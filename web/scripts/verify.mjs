// Offline render check for web/dist. Needs a running preview server (npm run preview).
// Blocks every request that is not to 127.0.0.1/localhost, collects console errors, takes screenshots,
// spot-checks numbers on the page against the JSON, switches the state and checks that every race fact changes,
// checks the no-data and unusable-source badges, and runs axe at 390 and 1280 px.
// Usage: node scripts/verify.mjs [base url]   (CHROME_PATH may point at a Chromium binary)
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

// Gated: these checks cover the race detail views, which are hidden while web/src/config.ts has SHOW_DETAILS = false.
// They are kept for when the views come back; scripts/verify-dashboard.mjs checks the page shown instead.
if (!/export const SHOW_DETAILS = true/.test(readFileSync(resolve(import.meta.dirname, "../src/config.ts"), "utf-8"))) {
  console.log("SKIPPED: SHOW_DETAILS is false in web/src/config.ts, so the race detail views are not on the page");
  process.exit(0);
}

const BASE = process.argv[2] ?? "http://127.0.0.1:4173/";
const ROOT = resolve(import.meta.dirname, "../..");
const SHOTS = resolve(ROOT, "docs/screenshots");
const PROCESSED = resolve(ROOT, "data/processed");
const load = (id) => JSON.parse(readFileSync(resolve(PROCESSED, `${id}.json`), "utf-8"));
const index = load("index");
const races = Object.fromEntries(readdirSync(PROCESSED).filter((n) => n.endsWith(".json") && n !== "index.json")
  .map((n) => [n.slice(0, -5), load(n.slice(0, -5))]));
const tx = races["tx-senate-2026"];
// the race the state-switch check opens: the first non-Texas race, alphabetically by state
const other = Object.values(index.races).filter((r) => r.race_id !== "tx-senate-2026").sort((a, b) => a.state.localeCompare(b.state))[0];
const od = races[other.race_id];
// a race with an unusable attention series (badge with reason) and one with a skipped source
const unusableRace = Object.values(races).find((d) => Object.values(d.quality).some((q) => q.status === "unusable"));
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const report = { blocked: [], consoleErrors: [], pageErrors: [], requests: [], checks: [], axe: {} };
let failed = false;

async function open(width, url = BASE) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(u.hostname) || u.protocol === "data:" || u.protocol === "blob:") {
      report.requests.push(u.pathname);
      return route.continue();
    }
    report.blocked.push(route.request().url());
    return route.abort();
  });
  page.on("console", (m) => { if (m.type() === "error") report.consoleErrors.push(`${width}px: ${m.text()}`); });
  page.on("pageerror", (e) => report.pageErrors.push(`${width}px: ${e.message}`));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("body[data-ready=true]");
  await page.waitForSelector("#panel-att-0 svg");
  return { ctx, page };
}

function check(label, onPage, inJson, path, ok) {
  report.checks.push({ label, onPage, inJson, path, ok: !!ok });
  if (!ok) failed = true;
}

async function axe(page, key) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  report.axe[key] = r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s): ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Every race fact that must change with the state: title, market, news query, Wikipedia pages, search terms,
 * a lag cell and a daily close. */
async function facts(page) {
  return page.evaluate(() => ({
    race: document.querySelector("#race")?.getAttribute("data-race"),
    title: document.querySelector("#race-h")?.textContent?.trim(),
    market: document.querySelector('[data-k="market"]')?.textContent?.trim(),
    news: document.querySelector("#news-query")?.textContent?.trim(),
    pages: document.querySelector("#wiki-pages")?.textContent?.trim(),
    terms: [...document.querySelectorAll('[data-k="terms"]')].map((e) => e.textContent.trim()).join(" | "),
    queries: [...document.querySelectorAll('[data-k="query"]')].map((e) => e.textContent.trim()),
    priceTitle: document.querySelector("#panel-price .ptitle")?.textContent?.trim(),
    panelTitles: [...document.querySelectorAll("#charts figure .ptitle")].map((e) => e.textContent.trim()),
    lag1: document.querySelector('table[data-outcome="volume_surprise"] tr[data-series="wikipedia/pageviews_total"] td[data-lag="1"]')?.textContent?.replace(/\s+/g, " ").trim(),
    close1005: document.querySelector('#daily-table tr[data-date="2026-10-05"] td[data-col="kalshi/price_close"]')?.textContent?.trim(),
    heat: document.querySelector("#chart-heatmap figcaption .summary")?.textContent?.replace(/\s+/g, " ").trim(),
  }));
}

