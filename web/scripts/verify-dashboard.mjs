// Render check for the dashboard page (SHOW_DETAILS off): the map, and below it one line chart for the selected race.
// Blocks every request that is not to 127.0.0.1/localhost and collects console errors. Checks the map, the chart
// legend (one row at 1280, wraps at 390, swatches match the lines in both themes, each entry toggles its line and
// axis, the last line cannot be switched off, the "why?" note opens by keyboard), that the chart has no race type
// switch and no scale switch, the plotted values (read back from the line paths) against data/processed, the date range (out-of-range dates are rejected), the readout
// values against data/processed (spot check table), the no-news state, touch target sizes and overflow at 390 px,
// the demo label, that the removed explanatory copy is gone and the map table is clipped to 1x1 px, the theme switch
// (data-theme flips, localStorage, chart and map colors follow, system setting fallback), that no element has a box
// shadow or a gradient, 44 px touch targets at 390 px, and runs axe in the light and dark theme at 1280 and 390 px.
// The Filters panel: the button right of the map heading, exactly five controls, disabled "coming soon" choices,
// the URL hash, the count badge, Reset, Esc and outside click, the map and chart following the controls.
// Writes docs/screenshots/style-{light,dark}-{1280,390}.png, filt-{closed,open}-{1280,390}.png and
// chart-{1280,390}-{light,dark}.png.
// Usage: node scripts/verify-dashboard.mjs <live base url> [demo base url]   (CHROME_PATH may point at Chromium)
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:4173/";
const DEMO = process.argv[3] ?? null;
const ROOT = resolve(import.meta.dirname, "../..");
const SHOTS = resolve(ROOT, "docs/screenshots");
const PROCESSED = resolve(ROOT, "data/processed");
const load = (id) => JSON.parse(readFileSync(resolve(PROCESSED, `${id}.json`), "utf-8"));
const index = load("index");
const tx = load("tx-senate-2026");
const NEWS = "news/race_either/national";
// a race with no news in its display window, for the no-news state (Kentucky also has missing Kalshi days)
const noNews = Object.keys(index.races).filter((id) => id !== "tx-senate-2026").map(load)
  .filter((d) => d.series.display_daily && d.series.display_daily.rows.every((r) => r[NEWS] == null))
  .sort((a, b) => b.series.display_daily.coverage.kalshi_price_close.missing_days.length
    - a.series.display_daily.coverage.kalshi_price_close.missing_days.length)[0];
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const report = { blocked: [], consoleErrors: [], pageErrors: [], checks: [], spot: [], plotted: [], axe: {} };
let failed = false;

async function open(width, url = `${BASE}?race=tx-senate-2026`, touch = false, colorScheme = "light") {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, hasTouch: touch, isMobile: touch,
    colorScheme });
  const page = await ctx.newPage();
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(u.hostname) || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
    report.blocked.push(route.request().url());
    return route.abort();
  });
  page.on("console", (m) => { if (m.type() === "error") report.consoleErrors.push(`${width}px: ${m.text()}`); });
  page.on("pageerror", (e) => report.pageErrors.push(`${width}px: ${e.message}`));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("body[data-ready=true]");
  await page.waitForSelector("#chart svg path.line");
  return { ctx, page };
}

function check(label, onPage, expected, ok) {
  report.checks.push({ label, onPage: String(onPage).slice(0, 400), expected: String(expected).slice(0, 300), ok: !!ok });
  if (!ok) failed = true;
}

async function axe(page, key) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  report.axe[key] = r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s): ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
}

// token values from web/src/style.css, as computed rgb
const THEME = {
  light: { bg: "rgb(255, 252, 240)", fg: "rgb(16, 15, 15)", price: "rgb(32, 94, 166)", volume: "rgb(175, 48, 41)", news: "rgb(102, 128, 11)" },
  dark: { bg: "rgb(16, 15, 15)", fg: "rgb(206, 205, 195)", price: "rgb(67, 133, 190)", volume: "rgb(209, 77, 65)", news: "rgb(135, 154, 57)" },
};
/** The colors the page actually draws with, to compare against THEME. */
const drawn = (page) => page.evaluate(() => {
  const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
  return { theme: document.documentElement.dataset.theme, bg: cs("body", "backgroundColor"), fg: cs("body", "color"),
    price: cs("#chart path.line-price", "stroke"), volume: cs("#chart path.line-volume", "stroke"),
    news: cs("#chart path.line-news", "stroke"), selected: cs("svg.usmap .sel-line", "stroke"),
    pressed: document.querySelector("#theme-btn")?.getAttribute("aria-pressed"),
    stored: localStorage.getItem("theme") };
});
function themeOk(d, name) {
  const t = THEME[name];
  return d.theme === name && d.bg === t.bg && d.fg === t.fg && d.price === t.price && d.volume === t.volume
    && d.news === t.news && d.selected === t.fg && d.pressed === String(name === "dark");
}
/** Elements with a box shadow or a gradient background (the style allows neither). */
const decorated = (page) => page.evaluate(() => [...document.querySelectorAll("*")].filter((e) => {
  const c = getComputedStyle(e);
  return c.boxShadow !== "none" || /gradient/.test(c.backgroundImage);
}).map((e) => e.id || e.className?.baseVal || e.className || e.tagName));
async function toggleTheme(page) {
  await page.locator("#theme-btn").click();
}

const fmt = {
  price: (v) => v == null ? "no data" : `${(v * 100).toFixed(1)}%`,
  volume: (v) => v == null ? "no data" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v)} contracts`,
  news: (v) => v == null ? "no data" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v)} stories`,
};
const COL = { price: "kalshi_price_close", volume: "kalshi_volume", news: NEWS };

const lines = (page) => page.$$eval("#chart svg path.line", (ps) => ps.map((p) => p.dataset.series).sort().join(","));
const axes = (page) => page.$$eval("#chart svg g[data-axis]", (gs) => gs.map((g) => g.dataset.axis).sort().join(","));
const readout = (page) => page.evaluate(() => ({
  date: document.querySelector("#readout .rdate")?.dataset.date ?? null,
  price: document.querySelector('#readout [data-v="price"]')?.textContent ?? null,
  volume: document.querySelector('#readout [data-v="volume"]')?.textContent ?? null,
  news: document.querySelector('#readout [data-v="news"]')?.textContent ?? null,
}));
const msg = (page) => page.locator("#range-msg").innerText();

