// The "News (Media Cloud)" view of a race: status line, datapoint tiles, five charts, the ten largest days, the
// method drawer and downloads. Numbers come from the race JSON (or, with ?demo=1 on the local server, the synthetic
// fixture) and, for precision and headlines, from the local audit file. The math is in news.ts.
import { format, utcFormat } from "d3";
import { attentionChart, dailyBarsChart, dayCenter, emptyChart, type Frame, hbarChart, type HourPoint, keptDomain,
  linesChart, priceChart, SERIES_COLORS } from "./charts";
import { analysisWindow, type AuditData, codedPhase, countTile, DEFAULT_COLLECTIONS, dailyRatio, dailyShare,
  hasMcData, headlinesByDay, type McBlock, mcColumns, meanOver, meanShare, newsCsv, newsMetrics, precision,
  PRECISION_RULE, seriesName, SHARE_RULE, topDays, valuesOn } from "./news";
import { el, esc, raceTitle } from "./race";
import type { Num, Quality, RaceData, Table } from "./types";
import { DAY_MS, excludedSpans, PRICE, utcMs, VOLUME } from "./transforms";

export const DEMO_TEXT = "DEMO DATA, not real";
const BANNER = `<p class="demo-banner" data-demo-banner>${DEMO_TEXT}</p>`;
const fmtInt = format(",.0f");
const fmt1 = format(",.1f");
const fmtPct = format(".1%");
const fmt3 = format(".3f");
const fmtDay = utcFormat("%b %-d");

// Limitations, from the "Unverified (needs the key)" list in docs/sources/mediacloud.md (checked 2026-11-11).
export const LIMITATIONS = [
  "The unit is a story in Media Cloud's source list, not a reader: outlets Media Cloud does not crawl are out and paywalled content is thin.",
  "Not confirmed until a keyed run: that collection 34412234 is \"United States - National\", and its source count.",
  "Not confirmed: whether a Texas state-and-local collection exists, its name, id and source count (texas_local has no id until `python -m raceattn mediacloud collections --state TX` runs with a key).",
  "Not confirmed: the grammar of article_title: searches (headline_either) and whether language:en is accepted inside q.",
  "Not confirmed: whether count-over-time returns ratio and total_count for every day, and whether it returns days with zero matches explicitly or leaves them out.",
  "Not confirmed: whether per-source daily counts exist (distinct sources per day) and whether top sources are available. Neither is built in the pipeline.",
  "Not confirmed: the timezone of publish_date (timezone_note: unverified in the config) and the API version.",
  "Not confirmed: the live response shapes of count-over-time, story-list and sources/collections, and which endpoints are limited to 2 requests a minute.",
  "Not confirmed: whether Media Cloud collapses syndicated wire copy (the audit reports a duplicate rate instead of assuming).",
];

export interface NewsModel {
  daily: Table;              // date plus the Media Cloud columns (race JSON, or the demo fixture)
  quality: Record<string, Quality>;
  block: McBlock | null;     // queries.news_mediacloud.mediacloud
  blockFrom: string;         // where the block came from, said on the page
  audit: AuditData | null;
  auditState: "loaded" | "static";   // static: no local server, so no audit file can be read
  demo: boolean;             // the demo fixture is in use
  demoProblem: string;       // ?demo=1 asked for but not available, with the reason
  server: string | null;     // "live" | "demo" | null (static build)
  lastPull: string;
  lastPullFrom: string;
  configMissing: boolean;    // the race has no Media Cloud query file
}

type GetJson = <T>(url: string) => Promise<T>;
interface QueryConfigResponse { _source: string; news_mediacloud: { mediacloud: McBlock } | null }
interface DemoFixture { _synthetic: boolean; _note: string; series: { daily: Table; meta: RaceData["series"]["meta"] };
  queries: { news_mediacloud: { mediacloud: McBlock } }; quality?: Record<string, Quality>; local: { audit: AuditData } }

/** The local server marks index.html with a meta tag; the static build has none, so it never requests /local/. */
export function localServer(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="raceattn-local-server"]')?.content ?? null;
}

export async function loadNewsModel(d: RaceData, demoRequested: boolean, getJson: GetJson): Promise<NewsModel> {
  const server = localServer();
  const rid = d.race.race_id;
  const realBlock = (d.queries.news_mediacloud as unknown as { mediacloud?: McBlock } | undefined)?.mediacloud ?? null;
  const m: NewsModel = { daily: d.series.daily, quality: d.quality, block: realBlock,
    blockFrom: realBlock ? "race JSON (queries.news_mediacloud.mediacloud)" : "", audit: null,
    auditState: server ? "loaded" : "static", demo: false, demoProblem: "", server, lastPull: "", lastPullFrom: "",
    configMissing: false };
  if (!m.block && server) {
    const q = await getJson<QueryConfigResponse>(`local/mediacloud/${rid}/query-config.json`);
    m.block = q.news_mediacloud?.mediacloud ?? null;
    m.blockFrom = m.block ? `local dashboard server (${q._source})` : "";
    m.configMissing = !m.block;
  }
  if (demoRequested && server === "demo") {
    const fx = await getJson<DemoFixture>(`local/demo/${rid}.mediacloud.json`);
    if (fx._synthetic && fx._note === "DEMO DATA, not real") {
      m.daily = fx.series.daily;
      m.quality = fx.quality ?? {};
      m.block = fx.queries.news_mediacloud.mediacloud;
      m.blockFrom = "demo fixture (the real queries from the config; collections and counts are synthetic)";
      m.audit = fx.local.audit;
      m.demo = true;
      m.lastPull = "none: demo fixture made in memory at server start";
      m.lastPullFrom = `race JSON generated_at ${d.generated_at} (Kalshi and Wikipedia)`;
    }
  } else if (demoRequested) {
    m.demoProblem = server ? "This dashboard server was started without --demo, so real data is shown. Restart it with "
      + "`python -m raceattn dashboard --race " + rid + " --demo`."
      : "Demo data is served only by the local dashboard server (`python -m raceattn dashboard --race " + rid + " --demo`), "
      + "so this page shows real data only.";
  }
  if (!m.demo) {
    if (server) m.audit = await getJson<AuditData>(`local/mediacloud/${rid}/audit.json`);
    const fetched = Object.entries(d.series.meta).filter(([s, x]) => s.startsWith("news_mediacloud/") && x.fetched_at)
      .map(([, x]) => x.fetched_at).sort();
    m.lastPull = fetched.length ? fetched[fetched.length - 1] : "never (no Media Cloud pull in this race JSON)";
    m.lastPullFrom = fetched.length ? "latest fetched_at of the Media Cloud series in the race JSON (series.meta)"
      : `race JSON generated_at ${d.generated_at}`;
  }
  return m;
}

