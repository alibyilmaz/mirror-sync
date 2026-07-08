import prisma from "../db.server";
import { graphql } from "./sync/admin.server";

// Shopify managed pricing: plans are configured in the Dev Dashboard and
// Shopify hosts the pricing/upgrade page. The app only READS the active
// subscription to know which plan applies. Plan names here must match the
// names configured in the Dev Dashboard exactly (case-insensitive).

export const PLANS: Record<string, { label: string; skuLimit: number }> = {
  free: { label: "Free", skuLimit: 25 },
  starter: { label: "Starter", skuLimit: 250 },
  growth: { label: "Growth", skuLimit: 2500 },
  scale: { label: "Scale", skuLimit: Number.POSITIVE_INFINITY },
};

// App handle as configured in shopify.app.toml / Dev Dashboard; used for
// the hosted upgrade page URL.
export const APP_HANDLE = "mirrorsync";

export function upgradeUrl(shopDomain: string): string {
  const store = shopDomain.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${store}/charges/${APP_HANDLE}/pricing_plans`;
}

// Reads the active managed-pricing subscription and caches it on Shop.plan.
// Falls back to the cached value if the API call fails (billing must never
// take sync down).
export async function refreshPlan(shopDomain: string): Promise<string> {
  try {
    const data = await graphql<{
      currentAppInstallation: {
        activeSubscriptions: { name: string; status: string }[];
      };
    }>(
      shopDomain,
      `#graphql
      query mirrorSyncCurrentPlan {
        currentAppInstallation {
          activeSubscriptions { name status }
        }
      }`,
    );
    const active = data.currentAppInstallation.activeSubscriptions.find(
      (s) => s.status === "ACTIVE",
    );
    const plan = normalizePlanName(active?.name);
    await prisma.shop.updateMany({ where: { domain: shopDomain }, data: { plan } });
    return plan;
  } catch {
    const row = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    return row?.plan ?? "free";
  }
}

function normalizePlanName(name: string | undefined): string {
  const key = name?.trim().toLowerCase() ?? "";
  return key in PLANS ? key : "free";
}

export function skuLimitFor(plan: string): number {
  return PLANS[plan]?.skuLimit ?? PLANS.free.skuLimit;
}

// Synced SKUs = mappings on connections where this shop is the source.
export async function syncedSkuCount(shopDomain: string): Promise<number> {
  return prisma.mapping.count({
    where: {
      status: { not: "broken" },
      connection: { sourceShop: { domain: shopDomain }, status: { not: "disabled" } },
    },
  });
}

export type PlanCheck = {
  plan: string;
  limit: number;
  used: number;
  over: boolean;
};

export async function checkPlanLimit(shopDomain: string): Promise<PlanCheck> {
  const plan = await refreshPlan(shopDomain);
  const limit = skuLimitFor(plan);
  const used = await syncedSkuCount(shopDomain);
  return { plan, limit, used, over: used > limit };
}
