import type { HeadersFunction } from "react-router";

// Public (unauthenticated) privacy policy — the URL to list in the App Store
// submission. MirrorSync only ever touches the merchant's own inventory and
// product data; it stores no customer personal information.
export const headers: HeadersFunction = () => ({
  "Cache-Control": "public, max-age=3600",
});

export default function Privacy() {
  const updated = "July 2026";
  return (
    <main
      style={{
        maxWidth: "42rem",
        margin: "0 auto",
        padding: "3rem 1.25rem",
        fontFamily: "system-ui, -apple-system, sans-serif",
        lineHeight: 1.6,
        color: "#1a1a1a",
      }}
    >
      <h1>MirrorSync — Privacy Policy</h1>
      <p>
        <em>Last updated: {updated}</em>
      </p>

      <p>
        MirrorSync keeps inventory and product data in sync between two or more
        Shopify stores owned by the same merchant. This policy explains what the
        app accesses and stores.
      </p>

      <h2>What we access</h2>
      <p>
        With the merchant&apos;s permission, MirrorSync reads and writes
        inventory levels, product details (title, price, tags, images,
        metafields), and store locations, using the Shopify Admin API. These
        permissions are requested at install and used only to perform the sync
        the merchant configured.
      </p>

      <h2>What we store</h2>
      <p>
        We store the minimum needed to sync reliably: store domains, the mapping
        between matched products/variants across stores, sync settings, a record
        of recent changes for drift detection, and a plain-language activity log.
        We store an offline access token per store so background syncing can run.
        We do <strong>not</strong> access, request, or store any customer
        personal information — no names, emails, addresses, or orders.
      </p>

      <h2>Data location and retention</h2>
      <p>
        Data is stored in a Postgres database (Supabase). Operational records
        (change history, activity log) are pruned automatically over time. When
        the app is uninstalled we delete the store&apos;s access token and
        disable its connections; on Shopify&apos;s <code>shop/redact</code>{" "}
        request (48 hours after uninstall) we permanently delete all of that
        store&apos;s data.
      </p>

      <h2>Sharing</h2>
      <p>
        We do not sell or share merchant data with third parties. Data is only
        transmitted between the merchant&apos;s own Shopify stores and our
        hosting/database providers to operate the service.
      </p>

      <h2>GDPR / compliance</h2>
      <p>
        MirrorSync handles Shopify&apos;s mandatory compliance webhooks
        (<code>customers/data_request</code>, <code>customers/redact</code>,
        <code>shop/redact</code>). Because we store no customer data, data and
        redaction requests have nothing to return; shop redaction purges the
        store&apos;s records.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy or your data: <a href="mailto:ali@cloudpeer.com">ali@cloudpeer.com</a>.
      </p>
    </main>
  );
}
