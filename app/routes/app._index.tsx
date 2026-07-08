import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { refreshPlan, skuLimitFor, upgradeUrl, PLANS } from "../lib/plans.server";

const STATUS_TONE: Record<string, "info" | "success" | "warning" | "neutral"> =
  {
    importing: "info",
    active: "success",
    paused: "warning",
    disabled: "neutral",
  };

const STATUS_LABEL: Record<string, string> = {
  importing: "Importing",
  active: "Active",
  paused: "Paused",
  disabled: "Disabled",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({
    where: { domain: session.shop },
    include: {
      sourceConnections: {
        include: { destShop: true, _count: { select: { mappings: true } } },
      },
      destConnections: {
        include: { sourceShop: true, _count: { select: { mappings: true } } },
      },
    },
  });

  const asSource = shop?.sourceConnections ?? [];
  const asDest = shop?.destConnections ?? [];

  const connections = [
    ...asSource.map((c) => ({
      id: c.id,
      source: session.shop,
      dest: c.destShop.domain,
      status: c.status,
      mappingCount: c._count.mappings,
    })),
    ...asDest.map((c) => ({
      id: c.id,
      source: c.sourceShop.domain,
      dest: session.shop,
      status: c.status,
      mappingCount: c._count.mappings,
    })),
  ];

  const connectionIds = connections.map((c) => c.id);
  const sourceConnectionIds = asSource.map((c) => c.id);

  const [syncedSkus, pausedSkus, failedJobs, recentActivity] =
    await Promise.all([
      sourceConnectionIds.length
        ? db.mapping.count({
            where: {
              connectionId: { in: sourceConnectionIds },
              status: "active",
            },
          })
        : Promise.resolve(0),
      connectionIds.length
        ? db.mapping.count({
            where: {
              connectionId: { in: connectionIds },
              status: { in: ["paused", "broken"] },
            },
          })
        : Promise.resolve(0),
      db.deadLetter.count({
        where: {
          status: "dead",
          // Only this store's failures (connection jobs belong to the
          // source shop; include both sides of our connections).
          shopDomain: {
            in: [
              session.shop,
              ...asSource.map((c) => c.destShop.domain),
              ...asDest.map((c) => c.sourceShop.domain),
            ],
          },
        },
      }),
      db.auditLog.findMany({
        where: {
          OR: [
            { shopDomain: session.shop },
            { connectionId: { in: connectionIds } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);

  // Refresh the managed-pricing plan while the merchant is looking at us;
  // falls back to the cached value if the API call fails.
  const plan = await refreshPlan(session.shop);

  const limit = skuLimitFor(plan);

  return {
    plan,
    planLabel: PLANS[plan]?.label ?? plan,
    // Infinity doesn't survive JSON serialization; null = unlimited.
    skuLimit: Number.isFinite(limit) ? limit : null,
    manageplanUrl: upgradeUrl(session.shop),
    connections,
    syncedSkus,
    pausedSkus,
    failedJobs,
    recentActivity: recentActivity.map((entry) => ({
      id: entry.id,
      level: entry.level,
      message: entry.message,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
};

export default function Index() {
  const {
    planLabel,
    skuLimit,
    manageplanUrl,
    connections,
    syncedSkus,
    pausedSkus,
    failedJobs,
    recentActivity,
  } = useLoaderData<typeof loader>();

  const needsAttention = pausedSkus > 0 || failedJobs > 0;

  if (connections.length === 0) {
    return (
      <s-page heading="MirrorSync">
        <s-section heading="Connect your first store">
          <s-paragraph>
            MirrorSync keeps inventory in sync between two Shopify stores.
            Connect a store to get started — pairing takes about a minute.
          </s-paragraph>
          <s-button href="/app/connections" variant="primary">
            Connect your first store
          </s-button>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="MirrorSync">
      {needsAttention && (
        <s-banner
          tone={failedJobs > 0 ? "critical" : "warning"}
          heading="Attention needed"
        >
          <s-paragraph>
            {pausedSkus > 0 &&
              `${pausedSkus} SKU${pausedSkus === 1 ? " is" : "s are"} paused and not syncing. `}
            {failedJobs > 0 &&
              `${failedJobs} sync job${failedJobs === 1 ? "" : "s"} failed and need${failedJobs === 1 ? "s" : ""} a retry. `}
            <s-link href="/app/health">Review on the Health page</s-link>
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Connections">
        {connections.map((c) => (
          <s-stack key={c.id} direction="inline" gap="base">
            <s-text>
              {c.source} → {c.dest}:
            </s-text>
            <s-badge tone={STATUS_TONE[c.status] ?? "neutral"}>
              {STATUS_LABEL[c.status] ?? c.status}
            </s-badge>
            <s-text>{String(c.mappingCount)} SKUs</s-text>
            <s-link href={`/app/mappings/${c.id}`}>View SKUs</s-link>
            <s-link href={`/app/settings/${c.id}`}>Settings</s-link>
          </s-stack>
        ))}
      </s-section>

      <s-section heading="Recent activity">
        {recentActivity.length === 0 ? (
          <s-paragraph>
            No activity yet. Once syncing starts, the latest events show up
            here.
          </s-paragraph>
        ) : (
          <s-unordered-list>
            {recentActivity.map((entry) => (
              <s-list-item key={entry.id}>
                <s-text
                  tone={
                    entry.level === "error"
                      ? "critical"
                      : entry.level === "warn"
                        ? "caution"
                        : "auto"
                  }
                >
                  {entry.message}
                </s-text>{" "}
                <s-text tone="neutral">
                  {new Date(entry.createdAt).toLocaleString()}
                </s-text>
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>

      <s-section slot="aside" heading="Plan">
        <s-paragraph>Current plan: {planLabel}</s-paragraph>
        <s-paragraph>
          Synced SKUs: {String(syncedSkus)}
          {skuLimit !== null ? ` of ${skuLimit}` : " (unlimited)"}
        </s-paragraph>
        {skuLimit !== null && syncedSkus >= skuLimit && (
          <s-banner tone="warning">
            You've reached your plan's SKU limit. New products won't sync
            until you upgrade.
          </s-banner>
        )}
        <s-link href={manageplanUrl} target="_blank">
          Manage plan
        </s-link>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(new Error("Overview page failed to load"));
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
