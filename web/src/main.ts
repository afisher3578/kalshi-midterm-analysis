import "./style.css";
import { chartTitle, DEFAULT_RACE, FUNDING_DISCLOSURE, MAP_TITLE, MEDIA_ATTENTION_DEF, PROJECT_NAME, SHOW_DETAILS,
  SHOW_FUNDING_DISCLOSURE, STATES, SUBTITLE, TITLE } from "./config";
import { chartSeries, hasData, hourlySeries, NEWS_COL, partyLines, WIKI_COL } from "./display";
import { countChanged, DEFAULT_FILTERS, ENABLED_STATES, ENABLED_TYPES, type Filters, mapValue, METRICS, parseHash,
  passesPolls, pollClass, POLLS, RACE_TYPES, serializeHash, SOURCES } from "./filters";
import { FILTER, INFO, themeIcon } from "./icons";
import { type ChartState, LineChart } from "./linechart";
import { fmtCompact, renderMap, type StateCell, stateText } from "./map";
import { loadNewsModel, localServer, NewsView } from "./newsview";
import { el, esc, footerItems, raceTitle, RaceView, shownSeries, type RaceUi } from "./race";
import type { DisplayDaily, IndexData, IndexRace, RaceData } from "./types";
import { byOffice, clampRange, raceIdFromSearch, type View } from "./transforms";

const METRIC_LABEL = { volume: "Kalshi trading volume, contracts over the display window",
  attention: { news: "attention, news stories over the display window", wikipedia: "attention, Wikipedia pageviews over the display window" } };
const fmtMap = fmtCompact;

interface Ui extends RaceUi {
  filters: Filters;       // the five controls in the Filters panel, kept in the URL hash
  state: string | null;   // the state of the open race (the map outline)
  race: string | null;
  page: "race" | "news";  // ?view=news opens the News (Media Cloud) view; the other view values pick the panel transform
  demo: boolean;          // ?demo=1: ask the local dashboard server for the synthetic Media Cloud fixture
}

const app = document.getElementById("app")!;
const raceCache = new Map<string, RaceData>();
let index: IndexData;
let view: RaceView | null = null;
let newsView: NewsView | null = null;
let chart: LineChart | null = null;
// the chart's line toggles and dates carry over when another race is opened
const chartState: ChartState = { visible: { dem: true, rep: true, volume: true, news: true }, from: "", to: "" };
let demoDisplay: { race: string; dd: DisplayDaily } | null | undefined;

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
  const filters = parseHash(location.hash);
  return {
    filters,
    group: "all", source: detailSource(filters),
    view: pick("view", ["raw", "z", "surprise"] as View[], "raw"),
    from: q.get("from") ?? "", to: q.get("to") ?? "",
    overlay: q.get("events") === "on",
    focus: q.get("focus") ?? "wikipedia/pageviews_total",
    state: null,
    race: raceParam || null,
    page: SHOW_DETAILS && q.get("view") === "news" ? "news" : "race",
    demo: q.get("demo") === "1",
  };
}

/** The race detail views (SHOW_DETAILS) keep their source filter; it follows the Sources control. */
function detailSource(f: Filters): string {
  return f.source === "news" ? "news_mediacloud" : "wikipedia";
}

function writeUrl(ui: Ui) {
  history.replaceState(null, "", queryFor(ui) + serializeHash(ui.filters));
}

/** The query string: race, page and window. The filters live in the hash (serializeHash). */
function queryFor(ui: Ui, page = ui.page): string {
  const q = new URLSearchParams();
  if (ui.race) q.set("race", ui.race);
  if (page === "news") q.set("view", "news");
  else if (ui.view !== "raw") q.set("view", ui.view);
  if (ui.demo) q.set("demo", "1");
  if (ui.overlay) q.set("events", "on");
  const r = ui.race ? index.races[ui.race] : undefined;
  if (r && ui.from && ui.from !== r.window.start) q.set("from", ui.from);
  if (r && ui.to && ui.to !== r.window.end) q.set("to", ui.to);
  if (ui.focus !== "wikipedia/pageviews_total") q.set("focus", ui.focus);
  const s = q.toString();
  return `${location.pathname}${s ? `?${s}` : ""}`;
}

