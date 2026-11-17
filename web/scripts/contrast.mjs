// WCAG 2 contrast check for the color tokens in web/src/style.css (the :root block is the light theme, the
// [data-theme="dark"] block the dark theme). Prints a Markdown table per theme. Exits 1 if fg, muted or link is
// under 4.5:1, or any series color or the map selected outline (fg) is under 3:1, against bg. The candidate colors
// (series-dem, series-rep) also color the end of line label text (surname and percent), so they need 4.5:1. faint and rule are
// report only: they are never used for essential text. Also checks the map labels on each ramp bin (4.5:1), the
// faded coming soon fill (map-faded) and the state borders (map-edge) against bg (3:1, WCAG 1.4.11), reports each bin
// against bg, and asks the faded fill to stay 2:1 or more from the lowest bin and the top bin (a project rule, so a
// faded state never reads as a value).
// Usage: node scripts/contrast.mjs   (or npm run contrast)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(import.meta.dirname, "../src/style.css"), "utf-8");

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in style.css`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toUpperCase()]));
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const themes = { light: block(":root"), dark: { ...block(":root"), ...block('[data-theme="dark"]') } };
// [token, what it is for, minimum ratio or null for report only]
const CHECKS = [
  ["fg", "text", 4.5],
  ["muted", "secondary text, axis text, legend", 4.5],
  ["link", "links", 4.5],
  ["faint", "swatch borders, off swatches (not text)", null],
  ["rule", "hairlines, gridlines (not text)", null],
  ["series-dem", "Democratic candidate line", 3],
  ["series-rep", "Republican candidate line", 3],
  ["series-dem", "Democratic end of line label text", 4.5],
  ["series-rep", "Republican end of line label text", 4.5],
  ["series-volume", "Kalshi volume line", 3],
  ["series-news", "media attention line", 3],
  ["map-faded", "map fill of faded (coming soon) states, legend swatch", 3],
  ["map-edge", "map state borders, legend swatch borders", 3],
  ...[1, 2, 3, 4, 5].map((i) => [`map-${i}`, `map bin ${i} fill (value also in the label)`, null]),
];

let failed = false;
const out = [];
for (const [name, t] of Object.entries(themes)) {
  out.push(`### ${name[0].toUpperCase() + name.slice(1)} theme (bg ${t.bg})`, "",
    "| token | value | use | ratio vs bg | needs | result |", "|---|---|---|---|---|---|");
  for (const [tok, use, min] of [...CHECKS, ["fg", "map selected-state outline", 3]]) {
    const r = ratio(t[tok], t.bg);
    const ok = min === null || r >= min;
    if (!ok) failed = true;
    out.push(`| --${tok} | ${t[tok]} | ${use} | ${r.toFixed(2)}:1 | ${min === null ? "report only" : `${min}:1`} | ${
      min === null ? "n/a" : ok ? "pass" : "FAIL"} |`);
  }
  // map labels: bins 1 and 2 use --fg, bins 3 to 5 use --bg (web/src/map.ts)
  for (let i = 1; i <= 5; i++) {
    const ink = i <= 2 ? "fg" : "bg";
    const r = ratio(t[`map-${i}`], t[ink]);
    if (r < 4.5) failed = true;
    out.push(`| --map-${i} | ${t[`map-${i}`]} | map fill, label in --${ink} | ${r.toFixed(2)}:1 (label vs fill) | 4.5:1 | ${
      r >= 4.5 ? "pass" : "FAIL"} |`);
  }
  // the faded fill against the lowest and top bins and the borders (2:1, project rule; report for the borders)
  for (const [a, b, use, min] of [["map-faded", "map-1", "faded fill vs lowest bin", 2], ["map-faded", "map-5",
    "faded fill vs top bin (selected Texas)", 2], ["map-edge", "map-faded", "borders vs faded fill", null]]) {
    const r = ratio(t[a], t[b]);
    const ok = min === null || r >= min;
    if (!ok) failed = true;
    out.push(`| --${a} | ${t[a]} | ${use} (--${b} ${t[b]}) | ${r.toFixed(2)}:1 (vs --${b}) | ${min === null ? "report only"
      : `${min}:1`} | ${min === null ? "n/a" : ok ? "pass" : "FAIL"} |`);
  }
  out.push("");
}
console.log(out.join("\n"));
console.log(failed ? "CONTRAST FAILED" : "CONTRAST OK");
process.exit(failed ? 1 : 0);
