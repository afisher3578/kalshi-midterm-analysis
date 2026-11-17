// Chart panels (Observable Plot). Every panel shares the same UTC x domain, left margin and annotations,
// so the time axes line up vertically.
import * as Plot from "@observablehq/plot";
import { format, scaleLinear, utcDay, utcFormat, utcMonday, utcMonth, utcWeek } from "d3";
import type { Num } from "./types";
import { DAY_MS, HOUR_MS } from "./transforms";

// All colors are CSS variables from style.css, so the panels follow the theme without a redraw.
export const COLORS = {
  line: "var(--series-price)",
  bar: "var(--muted)",
  grey: "var(--faint)",
  rule: "var(--series-volume)",
  excluded: "var(--rule)",
  zero: "var(--muted)",
  event: "var(--cat-4)",
  eventDraft: "var(--faint)",
};

// Categorical palette for overlays (Flexoki hues, --cat-1 to --cat-7); each series also gets its own dash and a text label.
export const SERIES_COLORS = [1, 2, 3, 4, 5, 6, 7].map((i) => `var(--cat-${i})`);
export const SERIES_DASH = [null, "6,3", "2,2", "8,3,2,3", "1,3", "10,4", "4,4"];

const MARGIN_LEFT = 60;
const MARGIN_RIGHT = 14;
const TOP_BAND = 34; // y inset that keeps data clear of the election annotation

export interface Frame {
  width: number;
  domain: [Date, Date];
  election: Date;
  excluded: { start: Date; end: Date }[];
  events?: { t: Date; confirmed: boolean }[];  // information-event overlay (empty or undefined when off)
}

const tickFmt = utcFormat("%b %-d");

function xAxis(frame: Frame) {
  const span = frame.domain[1].getTime() - frame.domain[0].getTime();
  const weeks = span / (7 * 86_400_000);
  const every = weeks < 3 ? utcDay.every(frame.width < 560 ? 4 : 2)! : frame.width < 560 && weeks > 6 ? utcMonth
    : utcWeek.every(frame.width < 900 || weeks > 8 ? 2 : 1)!;
  return { type: "utc" as const, domain: frame.domain, ticks: every, tickFormat: tickFmt, label: null };
}

function annotations(frame: Frame): Plot.Markish[] {
  const label = utcFormat("%b %-d")(frame.election);
  const text = (t: string, dy: number) => Plot.text([frame.election], {
    x: (d: Date) => d, frameAnchor: "top", textAnchor: "end", lineAnchor: "top", dx: -5, dy,
    text: () => t, fontSize: 11, fill: "var(--fg)", stroke: "var(--bg)", strokeWidth: 3, paintOrder: "stroke",
  });
  const inDomain = (t: Date) => t >= frame.domain[0] && t <= frame.domain[1];
  const ev = (frame.events ?? []).filter((e) => inDomain(e.t));
  const showElection = inDomain(frame.election);
  return [
    Plot.rect(frame.excluded, { x1: "start", x2: "end", fill: COLORS.excluded }),
    ...(ev.length ? [
      Plot.ruleX(ev.filter((e) => e.confirmed), { x: "t", stroke: COLORS.event, strokeWidth: 1.2 }),
      Plot.ruleX(ev.filter((e) => !e.confirmed), { x: "t", stroke: COLORS.eventDraft, strokeWidth: 1, strokeDasharray: "2,2" }),
    ] : []),
    ...(showElection ? [Plot.ruleX([frame.election], { stroke: COLORS.rule, strokeWidth: 1.5, strokeDasharray: "4,3" }),
      text(`Election day, ${label}`, 3), text("shaded: excluded from metrics", 17)] : []),
  ];
}

interface PanelOpts {
  frame: Frame;
  height: number;
  ariaLabel: string;
  ariaDescription: string;
  y: Plot.ScaleOptions;
  marks: Plot.Markish[];
}

