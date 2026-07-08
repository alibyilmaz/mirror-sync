import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "MirrorSync — Sync you don't have to think about" },
  {
    name: "description",
    content:
      "Reliable inventory and product sync between your Shopify stores. Never oversell, catch every change, recover in one click.",
  },
  { property: "og:title", content: "MirrorSync" },
  { property: "og:description", content: "Sync you don't have to think about." },
  { property: "og:image", content: "/brand/mirrorsync-og.svg" },
];

export const links: LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/brand/mirrorsync-icon.svg" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&display=swap",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

// The MirrorSync mark (concept A: reflected square). Inlined so it renders
// with no extra request and inherits crisp scaling.
function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1200 1200" className={className} aria-hidden="true">
      <rect width="1200" height="1200" fill="#0F1B2D" />
      <line x1="600" y1="320" x2="600" y2="880" stroke="rgba(255,255,255,0.28)" strokeWidth="10" />
      <rect x="252" y="412" width="296" height="296" rx="64" fill="#14B8A6" />
      <rect x="663" y="423" width="274" height="274" rx="56" fill="none" stroke="#2DD4BF" strokeWidth="22" />
      <line x1="500" y1="820" x2="660" y2="820" stroke="rgba(255,255,255,0.85)" strokeWidth="16" strokeLinecap="round" />
      <path d="M660,784 L716,820 L660,856 Z" fill="rgba(255,255,255,0.85)" />
    </svg>
  );
}

const FEATURES = [
  {
    title: "Never oversell",
    text: "Syncs the instant stock changes — inventory_levels/update, not just paid orders — so a restock or sale reflects across stores in seconds.",
    icon: (
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    ),
  },
  {
    title: "Catches every change",
    text: "Edits from other apps or by hand, and any missed webhook, are caught by an hourly full-state reconciliation that repairs drift automatically.",
    icon: (
      <>
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="m16 16 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: "One-click recovery",
    text: "Every sync is logged in plain language. When something looks off, a safety pause kicks in and you resync with a single tap — no support ticket.",
    icon: (
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
];

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <div className={styles.brandbar}>
          <Logo className={styles.logo} />
          <span className={styles.wordmark}>
            Mirror<b>Sync</b>
          </span>
        </div>

        <section className={styles.hero}>
          <div className={styles.heroText}>
            <span className={styles.eyebrow}>Inventory &amp; product sync</span>
            <h1 className={styles.heading}>
              Keep your stores in sync, without watching them.
            </h1>
            <p className={styles.tagline}>Sync you don&apos;t have to think about.</p>
            <p className={styles.text}>
              MirrorSync mirrors inventory and product data one way — source to
              destination — between the Shopify stores you own. Reliability is
              the whole product: duplicate and out-of-order events, other
              apps&apos; writes, and API limits are all handled so your
              destination never oversells and never silently drifts.
            </p>
          </div>

          {showForm && (
            <div className={styles.card}>
              <p className={styles.cardTitle}>Log in to get started</p>
              <Form className={styles.form} method="post" action="/auth/login">
                <label className={styles.label}>
                  Shop domain
                  <input
                    className={styles.input}
                    type="text"
                    name="shop"
                    placeholder="my-shop-domain.myshopify.com"
                    autoComplete="off"
                  />
                  <span className={styles.hint}>e.g. my-shop-domain.myshopify.com</span>
                </label>
                <button className={styles.button} type="submit">
                  Log in
                </button>
              </Form>
            </div>
          )}
        </section>

        <ul className={styles.features}>
          {FEATURES.map((f) => (
            <li className={styles.feature} key={f.title}>
              <svg className={styles.featureIcon} viewBox="0 0 24 24" aria-hidden="true">
                {f.icon}
              </svg>
              <h2 className={styles.featureTitle}>{f.title}</h2>
              <p className={styles.featureText}>{f.text}</p>
            </li>
          ))}
        </ul>

        <footer className={styles.footer}>
          <span>© {new Date().getFullYear()} MirrorSync</span>
          <a href="/privacy">Privacy</a>
          <a href="mailto:mirrorsync@proton.me">mirrorsync@proton.me</a>
        </footer>
      </div>
    </div>
  );
}
