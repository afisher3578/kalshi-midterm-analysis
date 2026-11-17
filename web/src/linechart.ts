// The dashboard chart: one line chart for the selected race with three series on their own y axes (Kalshi price
// on the left, Kalshi volume and media attention on the right), a legend whose entries switch each line and its
// y axis, a date range (two date inputs, quick range buttons, a brush, ctrl or cmd + wheel and two finger pinch)
// and a cursor for pointer, touch and keyboard. Data: series.display_daily; when the range is 14 days or fewer
// the Kalshi lines come from series.display_hourly and attention (daily only) is drawn as a step line.
import { axisBottom, axisLeft, axisRight, bisector, brushX, curveStepAfter, format, line, max, type ScaleLinear, scaleLinear,
  type ScaleTime, scaleUtc, select, type Selection, utcDay, utcFormat, utcHour } from "d3";
import { attentionNote, axisTitle, type ChartSeries, checkRange, clampDate, dailyToSteps, fmtDayShort, fmtHour,
  type Granularity, granularityFor, hourDay, hourlyRange, type HourlySeries, hourNote, kalshiLabel, legendText, lockedLine,
  PRICE_WHY, quickRanges, rangeDays, SERIES_KEYS, type SeriesKey, toggleLine, zoomRange } from "./display";
import { esc } from "./race";
import { DAY_MS, utcMs } from "./transforms";
import type { Num } from "./types";

// Colors are the --series-* variables in style.css (Flexoki blue, red and green; 600 shades light, 400 dark), so a
// theme switch recolors the chart without a redraw. Each line also has its own dash.
export const SERIES_STYLE: Record<SeriesKey, { label: string; short: string; unit: string; color: string; dash: string | null }> = {
  price: { label: "Kalshi price (Democratic win, % chance)", short: "Kalshi price", unit: "%", color: "var(--series-price)", dash: null },
  volume: { label: "Kalshi volume (contracts per day)", short: "Kalshi volume", unit: "contracts", color: "var(--series-volume)", dash: "7,4" },
  news: { label: "Media attention (news stories per day)", short: "Media attention", unit: "stories", color: "var(--series-news)", dash: "2,3" },
};
// the attention line when the source is Wikipedia (ChartInput.attention); same slot, color and dash as news
const WIKI_STYLE = { ...SERIES_STYLE.news, label: "Wikipedia attention (pageviews per day)", short: "Wikipedia attention",
  unit: "pageviews" };

export interface ChartState {
  visible: Record<SeriesKey, boolean>;
  from: string;
  to: string;
  newsAutoOff?: boolean;  // news was switched off because the race had none; it comes back for a race with news
}

export interface ChartInput {
  series: ChartSeries;
  title: string;
  window: { start: string; end: string };
  election: string[];       // shaded days, e.g. election day and the day after
  news: { available: boolean; status: string };
  demo: boolean;
  attention?: "news" | "wikipedia";  // what the attention line plots (default news)
  hourly?: HourlySeries | null;      // series.display_hourly; without it the Kalshi lines stay daily at every zoom
  electionDate: string;              // the race's election day, for the "Last 7 days before the election" button
}

const fmtDay = utcFormat("%b %-d");
const fmtLong = utcFormat("%a %b %-d, %Y");
const fmtPrice = format(".1f");
const fmtVolume = format(",.2~f");
const fmtNews = format(",.0f");
const fmtTick = format(".2~s");
let uid = 0;

export function formatValue(key: SeriesKey, v: Num, attention: "news" | "wikipedia" = "news"): string {
  if (v === null) return "no data";
  if (key === "price") return `${fmtPrice(v)}%`;
  if (key === "volume") return `${fmtVolume(v)} contracts`;
  return `${fmtNews(v)} ${attention === "wikipedia" ? "pageviews" : "stories"}`;
}

function addDays(d: string, n: number): string {
  return new Date(utcMs(d) + n * DAY_MS).toISOString().slice(0, 10);
}