function panel(o: PanelOpts): SVGSVGElement {
  const svg = Plot.plot({
    width: o.frame.width,
    height: o.height,
    marginLeft: MARGIN_LEFT,
    marginRight: MARGIN_RIGHT,
    marginTop: 26,
    marginBottom: 28,
    style: { fontSize: "12px", fontFamily: "inherit", background: "var(--bg)", color: "var(--fg)", overflow: "visible" },
    ariaLabel: o.ariaLabel,
    ariaDescription: o.ariaDescription,
    x: xAxis(o.frame),
    y: { grid: true, insetTop: TOP_BAND, labelAnchor: "top", ...o.y } as Plot.ScaleOptions,
    marks: [...annotations(o.frame), ...o.marks, Plot.frame({ anchor: "bottom", stroke: "var(--faint)" })],
  }) as SVGSVGElement;
  // The svg is one image with a text alternative. Plot labels its mark groups with aria-label, which is not valid
  // on <g> or <line> without a role, so move those names to data-mark.
  svg.setAttribute("role", "img");
  svg.querySelectorAll("[aria-label]").forEach((g) => {
    g.setAttribute("data-mark", g.getAttribute("aria-label")!);
    g.removeAttribute("aria-label");
  });
  return svg;
}

export interface HourPoint { t: Date; price: Num; volume: Num }

export function priceChart(frame: Frame, rows: HourPoint[], aria: [string, string]) {
  return panel({
    frame, height: 200, ariaLabel: aria[0], ariaDescription: aria[1],
    y: { domain: [0, 100], ticks: [0, 25, 50, 75, 100], label: "Yes price, cents (= implied probability, %)" },
    marks: [
      Plot.ruleY([50], { stroke: "var(--rule)" }),
      Plot.lineY(rows, { x: "t", y: (d: HourPoint) => (d.price === null ? null : d.price * 100), stroke: COLORS.line,
        strokeWidth: 1.4 }),
    ],
  });
}

export function volumeChart(frame: Frame, rows: HourPoint[], aria: [string, string]) {
  const max = Math.max(1, ...rows.map((r) => r.volume ?? 0));
  const ticks = [0, 100, 1e4, 1e6, 1e8].filter((t) => t <= max * 1.01);
  return panel({
    frame, height: 190, ariaLabel: aria[0], ariaDescription: aria[1],
    y: { type: "symlog", constant: 1, domain: [0, max], ticks, tickFormat: format("~s"),
      label: "Contracts per hour (symlog scale)" },
    marks: [
      Plot.rectY(rows, { x1: (d: HourPoint) => new Date(d.t.getTime() - HOUR_MS), x2: "t", y: (d: HourPoint) => d.volume,
        fill: COLORS.bar }),
    ],
  });
}

export interface DayPoint { t: Date; v: Num; kept: boolean }

/** y domain fitted to the days used in the metrics (kept days), so election night does not flatten the rest.
 * Values outside it are listed by the caller and drawn as triangles on the frame edge. */
export function keptDomain(rows: DayPoint[], zeroBased: boolean): [number, number] | undefined {
  const vals = rows.filter((r) => r.kept && r.v !== null).map((r) => r.v as number);
  if (!vals.length) return undefined;
  const lo = zeroBased ? Math.min(0, ...vals) : Math.min(...vals);
  const hi = Math.max(...vals);
  return scaleLinear().domain([lo, hi === lo ? lo + 1 : hi]).nice().domain() as [number, number];
}

