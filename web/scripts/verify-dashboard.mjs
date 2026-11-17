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
// F3, hourly zoom: the "Kalshi: hourly / daily" label and the per day / per hour texts at the 14 / 15 day edge,
// via the date inputs and the quick range buttons (keyboard too), about 24 points per day when hourly, hourly
// price and volume against series.display_hourly, day totals against series.display_daily, the attention step
// line (changes only at 00:00 UTC) and its note, the "no trades" readout of a filled hour, election shading,
// ctrl + wheel and two finger pinch zoom (a plain wheel still scrolls the page), a hover frame check at 390 px,
// and axe in hourly view.
// G1: the title and subtitle, the map heading, the sun / moon theme icon and the filter icon (keyboard), the media
// attention tooltip (hover, focus, tap, Esc, outside click, blur, inside the viewport at 390 px), the six entry map
// legend, the faded style for every state that is not an open state with a value, and no "no data", "insufficient
// data" or "outside the polling filter" in the visible text under several filters, in both themes.
// G2: the Kalshi style chart: a Democratic (blue) and a Republican (red) line named after the candidates, the percent
// axis on the right, end of line labels (latest value in view, no overlap, inside the svg at 390 px), the crosshair
// tooltip against data/processed in daily and hourly view, the 1D 1W 1M 3M All range buttons, no "why" and no "News
// data: live" text in either theme or source.
// H1: the theme glyph of alexfisher.co (sun U+263C in light, moon U+263E in dark, muted, 0.9rem), the funnel filter
// icon, no "News data:", "why?", "mirror image", "no data" or "insufficient data" in the visible DOM (svg titles
// included), the exact News legend labels (and the Wikipedia and Kalshi volume ones, reported), a label, a tooltip
// and a focus stop on Texas only, the solid faded fill and the state borders, the chart heading and the GitHub footer.
// Writes docs/screenshots/g2-{1280,390}-{light,dark}.png, g2-1w-hourly.png, g2-crosshair-1280.png,
// g1-{1280,390}-{light,dark}.png, g1-tooltip-{1280,390}.png, style-{light,dark}-{1280,390}.png, filt-{closed,open}-{1280,390}.png,
// chart-{1280,390}-{light,dark}.png, hourly-{1280,390}-{light,dark}.png, h1-{1280,390}-{light,dark}.png and
// h1-header-{light,dark}.png and h2-footer-{1280,390}-{light,dark}.png.
// H2: the footer data attribution "Data: Kalshi, Media Cloud, Wikimedia." (each source a link) and the GitHub link,
// on one line at 1280 and on separate lines at 390, in both themes.
// Usage: node scripts/verify-dashboard.mjs <live base url> [demo base url]   (CHROME_PATH may point at Chromium)
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

