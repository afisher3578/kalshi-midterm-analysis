import "./style.css";
import { format, utcFormat } from "d3";
import { DEFAULT_RACE, FUNDING_DISCLOSURE, MIN_PAIRS, PROJECT_NAME, SHOW_FUNDING_DISCLOSURE, SOURCE_CATALOG,
  SOURCE_NOTES } from "./config";
import { attentionChart, dayCenter, type DayPoint, type Frame, type HourPoint, keptDomain, priceChart, volumeChart }
  from "./charts";
import type { LagCell, Num, Quality, RaceData } from "./types";
import { attentionColumns, column, excludedSpans, extremes, metricsExport, PRICE, raceIdFromSearch, seriesLabel,
  toCsv, transform, utcMs, type View, VOLUME, xDomain } from "./transforms";

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const OUTCOMES: Record<string, { title: string; short: string }> = {
  volume_surprise: { title: "(a) Kalshi volume surprise", short: "volume surprise" },
  abs_price_change: { title: "(b) Absolute daily price change", short: "absolute price change" },
  price_change: { title: "(c) Signed daily price change", short: "signed price change" },
};
const VIEW_LABEL: Record<View, string> = { raw: "Raw", z: "z-score", surprise: "Surprise" };

const fmtDay = utcFormat("%b %-d");
const fmtHour = utcFormat("%b %-d %H:%M UTC");
const fmtInt = format(",.0f");
const fmt2 = format(".2f");
const fmtSi = format(".3~s");

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
function cents(p: number): string {
  return `${format(".1f")(p * 100)}¢`;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = "") {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.innerHTML = html;
  return e;
}

interface State {
  data: RaceData;
  view: View;
  width: number;
}

const app = document.getElementById("app")!;

async function main() {
  const raceId = raceIdFromSearch(location.search, DEFAULT_RACE);
  const url = `data/${raceId}.json`;
  let data: RaceData;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    app.innerHTML = `<main class="wrap"><h1>${esc(PROJECT_NAME)}</h1><p class="error" role="alert">Could not load
      <code>${esc(url)}</code> (${esc((e as Error).message)}). Build the site and serve <code>web/dist</code> over
      http (for example <code>npm run preview</code>); opening index.html from disk blocks fetch.</p></main>`;
    return;
  }
  document.title = `${raceTitle(data)} | ${PROJECT_NAME}`;
  const state: State = { data, view: "raw", width: 0 };
  renderShell(state);
  const charts = document.getElementById("charts")!;
  const draw = () => {
    const w = Math.floor(charts.clientWidth);
    if (w > 0 && w !== state.width) {
      state.width = w;
      renderCharts(state);
    }
  };
  new ResizeObserver(draw).observe(charts);
  draw();
  document.querySelectorAll<HTMLInputElement>('input[name="view"]').forEach((r) =>
    r.addEventListener("change", () => {
      state.view = r.value as View;
      renderCharts(state);
    }));
  document.body.dataset.ready = "true";
}

function raceTitle(d: RaceData): string {
  const office = d.race.office.charAt(0).toUpperCase() + d.race.office.slice(1);
  return `${STATES[d.race.state] ?? d.race.state} ${office} ${d.race.election_date.slice(0, 4)}`;
}

