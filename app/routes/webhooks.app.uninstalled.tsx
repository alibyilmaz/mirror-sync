import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Tokens are gone; disable every connection touching this shop so the
  // worker drops their jobs instead of retrying into 401s. Data is kept
  // until shop/redact arrives (48h later) in case of quick reinstall.
  const shopRow = await db.shop.findUnique({ where: { domain: shop } });
  if (shopRow) {
    await db.$transaction([
      db.shop.update({
        where: { id: shopRow.id },
        data: { uninstalledAt: new Date() },
      }),
      db.connection.updateMany({
        where: { OR: [{ sourceShopId: shopRow.id }, { destShopId: shopRow.id }] },
        data: { status: "disabled", pausedReason: `${shop} uninstalled the app` },
      }),
      db.pairingCode.deleteMany({ where: { shopId: shopRow.id } }),
      db.auditLog.create({
        data: {
          shopDomain: shop,
          kind: "system",
          level: "warn",
          message: `App uninstalled from ${shop}. All connections involving this store were disabled and its access token was deleted.`,
        },
      }),
    ]);
  }

  return new Response();
};
