// US state map (d3-geo + us-atlas, bundled; no remote topojson). The geometry is the pre-projected
// states-albers-10m.json from us-atlas 3.0.1, committed in src/geo/, so the map renders from the page's own files.
import { format, geoPath, scaleQuantize } from "d3";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import atlas from "./geo/states-albers-10m.json";

export interface StateCell {
  code: string;
  name: string;
  value: number | null;      // null: no data, insufficient data or no race
  status: "ok" | "insufficient" | "nodata";
  text: string;              // value with unit and n, or the reason
  raceId: string | null;
  filteredOut: boolean;      // outside the polling filter
  active: boolean;           // open for clicks; every other state is drawn faded (coming soon)
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

// The faded style of a state that is coming soon, has no race, no data, insufficient data (n under 20 days) or falls
// outside the polling filter: one solid fill (3:1 against the page in both themes, docs/style-contrast.md), the same
// as the legend's coming soon swatch.
export const FADED_FILL = "var(--map-faded)";

// One ramp for both metrics, --map-1 (closest to the page) to --map-5 (closest to the text color), from style.css.
export const RAMP = [1, 2, 3, 4, 5].map((i) => `var(--map-${i})`);

const si = format(".3~s");

/** Map values and legend edges: three significant digits with an SI suffix (6.66k, 43M), rounded half up on the
 * decimal value. A bin edge or sum such as 6654.999... (float noise for 6655) reads 6.66k, not 6.65k. */
export function fmtCompact(v: number): string {
  if (!Number.isFinite(v) || v === 0) return si(v);
  const clean = (x: number) => Number(x.toPrecision(12));  // drop float noise below 12 significant digits
  const x = clean(v);
  const unit = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 2);  // the place of the third significant digit
  return si(clean(Math.sign(x) * Math.round(clean(Math.abs(x) / unit)) * unit));
}

/** Five equal-width bins from 0 (or the lowest value, if negative) to the highest shown value. */
export function binScale(values: number[]) {
  const lo = Math.min(...values), hi = Math.max(...values);
  return scaleQuantize<string>().domain([Math.min(0, lo), hi === lo ? lo + 1 : hi]).range(RAMP);
}

type Scale = ReturnType<typeof binScale>;

/** True when the state is drawn with its bin color: an open state with a value inside the polling filter. */
export function isShown(c: StateCell | undefined, scale: Scale | null): boolean {
  return !!c && !!scale && c.active && !c.filteredOut && c.status === "ok" && c.value !== null;
}

/** The fill of a state: its bin color, or the faded style. */
export function fillOf(c: StateCell | undefined, scale: Scale | null): string {
  return isShown(c, scale) ? scale!(c!.value as number) : FADED_FILL;
}

/** The value line of an on-map label, or null for the postal code only. A value from under 20 days has status
 * "insufficient" and value null, so it never shows as a number. */
export function labelValue(c: StateCell, fmt: (n: number) => string): string | null {
  return c.status === "ok" && c.value !== null && !c.filteredOut ? fmt(c.value) : null;
}

/** The map legend: the five bins (labels from the data) and the faded "coming soon" entry; only that entry when
 * there is no scale. */
export function legendEntries(scale: Scale | null, fmt: (n: number) => string): { fill: string; label: string; faded: boolean }[] {
  const out = scale ? scale.range().map((col) => {
    const [a, b] = scale.invertExtent(col);
    return { fill: col, label: `${fmt(a)} to ${fmt(b)}`, faded: false };
  }) : [];
  return [...out, { fill: FADED_FILL, label: "coming soon", faded: true }];
}

/** Labels on bins 3 to 5 use the background color, on bins 1 and 2 the text color (4.5:1 in both themes, see
 * docs/style-contrast.md). */
function onDark(fill: string): boolean {
  return RAMP.indexOf(fill) >= 2;
}

/** The words a reader gets for one state: the open state's aria-label and title, and every row of the map table. */
export function stateText(c: StateCell): string {
  const parts = [c.filteredOut ? `outside the polling filter, ${c.text}` : c.text];
  if (!c.active) parts.push("coming soon");
  return `${c.name}: ${parts.join(", ")}`;
}

/** What a state path carries for readers: only an open state with a race (Texas) gets a tooltip, a name and a
 * focus stop. Every other state is a bare faded shape (aria-hidden); the hidden map table carries its values. */