function renderShell(s: State) {
  const d = s.data;
  const att = attentionColumns(d);
  const ex = excludedSpans(d.excluded_days);
  app.innerHTML = "";
  const header = el("header", { class: "wrap head" }, `
    <p class="kicker">${esc(PROJECT_NAME)}: Kalshi market data next to attention data, on one UTC clock</p>
    <h1>${esc(raceTitle(d))}</h1>
    <dl class="facts">
      <div><dt>Window</dt><dd>${esc(d.window.start)} to ${esc(d.window.end)} (UTC, inclusive, ${d.window.days} days)</dd></div>
      <div><dt>Followed contract</dt><dd><code>${esc(d.race.kalshi.followed_market)}</code> (Kalshi event
        <code>${esc(d.race.kalshi.event)}</code>)</dd></div>
      <div><dt>Election day</dt><dd>${esc(d.race.election_date)}</dd></div>
      <div><dt>Excluded from metrics</dt><dd>${ex.map((e) => e.first === e.last ? esc(e.first)
        : `${esc(e.first)} to ${esc(e.last)}`).join(", ") || "none"} (election night; shaded on every chart)</dd></div>
    </dl>
    <p class="lede">Kalshi price and volume are hourly. Wikipedia pageviews are daily (drawn at noon UTC of each day).
      All times are UTC. The tool reports timing and association, not causation.</p>`);
  const main = el("main", { class: "wrap", id: "main" });
  main.append(
    el("section", { "aria-labelledby": "charts-h" }, `
      <h2 id="charts-h">Series</h2>
      <fieldset class="toggle">
        <legend>Attention panels show</legend>
        ${(["raw", "z", "surprise"] as View[]).map((v) => `<label><input type="radio" name="view" value="${v}"
          ${v === s.view ? "checked" : ""}> ${VIEW_LABEL[v]}</label>`).join("")}
        <p class="hint" id="view-hint"></p>
      </fieldset>
      <div id="charts"></div>`),
    lagSection(d, att),
    noDataSection(d),
    dailyTableSection(d, att),
    methodSection(d, att),
    exportSection(d),
  );
  app.append(header, main, footer(d));
  main.querySelector("#export-daily")!.addEventListener("click", () =>
    download(`${d.race.race_id}-daily.csv`, toCsv(d.series.daily), "text/csv"));
  main.querySelector("#export-hourly")!.addEventListener("click", () =>
    download(`${d.race.race_id}-hourly.csv`, toCsv(d.series.hourly), "text/csv"));
  main.querySelector("#export-metrics")!.addEventListener("click", () =>
    download(`${d.race.race_id}-metrics.json`, JSON.stringify(metricsExport(d), null, 1) + "\n", "application/json"));
}

function frameFor(s: State): Frame {
  const d = s.data;
  return {
    width: s.width,
    domain: xDomain(d),
    election: new Date(utcMs(d.race.election_date)),
    excluded: excludedSpans(d.excluded_days),
  };
}

function badge(q: Quality | undefined): string {
  const st = q?.status ?? "unusable";
  return `<span class="badge badge-${st}">Quality: ${st}</span>`;
}

function qualityLine(q: Quality | undefined): string {
  if (!q) return `<p class="qual">No quality record for this series.</p>`;
  const missing = q.missing_days.length ? `Missing days (${q.missing_days.length}): ${q.missing_days.join(", ")}`
    : "None missing";
  const reasons = q.reasons.length ? ` Reasons: ${esc(q.reasons.join("; "))}.` : "";
  return `<p class="qual">Coverage <span data-k="coverage">${q.coverage_days}/${q.window_days} days
    (${format(".0%")(q.coverage)})</span>. <span data-k="missing">${esc(missing)}</span>.
    Longest gap ${q.longest_gap} day${q.longest_gap === 1 ? "" : "s"}.${reasons}</p>`;
}

function figure(id: string, title: string, head: string, summary: string, svg: Element, foot: string) {
  const f = el("figure", { class: "panel", id, "aria-labelledby": `${id}-cap` });
  const cap = el("figcaption", { id: `${id}-cap` }, `<span class="ptitle">${esc(title)}</span> ${head}
    <span class="summary">${summary}</span>`);
  f.append(cap, svg, el("p", { class: "pfoot" }, foot));
  return f;
}

