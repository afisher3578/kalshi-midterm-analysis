# Dashboard style: tokens and contrast (R2)

The dashboard uses the alexfisher.co tokens (Flexoki base scale). All colors are CSS variables at the top of
`web/src/style.css`; the TypeScript only names them (`var(--series-dem)` and so on).

## Tokens

| token | light | dark | use |
|---|---|---|---|
| --bg | #FFFCF0 | #100F0F | page |
| --fg | #100F0F | #CECDC3 | text, focus ring, selected state outline |
| --muted | #6F6E69 | #878580 | labels, axis text, legend, off toggles |
| --faint | #B7B5AC | #575653 | no-data hatch, off swatches (not text) |
| --rule | #E6E4D9 | #343331 | hairlines, gridlines, election band |
| --link | #100F0F | #CECDC3 | links |
| --series-dem | #205EA6 (blue-600) | #4385BE (blue-400) | Democratic candidate line and end of line label |
| --series-rep | #AF3029 (red-600) | #E8705F (red-300) | Republican candidate line and end of line label |
| --series-volume | #5E409D (purple-600) | #8B7EC8 (purple-400) | Kalshi volume line |
| --series-news | #66800B (green-600) | #879A39 (green-400) | media attention line |
| --map-1 to --map-5 | #DAD8CE, #B7B5AC, #6F6E69, #403E3C, #1C1B1A | #343331, #575653, #878580, #B7B5AC, #CECDC3 | map ramp, low to high |
| --map-faded | #878580 | #6F6E69 | faded (coming soon) states and the legend's coming soon swatch, solid, no opacity |
| --map-edge | #575653 | #9F9D96 | state borders and legend swatch borders |

The `--cat-1` to `--cat-7` variables (Flexoki hues) color the hidden detail views only.

## Contrast

Output of `cd web && npm run contrast` (web/scripts/contrast.mjs). It exits 1 if text is under 4.5:1, or a series
line or the selected outline is under 3:1, against --bg. The two candidate colors also color label text, so they
must reach 4.5:1 (the dark red is red-300 for that: red-400 is 4.42:1). Map rows give the label color against the bin fill.
The faded state fill (--map-faded) and the state borders (--map-edge) must reach 3:1 against --bg (WCAG 1.4.11), so the
coming soon states show on the cream page; the faded fill must also stay 2:1 or more from the lowest bin and from the top
bin (the selected Texas), a project rule so a faded state never reads as a value. The bin fills against --bg are report
only: the light bins sit close to the page by design, and the on-map label carries the value.

### Light theme (bg #FFFCF0)

| token | value | use | ratio vs bg | needs | result |
|---|---|---|---|---|---|
| --fg | #100F0F | text | 18.62:1 | 4.5:1 | pass |
| --muted | #6F6E69 | secondary text, axis text, legend | 4.97:1 | 4.5:1 | pass |
| --link | #100F0F | links | 18.62:1 | 4.5:1 | pass |
| --faint | #B7B5AC | swatch borders, off swatches (not text) | 2.00:1 | report only | n/a |
| --rule | #E6E4D9 | hairlines, gridlines (not text) | 1.24:1 | report only | n/a |
| --series-dem | #205EA6 | Democratic candidate line | 6.36:1 | 3:1 | pass |
| --series-rep | #AF3029 | Republican candidate line | 6.23:1 | 3:1 | pass |
| --series-dem | #205EA6 | Democratic end of line label text | 6.36:1 | 4.5:1 | pass |
| --series-rep | #AF3029 | Republican end of line label text | 6.23:1 | 4.5:1 | pass |
| --series-volume | #5E409D | Kalshi volume line | 7.58:1 | 3:1 | pass |
| --series-news | #66800B | media attention line | 4.39:1 | 3:1 | pass |
| --map-faded | #878580 | map fill of faded (coming soon) states, legend swatch | 3.59:1 | 3:1 | pass |
| --map-edge | #575653 | map state borders, legend swatch borders | 7.14:1 | 3:1 | pass |
| --map-1 | #DAD8CE | map bin 1 fill (value also in the label) | 1.39:1 | report only | n/a |
| --map-2 | #B7B5AC | map bin 2 fill (value also in the label) | 2.00:1 | report only | n/a |
| --map-3 | #6F6E69 | map bin 3 fill (value also in the label) | 4.97:1 | report only | n/a |
| --map-4 | #403E3C | map bin 4 fill (value also in the label) | 10.36:1 | report only | n/a |
| --map-5 | #1C1B1A | map bin 5 fill (value also in the label) | 16.73:1 | report only | n/a |
| --fg | #100F0F | map selected-state outline | 18.62:1 | 3:1 | pass |
| --map-1 | #DAD8CE | map fill, label in --fg | 13.39:1 (label vs fill) | 4.5:1 | pass |
| --map-2 | #B7B5AC | map fill, label in --fg | 9.31:1 (label vs fill) | 4.5:1 | pass |
| --map-3 | #6F6E69 | map fill, label in --bg | 4.97:1 (label vs fill) | 4.5:1 | pass |
| --map-4 | #403E3C | map fill, label in --bg | 10.36:1 (label vs fill) | 4.5:1 | pass |
| --map-5 | #1C1B1A | map fill, label in --bg | 16.73:1 (label vs fill) | 4.5:1 | pass |
| --map-faded | #878580 | faded fill vs lowest bin (--map-1 #DAD8CE) | 2.58:1 (vs --map-1) | 2:1 | pass |
| --map-faded | #878580 | faded fill vs top bin (selected Texas) (--map-5 #1C1B1A) | 4.67:1 (vs --map-5) | 2:1 | pass |
| --map-edge | #575653 | borders vs faded fill (--map-faded #878580) | 1.99:1 (vs --map-faded) | report only | n/a |