/** Type a date into an input and fire change, the way a user commits a typed date. */
async function setDate(page, id, v) {
  await page.locator(id).evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event("change", { bubbles: true })); }, v);
}
/** The x axis tick labels, a cheap fingerprint of the dates in view. */
async function domain(page) {
  return page.$$eval("#chart svg .xaxis .tick text", (ts) => ts.map((t) => t.textContent).join(" "));
}

/** No race type switch and no scale switch in the chart section, and none of their old ids, names or labels on the
 * page. (The Race type choice in the Filters panel is the one way to pick a race type.) */
const noOldControls = (page) => page.evaluate(() => {
  const sec = document.querySelector("#racesec");
  const found = ["#race-type", "#race-switch", 'input[name="racetype"]', 'input[name$="-mode"]', ".scale-mode",
    ".series-toggles", "#tg-price", "#tg-volume", "#tg-news", '[data-mode]'].filter((q) => document.querySelector(q));
  const radios = sec.querySelectorAll("input[type=radio], input[type=checkbox], select").length;
  const text = sec.innerText;
  const words = ["Own scale", "Indexed", "Scale", "Senate or Governor", "Governor", "Race type"].filter((w) => text.includes(w));
  return { found, radios, words };
});
/** Legend geometry: each entry's box, the legend's overflow, the page overflow. */
const legendBox = (page) => page.evaluate(() => {
  const items = [...document.querySelectorAll("#legend .lg-item")].map((li) => {
    const r = li.getBoundingClientRect();
    return { k: li.dataset.key, top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  });
  const lg = document.querySelector("#legend");
  const chart = document.querySelector("#chart").getBoundingClientRect();
  return { items, lgOverflow: lg.scrollWidth - lg.clientWidth, pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vw: innerWidth, aboveChart: lg.getBoundingClientRect().bottom <= chart.top };
});
/** Swatch stroke vs line stroke for every series, as computed colors. */
const swatches = (page) => page.evaluate(() => ["price", "volume", "news"].map((k) => ({ k,
  swatch: getComputedStyle(document.querySelector(`#lg-${k} .swatch line`)).stroke,
  line: getComputedStyle(document.querySelector(`#chart path.line-${k}`)).stroke })));
/** The values a line actually plots, read back from its path: each point's x is inverted to a UTC day with the
 * svg's x domain and range, its y to a value with the path's y domain and range. */
const plotted = (page, k) => page.evaluate((key) => {
  const svg = document.querySelector("#chart svg.lc"), p = document.querySelector(`#chart path.line-${key}`);
  const [x0, x1] = svg.dataset.xdomain.split(",").map(Number), [r0, r1] = svg.dataset.xrange.split(",").map(Number);
  const [d0, d1] = p.dataset.domain.split(",").map(Number), [y0, y1] = p.dataset.range.split(",").map(Number);
  const pts = [...p.getAttribute("d").matchAll(/(-?[\d.]+(?:e-?\d+)?),(-?[\d.]+(?:e-?\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  // d3 writes path coordinates to 0.001 px, so a value is exact to 0.001 px in data units
  const out = { tol: (0.001 * Math.abs(d1 - d0)) / Math.abs(y1 - y0), at: {} };
  for (const [px, py] of pts) {
    const t = x0 + ((px - r0) / (r1 - r0)) * (x1 - x0);
    const day = new Date(Math.floor(t / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
    out.at[day] = d0 + ((py - y0) / (y1 - y0)) * (d1 - d0);
  }
  return out;
}, k);

// ---------------------------------------------------------------- 1280 desktop, Texas
{
  const { ctx, page } = await open(1280);
  // layout: the map section, then directly the chart section; hidden views are not on the page
  const order = await page.evaluate(() => {
    const m = document.querySelector("#mapsec"), c = document.querySelector("#racesec");
    return { next: m?.nextElementSibling?.id, below: c.getBoundingClientRect().top >= m.getBoundingClientRect().bottom,
      hidden: ["#race-tabs", "#charts", "#m3charts", "#daily-table", "#export-daily", "table.lag", "#f-from", "#f-overlay",
        "#f-office", "#f-band", "#f-group", "#f-metric", "#f-source", "#filter-hint", "#race-type", "#race-switch", "form#filters .fgrid"]
        .filter((s) => document.querySelector(s)) };
  });
  check("layout: chart section directly below the map section", JSON.stringify(order), "next racesec, below, no hidden views",
    order.next === "racesec" && order.below && order.hidden.length === 0);
  const race = await page.locator("#race").getAttribute("data-race");
  check("default race is Texas Senate", race, "tx-senate-2026", race === "tx-senate-2026");

  // map: every state with a race is drawn with its value; only Texas is a button (the rest are coming soon)
  const mapStates = await page.$$eval("svg.usmap path[data-race]", (ps) => ps.map((p) => p.getAttribute("data-state")).sort());
  const idxStates = [...new Set(Object.values(index.races).filter((r) => r.office === "senate").map((r) => r.state))].sort();
  check("map: every state with a Senate race carries its race", mapStates.join(","), idxStates.join(","),
    JSON.stringify(mapStates) === JSON.stringify(idxStates));
  const buttons = await page.$$eval('svg.usmap path[role="button"]', (ps) => ps.map((p) => `${p.dataset.state}:${p.tabIndex}`));
  const greyed = await page.$$eval("svg.usmap path.st.greyed", (ps) => ps.length);
  const greyFocus = await page.$$eval("svg.usmap path.st.greyed", (ps) => ps.filter((p) => p.tabIndex >= 0 || p.getAttribute("role") === "button").length);
  const opacity = await page.$eval('svg.usmap path[data-state="FL"]', (p) => getComputedStyle(p).opacity);
  check("map: only Texas is a button; every other state is faded and takes no focus", `${buttons.join(",")}; ${greyed} greyed, ${greyFocus} focusable, FL opacity ${opacity}`,
    "TX:0; 50 greyed, 0 focusable, opacity < 1", buttons.join(",") === "TX:0" && greyed >= 50 && greyFocus === 0 && Number(opacity) < 1);
  const txVol = index.races["tx-senate-2026"].display.kalshi_volume;
  const txRow = (await page.locator('#map-table tr[data-race="tx-senate-2026"] td[data-k="value"]').textContent()).replace(/\s+/g, " ").trim();
  const txLabel = await page.$eval('svg.usmap path[data-state="TX"]', (p) => `${p.getAttribute("aria-label")} | title ${p.querySelector("title")?.textContent}`);
  check("map default metric: TX Kalshi volume with n in the table, the aria-label and the title",
    `${txRow} | ${txLabel}`, `43M contracts (n=${txVol.n_days} days)`,
    txRow === `43M contracts (n=${txVol.n_days} days)` && txLabel.includes(`43M contracts (n=${txVol.n_days} days)`)
      && txLabel.includes("title Texas: 43M contracts"));
  const flLabel = await page.$eval('svg.usmap path[data-state="FL"]', (p) => p.getAttribute("aria-label"));
  check("greyed state with a race keeps its value as text and says coming soon", flLabel, "Florida: ... contracts (n=92 days), coming soon",
    /^Florida: .* contracts \(n=\d+ days\), coming soon$/.test(flLabel));
  const noData = await page.$eval('svg.usmap path[data-state="AL"]', (p) => p.style.fill);
  check("map: states with no race are drawn as no data", noData, "var(--rule)", noData === "var(--rule)");
  // a click on a greyed state does nothing
  await page.locator('svg.usmap path[data-state="FL"]').click({ force: true });
  await page.waitForTimeout(200);
  check("click on a greyed state (Florida) does not open its race", await page.locator("#race").getAttribute("data-race"), "tx-senate-2026",
    await page.locator("#race").getAttribute("data-race") === "tx-senate-2026");

  // ---- the Filters panel
  const fb = page.locator("#filters-btn");
  const geo = await page.evaluate(() => {
    const h = document.querySelector("#map-h").getBoundingClientRect(), b = document.querySelector("#filters-btn").getBoundingClientRect();
    return { sameRow: b.top < h.bottom && b.bottom > h.top, right: b.left > h.right };
  });
  check("Filters button sits right of the map heading, same row", JSON.stringify(geo), "same row, right", geo.sameRow && geo.right);
  const attrs = `${await fb.getAttribute("aria-expanded")} ${await fb.getAttribute("aria-controls")} ${await page.locator("#filters-panel").isVisible()}`;
  check("Filters button: aria-expanded false, aria-controls the panel, panel closed", attrs, "false filters-panel false", attrs === "false filters-panel false");
  check("no count badge in the default view", await page.locator("#filters-badge").isVisible(), "false", !(await page.locator("#filters-badge").isVisible()));
  await page.mouse.move(0, 0);
  await page.locator("#mapsec").scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(SHOTS, "filt-closed-1280.png") });
  await fb.click();
  const opened = `${await fb.getAttribute("aria-expanded")} ${await page.locator("#filters-panel").isVisible()}`;
  check("click opens the panel", opened, "true true", opened === "true true");
  const controls = await page.$$eval("#filters-panel [data-control]", (cs) => cs.map((c) => c.dataset.control).join(","));
  check("panel has exactly five controls", controls, "state,type,metric,polls,source", controls === "state,type,metric,polls,source");
  const stateOpts = await page.$$eval("#f-state option", (os) => ({ n: os.length, enabled: os.filter((o) => !o.disabled).map((o) => o.value),
    ariaOff: os.filter((o) => o.disabled && o.getAttribute("aria-disabled") === "true" && o.title === "Coming soon").length,
    value: document.querySelector("#f-state").value }));
  check("State: 50 states, only Texas enabled (others disabled, aria-disabled, title Coming soon), Texas selected",
    JSON.stringify(stateOpts), "50, [TX], 49, TX", stateOpts.n === 50 && stateOpts.enabled.join() === "TX" && stateOpts.ariaOff === 49 && stateOpts.value === "TX");
  const types = await page.$$eval('input[name="f-type"]', (is) => is.map((i) => `${i.value}:${i.checked ? "on" : ""}${i.disabled ? "off" : ""}${
    i.getAttribute("aria-disabled") === "true" && i.title === "Coming soon" ? "-soon" : ""}`).join(","));
  check("Race type: Senate checked and active; Governor, House, National disabled and coming soon", types,
    "senate:on,governor:off-soon,house:off-soon,national:off-soon", types === "senate:on,governor:off-soon,house:off-soon,national:off-soon");
  const soonOpacity = await page.$eval('input[name="f-type"][value="governor"]', (i) => getComputedStyle(i.closest("label")).opacity);
  check("disabled race types are visibly greyed", soonOpacity, "< 1", Number(soonOpacity) < 1);
  const radios = await page.$$eval('#filters-panel fieldset', (fs) => fs.map((f) => `${f.dataset.control}:${f.querySelector("legend")?.textContent}:${
    [...f.querySelectorAll("input")].map((i) => i.value).join("/")}`).join(" | "));
  check("radio groups with fieldset and legend", radios,
    "type:Race type:senate/governor/house/national | metric:Map metric:volume/attention | polls:Polling:all/few/many | source:Sources:news/wikipedia",
    radios === "type:Race type:senate/governor/house/national | metric:Map metric:volume/attention | polls:Polling:all/few/many | source:Sources:news/wikipedia");
  const srcNote = await page.locator('#filters-panel [data-control="source"] .hint').innerText();
  check("Sources: muted note", srcNote, "More sources in development.", srcNote === "More sources in development.");
  await page.screenshot({ path: resolve(SHOTS, "filt-open-1280.png") });
  await axe(page, "1280 filters open");
  // map metric Attention with News: Texas shows stories; every other state has no news (no data)
  await page.locator('#filters-panel label:has(input[name="f-metric"][value="attention"])').click();
  const attRow = (await page.locator('#map-table tr[data-race="tx-senate-2026"] td[data-k="value"]').textContent()).replace(/\s+/g, " ").trim();
  const txNews = index.races["tx-senate-2026"].display["news/race_either/national"];
  const flAtt = await page.$eval('svg.usmap path[data-state="FL"]', (p) => `${p.style.fill} ${p.getAttribute("aria-label")}`);
  check("Attention (News): TX stories with n; Florida has no news (no data)", `${attRow} | ${flAtt}`,
    `6.66k stories (n=${txNews.n_days} days) | var(--rule) Florida: no news data, coming soon`,
    attRow === `6.66k stories (n=${txNews.n_days} days)` && flAtt === "var(--rule) Florida: no news data, coming soon");
  // polling Few: Texas (53 polls) is outside and greyed with the filtered pattern; Kentucky (1 poll) stays in
  await page.locator('#filters-panel label:has(input[name="f-polls"][value="few"])').click();
  const pf = await page.evaluate(() => ({ tx: document.querySelector('svg.usmap path[data-state="TX"]').getAttribute("fill"),
    ky: document.querySelector('svg.usmap path[data-state="KY"]').getAttribute("fill") }));
  check("Polling Few: TX outside (dots), KY inside", JSON.stringify(pf), "TX url(#dots-filtered), KY not",
    pf.tx === "url(#dots-filtered)" && pf.ky !== "url(#dots-filtered)");
  const badge = (await page.locator("#filters-badge").innerText()).trim();
  const hash = await page.evaluate(() => location.hash);
  check("badge counts two changed controls; hash holds them", `${badge} | ${hash}`, "2 changed | #metric=attention&polls=few",
    /^2\s*changed$/.test(badge) && hash === "#metric=attention&polls=few");
  // Esc closes and returns focus to the button
  await page.locator('#filters-panel input[name="f-polls"][value="few"]').focus();
  await page.keyboard.press("Escape");
  const esc = `${await page.locator("#filters-panel").isVisible()} ${await fb.getAttribute("aria-expanded")} ${await page.evaluate(() => document.activeElement?.id)}`;
  check("Esc closes the panel and focus returns to the button", esc, "false false filters-btn", esc === "false false filters-btn");
  // keyboard: Enter opens, focus moves into the panel; Tab reaches the controls
  await page.keyboard.press("Enter");
  const inPanel = await page.evaluate(() => document.querySelector("#filters-panel").contains(document.activeElement) && document.activeElement.id);
  check("keyboard: Enter on the button opens the panel and focuses the first control", inPanel, "f-state", inPanel === "f-state");
  // a click outside closes
  await page.mouse.click(5, 5);
  check("click outside closes the panel", await page.locator("#filters-panel").isVisible(), "false", !(await page.locator("#filters-panel").isVisible()));
  // Reset restores the defaults
  await fb.click();
  await page.locator("#f-reset").click();
  const afterReset = `${await page.evaluate(() => location.hash)}|${await page.locator("#filters-badge").isVisible()}|${
    await page.$eval('input[name="f-metric"]:checked', (i) => i.value)}|${await page.$eval('input[name="f-polls"]:checked', (i) => i.value)}`;
  check("Reset: defaults, empty hash, no badge", afterReset, "|false|volume|all", afterReset === "|false|volume|all");
  // Sources: Wikipedia switches the chart's attention line
  await page.locator('#filters-panel label:has(input[name="f-source"][value="wikipedia"])').click();
  await page.waitForFunction(() => document.querySelector("#news-status")?.textContent.startsWith("Wikipedia"));
  const wst = (await page.locator("#news-status").innerText()).trim();
  const wdd = tx.series.display_daily;
  const wn = wdd.rows.filter((r) => r.wikipedia_pageviews_total != null).length;
  const wlabel = (await page.locator("#lg-news").textContent()).replace(/\s+/g, " ").trim();
  check("Sources Wikipedia: chart plots Wikipedia pageviews", `${wst} | ${wlabel} | lines ${await lines(page)}`,
    `Wikipedia pageviews: ${wn} of ${wdd.rows.length} days`, wst === `Wikipedia pageviews: ${wn} of ${wdd.rows.length} days`
      && wlabel === "Attention: Wikipedia pageviews per day (race and candidate pages)" && await lines(page) === "news,price,volume");
  await page.locator("#chart").focus();
  await page.keyboard.press("Home");
  const wr = await readout(page);
  const w0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(wdd.rows[0].wikipedia_pageviews_total);
  check("Wikipedia readout matches the JSON on the first day", wr.news, `${w0} pageviews`, wr.news === `${w0} pageviews`);
  await page.locator("#chart").blur();
  check("hash after Sources Wikipedia", await page.evaluate(() => location.hash), "#source=wikipedia",
    await page.evaluate(() => location.hash) === "#source=wikipedia");
  await page.keyboard.press("Escape");
  await fb.click();
  await page.locator('#filters-panel label:has(input[name="f-source"][value="news"])').click();
  await page.waitForFunction(() => document.querySelector("#news-status")?.textContent.startsWith("News data"));
  await page.keyboard.press("Escape");

  // status line
  const dd = tx.series.display_daily;
  const n = dd.rows.filter((r) => r[NEWS] != null).length;
  const status = (await page.locator("#news-status").innerText()).trim();
  check("status line: live news N of M days", status, `News data: live, ${n} of ${dd.rows.length} days`,
    status === `News data: live, ${n} of ${dd.rows.length} days`);
  // the explanatory copy removed in R1 (docs/dashboard-copy-removed.md) is not on the page; the map table stays as a
  // visually hidden text alternative for the map
  const REMOVED = ["on one UTC clock", "races with committed data", "Colored by", "The map's values as a table",
    "have no processed race for this race type", "(working name)", "Source terms", "Map geometry: us-atlas",
    "News counts come from Media Cloud sources only", "Only counts and metrics are published"];
  const bodyText = await page.evaluate(() => document.body.innerText);
  const found = REMOVED.filter((t) => bodyText.includes(t));
  check("removed copy is not on the page", found.join(" | ") || "none", "none", found.length === 0);
  // the table sits in a 1x1 px clipped wrapper (sr-only), not hidden or scaled, so screen readers still read it
  const wrap = await page.$eval("#map-table-wrap", (e) => {
    const b = e.getBoundingClientRect();
    return { w: b.width, h: b.height, overflow: getComputedStyle(e).overflow };
  });
  const tableRows = await page.locator("#map-table tbody tr").count();
  const tableAria = await page.locator("#map-table-wrap").ariaSnapshot();
  const tableNamed = /table "Map values by state"/.test(tableAria);
  const tableFocus = await page.$$eval("#map-table-wrap :is(a[href], button, input, select, textarea, [tabindex], [contenteditable=''], [contenteditable='true'])",
    (es) => es.filter((e) => e.tabIndex >= 0 && !e.disabled).length);
  check("map table is clipped to 1x1 px, has rows, is in the accessibility tree, and takes no focus",
    `wrapper ${wrap.w}x${wrap.h} overflow ${wrap.overflow}; ${tableRows} rows; named table ${tableNamed}; ${tableFocus} focusable`,
    `wrapper <=1x1 overflow hidden; ${Object.keys(index.races).length} rows; named table true; 0 focusable`,
    wrap.w <= 1 && wrap.h <= 1 && wrap.overflow === "hidden" && tableRows === Object.keys(index.races).length
      && tableNamed && tableFocus === 0);
  const footers = await page.locator("footer").count();
  check("no footer while the funding disclosure is off", footers, "0", footers === 0);
  const elabel = await page.locator('#chart g[data-mark="election"] text').textContent();
  check("election days shaded and labeled", elabel, "Election, Nov 3 and 4", elabel === "Election, Nov 3 and 4"
    && await page.locator('#chart g[data-mark="election"] rect').count() === 1);
  check("three lines and three axes by default", `${await lines(page)} | ${await axes(page)}`, "news,price,volume twice",
    await lines(page) === "news,price,volume" && await axes(page) === "news,price,volume");
  const old = await noOldControls(page);
  check("no race type switch and no scale switch in the chart area (no radios, checkboxes or selects, no such labels)",
    JSON.stringify(old), '{"found":[],"radios":0,"words":[]}', old.found.length === 0 && old.radios === 0 && old.words.length === 0);

  // legend: one entry per line, one row above the chart, the texts, real buttons with aria-pressed
  const lt = await page.$$eval("#legend .lg-btn", (bs) => bs.map((b) => `${b.tagName}|${b.type}|${b.getAttribute("aria-pressed")}|${
    b.textContent.replace(/\s+/g, " ").trim()}`));
  const wantLt = ["BUTTON|button|true|Price: Kalshi chance that Democrats win (%)", "BUTTON|button|true|Volume: contracts traded per day",
    "BUTTON|button|true|Attention: news stories per day mentioning the race (Media Cloud)"];
  check("legend: three button entries, pressed, with name and description", lt.join(" / "), wantLt.join(" / "),
    JSON.stringify(lt) === JSON.stringify(wantLt));
  const lb = await legendBox(page);
  const oneRow = lb.items.length === 3 && lb.items.every((i) => Math.abs(i.top - lb.items[0].top) <= 2)
    && lb.items[0].right <= lb.items[1].left && lb.items[1].right <= lb.items[2].left;
  check("1280: legend entries share one row, above the chart, no overflow", JSON.stringify(lb), "same top, left to right, above chart",
    oneRow && lb.aboveChart && lb.lgOverflow <= 0 && lb.pageOverflow <= 0);
  const sw = await swatches(page);
  check("light: each legend swatch has its line's stroke color", JSON.stringify(sw), "swatch == line, the light tokens",
    sw.every((x) => x.swatch === x.line && x.line === THEME.light[x.k]));
  // the why? note: a separate button with aria-expanded and aria-controls, opened and closed by keyboard
  const why = page.locator("#lg-why");
  const whyAttrs = await why.evaluate((b) => `${b.tagName} ${b.closest(".lg-btn") ? "nested" : "separate"} ${b.getAttribute("aria-expanded")} ${
    b.getAttribute("aria-controls")} ${document.querySelector("#lg-note").hidden}`);
  check("why? is a separate button, aria-expanded false, controls the hidden note", whyAttrs, "BUTTON separate false lg-note true",
    whyAttrs === "BUTTON separate false lg-note true");
  await why.focus();
  await page.keyboard.press("Enter");
  const nEnter = `${await why.getAttribute("aria-expanded")} ${await page.locator("#lg-note").isVisible()} ${(await page.locator("#lg-note").innerText()).trim()}`;
  await page.keyboard.press("Space");
  const nSpace = `${await why.getAttribute("aria-expanded")} ${await page.locator("#lg-note").isVisible()}`;
  await page.keyboard.press("Space");
  const nSpace2 = `${await why.getAttribute("aria-expanded")} ${await page.locator("#lg-note").isVisible()}`;
  const NOTE = "The Republican contract is the mirror image: its price is about 100% minus this line.";
  check("why? opens with Enter, closes and opens with Space; the note text", `${nEnter} | ${nSpace} | ${nSpace2}`,
    `true true ${NOTE} | false false | true true`, nEnter === `true true ${NOTE}` && nSpace === "false false" && nSpace2 === "true true");
  check("no Republican line is drawn", await lines(page), "news,price,volume", await lines(page) === "news,price,volume");
  await axe(page, "1280 legend and note open");
  await page.mouse.move(0, 0);
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "chart-1280-light.png") });

  // plotted values: each line's path coordinates, read back to values, against the JSON on three days
  for (const k of ["price", "volume", "news"]) {
    const got = await plotted(page, k);
    for (const d of ["2026-08-05", "2026-09-15", "2026-11-03"]) {
      const raw = dd.rows.find((r) => r.date === d)[COL[k]];
      const exp = raw == null ? null : k === "price" ? raw * 100 : raw;
      const v = got.at[d] ?? null;
      const ok = exp === null ? v === null : v !== null && Math.abs(v - exp) <= got.tol + 1e-9 * Math.abs(exp);
      report.plotted.push({ date: d, series: k, plotted: v, json: raw, tol: got.tol, ok });
      if (!ok) failed = true;
    }
  }

  // spot check: readout text against the processed JSON, by keyboard (focus the chart, Home, arrows)
  await page.locator("#chart").focus();
  const dates = dd.rows.map((r) => r.date);
  const want = ["2026-08-05", "2026-09-15", "2026-11-03"];
  await page.keyboard.press("Home");
  let at = 0;
  for (const d of want) {
    const target = dates.indexOf(d);
    while (at < target) { await page.keyboard.press("ArrowRight"); at++; }
    const r = await readout(page);
    const row = dd.rows[target];
    for (const k of ["price", "volume", "news"]) {
      const exp = fmt[k](row[COL[k]]);
      report.spot.push({ date: d, series: k, readout: r[k], json: row[COL[k]], expected_text: exp, ok: r.date === d && r[k] === exp });
      if (!(r.date === d && r[k] === exp)) failed = true;
    }
  }
  check("keyboard: arrow keys move the cursor day", (await readout(page)).date, "2026-11-03", (await readout(page)).date === "2026-11-03");
  // pointer: hovering the middle of the plot shows the same values as the JSON for that day
  await page.locator("#chart").scrollIntoViewIfNeeded();
  const box = await page.locator("#chart svg rect.hit").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const hr = await readout(page);
  const hrow = dd.rows.find((r) => r.date === hr.date);
  const tip = await page.locator("#chart .tip").innerText();
  check("hover: readout and tooltip show the day's values", `${hr.date} ${hr.price} ${hr.volume} ${hr.news} | tip ${tip.replace(/\s+/g, " ")}`,
    hrow ? `${fmt.price(hrow.kalshi_price_close)} ${fmt.volume(hrow.kalshi_volume)} ${fmt.news(hrow[NEWS])}` : "a date",
    hrow && hr.price === fmt.price(hrow.kalshi_price_close) && hr.volume === fmt.volume(hrow.kalshi_volume)
      && hr.news === fmt.news(hrow[NEWS]) && tip.includes(hr.price));
  const live = await page.locator("#readout").getAttribute("aria-live");
  check("readout row is aria-live polite", live, "polite", live === "polite");

  // legend entries are the toggles: a click switches the line and its axis; the last line stays on
  const pressed = (k) => page.locator(`#lg-${k}`).getAttribute("aria-pressed");
  await page.locator("#lg-volume").click();
  check("legend: Volume off: line and axis gone, aria-pressed false", `${await lines(page)} | ${await axes(page)} | ${await pressed("volume")}`,
    "news,price | news,price | false", await lines(page) === "news,price" && await axes(page) === "news,price" && await pressed("volume") === "false");
  await page.locator("#lg-volume").click();
  check("legend: Volume on: line and axis back", `${await lines(page)} | ${await axes(page)} | ${await pressed("volume")}`, "news,price,volume | true",
    await lines(page) === "news,price,volume" && await axes(page) === "news,price,volume" && await pressed("volume") === "true");
  await page.locator("#lg-price").click();
  check("legend: Price off: left axis gone", `${await lines(page)} | ${await axes(page)}`, "news,volume",
    await lines(page) === "news,volume" && await axes(page) === "news,volume");
  // keyboard: Enter and Space on a focused entry
  await page.locator("#lg-news").focus();
  await page.keyboard.press("Enter");
  const lastLocked = await page.locator("#lg-volume").getAttribute("aria-disabled");
  await page.locator("#lg-volume").focus();
  await page.keyboard.press("Space");
  await page.locator("#lg-volume").click({ force: true });  // aria-disabled: Playwright would wait for it to be enabled
  const note = await page.locator("#tg-note").innerText();
  check("last visible line cannot be switched off (aria-disabled, still pressed, line drawn, note)",
    `aria-disabled ${lastLocked}; pressed ${await pressed("volume")}; lines ${await lines(page)}; note "${note}"`,
    "true, true, volume, note", lastLocked === "true" && await pressed("volume") === "true" && await lines(page) === "volume"
      && note.includes("cannot be switched off"));
  await page.locator("#lg-price").click();
  await page.locator("#lg-news").click();
  check("all three lines back; nothing locked", `${await lines(page)} | ${await page.locator('.lg-btn[aria-disabled="true"]').count()} locked`,
    "news,price,volume | 0 locked", await lines(page) === "news,price,volume" && await page.locator('.lg-btn[aria-disabled="true"]').count() === 0);

  // date range: inputs carry min and max; out-of-range and start-after-end are rejected with a visible message
  const mm = await page.$eval("#d-from", (i) => `${i.min}..${i.max}`);
  check("date inputs limited to the display window", mm, `${dd.window.start}..${dd.window.end}`, mm === "2026-08-05..2026-11-04");
  const full = await domain(page);
  await setDate(page, "#d-from", "2026-08-04");
  const m1 = await msg(page);
  check("start before 2026-08-05 is rejected", `${m1} | from=${await page.inputValue("#d-from")}`, "message, from stays 2026-08-05",
    m1.includes("before 2026-08-05") && await page.inputValue("#d-from") === "2026-08-05" && await domain(page) === full);
  await setDate(page, "#d-to", "2026-11-05");
  const m2 = await msg(page);
  check("end after 2026-11-04 is rejected", `${m2} | to=${await page.inputValue("#d-to")}`, "message, to stays 2026-11-04",
    m2.includes("after 2026-11-04") && await page.inputValue("#d-to") === "2026-11-04" && await domain(page) === full);
  await setDate(page, "#d-from", "2026-10-10");
  await setDate(page, "#d-to", "2026-10-01");
  const m3 = await msg(page);
  check("start after end is rejected", m3, "Start date ... is after end date", m3.includes("after end date"));
  await setDate(page, "#d-to", "2026-10-20");
  const narrowed = await domain(page);
  await page.locator("#chart").focus();
  await page.keyboard.press("End");
  const endDay = (await readout(page)).date;
  await page.keyboard.press("Home");
  const startDay = (await readout(page)).date;
  check("valid range narrows the chart and the cursor stays inside it", `${startDay}..${endDay}; ticks ${narrowed}`,
    "2026-10-10..2026-10-20", startDay === "2026-10-10" && endDay === "2026-10-20" && narrowed !== full && (await msg(page)) === "");
  await page.locator("#d-reset").click();
  check("Reset restores the full range", `${await page.inputValue("#d-from")}..${await page.inputValue("#d-to")}`, "2026-08-05..2026-11-04",
    await page.inputValue("#d-from") === "2026-08-05" && await page.inputValue("#d-to") === "2026-11-04" && await domain(page) === full);
  // brush: drag across the strip picks a range
  await page.locator(".brushbox").scrollIntoViewIfNeeded();
  const bb = await page.locator(".brushbox svg rect.overlay").boundingBox();
  await page.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width * 0.6, bb.y + bb.height / 2, { steps: 5 });
  await page.mouse.up();
  const bf = await page.inputValue("#d-from"), bt = await page.inputValue("#d-to");
  check("brush drag sets both dates inside the window", `${bf}..${bt}`, "a range strictly inside", bf > "2026-08-05" && bt < "2026-11-04" && bf < bt);
  await page.locator("#d-reset").click();

  await page.locator("#chart").blur();
  await page.mouse.move(0, 0);
  // light theme (the context prefers light and nothing is saved yet)
  const light = await drawn(page);
  check("light theme by default: page, chart lines and map outline use the light tokens", JSON.stringify(light), JSON.stringify(THEME.light),
    themeOk(light, "light") && light.stored === null);
  const deco = await decorated(page);
  check("light: no element has a box shadow or a gradient", deco.join(", ") || "none", "none", deco.length === 0);
  await page.screenshot({ path: resolve(SHOTS, "style-light-1280.png"), fullPage: true });
  await axe(page, "1280 Texas light");
  // switch to dark: html[data-theme] flips, the choice is saved, colors follow without a reload
  const name = await page.locator("#theme-btn").evaluate((b) => `${b.textContent} / ${b.getAttribute("aria-label")}`);
  await toggleTheme(page);
  const dark = await drawn(page);
  check("theme toggle: data-theme dark, saved, aria-pressed true, chart and map recolored", `${name}; ${JSON.stringify(dark)}`,
    JSON.stringify(THEME.dark), themeOk(dark, "dark") && dark.stored === "dark");
  const decoDark = await decorated(page);
  check("dark: no element has a box shadow or a gradient", decoDark.join(", ") || "none", "none", decoDark.length === 0);
  const swd = await swatches(page);
  check("dark: each legend swatch has its line's stroke color", JSON.stringify(swd), "swatch == line, the dark tokens",
    swd.every((x) => x.swatch === x.line && x.line === THEME.dark[x.k]));
  await page.locator("#theme-btn").blur();
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "chart-1280-dark.png") });
  await page.screenshot({ path: resolve(SHOTS, "style-dark-1280.png"), fullPage: true });
  await axe(page, "1280 Texas dark");
  // the saved choice wins on reload, and is in place before the app script runs
  await page.reload({ waitUntil: "domcontentloaded" });
  const early = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.waitForSelector("body[data-ready=true]");
  await page.waitForSelector("#chart svg path.line");
  const reloaded = await drawn(page);
  check("reload keeps the saved dark theme (set in <head>, before the app)", `${early}; ${JSON.stringify(reloaded)}`, "dark",
    early === "dark" && themeOk(reloaded, "dark"));
  await toggleTheme(page);
  const back = await drawn(page);
  check("toggle again: back to light and saved", JSON.stringify(back), "light", themeOk(back, "light") && back.stored === "light");

  // another race by URL (?race=); no news: one short line, toggle off and disabled, gaps kept
  if (noNews) {
    const id = noNews.race.race_id;
    await page.goto(`${BASE}?race=${id}`, { waitUntil: "networkidle" });
    await page.waitForFunction((rid) => document.querySelector("#race")?.getAttribute("data-race") === rid, id);
    await page.waitForSelector("#chart svg path.line");
    const st = (await page.locator("#news-status").innerText()).trim();
    const nd = await page.locator("#lg-news").getAttribute("aria-disabled") === "true", nc = await pressed("news") === "true";
    await page.locator("#lg-news").click({ force: true });
    const legNews = (await page.locator("#lg-news").textContent()).replace(/\s+/g, " ").trim();
    check(`?race=${id}: no news: status line, Attention entry off and disabled (a click does nothing), price and volume drawn`,
      `${st} | disabled ${nd} pressed ${nc} | ${legNews} | lines ${await lines(page)}`, "No news data for this race yet.",
      st === "No news data for this race yet." && nd && !nc && legNews.includes("(no news data for this race yet)")
        && await lines(page) === "price,volume");
    const miss = noNews.series.display_daily.coverage.kalshi_price_close.missing_days;
    const segs = await page.$eval("#chart svg path.line-price", (p) => (p.getAttribute("d").match(/M/g) || []).length);
    check(`${id}: missing Kalshi days break the price line (not drawn as zero)`, `${segs} segment(s); missing ${miss.join(", ")}`,
      "more than one segment when a missing day is inside the window", miss.length === 0 || segs > 1);
    await axe(page, `1280 ${id}`);
    await page.locator('svg.usmap path[data-state="TX"]').click();
    await page.waitForFunction(() => document.querySelector("#race")?.getAttribute("data-race")?.startsWith("tx-"));
    check("Texas on the map opens Texas Senate; Attention entry on again", `${await page.locator("#race").getAttribute("data-race")} ${await pressed("news")} ${await lines(page)}`,
      "tx-senate-2026 true news,price,volume", await page.locator("#race").getAttribute("data-race") === "tx-senate-2026"
        && await pressed("news") === "true" && await lines(page) === "news,price,volume");
  }
  // the hash on load: known values apply, unknown or disabled values fall back to the default
  await page.goto(`${BASE}#state=FL&type=governor&metric=attention&polls=many&source=bluesky`, { waitUntil: "networkidle" });
  await page.waitForSelector("body[data-ready=true]");
  const fromHash = await page.evaluate(() => ({ state: document.querySelector("#f-state").value,
    type: document.querySelector('input[name="f-type"]:checked').value, metric: document.querySelector('input[name="f-metric"]:checked').value,
    polls: document.querySelector('input[name="f-polls"]:checked').value, source: document.querySelector('input[name="f-source"]:checked').value,
    badge: document.querySelector("#filters-badge").textContent, race: document.querySelector("#race").dataset.race }));
  check("hash on load: FL, governor and bluesky rejected; attention and many kept; Texas Senate open",
    JSON.stringify(fromHash), "TX senate attention many news, badge 2", fromHash.state === "TX" && fromHash.type === "senate"
      && fromHash.metric === "attention" && fromHash.polls === "many" && fromHash.source === "news"
      && fromHash.badge.startsWith("2") && fromHash.race === "tx-senate-2026");
  await ctx.close();
}