// H2: the footer reads the data attribution (each source a link) and then the GitHub link
const H2_ATTRIBUTION = "Data: Kalshi, Media Cloud, Wikimedia.";
const FOOT_LINKS = ["Kalshi|https://kalshi.com/", "Media Cloud|https://www.mediacloud.org/", "Wikimedia|https://www.wikimedia.org/",
  "Code and data on GitHub|https://github.com/afisher3578/kalshi-midterm-analysis"].map((l) => `${l}|noopener noreferrer|`);
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
const report = { blocked: [], consoleErrors: [], pageErrors: [], checks: [], spot: [], plotted: [], hourly: [], totals: [], g2: [],
  frames: null, axe: {} };
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
  report.axe[key] = r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s): ${v.nodes.slice(0, 2).map((n) => n.target.join(" ") + " " + n.any.map((a) => JSON.stringify(a.data)).join(" ")).join(" | ")}`);
}

// token values from web/src/style.css, as computed rgb
const THEME = {
  light: { bg: "rgb(255, 252, 240)", fg: "rgb(16, 15, 15)", dem: "rgb(32, 94, 166)", rep: "rgb(175, 48, 41)", volume: "rgb(94, 64, 157)",
    news: "rgb(102, 128, 11)" },
  dark: { bg: "rgb(16, 15, 15)", fg: "rgb(206, 205, 195)", dem: "rgb(67, 133, 190)", rep: "rgb(232, 112, 95)", volume: "rgb(139, 126, 200)",
    news: "rgb(135, 154, 57)" },
};
/** The colors the page actually draws with, to compare against THEME. */
const drawn = (page) => page.evaluate(() => {
  const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
  return { theme: document.documentElement.dataset.theme, bg: cs("body", "backgroundColor"), fg: cs("body", "color"),
    dem: cs("#chart path.line-dem", "stroke"), rep: cs("#chart path.line-rep", "stroke"), volume: cs("#chart path.line-volume", "stroke"),
    news: cs("#chart path.line-news", "stroke"), selected: cs("svg.usmap .sel-line", "stroke"),
    pressed: document.querySelector("#theme-btn")?.getAttribute("aria-pressed"),
    stored: localStorage.getItem("theme") };
});
function themeOk(d, name) {
  const t = THEME[name];
  return d.theme === name && d.bg === t.bg && d.fg === t.fg && d.dem === t.dem && d.rep === t.rep && d.volume === t.volume
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

const pctText = (v) => v == null ? "no data" : `${(v * 100).toFixed(1)}%`;
const fmt = {
  dem: pctText,
  rep: pctText,
  volume: (v) => v == null ? "no data" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v)} contracts`,
  news: (v) => v == null ? "no data" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v)} stories`,
};
const COL = { dem: "kalshi_price_close", rep: "kalshi_r_price_close", volume: "kalshi_volume", news: NEWS };
const KEYS = ["dem", "rep", "volume", "news"];

const lines = (page) => page.$$eval("#chart svg path.line", (ps) => ps.map((p) => p.dataset.series).sort().join(","));
const axes = (page) => page.$$eval("#chart svg g[data-axis]", (gs) => gs.map((g) => g.dataset.axis).sort().join(","));
const readout = (page) => page.evaluate(() => ({
  date: document.querySelector("#readout .rdate")?.dataset.date ?? null,
  dem: document.querySelector('#readout [data-v="dem"]')?.textContent ?? null,
  rep: document.querySelector('#readout [data-v="rep"]')?.textContent ?? null,
  volume: document.querySelector('#readout [data-v="volume"]')?.textContent ?? null,
  news: document.querySelector('#readout [data-v="news"]')?.textContent ?? null,
}));
/** The crosshair tooltip: its timestamp and each line's value. */
const tooltip = (page) => page.evaluate(() => {
  const t = document.querySelector("#chart .tip");
  const v = (k) => t.querySelector(`[data-v="${k}"]`)?.textContent ?? null;
  return { hidden: t.hidden, when: t.querySelector(".twhen")?.textContent ?? null, dem: v("dem"), rep: v("rep"), volume: v("volume"), news: v("news") };
});
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
const swatches = (page) => page.evaluate(() => ["dem", "rep", "volume", "news"].map((k) => ({ k,
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

// ---------------------------------------------------------------- F3 helpers
const DAY = 86_400_000, HOUR = 3_600_000;
const txh = tx.series.display_hourly;
const hourRow = new Map(txh.rows.map((r) => [r[0], r]));
const dayRow = new Map(tx.series.display_daily.rows.map((r) => [r.date, r]));
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const gran = (page) => page.evaluate(() => ({ label: document.querySelector("#gran").textContent,
  svg: document.querySelector("#chart svg.lc").dataset.granularity,
  legend: document.querySelector("#lg-volume .lg-desc").textContent,
  axis: document.querySelector("#chart .y-volume .atitle")?.textContent ?? null,
  att: document.querySelector("#lg-news .lg-desc").textContent,
  note: document.querySelector("#att-note").hidden ? null : document.querySelector("#att-note").textContent,
  live: document.querySelector("#gran").getAttribute("aria-live") }));
const isHourly = (g) => g.label === "Kalshi: hourly" && g.svg === "hour" && g.legend === "contracts traded per hour in the Talarico contract"
  && g.axis === "Volume per hour" && g.att.includes("per day") && g.live === "polite";
const isDaily = (g) => g.label === "Kalshi: daily" && g.svg === "day" && g.legend === "contracts traded per day in the Talarico contract"
  && g.axis === "Volume per day" && g.note === null && g.live === "polite";
/** Every point of a line's path, x inverted to epoch ms and y to a value. */
const points = (page, k) => page.evaluate((key) => {
  const svg = document.querySelector("#chart svg.lc"), p = document.querySelector(`#chart path.line-${key}`);
  const [x0, x1] = svg.dataset.xdomain.split(",").map(Number), [r0, r1] = svg.dataset.xrange.split(",").map(Number);
  const [d0, d1] = p.dataset.domain.split(",").map(Number), [y0, y1] = p.dataset.range.split(",").map(Number);
  const pts = [...p.getAttribute("d").matchAll(/(-?[\d.]+(?:e-?\d+)?),(-?[\d.]+(?:e-?\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  return { tol: (0.001 * Math.abs(d1 - d0)) / Math.abs(y1 - y0), step: p.dataset.step === "true", d: p.getAttribute("d").slice(0, 80),
    pts: pts.map(([px, py]) => ({ px, py, t: x0 + ((px - r0) / (r1 - r0)) * (x1 - x0), v: d0 + ((py - y0) / (y1 - y0)) * (d1 - d0) })) };
}, k);
/** Plotted hourly values by ts (each point's x rounded to the hour). */
async function hourly(page, k) {
  const p = await points(page, k);
  const at = new Map(p.pts.map((q) => [new Date(Math.round(q.t / HOUR) * HOUR).toISOString().replace(".000Z", "Z"), q.v]));
  return { tol: p.tol, at, n: p.pts.length };
}
const range = async (page) => `${await page.inputValue("#d-from")}..${await page.inputValue("#d-to")}`;
const quickPressed = (page) => page.$$eval(".rbtn", (bs) => bs.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.id).join(","));
/** Move the keyboard cursor to an hour: Home is the range start's 00:00Z hour, Shift + right steps a day, right an hour. */
async function cursorTo(page, ts, from) {
  await page.locator("#chart").focus();
  await page.keyboard.press("Home");
  const h = Math.round((Date.parse(ts) - Date.parse(from + "T00:00:00Z")) / HOUR);
  for (let i = 0; i < Math.floor(h / 24); i++) await page.keyboard.press("Shift+ArrowRight");
  for (let i = 0; i < h % 24; i++) await page.keyboard.press("ArrowRight");
  return page.evaluate(() => ({ ts: document.querySelector("#readout .rdate")?.dataset.ts ?? null,
    when: document.querySelector("#readout .rdate")?.textContent ?? null,
    dem: document.querySelector('#readout [data-v="dem"]')?.textContent ?? null,
    rep: document.querySelector('#readout [data-v="rep"]')?.textContent ?? null,
    volume: document.querySelector('#readout [data-v="volume"]')?.textContent ?? null,
    news: document.querySelector('#readout [data-v="news"]')?.textContent ?? null,
    newsLabel: document.querySelector('#readout .rk[data-k="news"]')?.textContent ?? null,
    note: document.querySelector("#readout .rnote")?.textContent ?? null }));
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const whenText = (ts) => { const d = new Date(ts); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${
  String(d.getUTCHours()).padStart(2, "0")}:00 UTC`; };

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
  const flFill = await page.$eval('svg.usmap path[data-state="FL"]', (p) => p.style.fill);
  check("map: only Texas is a button; every other state is faded and takes no focus", `${buttons.join(",")}; ${greyed} greyed, ${greyFocus} focusable, FL fill ${flFill}`,
    "TX:0; 50 greyed, 0 focusable, var(--map-faded)", buttons.join(",") === "TX:0" && greyed >= 50 && greyFocus === 0 && flFill === "var(--map-faded)");
  const txVol = index.races["tx-senate-2026"].display.kalshi_volume;
  const txRow = (await page.locator('#map-table tr[data-race="tx-senate-2026"] td[data-k="value"]').textContent()).replace(/\s+/g, " ").trim();
  const txLabel = await page.$eval('svg.usmap path[data-state="TX"]', (p) => `${p.getAttribute("aria-label")} | title ${p.querySelector("title")?.textContent}`);
  check("map default metric: TX Kalshi volume with n in the table, the aria-label and the title",
    `${txRow} | ${txLabel}`, `43M contracts (n=${txVol.n_days} days)`,
    txRow === `43M contracts (n=${txVol.n_days} days)` && txLabel.includes(`43M contracts (n=${txVol.n_days} days)`)
      && txLabel.includes("title Texas: 43M contracts"));
  const flA11y = await page.$eval('svg.usmap path[data-state="FL"]', (p) => `${p.getAttribute("aria-label")} ${p.getAttribute("role")} ${
    !!p.querySelector("title")} ${p.getAttribute("aria-hidden")}`);
  const flRow = (await page.locator('#map-table tr[data-race="fl-senate-2026"] td[data-k="value"]').textContent()).replace(/\s+/g, " ").trim();
  check("greyed state with a race (Florida): no name, role or tooltip on the map; its value and coming soon are in the map table",
    `${flA11y} | table ${flRow}`, "null null false true | table ... contracts (n=92 days), coming soon",
    flA11y === "null null false true" && /^.* contracts \(n=\d+ days\), coming soon$/.test(flRow));
  const noData = await page.$eval('svg.usmap path[data-state="AL"]', (p) => `${p.style.fill} ${p.classList.contains("faded")}`);
  check("map: states with no race are drawn in the faded coming soon style", noData, "var(--map-faded) true", noData === "var(--map-faded) true");
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
  const flAttRow = (await page.locator('#map-table tr[data-race="fl-senate-2026"] td[data-k="value"]').textContent()).replace(/\s+/g, " ").trim();
  check("Attention (News): TX stories with n; Florida has no news (faded, the reason only in the map table)", `${attRow} | ${flAtt} | ${flAttRow}`,
    `6.66k stories (n=${txNews.n_days} days) | var(--map-faded) null | no news data, coming soon`,
    attRow === `6.66k stories (n=${txNews.n_days} days)` && flAtt === "var(--map-faded) null" && flAttRow === "no news data, coming soon");
  // polling Few: Texas (53 polls) is outside and drawn faded, its label says so; Kentucky (1 poll) stays in
  await page.locator('#filters-panel label:has(input[name="f-polls"][value="few"])').click();
  const pf = await page.evaluate(() => { const st = (c) => document.querySelector(`svg.usmap path[data-state="${c}"]`);
    return { tx: `${st("TX").style.fill} ${st("TX").classList.contains("faded")}`, txLabel: st("TX").getAttribute("aria-label"),
      ky: document.querySelector('#map-table tr[data-race="ky-senate-2026"] td[data-k="value"]').textContent }; });
  check("Polling Few: TX outside (faded, the label says outside the polling filter), KY inside (map table)", JSON.stringify(pf),
    "TX var(--map-faded) true, KY not outside", pf.tx === "var(--map-faded) true" && pf.txLabel.includes("outside the polling filter")
      && !pf.ky.includes("outside the polling filter"));
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
  await page.waitForFunction(() => document.querySelector("#lg-news .lg-desc")?.textContent.startsWith("Wikipedia"));
  const wdd = tx.series.display_daily;
  const wst = await page.locator("#news-status").count();
  const wlabel = (await page.locator("#lg-news").textContent()).replace(/\s+/g, " ").trim();
  check("Sources Wikipedia: chart plots Wikipedia pageviews, no status line", `status lines ${wst} | ${wlabel} | lines ${await lines(page)}`,
    "0 | Attention: Wikipedia pageviews per day (race and candidate pages) | dem,news,rep,volume", wst === 0
      && wlabel === "Attention: Wikipedia pageviews per day (race and candidate pages)" && await lines(page) === "dem,news,rep,volume");
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
  await page.waitForFunction(() => document.querySelector("#lg-news .lg-desc")?.textContent.startsWith("news stories"));
  await page.keyboard.press("Escape");

  // G2: no news status line when the race has news (the "News data: live, N of M days" line is gone)
  const dd = tx.series.display_daily;
  const status = await page.locator("#news-status").count();
  const liveText = (await page.evaluate(() => document.body.innerText)).includes("News data");
  check("G2: no status line for a race with news, no \"News data\" text", `status lines ${status}, text ${liveText}`, "0, false",
    status === 0 && !liveText);
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
  const foot = await page.evaluate(() => [...document.querySelectorAll("footer")].map((f) => ({ text: f.innerText.trim(),
    links: [...f.querySelectorAll("a")].map((a) => `${a.textContent}|${a.href}|${a.rel}|${a.target}`) })));
  check("H1/H2 footer: one footer, the data attribution and the GitHub link (4 links, exact hrefs, same tab, rel noopener noreferrer), no other copy",
    JSON.stringify(foot), FOOT_LINKS.join(" , "), foot.length === 1
      && foot[0].text.replace(/\s+/g, " ") === `${H2_ATTRIBUTION} Code and data on GitHub` && foot[0].links.join() === FOOT_LINKS.join());
  const elabel = await page.locator('#chart g[data-mark="election"] text').textContent();
  check("election days shaded and labeled", elabel, "Election, Nov 3 and 4", elabel === "Election, Nov 3 and 4"
    && await page.locator('#chart g[data-mark="election"] rect').count() === 1);
  check("four lines and three axes by default (one percent axis for both candidates)", `${await lines(page)} | ${await axes(page)}`,
    "dem,news,rep,volume | news,price,volume", await lines(page) === "dem,news,rep,volume" && await axes(page) === "news,price,volume");
  const old = await noOldControls(page);
  check("no race type switch and no scale switch in the chart area (no radios, checkboxes or selects, no such labels)",
    JSON.stringify(old), '{"found":[],"radios":0,"words":[]}', old.found.length === 0 && old.radios === 0 && old.words.length === 0);

  // legend: one entry per line, one row above the chart, the texts, real buttons with aria-pressed
  const lt = await page.$$eval("#legend .lg-btn", (bs) => bs.map((b) => `${b.tagName}|${b.type}|${b.getAttribute("aria-pressed")}|${
    b.textContent.replace(/\s+/g, " ").trim()}`));
  const last = (col) => [...dd.rows].reverse().find((r) => r[col] != null)[col];
  const wantLt = [`BUTTON|button|true|James Talarico (D) ${pctText(last("kalshi_price_close"))}: Kalshi chance that James Talarico wins (%)`,
    `BUTTON|button|true|Ken Paxton (R) ${pctText(last("kalshi_r_price_close"))}: Kalshi chance that Ken Paxton wins (%)`,
    "BUTTON|button|true|Volume: contracts traded per day in the Talarico contract",
    "BUTTON|button|true|Attention: news stories per day mentioning the race (Media Cloud)"];
  check("legend: four button entries, pressed, with name, latest value and description", lt.join(" / "), wantLt.join(" / "),
    JSON.stringify(lt) === JSON.stringify(wantLt));
  const lb = await legendBox(page);
  const oneRow = lb.items.length === 4 && lb.items.every((i) => Math.abs(i.top - lb.items[0].top) <= 2)
    && lb.items.every((it, i) => i === 0 || lb.items[i - 1].right <= it.left);
  check("1280: legend entries share one row, above the chart, no overflow", JSON.stringify(lb), "same top, left to right, above chart",
    oneRow && lb.aboveChart && lb.lgOverflow <= 0 && lb.pageOverflow <= 0);
  const sw = await swatches(page);
  check("light: each legend swatch has its line's stroke color", JSON.stringify(sw), "swatch == line, the light tokens",
    sw.every((x) => x.swatch === x.line && x.line === THEME.light[x.k]));
  // G2: no why? control or note any more, and a Republican line is drawn
  const whyGone = await page.evaluate(() => ({ btn: !!document.querySelector("#lg-why"), note: !!document.querySelector("#lg-note") }));
  check("G2: the why? button and its note are gone; the Republican line is drawn", `${JSON.stringify(whyGone)} | ${await lines(page)}`,
    "no button, no note | dem,news,rep,volume", !whyGone.btn && !whyGone.note && await lines(page) === "dem,news,rep,volume");
  await axe(page, "1280 legend");
  await page.mouse.move(0, 0);
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "chart-1280-light.png") });

  // plotted values: each line's path coordinates, read back to values, against the JSON on three days
  for (const k of KEYS) {
    const got = await plotted(page, k);
    for (const d of ["2026-08-05", "2026-09-15", "2026-11-03"]) {
      const raw = dd.rows.find((r) => r.date === d)[COL[k]];
      const exp = raw == null ? null : k === "dem" || k === "rep" ? raw * 100 : raw;
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
    for (const k of KEYS) {
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
  check("hover: readout and tooltip show the day's values", `${hr.date} ${hr.dem} ${hr.rep} ${hr.volume} ${hr.news} | tip ${tip.replace(/\s+/g, " ")}`,
    hrow ? `${fmt.dem(hrow.kalshi_price_close)} ${fmt.rep(hrow.kalshi_r_price_close)} ${fmt.volume(hrow.kalshi_volume)} ${fmt.news(hrow[NEWS])}` : "a date",
    hrow && hr.dem === fmt.dem(hrow.kalshi_price_close) && hr.rep === fmt.rep(hrow.kalshi_r_price_close) && hr.volume === fmt.volume(hrow.kalshi_volume)
      && hr.news === fmt.news(hrow[NEWS]) && tip.includes(hr.dem) && tip.includes(hr.rep));
  const live = await page.locator("#readout").getAttribute("aria-live");
  check("readout row is aria-live polite", live, "polite", live === "polite");

  // legend entries are the toggles: a click switches the line and its axis; the last line stays on
  const pressed = (k) => page.locator(`#lg-${k}`).getAttribute("aria-pressed");
  await page.locator("#lg-volume").click();
  check("legend: Volume off: line and axis gone, aria-pressed false", `${await lines(page)} | ${await axes(page)} | ${await pressed("volume")}`,
    "dem,news,rep | news,price | false", await lines(page) === "dem,news,rep" && await axes(page) === "news,price" && await pressed("volume") === "false");
  await page.locator("#lg-volume").click();
  check("legend: Volume on: line and axis back", `${await lines(page)} | ${await axes(page)} | ${await pressed("volume")}`, "dem,news,rep,volume | true",
    await lines(page) === "dem,news,rep,volume" && await axes(page) === "news,price,volume" && await pressed("volume") === "true");
  await page.locator("#lg-dem").click();
  check("legend: Talarico off: his line and end label gone, the percent axis stays for Paxton", `${await lines(page)} | ${await axes(page)} | ${
    await page.locator(".endlabel").count()} label`, "news,rep,volume | news,price,volume | 1",
    await lines(page) === "news,rep,volume" && await axes(page) === "news,price,volume" && await page.locator(".endlabel").count() === 1);
  await page.locator("#lg-rep").click();
  check("legend: both candidates off: the percent axis goes too", `${await lines(page)} | ${await axes(page)}`, "news,volume",
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
  await page.locator("#lg-dem").click();
  await page.locator("#lg-rep").click();
  await page.locator("#lg-news").click();
  check("all four lines back; nothing locked", `${await lines(page)} | ${await page.locator('.lg-btn[aria-disabled="true"]').count()} locked`,
    "dem,news,rep,volume | 0 locked", await lines(page) === "dem,news,rep,volume" && await page.locator('.lg-btn[aria-disabled="true"]').count() === 0);

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
  await page.mouse.move(2, 450);  // the page margin: no control under the pointer once the screenshot scrolls
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
    check(`?race=${id}: no news: the one status line, Attention entry off and disabled (a click does nothing), both candidates and volume drawn`,
      `${st} | disabled ${nd} pressed ${nc} | ${legNews} | lines ${await lines(page)}`, "No news data for this race yet.",
      st === "No news data for this race yet." && nd && !nc && legNews.includes("(no news data for this race yet)")
        && await lines(page) === "dem,rep,volume");
    const miss = noNews.series.display_daily.coverage.kalshi_price_close.missing_days;
    const segs = await page.$eval("#chart svg path.line-dem", (p) => (p.getAttribute("d").match(/M/g) || []).length);
    check(`${id}: missing Kalshi days break the price line (not drawn as zero)`, `${segs} segment(s); missing ${miss.join(", ")}`,
      "more than one segment when a missing day is inside the window", miss.length === 0 || segs > 1);
    await axe(page, `1280 ${id}`);
    await page.locator('svg.usmap path[data-state="TX"]').click();
    await page.waitForFunction(() => document.querySelector("#race")?.getAttribute("data-race")?.startsWith("tx-"));
    check("Texas on the map opens Texas Senate; Attention entry on again", `${await page.locator("#race").getAttribute("data-race")} ${await pressed("news")} ${await lines(page)}`,
      "tx-senate-2026 true dem,news,rep,volume", await page.locator("#race").getAttribute("data-race") === "tx-senate-2026"
        && await pressed("news") === "true" && await lines(page) === "dem,news,rep,volume");
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

// ---------------------------------------------------------------- F3: hourly zoom, 1280
{
  const { ctx, page } = await open(1280);
  const w = tx.series.display_daily.window;
  const g0 = await gran(page);
  check("full range: Kalshi: daily, volume per day in the legend and on the axis, no attention note", JSON.stringify(g0),
    "Kalshi: daily, per day, note hidden", isDaily(g0));
  check("full range: All pressed", await quickPressed(page), "r-All", await quickPressed(page) === "r-All");
  // the threshold edge through the date inputs: 14 days hourly, 15 days daily
  await setDate(page, "#d-from", "2026-10-01");
  await setDate(page, "#d-to", "2026-10-14");
  const g14 = await gran(page);
  check("14 days (2026-10-01..2026-10-14, date inputs): hourly", `${await range(page)} ${JSON.stringify(g14)}`, "Kalshi: hourly, per hour", isHourly(g14));
  await setDate(page, "#d-to", "2026-10-15");
  const g15 = await gran(page);
  check("15 days (2026-10-01..2026-10-15): daily", `${await range(page)} ${JSON.stringify(g15)}`, "Kalshi: daily, per day", isDaily(g15));
  await setDate(page, "#d-from", "2026-10-10");
  await setDate(page, "#d-to", "2026-10-20");
  const g11 = await gran(page);
  const pts11 = (await hourly(page, "dem")).n;
  check("11 days via the date inputs: hourly, about 24 price points per day", `${JSON.stringify(g11)} ${pts11} points`, "hourly, 264 points",
    isHourly(g11) && Math.abs(pts11 / 11 - 24) <= 1);
  await page.locator("#d-reset").click();
  check("Reset: full range and daily again", `${await range(page)} ${(await gran(page)).label}`, `${w.start}..${w.end} Kalshi: daily`,
    await range(page) === `${w.start}..${w.end}` && isDaily(await gran(page)));

  // range buttons by keyboard: real buttons, Enter and Space. 1W is the 7 days ending on the window's last day.
  await page.locator("#r-1W").focus();
  await page.keyboard.press("Enter");
  const g7 = await gran(page);
  const r7 = await range(page);
  const W1 = `${addDays(w.end, -6)}..${w.end}`;
  check("keyboard Enter on 1W: the 7 days ending on the window's last day, hourly, pressed",
    `${r7} ${JSON.stringify(g7)} pressed ${await quickPressed(page)}`, `${W1} hourly r-1W`,
    r7 === W1 && r7 === "2026-10-29..2026-11-04" && isHourly(g7) && await quickPressed(page) === "r-1W");
  const note = g7.note;
  check("hourly: the attention note is visible", note, "Attention is daily: Media Cloud gives no time of day.",
    note === "Attention is daily: Media Cloud gives no time of day." && await page.locator("#att-note").isVisible());
  // one point per hour on the candidate lines and volume: every display_hourly row of the 7 days (the last day ends at
  // the last candle)
  const hp = await hourly(page, "dem"), hpr = await hourly(page, "rep"), hv = await hourly(page, "volume");
  const nRows = txh.rows.filter((r) => r[0].slice(0, 10) >= "2026-10-29").length;
  check("hourly 1W: each Kalshi line has one point per display_hourly row", `dem ${hp.n}, rep ${hpr.n}, volume ${hv.n}; JSON ${nRows} rows`,
    `${nRows} each`, hp.n === nRows && hpr.n === nRows && hv.n === nRows);
  // hourly spot checks: plotted values and the readout against display_hourly
  for (const ts of ["2026-10-29T15:00:00Z", "2026-11-01T03:00:00Z", "2026-11-03T20:00:00Z"]) {
    const row = hourRow.get(ts);
    const r = await cursorTo(page, ts, "2026-10-29");
    const tp = await tooltip(page);
    const pp = hp.at.get(ts), pr = hpr.at.get(ts), pv = hv.at.get(ts);
    const okP = Math.abs(pp - row[1] * 100) <= hp.tol + 1e-9 && Math.abs(pr - row[3] * 100) <= hpr.tol + 1e-9
      && Math.abs(pv - row[2]) <= hv.tol + 1e-9 * row[2];
    const okV = !tp.hidden && tp.when === whenText(ts) && tp.dem === fmt.dem(row[1]) && tp.rep === fmt.rep(row[3])
      && tp.volume === fmt.volume(row[2]) && tp.news === fmt.news(dayRow.get(ts.slice(0, 10))[NEWS]);
    const okR = r.ts === ts && r.when === whenText(ts) && r.dem === fmt.dem(row[1]) && r.rep === fmt.rep(row[3]) && r.volume === fmt.volume(row[2]);
    const day = ts.slice(0, 10);
    const okN = r.news === fmt.news(dayRow.get(day)[NEWS]) && /all of /.test(r.newsLabel);
    report.hourly.push({ ts, json_price: row[1], plotted_price: pp, json_r_price: row[3], plotted_r_price: pr, json_volume: row[2],
      plotted_volume: pv, json_news: dayRow.get(day)[NEWS], tooltip: `${tp.when}: ${tp.dem}; ${tp.rep}; ${tp.volume}; ${tp.news}`,
      readout: `${r.when}: ${r.dem}; ${r.rep}; ${r.volume}; ${r.newsLabel} ${r.news}`, ok: okP && okV && okR && okN });
    if (!(okP && okV && okR && okN)) failed = true;
  }
  // day totals: sum of the plotted hours equals the daily volume; the day's last hourly price equals the daily close
  for (const day of ["2026-10-30", "2026-11-02"]) {
    const hrs = [...hv.at.keys()].filter((t) => t.slice(0, 10) === day).sort();
    const sum = hrs.reduce((a, t) => a + hv.at.get(t), 0);
    const jsonSum = txh.rows.filter((r) => r[0].slice(0, 10) === day).reduce((a, r) => a + r[2], 0);
    const lastP = hp.at.get(hrs[hrs.length - 1]);
    const d = dayRow.get(day);
    const okV = hrs.length === 24 && Math.abs(sum - d.kalshi_volume) <= 24 * hv.tol + 1e-6 * d.kalshi_volume;
    const okC = Math.abs(lastP - d.kalshi_price_close * 100) <= hp.tol + 1e-9;
    report.totals.push({ day, hours: hrs.length, plotted_sum: sum, json_hourly_sum: jsonSum, daily_volume: d.kalshi_volume, sum_tol: 24 * hv.tol,
      last_hour_price: lastP, daily_close: d.kalshi_price_close, ok: okV && okC });
    if (!(okV && okC)) failed = true;
  }
  // attention is never hourly: a step path whose value changes only at 00:00 UTC
  const an = await points(page, "news");
  const changes = [];
  for (let i = 1; i < an.pts.length; i++) {
    const a = an.pts[i - 1], b = an.pts[i];
    if (Math.abs(a.py - b.py) > 0.01) changes.push({ sameX: Math.abs(a.px - b.px) < 0.01, t: b.t });
  }
  const atMidnight = changes.every((c) => c.sameX && Math.abs(((c.t % DAY) + DAY) % DAY) < 60_000 || Math.abs((c.t % DAY) - DAY) < 60_000);
  const ys = new Set(an.pts.map((q) => q.py.toFixed(2)));
  check("hourly: attention is a step line: at most days + 1 distinct y values, every change vertical at 00:00 UTC",
    `step ${an.step}; ${ys.size} distinct y over 7 days; ${changes.length} changes, all at midnight ${atMidnight}; ${an.pts.length} points`,
    "step true, <= 8 distinct y, changes at midnight", an.step && ys.size <= 8 && changes.length > 0 && atMidnight
      && changes.every((c) => c.sameX));
  const stepVals = an.pts.filter((q, i) => i % 2 === 0).map((q) => q.v);
  const days7 = Array.from({ length: 7 }, (_, i) => addDays("2026-10-29", i));
  const stepOk = days7.every((d, i) => Math.abs(stepVals[i] - dayRow.get(d)[NEWS]) <= an.tol + 1e-9);
  check("hourly: attention step values equal the daily news counts", stepVals.map((v) => v.toFixed(3)).join(","),
    days7.map((d) => dayRow.get(d)[NEWS]).join(","), stepOk);
  const eb = await page.locator('#chart g[data-mark="election"] rect').count();
  const ebw = await page.$eval('#chart g[data-mark="election"] rect', (r) => Number(r.getAttribute("width")));
  check("hourly: election day shading and label present", `${eb} band, width ${ebw.toFixed(1)}, ${await page.locator('#chart g[data-mark="election"] text').textContent()}`,
    "1 band, label", eb === 1 && ebw > 20);
  // axe in hourly view, light
  await page.locator("#chart").blur();
  await axe(page, "1280 hourly light");
  await page.mouse.move(0, 0);
  await cursorTo(page, "2026-10-30T12:00:00Z", "2026-10-29");  // the tooltip opens right of it, clear of the election label
  await page.locator("#chart").blur();
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "hourly-1280-light.png") });
  await toggleTheme(page);
  await page.locator("#theme-btn").blur();
  await axe(page, "1280 hourly dark");
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "hourly-1280-dark.png") });
  await toggleTheme(page);

  // Space on All: back to daily
  await page.locator("#r-All").focus();
  await page.keyboard.press("Space");
  check("keyboard Space on All: daily again", `${await range(page)} ${(await gran(page)).label} ${await quickPressed(page)}`,
    `${w.start}..${w.end} Kalshi: daily r-All`, await range(page) === `${w.start}..${w.end}` && isDaily(await gran(page))
      && await quickPressed(page) === "r-All");
  await setDate(page, "#d-from", "2026-10-22");
  const r14 = await range(page);
  check("14 days 2026-10-22..2026-11-04 (date inputs): hourly, through the last candle, no range button pressed",
    `${r14} ${(await gran(page)).label} pressed "${await quickPressed(page)}"`, `2026-10-22..${w.end} Kalshi: hourly, none`,
    r14 === `2026-10-22..${w.end}` && isHourly(await gran(page)) && (await hourly(page, "dem")).at.has(txh.last_ts)
      && await quickPressed(page) === "");
  await page.locator("#r-All").click();

  // a filled hour (no candle) shows the no trades readout
  const filled = txh.filled_hours.hours[txh.filled_hours.hours.length - 1];
  const fd = filled.slice(0, 10);
  const ff = addDays(fd, -6) < w.start ? w.start : addDays(fd, -6);
  await setDate(page, "#d-from", ff);
  await setDate(page, "#d-to", addDays(ff, 13));
  const fr = await cursorTo(page, filled, ff);
  const frow = hourRow.get(filled);
  check(`filled hour ${filled} (range ${ff}..${addDays(ff, 13)}): readout says the Talarico contract had no trades, volume 0, price carried`,
    JSON.stringify(fr), "Talarico contract: no trades this hour, last price carried forward", fr.ts === filled
      && fr.note.startsWith("Talarico contract: no trades this hour, last price carried forward") && fr.volume === "0 contracts"
      && fr.dem === fmt.dem(frow[1]));
  await page.keyboard.press("ArrowRight");
  const fr2 = await page.evaluate(() => document.querySelector("#readout .rnote")?.textContent ?? null);
  const nextTs = new Date(Date.parse(filled) + HOUR).toISOString().replace(".000Z", "Z");
  const rFilled = new Set(txh.opposing.filled_hours.hours);
  check("the next hour (Talarico trades) has no Talarico note", fr2, rFilled.has(nextTs) ? "Paxton note only" : "null",
    rFilled.has(nextTs) ? fr2 === "Paxton contract: no trades this hour, last price carried forward" : fr2 === null);
  await page.locator("#d-reset").click();

  // zoom gestures: a plain wheel over the chart scrolls the page and keeps the range; ctrl + wheel zooms
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator("#chart").scrollIntoViewIfNeeded();
  const hb = await page.locator("#chart svg rect.hit").boundingBox();
  await page.mouse.move(hb.x + hb.width * 0.8, hb.y + hb.height / 2);
  const y0 = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(200);
  const y1 = await page.evaluate(() => scrollY);
  check("plain wheel over the chart scrolls the page and does not zoom", `scrollY ${y0} -> ${y1}; ${await range(page)}`,
    `scrolled, ${w.start}..${w.end}`, y1 > y0 && await range(page) === `${w.start}..${w.end}`);
  const hb2 = await page.locator("#chart svg rect.hit").boundingBox();
  await page.mouse.move(hb2.x + hb2.width * 0.8, hb2.y + hb2.height / 2);
  const y2 = await page.evaluate(() => scrollY);
  await page.keyboard.down("Control");
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(40); }
  await page.keyboard.up("Control");
  await page.waitForTimeout(100);
  const zr = await range(page);
  const [zf, zt] = zr.split("..");
  const zd = (Date.parse(zt) - Date.parse(zf)) / DAY + 1;
  check("ctrl + wheel over the chart zooms in around the pointer (page does not scroll)", `${zr} (${zd} days); scrollY ${y2} -> ${await page.evaluate(() => scrollY)}`,
    "fewer days, later part of the window", zd < 92 && zf > w.start && await page.evaluate(() => scrollY) === y2);
  await page.locator("#d-reset").click();
  check("Reset after zoom restores the full range", await range(page), `${w.start}..${w.end}`, await range(page) === `${w.start}..${w.end}`);
  await ctx.close();
}

