import prisma from "../../db.server";
import { unauthenticated } from "../../shopify.server";

// Admin API access for background jobs (no request context): offline
// session token via unauthenticated.admin(shop), plus a per-shop rate
// budget persisted in Postgres so restarts don't forget throttle state.

export class RateLimitedError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`Rate limited, retry in ${retryAfterSeconds}s`);
  }
}

export class ShopApiError extends Error {
  constructor(
    message: string,
    public userErrors?: { field?: string[] | null; message: string }[],
  ) {
    super(message);
  }
}

// Minimum cost points we want in the bucket before making a call. A single
// query costs <20, mutations ~10; 100 leaves room for a burst.
const MIN_BUDGET = 100;
const DEFAULT_RESTORE_RATE = 100; // points/s on the lowest plan tier

type CostExtensions = {
  cost?: {
    requestedQueryCost: number;
    actualQueryCost: number | null;
    throttleStatus?: {
      maximumAvailable: number;
      currentlyAvailable: number;
      restoreRate: number;
    };
  };
};

export async function graphql<T = unknown>(
  shop: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  await checkBudget(shop);

  const { admin } = await unauthenticated.admin(shop);
  let body: { data?: T; extensions?: CostExtensions };
  try {
    const response = await admin.graphql(query, variables ? { variables } : undefined);
    body = (await response.json()) as typeof body;
  } catch (e) {
    // Top-level GraphQL errors are never returned in the body: the
    // underlying client throws a GraphqlQueryError carrying them in
    // error.body. Duck-typed (not instanceof) so we don't import from a
    // transitive package.
    const errBody = (e as { body?: { errors?: { message?: string; extensions?: { code?: string } }[]; extensions?: CostExtensions } })?.body;
    if (errBody?.errors?.length) {
      const throttleStatus = errBody.extensions?.cost?.throttleStatus;
      if (throttleStatus) await saveBudget(shop, throttleStatus);
      const throttled = errBody.errors.some((err) => err.extensions?.code === "THROTTLED");
      if (throttled) {
        const wait = throttleStatus
          ? Math.ceil(
              ((errBody.extensions?.cost?.requestedQueryCost ?? MIN_BUDGET) -
                throttleStatus.currentlyAvailable) /
                Math.max(1, throttleStatus.restoreRate),
            )
          : 5;
        throw new RateLimitedError(Math.max(1, wait));
      }
      throw new ShopApiError(errBody.errors.map((err) => err.message ?? "GraphQL error").join("; "));
    }
    throw e;
  }

  const throttleStatus = body.extensions?.cost?.throttleStatus;
  if (throttleStatus) await saveBudget(shop, throttleStatus);

  if (!body.data) throw new ShopApiError("Empty GraphQL response");
  return body.data;
}

// Project the cost bucket forward from the last observed state; if it's
// too empty, tell the worker how long to shelve the job.
async function checkBudget(shop: string): Promise<void> {
  const row = await prisma.shop.findUnique({
    where: { domain: shop },
    select: { rateAvailable: true, rateMax: true, rateRestoreRate: true, rateUpdatedAt: true },
  });
  if (!row?.rateAvailable || !row.rateUpdatedAt) return; // no data yet: go
  const restore = row.rateRestoreRate ?? DEFAULT_RESTORE_RATE;
  const max = row.rateMax ?? 1000;
  const elapsed = (Date.now() - row.rateUpdatedAt.getTime()) / 1000;
  const projected = Math.min(max, row.rateAvailable + elapsed * restore);
  if (projected < MIN_BUDGET) {
    throw new RateLimitedError(Math.max(1, Math.ceil((MIN_BUDGET - projected) / restore)));
  }
}