function closeOn(d, date) {
  const i = d.series.daily.rows.findIndex((r) => r[0] === date);
  return d.series.daily.rows[i][d.series.daily.columns.indexOf("kalshi/price_close")];
}

// ---------------------------------------------------------------- 1280 desktop
{
  const { ctx, page } = await open(1280);
  // M1 spot checks still hold on the Texas view
  const cell = page.locator('table[data-outcome="volume_surprise"] tr[data-series="wikipedia/pageviews_total"] td[data-lag="1"]');
  const cellText = (await cell.innerText()).replace(/\s+/g, " ").trim();
  const jc = tx.metrics.daily["wikipedia/pageviews_total"].outcomes.volume_surprise["1"];
  check("TX lag cell rho and n", cellText, `rho ${jc.rho}, n ${jc.n}`,
    'metrics.daily["wikipedia/pageviews_total"].outcomes.volume_surprise["1"]',
    cellText.includes(jc.rho.toFixed(2)) && cellText.includes(`n=${jc.n}`));
  const c = closeOn(tx, "2026-10-05");
  const closeText = (await page.locator('#daily-table tr[data-date="2026-10-05"] td[data-col="kalshi/price_close"]').textContent()).trim();
  check("TX daily close 2026-10-05 (cents)", closeText, String(c), "series.daily (2026-10-05, kalshi/price_close)",
    Number(closeText) === Math.round(c * 1000) / 10);
  const ruleX = await page.$$eval("#charts figure.panel svg", (svgs) => svgs.map((s) => {
    const l = s.querySelector('g[data-mark="rule"] line');
    return l ? Math.round(l.getBoundingClientRect().left) : null;
  }));
  check("election rule at same x on every small-multiple panel", JSON.stringify(ruleX), "same value", "n/a",
    ruleX.length > 2 && ruleX.every((x) => x !== null && x === ruleX[0]));

  // map: one focusable state per race, each with its number and n in the table
  const mapStates = await page.$$eval("svg.usmap path.has-race", (ps) => ps.map((p) => p.getAttribute("data-state")));
  const idxStates = [...new Set(Object.values(index.races).map((r) => r.state))].sort();
  check("map: every state with a race is a focusable button", JSON.stringify(mapStates.sort()), JSON.stringify(idxStates),
    "index.json races[*].state", JSON.stringify(mapStates.sort()) === JSON.stringify(idxStates));
  const txRow = (await page.locator('#map-table tr[data-race="tx-senate-2026"] td[data-k="value"]').innerText()).trim();
  const txTotal = index.races["tx-senate-2026"].metrics.attention_total;
  check("map table: TX total attention with n", txRow, `${txTotal.value} views, n ${txTotal.n_days}`,
    'index.races["tx-senate-2026"].metrics.attention_total', txRow.includes(`n=${txTotal.n_days} days`) && txRow.startsWith("3.08M"));
  const hatched = await page.$$eval("svg.usmap path", (ps) => ps.filter((p) => p.getAttribute("fill") === "url(#hatch-insufficient)").length);
  check("map: states with no race are drawn as insufficient data", String(hatched), "> 0", "n/a", hatched > 0);
  // the rho metric: every number carries n; a state with n < 20 would read insufficient data
  await page.selectOption("#f-metric", "attention_rho");
  const rhoRow = (await page.locator('#map-table tr[data-race="tx-senate-2026"] td[data-k="value"]').innerText()).trim();
  check("map table: TX rho with n and lag", rhoRow, "rho 0.24 (n=56 pairs, lag 0)", 'index...metrics.attention_vs_volume',
    rhoRow.includes("rho 0.24") && rhoRow.includes("n=56 pairs"));
  const labels = await page.$$eval("svg.usmap text.stlabel", (ts) => ts.map((t) => t.textContent));
  check("map: every state label prints its value (not color only)", JSON.stringify(labels), "code + value", "n/a",
    labels.length === idxStates.length && labels.every((l) => /^[A-Z]{2}.+/.test(l)));
  await page.selectOption("#f-metric", "attention_total");
  await page.screenshot({ path: resolve(SHOTS, "m3-map-1280.png"), fullPage: false });
  await page.locator("#mapsec").screenshot({ path: resolve(SHOTS, "m3-map-1280.png") });
  await axe(page, "1280 Texas");

  // race-type switcher: Texas has a Senate and a Governor race; switching changes the race with the state fixed
  const txRaces = Object.values(index.races).filter((r) => r.state === "TX");
  if (txRaces.length > 1) {
    const gov = txRaces.find((r) => r.office === "governor");
    const radios = await page.locator('#race-type input[name="racetype"]').count();
    await page.locator(`#race-type input[value="${gov.race_id}"]`).check();
    await page.waitForFunction((id) => document.querySelector("#race")?.getAttribute("data-race") === id, gov.race_id);
    const gTitle = (await page.locator("#race-h").innerText()).trim();
    const gCard = (await page.locator('#nodata li[data-source="bluesky"]').innerText()).replace(/\s+/g, " ");
    check("race-type switcher: TX Senate -> TX Governor", `${radios} options; title ${gTitle}`, gov.race_id, "index races with state TX",
      radios === txRaces.length && gTitle === "Texas Governor 2026");
    check("no-data badge for a source left out by race_overrides", gCard, races[gov.race_id].skipped.bluesky, "skipped.bluesky",
      gCard.includes("left out by race_overrides") && gCard.includes(`--race ${gov.race_id} --sources bluesky`));
    await page.locator('#race-type input[value="tx-senate-2026"]').check();
    await page.waitForFunction(() => document.querySelector("#race")?.getAttribute("data-race") === "tx-senate-2026");
    await page.selectOption("#f-office", "governor");
    const govStates = await page.$$eval("svg.usmap path.has-race", (ps) => ps.map((p) => p.getAttribute("data-state")));
    check("race type filter: governor shows only states with a governor race", JSON.stringify(govStates),
      JSON.stringify(Object.values(index.races).filter((r) => r.office === "governor").map((r) => r.state)), "index", 
      govStates.length === Object.values(index.races).filter((r) => r.office === "governor").length);
    await page.selectOption("#f-office", "all");
    await page.locator('#race-type input[value="tx-senate-2026"]').check();
    await page.waitForFunction(() => document.querySelector("#race")?.getAttribute("data-race") === "tx-senate-2026");
  }

  // state switch: keyboard on the map (focus the state, press Enter), then compare every fact
  const before = await facts(page);
  await page.locator(`svg.usmap path[data-state="${other.state}"]`).focus();
  const focusVisible = await page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false);
  await page.keyboard.press("Enter");
  await page.waitForFunction((id) => document.querySelector("#race")?.getAttribute("data-race") === id, other.race_id);
  await page.waitForSelector("#panel-att-0 svg");
  const after = await facts(page);
  check("keyboard: map state focusable, Enter opens the race", `focus-visible ${focusVisible}, race ${after.race}`, other.race_id,
    "n/a", after.race === other.race_id);
  const changed = ["title", "market", "news", "pages", "terms", "priceTitle", "lag1", "close1005", "heat"].filter((k) => before[k] !== after[k]);
  // a request with no parameters (Kalshi /historical/cutoff) is global, not race-specific; every other must change
  const sameQueries = after.queries.filter((q) => before.queries.includes(q) && q.includes("?"));
  const globalQueries = after.queries.filter((q) => before.queries.includes(q) && !q.includes("?"));
  check(`state switch TX -> ${other.state}: every fact changes`, JSON.stringify({ before, after }, null, 0).slice(0, 900),
    `title, market, news query, pages, terms, price title, lag cell, close, heatmap all differ; no parameterized query string repeats (global endpoints that repeat: ${globalQueries.join(", ") || "none"})`,
    "n/a", changed.length === 9 && sameQueries.length === 0 && after.queries.length > 0);
  check(`${other.state}: title from the JSON`, after.title, `${od.race.state} ${od.race.office}`, "race", after.title.includes("Senate 2026"));
  check(`${other.state}: news query from the JSON`, after.news, od.race.news_query, "race.news_query", after.news === od.race.news_query);
  check(`${other.state}: market from the JSON`, after.market, od.race.kalshi.followed_market, "race.kalshi.followed_market",
    after.market === od.race.kalshi.followed_market);
  const oc = closeOn(od, "2026-10-05");
  check(`${other.state}: daily close 2026-10-05 (cents)`, after.close1005, String(oc), "series.daily",
    Number(after.close1005) === Math.round(oc * 1000) / 10);
  const oj = od.metrics.daily["wikipedia/pageviews_total"]?.outcomes?.volume_surprise?.["1"];
  check(`${other.state}: lag cell from the JSON`, after.lag1, oj ? `rho ${oj.rho}, n ${oj.n}` : "n/a", "metrics.daily...volume_surprise[1]",
    oj && (oj.rho === null ? after.lag1.includes(`n=${oj.n}`) : after.lag1.includes(oj.rho.toFixed(2)) && after.lag1.includes(`n=${oj.n}`)));
  const url = new URL(page.url());
  check("URL carries race and state", url.search, `race=${other.race_id}&state=${other.state}`, "n/a",
    url.searchParams.get("race") === other.race_id && url.searchParams.get("state") === other.state);
  // with another state open, a multi-race state is colored by its Senate race (office order), and the table lists every race
  const txIds = Object.values(index.races).filter((r) => r.state === "TX").map((r) => r.race_id).sort();
  const txFill = await page.locator('svg.usmap path[data-state="TX"]').getAttribute("data-race");
  const txRows = await page.$$eval('#map-table tr[data-state="TX"]', (trs) => trs.map((t) => `${t.dataset.race}${t.dataset.fill ? "*" : ""}`));
  const mapCap = (await page.locator("#map-caption").innerText()).replace(/\s+/g, " ");
  check(`${other.state} open: TX colored by its Senate race; table has one row per TX race; caption says so`,
    `fill ${txFill}; rows ${txRows.join(", ")}; caption ...${mapCap.slice(-160)}`, `fill tx-senate-2026; rows ${txIds.join(", ")}`,
    "index races with state TX", txFill === "tx-senate-2026" && JSON.stringify(txRows.map((r) => r.replace("*", "")).sort()) === JSON.stringify(txIds)
      && txRows.filter((r) => r.endsWith("*")).join() === "tx-senate-2026*" && mapCap.includes("Texas by Texas Senate 2026"));
  await page.screenshot({ path: resolve(SHOTS, `m3-race-${other.race_id}-1280.png`), fullPage: true });
  await axe(page, `1280 ${other.race_id}`);

  // filters: platform group, source, window and the event overlay change the panels with no reload
  const nAll = await page.locator("#charts figure[id^=panel-att]").count();
  await page.selectOption("#f-group", "talking");
  const nTalk = await page.locator("#charts figure[id^=panel-att]").count();
  const talkTitles = await page.$$eval("#charts figure[id^=panel-att] .ptitle", (e) => e.map((x) => x.textContent));
  check("platform filter: talking keeps only talking series", JSON.stringify(talkTitles), "Bluesky/X only", "n/a",
    nTalk < nAll && talkTitles.every((t) => /Bluesky|X posts|Reddit/.test(t)));
  await page.selectOption("#f-group", "all");
  await page.fill("#f-from", "2026-10-01");
  await page.locator("#f-from").dispatchEvent("change");
  const heatSub = (await page.locator("#chart-heatmap figcaption .summary").innerText()).replace(/\s+/g, " ");
  check("window filter recomputes the heatmap with a smaller n", heatSub, "2026-10-01 to 2026-11-04, n < full",
    "n/a", heatSub.includes("2026-10-01 to") && !heatSub.includes("(n=56)"));
  await page.fill("#f-from", od.window.start);
  await page.locator("#f-from").dispatchEvent("change");
  await page.check("#f-overlay");
  const ov = await page.locator("#panel-price figcaption").innerText();
  check("event overlay on: caption counts the events", ov.replace(/\s+/g, " ").slice(-160), "Event overlay on: N", "events_overlay",
    /Event overlay on: \d+ information event/.test(ov));
  await page.uncheck("#f-overlay");

  // badges: a skipped source shows the reason and the local command
  const card = page.locator('#nodata li[data-source="x"]');
  const cardText = (await card.innerText()).replace(/\s+/g, " ");
  check("no-data badge for X: reason, command and env var", cardText, od.skipped.x, "skipped.x",
    cardText.includes(od.skipped.x) && cardText.includes(`python -m raceattn run --race ${od.race.race_id} --sources x`)
      && cardText.includes("X_BEARER_TOKEN"));
  await ctx.close();
}

