// The dashboard chart, laid out the way Kalshi's market chart is: one solid line per candidate (Democratic blue,
// Republican red) on a 0 to 100% axis on the right, a dot and a label (surname and latest percent) at the right end
// of each line, a crosshair with one tooltip, and a row of range buttons (1D 1W 1M 3M All) under the chart. Kalshi
// volume and media attention stay as toggleable lines with their own y axes on the left. The legend entries switch
// each line; the date inputs, the brush, ctrl or cmd + wheel and two finger pinch pick any other range; the cursor
// works with pointer, touch and keyboard. Data: series.display_daily; when the range is 14 days or fewer the Kalshi
// lines come from series.display_hourly and attention (daily only) is drawn as a step line.
import { axisBottom, axisLeft, axisRight, bisector, brushX, curveStepAfter, format, line, max, type ScaleLinear, scaleLinear,
  type ScaleTime, scaleUtc, select, type Selection, utcDay, utcFormat, utcHour } from "d3";
import { attentionNote, axisTitle, type ChartSeries, checkRange, clampDate, dailyToSteps, fmtDayShort, fmtHour,
  type Granularity, granularityFor, hasData, hourDay, hourlyRange, type HourlySeries, hourNote, kalshiLabel, lastValueIndex,
  legendText, lockedLine, NO_TRADES, nudgeLabels, PRICE_COL, PRICE_KEYS, type PartyLines, type PriceKey, RANGE_IDS, rangeDays,
  rangeForButton, SERIES_KEYS, type SeriesKey, toggleLine, zoomRange } from "./display";
import { esc } from "./race";
import { DAY_MS, utcMs } from "./transforms";
import type { Num } from "./types";

// Colors are the --series-* variables in style.css (Flexoki blue, red, purple and green; 600 shades in the light
// theme, 400 in the dark theme except the dark red, 300 so its label text passes 4.5:1), so a theme switch recolors
// the chart without a redraw. The candidate lines are solid; volume and attention have their own dash.
export const SERIES_STYLE: Record<SeriesKey, { short: string; unit: string; color: string; dash: string | null }> = {
  dem: { short: "Democratic candidate", unit: "%", color: "var(--series-dem)", dash: null },
  rep: { short: "Republican candidate", unit: "%", color: "var(--series-rep)", dash: null },
  volume: { short: "Kalshi volume", unit: "contracts", color: "var(--series-volume)", dash: "7,4" },
  news: { short: "Media attention", unit: "stories", color: "var(--series-news)", dash: "2,3" },
};
// the attention line when the source is Wikipedia (ChartInput.attention); same slot, color and dash as news
const WIKI_STYLE = { ...SERIES_STYLE.news, short: "Wikipedia attention", unit: "pageviews" };

export interface ChartState {
  visible: Record<SeriesKey, boolean>;
  from: string;
  to: string;
  newsAutoOff?: boolean;  // news was switched off because the race had none; it comes back for a race with news
}

export interface ChartInput {
  series: ChartSeries;
  lines: PartyLines;                 // who the dem and rep lines are (candidates block); null: no such line
  title: string;
  window: { start: string; end: string };
  election: string[];       // shaded days, e.g. election day and the day after
  news: { available: boolean };
  demo: boolean;
  attention?: "news" | "wikipedia";  // what the attention line plots (default news)
  hourly?: HourlySeries | null;      // series.display_hourly; without it the Kalshi lines stay daily at every zoom
  electionDate: string;              // the race's election day
}

const fmtDay = utcFormat("%b %-d");
const fmtLong = utcFormat("%a %b %-d, %Y");
const fmtPrice = format(".1f");
const fmtVolume = format(",.2~f");
const fmtNews = format(",.0f");
const fmtTick = format(".2~s");
let uid = 0;

const isPrice = (k: SeriesKey): k is PriceKey => k === "dem" || k === "rep";

export function formatValue(key: SeriesKey, v: Num, attention: "news" | "wikipedia" = "news"): string {
  if (v === null) return "no data";
  if (isPrice(key)) return `${fmtPrice(v)}%`;
  if (key === "volume") return `${fmtVolume(v)} contracts`;
  return `${fmtNews(v)} ${attention === "wikipedia" ? "pageviews" : "stories"}`;
}

function addDays(d: string, n: number): string {
  return new Date(utcMs(d) + n * DAY_MS).toISOString().slice(0, 10);
}

const fmtHourTick = utcFormat("%H:00");
const HOUR_MS = 3_600_000;
const bisectT = bisector((t: number) => t);

/** Long name of a range button for screen readers; it starts with the visible text ("1W"). */
export const RANGE_NAMES: Record<string, string> = { "1D": "1D, the last day", "1W": "1W, the last 7 days",
  "1M": "1M, the last 30 days", "3M": "3M, the last 90 days", All: "All, the whole window" };

function electionLabel(days: string[]): string {
  if (!days.length) return "";
  const a = new Date(utcMs(days[0])), b = new Date(utcMs(days[days.length - 1]));
  if (days.length === 1) return `Election day, ${fmtDay(a)}`;
  return a.getUTCMonth() === b.getUTCMonth() ? `Election, ${fmtDay(a)} and ${b.getUTCDate()}` : `Election, ${fmtDay(a)} and ${fmtDay(b)}`;
}

