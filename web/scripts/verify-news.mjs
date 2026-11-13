// Render checks for the News (Media Cloud) view. Needs two Python dashboard servers (they serve /local/):
//   node scripts/verify-news.mjs <live base url> <demo base url>
// `npm run verify` starts both itself (scripts/run-verify.mjs). Also serves web/dist with a plain static server
// (no /local/) to check the static build. Blocks every request that is not to 127.0.0.1, collects console errors,
// checks the live Texas data (numbers against the JSON), the empty state on a race with no Media Cloud query config,
// the demo banners, axe at 390 and 1280, and saves docs/screenshots/mc-news-{empty,demo}-{1280,390}.png and
// mc-live-{1280,390}.png, mc-live-overview-1280.png (full page). The mc-live shots come from the static build, which
// has no /local/ and so no audit headlines; the script also checks that no audit title or URL is on those pages.
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
function firstLast(d) {
  const lo = Date.parse(d.window.start + "T00:00:00Z"), hi = Date.parse(d.window.end + "T00:00:00Z") + 86_400_000;
  const hourly = d.series.hourly.rows.filter((r) => r[1] !== null && Date.parse(r[0]) > lo && Date.parse(r[0]) <= hi);
  return [priceCents(hourly[0][1]), priceCents(hourly[hourly.length - 1][1])];
}
const [firstPrice, lastPrice] = firstLast(tx);
const qconf = await (await fetch(`${LIVE}local/mediacloud/${RACE}/query-config.json`)).json();
const mcConf = qconf.news_mediacloud.mediacloud;
const realQueries = mcConf.queries;
// titles and URLs of the local audit sample (git-ignored); none may appear on a page that is saved as a screenshot
const audit = await (await fetch(`${LIVE}local/mediacloud/${RACE}/audit.json`)).json();
const auditStrings = Object.values(audit.phases ?? {}).flatMap((ph) => ph.rows ?? []).flatMap((r) => [r.title, r.url])
  .map((x) => norm(x)).filter((x) => x.length >= 12);

// independent of src/news.ts: live numbers recomputed from the race JSON
const daily = tx.series.daily;
const colOf = (name) => { const i = daily.columns.indexOf(name); return daily.rows.map((r) => [r[0], r[i]]); };
const [an0, an1] = mcConf.phases.analysis;
const inAnalysis = (name) => colOf(name).filter(([d, v]) => d >= an0 && d <= an1 && v !== null);
const liveColls = Object.keys(mcConf.collections);
const liveTotal = Object.fromEntries(liveColls.map((c) => [c, inAnalysis(`news_mediacloud/race_either/${c}`).reduce((s, [, v]) => s + v, 0)]));
const livePeak = inAnalysis("news_mediacloud/race_either/national").reduce((b, x) => (x[1] > b[1] ? x : b));
const talaricoAll = colOf("news_mediacloud/talarico_race/national").reduce((s, [, v]) => s + (v ?? 0), 0);
const fmtInt = (n) => n.toLocaleString("en-US");

// the empty state is checked on a race with no Media Cloud query config
const EMPTY_RACE = "fl-senate-2026";
const emptyData = JSON.parse(readFileSync(resolve(ROOT, `data/processed/${EMPTY_RACE}.json`), "utf-8"));
const [emptyFirst, emptyLast] = firstLast(emptyData);
check(`${EMPTY_RACE} has no Media Cloud query config and no Media Cloud series`, String(existsSync(resolve(ROOT, `config/queries/${EMPTY_RACE}.mediacloud.yaml`))),
  "false", `config/queries/${EMPTY_RACE}.mediacloud.yaml`, !existsSync(resolve(ROOT, `config/queries/${EMPTY_RACE}.mediacloud.yaml`))
    && !emptyData.series.daily.columns.some((c) => c.startsWith("news_mediacloud/")));

