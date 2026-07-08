import { describe, expect, it } from "vitest";
import {
  checkVersion,
  decideWrite,
  diffProductFields,
  isEmptyProductDiff,
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

describe("decideWrite — loop prevention", () => {
  const now = t("2026-07-08T12:00:00Z");
  const targetHash = stableHash(7);

  it("skips when destination already has the target value (no-op)", () => {
    expect(
      decideWrite({ target: 7, destCurrent: 7, recentEcho: null, targetHash, now }),
    ).toEqual({ write: false, reason: "noop" });
  });

  it("skips when we ourselves recently wrote this exact value (own echo)", () => {
    expect(
      decideWrite({
        target: 7,
        destCurrent: null,
        recentEcho: { valueHash: targetHash, writtenAt: t("2026-07-08T11:55:00Z") },
        targetHash,
        now,
      }),
    ).toEqual({ write: false, reason: "own-echo" });
  });

  it("writes when the echo record is older than the TTL", () => {
    const old = new Date(now.getTime() - ECHO_TTL_MS - 1);
    expect(
      decideWrite({
        target: 7,
        destCurrent: 5,
        recentEcho: { valueHash: targetHash, writtenAt: old },
        targetHash,
        now,
      }),
    ).toEqual({ write: true, target: 7 });
  });

  it("writes when the echo was for a different value", () => {
    expect(
      decideWrite({
        target: 7,
        destCurrent: 5,
        recentEcho: { valueHash: stableHash(9), writtenAt: t("2026-07-08T11:59:00Z") },
        targetHash,
        now,
      }),
    ).toEqual({ write: true, target: 7 });
  });

  it("writes when values differ and there is no echo", () => {
    expect(
      decideWrite({ target: 7, destCurrent: 5, recentEcho: null, targetHash, now }),
    ).toEqual({ write: true, target: 7 });
  });

  // The ping-pong scenario: A -> B and (misconfigured) B -> A. A=7 gets
  // written to B; B's webhook comes back toward A. A already has 7, so the
  // write decision is a no-op and the loop dies immediately.
  it("kills a two-store ping-pong via the no-op rule", () => {
    const bounceBack = decideWrite({
      target: 7,
      destCurrent: 7, // A already holds the value it originally published
      recentEcho: null,
      targetHash,
      now,
    });
    expect(bounceBack.write).toBe(false);
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
});