### Dark theme (bg #100F0F)

| token | value | use | ratio vs bg | needs | result |
|---|---|---|---|---|---|
| --fg | #CECDC3 | text | 11.98:1 | 4.5:1 | pass |
| --muted | #878580 | secondary text, axis text, legend | 5.19:1 | 4.5:1 | pass |
| --link | #CECDC3 | links | 11.98:1 | 4.5:1 | pass |
| --faint | #575653 | swatch borders, off swatches (not text) | 2.61:1 | report only | n/a |
| --rule | #343331 | hairlines, gridlines (not text) | 1.52:1 | report only | n/a |
| --series-dem | #4385BE | Democratic candidate line | 4.86:1 | 3:1 | pass |
| --series-rep | #E8705F | Republican candidate line | 6.30:1 | 3:1 | pass |
| --series-dem | #4385BE | Democratic end of line label text | 4.86:1 | 4.5:1 | pass |
| --series-rep | #E8705F | Republican end of line label text | 6.30:1 | 4.5:1 | pass |
| --series-volume | #8B7EC8 | Kalshi volume line | 5.39:1 | 3:1 | pass |
| --series-news | #879A39 | media attention line | 6.12:1 | 3:1 | pass |
| --map-faded | #6F6E69 | map fill of faded (coming soon) states, legend swatch | 3.75:1 | 3:1 | pass |
| --map-edge | #9F9D96 | map state borders, legend swatch borders | 7.05:1 | 3:1 | pass |
| --map-1 | #343331 | map bin 1 fill (value also in the label) | 1.52:1 | report only | n/a |
| --map-2 | #575653 | map bin 2 fill (value also in the label) | 2.61:1 | report only | n/a |
| --map-3 | #878580 | map bin 3 fill (value also in the label) | 5.19:1 | report only | n/a |
| --map-4 | #B7B5AC | map bin 4 fill (value also in the label) | 9.31:1 | report only | n/a |
| --map-5 | #CECDC3 | map bin 5 fill (value also in the label) | 11.98:1 | report only | n/a |
| --fg | #CECDC3 | map selected-state outline | 11.98:1 | 3:1 | pass |
| --map-1 | #343331 | map fill, label in --fg | 7.90:1 (label vs fill) | 4.5:1 | pass |
| --map-2 | #575653 | map fill, label in --fg | 4.59:1 (label vs fill) | 4.5:1 | pass |
| --map-3 | #878580 | map fill, label in --bg | 5.19:1 (label vs fill) | 4.5:1 | pass |
| --map-4 | #B7B5AC | map fill, label in --bg | 9.31:1 (label vs fill) | 4.5:1 | pass |
| --map-5 | #CECDC3 | map fill, label in --bg | 11.98:1 (label vs fill) | 4.5:1 | pass |
| --map-faded | #6F6E69 | faded fill vs lowest bin (--map-1 #343331) | 2.47:1 (vs --map-1) | 2:1 | pass |
| --map-faded | #6F6E69 | faded fill vs top bin (selected Texas) (--map-5 #CECDC3) | 3.20:1 (vs --map-5) | 2:1 | pass |
| --map-edge | #9F9D96 | borders vs faded fill (--map-faded #6F6E69) | 1.88:1 (vs --map-faded) | report only | n/a |

## Theme switching

An inline script in the `<head>` of `web/index.html` sets `data-theme` on `<html>` before first paint. It uses
`localStorage.theme` if one is saved, else `prefers-color-scheme`. The theme button in the header (as on alexfisher.co: a
text glyph for the current theme, sun U+263C in light and moon U+263E in dark, aria-pressed) flips it and saves the
choice. The map and chart use CSS variables only, so they recolor without a redraw.