function racesIn(state: string, office: string): IndexRace[] {
  return Object.values(index.races).filter((r) => r.state === state && (office === "all" || r.office === office))
    .sort(byOffice);
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
  // no race in the URL: the race the State and Race type controls point at (Texas Senate)
  if (!ui.race) ui.race = racesIn(ui.filters.state, ui.filters.type)[0]?.race_id ?? (index.races[DEFAULT_RACE] ? DEFAULT_RACE : null);
  ui.state = ui.race ? index.races[ui.race].state : null;
  renderShell(ui);
  drawMap(ui);
  await openRace(ui, false);
  addEventListener("hashchange", () => {
    const f = parseHash(location.hash);
    if (serializeHash(f) !== serializeHash(ui.filters)) applyFilters(ui, f, false);
  });
  new ResizeObserver(() => { view?.draw(); newsView?.draw(); chart?.draw(); }).observe(document.getElementById("race")!);
  document.body.dataset.ready = "true";
}

function renderShell(ui: Ui) {
  app.innerHTML = "";
  const header = el("header", { class: "wrap head" }, `
    <div class="headrow"><div class="titles"><h1>${esc(TITLE)}</h1><p class="subtitle">${esc(SUBTITLE)}</p></div>
      <button type="button" class="theme-toggle" id="theme-btn"></button></div>`);
  const main = el("main", { class: "wrap", id: "main" });
  const mapSec = el("section", { "aria-labelledby": "map-h", id: "mapsec" }, `
    <div class="maphead"><h2 id="map-h">${esc(MAP_TITLE)}<button type="button" class="info-btn" id="ma-info"
      aria-label="What is media attention?" aria-describedby="ma-tip">${INFO}</button></h2>
      <div class="tip-pop" id="ma-tip" role="tooltip" hidden>${esc(MEDIA_ATTENTION_DEF)}</div>${filtersPanel(ui.filters)}</div>
    <div id="map"></div>
    <div class="vh" id="map-table-wrap"><table id="map-table" aria-label="Map values by state"><thead><tr><th scope="col">State</th><th scope="col">Race</th>
      <th scope="col">Value (n)</th><th scope="col">Polls in the window</th><th scope="col">Status</th></tr></thead>
      <tbody></tbody></table></div>`);
  const raceSec = SHOW_DETAILS ? el("section", { "aria-labelledby": "race-h", id: "racesec" }, `
    <form class="window" id="window-form"><div class="f"><label for="f-from">Window from</label><input type="date" id="f-from"></div>
      <div class="f"><label for="f-to">Window to</label><input type="date" id="f-to"></div>
      <div class="f fcheck"><input type="checkbox" id="f-overlay" ${ui.overlay ? "checked" : ""}><label for="f-overlay">Show
        information events on the charts</label></div></form>
    <nav id="race-tabs" aria-label="Race views"></nav><div id="race" aria-live="polite"></div>`)
    : el("section", { "aria-labelledby": "chart-h", id: "racesec", class: "chartsec" }, `
    <div id="race"></div>`);
  main.append(mapSec, raceSec);
  app.append(header, main);
  app.append(footer());
  themeToggle(document.getElementById("theme-btn") as HTMLButtonElement);
  infoTip(document.getElementById("ma-info") as HTMLButtonElement, document.getElementById("ma-tip")!);
  wireFilters(ui);
  if (!SHOW_DETAILS) return;
  const on = (id: string, f: (v: string, e: HTMLInputElement) => void) =>
    document.getElementById(id)!.addEventListener("change", (e) => f((e.target as HTMLInputElement).value, e.target as HTMLInputElement));
  document.getElementById("window-form")!.addEventListener("submit", (e) => e.preventDefault());
  on("f-from", (v) => { ui.from = v; refreshRace(ui); });
  on("f-to", (v) => { ui.to = v; refreshRace(ui); });
  on("f-overlay", (_v, t) => { ui.overlay = t.checked; refreshRace(ui); });
}

const SOON = "Coming soon";