function collectionsOf(m: NewsModel): string[] {
  return m.block?.collections ? Object.keys(m.block.collections) : DEFAULT_COLLECTIONS;
}

function hasSeries(t: Table, name: string): boolean {
  const i = t.columns.indexOf(name);
  return i >= 0 && t.rows.some((r) => r[i] !== null && r[i] !== undefined);
}

export class NewsView {
  width = 0;
  measure: "count" | "ratio" = "count";
  constructor(readonly root: HTMLElement, public data: RaceData, public model: NewsModel) {}

  get hasData(): boolean {
    return hasMcData(this.model.daily);
  }

  banner(): string {
    return this.model.demo ? BANNER : "";
  }

  /** Collections that have race_either counts, national first. */
  withData(): string[] {
    return collectionsOf(this.model).filter((c) => hasSeries(this.model.daily, seriesName("race_either", c)));
  }

  render() {
    const d = this.data, m = this.model;
    this.root.innerHTML = "";
    this.root.dataset.race = d.race.race_id;
    this.root.dataset.view = "news";
    this.root.dataset.demo = m.demo ? "true" : "false";
    const head = el("header", { class: "racehead" }, `<h2 id="race-h" class="racetitle">${esc(raceTitle(d))}: News (Media Cloud)</h2>
      <p class="lede">Daily counts of online news stories in Media Cloud collections that match the race queries
        (docs/mediacloud-search-criteria.md). The unit is a story, not a reader. All dates are UTC. The tool reports
        timing and association, not causation.</p>`);
    this.root.append(head);
    if (m.demo) {
      this.root.append(el("div", { class: "demo-top", id: "mc-demo-top", role: "note" }, `${BANNER}<p>Every Media Cloud
        number, chart, source name and headline below is synthetic, made by <code>raceattn.dashboard.demo_fixture</code>
        with <code>random.Random(1)</code> to exercise the page. The Kalshi and Wikipedia panels show real data.</p>`));
    }
    if (m.demoProblem) this.root.append(el("p", { class: "note", id: "mc-demo-problem", role: "note" }, esc(m.demoProblem)));
    if (!this.hasData && !m.demo) this.root.append(this.emptyCard());
    this.root.append(this.statusLine(), this.tiles(),
      el("section", { id: "mc-charts-sec", "aria-labelledby": "mc-charts-h" }, `<h3 id="mc-charts-h" class="sec">Charts</h3>
        <div id="mc-charts"></div>`),
      this.topDaysSection(), this.drawer(), this.exportSection());
    this.root.querySelector("#mc-export-csv")?.addEventListener("click", () =>
      download(`${d.race.race_id}-mediacloud-daily${m.demo ? "-DEMO" : ""}.csv`, newsCsv(m.daily, mcColumns(m.daily)), "text/csv"));
    this.root.querySelector("#mc-export-json")?.addEventListener("click", () =>
      download(`${d.race.race_id}-mediacloud-metrics${m.demo ? "-DEMO" : ""}.json`, JSON.stringify({
        _note: m.demo ? DEMO_TEXT : "computed in the page from the race JSON", race_id: d.race.race_id,
        ...newsMetrics(m.daily, collectionsOf(m), analysisWindow(m.block), m.audit, m.demo) }, null, 1) + "\n",
      "application/json"));
    this.width = 0;
  }