function renderCharts(s: State) {
  const d = s.data;
  const frame = frameFor(s);
  const root = document.getElementById("charts")!;
  root.innerHTML = "";
  const hourly: HourPoint[] = d.series.hourly.rows.map((r) => ({ t: new Date(String(r[0])),
    price: r[1] === null ? null : Number(r[1]), volume: r[2] === null ? null : Number(r[2]) }));
  const dates = d.series.daily.rows.map((r) => String(r[0]));
  const keep = d.series.daily.rows.map((r) => r[1] !== true);
  const sh = (name: string) => d.series.meta[name]?.query_hash ?? "n/a";

  // Price
  const pe = extremes(hourly.map((h) => h.price));
  const at = (i: number) => fmtHour(hourly[i].t);
  const pSum = pe.last ? `First close ${cents(hourly[0].price ?? 0)} (${at(0)}); last ${cents(pe.last.v)}
    (${at(pe.last.i)}); low ${cents(pe.min!.v)} (${at(pe.min!.i)}); high ${cents(pe.max!.v)} (${at(pe.max!.i)}).` : "No data.";
  const pq = d.quality[PRICE];
  const ffh = (pq?.extra?.forward_filled_hours as number | undefined) ?? 0;
  root.append(figure("panel-price", `Kalshi ${d.race.kalshi.followed_market}: hourly close`, badge(pq), pSum,
    priceChart(frame, hourly, [`Kalshi ${d.race.kalshi.followed_market} hourly closing price`,
      `Line chart of the hourly Yes price in cents. ${pSum.replace(/\s+/g, " ")}`]),
    `${qualityLine(pq)}<p class="meta">${hourly.length} hourly candles; ${ffh} hours with no trades carry the previous
      close forward. Query hash <code>${esc(sh(PRICE))}</code>.</p>`));

  // Volume
  const vols = hourly.map((h) => h.volume);
  const ve = extremes(vols);
  const total = vols.reduce<number>((a, v) => a + (v ?? 0), 0);
  const zeros = vols.filter((v) => v === 0).length;
  const vq = d.quality[VOLUME];
  const winHours = (vq?.extra?.window_hours as number | undefined) ?? hourly.length;
  const vSum = ve.max ? `Total ${fmtSi(total)} contracts (${fmtInt(total)}). Busiest hour ${fmtInt(ve.max.v)} contracts
    (hour ending ${at(ve.max.i)}). ${zeros} hours with zero volume; ${winHours - hourly.length} of ${winHours} window hours
    have no candle.` : "No data.";
  root.append(figure("panel-volume", "Kalshi volume: contracts per hour", badge(vq), vSum,
    volumeChart(frame, hourly, ["Kalshi hourly volume, symlog scale",
      `Bar chart, one bar per hour, symlog scale. ${vSum.replace(/\s+/g, " ")}`]),
    `${qualityLine(vq)}<p class="meta">Symlog scale: the axis is sign(x) ln(1 + |x|), so hours with zero volume sit on the
      baseline instead of dropping out. Bars span the hour that ends at the candle's end_period_ts. Query hash
      <code>${esc(sh(VOLUME))}</code>.</p>`));

  // Attention
  const hint = document.getElementById("view-hint")!;
  hint.textContent = "The y axis fits the days used in the metrics; election-night values above it are marked with a "
    + "triangle and printed in the caption. " + {
    raw: "Raw daily pageviews.",
    z: "z-score: (x - mean) / sd, mean and sample sd over the non-excluded days of the window. Excluded days use the same scale.",
    surprise: "Surprise: ln((x + 1) / (mean of the previous 7 days + 1)). Blank for the first 7 days and next to missing days.",
  }[s.view];
  attentionColumns(d).forEach((name, k) => {
    const q = d.quality[name];
    const unusable = !q || q.status === "unusable";
    const vals = transform(column(d.series.daily, name), keep, s.view);
    const rows: DayPoint[] = dates.map((dt, i) => ({ t: dayCenter(dt), v: vals[i], kept: keep[i] }));
    const domain = keptDomain(rows, s.view === "raw");
    const e = extremes(vals);
    const show = (v: number) => (s.view === "raw" ? fmtInt(v) : fmt2(v));
    const unit = s.view === "raw" ? " views" : "";
    const off = domain ? rows.filter((r) => r.v !== null && (r.v > domain[1] || r.v < domain[0])) : [];
    const summary = (e.max ? `${VIEW_LABEL[s.view]}: low ${show(e.min!.v)}${unit} (${fmtDay(rows[e.min!.i].t)}), high
      ${show(e.max.v)}${unit} (${fmtDay(rows[e.max.i].t)}), last ${show(e.last!.v)}${unit} (${fmtDay(rows[e.last!.i].t)}).`
      + (s.view === "raw" ? ` Total ${fmtInt(vals.reduce<number>((a, v) => a + (v ?? 0), 0))} views over ${e.count} days.` : "")
      : "No values to show.")
      + (off.length ? ` Off the chart's scale (excluded days, marked with a triangle): ${off.map((r) =>
        `${fmtDay(r.t)} ${show(r.v!)}`).join(", ")}.` : "");
    const label = { raw: "Pageviews per day", z: "z-score (sd units)", surprise: "Surprise, ln ratio" }[s.view];
    const title = seriesLabel(name);
    const reason = unusable ? (q?.reasons.join("; ") || "no data") : undefined;
    root.append(figure(`panel-att-${k}`, title, badge(q),
      (unusable ? `<span class="unusable-note">Unusable, left out of the lag tables: ${esc(reason)}.</span> ` : "") + summary,
      attentionChart(frame, rows, { label, unusable, zeroRule: s.view !== "raw", reason, domain,
        aria: [`${title}, ${VIEW_LABEL[s.view]} view`, `Daily line chart. ${summary.replace(/\s+/g, " ")}`] }),
      `${qualityLine(q)}<p class="meta">Series <code>${esc(name)}</code>, query hash <code>${esc(sh(name))}</code>.</p>`));
  });
}

