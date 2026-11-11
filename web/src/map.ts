// US state map (d3-geo + us-atlas, bundled; no remote topojson). The geometry is the pre-projected
// states-albers-10m.json from us-atlas 3.0.1, committed in src/geo/, so the map renders from the page's own files.
import { geoPath, scaleQuantize, interpolateBlues, interpolatePuOr, format } from "d3";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import atlas from "./geo/states-albers-10m.json";

export interface StateCell {
  code: string;
  name: string;
  value: number | null;      // null: insufficient data or no race
  text: string;              // value with unit and n, or the reason
  raceId: string | null;
  filteredOut: boolean;      // outside the polling density band
}

// FIPS code -> postal code (us-atlas ids are FIPS)
export const FIPS: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
  "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
  "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "72": "PR",
};

const topo = atlas as unknown as Topology<{ states: GeometryCollection<{ name: string }> }>;
const states = feature(topo, topo.objects.states);
const path = geoPath();

// label nudges (px in the 975 x 610 Albers frame) where the centroid falls on a coastline or outside the shape
const LABEL_NUDGE: Record<string, [number, number]> = { FL: [22, 12], LA: [-12, 0], MI: [12, 22], KY: [6, 2], VA: [6, 2] };

export const INSUFFICIENT_FILL = "url(#hatch-insufficient)";
export const FILTERED_FILL = "url(#dots-filtered)";

/** Five equal-width bins over the shown values. Diverging metrics are centered on 0. */
export function binScale(values: number[], diverging: boolean) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
  const domain: [number, number] = diverging ? [-m, m] : [Math.min(0, lo), hi === lo ? lo + 1 : hi];
  const colors = diverging ? [0.1, 0.3, 0.5, 0.7, 0.9].map((t) => interpolatePuOr(1 - t))
    : [0.25, 0.42, 0.59, 0.76, 0.93].map((t) => interpolateBlues(t));
  return scaleQuantize<string>().domain(domain).range(colors);
}

/** Text color with enough contrast on a fill. */
function inkOn(fill: string): string {
  const m = fill.match(/rgb\((\d+), (\d+), (\d+)\)/);
  if (!m) return "#111827";
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => Number(x) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.25 ? "#111827" : "#ffffff";
}

export function renderMap(root: HTMLElement, cells: Map<string, StateCell>, opts: { diverging: boolean;
  metricLabel: string; selected: string | null; fmt: (n: number) => string; onPick: (code: string) => void }) {
  const shown = [...cells.values()].filter((c) => c.value !== null && !c.filteredOut).map((c) => c.value as number);
  const scale = shown.length ? binScale(shown, opts.diverging) : null;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 975 610");
  svg.setAttribute("class", "usmap");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", `US map colored by ${opts.metricLabel}. States with a race are buttons; the same
    values are in the table below the map.`.replace(/\s+/g, " "));
  svg.innerHTML = `<defs>
    <pattern id="hatch-insufficient" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
      <rect width="8" height="8" fill="#eceef1"/><line x1="0" y1="0" x2="0" y2="8" stroke="#8b929c" stroke-width="2"/></pattern>
    <pattern id="dots-filtered" patternUnits="userSpaceOnUse" width="7" height="7">
      <rect width="7" height="7" fill="#ffffff"/><circle cx="3.5" cy="3.5" r="1.1" fill="#9ca3af"/></pattern></defs>`;
  for (const f of states.features) {
    const code = FIPS[String(f.id).padStart(2, "0")];
    if (!code) continue;
    const c = cells.get(code);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", path(f) ?? "");
    p.setAttribute("data-state", code);
    const fill = !c || c.filteredOut ? FILTERED_FILL : c.value === null || !scale ? INSUFFICIENT_FILL : scale(c.value);
    p.setAttribute("fill", c?.filteredOut ? FILTERED_FILL : fill);
    p.setAttribute("class", "st" + (c?.raceId ? " has-race" : "") + (opts.selected === code ? " selected" : ""));
    const name = c?.name ?? code;
    if (c?.raceId) {
      p.setAttribute("tabindex", "0");
      p.setAttribute("role", "button");
      p.setAttribute("aria-label", `${name}: ${c.filteredOut ? "filtered out by the polling density band, " : ""}${c.text}. Open the race.`);
      p.setAttribute("aria-pressed", opts.selected === code ? "true" : "false");
      p.addEventListener("click", () => opts.onPick(code));
      p.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onPick(code); }
      });
    } else {
      p.setAttribute("aria-hidden", "true");
    }
    svg.append(p);
  }
  // state labels for states with a race: postal code and the shown number, so the value does not rely on color
  for (const f of states.features) {
    const code = FIPS[String(f.id).padStart(2, "0")];
    const c = code ? cells.get(code) : undefined;
    if (!c?.raceId) continue;
    const [cx, cy] = path.centroid(f);
    const [dx, dy] = LABEL_NUDGE[code] ?? [0, 0];
    const x = cx + dx, y = cy + dy;
    const fill = c.filteredOut || c.value === null || !scale ? "#eceef1" : scale(c.value);
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", String(x));
    t.setAttribute("y", String(y));
    t.setAttribute("class", "stlabel");
    t.setAttribute("aria-hidden", "true");
    t.setAttribute("fill", inkOn(fill));
    t.innerHTML = `<tspan x="${x}" dy="-0.2em">${code}</tspan><tspan x="${x}" dy="1.15em" class="stval">${
      c.filteredOut ? "filtered" : c.value === null ? "n/a" : opts.fmt(c.value)}</tspan>`;
    svg.append(t);
  }
  // legend: discrete bins plus the two patterns, each with text
  const legend = document.createElement("ul");
  legend.className = "legend";
  legend.setAttribute("aria-label", `Legend for ${opts.metricLabel}`);
  const items: string[] = [];
  if (scale) {
    for (const col of scale.range()) {
      const [a, b] = scale.invertExtent(col);
      items.push(`<li><span class="sw" style="background:${col}"></span>${opts.fmt(a)} to ${opts.fmt(b)}</li>`);
    }
  }
  items.push(`<li><svg class="sw" viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" fill="url(#hatch-insufficient)"/></svg>
    insufficient data (no race, or n under 20)</li>`);
  items.push(`<li><svg class="sw" viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" fill="url(#dots-filtered)"/></svg>
    filtered out (polling density band or race type)</li>`);
  legend.innerHTML = items.join("");
  root.innerHTML = "";
  const fig = document.createElement("div");
  fig.className = "mapwrap";
  fig.append(svg);
  root.append(fig, legend);
  return { scale };
}

export const fmtMap = {
  attention_total: format(".3~s"),
  attention_rho: format(".2f"),
  price_change: (v: number) => `${v > 0 ? "+" : ""}${format(".1f")(v)}`,
  polling_density: format(",.0f"),
  data_coverage: format(".0%"),
};
