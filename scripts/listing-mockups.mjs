// Build the 5 App Store listing images (1600x900) as branded compositions
// of the embedded app screens, using REAL data captured from the demo
// stores. Renders HTML with headless Edge via puppeteer-core.
//   node scripts/listing-mockups.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const OUT = resolve("listing-assets");
const SRC = resolve(OUT, "src");
mkdirSync(SRC, { recursive: true });

// Edge headless is blocked on this machine (exits silently — likely
// enterprise policy), so use puppeteer's chrome-headless-shell.
const EDGE =
  "C:\\Users\\Ali\\.cache\\puppeteer\\chrome-headless-shell\\win64-150.0.7871.24\\chrome-headless-shell-win64\\chrome-headless-shell.exe";

// ---------------------------------------------------------------------------
// Shared chrome: brand canvas + simplified Shopify-admin window + app shell
// ---------------------------------------------------------------------------

const badge = (tone, label) => {
  const tones = {
    success: ["#e7f4ec", "#0d6b45"],
    warning: ["#fdf3dc", "#8a6116"],
    critical: ["#fbeae8", "#a4270f"],
    info: ["#e8f2fb", "#20527d"],
    neutral: ["#f1f1f1", "#5c5f62"],
  };
  const [bg, fg] = tones[tone];
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:12.5px;font-weight:550;padding:3px 10px;border-radius:20px;white-space:nowrap;">${label}</span>`;
};

const btn = (label, primary = false) =>
  `<span style="display:inline-block;padding:8px 16px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:default;${
    primary
      ? "background:#1a1a1a;color:#fff;"
      : "background:#fff;color:#26292c;border:1px solid #d0d3d6;box-shadow:0 1px 0 rgba(0,0,0,0.05);"
  }">${label}</span>`;