export function stateA11y(c: StateCell | undefined, selected: string | null): { title: string; role: "button";
  label: string; pressed: boolean } | null {
  if (!c?.active || !c.raceId) return null;
  const text = stateText(c);
  return { title: text, role: "button", label: `${text}. Open the race.`, pressed: selected === c.code };
}

/** True when the state gets an on-map label (postal code and value): open states only. */
export function hasLabel(c: StateCell | undefined): boolean {
  return !!c?.raceId && c.active;
}

export function renderMap(root: HTMLElement, cells: Map<string, StateCell>, opts: { metricLabel: string;
  selected: string | null; fmt: (n: number) => string; onPick: (code: string) => void }) {
  const shown = [...cells.values()].filter((c) => c.value !== null && !c.filteredOut).map((c) => c.value as number);
  const scale = shown.length ? binScale(shown) : null;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 975 610");
  svg.setAttribute("class", "usmap");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", `US map colored by ${opts.metricLabel}. Texas is a button; the other states are
    coming soon. The same values are in the table below the map.`.replace(/\s+/g, " "));
  for (const f of states.features) {
    const code = FIPS[String(f.id).padStart(2, "0")];
    if (!code) continue;
    const c = cells.get(code);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", path(f) ?? "");
    p.setAttribute("data-state", code);
    if (c?.raceId) p.setAttribute("data-race", c.raceId);
    // tokens as inline style, since var() belongs in CSS, not in presentation attributes
    p.style.fill = fillOf(c, scale);
    p.setAttribute("class", "st" + (c?.active ? " active" : " greyed") + (isShown(c, scale) ? "" : " faded")
      + (opts.selected === code ? " selected" : ""));
    const a = stateA11y(c, opts.selected);
    if (a) {
      const title = document.createElementNS(NS, "title");
      title.textContent = a.title;
      p.append(title);
      p.setAttribute("tabindex", "0");
      p.setAttribute("role", a.role);
      p.setAttribute("aria-label", a.label);
      p.setAttribute("aria-pressed", String(a.pressed));
      p.addEventListener("click", () => opts.onPick(code));
      p.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onPick(code); }
      });
    } else {
      p.setAttribute("aria-hidden", "true");
    }
    svg.append(p);
  }
  // the selected state's outline goes above every state, so no neighbor border covers it
  const sel = opts.selected ? states.features.find((f) => FIPS[String(f.id).padStart(2, "0")] === opts.selected) : undefined;
  if (sel) {
    for (const cls of ["sel-halo", "sel-line"]) {
      const o = document.createElementNS(NS, "path");
      o.setAttribute("d", path(sel) ?? "");
      o.setAttribute("class", cls);
      o.setAttribute("aria-hidden", "true");
      svg.append(o);
    }
  }
  // labels for open states only (Texas): postal code and the shown number, so the value does not rely on color
  for (const f of states.features) {
    const code = FIPS[String(f.id).padStart(2, "0")];
    const c = code ? cells.get(code) : undefined;
    if (!c || !hasLabel(c)) continue;
    const [cx, cy] = path.centroid(f);
    const [dx, dy] = LABEL_NUDGE[code] ?? [0, 0];
    const x = cx + dx, y = cy + dy;
    const fill = fillOf(c, scale);
    const val = labelValue(c, opts.fmt);
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", String(x));
    t.setAttribute("y", String(y));
    t.setAttribute("class", "stlabel" + (isShown(c, scale) && onDark(fill) ? " on-dark" : ""));
    t.setAttribute("aria-hidden", "true");
    t.innerHTML = val === null ? `<tspan x="${x}" dy="0.35em">${code}</tspan>`
      : `<tspan x="${x}" dy="-0.2em">${code}</tspan><tspan x="${x}" dy="1.15em" class="stval">${val}</tspan>`;
    svg.append(t);
  }
  // legend: the five bins and the faded "coming soon" entry, in one row that wraps
  const legend = document.createElement("ul");
  legend.className = "legend";
  legend.setAttribute("aria-label", `Legend for ${opts.metricLabel}`);
  legend.innerHTML = legendEntries(scale, opts.fmt).map((e) =>
    `<li><span class="sw${e.faded ? " sw-greyed" : ""}" style="background:${e.fill}"></span>${e.label}</li>`).join("");
  root.innerHTML = "";
  const fig = document.createElement("div");
  fig.className = "mapwrap";
  fig.append(svg);
  root.append(fig, legend);
  return { scale };
}
