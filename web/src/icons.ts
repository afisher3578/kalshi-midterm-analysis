// Small inline SVG icons (currentColor, 1.5 px stroke, 20 px), so the buttons need no icon library or extra files.
const svg = (body: string, name: string, size = 20) => `<svg class="icon icon-${name}" width="${size}" height="${size}"
  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true" focusable="false" data-icon="${name}">${body}</svg>`.replace(/\s+/g, " ");

// a funnel, the common "filters" mark
export const FILTER = svg(`<path d="M4 5h16l-6.25 7.5v5.25L10.25 19.5v-7L4 5z"/>`, "filter");
export const INFO = svg(`<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.75" r="0.6"
  fill="currentColor"/>`, "info", 16);

// the theme glyphs of alexfisher.co: plain text, sun U+263C and moon U+263E
export const SUN_GLYPH = "☼";
export const MOON_GLYPH = "☾";

/** The theme button's glyph and label, as on alexfisher.co: the glyph of the current theme (the moon while dark,
 * the sun while light); the label says what a click does. */
export function themeIcon(theme: "light" | "dark"): { icon: "sun" | "moon"; glyph: string; label: string } {
  return theme === "dark" ? { icon: "moon", glyph: MOON_GLYPH, label: "Switch to light theme" }
    : { icon: "sun", glyph: SUN_GLYPH, label: "Switch to dark theme" };
}
