import { createHash } from "node:crypto";

// Stable hash used for duplicate detection (payloadHash) and echo matching
// (valueHash). Key order is normalized so semantically equal objects hash
// equally.
export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

// GraphQL GIDs <-> numeric IDs (webhook payloads are REST-shaped and numeric).
export function toGid(type: string, id: bigint | number | string): string {
  return `gid://shopify/${type}/${id}`;
}

export function fromGid(gid: string): bigint {
  const last = gid.split("/").pop() ?? "";
  // Some GIDs carry query params (e.g. InventoryLevel/1?inventory_item_id=2)
  return BigInt(last.split("?")[0]);
}

export function inventoryKey(inventoryItemId: bigint | number | string, locationId: bigint | number | string): string {
  return `${inventoryItemId}:${locationId}`;
}
