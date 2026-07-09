import prisma from "../../db.server";
import type { InitialImportJob } from "../jobs";
import { QUEUES } from "../jobs";
import { enqueue } from "../queue.server";
import { fromGid } from "../util";
import {
  getBulkOperation,
  getCurrentBulkQuery,
  listLocations,
  startBulkExport,
} from "./admin.server";
import { checkPlanLimit } from "../plans.server";

// First pairing: export the full catalog from both stores with Bulk
// Operations, auto-match variants by SKU (then barcode), link locations,
// then hand over to a reconcile run for the first real inventory push.
//
// Runs as a small state machine over queue jobs so the worker never blocks:
// start -> poll (repeats) -> match.

const BULK_QUERY = `
{
  products {
    edges {
      node {
        id
        title
        variants {
          edges {
            node {
              id
              sku
              barcode
              inventoryItem { id }
            }
          }
        }
      }
    }
  }
}`;

export async function runInitialImport(job: InitialImportJob): Promise<void> {
  const conn = await prisma.connection.findUnique({
    where: { id: job.connectionId },
    include: { sourceShop: true, destShop: true },
  });
  if (!conn || conn.status === "disabled") return;

  switch (job.step) {
    case "start":
      return stepStart(conn);
    case "poll":
      return stepPoll(conn);
    case "match":
      return stepMatch(conn);
  }
}

type Conn = NonNullable<
  Awaited<ReturnType<typeof prisma.connection.findUnique<{
    where: { id: string };
    include: { sourceShop: true; destShop: true };
  }>>>
>;

async function stepStart(conn: Conn): Promise<void> {
  for (const side of ["source", "dest"] as const) {
    const shop = side === "source" ? conn.sourceShop.domain : conn.destShop.domain;

    // Idempotent: if this attempt already kicked off (or finished) this
    // side, don't start it again. Without this, a transient failure after
    // the source export started makes every retry re-call startBulkExport,
    // which Shopify rejects ("a bulk operation is already in progress")
    // until the export finishes — often past the retry ladder, stranding
    // the connection in 'importing' forever.
    const already = await prisma.bulkImport.findFirst({
      where: { connectionId: conn.id, side, status: { in: ["running", "completed"] } },
    });
    if (already) continue;

    let opId: string;
    try {
      opId = await startBulkExport(shop, BULK_QUERY);
    } catch (e) {
      // Collision with an in-flight bulk query (ours from a prior attempt,
      // or another app's): adopt the running one rather than failing.
      const current = await getCurrentBulkQuery(shop);
      if (current && (current.status === "RUNNING" || current.status === "CREATED")) {
        opId = current.id;
      } else {
        throw e;
      }
    }
    await prisma.bulkImport.create({
      data: { connectionId: conn.id, side, bulkOperationId: opId, status: "running" },
    });
  }
  await prisma.auditLog.create({
    data: {
      connectionId: conn.id,
      shopDomain: conn.sourceShop.domain,
      kind: "import",
      message: `Initial import started: exporting product catalogs from ${conn.sourceShop.domain} and ${conn.destShop.domain}.`,
    },
  });
  // Small catalogs finish their bulk export in seconds; poll early and
  // often (the poll is one cheap query per side).
  await enqueue(QUEUES.import, { type: "initial_import", connectionId: conn.id, step: "poll" }, 4);
}