export class LineChart {
  readonly id = `lc${++uid}`;
  cursor: number | null = null;
  private svgBox!: HTMLElement;
  private brushBox!: HTMLElement;
  private tip!: HTMLElement;
  private settingBrush = false;
  /** "day": one point per UTC day; "hour": the Kalshi lines one point per hour (14 days or fewer in view). */
  g: Granularity = "day";
  private hr: [number, number] | null = null;   // hourly index range in view (hour mode)
  private touches = new Map<number, number>();   // touch pointers on the chart: id to clientX, for pinch zoom
  private pinch: { d0: number; from: string; to: string; anchor: number } | null = null;
  private zoomFrame = 0;
  private wheel = { dy: 0, anchor: 0.5 };

  constructor(readonly root: HTMLElement, public input: ChartInput, public state: ChartState,
              readonly onChange: (s: ChartState) => void = () => {}) {}

  get dates(): string[] { return this.input.series.dates; }

  private get wiki(): boolean { return this.input.attention === "wikipedia"; }

  /** Label, unit and color of a line; candidate lines are named after the candidate, the attention line follows
   * the chosen source. */
  style(k: SeriesKey) {
    if (k === "news" && this.wiki) return WIKI_STYLE;
    const l = isPrice(k) ? this.input.lines[k] : null;
    return l ? { ...SERIES_STYLE[k], short: `${l.name} (${l.party})` } : SERIES_STYLE[k];
  }

  /** The lines this race can draw: a candidate line needs a contract and some data (no Republican column, no line). */
  get keys(): SeriesKey[] {
    return SERIES_KEYS.filter((k) => !isPrice(k) || (!!this.input.lines[k] && hasData(this.input.series[k])));
  }

  private fmt(k: SeriesKey, v: Num): string { return formatValue(k, v, this.input.attention); }

  /** Index range [lo, hi] of the cursor positions in view: hours in hour mode, days otherwise. */
  view(): [number, number] {
    return this.g === "hour" && this.hr ? this.hr : this.range();
  }

  /** Index range [lo, hi] of the dates in view. */
  range(): [number, number] {
    const lo = this.dates.findIndex((d) => d >= this.state.from);
    let hi = this.dates.length - 1;
    while (hi > 0 && this.dates[hi] > this.state.to) hi--;
    return [Math.max(lo, 0), hi];
  }

