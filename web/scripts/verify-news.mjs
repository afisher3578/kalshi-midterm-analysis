// Render checks for the News (Media Cloud) view. Needs two Python dashboard servers (they serve /local/):
//   node scripts/verify-news.mjs <live base url> <demo base url>
// `npm run verify` starts both itself (scripts/run-verify.mjs). Also serves web/dist with a plain static server
// (no /local/) to check the static build. Blocks every request that is not to 127.0.0.1, collects console errors,
// checks the empty state, the demo banners, three numbers against the JSON, axe at 390 and 1280, and saves
// docs/screenshots/mc-news-{empty,demo}-{1280,390}.png (full page).
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const [LIVE, DEMO] = process.argv.slice(2);
if (!LIVE || !DEMO) {
  console.error("usage: node scripts/verify-news.mjs <live base url> <demo base url> (or npm run verify)");
  process.exit(2);
}
const RACE = "tx-senate-2026";
const ROOT = resolve(import.meta.dirname, "../..");
const DIST = resolve(ROOT, "web/dist");
const SHOTS = resolve(ROOT, "docs/screenshots");
const tx = JSON.parse(readFileSync(resolve(ROOT, `data/processed/${RACE}.json`), "utf-8"));
mkdirSync(SHOTS, { recursive: true });

const report = { blocked: [], consoleErrors: [], pageErrors: [], requests: [], checks: [], axe: {} };
let failed = false;
function check(label, onPage, inJson, path, ok) {
  report.checks.push({ label, onPage, inJson, path, ok: !!ok });
  if (!ok) failed = true;
}
const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();

// the static build must not contain anything local or demo
const distFiles = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : distFiles.push(p.slice(DIST.length + 1)); } };
walk(DIST);
check("web/dist has no local dir and no demo or Media Cloud fixture file", JSON.stringify(distFiles), "no local/, no *demo*, no *.mediacloud.json",
  "web/dist", !existsSync(join(DIST, "local")) && !distFiles.some((f) => /demo|mediacloud\.json|^local\//.test(f)));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

async function open(width, url, ready = "#mc-charts figure") {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  const seen = [];
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(u.hostname) || u.protocol === "data:" || u.protocol === "blob:") {
      report.requests.push(u.pathname);
      seen.push(u.pathname);
      return route.continue();
    }
    report.blocked.push(route.request().url());
    return route.abort();
  });
  page.on("console", (m) => { if (m.type() === "error") report.consoleErrors.push(`${width}px ${url}: ${m.text()}`); });
  page.on("pageerror", (e) => report.pageErrors.push(`${width}px ${url}: ${e.message}`));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("body[data-ready=true]");
  await page.waitForSelector(ready);
  return { ctx, page, seen };
}

async function axe(page, key) {
  await page.evaluate(() => document.querySelectorAll("#race details").forEach((d) => { d.open = true; }));
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  report.axe[key] = r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s): ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Full-page screenshot; Chromium repeats content past about 16k device pixels, so tall pages use CSS-pixel scale. */
async function shot(page, name) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.screenshot({ path: resolve(SHOTS, name), fullPage: true, scale: h * 2 > 16000 ? "css" : "device" });
}

async function overflow(page, label) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`no horizontal page scroll at 390 px (${label})`, String(o), "0", "n/a", o <= 0);
}

const priceCents = (v) => (Math.round(v * 1000) / 10).toFixed(1);
// the same hours the page draws: candles ending after window start 00:00 UTC, up to the day after window end
const lo = Date.parse(tx.window.start + "T00:00:00Z"), hi = Date.parse(tx.window.end + "T00:00:00Z") + 86_400_000;
const hourly = tx.series.hourly.rows.filter((r) => r[1] !== null && Date.parse(r[0]) > lo && Date.parse(r[0]) <= hi);
const firstPrice = priceCents(hourly[0][1]), lastPrice = priceCents(hourly[hourly.length - 1][1]);
const qconf = await (await fetch(`${LIVE}local/mediacloud/${RACE}/query-config.json`)).json();
const realQueries = qconf.news_mediacloud.mediacloud.queries;