async function stepPoll(conn: Conn): Promise<void> {
  const imports = await latestImports(conn.id);
  let allDone = true;

  for (const imp of Object.values(imports)) {
    if (!imp || imp.status === "completed") continue;
    const shop = imp.side === "source" ? conn.sourceShop.domain : conn.destShop.domain;
    const op = await getBulkOperation(shop, imp.bulkOperationId!);

    if (op.status === "COMPLETED") {
      await prisma.bulkImport.update({
        where: { id: imp.id },
        data: { status: "completed", url: op.url, completedAt: new Date() },
      });
    } else if (["FAILED", "CANCELED", "EXPIRED"].includes(op.status)) {
      await prisma.bulkImport.update({
        where: { id: imp.id },
        data: { status: "failed", error: op.errorCode ?? op.status },
      });
      await prisma.$transaction([
        prisma.connection.update({
          where: { id: conn.id },
          data: { status: "paused", pausedReason: "Initial import failed" },
        }),
        prisma.auditLog.create({
          data: {
            connectionId: conn.id,
            shopDomain: shop,
            level: "error",
            kind: "import",
            message: `Catalog export failed at ${shop} (${op.errorCode ?? op.status}). Use "Restart import" on the Connections page to try again.`,
          },
        }),
      ]);
      return; // stop the state machine; restart is manual
    } else {
      allDone = false; // still CREATED / RUNNING
    }
  }

  if (!allDone) {
    // Re-enqueue instead of throwing: polling is not a failure, it must
    // not eat retry attempts.
    await enqueue(QUEUES.import, { type: "initial_import", connectionId: conn.id, step: "poll" }, 6);
    return;
  }
  await enqueue(QUEUES.import, { type: "initial_import", connectionId: conn.id, step: "match" });
}

type CatalogVariant = {
  variantId: bigint;
  productId: bigint;
  inventoryItemId: bigint;
  sku: string | null;
  barcode: string | null;
};

