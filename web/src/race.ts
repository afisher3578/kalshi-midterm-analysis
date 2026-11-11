// One race: the M1 panels (price, volume, one panel per attention series, lag tables, daily table, method drawer,
// exports) plus the M3 chart types. Every race fact on the page comes from the race JSON, so switching the race
// switches every title, number and query string.
import { format, utcFormat } from "d3";
import { MIN_PAIRS, SOURCE_CATALOG, STATES } from "./config";
import { attentionChart, calendarChart, dayCenter, type DayPoint, eventStudyChart, type Frame, heatmapChart,
  type HeatCell, type HourPoint, keptDomain, overlayChart, priceChart, scatterChart, SERIES_COLORS, type StudyPoint,
  volumeChart } from "./charts";
import type { LagCell, Num, Quality, RaceData } from "./types";
import { attentionColumns, column, DAY_MS, eventStudy, excludedSpans, extremes, keepMask, lagCellRho, LAGS,
  mask, metricsExport, outcomes, passesFilter, PRICE, seriesLabel, shortLabel, sourceOf, groupOf, surprise, toCsv, transform,
  utcMs, type View, VOLUME, zscore } from "./transforms";

export interface RaceUi {
  view: View;
  group: string;      // all | talking | reporting | looking
  source: string;     // all | connector id
  from: string;       // ISO date, inclusive
  to: string;
  overlay: boolean;   // information-event overlay
  focus: string;      // attention series for the scatter, event study and calendar
}

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

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
function cents(p: number): string {
  return `${format(".1f")(p * 100)}¢`;
}
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = "") {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.innerHTML = html;
  return e;
}

export function raceTitle(d: { race: { office: string; state: string; election_date: string } }): string {
  const office = d.race.office.charAt(0).toUpperCase() + d.race.office.slice(1);
  return `${STATES[d.race.state] ?? d.race.state} ${office} ${d.race.election_date.slice(0, 4)}`;
}

/** Attention series of the race that pass the platform and source filters, in table order. */
export function shownSeries(d: RaceData, ui: RaceUi): string[] {
  return attentionColumns(d).filter((s) => passesFilter(s, ui.group, ui.source));
}

export class RaceView {
  width = 0;
  constructor(readonly root: HTMLElement, public data: RaceData, public ui: RaceUi) {}