function lagCell(c: LagCell | undefined, band: Num): string {
  if (!c) return `<td class="blank">not computed</td>`;
  if (c.n < MIN_PAIRS) return `<td class="blank" data-rho="" data-n="${c.n}">blank: n&lt;${MIN_PAIRS}<span class="n">n=${c.n}</span></td>`;
  if (c.rho === null) return `<td class="blank" data-rho="" data-n="${c.n}">no variance<span class="n">n=${c.n}</span></td>`;
  const out = band !== null && Math.abs(c.rho) > band;
  return `<td class="${out ? "out" : ""}" data-rho="${c.rho}" data-n="${c.n}"><span class="rho">${fmt2(c.rho)}</span>${out
    ? '<span class="vh"> (outside the noise band)</span><span aria-hidden="true">*</span>' : ""}<span class="n">n=${c.n}</span></td>`;
}

function lagSection(d: RaceData, att: string[]): HTMLElement {
  const entries = att.map((a) => d.metrics.daily[a]).filter(Boolean);
  const computed = entries.filter((e) => e.status === "computed");
  const skipped = entries.filter((e) => e.status !== "computed");
  const lags = computed[0]?.lags ?? [-2, -1, 0, 1, 2];
  const sec = el("section", { "aria-labelledby": "lags-h", id: "lags" });
  let html = `<h2 id="lags-h">Lag tables: attention surprise vs Kalshi, daily</h2>
    <p>Spearman rho between each attention series' daily surprise and the outcome, with the outcome shifted by the lag.
    <strong>Lag above 0 means the outcome is measured after the attention</strong> (lag +1: attention on day t, outcome on
    day t+1). Election night is excluded on both sides. Each cell shows rho to 2 decimals and n, the number of day
    pairs. Cells with fewer than ${MIN_PAIRS} pairs are blank. A * marks |rho| above the row's noise band.</p>`;
  for (const [okey, o] of Object.entries(OUTCOMES)) {
    if (!computed.some((e) => e.outcomes?.[okey])) continue;
    html += `<h3 class="tcap" id="cap-${okey}">${esc(o.title)}: Spearman rho of attention surprise vs
      ${esc(o.short)}</h3><div class="table-scroll" role="region" aria-labelledby="cap-${okey}" tabindex="0">
      <table class="lag" data-outcome="${okey}" aria-labelledby="cap-${okey}">
      <thead><tr><th scope="col">Attention series</th>${lags.map((l) => `<th scope="col">Lag ${signed(l)} d</th>`).join("")}
      <th scope="col">Noise band</th></tr></thead><tbody>`;
    for (const e of computed) {
      const cells = e.outcomes?.[okey] ?? {};
      const band = e.noise_band ?? null;
      html += `<tr data-series="${esc(e.attention_series)}"><th scope="row">${esc(seriesLabel(e.attention_series))}
        <span class="badge badge-${e.quality_status}">${e.quality_status}</span></th>
        ${lags.map((l) => lagCell(cells[String(l)], band).replace("<td", `<td data-lag="${l}"`)).join("")}
        <td class="band">${band === null ? "n/a" : `&plusmn;${fmt2(band)}`}<span class="n">2/sqrt(${e.noise_band_n})</span></td></tr>`;
    }
    html += `</tbody></table></div>`;
  }
  const nb = computed[0];
  html += `<p class="note">Noise band: about 2/sqrt(n)${nb?.noise_band != null ? `, here &plusmn;${fmt2(nb.noise_band)} at
    n=${nb.noise_band_n}` : ""}. Daily series are autocorrelated, so the effective n is smaller and this band is
    generous: a rho just outside it is weak evidence. The tool reports timing and association, not causation.</p>`;
  if (skipped.length) {
    html += `<p class="note">Left out of the lag tables: ${skipped.map((e) => `${esc(seriesLabel(e.attention_series))}
      (${esc(e.reason ?? "skipped")})`).join("; ")}.</p>`;
  }
  if (!computed.length) html += `<p class="note">No lag table could be computed for this race.</p>`;
  html += `<p class="note">Hourly lag tables: ${esc(d.metrics.hourly_note ?? "none")}.</p>`;
  sec.innerHTML = html;
  return sec;
}

