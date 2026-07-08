import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { Job, QueueName } from "./jobs";

// Thin wrapper over pgmq's SQL API. All queue state lives in Postgres; the
// worker polls. No LISTEN/NOTIFY: the pooled (transaction-mode) connection
// does not support it, and polling every few seconds is plenty for sync jobs.

export type QueueMessage = {
  msgId: bigint;
  readCt: number;
  enqueuedAt: Date;
  job: Job;
};

export async function enqueue(
  queue: QueueName,
  job: Job,
  delaySeconds = 0,
): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ send: bigint }[]>`
    SELECT pgmq.send(${queue}::text, ${JSON.stringify(job)}::jsonb, ${delaySeconds}::integer) AS send
  `;
  return rows[0].send;
}

// Read up to `qty` messages, making them invisible for `vtSeconds`. If the
// worker crashes mid-processing, the message reappears after the timeout.
export async function readBatch(
  queue: QueueName,
  vtSeconds: number,
  qty: number,
): Promise<QueueMessage[]> {
  const rows = await prisma.$queryRaw<
    { msg_id: bigint; read_ct: number; enqueued_at: Date; message: unknown }[]
  >`
    SELECT msg_id, read_ct, enqueued_at, message
    FROM pgmq.read(${queue}::text, ${vtSeconds}::integer, ${qty}::integer)
  `;
  return rows.map((r) => ({
    msgId: r.msg_id,
    readCt: r.read_ct,
    enqueuedAt: r.enqueued_at,
    job: r.message as Job,
  }));
}

// Successful completion: archive keeps the message in pgmq's archive table
// (cheap history, purged by a cron job) instead of deleting outright.
export async function ack(queue: QueueName, msgId: bigint): Promise<void> {
  await prisma.$queryRaw`SELECT pgmq.archive(${queue}::text, ${msgId}::bigint)`;
}

export async function discard(queue: QueueName, msgId: bigint): Promise<void> {
  await prisma.$queryRaw`SELECT pgmq.delete(${queue}::text, ${msgId}::bigint)`;
}

// Transient failure or rate-limit wait: push visibility into the future so
// the message is retried later. Backoff grows with read_ct.
export async function delay(
  queue: QueueName,
  msgId: bigint,
  seconds: number,
): Promise<void> {
  await prisma.$queryRaw`SELECT pgmq.set_vt(${queue}::text, ${msgId}::bigint, ${seconds}::integer)`;
}

export function backoffSeconds(attempt: number): number {
  // 1 -> 30s, 2 -> 2m, 3 -> 8m, 4 -> 32m, capped at 1h
  return Math.min(30 * 4 ** (attempt - 1), 3600);
}

export async function queueDepth(queue: QueueName): Promise<number> {
  const rows = await prisma.$queryRaw<{ queue_length: bigint }[]>`
    SELECT queue_length FROM pgmq.metrics(${queue}::text)
  `;
  return Number(rows[0]?.queue_length ?? 0);
}

// Exhausted retries: persist to the dead-letter table (dashboard offers
// one-click retry) and remove from the live queue.
export async function deadLetter(
  queue: QueueName,
  msg: QueueMessage,
  error: string,
): Promise<void> {
  await prisma.deadLetter.create({
    data: {
      queue,
      payload: msg.job as unknown as Prisma.InputJsonValue,
      error: error.slice(0, 4000),
      attempts: msg.readCt,
    },
  });
  await ack(queue, msg.msgId);
}
