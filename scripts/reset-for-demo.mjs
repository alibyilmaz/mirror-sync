// Rewind the two real demo stores to the pre-pairing state so the
// screencast can show onboarding from scratch. Keeps: products, sessions,
// webhook registrations (per-shop). Removes: the connection (cascades
// mappings/locationLinks/bulkImports), pairing codes, audit history for
// the two shops. Resets source stock to tidy values.
//   node --env-file=.env scripts/reset-for-demo.mjs
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const SOURCE = "mirror-sync.myshopify.com";
const DEST = "mirror-sync-dest.myshopify.com";

async function gql(shop, query, variables) {
  const s = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  const r = await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": s.accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json();
  if (b.errors) throw new Error(JSON.stringify(b.errors).slice(0, 240));
  return b.data;
}

async function setStock(shop, sku, qty) {
  const d = await gql(shop, `query($q:String!){ productVariants(first:1, query:$q){ nodes { inventoryItem { id inventoryLevels(first:5){ nodes { location { id } quantities(names:["available"]){ quantity } } } } } } }`, { q: `sku:${sku}` });
  const v = d.productVariants.nodes[0];
  if (!v) { console.log(`  ${sku}@${shop}: not found, skipped`); return; }
  const lvl = v.inventoryItem.inventoryLevels.nodes.find((n) => n.quantities.length);
  if (!lvl) { console.log(`  ${sku}@${shop}: unstocked, skipped`); return; }
  const cur = lvl.quantities[0].quantity;
  if (cur === qty) { console.log(`  ${sku}@${shop}: already ${qty}`); return; }
  const key = `demo-reset-${shop}-${sku}-${qty}-${Date.now()}`;
  const m = await gql(shop, `mutation($input:InventorySetQuantitiesInput!,$k:String!){ inventorySetQuantities(input:$input) @idempotent(key:$k){ userErrors{ message } } }`, {
    input: { name: "available", reason: "correction", referenceDocumentUri: "https://mirrorsync.app/demo-reset",
      quantities: [{ inventoryItemId: v.inventoryItem.id, locationId: lvl.location.id, quantity: qty, changeFromQuantity: cur }] },
    k: key,
  });
  const errs = m.inventorySetQuantities.userErrors;
  console.log(`  ${sku}@${shop}: ${cur} -> ${qty} ${errs.length ? "ERR " + errs[0].message : "ok"}`);
}

// 1. Tidy source stock (what the camera will see at the start).
console.log("== source stock ==");
for (const [sku, qty] of [["SYNC-TEE-M", 25], ["SYNC-TEE-L", 8], ["SYNC-CAP", 42], ["SRC-BC-1", 30], ["SRC-BC-2", 12], ["SRC-BC-3", 47], ["SRC-BC-4", 8], ["COFFEE-ROASTERY-01", 20]]) {
  await setStock(SOURCE, sku, qty);
}
// Dest left as-is: the on-camera initial import will visibly align it.

// 2. Delete the real connection + history.
const shops = await prisma.shop.findMany({ where: { domain: { in: [SOURCE, DEST] } } });
const ids = shops.map((s) => s.id);
const del = await prisma.connection.deleteMany({ where: { sourceShopId: { in: ids }, destShopId: { in: ids } } });
const codes = await prisma.pairingCode.deleteMany({ where: { shopId: { in: ids } } });
const audit = await prisma.auditLog.deleteMany({ where: { shopDomain: { in: [SOURCE, DEST] } } });
for (const q of ["sync_jobs", "reconcile_jobs", "import_jobs"]) {
  await prisma.$queryRaw`SELECT pgmq.purge_queue(${q}::text)`;
}
console.log(`== db == connections deleted: ${del.count}, codes: ${codes.count}, audit rows: ${audit.count}, queues purged`);
console.log("Both stores are now at the 'Connect your first store' state. Products, sessions and webhooks kept.");
await prisma.$disconnect();