  emptyCard(): HTMLElement {
    const d = this.data, m = this.model;
    const reason = d.skipped?.news_mediacloud;
    const notConf = Object.entries(m.block?.collections ?? {}).filter(([, c]) => c.id === null);
    const sources = [...new Set([...d.sources, "news_mediacloud"])].join(",");
    const missing = [
      reason?.includes("missing key") ? `the API key: <code>MEDIACLOUD_API_KEY</code> is not set (race JSON
        <code>skipped.news_mediacloud</code>: "${esc(reason)}")` : reason ? `the pull: ${esc(reason)}` : "",
      notConf.length ? `collection${notConf.length > 1 ? "s" : ""} not configured (no id in
        <code>${esc(m.block?.path ?? "the query config")}</code>): ${notConf.map(([k]) => `<code>${esc(k)}</code>`).join(", ")}`
        : "",
      m.configMissing ? `a Media Cloud query config for this race (<code>config/queries/${esc(d.race.race_id)}.mediacloud.yaml</code>)` : "",
    ].filter(Boolean);
    return el("section", { class: "mc-empty", id: "mc-empty", "aria-labelledby": "mc-empty-h" }, `
      <h3 id="mc-empty-h">No Media Cloud data has been pulled for this race</h3>
      <p>Nothing below is estimated or filled in: the tiles and the news charts stay empty until a pull. The Kalshi and
        Wikipedia panels show their real data.</p>
      ${missing.length ? `<p>What is missing:</p><ul>${missing.map((x) => `<li>${x}</li>`).join("")}</ul>` : ""}
      <p>Steps:</p>
      <ol class="steps">
        <li>Get a free API key at <a href="https://search.mediacloud.org" rel="noopener noreferrer">https://search.mediacloud.org</a>
          (make an account, then copy the API key from your profile).</li>
        <li>Put <code>MEDIACLOUD_API_KEY=<span class="placeholder">...</span></code> in <code>.env</code> at the repo root (git-ignored, never printed).</li>
        <li>Run <code id="mc-run-cmd">python -m raceattn run --race ${esc(d.race.race_id)} --sources ${esc(sources)}</code>.
          The other sources come from the cache. Do not use <code>--sources news_mediacloud</code> on its own: the pipeline
          writes only the sources of the run, so the race JSON would lose its Kalshi and Wikipedia data.</li>
        <li>Restart <code>python -m raceattn dashboard --race ${esc(d.race.race_id)}</code>.</li>
      </ol>`);
  }

  statusLine(): HTMLElement {
    const m = this.model, b = m.block;
    const state = m.demo ? `<strong class="st-demo">${DEMO_TEXT}</strong>` : this.hasData ? "<strong>Live data</strong>"
      : "<strong>Not yet pulled</strong>";
    const colls = b ? Object.entries(b.collections).map(([k, c]) => `<li><code>${esc(k)}</code>: ${c.name ? esc(c.name)
      : "no name yet"}, id ${c.id ?? "none"} (${esc(c.id === null && !m.demo ? "not configured" : c.status)})</li>`).join("")
      : `<li>${m.server ? "no Media Cloud query config for this race" : "available when run locally (the query config is served by <code>python -m raceattn dashboard</code>)"}</li>`;
    const hash = b?.config_sha256 ?? "";
    return el("section", { id: "mc-status", "aria-labelledby": "mc-status-h", class: "mc-status" }, `
      <h3 id="mc-status-h" class="sec">Status</h3>${this.banner()}
      <dl class="facts">
        <div><dt>Media Cloud data</dt><dd data-k="mc-state">${state}</dd></div>
        <div><dt>Collections used</dt><dd><ul class="plain">${colls}</ul></dd></div>
        <div><dt>Query config</dt><dd>${b ? `version ${b.version}, status ${esc(b.status)}, config hash
          <details class="inline"><summary><code>${esc(hash.slice(0, 12))}</code><span class="vh"> (show the full hash)</span></summary>
          <code data-k="config-hash">${esc(hash)}</code></details> <span class="note">From the ${esc(m.blockFrom)}.</span>`
          : "available when run locally"}</dd></div>
        <div><dt>Last pull</dt><dd data-k="last-pull">${esc(m.lastPull)} <span class="note">(${esc(m.lastPullFrom)})</span></dd></div>
      </dl>`);
  }

  tiles(): HTMLElement {
    const m = this.model;
    const win = analysisWindow(m.block);
    const winText = `${win[0]} to ${win[1]}${m.block?.phases?.analysis ? " (analysis phase of the query config)" : " (default analysis window; the query config is not loaded)"}`;
    const sec = el("section", { id: "mc-tiles", "aria-labelledby": "mc-tiles-h" });
    const tile = (label: string, value: string, note: string, k: string) => `<div class="tile"><span class="tlabel">${esc(label)}</span>
      <span class="tval" data-k="${esc(k)}">${value}</span><span class="tnote">${note}</span></div>`;
    const groups = collectionsOf(m).map((c) => {
      const cn = m.block?.collections?.[c];
      const name = `${c}${cn?.name ? `: ${cn.name}` : ""}`;
      const hId = `mc-tg-${c}`;
      const either = seriesName("race_either", c);
      let body: string;
      if (!hasSeries(m.daily, either)) {
        const why = cn && cn.id === null && !m.demo ? "Not configured: no collection id in the query config, so nothing is requested (not a zero)."
          : "Not yet pulled: no Media Cloud counts in the data.";
        body = `<p class="note" data-k="tiles-empty-${esc(c)}">${esc(why)}</p>`;
      } else {
        const t = countTile(m.daily, either, win);
        const sh = meanShare(m.daily, c, win);
        const ds = seriesName("race_either", c, "distinct_sources");
        const dsm = m.daily.columns.includes(ds) ? meanOver(m.daily, ds, win) : null;
        const n = `n=${t.presentDays} of ${t.windowDays} days`;
        body = `<div class="tiles">
          ${tile("Total matching stories", t.total === null ? "no values" : fmtInt(t.total), `race_either, ${n}`, `total-${c}`)}
          ${tile("Mean per day", t.mean === null ? "no values" : fmt1(t.mean), `total / days with a value, ${n}`, `mean-${c}`)}
          ${tile("Peak day", t.peak ? `${fmtInt(t.peak.count)}` : "no values", t.peak ? `on <span data-k="peak-date-${esc(c)}">${t.peak.date}</span>` : "", `peak-${c}`)}
          ${tile("Days with zero stories", String(t.zeroDays), `explicit zeros from the API; missing days (no value, not counted as 0): <span data-k="missing-${esc(c)}">${t.missingDays}</span>${
            t.missingDates.length ? ` (${t.missingDates.slice(0, 6).join(", ")}${t.missingDates.length > 6 ? ", ..." : ""})` : ""}`, `zero-${c}`)}
          ${tile("Average Talarico share", sh.mean === null ? "undefined" : fmtPct(sh.mean),
            `mean of the daily share over the n=${sh.n} days where it is defined; ${sh.undefinedDays} day(s) undefined; from the ${sh.from}`, `share-${c}`)}
          ${tile("Distinct sources per day", dsm?.mean != null ? fmt1(dsm.mean) : "not available yet",
            dsm?.mean != null ? `mean over n=${dsm.n} days with a value` : "no per-source daily counts in the data (see the notes)", `sources-${c}`)}
        </div>`;
      }
      return `<section class="tilegroup" aria-labelledby="${hId}"><h4 id="${hId}">${esc(name)}</h4>${this.banner()}${body}</section>`;
    });
    sec.innerHTML = `<h3 id="mc-tiles-h" class="sec">Datapoints for the analysis window, ${esc(winText)}</h3>
      <p class="note">Talarico share rule: ${esc(SHARE_RULE)}.</p>${groups.join("")}${this.precisionGroup()}`;
    return sec;
  }

