import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory GDPR topics. MirrorSync stores no customer data at all, so
// customers/data_request and customers/redact only need an acknowledgement.
// shop/redact arrives 48h after uninstall and triggers the final purge.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      await db.auditLog.create({
        data: {
          shopDomain: shop,
          kind: "system",
          message: `Received ${topic} — no customer data is stored, nothing to provide or redact.`,
        },
      });
      break;
    case "SHOP_REDACT": {
      const shopRow = await db.shop.findUnique({ where: { domain: shop } });
      if (shopRow) {
        // Cascades take out connections, mappings, location links, imports.
        await db.$transaction([
          db.connection.deleteMany({
            where: { OR: [{ sourceShopId: shopRow.id }, { destShopId: shopRow.id }] },
          }),
          db.shop.delete({ where: { id: shopRow.id } }),
          db.session.deleteMany({ where: { shop } }),
          db.webhookReceipt.deleteMany({ where: { shop } }),
          db.resourceVersion.deleteMany({ where: { shopDomain: shop } }),
          db.echoWrite.deleteMany({ where: { shopDomain: shop } }),
          // Dead-letter payloads carry this shop's webhook data, so they
          // must be purged too.
          db.deadLetter.deleteMany({ where: { shopDomain: shop } }),
          db.auditLog.deleteMany({ where: { shopDomain: shop } }),
        ]);
      }
      break;
    }
  }

  return new Response();
};