// ---------------------------------------------------------------- empty state (real data, no Media Cloud pull)
for (const width of [1280, 390]) {
  const { ctx, page } = await open(width, `${LIVE}?race=${RACE}&view=news`);
  const empty = norm(await page.locator("#mc-empty").innerText());
  const cmd = norm(await page.locator("#mc-run-cmd").innerText());
  check(`${width}: empty-state card with the run command`, `${empty.slice(0, 160)}... | ${cmd}`,
    `python -m raceattn run --race ${RACE} --sources ...news_mediacloud`, "skipped.news_mediacloud",
    empty.includes("No Media Cloud data has been pulled") && cmd.startsWith(`python -m raceattn run --race ${RACE} --sources `)
      && cmd.includes("news_mediacloud") && cmd.includes("kalshi") && empty.includes("MEDIACLOUD_API_KEY")
      && empty.includes("texas_local") && empty.includes(`python -m raceattn dashboard --race ${RACE}`));
  const keyLink = await page.locator('#mc-empty a[href="https://search.mediacloud.org"]').getAttribute("rel");
  check(`${width}: key link is a plain link`, keyLink, "noopener noreferrer", "n/a", keyLink === "noopener noreferrer");
  const state = norm(await page.locator('[data-k="mc-state"]').innerText());
  check(`${width}: status line says Not yet pulled`, state, "Not yet pulled", "n/a", state === "Not yet pulled");
  const hash = norm(await page.locator('[data-k="config-hash"]').textContent());
  check(`${width}: status line config hash from the query config`, hash, qconf.news_mediacloud.mediacloud.config_sha256,
    "query-config.json news_mediacloud.mediacloud.config_sha256", hash === qconf.news_mediacloud.mediacloud.config_sha256);
  const charts = await page.$$eval("#mc-charts > figure", (fs) => fs.map((f) => ({ id: f.id, text: f.querySelector("figcaption")?.textContent ?? "",
    svg: !!f.querySelector("svg"), box: !!f.querySelector(".empty-box") })));
  const newsCharts = charts.filter((c) => c.id !== "mc-chart3");
  check(`${width}: every news chart is a labeled empty panel`, JSON.stringify(newsCharts.map((c) => [c.id, norm(c.text).slice(0, 70)])),
    "mc-chart1, 2, 4, 5 say Empty", "n/a", newsCharts.length === 4 && newsCharts.every((c) => /Empty/.test(c.text) && (c.svg || c.box)));
  const c3 = norm(await page.locator("#mc-chart3-cap").innerText());
  check(`${width}: Chart 3 Kalshi price is real data (first and last hourly close, cents)`, c3, `first ${firstPrice}, last ${lastPrice}`,
    "series.hourly.rows[*][1] (kalshi/price_close)", c3.includes(`first ${firstPrice} cents`) && c3.includes(`last ${lastPrice} cents`));
  const subs = await page.locator("#mc-chart3 .subpanel svg").count();
  check(`${width}: Chart 3 has price, news (empty), Wikipedia and volume panels`, String(subs), "4", "n/a", subs === 4);
  const banners = await page.locator("[data-demo-banner]").count();
  check(`${width}: no demo banner without demo mode`, String(banners), "0", "n/a", banners === 0);
  const qs = await page.$$eval('#mc-drawer [data-query]', (ls) => ls.map((l) => ({ name: l.dataset.query, q: l.querySelector('[data-k="mc-query"]').textContent })));
  check(`${width}: drawer lists every query verbatim (7 plus any_either)`, `${qs.length} queries`, `${Object.keys(realQueries).length}`,
    "query-config.json news_mediacloud.mediacloud.queries", qs.length === 8 && qs.every((x) => realQueries[x.name]?.query === x.q));
  const prec = norm(await page.locator('[data-k="precision-empty"]').innerText());
  check(`${width}: precision tile says not coded yet`, prec, "not coded yet", "data/local audit", prec.includes("not coded yet"));
  const tiles = norm(await page.locator('[data-k="tiles-empty-national"]').innerText());
  check(`${width}: tiles say not yet pulled, not zeros`, tiles, "Not yet pulled", "n/a", tiles.startsWith("Not yet pulled"));
  if (width === 390) await overflow(page, "news, empty state");
  await axe(page, `${width} news empty`);
  await page.evaluate(() => document.querySelectorAll("#race details").forEach((d) => { d.open = false; }));
  await shot(page, `mc-news-empty-${width}.png`);
  if (width === 1280) {
    // the Overview tab still shows the race page with the values the existing checks use
    await page.locator('#race-tabs a[data-page="race"]').click();
    await page.waitForSelector("#panel-att-0 svg");
    const close = norm(await page.locator('#daily-table tr[data-date="2026-10-05"] td[data-col="kalshi/price_close"]').textContent());
    const c = tx.series.daily.rows.find((r) => r[0] === "2026-10-05")[tx.series.daily.columns.indexOf("kalshi/price_close")];
    check("Overview tab: TX daily close 2026-10-05 (cents)", close, String(c), "series.daily (2026-10-05, kalshi/price_close)",
      Number(close) === Math.round(c * 1000) / 10);
    const cell = norm(await page.locator('table[data-outcome="volume_surprise"] tr[data-series="wikipedia/pageviews_total"] td[data-lag="1"]').innerText());
    const jc = tx.metrics.daily["wikipedia/pageviews_total"].outcomes.volume_surprise["1"];
    check("Overview tab: TX lag cell rho and n", cell, `rho ${jc.rho}, n ${jc.n}`, 'metrics.daily["wikipedia/pageviews_total"].outcomes.volume_surprise["1"]',
      cell.includes(jc.rho.toFixed(2)) && cell.includes(`n=${jc.n}`));
    const url = new URL(page.url());
    check("Overview tab drops view=news from the URL; News tab link carries it", url.search,
      `race=${RACE}, no view`, "n/a", url.searchParams.get("view") === null
        && (await page.locator('#race-tabs a[data-page="news"]').getAttribute("href")).includes("view=news"));
  }
  await ctx.close();
}