async function saveBudget(
  shop: string,
  s: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number },
): Promise<void> {
  await prisma.shop.updateMany({
    where: { domain: shop },
    data: {
      rateAvailable: s.currentlyAvailable,
      rateMax: s.maximumAvailable,
      rateRestoreRate: s.restoreRate,
      rateUpdatedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Typed operations used by the sync engine
// ---------------------------------------------------------------------------

export async function getInventoryAvailable(
  shop: string,
  inventoryItemGid: string,
  locationGid: string,
): Promise<number | null> {
  const data = await graphql<{
    inventoryItem: {
      inventoryLevel: { quantities: { name: string; quantity: number }[] } | null;
    } | null;
  }>(
    shop,
    `#graphql
    query mirrorSyncGetAvailable($itemId: ID!, $locationId: ID!) {
      inventoryItem(id: $itemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) { name quantity }
        }
      }
    }`,
    { itemId: inventoryItemGid, locationId: locationGid },
  );
  const quantities = data.inventoryItem?.inventoryLevel?.quantities;
  return quantities?.find((q) => q.name === "available")?.quantity ?? null;
}

export async function setInventoryAvailable(
  shop: string,
  inventoryItemGid: string,
  locationGid: string,
  quantity: number,
  referenceUri: string,
): Promise<void> {
  const data = await graphql<{
    inventorySetQuantities: {
      userErrors: { field?: string[] | null; message: string }[];
    };
  }>(
    shop,
    `#graphql
    mutation mirrorSyncSetAvailable($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        referenceDocumentUri: referenceUri,
        quantities: [{ inventoryItemId: inventoryItemGid, locationId: locationGid, quantity }],
      },
    },
  );
  const errors = data.inventorySetQuantities.userErrors;
  if (errors.length > 0) {
    throw new ShopApiError(
      `inventorySetQuantities failed: ${errors.map((e) => e.message).join("; ")}`,
      errors,
    );
  }
}

export type ProductSnapshot = {
  title: string;
  tags: string[];
  variantPrices: Map<bigint, string>;
};

export async function getProductSnapshot(
  shop: string,
  productGid: string,
): Promise<ProductSnapshot | null> {
  const data = await graphql<{
    product: {
      title: string;
      tags: string[];
      variants: { nodes: { id: string; price: string }[] };
    } | null;
  }>(
    shop,
    `#graphql
    query mirrorSyncProductSnapshot($id: ID!) {
      product(id: $id) {
        title
        tags
        variants(first: 250) { nodes { id price } }
      }
    }`,
    { id: productGid },
  );
  if (!data.product) return null;
  const variantPrices = new Map<bigint, string>();
  for (const v of data.product.variants.nodes) {
    variantPrices.set(BigInt(v.id.split("/").pop()!), v.price);
  }
  return { title: data.product.title, tags: data.product.tags, variantPrices };
}

export async function updateProductFields(
  shop: string,
  productGid: string,
  fields: { title?: string; tags?: string[] },
): Promise<void> {
  const data = await graphql<{
    productUpdate: { userErrors: { message: string }[] };
  }>(
    shop,
    `#graphql
    mutation mirrorSyncProductUpdate($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        userErrors { field message }
      }
    }`,
    { product: { id: productGid, ...fields } },
  );
  if (data.productUpdate.userErrors.length > 0) {
    throw new ShopApiError(
      `productUpdate failed: ${data.productUpdate.userErrors.map((e) => e.message).join("; ")}`,
    );
  }
}

export async function updateVariantPrices(
  shop: string,
  productGid: string,
  variants: { variantGid: string; price: string }[],
): Promise<void> {
  const data = await graphql<{
    productVariantsBulkUpdate: { userErrors: { message: string }[] };
  }>(
    shop,
    `#graphql
    mutation mirrorSyncVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }`,
    {
      productId: productGid,
      variants: variants.map((v) => ({ id: v.variantGid, price: v.price })),
    },
  );
  if (data.productVariantsBulkUpdate.userErrors.length > 0) {
    throw new ShopApiError(
      `productVariantsBulkUpdate failed: ${data.productVariantsBulkUpdate.userErrors
        .map((e) => e.message)
        .join("; ")}`,
    );
  }
}

// First write to an item the destination doesn't stock at that location:
// activate it there with the initial quantity in one call.
export async function activateInventory(
  shop: string,
  inventoryItemGid: string,
  locationGid: string,
  available: number,
): Promise<void> {
  const data = await graphql<{
    inventoryActivate: { userErrors: { message: string }[] };
  }>(
    shop,
    `#graphql
    mutation mirrorSyncActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
        userErrors { field message }
      }
    }`,
    { inventoryItemId: inventoryItemGid, locationId: locationGid, available },
  );
  if (data.inventoryActivate.userErrors.length > 0) {
    throw new ShopApiError(
      `inventoryActivate failed: ${data.inventoryActivate.userErrors.map((e) => e.message).join("; ")}`,
    );
  }
}

// Batched read for reconciliation: available quantity for many inventory
// items at one location in a single query.
export async function getInventoryAvailableBatch(
  shop: string,
  inventoryItemGids: string[],
  locationGid: string,
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (inventoryItemGids.length === 0) return result;
  const data = await graphql<{
    nodes: ({
      id: string;
      inventoryLevel: { quantities: { name: string; quantity: number }[] } | null;
    } | null)[];
  }>(
    shop,
    `#graphql
    query mirrorSyncAvailableBatch($ids: [ID!]!, $locationId: ID!) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }`,
    { ids: inventoryItemGids, locationId: locationGid },
  );
  for (const node of data.nodes) {
    if (!node?.id) continue;
    const qty = node.inventoryLevel?.quantities.find((q) => q.name === "available")?.quantity;
    result.set(node.id, qty ?? null);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bulk operations + locations (initial import)
// ---------------------------------------------------------------------------

export async function startBulkExport(shop: string, bulkQuery: string): Promise<string> {
  const data = await graphql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: { message: string }[];
    };
  }>(
    shop,
    `#graphql
    mutation mirrorSyncBulkExport($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { query: bulkQuery },
  );
  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (userErrors.length > 0 || !bulkOperation) {
    throw new ShopApiError(
      `bulkOperationRunQuery failed: ${userErrors.map((e) => e.message).join("; ") || "no operation returned"}`,
    );
  }
  return bulkOperation.id;
}