export function attentionChart(frame: Frame, rows: DayPoint[], o: { label: string; unusable: boolean; zeroRule: boolean;
  aria: [string, string]; reason?: string; domain?: [number, number] }) {
  const stroke = o.unusable ? COLORS.grey : COLORS.line;
  const marks: Plot.Markish[] = [];
  const inside = (r: DayPoint) => r.v !== null && (!o.domain || (r.v >= o.domain[0] && r.v <= o.domain[1]));
  // Off-scale values are not drawn as line segments (they would run into the annotation band); they get a
  // triangle at the frame edge and their values are printed in the caption.
  const drawn = rows.map((r) => ({ ...r, v: inside(r) ? r.v : null }));
  if (o.zeroRule) marks.push(Plot.ruleY([0], { stroke: COLORS.zero }));
  marks.push(
    Plot.lineY(drawn, { x: "t", y: "v", stroke, strokeWidth: 1.5, strokeDasharray: o.unusable ? "3,3" : undefined }),
    Plot.dot(drawn, { x: "t", y: "v", r: 1.8, fill: stroke }),
  );
  if (o.domain) {
    const [lo, hi] = o.domain;
    const off = rows.filter((r) => r.v !== null && (r.v > hi || r.v < lo));
    marks.push(Plot.dot(off, { x: "t", y: (r: DayPoint) => (r.v! > hi ? hi : lo), symbol: "triangle", r: 4.5,
      rotate: (r: DayPoint) => (r.v! > hi ? 0 : 180), fill: COLORS.rule }));
  }
  if (o.unusable && o.reason) {
    marks.push(Plot.text([o.reason], { frameAnchor: "middle", text: (d: string) => `Unusable: ${d}`, fill: "var(--muted)",
      fontSize: 12, stroke: "var(--bg)", strokeWidth: 4, paintOrder: "stroke", lineWidth: 40 }));
  }
  return panel({
    frame, height: 180, ariaLabel: o.aria[0], ariaDescription: o.aria[1],
    y: { label: o.label, tickFormat: o.zeroRule ? format("~g") : format("~s"), ticks: 4,
      ...(o.domain ? { domain: o.domain } : { nice: true, zero: !o.zeroRule }) },
    marks,
  });
}

/** Daily points are drawn at noon UTC of their date, the middle of the day they cover. */
export function dayCenter(date: string): Date {
  return new Date(Date.parse(date + "T00:00:00Z") + DAY_MS / 2);
}

// ---------------------------------------------------------------- M3 chart types

function svgPlot(o: Plot.PlotOptions & { ariaLabel: string; ariaDescription: string }): SVGSVGElement {
  const svg = Plot.plot({ style: { fontSize: "12px", fontFamily: "inherit", background: "var(--bg)", color: "var(--fg)",
    overflow: "visible" }, ...o }) as SVGSVGElement;
  const el = svg.tagName.toLowerCase() === "svg" ? svg : (svg.querySelector("svg") as SVGSVGElement);
  el.setAttribute("role", "img");
  el.querySelectorAll("[aria-label]").forEach((g) => {
    if (g === el) return;
    g.setAttribute("data-mark", g.getAttribute("aria-label")!);
    g.removeAttribute("aria-label");
  });
  return svg;
}

export interface OverlaySeries { name: string; label: string; points: { t: Date; v: Num }[] }

/** Normalized overlay: every series as a z-score on one axis, each with its own color, dash and end label. */
export function overlayChart(frame: Frame, series: OverlaySeries[], aria: [string, string]) {
  const marks: Plot.Markish[] = [Plot.ruleY([0], { stroke: COLORS.zero })];
  series.forEach((s, k) => {
    const color = SERIES_COLORS[k % SERIES_COLORS.length];
    const dash = SERIES_DASH[k % SERIES_DASH.length] ?? undefined;
    marks.push(Plot.lineY(s.points, { x: "t", y: "v", stroke: color, strokeWidth: 1.6, strokeDasharray: dash }));
    const last = [...s.points].reverse().find((p) => p.v !== null);
    if (last) marks.push(Plot.text([last], { x: "t", y: "v", text: () => `${k + 1}`, dx: 6, fill: color,
      fontWeight: 700, textAnchor: "start" }));
  });
  return panel({ frame, height: 240, ariaLabel: aria[0], ariaDescription: aria[1],
    y: { label: "z-score (sd units); numbers at line ends match the list", ticks: 5, nice: true },
    marks });
}

export interface HeatCell { series: string; label: string; lag: number; rho: Num; n: number }

