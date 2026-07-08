-- pg_cron schedules. Everything the clock triggers happens inside
-- Postgres: cron enqueues pgmq jobs, the Node worker does the API work.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Hourly reconciliation: one job per active connection, staggered by the
-- queue itself. Runs at minute 7 to stay clear of top-of-hour load.
SELECT cron.schedule(
  'mirrorsync-hourly-reconcile',
  '7 * * * *',
  $$
  SELECT pgmq.send(
    'reconcile_jobs',
    jsonb_build_object('type', 'reconcile_connection', 'connectionId', c.id)
  )
  FROM "Connection" c
  WHERE c.status = 'active'
  $$
);

-- Daily cleanup of bookkeeping tables that only matter for a while:
-- webhook receipts (dedup window), echo tags (loop window), old audit
-- entries and archived queue messages.
SELECT cron.schedule(
  'mirrorsync-daily-cleanup',
  '23 3 * * *',
  $$
  DELETE FROM "WebhookReceipt" WHERE "receivedAt" < now() - interval '7 days';
  DELETE FROM "EchoWrite" WHERE "writtenAt" < now() - interval '2 days';
  DELETE FROM "AuditLog" WHERE "createdAt" < now() - interval '90 days';
  DELETE FROM pgmq.a_sync_jobs WHERE archived_at < now() - interval '14 days';
  DELETE FROM pgmq.a_import_jobs WHERE archived_at < now() - interval '14 days';
  DELETE FROM pgmq.a_reconcile_jobs WHERE archived_at < now() - interval '14 days';
  $$
);