// unusable source badge
{
  if (!unusableRace) {
    check("a processed race has an unusable source", "none found", "at least one", "quality[*].status", false);
  } else {
    const rid = unusableRace.race.race_id;
    const { ctx, page } = await open(1280, `${BASE}?race=${rid}`);
    const [series, q] = Object.entries(unusableRace.quality).find(([, qq]) => qq.status === "unusable");
    const card = (await page.locator(`#nodata li[data-series="${series}"]`).innerText()).replace(/\s+/g, " ");
    check(`unusable badge for ${series} in ${rid}`, card, q.reasons.join("; "), `quality["${series}"]`,
      card.includes("Unusable") && card.includes(q.reasons[0]));
    const panelNote = (await page.locator('#charts [data-k="unusable"]').first().innerText()).replace(/\s+/g, " ");
    const svgCount = await page.locator("#charts figure svg").count();
    check(`unusable panel in ${rid} is drawn with its reason, not blank`, `${panelNote} (${svgCount} charts drawn)`, q.reasons[0],
      "n/a", panelNote.includes(q.reasons[0]) && svgCount > 2);
    const skippedNote = await page.locator("#lags-skipped").innerText().catch(() => "");
    check(`lag section in ${rid} says why its tables are left out`, skippedNote.replace(/\s+/g, " ").slice(0, 200), "reason",
      "metrics.daily[*].reason", skippedNote.includes("unusable or missing"));
    await axe(page, `1280 ${rid}`);
    await ctx.close();
  }
}

