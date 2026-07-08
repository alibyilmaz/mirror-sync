import prisma from "../db.server";
import { QUEUES, MAX_ATTEMPTS, type QueueName } from "./jobs";
import {
  ack,
  backoffSeconds,
  deadLetter,
  delay,
  readBatch,
  resolveJobShop,
  type QueueMessage,
} from "./queue.server";
import { processJob, RateLimitedError } from "./sync/process.server";

// Single-threaded consumer loop, same process as the web server. Messages
// are processed strictly one at a time: no concurrency means no races on
// watermarks or rate budgets, and sync volume fits comfortably.

const POLL_INTERVAL_MS = 2000;
// If a job dies mid-flight (process crash), it reappears after this long.
const VISIBILITY_TIMEOUT_S = 120;

let running = false;

export function startWorker(): void {
  if (running) return;
  running = true;
  console.log("[worker] queue consumer started");
  void loop();
}

export function stopWorker(): void {
  running = false;
}

async function loop(): Promise<void> {
  while (running) {
    let didWork = false;
    try {
      // Sync jobs get the biggest batch; import/reconcile are heavyweight
      // and rare, one at a time is plenty.
      didWork =
        (await drain(QUEUES.sync, 10)) ||
        (await drain(QUEUES.import, 1)) ||
        (await drain(QUEUES.reconcile, 1));
    } catch (e) {
      // Never let the loop die: a DB blip should not stop sync for good.
      console.error("[worker] tick failed", e);
    }
    if (!didWork) await sleep(POLL_INTERVAL_MS);
  }
}

async function drain(queue: QueueName, qty: number): Promise<boolean> {
  const messages = await readBatch(queue, VISIBILITY_TIMEOUT_S, qty);
  for (const msg of messages) {
    await handle(queue, msg);
  }
  return messages.length > 0;
}

async function handle(queue: QueueName, msg: QueueMessage): Promise<void> {
  try {
    await processJob(msg.job);
    await ack(queue, msg.msgId);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      // Not a failure: the shop's API budget is empty. Try again when the
      // bucket has refilled; does not count against retry attempts.
      await delay(queue, msg.msgId, e.retryAfterSeconds);
      return;
    }
    const error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    if (msg.readCt >= MAX_ATTEMPTS) {
      console.error(`[worker] job dead-lettered after ${msg.readCt} attempts`, error);
      await deadLetter(queue, msg, error);
      await prisma.auditLog.create({
        data: {
          shopDomain: await resolveJobShop(msg.job),
          level: "error",
          kind: "system",
          message: `A sync job failed ${msg.readCt} times and was moved to the dead-letter queue. You can retry it from the Health page.`,
          context: { queue, error: error.slice(0, 1000) },
        },
      });
    } else {
      console.warn(`[worker] job failed (attempt ${msg.readCt}), retrying`, error);
      await delay(queue, msg.msgId, backoffSeconds(msg.readCt));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