// ---------------------------------------------------------------- F3: hourly zoom, 390 phone
{
  const { ctx, page } = await open(390, `${BASE}?race=tx-senate-2026`, true);
  await page.locator("#r-1W").tap();
  check("390: tap 1W: hourly", `${await range(page)} ${(await gran(page)).label}`, "2026-10-29..2026-11-04 Kalshi: hourly",
    await range(page) === "2026-10-29..2026-11-04" && isHourly(await gran(page)));
  const ticks = await page.$$eval("#chart svg .xaxis .tick text", (ts) => ts.map((t) => { const r = t.getBoundingClientRect(); return { s: t.textContent, l: r.left, r: r.right }; }));
  const overlap = ticks.some((t, i) => i > 0 && t.l < ticks[i - 1].r + 4);
  check("390 hourly: x axis tick labels do not crowd (no overlap, date labels)", ticks.map((t) => t.s).join(" | "), "no overlap",
    !overlap && ticks.length >= 2 && ticks.every((t) => /^[A-Z][a-z]{2} \d+$/.test(t.s)));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("390 hourly: no horizontal page scroll", overflow, "0", overflow <= 0);
  // a tap fills the text row with the hour
  await page.locator("#chart").scrollIntoViewIfNeeded();
  const box = await page.locator("#chart svg rect.hit").boundingBox();
  await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height / 2);
  const tr = await page.evaluate(() => ({ ts: document.querySelector("#readout .rdate")?.dataset.ts, when: document.querySelector("#readout .rdate")?.textContent,
    text: document.querySelector("#readout").innerText }));
  const trow = hourRow.get(tr.ts);
  check("390: a tap fills the readout row with the hour in UTC and its values", tr.text.replace(/\s+/g, " "), "the hour, UTC, price and volume",
    !!trow && tr.when === whenText(tr.ts) && tr.text.includes(fmt.dem(trow[1])) && tr.text.includes(fmt.rep(trow[3]))
      && tr.text.includes(fmt.volume(trow[2])));
  await axe(page, "390 hourly light");
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "hourly-390-light.png") });
  await page.locator("#theme-btn").tap();
  await page.locator("#theme-btn").blur();
  await axe(page, "390 hourly dark");
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "hourly-390-dark.png") });
  await page.locator("#theme-btn").tap();

  // two finger pinch (CDP touch events): fingers moving apart zoom the chart in
  await page.locator("#r-All").tap();
  const cdp = await ctx.newCDPSession(page);
  await page.locator("#chart").scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);  // let a ResizeObserver redraw settle before reading the plot box
  const pb = await page.locator("#chart svg rect.hit").boundingBox();
  const cy = pb.y + pb.height / 2, mid = pb.x + pb.width * 0.7;
  const touch = (type, d) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [
    { x: mid - d, y: cy, id: 1 }, { x: mid + d, y: cy, id: 2 }] });
  await touch("touchStart", 15);
  for (let d = 20; d <= 90; d += 10) { await touch("touchMove", d); await page.waitForTimeout(30); }
  await touch("touchEnd", 0);
  await page.waitForTimeout(100);
  const pr = await range(page);
  const [pf, pt] = pr.split("..");
  const pdays = (Date.parse(pt) - Date.parse(pf)) / DAY + 1;
  const vv = await page.evaluate(() => visualViewport.scale);
  check("390: two finger pinch apart zooms the chart in, not the page", `${pr} (${pdays} days); page scale ${vv}`, "fewer than 92 days, scale 1",
    pdays < 92 && vv === 1);
  // one finger vertical swipe on the chart still scrolls the page
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator("#chart").scrollIntoViewIfNeeded();
  const sb = await page.locator("#chart svg rect.hit").boundingBox();
  const s0 = await page.evaluate(() => scrollY);
  const one = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: sb.x + sb.width / 2, y, id: 3 }] });
  await one("touchStart", sb.y + sb.height * 0.8);
  for (let k = 1; k <= 8; k++) { await one("touchMove", sb.y + sb.height * 0.8 - k * 20); await page.waitForTimeout(16); }
  await one("touchEnd", 0);
  await page.waitForTimeout(300);
  const s1 = await page.evaluate(() => scrollY);
  check("390: one finger vertical swipe on the chart scrolls the page and keeps the range", `scrollY ${s0} -> ${s1}; ${await range(page)}`,
    `scrolled, ${pr}`, s1 > s0 && await range(page) === pr);

  // frame check: 60 pointer moves across the plot in the 14 day hourly view (after the swipe's fling has stopped)
  await page.waitForFunction(() => new Promise((ok) => { const y = scrollY; setTimeout(() => ok(scrollY === y), 250); }), null, { polling: 300 });
  await setDate(page, "#d-to", "2026-11-04");  // the end first: the pinch left a range that may end before Oct 22
  await setDate(page, "#d-from", "2026-10-22");
  const fb = await page.locator("#chart svg rect.hit").boundingBox();
  const frames = await page.evaluate(async ({ x, y, w }) => {
    const hit = document.querySelector("#chart svg rect.hit");
    const out = [];
    for (let i = 0; i < 60; i++) {
      const cx = x + 1 + (w - 2) * (i / 59);
      const t0 = performance.now();
      hit.dispatchEvent(new PointerEvent("pointermove", { clientX: cx, clientY: y, bubbles: true, pointerType: "mouse" }));
      void document.querySelector("#readout").offsetHeight;  // force the layout the update caused
      out.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
    const s = [...out].sort((a, b) => a - b);
    return { n: out.length, median: (s[29] + s[30]) / 2, max: s[s.length - 1],
      hours: document.querySelectorAll("#chart path.line-dem")[0].getAttribute("d").split("L").length,
      readout: document.querySelector("#readout .rdate")?.dataset.ts };
  }, { x: fb.x, y: fb.y + fb.height / 2, w: fb.width });
  report.frames = frames;
  check("390 hourly 14 days: pointermove handling, median under 16 ms", JSON.stringify(frames), "median < 16 ms",
    frames.median < 16 && frames.hours > 300 && frames.readout?.slice(0, 10) >= "2026-11-03");
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
  const targets = "#theme-btn, #ma-info, #racesec .lg-btn, #racesec input[type=date], #d-reset, #racesec .rbtn, #chart, #racesec .brushbox svg, #filters-btn, #filters-panel label.tg, #filters-panel select, #f-reset, #f-close, footer a";
  const nTargets = await page.locator(targets).count();
  const small = await page.evaluate((sel) => [...document.querySelectorAll(sel)]
    .map((e) => { const r = e.getBoundingClientRect(); return { e: e.id || e.className?.baseVal || e.className || e.tagName, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((r) => r.w < 44 || r.h < 44), targets);
  check(`touch targets at least 44 px (theme, legend entries, dates, Reset, range buttons, chart, brush, Filters button and panel, 4 footer links; ${nTargets} checked)`,
    JSON.stringify(small), "none smaller", small.length === 0 && nTargets >= 27);
  await page.touchscreen.tap(195, 40);
  check("390: a tap outside the sheet closes it", await page.locator("#filters-panel").isVisible(), "false",
    !(await page.locator("#filters-panel").isVisible()));
  await page.locator("#chart").scrollIntoViewIfNeeded();
  const box = await page.locator("#chart svg rect.hit").boundingBox();
  await page.touchscreen.tap(box.x + box.width * 0.25, box.y + box.height / 2);
  const r = await readout(page);
  check("tap on the chart fills the readout row", JSON.stringify(r), "date and four values", r.date && r.dem && r.rep && r.volume && r.news);
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

// ---------------------------------------------------------------- G1: title, icon buttons, media attention tooltip, map legend
const G1 = { title: "2026 U.S. Midterms", subtitle: "Kalshi results and media attention", map: "Kalshi volume by state and media attention",
  def: "Media attention is how often the race appears in the news each day, counted as stories that mention the candidates or race." };
const FORBIDDEN = /no data|insufficient data|outside the polling filter/i;
/** The page text a reader sees: body.innerText with the visually hidden (.vh, 1 x 1 px) text alternatives left out. */
const visibleText = (page) => page.evaluate(() => {
  const vh = [...document.querySelectorAll(".vh")];
  vh.forEach((e) => { e.dataset.g1 = e.style.display; e.style.display = "none"; });
  const t = document.body.innerText;
  vh.forEach((e) => { e.style.display = e.dataset.g1; delete e.dataset.g1; });
  return t;
});
/** Map fills: every state that is not an open state with a value must match a coming soon state and the legend's
 * coming soon swatch; no pattern fills; the on-map labels. */
const fades = (page) => page.evaluate(() => {
  const ps = [...document.querySelectorAll("svg.usmap path.st")];
  const cs = (e) => { const c = getComputedStyle(e); return `${c.fill}|${c.opacity}`; };
  const want = cs(document.querySelector('svg.usmap path.st.greyed[data-race]'));
  const sw = getComputedStyle(document.querySelector("#map .legend li:last-child .sw"));
  return { want, swatch: `${sw.backgroundColor}|${sw.opacity}`,
    bad: ps.filter((p) => p.classList.contains("faded") && cs(p) !== want).map((p) => p.dataset.state),
    shown: ps.filter((p) => !p.classList.contains("faded")).map((p) => p.dataset.state),
    shownOk: ps.filter((p) => !p.classList.contains("faded")).every((p) => p.classList.contains("active")),
    patterns: ps.filter((p) => /url\(/.test(`${p.getAttribute("fill") ?? ""} ${p.style.fill} ${getComputedStyle(p).fill}`)).length,
    defs: document.querySelectorAll("svg.usmap pattern").length,
    labels: [...document.querySelectorAll("svg.usmap .stlabel")].map((t) => t.textContent) };
});
const legendItems = (page) => page.$$eval("#map .legend > li", (ls) => ls.map((l) => l.textContent.replace(/\s+/g, " ").trim()));
const tipOpen = (page) => page.locator("#ma-tip").isVisible();
const BAND = /^[\d.]+[kMGB]? to [\d.]+[kMGB]?$/;
async function noForbidden(page, key) {
  const t = await visibleText(page);
  const f = await fades(page);
  const hits = [...new Set((t.match(new RegExp(FORBIDDEN.source, "gi")) ?? []).map((x) => x.toLowerCase()))];
  const badLabels = f.labels.filter((l) => /no data|filtered|n\/a|insufficient/i.test(l));
  check(`G1 ${key}: visible text has no "no data", "insufficient data" or "outside the polling filter"; labels clean`,
    `${hits.join(", ") || "none"}; labels ${badLabels.join(",") || "clean"}`, "none; clean", hits.length === 0 && badLabels.length === 0);
  check(`G1 ${key}: every faded state matches the coming soon fill and the legend swatch; no pattern fills`,
    JSON.stringify({ ...f, labels: undefined }), "bad [], swatch == want, 0 patterns, shown only open states",
    f.bad.length === 0 && f.swatch === f.want && f.patterns === 0 && f.defs === 0 && f.shownOk);
  return f;
}

{
  const { ctx, page } = await open(1280);
  const titles = await page.evaluate(() => ({ h1: document.querySelector("h1").textContent.trim(),
    sub: document.querySelector(".head .subtitle")?.textContent.trim(), subTag: document.querySelector(".head .subtitle")?.tagName,
    map: document.querySelector("#map-h").textContent.trim(), h1s: document.querySelectorAll("h1").length }));
  check("G1: title, subtitle (a p) and map heading", JSON.stringify(titles), `${G1.title} / ${G1.subtitle} / ${G1.map}...`,
    titles.h1 === G1.title && titles.sub === G1.subtitle && titles.subTag === "P" && titles.map.startsWith(G1.map) && titles.h1s === 1);
  // theme button (H1, as on alexfisher.co): the current theme's glyph as text, the sun in light, the moon in dark, keyboard
  const tb = page.locator("#theme-btn");
  const tstate = () => tb.evaluate((b) => ({ text: b.textContent, label: b.getAttribute("aria-label"), title: b.title,
    icon: b.dataset.icon, n: b.querySelectorAll("svg").length, theme: document.documentElement.dataset.theme,
    pressed: b.getAttribute("aria-pressed") }));
  const t0 = await tstate();
  check("H1 theme button in light: sun glyph U+263C, no svg, Switch to dark theme", JSON.stringify(t0), "\u263C sun Switch to dark theme",
    t0.text === "\u263C" && t0.icon === "sun" && t0.n === 0 && t0.label === "Switch to dark theme" && t0.title === t0.label && t0.pressed === "false");
  await tb.focus();
  await page.keyboard.press("Enter");
  const t1 = await tstate();
  check("H1 theme button: Enter switches to dark, moon glyph U+263E, Switch to light theme", JSON.stringify(t1), "dark \u263E moon Switch to light theme",
    t1.theme === "dark" && t1.text === "\u263E" && t1.icon === "moon" && t1.n === 0 && t1.label === "Switch to light theme" && t1.pressed === "true");
  await page.keyboard.press("Enter");
  const t2 = await tstate();
  check("H1 theme button: Enter again, back to light and the sun", JSON.stringify(t2), "light \u263C",
    t2.theme === "light" && t2.text === "\u263C" && t2.label === "Switch to dark theme");
  await tb.blur();
  // filters button: icon only (the badge digits at most), named, keyboard open, Esc closes and returns focus
  const fbtn = page.locator("#filters-btn");
  const fstate = await fbtn.evaluate((b) => ({ text: b.innerText.trim(), label: b.getAttribute("aria-label"), title: b.title,
    icon: b.querySelector("svg")?.dataset.icon }));
  check("G1 filters button: filter icon, no visible word, aria-label and title Filters", JSON.stringify(fstate), "'' filter Filters",
    /^\d*$/.test(fstate.text) && fstate.icon === "filter" && fstate.label === "Filters" && fstate.title === "Filters");
  await fbtn.focus();
  await page.keyboard.press("Enter");
  const fo = await page.locator("#filters-panel").isVisible();
  await page.keyboard.press("Escape");
  const fe = `${fo} ${await page.locator("#filters-panel").isVisible()} ${await page.evaluate(() => document.activeElement?.id)}`;
  check("G1 filters button: Enter opens, Esc closes, focus back on the button", fe, "true false filters-btn", fe === "true false filters-btn");
  const fh = await page.locator("#filters-h").textContent();
  check("G1 the panel heading still says Filters", fh, "Filters", fh === "Filters");
  await fbtn.blur();
  // the media attention tooltip
  const info = page.locator("#ma-info");
  const desc = await page.evaluate(() => {
    const b = document.querySelector("#ma-info"), t = document.getElementById(b.getAttribute("aria-describedby"));
    return { type: b.type, tag: b.tagName, label: b.getAttribute("aria-label"), role: t?.getAttribute("role"), text: t?.textContent,
      inH2: !!document.querySelector("#map-h").contains(t), btnInH2: document.querySelector("#map-h").contains(b),
      afterWords: document.querySelector("#map-h").textContent.trim().endsWith("media attention") };
  });
  check("G1 info button: a button named What is media attention?, described by the tooltip (outside the h2) with the exact text",
    JSON.stringify(desc), "button, role tooltip, the definition", desc.tag === "BUTTON" && desc.type === "button"
      && desc.label === "What is media attention?" && desc.role === "tooltip" && desc.text === G1.def && !desc.inH2 && desc.btnInH2 && desc.afterWords);
  check("G1 tooltip closed at load", await tipOpen(page), "false", !(await tipOpen(page)));
  await noForbidden(page, "1280 light default");
  await axe(page, "G1 1280 light tooltip closed");
  await info.hover();
  const hov = await tipOpen(page);
  const tb1 = await page.locator("#ma-tip").boundingBox();
  await page.mouse.move(tb1.x + tb1.width / 2, tb1.y + tb1.height / 2, { steps: 4 });
  await page.waitForTimeout(250);
  const stay = await tipOpen(page);
  await page.mouse.move(5, 600);
  await page.waitForTimeout(250);
  const gone = await tipOpen(page);
  check("G1 tooltip: opens on hover, stays open over the tooltip, closes when the pointer leaves", `${hov} ${stay} ${gone}`, "true true false",
    hov && stay && !gone);
  await info.focus();
  const foc = await tipOpen(page);
  const tipText = await page.locator("#ma-tip").innerText();
  check("G1 tooltip: opens on focus, text is the definition", `${foc} ${tipText}`, `true ${G1.def}`, foc && tipText === G1.def);
  await axe(page, "G1 1280 light tooltip open");
  await page.screenshot({ path: resolve(SHOTS, "g1-tooltip-1280.png") });
  await page.keyboard.press("Escape");
  const escd = await tipOpen(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const tabbed = `${await page.evaluate(() => document.activeElement?.id)} ${await tipOpen(page)}`;
  await page.keyboard.press("Tab");
  const blurred = await tipOpen(page);
  check("G1 tooltip: Esc closes it, Tab back opens it, blur closes it", `${escd} | ${tabbed} | ${blurred}`, "false | ma-info true | false",
    !escd && tabbed === "ma-info true" && !blurred);
  await info.click();
  const c1 = await tipOpen(page);
  await page.mouse.move(5, 600);
  await page.waitForTimeout(250);
  const pinned = await tipOpen(page);
  await page.mouse.click(5, 600);
  const outside = await tipOpen(page);
  check("G1 tooltip: a click pins it open (still open after the pointer leaves), a click outside closes it", `${c1} ${pinned} ${outside}`,
    "true true false", c1 && pinned && !outside);
  // legend: six entries, five bands from the data and coming soon
  const items = await legendItems(page);
  check("G1 map legend: six entries, five bands then coming soon", items.join(" | "), "a to b x5 | coming soon",
    items.length === 6 && items.slice(0, 5).every((t) => BAND.test(t)) && items[5] === "coming soon");
  const lgRow = await page.$$eval("#map .legend > li", (ls) => new Set(ls.map((l) => Math.round(l.getBoundingClientRect().top))).size);
  check("G1 1280: the map legend is one row", lgRow, "1", lgRow === 1);
  await page.mouse.move(5, 600);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(SHOTS, "g1-1280-light.png") });
  await toggleTheme(page);
  await tb.blur();
  await page.mouse.move(5, 600);
  await noForbidden(page, "1280 dark default");
  await axe(page, "G1 1280 dark tooltip closed");
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(SHOTS, "g1-1280-dark.png") });
  await info.focus();
  await axe(page, "G1 1280 dark tooltip open");
  await info.blur();
  // filters that leave states faded: polling Few (Texas outside), Many, the attention metric with each source
  for (const h of ["#polls=few", "#polls=many", "#metric=attention", "#metric=attention&polls=few", "#metric=attention&source=wikipedia&polls=few"]) {
    await page.evaluate((x) => { location.hash = x; }, h);
    // the app writes the hash back in its own order, so compare the pairs
    await page.waitForFunction((x) => [...new URLSearchParams(location.hash.slice(1))].sort().join() === [...new URLSearchParams(x.slice(1))].sort().join(), h);
    await page.waitForTimeout(150);
    for (const theme of ["dark", "light"]) {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) { await toggleTheme(page); await tb.blur(); }
      const f = await noForbidden(page, `1280 ${theme} ${h}`);
      if (h.includes("polls=few")) {
        const tx = f.labels.find((l) => l.startsWith("TX"));
        check(`G1 ${h}: Texas (outside the filter) is faded, its map label is the postal code only`, `${f.shown.join(",")} | ${tx}`, " | TX",
          !f.shown.includes("TX") && tx === "TX");
      }
    }
    const lg = await legendItems(page);
    check(`G1 ${h}: legend is the bands then coming soon, or only coming soon`, lg.join(" | "), "bands + coming soon",
      lg[lg.length - 1] === "coming soon" && (lg.length === 1 || (lg.length === 6 && lg.slice(0, 5).every((t) => BAND.test(t)))));
  }
  await ctx.close();
}

{
  const { ctx, page } = await open(390, `${BASE}?race=tx-senate-2026`, true);
  const info = page.locator("#ma-info");
  const items = await legendItems(page);
  const lg = await page.$$eval("#map .legend > li", (ls) => ls.map((l) => { const r = l.getBoundingClientRect();
    return { top: Math.round(r.top), left: r.left, right: r.right, h: Math.round(r.height) }; }));
  check("G1 390: map legend wraps cleanly (six entries, all inside the viewport, no entry breaks onto two lines)", JSON.stringify(lg),
    "inside 0..390, one line each", items.length === 6 && lg.every((r) => r.left >= 0 && r.right <= 390 && r.h <= 24));
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(SHOTS, "g1-390-light.png") });
  await noForbidden(page, "390 light");
  await info.tap();
  const tap1 = await tipOpen(page);
  const bb = await page.locator("#ma-tip").boundingBox();
  const inside = bb && bb.x >= 0 && bb.y >= 0 && bb.x + bb.width <= 390;
  check("G1 390: a tap opens the tooltip, inside the viewport", `${tap1} ${JSON.stringify(bb)}`, "true, 0 <= x, x + w <= 390", tap1 && inside);
  await axe(page, "G1 390 light tooltip open");
  await page.screenshot({ path: resolve(SHOTS, "g1-tooltip-390.png") });
  await info.tap();
  const tap2 = await tipOpen(page);
  await info.tap();
  const tap3 = await tipOpen(page);
  await page.touchscreen.tap(3, 860);  // the page margin: a tap that lands on no control
  const tapOut = await tipOpen(page);
  check("G1 390: tap toggles the tooltip (open, closed, open), a tap outside closes it", `${tap1} ${tap2} ${tap3} ${tapOut}`, "true false true false",
    tap1 && !tap2 && tap3 && !tapOut);
  await page.locator("#theme-btn").tap();
  await page.locator("#theme-btn").blur();
  await noForbidden(page, "390 dark");
  await axe(page, "G1 390 dark tooltip closed");
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(SHOTS, "g1-390-dark.png") });
  await info.tap();
  await axe(page, "G1 390 dark tooltip open");
  const bbd = await page.locator("#ma-tip").boundingBox();
  check("G1 390 dark: the tooltip stays inside the viewport", JSON.stringify(bbd), "x + w <= 390", bbd && bbd.x >= 0 && bbd.x + bbd.width <= 390);
  await ctx.close();
}

