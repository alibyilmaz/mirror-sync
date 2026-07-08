import prisma from "../../db.server";
import type { Job, WebhookJob } from "../jobs";
import { inventoryKey, stableHash, toGid } from "../util";
import {
  checkVersion,
  decideWrite,
  diffProductFields,
  isEmptyProductDiff,
  isOwnEcho,
  shouldPauseAfterFailure,
  targetQuantity,
  ECHO_TTL_MS,
} from "./decisions";
import {
  RateLimitedError,
  ShopApiError,
  StaleWriteError,
  activateInventory,
  getInventoryAvailable,
  getProductSnapshot,
  getProductMetafields,
  setInventoryAvailable,
  setMetafields,
  updateProductFields,
  updateVariantPrices,
} from "./admin.server";
import { reconcileConnection } from "./reconcile.server";
import { runInitialImport } from "./import.server";

export { RateLimitedError };

// In-job re-read attempts when the destination changes mid-write. Beyond
// this the SKU flows to the failure/pause path.
const MAX_STALE_RETRIES = 3;

export async function processJob(job: Job): Promise<void> {
  switch (job.type) {
    case "webhook":
      return processWebhook(job);
    case "reconcile_connection":
      return reconcileConnection(job);
    case "initial_import":
      return runInitialImport(job);
    case "retry_dead_letter": {
      const dl = await prisma.deadLetter.findUnique({ where: { id: job.deadLetterId } });
      if (!dl || dl.status !== "dead") return;
      await processJob(dl.payload as unknown as Job);
      await prisma.deadLetter.update({
        where: { id: dl.id },
        data: { status: "retried", retriedAt: new Date() },
      });
      return;
    }
  }
}

async function processWebhook(job: WebhookJob): Promise<void> {
  switch (job.topic) {
    case "INVENTORY_LEVELS_UPDATE":
      return handleInventoryLevelUpdate(job);
    case "PRODUCTS_UPDATE":
      return handleProductUpdate(job);
    case "PRODUCTS_DELETE":
      return handleProductDelete(job);
    default:
      console.warn(`[sync] ignoring unexpected topic ${job.topic}`);
  }
}

// ---------------------------------------------------------------------------
// inventory_levels/update — the core path
// ---------------------------------------------------------------------------

// IDs can arrive as strings: ingest keeps integers above 2^53 as strings
// to avoid precision loss (BigInt() accepts both).
type InventoryLevelPayload = {
  inventory_item_id: number | string;
  location_id: number | string;
  available: number | null;
  updated_at: string;
};

async function handleInventoryLevelUpdate(job: WebhookJob): Promise<void> {
  const p = job.payload as InventoryLevelPayload;
  if (p.available === null || p.available === undefined) return; // untracked item
  const sourceKey = inventoryKey(p.inventory_item_id, p.location_id);
  const version = new Date(p.updated_at);
  const payloadHash = stableHash({ available: p.available });

  // Duplicate + out-of-order deliveries die here.
  const mark = await prisma.resourceVersion.findUnique({
    where: {
      shopDomain_resourceType_resourceKey: {
        shopDomain: job.shop,
        resourceType: "inventory",
        resourceKey: sourceKey,
      },
    },
  });
  const versionCheck = checkVersion(version, payloadHash, mark);
  if (!versionCheck.ok) return;

  // Origin tagging (inbound): if this webhook reports exactly the value we
  // ourselves wrote to this shop's item moments ago, it's the echo of our
  // own write — don't re-propagate it (that's how a chain A→B→C could
  // otherwise loop). A genuine third-party change carries a different value
  // and passes straight through. We still advance the watermark so the
  // echo isn't reconsidered.
  const recentEcho = await prisma.echoWrite.findFirst({
    where: {
      shopDomain: job.shop,
      resourceType: "inventory",
      resourceKey: sourceKey,
      writtenAt: { gte: new Date(Date.now() - ECHO_TTL_MS) },
    },
    orderBy: { writtenAt: "desc" },
  });
  // EchoWrite stores stableHash(value) of the bare quantity we wrote, so
  // compare against the same shape (not payloadHash, which hashes an object).
  if (isOwnEcho(stableHash(p.available), recentEcho, new Date())) {
    await upsertWatermark(job.shop, "inventory", sourceKey, version, payloadHash);
    return;
  }

  const connections = await prisma.connection.findMany({
    where: {
      sourceShop: { domain: job.shop },
      status: "active",
      syncInventory: true,
      destShop: { uninstalledAt: null },
    },
    include: {
      destShop: true,
      locationLinks: { where: { sourceLocationId: BigInt(p.location_id) } },
      mappings: {
        where: { sourceInventoryItemId: BigInt(p.inventory_item_id), status: "active" },
      },
    },
  });

  const failures: unknown[] = [];
  for (const conn of connections) {
    const mapping = conn.mappings[0];
    const link = conn.locationLinks[0];
    // Unmapped SKU or unlinked location: nothing to do here; hourly
    // reconciliation reports coverage gaps so they aren't silent forever.
    if (!mapping || !link) continue;

    try {
      await syncOneInventoryLevel({
        connection: conn,
        destDomain: conn.destShop.domain,
        mapping,
        destLocationId: link.destLocationId,
        sourceAvailable: p.available,
      });
    } catch (e) {
      if (e instanceof RateLimitedError) throw e; // shelve the whole job
      failures.push(e);
    }
  }

  // Advance the watermark ONLY when every connection succeeded. If any
  // write failed we re-throw so the worker retries the identical event —
  // and the retry must NOT be rejected as a duplicate, so the watermark
  // stays where it was. (Reprocessing the connections that already
  // succeeded is a safe no-op: decideWrite skips destinations that already
  // hold the target value.)
  if (failures.length > 0) {
    throw failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
  }
  await upsertWatermark(job.shop, "inventory", sourceKey, version, payloadHash);
}

