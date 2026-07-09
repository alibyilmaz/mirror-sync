# MirrorSync — App Store listing copy

Ready-to-paste text for the Shopify App Store listing form (English, global
market). Verify each field's character limit in the form — Shopify changes
them occasionally; values below are kept in a safe range. `[...]` = fill in.

## App name (≤30 chars, may not contain "Shopify")

```
MirrorSync ‑ Multi Store Sync
```

## App card subtitle (≤62 chars — shown on the search result card)

```
Reliable inventory & product sync across all your stores
```

Alternative (harder reliability angle):

```
Inventory sync that finds and fixes drift automatically
```

> Compliance note (Shopify's listing AI check): no statistics or absolute
> claims — avoid "never oversells", "quantities never go negative",
> "guaranteed", "under 30 seconds". Copy below is mechanism-based.

## App introduction (≤100 chars — top of the listing page)

```
Keep stock aligned across your stores with self-healing sync that finds and repairs drift for you.
```

## App details (≤500 chars — main description; this text = 488 chars
## when pasted as one paragraph)

```
MirrorSync mirrors inventory and product data from one store to another in
near real time — and keeps checking afterwards. Every hour it compares both
stores SKU by SKU, repairs any drift it finds, and logs every fix in plain
language. If stock keeps drifting or a product breaks, that SKU pauses
safely and one click fixes it. A safety stock buffer helps protect you from
overselling during restocks. Built for multi-brand operators, expansion
stores, and supplier-retailer partnerships.
```

## Features (~80 chars each)

1. Fast inventory sync — updates flow to the mirrored store moments after a change
2. Hourly drift detection and self-repair — catches changes even when a webhook is missed
3. Oversell guard: a safety stock buffer keeps a margin between your stores
4. Syncs stock changes from other apps and manual edits — not just orders
5. Plain-language audit log + one-click resync when something needs attention
6. Optional product sync: title, price, tags, images, and metafields by namespace
7. SKU/barcode auto-matching on connect, with manual override for edge cases

## Search terms (5)

```
inventory sync, multi store, sync stores, stock sync, connect stores
```

## Images (1600×900) — generated in `listing-assets/`

**Feature Image 1** → use `0-feature.png` (UI-dominant Health screen; the
check rejects logo/illustration-only feature images — do NOT use the OG or
app-icon file there).

## Screenshots (1600×900, 3–6) — capture scenarios

Capture from the app running in a real dev store (see "Real data" below);
mock data looks bad in Built for Shopify review.

1. **Health screen (hero):** audit log showing back-to-back
   `Drift repaired for SKU X: mirror-dest had 999, corrected to 42…` lines.
   Overlay: *"It checks itself every hour — and fixes what it finds."*
2. **Post-sabotage pause:** the `Inventory drifted 3 reconciliations in a
   row…` warning + Resync now button. Overlay: *"When something's wrong, it
   tells you in plain English."*
3. **Connect flow:** the pairing code screen. Overlay: *"Connect two stores
   with a one-time code."*
4. **Mapping table:** auto-matched SKUs with auto_sku / auto_barcode / manual
   badges. Overlay: *"SKUs match themselves. You approve the edge cases."*
5. **Settings:** safety buffer + field-selective sync. Overlay: *"Sync exactly
   what you want — nothing more."*

## Demo video (60s — chaos scenario #3)

| s     | Shot                                          | Caption |
| ----- | --------------------------------------------- | ------- |
| 0–8   | Two stores side by side, stock equal          | "Your stores. Always in sync." |
| 8–20  | Dest stock manually set to 999                | "Something — an app, a typo — changes your stock…" |
| 20–35 | Health screen: drift repaired, back to 42     | "MirrorSync catches it and fixes it. Automatically." |
| 35–48 | After the 3rd time: pause warning + Resync     | "If it keeps happening, it pauses safely and tells you why." |
| 48–60 | Logo + plans                                  | "MirrorSync. Sync you don't have to think about. Free for 25 SKUs." |

## Pricing plans (Partner Dashboard) — names must match `plans.server.ts`

| Plan    | Price      | Description |
| ------- | ---------- | ----------- |
| Free    | $0         | Up to 25 synced SKUs. All features included — no time limit. |
| Starter | $29/mo     | Up to 250 synced SKUs. |
| Growth  | $59/mo     | Up to 2,500 synced SKUs. |
| Scale   | $99/mo     | Unlimited SKUs. Priority support. |

Names are case-insensitive matched to `free` / `starter` / `growth` / `scale`.

## Testing instructions (paste into "Instruction notes", ≤2800 chars)

```
MirrorSync is fully embedded — no external login or credentials needed.
It authenticates automatically with the Shopify session on install.

SETUP (needs two development stores):
1. Install the app on two dev stores: Store A (source) and Store B
   (destination).
2. In both stores, create 2–3 products that share the same SKU (or the
   same barcode) — matching is by SKU first, then barcode.
3. Open the app on Store A > Connections > "Generate connection code".
4. Open the app on Store B > Connections > enter the code under "Receive
   inventory INTO this store" > Connect.
5. The initial import starts automatically: both catalogs are exported,
   variants are matched, and Store B's stock is set to match Store A.
   Progress and results appear on the Health page (~1–2 minutes).

CORE FUNCTIONALITY:
6. Real-time sync: in Store A admin, change the inventory of a matched
   SKU. Within ~30 seconds Store B shows the same quantity.
7. Self-healing: in Store B admin, manually change a synced SKU's stock
   (simulates another app interfering). Click "Resync now" on the Health
   page — the value is corrected back and a plain-language entry appears
   in the activity log ("Drift repaired for SKU ..."). This also runs
   automatically every hour.
8. Oversell guard: open Settings for the connection (source store),
   set "Safety stock buffer" to 5, save, then "Resync now" on Health.
   Store B now shows Store A's stock minus 5, and never goes below 0.
9. SKU mapping page: shows every matched pair with its match type
   (auto-SKU / auto-barcode / manual), plus pause/resume per SKU and a
   manual mapping form for products whose SKUs differ between stores.

NOTES:
- "Resync now" triggers the hourly reconciliation immediately, so you
  never need to wait for the scheduled run.
- The app requests only product/inventory/location scopes and stores no
  customer data; all three GDPR compliance webhooks are implemented.
- The Free plan covers 25 synced SKUs (managed pricing) — no charge is
  required to test everything above.
```

## Screencast script (3–4 min, one take — Loom or YouTube unlisted)

| # | ~Time | Scene | Say / show |
|---|-------|-------|------------|
| 1 | 0:00–0:20 | Landing + install | "MirrorSync keeps inventory identical across your Shopify stores." Show app opening in admin (embedded, no login). |
| 2 | 0:20–1:00 | Onboarding: pairing | Store A: Connections → Generate code. Store B: paste code → Connect. Show the success banner. |
| 3 | 1:00–1:40 | Import + mapping | Health page while import runs; then SKU mapping page: auto-SKU, auto-barcode and manual badges. "SKUs match themselves — you approve the edge cases." |
| 4 | 1:40–2:20 | Live sync | Store A admin: change a SKU's stock. Switch to Store B: value updates in seconds. |
| 5 | 2:20–3:10 | Self-healing (the differentiator) | Store B: manually break the stock (e.g. set 999). Health → Resync now → show the "Drift repaired… had 999, corrected to…" audit line. "It checks itself every hour and writes what it fixed in plain English." |
| 6 | 3:10–3:40 | Oversell guard | Settings: set buffer 5 → resync → Store B shows source minus 5. "Restocks and flash sales can't oversell the mirrored store." |
| 7 | 3:40–4:00 | Close | Plans (Free = 25 SKUs), logo, tagline: "Sync you don't have to think about." |

Recording tips: 1600×900+ window, English UI, quiet room (their DON'T:
no loud background noise), cursor visible. Host on Loom (public link) or
YouTube (unlisted) and paste the URL into "Screencast URL".

## Two assurance lines for the help doc

- "Even if Shopify drops or coalesces a webhook, the hourly reconciliation
  catches the difference — nothing stays out of sync for more than an hour."
- "MirrorSync never deletes anything in your stores. When a source product is
  deleted, its copy is left untouched and sync for that SKU stops with a note."

## Pre-submit checklist

- [x] `application_url` = production URL (Railway)
- [x] Admin API on current stable (2026-07), mutations re-verified live
- [x] App icon 1200×1200 (`public/brand/mirrorsync-app-icon-1200.png`)
- [x] Privacy policy URL (`/privacy`; stores store domain + product/inventory
      data, no customer data)
- [ ] Demo store URL (a clean dev store, app installed + paired)
- [ ] Create the 4 pricing plans in the Partner Dashboard (names exact)
- [ ] Upload screenshots + demo video
- [ ] Confirm `npm run dev` is not running (it re-points URLs to a tunnel);
      re-`shopify app deploy` if it ran
