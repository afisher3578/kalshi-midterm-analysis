// Render check for the dashboard page (SHOW_DETAILS off): the map, and below it one line chart for the selected race.
// Blocks every request that is not to 127.0.0.1/localhost and collects console errors. Checks the map, the chart
// toggles (the last line cannot be switched off), the date range (out-of-range dates are rejected), the readout
// values against data/processed (spot check table), the no-news state, touch target sizes and overflow at 390 px,
// the demo label, and runs axe at 1280 and 390 px. Writes docs/screenshots/mc-simple-1280.png and mc-simple-390.png.
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
const report = { blocked: [], consoleErrors: [], pageErrors: [], checks: [], spot: [], axe: {} };
let failed = false;

async function open(width, url = `${BASE}?race=tx-senate-2026`, touch = false) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, hasTouch: touch, isMobile: touch });
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

// ---------------------------------------------------------------- 1280 desktop, Texas
{
  const { ctx, page } = await open(1280);
  // layout: the map section, then directly the chart section; hidden views are not on the page
  const order = await page.evaluate(() => {
    const m = document.querySelector("#mapsec"), c = document.querySelector("#racesec");
    return { next: m?.nextElementSibling?.id, below: c.getBoundingClientRect().top >= m.getBoundingClientRect().bottom,
      hidden: ["#race-tabs", "#charts", "#m3charts", "#daily-table", "#export-daily", "table.lag", "#f-from", "#f-overlay"]
        .filter((s) => document.querySelector(s)) };
  });
  check("layout: chart section directly below the map section", JSON.stringify(order), "next racesec, below, no hidden views",
    order.next === "racesec" && order.below && order.hidden.length === 0);
  const race = await page.locator("#race").getAttribute("data-race");
  check("default race is Texas Senate", race, "tx-senate-2026", race === "tx-senate-2026");

  // map behavior kept (the M3 map checks)
  const mapStates = await page.$$eval("svg.usmap path.has-race", (ps) => ps.map((p) => p.getAttribute("data-state")).sort());
  const idxStates = [...new Set(Object.values(index.races).map((r) => r.state))].sort();
  check("map: every state with a race is a focusable button", mapStates.join(","), idxStates.join(","),
    JSON.stringify(mapStates) === JSON.stringify(idxStates));
  const txRow = (await page.locator('#map-table tr[data-race="tx-senate-2026"] td[data-k="value"]').innerText()).trim();
  const txTotal = index.races["tx-senate-2026"].metrics.attention_total;
  check("map table: TX total attention with n", txRow, `n=${txTotal.n_days} days`, txRow.includes(`n=${txTotal.n_days} days`));
  const hatched = await page.$$eval("svg.usmap path", (ps) => ps.filter((p) => p.getAttribute("fill") === "url(#hatch-insufficient)").length);
  check("map: states with no race are drawn as insufficient data", hatched, "> 0", hatched > 0);
  await page.selectOption("#f-metric", "attention_rho");
  const rhoRow = (await page.locator('#map-table tr[data-race="tx-senate-2026"] td[data-k="value"]').innerText()).trim();
  check("map metric filter still recolors the map and table", rhoRow, "rho ... n=... pairs", /rho .*n=\d+ pairs/.test(rhoRow));
  await page.selectOption("#f-metric", "attention_total");

  // status line and footer
  const dd = tx.series.display_daily;
  const n = dd.rows.filter((r) => r[NEWS] != null).length;
  const status = (await page.locator("#news-status").innerText()).trim();
  check("status line: live news N of M days", status, `News data: live, ${n} of ${dd.rows.length} days`,
    status === `News data: live, ${n} of ${dd.rows.length} days`);
  const foot = (await page.locator("#news-caveat").innerText()).replace(/\s+/g, " ").trim();
  const FOOT = "News counts come from Media Cloud sources only. Queries are still in draft. Timing alone does not show that one thing caused another.";
  check("footer line", foot, FOOT, foot === FOOT);
  const elabel = await page.locator('#chart g[data-mark="election"] text').textContent();
  check("election days shaded and labeled", elabel, "Election, Nov 3 and 4", elabel === "Election, Nov 3 and 4"
    && await page.locator('#chart g[data-mark="election"] rect').count() === 1);
  check("three lines and three axes by default", `${await lines(page)} | ${await axes(page)}`, "news,price,volume twice",
    await lines(page) === "news,price,volume" && await axes(page) === "news,price,volume");

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

  // toggles: off removes the line and its axis; on brings both back
  await page.locator("#tg-volume").uncheck();
  check("toggle volume off: line and axis gone", `${await lines(page)} | ${await axes(page)}`, "news,price | news,price",
    await lines(page) === "news,price" && await axes(page) === "news,price");
  await page.locator("#tg-volume").check();
  check("toggle volume on: line and axis back", `${await lines(page)} | ${await axes(page)}`, "news,price,volume",
    await lines(page) === "news,price,volume" && await axes(page) === "news,price,volume");
  await page.locator("#tg-price").uncheck();
  check("toggle price off: left axis gone", `${await lines(page)} | ${await axes(page)}`, "news,volume",
    await lines(page) === "news,volume" && await axes(page) === "news,volume");
  await page.locator("#tg-news").uncheck();
  const lastDisabled = await page.locator("#tg-volume").isDisabled();
  await page.locator('label[data-key="volume"]').click({ force: true });
  const note = await page.locator("#tg-note").innerText();
  check("last visible series cannot be switched off", `disabled ${lastDisabled}; checked ${await page.locator("#tg-volume").isChecked()}; lines ${await lines(page)}; note "${note}"`,
    "disabled, still checked, volume line drawn, note", lastDisabled && await page.locator("#tg-volume").isChecked()
      && await lines(page) === "volume" && note.includes("cannot be switched off"));
  await page.locator("#tg-price").check();
  await page.locator("#tg-news").check();
  // indexed mode: one shared 0 to 100 axis
  await page.locator('input[value="indexed"]').check();
  check("indexed mode: one shared axis, three lines", `${await lines(page)} | ${await axes(page)}`, "news,price,volume | index",
    await lines(page) === "news,price,volume" && await axes(page) === "index");
  await page.locator('input[value="own"]').check();

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
  await page.screenshot({ path: resolve(SHOTS, "mc-simple-1280.png"), fullPage: true });
  await axe(page, "1280 Texas");

  // keyboard on the map opens another race; the chart redraws for it (no news: toggle off and disabled, gaps kept)
  if (noNews) {
    const id = noNews.race.race_id;
    await page.locator(`svg.usmap path[data-state="${noNews.race.state}"]`).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction((rid) => document.querySelector("#race")?.getAttribute("data-race") === rid, id);
    const st = (await page.locator("#news-status").innerText()).trim();
    const nd = await page.locator("#tg-news").isDisabled(), nc = await page.locator("#tg-news").isChecked();
    check(`map Enter opens ${id}; no news: status, toggle off and disabled, price and volume drawn`,
      `${st} | disabled ${nd} checked ${nc} | lines ${await lines(page)}`, "No news data for this race yet",
      st.startsWith("No news data for this race yet") && nd && !nc && await lines(page) === "price,volume");
    const miss = noNews.series.display_daily.coverage.kalshi_price_close.missing_days;
    const segs = await page.$eval("#chart svg path.line-price", (p) => (p.getAttribute("d").match(/M/g) || []).length);
    check(`${id}: missing Kalshi days break the price line (not drawn as zero)`, `${segs} segment(s); missing ${miss.join(", ")}`,
      "more than one segment when a missing day is inside the window", miss.length === 0 || segs > 1);
    await axe(page, `1280 ${id}`);
    await page.locator('svg.usmap path[data-state="TX"]').click();
    await page.waitForFunction(() => document.querySelector("#race")?.getAttribute("data-race")?.startsWith("tx-"));
    check("back to Texas: news toggle on again", `${await page.locator("#tg-news").isChecked()} ${await lines(page)}`, "true news,price,volume",
      await page.locator("#tg-news").isChecked() && await lines(page) === "news,price,volume");
  }
  await ctx.close();
}