  precisionGroup(): string {
    const m = this.model;
    const coded = codedPhase(m.audit);
    let body: string;
    if (coded) {
      const rows = precision(coded.rows);
      body = `<p class="note">From the ${esc(coded.phase)} audit file <code>${esc(coded.path)}</code> (local only, not
        published). ${esc(PRECISION_RULE)}.</p><div class="tiles">${rows.map((r) => `<div class="tile"><span class="tlabel">${
        esc(r.query)} / ${esc(r.collection)}</span><span class="tval" data-k="precision-${esc(r.query)}-${esc(r.collection)}">${
        r.precision === null ? "not coded yet" : fmt3(r.precision)}</span><span class="tnote">${r.precision === null ? ""
        : `Wilson 95% ${fmt3(r.wilson95[0]!)} to ${fmt3(r.wilson95[1]!)}; `}n=${r.coded} coded (yes ${r.yes}, no ${r.no});
        ${r.unclear} unclear, ${r.uncoded} blank, ${r.invalid} invalid left out</span></div>`).join("")}</div>`;
    } else {
      const text = m.auditState === "static" ? "available when run locally (the audit file is read by the local dashboard server)"
        : m.audit?.available ? "not coded yet: the audit file has no row with relevant = yes or no"
          : "not coded yet: no audit file (python -m raceattn mediacloud audit writes data/local/mediacloud/audit/<race>/<phase>.csv)";
      body = `<p class="note" data-k="precision-empty">Precision: ${esc(text)}.</p>`;
    }
    return `<section class="tilegroup" aria-labelledby="mc-tg-precision"><h4 id="mc-tg-precision">Precision of the core
      queries (audit sample)</h4>${this.banner()}${body}</section>`;
  }

  frame(): Frame {
    const d = this.data;
    return { width: this.width, domain: [new Date(utcMs(d.window.start)), new Date(utcMs(d.window.end) + DAY_MS)],
      election: new Date(utcMs(d.race.election_date)), excluded: excludedSpans(d.excluded_days), events: [] };
  }

  draw(force = false) {
    const w = Math.floor(this.root.querySelector<HTMLElement>("#mc-charts")?.clientWidth ?? 0);
    if (w > 0 && (force || w !== this.width)) {
      this.width = w;
      this.drawCharts();
    }
  }

