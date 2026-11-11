// Chart panels (Observable Plot). Every panel shares the same UTC x domain, left margin and annotations,
// so the time axes line up vertically.
import * as Plot from "@observablehq/plot";
import { format, scaleLinear, utcFormat, utcMonth, utcWeek } from "d3";
import type { Num } from "./types";
import { DAY_MS, HOUR_MS } from "./transforms";

export const COLORS = {
  line: "#1f4e79",
  bar: "#2f6690",
  grey: "#7b8089",
  rule: "#9a3412",
  excluded: "#e3e6ea",
  zero: "#6b7280",
};

const MARGIN_LEFT = 60;
const MARGIN_RIGHT = 14;
const TOP_BAND = 34; // y inset that keeps data clear of the election annotation

export interface Frame {
  width: number;
  domain: [Date, Date];
  election: Date;
  excluded: { start: Date; end: Date }[];
}

const tickFmt = utcFormat("%b %-d");

function xAxis(frame: Frame) {
  const every = frame.width < 560 ? utcMonth : utcWeek.every(frame.width < 900 ? 2 : 1)!;
  return { type: "utc" as const, domain: frame.domain, ticks: every, tickFormat: tickFmt, label: null };
}

function annotations(frame: Frame): Plot.Markish[] {
  const label = utcFormat("%b %-d")(frame.election);
  const text = (t: string, dy: number) => Plot.text([frame.election], {
    x: (d: Date) => d, frameAnchor: "top", textAnchor: "end", lineAnchor: "top", dx: -5, dy,
    text: () => t, fontSize: 11, fill: "#1f2937", stroke: "white", strokeWidth: 3, paintOrder: "stroke",
  });
  return [
    Plot.rect(frame.excluded, { x1: "start", x2: "end", fill: COLORS.excluded }),
    Plot.ruleX([frame.election], { stroke: COLORS.rule, strokeWidth: 1.5, strokeDasharray: "4,3" }),
    text(`Election day, ${label}`, 3),
    text("shaded: excluded from metrics", 17),
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
    style: { fontSize: "12px", fontFamily: "inherit", background: "white", color: "#1f2937", overflow: "visible" },
    ariaLabel: o.ariaLabel,
    ariaDescription: o.ariaDescription,
    x: xAxis(o.frame),
    y: { grid: true, insetTop: TOP_BAND, labelAnchor: "top", ...o.y } as Plot.ScaleOptions,
    marks: [...annotations(o.frame), ...o.marks, Plot.frame({ anchor: "bottom", stroke: "#9ca3af" })],
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
      Plot.ruleY([50], { stroke: "#c4c8ce" }),
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
    marks.push(Plot.text([o.reason], { frameAnchor: "middle", text: (d: string) => `Unusable: ${d}`, fill: "#374151",
      fontSize: 12, stroke: "white", strokeWidth: 4, paintOrder: "stroke", lineWidth: 40 }));
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