// ---------------------------------------------------------------- system setting fallback
{
  const { ctx, page } = await open(1280, `${BASE}?race=tx-senate-2026`, false, "dark");
  const d = await drawn(page);
  check("no saved choice and the system prefers dark: dark theme", JSON.stringify(d), "dark", themeOk(d, "dark") && d.stored === null);
  await ctx.close();
}

// ---------------------------------------------------------------- 390 phone (touch)
{
  const { ctx, page } = await open(390, `${BASE}?race=tx-senate-2026`, true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal page scroll at 390 px", overflow, "0", overflow <= 0);
  const lb = await legendBox(page);
  const rows = new Set(lb.items.map((i) => i.top)).size;
  check("390: legend wraps (entries on more than one row), every entry inside the viewport, no overflow", JSON.stringify(lb),
    "rows > 1, right <= 390, overflow 0", rows > 1 && lb.items.every((i) => i.left >= 0 && i.right <= lb.vw) && lb.lgOverflow <= 0
      && lb.pageOverflow <= 0);
  await page.locator("#lg-why").tap();
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "chart-390-light.png") });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(SHOTS, "filt-closed-390.png") });
  await page.locator("#filters-btn").tap();
  const sheet = await page.$eval("#filters-panel", (p) => { const r = p.getBoundingClientRect(); return { pos: getComputedStyle(p).position,
    left: r.left, right: innerWidth - r.right, bottom: Math.round(innerHeight - r.bottom), h: r.height }; });
  check("390: the panel is a bottom sheet (fixed, full width, on the bottom edge)", JSON.stringify(sheet), "fixed 0 0 0",
    sheet.pos === "fixed" && sheet.left === 0 && sheet.right === 0 && sheet.bottom === 0 && sheet.h < 900);
  await page.screenshot({ path: resolve(SHOTS, "filt-open-390.png") });
  await axe(page, "390 filters open");
  const targets = "#theme-btn, #racesec .lg-btn, #lg-why, #racesec input[type=date], #d-reset, #chart, #racesec .brushbox svg, #filters-btn, #filters-panel label.tg, #filters-panel select, #f-reset, #f-close";
  const nTargets = await page.locator(targets).count();
  const small = await page.evaluate((sel) => [...document.querySelectorAll(sel)]
    .map((e) => { const r = e.getBoundingClientRect(); return { e: e.id || e.className?.baseVal || e.className || e.tagName, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((r) => r.w < 44 || r.h < 44), targets);
  check(`touch targets at least 44 px (theme, legend entries, why?, dates, Reset, chart, brush, Filters button and panel; ${nTargets} checked)`,
    JSON.stringify(small), "none smaller", small.length === 0 && nTargets >= 23);
  await page.touchscreen.tap(195, 40);
  check("390: a tap outside the sheet closes it", await page.locator("#filters-panel").isVisible(), "false",
    !(await page.locator("#filters-panel").isVisible()));
  await page.locator("#chart").scrollIntoViewIfNeeded();
  const box = await page.locator("#chart svg rect.hit").boundingBox();
  await page.touchscreen.tap(box.x + box.width * 0.25, box.y + box.height / 2);
  const r = await readout(page);
  check("tap on the chart fills the readout row", JSON.stringify(r), "date and three values", r.date && r.price && r.volume && r.news);
  const deco = await decorated(page);
  check("390 light: no box shadow or gradient", deco.join(", ") || "none", "none", deco.length === 0);
  await page.screenshot({ path: resolve(SHOTS, "style-light-390.png"), fullPage: true });
  await axe(page, "390 Texas light");
  await page.locator("#theme-btn").tap();
  const dark = await drawn(page);
  check("390: tap the theme toggle: dark and saved", JSON.stringify(dark), "dark", themeOk(dark, "dark") && dark.stored === "dark");
  const decoDark = await decorated(page);
  check("390 dark: no box shadow or gradient", decoDark.join(", ") || "none", "none", decoDark.length === 0);
  const overflowDark = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("390 dark: no horizontal page scroll", overflowDark, "0", overflowDark <= 0);
  const sw390 = await swatches(page);
  check("390 dark: swatches match the lines", JSON.stringify(sw390), "swatch == line", sw390.every((x) => x.swatch === x.line && x.line === THEME.dark[x.k]));
  await page.locator("#theme-btn").blur();
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "chart-390-dark.png") });
  await page.screenshot({ path: resolve(SHOTS, "style-dark-390.png"), fullPage: true });
  await axe(page, "390 Texas dark");
  await ctx.close();
}