  drawCharts() {
    const m = this.model;
    const root = this.root.querySelector<HTMLElement>("#mc-charts")!;
    root.innerHTML = "";
    const frame = this.frame();
    const dates = m.daily.rows.map((r) => String(r[0]));
    const pts = (vals: Num[]) => dates.map((x, i) => ({ t: dayCenter(x), v: vals[i] }));
    const colls = this.withData();
    const main = colls[0];
    const empty = "No Media Cloud data pulled for this race yet";
    const marks = this.dateMarks();
    const sum = (vals: Num[]) => vals.reduce<number>((a, v) => a + (v ?? 0), 0);
    const nOf = (vals: Num[]) => vals.filter((v) => v !== null).length;

    // Chart 1: race_either per collection, count or ratio
    const toggle = `<fieldset class="toggle" id="mc-measure"><legend>Chart 1 shows</legend>${(["count", "ratio"] as const)
      .map((v) => `<label><input type="radio" name="mc-measure" value="${v}" ${v === this.measure ? "checked" : ""}>
      ${v === "count" ? "Raw story count" : "Normalized ratio (matching / all stories in the collection that day)"}</label>`).join("")}</fieldset>`;
    if (colls.length) {
      const kind = this.measure === "ratio" ? "ratio" : undefined;
      const lines = colls.map((c) => ({ label: `${c} race_either`, points: pts(valuesOn(m.daily, seriesName("race_either", c, kind), dates)) }));
      const text = lines.map((l, k) => {
        const v = l.points.map((p) => p.v);
        return `${k + 1} = ${l.label}: ${this.measure === "count" ? `total ${fmtInt(sum(v))} stories over ${nOf(v)} days`
          : `mean ratio ${format(".2~e")(sum(v) / Math.max(1, nOf(v)))} over ${nOf(v)} days`}`;
      }).join("; ");
      root.append(fig("mc-chart1", "Chart 1. Stories per day matching race_either, by collection", this.banner(),
        `${esc(text)}. ${marks}`, linesChart(frame, lines, { label: this.measure === "count" ? "Stories per day" : "Share of the collection's stories",
          aria: ["Chart 1: race_either stories per day by collection", `Line chart. ${text}. ${marks}`] }), toggle + legend(lines.map((l) => l.label))));
    } else {
      root.append(fig("mc-chart1", "Chart 1. Stories per day matching race_either, by collection", this.banner(),
        `Empty: ${empty}. ${marks}`, emptyChart(frame, empty, ["Chart 1: empty", `${empty}. ${marks}`]), toggle));
    }
    root.querySelectorAll<HTMLInputElement>('input[name="mc-measure"]').forEach((r) => r.addEventListener("change", () => {
      this.measure = r.value as "count" | "ratio";
      this.drawCharts();
      this.root.querySelector<HTMLInputElement>(`input[name="mc-measure"][value="${this.measure}"]`)?.focus();
    }));

    // Chart 2: talarico_race vs paxton_race, share beneath
    if (main && hasSeries(m.daily, seriesName("talarico_race", main))) {
      const t = valuesOn(m.daily, seriesName("talarico_race", main), dates), p = valuesOn(m.daily, seriesName("paxton_race", main), dates);
      const shareCol = seriesName("talarico_share", main);
      const share = m.daily.columns.includes(shareCol) ? valuesOn(m.daily, shareCol, dates) : dailyShare(t, p);
      const text = `${main}: talarico_race total ${fmtInt(sum(t))}, paxton_race total ${fmtInt(sum(p))} over the race window; daily
        Talarico share defined on ${nOf(share)} of ${dates.length} days`;
      const f = fig("mc-chart2", `Chart 2. Talarico vs Paxton race-context stories per day (${main})`, this.banner(), esc(text),
        linesChart(frame, [{ label: "talarico_race", points: pts(t) }, { label: "paxton_race", points: pts(p) }],
          { label: "Stories per day", aria: ["Chart 2: talarico_race and paxton_race per day", `Line chart. ${text}.`] }),
        legend(["talarico_race", "paxton_race"]));
      f.insertBefore(el("p", { class: "subtitle" }, "Talarico share = talarico_race / (talarico_race + paxton_race), same days; dashed line at 50%; blank where undefined"),
        f.querySelector(".pfoot"));
      f.insertBefore(linesChart(frame, [{ label: "Talarico share", points: pts(share) }], { label: "Talarico share", height: 170,
        domain: [0, 1], ref: 0.5, percent: true, aria: ["Chart 2, lower panel: Talarico share per day",
          `Line chart of the daily share, 0 to 100%, reference line at 50%. Defined on ${nOf(share)} days.`] }), f.querySelector(".pfoot"));
      root.append(f);
    } else {
      root.append(fig("mc-chart2", "Chart 2. Talarico vs Paxton race-context stories per day", this.banner(), `Empty: ${empty}.`,
        emptyChart(frame, empty, ["Chart 2: empty", empty]), ""));
    }

    // Chart 3: Kalshi price, news, Wikipedia, Kalshi daily volume as stacked panels on one time axis
    this.chart3(root, frame, dates, main, empty);

    // Chart 4: core vs broad
    if (main && hasSeries(m.daily, seriesName("any_either", main))) {
      const core = valuesOn(m.daily, seriesName("race_either", main), dates), broad = valuesOn(m.daily, seriesName("any_either", main), dates);
      const rc = seriesName("core_vs_broad", main);
      const ratio = m.daily.columns.includes(rc) ? valuesOn(m.daily, rc, dates) : dailyRatio(core, broad);
      const rv = ratio.filter((v): v is number => v !== null);
      const text = `${main}: race_either total ${fmtInt(sum(core))}, any_either total ${fmtInt(sum(broad))}; core_vs_broad
        mean ${rv.length ? fmt3(rv.reduce((a, b) => a + b, 0) / rv.length) : "undefined"} over ${rv.length} days`;
      const f = fig("mc-chart4", `Chart 4. Core vs broad queries (${main})`, this.banner(), esc(text),
        linesChart(frame, [{ label: "race_either (core)", points: pts(core) }, { label: "any_either (broad)", points: pts(broad) }],
          { label: "Stories per day", aria: ["Chart 4: core and broad queries per day", `Line chart. ${text}.`] }),
        legend(["race_either (core)", "any_either (broad)"]) + `<p class="meta">core_vs_broad = race_either / any_either per day:
          the share of name-mention stories that the race-context queries keep. A low value means the query choice matters a lot.</p>`);
      f.insertBefore(el("p", { class: "subtitle" }, "core_vs_broad ratio per day (0 to 1)"), f.querySelector(".pfoot"));
      f.insertBefore(linesChart(frame, [{ label: "core_vs_broad", points: pts(ratio) }], { label: "core / broad", height: 170,
        domain: [0, 1], fraction: true, aria: ["Chart 4, lower panel: core_vs_broad ratio", `Line chart, 0 to 1. ${text}.`] }), f.querySelector(".pfoot"));
      root.append(f);
    } else {
      root.append(fig("mc-chart4", "Chart 4. Core vs broad queries", this.banner(), `Empty: ${empty}.`,
        emptyChart(frame, empty, ["Chart 4: empty", empty]), ""));
    }

    // Chart 5: top sources
    const ts = m.block?.top_sources ?? {};
    const tsColls = Object.keys(ts).filter((c) => ts[c]?.sources?.length);
    const c5 = el("figure", { class: "panel", id: "mc-chart5", "aria-labelledby": "mc-chart5-cap" });
    c5.append(el("figcaption", { id: "mc-chart5-cap" }, `<span class="ptitle">Chart 5. Top sources over the analysis window</span>
      ${this.banner()}<span class="summary">${tsColls.length ? esc(tsColls.map((c) => `${c}: ${ts[c].sources.slice(0, 3)
        .map((s) => `${s.source} ${fmtInt(s.count)}`).join(", ")}`).join("; ")) : "Empty: no per-source counts in the data yet."}</span>`));
    if (tsColls.length) {
      for (const c of tsColls) {
        const t = ts[c];
        c5.append(el("p", { class: "subtitle" }, `${esc(c)}: ${esc(t.query)} stories per source, ${esc(t.start)} to ${esc(t.end)}${t.note ? ` (${esc(t.note)})` : ""}`));
        const rows = [...t.sources].sort((a, b) => b.count - a.count).map((s) => ({ label: s.source, count: s.count }));
        c5.append(hbarChart(Math.min(this.width, 900), rows, { label: "Stories", aria: [`Chart 5: top sources, ${c}`,
          `Horizontal bar chart. ${rows.map((r) => `${r.label} ${r.count}`).join("; ")}.`] }));
        c5.append(el("details", { class: "mc-values" }, `<summary>${esc(c)}: the values as a table</summary>
          <div class="table-scroll" role="region" aria-label="Top sources table, ${esc(c)}" tabindex="0">
          <table class="mc-small"><thead><tr><th scope="col">Source</th><th scope="col">Stories</th></tr></thead><tbody>${rows.map((r) =>
            `<tr><th scope="row">${esc(r.label)}</th><td>${fmtInt(r.count)}</td></tr>`).join("")}</tbody></table></div>`));
      }
    } else {
      c5.append(el("div", { class: "empty-box", role: "img", "aria-label": "Chart 5: empty, no per-source counts in the data" },
        `<p>No per-source counts in the data yet. The pipeline does not request them (it is not known whether the API offers
        them). Expected shape: <code>queries.news_mediacloud.mediacloud.top_sources.&lt;collection&gt;</code> =
        <code>{query, start, end, sources: [{source, count}]}</code>.</p>`));
    }
    root.append(c5);
  }