// ---------------------------------------------------------------- 390 phone
{
  const { ctx, page } = await open(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal page scroll at 390 px (map + Texas)", String(overflow), "0", "n/a", overflow <= 0);
  await page.locator("#mapsec").screenshot({ path: resolve(SHOTS, "m3-map-390.png") });
  await axe(page, "390 Texas");
  await page.selectOption("#f-state", other.state);
  await page.waitForFunction((id) => document.querySelector("#race")?.getAttribute("data-race") === id, other.race_id);
  await page.waitForSelector("#panel-att-0 svg");
  await page.waitForTimeout(300);
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`no horizontal page scroll at 390 px (${other.race_id}, opened from the state select)`, String(overflow2), "0", "n/a", overflow2 <= 0);
  await page.screenshot({ path: resolve(SHOTS, `m3-race-${other.race_id}-390.png`), fullPage: true });
  await axe(page, `390 ${other.race_id}`);
  await ctx.close();
}

await browser.close();
if (report.blocked.length || report.consoleErrors.length || report.pageErrors.length) failed = true;
if (Object.values(report.axe).some((v) => v.length)) failed = true;
report.requests = [...new Set(report.requests)];
console.log(JSON.stringify(report, null, 1));
console.log(failed ? "VERIFY FAILED" : "VERIFY OK");
process.exit(failed ? 1 : 0);
