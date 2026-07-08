// Create products that match by BARCODE, not SKU, so the importer records
// auto_barcode mappings (SKU is tried first; a differing SKU + shared
// barcode falls through to the barcode match).
//   node --env-file=.env scripts/seed-barcode-pairs.mjs <shop> source|dest
import { PrismaClient } from "@prisma/client";

const [shop, role] = process.argv.slice(2);
if (!shop || !["source", "dest"].includes(role)) {
  console.error("usage: node scripts/seed-barcode-pairs.mjs <shop> source|dest");
  process.exit(1);
}
const prisma = new PrismaClient();
const s = await prisma.session.findFirst({ where: { shop, isOnline: false } });
if (!s) { console.error("no session for " + shop); process.exit(1); }
const API = `https://${shop}/admin/api/2026-07/graphql.json`;
async function gql(query, variables) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": s.accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json();
  if (b.errors) throw new Error(JSON.stringify(b.errors).slice(0, 240));
  return b.data;
}
const loc = await gql(`{ locations(first:1, includeInactive:false){ nodes { id } } }`);
const locationId = loc.locations.nodes[0].id;

// Shared barcodes; SKUs differ per store so matching lands on barcode.
const PAIRS = [
  { title: "Aurora Candle", barcode: "8901234500001", qty: 30 },
  { title: "Linen Tote", barcode: "8901234500002", qty: 12 },
  { title: "Copper Mug", barcode: "8901234500003", qty: 47 },
  { title: "Field Notebook", barcode: "8901234500004", qty: 8 },
];
const skuPrefix = role === "source" ? "SRC" : "DST";

for (const [i, p] of PAIRS.entries()) {
  const sku = `${skuPrefix}-BC-${i + 1}`;
  const d = await gql(
    `mutation($input: ProductSetInput!) {
      productSet(input: $input, synchronous: true) {
        product { variants(first:1){ nodes { sku barcode } } }
        userErrors { field message }
      }
    }`,
    {
      input: {
        title: p.title,
        status: "ACTIVE",
        productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants: [
          {
            optionValues: [{ optionName: "Title", name: "Default Title" }],
            sku,
            barcode: p.barcode,
            price: "24.00",
            inventoryQuantities: [{ locationId, name: "available", quantity: p.qty }],
          },
        ],
      },
    },
  );
  const errs = d.productSet.userErrors;
  console.log(`  ${p.title}: sku=${sku} barcode=${p.barcode} ${errs.length ? "ERR " + errs.map((e) => e.message).join(";") : "ok"}`);
}
await prisma.$disconnect();
console.log("done");
