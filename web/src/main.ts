import "./style.css";
import { format } from "d3";
import { DEFAULT_RACE, FUNDING_DISCLOSURE, GROUP_DEFAULT_SOURCE, PROJECT_NAME, SHOW_FUNDING_DISCLOSURE, SOURCE_LABEL,
  SOURCE_NOTES, STATES } from "./config";
import { fmtMap, renderMap, type StateCell } from "./map";
import { el, esc, raceTitle, RaceView, shownSeries, type RaceUi } from "./race";
import type { IndexData, IndexRace, RaceData } from "./types";
import { clampRange, densityBand, type DensityBand, mapValue, type MapMetric, PLATFORM_GROUP, raceIdFromSearch,
  type View } from "./transforms";

const METRICS: Record<MapMetric, { label: string; diverging: boolean }> = {
  attention_total: { label: "Total attention over the window", diverging: false },
  attention_rho: { label: "Attention surprise vs volume surprise, rho (lag 0)", diverging: true },
  price_change: { label: "Price change of the followed contract over the window, cents", diverging: true },
  polling_density: { label: "Polling density (polls in the window)", diverging: false },
  data_coverage: { label: "Data coverage (share of days with data)", diverging: false },
};
const GROUPS: Record<string, string> = { all: "All platforms", looking: "Looking (Wikipedia)",
  talking: "Talking (X, Bluesky, Reddit)", reporting: "Reporting (news)" };
const BANDS: Record<DensityBand, string> = { all: "Any polling density", low: "Low (under 10 polls)",
  medium: "Medium (10 to 29 polls)", high: "High (30 or more polls)" };

interface Ui extends RaceUi {
  office: string;
  metric: MapMetric;
  band: DensityBand;
  state: string | null;
  race: string | null;
}

const app = document.getElementById("app")!;
const raceCache = new Map<string, RaceData>();
let index: IndexData;
let view: RaceView | null = null;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function loadRace(id: string): Promise<RaceData> {
  if (!raceCache.has(id)) raceCache.set(id, await getJson<RaceData>(`data/${id}.json`));
  return raceCache.get(id)!;
}

function readUi(): Ui {
  const q = new URLSearchParams(location.search);
  const pick = <T extends string>(k: string, ok: readonly T[], dflt: T): T => (ok.includes(q.get(k) as T) ? (q.get(k) as T) : dflt);
  const raceParam = q.get("race") ? raceIdFromSearch(location.search, "") : "";
  const st = (q.get("state") ?? "").toUpperCase();
  return {
    office: pick("office", ["all", "senate", "governor"], "all"),
    metric: pick("metric", Object.keys(METRICS) as MapMetric[], "attention_total"),
    band: pick("band", Object.keys(BANDS) as DensityBand[], "all"),
    group: pick("group", Object.keys(GROUPS), "all"),
    source: q.get("source") && /^[a-z_]+$/.test(q.get("source")!) ? q.get("source")! : "all",
    view: pick("view", ["raw", "z", "surprise"] as View[], "raw"),
    from: q.get("from") ?? "", to: q.get("to") ?? "",
    overlay: q.get("events") === "on",
    focus: q.get("focus") ?? "wikipedia/pageviews_total",
    state: /^[A-Z]{2}$/.test(st) ? st : null,
    race: raceParam || null,
  };
}

function writeUrl(ui: Ui) {
  const q = new URLSearchParams();
  if (ui.race) q.set("race", ui.race);
  if (ui.state) q.set("state", ui.state);
  if (ui.office !== "all") q.set("office", ui.office);
  if (ui.metric !== "attention_total") q.set("metric", ui.metric);
  if (ui.band !== "all") q.set("band", ui.band);
  if (ui.group !== "all") q.set("group", ui.group);
  if (ui.source !== "all") q.set("source", ui.source);
  if (ui.view !== "raw") q.set("view", ui.view);
  if (ui.overlay) q.set("events", "on");
  const r = ui.race ? index.races[ui.race] : undefined;
  if (r && ui.from && ui.from !== r.window.start) q.set("from", ui.from);
  if (r && ui.to && ui.to !== r.window.end) q.set("to", ui.to);
  if (ui.focus !== "wikipedia/pageviews_total") q.set("focus", ui.focus);
  history.replaceState(null, "", `${location.pathname}?${q.toString()}`);
}

