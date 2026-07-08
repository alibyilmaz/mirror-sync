import type { ActionFunctionArgs } from "react-router";
import { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { QUEUES } from "../lib/jobs";

// Single ingest endpoint for the three sync topics. Contract: verify HMAC
// (authenticate.webhook), dedupe by webhook id, enqueue, answer 200 fast.
// All real work happens in the queue consumer.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);

  // Ignore events from shops that aren't a source of any live connection.
  // (Destination-side echoes of our own writes land here and die quietly.)
  const isSource = await db.connection.count({
    where: { sourceShop: { domain: shop }, status: { not: "disabled" } },
  });
  if (isSource === 0) return new Response();

  // Shopify redelivers webhooks; the receipt's primary key makes ingest
  // exactly-once. Receipt + enqueue are one transaction: either the event
  // is queued and marked received, or neither (so a redelivery can't be
  // swallowed by a half-finished attempt).
  const job = JSON.stringify({
    type: "webhook",
    shop,
    topic,
    webhookId,
    payload,
    receivedAt: new Date().toISOString(),
  });
  try {
    await db.$transaction(async (tx) => {
      await tx.webhookReceipt.create({ data: { id: webhookId, shop, topic } });
      await tx.$queryRaw`SELECT pgmq.send(${QUEUES.sync}::text, ${job}::jsonb, 0::integer)`;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return new Response(); // duplicate delivery
    }
    throw e;
  }

  return new Response();
};
