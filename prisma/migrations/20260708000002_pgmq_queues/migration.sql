-- Supabase Queues (pgmq): the job queues the worker polls.
-- On Supabase both extensions are preinstalled; CREATE EXTENSION just
-- enables them for this database. (Dashboard: Database -> Extensions.)
CREATE EXTENSION IF NOT EXISTS pgmq;

SELECT pgmq.create('sync_jobs');
SELECT pgmq.create('import_jobs');
SELECT pgmq.create('reconcile_jobs');
