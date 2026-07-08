import { randomBytes } from "node:crypto";
import prisma from "../db.server";
import { wouldCreateCycle } from "./graph";
import { enqueue } from "./queue.server";
import { QUEUES } from "./jobs";

const CODE_TTL_MS = 15 * 60 * 1000;

// Arbitrary constant key for the global pairing-graph advisory lock, so
// concurrent redeems serialize their cycle-check-then-create.
export const PAIRING_LOCK_KEY = 827641;

export class PairingError extends Error {}

// Generated on the SOURCE store; the merchant types it into the destination.
export async function generatePairingCode(shopDomain: string): Promise<string> {
  const shop = await requireShop(shopDomain);
  // Unambiguous alphabet (no 0/O, 1/I) — the merchant re-types this by hand.
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const raw = Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  await prisma.pairingCode.create({
    data: {
      code,
      shopId: shop.id,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return code;
}

// Redeemed on the DESTINATION store: creates the source -> destination
// connection and kicks off the initial import.
export async function redeemPairingCode(destDomain: string, rawCode: string) {
  const destShop = await requireShop(destDomain);
  const code = rawCode.trim().toUpperCase();

  const pairing = await prisma.pairingCode.findUnique({
    where: { code },
    include: { shop: true },
  });
  if (!pairing || pairing.usedAt || pairing.expiresAt < new Date()) {
    throw new PairingError(
      "That code is invalid or expired. Generate a fresh code on the source store — codes are single-use and valid for 15 minutes.",
    );
  }
  if (pairing.shop.domain === destDomain) {
    throw new PairingError(
      "This code was generated on this store. Enter it on the destination store instead.",
    );
  }
  if (pairing.shop.uninstalledAt) {
    throw new PairingError("The source store no longer has MirrorSync installed.");
  }

  const connection = await prisma.$transaction(async (tx) => {
    // Serialize ALL pairing-graph mutations. The cycle check is
    // check-then-act: without this lock, two web requests redeeming the
    // reverse direction (A→B and B→A) at the same time both read the graph
    // before either commits, both see no cycle, and create A↔B — which the
    // safety-stock buffer then ratchets to zero. Pairing is rare, so a
    // single global advisory lock (held to commit) is fine.
    // $executeRaw (not $queryRaw): the function returns void, which
    // $queryRaw can't deserialize into a row.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PAIRING_LOCK_KEY}::bigint)`;

    const existing = await tx.connection.findUnique({
      where: {
        sourceShopId_destShopId: { sourceShopId: pairing.shopId, destShopId: destShop.id },
      },
    });
    if (existing && existing.status !== "disabled") {
      throw new PairingError("These stores are already connected in this direction.");
    }

    // Keep the connection graph acyclic — this is what makes sync loops
    // impossible (see lib/graph.ts). Read edges inside the locked tx.
    const edges = await tx.connection.findMany({
      where: { status: { not: "disabled" } },
      select: { sourceShopId: true, destShopId: true },
    });
    if (wouldCreateCycle(edges, pairing.shopId, destShop.id)) {
      throw new PairingError(
        "This connection would create a sync loop (the destination already feeds the source, directly or through another store). MirrorSync only supports one-directional flows.",
      );
    }

    // Claim the code atomically; a concurrent redeem of the same code loses.
    const claimed = await tx.pairingCode.updateMany({
      where: { id: pairing.id, usedAt: null },
      data: { usedAt: new Date(), usedBy: destDomain },
    });
    if (claimed.count === 0) throw new PairingError("That code was just used.");

    if (existing) {
      // Re-pairing a previously disabled connection: revive it.
      return tx.connection.update({
        where: { id: existing.id },
        data: { status: "importing", pausedReason: null },
      });
    }
    return tx.connection.create({
      data: { sourceShopId: pairing.shopId, destShopId: destShop.id },
    });
  });

  await prisma.auditLog.create({
    data: {
      connectionId: connection.id,
      shopDomain: destDomain,
      kind: "system",
      message: `Connected: ${pairing.shop.domain} → ${destDomain}. Starting initial import and SKU matching.`,
    },
  });

  await enqueue(QUEUES.import, {
    type: "initial_import",
    connectionId: connection.id,
    step: "start",
  });

  return connection;
}

async function requireShop(domain: string) {
  const shop = await prisma.shop.findUnique({ where: { domain } });
  if (!shop) throw new PairingError("This store is not registered yet. Reload the app.");
  return shop;
}