/** Lead-lag heatmap: rows are attention series, columns are lags; each cell prints rho and n. */
export function heatmapChart(width: number, cells: HeatCell[], minN: number, aria: [string, string]) {
  const rows = [...new Set(cells.map((c) => c.label))];
  const narrow = width < 560;
  return svgPlot({
    width, height: 46 + rows.length * (narrow ? 58 : 44), marginLeft: narrow ? 10 : 190, marginTop: 34, marginBottom: 8,
    ariaLabel: aria[0], ariaDescription: aria[1],
    x: { axis: "top", label: "lag in days (above 0: outcome after attention)", tickFormat: (d: number) => (d > 0 ? `+${d}` : `${d}`),
      domain: [-2, -1, 0, 1, 2], type: "band" },
    y: { domain: rows, label: null, axis: narrow ? null : "left", tickSize: 0, paddingInner: narrow ? 0.38 : 0.1, paddingOuter: narrow ? 0.3 : 0.1 },
    color: { type: "linear", domain: [-0.6, 0.6], scheme: "PuOr", reverse: true, clamp: true },
    marks: [
      Plot.cell(cells, { x: "lag", y: "label", fill: (c: HeatCell) => (c.rho === null ? "var(--rule)" : c.rho), inset: 1 }),
      Plot.text(cells, { x: "lag", y: "label", text: (c: HeatCell) => (c.rho === null ? `n<${minN}\nn=${c.n}`
        : `${format(".2f")(c.rho)}\nn=${c.n}`), fill: (c: HeatCell) => (c.rho !== null && Math.abs(c.rho) > 0.4 ? "var(--bg)" : "var(--fg)"),
        fontSize: 11, lineHeight: 1.1 }),
      ...(narrow ? [Plot.text(cells.filter((c) => c.lag === -2), { x: "lag", y: "label", text: "label", frameAnchor: "left",
        dy: -21, dx: -20, textAnchor: "start", fontSize: 11, fill: "var(--muted)" })] : []),
    ],
  });
}

export interface StudyPoint { offset: number; mean: Num; n: number; what: string }

/** Event-study plot: mean outcome at each day offset around the anchor days, with n printed at each point. */
export function eventStudyChart(width: number, pts: StudyPoint[], aria: [string, string]) {
  const whats = [...new Set(pts.map((p) => p.what))];
  return svgPlot({
    width, height: 120 + 140 * whats.length, marginLeft: 60, marginRight: 14, marginTop: 34, marginBottom: 34,
    ariaLabel: aria[0], ariaDescription: aria[1],
    // facet labels above each facet, inside the plot width (a right-hand axis spills past a phone screen)
    fy: { domain: whats, label: null, axis: null, padding: 0.25 },
    x: { label: "days from the anchor day", domain: [-2, -1, 0, 1, 2], type: "point", tickFormat: (d: number) => (d > 0 ? `+${d}` : `${d}`) },
    y: { label: "mean", grid: true, nice: true },
    marks: [
      Plot.ruleY([0], { stroke: COLORS.zero }),
      Plot.ruleX([0], { stroke: COLORS.rule, strokeDasharray: "3,3" }),
      Plot.text(whats, { fy: (d: string) => d, text: (d: string) => d, frameAnchor: "top-left", textAnchor: "start",
        lineAnchor: "bottom", dy: -8, fontWeight: 600, fill: "var(--fg)" }),
      Plot.lineY(pts.filter((p) => p.mean !== null), { x: "offset", y: "mean", fy: "what", stroke: COLORS.line }),
      Plot.dot(pts.filter((p) => p.mean !== null), { x: "offset", y: "mean", fy: "what", fill: COLORS.line, r: 3 }),
      Plot.text(pts, { x: "offset", y: (p: StudyPoint) => p.mean ?? 0, fy: "what", text: (p: StudyPoint) => `n=${p.n}`, dy: -10,
        fontSize: 10, fill: "var(--muted)" }),
    ],
  });
}

export interface ScatterPoint { x: number; y: number; date: string }

