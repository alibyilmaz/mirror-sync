import { PrismaClient } from "@prisma/client";
import { MANUAL_PAUSE_REASON } from "../app/lib/pause";

// Idempotent demo data for local development. Deterministic ids so re-running
// updates rather than duplicates. NOTE: no Session rows are seeded, so the
// embedded UI still needs a real Shopify install to authenticate — this is
// purely so the dashboard queries and worker have something to show/act on.
const prisma = new PrismaClient();

const SOURCE = "mirror-source.myshopify.com";
const DEST = "mirror-dest.myshopify.com";

async function main() {
  const source = await prisma.shop.upsert({
    where: { domain: SOURCE },
    create: { id: "shop_source", domain: SOURCE, plan: "growth" },
    update: { plan: "growth", uninstalledAt: null },
  });
  const dest = await prisma.shop.upsert({
    where: { domain: DEST },
    create: { id: "shop_dest", domain: DEST, plan: "free" },
    update: { plan: "free", uninstalledAt: null },
  });

  // "paused", not "active": these shops are fake (no Shopify session), so
  // an active connection would make the hourly pg_cron reconcile enqueue
  // jobs the worker can only fail on.
  const DEMO_PAUSE = "Demo data — no real stores behind this connection";
  const connection = await prisma.connection.upsert({
    where: { sourceShopId_destShopId: { sourceShopId: source.id, destShopId: dest.id } },
    create: {
      id: "conn_demo",
      sourceShopId: source.id,
      destShopId: dest.id,
      status: "paused",
      pausedReason: DEMO_PAUSE,
      syncInventory: true,
      syncTitle: true,
      syncPrice: true,
      safetyStockBuffer: 2,
    },
    update: { status: "paused", pausedReason: DEMO_PAUSE, safetyStockBuffer: 2 },
  });

  await prisma.locationLink.upsert({
    where: { connectionId_sourceLocationId: { connectionId: connection.id, sourceLocationId: 111n } },
    create: { id: "loc_1", connectionId: connection.id, sourceLocationId: 111n, destLocationId: 222n },
    update: { destLocationId: 222n },
  });

  const mappings = [
    { id: "map_1", sku: "TEE-BLK-M", sv: 1001n, sii: 9001n, dv: 2001n, dii: 8001n, matchType: "auto_sku", status: "active" },
    { id: "map_2", sku: "TEE-BLK-L", sv: 1002n, sii: 9002n, dv: 2002n, dii: 8002n, matchType: "auto_barcode", status: "active" },
    { id: "map_3", sku: "HOODIE-GRY", sv: 1003n, sii: 9003n, dv: 2003n, dii: 8003n, matchType: "auto_sku", status: "paused",
      pauseReason: "Inventory drifted 3 reconciliations in a row — something else appears to be changing stock at " + DEST },
    { id: "map_4", sku: "CAP-RED", sv: 1004n, sii: 9004n, dv: 2004n, dii: 8004n, matchType: "manual", status: "paused",
      pauseReason: MANUAL_PAUSE_REASON },
    { id: "map_5", sku: "SOCKS-WHT", sv: 1005n, sii: 9005n, dv: 2005n, dii: 8005n, matchType: "auto_sku", status: "broken",
      pauseReason: "Source product was deleted" },
  ];

  for (const m of mappings) {
    await prisma.mapping.upsert({
      where: { connectionId_sourceVariantId: { connectionId: connection.id, sourceVariantId: m.sv } },
      create: {
        id: m.id,
        connectionId: connection.id,
        sku: m.sku,
        barcode: m.matchType === "auto_barcode" ? `00000${m.sv}` : null,
        sourceProductId: 700n + m.sv,
        sourceVariantId: m.sv,
        sourceInventoryItemId: m.sii,
        destProductId: 600n + m.dv,
        destVariantId: m.dv,
        destInventoryItemId: m.dii,
        matchType: m.matchType,
        status: m.status,
        pauseReason: m.pauseReason ?? null,
        pausedAt: m.status === "active" ? null : new Date(),
        lastSyncedAt: m.status === "active" ? new Date() : null,
      },
      update: { status: m.status, pauseReason: m.pauseReason ?? null },
    });
  }

  // Plain-language activity, newest last.
  await prisma.auditLog.deleteMany({ where: { connectionId: connection.id, kind: "system", message: { contains: "Seed" } } });
  const logs = [
    { kind: "import", level: "info", shop: SOURCE, message: `Connected: ${SOURCE} → ${DEST}. Starting initial import and SKU matching.` },
    { kind: "import", level: "info", shop: SOURCE, message: "Initial matching finished: 4 SKUs matched by SKU, 1 by barcode. Now pushing initial inventory levels." },
    { kind: "sync", level: "info", shop: DEST, message: `Inventory synced for SKU TEE-BLK-M: 40 → 38 at ${DEST} (source has 40, safety buffer 2).` },
    { kind: "sync", level: "info", shop: DEST, message: `Inventory synced for SKU TEE-BLK-L: 12 → 10 at ${DEST} (source has 12, safety buffer 2).` },
    { kind: "reconcile", level: "info", shop: DEST, message: "Drift repaired for SKU HOODIE-GRY: mirror-dest had 5, corrected to 3 to match mirror-source." },
    { kind: "pause", level: "warn", shop: DEST, message: `Sync paused for SKU HOODIE-GRY: its stock at ${DEST} drifted away 3 hours in a row. Another app or a manual edit is probably changing it. Fixed it one more time, but review it, then use "Resync now".` },
    { kind: "sync", level: "warn", shop: DEST, message: `Source product for SKU SOCKS-WHT was deleted at ${SOURCE}. The copy at ${DEST} was left untouched — delete it manually if you want it gone. Sync for this SKU stopped.` },
    { kind: "system", level: "error", shop: SOURCE, message: "A sync job failed 5 times and was moved to the dead-letter queue. You can retry it from the Health page. (Seed sample)" },
  ];
  for (const l of logs) {
    await prisma.auditLog.create({
      data: { connectionId: connection.id, shopDomain: l.shop, kind: l.kind, level: l.level, message: l.message },
    });
  }

  // One dead-letter row so the Health page shows the retry flow.
  await prisma.deadLetter.upsert({
    where: { id: "dl_demo" },
    create: {
      id: "dl_demo",
      queue: "sync_jobs",
      shopDomain: SOURCE,
      payload: { type: "webhook", shop: SOURCE, topic: "INVENTORY_LEVELS_UPDATE", webhookId: "seed-demo", payload: { inventory_item_id: 9003, location_id: 111, available: 3 }, receivedAt: new Date(0).toISOString() },
      error: "ShopApiError: inventorySetQuantities failed: Inventory item not stocked at location (seed sample)",
      attempts: 5,
      status: "dead",
    },
    update: { status: "dead" },
  });

  console.log("Seed complete:");
  console.log(`  shops:       ${SOURCE} (growth), ${DEST} (free)`);
  console.log(`  connection:  ${connection.id} ${connection.status}, buffer 2`);
  console.log(`  mappings:    ${mappings.length} (2 active, 2 paused, 1 broken)`);
  console.log(`  audit logs:  ${logs.length}`);
  console.log(`  dead letter: 1`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