// ---------------------------------------------------------------- demo mode
const fx = await (await fetch(`${DEMO}local/demo/${RACE}.mediacloud.json`)).json();
check("demo fixture is labeled", JSON.stringify({ s: fx._synthetic, n: fx._note }), "_synthetic true, DEMO DATA, not real", "fixture",
  fx._synthetic === true && fx._note === "DEMO DATA, not real");
// independent of src/news.ts: recompute three numbers from the fixture
const [a0, a1] = fx.queries.news_mediacloud.mediacloud.phases.analysis;
const col = (name) => { const i = fx.series.daily.columns.indexOf(name); return fx.series.daily.rows.filter((r) => r[0] >= a0 && r[0] <= a1).map((r) => [r[0], r[i]]); };
const either = col("news_mediacloud/race_either/national").filter(([, v]) => v !== null);
const total = either.reduce((s, [, v]) => s + v, 0);
const peak = either.reduce((b, x) => (x[1] > b[1] ? x : b));
const share = col("news_mediacloud/talarico_share/national").map(([, v]) => v).filter((v) => v !== null);
const meanShare = share.reduce((s, v) => s + v, 0) / share.length;

for (const width of [1280, 390]) {
  const { ctx, page } = await open(width, `${DEMO}?race=${RACE}&view=news&demo=1`, "#mc-charts figure svg");
  const totalOnPage = norm(await page.locator('[data-k="total-national"]').innerText());
  check(`${width}: demo total stories (race_either, national)`, totalOnPage, String(total),
    `fixture series.daily news_mediacloud/race_either/national, sum ${a0}..${a1}`, Number(totalOnPage.replace(/,/g, "")) === total);
  const peakOnPage = norm(await page.locator('[data-k="peak-national"]').innerText());
  const peakDate = norm(await page.locator('[data-k="peak-date-national"]').innerText());
  check(`${width}: demo peak day count and date`, `${peakOnPage} on ${peakDate}`, `${peak[1]} on ${peak[0]}`,
    "fixture series.daily news_mediacloud/race_either/national, max", Number(peakOnPage.replace(/,/g, "")) === peak[1] && peakDate === peak[0]);
  const shareOnPage = norm(await page.locator('[data-k="share-national"]').innerText());
  check(`${width}: demo mean Talarico share (national)`, shareOnPage, `${(meanShare * 100).toFixed(1)}% (n=${share.length})`,
    "fixture series.daily news_mediacloud/talarico_share/national, mean over defined days", shareOnPage === `${(meanShare * 100).toFixed(1)}%`);
  const groups = await page.$$eval("#mc-charts > figure, #mc-tiles .tilegroup, #mc-status, #mc-topdays, #mc-method, #mc-export", (els) =>
    els.map((e) => ({ id: e.id || e.querySelector("h4")?.id, banner: [...e.querySelectorAll("[data-demo-banner]")].some((b) =>
      b.textContent === "DEMO DATA, not real" && b.offsetParent !== null && !b.closest("[aria-hidden=true]")) })));
  check(`${width}: every chart, tile group and section shows the visible DEMO banner`, JSON.stringify(groups),
    "all true", "n/a", groups.length >= 12 && groups.every((g) => g.banner));
  const aria = await page.locator("#mc-tiles").ariaSnapshot();
  check(`${width}: the banner is in the accessibility tree`, `${(aria.match(/DEMO DATA, not real/g) ?? []).length} in the tiles snapshot`,
    ">= 3", "n/a", (aria.match(/DEMO DATA, not real/g) ?? []).length >= 3);
  const c3news = await page.locator("#mc-chart3 .subpanel").nth(1).locator("[data-demo-banner]").count();
  const c3 = norm(await page.locator("#mc-chart3-cap").innerText());
  check(`${width}: Chart 3 news panel labeled demo, Kalshi still real`, c3, `first ${firstPrice}, last ${lastPrice}; news panel banner`,
    "series.hourly (kalshi/price_close)", c3news === 1 && c3.includes(`first ${firstPrice} cents`) && c3.includes("DEMO"));
  const svgs = await page.$$eval("#mc-charts > figure", (fs) => fs.map((f) => `${f.id}:${f.querySelectorAll("svg").length}`));
  check(`${width}: demo draws every chart (5 figures, top sources bars)`, svgs.join(" "), "chart1..5 with svg", "n/a",
    svgs.length === 5 && svgs.every((s) => !s.endsWith(":0")));
  const links = await page.$$eval("#mc-top-table td.heads a", (as) => as.map((a) => ({ href: a.href, rel: a.rel, t: a.textContent })));
  check(`${width}: headlines table: synthetic, example.invalid, rel noopener noreferrer, local only`, `${links.length} links; ${links[0]?.href}`,
    "links to example.invalid", "fixture local.audit", links.length >= 10 && links.every((l) => l.href.startsWith("https://example.invalid/")
      && l.rel === "noopener noreferrer" && l.t.includes("synthetic")) && (await page.locator("#mc-topdays").innerText()).includes("local only, not published"));
  const prec = await page.$$eval("#mc-tiles [data-k^=precision-]", (e) => e.map((x) => x.textContent.trim()));
  check(`${width}: precision tiles from the (synthetic) audit`, prec.join(", "), "4 numbers", "fixture local.audit", prec.length === 4 && prec.every((p) => /^0\.\d{3}$|^1\.000$/.test(p)));
  if (width === 1280) {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#mc-export-csv").click()]);
    const csv = readFileSync(await dl.path(), "utf-8").trim().split("\n");
    check("CSV download: date plus every Media Cloud column, one row per day", `${csv.length - 1} rows, ${csv[0].split(",").length} columns`,
      `${fx.series.daily.rows.length} rows, ${fx.series.daily.columns.length} columns`, "fixture series.daily",
      csv.length - 1 === fx.series.daily.rows.length && csv[0].split(",").length === fx.series.daily.columns.length && csv[0].startsWith("date,"));
    const [dj] = await Promise.all([page.waitForEvent("download"), page.locator("#mc-export-json").click()]);
    const mj = JSON.parse(readFileSync(await dj.path(), "utf-8"));
    check("JSON download: tile values with definitions and n", JSON.stringify(mj.collections.national.total_stories).slice(0, 120),
      `total ${total}`, "fixture", mj.demo === true && mj.collections.national.total_stories.total === total && mj.definitions.talarico_share);
    await page.locator('input[name="mc-measure"][value="ratio"]').check();
    const r = norm(await page.locator("#mc-chart1-cap").innerText());
    check("Chart 1 toggle to ratio redraws with the ratio series", r.slice(0, 140), "mean ratio", "n/a", r.includes("mean ratio"));
    await page.locator('input[name="mc-measure"][value="count"]').check();
  }
  if (width === 390) await overflow(page, "news, demo");
  await axe(page, `${width} news demo`);
  await page.evaluate(() => document.querySelectorAll("#race details").forEach((d) => { d.open = false; }));
  await shot(page, `mc-news-demo-${width}.png`);
  await ctx.close();
}