  render() {
    const d = this.data;
    this.root.innerHTML = "";
    this.root.dataset.race = d.race.race_id;
    const ex = excludedSpans(d.excluded_days);
    const att = shownSeries(d, this.ui);
    const head = el("header", { class: "racehead" }, `
      <h2 id="race-h" class="racetitle">${esc(raceTitle(d))}</h2>
      <dl class="facts">
        <div><dt>Window</dt><dd>${esc(d.window.start)} to ${esc(d.window.end)} (UTC, inclusive, ${d.window.days} days)${
          this.ui.from !== d.window.start || this.ui.to !== d.window.end ? `; showing ${esc(this.ui.from)} to ${esc(this.ui.to)}` : ""}</dd></div>
        <div><dt>Followed contract</dt><dd><code data-k="market">${esc(d.race.kalshi.followed_market)}</code> (Kalshi event
          <code>${esc(d.race.kalshi.event)}</code>)</dd></div>
        <div><dt>Election day</dt><dd>${esc(d.race.election_date)}</dd></div>
        <div><dt>Excluded from metrics</dt><dd>${ex.map((e) => e.first === e.last ? esc(e.first)
          : `${esc(e.first)} to ${esc(e.last)}`).join(", ") || "none"} (election night; shaded on every chart)</dd></div>
        <div><dt>Polling density</dt><dd>${d.polling?.polling_density ?? "unknown"} polls in the window${
          d.polling?.polling_density != null ? ` (n=${d.polling.polling_density}, from the Wikipedia polling tables, needs review)` : ""}</dd></div>
        <div><dt>Candidates</dt><dd>${d.race.entities.map((e) => esc(e.name)).join(", ")}</dd></div>
      </dl>
      <p class="lede">Kalshi price and volume are hourly. Wikipedia pageviews are daily (drawn at noon UTC of each day).
        All times are UTC. The tool reports timing and association, not causation.</p>`);
    const charts = el("section", { "aria-labelledby": "charts-h" }, `
      <h3 id="charts-h" class="sec">Small multiples: price, volume and each attention series</h3>
      <fieldset class="toggle">
        <legend>Attention panels show</legend>
        ${(["raw", "z", "surprise"] as View[]).map((v) => `<label><input type="radio" name="view" value="${v}"
          ${v === this.ui.view ? "checked" : ""}> ${VIEW_LABEL[v]}</label>`).join("")}
        <p class="hint" id="view-hint"></p>
      </fieldset>
      <div id="charts"></div>`);
    this.root.append(head, sourceBadges(d, this.ui), charts,
      el("section", { id: "m3charts", "aria-labelledby": "m3-h" }, `<h3 id="m3-h" class="sec">Comparisons</h3>
        <div class="focus-pick"><label for="focus">Series for the scatter, event study and calendar</label>
        <select id="focus">${att.map((s) => `<option value="${esc(s)}" ${s === this.ui.focus ? "selected" : ""}>${
          esc(seriesLabel(s))}</option>`).join("")}</select></div><div id="m3"></div>`),
      lagSection(d, att), queriesSection(d), dailyTableSection(d, att), methodSection(d, att), exportSection(d));
    this.root.querySelector("#export-daily")!.addEventListener("click", () =>
      download(`${d.race.race_id}-daily.csv`, toCsv(d.series.daily), "text/csv"));
    this.root.querySelector("#export-hourly")!.addEventListener("click", () =>
      download(`${d.race.race_id}-hourly.csv`, toCsv(d.series.hourly), "text/csv"));
    this.root.querySelector("#export-metrics")!.addEventListener("click", () =>
      download(`${d.race.race_id}-metrics.json`, JSON.stringify(metricsExport(d), null, 1) + "\n", "application/json"));
    this.root.querySelectorAll<HTMLInputElement>('input[name="view"]').forEach((r) =>
      r.addEventListener("change", () => {
        this.ui.view = r.value as View;
        this.root.dispatchEvent(new CustomEvent("uichange"));
        this.drawCharts();
      }));
    this.root.querySelector<HTMLSelectElement>("#focus")!.addEventListener("change", (e) => {
      this.ui.focus = (e.target as HTMLSelectElement).value;
      this.root.dispatchEvent(new CustomEvent("uichange"));
      this.drawM3();
    });
    this.width = 0;
  }

  /** Redraw the charts if the container width changed (or force). */
  draw(force = false) {
    const w = Math.floor(this.root.querySelector<HTMLElement>("#charts")?.clientWidth ?? 0);
    if (w > 0 && (force || w !== this.width)) {
      this.width = w;
      this.drawCharts();
      this.drawM3();
    }
  }

  frame(): Frame {
    const d = this.data;
    const evs = this.ui.overlay ? (d.events_overlay?.rows ?? []).map((r) => ({ t: dayCenter(r.date), confirmed: r.status === "confirmed" })) : [];
    return { width: this.width, domain: [new Date(utcMs(this.ui.from)), new Date(utcMs(this.ui.to) + DAY_MS)],
      election: new Date(utcMs(d.race.election_date)), excluded: excludedSpans(d.excluded_days), events: evs };
  }

  overlayNote(): string {
    const o = this.data.events_overlay;
    if (!this.ui.overlay) return "";
    const n = (o?.rows ?? []).filter((r) => r.date >= this.ui.from && r.date <= this.ui.to).length;
    return ` Event overlay on: ${n} information event(s) in view (purple ticks; dashed = draft, needs review; ${
      o?.n_confirmed ?? 0} confirmed).`;
  }

