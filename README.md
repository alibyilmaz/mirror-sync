# MirrorSync

Reliable inventory + product sync between Shopify stores owned by the same
merchant. One direction per connection (source → destination), built so the
destination never oversells and never silently drifts.

What makes it reliable (and different from the usual sync apps):

- **Listens to `inventory_levels/update`**, not just orders — changes made by
  other apps, manual edits and restocks all propagate.
- **Duplicate + out-of-order webhooks are treated as normal input**: every
  event is deduplicated by webhook id and checked against a per-resource
  version watermark; stale updates are rejected.
- **No sync loops**: the connection graph must stay acyclic (enforced at
  pairing), writes are diff-based (no-op writes are skipped), and our own
  writes are tagged and recognized when they echo back.
- **Hourly reconciliation** compares the full mapped state per connection and
  repairs drift, within each shop's API rate budget, logging every fix in
  plain language.
- **Oversell guard**: a configurable safety-stock buffer, plus automatic
  per-SKU pause when writes keep failing or stock keeps drifting — with
  one-click "Resync now" recovery in the dashboard.
- **Self-serve recovery**: failed jobs land in a dead-letter queue visible on
  the Health page with a Retry button.

## Stack

- Shopify React Router app template (TypeScript), Polaris web components,
  GraphQL Admin API only
- Supabase Postgres via Prisma — pooled connection (`:6543`) at runtime,
  direct (`:5432`) for migrations
- Supabase Queues (pgmq) for jobs, pg_cron for schedules — no Redis
- One always-on Node process (Fly.io/Railway): Express serves the embedded
  app and runs the queue consumer loop in `server.mjs`

## Setup

1. **Supabase**: create a project. Extensions `pgmq` and `pg_cron` are
   enabled by the migrations (or enable them under Database → Extensions).
2. **Env**: copy `.env.example` to `.env`, fill in the Supabase URLs
   (pooled for `DATABASE_URL`, direct for `DIRECT_URL`).
3. **Shopify app**: `npm run config:link` to link this code to an app in
   the Dev Dashboard (creates/updates `client_id` in `shopify.app.toml`),
   then `shopify app env pull` or fill the SHOPIFY_* vars by hand.
4. **Migrations**: `npx prisma migrate deploy` (creates tables, pgmq queues
   and the pg_cron schedules).
5. **Managed pricing**: configure plans named `Free`, `Starter`, `Growth`,
   `Scale` in the app's pricing section of the dashboard (limits in
   `app/lib/plans.server.ts`). Note: plan detection currently uses the
   Admin API `currentAppInstallation.activeSubscriptions` query, which
   Shopify is superseding with the Partner API `activeSubscription` query
   ("Shopify App Pricing", 2026) — see the note in `plans.server.ts`.

## Development

```bash
npm run dev          # shopify app dev (web app, tunnel, hot reload)
npm run dev:worker   # queue consumer, separate terminal (tsx watch)
npm test             # sync-engine core tests (vitest)
npm run typecheck
```

The dev server does not run the worker — run both commands side by side.
In production `server.mjs` runs both in one process.

Order matters on Windows: start `npm run dev` first and `npm run dev:worker`
second. Dev's pre-step runs `prisma generate`, which fails with EPERM if a
running worker holds the query-engine DLL open.

### Seed demo data

```bash
npm run seed         # idempotent: 2 shops, 1 connection, 5 SKUs, audit log, 1 DLQ row
```

Populates enough for the dashboard queries and the worker to have something
to show. It seeds no `Session` rows, so the embedded UI still needs a real
Shopify install to authenticate.

### Run it locally without Shopify

`npm run dev` needs a linked Shopify app and an interactive Partner login.
To exercise the DB + queue + worker layer without that, run the built server
directly:

```bash
npm run build        # react-router build + esbuild worker bundle
npm run serve        # node --env-file=.env server.mjs  (web + worker, port 3000)
```

The landing page serves at http://localhost:3000; `/app` returns an auth
challenge until a real install provides a session token. The worker connects
to Supabase and polls pgmq immediately — enqueue a job and watch the queue
drain (`SELECT queue_length FROM pgmq.metrics('sync_jobs')`).

## Deploy (Fly.io/Railway)

The Dockerfile builds the app and the worker bundle. The container runs
`npm run docker-start` → migrations, then `node server.mjs` (web + worker).
Set the same env vars as `.env.example`. Scale to exactly **one** machine
that never sleeps: the worker loop is single-threaded on purpose (no races
on watermarks or rate budgets), and one instance is plenty for the write
volumes involved.

## How syncing works (short version)

1. Webhooks (`inventory_levels/update`, `products/update`, `products/delete`)
   are HMAC-verified, deduplicated (`WebhookReceipt`), enqueued to pgmq and
   answered immediately.
2. The worker reads jobs, rejects stale events via `ResourceVersion`
   watermarks, fans out to connections, and writes diffs only — reading the
   destination first, skipping no-ops, tagging its own writes (`EchoWrite`).
3. Failures retry with exponential backoff (pgmq visibility timeout); after
   5 attempts the job is archived to `DeadLetter` and surfaced in the UI.
   Rate limiting is budgeted per shop from the GraphQL cost extension and
   never counts as a failed attempt.
4. `pg_cron` enqueues an hourly reconcile job per active connection; drift
   is repaired and every fix is written to the `AuditLog` in plain English.
5. First pairing runs a Bulk Operations export of both catalogs, matches
   variants by SKU then barcode (ambiguous values are skipped, never
   guessed), links locations, then does an initial reconcile pass.
