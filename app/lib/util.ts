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

// Shopify's own webhook examples use IDs above Number.MAX_SAFE_INTEGER
// (e.g. inventory_item_id 271878346596884015), so a plain JSON.parse would
// silently corrupt them. We pre-scan the RAW text and wrap any oversized
// integer literal in quotes, so it parses as a string (BigInt() accepts
// both shapes downstream).
//
// Done as a string transform on purpose: the JSON.parse reviver's
// `context.source` argument only exists on Node 22+, and this app can run
// on Node 20 — there the reviver approach silently no-ops and corrupts IDs.
// This scanner works on every version.
export function parseJsonPreservingBigInts(text: string): unknown {
  return JSON.parse(quoteOversizedIntegers(text));
}

function quoteOversizedIntegers(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Copy the escaped char verbatim so a `\"` doesn't end the string.
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    // A number literal can only start here if the previous non-space
    // structural char was one that precedes a value (: , [ or start).
    if ((ch >= "0" && ch <= "9") || (ch === "-" && isNumberStart(out))) {
      let j = i;
      if (text[j] === "-") j += 1;
      const digitsStart = j;
      while (j < text.length && text[j] >= "0" && text[j] <= "9") j += 1;
      const isPureInteger = j < text.length ? !".eE".includes(text[j]) : true;
      const literal = text.slice(i, j);
      if (isPureInteger && j > digitsStart && !isSafeIntegerLiteral(literal)) {
        out += `"${literal}"`;
      } else {
        out += literal;
      }
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function isNumberStart(outSoFar: string): boolean {
  // '-' begins a number only in value position (after : , [ or at start).
  const prev = outSoFar.replace(/\s+$/, "").slice(-1);
  return prev === "" || prev === ":" || prev === "," || prev === "[";
}

function isSafeIntegerLiteral(literal: string): boolean {
  const n = Number(literal);
  return Number.isSafeInteger(n);
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