  chart3(root: HTMLElement, frame: Frame, dates: string[], main: string | undefined, empty: string) {
    const d = this.data, m = this.model;
    const lo = utcMs(d.window.start), hi = utcMs(d.window.end) + DAY_MS;
    const hourly: HourPoint[] = d.series.hourly.rows.map((r) => ({ t: new Date(String(r[0])),
      price: r[1] === null ? null : Number(r[1]), volume: r[2] === null ? null : Number(r[2]) }))
      .filter((h) => h.t.getTime() > lo && h.t.getTime() <= hi);
    const rdates = d.series.daily.rows.map((r) => String(r[0]));
    const vi = d.series.daily.columns.indexOf(VOLUME);
    const wiki = "wikipedia/pageviews_total";
    const wi = d.series.daily.columns.indexOf(wiki);
    const market = d.race.kalshi.followed_market;
    const prices = hourly.map((h) => h.price).filter((v): v is number => v !== null);
    const priceText = prices.length ? `first ${fmt1(prices[0] * 100)} cents, last ${fmt1(prices[prices.length - 1] * 100)} cents over ${hourly.length} hourly candles`
      : "no prices";
    const f = el("figure", { class: "panel", id: "mc-chart3", "aria-labelledby": "mc-chart3-cap" });
    f.append(el("figcaption", { id: "mc-chart3-cap" }, `<span class="ptitle">Chart 3. Kalshi price and news attention on one
      time axis</span><span class="summary">Stacked panels, not a dual axis. Kalshi ${esc(market)}: ${esc(priceText)}. ${this.model.demo
      ? "The news panel is DEMO data; the Kalshi and Wikipedia panels are real." : ""}</span>`));
    const sub = (title: string, svg: Element, extra = "") => {
      const s = el("div", { class: "subpanel" }, `<p class="subtitle">${title}</p>${extra}`);
      s.append(svg);
      f.append(s);
    };
    sub(`Kalshi ${esc(market)}: hourly close (real data)`, priceChart(frame, hourly, [`Kalshi ${market} hourly closing price`,
      `Line chart of the hourly Yes price in cents, ${priceText}.`]));
    if (main) {
      const v = valuesOn(m.daily, seriesName("race_either", main), dates);
      const rows = dates.map((x, i) => ({ t: dayCenter(x), v: v[i], kept: !d.excluded_days.includes(x) }));
      const text = `${main} race_either, total ${fmtInt(v.reduce<number>((a, b) => a + (b ?? 0), 0))} stories`;
      const dom = keptDomain(rows, true);
      const off = dom ? rows.filter((r) => r.v !== null && r.v > dom[1]).map((r) => `${fmtDay(r.t)} ${fmtInt(r.v!)}`) : [];
      sub(`News: ${esc(main)} race_either stories per day${m.demo ? "" : " (real data)"}${off.length ? `; above the scale
        (excluded days, triangles): ${esc(off.join(", "))}` : ""}`, attentionChart(frame, rows, {
        label: "Stories per day", unusable: false, zeroRule: false, domain: dom,
        aria: ["Chart 3, news panel", `Daily line chart, ${text}${m.demo ? ", DEMO DATA, not real" : ""}.`] }), this.banner());
    } else {
      sub("News: race_either stories per day", emptyChart(frame, empty, ["Chart 3, news panel: empty", empty], 120));
    }
    if (wi >= 0) {
      const v = d.series.daily.rows.map((r) => (r[wi] === null ? null : Number(r[wi])));
      const rows = rdates.map((x, i) => ({ t: dayCenter(x), v: v[i], kept: !d.excluded_days.includes(x) }));
      const dom = keptDomain(rows, true);
      const off = dom ? rows.filter((r) => r.v !== null && r.v > dom[1]).map((r) => `${fmtDay(r.t)} ${fmtInt(r.v!)}`) : [];
      sub(`Wikipedia pageviews, all pages summed (real data)${off.length ? `; above the scale (excluded days, triangles): ${
        esc(off.join(", "))}` : ""}`, attentionChart(frame, rows, { label: "Pageviews per day",
        unusable: d.quality[wiki]?.status === "unusable", zeroRule: false, domain: dom,
        aria: ["Chart 3, Wikipedia panel", `Daily line chart of Wikipedia pageviews, total ${fmtInt(v.reduce<number>((a, b) => a + (b ?? 0), 0))}.`] }));
    }
    if (vi >= 0) {
      const vol = d.series.daily.rows.map((r, i) => ({ date: rdates[i], v: r[vi] === null ? null : Number(r[vi]) }));
      const tot = vol.reduce<number>((a, x) => a + (x.v ?? 0), 0);
      sub("Kalshi volume: contracts per day (real data)", dailyBarsChart(frame, vol, { label: "Contracts per day",
        aria: ["Chart 3, Kalshi daily volume", `Bar chart, one bar per UTC day, total ${fmtInt(tot)} contracts.`] }));
    }
    f.append(el("div", { class: "pfoot" }, `<p class="meta">Kalshi price is the series and label of the race page
      (<code>${PRICE}</code>, hourly); daily volume is <code>${VOLUME}</code> from the daily table.</p>`));
    root.append(f);
  }

