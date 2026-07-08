import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueue } from "../lib/queue.server";
import { QUEUES } from "../lib/jobs";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { domain: session.shop },
    include: {
      sourceConnections: {
        where: { status: { not: "disabled" } },
        include: {
          destShop: true,
          bulkImports: { orderBy: { startedAt: "desc" } },
        },
      },
      destConnections: {
        where: { status: { not: "disabled" } },
        include: {
          sourceShop: true,
          bulkImports: { orderBy: { startedAt: "desc" } },
        },
      },
    },
  });

  // Keep only the most recent import per side (imports can be restarted).
  const latestImports = (
    imports: { side: string; status: string; error: string | null }[],
  ) => {
    const seen = new Set<string>();
    return imports
      .filter((i) => (seen.has(i.side) ? false : (seen.add(i.side), true)))
      .map((i) => ({ side: i.side, status: i.status, error: i.error }));
  };

  const connections = [
    ...(shop?.sourceConnections ?? []).map((c) => ({
      id: c.id,
      direction: "source" as const,
      otherShop: c.destShop.domain,
      status: c.status,
      pausedReason: c.pausedReason,
      imports: latestImports(c.bulkImports),
    })),
    ...(shop?.destConnections ?? []).map((c) => ({
      id: c.id,
      direction: "dest" as const,
      otherShop: c.sourceShop.domain,
      status: c.status,
      pausedReason: c.pausedReason,
      imports: latestImports(c.bulkImports),
    })),
  ];

  const connectionIds = connections.map((c) => c.id);

  const pausedMappings =
    connectionIds.length === 0
      ? []
      : await db.mapping.findMany({
          where: {
            connectionId: { in: connectionIds },
            status: { in: ["paused", "broken"] },
          },
          select: {
            id: true,
            connectionId: true,
            sku: true,
            status: true,
            pauseReason: true,
            pausedAt: true,
          },
          orderBy: { pausedAt: "desc" },
          take: 100,
        });

  const auditLogs = await db.auditLog.findMany({
    where: {
      OR: [
        { shopDomain: session.shop },
        ...(connectionIds.length > 0 ? [{ connectionId: { in: connectionIds } }] : []),
      ],
    },
    select: { id: true, level: true, kind: true, message: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const deadLetters = await db.deadLetter.findMany({
    where: { status: "dead" },
    select: { id: true, queue: true, error: true, attempts: true, failedAt: true },
    orderBy: { failedAt: "desc" },
    take: 50,
  });

  return {
    connections,
    pausedMappings: pausedMappings.map((m) => ({
      id: m.id,
      connectionId: m.connectionId,
      sku: m.sku,
      status: m.status,
      pauseReason: m.pauseReason,
      pausedAt: m.pausedAt ? m.pausedAt.toISOString() : null,
    })),
    auditLogs: auditLogs.map((log) => ({
      id: log.id,
      level: log.level,
      kind: log.kind,
      message: log.message,
      createdAt: log.createdAt.toISOString(),
    })),
    deadLetters: deadLetters.map((d) => ({
      id: d.id,
      queue: d.queue,
      error: d.error.slice(0, 200),
      attempts: d.attempts,
      failedAt: d.failedAt.toISOString(),
    })),
  };
};

async function findOwnedConnection(connectionId: string, shopDomain: string) {
  return db.connection.findFirst({
    where: {
      id: connectionId,
      OR: [
        { sourceShop: { domain: shopDomain } },
        { destShop: { domain: shopDomain } },
      ],
    },
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "resync-connection") {
    const connectionId = String(form.get("connectionId") ?? "");
    const connection = await findOwnedConnection(connectionId, session.shop);
    if (!connection) return { error: "That connection was not found." };
    await enqueue(QUEUES.reconcile, {
      type: "reconcile_connection",
      connectionId,
      manual: true,
    });
    return { message: "Resync started. Fresh numbers should land within a few minutes." };
  }

  if (intent === "resync-mapping") {
    const connectionId = String(form.get("connectionId") ?? "");
    const mappingId = String(form.get("mappingId") ?? "");
    const connection = await findOwnedConnection(connectionId, session.shop);
    if (!connection) return { error: "That connection was not found." };
    const mapping = await db.mapping.findFirst({
      where: { id: mappingId, connectionId },
    });
    if (!mapping) return { error: "That item was not found." };
    await enqueue(QUEUES.reconcile, {
      type: "reconcile_connection",
      connectionId,
      manual: true,
      mappingIds: [mappingId],
    });
    return { message: "Resync started for this item." };
  }

  if (intent === "retry-dead-letter") {
    const deadLetterId = String(form.get("deadLetterId") ?? "");
    const deadLetterRow = await db.deadLetter.findUnique({
      where: { id: deadLetterId },
    });
    if (!deadLetterRow) return { error: "That job was not found." };
    await enqueue(QUEUES.sync, { type: "retry_dead_letter", deadLetterId });
    return { message: "Retry queued." };
  }

  if (intent === "restart-import") {
    const connectionId = String(form.get("connectionId") ?? "");
    const connection = await findOwnedConnection(connectionId, session.shop);
    if (!connection) return { error: "That connection was not found." };
    await db.connection.update({
      where: { id: connectionId },
      data: { status: "importing" },
    });
    await enqueue(QUEUES.import, {
      type: "initial_import",
      connectionId,
      step: "start",
    });
    return { message: "Import restarted. Products are being matched by SKU and barcode." };
  }

  return { error: "Unknown action" };
};

type BadgeTone = "info" | "success" | "warning" | "critical" | "neutral";

function connectionTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "importing") return "info";
  if (status === "paused") return "warning";
  return "neutral";
}

function importTone(status: string): BadgeTone {
  if (status === "completed") return "success";
  if (status === "failed") return "critical";
  if (status === "running") return "info";
  return "neutral";
}

function levelTone(level: string): BadgeTone {
  if (level === "error") return "critical";
  if (level === "warn") return "warning";
  return "info";
}

function queueLabel(queue: string): string {
  if (queue === "sync_jobs") return "Sync";
  if (queue === "import_jobs") return "Import";
  if (queue === "reconcile_jobs") return "Reconcile";
  return queue;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Health() {
  const { connections, pausedMappings, auditLogs, deadLetters } =
    useLoaderData<typeof loader>();
  const act = useFetcher<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (act.data && "message" in act.data && act.data.message) {
      shopify.toast.show(act.data.message);
    }
  }, [act.data, shopify]);

  const submitting = (intent: string, field: string, value: string) =>
    act.state !== "idle" &&
    act.formData?.get("intent") === intent &&
    act.formData?.get(field) === value;

  return (
    <s-page heading="Health">
      {act.data && "error" in act.data && act.data.error && (
        <s-banner tone="critical">{act.data.error}</s-banner>
      )}

      <s-section heading="Connections">
        {connections.length === 0 ? (
          <s-paragraph>
            No connections yet. Set one up on the{" "}
            <s-link href="/app/connections">Connections page</s-link>.
          </s-paragraph>
        ) : (
          connections.map((c) => {
            const importTrouble =
              c.status === "importing" || c.imports.some((i) => i.status === "failed");
            return (
              <s-box
                key={c.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base">
                    <s-text>
                      {c.direction === "source"
                        ? `Sends inventory to ${c.otherShop}`
                        : `Receives inventory from ${c.otherShop}`}
                    </s-text>
                    <s-badge tone={connectionTone(c.status)}>{c.status}</s-badge>
                  </s-stack>

                  {c.status === "paused" && (
                    <s-banner tone="warning">
                      {c.pausedReason ??
                        "This connection is paused. Resync to check the numbers and pick up where it left off."}
                    </s-banner>
                  )}

                  {importTrouble &&
                    c.imports.map((imp) => (
                      <s-stack
                        key={`${c.id}-${imp.side}`}
                        direction="inline"
                        gap="base"
                      >
                        <s-text>
                          {imp.side === "source"
                            ? "Reading products from the source store:"
                            : "Reading products from the destination store:"}
                        </s-text>
                        <s-badge tone={importTone(imp.status)}>{imp.status}</s-badge>
                        {imp.error && <s-text tone="critical">{imp.error}</s-text>}
                      </s-stack>
                    ))}

                  <s-stack direction="inline" gap="base">
                    <s-button
                      onClick={() =>
                        act.submit(
                          { intent: "resync-connection", connectionId: c.id },
                          { method: "post" },
                        )
                      }
                      {...(submitting("resync-connection", "connectionId", c.id)
                        ? { loading: true }
                        : {})}
                    >
                      Resync now
                    </s-button>
                    {importTrouble && (
                      <s-button
                        variant="tertiary"
                        onClick={() =>
                          act.submit(
                            { intent: "restart-import", connectionId: c.id },
                            { method: "post" },
                          )
                        }
                        {...(submitting("restart-import", "connectionId", c.id)
                          ? { loading: true }
                          : {})}
                      >
                        Restart import
                      </s-button>
                    )}
                  </s-stack>
                </s-stack>
              </s-box>
            );
          })
        )}
      </s-section>

      {pausedMappings.length > 0 && (
        <s-section heading="Paused SKUs">
          <s-paragraph>
            These items stopped syncing after repeated problems. Resync an item
            to re-check its numbers and turn syncing back on.
          </s-paragraph>
          <s-table>
            <s-table-header-row>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Reason</s-table-header>
              <s-table-header>When</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {pausedMappings.map((m) => (
                <s-table-row key={m.id}>
                  <s-table-cell>{m.sku ?? "(no SKU)"}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={m.status === "broken" ? "critical" : "warning"}>
                      {m.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{m.pauseReason ?? "—"}</s-table-cell>
                  <s-table-cell>{formatWhen(m.pausedAt)}</s-table-cell>
                  <s-table-cell>
                    <s-button
                      variant="tertiary"
                      onClick={() =>
                        act.submit(
                          {
                            intent: "resync-mapping",
                            connectionId: m.connectionId,
                            mappingId: m.id,
                          },
                          { method: "post" },
                        )
                      }
                      {...(submitting("resync-mapping", "mappingId", m.id)
                        ? { loading: true }
                        : {})}
                    >
                      Resync now
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}

      {deadLetters.length > 0 && (
        <s-section heading="Failed jobs">
          <s-paragraph>
            These sync jobs stopped after several attempts. Retrying is safe:
            each job re-checks the current numbers before writing anything, so
            nothing gets double-counted.
          </s-paragraph>
          <s-table>
            <s-table-header-row>
              <s-table-header>Queue</s-table-header>
              <s-table-header>Error</s-table-header>
              <s-table-header>Attempts</s-table-header>
              <s-table-header>When</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {deadLetters.map((d) => (
                <s-table-row key={d.id}>
                  <s-table-cell>{queueLabel(d.queue)}</s-table-cell>
                  <s-table-cell>{d.error}</s-table-cell>
                  <s-table-cell>{String(d.attempts)}</s-table-cell>
                  <s-table-cell>{formatWhen(d.failedAt)}</s-table-cell>
                  <s-table-cell>
                    <s-button
                      variant="tertiary"
                      onClick={() =>
                        act.submit(
                          { intent: "retry-dead-letter", deadLetterId: d.id },
                          { method: "post" },
                        )
                      }
                      {...(submitting("retry-dead-letter", "deadLetterId", d.id)
                        ? { loading: true }
                        : {})}
                    >
                      Retry
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}

      <s-section heading="Activity">
        {auditLogs.length === 0 ? (
          <s-paragraph>
            Nothing yet. Sync activity for this store will appear here.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {auditLogs.map((log) => (
              <s-stack key={log.id} direction="inline" gap="base">
                <s-badge tone={levelTone(log.level)}>{log.level}</s-badge>
                <s-text>{log.message}</s-text>
                <s-text tone="neutral">{formatWhen(log.createdAt)}</s-text>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(new Error("Health page failed to load"));
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