// ---------------------------------------------------------------- G2: Kalshi style chart, both candidates
/** End of line labels: key, the shown percent and the svg-relative box of each, and whether any two overlap. */
const endLabels = (page) => page.evaluate(() => {
  const svg = document.querySelector("#chart svg.lc").getBoundingClientRect();
  const ls = [...document.querySelectorAll("#chart .endlabel")].map((g) => {
    const r = g.getBoundingClientRect();
    return { k: g.dataset.k, name: g.querySelector(".el-name").textContent, pct: g.querySelector(".el-pct").textContent,
      fill: getComputedStyle(g.querySelector(".el-pct")).fill, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
      inside: r.left >= svg.left - 0.5 && r.right <= svg.right + 0.5 && r.top >= svg.top - 0.5 && r.bottom <= svg.bottom + 0.5 };
  });
  const overlap = ls.some((a, i) => ls.some((b, j) => j > i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
  return { ls, overlap };
});
/** The last non-null value in [from, to] of a daily or an hourly column, as the label prints it. */
function lastInView(from, to, hourlyMode, k) {
  if (hourlyMode) {
    const i = k === "dem" ? 1 : 3;
    const r = [...txh.rows].reverse().find((x) => x[0].slice(0, 10) >= from && x[0].slice(0, 10) <= to && x[i] != null);
    return pctText(r[i]);
  }
  const r = [...tx.series.display_daily.rows].reverse().find((x) => x.date >= from && x.date <= to && x[COL[k]] != null);
  return pctText(r[COL[k]]);
}
const BODY_BAD = /\bwhy\b|News data: live/i;
async function noWhy(page, key) {
  const t = await page.evaluate(() => document.body.innerText);
  const hits = t.match(new RegExp(BODY_BAD.source, "gi")) ?? [];
  check(`G2 ${key}: page text has no "why" (whole word) and no "News data: live"`, hits.join(", ") || "none", "none", hits.length === 0);
}
async function labelsOk(page, key, from, to, hourlyMode) {
  const e = await endLabels(page);
  const want = { dem: lastInView(from, to, hourlyMode, "dem"), rep: lastInView(from, to, hourlyMode, "rep") };
  const leg = await page.evaluate(() => ({ dem: document.querySelector('.lg-val[data-k="dem"]').textContent.trim(),
    rep: document.querySelector('.lg-val[data-k="rep"]').textContent.trim() }));
  const ok = e.ls.length === 2 && e.ls.every((l) => l.pct === want[l.k] && l.inside) && !e.overlap
    && e.ls.find((l) => l.k === "dem").name === "Talarico" && e.ls.find((l) => l.k === "rep").name === "Paxton"
    && leg.dem === want.dem && leg.rep === want.rep;
  check(`G2 ${key}: end labels Talarico and Paxton show the last value in view (${from}..${to}), the legend the same, inside the svg, no overlap`,
    JSON.stringify({ labels: e.ls.map((l) => `${l.k} ${l.name} ${l.pct} inside ${l.inside} y ${Math.round(l.top)}..${Math.round(l.bottom)}`), overlap: e.overlap, legend: leg }),
    JSON.stringify(want), ok);
  return e;
}

{
  const { ctx, page } = await open(1280);
  const w = tx.series.display_daily.window;
  // two price paths, blue and red, named after the candidates
  const paths = await page.evaluate(() => ["dem", "rep"].map((k) => { const p = document.querySelector(`#chart path.line-${k}`);
    return { k, stroke: p && getComputedStyle(p).stroke, dash: p && p.getAttribute("stroke-dasharray"), dom: p?.dataset.domain, rng: p?.dataset.range }; }));
  const names = await page.$$eval("#legend .lg-name", (ns) => ns.map((n) => n.textContent));
  check("G2 1280 light: a Democratic (blue) and a Republican (red) price path, solid, with data-domain and data-range; legend names",
    `${JSON.stringify(paths)} | ${names.join(" / ")}`, "rgb(32, 94, 166) / rgb(175, 48, 41) | James Talarico (D) / Ken Paxton (R) / Volume / Attention",
    paths[0].stroke === THEME.light.dem && paths[1].stroke === THEME.light.rep && paths.every((p) => !p.dash && p.dom === "0,100" && p.rng)
      && names.join(" / ") === "James Talarico (D) / Ken Paxton (R) / Volume / Attention");
  const pax = await page.$eval("#chart .y-price", (g) => ({ ticks: [...g.querySelectorAll(".tick text")].map((t) => t.textContent).join(" "),
    right: g.getBoundingClientRect().left > document.querySelector("#chart svg rect.hit").getBoundingClientRect().right }));
  check("G2: the percent axis is on the right of the plot with ticks 0% 25% 50% 75% 100%", JSON.stringify(pax), "0% 25% 50% 75% 100%, right",
    pax.ticks === "0% 25% 50% 75% 100%" && pax.right);
  await labelsOk(page, "1280 All", w.start, w.end, false);
  const elFill = await endLabels(page);
  check("G2 light: end label text in the line colors", elFill.ls.map((l) => `${l.k} ${l.fill}`).join(", "), "dem blue, rep red",
    elFill.ls.every((l) => l.fill === THEME.light[l.k]));
  // range buttons: exactly 1D 1W 1M 3M All; each click sets the dates and the zoom; aria-pressed follows
  const rb = await page.$$eval("#racesec .rbtn", (bs) => bs.map((b) => b.textContent));
  check("G2 range buttons are exactly 1D 1W 1M 3M All", rb.join(" "), "1D 1W 1M 3M All", rb.join(" ") === "1D 1W 1M 3M All");
  const want = { "1D": [w.end, w.end, "hour"], "1W": [addDays(w.end, -6), w.end, "hour"], "1M": [addDays(w.end, -29), w.end, "day"],
    "3M": [addDays(w.end, -89), w.end, "day"], All: [w.start, w.end, "day"] };
  for (const [id, [f, t, g]] of Object.entries(want)) {
    await page.locator(`#r-${id}`).click();
    const got = `${await range(page)} ${(await gran(page)).svg} ${await quickPressed(page)}`;
    check(`G2 range ${id}: ${f}..${t}, ${g === "hour" ? "hourly" : "daily"}, pressed`, got, `${f}..${t} ${g} r-${id}`, got === `${f}..${t} ${g} r-${id}`);
    await labelsOk(page, `1280 ${id}`, f, t, g === "hour");
  }
  // close lines: end labels nudged apart (Aug 5 to Sep 2 ends at 48% and 52%)
  await setDate(page, "#d-from", "2026-08-05");
  await setDate(page, "#d-to", "2026-09-02");
  await labelsOk(page, "1280 close values", "2026-08-05", "2026-09-02", false);
  await page.locator("#chart").screenshot({ path: resolve(SHOTS, "g2-nudge-1280.png") });
  await page.locator("#r-All").click();
  // daily crosshair: the tooltip against the JSON on three days (keyboard), then a pointer hover
  await page.locator("#chart").focus();
  await page.keyboard.press("Home");
  const dates = tx.series.display_daily.rows.map((r) => r.date);
  let at = 0;
  for (const d of ["2026-08-20", "2026-10-01", "2026-11-03"]) {
    while (at < dates.indexOf(d)) { await page.keyboard.press("ArrowRight"); at++; }
    const tp = await tooltip(page), row = dayRow.get(d);
    const ok = !tp.hidden && tp.when.endsWith(", UTC") && KEYS.every((k) => tp[k] === fmt[k](row[COL[k]]));
    report.g2.push({ mode: "daily", at: d, tooltip: `${tp.when}: ${KEYS.map((k) => tp[k]).join("; ")}`,
      json: KEYS.map((k) => `${k} ${row[COL[k]]}`).join("; "), ok });
    if (!ok) failed = true;
  }
  await page.locator("#chart").blur();
  const hb = await page.locator("#chart svg rect.hit").boundingBox();
  for (const fx of [0.1, 0.97]) {
    await page.mouse.move(hb.x + hb.width * fx, hb.y + hb.height / 2);
    const geo = await page.evaluate(() => { const t = document.querySelector("#chart .tip").getBoundingClientRect(),
      c = document.querySelector("#chart").getBoundingClientRect(), x = document.querySelector("#chart .cursor line").getBoundingClientRect();
      return { left: t.left, right: t.right, cl: c.left, cr: c.right, cx: x.left, vw: innerWidth }; });
    const side = geo.left >= geo.cx ? "right" : "left";
    check(`G2 hover at ${fx * 100}% across: one tooltip next to the crosshair (${fx < 0.5 ? "right" : "left"} of it), inside the chart and the viewport`,
      JSON.stringify({ ...geo, side }), fx < 0.5 ? "right" : "left", side === (fx < 0.5 ? "right" : "left") && geo.left >= geo.cl - 0.5
        && geo.right <= geo.cr + 0.5 && geo.right <= geo.vw && await page.locator("#chart .cursor circle").count() === 4);
  }
  await page.mouse.move(hb.x + hb.width * 0.62, hb.y + hb.height * 0.4);
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "g2-crosshair-1280.png") });
  await page.mouse.move(0, 0);
  await noWhy(page, "1280 light news");
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "g2-1280-light.png") });
  await axe(page, "G2 1280 light");
  // hourly 1W: tooltip spot checks were done in the F3 block; here the screenshot
  await page.locator("#r-1W").click();
  await page.mouse.move(hb.x + hb.width * 0.4, hb.y + hb.height * 0.45);
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "g2-1w-hourly.png") });
  await page.mouse.move(0, 0);
  await noWhy(page, "1280 light news 1W");
  await page.locator("#r-All").click();
  await toggleTheme(page);
  await page.locator("#theme-btn").blur();
  const pd = await page.evaluate(() => ["dem", "rep"].map((k) => getComputedStyle(document.querySelector(`#chart path.line-${k}`)).stroke));
  const ed = await endLabels(page);
  check("G2 dark: blue and red lines and end labels in the dark tokens", `${pd.join(" / ")} | ${ed.ls.map((l) => l.fill).join(" / ")}`,
    `${THEME.dark.dem} / ${THEME.dark.rep}`, pd[0] === THEME.dark.dem && pd[1] === THEME.dark.rep
      && ed.ls.every((l) => l.fill === THEME.dark[l.k]));
  await noWhy(page, "1280 dark news");
  await page.mouse.move(2, 450);
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "g2-1280-dark.png") });
  await axe(page, "G2 1280 dark");
  // the Wikipedia source, both themes
  await page.evaluate(() => { location.hash = "#source=wikipedia"; });
  await page.waitForFunction(() => document.querySelector("#lg-news .lg-desc")?.textContent.startsWith("Wikipedia"));
  await noWhy(page, "1280 dark wikipedia");
  await toggleTheme(page);
  await noWhy(page, "1280 light wikipedia");
  await ctx.close();
}