// ---------------------------------------------------------------- 390 phone (touch)
{
  const { ctx, page } = await open(390, `${BASE}?race=tx-senate-2026`, true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal page scroll at 390 px", overflow, "0", overflow <= 0);
  const small = await page.evaluate(() => [...document.querySelectorAll(
    "#racesec label.tg, #racesec input[type=date], #d-reset, #chart, #racesec .brushbox svg, #filters select, #race-type label")]
    .map((e) => { const r = e.getBoundingClientRect(); return { e: e.id || e.className || e.tagName, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((r) => r.w < 40 || r.h < 40));
  check("touch targets at least 40 px (toggles, scale, dates, Reset, chart, brush, filters)", JSON.stringify(small), "none smaller", small.length === 0);
  await page.locator("#chart").scrollIntoViewIfNeeded();
  const box = await page.locator("#chart svg rect.hit").boundingBox();
  await page.touchscreen.tap(box.x + box.width * 0.25, box.y + box.height / 2);
  const r = await readout(page);
  check("tap on the chart fills the readout row", JSON.stringify(r), "date and three values", r.date && r.price && r.volume && r.news);
  await page.screenshot({ path: resolve(SHOTS, "mc-simple-390.png"), fullPage: true });
  await axe(page, "390 Texas");
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
console.log(failed ? "VERIFY FAILED" : "VERIFY OK");
process.exit(failed ? 1 : 0);