/** The Filters button and its panel (a popover on wide screens, a bottom sheet on phones): five controls. */
function filtersPanel(f: Filters): string {
  const soon = ` disabled aria-disabled="true" title="${SOON}"`;
  const states = Object.entries(STATES).filter(([c]) => c !== "DC" && c !== "PR").sort((a, b) => a[1].localeCompare(b[1]));
  const radios = (name: string, opts: { value: string; label: string }[], cur: string, enabled?: string[]) =>
    opts.map((o) => {
      const off = enabled && !enabled.includes(o.value);
      return `<label class="tg${off ? " soon" : ""}"${off ? ` title="${SOON}"` : ""}><input type="radio" name="${name}" value="${esc(o.value)}"${
        o.value === cur ? " checked" : ""}${off ? soon : ""}><span>${esc(o.label)}</span>${
        off ? '<span class="soon-tag">soon</span>' : ""}</label>`;
    }).join("");
  return `<div class="fwrap" id="fwrap">
    <button type="button" class="filters-btn" id="filters-btn" aria-expanded="false" aria-controls="filters-panel"
      aria-label="Filters" title="Filters">${FILTER}<span class="fbadge" id="filters-badge" hidden></span></button>
    <div class="fpanel" id="filters-panel" role="dialog" aria-labelledby="filters-h" hidden>
      <form id="filters" class="filters">
        <div class="fhead"><h3 id="filters-h">Filters</h3>
          <button type="button" id="f-reset">Reset</button><button type="button" id="f-close" class="fclose">Close</button></div>
        <div class="f" data-control="state"><label for="f-state">State</label><select id="f-state">${states.map(([c, n]) =>
          `<option value="${c}"${c === f.state ? " selected" : ""}${ENABLED_STATES.includes(c) ? "" : soon}>${esc(n)}</option>`).join("")}</select></div>
        <fieldset class="fset" data-control="type"><legend>Race type</legend>${radios("f-type", RACE_TYPES, f.type, ENABLED_TYPES)}</fieldset>
        <fieldset class="fset" data-control="metric"><legend>Map metric</legend>${radios("f-metric", METRICS, f.metric)}</fieldset>
        <fieldset class="fset seg" data-control="polls"><legend>Polling</legend>${radios("f-polls", POLLS, f.polls)}</fieldset>
        <fieldset class="fset" data-control="source"><legend>Sources</legend>${radios("f-source", SOURCES, f.source)}
          <p class="hint">More sources in development.</p></fieldset>
      </form>
    </div>
  </div>`;
}

function wireFilters(ui: Ui) {
  const btn = document.getElementById("filters-btn") as HTMLButtonElement;
  const panel = document.getElementById("filters-panel")!;
  const wrap = document.getElementById("fwrap")!;
  const form = document.getElementById("filters") as HTMLFormElement;
  const isOpen = () => btn.getAttribute("aria-expanded") === "true";
  const setOpen = (open: boolean, focusBtn = false) => {
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("sheet-open", open);
    if (open) (form.querySelector<HTMLElement>("select, input:checked:not([disabled])"))?.focus();
    else if (focusBtn) btn.focus();
  };
  btn.addEventListener("click", () => setOpen(!isOpen()));
  document.getElementById("f-close")!.addEventListener("click", () => setOpen(false, true));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) { e.preventDefault(); setOpen(false, true); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (isOpen() && !wrap.contains(e.target as Node)) setOpen(false);
  });
  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const f = { ...ui.filters };
    if (t.id === "f-state") f.state = t.value;
    else if (t.name === "f-type") f.type = t.value;
    else if (t.name === "f-metric") f.metric = t.value as Filters["metric"];
    else if (t.name === "f-polls") f.polls = t.value as Filters["polls"];
    else if (t.name === "f-source") f.source = t.value as Filters["source"];
    applyFilters(ui, parseHash(serializeHash(f)), t.id === "f-state" || t.name === "f-type");
  });
  document.getElementById("f-reset")!.addEventListener("click", () => applyFilters(ui, { ...DEFAULT_FILTERS }, true));
  syncFilters(ui);
}

/** Put the controls and the badge in line with ui.filters. */
function syncFilters(ui: Ui) {
  const f = ui.filters;
  (document.getElementById("f-state") as HTMLSelectElement).value = f.state;
  for (const [name, v] of [["f-type", f.type], ["f-metric", f.metric], ["f-polls", f.polls], ["f-source", f.source]]) {
    document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((i) => { i.checked = i.value === v; });
  }
  const n = countChanged(f);
  const badge = document.getElementById("filters-badge")!;
  badge.hidden = n === 0;
  badge.innerHTML = n ? `${n}<span class="vh"> changed</span>` : "";
  // the name holds the visible count too (WCAG 2.5.3, label in name)
  document.getElementById("filters-btn")!.setAttribute("aria-label", n ? `Filters, ${n} changed` : "Filters");
}