export function scatterChart(width: number, pts: ScatterPoint[], labels: [string, string], aria: [string, string]) {
  return svgPlot({
    width: Math.min(width, 640), height: Math.min(width, 640) * 0.7 + 40, marginLeft: 56, marginBottom: 40,
    ariaLabel: aria[0], ariaDescription: aria[1],
    x: { label: labels[0], grid: true, nice: true }, y: { label: labels[1], grid: true, nice: true },
    marks: [Plot.ruleX([0], { stroke: COLORS.zero }), Plot.ruleY([0], { stroke: COLORS.zero }),
      Plot.dot(pts, { x: "x", y: "y", r: 3.2, fill: COLORS.line, fillOpacity: 0.75 })],
  });
}

export interface CalDay { date: Date; v: Num; excluded: boolean }

/** Calendar heatmap: one column per week (Monday start), one row per weekday; missing days are hatched. */
export function calendarChart(width: number, days: CalDay[], unit: string, aria: [string, string]) {
  const wk = (d: Date) => utcMonday.floor(d);
  const weekday = (d: Date) => (d.getUTCDay() + 6) % 7; // Monday 0
  const vals = days.filter((d) => d.v !== null && !d.excluded).map((d) => d.v as number);
  const hi = vals.length ? Math.max(...vals) : 1;
  const lo = vals.length ? Math.max(1, Math.min(...vals)) : 1;
  return svgPlot({
    width, height: 7 * 22 + 60, marginLeft: 40, marginTop: 30, marginBottom: 30,
    ariaLabel: aria[0], ariaDescription: aria[1],
    x: { type: "band", label: null, tickFormat: (d: Date) => (d.getUTCDate() <= 7 ? utcFormat("%b %-d")(d) : ""), axis: "top",
      padding: 0.08 },
    y: { type: "band", domain: [0, 1, 2, 3, 4, 5, 6], tickFormat: (d: number) => "MTWTFSS"[d], label: null, padding: 0.08 },
    color: { type: "log", domain: [lo, hi], scheme: "Blues", clamp: true, label: unit },
    marks: [
      Plot.cell(days.filter((d) => d.v !== null), { x: (d: CalDay) => wk(d.date), y: (d: CalDay) => weekday(d.date),
        fill: (d: CalDay) => Math.max(d.v as number, lo) }),
      Plot.cell(days.filter((d) => d.excluded), { x: (d: CalDay) => wk(d.date), y: (d: CalDay) => weekday(d.date),
        fill: "none", stroke: COLORS.rule, strokeWidth: 1.5 }),
      Plot.cell(days.filter((d) => d.v === null), { x: (d: CalDay) => wk(d.date), y: (d: CalDay) => weekday(d.date),
        fill: "var(--bg)", stroke: "var(--faint)", strokeDasharray: "2,2" }),
      Plot.text(days.filter((d) => d.excluded), { x: (d: CalDay) => wk(d.date), y: (d: CalDay) => weekday(d.date), text: () => "x",
        fill: COLORS.rule, fontWeight: 700 }),
      Plot.text(days.filter((d) => d.v === null), { x: (d: CalDay) => wk(d.date), y: (d: CalDay) => weekday(d.date), text: () => "-",
        fill: "var(--muted)" }),
    ],
  });
}

// ---------------------------------------------------------------- MC2: news view panels

export interface LineSeries { label: string; points: { t: Date; v: Num }[] }

/** Two or more daily lines on the shared time axis, each with its own color, dash and an end label (so the lines
 * are told apart without color). `ref` draws a horizontal reference line (e.g. 50%). */