// ---------------------------------------------------------------- demo
if (DEMO) {
  const { ctx, page } = await open(1280, `${DEMO}?race=tx-senate-2026&demo=1`);
  const label = (await page.locator("#demo-label").innerText().catch(() => "")).trim();
  const st = (await page.locator("#news-status").innerText()).trim();
  check("--demo: chart shows a visible Demo data label and the status says demo", `${label} | ${st}`, "Demo data",
    label === "Demo data" && await page.locator("#demo-label").isVisible() && st.includes("demo"));
  await axe(page, "1280 demo");
  await ctx.close();
}

await browser.close();
if (report.blocked.length || report.consoleErrors.length || report.pageErrors.length) failed = true;
if (Object.values(report.axe).some((v) => v.length)) failed = true;
console.log(JSON.stringify(report, null, 1));
console.log("\nSpot check (readout text vs data/processed/tx-senate-2026.json, series.display_daily):");
console.log("| date | series | readout | JSON value | ok |\n|---|---|---|---|---|");
for (const s of report.spot) console.log(`| ${s.date} | ${s.series} | ${s.readout} | ${s.json} | ${s.ok ? "yes" : "NO"} |`);
console.log("\nPlotted values (line path coordinates read back to values) vs data/processed/tx-senate-2026.json (price x100):");
console.log("| date | series | plotted | JSON value | tolerance (0.001 px) | ok |\n|---|---|---|---|---|---|");
for (const s of report.plotted) console.log(`| ${s.date} | ${s.series} | ${s.plotted} | ${s.json} | ${s.tol.toPrecision(3)} | ${s.ok ? "yes" : "NO"} |`);
if (report.plotted.length !== 9) { console.log("expected 9 plotted spot checks"); failed = true; }
console.log(failed ? "VERIFY FAILED" : "VERIFY OK");
process.exit(failed ? 1 : 0);