/** Apply a new filter state. `pick`: the State or Race type control (or Reset) was used, so open that race. */
function applyFilters(ui: Ui, f: Filters, pick: boolean) {
  const sourceChanged = f.source !== ui.filters.source;
  ui.filters = f;
  ui.source = detailSource(f);
  syncFilters(ui);
  const target = racesIn(f.state, f.type)[0]?.race_id;
  if (pick && target && target !== ui.race) {
    ui.race = target;
    ui.state = f.state;
    drawMap(ui);
    openRace(ui, false);
    return;
  }
  drawMap(ui);
  if (sourceChanged) { if (SHOW_DETAILS) refreshRace(ui); else openRace(ui, false); }
  writeUrl(ui);
}

/** The theme switch (as on alexfisher.co): the current theme's glyph as text; flips data-theme on <html> and saves
 * it. index.html sets the first value before paint. All colors are CSS variables, so the map and chart follow without a redraw. */
function themeToggle(btn: HTMLButtonElement) {
  const root = document.documentElement;
  const sync = () => {
    const t = themeIcon(root.dataset.theme === "dark" ? "dark" : "light");
    btn.textContent = t.glyph;
    btn.dataset.icon = t.icon;
    btn.setAttribute("aria-label", t.label);
    btn.title = t.label;
    btn.setAttribute("aria-pressed", String(root.dataset.theme === "dark"));
  };
  sync();
  btn.addEventListener("click", () => {
    const t = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = t;
    try { localStorage.setItem("theme", t); } catch { /* storage blocked: the switch still works for this page */ }
    sync();
  });
  // without a saved choice, follow the system setting when it changes
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    let saved: string | null = null;
    try { saved = localStorage.getItem("theme"); } catch { /* none */ }
    if (saved) return;
    root.dataset.theme = e.matches ? "dark" : "light";
    sync();
  });
}

/** The media attention tooltip: shows on hover (it stays open while the pointer is over it) and on focus, a click or
 * tap pins it open or closes it, Esc, a click outside and blur close it. Placed under the button, inside the
 * map heading's box, so it stays in the viewport on phones. */
function infoTip(btn: HTMLButtonElement, tip: HTMLElement) {
  const s = { hover: false, focus: false, pinned: false, off: false };
  let leave = 0;
  const sync = () => {
    const open = !s.off && (s.hover || s.focus || s.pinned);
    if (open === !tip.hidden) return;
    tip.hidden = !open;
    if (!open) return;
    const box = tip.offsetParent?.getBoundingClientRect(), b = btn.getBoundingClientRect();
    if (!box) return;
    const w = tip.offsetWidth, mid = b.left + b.width / 2 - box.left;
    tip.style.left = `${Math.max(0, Math.min(box.width - w, mid - w / 2))}px`;
    tip.style.top = `${b.bottom - box.top}px`;
  };
  const hover = (on: boolean) => {
    clearTimeout(leave);
    if (on) { s.hover = true; s.off = false; sync(); return; }
    leave = window.setTimeout(() => { s.hover = false; sync(); }, 120);  // time to move onto the tooltip
  };
  for (const e of [btn, tip]) {
    e.addEventListener("pointerenter", (ev) => { if (ev.pointerType !== "touch") hover(true); });
    e.addEventListener("pointerleave", (ev) => { if (ev.pointerType !== "touch") hover(false); });
  }
  btn.addEventListener("focus", () => { s.focus = true; s.off = false; sync(); });
  btn.addEventListener("blur", () => { Object.assign(s, { focus: false, pinned: false, hover: false }); sync(); });
  btn.addEventListener("click", () => {
    if (s.pinned && !s.off) Object.assign(s, { pinned: false, off: true });
    else Object.assign(s, { pinned: true, off: false });
    sync();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !tip.hidden) { Object.assign(s, { pinned: false, off: true }); sync(); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!btn.contains(e.target as Node) && !tip.contains(e.target as Node)) {
      Object.assign(s, { pinned: false, hover: false, off: true });
      sync();
    }
  });
}

function pickState(ui: Ui, code: string) {
  ui.state = code;
  ui.race = racesIn(code, ui.filters.type)[0]?.race_id ?? racesIn(code, "all")[0]?.race_id ?? null;
  drawMap(ui);
  openRace(ui, true);
}

