# Dashboard copy removed (R1)

Removed on 2026-11-16, card t_88761f89, R1 minimal pass. Only text was removed from the dashboard page; the map,
selection, chart and data work as before. Strings are as they were in the source, with template placeholders
shown as written. Line breaks inside the template literals are joined into single spaces here.

## 1. Kicker line (web/src/main.ts, renderShell)

```
${esc(PROJECT_NAME)}: Kalshi market data next to attention data, on one UTC clock
```

The h1 ("2026 races: market prices and attention") and the HTML `<title>` are kept.

## 2. Lede paragraph (web/src/main.ts, renderShell)

```
${Object.keys(index.races).length} races with committed data. Pick a state on the map, in the table or in the list${SHOW_DETAILS ? "" : "; the chart below the map shows that race"}. Every number shows its n; anything with fewer than 20 days or pairs reads "insufficient data". The tool reports timing and association, not causation.
```

## 3. Map caption, #map-caption (web/src/main.ts, renderShell and drawMap)

The `<p id="map-caption">` element and the code in drawMap that filled it:

```
Colored by <strong>${esc(m.label)}</strong>${usesSource ? ` for <strong>${esc(SOURCE_LABEL[source] ?? source)}</strong>${source === "wikipedia" ? " (race page plus candidate pages, summed)" : ""}` : ""}; ${ui.office === "all" ? "all race types" : `${esc(ui.office)} races only`}; ${esc(BANDS[ui.band].toLowerCase())}. Totals and changes cover the non-excluded days of each race's window (election night left out). Bins are equal width over the values shown.${multi.length ? ` A state with more than one race is colored by the open race, else by Senate, then Governor, House, national: ${esc(multi.join("; "))}. The table lists every race.` : ""}
```

The multi-race list it used:

```
${STATES[code]} by ${raceTitle({ race: r })}${code === ui.state ? " (the open race)" : ""}
```

## 4. Map table heading and visible table (web/src/main.ts, renderShell)

Visible heading:

```
The map's values as a table
```

The table was not deleted. `#map-table` keeps the same rows, the same `data-state`, `data-race`, `data-fill` and
`data-k` attributes and the same "Open" buttons, and now sits directly under the map inside
`<div class="vh" id="map-table-wrap">`, the standard visually hidden (sr-only) class in web/src/style.css, as a
text alternative for the colored map. Its accessible name is `aria-label="Map values by state"`. The `tabindex="0"`
scroll region wrapper (`div.table-scroll`, labelled by the removed heading) is gone, and the Open buttons carry
`tabindex="-1"` so hidden buttons take no focus. The table stays in the accessibility tree.

## 5. States without a race, #map-none (web/src/main.ts, renderShell and drawMap)

The `<p id="map-none">` element and the code in drawMap that filled it:

```
${none.length} states (plus DC and Puerto Rico) have no processed race for this race type and are drawn as insufficient data: ${none.join(", ")}.
```

Those states still draw on the map as "no processed race" with the insufficient data hatch.

## 6. Footer copy (web/src/main.ts, footer; web/src/config.ts, SOURCE_NOTES)

From web/src/main.ts:

```
<strong>${esc(PROJECT_NAME)}</strong> (working name). Index updated ${esc(index.updated_at)}.
```

```
${esc(n.name)}: ${esc(n.note)} <a href="${esc(n.url)}" rel="noreferrer">Source terms</a>
```

```
Map geometry: us-atlas 3.0.1 (US Census Bureau cartographic boundaries, ISC license), bundled with the page.
```

```
News counts come from Media Cloud sources only. Queries are still in draft. Timing alone does not show that one thing caused another.
```

(`<p id="news-caveat">`, shown only while SHOW_DETAILS is off.)

```
Only counts and metrics are published, never post text or user data. Code and data licenses are not yet decided.
```

The SOURCE_NOTES texts the list rendered, from web/src/config.ts (SOURCE_NOTES itself is kept there):

- Kalshi: name "Kalshi public market data API"; note "Unauthenticated, read-only candlesticks. Only aggregates are
  published. Kalshi's terms on redistributing derived aggregates were not yet reviewed (docs/sources/kalshi.md).";
  URL https://docs.kalshi.com/getting_started/quick_start_market_data
- Wikimedia: name "Wikimedia Analytics API (pageviews)"; note "Pageview data is CC0 1.0; use of the API is under the
  Wikimedia Terms of Use (docs/sources/wikipedia.md)."; URL
  https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html

The funding disclosure (SHOW_FUNDING_DISCLOSURE) is kept. The footer element is rendered only when it is on;
otherwise the page has no footer.

## Where the removed facts live now

README.md, section "Limitations and sources": Media Cloud sources only, draft queries, the Kalshi and Wikimedia
source terms with their links, and the us-atlas credit. The us-atlas license text is in web/src/geo/LICENSE-us-atlas
and the build copies it to web/dist/LICENSE-us-atlas.