{
  const { ctx, page } = await open(390, `${BASE}?race=tx-senate-2026`, true);
  const w = tx.series.display_daily.window;
  const g = await page.evaluate(() => {
    const h = (sel) => [...document.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().height));
    return { overflow: document.documentElement.scrollWidth, ranges: h("#racesec .rbtn"), legend: h("#legend .lg-btn"),
      rows: new Set([...document.querySelectorAll("#legend .lg-item")].map((e) => Math.round(e.getBoundingClientRect().top))).size };
  });
  check("G2 390: no horizontal overflow, range buttons and legend toggles at least 44 px tall, legend wraps", JSON.stringify(g),
    "scrollWidth <= 390, all >= 44, rows > 1", g.overflow <= 390 && g.ranges.length === 5 && g.ranges.every((x) => x >= 44)
      && g.legend.length === 4 && g.legend.every((x) => x >= 44) && g.rows > 1);
  await labelsOk(page, "390 All", w.start, w.end, false);
  const small = await page.$eval("#chart .el-pct", (t) => getComputedStyle(t).fontSize);
  check("G2 390: compact end labels (surname and percent, smaller font)", small, "12px", small === "12px");
  await page.locator("#r-1W").tap();
  await labelsOk(page, "390 1W", addDays(w.end, -6), w.end, true);
  await setDate(page, "#d-from", "2026-08-05");
  await setDate(page, "#d-to", "2026-09-02");
  await labelsOk(page, "390 close values", "2026-08-05", "2026-09-02", false);
  await page.locator("#r-All").tap();
  await noWhy(page, "390 light");
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "g2-390-light.png") });
  await axe(page, "G2 390 light");
  await page.locator("#theme-btn").tap();
  await page.locator("#theme-btn").blur();
  await noWhy(page, "390 dark");
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "g2-390-dark.png") });
  await axe(page, "G2 390 dark");
  await ctx.close();
}