function racesIn(state: string, office: string): IndexRace[] {
  return Object.values(index.races).filter((r) => r.state === state && (office === "all" || r.office === office))
    .sort((a, b) => a.office.localeCompare(b.office));
}

/** The attention series the map reads for the current platform and source filters. */
function mapSource(ui: Ui): string {
  return ui.source !== "all" ? ui.source : GROUP_DEFAULT_SOURCE[ui.group] ?? "wikipedia";
}

function mapSeries(r: IndexRace | undefined, source: string): string {
  const att = r?.metrics?.attention ?? {};
  if (source === "wikipedia") return "wikipedia/pageviews_total";
  return Object.keys(att).find((s) => s.startsWith(source + "/")) ?? `${source}/post_count`;
}

async function main() {
  try {
    index = await getJson<IndexData>("data/index.json");
  } catch (e) {
    app.innerHTML = `<main class="wrap"><h1>${esc(PROJECT_NAME)}</h1><p class="error" role="alert">Could not load
      <code>data/index.json</code> (${esc((e as Error).message)}). Build the site and serve <code>web/dist</code> over
      http (for example <code>npm run preview</code>); opening index.html from disk blocks fetch.</p></main>`;
    return;
  }
  const ui = readUi();
  if (ui.race && !index.races[ui.race]) ui.race = null;
  if (ui.race) ui.state = index.races[ui.race].state;
  if (!ui.race && ui.state) ui.race = racesIn(ui.state, ui.office)[0]?.race_id ?? null;
  if (!ui.race && !ui.state && index.races[DEFAULT_RACE]) {
    ui.race = DEFAULT_RACE;
    ui.state = index.races[DEFAULT_RACE].state;
  }
  renderShell(ui);
  drawMap(ui);
  await openRace(ui, false);
  new ResizeObserver(() => view?.draw()).observe(document.getElementById("race")!);
  document.body.dataset.ready = "true";
}

function sourcesInIndex(): string[] {
  const s = new Set<string>();
  for (const r of Object.values(index.races)) for (const a of Object.values(r.metrics?.attention ?? {})) s.add(a.source);
  return [...s].sort();
}

