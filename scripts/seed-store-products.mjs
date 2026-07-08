// Seed test products (matching SKUs) into a dev store via the Admin API,
// using the offline token stored by the app install.
//   node --env-file=.env scripts/seed-store-products.mjs <shop-domain> <mode>
// mode "source": realistic stock levels. mode "dest": deliberately wrong
// stock, so the first sync visibly corrects it.
import { PrismaClient } from "@prisma/client";

const [shop, mode] = process.argv.slice(2);
if (!shop || !["source", "dest"].includes(mode)) {
  console.error("usage: node scripts/seed-store-products.mjs <shop.myshopify.com> source|dest");
  process.exit(1);
}

const prisma = new PrismaClient();
const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
if (!session) {
  console.error(`No offline session for ${shop} — is the app installed there?`);
  process.exit(1);
}

const API = `https://${shop}/admin/api/2025-10/graphql.json`;
async function gql(query, variables) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const loc = await gql(`{ locations(first: 1, includeInactive: false) { nodes { id name } } }`);
const locationId = loc.locations.nodes[0].id;
console.log(`${shop}: location ${loc.locations.nodes[0].name} (${locationId})`);

const PRODUCTS = [
  { title: "Sync Test Tee M", sku: "SYNC-TEE-M", price: "19.90", source: 25, dest: 3 },
  { title: "Sync Test Tee L", sku: "SYNC-TEE-L", price: "19.90", source: 8, dest: 99 },
  { title: "Sync Test Cap", sku: "SYNC-CAP", price: "14.50", source: 42, dest: 0 },
];

for (const p of PRODUCTS) {
  const qty = mode === "source" ? p.source : p.dest;
  const data = await gql(
    `mutation seedProduct($input: ProductSetInput!) {
      productSet(input: $input, synchronous: true) {
        product { id variants(first: 1) { nodes { sku } } }
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
            sku: p.sku,
            price: p.price,
            inventoryQuantities: [{ locationId, name: "available", quantity: qty }],
          },
        ],
      },
    },
  );
  const errs = data.productSet.userErrors;
  if (errs.length) console.log(`  ${p.sku}: ERROR ${errs.map((e) => e.message).join("; ")}`);
  else console.log(`  ${p.sku}: ok (available=${qty})`);
}

await prisma.$disconnect();
console.log("done");