// ---------------------------------------------------------------- live data (real server, Texas)
for (const width of [1280, 390]) {
  const { ctx, page } = await open(width, `${LIVE}?race=${RACE}&view=news`, "#mc-chart1 svg");
  const emptyCards = await page.locator("#mc-empty").count();
  check(`${width}: live data, no empty-state card`, String(emptyCards), "0", "series.daily news_mediacloud/*", emptyCards === 0);
  const banners = await page.locator("[data-demo-banner], #mc-demo-top").count();
  check(`${width}: no demo banner without demo mode`, String(banners), "0", "n/a", banners === 0);
  const state = norm(await page.locator('[data-k="mc-state"]').innerText());
  check(`${width}: status line says Live data`, state, "Live data", "n/a", state === "Live data");
  const hash = norm(await page.locator('[data-k="config-hash"]').textContent());
  check(`${width}: status line config hash from the query config`, hash, mcConf.config_sha256,
    "query-config.json news_mediacloud.mediacloud.config_sha256", hash === mcConf.config_sha256);
  const status = norm(await page.locator("#mc-status").innerText());
  check(`${width}: status lists every collection with its id, configured`, status.slice(0, 400),
    liveColls.map((c) => `${c} id ${mcConf.collections[c].id}`).join(", "), "query-config.json news_mediacloud.mediacloud.collections",
    liveColls.length === 2 && liveColls.every((c) => mcConf.collections[c].id !== null
      && status.includes(`${c}: `) && status.includes(`id ${mcConf.collections[c].id} (configured)`)));
  const qs = await page.$$eval('#mc-drawer [data-query]', (ls) => ls.map((l) => ({ name: l.dataset.query, q: l.querySelector('[data-k="mc-query"]').textContent })));
  check(`${width}: drawer lists every query verbatim (7 plus any_either)`, `${qs.length} queries`, `${Object.keys(realQueries).length}`,
    "query-config.json news_mediacloud.mediacloud.queries", qs.length === 8 && qs.every((x) => realQueries[x.name]?.query === x.q));
  // both collections drawn: Chart 1 has one line and one list entry per collection, and each has a tile group
  const c1 = await page.$$eval("#mc-chart1 .serieslist li", (ls) => ls.map((l) => l.textContent.replace(/\s+/g, " ").trim()));
  const c1lines = await page.locator('#mc-chart1 svg g[data-mark="line"] path, #mc-chart1 svg g[aria-label="line"] path').count();
  check(`${width}: Chart 1 draws both collections`, `${c1.join(" | ")}; ${c1lines} line paths`, liveColls.map((c) => `${c} race_either`).join(", "),
    "series.daily news_mediacloud/race_either/<collection>", c1.length === 2 && liveColls.every((c, k) => c1[k] === `${k + 1} ${c} race_either`) && c1lines >= 2);
  for (const c of liveColls) {
    const t = norm(await page.locator(`[data-k="total-${c}"]`).innerText());
    check(`${width}: total stories (race_either, ${c}, analysis phase)`, t, fmtInt(liveTotal[c]),
      `series.daily news_mediacloud/race_either/${c}, sum ${an0}..${an1}`, Number(t.replace(/,/g, "")) === liveTotal[c] && liveTotal[c] > 0);
    const src = norm(await page.locator(`[data-k="sources-${c}"]`).innerText());
    check(`${width}: distinct sources tile (${c}) says not available, not 0`, src, "not available yet", "no per-source series", src === "not available yet");
  }
  const peakOnPage = norm(await page.locator('[data-k="peak-national"]').innerText());
  const peakDate = norm(await page.locator('[data-k="peak-date-national"]').innerText());
  check(`${width}: peak day count and date (race_either, national)`, `${peakOnPage} on ${peakDate}`, `${livePeak[1]} on ${livePeak[0]}`,
    "series.daily news_mediacloud/race_either/national, max over the analysis phase", Number(peakOnPage.replace(/,/g, "")) === livePeak[1] && peakDate === livePeak[0]);
  const c2 = norm(await page.locator("#mc-chart2-cap").innerText());
  check(`${width}: Chart 2 talarico_race total (national, race window)`, c2.slice(0, 120), `talarico_race total ${fmtInt(talaricoAll)}`,
    "series.daily news_mediacloud/talarico_race/national, sum over every day", c2.includes(`talarico_race total ${fmtInt(talaricoAll)}`));
  const c5 = norm(await page.locator("#mc-chart5-cap").innerText());
  const c5svg = await page.locator("#mc-chart5 svg").count();
  check(`${width}: Chart 5 top sources says not available (empty panel, no bars)`, c5.slice(0, 120), "Empty: no per-source counts", "n/a",
    c5.includes("Empty: no per-source counts in the data yet") && c5svg === 0 && (await page.locator("#mc-chart5 .empty-box").count()) === 1);
  const c3 = norm(await page.locator("#mc-chart3-cap").innerText());
  check(`${width}: Chart 3 Kalshi price is real data (first and last hourly close, cents)`, c3, `first ${firstPrice}, last ${lastPrice}`,
    "series.hourly.rows[*][1] (kalshi/price_close)", c3.includes(`first ${firstPrice} cents`) && c3.includes(`last ${lastPrice} cents`));
  check(`${width}: Chart 5 empty state says the API offers per-source counts, not built yet`, norm(await page.locator("#mc-chart5 .empty-box").innerText()).slice(0, 160),
    "count-by-source-over-interval ... follow-up card", "n/a", await page.locator("#mc-chart5 .empty-box").innerText().then((t) =>
      t.includes("search/count-by-source-over-interval") && t.includes("follow-up card") && !t.includes("not known")));
  // Media Cloud days are publish dates with no timezone: the timezone_note from the race JSON, never "All dates are UTC"
  const tzNote = tx.queries.news_mediacloud.mediacloud.timezone_note;
  const dates = norm(await page.locator("#mc-dates").innerText());
  const newsText = await page.evaluate(() => { document.querySelectorAll("#race details").forEach((d) => { d.open = true; });
    return document.querySelector("#race").innerText; });
  check(`${width}: news view shows the timezone_note and does not say the dates are UTC`, dates, `Media Cloud dates: ${tzNote}.`,
    "queries.news_mediacloud.mediacloud.timezone_note", tzNote && dates === norm(`Media Cloud dates: ${tzNote}.`)
      && !/All (dates|times) are UTC/.test(newsText) && !newsText.includes("UTC dates, inclusive"));
  await page.evaluate(() => document.querySelectorAll("#race details").forEach((d) => { d.open = false; }));
  // both download labels fully visible: no clipped text, inside the viewport, the label as written
  const btns = await page.$$eval("#mc-export button", (bs) => bs.map((b) => { const r = b.getBoundingClientRect();
    return { t: b.textContent.trim(), clip: b.scrollWidth > b.clientWidth || b.scrollHeight > b.clientHeight, inView: r.left >= 0 && r.right <= innerWidth } }));
  check(`${width}: download buttons show their full labels`, JSON.stringify(btns), "2 buttons, no clipping, JSON label ends with sample sizes (n)", "n/a",
    btns.length === 2 && btns.every((b) => !b.clip && b.inView) && btns[1].t === "Download JSON: tile values with their definitions and sample sizes (n)");
  const prec = norm(await page.locator('[data-k="precision-empty"]').innerText());
  check(`${width}: precision tile says not coded yet`, prec, "not coded yet", "data/local audit", prec.includes("not coded yet"));
  // Limitations in the method drawer match the live API facts (docs/sources/mediacloud.md): nothing checked is called unconfirmed
  const lim = await page.$$eval("#mc-limitations li", (ls) => ls.map((l) => l.textContent.replace(/\s+/g, " ").trim()));
  const limText = lim.join(" | ");
  const stale = lim.filter((l) => /not confirmed/i.test(l) && /34412234|38381323|article_title|language:en|total_count|zero matches|texas/i.test(l));
  check(`${width}: Limitations state the checked facts and keep the open items`, `${lim.length} lines, ${stale.length} stale`,
    "collection ids and names from the query config; open: publish_date accuracy, per-source counts, syndication, not frozen, audit not coded, licensing",
    "query-config.json news_mediacloud.mediacloud (collections, version, status, frozen_on, api_version), race JSON licensing",
    stale.length === 0 && !/Not confirmed until a keyed run|has no id until/.test(limText)
      && liveColls.every((c) => limText.includes(`${c} is ${mcConf.collections[c].id} "${mcConf.collections[c].name}", ${mcConf.collections[c].source_count} sources`))
      && limText.includes(`Media Cloud API ${mcConf.api_version}`) && limText.includes("article_title: searches (headline_either) and language:en inside q work as drafted")
      && limText.includes("Whether that extraction is accurate is not confirmed") && limText.includes("a follow-up card builds them")
      && limText.includes("Syndicated copy is not collapsed") && limText.includes("22.5%")
      && limText.includes(`The queries are not frozen: version ${mcConf.version}, status ${mcConf.status}`) && mcConf.frozen_on === null
      && limText.includes("tuning audit is not coded") && tx.licensing.confirmed === false && limText.includes("licensing.confirmed is false"));
  if (width === 390) await overflow(page, "news, live data");
  await axe(page, `${width} news live`);
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

// ---------------------------------------------------------------- empty state (real server, race with no query config)
for (const width of [1280, 390]) {
  const { ctx, page } = await open(width, `${LIVE}?race=${EMPTY_RACE}&view=news`);
  const empty = norm(await page.locator("#mc-empty").innerText());
  const cmd = norm(await page.locator("#mc-run-cmd").innerText());
  check(`${width}: ${EMPTY_RACE} empty-state card with the run command`, `${empty.slice(0, 160)}... | ${cmd}`,
    `python -m raceattn run --race ${EMPTY_RACE} --sources ...news_mediacloud`, "skipped.news_mediacloud",
    empty.includes("No Media Cloud data has been pulled") && cmd.startsWith(`python -m raceattn run --race ${EMPTY_RACE} --sources `)
      && cmd.includes("news_mediacloud") && cmd.includes("kalshi") && empty.includes("MEDIACLOUD_API_KEY")
      && empty.includes(`config/queries/${EMPTY_RACE}.mediacloud.yaml`) && empty.includes(`python -m raceattn dashboard --race ${EMPTY_RACE}`));
  const keyLink = await page.locator('#mc-empty a[href="https://search.mediacloud.org"]').getAttribute("rel");
  check(`${width}: key link is a plain link`, keyLink, "noopener noreferrer", "n/a", keyLink === "noopener noreferrer");
  const state = norm(await page.locator('[data-k="mc-state"]').innerText());
  check(`${width}: ${EMPTY_RACE} status line says Not yet pulled`, state, "Not yet pulled", "n/a", state === "Not yet pulled");
  const status = norm(await page.locator("#mc-status").innerText());
  check(`${width}: ${EMPTY_RACE} status says there is no query config`, status.slice(0, 200), "no Media Cloud query config for this race", "n/a",
    status.includes("no Media Cloud query config for this race"));
  const charts = await page.$$eval("#mc-charts > figure", (fs) => fs.map((f) => ({ id: f.id, text: f.querySelector("figcaption")?.textContent ?? "",
    svg: !!f.querySelector("svg"), box: !!f.querySelector(".empty-box") })));
  const newsCharts = charts.filter((c) => c.id !== "mc-chart3");
  check(`${width}: every news chart is a labeled empty panel`, JSON.stringify(newsCharts.map((c) => [c.id, norm(c.text).slice(0, 70)])),
    "mc-chart1, 2, 4, 5 say Empty", "n/a", newsCharts.length === 4 && newsCharts.every((c) => /Empty/.test(c.text) && (c.svg || c.box)));
  const c3 = norm(await page.locator("#mc-chart3-cap").innerText());
  check(`${width}: ${EMPTY_RACE} Chart 3 Kalshi price is real data (first and last hourly close, cents)`, c3, `first ${emptyFirst}, last ${emptyLast}`,
    `${EMPTY_RACE} series.hourly.rows[*][1]`, c3.includes(`first ${emptyFirst} cents`) && c3.includes(`last ${emptyLast} cents`));
  const subs = await page.locator("#mc-chart3 .subpanel svg").count();
  check(`${width}: Chart 3 has price, news (empty), Wikipedia and volume panels`, String(subs), "4", "n/a", subs === 4);
  const banners = await page.locator("[data-demo-banner]").count();
  check(`${width}: no demo banner without demo mode (${EMPTY_RACE})`, String(banners), "0", "n/a", banners === 0);
  const tiles = norm(await page.locator('[data-k="tiles-empty-national"]').innerText());
  check(`${width}: tiles say not yet pulled, not zeros`, tiles, "Not yet pulled", "n/a", tiles.startsWith("Not yet pulled"));
  if (width === 390) await overflow(page, `news, empty state, ${EMPTY_RACE}`);
  await axe(page, `${width} news empty ${EMPTY_RACE}`);
  await page.evaluate(() => document.querySelectorAll("#race details").forEach((d) => { d.open = false; }));
  await shot(page, `mc-news-empty-${width}.png`);
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
    check("JSON download: tile values with their definitions and sample sizes (n)", JSON.stringify(mj.collections.national.total_stories).slice(0, 120),
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
  check("static build: news view renders the live data, no /local/ request, says available when run locally",
    `${seen.filter((s) => s.startsWith("/local")).length} /local requests`, "0; live data; available when run locally", "n/a",
    !seen.some((s) => s.startsWith("/local")) && (await page.locator("#mc-empty").count()) === 0
      && txt.includes("available when run locally") && txt.includes("Demo data is served only by the local dashboard server"));
  await ctx.close();
}
// screenshots of the live data for docs/: from the static build, so no audit headline can be on them
for (const width of [1280, 390]) {
  const base = `http://127.0.0.1:${stat.address().port}/`;
  const { ctx, page, seen } = await open(width, `${base}?race=${RACE}&view=news`, "#mc-chart1 svg");
  await page.evaluate(() => document.querySelectorAll("#race details").forEach((d) => { d.open = true; }));
  const txt = norm(await page.locator("body").innerText());
  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.href));
  const heads = await page.$$eval("#mc-top-table td.heads", (tds) => tds.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  const leaked = auditStrings.filter((x) => txt.includes(x) || hrefs.includes(x));
  check(`static ${width}: live news view, no headline links, no audit title or URL on the page (screenshot source)`,
    `${seen.filter((s) => s.startsWith("/local")).length} /local requests; ${heads.length} headline cells; ${leaked.length} of ${auditStrings.length} audit strings found`,
    "0 /local; every headline cell says available when run locally; 0 found", "data/local audit (via the live server)",
    !seen.some((s) => s.startsWith("/local")) && heads.length >= 10 && heads.every((h) => h === "available when run locally")
      && (await page.locator("#mc-top-table td.heads a").count()) === 0 && leaked.length === 0
      && norm(await page.locator('[data-k="mc-state"]').innerText()) === "Live data"
      && Number(norm(await page.locator('[data-k="total-national"]').innerText()).replace(/,/g, "")) === liveTotal.national);
  if (width === 390) await overflow(page, "news, live data, static build");
  await page.evaluate(() => document.querySelectorAll("#race details").forEach((d) => { d.open = false; }));
  await shot(page, `mc-live-${width}.png`);
  if (width === 1280) {
    await page.locator('#race-tabs a[data-page="race"]').click();
    await page.waitForSelector("#panel-att-0 svg");
    await page.waitForTimeout(300);
    const otxt = norm(await page.locator("body").innerText());
    const oleak = auditStrings.filter((x) => otxt.includes(x));
    check("static 1280: Overview tab, no audit title or URL on the page (screenshot source)", `${oleak.length} found`, "0", "n/a", oleak.length === 0);
    await shot(page, "mc-live-overview-1280.png");
  }
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
