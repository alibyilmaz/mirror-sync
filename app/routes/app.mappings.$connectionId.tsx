import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { checkPlanLimit } from "../lib/plans.server";
import { MANUAL_PAUSE_REASON } from "../lib/pause";

async function loadConnectionForShop(connectionId: string | undefined, shopDomain: string) {
  if (!connectionId) throw new Response("Not found", { status: 404 });
  const connection = await db.connection.findUnique({
    where: { id: connectionId },
    include: { sourceShop: true, destShop: true },
  });
  if (
    !connection ||
    (connection.sourceShop.domain !== shopDomain && connection.destShop.domain !== shopDomain)
  ) {
    throw new Response("Not found", { status: 404 });
  }
  return connection;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const connection = await loadConnectionForShop(params.connectionId, session.shop);

  const mappings = await db.mapping.findMany({
    where: { connectionId: connection.id },
    orderBy: { sku: "asc" },
  });

  return {
    source: connection.sourceShop.domain,
    dest: connection.destShop.domain,
    mappings: mappings.map((m) => ({
      id: m.id,
      sku: m.sku,
      barcode: m.barcode,
      matchType: m.matchType,
      status: m.status,
      pauseReason: m.pauseReason,
      sourceVariantId: m.sourceVariantId.toString(),
      destVariantId: m.destVariantId.toString(),
      sourceProductId: m.sourceProductId?.toString() ?? null,
      destProductId: m.destProductId?.toString() ?? null,
      lastSyncedAt: m.lastSyncedAt?.toISOString() ?? null,
    })),
    counts: {
      total: mappings.length,
      active: mappings.filter((m) => m.status === "active").length,
      paused: mappings.filter((m) => m.status === "paused").length,
      broken: mappings.filter((m) => m.status === "broken").length,
      bySku: mappings.filter((m) => m.matchType === "auto_sku").length,
      byBarcode: mappings.filter((m) => m.matchType === "auto_barcode").length,
      manual: mappings.filter((m) => m.matchType === "manual").length,
    },
  };
};

function toBigIntOrNull(value: FormDataEntryValue | null): bigint | null {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text);
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const connection = await loadConnectionForShop(params.connectionId, session.shop);

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "pause-mapping" || intent === "resume-mapping" || intent === "unlink-mapping") {
    const mappingId = String(form.get("mappingId") ?? "");
    const mapping = await db.mapping.findUnique({ where: { id: mappingId } });
    if (!mapping || mapping.connectionId !== connection.id) {
      return { error: "That mapping no longer exists." };
    }

    if (intent === "pause-mapping") {
      await db.mapping.update({
        where: { id: mapping.id },
        // MANUAL_PAUSE_REASON marks this as a deliberate pause so a
        // connection-wide "Resync now" won't silently un-pause it.
        data: { status: "paused", pauseReason: MANUAL_PAUSE_REASON, pausedAt: new Date() },
      });
      return { ok: true };
    }
    if (intent === "resume-mapping") {
      await db.mapping.update({
        where: { id: mapping.id },
        data: {
          status: "active",
          pauseReason: null,
          pausedAt: null,
          failureCount: 0,
          driftCount: 0,
        },
      });
      return { ok: true };
    }
    await db.mapping.delete({ where: { id: mapping.id } });
    return { ok: true };
  }

  if (intent === "manual-map") {
    const sourceVariantId = toBigIntOrNull(form.get("sourceVariantId"));
    const sourceInventoryItemId = toBigIntOrNull(form.get("sourceInventoryItemId"));
    const destVariantId = toBigIntOrNull(form.get("destVariantId"));
    const destProductId = toBigIntOrNull(form.get("destProductId"));
    const destInventoryItemId = toBigIntOrNull(form.get("destInventoryItemId"));
    if (
      sourceVariantId === null ||
      sourceInventoryItemId === null ||
      destVariantId === null ||
      destProductId === null ||
      destInventoryItemId === null
    ) {
      return { error: "Every ID field is required and must contain only digits." };
    }
    const sku = String(form.get("sku") ?? "").trim() || null;

    // Plan limit applies wherever mappings are born (import + here).
    const existing = await db.mapping.findUnique({
      where: {
        connectionId_sourceVariantId: { connectionId: connection.id, sourceVariantId },
      },
      select: { id: true },
    });
    if (!existing) {
      const plan = await checkPlanLimit(connection.sourceShop.domain);
      if (plan.used >= plan.limit) {
        return {
          error: `The ${plan.plan} plan covers ${plan.limit} synced SKUs and ${plan.used} are in use. Upgrade the plan to add more.`,
        };
      }
    }

    await db.mapping.upsert({
      where: {
        connectionId_sourceVariantId: { connectionId: connection.id, sourceVariantId },
      },
      create: {
        connectionId: connection.id,
        sku,
        sourceVariantId,
        sourceInventoryItemId,
        destVariantId,
        destProductId,
        destInventoryItemId,
        matchType: "manual",
        status: "active",
      },
      update: {
        sku,
        sourceInventoryItemId,
        destVariantId,
        destProductId,
        destInventoryItemId,
        matchType: "manual",
        status: "active",
        pauseReason: null,
        pausedAt: null,
        failureCount: 0,
        driftCount: 0,
      },
    });
    return { ok: true, mapped: true };
  }

  return { error: "Unknown action" };
};

type MappingItem = Awaited<ReturnType<typeof loader>>["mappings"][number];

