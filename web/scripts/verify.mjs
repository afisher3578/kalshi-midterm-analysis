// Offline render check for web/dist. Needs a running preview server (npm run preview).
// Blocks every request that is not to 127.0.0.1/localhost, collects console errors, takes screenshots,
// spot-checks numbers on the page against the JSON and runs axe.
// Usage: node scripts/verify.mjs [base url]   (CHROME_PATH may point at a Chromium binary)
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:4173/";
const ROOT = resolve(import.meta.dirname, "../..");
const SHOTS = resolve(ROOT, "docs/screenshots");
const data = JSON.parse(readFileSync(resolve(ROOT, "data/processed/tx-senate-2026.json"), "utf-8"));
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const report = { blocked: [], consoleErrors: [], pageErrors: [], requests: [], checks: [], axe: {} };
let failed = false;

async function open(width) {
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
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("body[data-ready=true]");
  await page.waitForSelector("#panel-att-0 svg");
  return { ctx, page };
}

function check(label, onPage, inJson, path, ok) {
  report.checks.push({ label, onPage, inJson, path, ok });
  if (!ok) failed = true;
}

// 1280 desktop
{
  const { ctx, page } = await open(1280);
  await page.screenshot({ path: resolve(SHOTS, "m1-texas-1280.png"), fullPage: true });

  // Spot check 1: lag cell, Wikipedia total vs volume surprise at lag +1.
  const cell = page.locator('table[data-outcome="volume_surprise"] tr[data-series="wikipedia/pageviews_total"] td[data-lag="1"]');
  const cellText = (await cell.innerText()).replace(/\s+/g, " ").trim();
  const jc = data.metrics.daily["wikipedia/pageviews_total"].outcomes.volume_surprise["1"];
  check("lag cell rho and n", cellText, `rho ${jc.rho}, n ${jc.n}`,
    'metrics.daily["wikipedia/pageviews_total"].outcomes.volume_surprise["1"]',
    cellText.includes(jc.rho.toFixed(2)) && cellText.includes(`n=${jc.n}`));

  // Spot check 2: daily close on 2026-10-05.
  const rowIdx = data.series.daily.rows.findIndex((r) => r[0] === "2026-10-05");
  const ci = data.series.daily.columns.indexOf("kalshi/price_close");
  const close = data.series.daily.rows[rowIdx][ci];
  const closeText = (await page.locator('#daily-table tr[data-date="2026-10-05"] td[data-col="kalshi/price_close"]').textContent()).trim();
  check("daily close 2026-10-05 (cents)", closeText, String(close),
    `series.daily.rows[${rowIdx}][${ci}] (date 2026-10-05, kalshi/price_close)`, Number(closeText) === Math.round(close * 1000) / 10);

  // Spot check 3: coverage and missing days of James_Talarico.
  const q = data.quality["wikipedia/pageviews/James_Talarico"];
  const panels = page.locator("figure.panel");
  let covText = "";
  for (let i = 0; i < await panels.count(); i++) {
    const t = await panels.nth(i).locator(".ptitle").innerText();
    if (t.includes("James Talarico")) {
      covText = (await panels.nth(i).locator('[data-k="coverage"]').innerText()) + " / " +
        (await panels.nth(i).locator('[data-k="missing"]').innerText());
    }
  }
  check("coverage, James_Talarico", covText.replace(/\s+/g, " "), `${q.coverage_days}/${q.window_days}, coverage ${q.coverage}, missing ${q.missing_days.length}`,
    'quality["wikipedia/pageviews/James_Talarico"]', covText.includes(`${q.coverage_days}/${q.window_days}`) &&
    (q.missing_days.length ? covText.includes(String(q.missing_days.length)) : covText.includes("None missing")));

  // Every panel shares the same x domain: compare pixel positions of the election rule across panels.
  const ruleX = await page.$$eval("figure.panel svg", (svgs) => svgs.map((s) => {
    const l = s.querySelector('g[data-mark="rule"] line');
    return l ? Math.round(l.getBoundingClientRect().left) : null;
  }));
  check("election rule at same x on every panel", JSON.stringify(ruleX), "same value", "n/a",
    ruleX.every((x) => x !== null && x === ruleX[0]));

  // Keyboard: the view toggle works from the keyboard.
  await page.locator('input[value="raw"]').focus();
  await page.keyboard.press("ArrowRight");
  const sel = await page.locator('input[name="view"]:checked').getAttribute("value");
  check("arrow key moves the view toggle", sel, "z", "n/a", sel === "z");
  await page.locator('input[value="surprise"]').check();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS, "m1-texas-1280-surprise.png"), fullPage: true });

  // Exports produce files without any network request.
  for (const id of ["export-daily", "export-hourly", "export-metrics"]) {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click(`#${id}`)]);
    const body = readFileSync(await dl.path(), "utf-8");
    check(`export ${id}`, `${dl.suggestedFilename()} ${body.length} bytes, first line: ${body.split("\n")[0].slice(0, 60)}`,
      "non-empty", "n/a", body.length > 100);
  }

  await page.locator('input[value="raw"]').check();
  await page.locator("#drawer summary").click();
  await page.locator("#drawer").screenshot({ path: resolve(SHOTS, "m1-texas-1280-drawer.png") });
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  report.axe["1280"] = axe.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`);
  await ctx.close();
}

// 390 phone
{
  const { ctx, page } = await open(390);
  await page.screenshot({ path: resolve(SHOTS, "m1-texas-390.png"), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal page scroll at 390 px", String(overflow), "0", "n/a", overflow <= 0);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  report.axe["390"] = axe.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`);
  await ctx.close();
}

await browser.close();
if (report.blocked.length || report.consoleErrors.length || report.pageErrors.length) failed = true;
if (Object.values(report.axe).some((v) => v.length)) failed = true;
report.requests = [...new Set(report.requests)];
console.log(JSON.stringify(report, null, 1));
console.log(failed ? "VERIFY FAILED" : "VERIFY OK");
process.exit(failed ? 1 : 0);
