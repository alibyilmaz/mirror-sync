import prisma from "../../db.server";
import type { ReconcileConnectionJob } from "../jobs";
import { inventoryKey, stableHash, toGid } from "../util";
import { shouldPauseAfterDrift, shouldPauseAfterFailure, targetQuantity } from "./decisions";
import {
  RateLimitedError,
  activateInventory,
  getInventoryAvailableBatch,
  setInventoryAvailable,
} from "./admin.server";

// Hourly safety net (pg_cron enqueues one job per active connection):
// compare source vs destination for every mapped SKU and repair drift.
// This is what catches changes whose webhooks never arrived, and it is
// self-serve recovery: the dashboard's "Resync now" enqueues the same job
// with manual=true, which also revives paused SKUs.

const BATCH_SIZE = 50;

export async function reconcileConnection(job: ReconcileConnectionJob): Promise<void> {
  const conn = await prisma.connection.findUnique({
    where: { id: job.connectionId },
    include: { sourceShop: true, destShop: true, locationLinks: true },
  });
  if (!conn || conn.status === "disabled" || conn.status === "importing") return;
  if (conn.sourceShop.uninstalledAt || conn.destShop.uninstalledAt) return;
  if (!conn.syncInventory) return;

  const mappings = await prisma.mapping.findMany({
    where: {
      connectionId: conn.id,
      ...(job.mappingIds ? { id: { in: job.mappingIds } } : {}),
      // Manual resync also picks up paused SKUs (that's the recovery path);
      // scheduled runs only check active ones. Broken stays broken.
      status: job.manual ? { in: ["active", "paused"] } : "active",
    },
    orderBy: { id: "asc" },
  });

  let checked = 0;
  let repaired = 0;
  let paused = 0;
  let revived = 0;
  let failed = 0;

  for (const link of conn.locationLinks) {
    const sourceLocationGid = toGid("Location", link.sourceLocationId);
    const destLocationGid = toGid("Location", link.destLocationId);

    for (let i = 0; i < mappings.length; i += BATCH_SIZE) {
      const batch = mappings.slice(i, i + BATCH_SIZE);
      const sourceLevels = await getInventoryAvailableBatch(
        conn.sourceShop.domain,
        batch.map((m) => toGid("InventoryItem", m.sourceInventoryItemId)),
        sourceLocationGid,
      );
      const destLevels = await getInventoryAvailableBatch(
        conn.destShop.domain,
        batch.map((m) => toGid("InventoryItem", m.destInventoryItemId)),
        destLocationGid,
      );

      for (const mapping of batch) {
        const sourceAvailable = sourceLevels.get(toGid("InventoryItem", mapping.sourceInventoryItemId));
        const destCurrent = destLevels.get(toGid("InventoryItem", mapping.destInventoryItemId));
        if (sourceAvailable === null || sourceAvailable === undefined) continue; // not stocked at this location
        checked++;

        const target = targetQuantity(sourceAvailable, conn.safetyStockBuffer);
        if (destCurrent === target) {
          if (job.manual && mapping.status === "paused") {
            await revive(mapping.id);
            revived++;
          }
          continue;
        }

        // Drift found. Repair it, count it, and pause the SKU if it keeps
        // drifting (something else is fighting over this inventory).
        // One broken SKU must not sink the whole pass: repair errors are
        // recorded per mapping and the loop moves on.
        try {
          if (destCurrent === null || destCurrent === undefined) {
            // Not stocked at the destination location yet.
            await activateInventory(
              conn.destShop.domain,
              toGid("InventoryItem", mapping.destInventoryItemId),
              destLocationGid,
              target,
            );
          } else {
            await setInventoryAvailable(
              conn.destShop.domain,
              toGid("InventoryItem", mapping.destInventoryItemId),
              destLocationGid,
              target,
              `https://mirrorsync.app/reconcile/${conn.id}/${mapping.id}`,
            );
          }
        } catch (e) {
          if (e instanceof RateLimitedError) throw e; // shelve the whole job
          failed++;
          const message = e instanceof Error ? e.message : String(e);
          const failureCount = mapping.failureCount + 1;
          const pauseNow = shouldPauseAfterFailure(failureCount);
          await prisma.$transaction([
            prisma.mapping.update({
              where: { id: mapping.id },
              data: pauseNow
                ? {
                    failureCount,
                    status: "paused",
                    pausedAt: new Date(),
                    pauseReason: `Repair keeps failing (last: ${message.slice(0, 200)})`,
                  }
                : { failureCount },
            }),
            prisma.auditLog.create({
              data: {
                connectionId: conn.id,
                shopDomain: conn.destShop.domain,
                level: "warn",
                kind: pauseNow ? "pause" : "reconcile",
                message: pauseNow
                  ? `Sync paused for ${skuLabel(mapping.sku)}: repairing it failed ${failureCount} times (last error: ${message.slice(0, 200)}). Check that the product still exists at ${conn.destShop.domain}, then use "Resync now".`
                  : `Could not repair ${skuLabel(mapping.sku)} at ${conn.destShop.domain}: ${message.slice(0, 200)}. Will try again next hour.`,
              },
            }),
          ]);
          continue;
        }
        const driftCount = job.manual ? 0 : mapping.driftCount + 1;
        const shouldPause = !job.manual && shouldPauseAfterDrift(driftCount);
        await prisma.$transaction([
          prisma.echoWrite.create({
            data: {
              shopDomain: conn.destShop.domain,
              resourceType: "inventory",
              resourceKey: inventoryKey(mapping.destInventoryItemId, link.destLocationId),
              valueHash: stableHash(target),
            },
          }),
          prisma.mapping.update({
            where: { id: mapping.id },
            data: shouldPause
              ? {
                  driftCount,
                  status: "paused",
                  pausedAt: new Date(),
                  pauseReason: `Inventory drifted ${driftCount} reconciliations in a row — something else appears to be changing stock at ${conn.destShop.domain}`,
                }
              : job.manual
                ? { driftCount: 0, failureCount: 0, status: "active", pausedAt: null, pauseReason: null, lastSyncedAt: new Date() }
                : { driftCount, lastSyncedAt: new Date() },
          }),
          prisma.auditLog.create({
            data: {
              connectionId: conn.id,
              shopDomain: conn.destShop.domain,
              level: shouldPause ? "warn" : "info",
              kind: shouldPause ? "pause" : "reconcile",
              message: shouldPause
                ? `Sync paused for ${skuLabel(mapping.sku)}: its stock at ${conn.destShop.domain} drifted away ${driftCount} hours in a row (last: ${destCurrent ?? "?"} instead of ${target}). Another app or a manual edit is probably changing it. Fixed it one more time, but review it, then use "Resync now".`
                : `Drift repaired for ${skuLabel(mapping.sku)}: ${conn.destShop.domain} had ${destCurrent ?? "nothing"}, corrected to ${target} to match ${conn.sourceShop.domain}.`,
            },
          }),
        ]);
        repaired++;
        if (shouldPause) paused++;
        if (job.manual && mapping.status === "paused") revived++;
      }
    }
  }

  // A drift-free full pass clears drift counters so occasional one-off
  // repairs don't slowly accumulate into a pause.
  if (repaired === 0 && failed === 0 && !job.manual) {
    await prisma.mapping.updateMany({
      where: { connectionId: conn.id, status: "active", driftCount: { gt: 0 } },
      data: { driftCount: 0 },
    });
  }

  await prisma.auditLog.create({
    data: {
      connectionId: conn.id,
      shopDomain: conn.sourceShop.domain,
      kind: "reconcile",
      message: job.manual
        ? `Manual resync finished: ${checked} SKUs checked, ${repaired} corrected, ${revived} paused SKUs resumed${failed > 0 ? `, ${failed} could not be repaired (see entries above)` : ""}.`
        : `Hourly check finished: ${checked} SKUs compared, ${repaired} drifted and were corrected${paused > 0 ? `, ${paused} paused for repeated drift` : ""}${failed > 0 ? `, ${failed} could not be repaired` : ""}.`,
    },
  });
}

async function revive(mappingId: string): Promise<void> {
  await prisma.mapping.update({
    where: { id: mappingId },
    data: { status: "active", pausedAt: null, pauseReason: null, driftCount: 0, failureCount: 0 },
  });
}

function skuLabel(sku: string | null): string {
  return sku ? `SKU ${sku}` : "an unlabelled SKU";
}