export function linesChart(frame: Frame, series: LineSeries[], o: { label: string; aria: [string, string]; height?: number;
  domain?: [number, number]; ref?: number; percent?: boolean; fraction?: boolean }) {
  const marks: Plot.Markish[] = [];
  if (o.ref !== undefined) marks.push(Plot.ruleY([o.ref], { stroke: COLORS.zero, strokeDasharray: "4,3" }));
  series.forEach((s, k) => {
    const color = SERIES_COLORS[k % SERIES_COLORS.length];
    const dash = SERIES_DASH[k % SERIES_DASH.length] ?? undefined;
    marks.push(Plot.lineY(s.points, { x: "t", y: "v", stroke: color, strokeWidth: 1.6, strokeDasharray: dash }),
      Plot.dot(s.points, { x: "t", y: "v", r: 1.6, fill: color }));
    const last = [...s.points].reverse().find((p) => p.v !== null);
    if (last) marks.push(Plot.text([last], { x: "t", y: "v", text: () => `${k + 1}`, dx: 6, fill: color, fontWeight: 700,
      textAnchor: "start", stroke: "var(--bg)", strokeWidth: 3, paintOrder: "stroke" }));
  });
  return panel({ frame, height: o.height ?? 220, ariaLabel: o.aria[0], ariaDescription: o.aria[1],
    y: { label: o.label, ...(o.percent || o.fraction ? { ticks: [0, 0.5, 1] } : { ticks: 4 }),
      ...(o.domain ? { domain: o.domain } : { nice: true, zero: true }),
      tickFormat: o.percent ? format(".0%") : o.fraction ? format(".1f") : format("~s") },
    marks });
}

/** One bar per UTC day (daily totals such as Kalshi volume per day). */
export function dailyBarsChart(frame: Frame, points: { date: string; v: Num }[], o: { label: string; aria: [string, string] }) {
  return panel({ frame, height: 160, ariaLabel: o.aria[0], ariaDescription: o.aria[1],
    y: { label: o.label, ticks: 4, nice: true, zero: true, tickFormat: format("~s") },
    marks: [Plot.rectY(points, { x1: (p: { date: string }) => new Date(Date.parse(p.date + "T00:00:00Z") + 3_600_000 * 2),
      x2: (p: { date: string }) => new Date(Date.parse(p.date + "T00:00:00Z") + DAY_MS - 3_600_000 * 2),
      y: (p: { v: Num }) => p.v, fill: COLORS.bar })] });
}

/** A labeled empty panel on the shared axis: the frame, the time axis and a message, no y values (not zeros). */
export function emptyChart(frame: Frame, message: string, aria: [string, string], height = 150) {
  return panel({ frame, height, ariaLabel: aria[0], ariaDescription: aria[1],
    y: { domain: [0, 1], ticks: [], label: null },
    // bottom left, clear of the election-day label in the top right corner
    marks: [Plot.text([message], { frameAnchor: "bottom-left", dx: 8, dy: -10, textAnchor: "start", lineAnchor: "bottom",
      text: (d: string) => d, fill: "var(--muted)", fontSize: 13, fontWeight: 600, stroke: "var(--bg)", strokeWidth: 4,
      paintOrder: "stroke", lineWidth: 24 })] });
}

export interface BarRow { label: string; count: number }

/** Horizontal bars, largest first, each with its value printed at the end of the bar. */
/** `label` names the x unit; it goes in the caller's text, not on the axis (it collided with the last tick). */
export function hbarChart(width: number, rows: BarRow[], o: { label: string; aria: [string, string] }) {
  const narrow = width < 560;
  return svgPlot({
    width, height: 40 + rows.length * (narrow ? 42 : 26), marginLeft: narrow ? 8 : 250, marginRight: 56, marginTop: 28, marginBottom: 8,
    ariaLabel: o.aria[0], ariaDescription: o.aria[1],
    x: { axis: "top", label: null, grid: true, nice: true, tickFormat: format("~s"), ticks: narrow ? 3 : 6 },
    y: { domain: rows.map((r) => r.label), label: null, axis: narrow ? null : "left", tickSize: 0, padding: narrow ? 0.55 : 0.25 },
    marks: [
      Plot.barX(rows, { x: "count", y: "label", fill: COLORS.bar }),
      Plot.text(rows, { x: "count", y: "label", text: (r: BarRow) => format(",")(r.count), dx: 4, textAnchor: "start", fontSize: 11 }),
      ...(narrow ? [Plot.text(rows, { x: 0, y: "label", text: "label", dy: -14, textAnchor: "start", fontSize: 11,
        fill: "var(--fg)", stroke: "var(--bg)", strokeWidth: 3, paintOrder: "stroke" })] : []),
    ],
  });
}
