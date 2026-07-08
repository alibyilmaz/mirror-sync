// Job payloads that travel through pgmq. Keep them JSON-serializable and
// small: webhook payloads ride along verbatim, everything else is IDs.

export const QUEUES = {
  sync: "sync_jobs",
  import: "import_jobs",
  reconcile: "reconcile_jobs",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const MAX_ATTEMPTS = 5;

export type WebhookJob = {
  type: "webhook";
  shop: string;
  topic: string; // INVENTORY_LEVELS_UPDATE | PRODUCTS_UPDATE | PRODUCTS_DELETE
  webhookId: string;
  payload: unknown;
  receivedAt: string; // ISO
};

export type ReconcileConnectionJob = {
  type: "reconcile_connection";
  connectionId: string;
  // Set when triggered from the dashboard ("resync now"); reconciles even if
  // mappings are paused, and unpauses them on success.
  manual?: boolean;
  // Optional narrowing to specific mappings (one-click resync of paused SKUs).
  mappingIds?: string[];
};

export type InitialImportJob = {
  type: "initial_import";
  connectionId: string;
  // State machine step; the job re-enqueues itself with the next step.
  step: "start" | "poll" | "match";
};

export type RetryDeadLetterJob = {
  type: "retry_dead_letter";
  deadLetterId: string;
};

export type Job =
  | WebhookJob
  | ReconcileConnectionJob
  | InitialImportJob
  | RetryDeadLetterJob;