function renderShell(ui: Ui) {
  const offices = [...new Set(["senate", "governor", ...Object.values(index.races).map((r) => r.office)])];
  const raceStates = [...new Set(Object.values(index.races).map((r) => r.state))].sort((a, b) =>
    (STATES[a] ?? a).localeCompare(STATES[b] ?? b));
  const opt = (v: string, label: string, cur: string) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
  app.innerHTML = "";
  const header = el("header", { class: "wrap head" }, `
    <p class="kicker">${esc(PROJECT_NAME)}: Kalshi market data next to attention data, on one UTC clock</p>
    <h1>2026 races: market prices and attention</h1>
    <p class="lede">${Object.keys(index.races).length} races with committed data. Pick a state on the map, in the table or
      in the list. Every number shows its n; anything with fewer than 20 days or pairs reads "insufficient data". The tool
      reports timing and association, not causation.</p>`);
  const main = el("main", { class: "wrap", id: "main" });
  const filters = el("form", { class: "filters", id: "filters", "aria-labelledby": "filters-h" }, `
    <h2 id="filters-h" class="filters-h">Filters</h2>
    <div class="fgrid">
      <div class="f"><label for="f-state">State</label><select id="f-state">${opt("", "Pick a state", ui.state ?? "")}${
        raceStates.map((s) => opt(s, STATES[s] ?? s, ui.state ?? "")).join("")}</select></div>
      <div class="f"><label for="f-office">Race type</label><select id="f-office">${opt("all", "All race types", ui.office)}${
        offices.map((o) => opt(o, o.charAt(0).toUpperCase() + o.slice(1), ui.office)).join("")}</select></div>
      <div class="f"><label for="f-metric">Map metric</label><select id="f-metric">${Object.entries(METRICS).map(([k, m]) =>
        opt(k, m.label, ui.metric)).join("")}</select></div>
      <div class="f"><label for="f-band">Polling density band</label><select id="f-band">${Object.entries(BANDS).map(([k, l]) =>
        opt(k, l, ui.band)).join("")}</select></div>
      <div class="f"><label for="f-group">Platform group</label><select id="f-group">${Object.entries(GROUPS).map(([k, l]) =>
        opt(k, l, ui.group)).join("")}</select></div>
      <div class="f"><label for="f-source">Source</label><select id="f-source">${opt("all", "All sources in the group", ui.source)}${
        sourcesInIndex().map((s) => opt(s, `${SOURCE_LABEL[s] ?? s} (${PLATFORM_GROUP[s] ?? "other"})`, ui.source)).join("")}</select></div>
      <div class="f"><label for="f-from">Window from</label><input type="date" id="f-from"></div>
      <div class="f"><label for="f-to">Window to</label><input type="date" id="f-to"></div>
      <div class="f fcheck"><input type="checkbox" id="f-overlay" ${ui.overlay ? "checked" : ""}><label for="f-overlay">Show
        information events on the charts</label></div>
    </div>
    <p class="hint" id="filter-hint"></p>`);
  const mapSec = el("section", { "aria-labelledby": "map-h", id: "mapsec" }, `
    <h2 id="map-h">Map</h2>
    <p id="map-caption" class="note"></p>
    <div id="map"></div>
    <h3 class="tcap" id="maptable-cap">The map's values as a table</h3>
    <div class="table-scroll" role="region" aria-labelledby="maptable-cap" tabindex="0"><table id="map-table"
      aria-labelledby="maptable-cap"><thead><tr><th scope="col">State</th><th scope="col">Race</th><th scope="col">Value (n)</th>
      <th scope="col">Polling band</th><th scope="col">Quality (series)</th><th scope="col">Open</th></tr></thead><tbody></tbody></table></div>
    <p class="note" id="map-none"></p>`);
  const raceSec = el("section", { "aria-labelledby": "race-h", id: "racesec" }, `
    <div id="race-switch"></div><div id="race" aria-live="polite"></div>`);
  main.append(filters, mapSec, raceSec);
  app.append(header, main, footer());
  filters.addEventListener("submit", (e) => e.preventDefault());
  const on = (id: string, f: (v: string, e: HTMLInputElement | HTMLSelectElement) => void, ev = "change") =>
    document.getElementById(id)!.addEventListener(ev, (e) => f((e.target as HTMLInputElement).value, e.target as HTMLInputElement));
  on("f-state", (v) => { if (v) pickState(ui, v); });
  on("f-office", (v) => {
    ui.office = v;
    if (ui.state && !racesIn(ui.state, ui.office).some((r) => r.race_id === ui.race)) {
      ui.race = racesIn(ui.state, ui.office)[0]?.race_id ?? ui.race;
    }
    drawMap(ui);
    openRace(ui, true);
  });
  on("f-metric", (v) => { ui.metric = v as MapMetric; drawMap(ui); writeUrl(ui); });
  on("f-band", (v) => { ui.band = v as DensityBand; drawMap(ui); writeUrl(ui); });
  on("f-group", (v) => {
    ui.group = v;
    if (ui.source !== "all" && v !== "all" && PLATFORM_GROUP[ui.source] !== v) {
      ui.source = "all";
      (document.getElementById("f-source") as HTMLSelectElement).value = "all";
    }
    drawMap(ui);
    refreshRace(ui);
  });
  on("f-source", (v) => { ui.source = v; drawMap(ui); refreshRace(ui); });
  on("f-from", (v) => { ui.from = v; refreshRace(ui); });
  on("f-to", (v) => { ui.to = v; refreshRace(ui); });
  on("f-overlay", (_v, t) => { ui.overlay = (t as HTMLInputElement).checked; refreshRace(ui); });
}

function pickState(ui: Ui, code: string) {
  ui.state = code;
  const rs = racesIn(code, ui.office);
  ui.race = (rs.find((r) => r.race_id === ui.race) ?? rs[0] ?? racesIn(code, "all")[0])?.race_id ?? null;
  drawMap(ui);
  openRace(ui, true);
}