// ---------------------------------------------------------------- static build (no Python server, no /local/)
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const stat = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const f = resolve(DIST, "." + (p === "/" ? "/index.html" : p));
  if (!f.startsWith(DIST) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((ok) => stat.listen(0, "127.0.0.1", ok));
{
  const base = `http://127.0.0.1:${stat.address().port}/`;
  const { ctx, page, seen } = await open(1280, `${base}?race=${RACE}&view=news&demo=1`);
  const txt = norm(await page.locator("#race").innerText());
  check("static build: news view renders, no /local/ request, says available when run locally", `${seen.filter((s) => s.startsWith("/local")).length} /local requests`,
    "0; empty state; available when run locally", "n/a", !seen.some((s) => s.startsWith("/local")) && txt.includes("No Media Cloud data has been pulled")
      && txt.includes("available when run locally") && txt.includes("Demo data is served only by the local dashboard server"));
  await ctx.close();
}
stat.close();

await browser.close();
if (report.blocked.length || report.consoleErrors.length || report.pageErrors.length) failed = true;
if (Object.values(report.axe).some((v) => v.length)) failed = true;
report.requests = [...new Set(report.requests)];
console.log(JSON.stringify(report, null, 1));
console.log(failed ? "VERIFY NEWS FAILED" : "VERIFY NEWS OK");
process.exit(failed ? 1 : 0);
