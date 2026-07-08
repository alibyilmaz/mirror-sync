import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const connection = await db.connection.findUnique({
    where: { id: params.connectionId },
    include: { sourceShop: true, destShop: true, locationLinks: true },
  });
  if (!connection) throw new Response("Not found", { status: 404 });

  const isSource = connection.sourceShop.domain === session.shop;
  const isDest = connection.destShop.domain === session.shop;
  if (!isSource && !isDest) throw new Response("Not found", { status: 404 });

  return {
    role: isSource ? ("source" as const) : ("dest" as const),
    sourceDomain: connection.sourceShop.domain,
    destDomain: connection.destShop.domain,
    settings: {
      syncInventory: connection.syncInventory,
      syncTitle: connection.syncTitle,
      syncPrice: connection.syncPrice,
      syncImages: connection.syncImages,
      syncTags: connection.syncTags,
      metafieldNamespaces: connection.metafieldNamespaces.join(", "),
      safetyStockBuffer: connection.safetyStockBuffer,
    },
    locationLinks: connection.locationLinks.map((link) => ({
      id: link.id,
      sourceLocationId: link.sourceLocationId.toString(),
      destLocationId: link.destLocationId.toString(),
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "save") return { error: "Unknown action" };

  const connection = await db.connection.findUnique({
    where: { id: params.connectionId },
    include: { sourceShop: true, destShop: true },
  });
  if (!connection) throw new Response("Not found", { status: 404 });
  if (connection.sourceShop.domain !== session.shop) {
    return { error: "Sync settings can only be changed on the source store." };
  }

  const checked = (name: string) => {
    const value = form.get(name);
    return value !== null && value !== "" && value !== "false";
  };
  const parsedBuffer = Number.parseInt(
    String(form.get("safetyStockBuffer") ?? ""),
    10,
  );
  const next = {
    syncInventory: checked("syncInventory"),
    syncTitle: checked("syncTitle"),
    syncPrice: checked("syncPrice"),
    syncImages: checked("syncImages"),
    syncTags: checked("syncTags"),
    metafieldNamespaces: String(form.get("metafieldNamespaces") ?? "")
      .split(",")
      .map((namespace) => namespace.trim())
      .filter((namespace) => namespace.length > 0),
    safetyStockBuffer:
      Number.isFinite(parsedBuffer) && parsedBuffer > 0 ? parsedBuffer : 0,
  };

  const changes: string[] = [];
  const toggles = [
    ["syncInventory", "inventory sync"],
    ["syncTitle", "title sync"],
    ["syncPrice", "price sync"],
    ["syncImages", "image sync"],
    ["syncTags", "tag sync"],
  ] as const;
  for (const [field, label] of toggles) {
    if (connection[field] !== next[field]) {
      changes.push(`${label} ${next[field] ? "on" : "off"}`);
    }
  }
  if (
    connection.metafieldNamespaces.join(",") !==
    next.metafieldNamespaces.join(",")
  ) {
    changes.push(
      next.metafieldNamespaces.length > 0
        ? `metafield namespaces ${next.metafieldNamespaces.join(", ")}`
        : "metafield namespaces cleared",
    );
  }
  if (connection.safetyStockBuffer !== next.safetyStockBuffer) {
    changes.push(`safety buffer ${next.safetyStockBuffer}`);
  }

  if (changes.length > 0) {
    await db.connection.update({ where: { id: connection.id }, data: next });
    await db.auditLog.create({
      data: {
        connectionId: connection.id,
        shopDomain: session.shop,
        kind: "system",
        message: `Sync settings updated for ${connection.sourceShop.domain} → ${connection.destShop.domain}: ${changes.join(", ")}.`,
        context: { changed: changes },
      },
    });
  }
  return { ok: true };
};

export default function ConnectionSettings() {
  const { role, sourceDomain, destDomain, settings, locationLinks } =
    useLoaderData<typeof loader>();
  const save = useFetcher<typeof action>();
  const readOnly = role !== "source";
  const disabledProps = readOnly ? { disabled: true } : {};

  const fields = (
    <s-stack direction="block" gap="base">
      <s-checkbox
        label="Inventory"
        details="The core feature — leave this on"
        name="syncInventory"
        {...(settings.syncInventory ? { defaultChecked: true } : {})}
        {...disabledProps}
      ></s-checkbox>
      <s-checkbox
        label="Titles"
        name="syncTitle"
        {...(settings.syncTitle ? { defaultChecked: true } : {})}
        {...disabledProps}
      ></s-checkbox>
      <s-checkbox
        label="Prices"
        name="syncPrice"
        {...(settings.syncPrice ? { defaultChecked: true } : {})}
        {...disabledProps}
      ></s-checkbox>
      <s-checkbox
        label="Images (coming soon)"
        name="syncImagesDisplay"
        {...(settings.syncImages ? { defaultChecked: true } : {})}
        disabled
      ></s-checkbox>
      <s-checkbox
        label="Tags"
        name="syncTags"
        {...(settings.syncTags ? { defaultChecked: true } : {})}
        {...disabledProps}
      ></s-checkbox>
      <s-text-field
        label="Metafield namespaces"
        name="metafieldNamespaces"
        details="Metafields in these namespaces are copied to the destination store. Separate namespaces with commas, e.g. specs, care."
        placeholder="specs, care"
        defaultValue={settings.metafieldNamespaces}
        {...(readOnly ? { readOnly: true } : {})}
      ></s-text-field>
      <s-number-field
        label="Safety stock buffer"
        name="safetyStockBuffer"
        min={0}
        details="Destination shows source stock minus this buffer, never below 0."
        defaultValue={String(settings.safetyStockBuffer)}
        {...(readOnly ? { readOnly: true } : {})}
      ></s-number-field>
    </s-stack>
  );

  return (
    <s-page heading={`Sync settings — ${sourceDomain} → ${destDomain}`}>
      <s-section heading="What to sync">
        {readOnly && (
          <s-banner tone="info">
            These settings are managed on the source store ({sourceDomain}).
            Open MirrorSync there to change them.
          </s-banner>
        )}
        {readOnly ? (
          fields
        ) : (
          <save.Form method="post">
            <input type="hidden" name="intent" value="save" />
            <input
              type="hidden"
              name="syncImages"
              value={settings.syncImages ? "on" : ""}
            />
            <s-stack direction="block" gap="base">
              {fields}
              <s-button
                type="submit"
                variant="primary"
                {...(save.state !== "idle" ? { loading: true } : {})}
              >
                Save
              </s-button>
            </s-stack>
          </save.Form>
        )}
        {save.data && "ok" in save.data && (
          <s-banner tone="success">Settings saved.</s-banner>
        )}
        {save.data && "error" in save.data && (
          <s-banner tone="critical">{save.data.error}</s-banner>
        )}
      </s-section>

      <s-section heading="Linked locations">
        {locationLinks.length === 0 ? (
          <s-paragraph>No locations are linked yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Source location ID</s-table-header>
              <s-table-header>Destination location ID</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {locationLinks.map((link) => (
                <s-table-row key={link.id}>
                  <s-table-cell>{link.sourceLocationId}</s-table-cell>
                  <s-table-cell>→ {link.destLocationId}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-paragraph>
          <s-text tone="neutral">
            Stock at locations that are not linked is not synced.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(new Error("Sync settings page failed to load"));
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