  drawCharts() {
    const d = this.data, s = this.ui;
    const frame = this.frame();
    const root = this.root.querySelector<HTMLElement>("#charts")!;
    root.innerHTML = "";
    const lo = utcMs(s.from), hi = utcMs(s.to) + DAY_MS;
    const hourly: HourPoint[] = d.series.hourly.rows.map((r) => ({ t: new Date(String(r[0])),
      price: r[1] === null ? null : Number(r[1]), volume: r[2] === null ? null : Number(r[2]) }))
      .filter((h) => h.t.getTime() > lo && h.t.getTime() <= hi);
    const dates = d.series.daily.rows.map((r) => String(r[0]));
    const keep = d.series.daily.rows.map((r) => r[1] !== true);
    const inRange = dates.map((x) => x >= s.from && x <= s.to);
    const sh = (name: string) => d.series.meta[name]?.query_hash ?? "n/a";
    const ov = this.overlayNote();

    // Price
    const pe = extremes(hourly.map((h) => h.price));
    const at = (i: number) => fmtHour(hourly[i].t);
    const pSum = pe.last ? `First close ${cents(hourly[0].price ?? 0)} (${at(0)}); last ${cents(pe.last.v)}
      (${at(pe.last.i)}); low ${cents(pe.min!.v)} (${at(pe.min!.i)}); high ${cents(pe.max!.v)} (${at(pe.max!.i)}).` : "No data.";
    const pq = d.quality[PRICE];
    const ffh = (pq?.extra?.forward_filled_hours as number | undefined) ?? 0;
    root.append(figure("panel-price", `Kalshi ${d.race.kalshi.followed_market}: hourly close`, badge(pq), pSum + ov,
      priceChart(frame, hourly, [`Kalshi ${d.race.kalshi.followed_market} hourly closing price`,
        `Line chart of the hourly Yes price in cents. ${pSum.replace(/\s+/g, " ")}`]),
      `${qualityLine(pq)}<p class="meta">${hourly.length} hourly candles shown; ${ffh} hours in the window with no trades
        carry the previous close forward. Query hash <code>${esc(sh(PRICE))}</code>.</p>`));

    // Volume
    const vols = hourly.map((h) => h.volume);
    const ve = extremes(vols);
    const total = vols.reduce<number>((a, v) => a + (v ?? 0), 0);
    const zeros = vols.filter((v) => v === 0).length;
    const vq = d.quality[VOLUME];
    const vSum = ve.max ? `Total ${fmtSi(total)} contracts (${fmtInt(total)}) over ${hourly.length} hours. Busiest hour
      ${fmtInt(ve.max.v)} contracts (hour ending ${at(ve.max.i)}). ${zeros} hours with zero volume.` : "No data.";
    const vNote = vq?.status === "unusable" ? `<span class="unusable-note" data-k="unusable">Unusable, so every lag table and
      event metric of this race is left out: ${esc(vq.reasons.join("; "))}.</span> ` : "";
    root.append(figure("panel-volume", "Kalshi volume: contracts per hour", badge(vq), vNote + vSum,
      volumeChart(frame, hourly, ["Kalshi hourly volume, symlog scale",
        `Bar chart, one bar per hour, symlog scale. ${vSum.replace(/\s+/g, " ")}`]),
      `${qualityLine(vq)}<p class="meta">Symlog scale: the axis is sign(x) ln(1 + |x|), so hours with zero volume sit on the
        baseline instead of dropping out. Bars span the hour that ends at the candle's end_period_ts. Query hash
        <code>${esc(sh(VOLUME))}</code>.</p>`));

    // Attention
    const hint = this.root.querySelector("#view-hint")!;
    hint.textContent = "The y axis fits the days used in the metrics; election-night values above it are marked with a "
      + "triangle and printed in the caption. " + {
      raw: "Raw daily counts.",
      z: "z-score: (x - mean) / sd, mean and sample sd over the non-excluded days of the window. Excluded days use the same scale.",
      surprise: "Surprise: ln((x + 1) / (mean of the previous 7 days + 1)). Blank for the first 7 days and next to missing days.",
    }[s.view];
    const shown = shownSeries(d, s);
    if (!shown.length) {
      root.append(el("p", { class: "note", id: "no-series" }, `No attention series of this race matches the platform and
        source filters (${esc(s.group)}, ${esc(s.source)}). Change the filters above.`));
    }
    shown.forEach((name, k) => {
      const q = d.quality[name];
      const unusable = !q || q.status === "unusable";
      const vals = transform(column(d.series.daily, name), keep, s.view);
      const rows: DayPoint[] = dates.map((dt, i) => ({ t: dayCenter(dt), v: inRange[i] ? vals[i] : null, kept: keep[i] && inRange[i] }));
      const domain = keptDomain(rows, s.view === "raw");
      const e = extremes(rows.map((r) => r.v));
      const show = (v: number) => (s.view === "raw" ? fmtInt(v) : fmt2(v));
      const unit = s.view === "raw" ? ` ${unitOf(d, name)}` : "";
      const off = domain ? rows.filter((r) => r.v !== null && (r.v > domain[1] || r.v < domain[0])) : [];
      const summary = (e.max ? `${VIEW_LABEL[s.view]}: low ${show(e.min!.v)}${unit} (${fmtDay(rows[e.min!.i].t)}), high
        ${show(e.max.v)}${unit} (${fmtDay(rows[e.max.i].t)}), last ${show(e.last!.v)}${unit} (${fmtDay(rows[e.last!.i].t)}).`
        + (s.view === "raw" ? ` Total ${fmtInt(rows.reduce<number>((a, r) => a + (r.v ?? 0), 0))}${unit} over ${e.count} days (n=${e.count}).` : "")
        : "No values to show.")
        + (off.length ? ` Off the chart's scale (excluded days, marked with a triangle): ${off.map((r) =>
          `${fmtDay(r.t)} ${show(r.v!)}`).join(", ")}.` : "");
      const label = { raw: `${cap(unitOf(d, name))} per day`, z: "z-score (sd units)", surprise: "Surprise, ln ratio" }[s.view];
      const title = seriesLabel(name);
      const reason = unusable ? (q?.reasons.join("; ") || "no data") : undefined;
      root.append(figure(`panel-att-${k}`, title, badge(q),
        (unusable ? `<span class="unusable-note" data-k="unusable">Unusable, left out of the lag tables: ${esc(reason)}.</span> ` : "") + summary,
        attentionChart(frame, rows, { label, unusable, zeroRule: s.view !== "raw", reason, domain,
          aria: [`${title}, ${VIEW_LABEL[s.view]} view`, `Daily line chart. ${summary.replace(/\s+/g, " ")}`] }),
        `${qualityLine(q)}<p class="meta">Series <code>${esc(name)}</code> (${esc(groupOf(name))}), query hash
          <code>${esc(sh(name))}</code>.</p>`));
    });
  }