function noDataSection(d: RaceData): HTMLElement {
  const r = d.race;
  const applies = (n: string) => (n === "entities" ? r.entities.length > 0 : n === "news_query" ? !!r.news_query
    : (r.subreddits ?? []).length > 0);
  const missing = SOURCE_CATALOG.filter((c) => applies(c.needs) && !d.sources.includes(c.id));
  const sec = el("section", { "aria-labelledby": "nodata-h", id: "nodata" });
  sec.innerHTML = `<h2 id="nodata-h">Sources with no cached data</h2>
    <p>The race config implies these sources, but this file has no data for them. Nothing is estimated or filled in.
    Run them locally with your own keys (keys stay in your shell or a git-ignored <code>.env</code>).</p>
    <ul class="cards">${missing.map((c) => `<li class="card" data-source="${esc(c.id)}"><h3>No cached data for
      ${esc(c.label)}</h3><p>Channel: ${esc(c.channel)}. Connector planned for ${esc(c.milestone)}.</p>
      <p>Run: <code>python -m raceattn run --race ${esc(r.race_id)} --sources ${esc(c.id)}</code></p>
      <p>Needs: ${c.env.length ? c.env.map((k) => `<code>${esc(k)}</code>`).join(" and ") : "no key"}${c.envNote
        ? ` (${esc(c.envNote)})` : ""}.</p></li>`).join("")}</ul>`;
  return sec;
}

