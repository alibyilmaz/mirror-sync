import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { generatePairingCode, redeemPairingCode, PairingError } from "../lib/pairing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUnique({
    where: { domain: session.shop },
    include: {
      sourceConnections: {
        where: { status: { not: "disabled" } },
        include: { destShop: true, _count: { select: { mappings: true } } },
      },
      destConnections: {
        where: { status: { not: "disabled" } },
        include: { sourceShop: true, _count: { select: { mappings: true } } },
      },
    },
  });
  return {
    shopDomain: session.shop,
    asSource: (shop?.sourceConnections ?? []).map((c) => ({
      id: c.id,
      otherShop: c.destShop.domain,
      status: c.status,
      mappingCount: c._count.mappings,
    })),
    asDest: (shop?.destConnections ?? []).map((c) => ({
      id: c.id,
      otherShop: c.sourceShop.domain,
      status: c.status,
      mappingCount: c._count.mappings,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  try {
    if (intent === "generate-code") {
      const code = await generatePairingCode(session.shop);
      return { code };
    }
    if (intent === "redeem-code") {
      const connection = await redeemPairingCode(session.shop, String(form.get("code") ?? ""));
      return { connected: connection.id };
    }
  } catch (e) {
    if (e instanceof PairingError) return { error: e.message };
    throw e;
  }
  return { error: "Unknown action" };
};

export default function Connections() {
  const { shopDomain, asSource, asDest } = useLoaderData<typeof loader>();
  const generate = useFetcher<typeof action>();
  const redeem = useFetcher<typeof action>();

  // While any connection is importing, poll so the merchant watches
  // "Matching products…" flip to the final state without touching refresh.
  const revalidator = useRevalidator();
  const importing = [...asSource, ...asDest].some((c) => c.status === "importing");
  useEffect(() => {
    if (!importing) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 4000);
    return () => clearInterval(timer);
  }, [importing, revalidator]);

  const skuCell = (c: { status: string; mappingCount: number }) =>
    c.status === "importing" ? "Matching products…" : String(c.mappingCount);

  return (
    <s-page heading="Connections">
      <s-section heading="This store">
        <s-paragraph>{shopDomain}</s-paragraph>
      </s-section>

      <s-section heading="Share inventory FROM this store (source)">
        <s-paragraph>
          Generate a one-time code, then open MirrorSync on the destination
          store and enter it there. Codes expire after 15 minutes.
        </s-paragraph>
        <generate.Form method="post">
          <input type="hidden" name="intent" value="generate-code" />
          <s-button
            type="submit"
            variant="primary"
            {...(generate.state !== "idle" ? { loading: true } : {})}
          >
            Generate connection code
          </s-button>
        </generate.Form>
        {generate.data && "code" in generate.data && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>{generate.data.code}</s-heading>
            <s-text tone="neutral">
              Enter this code on the destination store within 15 minutes.
            </s-text>
          </s-box>
        )}
      </s-section>

      <s-section heading="Receive inventory INTO this store (destination)">
        <redeem.Form method="post">
          <input type="hidden" name="intent" value="redeem-code" />
          <s-stack direction="inline" gap="base">
            <s-text-field
              label="Connection code"
              name="code"
              placeholder="XXXX-XXXX"
            ></s-text-field>
            <s-button type="submit" {...(redeem.state !== "idle" ? { loading: true } : {})}>
              Connect
            </s-button>
          </s-stack>
        </redeem.Form>
        {redeem.data && "error" in redeem.data && (
          <s-banner tone="critical">{redeem.data.error}</s-banner>
        )}
        {redeem.data && "connected" in redeem.data && (
          <s-banner tone="success">
            Connected. The initial import has started — matching products by
            SKU and barcode. Track progress on the Health page.
          </s-banner>
        )}
      </s-section>

      {(asSource.length > 0 || asDest.length > 0) && (
        <s-section heading="Active connections">
          <s-table>
            <s-table-header-row>
              <s-table-header>Direction</s-table-header>
              <s-table-header>Store</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Synced SKUs</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {asSource.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>→ sends to</s-table-cell>
                  <s-table-cell>{c.otherShop}</s-table-cell>
                  <s-table-cell>{c.status}</s-table-cell>
                  <s-table-cell>{skuCell(c)}</s-table-cell>
                </s-table-row>
              ))}
              {asDest.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>← receives from</s-table-cell>
                  <s-table-cell>{c.otherShop}</s-table-cell>
                  <s-table-cell>{c.status}</s-table-cell>
                  <s-table-cell>{skuCell(c)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(new Error("Connections page failed to load"));
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
