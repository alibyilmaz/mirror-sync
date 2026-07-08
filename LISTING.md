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
Inventory sync that catches drift and prevents overselling
```

## App introduction (≤100 chars — top of the listing page)

```
Keep stock identical across your stores. Self-healing sync that catches drift and never oversells.
```

## App details (≤500 chars — main description)

```
MirrorSync mirrors inventory and product data from one store to another in
near real time — and keeps checking afterwards. Every hour it compares both
stores SKU by SKU, repairs any drift, and writes a plain-language log of what
changed and why. If stock keeps drifting or a product breaks, the SKU pauses
safely and one click fixes it. A safety buffer keeps you from overselling
during restocks and flash sales. Built for multi-brand operators, expansion
stores, and supplier-retailer partnerships.
```

## Features (~80 chars each)

1. Near real-time inventory sync — typically under 30 seconds, guaranteed convergence
2. Hourly drift detection & self-repair: catches changes even when webhooks are missed
3. Oversell guard: safety stock buffer, quantities never go negative
4. Catches stock changes made by ANY app or manual edit — not just orders
5. Plain-language audit log + one-click resync when something needs attention
6. Optional product sync: title, price, tags, images, and metafields by namespace
7. SKU/barcode auto-matching on connect, with manual override for edge cases

## Search terms (5)

```
inventory sync, multi store, sync stores, stock sync, connect stores
```

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
   in under a minute."*
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