function drawMap(ui: Ui) {
  const source = mapSource(ui);
  const m = METRICS[ui.metric];
  const cells = new Map<string, StateCell>();
  const fmt = { int: format(".3~s"), two: format(".2f"), pct: format(".0%") };
  for (const code of Object.keys(STATES)) {
    const rs = racesIn(code, ui.office);
    const r = rs.find((x) => x.race_id === ui.race) ?? rs[0];
    if (!r) {
      cells.set(code, { code, name: STATES[code], value: null, text: "no processed race", raceId: null, filteredOut: false });
      continue;
    }
    const series = mapSeries(r, source);
    const v = mapValue(r.metrics, ui.metric, series, fmt);
    const band = densityBand(r.metrics?.polling_density);
    const filteredOut = ui.band !== "all" && band !== ui.band;
    cells.set(code, { code, name: STATES[code], value: v.value, raceId: r.race_id, filteredOut,
      text: v.value === null ? `insufficient data (${v.reason})` : v.text });
  }
  const usesSource = ui.metric === "attention_total" || ui.metric === "attention_rho";
  document.getElementById("map-caption")!.innerHTML = `Colored by <strong>${esc(m.label)}</strong>${usesSource
    ? ` for <strong>${esc(SOURCE_LABEL[source] ?? source)}</strong>${source === "wikipedia" ? " (race page plus candidate pages, summed)" : ""}`
    : ""}; ${ui.office === "all" ? "all race types" : `${esc(ui.office)} races only`}; ${esc(BANDS[ui.band].toLowerCase())}.
    Totals and changes cover the non-excluded days of each race's window (election night left out). Bins are equal
    width over the values shown.`;
  renderMap(document.getElementById("map")!, cells, { diverging: m.diverging, metricLabel: m.label, selected: ui.state,
    fmt: fmtMap[ui.metric], onPick: (code) => pickState(ui, code) });
  const withRace = [...cells.values()].filter((c) => c.raceId).sort((a, b) => a.name.localeCompare(b.name));
  const tbody = document.querySelector("#map-table tbody")!;
  tbody.innerHTML = withRace.map((c) => {
    const r = index.races[c.raceId!];
    const qs = r.metrics?.quality_summary;
    const band = densityBand(r.metrics?.polling_density);
    return `<tr data-state="${c.code}"><th scope="row">${esc(c.name)}</th><td>${esc(raceTitle({ race: r }))}</td>
      <td data-k="value">${c.filteredOut ? `filtered out by the band; ${esc(c.text)}` : esc(c.text)}</td>
      <td>${band ?? "unknown"}${r.metrics?.polling_density != null ? ` (n=${r.metrics.polling_density} poll${r.metrics.polling_density === 1 ? "" : "s"})` : ""}</td>
      <td>${qs ? `${qs.ok} ok, ${qs.degraded} degraded, ${qs.unusable} unusable` : "n/a"}</td>
      <td><button type="button" class="linkish" data-open="${c.code}" ${ui.state === c.code ? 'aria-current="true"' : ""}>Open
        <span class="vh">${esc(c.name)}</span></button></td></tr>`;
  }).join("");
  tbody.querySelectorAll<HTMLButtonElement>("button[data-open]").forEach((b) =>
    b.addEventListener("click", () => pickState(ui, b.dataset.open!)));
  const none = [...cells.values()].filter((c) => !c.raceId && c.code !== "DC" && c.code !== "PR").map((c) => c.name);
  document.getElementById("map-none")!.textContent = `${none.length} states (plus DC and Puerto Rico) have no processed
    race for this race type and are drawn as insufficient data: ${none.join(", ")}.`.replace(/\s+/g, " ");
}

