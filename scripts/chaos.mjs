// Chaos-test helpers driven from the CLI:
//   node --env-file=.env scripts/chaos.mjs set <shop> <sku> <qty>     one write
//   node --env-file=.env scripts/chaos.mjs get <shop> <sku>           read available
//   node --env-full... flash <shop> <sku> <count> <intervalMs> <final> rapid-fire updates
//   node ... receipts <sinceIso>                                      count webhook receipts
//   node ... enqueue-reconcile <manual|scheduled> [mappingSku]        simulate cron / dashboard
//   node ... state <sku>                                              mapping row state
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const [cmd, ...args] = process.argv.slice(2);

async function session(shop) {
  const s = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!s) throw new Error("no session for " + shop);
  return s;
}
async function gql(shop, query, variables) {
  const s = await session(shop);
  const res = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": s.accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const b = await res.json();
  if (b.errors) throw new Error(JSON.stringify(b.errors).slice(0, 300));
  return b.data;
}
async function itemLoc(shop, sku) {
  const d = await gql(shop, `query($q:String!){ productVariants(first:1, query:$q){ nodes { sku inventoryItem { id inventoryLevels(first:5){ nodes { location { id } quantities(names:["available"]){ quantity } } } } } } }`, { q: `sku:${sku}` });
  const v = d.productVariants.nodes[0];
  if (!v) return null;
  const lvl = v.inventoryItem.inventoryLevels.nodes.find((n) => n.quantities.length);
  return { itemId: v.inventoryItem.id, locationId: lvl?.location.id, available: lvl?.quantities[0]?.quantity ?? null };
}
async function setQty(shop, sku, qty) {
  const t = await itemLoc(shop, sku);
  const d = await gql(shop, `mutation($input:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input){ userErrors { message code } } }`, {
    input: { name: "available", reason: "correction", ignoreCompareQuantity: true, referenceDocumentUri: "https://mirrorsync.app/chaos-external",
      quantities: [{ inventoryItemId: t.itemId, locationId: t.locationId, quantity: qty }] },
  });
  const errs = d.inventorySetQuantities.userErrors;
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return qty;
}

if (cmd === "get") {
  const t = await itemLoc(args[0], args[1]);
  console.log(t ? t.available : "NOT_FOUND");
} else if (cmd === "set") {
  await setQty(args[0], args[1], Number(args[2]));
  console.log("set", args[1], "=", args[2], "on", args[0]);
} else if (cmd === "flash") {
  const [shop, sku, countS, intervalS, finalS] = args;
  const count = Number(countS), interval = Number(intervalS), final = Number(finalS);
  const values = [];
  for (let i = 0; i < count - 1; i++) values.push(5 + Math.floor(((i * 37) % 60)));
  values.push(final);
  const t0 = Date.now();
  for (const [i, v] of values.entries()) {
    await setQty(shop, sku, v);
    process.stdout.write(`${v} `);
    if (i < values.length - 1) await new Promise((r) => setTimeout(r, interval));
  }
  console.log(`\n${count} updates in ${((Date.now() - t0) / 1000).toFixed(1)}s, final=${final}`);
} else if (cmd === "receipts") {
  const rows = await prisma.webhookReceipt.count({ where: { receivedAt: { gte: new Date(args[0]) }, topic: { contains: "INVENTORY" } } });
  console.log(rows);
} else if (cmd === "enqueue-reconcile") {
  const conn = await prisma.connection.findFirst({ where: { sourceShop: { domain: "mirror-sync.myshopify.com" }, destShop: { domain: "mirror-sync-dest.myshopify.com" } } });
  const job = { type: "reconcile_connection", connectionId: conn.id };
  if (args[0] === "manual") job.manual = true;
  if (args[1]) {
    const m = await prisma.mapping.findFirst({ where: { connectionId: conn.id, sku: args[1] } });
    job.mappingIds = [m.id];
  }
  await prisma.$queryRaw`SELECT pgmq.send('reconcile_jobs', ${JSON.stringify(job)}::jsonb, 0)`;
  console.log("enqueued", JSON.stringify(job));
} else if (cmd === "state") {
  const m = await prisma.mapping.findFirst({ where: { sku: args[0], connection: { destShop: { domain: "mirror-sync-dest.myshopify.com" } } } });
  console.log(JSON.stringify({ status: m.status, driftCount: m.driftCount, failureCount: m.failureCount, pauseReason: m.pauseReason }, null, 0));
} else if (cmd === "audit") {
  const rows = await prisma.auditLog.findMany({ where: { createdAt: { gte: new Date(args[0]) } }, orderBy: { createdAt: "asc" } });
  for (const a of rows) console.log(`[${a.level}/${a.kind}] ${a.message.slice(0, 150)}`);
} else if (cmd === "queue-depth") {
  for (const q of ["sync_jobs", "reconcile_jobs", "import_jobs"]) {
    const [{ queue_length }] = await prisma.$queryRaw`SELECT queue_length FROM pgmq.metrics(${q}::text)`;
    console.log(q, Number(queue_length));
  }
} else if (cmd === "set-buffer") {
  const conn = await prisma.connection.findFirst({ where: { sourceShop: { domain: "mirror-sync.myshopify.com" }, destShop: { domain: "mirror-sync-dest.myshopify.com" } } });
  await prisma.connection.update({ where: { id: conn.id }, data: { safetyStockBuffer: Number(args[0]) } });
  console.log("buffer =", args[0]);
} else {
  console.log("unknown cmd");
}
await prisma.$disconnect();
