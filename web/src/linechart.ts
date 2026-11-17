// The dashboard chart: one line chart for the selected race with three series on their own y axes (Kalshi price
// on the left, Kalshi volume and media attention on the right), a legend whose entries switch each line and its
// y axis, a date range (two date inputs plus a brush) and a day cursor for pointer, touch and keyboard.
// Data: series.display_daily.
import { axisBottom, axisLeft, axisRight, brushX, format, line, max, type ScaleLinear, scaleLinear, type ScaleTime, scaleUtc,
  select, type Selection, utcFormat } from "d3";
import { type ChartSeries, checkRange, clampDate, type Granularity, legendText, lockedLine, PRICE_WHY, SERIES_KEYS, type SeriesKey,
  toggleLine } from "./display";
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
const AXIS_TITLE: Record<SeriesKey, string> = { price: "Price, %", volume: "Volume", news: "Stories" };

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
  granularity?: Granularity;         // one point per day (default) or per hour; the legend says "per day" or "per hour"
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

  constructor(readonly root: HTMLElement, public input: ChartInput, public state: ChartState,
              readonly onChange: (s: ChartState) => void = () => {}) {}

  get dates(): string[] { return this.input.series.dates; }

  private get wiki(): boolean { return this.input.attention === "wikipedia"; }

  /** Label, unit and color of a line; the attention line follows the chosen source. */
  style(k: SeriesKey) { return k === "news" && this.wiki ? WIKI_STYLE : SERIES_STYLE[k]; }

  private fmt(k: SeriesKey, v: Num): string { return formatValue(k, v, this.input.attention); }

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
      const t = legendText(k, this.input.attention, input.granularity);
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
      </div>
      <div class="chartbox" id="chart" tabindex="0" role="group"
        aria-label="Line chart, ${esc(input.title)}. Use the left and right arrow keys to move the day cursor; the values are read out below the chart."
        aria-describedby="readout"><div class="chartsvg"></div><div class="tip" aria-hidden="true" hidden></div></div>
      <div class="brushbox" aria-hidden="true"></div>
      <p class="hint brushhint">Drag across the strip above to pick dates, or use the date fields.</p>
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
    const box = this.root.querySelector<HTMLElement>("#chart")!;
    box.addEventListener("keydown", (e) => this.onKey(e));
    box.addEventListener("focus", () => { if (this.cursor === null) this.setCursor(this.range()[1]); });
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
    const [lo, hi] = this.range();
    const c = this.cursor ?? hi;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -7, PageDown: 7 };
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
    const [lo, hi] = this.range();
    if (this.cursor !== null && (this.cursor < lo || this.cursor > hi)) this.cursor = null;
    const x = scaleUtc().domain([new Date(utcMs(state.from)), new Date(utcMs(state.to) + DAY_MS)]).range([ml, W - mr]);
    this.x = x;
    const inView = (v: Num[]) => v.slice(lo, hi + 1).filter((z): z is number => z !== null);
    const top = (k: SeriesKey) => (max(inView(input.series[k])) ?? 1) || 1;
    this.ys = {};
    for (const k of vis) {
      const dom: [number, number] = k === "price" ? [0, 100] : [0, top(k)];
      const y = scaleLinear().domain(dom).range([H - mb, mt]);
      if (k !== "price") y.nice(5);
      this.ys[k] = y;
    }
    this.svgBox.innerHTML = "";
    const svg = select(this.svgBox).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H)
      .attr("class", "lc").attr("aria-hidden", "true")
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
    // x axis
    const span = (utcMs(state.to) - utcMs(state.from)) / DAY_MS + 1;
    const xa = axisBottom(x).ticks(Math.max(2, Math.min(span, Math.floor((W - ml - mr) / 70)))).tickFormat((d) => fmtDay(d as Date));
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
    // lines: null values break the line; a lone point between gaps is drawn as a dot
    const cx = (i: number) => x(new Date(utcMs(this.dates[i]) + DAY_MS / 2));
    const lines = svg.append("g").attr("clip-path", `url(#${clipId})`);
    for (const k of vis) {
      const y = this.ys[k]!;
      const v = input.series[k];
      const idx = this.dates.map((_, i) => i).filter((i) => i >= lo && i <= hi);
      const st = this.style(k);
      // data-domain and data-range let the render check read values back from the path coordinates
      lines.append("path").attr("class", `line line-${k}`).attr("data-series", k)
        .attr("data-domain", y.domain().join(",")).attr("data-range", y.range().join(","))
        .attr("stroke-dasharray", st.dash).attr("stroke-linecap", st.dash ? "butt" : "round")
        .attr("d", line<number>().defined((i) => v[i] !== null).x(cx).y((i) => y(v[i] as number))(idx));
      const lone = idx.filter((i) => v[i] !== null && (i === lo || v[i - 1] === null) && (i === hi || v[i + 1] === null));
      lines.append("g").selectAll("circle").data(lone).join("circle").attr("class", `lone lone-${k}`).attr("r", 2.6)
        .attr("cx", cx).attr("cy", (i) => y(v[i] as number));
    }
    this.cursorG = svg.append("g").attr("class", "cursor");
    // pointer and touch: the nearest day under the pointer
    const pick = (ev: PointerEvent) => {
      const r = (ev.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const t = x.invert(px).getTime();
      let i = Math.floor((t - utcMs(this.dates[0])) / DAY_MS);
      i = Math.max(lo, Math.min(hi, i));
      this.setCursor(i);
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
      .attr("text-anchor", "start").text(k === "news" && this.wiki ? "Pageviews" : AXIS_TITLE[k]);
  }

  private drawCursor() {
    const out = this.root.querySelector<HTMLElement>("#readout");
    if (!this.cursorG || !out) return;
    const g = this.cursorG;
    g.selectAll("*").remove();
    const i = this.cursor;
    if (i === null) {
      out.innerHTML = `Point at the chart, tap it, or focus it and use the arrow keys to read the values for a day.`;
      this.tip.hidden = true;
      return;
    }
    const { h, mt, mb, w } = this.dims;
    const date = this.dates[i];
    const cx = this.x(new Date(utcMs(date) + DAY_MS / 2));
    g.append("line").attr("x1", cx).attr("x2", cx).attr("y1", mt).attr("y2", h - mb);
    const vis = SERIES_KEYS.filter((k) => this.state.visible[k]);
    for (const k of vis) {
      const v = this.input.series[k][i];
      if (v === null) continue;
      g.append("circle").attr("class", `cdot-${k}`).attr("cx", cx).attr("cy", this.ys[k]!(v)).attr("r", 4.5);
    }
    const s = this.input.series;
    const parts = vis.map((k) => `<span class="rd" data-k="${k}"><span class="rk" data-k="${k}">${
      esc(this.style(k).short)}</span> <span class="rv" data-v="${k}">${esc(this.fmt(k, s[k][i]))}</span></span>`);
    const dateText = `<span class="rdate" data-date="${date}">${esc(fmtLong(new Date(utcMs(date))))} (${date})</span>`;
    out.innerHTML = `${dateText}<span class="sep">:</span> ${parts.join('<span class="sep">; </span>')}`;
    this.tip.innerHTML = `<strong>${esc(fmtLong(new Date(utcMs(date))))}</strong>${vis.map((k) =>
      `<div><span class="rk" data-k="${k}">${esc(this.style(k).short)}</span> ${
        esc(this.fmt(k, s[k][i]))}</div>`).join("")}`;
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