const fmtHourTick = utcFormat("%H:00");
const bisectT = bisector((t: number) => t);

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

  /** Label, unit and color of a line; the attention line follows the chosen source. */
  style(k: SeriesKey) { return k === "news" && this.wiki ? WIKI_STYLE : SERIES_STYLE[k]; }

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
    if (!SERIES_KEYS.some((k) => state.visible[k])) state.visible.price = true;
    state.from = clampDate(state.from || input.window.start, input.window.start, input.window.end);
    state.to = clampDate(state.to || input.window.end, input.window.start, input.window.end);
    if (state.from > state.to) [state.from, state.to] = [input.window.start, input.window.end];
    const entry = (k: SeriesKey) => {
      const s = this.style(k);
      const t = legendText(k, this.input.attention, "day");  // volume follows the zoom in draw(); attention stays per day
      const off = k === "news" && !input.news.available
        ? ` <span class="lg-off">(no ${this.wiki ? "Wikipedia" : "news"} data for this race yet)</span>` : "";
      const why = k === "price" ? `<button type="button" class="lg-why" id="lg-why" aria-expanded="false"
        aria-controls="lg-note" aria-label="Why is there no Republican line?">why?</button>` : "";
      return `<li class="lg-item" data-key="${k}"><button type="button" class="lg-btn" id="lg-${k}" data-key="${k}"
        aria-pressed="${state.visible[k]}"><svg class="swatch" viewBox="0 0 30 10" width="30" height="10" aria-hidden="true"><line
        x1="1" y1="5" x2="29" y2="5"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/></svg><span class="lg-text"><strong
        class="lg-name">${esc(t.name)}</strong><span class="vh">:</span> <span class="lg-desc">${esc(t.desc)}</span>${off}</span></button>${why}</li>`;
    };
    this.root.innerHTML = `
      <h2 id="chart-h" class="charttitle">${esc(input.title)}: Kalshi price, Kalshi volume and ${this.wiki ? "Wikipedia" : "media"} attention</h2>
      ${input.demo ? '<p class="demo-banner" id="demo-label">Demo data</p>' : ""}
      <p class="status" id="news-status" data-news="${input.news.available ? "yes" : "no"}">${esc(input.news.status)}</p>
      <div class="lgbox">
        <ul class="lg" id="legend" aria-label="Lines on the chart; each button shows or hides a line and its y axis">
          ${SERIES_KEYS.map(entry).join("")}</ul>
        <p class="lg-note" id="lg-note" hidden>${esc(PRICE_WHY)}</p>
        <p class="hint" id="tg-note" aria-live="polite"></p>
        <p class="gran" id="gran" aria-live="polite">${kalshiLabel("day")}</p>
      </div>
      <div class="chartbox" id="chart" tabindex="0" role="group"
        aria-label="Line chart, ${esc(input.title)}. Use the left and right arrow keys to move the cursor one day, or one hour when the chart is hourly; Shift with an arrow key, Page Up and Page Down move further. The values are read out below the chart."
        aria-describedby="readout"><div class="chartsvg"></div><div class="tip" aria-hidden="true" hidden></div></div>
      <p class="hint" id="att-note" hidden></p>
      <div class="brushbox" aria-hidden="true"></div>
      <p class="hint brushhint">Drag across the strip above to pick dates, or use the date fields. Ranges of 14 days or fewer show Kalshi by the hour.</p>
      <form class="range" id="range" novalidate>
        <div class="f"><label for="d-from">Start date</label><input type="date" id="d-from" min="${input.window.start}"
          max="${input.window.end}" value="${state.from}" aria-describedby="range-msg"></div>
        <div class="f"><label for="d-to">End date</label><input type="date" id="d-to" min="${input.window.start}"
          max="${input.window.end}" value="${state.to}" aria-describedby="range-msg"></div>
        <button type="button" id="d-reset">Reset</button>
        <div class="quick" role="group" aria-label="Quick ranges">${quickRanges(input.window, input.electionDate).map((q) =>
          `<button type="button" class="qbtn" id="q-${q.id}" data-from="${q.from}" data-to="${q.to}" aria-pressed="false">${
            esc(q.label)}</button>`).join("")}</div>
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
      state.visible = toggleLine(state.visible, k);
      this.syncToggles();
      this.changed();
    }));
    const why = this.root.querySelector<HTMLButtonElement>("#lg-why")!;
    const note = this.root.querySelector<HTMLElement>("#lg-note")!;
    why.addEventListener("click", () => {
      const open = why.getAttribute("aria-expanded") !== "true";
      why.setAttribute("aria-expanded", String(open));
      note.hidden = !open;
    });
    const from = this.root.querySelector<HTMLInputElement>("#d-from")!;
    const to = this.root.querySelector<HTMLInputElement>("#d-to")!;
    const onDate = () => this.setRange(from.value, to.value);
    from.addEventListener("change", onDate);
    to.addEventListener("change", onDate);
    this.root.querySelector("#range")!.addEventListener("submit", (e) => { e.preventDefault(); onDate(); });
    this.root.querySelector("#d-reset")!.addEventListener("click", () => this.setRange(input.window.start, input.window.end));
    this.root.querySelectorAll<HTMLButtonElement>(".qbtn").forEach((b) =>
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
    const locked = lockedLine(this.state.visible);
    for (const k of SERIES_KEYS) {
      const b = this.root.querySelector<HTMLButtonElement>(`#lg-${k}`)!;
      const unavailable = k === "news" && !this.input.news.available;
      b.setAttribute("aria-pressed", String(this.state.visible[k]));
      if (unavailable || locked === k) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    }
    this.root.querySelector("#tg-note")!.textContent = locked
      ? `${legendText(locked, this.input.attention).name} is the only line on, so it cannot be switched off.` : "";
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

  /** Quick range buttons: aria-pressed on the one that matches the range in view. */
  private syncQuick() {
    this.root.querySelectorAll<HTMLButtonElement>(".qbtn").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.from === this.state.from && b.dataset.to === this.state.to)));
  }

  /** The x position (epoch ms) of cursor index i: the hour's ts in hour mode, the day's noon otherwise. */
  private tAt(i: number): number {
    return this.g === "hour" ? this.input.hourly!.t[i] : utcMs(this.dates[i]) + DAY_MS / 2;
  }

  /** Values of a line at the cursor positions: hours for price and volume in hour mode, days otherwise. */
  private vals(k: SeriesKey): Num[] {
    return this.g === "hour" && k !== "news" ? this.input.hourly![k] : this.input.series[k];
  }

  /** The day index of cursor index i. */
  private dayOf(i: number): number {
    if (this.g !== "hour") return i;
    return Math.round((utcMs(hourDay(this.input.hourly!.ts[i])) - utcMs(this.dates[0])) / DAY_MS);
  }

  // ---------------------------------------------------------------- drawing
  private x!: ScaleTime<number, number>;
  private ys: Partial<Record<SeriesKey, ScaleLinear<number, number>>> = {};
  private dims = { w: 0, h: 0, ml: 0, mr: 0, mt: 0, mb: 0 };
  private cursorG!: Selection<SVGGElement, unknown, null, undefined>;

  draw() {
    if (!this.svgBox) return;
    const { state, input } = this;
    const W = Math.max(280, Math.floor(this.svgBox.clientWidth || this.root.clientWidth || 800));
    const H = W < 560 ? 300 : 380;
    const vis = SERIES_KEYS.filter((k) => state.visible[k]);
    const rightKeys = vis.filter((k) => k !== "price");
    const axisW = W < 560 ? 44 : 56;
    const ml = state.visible.price ? axisW : 14;
    const mr = 14 + rightKeys.length * axisW;
    const mt = rightKeys.length > 1 ? 44 : 30, mb = 28;  // two right axes: their titles go on two rows
    this.dims = { w: W, h: H, ml, mr, mt, mb };
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
    const x = scaleUtc().domain([new Date(utcMs(state.from)), new Date(utcMs(state.to) + DAY_MS)]).range([ml, W - mr]);
    this.x = x;
    const inView = (k: SeriesKey) => (k === "news" ? input.series.news.slice(dlo, dhi + 1) : this.vals(k).slice(lo, hi + 1))
      .filter((z): z is number => z !== null);
    const top = (k: SeriesKey) => (max(inView(k)) ?? 1) || 1;
    this.ys = {};
    for (const k of vis) {
      const dom: [number, number] = k === "price" ? [0, 100] : [0, top(k)];
      const y = scaleLinear().domain(dom).range([H - mb, mt]);
      if (k !== "price") y.nice(5);
      this.ys[k] = y;
    }
    this.svgBox.innerHTML = "";
    const svg = select(this.svgBox).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H)
      .attr("class", "lc").attr("aria-hidden", "true").attr("data-granularity", g)
      .attr("data-xdomain", x.domain().map((d) => d.getTime()).join(",")).attr("data-xrange", x.range().join(","));
    const clipId = `${this.id}-clip`;
    svg.append("defs").append("clipPath").attr("id", clipId).append("rect")
      .attr("x", ml).attr("y", mt - 2).attr("width", W - ml - mr).attr("height", H - mt - mb + 4);
    // election days: shaded band and label
    const e0 = input.election[0], e1 = input.election[input.election.length - 1];
    if (e0 && e1 && e1 >= state.from && e0 <= state.to) {
      const a = Math.max(ml, x(new Date(utcMs(e0)))), b = Math.min(W - mr, x(new Date(utcMs(e1) + DAY_MS)));
      const g = svg.append("g").attr("data-mark", "election");
      g.append("rect").attr("class", "eband").attr("x", a).attr("y", mt).attr("width", Math.max(1, b - a)).attr("height", H - mt - mb);
      const lx = b - (W - mr) > -4 ? a - 4 : b + 4;
      g.append("text").attr("x", lx).attr("y", mt + 12).attr("text-anchor", b - (W - mr) > -4 ? "end" : "start")
        .attr("class", "elabel")
        .text(electionLabel(input.election));
    }
    // x axis: day ticks at 00:00 UTC (one every few days when they would crowd); within one or two days, hours
    const span = rangeDays(state.from, state.to);
    const fit = Math.max(2, Math.floor((W - ml - mr) / (g === "hour" ? 56 : 70)));  // a "Nov 3" label is about 45 px
    const [x0, x1] = x.domain();
    let xa;
    if (span <= 2) {
      const ticks = utcHour.every(span === 1 ? (fit >= 8 ? 3 : 6) : (fit >= 8 ? 6 : 12))!.range(x0, new Date(x1.getTime() + 1));
      xa = axisBottom(x).tickValues(ticks).tickFormat((d) => ((d as Date).getUTCHours() ? fmtHourTick(d as Date) : fmtDay(d as Date)));
    } else if (g === "hour") {
      const k = Math.ceil(span / fit);  // every k days from the range start, so the first day is always labeled
      xa = axisBottom(x).tickValues(utcDay.range(x0, x1).filter((_, i) => i % k === 0)).tickFormat((d) => fmtDay(d as Date));
    } else {
      xa = axisBottom(x).ticks(Math.max(2, Math.min(span, fit))).tickFormat((d) => fmtDay(d as Date));
    }
    svg.append("g").attr("class", "axis xaxis").attr("transform", `translate(0,${H - mb})`).call(xa);
    // y axes, each in its series color
    rightKeys.forEach((k, j) => {
      const g = svg.append("g").attr("class", `axis yaxis y-${k}`).attr("data-axis", k)
        .attr("transform", `translate(${W - mr + j * axisW},0)`)
        .call(axisRight(this.ys[k]!).ticks(5).tickFormat((d) => fmtTick(d as number)));
      this.axisTitle(g, k, "start", j);
    });
    if (state.visible.price) {
      const g = svg.append("g").attr("class", "axis yaxis y-price").attr("data-axis", "price").attr("transform", `translate(${ml},0)`)
        .call(axisLeft(this.ys.price!).tickValues([0, 25, 50, 75, 100]).tickFormat((d) => `${d}%`));
      this.axisTitle(g, "price", "end");
    }
    // grid
    const gy = scaleLinear().domain([0, 100]).range([H - mb, mt]);
    svg.insert("g", ".axis").attr("class", "grid").selectAll("line").data([25, 50, 75, 100]).join("line")
      .attr("x1", ml).attr("x2", W - mr).attr("y1", (d) => gy(d)).attr("y2", (d) => gy(d));
    // lines: null values break the line; a lone point between gaps is drawn as a dot. In hour mode price and
    // volume have one point per hour (at the candle's ts) and attention is a step line, flat across each UTC day.
    const lines = svg.append("g").attr("clip-path", `url(#${clipId})`);
    for (const k of vis) {
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
      const v = k === "news" ? input.series.news : this.vals(k);
      const [a, b] = k === "news" ? [dlo, dhi] : [lo, hi];
      const cx = (i: number) => x(new Date(k === "news" ? utcMs(this.dates[i]) + DAY_MS / 2 : this.tAt(i)));
      const idx: number[] = [];
      for (let i = a; i <= b; i++) idx.push(i);
      path.attr("d", line<number>().defined((i) => v[i] !== null).x(cx).y((i) => y(v[i] as number))(idx));
      const lone = idx.filter((i) => v[i] !== null && (i === a || v[i - 1] === null) && (i === b || v[i + 1] === null));
      lines.append("g").selectAll("circle").data(lone).join("circle").attr("class", `lone lone-${k}`).attr("r", 2.6)
        .attr("cx", cx).attr("cy", (i) => y(v[i] as number));
    }
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

  /** Axis title. style.css gives the axis line the series color and dash (.y-price and so on) and keeps all axis
   * text muted, so no text depends on a series color for contrast. */
  private axisTitle(g: Selection<SVGGElement, unknown, null, undefined>, k: SeriesKey, anchor: "start" | "end", row = 0) {
    g.append("text").attr("class", "atitle").attr("x", anchor === "end" ? -this.dims.ml + 2 : 2).attr("y", this.dims.mt - 14 - row * 14)
      .attr("text-anchor", "start").text(axisTitle(k, this.input.attention, this.g));
  }

  /** The "Kalshi: hourly / daily" label, the volume legend text and the attention note follow the granularity. */
  private syncGranularity() {
    const g = this.g;
    const label = this.root.querySelector<HTMLElement>("#gran");
    if (label && label.textContent !== kalshiLabel(g)) label.textContent = kalshiLabel(g);  // aria-live: only on a change
    if (label) label.dataset.granularity = g;
    const vd = this.root.querySelector<HTMLElement>("#lg-volume .lg-desc");
    if (vd) vd.textContent = legendText("volume", this.input.attention, g).desc;
    const note = this.root.querySelector<HTMLElement>("#att-note");
    if (note) {
      note.textContent = attentionNote(this.input.attention ?? "news");
      note.hidden = g !== "hour";
    }
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
    g.append("line").attr("x1", cx).attr("x2", cx).attr("y1", mt).attr("y2", h - mb);
    const vis = SERIES_KEYS.filter((k) => this.state.visible[k]);
    const value = (k: SeriesKey) => (k === "news" ? this.input.series.news[di] : this.vals(k)[i]);
    for (const k of vis) {
      const v = value(k);
      if (v === null) continue;
      g.append("circle").attr("class", `cdot-${k}`).attr("cx", cx).attr("cy", this.ys[k]!(v)).attr("r", 4.5);
    }
    // in hour mode: price is the hour's last price, volume the hour's contracts, attention the whole UTC day's value
    const label = (k: SeriesKey) => !hour ? this.style(k).short
      : k === "price" ? `${this.style(k).short}, end of hour` : k === "volume" ? `${this.style(k).short}, this hour`
      : `${this.style(k).short}, all of ${fmtDayShort(date)}`;
    const parts = vis.map((k) => `<span class="rd" data-k="${k}"><span class="rk" data-k="${k}">${
      esc(label(k))}</span> <span class="rv" data-v="${k}">${esc(this.fmt(k, value(k)))}</span></span>`);
    const when = ts ? fmtHour(ts) : `${fmtLong(new Date(utcMs(date)))}, UTC`;
    const note = ts ? hourNote(ts, this.input.hourly!) : "";
    const dateText = `<span class="rdate" data-date="${date}"${ts ? ` data-ts="${ts}"` : ""}>${esc(when)}</span>`;
    const noteText = note ? `<span class="sep">; </span><span class="rnote" id="rnote">${esc(note)}</span>` : "";
    out.innerHTML = `${dateText}<span class="sep">:</span> ${parts.join('<span class="sep">; </span>')}${noteText}`;
    this.tip.innerHTML = `<strong>${esc(when)}</strong>${vis.map((k) =>
      `<div><span class="rk" data-k="${k}">${esc(label(k))}</span> ${esc(this.fmt(k, value(k)))}</div>`).join("")}${
      note ? `<div class="tnote">${esc(note)}</div>` : ""}`;
    this.tip.hidden = false;
    const scale = this.svgBox.clientWidth / w || 1;
    const left = cx * scale;
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${left + 12 + tw > this.svgBox.clientWidth ? Math.max(0, left - 12 - tw) : left + 12}px`;
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
    const p = this.input.series.price;
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