async function syncOneInventoryLevel(params: {
  connection: {
    id: string;
    safetyStockBuffer: number;
  };
  destDomain: string;
  mapping: {
    id: string;
    sku: string | null;
    destInventoryItemId: bigint;
    failureCount: number;
  };
  destLocationId: bigint;
  sourceAvailable: number;
}): Promise<void> {
  const { connection, destDomain, mapping, destLocationId, sourceAvailable } = params;
  const target = targetQuantity(sourceAvailable, connection.safetyStockBuffer);
  const destKey = inventoryKey(mapping.destInventoryItemId, destLocationId);
  const targetHash = stableHash(target);
  const itemGid = toGid("InventoryItem", mapping.destInventoryItemId);
  const locationGid = toGid("Location", destLocationId);

  try {
    let observed = await getInventoryAvailable(destDomain, itemGid, locationGid);
    const before = observed;
    // Optimistic-concurrency loop: write with compareQuantity = the value we
    // just read; if the destination changed underneath us, re-read and retry
    // a bounded number of times. If it keeps changing, StaleWriteError falls
    // through to the failure path, which pauses the SKU after 3 — exactly
    // the "something else is fighting over this inventory" oversell guard.
    for (let staleRetries = 0; ; staleRetries++) {
      const decision = decideWrite(target, observed);
      if (!decision.write) return; // already correct (possibly after a concurrent change)

      if (observed === null) {
        // Item isn't stocked at the destination location yet: activate it
        // there with the initial quantity (setting quantities would fail).
        await activateInventory(destDomain, itemGid, locationGid, target);
        break;
      }
      try {
        await setInventoryAvailable(
          destDomain,
          itemGid,
          locationGid,
          target,
          `https://mirrorsync.app/sync/${connection.id}/${mapping.id}`,
          observed,
        );
        break;
      } catch (e) {
        if (e instanceof StaleWriteError && staleRetries < MAX_STALE_RETRIES) {
          observed = await getInventoryAvailable(destDomain, itemGid, locationGid);
          continue;
        }
        throw e;
      }
    }
    const destCurrent = before;
    await prisma.$transaction([
      prisma.echoWrite.create({
        data: {
          shopDomain: destDomain,
          resourceType: "inventory",
          resourceKey: destKey,
          valueHash: targetHash,
        },
      }),
      prisma.mapping.update({
        where: { id: mapping.id },
        data: { lastSyncedAt: new Date(), failureCount: 0 },
      }),
      prisma.auditLog.create({
        data: {
          connectionId: connection.id,
          shopDomain: destDomain,
          kind: "sync",
          message: `Inventory synced for ${label(mapping.sku)}: ${destCurrent ?? "?"} → ${target} at ${destDomain}${connection.safetyStockBuffer > 0 ? ` (source has ${sourceAvailable}, safety buffer ${connection.safetyStockBuffer})` : ""}.`,
        },
      }),
    ]);
  } catch (e) {
    if (e instanceof RateLimitedError) throw e;
    await recordWriteFailure(connection.id, destDomain, mapping.id, mapping.sku, mapping.failureCount, e);
    throw e;
  }
}