async function stepMatch(conn: Conn): Promise<void> {
  const imports = await latestImports(conn.id);
  const source = imports.source;
  const dest = imports.dest;
  if (!source?.url || !dest?.url) {
    throw new Error(`Import for connection ${conn.id} is missing bulk result URLs`);
  }

  const [sourceCatalog, destCatalog] = [
    await downloadCatalog(source.url),
    await downloadCatalog(dest.url),
  ];

  // Index destination by normalized SKU and barcode. Values that appear on
  // more than one destination variant are ambiguous — never guess.
  const bySku = indexUnique(destCatalog, (v) => normalize(v.sku));
  const byBarcode = indexUnique(destCatalog, (v) => normalize(v.barcode));

  // SOURCE-side duplicates matter too: Shopify allows the same SKU on
  // multiple variants. Two source variants sharing a SKU would both map to
  // the same destination variant and fight over its quantity forever, and
  // reconcile would eventually pause both for "drift". Skip and flag them,
  // exactly like destination ambiguity.
  const sourceSkuDup = duplicatedKeys(sourceCatalog, (v) => normalize(v.sku));
  const sourceBarcodeDup = duplicatedKeys(sourceCatalog, (v) => normalize(v.barcode));

  let matchedSku = 0;
  let matchedBarcode = 0;
  let unmatched = 0;
  let ambiguous = 0;

  // Match entirely in memory first. Writes happen in ONE transaction below,
  // so the dashboard never sees a half-written mapping table (the SKU count
  // jumps from "matching…" straight to the final number, together with the
  // status flip and the audit entry).
  type MatchedRow = { sv: CatalogVariant; dv: CatalogVariant; matchType: string };
  const matched: MatchedRow[] = [];

  for (const sv of sourceCatalog) {
    const skuKey = normalize(sv.sku);
    const barcodeKey = normalize(sv.barcode);

    // Skip source variants whose SKU/barcode is duplicated on the SOURCE
    // side (see sourceSkuDup above).
    if ((skuKey && sourceSkuDup.has(skuKey)) || (barcodeKey && sourceBarcodeDup.has(barcodeKey))) {
      ambiguous++;
      continue;
    }

    let dv = skuKey ? bySku.unique.get(skuKey) : undefined;
    let matchType = "auto_sku";
    if (!dv) {
      dv = barcodeKey ? byBarcode.unique.get(barcodeKey) : undefined;
      matchType = "auto_barcode";
    }
    if (!dv && ((skuKey && bySku.duplicates.has(skuKey)) || (barcodeKey && byBarcode.duplicates.has(barcodeKey)))) {
      ambiguous++;
      continue;
    }
    if (!dv) {
      unmatched++;
      continue;
    }
    if (matchType === "auto_sku") matchedSku++;
    else matchedBarcode++;
    matched.push({ sv, dv, matchType });
  }

  await autoLinkLocations(conn);

  // Split into creates vs updates against the current table. Manual
  // mappings are still protected at WRITE time (the updateMany guard),
  // so a manual-map saved mid-import can't be clobbered.
  const existing = await prisma.mapping.findMany({
    where: { connectionId: conn.id },
    select: { sourceVariantId: true, matchType: true, status: true },
  });
  const existingByVid = new Map(existing.map((e) => [e.sourceVariantId.toString(), e]));
  const rowData = ({ sv, dv, matchType }: MatchedRow) => ({
    sku: sv.sku,
    barcode: sv.barcode,
    sourceProductId: sv.productId,
    sourceInventoryItemId: sv.inventoryItemId,
    destProductId: dv.productId,
    destVariantId: dv.variantId,
    destInventoryItemId: dv.inventoryItemId,
    matchType,
  });
  const creates = matched
    .filter((m) => !existingByVid.has(m.sv.variantId.toString()))
    .map((m) => ({ connectionId: conn.id, sourceVariantId: m.sv.variantId, ...rowData(m) }));
  const updates = matched.filter((m) => {
    const e = existingByVid.get(m.sv.variantId.toString());
    return e && e.matchType !== "manual";
  });
  const updateStatements = updates.map((m) =>
    prisma.mapping.updateMany({
      where: { connectionId: conn.id, sourceVariantId: m.sv.variantId, matchType: { not: "manual" } },
      data: rowData(m),
    }),
  );

  // Plan limit is enforced where mappings are born (here and at manual
  // mapping): over the cap, the connection pauses instead of half-syncing.
  const planCheck = await checkPlanLimit(conn.sourceShop.domain);
  const projectedUsed = planCheck.used + creates.length;

  // A re-import refreshes mapping targets but deliberately does NOT revive
  // SKUs that were auto-paused (write failures / drift) — that needs the
  // merchant's explicit "Resync now". Say so, or the pause looks like a bug.
  const stillPaused = existing.filter((e) => e.status === "paused").length;

  const mappingWrites = [
    prisma.mapping.createMany({ data: creates, skipDuplicates: true }),
    ...updateStatements,
  ];

  if (projectedUsed > planCheck.limit) {
    await prisma.$transaction([
      ...mappingWrites,
      prisma.connection.update({
        where: { id: conn.id },
        data: {
          status: "paused",
          pausedReason: `Plan limit: ${projectedUsed} SKUs matched, the ${planCheck.plan} plan covers ${planCheck.limit}`,
        },
      }),
      prisma.auditLog.create({
        data: {
          connectionId: conn.id,
          shopDomain: conn.sourceShop.domain,
          level: "warn",
          kind: "import",
          message: `Matching found ${projectedUsed} SKUs, but the ${planCheck.plan} plan covers ${planCheck.limit}. Sync is paused — upgrade the plan (Overview page) or unlink SKUs, then use "Resync now".`,
        },
      }),
    ]);
    return;
  }

  await prisma.$transaction([
    ...mappingWrites,
    prisma.connection.update({ where: { id: conn.id }, data: { status: "active" } }),
    prisma.auditLog.create({
      data: {
        connectionId: conn.id,
        shopDomain: conn.sourceShop.domain,
        kind: "import",
        level: stillPaused > 0 ? "warn" : "info",
        message:
          `Initial matching finished: ${matchedSku} SKUs matched by SKU, ${matchedBarcode} by barcode` +
          `${ambiguous > 0 ? `, ${ambiguous} skipped because the same SKU/barcode exists on several destination products (map them manually)` : ""}` +
          `${unmatched > 0 ? `, ${unmatched} had no match at ${conn.destShop.domain}` : ""}. Now pushing initial inventory levels.` +
          `${stillPaused > 0 ? ` Note: ${stillPaused} SKU${stillPaused === 1 ? " is" : "s are"} still paused and won't sync — use "Resync now" on the Health page to resume ${stillPaused === 1 ? "it" : "them"}.` : ""}`,
      },
    }),
  ]);

  // The first inventory push IS a reconciliation pass.
  await enqueue(QUEUES.reconcile, { type: "reconcile_connection", connectionId: conn.id });
}