function drawMap(ui: Ui) {
  const f = ui.filters;
  const cells = new Map<string, StateCell>();
  const label = f.metric === "volume" ? METRIC_LABEL.volume : METRIC_LABEL.attention[f.source];
  for (const code of Object.keys(STATES)) {
    const r = racesIn(code, f.type)[0];
    const active = ENABLED_STATES.includes(code);
    if (!r) {
      cells.set(code, { code, name: STATES[code], value: null, status: "nodata", text: `no ${f.type} race`, raceId: null,
        filteredOut: false, active });
      continue;
    }
    const v = mapValue(r.display, f.metric, f.source, fmtMap);
    cells.set(code, { code, name: STATES[code], value: v.value, status: v.status, text: v.text, raceId: r.race_id,
      filteredOut: !passesPolls(f.polls, r.metrics?.polling_density), active });
  }
  renderMap(document.getElementById("map")!, cells, { metricLabel: label, selected: ui.state, fmt: fmtMap,
    onPick: (code) => pickState(ui, code) });
  // text alternative: every race, the map's value for the race the map shows, its polls and whether it is open yet
  const rows = Object.values(index.races).sort((a, b) => (STATES[a.state] ?? a.state).localeCompare(STATES[b.state] ?? b.state) || byOffice(a, b));
  document.querySelector("#map-table tbody")!.innerHTML = rows.map((r) => {
    const c = cells.get(r.state);
    const fills = c?.raceId === r.race_id;
    const polls = r.metrics?.polling_density;
    const open = fills && c!.active;
    return `<tr data-state="${r.state}" data-race="${esc(r.race_id)}"${fills ? ' data-fill="true"' : ""}><th scope="row">${
      esc(STATES[r.state] ?? r.state)}</th><td>${esc(raceTitle({ race: r }))}</td>
      <td data-k="value">${fills ? esc(stateText(c!).replace(/^[^:]+: /, "")) : "not on the map (race type coming soon)"}</td>
      <td>${polls != null ? `${polls} (${pollClass(polls) === "few" ? "few" : "many"})` : "unknown"}</td>
      <td>${open ? "available" : "coming soon"}</td></tr>`;
  }).join("");
}

async function openRace(ui: Ui, scroll: boolean) {
  const root = document.getElementById("race")!;
  const tabs = document.getElementById("race-tabs");
  if (!ui.race) {
    if (tabs) tabs.innerHTML = "";
    root.innerHTML = `<p class="note" id="${SHOW_DETAILS ? "race-h" : "chart-h"}">No race selected. Pick Texas on the map.</p>`;
    writeUrl(ui);
    return;
  }
  // the race comes from the map and the Filters panel (State, Race type) or ?race=; the chart has no race switch
  let data: RaceData;
  try {
    data = await loadRace(ui.race);
  } catch (e) {
    root.innerHTML = `<p class="error" role="alert">Could not load <code>data/${esc(ui.race)}.json</code>
      (${esc((e as Error).message)}).</p>`;
    return;
  }
  if (!SHOW_DETAILS) {
    await openChart(ui, data, root);
    if (scroll) document.getElementById("chart-h")?.scrollIntoView({ block: "start" });
    return;
  }
  [ui.from, ui.to] = clampRange(ui.from || null, ui.to || null, data.window.start, data.window.end);
  syncDateInputs(ui, data);
  if (!shownSeries(data, ui).includes(ui.focus)) ui.focus = shownSeries(data, ui)[0] ?? ui.focus;
  renderTabs(ui, tabs!);
  if (ui.page === "news") {
    document.title = `${raceTitle(data)}: News (Media Cloud) | ${PROJECT_NAME}`;
    view = null;
    try {
      const model = await loadNewsModel(data, ui.demo, getJson);
      newsView = new NewsView(root, data, model);
      newsView.render();
      newsView.draw(true);
    } catch (e) {
      root.innerHTML = `<p class="error" role="alert">Could not load the Media Cloud data for ${esc(ui.race)}
        (${esc((e as Error).message)}).</p>`;
    }
    writeUrl(ui);
    if (scroll) document.getElementById("race-h")?.scrollIntoView({ block: "start" });
    return;
  }
  newsView = null;
  document.title = `${raceTitle(data)} | ${PROJECT_NAME}`;
  view = new RaceView(root, data, ui);
  root.addEventListener("uichange", () => writeUrl(ui));
  view.render();
  view.draw(true);
  writeUrl(ui);
  if (scroll) document.getElementById("race-h")?.scrollIntoView({ block: "start" });
}

/** The demo fixture's display_daily (synthetic news counts), only from a server started with --demo and only for
 * the race it was started for; undefined until asked, null when there is none. */
