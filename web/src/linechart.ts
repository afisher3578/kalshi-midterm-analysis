// The dashboard chart: one line chart for the selected race with three series on their own y axes (Kalshi price
// on the left, Kalshi volume and media attention on the right), y axis toggles, an indexed mode, a date range
// (two date inputs plus a brush) and a day cursor for pointer, touch and keyboard. Data: series.display_daily.
import { axisBottom, axisLeft, axisRight, brushX, format, line, max, type ScaleLinear, scaleLinear, type ScaleTime, scaleUtc,
  select, type Selection, utcFormat } from "d3";
import { canHide, type ChartSeries, checkRange, clampDate, indexed, SERIES_KEYS, type SeriesKey } from "./display";
import { esc } from "./race";
import { DAY_MS, utcMs } from "./transforms";
import type { Num } from "./types";

// Okabe-Ito hues (color blind safe), darkened where needed for 4.5:1 text contrast on white; each also has a dash.
export const SERIES_STYLE: Record<SeriesKey, { label: string; short: string; unit: string; color: string; dash: string | null }> = {
  price: { label: "Kalshi price (Democratic win, % chance)", short: "Kalshi price", unit: "%", color: "#0072B2", dash: null },
  volume: { label: "Kalshi volume (contracts per day)", short: "Kalshi volume", unit: "contracts", color: "#B84A00", dash: "7,4" },
  news: { label: "Media attention (news stories per day)", short: "Media attention", unit: "stories", color: "#007A5A", dash: "2,3" },
};
const AXIS_TITLE: Record<SeriesKey, string> = { price: "Price, %", volume: "Volume", news: "Stories" };

export interface ChartState {
  visible: Record<SeriesKey, boolean>;
  mode: "own" | "indexed";
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
}

const fmtDay = utcFormat("%b %-d");
const fmtLong = utcFormat("%a %b %-d, %Y");
const fmtPrice = format(".1f");
const fmtVolume = format(",.2~f");
const fmtNews = format(",.0f");
const fmtTick = format(".2~s");
let uid = 0;

