import prisma from "../../db.server";
import type { ReconcileConnectionJob } from "../jobs";
import { inventoryKey, stableHash, toGid } from "../util";
import { shouldPauseAfterDrift, shouldPauseAfterFailure, targetQuantity } from "./decisions";
import { MANUAL_PAUSE_REASON } from "../pause";
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
  if (!conn) return;
  if (conn.sourceShop.uninstalledAt || conn.destShop.uninstalledAt) return;
  if (!conn.syncInventory) return;
  // Scheduled (hourly) runs only touch fully active connections — a paused
  // connection (plan-limit overage, failed import) must NOT keep writing
  // inventory every hour, or plan enforcement is void and merchant fixes
  // get overwritten. A manual "Resync now" is the deliberate recovery path
  // and may run on a paused connection.
  if (conn.status === "disabled" || conn.status === "importing") return;
  if (conn.status !== "active" && !job.manual) return;

  // Targeted resync (per-SKU "Resync now") explicitly revives the SKU the
  // merchant clicked. A connection-wide manual resync must NOT revive SKUs
  // the merchant paused on purpose from the Mappings page.
  const targeted = Boolean(job.mappingIds && job.mappingIds.length > 0);

  const mappings = await prisma.mapping.findMany({
    where: {
      connectionId: conn.id,
      ...(job.mappingIds ? { id: { in: job.mappingIds } } : {}),
      // Manual resync also picks up paused SKUs (that's the recovery path);
      // scheduled runs only check active ones. Broken stays broken.
      status: job.manual ? { in: ["active", "paused"] } : "active",
      // Connection-wide manual resync skips deliberately-paused SKUs;
      // a targeted resync of that exact SKU overrides.
      ...(job.manual && !targeted ? { NOT: { pauseReason: MANUAL_PAUSE_REASON } } : {}),
    },
    orderBy: { id: "asc" },
  });

  let checked = 0;
  let repaired = 0;
  let paused = 0;
  let revived = 0;
  let failed = 0;
  const failedIds = new Set<string>();

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
          // In sync. Clear any stale counters on an active SKU so isolated
          // failures/drift weeks apart never accumulate into a false pause.
          // Manual-paused revival is handled by the sweep after the loop.
          if (mapping.status === "active" && (mapping.failureCount > 0 || mapping.driftCount > 0)) {
            await prisma.mapping.updateMany({
              where: { id: mapping.id },
              data: { failureCount: 0, driftCount: 0, lastSyncedAt: new Date() },
            });
          }
          continue;
        }

        // Drift found. The mapping may have been unlinked or re-pointed from
        // the dashboard since we snapshotted the batch; re-read it before
        // writing so a stray repair never lands on a deleted or wrong
        // destination item.
        const live = await prisma.mapping.findUnique({ where: { id: mapping.id } });
        if (
          !live ||
          live.status === "broken" ||
          live.destInventoryItemId !== mapping.destInventoryItemId
        ) {
          continue;
        }

        // One broken SKU must not sink the whole pass: repair errors are
        // recorded per mapping and the loop moves on. All mapping writes use
        // updateMany so a row deleted mid-pass updates 0 rows instead of
        // throwing P2025 and aborting the transaction.
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
          failedIds.add(mapping.id);
          const message = e instanceof Error ? e.message : String(e);
          const failureCount = mapping.failureCount + 1;
          const pauseNow = shouldPauseAfterFailure(failureCount);
          await prisma.$transaction([
            prisma.mapping.updateMany({
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
          prisma.mapping.updateMany({
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
                : { driftCount, failureCount: 0, lastSyncedAt: new Date() },
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
      }
    }
  }

  // Manual resync is the recovery path: resume every paused SKU in the
  // working set that didn't fail this run — including ones whose source
  // isn't stocked at any linked location (no drift to trigger inline
  // revival), so the one-click recovery advertised in the pause message
  // always does something. (Deliberately manual-paused SKUs were already
  // excluded from the working set unless explicitly targeted.)
  if (job.manual) {
    const reviveIds = mappings
      .filter((m) => m.status === "paused" && !failedIds.has(m.id))
      .map((m) => m.id);
    if (reviveIds.length > 0) {
      const res = await prisma.mapping.updateMany({
        where: { id: { in: reviveIds }, status: "paused" },
        data: { status: "active", pausedAt: null, pauseReason: null, driftCount: 0, failureCount: 0 },
      });
      revived += res.count;
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

function skuLabel(sku: string | null): string {
  return sku ? `SKU ${sku}` : "an unlabelled SKU";
}
