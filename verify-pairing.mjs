import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const conn = await prisma.connection.findFirst({
  where: { sourceShop: { domain: "mirror-sync.myshopify.com" }, destShop: { domain: "mirror-sync-dest.myshopify.com" } },
  include: { locationLinks: true, bulkImports: { orderBy: { startedAt: "desc" } } },
});
if (!conn) { console.log("NO CONNECTION YET"); process.exit(0); }
console.log(`CONNECTION: ${conn.id} status=${conn.status}${conn.pausedReason ? ` (${conn.pausedReason})` : ""}`);
for (const bi of conn.bulkImports) console.log(`  bulk ${bi.side}: ${bi.status}${bi.error ? " err=" + bi.error : ""}`);
for (const l of conn.locationLinks) console.log(`  locationLink: ${l.sourceLocationId} -> ${l.destLocationId}`);

const mappings = await prisma.mapping.findMany({ where: { connectionId: conn.id }, orderBy: { sku: "asc" } });
console.log(`MAPPINGS: ${mappings.length}`);
for (const m of mappings) console.log(`  ${m.sku}: ${m.matchType} ${m.status} src=${m.sourceInventoryItemId} dst=${m.destInventoryItemId}`);

const audit = await prisma.auditLog.findMany({ where: { connectionId: conn.id }, orderBy: { createdAt: "asc" } });
console.log(`AUDIT (${audit.length}):`);
for (const a of audit) console.log(`  [${a.level}/${a.kind}] ${a.message.slice(0, 130)}`);

for (const q of ["import_jobs", "reconcile_jobs", "sync_jobs"]) {
  const [{ queue_length }] = await prisma.$queryRaw`SELECT queue_length FROM pgmq.metrics(${q}::text)`;
  console.log(`queue ${q}: ${Number(queue_length)}`);
}
await prisma.$disconnect();