export function formatValue(key: SeriesKey, v: Num): string {
  if (v === null) return "no data";
  if (key === "price") return `${fmtPrice(v)}%`;
  if (key === "volume") return `${fmtVolume(v)} contracts`;
  return `${fmtNews(v)} stories`;
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
    const toggle = (k: SeriesKey) => {
      const s = SERIES_STYLE[k];
      return `<label class="tg" data-key="${k}"><input type="checkbox" id="tg-${k}" data-key="${k}"${state.visible[k] ? " checked" : ""}>
        <svg class="swatch" viewBox="0 0 30 10" width="30" height="10" aria-hidden="true"><line x1="1" y1="5" x2="29" y2="5"
          stroke="${s.color}" stroke-width="3"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/></svg>
        <span>${esc(s.label)}${k === "news" && !input.news.available ? ' <span class="tg-off">(no news data for this race yet)</span>' : ""}</span></label>`;
    };
    this.root.innerHTML = `
      <h2 id="chart-h" class="charttitle">${esc(input.title)}: Kalshi price, Kalshi volume and media attention</h2>
      ${input.demo ? '<p class="demo-banner" id="demo-label">Demo data</p>' : ""}
      <p class="status" id="news-status" data-news="${input.news.available ? "yes" : "no"}">${esc(input.news.status)}</p>
      <div class="chartctl">
        <fieldset class="series-toggles"><legend>Lines and their y axes</legend>
          ${SERIES_KEYS.map(toggle).join("")}
          <p class="hint" id="tg-note" aria-live="polite"></p>
        </fieldset>
        <fieldset class="scale-mode"><legend>Scale</legend>
          <label class="tg"><input type="radio" name="${this.id}-mode" value="own"${state.mode === "own" ? " checked" : ""}> Own scale</label>
          <label class="tg"><input type="radio" name="${this.id}-mode" value="indexed"${state.mode === "indexed" ? " checked" : ""}> Indexed (each line 0 to 100)</label>
        </fieldset>
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
    this.root.querySelectorAll<HTMLInputElement>(".series-toggles input").forEach((i) => i.addEventListener("change", () => {
      const k = i.dataset.key as SeriesKey;
      if (!i.checked && !canHide(state.visible, k)) {
        i.checked = true;
      } else {
        state.visible[k] = i.checked;
      }
      this.syncToggles();
      this.changed();
    }));
    this.root.querySelectorAll<HTMLInputElement>(`input[name="${this.id}-mode"]`).forEach((r) => r.addEventListener("change", () => {
      state.mode = r.value as ChartState["mode"];
      this.changed();
    }));
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
    const note: string[] = [];
    for (const k of SERIES_KEYS) {
      const i = this.root.querySelector<HTMLInputElement>(`#tg-${k}`)!;
      const unavailable = k === "news" && !this.input.news.available;
      const last = this.state.visible[k] && !canHide(this.state.visible, k);
      i.checked = this.state.visible[k];
      i.disabled = unavailable || last;
      i.closest("label")!.classList.toggle("disabled", i.disabled);
      if (last) note.push(`${SERIES_STYLE[k].short} is the only line on, so it cannot be switched off.`);
    }
    this.root.querySelector("#tg-note")!.textContent = note.join(" ");
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
  private shown: Record<SeriesKey, Num[]> = { price: [], volume: [], news: [] };
  private dims = { w: 0, h: 0, ml: 0, mr: 0, mt: 0, mb: 0 };
  private cursorG!: Selection<SVGGElement, unknown, null, undefined>;

  draw() {
    if (!this.svgBox) return;
    const { state, input } = this;
    const W = Math.max(280, Math.floor(this.svgBox.clientWidth || this.root.clientWidth || 800));
    const H = W < 560 ? 300 : 380;
    const vis = SERIES_KEYS.filter((k) => state.visible[k]);
    const own = state.mode === "own";
    const rightKeys = own ? vis.filter((k) => k !== "price") : [];
    const axisW = W < 560 ? 44 : 56;
    const ml = own ? (state.visible.price ? axisW : 14) : axisW;
    const mr = 14 + rightKeys.length * axisW;
    const mt = rightKeys.length > 1 ? 44 : 30, mb = 28;  // two right axes: their titles go on two rows
    this.dims = { w: W, h: H, ml, mr, mt, mb };
    const [lo, hi] = this.range();
    if (this.cursor !== null && (this.cursor < lo || this.cursor > hi)) this.cursor = null;
    const x = scaleUtc().domain([new Date(utcMs(state.from)), new Date(utcMs(state.to) + DAY_MS)]).range([ml, W - mr]);
    this.x = x;
    const s = input.series;
    this.shown = {
      price: own ? s.price : indexed(s.price, lo, hi),
      volume: own ? s.volume : indexed(s.volume, lo, hi),
      news: own ? s.news : indexed(s.news, lo, hi),
    };
    const inView = (v: Num[]) => v.slice(lo, hi + 1).filter((z): z is number => z !== null);
    const top = (k: SeriesKey) => (max(inView(this.shown[k])) ?? 1) || 1;
    this.ys = {};
    for (const k of vis) {
      const dom: [number, number] = !own || k === "price" ? [0, 100] : [0, top(k)];
      const y = scaleLinear().domain(dom).range([H - mb, mt]);
      if (own && k !== "price") y.nice(5);
      this.ys[k] = y;
    }
    this.svgBox.innerHTML = "";
    const svg = select(this.svgBox).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H)
      .attr("class", "lc").attr("aria-hidden", "true").attr("data-mode", state.mode);
    const clipId = `${this.id}-clip`;
    svg.append("defs").append("clipPath").attr("id", clipId).append("rect")
      .attr("x", ml).attr("y", mt - 2).attr("width", W - ml - mr).attr("height", H - mt - mb + 4);
    // election days: shaded band and label
    const e0 = input.election[0], e1 = input.election[input.election.length - 1];
    if (e0 && e1 && e1 >= state.from && e0 <= state.to) {
      const a = Math.max(ml, x(new Date(utcMs(e0)))), b = Math.min(W - mr, x(new Date(utcMs(e1) + DAY_MS)));
      const g = svg.append("g").attr("data-mark", "election");
      g.append("rect").attr("x", a).attr("y", mt).attr("width", Math.max(1, b - a)).attr("height", H - mt - mb)
        .attr("fill", "#e5e7eb");
      const lx = b - (W - mr) > -4 ? a - 4 : b + 4;
      g.append("text").attr("x", lx).attr("y", mt + 12).attr("text-anchor", b - (W - mr) > -4 ? "end" : "start")
        .attr("class", "elabel").attr("paint-order", "stroke").attr("stroke", "#fff").attr("stroke-width", 3)
        .text(electionLabel(input.election));
    }
    // x axis
    const span = (utcMs(state.to) - utcMs(state.from)) / DAY_MS + 1;
    const xa = axisBottom(x).ticks(Math.max(2, Math.min(span, Math.floor((W - ml - mr) / 70)))).tickFormat((d) => fmtDay(d as Date));
    svg.append("g").attr("class", "axis xaxis").attr("transform", `translate(0,${H - mb})`).call(xa);
    // y axes, each in its series color (one shared neutral axis in indexed mode)
    if (own) {
      rightKeys.forEach((k, j) => {
        const g = svg.append("g").attr("class", `axis yaxis y-${k}`).attr("data-axis", k)
          .attr("transform", `translate(${W - mr + j * axisW},0)`)
          .call(axisRight(this.ys[k]!).ticks(5).tickFormat((d) => fmtTick(d as number)));
        this.colorAxis(g, k, "start", j);
      });
      if (state.visible.price) {
        const g = svg.append("g").attr("class", "axis yaxis y-price").attr("data-axis", "price").attr("transform", `translate(${ml},0)`)
          .call(axisLeft(this.ys.price!).tickValues([0, 25, 50, 75, 100]).tickFormat((d) => `${d}%`));
        this.colorAxis(g, "price", "end");
      }
    } else {
      const y = scaleLinear().domain([0, 100]).range([H - mb, mt]);
      const g = svg.append("g").attr("class", "axis yaxis y-index").attr("data-axis", "index").attr("transform", `translate(${ml},0)`)
        .call(axisLeft(y).tickValues([0, 25, 50, 75, 100]));
      g.append("text").attr("class", "atitle").attr("x", -ml + 2).attr("y", mt - 14).attr("text-anchor", "start")
        .attr("fill", "#1f2937").text("Index, 0 to 100");
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
      const v = this.shown[k];
      const idx = this.dates.map((_, i) => i).filter((i) => i >= lo && i <= hi);
      const st = SERIES_STYLE[k];
      lines.append("path").attr("class", `line line-${k}`).attr("data-series", k).attr("fill", "none")
        .attr("stroke", st.color).attr("stroke-width", 2.4).attr("stroke-dasharray", st.dash)
        .attr("stroke-linejoin", "round").attr("stroke-linecap", st.dash ? "butt" : "round")
        .attr("d", line<number>().defined((i) => v[i] !== null).x(cx).y((i) => y(v[i] as number))(idx));
      const lone = idx.filter((i) => v[i] !== null && (i === lo || v[i - 1] === null) && (i === hi || v[i + 1] === null));
      lines.append("g").selectAll("circle").data(lone).join("circle").attr("class", `lone lone-${k}`).attr("r", 2.6)
        .attr("fill", st.color).attr("cx", cx).attr("cy", (i) => y(v[i] as number));
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

  private colorAxis(g: Selection<SVGGElement, unknown, null, undefined>, k: SeriesKey, anchor: "start" | "end", row = 0) {
    const c = SERIES_STYLE[k].color;
    g.selectAll("path, line").attr("stroke", c);
    g.selectAll("text").attr("fill", c);
    if (SERIES_STYLE[k].dash) g.select("path.domain").attr("stroke-dasharray", SERIES_STYLE[k].dash);
    g.append("text").attr("class", "atitle").attr("x", anchor === "end" ? -this.dims.ml + 2 : 2).attr("y", this.dims.mt - 14 - row * 14)
      .attr("text-anchor", "start").attr("fill", c).text(AXIS_TITLE[k]);
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
    g.append("line").attr("x1", cx).attr("x2", cx).attr("y1", mt).attr("y2", h - mb).attr("stroke", "#374151")
      .attr("stroke-width", 1);
    const vis = SERIES_KEYS.filter((k) => this.state.visible[k]);
    for (const k of vis) {
      const v = this.shown[k][i];
      if (v === null) continue;
      g.append("circle").attr("cx", cx).attr("cy", this.ys[k]!(v)).attr("r", 4.5).attr("fill", "#fff")
        .attr("stroke", SERIES_STYLE[k].color).attr("stroke-width", 2.5);
    }
    const s = this.input.series;
    const parts = vis.map((k) => `<span class="rd" data-k="${k}"><span class="rk" style="border-color:${SERIES_STYLE[k].color}">${
      esc(SERIES_STYLE[k].short)}</span> <span class="rv" data-v="${k}">${esc(formatValue(k, s[k][i]))}</span></span>`);
    const dateText = `<span class="rdate" data-date="${date}">${esc(fmtLong(new Date(utcMs(date))))} (${date})</span>`;
    out.innerHTML = `${dateText}<span class="sep">:</span> ${parts.join('<span class="sep">; </span>')}`;
    this.tip.innerHTML = `<strong>${esc(fmtLong(new Date(utcMs(date))))}</strong>${vis.map((k) =>
      `<div><span class="rk" style="border-color:${SERIES_STYLE[k].color}">${esc(SERIES_STYLE[k].short)}</span> ${
        esc(formatValue(k, s[k][i]))}</div>`).join("")}`;
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
    svg.append("rect").attr("x", ml).attr("y", 0).attr("width", w - ml - mr).attr("height", H).attr("fill", "#f3f4f6")
      .attr("stroke", "#9ca3af");
    svg.append("path").attr("fill", "none").attr("stroke", "#6b7280").attr("stroke-width", 1.2)
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