export type BulkOperationStatus = {
  status: string; // CREATED | RUNNING | COMPLETED | FAILED | CANCELED | EXPIRED
  url: string | null;
  errorCode: string | null;
  objectCount: string;
};

export async function getBulkOperation(shop: string, gid: string): Promise<BulkOperationStatus> {
  const data = await graphql<{
    node: (BulkOperationStatus & { id: string }) | null;
  }>(
    shop,
    `#graphql
    query mirrorSyncBulkStatus($id: ID!) {
      node(id: $id) {
        ... on BulkOperation { id status url errorCode objectCount }
      }
    }`,
    { id: gid },
  );
  if (!data.node) throw new ShopApiError(`Bulk operation ${gid} not found`);
  return data.node;
}

export type ShopLocation = { id: bigint; name: string; isActive: boolean };

export async function listLocations(shop: string): Promise<ShopLocation[]> {
  const data = await graphql<{
    locations: { nodes: { id: string; name: string; isActive: boolean }[] };
  }>(
    shop,
    `#graphql
    query mirrorSyncLocations {
      locations(first: 50, includeInactive: false) {
        nodes { id name isActive }
      }
    }`,
  );
  return data.locations.nodes.map((l) => ({
    id: BigInt(l.id.split("/").pop()!),
    name: l.name,
    isActive: l.isActive,
  }));
}

export type Metafield = { namespace: string; key: string; type: string; value: string };

export async function getProductMetafields(
  shop: string,
  productGid: string,
  namespaces: string[],
): Promise<Metafield[]> {
  const data = await graphql<{
    product: {
      metafields: { nodes: Metafield[] };
    } | null;
  }>(
    shop,
    `#graphql
    query mirrorSyncProductMetafields($id: ID!) {
      product(id: $id) {
        metafields(first: 250) { nodes { namespace key type value } }
      }
    }`,
    { id: productGid },
  );
  const all = data.product?.metafields.nodes ?? [];
  return all.filter((m) => namespaces.includes(m.namespace));
}

export async function setMetafields(
  shop: string,
  ownerGid: string,
  metafields: Metafield[],
): Promise<void> {
  if (metafields.length === 0) return;
  const data = await graphql<{
    metafieldsSet: { userErrors: { message: string }[] };
  }>(
    shop,
    `#graphql
    mutation mirrorSyncMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      metafields: metafields.map((m) => ({ ...m, ownerId: ownerGid })),
    },
  );
  if (data.metafieldsSet.userErrors.length > 0) {
    throw new ShopApiError(
      `metafieldsSet failed: ${data.metafieldsSet.userErrors.map((e) => e.message).join("; ")}`,
    );
  }
}