function dailyTableSection(d: RaceData, att: string[]): HTMLElement {
  const t = d.series.daily;
  const idx = (c: string) => t.columns.indexOf(c);
  const sec = el("section", { "aria-labelledby": "daily-h" });
  const cell = (v: unknown, f: (n: number) => string) => (v === null || v === undefined ? "missing" : f(Number(v)));
  sec.innerHTML = `<h2 id="daily-h">Daily values</h2>
    <details><summary>Show every daily value behind the charts (${t.rows.length} days)</summary>
    <p class="tcap" id="daily-cap">Daily aligned table (UTC dates). Price is the last hourly close of the day in cents;
    volume is the sum of the day's hourly volume.</p>
    <div class="table-scroll" role="region" aria-labelledby="daily-cap" tabindex="0"><table class="daily" id="daily-table"
      aria-labelledby="daily-cap">
    <thead><tr><th scope="col">Date</th><th scope="col">Excluded</th><th scope="col">Close (cents)</th>
    <th scope="col">Volume</th>${att.map((a) => `<th scope="col">${esc(seriesLabel(a).replace("Wikipedia: ", ""))}</th>`).join("")}
    </tr></thead><tbody>${t.rows.map((r) => `<tr data-date="${esc(r[0])}"><th scope="row">${esc(r[0])}</th>
      <td>${r[1] ? "yes" : ""}</td><td data-col="${PRICE}">${cell(r[idx(PRICE)], (p) => format(".1f")(p * 100))}</td>
      <td>${cell(r[idx(VOLUME)], fmtInt)}</td>${att.map((a) => `<td>${cell(r[idx(a)], fmtInt)}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div></details>`;
  return sec;
}

function methodSection(d: RaceData, att: string[]): HTMLElement {
  const sec = el("section", { "aria-labelledby": "method-h", id: "method" });
  const series = [PRICE, VOLUME, ...att];
  const hashRows = series.map((s) => {
    const m = d.series.meta[s];
    const conn = m ? d.queries[m.source]?.query_hash : undefined;
    return `<tr><th scope="row"><code>${esc(s)}</code></th><td><code>${esc(m?.query_hash ?? "n/a")}</code></td>
      <td><code>${esc(conn ?? "n/a")}</code></td><td>${esc(d.quality[s]?.status ?? "n/a")}</td><td>${esc(m?.fetched_at ?? "n/a")}</td></tr>`;
  }).join("");
  sec.innerHTML = `<h2 id="method-h">Method</h2>
    <details id="drawer"><summary>How this is computed</summary><div class="drawer">
    <h3>One clock</h3><p>Everything is in UTC. Kalshi candles are hourly; the hour's timestamp is the candle's end. A
    day's Kalshi close is the last hourly close of that UTC date and its volume is the sum of that date's hourly volume.
    Hours with no trades keep the previous close and count 0 volume. Wikipedia pageviews are daily only. Attention data is
    never interpolated: a missing day stays missing.</p>
    <h3>Surprise</h3><p>For each day, surprise = ln((x + 1) / (mean of the previous 7 days + 1)). It asks how unusual
    today is compared with the past week, so a slow climb toward election day does not by itself look like a match
    between two series. It is blank when the day or any of the 7 days before it is missing, and for the first 7 days of
    the window. It is applied to every attention series and to Kalshi volume. (For hourly sources the 7 previous values
    are the same hour on the previous 7 days.) The page computes it with the same formula as the pipeline.</p>
    <h3>z-score view</h3><p>(x - mean) / sd, with the mean and sample standard deviation (n - 1) taken over the
    non-missing, non-excluded days of the window. It is a display aid only and is not used in any metric.</p>
    <h3>Election night</h3><p>Days in <code>exclude_days</code> (${esc(d.excluded_days.join(", "))}) are dropped from
    every metric, on both the attention and the outcome side, after the surprise is computed. They stay on the charts,
    shaded.</p>
    <h3>Lag tables</h3><p>Spearman rank correlation (rho, ties get average ranks) between attention surprise on day t and
    the outcome on day t + lag, for lags -2 to +2 days. Lag above 0 means the outcome comes after the attention. Outcomes:
    (a) Kalshi volume surprise, (b) the absolute change in daily close, (c) the signed change in daily close. A cell with
    fewer than ${MIN_PAIRS} day pairs is blank; n is always shown.</p>
    <h3>Noise band</h3><p>About 2/sqrt(n): with no real relation, |rho| lands inside it most of the time. Daily series are
    autocorrelated, so the true uncertainty is larger and the band is generous. The tool reports timing and association,
    not causation.</p>
    <h3>Quality</h3><p>Each series gets coverage (days with data out of window days), missing days, longest gap and
    near-zero stretches (days under 5% of the series median next to normal days). Status is unusable if coverage is under
    70%, there is no data, or near-zero days exceed 10% of the window; degraded if coverage is under 95%, any near-zero
    stretch exists, or a gap is 3 days or longer; otherwise ok. Unusable series are greyed out and left out of the lag
    tables. Every lag cell in the metrics JSON carries n, the worse of the two quality statuses and both query hashes.</p>
    <h3>Query hashes</h3><p>Each series is tied to a hash of the exact requests that produced it (the full requests are in
    the <code>queries</code> block of the race JSON).</p>
    <div class="table-scroll" role="region" aria-labelledby="hash-cap" tabindex="0"><table class="hashes">
    <caption id="hash-cap">Query hash per series</caption><thead><tr><th scope="col">Series</th>
    <th scope="col">Series query hash</th><th scope="col">Connector query hash</th><th scope="col">Quality</th>
    <th scope="col">Fetched at (UTC)</th></tr></thead><tbody>${hashRows}</tbody></table></div>
    </div></details>`;
  return sec;
}

function exportSection(d: RaceData): HTMLElement {
  return el("section", { "aria-labelledby": "export-h", id: "export" }, `<h2 id="export-h">Download</h2>
    <p>Files are built in your browser from the data already loaded. Plain CSV with a header row and UTC timestamps.</p>
    <div class="buttons">
      <button type="button" id="export-daily">Download CSV: daily table (${d.series.daily.rows.length} days)</button>
      <button type="button" id="export-hourly">Download CSV: hourly Kalshi (${d.series.hourly.rows.length} hours)</button>
      <button type="button" id="export-metrics">Download metrics JSON</button>
    </div>`);
}

function footer(d: RaceData): HTMLElement {
  const notes = d.sources.map((s) => SOURCE_NOTES[s]).filter(Boolean);
  return el("footer", { class: "wrap foot" }, `
    <p><strong>${esc(PROJECT_NAME)}</strong> (working name), version ${esc(d.version)}. Data generated at
      ${esc(d.generated_at)}.</p>
    <ul>${notes.map((n) => `<li>${esc(n.name)}: ${esc(n.note)} <a href="${esc(n.url)}" rel="noreferrer">Source
      terms</a></li>`).join("")}</ul>
    <p>Only counts and metrics are published, never post text or user data. Code and data licenses are not yet decided.</p>
    ${SHOW_FUNDING_DISCLOSURE ? `<p class="disclosure">${esc(FUNDING_DISCLOSURE)}</p>` : ""}`);
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

main();
