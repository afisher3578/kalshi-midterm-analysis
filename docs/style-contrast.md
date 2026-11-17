# Dashboard style: tokens and contrast (R2)

The dashboard uses the alexfisher.co tokens (Flexoki base scale). All colors are CSS variables at the top of
`web/src/style.css`; the TypeScript only names them (`var(--series-price)` and so on).

## Tokens

| token | light | dark | use |
|---|---|---|---|
| --bg | #FFFCF0 | #100F0F | page |
| --fg | #100F0F | #CECDC3 | text, focus ring, selected state outline |
| --muted | #6F6E69 | #878580 | labels, axis text, legend, off toggles |
| --faint | #B7B5AC | #575653 | no-data hatch, off swatches (not text) |
| --rule | #E6E4D9 | #343331 | hairlines, gridlines, election band |
| --link | #100F0F | #CECDC3 | links |
| --series-price | #205EA6 (blue-600) | #4385BE (blue-400) | Kalshi price line |
| --series-volume | #AF3029 (red-600) | #D14D41 (red-400) | Kalshi volume line |
| --series-news | #66800B (green-600) | #879A39 (green-400) | media attention line |
| --map-1 to --map-5 | #DAD8CE, #B7B5AC, #6F6E69, #403E3C, #1C1B1A | #343331, #575653, #878580, #B7B5AC, #CECDC3 | map ramp, low to high |

The `--cat-1` to `--cat-7` variables (Flexoki hues) color the hidden detail views only.

## Contrast

Output of `cd web && npm run contrast` (web/scripts/contrast.mjs). It exits 1 if text is under 4.5:1, or a series
line or the selected outline is under 3:1, against --bg. Map rows give the label color against the bin fill.

### Light theme (bg #FFFCF0)

| token | value | use | ratio vs bg | needs | result |
|---|---|---|---|---|---|
| --fg | #100F0F | text | 18.62:1 | 4.5:1 | pass |
| --muted | #6F6E69 | secondary text, axis text, legend | 4.97:1 | 4.5:1 | pass |
| --link | #100F0F | links | 18.62:1 | 4.5:1 | pass |
| --faint | #B7B5AC | no-data hatch, off swatches (not text) | 2.00:1 | report only | n/a |
| --rule | #E6E4D9 | hairlines, gridlines (not text) | 1.24:1 | report only | n/a |
| --series-price | #205EA6 | Kalshi price line | 6.36:1 | 3:1 | pass |
| --series-volume | #AF3029 | Kalshi volume line | 6.23:1 | 3:1 | pass |
| --series-news | #66800B | media attention line | 4.39:1 | 3:1 | pass |
| --fg | #100F0F | map selected-state outline | 18.62:1 | 3:1 | pass |
| --map-1 | #DAD8CE | map fill, label in --fg | 13.39:1 (label vs fill) | 4.5:1 | pass |
| --map-2 | #B7B5AC | map fill, label in --fg | 9.31:1 (label vs fill) | 4.5:1 | pass |
| --map-3 | #6F6E69 | map fill, label in --bg | 4.97:1 (label vs fill) | 4.5:1 | pass |
| --map-4 | #403E3C | map fill, label in --bg | 10.36:1 (label vs fill) | 4.5:1 | pass |
| --map-5 | #1C1B1A | map fill, label in --bg | 16.73:1 (label vs fill) | 4.5:1 | pass |

### Dark theme (bg #100F0F)

| token | value | use | ratio vs bg | needs | result |
|---|---|---|---|---|---|
| --fg | #CECDC3 | text | 11.98:1 | 4.5:1 | pass |
| --muted | #878580 | secondary text, axis text, legend | 5.19:1 | 4.5:1 | pass |
| --link | #CECDC3 | links | 11.98:1 | 4.5:1 | pass |
| --faint | #575653 | no-data hatch, off swatches (not text) | 2.61:1 | report only | n/a |
| --rule | #343331 | hairlines, gridlines (not text) | 1.52:1 | report only | n/a |
| --series-price | #4385BE | Kalshi price line | 4.86:1 | 3:1 | pass |
| --series-volume | #D14D41 | Kalshi volume line | 4.42:1 | 3:1 | pass |
| --series-news | #879A39 | media attention line | 6.12:1 | 3:1 | pass |
| --fg | #CECDC3 | map selected-state outline | 11.98:1 | 3:1 | pass |
| --map-1 | #343331 | map fill, label in --fg | 7.90:1 (label vs fill) | 4.5:1 | pass |
| --map-2 | #575653 | map fill, label in --fg | 4.59:1 (label vs fill) | 4.5:1 | pass |
| --map-3 | #878580 | map fill, label in --bg | 5.19:1 (label vs fill) | 4.5:1 | pass |
| --map-4 | #B7B5AC | map fill, label in --bg | 9.31:1 (label vs fill) | 4.5:1 | pass |
| --map-5 | #CECDC3 | map fill, label in --bg | 11.98:1 (label vs fill) | 4.5:1 | pass |

## Theme switching

An inline script in the `<head>` of `web/index.html` sets `data-theme` on `<html>` before first paint. It uses
`localStorage.theme` if one is saved, else `prefers-color-scheme`. The "Dark" button in the header (aria-pressed)
flips it and saves the choice. The map and chart use CSS variables only, so they recolor without a redraw.
