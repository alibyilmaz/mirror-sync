# MirrorSync — Shopify App Store submission checklist

Status as of the latest deploy. Items marked ✅ are done in code/config;
⬜ items need action in the Partner/Dev Dashboard (they can't be automated).

## 1. Technical readiness (done)

- ✅ **Embedded + session-token auth** — `isEmbeddedApp`, App Bridge; auth
  runs immediately on load (`authenticate.admin`). No third-party cookies.
- ✅ **Admin API 2026-07** (current stable) — every mutation/query re-verified
  live against 2026-07; well clear of the 90-day-deprecation rejection rule.
- ✅ **Only-used scopes** — `read/write_inventory`, `read/write_products`,
  `read_locations`. All five are exercised (audited); no unused scopes.
- ✅ **Mandatory compliance webhooks** — `customers/data_request`,
  `customers/redact`, `shop/redact` handled (verify HMAC, return 200).
- ✅ **Managed pricing** — plan detection via `currentAppInstallation`;
  limits by synced-SKU count in `app/lib/plans.server.ts`.
- ✅ **Clean uninstall** — `app/uninstalled` deletes the token + disables
  connections; `shop/redact` purges all store data 48h later.
- ✅ **Privacy policy page** — `https://mirror-sync-production.up.railway.app/privacy`.
- ✅ **Hosted, always-on** — Railway (single machine, graceful shutdown).
- ✅ **HMAC-verified webhooks, fast 200, async processing** — no request-time
  API work; queue consumer does the rest.

> Ready-to-paste listing copy (name, subtitle, intro, details, features,
> search terms, screenshot/video scenarios, pricing text) is in
> **[LISTING.md](LISTING.md)**.

## 2. App listing (Partner/Dev Dashboard → your app → Distribution → Manage listing)

- ⬜ **App name**: "MirrorSync" (confirm it's available/unique in the store).
- ⬜ **App icon**: 1200×1200 px PNG, no text, no Shopify branding.
- ⬜ **App card subtitle** (≤62 chars): e.g. "Reliable inventory sync across
  your stores."
- ⬜ **Key benefits** (3, ~80 chars each), lead with the differentiators:
  1. Never oversell — syncs the moment stock changes, not just on orders.
  2. Catches changes from any app or manual edit, with hourly drift repair.
  3. One-click recovery — see every sync in plain language, resync in a tap.
- ⬜ **Screenshots** (min 3, 1600×900): Overview, Health (paused SKUs +
  activity log), SKU mapping table. Use a demo store with real-looking data.
- ⬜ **Feature/demo video** (screencast) — pairing → import → a live sync.
- ⬜ **Category**: Store management → Inventory management (or Migration/sync).
- ⬜ **Languages**: English.

## 3. Pricing (Dashboard → Pricing) — must match `plans.server.ts`

Configure managed-pricing plans with these names (case-insensitive match):

| Plan    | Price      | Synced-SKU limit |
| ------- | ---------- | ---------------- |
| Free    | $0         | 25               |
| Starter | (you set)  | 250              |
| Growth  | (you set)  | 2,500            |
| Scale   | (you set)  | unlimited        |

- ⬜ Create the four plans; set your prices. If you rename any, update
  `PLANS` in `app/lib/plans.server.ts` to match exactly.

## 4. App setup / configuration

- ✅ App URL + redirect URLs point to Railway (deployed).
- ⬜ **Protected customer data access**: declare **none** — MirrorSync
  requests no customer-data scopes, so the PCD questionnaire is a quick "no
  customer data" path. Do not request `read_customers`/orders.
- ⬜ **Emergency/support contact**, **support email**, **support URL**.
- ⬜ **Privacy policy URL**: the `/privacy` page above (contact:
  `mirrorsync@proton.me`).
- ⬜ **Demo store URL** + **review instructions**: give reviewers two dev
  stores already paired, and step-by-step: install on store A and B →
  Connections → generate code on A → redeem on B → watch import + a stock
  change sync. Include a screencast.

## 5. Automated review checks (should pass — re-verify before submitting)

- ⬜ Install on a brand-new dev store → app loads embedded and authenticates
  immediately (no blank/Example-Domain screen).
- ⬜ Uninstall → reinstall works cleanly.
- ⬜ Compliance webhooks return 200 (tested in prod).
- ⬜ Lighthouse: embedded pages don't drop the store's performance score by
  >10 points (our UI is minimal Polaris web components — should be fine).

## 6. Before you click Submit

- ⬜ Make sure `npm run dev` is **not** running (it re-points the app URL to a
  tunnel). If it ran, re-release production:
  `CI=1 npm exec shopify app deploy -- --allow-updates`.
- ⬜ Confirm the released version points to Railway (Dashboard → Versions).
- ⬜ Move Railway off the trial to a paid instance (or Fly.io via `fly.toml`)
  so the app stays always-on through review and beta.
- ⬜ Rotate the Supabase DB password and Shopify API secret if they were ever
  shared in plaintext, and confirm they live only in host secrets.