async function autoLinkLocations(conn: Conn): Promise<void> {
  const existing = await prisma.locationLink.count({ where: { connectionId: conn.id } });
  if (existing > 0) return;

  const [sourceLocations, destLocations] = [
    await listLocations(conn.sourceShop.domain),
    await listLocations(conn.destShop.domain),
  ];

  // Single location on both sides: the only sensible link, make it.
  if (sourceLocations.length === 1 && destLocations.length === 1) {
    await prisma.locationLink.create({
      data: {
        connectionId: conn.id,
        sourceLocationId: sourceLocations[0].id,
        destLocationId: destLocations[0].id,
      },
    });
    return;
  }

  // Multi-location: link exact name matches, surface the rest.
  const destByName = new Map(destLocations.map((l) => [l.name.toLowerCase(), l]));
  let linked = 0;
  for (const sl of sourceLocations) {
    const dl = destByName.get(sl.name.toLowerCase());
    if (dl) {
      await prisma.locationLink.create({
        data: { connectionId: conn.id, sourceLocationId: sl.id, destLocationId: dl.id },
      });
      linked++;
    }
  }
  if (linked < sourceLocations.length) {
    await prisma.auditLog.create({
      data: {
        connectionId: conn.id,
        shopDomain: conn.sourceShop.domain,
        level: "warn",
        kind: "import",
        message: `${sourceLocations.length - linked} of ${sourceLocations.length} locations at ${conn.sourceShop.domain} could not be matched by name at ${conn.destShop.domain}. Inventory at unlinked locations is not synced — link them on the Connections page.`,
      },
    });
  }
}

async function latestImports(connectionId: string) {
  const rows = await prisma.bulkImport.findMany({
    where: { connectionId },
    orderBy: { startedAt: "desc" },
  });
  return {
    source: rows.find((r) => r.side === "source"),
    dest: rows.find((r) => r.side === "dest"),
  };
}

// Bulk result JSONL: product lines first, variant lines follow with
// __parentId pointing at their product.
async function downloadCatalog(url: string): Promise<CatalogVariant[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Bulk result download failed: HTTP ${response.status}`);
  const text = await response.text();

  const variants: CatalogVariant[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      id: string;
      __parentId?: string;
      sku?: string | null;
      barcode?: string | null;
      inventoryItem?: { id: string };
    };
    if (!row.__parentId || !row.inventoryItem) continue; // product line, not variant
    variants.push({
      variantId: fromGid(row.id),
      productId: fromGid(row.__parentId),
      inventoryItemId: fromGid(row.inventoryItem.id),
      sku: row.sku || null,
      barcode: row.barcode || null,
    });
  }
  return variants;
}

function normalize(value: string | null | undefined): string | null {
  const v = value?.trim().toUpperCase();
  return v ? v : null;
}

function indexUnique(
  catalog: CatalogVariant[],
  keyOf: (v: CatalogVariant) => string | null,
): { unique: Map<string, CatalogVariant>; duplicates: Set<string> } {
  const unique = new Map<string, CatalogVariant>();
  const duplicates = new Set<string>();
  for (const v of catalog) {
    const key = keyOf(v);
    if (!key) continue;
    if (duplicates.has(key)) continue;
    if (unique.has(key)) {
      unique.delete(key);
      duplicates.add(key);
      continue;
    }
    unique.set(key, v);
  }
  return { unique, duplicates };
}

// Normalized keys that appear on more than one variant in a catalog.
function duplicatedKeys(
  catalog: CatalogVariant[],
  keyOf: (v: CatalogVariant) => string | null,
): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of catalog) {
    const key = keyOf(v);
    if (!key) continue;
    if (seen.has(key)) dup.add(key);
    else seen.add(key);
  }
  return dup;
}