// ---------------------------------------------------------------- H1: header glyph, filter icon, map labels and colors, legend, heading, footer
const H1_FORBIDDEN = ["News data:", "why?", "mirror image", "no data", "insufficient data"];
const H1_NEWS_LEGEND = ["0 to 1.33k", "1.33k to 2.66k", "2.66k to 3.99k", "3.99k to 5.32k", "5.32k to 6.66k", "coming soon"];
const H1_HEADING = "Texas Senate Race 2026: Kalshi price, Kalshi volume and media attention";
const H1_COLORS = { light: { faded: "rgb(135, 133, 128)", edge: "rgb(87, 86, 83)", muted: "rgb(111, 110, 105)" },
  dark: { faded: "rgb(111, 110, 105)", edge: "rgb(159, 157, 150)", muted: "rgb(135, 133, 128)" } };
report.h1 = {};
/** The visible DOM text: the body without the visually hidden (.vh) text alternatives, svg titles included. */
const domText = (page) => page.evaluate(() => {
  const c = document.body.cloneNode(true);
  c.querySelectorAll(".vh, script, noscript").forEach((e) => e.remove());
  return c.textContent;
});
/** What the map gives readers per state: on-map labels, svg titles, focus stops and named states. */
const mapReaders = (page) => page.evaluate(() => {
  const ps = [...document.querySelectorAll("svg.usmap path.st")];
  return { labels: [...document.querySelectorAll("svg.usmap .stlabel")].map((t) => t.textContent),
    titles: ps.filter((p) => p.querySelector("title")).map((p) => p.dataset.state),
    focus: ps.filter((p) => p.hasAttribute("tabindex")).map((p) => p.dataset.state),
    named: ps.filter((p) => p.hasAttribute("role") || p.hasAttribute("aria-label")).map((p) => p.dataset.state),
    shown: ps.filter((p) => p.getAttribute("aria-hidden") !== "true").map((p) => p.dataset.state) };
});
async function setHash(page, h) {
  await page.evaluate((x) => { location.hash = x; }, h);
  await page.waitForFunction((x) => [...new URLSearchParams(location.hash.slice(1))].sort().join() === [...new URLSearchParams(x.slice(1))].sort().join(), h);
  await page.waitForTimeout(150);
}
async function h1Page(page, theme, key) {
  for (const h of ["#metric=volume", "#metric=attention", "#metric=attention&source=wikipedia", "#polls=few", "#metric=attention&polls=many"]) {
    await setHash(page, h === "#metric=volume" ? "" : h);
    const t = await domText(page);
    const hits = H1_FORBIDDEN.filter((f) => t.toLowerCase().includes(f.toLowerCase()));
    const m = await mapReaders(page);
    check(`H1 ${key} ${h}: visible DOM has none of ${H1_FORBIDDEN.join(", ")}`, hits.join(" | ") || "none", "none", hits.length === 0);
    check(`H1 ${key} ${h}: only Texas has a map label, a tooltip, a focus stop and a name`, JSON.stringify(m),
      "labels TX..., titles TX, focus TX, named TX, shown TX", m.labels.length === 1 && m.labels[0].startsWith("TX")
        && [m.titles, m.focus, m.named, m.shown].every((x) => x.join() === "TX"));
    const lg = await legendItems(page);
    if (theme === "light") report.h1[h] = lg.join(" | ");
    if (h === "#metric=attention") {
      check(`H1 ${key}: News legend reads exactly`, lg.join(" | "), H1_NEWS_LEGEND.join(" | "), lg.join(" | ") === H1_NEWS_LEGEND.join(" | "));
      check(`H1 ${key}: Texas map label is TX 6.66k`, m.labels.join(), "TX6.66k", m.labels.join() === "TX6.66k");
    }
  }
  await setHash(page, "#metric=attention");
  const col = await page.evaluate(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const fl = cs('svg.usmap path[data-state="FL"]'), al = cs('svg.usmap path[data-state="AL"]'), sw = cs("#map .legend li:last-child .sw");
    const tb = cs("#theme-btn"), fb = cs("#filters-btn");
    const svg = document.querySelector("#filters-btn svg");
    return { fl: `${fl.fill}|${fl.opacity}`, al: `${al.fill}|${al.opacity}`, edge: fl.stroke, swatch: `${sw.backgroundColor}|${sw.opacity}`,
      swBorder: sw.borderTopColor, themeColor: tb.color, themeSize: tb.fontSize, themeBorder: tb.borderTopStyle, themeBg: tb.backgroundColor,
      filterColor: fb.color, filterIcon: svg?.dataset.icon, filterSize: `${svg?.getAttribute("width")}x${svg?.getAttribute("height")}`,
      filterStroke: svg?.getAttribute("stroke"), filterWidth: svg?.getAttribute("stroke-width"),
      heading: document.querySelector("#chart-h").textContent.trim(), glyph: document.querySelector("#theme-btn").textContent,
      theme: document.documentElement.dataset.theme };
  });
  const want = H1_COLORS[theme];
  check(`H1 ${key}: faded states (FL with a race, AL without) are solid --map-faded, borders --map-edge, the coming soon swatch matches`,
    JSON.stringify(col), `${want.faded}|1, edge ${want.edge}`, col.theme === theme && col.fl === `${want.faded}|1` && col.al === col.fl
      && col.edge === want.edge && col.swatch === col.fl && col.swBorder === want.edge);
  check(`H1 ${key}: theme glyph ${theme === "dark" ? "moon U+263E" : "sun U+263C"}, muted, 0.9rem (15.3px), no border or background; filter funnel, muted, 20 px, thin currentColor stroke`,
    JSON.stringify(col), "glyph, muted, 15.3px", col.glyph === (theme === "dark" ? "☾" : "☼") && col.themeColor === want.muted
      && col.themeSize === "15.3px" && col.themeBorder === "none" && col.themeBg === "rgba(0, 0, 0, 0)" && col.filterColor === want.muted
      && col.filterIcon === "filter" && col.filterSize === "20x20" && col.filterStroke === "currentColor" && col.filterWidth === "1.5");
  check(`H1 ${key}: chart heading`, col.heading, H1_HEADING, col.heading === H1_HEADING);
}