async function openRace(ui: Ui, scroll: boolean) {
  const root = document.getElementById("race")!;
  const sw = document.getElementById("race-switch")!;
  (document.getElementById("f-state") as HTMLSelectElement).value = ui.state ?? "";
  if (!ui.race) {
    sw.innerHTML = "";
    root.innerHTML = `<p class="note" id="race-h">No race selected. Pick a state above.</p>`;
    writeUrl(ui);
    return;
  }
  const rs = racesIn(ui.state ?? index.races[ui.race].state, "all");
  sw.innerHTML = rs.length > 1 ? `<fieldset class="toggle" id="race-type"><legend>Race type in ${esc(STATES[ui.state!] ?? ui.state)}</legend>${
    rs.map((r) => `<label><input type="radio" name="racetype" value="${esc(r.race_id)}" ${r.race_id === ui.race ? "checked" : ""}>
      ${esc(r.office.charAt(0).toUpperCase() + r.office.slice(1))}</label>`).join("")}</fieldset>`
    : `<p class="note" id="race-type">${esc(STATES[ui.state!] ?? "")}: one race with data (${esc(index.races[ui.race].office)}).</p>`;
  sw.querySelectorAll<HTMLInputElement>('input[name="racetype"]').forEach((i) => i.addEventListener("change", () => {
    ui.race = i.value;
    openRace(ui, false);
  }));
  let data: RaceData;
  try {
    data = await loadRace(ui.race);
  } catch (e) {
    root.innerHTML = `<p class="error" role="alert">Could not load <code>data/${esc(ui.race)}.json</code>
      (${esc((e as Error).message)}).</p>`;
    return;
  }
  [ui.from, ui.to] = clampRange(ui.from || null, ui.to || null, data.window.start, data.window.end);
  syncDateInputs(ui, data);
  if (!shownSeries(data, ui).includes(ui.focus)) ui.focus = shownSeries(data, ui)[0] ?? ui.focus;
  document.title = `${raceTitle(data)} | ${PROJECT_NAME}`;
  view = new RaceView(root, data, ui);
  root.addEventListener("uichange", () => writeUrl(ui));
  view.render();
  view.draw(true);
  writeUrl(ui);
  updateHint(ui, data);
  if (scroll) document.getElementById("race-h")?.scrollIntoView({ block: "start" });
}

function syncDateInputs(ui: Ui, data: RaceData) {
  for (const [id, v] of [["f-from", ui.from], ["f-to", ui.to]] as const) {
    const i = document.getElementById(id) as HTMLInputElement;
    i.min = data.window.start;
    i.max = data.window.end;
    i.value = v;
  }
}

function updateHint(ui: Ui, data: RaceData) {
  const n = shownSeries(data, ui).length;
  document.getElementById("filter-hint")!.textContent = `Showing ${n} attention series of ${raceTitle(data)} for these
    filters; window ${ui.from} to ${ui.to}. Platform group, source, window and the event overlay change the race panels;
    race type, metric, source and polling band change the map.`.replace(/\s+/g, " ");
}

function refreshRace(ui: Ui) {
  if (!view) return;
  [ui.from, ui.to] = clampRange(ui.from || null, ui.to || null, view.data.window.start, view.data.window.end);
  syncDateInputs(ui, view.data);
  if (!shownSeries(view.data, ui).includes(ui.focus)) ui.focus = shownSeries(view.data, ui)[0] ?? ui.focus;
  view.ui = ui;
  view.render();
  view.draw(true);
  writeUrl(ui);
  updateHint(ui, view.data);
}

function footer(): HTMLElement {
  const notes = ["kalshi", "wikipedia"].map((s) => SOURCE_NOTES[s]).filter(Boolean);
  return el("footer", { class: "wrap foot" }, `
    <p><strong>${esc(PROJECT_NAME)}</strong> (working name). Index updated ${esc(index.updated_at)}.</p>
    <ul>${notes.map((n) => `<li>${esc(n.name)}: ${esc(n.note)} <a href="${esc(n.url)}" rel="noreferrer">Source
      terms</a></li>`).join("")}</ul>
    <p>Map geometry: us-atlas 3.0.1 (US Census Bureau cartographic boundaries, ISC license), bundled with the page.</p>
    <p>Only counts and metrics are published, never post text or user data. Code and data licenses are not yet decided.</p>
    ${SHOW_FUNDING_DISCLOSURE ? `<p class="disclosure">${esc(FUNDING_DISCLOSURE)}</p>` : ""}`);
}

main();