async function demoNews(ui: Ui, raceId: string): Promise<DisplayDaily | null> {
  if (!ui.demo || localServer() !== "demo") return null;
  if (demoDisplay === undefined) {
    try {
      const fx = await getJson<{ _synthetic: boolean; race_id: string; series: { display_daily?: DisplayDaily } }>(
        `local/demo/${raceId}.mediacloud.json`);
      demoDisplay = fx._synthetic && fx.series.display_daily ? { race: fx.race_id, dd: fx.series.display_daily } : null;
    } catch {
      return null;  // the server only serves the fixture of the race it was started with
    }
  }
  return demoDisplay && demoDisplay.race === raceId ? demoDisplay.dd : null;
}

/** The dashboard chart for one race (SHOW_DETAILS off): both candidates' Kalshi prices, volume and attention (news or Wikipedia, from the
 * Sources control) from series.display_daily, and hourly Kalshi from series.display_hourly when zoomed in. */
async function openChart(ui: Ui, data: RaceData, root: HTMLElement) {
  document.title = `${raceTitle(data)} | ${PROJECT_NAME}`;
  view = null;
  newsView = null;
  root.dataset.race = data.race.race_id;
  const dd = data.series.display_daily;
  if (!dd) {
    chart = null;
    root.innerHTML = `<h2 id="chart-h" class="charttitle">${esc(raceTitle(data))}</h2><p class="note">This race JSON has no
      series.display_daily yet. Run <code>python -m raceattn run --race ${esc(data.race.race_id)}</code> to add it.</p>`;
    writeUrl(ui);
    return;
  }
  const wiki = ui.filters.source === "wikipedia";
  const demo = wiki ? null : await demoNews(ui, data.race.race_id);
  // the Democratic and Republican lines: party and name from the candidates block, columns from the tickers (kalshi_*
  // is the followed market, kalshi_r_* the opposing contract named in display_hourly.opposing)
  const opposing = data.series.display_hourly?.opposing?.ticker ?? dd.opposing?.ticker ?? null;
  const lines = partyLines(data.candidates, data.race.kalshi.followed_market, opposing);
  const series = chartSeries(dd, demo, wiki ? WIKI_COL : NEWS_COL, lines);
  const available = hasData(series.news);
  const e = data.race.election_date;
  const election = [e, new Date(Date.parse(e + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10)]
    .filter((d) => d >= dd.window.start && d <= dd.window.end);
  // hourly Kalshi (series.display_hourly) for ranges of 14 days or fewer; without it the chart stays daily
  const dh = data.series.display_hourly;
  const hourly = dh && dh.rows.length ? hourlySeries(dh, lines) : null;
  const office = data.race.office.charAt(0).toUpperCase() + data.race.office.slice(1);
  const heading = chartTitle(STATES[data.race.state] ?? data.race.state, office, data.race.election_date.slice(0, 4));
  chart = new LineChart(root, { series, lines, title: raceTitle(data), heading, window: { start: dd.window.start, end: dd.window.end },
    election, news: { available }, demo: !!demo, attention: wiki ? "wikipedia" : "news", hourly, electionDate: e },
    chartState);
  chart.render();
  writeUrl(ui);
}

/** Links between the race overview and the News (Media Cloud) view; real links (the URL works on its own), switched
 * in place on click. */
function renderTabs(ui: Ui, nav: HTMLElement) {
  const link = (page: "race" | "news", label: string) => `<li><a href="${esc(queryFor(ui, page))}" data-page="${page}"${
    ui.page === page ? ' aria-current="page"' : ""}>${label}</a></li>`;
  nav.innerHTML = `<ul class="tabs">${link("race", "Overview: Kalshi and attention")}${link("news", "News (Media Cloud)")}</ul>`;
  nav.querySelectorAll<HTMLAnchorElement>("a[data-page]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    ui.page = a.dataset.page as "race" | "news";
    openRace(ui, false).then(() => document.querySelector<HTMLAnchorElement>(`#race-tabs a[data-page="${ui.page}"]`)?.focus());
  }));
}

function syncDateInputs(ui: Ui, data: RaceData) {
  for (const [id, v] of [["f-from", ui.from], ["f-to", ui.to]] as const) {
    const i = document.getElementById(id) as HTMLInputElement;
    i.min = data.window.start;
    i.max = data.window.end;
    i.value = v;
  }
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
}

/** The page footer: the data attribution, the link to the repository, and the funding disclosure when it is on. */
function footer(): HTMLElement {
  return el("footer", { class: "wrap foot" }, `<div class="footin">${footerItems()}${
    SHOW_FUNDING_DISCLOSURE ? `<p class="disclosure">${esc(FUNDING_DISCLOSURE)}</p>` : ""}</div>`);
}

main();