const MATCH_TYPE_LABELS: Record<string, string> = {
  auto_sku: "SKU",
  auto_barcode: "Barcode",
  manual: "Manual",
};

function MappingRow({ mapping }: { mapping: MappingItem }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  const submit = (intent: string) =>
    fetcher.submit({ intent, mappingId: mapping.id }, { method: "POST" });

  return (
    <s-table-row>
      <s-table-cell>{mapping.sku ?? "—"}</s-table-cell>
      <s-table-cell>{mapping.barcode ?? "—"}</s-table-cell>
      <s-table-cell>
        <s-badge tone={mapping.matchType === "manual" ? "neutral" : "info"}>
          {MATCH_TYPE_LABELS[mapping.matchType] ?? mapping.matchType}
        </s-badge>
      </s-table-cell>
      <s-table-cell>
        <s-badge
          tone={
            mapping.status === "active"
              ? "success"
              : mapping.status === "paused"
                ? "warning"
                : "critical"
          }
        >
          {mapping.status}
        </s-badge>
        {mapping.pauseReason && <s-text tone="neutral"> {mapping.pauseReason}</s-text>}
      </s-table-cell>
      <s-table-cell>
        {mapping.lastSyncedAt ? new Date(mapping.lastSyncedAt).toLocaleString() : "Never"}
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="base">
          {mapping.status === "active" ? (
            <s-button
              variant="tertiary"
              onClick={() => submit("pause-mapping")}
              {...(busy ? { loading: true } : {})}
            >
              Pause
            </s-button>
          ) : (
            <s-button
              variant="tertiary"
              onClick={() => submit("resume-mapping")}
              {...(busy ? { loading: true } : {})}
            >
              Resume
            </s-button>
          )}
          <s-button
            variant="tertiary"
            tone="critical"
            onClick={() => submit("unlink-mapping")}
            {...(busy ? { loading: true } : {})}
          >
            Unlink
          </s-button>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

export default function Mappings() {
  const { source, dest, mappings, counts } = useLoaderData<typeof loader>();
  const manual = useFetcher<typeof action>();

  return (
    <s-page heading={`SKU mapping — ${source} → ${dest}`}>
      <s-section heading="Summary">
        <s-paragraph>
          {String(counts.total)} SKUs are mapped between the two stores.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-badge tone="success">{`${counts.active} active`}</s-badge>
          <s-badge tone="warning">{`${counts.paused} paused`}</s-badge>
          <s-badge tone="critical">{`${counts.broken} broken`}</s-badge>
          <s-badge tone="info">{`${counts.bySku} matched by SKU`}</s-badge>
          <s-badge tone="info">{`${counts.byBarcode} matched by barcode`}</s-badge>
          <s-badge tone="neutral">{`${counts.manual} mapped manually`}</s-badge>
        </s-stack>
      </s-section>

      <s-banner tone="info" heading="Missing a product?">
        If some products on the source store didn&apos;t match, fix their SKU or
        barcode on either store, then use &quot;Restart import&quot; on the Health page.
        Restarting the import keeps all of your manual mappings.
      </s-banner>

      <s-section heading="Mapped SKUs">
        {mappings.length === 0 ? (
          <s-paragraph>
            No SKUs are mapped yet. The initial import may still be running —
            check the Health page — or you can add a manual mapping below.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Barcode</s-table-header>
              <s-table-header>Matched by</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Last synced</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {mappings.map((m) => (
                <MappingRow key={m.id} mapping={m} />
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Add a manual mapping">
        <s-paragraph>
          Link a source variant to a destination variant by their numeric IDs.
          To find a variant&apos;s ID, open the product in the Shopify admin, click
          the variant, and copy the number at the end of the browser URL. The
          inventory item ID is shown in the URL when you view that variant&apos;s
          inventory history.
        </s-paragraph>
        <manual.Form method="post">
          <input type="hidden" name="intent" value="manual-map" />
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-text-field
                label="Source variant ID"
                name="sourceVariantId"
                placeholder="e.g. 45678901234567"
              ></s-text-field>
              <s-text-field
                label="Source inventory item ID"
                name="sourceInventoryItemId"
                placeholder="e.g. 47890123456789"
              ></s-text-field>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-text-field
                label="Destination variant ID"
                name="destVariantId"
                placeholder="e.g. 45678909876543"
              ></s-text-field>
              <s-text-field
                label="Destination product ID"
                name="destProductId"
                placeholder="e.g. 8901234567890"
              ></s-text-field>
              <s-text-field
                label="Destination inventory item ID"
                name="destInventoryItemId"
                placeholder="e.g. 47890129876543"
              ></s-text-field>
            </s-stack>
            <s-text-field
              label="SKU (optional)"
              name="sku"
              placeholder="e.g. TSHIRT-M-BLUE"
            ></s-text-field>
            <s-button
              type="submit"
              variant="primary"
              {...(manual.state !== "idle" ? { loading: true } : {})}
            >
              Add mapping
            </s-button>
          </s-stack>
        </manual.Form>
        {manual.data && "error" in manual.data && (
          <s-banner tone="critical">{manual.data.error}</s-banner>
        )}
        {manual.data && "mapped" in manual.data && (
          <s-banner tone="success">
            Mapping saved. Inventory for this SKU will sync on the next update.
          </s-banner>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(new Error("Mapping page failed to load"));
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