for (const [w, theme] of [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]]) {
  const { ctx, page } = await open(w, `${BASE}?race=tx-senate-2026`, w === 390, theme);
  await page.evaluate(() => localStorage.removeItem("theme"));
  const key = `${w} ${theme}`;
  await h1Page(page, theme, key);
  if (w === 1280) {
    // hover turns the glyph and the funnel to the text color
    await page.locator("#theme-btn").hover();
    const hov = await page.$eval("#theme-btn", (b) => getComputedStyle(b).color);
    await page.locator("#filters-btn").hover();
    const fhov = await page.$eval("#filters-btn", (b) => getComputedStyle(b).color);
    check(`H1 ${key}: hover colors the glyph and the funnel in --fg`, `${hov} ${fhov}`, `${THEME[theme].fg} x2`,
      hov === THEME[theme].fg && fhov === THEME[theme].fg);
    await page.mouse.move(5, 880);
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator("header").screenshot({ path: resolve(SHOTS, `h1-header-${theme}.png`) });
  }
  await axe(page, `H1 ${key}`);
  await page.mouse.move(5, 880);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(SHOTS, `h1-${w}-${theme}.png`) });
  await ctx.close();
}

// ---------------------------------------------------------------- H2: the footer data attribution
for (const [w, theme] of [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]]) {
  const { ctx, page } = await open(w, `${BASE}?race=tx-senate-2026`, w === 390, theme);
  const key = `${w} ${theme}`;
  await page.locator("footer").scrollIntoViewIfNeeded();
  const f = await page.evaluate(() => {
    const top = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top);
    const foot = document.querySelector("footer");
    return { theme: document.documentElement.dataset.theme, text: foot.innerText.trim().replace(/\s+/g, " "),
      attrib: document.querySelector("footer .attrib").innerText.trim(), attribTop: top("footer .attrib"), repoTop: top("footer .repo"),
      links: [...foot.querySelectorAll("a")].map((a) => { const r = a.getBoundingClientRect();
        return `${a.textContent}|${a.href}|${a.rel}|${a.target}|${Math.round(r.width) >= 44 && Math.round(r.height) >= 44}`; }) };
  });
  check(`H2 ${key}: footer reads the attribution then the GitHub link`, f.text, `${H2_ATTRIBUTION} Code and data on GitHub`,
    f.theme === theme && f.attrib === H2_ATTRIBUTION && f.text === `${H2_ATTRIBUTION} Code and data on GitHub`);
  check(`H2 ${key}: 4 footer links, exact hrefs, same tab, rel noopener noreferrer, at least 44 px`, JSON.stringify(f.links),
    FOOT_LINKS.map((l) => `${l}|true`).join(), f.links.join() === FOOT_LINKS.map((l) => `${l}|true`).join());
  const oneLine = f.attribTop === f.repoTop;
  check(`H2 ${key}: attribution and GitHub link ${w === 390 ? "on separate lines" : "on one line"}`,
    `attribution top ${f.attribTop}, GitHub top ${f.repoTop}`, w === 390 ? "different tops" : "same top", w === 390 ? !oneLine : oneLine);
  await page.screenshot({ path: resolve(SHOTS, `h2-footer-${w}-${theme}.png`) });
  await ctx.close();
}