  /** Text naming the shaded and marked days, from the race JSON only. */
  dateMarks(): string {
    const d = this.data;
    const ex = excludedSpans(d.excluded_days).map((e) => (e.first === e.last ? e.first : `${e.first} to ${e.last}`)).join(", ");
    const r = d.race as unknown as Record<string, unknown>;
    const extra = ["primary_date", "runoff_date"].filter((k) => typeof r[k] === "string"
      && (r[k] as string) >= d.window.start && (r[k] as string) <= d.window.end).map((k) => `${k.replace("_date", "")} ${r[k]}`);
    return `Marked: election day ${d.race.election_date} (dashed line); shaded: ${ex || "none"} (excluded from the metrics).
      ${extra.length ? `Also in the window: ${extra.join(", ")}.` : "No primary or runoff date is in the race config or JSON, so none is marked."}`;
  }

  topDaysSection(): HTMLElement {
    const m = this.model;
    const win = analysisWindow(m.block);
    const colls = collectionsOf(m);
    const main = this.withData()[0] ?? "national";
    const top = topDays(m.daily, seriesName("race_either", main), win, 10);
    const heads = headlinesByDay(m.audit, top.map((t) => t.date));
    const anyHeads = [...heads.values()].some((l) => l.length);
    const sec = el("section", { id: "mc-topdays", "aria-labelledby": "mc-topdays-h" });
    const headNote = m.auditState === "static" ? "Sample headlines: available when run locally."
      : anyHeads ? `Sample headlines come from the audit file${m.demo ? " (synthetic, links go to example.invalid)" : ""}: local only, not published.`
        : "No sample headlines: no audit file or story listing under data/local for these days.";
    const cell = (c: string, date: string) => {
      const v = valuesOn(m.daily, seriesName("race_either", c), [date])[0];
      const conf = m.block?.collections?.[c];
      return v === null ? (conf && conf.id === null && !m.demo ? "not configured" : "missing") : fmtInt(v);
    };
    sec.innerHTML = `<h3 id="mc-topdays-h" class="sec">The ten largest days (race_either, ${esc(main)})</h3>${this.banner()}
      <p class="note">Analysis window ${esc(win[0])} to ${esc(win[1])}. ${esc(headNote)}</p>
      ${top.length ? `<div class="table-scroll" role="region" aria-labelledby="mc-topdays-cap" tabindex="0">
      <table class="mc-top" id="mc-top-table" aria-labelledby="mc-topdays-cap"><caption id="mc-topdays-cap">Ten largest days by
        race_either stories (${esc(main)}), with counts per collection</caption>
      <thead><tr><th scope="col">Rank</th><th scope="col">Date</th>${colls.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}
        <th scope="col">Sample headlines${anyHeads ? ` <span class="badge badge-none">local only, not published</span>` : ""}</th></tr></thead>
      <tbody>${top.map((t, k) => `<tr data-date="${t.date}"><td>${k + 1}</td><th scope="row">${t.date}</th>${colls.map((c) =>
        `<td>${cell(c, t.date)}</td>`).join("")}<td class="heads">${(heads.get(t.date) ?? []).length ? `<ul>${heads.get(t.date)!.map((h) =>
        `<li><a href="${esc(h.url)}" rel="noopener noreferrer">${esc(h.title)}</a> <span class="note">(${esc(h.source)}, ${esc(h.query)}, ${esc(h.collection)})</span></li>`).join("")}</ul>`
        : m.auditState === "static" ? "available when run locally" : "none"}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty-box" id="mc-topdays-empty"><p>Empty: no Media Cloud counts, so there are no largest days to list.</p></div>`}`;
    return sec;
  }

  drawer(): HTMLElement {
    const m = this.model, b = m.block;
    const sec = el("section", { id: "mc-method", "aria-labelledby": "mc-method-h" });
    if (!b) {
      sec.innerHTML = `<h3 id="mc-method-h" class="sec">Method</h3><details id="mc-drawer"><summary>How these numbers were made</summary>
        <div class="drawer"><p>The query config is not in the race JSON (the pipeline writes it when Media Cloud runs). ${m.server
        ? "This race has no Media Cloud query file." : "It is served by the local dashboard server: available when run locally."}</p>
        ${limitations()}</div></details>`;
      return sec;
    }
    const qs = Object.entries(b.queries ?? {});
    const derivedText = (name: string, x: Record<string, string>) => x.kind === "share" ? `${name} = ${x.numerator} / (${x.numerator} + ${x.other})`
      : x.kind === "exclusive_share" ? `${name} = (${x.numerator} - ${x.both}) / ((${x.numerator} - ${x.both}) + (${x.other} - ${x.both}))`
        : x.kind === "ratio" ? `${name} = ${x.numerator} / ${x.denominator}` : `${name}: ${JSON.stringify(x)}`;
    const log = (l: unknown[] | undefined) => (l && l.length ? `<ul>${l.map((x) => `<li><code>${esc(JSON.stringify(x))}</code></li>`).join("")}</ul>` : "<p>None yet.</p>");
    sec.innerHTML = `<h3 id="mc-method-h" class="sec">Method</h3>${this.banner()}<details id="mc-drawer"><summary>How these numbers were made</summary>
      <div class="drawer">
      <p>Source of this block: ${esc(m.blockFrom)}.</p>
      <h4>Query config</h4><p><code>${esc(b.path ?? "")}</code>, version ${b.version}, status ${esc(b.status)}, frozen on
        ${esc(b.frozen_on ?? "not frozen")}, language ${esc(b.language ?? "")}, platform <code>${esc(b.platform ?? "")}</code>, API
        version ${esc(b.api_version ?? "not recorded")}, publish-date timezone: ${esc(b.timezone_note ?? "not recorded")}. Config sha256
        <code>${esc(b.config_sha256)}</code>.</p>
      <h4>Collections</h4><div class="table-scroll" role="region" aria-labelledby="mc-coll-cap" tabindex="0"><table class="hashes">
        <caption id="mc-coll-cap">Collections</caption><thead><tr><th scope="col">Key</th><th scope="col">Name</th><th scope="col">Id</th>
        <th scope="col">Sources</th><th scope="col">Looked up on</th><th scope="col">Status</th></tr></thead><tbody>${Object.entries(b.collections)
        .map(([k, c]) => `<tr><th scope="row"><code>${esc(k)}</code></th><td>${esc(c.name ?? "none")}</td><td>${c.id ?? "none"}</td>
        <td>${c.source_count ?? "unknown"}</td><td>${esc(c.looked_up_on ?? "not yet")}</td><td>${esc(c.status)}</td></tr>`).join("")}</tbody></table></div>
      <h4>Phases (UTC dates, inclusive)</h4><ul>${Object.entries(b.phases).map(([k, [s, e]]) => `<li>${esc(k)}: ${esc(s)} to ${esc(e)}</li>`).join("")}</ul>
      <h4>Queries (${qs.length}), verbatim</h4><ul class="mc-queries">${qs.map(([name, q]) => `<li data-query="${esc(name)}"><strong>${esc(name)}</strong>
        (${esc(q.role)})<br><code data-k="mc-query">${esc(q.query)}</code><br><span class="note">sha256 <code>${esc(q.query_sha256)}</code>;
        ${Object.entries(q.collections).map(([ck, c]) => `${esc(ck)} (id ${c.collection_id ?? "none"}): ${esc(c.status)}`).join("; ")}</span></li>`).join("")}</ul>
      <h4>Derived series (per collection and day)</h4><ul>${Object.entries(b.derived ?? {}).map(([n, x]) => `<li><code>${esc(derivedText(n, x))}</code></li>`).join("")}
        <li>A zero denominator or a missing input gives no value (never 0); the reason is in <code>derived_nulls</code>.</li></ul>
      <h4>Zero and missing</h4><p>A date the API returns with count 0 is a real zero. A date it leaves out is missing and is not
        counted as 0. The tiles count them separately.</p>
      <h4>Exclusions log</h4>${log(b.exclusions_log)}
      <h4>Changes log</h4>${log(b.changes_log)}
      ${limitations()}
      </div></details>`;
    return sec;
  }

  exportSection(): HTMLElement {
    const m = this.model;
    const ok = this.hasData || m.demo;
    return el("section", { id: "mc-export", "aria-labelledby": "mc-export-h" }, `<h3 id="mc-export-h" class="sec">Download</h3>
      ${this.banner()}<p>Built in your browser from the data already loaded; no request is made.${ok ? "" : " Nothing to download until Media Cloud data is pulled."}</p>
      <div class="buttons">
        <button type="button" id="mc-export-csv" ${ok ? "" : "disabled"}>Download CSV: daily Media Cloud series (${mcColumns(m.daily).length} columns)</button>
        <button type="button" id="mc-export-json" ${ok ? "" : "disabled"}>Download JSON: tile values with definitions and n</button>
      </div>`);
  }
}

function limitations(): string {
  return `<h4>Limitations</h4><ul>${LIMITATIONS.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
}

function legend(labels: string[]): string {
  return `<ol class="serieslist">${labels.map((l, k) => `<li><span class="key" style="border-color:${
    SERIES_COLORS[k % SERIES_COLORS.length]}">${k + 1}</span> ${esc(l)}</li>`).join("")}</ol>`;
}

function fig(id: string, title: string, head: string, summary: string, svg: Element, foot: string) {
  const f = el("figure", { class: "panel", id, "aria-labelledby": `${id}-cap` });
  f.append(el("figcaption", { id: `${id}-cap` }, `<span class="ptitle">${esc(title)}</span> ${head}<span class="summary">${summary}</span>`), svg);
  f.append(el("div", { class: "pfoot" }, foot));
  return f;
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