function page(caption, sub, appNavActive, contentHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=Inter:wght@400;450;550;600;650&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:1600px; height:900px; overflow:hidden; font-family:Inter,system-ui,sans-serif;
    background:#f8f6f1;
    background-image:
      radial-gradient(900px 700px at 4% -14%, rgba(13,148,136,.10), transparent 60%),
      radial-gradient(760px 640px at 103% 8%, rgba(94,234,212,.12), transparent 58%),
      radial-gradient(1000px 800px at 55% 125%, rgba(13,148,136,.06), transparent 62%);
  }
  .cap { position:absolute; top:64px; left:80px; width:560px; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:26px; }
  .brand svg { width:34px; height:34px; border-radius:9px; box-shadow:0 3px 10px rgba(22,39,61,.16); }
  .brand span { font-family:'Space Grotesk'; font-weight:600; font-size:19px; color:#16273d; letter-spacing:-.02em; }
  .brand b { color:#0d9488; font-weight:600; }
  h1 { font-family:'Space Grotesk'; font-weight:600; font-size:44px; line-height:1.12; letter-spacing:-.028em; color:#16273d; }
  .sub { margin-top:16px; font-size:17.5px; line-height:1.6; color:#5c6774; max-width:470px; }
  .win { position:absolute; right:64px; top:150px; width:880px; height:750px;
    background:#f6f6f7; border-radius:14px 14px 0 0; overflow:hidden;
    box-shadow:0 2px 6px rgba(22,39,61,.08), 0 30px 80px rgba(22,39,61,.18); }
  .topbar { height:48px; background:#1a1a1a; display:flex; align-items:center; padding:0 16px; gap:14px; }
  .topbar .mark { width:22px; height:22px; border-radius:6px; }
  .topbar .search { flex:1; max-width:380px; margin:0 auto; height:28px; background:#303030; border-radius:8px;
    display:flex; align-items:center; padding:0 10px; color:#9a9a9a; font-size:12.5px; gap:6px; }
  .topbar .shop { color:#e3e3e3; font-size:12.5px; font-weight:550; margin-left:auto; display:flex; align-items:center; gap:8px; }
  .topbar .avatar { width:24px; height:24px; border-radius:6px; background:#14b8a6; color:#04231f; font-size:11px; font-weight:700;
    display:flex; align-items:center; justify-content:center; }
  .appnav { height:46px; background:#fff; border-bottom:1px solid #e3e3e3; display:flex; align-items:center; padding:0 20px; gap:4px; }
  .appnav .title { display:flex; align-items:center; gap:8px; font-weight:650; font-size:13.5px; color:#1a1a1a; margin-right:18px; }
  .appnav .title svg { width:20px; height:20px; border-radius:5px; }
  .appnav a { font-size:13px; color:#5c5f62; padding:6px 12px; border-radius:8px; text-decoration:none; }
  .appnav a.on { background:#f1f1f1; color:#1a1a1a; font-weight:600; }
  .content { padding:20px 24px; height:656px; overflow:hidden; }
  .pagehead { font-weight:650; font-size:20px; color:#1a1a1a; margin-bottom:14px; }
  .card { background:#fff; border-radius:12px; box-shadow:0 1px 2px rgba(0,0,0,.05), 0 0 0 1px rgba(0,0,0,.05); padding:16px 18px; margin-bottom:14px; }
  .card h3 { font-size:14px; font-weight:650; color:#1a1a1a; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; font-size:13px; color:#26292c; }
  th { text-align:left; font-weight:550; color:#6d7175; font-size:12px; padding:6px 8px; border-bottom:1px solid #ebebeb; }
  td { padding:9px 8px; border-bottom:1px solid #f1f1f1; vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  .mono { font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
  .muted { color:#6d7175; }
  .banner { display:flex; gap:10px; border-radius:10px; padding:12px 14px; font-size:13px; line-height:1.5; margin-bottom:14px; align-items:flex-start; }
  .banner.warn { background:#fdf3dc; color:#57430e; box-shadow:0 0 0 1px #f0dbA5 inset; }
  .banner.ok { background:#e7f4ec; color:#0d4f34; box-shadow:0 0 0 1px #b7dfc5 inset; }
  .dot { width:8px; height:8px; border-radius:50%; flex:none; margin-top:6px; }
  .act { display:flex; gap:10px; padding:9px 0; border-bottom:1px solid #f1f1f1; font-size:13px; align-items:flex-start; line-height:1.5; }
  .act:last-child { border-bottom:none; }
  .act time { margin-left:auto; color:#8c9196; font-size:12px; white-space:nowrap; padding-left:14px; }
</style></head><body>
<div class="cap">
  <div class="brand">${LOGO}<span>Mirror<b>Sync</b></span></div>
  <h1>${caption}</h1>
  <p class="sub">${sub}</p>
</div>
<div class="win">
  <div class="topbar">
    ${LOGO_SM}
    <div class="search">⌕&nbsp; Search</div>
    <div class="shop"><span>mirror-sync-dest</span><span class="avatar">MD</span></div>
  </div>
  <div class="appnav">
    <span class="title">${LOGO_NAV}mirror-sync</span>
    ${["Overview", "Connections", "Health"].map((n) => `<a class="${n === appNavActive ? "on" : ""}">${n}</a>`).join("")}
  </div>
  <div class="content">${contentHtml}</div>
</div>
</body></html>`;
}

const LOGO_SVG = (cls) => `<svg class="${cls}" viewBox="0 0 1200 1200" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="1200" rx="140" fill="#0F1B2D"/>
  <line x1="600" y1="320" x2="600" y2="880" stroke="rgba(255,255,255,0.28)" stroke-width="10"/>
  <rect x="252" y="412" width="296" height="296" rx="64" fill="#14B8A6"/>
  <rect x="663" y="423" width="274" height="274" rx="56" fill="none" stroke="#2DD4BF" stroke-width="22"/>
  <line x1="500" y1="820" x2="660" y2="820" stroke="rgba(255,255,255,0.85)" stroke-width="16" stroke-linecap="round"/>
  <path d="M660,784 L716,820 L660,856 Z" fill="rgba(255,255,255,0.85)"/>
</svg>`;
const LOGO = LOGO_SVG("");
const LOGO_SM = LOGO_SVG("mark");
const LOGO_NAV = LOGO_SVG("");

// ---------------------------------------------------------------------------
// Screen content (REAL data from the demo stores)
// ---------------------------------------------------------------------------

const dotFor = (kind) =>
  kind === "pause" ? "#b98900" : kind === "import" ? "#20527d" : "#0d9488";

const HEALTH_FEED = [
  ["reconcile", "Hourly check finished: 9 SKUs compared, 0 drifted and were corrected.", "2 min ago"],
  ["reconcile", "Drift repaired for SKU SYNC-CAP: mirror-sync-dest.myshopify.com had 999, corrected to 42 to match mirror-sync.myshopify.com.", "19 min ago"],
  ["reconcile", "Drift repaired for SKU SYNC-CAP: mirror-sync-dest.myshopify.com had 640, corrected to 42 to match mirror-sync.myshopify.com.", "20 min ago"],
  ["reconcile", "Drift repaired for SKU SYNC-TEE-L: mirror-sync-dest.myshopify.com had 888, corrected to 8 to match mirror-sync.myshopify.com.", "21 min ago"],
  ["reconcile", "Drift repaired for SKU SYNC-TEE-M: mirror-sync-dest.myshopify.com had 777, corrected to 27 to match mirror-sync.myshopify.com.", "24 min ago"],
  ["sync", "Inventory synced for SKU SYNC-TEE-M: 30 → 14 at mirror-sync-dest.myshopify.com.", "1 hr ago"],
  ["import", "Initial matching finished: 6 SKUs matched by SKU, 4 by barcode. Now pushing initial inventory levels.", "1 hr ago"],
];

const feedHtml = (rows) =>
  rows
    .map(
      ([k, m, t]) =>
        `<div class="act"><span class="dot" style="background:${dotFor(k)}"></span><span>${m}</span><time>${t}</time></div>`,
    )
    .join("");

const screens = {
  "1-health": {
    caption: "It checks itself every hour — and fixes what it finds.",
    sub: "Hourly reconciliation compares both stores SKU by SKU and repairs any drift — with every fix written in plain language.",
    nav: "Health",
    html: `
      <div class="pagehead">Health</div>
      <div class="card" style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:13.5px;">Receives inventory from <span class="mono">mirror-sync.myshopify.com</span></span>
        ${badge("success", "Active")}
        <span style="margin-left:auto">${btn("Resync now", true)}</span>
      </div>
      <div class="card">
        <h3>Activity</h3>
        ${feedHtml(HEALTH_FEED)}
      </div>`,
  },

  "2-paused": {
    caption: "When something’s wrong, it tells you in plain English.",
    sub: "Repeated drift or write failures pause just that SKU — with the reason spelled out and a one-click way back.",
    nav: "Health",
    html: `
      <div class="pagehead">Health</div>
      <div class="banner warn"><span style="font-size:15px">⚠</span>
        <span><b>Sync paused for SKU SYNC-CAP:</b> its stock at mirror-sync-dest.myshopify.com drifted away 3 hours in a row (last: 999 instead of 42). Another app or a manual edit is probably changing it. Fixed it one more time, but review it, then use “Resync now”.</span>
      </div>
      <div class="card">
        <h3>Paused SKUs</h3>
        <table>
          <tr><th>SKU</th><th>Status</th><th>Reason</th><th>When</th><th></th></tr>
          <tr>
            <td class="mono">SYNC-CAP</td>
            <td>${badge("warning", "paused")}</td>
            <td class="muted" style="max-width:330px">Inventory drifted 3 reconciliations in a row — something else appears to be changing stock</td>
            <td class="muted">19 min ago</td>
            <td style="text-align:right">${btn("Resync now")}</td>
          </tr>
        </table>
      </div>
      <div class="card">
        <h3>Failed jobs</h3>
        <p class="muted" style="font-size:12.5px;margin-bottom:8px;">Retrying is safe: each job re-checks the current numbers before writing anything.</p>
        <table>
          <tr><th>Queue</th><th>Error</th><th>Attempts</th><th></th></tr>
          <tr>
            <td>${badge("neutral", "Sync")}</td>
            <td class="muted">inventorySetQuantities failed: Inventory item not stocked at location</td>
            <td>5</td>
            <td style="text-align:right">${btn("Retry")}</td>
          </tr>
        </table>
      </div>`,
  },

  "3-connect": {
    caption: "Connect two stores in under a minute.",
    sub: "Generate a one-time code on the source store, enter it on the destination — import and SKU matching start automatically.",
    nav: "Connections",
    html: `
      <div class="pagehead">Connections</div>
      <div class="card">
        <h3>Share inventory FROM this store (source)</h3>
        <p class="muted" style="font-size:13px;margin-bottom:12px;">Generate a one-time code, then enter it on the destination store. Codes expire after 15 minutes.</p>
        <div style="display:flex;align-items:center;gap:16px;">
          ${btn("Generate connection code", true)}
          <div style="background:#f6f6f7;border:1px dashed #c9cccf;border-radius:10px;padding:10px 22px;">
            <span class="mono" style="font-size:22px;font-weight:650;letter-spacing:.12em;color:#1a1a1a;">K7RM-P2WX</span>
          </div>
          <span class="muted" style="font-size:12.5px;">valid for 15 minutes</span>
        </div>
      </div>
      <div class="card">
        <h3>Active connections</h3>
        <table>
          <tr><th>Direction</th><th>Store</th><th>Status</th><th>Synced SKUs</th></tr>
          <tr>
            <td>← receives from</td>
            <td class="mono">mirror-sync.myshopify.com</td>
            <td>${badge("success", "active")}</td>
            <td>11</td>
          </tr>
        </table>
      </div>
      <div class="banner ok"><span style="font-size:15px">✓</span>
        <span>Connected. The initial import has started — matching products by SKU and barcode. Track progress on the Health page.</span>
      </div>`,
  },

  "4-mapping": {
    caption: "SKUs match themselves. You approve the edge cases.",
    sub: "On connect, catalogs are matched by SKU, then barcode. Ambiguous matches are never guessed — you map those by hand.",
    nav: "Connections",
    html: `
      <div class="pagehead">SKU mapping — mirror-sync → mirror-sync-dest</div>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        ${badge("success", "10 active")} ${badge("warning", "1 paused")}
        ${badge("neutral", "6 by SKU · 4 by barcode · 1 manual")}
      </div>
      <div class="card" style="padding:8px 18px;">
        <table>
          <tr><th>SKU</th><th>Barcode</th><th>Match</th><th>Status</th><th>Last synced</th><th></th></tr>
          <tr><td class="mono">SYNC-TEE-M</td><td class="muted">—</td><td>${badge("neutral", "auto · sku")}</td><td>${badge("success", "active")}</td><td class="muted">24 min ago</td><td style="text-align:right">${btn("Pause")}</td></tr>
          <tr><td class="mono">SYNC-TEE-L</td><td class="muted">—</td><td>${badge("neutral", "auto · sku")}</td><td>${badge("success", "active")}</td><td class="muted">21 min ago</td><td style="text-align:right">${btn("Pause")}</td></tr>
          <tr><td class="mono">SRC-BC-1</td><td class="mono muted">8901234500001</td><td>${badge("info", "auto · barcode")}</td><td>${badge("success", "active")}</td><td class="muted">31 min ago</td><td style="text-align:right">${btn("Pause")}</td></tr>
          <tr><td class="mono">SRC-BC-2</td><td class="mono muted">8901234500002</td><td>${badge("info", "auto · barcode")}</td><td>${badge("success", "active")}</td><td class="muted">31 min ago</td><td style="text-align:right">${btn("Pause")}</td></tr>
          <tr><td class="mono">SRC-BC-3</td><td class="mono muted">8901234500003</td><td>${badge("info", "auto · barcode")}</td><td>${badge("success", "active")}</td><td class="muted">31 min ago</td><td style="text-align:right">${btn("Pause")}</td></tr>
          <tr><td class="mono">SRC-BC-4</td><td class="mono muted">8901234500004</td><td>${badge("info", "auto · barcode")}</td><td>${badge("success", "active")}</td><td class="muted">31 min ago</td><td style="text-align:right">${btn("Pause")}</td></tr>
          <tr><td class="mono">COFFEE-ROASTERY-01</td><td class="muted">—</td><td>${badge("success", "manual")}</td><td>${badge("success", "active")}</td><td class="muted">36 min ago</td><td style="text-align:right">${btn("Pause")}</td></tr>
          <tr><td class="mono">SYNC-CAP</td><td class="muted">—</td><td>${badge("neutral", "auto · sku")}</td><td>${badge("warning", "paused")}</td><td class="muted">19 min ago</td><td style="text-align:right">${btn("Resume")}</td></tr>
        </table>
      </div>`,
  },

  "5-settings": {
    caption: "Sync exactly what you want — nothing more.",
    sub: "Inventory is the core. Titles, prices, tags and metafields are opt-in — and a safety buffer keeps restocks from overselling.",
    nav: "Connections",
    html: `
      <div class="pagehead">Sync settings — mirror-sync → mirror-sync-dest</div>
      <div class="card">
        <h3>What to sync</h3>
        ${[
          ["Inventory", true, "The core feature — leave this on"],
          ["Title", true, ""],
          ["Price", true, ""],
          ["Tags", false, ""],
          ["Images (coming soon)", false, "", true],
        ]
          .map(
            ([label, on, help, dis]) => `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:7px 0;${dis ? "opacity:.45;" : ""}">
            <span style="width:18px;height:18px;border-radius:5px;flex:none;margin-top:1px;display:flex;align-items:center;justify-content:center;
              ${on ? "background:#1a1a1a;color:#fff;font-size:12px;" : "background:#fff;border:1.5px solid #8c9196;"}">${on ? "✓" : ""}</span>
            <span style="font-size:13.5px;">${label}${help ? `<div class="muted" style="font-size:12px;margin-top:1px;">${help}</div>` : ""}</span>
          </div>`,
          )
          .join("")}
        <div style="margin-top:10px;">
          <div style="font-size:13px;font-weight:550;margin-bottom:5px;">Metafield namespaces</div>
          <div style="border:1px solid #c9cccf;border-radius:8px;padding:8px 12px;font-size:13px;max-width:340px;" class="mono">specs, care_guide</div>
          <div class="muted" style="font-size:12px;margin-top:4px;">Comma-separated. Only metafields in these namespaces are copied.</div>
        </div>
      </div>
      <div class="card">
        <h3>Oversell guard</h3>
        <div style="display:flex;align-items:center;gap:14px;">
          <div>
            <div style="font-size:13px;font-weight:550;margin-bottom:5px;">Safety stock buffer</div>
            <div style="border:1px solid #c9cccf;border-radius:8px;padding:8px 12px;font-size:14px;width:90px;text-align:center;font-weight:600;">5</div>
          </div>
          <p class="muted" style="font-size:12.5px;max-width:420px;">Destination shows source stock minus this buffer, never below 0 — so flash sales and restocks can’t oversell the mirrored store.</p>
        </div>
      </div>
      <div class="card">
        <h3>Linked locations</h3>
        <table>
          <tr><th>Source location</th><th></th><th>Destination location</th></tr>
          <tr><td>My Custom Location</td><td class="muted">→</td><td>My Custom Location</td></tr>
          <tr><td>Warehouse</td><td class="muted">→</td><td>Warehouse</td></tr>
        </table>
      </div>
      <div style="margin-top:2px;">${btn("Save", true)}</div>`,
  },
};

// ---------------------------------------------------------------------------

for (const [name, s] of Object.entries(screens)) {
  writeFileSync(resolve(SRC, `${name}.html`), page(s.caption, s.sub, s.nav, s.html));
}
console.log("HTML written:", Object.keys(screens).join(", "));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--force-device-scale-factor=1",
    `--user-data-dir=${resolve(OUT, ".edge-profile")}`,
  ],
});
const tab = await browser.newPage();
await tab.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
for (const name of Object.keys(screens)) {
  await tab.goto("file:///" + resolve(SRC, `${name}.html`).replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 60000 });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: resolve(OUT, `${name}.png`) });
  console.log("shot:", `listing-assets/${name}.png`);
}
await browser.close();
console.log("done");