  render() {
    const { input, state } = this;
    if (!input.news.available && state.visible.news) {
      state.visible.news = false;
      state.newsAutoOff = true;
    } else if (input.news.available && state.newsAutoOff) {
      state.visible.news = true;
      state.newsAutoOff = false;
    }
    const keys = this.keys;
    if (!keys.some((k) => state.visible[k])) state.visible[keys[0]] = true;
    state.from = clampDate(state.from || input.window.start, input.window.start, input.window.end);
    state.to = clampDate(state.to || input.window.end, input.window.start, input.window.end);
    if (state.from > state.to) [state.from, state.to] = [input.window.start, input.window.end];
    const entry = (k: SeriesKey) => {
      const s = this.style(k);
      const t = legendText(k, this.input.attention, "day", input.lines);  // volume follows the zoom in draw()
      const off = k === "news" && !input.news.available
        ? ` <span class="lg-off">(no ${this.wiki ? "Wikipedia" : "news"} data for this race yet)</span>` : "";
      const val = isPrice(k) ? `<span class="lg-val" data-k="${k}"></span>` : "";
      return `<li class="lg-item" data-key="${k}"><button type="button" class="lg-btn" id="lg-${k}" data-key="${k}"
        aria-pressed="${state.visible[k]}"><svg class="swatch" viewBox="0 0 30 10" width="30" height="10" aria-hidden="true"><line
        x1="1" y1="5" x2="29" y2="5"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/></svg><span class="lg-text"><strong
        class="lg-name">${esc(t.name)}</strong>${val}<span class="vh">:</span> <span class="lg-desc">${esc(t.desc)}</span>${off}</span></button></li>`;
    };
    const who = PRICE_KEYS.map((k) => (keys.includes(k) ? input.lines[k]?.name : null)).filter(Boolean).join(" and ");
    // the only status line left: News is the chosen source and the race has no news at all
    const status = !input.news.available && !this.wiki
      ? '<p class="status" id="news-status" data-news="no">No news data for this race yet.</p>' : "";
    this.root.innerHTML = `
      <h2 id="chart-h" class="charttitle">${esc(input.title)}: Kalshi chance${who ? ` for ${esc(who)}` : ""}, volume and ${
        this.wiki ? "Wikipedia" : "media"} attention</h2>
      ${input.demo ? '<p class="demo-banner" id="demo-label">Demo data</p>' : ""}
      ${status}
      <div class="lgbox">
        <ul class="lg" id="legend" aria-label="Lines on the chart; each button shows or hides a line and its y axis">
          ${keys.map(entry).join("")}</ul>
        <p class="hint" id="tg-note" aria-live="polite"></p>
        <p class="gran" id="gran" aria-live="polite">${kalshiLabel("day")}</p>
      </div>
      <div class="chartbox" id="chart" tabindex="0" role="group"
        aria-label="Line chart, ${esc(input.title)}. Use the left and right arrow keys to move the cursor one day, or one hour when the chart is hourly; Shift with an arrow key, Page Up and Page Down move further. The values are read out below the chart."
        aria-describedby="readout"><div class="chartsvg"></div><div class="tip" aria-hidden="true" hidden></div></div>
      <div class="ranges" role="group" aria-label="Date range">${RANGE_IDS.map((id) => {
        const r = rangeForButton(id, input.window);
        return `<button type="button" class="rbtn" id="r-${id}" data-range="${id}" data-from="${r.from}" data-to="${r.to}"
          data-zoom="${r.zoom}" aria-pressed="false" aria-label="${esc(RANGE_NAMES[id])}">${id}</button>`;
      }).join("")}</div>
      <p class="hint" id="att-note" hidden></p>
      <div class="brushbox" aria-hidden="true"></div>
      <p class="hint brushhint">Drag across the strip above to pick dates, or use the date fields. Ranges of 14 days or fewer show Kalshi by the hour.</p>
      <form class="range" id="range" novalidate>
        <div class="f"><label for="d-from">Start date</label><input type="date" id="d-from" min="${input.window.start}"
          max="${input.window.end}" value="${state.from}" aria-describedby="range-msg"></div>
        <div class="f"><label for="d-to">End date</label><input type="date" id="d-to" min="${input.window.start}"
          max="${input.window.end}" value="${state.to}" aria-describedby="range-msg"></div>
        <button type="button" id="d-reset">Reset</button>
        <p class="range-msg" id="range-msg" aria-live="polite"></p>
      </form>
      <p class="hint">Dates run from ${input.window.start} to ${input.window.end} (UTC days, the election minus 90 days to the day after).</p>
      <p class="readout" id="readout" aria-live="polite"></p>`;
    this.svgBox = this.root.querySelector(".chartsvg")!;
    this.brushBox = this.root.querySelector(".brushbox")!;
    this.tip = this.root.querySelector(".tip")!;
    this.root.querySelectorAll<HTMLButtonElement>(".lg-btn").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.key as SeriesKey;
      if (b.getAttribute("aria-disabled") === "true") return;
      state.visible = toggleLine(state.visible, k, this.keys);
      this.syncToggles();
      this.changed();
    }));
    const from = this.root.querySelector<HTMLInputElement>("#d-from")!;
    const to = this.root.querySelector<HTMLInputElement>("#d-to")!;
    const onDate = () => this.setRange(from.value, to.value);
    from.addEventListener("change", onDate);
    to.addEventListener("change", onDate);
    this.root.querySelector("#range")!.addEventListener("submit", (e) => { e.preventDefault(); onDate(); });
    this.root.querySelector("#d-reset")!.addEventListener("click", () => this.setRange(input.window.start, input.window.end));
    this.root.querySelectorAll<HTMLButtonElement>(".rbtn").forEach((b) =>
      b.addEventListener("click", () => this.setRange(b.dataset.from!, b.dataset.to!)));
    const box = this.root.querySelector<HTMLElement>("#chart")!;
    box.addEventListener("keydown", (e) => this.onKey(e));
    box.addEventListener("focus", () => { if (this.cursor === null) this.setCursor(this.view()[1]); });
    this.wireZoom(box);
    this.syncToggles();
    this.draw();
  }

  /** Apply a start and end date if valid; otherwise keep the current range and say why. */
  setRange(from: string, to: string): boolean {
    const msg = this.root.querySelector<HTMLElement>("#range-msg")!;
    const r = checkRange(from, to, this.input.window.start, this.input.window.end);
    const fromEl = this.root.querySelector<HTMLInputElement>("#d-from")!;
    const toEl = this.root.querySelector<HTMLInputElement>("#d-to")!;
    if (!r.ok) {
      msg.textContent = `${r.error} The chart still shows ${this.state.from} to ${this.state.to}.`;
      msg.classList.add("bad");
      fromEl.setAttribute("aria-invalid", "true");
      toEl.setAttribute("aria-invalid", "true");
      fromEl.value = this.state.from;
      toEl.value = this.state.to;
      return false;
    }
    msg.textContent = "";
    msg.classList.remove("bad");
    fromEl.removeAttribute("aria-invalid");
    toEl.removeAttribute("aria-invalid");
    this.state.from = r.from;
    this.state.to = r.to;
    fromEl.value = r.from;
    toEl.value = r.to;
    this.changed();
    return true;
  }

  private changed() {
    this.draw();
    this.onChange(this.state);
  }

  private syncToggles() {
    const locked = lockedLine(this.state.visible, this.keys);
    for (const k of this.keys) {
      const b = this.root.querySelector<HTMLButtonElement>(`#lg-${k}`)!;
      const unavailable = k === "news" && !this.input.news.available;
      b.setAttribute("aria-pressed", String(this.state.visible[k]));
      if (unavailable || locked === k) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    }
    this.root.querySelector("#tg-note")!.textContent = locked
      ? `${legendText(locked, this.input.attention, "day", this.input.lines).name} is the only line on, so it cannot be switched off.` : "";
  }

  private onKey(e: KeyboardEvent) {
    const [lo, hi] = this.view();
    const c = this.cursor ?? hi;
    // daily: an arrow moves one day, Shift + arrow or Page Up/Down a week; hourly: one hour, or one day (24 hours)
    const far = this.g === "hour" ? 24 : 7;
    const step: Record<string, number> = { ArrowLeft: e.shiftKey ? -far : -1, ArrowRight: e.shiftKey ? far : 1, PageUp: -far, PageDown: far };
    let next: number | null = null;
    if (e.key in step) next = c + step[e.key];
    else if (e.key === "Home") next = lo;
    else if (e.key === "End") next = hi;
    if (next === null) return;
    e.preventDefault();
    this.setCursor(Math.max(lo, Math.min(hi, next)));
  }

  setCursor(i: number | null) {
    this.cursor = i;
    this.drawCursor();
  }

  /** Zoom by `factor` around `anchor` (0..1 across the plot) in whole days, inside the window. */
  private zoomBy(factor: number, anchor: number, from = this.state.from, to = this.state.to) {
    const w = this.input.window;
    const r = zoomRange(from, to, w.start, w.end, factor, anchor);
    if (r.from !== this.state.from || r.to !== this.state.to) this.setRange(r.from, r.to);
  }

  /** Where a client x falls across the plot area, 0 (left edge) to 1 (right edge). */
  private anchorAt(clientX: number): number {
    const svg = this.svgBox.querySelector("svg");
    if (!svg) return 0.5;
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * this.dims.w;
    return Math.max(0, Math.min(1, (px - this.dims.ml) / (this.dims.w - this.dims.ml - this.dims.mr)));
  }

  /** Zoom gestures that leave page scrolling alone: the wheel zooms only with ctrl or cmd held (a trackpad pinch
   * arrives as ctrl + wheel), a plain wheel scrolls the page; on touch only two fingers zoom, one finger still
   * scrolls the page (the chart has touch-action: pan-y) and moves the cursor. */
  private wireZoom(box: HTMLElement) {
    const later = (f: () => void) => {
      if (this.zoomFrame) return;
      this.zoomFrame = requestAnimationFrame(() => { this.zoomFrame = 0; f(); });
    };
    box.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.wheel.dy += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.wheel.anchor = this.anchorAt(e.clientX);
      later(() => {
        const dy = Math.max(-200, Math.min(200, this.wheel.dy));
        this.wheel.dy = 0;
        this.zoomBy(Math.exp(dy * 0.01), this.wheel.anchor);
      });
    }, { passive: false });
    const sb = this.svgBox;
    sb.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      this.touches.set(e.pointerId, e.clientX);
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        this.pinch = { d0: Math.max(10, Math.abs(a - b)), from: this.state.from, to: this.state.to, anchor: this.anchorAt((a + b) / 2) };
      }
    });
    sb.addEventListener("pointermove", (e) => {
      if (!this.touches.has(e.pointerId)) return;
      this.touches.set(e.pointerId, e.clientX);
      if (!this.pinch || this.touches.size !== 2) return;
      const [a, b] = [...this.touches.values()];
      const p = this.pinch, d = Math.max(10, Math.abs(a - b));
      later(() => this.zoomBy(p.d0 / d, p.anchor, p.from, p.to));
    });
    const up = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
    };
    sb.addEventListener("pointerup", up);
    sb.addEventListener("pointercancel", up);
  }

  /** Range buttons: aria-pressed on the one that matches the range in view. On a short window 3M and All can be the
   * same range; then both are pressed. */
  private syncQuick() {
    this.root.querySelectorAll<HTMLButtonElement>(".rbtn").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.from === this.state.from && b.dataset.to === this.state.to)));
  }

  /** The x position (epoch ms) of cursor index i: the hour's ts in hour mode, the day's noon otherwise. */
  private tAt(i: number): number {
    return this.g === "hour" ? this.input.hourly!.t[i] : utcMs(this.dates[i]) + DAY_MS / 2;
  }

  /** Values of a line at the cursor positions: hours for the Kalshi lines in hour mode, days otherwise. */
  private vals(k: SeriesKey): Num[] {
    return this.g === "hour" && k !== "news" ? this.input.hourly![k] : this.input.series[k];
  }

  /** Index range [a, b] of a line's points in view: attention is always by day, the Kalshi lines follow the zoom. */
  private span(k: SeriesKey): [number, number] {
    return k === "news" ? this.range() : this.view();
  }

  /** The day index of cursor index i. */
  private dayOf(i: number): number {
    if (this.g !== "hour") return i;
    return Math.round((utcMs(hourDay(this.input.hourly!.ts[i])) - utcMs(this.dates[0])) / DAY_MS);
  }

  /** The latest value of a candidate line in view (its last non-null value) and its cursor index (-1 if none). */
  latest(k: PriceKey): { i: number; v: Num } {
    const [a, b] = this.view();
    const v = this.vals(k);
    const i = lastValueIndex(v, a, b);
    return { i, v: i < 0 ? null : v[i] };
  }

  // ---------------------------------------------------------------- drawing
  private x!: ScaleTime<number, number>;
  private ys: Partial<Record<SeriesKey, ScaleLinear<number, number>>> = {};
  private dims = { w: 0, h: 0, ml: 0, mr: 0, mt: 0, mb: 0, axisW: 0 };
  private cursorG!: Selection<SVGGElement, unknown, null, undefined>;

  draw() {
    if (!this.svgBox) return;
    const { state, input } = this;
    const W = Math.max(280, Math.floor(this.svgBox.clientWidth || this.root.clientWidth || 800));
    const narrow = W < 560;
    const H = narrow ? 300 : 380;
    const vis = this.keys.filter((k) => state.visible[k]);
    const prices = vis.filter(isPrice);
    const leftKeys = vis.filter((k) => !isPrice(k));
    // left: one axis per visible volume or attention line. Right: the end of line labels, then the percent axis.
    // On phones the labels are smaller; the right margin is sized from the longest surname and "100.0%".
    const axisW = narrow ? 40 : 56;
    // gap: the height of a label block (name and percent text boxes), the least distance between two label centers
    const lab = narrow ? { name: 10, pct: 12, nameW: 5.6, pctW: 7.2, gap: 30 } : { name: 11, pct: 15, nameW: 6.3, pctW: 8.8, gap: 34 };
    const labelW = prices.length ? Math.ceil(Math.max(6 * lab.pctW, ...prices.map((k) => input.lines[k]!.surname.length * lab.nameW))) : 0;
    const pAxisW = prices.length ? (narrow ? 30 : 38) : 0;
    const ml = leftKeys.length ? leftKeys.length * axisW : 14;
    const mr = prices.length ? 10 + labelW + 6 + pAxisW : 14;
    const mt = leftKeys.length > 1 ? 44 : 30, mb = 28;  // two left axes: their titles go on two rows
    this.dims = { w: W, h: H, ml, mr, mt, mb, axisW };
    // granularity: hourly Kalshi for 14 days or fewer, when the race has series.display_hourly
    const H1 = input.hourly;
    const hr = H1 && H1.ts.length && granularityFor(state.from, state.to) === "hourly" ? hourlyRange(H1.ts, state.from, state.to) : null;
    const g: Granularity = hr ? "hour" : "day";
    if (g !== this.g && this.cursor !== null) {
      // keep the cursor on the same day: a day goes to its last hour in view, an hour to its day
      const c = this.cursor;
      this.cursor = g === "hour" ? (hourlyRange(H1!.ts, this.dates[c], this.dates[c])?.[1] ?? null) : this.dates.indexOf(hourDay(H1!.ts[c]));
      if (this.cursor !== null && this.cursor < 0) this.cursor = null;
    }
    this.g = g;
    this.hr = hr;
    this.syncGranularity();
    this.syncQuick();
    const [dlo, dhi] = this.range();
    const [lo, hi] = this.view();
    if (this.cursor !== null && (this.cursor < lo || this.cursor > hi)) this.cursor = null;
    // hourly: the axis ends one hour after the last candle in view (the window's last day has candles only until
    // the market closed), so the lines reach the right edge next to their labels
    const end = Math.min(utcMs(state.to) + DAY_MS, g === "hour" ? H1!.t[hi] + HOUR_MS : Infinity);
    const x = scaleUtc().domain([new Date(utcMs(state.from)), new Date(end)]).range([ml, W - mr]);
    this.x = x;
    const top = (k: SeriesKey) => {
      const [a, b] = this.span(k);
      return (max(this.vals(k).slice(a, b + 1).filter((z): z is number => z !== null)) ?? 1) || 1;
    };
    const yPrice = scaleLinear().domain([0, 100]).range([H - mb, mt]);
    this.ys = {};
    for (const k of vis) this.ys[k] = isPrice(k) ? yPrice : scaleLinear().domain([0, top(k)]).range([H - mb, mt]).nice(5);
    this.svgBox.innerHTML = "";
    const svg = select(this.svgBox).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H)
      .attr("class", "lc").attr("aria-hidden", "true").attr("data-granularity", g)
      .attr("data-xdomain", x.domain().map((d) => d.getTime()).join(",")).attr("data-xrange", x.range().join(","));
    const clipId = `${this.id}-clip`;
    svg.append("defs").append("clipPath").attr("id", clipId).append("rect")
      .attr("x", ml).attr("y", mt - 2).attr("width", W - ml - mr).attr("height", H - mt - mb + 4);
    // horizontal gridlines at the percent ticks, dotted; no vertical gridlines
    svg.append("g").attr("class", "grid").selectAll("line").data([0, 25, 50, 75, 100]).join("line")
      .attr("x1", ml).attr("x2", W - mr).attr("y1", (d) => yPrice(d)).attr("y2", (d) => yPrice(d));
    // election days: shaded band and label
    const e0 = input.election[0], e1 = input.election[input.election.length - 1];
    if (e0 && e1 && e1 >= state.from && e0 <= state.to) {
      const a = Math.max(ml, x(new Date(utcMs(e0)))), b = Math.min(W - mr, x(new Date(utcMs(e1) + DAY_MS)));
      const eg = svg.append("g").attr("data-mark", "election");
      eg.append("rect").attr("class", "eband").attr("x", a).attr("y", mt).attr("width", Math.max(1, b - a)).attr("height", H - mt - mb);
      // the label goes left of a band at the right edge, right of any other band, and inside a band that fills the plot
      const atRight = b - (W - mr) > -4, inside = atRight && a - ml < 150;
      eg.append("text").attr("x", inside ? a + 6 : atRight ? a - 4 : b + 4).attr("y", mt + 12)
        .attr("text-anchor", atRight && !inside ? "end" : "start").attr("class", "elabel").text(electionLabel(input.election));
    }
    // x axis: day ticks at 00:00 UTC (one every few days when they would crowd); within one or two days, hours
    const span = rangeDays(state.from, state.to);
    const fit = Math.max(2, Math.floor((W - ml - mr) / (g === "hour" ? 56 : 70)));  // a "Nov 3" label is about 45 px
    const [x0, x1] = x.domain();
    let xa;
    if (span <= 2) {
      const hours = (x1.getTime() - x0.getTime()) / HOUR_MS;
      const every = [1, 2, 3, 6, 12].find((n) => hours / n <= fit) ?? 12;
      const ticks = utcHour.every(every)!.range(x0, new Date(x1.getTime() + 1));
      xa = axisBottom(x).tickValues(ticks).tickFormat((d) => ((d as Date).getUTCHours() ? fmtHourTick(d as Date) : fmtDay(d as Date)));
    } else if (g === "hour") {
      const k = Math.ceil(span / fit);  // every k days from the range start, so the first day is always labeled
      xa = axisBottom(x).tickValues(utcDay.range(x0, x1).filter((_, i) => i % k === 0)).tickFormat((d) => fmtDay(d as Date));
    } else {
      xa = axisBottom(x).ticks(Math.max(2, Math.min(span, fit))).tickFormat((d) => fmtDay(d as Date));
    }
    svg.append("g").attr("class", "axis xaxis").attr("transform", `translate(0,${H - mb})`).call(xa);
    // left y axes (volume, attention), each with its series color and dash on the axis line
    leftKeys.forEach((k, j) => {
      const ag = svg.append("g").attr("class", `axis yaxis y-${k}`).attr("data-axis", k)
        .attr("transform", `translate(${ml - j * axisW},0)`)
        .call(axisLeft(this.ys[k]!).ticks(5).tickFormat((d) => fmtTick(d as number)));
      this.axisTitle(ag, k, j);
    });
    // the percent axis on the right, as on Kalshi: 0 to 100% in quarters, no axis line, right of the end labels
    if (prices.length) {
      svg.append("g").attr("class", "axis yaxis y-price").attr("data-axis", "price").attr("transform", `translate(${W - pAxisW},0)`)
        .call(axisRight(yPrice).tickValues([0, 25, 50, 75, 100]).tickSize(0).tickPadding(2).tickFormat((d) => `${d}%`));
    }
    // lines: a null value breaks the line (nothing is filled here); a lone point between gaps is drawn as a dot. In
    // hour mode the Kalshi lines have one point per hour (at the candle's ts) and attention is a step line, flat
    // across each UTC day. Volume and attention are drawn under the candidate lines.
    const lines = svg.append("g").attr("clip-path", `url(#${clipId})`);
    for (const k of [...leftKeys, ...prices]) {
      const y = this.ys[k]!;
      const st = this.style(k);
      // data-domain and data-range let the render check read values back from the path coordinates
      const path = lines.append("path").attr("class", `line line-${k}`).attr("data-series", k)
        .attr("data-domain", y.domain().join(",")).attr("data-range", y.range().join(","))
        .attr("stroke-dasharray", st.dash).attr("stroke-linecap", st.dash ? "butt" : "round");
      if (k === "news" && g === "hour") {
        const steps = dailyToSteps(this.dates.slice(dlo, dhi + 1).map((date, j) => ({ date, v: input.series.news[dlo + j] })));
        path.attr("data-step", "true").attr("d", line<{ t: number; v: Num }>().defined((p) => p.v !== null).curve(curveStepAfter)
          .x((p) => x(new Date(p.t))).y((p) => y(p.v as number))(steps));
        continue;
      }
      const v = this.vals(k);
      const [a, b] = this.span(k);
      const cx = (i: number) => x(new Date(k === "news" ? utcMs(this.dates[i]) + DAY_MS / 2 : this.tAt(i)));
      const idx: number[] = [];
      for (let i = a; i <= b; i++) idx.push(i);
      path.attr("d", line<number>().defined((i) => v[i] !== null).x(cx).y((i) => y(v[i] as number))(idx));
      const lone = idx.filter((i) => v[i] !== null && (i === a || v[i - 1] === null) && (i === b || v[i + 1] === null));
      lines.append("g").selectAll("circle").data(lone).join("circle").attr("class", `lone lone-${k}`).attr("r", 2.6)
        .attr("cx", cx).attr("cy", (i) => y(v[i] as number));
    }
    this.endLabels(svg, prices, lab, W - mr + 10);
    this.cursorG = svg.append("g").attr("class", "cursor");
    // pointer and touch: the nearest hour (bisector on the hours in view) or the day under the pointer
    const pick = (ev: PointerEvent) => {
      if (this.pinch) return;
      const r = (ev.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const t = x.invert(px).getTime();
      let i = g === "hour" ? bisectT.center(H1!.t, t, lo, hi + 1) : Math.floor((t - utcMs(this.dates[0])) / DAY_MS);
      i = Math.max(lo, Math.min(hi, i));
      if (i !== this.cursor) this.setCursor(i);
    };
    svg.append("rect").attr("class", "hit").attr("x", ml).attr("y", mt).attr("width", W - ml - mr).attr("height", H - mt - mb)
      .attr("fill", "transparent").style("touch-action", "pan-y")
      .on("pointermove", pick).on("pointerdown", pick);
    this.drawCursor();
    this.drawBrush();
  }

  /** End of line labels, as on Kalshi: a dot on each candidate line's last value in view, then right of the plot in
   * the line color the surname (small) over the latest percent (larger, bold). Close labels are nudged apart
   * (nudgeLabels) and kept inside the plot. The legend entries show the same latest values. */
  private endLabels(svg: Selection<SVGSVGElement, unknown, null, undefined>, prices: PriceKey[],
                    f: { name: number; pct: number; gap: number }, lx: number) {
    const { mt, mb, h } = this.dims;
    const got = prices.map((k) => ({ k, ...this.latest(k) })).filter((p) => p.v !== null);
    for (const k of PRICE_KEYS) {
      const el = this.root.querySelector<HTMLElement>(`.lg-val[data-k="${k}"]`);
      const p = got.find((q) => q.k === k);
      if (el) el.textContent = p ? ` ${fmtPrice(p.v!)}%` : "";
    }
    if (!got.length) return;
    const y = this.ys[got[0].k]!;
    // the label block (name above, percent below) is centered on its y
    const half = f.gap / 2;
    const at = nudgeLabels(got.map((p) => y(p.v!)), f.gap, mt + half, h - mb - half);
    const g = svg.append("g").attr("class", "endlabels");
    got.forEach((p, j) => {
      g.append("circle").attr("class", `enddot enddot-${p.k}`).attr("cx", this.x(new Date(this.tAt(p.i)))).attr("cy", y(p.v!)).attr("r", 3.5);
      const t = g.append("g").attr("class", `endlabel endlabel-${p.k}`).attr("data-k", p.k).attr("data-value", fmtPrice(p.v!));
      t.append("text").attr("class", "el-name").attr("x", lx).attr("y", at[j] - 3).style("font-size", `${f.name}px`)
        .text(this.input.lines[p.k]!.surname);
      t.append("text").attr("class", "el-pct").attr("x", lx).attr("y", at[j] + f.pct - 2).style("font-size", `${f.pct}px`)
        .text(`${fmtPrice(p.v!)}%`);
    });
  }

  /** Title over a left axis. style.css gives the axis line the series color and dash (.y-volume and so on) and
   * keeps all axis text muted, so no text depends on a series color for contrast. */
  private axisTitle(g: Selection<SVGGElement, unknown, null, undefined>, k: SeriesKey, row = 0) {
    g.append("text").attr("class", "atitle").attr("x", -this.dims.axisW + 2).attr("y", this.dims.mt - 14 - row * 14)
      .attr("text-anchor", "start").text(axisTitle(k, this.input.attention, this.g));
  }

  /** The "Kalshi: hourly / daily" label, the volume legend text and the attention note follow the granularity. */
  private syncGranularity() {
    const g = this.g;
    const label = this.root.querySelector<HTMLElement>("#gran");
    if (label && label.textContent !== kalshiLabel(g)) label.textContent = kalshiLabel(g);  // aria-live: only on a change
    if (label) label.dataset.granularity = g;
    const vd = this.root.querySelector<HTMLElement>("#lg-volume .lg-desc");
    if (vd) vd.textContent = legendText("volume", this.input.attention, g, this.input.lines).desc;
    const note = this.root.querySelector<HTMLElement>("#att-note");
    if (note) {
      note.textContent = attentionNote(this.input.attention ?? "news");
      note.hidden = g !== "hour";
    }
  }

  /** The readout note of an hour: a contract with no trades (or a null price) that hour, price carried forward. With
   * both candidate lines on it names the contract. */
  private hourNotes(ts: string): string {
    const H1 = this.input.hourly!, fl = this.input.lines;
    const followed = PRICE_KEYS.find((k) => fl[k]?.daily === PRICE_COL);
    const other = PRICE_KEYS.find((k) => k !== followed && this.keys.includes(k) && this.state.visible[k]);
    const own = hourNote(ts, H1);
    const notes: string[] = [];
    if (own) notes.push(followed && other ? `${fl[followed]!.surname} contract: ${own}` : own);
    if (other && H1.filledR?.has(ts)) notes.push(`${fl[other]!.surname} contract: ${NO_TRADES}`);
    return notes.join("; ");
  }

  private drawCursor() {
    const out = this.root.querySelector<HTMLElement>("#readout");
    if (!this.cursorG || !out) return;
    const g = this.cursorG;
    g.selectAll("*").remove();
    const i = this.cursor;
    if (i === null) {
      out.innerHTML = `Point at the chart, tap it, or focus it and use the arrow keys to read the values for ${
        this.g === "hour" ? "an hour" : "a day"}.`;
      this.tip.hidden = true;
      return;
    }
    const { h, mt, mb, w } = this.dims;
    const hour = this.g === "hour";
    const ts = hour ? this.input.hourly!.ts[i] : null;
    const di = this.dayOf(i);
    const date = this.dates[di];
    const cx = this.x(new Date(this.tAt(i)));
    // the crosshair: a thin vertical line and a dot on each visible line
    g.append("line").attr("x1", cx).attr("x2", cx).attr("y1", mt).attr("y2", h - mb);
    const vis = this.keys.filter((k) => this.state.visible[k]);
    const value = (k: SeriesKey) => (k === "news" ? this.input.series.news[di] : this.vals(k)[i]);
    for (const k of vis) {
      const v = value(k);
      if (v === null) continue;
      g.append("circle").attr("class", `cdot-${k}`).attr("cx", cx).attr("cy", this.ys[k]!(v)).attr("r", 4.5);
    }
    // in hour mode: a price is the hour's last price, volume the hour's contracts, attention the whole UTC day's value
    const label = (k: SeriesKey) => !hour ? this.style(k).short
      : isPrice(k) ? `${this.style(k).short}, end of hour` : k === "volume" ? `${this.style(k).short}, this hour`
      : `${this.style(k).short}, all of ${fmtDayShort(date)}`;
    const parts = vis.map((k) => `<span class="rd" data-k="${k}"><span class="rk" data-k="${k}">${
      esc(label(k))}</span> <span class="rv" data-v="${k}">${esc(this.fmt(k, value(k)))}</span></span>`);
    const when = ts ? fmtHour(ts) : `${fmtLong(new Date(utcMs(date)))}, UTC`;
    const note = ts ? this.hourNotes(ts) : "";
    const dateText = `<span class="rdate" data-date="${date}"${ts ? ` data-ts="${ts}"` : ""}>${esc(when)}</span>`;
    const noteText = note ? `<span class="sep">; </span><span class="rnote" id="rnote">${esc(note)}</span>` : "";
    out.innerHTML = `${dateText}<span class="sep">:</span> ${parts.join('<span class="sep">; </span>')}${noteText}`;
    this.tip.innerHTML = `<strong class="twhen">${esc(when)}</strong>${vis.map((k) =>
      `<div class="trow"><span class="rk" data-k="${k}">${esc(label(k))}</span> <span class="tv" data-v="${k}">${
        esc(this.fmt(k, value(k)))}</span></div>`).join("")}${note ? `<div class="tnote">${esc(note)}</div>` : ""}`;
    this.tip.hidden = false;
    // one box next to the crosshair: right of it, or left of it when it would pass the plot's right edge (so it
    // never covers the end of line labels); always inside the chart box and the viewport
    const boxW = this.svgBox.clientWidth;
    const scale = boxW / w || 1;
    const left = cx * scale;
    const tw = this.tip.offsetWidth;
    const boxLeft = this.svgBox.getBoundingClientRect().left;
    const right = Math.min((w - this.dims.mr) * scale, document.documentElement.clientWidth - boxLeft);
    let tl = left + 12 + tw > right ? left - 12 - tw : left + 12;
    tl = Math.max(Math.max(0, -boxLeft), Math.min(right - tw, tl));
    this.tip.style.left = `${tl}px`;
    this.tip.style.top = `${mt * scale + 6}px`;
  }

  /** The brush strip: the whole window with the dates in view selected. Snaps to whole days. */
  private drawBrush() {
    const { input, state } = this;
    const { w, ml, mr } = this.dims;
    const H = 48;
    const x = scaleUtc().domain([new Date(utcMs(input.window.start)), new Date(utcMs(input.window.end) + DAY_MS)]).range([ml, w - mr]);
    this.brushBox.innerHTML = "";
    const svg = select(this.brushBox).append("svg").attr("viewBox", `0 0 ${w} ${H + 26}`).attr("width", w).attr("height", H + 26)
      .attr("class", "brush-svg");
    const p = this.input.series[this.input.lines.dem ? "dem" : "rep"];
    const y = scaleLinear().domain([0, 100]).range([H - 4, 4]);
    svg.append("rect").attr("class", "strip").attr("x", ml).attr("y", 0).attr("width", w - ml - mr).attr("height", H);
    svg.append("path").attr("class", "mini")
      .attr("d", line<number>().defined((i) => p[i] !== null).x((i) => x(new Date(utcMs(this.dates[i]) + DAY_MS / 2)))
        .y((i) => y(p[i] as number))(this.dates.map((_, i) => i)));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H})`)
      .call(axisBottom(x).ticks(Math.max(2, Math.floor((w - ml - mr) / 80))).tickFormat((d) => fmtDay(d as Date)));
    const brush = brushX().extent([[ml, 0], [w - mr, H]]).handleSize(18)
      .on("end", (ev) => {
        if (this.settingBrush || !ev.sourceEvent) return;
        if (!ev.selection) { this.setRange(input.window.start, input.window.end); return; }
        const [a, b] = ev.selection as [number, number];
        const day = (px: number) => new Date(Math.round(x.invert(px).getTime() / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
        const from = clampDate(day(a), input.window.start, input.window.end);
        const to = clampDate(addDays(day(b), -1), input.window.start, input.window.end);
        if (!this.setRange(from, to < from ? from : to)) this.draw();
      });
    const g = svg.append("g").attr("class", "brush").call(brush);
    this.settingBrush = true;
    g.call(brush.move, [x(new Date(utcMs(state.from))), x(new Date(utcMs(state.to) + DAY_MS))]);
    this.settingBrush = false;
  }
}