  drawM3() {
    const d = this.data, s = this.ui;
    const root = this.root.querySelector<HTMLElement>("#m3");
    if (!root || !this.width) return;
    root.innerHTML = "";
    const w = this.width;
    const frame = this.frame();
    const dates = d.series.daily.rows.map((r) => String(r[0]));
    const excluded = d.series.daily.rows.map((r) => r[1] === true);
    const keep = keepMask(dates, excluded, s.from, s.to);
    const shown = shownSeries(d, s);
    const usable = shown.filter((n) => d.quality[n] && d.quality[n].status !== "unusable");
    const close = column(d.series.daily, PRICE), volume = column(d.series.daily, VOLUME);
    const outs = outcomes(close, volume);
    const range = `${s.from} to ${s.to}`;
    const nKept = keep.filter(Boolean).length;

    // 1. normalized overlay
    const ovSeries = [PRICE, ...usable].map((name) => {
      const z = zscore(column(d.series.daily, name), keep);
      return { name, label: name === PRICE ? `Kalshi ${d.race.kalshi.followed_market} daily close` : seriesLabel(name),
        points: dates.map((x, i) => ({ t: dayCenter(x), v: keep[i] ? z[i] : null })) };
    });
    const ovList = ovSeries.map((o, k) => `<li><span class="key" style="border-color:${SERIES_COLORS[k % SERIES_COLORS.length]}">${k + 1}</span>
      ${esc(o.label)}</li>`).join("");
    root.append(figure("chart-overlay", "Normalized overlay", "", `Each series as a z-score over the kept days of ${range}
      (n=${nKept} days), so different units share one axis. Excluded days (election night) are not drawn here.${this.overlayNote()}`,
      overlayChart(frame, ovSeries, ["Normalized overlay of price and attention series",
        `Line chart of ${ovSeries.length} z-scored daily series: ${ovSeries.map((o) => o.label).join("; ")}.`]),
      `<ol class="serieslist">${ovList}</ol>`));

    // 2. lead-lag heatmap (client-side over the selected range; same math as the pipeline)
    const cells: HeatCell[] = [];
    for (const name of usable) {
      const a = surprise(column(d.series.daily, name));
      for (const lag of LAGS) {
        const r = lagCellRho(a, outs.volume_surprise, keep, lag, MIN_PAIRS);
        cells.push({ series: name, label: shortLabel(name, d.race.wikipedia_pages[0]), lag, rho: r.rho, n: r.n });
      }
    }
    const heatText = cells.length ? cells.filter((c) => c.lag === 0).map((c) => `${c.label}: lag 0 ${c.rho === null
      ? `blank (n=${c.n} under ${MIN_PAIRS})` : `rho ${fmt2(c.rho)} (n=${c.n})`}`).join("; ") : "no usable series";
    root.append(cells.length ? figure("chart-heatmap", "Lead-lag heatmap: attention surprise vs Kalshi volume surprise", "",
      `Spearman rho per series and lag over ${range}, recomputed in the page. ${esc(heatText)}.`,
      heatmapChart(w, cells, MIN_PAIRS, ["Lead-lag heatmap", `Heatmap of rho by series and lag. ${heatText}.`]),
      `<p class="meta">Cells with fewer than ${MIN_PAIRS} pairs print n&lt;${MIN_PAIRS}. For the full window this matches the
        pipeline's lag tables below.</p>`) : emptyNote("chart-heatmap", "Lead-lag heatmap", "No usable attention series matches the filters."));

    // 3. event study, 4. scatter, 5. calendar for the focus series
    const focus = usable.includes(s.focus) ? s.focus : usable[0];
    if (!focus) {
      root.append(emptyNote("chart-event", "Event study", "No usable attention series matches the filters."));
      return;
    }
    const fa = surprise(column(d.series.daily, focus));
    const confirmed = (d.events_overlay?.rows ?? []).filter((r) => r.status === "confirmed").map((r) => dates.indexOf(r.date)).filter((i) => i >= 0 && keep[i]);
    const spikeIdx = fa.map((v, i) => (v !== null && v >= 1.0 && keep[i] ? i : -1)).filter((i) => i >= 0);
    const anchors = confirmed.length ? confirmed : spikeIdx;
    const anchorWhat = confirmed.length ? `${confirmed.length} confirmed information event(s)`
      : `${spikeIdx.length} attention spike day(s) (surprise >= 1.0 in ${seriesLabel(focus)}); no confirmed events, draft events are not used`;
    const kAll = d.series.daily.rows.map((r) => r[1] !== true);
    const study: StudyPoint[] = [
      ...eventStudy(anchors, mask(outs.volume_surprise, kAll), keep).map((p) => ({ ...p, what: "volume surprise" })),
      ...eventStudy(anchors, outs.price_change.map((v) => (v === null ? null : v * 100)), keep).map((p) => ({ ...p, what: "price change, cents" })),
    ];
    const studyText = `${anchorWhat}. ` + study.filter((p) => p.offset === 0 || p.offset === 1).map((p) =>
      `${p.what} at ${p.offset > 0 ? "+" : ""}${p.offset}: ${p.mean === null ? "no value" : fmt2(p.mean)} (n=${p.n})`).join("; ");
    root.append(anchors.length ? figure("chart-event", "Event study", "", `Mean outcome at each day around the anchor days over
      ${range}. ${esc(studyText)}.`, eventStudyChart(Math.min(w, 760), study, ["Event study", studyText]),
      `<p class="meta">Anchors: ${esc(anchorWhat)}. n at each point is the number of anchor days with a value.</p>`)
      : emptyNote("chart-event", "Event study", `No anchor days in ${range}: 0 confirmed events and 0 spike days (n=0) in
        ${esc(seriesLabel(focus))}.`));

    const am = mask(fa, keep), vm = mask(outs.volume_surprise, keep);
    const pts = am.map((x, i) => ({ x, y: vm[i], date: dates[i] })).filter((p) => p.x !== null && p.y !== null) as
      { x: number; y: number; date: string }[];
    const r0 = lagCellRho(fa, outs.volume_surprise, keep, 0, MIN_PAIRS);
    const scText = `${pts.length} days (n=${pts.length}); Spearman rho ${r0.rho === null ? `blank (n under ${MIN_PAIRS})` : fmt2(r0.rho)}`;
    root.append(figure("chart-scatter", `Scatter: ${seriesLabel(focus)} surprise vs Kalshi volume surprise`, "",
      `Same-day pairs over ${range}, election night excluded. ${scText}.`,
      scatterChart(w, pts, ["attention surprise (ln ratio)", "volume surprise (ln ratio)"],
        ["Scatter of attention surprise vs volume surprise", scText]), ""));

    const raw = column(d.series.daily, focus);
    const cal = dates.map((x, i) => ({ date: new Date(utcMs(x)), v: raw[i], excluded: excluded[i] }))
      .filter((c) => { const iso = c.date.toISOString().slice(0, 10); return iso >= s.from && iso <= s.to; });
    const ce = extremes(cal.map((c) => c.v));
    const calText = ce.max ? `${cal.length} days; busiest ${fmtDay(cal[ce.max.i].date)} with ${fmtInt(ce.max.v)} ${unitOf(d, focus)};
      quietest ${fmtDay(cal[ce.min!.i].date)} with ${fmtInt(ce.min!.v)}; ${cal.filter((c) => c.v === null).length} missing.` : "no values";
    root.append(figure("chart-calendar", `Calendar heatmap: ${seriesLabel(focus)}`, "", `${calText} Darker is more
      (log scale). x marks excluded days, - marks missing days.`, calendarChart(w, cal, unitOf(d, focus),
      ["Calendar heatmap", calText.replace(/\s+/g, " ")]), ""));
  }
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function unitOf(d: RaceData, series: string): string {
  const u = d.series.meta[series]?.unit;
  return u === "views" ? "pageviews" : u ?? "count";
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
  f.append(cap, svg);
  if (foot) f.append(el("div", { class: "pfoot" }, foot));
  return f;
}

function emptyNote(id: string, title: string, text: string) {
  return el("figure", { class: "panel empty", id }, `<figcaption><span class="ptitle">${esc(title)}</span>
    <span class="summary">${text}</span></figcaption>`);
}

/** Cards for sources with no data for this race (skipped, with the reason) and for unusable series. */
function sourceBadges(d: RaceData, ui: RaceUi): HTMLElement {
  const r = d.race;
  const skipped = d.skipped ?? {};
  const applies = (n: string) => (n === "entities" ? r.entities.length > 0 : n === "news_query" ? !!r.news_query
    : (r.subreddits ?? []).length > 0);
  const missing = SOURCE_CATALOG.filter((c) => (skipped[c.id] || (applies(c.needs) && !d.sources.includes(c.id)))
    && passesFilter(`${c.id}/x`, ui.group, ui.source));
  const unusable = Object.keys(d.quality).filter((s) => d.quality[s].status === "unusable"
    && (s.startsWith("kalshi/") || passesFilter(s, ui.group, ui.source)));
  const sec = el("section", { "aria-labelledby": "nodata-h", id: "nodata" });
  const cmd = (src: string) => `python -m raceattn run --race ${r.race_id} --sources ${src}`;
  sec.innerHTML = `<h3 id="nodata-h" class="sec">Sources with no data or unusable data for this race</h3>
    <p>Nothing is estimated or filled in. Hosted pages show only committed data; run a source locally with your own key
    (keys stay in your shell or a git-ignored <code>.env</code>, never in the page).</p>
    <ul class="cards">${unusable.map((s) => {
      const q = d.quality[s];
      return `<li class="card card-unusable" data-series="${esc(s)}"><h4><span class="badge badge-unusable">Unusable</span>
        ${esc(seriesLabel(s))}</h4><p data-k="reason">Reason: ${esc(q.reasons.join("; ") || "no data")}.</p>
        <p>Coverage ${q.coverage_days}/${q.window_days} days (n=${q.coverage_days}). ${s.startsWith("kalshi/")
          ? "Every lag table and event metric of this race needs it, so they are left out (see the lag section)."
          : "Left out of every metric."}</p>
        <p>Re-run: <code>${esc(cmd(sourceOf(s)))} --refresh</code></p></li>`;
    }).join("")}${missing.map((c) => `<li class="card" data-source="${esc(c.id)}"><h4><span class="badge badge-none">No data</span>
      ${esc(c.label)}</h4><p data-k="reason">Reason: ${esc(skipped[c.id] ?? "not in the sources of this run")}.</p>
      <p>Channel: ${esc(c.channel)}.</p>
      ${c.built === false ? `<p>Connector not built yet (planned for ${esc(c.milestone)}).</p>`
        : `<p>Run locally: <code>${esc(cmd(c.id))}</code></p>`}
      <p>Needs: ${c.env.length ? c.env.map((k) => `<code>${esc(k)}</code>`).join(" and ") : "no key"}${c.envNote
        ? ` (${esc(c.envNote)})` : ""}.</p></li>`).join("")}</ul>${!missing.length && !unusable.length
      ? `<p class="note">Every source that applies to this race has data.</p>` : ""}`;
  return sec;
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
  let html = `<h3 id="lags-h" class="sec">Lag tables: attention surprise vs Kalshi, daily (full window, from the pipeline)</h3>
    <p>Spearman rho between each attention series' daily surprise and the outcome, with the outcome shifted by the lag.
    <strong>Lag above 0 means the outcome is measured after the attention</strong> (lag +1: attention on day t, outcome on
    day t+1). Election night is excluded on both sides. Each cell shows rho to 2 decimals and n, the number of day
    pairs. Cells with fewer than ${MIN_PAIRS} pairs are blank. A * marks |rho| above the row's noise band. These tables
    always cover the full window; the heatmap above follows the window filter.</p>`;
  for (const [okey, o] of Object.entries(OUTCOMES)) {
    if (!computed.some((e) => e.outcomes?.[okey])) continue;
    html += `<h4 class="tcap" id="cap-${okey}">${esc(o.title)}: Spearman rho of attention surprise vs
      ${esc(o.short)}</h4><div class="table-scroll" role="region" aria-labelledby="cap-${okey}" tabindex="0">
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
    html += `<p class="note" id="lags-skipped">Left out of the lag tables: ${skipped.map((e) => `${esc(seriesLabel(e.attention_series))}
      (${esc(e.reason ?? "skipped")})`).join("; ")}.</p>`;
  }
  if (!computed.length) html += `<p class="note">No lag table could be computed for this race with these filters.</p>`;
  html += `<p class="note">Hourly lag tables: ${esc(d.metrics.hourly_note ?? "none")}.</p>`;
  sec.innerHTML = html;
  return sec;
}

/** Every rendered query of the race, so a reader can audit what was searched. */
function queriesSection(d: RaceData): HTMLElement {
  const sec = el("section", { "aria-labelledby": "queries-h", id: "queries" });
  const items = Object.entries(d.queries).map(([cid, q]) => {
    const first = q.queries.slice(0, 4).map((x) => `<li><code data-k="query">${esc(x.endpoint)}${x.params && Object.keys(x.params).length
      ? "?" + esc(new URLSearchParams(Object.entries(x.params).map(([k, v]) => [k, String(v)])).toString()) : ""}</code></li>`).join("");
    const more = q.queries.length > 4 ? `<li>and ${q.queries.length - 4} more request(s) of the same shape</li>` : "";
    return `<li data-connector="${esc(cid)}"><strong>${esc(cid)}</strong>${q.terms ? ` (search terms: <code data-k="terms">${esc(q.terms.join(", "))}</code>)` : ""}
      <ul>${first}${more}</ul>${q.queries_note ? `<p class="note">${esc(q.queries_note)}</p>` : ""}</li>`;
  }).join("");
  sec.innerHTML = `<h3 id="queries-h" class="sec">Queries behind this race</h3>
    <p>Rendered from the race config by each connector (nothing is hard-coded per state). News query:
      <code id="news-query">${esc(d.race.news_query ?? "none")}</code>. Wikipedia pages:
      <code id="wiki-pages">${esc(d.race.wikipedia_pages.join(", "))}</code>.</p>
    <details><summary>Show every request (${Object.values(d.queries).reduce((a, q) => a + q.queries.length, 0)} logged)</summary>
    <ul class="queries">${items}</ul></details>`;
  return sec;
}

function dailyTableSection(d: RaceData, att: string[]): HTMLElement {
  const t = d.series.daily;
  const idx = (c: string) => t.columns.indexOf(c);
  const sec = el("section", { "aria-labelledby": "daily-h" });
  const cell = (v: unknown, f: (n: number) => string) => (v === null || v === undefined ? "missing" : f(Number(v)));
  sec.innerHTML = `<h3 id="daily-h" class="sec">Daily values</h3>
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
    const conn = m ? d.queries[m.connector ?? m.source]?.query_hash : undefined;
    return `<tr><th scope="row"><code>${esc(s)}</code></th><td><code>${esc(m?.query_hash ?? "n/a")}</code></td>
      <td><code>${esc(conn ?? "n/a")}</code></td><td>${esc(d.quality[s]?.status ?? "n/a")}</td><td>${esc(m?.fetched_at ?? "n/a")}</td></tr>`;
  }).join("");
  sec.innerHTML = `<h3 id="method-h" class="sec">Method</h3>
    <details id="drawer"><summary>How this is computed</summary><div class="drawer">
    <h4>One clock</h4><p>Everything is in UTC. Kalshi candles are hourly; the hour's timestamp is the candle's end. A
    day's Kalshi close is the last hourly close of that UTC date and its volume is the sum of that date's hourly volume.
    Hours with no trades keep the previous close and count 0 volume. Wikipedia pageviews are daily only. Attention data is
    never interpolated: a missing day stays missing.</p>
    <h4>Surprise</h4><p>For each day, surprise = ln((x + 1) / (mean of the previous 7 days + 1)). It asks how unusual
    today is compared with the past week, so a slow climb toward election day does not by itself look like a match
    between two series. It is blank when the day or any of the 7 days before it is missing, and for the first 7 days of
    the window. It is applied to every attention series and to Kalshi volume. (For hourly sources the 7 previous values
    are the same hour on the previous 7 days.) The page computes it with the same formula as the pipeline.</p>
    <h4>z-score view</h4><p>(x - mean) / sd, with the mean and sample standard deviation (n - 1) taken over the
    non-missing, non-excluded days in view. It is a display aid only and is not used in any metric.</p>
    <h4>Election night</h4><p>Days in <code>exclude_days</code> (${esc(d.excluded_days.join(", "))}) are dropped from
    every metric, on both the attention and the outcome side, after the surprise is computed. They stay on the charts,
    shaded.</p>
    <h4>Lag tables</h4><p>Spearman rank correlation (rho, ties get average ranks) between attention surprise on day t and
    the outcome on day t + lag, for lags -2 to +2 days. Lag above 0 means the outcome comes after the attention. Outcomes:
    (a) Kalshi volume surprise, (b) the absolute change in daily close, (c) the signed change in daily close. A cell with
    fewer than ${MIN_PAIRS} day pairs is blank; n is always shown.</p>
    <h4>Window filter</h4><p>A sub-range keeps the surprise computed on the full window (it needs the 7 days before) and
    then drops the days outside the range from every comparison chart. The pipeline's lag tables stay on the full window.</p>
    <h4>Event study</h4><p>Anchor days are confirmed information events when the race has any; otherwise days whose
    attention surprise is at least 1.0 (spikes). Draft events (needs review) are never used as anchors.</p>
    <h4>Noise band</h4><p>About 2/sqrt(n): with no real relation, |rho| lands inside it most of the time. Daily series are
    autocorrelated, so the true uncertainty is larger and the band is generous. The tool reports timing and association,
    not causation.</p>
    <h4>Quality</h4><p>Each series gets coverage (days with data out of window days), missing days, longest gap and
    near-zero stretches (days under 5% of the series median next to normal days). Status is unusable if coverage is under
    70%, there is no data, or near-zero days exceed 10% of the window; degraded if coverage is under 95%, any near-zero
    stretch exists, or a gap is 3 days or longer; otherwise ok. Unusable series are greyed out and left out of the lag
    tables. Every lag cell in the metrics JSON carries n, the worse of the two quality statuses and both query hashes.</p>
    <h4>Query hashes</h4><p>Each series is tied to a hash of the exact requests that produced it (the full requests are in
    the <code>queries</code> block of the race JSON).</p>
    <div class="table-scroll" role="region" aria-labelledby="hash-cap" tabindex="0"><table class="hashes">
    <caption id="hash-cap">Query hash per series</caption><thead><tr><th scope="col">Series</th>
    <th scope="col">Series query hash</th><th scope="col">Connector query hash</th><th scope="col">Quality</th>
    <th scope="col">Fetched at (UTC)</th></tr></thead><tbody>${hashRows}</tbody></table></div>
    </div></details>`;
  return sec;
}

function exportSection(d: RaceData): HTMLElement {
  return el("section", { "aria-labelledby": "export-h", id: "export" }, `<h3 id="export-h" class="sec">Download</h3>
    <p>Files are built in your browser from the data already loaded. Plain CSV with a header row and UTC timestamps.</p>
    <div class="buttons">
      <button type="button" id="export-daily">Download CSV: daily table (${d.series.daily.rows.length} days)</button>
      <button type="button" id="export-hourly">Download CSV: hourly Kalshi (${d.series.hourly.rows.length} hours)</button>
      <button type="button" id="export-metrics">Download metrics JSON</button>
    </div>`);
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
