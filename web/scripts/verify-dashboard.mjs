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
// Writes docs/screenshots/g1-{1280,390}-{light,dark}.png, g1-tooltip-{1280,390}.png, style-{light,dark}-{1280,390}.png, filt-{closed,open}-{1280,390}.png,
// chart-{1280,390}-{light,dark}.png and hourly-{1280,390}-{light,dark}.png.
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
const report = { blocked: [], consoleErrors: [], pageErrors: [], checks: [], spot: [], plotted: [], hourly: [], totals: [],
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
const isHourly = (g) => g.label === "Kalshi: hourly" && g.svg === "hour" && g.legend === "contracts traded per hour"
  && g.axis === "Volume per hour" && g.att.includes("per day") && g.live === "polite";
const isDaily = (g) => g.label === "Kalshi: daily" && g.svg === "day" && g.legend === "contracts traded per day"
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
const quickPressed = (page) => page.$$eval(".qbtn", (bs) => bs.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.id).join(","));
/** Move the keyboard cursor to an hour: Home is the range start's 00:00Z hour, Shift + right steps a day, right an hour. */
async function cursorTo(page, ts, from) {
  await page.locator("#chart").focus();
  await page.keyboard.press("Home");
  const h = Math.round((Date.parse(ts) - Date.parse(from + "T00:00:00Z")) / HOUR);
  for (let i = 0; i < Math.floor(h / 24); i++) await page.keyboard.press("Shift+ArrowRight");
  for (let i = 0; i < h % 24; i++) await page.keyboard.press("ArrowRight");
  return page.evaluate(() => ({ ts: document.querySelector("#readout .rdate")?.dataset.ts ?? null,
    when: document.querySelector("#readout .rdate")?.textContent ?? null,
    price: document.querySelector('#readout [data-v="price"]')?.textContent ?? null,
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
  const noData = await page.$eval('svg.usmap path[data-state="AL"]', (p) => `${p.style.fill} ${p.classList.contains("faded")}`);
  check("map: states with no race are drawn in the faded coming soon style", noData, "var(--map-3) true", noData === "var(--map-3) true");
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
  check("Attention (News): TX stories with n; Florida has no news (faded, the reason in its label)", `${attRow} | ${flAtt}`,
    `6.66k stories (n=${txNews.n_days} days) | var(--map-3) Florida: no news data, coming soon`,
    attRow === `6.66k stories (n=${txNews.n_days} days)` && flAtt === "var(--map-3) Florida: no news data, coming soon");
  // polling Few: Texas (53 polls) is outside and drawn faded, its label says so; Kentucky (1 poll) stays in
  await page.locator('#filters-panel label:has(input[name="f-polls"][value="few"])').click();
  const pf = await page.evaluate(() => { const st = (c) => document.querySelector(`svg.usmap path[data-state="${c}"]`);
    return { tx: `${st("TX").style.fill} ${st("TX").classList.contains("faded")}`, txLabel: st("TX").getAttribute("aria-label"),
      ky: st("KY").getAttribute("aria-label") }; });
  check("Polling Few: TX outside (faded, the label says outside the polling filter), KY inside", JSON.stringify(pf),
    "TX var(--map-3) true, KY not outside", pf.tx === "var(--map-3) true" && pf.txLabel.includes("outside the polling filter")
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

// ---------------------------------------------------------------- F3: hourly zoom, 1280
{
  const { ctx, page } = await open(1280);
  const w = tx.series.display_daily.window;
  const g0 = await gran(page);
  check("full range: Kalshi: daily, volume per day in the legend and on the axis, no attention note", JSON.stringify(g0),
    "Kalshi: daily, per day, note hidden", isDaily(g0));
  check("full range: Full range button pressed", await quickPressed(page), "q-full", await quickPressed(page) === "q-full");
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
  const pts11 = (await hourly(page, "price")).n;
  check("11 days via the date inputs: hourly, about 24 price points per day", `${JSON.stringify(g11)} ${pts11} points`, "hourly, 264 points",
    isHourly(g11) && Math.abs(pts11 / 11 - 24) <= 1);
  await page.locator("#d-reset").click();
  check("Reset: full range and daily again", `${await range(page)} ${(await gran(page)).label}`, `${w.start}..${w.end} Kalshi: daily`,
    await range(page) === `${w.start}..${w.end}` && isDaily(await gran(page)));

  // quick buttons by keyboard: real buttons, Enter and Space
  const qb = await page.$$eval(".qbtn", (bs) => bs.map((b) => `${b.tagName}|${b.type}|${b.textContent}`).join(" / "));
  check("three quick range buttons", qb, "Last 7 days before the election / Last 14 days / Full range",
    qb === "BUTTON|button|Last 7 days before the election / BUTTON|button|Last 14 days / BUTTON|button|Full range");
  await page.locator("#q-election7").focus();
  await page.keyboard.press("Enter");
  const g7 = await gran(page);
  const r7 = await range(page);
  check("keyboard Enter on Last 7 days before the election: 2026-10-28..2026-11-03 (from the election date), hourly, pressed",
    `${r7} ${JSON.stringify(g7)} pressed ${await quickPressed(page)}`, "2026-10-28..2026-11-03 hourly q-election7",
    r7 === `${addDays(tx.race.election_date, -6)}..${tx.race.election_date}` && r7 === "2026-10-28..2026-11-03" && isHourly(g7)
      && await quickPressed(page) === "q-election7");
  const note = g7.note;
  check("hourly: the attention note is visible", note, "Attention is daily: Media Cloud gives no time of day.",
    note === "Attention is daily: Media Cloud gives no time of day." && await page.locator("#att-note").isVisible());
  // about 24 points per day on price and volume
  const hp = await hourly(page, "price"), hv = await hourly(page, "volume");
  check("hourly 7 days: price and volume have about 24 points per day", `price ${hp.n}, volume ${hv.n} points over 7 days`, "168 each",
    Math.abs(hp.n / 7 - 24) <= 1 && Math.abs(hv.n / 7 - 24) <= 1);
  // hourly spot checks: plotted values and the readout against display_hourly
  for (const ts of ["2026-10-29T15:00:00Z", "2026-11-01T03:00:00Z", "2026-11-03T20:00:00Z"]) {
    const row = hourRow.get(ts);
    const r = await cursorTo(page, ts, "2026-10-28");
    const pp = hp.at.get(ts), pv = hv.at.get(ts);
    const okP = Math.abs(pp - row[1] * 100) <= hp.tol + 1e-9, okV = Math.abs(pv - row[2]) <= hv.tol + 1e-9 * row[2];
    const okR = r.ts === ts && r.when === whenText(ts) && r.price === fmt.price(row[1]) && r.volume === fmt.volume(row[2]);
    const day = ts.slice(0, 10);
    const okN = r.news === fmt.news(dayRow.get(day)[NEWS]) && /all of /.test(r.newsLabel);
    report.hourly.push({ ts, json_price: row[1], plotted_price: pp, json_volume: row[2], plotted_volume: pv, readout: `${r.when}: ${r.price}; ${r.volume}; ${r.newsLabel} ${r.news}`,
      ok: okP && okV && okR && okN });
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
  const days7 = Array.from({ length: 7 }, (_, i) => addDays("2026-10-28", i));
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
  await cursorTo(page, "2026-10-29T12:00:00Z", "2026-10-28");  // the tooltip opens right of it, clear of the election label
  await page.locator("#chart").blur();
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "hourly-1280-light.png") });
  await toggleTheme(page);
  await page.locator("#theme-btn").blur();
  await axe(page, "1280 hourly dark");
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "hourly-1280-dark.png") });
  await toggleTheme(page);

  // Space on Full range: back to daily
  await page.locator("#q-full").focus();
  await page.keyboard.press("Space");
  check("keyboard Space on Full range: daily again", `${await range(page)} ${(await gran(page)).label} ${await quickPressed(page)}`,
    `${w.start}..${w.end} Kalshi: daily q-full`, await range(page) === `${w.start}..${w.end}` && isDaily(await gran(page))
      && await quickPressed(page) === "q-full");
  await page.locator("#q-last14").click();
  const r14 = await range(page);
  check("Last 14 days: 2026-10-22..2026-11-04, hourly, through the last candle", `${r14} ${(await gran(page)).label}`,
    `2026-10-22..${w.end} Kalshi: hourly`, r14 === `2026-10-22..${w.end}` && isHourly(await gran(page))
      && (await hourly(page, "price")).at.has(txh.last_ts));
  await page.locator("#q-full").click();

  // a filled hour (no candle) shows the no trades readout
  const filled = txh.filled_hours.hours[txh.filled_hours.hours.length - 1];
  const fd = filled.slice(0, 10);
  const ff = addDays(fd, -6) < w.start ? w.start : addDays(fd, -6);
  await setDate(page, "#d-from", ff);
  await setDate(page, "#d-to", addDays(ff, 13));
  const fr = await cursorTo(page, filled, ff);
  const frow = hourRow.get(filled);
  check(`filled hour ${filled} (range ${ff}..${addDays(ff, 13)}): readout says no trades, volume 0, price carried`,
    JSON.stringify(fr), "no trades this hour, last price carried forward", fr.ts === filled
      && fr.note === "no trades this hour, last price carried forward" && fr.volume === "0 contracts" && fr.price === fmt.price(frow[1]));
  await page.keyboard.press("ArrowRight");
  const fr2 = await page.evaluate(() => document.querySelector("#readout .rnote")?.textContent ?? null);
  check("the next hour (with trades) has no note", fr2, "null", fr2 === null);
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
  await page.locator("#q-election7").tap();
  check("390: tap Last 7 days before the election: hourly", `${await range(page)} ${(await gran(page)).label}`, "2026-10-28..2026-11-03 Kalshi: hourly",
    await range(page) === "2026-10-28..2026-11-03" && isHourly(await gran(page)));
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
    !!trow && tr.when === whenText(tr.ts) && tr.text.includes(fmt.price(trow[1])) && tr.text.includes(fmt.volume(trow[2])));
  await axe(page, "390 hourly light");
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "hourly-390-light.png") });
  await page.locator("#theme-btn").tap();
  await page.locator("#theme-btn").blur();
  await axe(page, "390 hourly dark");
  await page.locator("#racesec").screenshot({ path: resolve(SHOTS, "hourly-390-dark.png") });
  await page.locator("#theme-btn").tap();

  // two finger pinch (CDP touch events): fingers moving apart zoom the chart in
  await page.locator("#q-full").tap();
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
  await page.locator("#q-last14").tap();
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
      hours: document.querySelectorAll("#chart path.line-price")[0].getAttribute("d").split("L").length,
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
  const targets = "#theme-btn, #ma-info, #racesec .lg-btn, #lg-why, #racesec input[type=date], #d-reset, #racesec .qbtn, #chart, #racesec .brushbox svg, #filters-btn, #filters-panel label.tg, #filters-panel select, #f-reset, #f-close";
  const nTargets = await page.locator(targets).count();
  const small = await page.evaluate((sel) => [...document.querySelectorAll(sel)]
    .map((e) => { const r = e.getBoundingClientRect(); return { e: e.id || e.className?.baseVal || e.className || e.tagName, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((r) => r.w < 44 || r.h < 44), targets);
  check(`touch targets at least 44 px (theme, legend entries, why?, dates, Reset, chart, brush, Filters button and panel; ${nTargets} checked)`,
    JSON.stringify(small), "none smaller", small.length === 0 && nTargets >= 26);
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
  // theme button: icon only, the moon in light, the sun in dark, keyboard
  const tb = page.locator("#theme-btn");
  const tstate = () => tb.evaluate((b) => ({ text: b.innerText.trim(), label: b.getAttribute("aria-label"), title: b.title,
    icon: b.querySelector("svg")?.dataset.icon, n: b.querySelectorAll("svg").length, theme: document.documentElement.dataset.theme,
    pressed: b.getAttribute("aria-pressed") }));
  const t0 = await tstate();
  check("G1 theme button in light: no text, moon icon, Switch to dark theme", JSON.stringify(t0), "'' moon Switch to dark theme",
    t0.text === "" && t0.icon === "moon" && t0.n === 1 && t0.label === "Switch to dark theme" && t0.title === t0.label && t0.pressed === "false");
  await tb.focus();
  await page.keyboard.press("Enter");
  const t1 = await tstate();
  check("G1 theme button: Enter switches to dark, sun icon, Switch to light theme", JSON.stringify(t1), "dark sun Switch to light theme",
    t1.theme === "dark" && t1.text === "" && t1.icon === "sun" && t1.n === 1 && t1.label === "Switch to light theme" && t1.pressed === "true");
  await page.keyboard.press("Enter");
  const t2 = await tstate();
  check("G1 theme button: Enter again, back to light and the moon", JSON.stringify(t2), "light moon",
    t2.theme === "light" && t2.icon === "moon" && t2.label === "Switch to dark theme");
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
  await page.touchscreen.tap(195, 860);
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
console.log("\nHourly spot check (7 day view, plotted values and readout vs series.display_hourly; price plotted x100):");
console.log("| ts_utc | JSON price | plotted price | JSON volume | plotted volume | readout | ok |\n|---|---|---|---|---|---|---|");
for (const s of report.hourly) console.log(`| ${s.ts} | ${s.json_price} | ${s.plotted_price.toFixed(4)} | ${s.json_volume} | ${s.plotted_volume.toFixed(2)} | ${s.readout} | ${s.ok ? "yes" : "NO"} |`);
console.log("\nDay totals (plotted hourly volumes summed and the day's last hourly price vs series.display_daily):");
console.log("| day | hours | plotted sum | JSON hourly sum | daily volume | sum tolerance | last hour price (x100) | daily close | ok |\n|---|---|---|---|---|---|---|---|---|");
for (const s of report.totals) console.log(`| ${s.day} | ${s.hours} | ${s.plotted_sum.toFixed(2)} | ${s.json_hourly_sum.toFixed(2)} | ${s.daily_volume} | ${s.sum_tol.toFixed(2)} | ${s.last_hour_price.toFixed(4)} | ${s.daily_close} | ${s.ok ? "yes" : "NO"} |`);
if (report.frames) console.log(`\nFrame check, 390 px, 14 day hourly view: ${report.frames.n} pointermove events, median ${report.frames.median.toFixed(2)} ms, max ${report.frames.max.toFixed(2)} ms`);
if (report.hourly.length !== 3 || report.totals.length !== 2) { console.log("expected 3 hourly spot checks and 2 day totals"); failed = true; }
console.log(failed ? "VERIFY FAILED" : "VERIFY OK");
process.exit(failed ? 1 : 0);
