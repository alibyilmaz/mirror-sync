import { describe, expect, it } from "vitest";
import {
  checkVersion,
  decideWrite,
  diffProductFields,
  isEmptyProductDiff,
  isOwnEcho,
  sameTags,
  shouldPauseAfterDrift,
  shouldPauseAfterFailure,
  targetQuantity,
  ECHO_TTL_MS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_DRIFT_REPAIRS,
} from "./decisions";
import { wouldCreateCycle } from "../graph";
import { parseJsonPreservingBigInts, stableHash } from "../util";

const t = (iso: string) => new Date(iso);

describe("checkVersion — duplicate + out-of-order webhooks are normal input", () => {
  const mark = { version: t("2026-07-08T10:00:00Z"), payloadHash: "h1" };

  it("accepts the first event for a resource (no watermark yet)", () => {
    expect(checkVersion(t("2026-07-08T10:00:00Z"), "h1", null)).toEqual({ ok: true });
  });

  it("rejects a strictly older event (out-of-order delivery)", () => {
    expect(checkVersion(t("2026-07-08T09:59:59Z"), "h0", mark)).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("rejects an identical redelivery (same version, same payload)", () => {
    expect(checkVersion(t("2026-07-08T10:00:00Z"), "h1", mark)).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("accepts same-second events with different payloads (rapid edits)", () => {
    expect(checkVersion(t("2026-07-08T10:00:00Z"), "h2", mark)).toEqual({ ok: true });
  });

  it("accepts newer events", () => {
    expect(checkVersion(t("2026-07-08T10:00:01Z"), "h2", mark)).toEqual({ ok: true });
  });

  it("does not treat same version as duplicate when stored hash is unknown", () => {
    const noHash = { version: t("2026-07-08T10:00:00Z"), payloadHash: null };
    expect(checkVersion(t("2026-07-08T10:00:00Z"), "h1", noHash)).toEqual({ ok: true });
  });
});

describe("targetQuantity — oversell buffer", () => {
  it("subtracts the safety stock buffer", () => {
    expect(targetQuantity(10, 3)).toBe(7);
  });
  it("never goes below zero", () => {
    expect(targetQuantity(2, 5)).toBe(0);
    expect(targetQuantity(-4, 0)).toBe(0); // Shopify can report negatives
  });
  it("ignores a negative buffer", () => {
    expect(targetQuantity(10, -5)).toBe(10);
  });
});

describe("decideWrite — write only when the destination differs", () => {
  it("skips when destination already has the target value (no-op)", () => {
    expect(decideWrite(7, 7)).toEqual({ write: false, reason: "noop" });
  });

  it("writes when values differ", () => {
    expect(decideWrite(7, 5)).toEqual({ write: true, target: 7 });
  });

  it("writes (activates) when the destination has no level yet", () => {
    expect(decideWrite(7, null)).toEqual({ write: true, target: 7 });
  });

  it("does NOT suppress a repair just because we once wrote this value", () => {
    // The old outbound echo check wrongly blocked this: a third party set
    // the destination to 5, and we must correct it back to 7 even though 7
    // is a value we previously wrote. Loop-safety now lives inbound.
    expect(decideWrite(7, 5)).toEqual({ write: true, target: 7 });
  });

  // The ping-pong scenario: A -> B and (misconfigured) B -> A. A=7 gets
  // written to B; B's webhook comes back toward A. A already has 7, so the
  // write decision is a no-op and the loop dies immediately.
  it("kills a two-store ping-pong via the no-op rule", () => {
    expect(decideWrite(7, 7).write).toBe(false);
  });
});

describe("isOwnEcho — inbound origin tagging stops chains looping", () => {
  const now = t("2026-07-08T12:00:00Z");
  const hash7 = stableHash(7);

  it("recognizes the echo of a value we just wrote to this shop", () => {
    expect(isOwnEcho(hash7, { valueHash: hash7, writtenAt: t("2026-07-08T11:55:00Z") }, now)).toBe(
      true,
    );
  });

  it("ignores an echo record older than the TTL (real change)", () => {
    const old = new Date(now.getTime() - ECHO_TTL_MS - 1);
    expect(isOwnEcho(hash7, { valueHash: hash7, writtenAt: old }, now)).toBe(false);
  });

  it("passes through a genuine third-party change (different value)", () => {
    expect(isOwnEcho(stableHash(9), { valueHash: hash7, writtenAt: t("2026-07-08T11:59:00Z") }, now)).toBe(
      false,
    );
  });

  it("passes through when there is no echo record", () => {
    expect(isOwnEcho(hash7, null, now)).toBe(false);
  });
});

describe("pause thresholds — oversell guard", () => {
  it("pauses after consecutive write failures", () => {
    expect(shouldPauseAfterFailure(MAX_CONSECUTIVE_FAILURES - 1)).toBe(false);
    expect(shouldPauseAfterFailure(MAX_CONSECUTIVE_FAILURES)).toBe(true);
  });
  it("pauses after repeated drift repairs on the same SKU", () => {
    expect(shouldPauseAfterDrift(MAX_DRIFT_REPAIRS - 1)).toBe(false);
    expect(shouldPauseAfterDrift(MAX_DRIFT_REPAIRS)).toBe(true);
  });
});

describe("wouldCreateCycle — pairing keeps the graph acyclic", () => {
  it("rejects a self-loop", () => {
    expect(wouldCreateCycle([], "a", "a")).toBe(true);
  });
  it("rejects the direct reverse of an existing connection", () => {
    expect(wouldCreateCycle([{ sourceShopId: "a", destShopId: "b" }], "b", "a")).toBe(true);
  });
  it("rejects a longer cycle (a->b->c, adding c->a)", () => {
    const edges = [
      { sourceShopId: "a", destShopId: "b" },
      { sourceShopId: "b", destShopId: "c" },
    ];
    expect(wouldCreateCycle(edges, "c", "a")).toBe(true);
  });
  it("allows chains and fan-out", () => {
    const edges = [
      { sourceShopId: "a", destShopId: "b" },
      { sourceShopId: "a", destShopId: "c" },
    ];
    expect(wouldCreateCycle(edges, "b", "c")).toBe(false); // a->b->c chain stays acyclic
    expect(wouldCreateCycle(edges, "b", "d")).toBe(false);
  });
});

describe("parseJsonPreservingBigInts — Shopify IDs above 2^53 must not corrupt", () => {
  it("keeps oversized integer IDs as exact strings", () => {
    // Real ID from Shopify's webhook documentation examples.
    const raw = '{"inventory_item_id":271878346596884015,"available":10}';
    const parsed = parseJsonPreservingBigInts(raw) as Record<string, unknown>;
    expect(parsed.inventory_item_id).toBe("271878346596884015");
    expect(BigInt(parsed.inventory_item_id as string)).toBe(271878346596884015n);
    expect(parsed.available).toBe(10); // small numbers stay numbers
  });

  it("leaves safe integers, floats and non-numeric fields untouched", () => {
    const raw = '{"id":123,"price":"10.00","weight":1.25,"nested":{"location_id":24826418}}';
    const parsed = parseJsonPreservingBigInts(raw) as {
      id: number;
      price: string;
      weight: number;
      nested: { location_id: number };
    };
    expect(parsed.id).toBe(123);
    expect(parsed.price).toBe("10.00");
    expect(parsed.weight).toBe(1.25);
    expect(parsed.nested.location_id).toBe(24826418);
  });

  it("handles oversized IDs inside arrays (product variants)", () => {
    const raw = '{"variants":[{"id":9007199254740993}]}';
    const parsed = parseJsonPreservingBigInts(raw) as { variants: { id: unknown }[] };
    expect(parsed.variants[0].id).toBe("9007199254740993"); // 2^53 + 1
  });

  it("does not touch digit runs that appear inside string values", () => {
    // The number-like text is inside a string and must stay a string,
    // unquoted-and-requoted transforms must not corrupt it.
    const raw = '{"note":"order 271878346596884015 shipped","id":271878346596884015}';
    const parsed = parseJsonPreservingBigInts(raw) as { note: string; id: string };
    expect(parsed.note).toBe("order 271878346596884015 shipped");
    expect(parsed.id).toBe("271878346596884015");
  });

  it("preserves negative oversized integers and leaves floats/exponents alone", () => {
    const raw = '{"a":-271878346596884015,"b":-1.5,"c":1e3,"d":-42}';
    const parsed = parseJsonPreservingBigInts(raw) as Record<string, unknown>;
    expect(parsed.a).toBe("-271878346596884015");
    expect(parsed.b).toBe(-1.5);
    expect(parsed.c).toBe(1000);
    expect(parsed.d).toBe(-42);
  });

  it("handles a string containing an escaped quote before a big int", () => {
    const raw = '{"note":"say \\"hi\\"","id":271878346596884015}';
    const parsed = parseJsonPreservingBigInts(raw) as { note: string; id: string };
    expect(parsed.note).toBe('say "hi"');
    expect(parsed.id).toBe("271878346596884015");
  });
});

describe("diffProductFields — only changed fields are written", () => {
  const settings = { syncTitle: true, syncPrice: true, syncTags: true };

  it("returns an empty diff for identical products (echo becomes a no-op)", () => {
    const state = {
      title: "Snowboard",
      tags: ["winter", "sale"],
      variantPrices: new Map([[1n, "10.00"]]),
    };
    const dest = {
      title: "Snowboard",
      tags: ["sale", "winter"], // order must not matter
      variantPrices: new Map([[2n, "10.00"]]),
    };
    const diff = diffProductFields({
      settings,
      source: state,
      dest,
      variantMap: new Map([[1n, 2n]]),
    });
    expect(isEmptyProductDiff(diff)).toBe(true);
  });

  it("treats numerically equal prices as equal (10.0 == 10.00)", () => {
    const diff = diffProductFields({
      settings,
      source: { title: "X", tags: [], variantPrices: new Map([[1n, "10.0"]]) },
      dest: { title: "X", tags: [], variantPrices: new Map([[2n, "10.00"]]) },
      variantMap: new Map([[1n, 2n]]),
    });
    expect(isEmptyProductDiff(diff)).toBe(true);
  });

  it("diffs only enabled fields", () => {
    const diff = diffProductFields({
      settings: { syncTitle: false, syncPrice: true, syncTags: false },
      source: { title: "New", tags: ["a"], variantPrices: new Map([[1n, "12.00"]]) },
      dest: { title: "Old", tags: ["b"], variantPrices: new Map([[2n, "10.00"]]) },
      variantMap: new Map([[1n, 2n]]),
    });
    expect(diff.title).toBeUndefined();
    expect(diff.tags).toBeUndefined();
    expect(diff.variantPrices).toEqual([{ destVariantId: 2n, price: "12.00" }]);
  });

  it("ignores unmapped variants", () => {
    const diff = diffProductFields({
      settings,
      source: { title: "X", tags: [], variantPrices: new Map([[1n, "12.00"], [3n, "99.00"]]) },
      dest: { title: "X", tags: [], variantPrices: new Map([[2n, "12.00"]]) },
      variantMap: new Map([[1n, 2n]]), // variant 3 has no destination
    });
    expect(isEmptyProductDiff(diff)).toBe(true);
  });

  it("detects a tag change even when tags contain spaces (no delimiter collision)", () => {
    // ["blue green","red"] and ["blue","green red"] both join to
    // "blue green red" — a delimiter-join compare would call them equal.
    const diff = diffProductFields({
      settings: { syncTitle: false, syncPrice: false, syncTags: true },
      source: { title: "X", tags: ["blue green", "red"], variantPrices: new Map() },
      dest: { title: "X", tags: ["blue", "green red"], variantPrices: new Map() },
      variantMap: new Map(),
    });
    expect(diff.tags).toEqual(["blue green", "red"]);
  });
});

describe("sameTags — order-insensitive, delimiter-safe", () => {
  it("is order-insensitive", () => {
    expect(sameTags(["a", "b"], ["b", "a"])).toBe(true);
  });
  it("distinguishes tag sets that share a space-joined form", () => {
    expect(sameTags(["blue green", "red"], ["blue", "green red"])).toBe(false);
  });
  it("distinguishes different-length sets", () => {
    expect(sameTags(["a"], ["a", "b"])).toBe(false);
  });
});