// Oversell guard: consecutive write failures pause the SKU rather than
// letting the destination drift silently during a restock.
async function recordWriteFailure(
  connectionId: string,
  destDomain: string,
  mappingId: string,
  sku: string | null,
  previousFailureCount: number,
  error: unknown,
): Promise<void> {
  const failureCount = previousFailureCount + 1;
  const pause = shouldPauseAfterFailure(failureCount);
  const message =
    error instanceof ShopApiError ? error.message : error instanceof Error ? error.message : String(error);
  await prisma.$transaction([
    prisma.mapping.update({
      where: { id: mappingId },
      data: pause
        ? {
            failureCount,
            status: "paused",
            pausedAt: new Date(),
            pauseReason: `${failureCount} consecutive write failures (last: ${message.slice(0, 200)})`,
          }
        : { failureCount },
    }),
    prisma.auditLog.create({
      data: {
        connectionId,
        shopDomain: destDomain,
        level: pause ? "warn" : "info",
        kind: pause ? "pause" : "sync",
        message: pause
          ? `Sync paused for ${label(sku)} after ${failureCount} consecutive write failures. Fix the underlying issue, then use "Resync now" on the Health page. Last error: ${message.slice(0, 300)}`
          : `Write failed for ${label(sku)} (attempt ${failureCount} of 3): ${message.slice(0, 300)}. Will retry automatically.`,
      },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// products/update — optional field sync
// ---------------------------------------------------------------------------

type ProductPayload = {
  id: number | string;
  title: string;
  tags: string; // REST-shaped: comma-separated
  updated_at: string;
  variants: { id: number | string; price: string; sku: string | null }[];
};

async function handleProductUpdate(job: WebhookJob): Promise<void> {
  const p = job.payload as ProductPayload;
  const resourceKey = String(p.id);
  const version = new Date(p.updated_at);
  const sourceTags = (p.tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const sourcePrices = new Map<bigint, string>(
    (p.variants ?? []).map((v) => [BigInt(v.id), v.price]),
  );
  const payloadHash = stableHash({
    title: p.title,
    tags: [...sourceTags].sort(),
    prices: [...sourcePrices.entries()].map(([id, price]) => [String(id), price]).sort(),
  });

  const mark = await prisma.resourceVersion.findUnique({
    where: {
      shopDomain_resourceType_resourceKey: {
        shopDomain: job.shop,
        resourceType: "product",
        resourceKey,
      },
    },
  });
  const versionCheck = checkVersion(version, payloadHash, mark);
  if (!versionCheck.ok) return;

  const connections = await prisma.connection.findMany({
    where: {
      sourceShop: { domain: job.shop },
      status: "active",
      destShop: { uninstalledAt: null },
      OR: [
        { syncTitle: true },
        { syncPrice: true },
        { syncTags: true },
        { metafieldNamespaces: { isEmpty: false } },
      ],
    },
    include: {
      destShop: true,
      mappings: { where: { sourceProductId: BigInt(p.id), status: "active" } },
    },
  });

  const failures: unknown[] = [];
  for (const conn of connections) {
    if (conn.mappings.length === 0) continue;

    // Variants of one source product can map to DIFFERENT destination
    // products (matching is per-variant, and merchants can move variants
    // between products). Group by destination product and sync each
    // separately — otherwise a variant belonging to product Y would be
    // pushed into product X's update and rejected.
    const byDestProduct = new Map<bigint, typeof conn.mappings>();
    for (const m of conn.mappings) {
      if (m.destProductId === null) continue;
      const list = byDestProduct.get(m.destProductId) ?? [];
      list.push(m);
      byDestProduct.set(m.destProductId, list);
    }

    for (const [destProductId, group] of byDestProduct) {
      try {
        await syncProductFields({
          connectionId: conn.id,
          destDomain: conn.destShop.domain,
          destProductGid: toGid("Product", destProductId),
          sourceProductGid: toGid("Product", p.id),
          settings: {
            syncTitle: conn.syncTitle,
            syncPrice: conn.syncPrice,
            syncTags: conn.syncTags,
            metafieldNamespaces: conn.metafieldNamespaces,
          },
          source: { title: p.title, tags: sourceTags, variantPrices: sourcePrices },
          variantMap: new Map(group.map((m) => [m.sourceVariantId, m.destVariantId])),
          sourceDomain: job.shop,
        });
      } catch (e) {
        if (e instanceof RateLimitedError) throw e;
        failures.push(e);
      }
    }
  }

  // Watermark advances only on a fully clean pass (see the inventory
  // handler for why): a failed field write must be retryable, not
  // duplicate-rejected. Product fields have no reconcile safety net, so
  // this is the only thing standing between a transient error and a
  // permanently lost price/title change.
  if (failures.length > 0) {
    throw failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
  }
  await upsertWatermark(job.shop, "product", resourceKey, version, payloadHash);
}

async function syncProductFields(params: {
  connectionId: string;
  destDomain: string;
  sourceDomain: string;
  destProductGid: string;
  sourceProductGid: string;
  settings: {
    syncTitle: boolean;
    syncPrice: boolean;
    syncTags: boolean;
    metafieldNamespaces: string[];
  };
  source: { title: string; tags: string[]; variantPrices: Map<bigint, string> };
  variantMap: Map<bigint, bigint>;
}): Promise<void> {
  const { connectionId, destDomain, destProductGid, settings, source, variantMap } = params;

  const dest = await getProductSnapshot(destDomain, destProductGid);
  if (!dest) {
    await prisma.auditLog.create({
      data: {
        connectionId,
        shopDomain: destDomain,
        level: "warn",
        kind: "sync",
        message: `Product no longer exists at ${destDomain}; its SKUs need re-matching. Run "Resync now" or re-map manually.`,
      },
    });
    return;
  }

  const diff = diffProductFields({ settings, source, dest, variantMap });
  const changes: string[] = [];

  if (!isEmptyProductDiff(diff)) {
    if (diff.title !== undefined || diff.tags !== undefined) {
      await updateProductFields(destDomain, destProductGid, {
        ...(diff.title !== undefined ? { title: diff.title } : {}),
        ...(diff.tags !== undefined ? { tags: diff.tags } : {}),
      });
      if (diff.title !== undefined) changes.push(`title → "${diff.title}"`);
      if (diff.tags !== undefined) changes.push("tags");
    }
    if (diff.variantPrices.length > 0) {
      await updateVariantPrices(
        destDomain,
        destProductGid,
        diff.variantPrices.map((v) => ({
          variantGid: toGid("ProductVariant", v.destVariantId),
          price: v.price,
        })),
      );
      changes.push(`${diff.variantPrices.length} price(s)`);
    }
  }

  // Metafields: webhook payloads don't carry them, so read source + dest
  // and write only what differs.
  if (settings.metafieldNamespaces.length > 0) {
    const [sourceMf, destMf] = [
      await getProductMetafields(params.sourceDomain, params.sourceProductGid, settings.metafieldNamespaces),
      await getProductMetafields(destDomain, destProductGid, settings.metafieldNamespaces),
    ];
    const destByKey = new Map(destMf.map((m) => [`${m.namespace}.${m.key}`, m]));
    const changed = sourceMf.filter((m) => {
      const existing = destByKey.get(`${m.namespace}.${m.key}`);
      return !existing || existing.value !== m.value || existing.type !== m.type;
    });
    if (changed.length > 0) {
      await setMetafields(destDomain, destProductGid, changed);
      changes.push(`${changed.length} metafield(s)`);
    }
  }

  if (changes.length > 0) {
    // No EchoWrite here: unlike inventory, handleProductUpdate has no
    // inbound own-echo check, so a product echo row would never be read.
    // Loop safety for product fields rests on the acyclic pairing graph
    // plus diffProductFields returning an empty diff for equal fields.
    await prisma.auditLog.create({
      data: {
        connectionId,
        shopDomain: destDomain,
        kind: "sync",
        message: `Product "${source.title}" updated at ${destDomain}: ${changes.join(", ")}.`,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// products/delete — never auto-delete downstream; mark and surface
// ---------------------------------------------------------------------------

async function handleProductDelete(job: WebhookJob): Promise<void> {
  const p = job.payload as { id: number | string };
  const mappings = await prisma.mapping.findMany({
    where: {
      sourceProductId: BigInt(p.id),
      status: { not: "broken" },
      connection: { sourceShop: { domain: job.shop } },
    },
    include: { connection: { include: { destShop: true } } },
  });
  if (mappings.length === 0) return;

  for (const m of mappings) {
    await prisma.$transaction([
      prisma.mapping.update({
        where: { id: m.id },
        data: {
          status: "broken",
          pauseReason: "Source product was deleted",
          pausedAt: new Date(),
        },
      }),
      prisma.auditLog.create({
        data: {
          connectionId: m.connectionId,
          shopDomain: m.connection.destShop.domain,
          level: "warn",
          kind: "sync",
          message: `Source product for ${label(m.sku)} was deleted at ${job.shop}. The copy at ${m.connection.destShop.domain} was left untouched — delete it manually if you want it gone. Sync for this SKU stopped.`,
        },
      }),
    ]);
  }
}

// ---------------------------------------------------------------------------

async function upsertWatermark(
  shopDomain: string,
  resourceType: string,
  resourceKey: string,
  version: Date,
  payloadHash: string,
): Promise<void> {
  // Guarded upsert: the watermark only ever moves forward.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.resourceVersion.findUnique({
      where: { shopDomain_resourceType_resourceKey: { shopDomain, resourceType, resourceKey } },
    });
    if (existing && existing.version > version) return;
    await tx.resourceVersion.upsert({
      where: { shopDomain_resourceType_resourceKey: { shopDomain, resourceType, resourceKey } },
      create: { shopDomain, resourceType, resourceKey, version, payloadHash },
      update: { version, payloadHash },
    });
  });
}

function label(sku: string | null): string {
  return sku ? `SKU ${sku}` : "an unmatched SKU";
}