// ---------------------------------------------------------------- demo
if (DEMO) {
  const { ctx, page } = await open(1280, `${DEMO}?race=tx-senate-2026&demo=1`);
  const label = (await page.locator("#demo-label").innerText().catch(() => "")).trim();
  const st = await page.locator("#news-status").count();
  check("--demo: chart shows a visible Demo data label (and no News data status line)", `${label} | status lines ${st}`, "Demo data | 0",
    label === "Demo data" && await page.locator("#demo-label").isVisible() && st === 0);
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
if (report.plotted.length !== 12) { console.log("expected 12 plotted spot checks"); failed = true; }
console.log("\nHourly spot check (7 day view, plotted values and readout vs series.display_hourly; price plotted x100):");
console.log("| ts_utc | JSON D price | plotted D | JSON R price | plotted R | JSON volume | plotted volume | JSON attention | tooltip | ok |\n|---|---|---|---|---|---|---|---|---|---|");
for (const s of report.hourly) console.log(`| ${s.ts} | ${s.json_price} | ${s.plotted_price.toFixed(4)} | ${s.json_r_price} | ${s.plotted_r_price.toFixed(4)} | ${s.json_volume} | ${s.plotted_volume.toFixed(2)} | ${s.json_news} | ${s.tooltip} | ${s.ok ? "yes" : "NO"} |`);
console.log("\nDay totals (plotted hourly volumes summed and the day's last hourly price vs series.display_daily):");
console.log("| day | hours | plotted sum | JSON hourly sum | daily volume | sum tolerance | last hour price (x100) | daily close | ok |\n|---|---|---|---|---|---|---|---|---|");
for (const s of report.totals) console.log(`| ${s.day} | ${s.hours} | ${s.plotted_sum.toFixed(2)} | ${s.json_hourly_sum.toFixed(2)} | ${s.daily_volume} | ${s.sum_tol.toFixed(2)} | ${s.last_hour_price.toFixed(4)} | ${s.daily_close} | ${s.ok ? "yes" : "NO"} |`);
console.log("\nG2 daily crosshair tooltip vs data/processed/tx-senate-2026.json (display_daily; prices x100):");
console.log("| date | tooltip | JSON | ok |\n|---|---|---|---|");
for (const s of report.g2) console.log(`| ${s.at} | ${s.tooltip} | ${s.json} | ${s.ok ? "yes" : "NO"} |`);
if (report.g2.length !== 3) { console.log("expected 3 G2 daily tooltip checks"); failed = true; }
console.log("\nH1 map legend readings (light, 1280):");
for (const [h, l] of Object.entries(report.h1 ?? {})) console.log(`| ${h} | ${l} |`);
if (report.frames) console.log(`\nFrame check, 390 px, 14 day hourly view: ${report.frames.n} pointermove events, median ${report.frames.median.toFixed(2)} ms, max ${report.frames.max.toFixed(2)} ms`);
if (report.hourly.length !== 3 || report.totals.length !== 2) { console.log("expected 3 hourly spot checks and 2 day totals"); failed = true; }
console.log(failed ? "VERIFY FAILED" : "VERIFY OK");
process.exit(failed ? 1 : 0);
