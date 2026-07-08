import prisma from "../db.server";
import { QUEUES, MAX_ATTEMPTS, type QueueName } from "./jobs";
import {
  ack,
  backoffSeconds,
  deadLetter,
  delay,
  discard,
  enqueue,
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
let loopPromise: Promise<void> | null = null;
let wakeSleep: (() => void) | null = null;

export function startWorker(): void {
  if (running) return;
  running = true;
  console.log("[worker] queue consumer started");
  loopPromise = loop();
}

// Graceful stop: signal the loop to finish its current batch, wake it if
// it's idle-sleeping, and resolve once it has exited so the caller can
// drain before the process dies (a message cut off mid-flight would
// otherwise reappear only after the 120s visibility timeout).
export async function stopWorker(): Promise<void> {
  if (!running) return;
  running = false;
  wakeSleep?.();
  await loopPromise;
  loopPromise = null;
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
      // Not a failure: the shop's API budget is empty. Shelving must NOT
      // consume a retry attempt, but pgmq's read_ct only ever grows and
      // set_vt can't reset it. So re-enqueue a fresh copy (read_ct starts
      // over) with the wait as its delay, then drop the current message.
      // Enqueue first: a crash in between leaves a harmless duplicate
      // (idempotent), never a lost job.
      await enqueue(queue, msg.job, e.retryAfterSeconds);
      await discard(queue, msg.msgId);
      return;
    }
    const error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    if (msg.readCt >= MAX_ATTEMPTS) {
      console.error(`[worker] job dead-lettered after ${msg.readCt} attempts`, error);
      if (msg.job.type === "retry_dead_letter") {
        // A retry that failed again must not spawn a nested dead-letter row
        // pointing at the original. The original row is still 'dead'
        // (processJob only marks it 'retried' on success), so just refresh
        // its error and drop this wrapper message.
        await prisma.deadLetter.updateMany({
          where: { id: msg.job.deadLetterId, status: "dead" },
          data: { error: `Retry failed again: ${error.slice(0, 3900)}` },
        });
        await discard(queue, msg.msgId);
      } else {
        await deadLetter(queue, msg, error);
      }
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

// Interruptible: stopWorker() cuts the idle wait short so shutdown is fast
// when the queue is empty.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });
}
