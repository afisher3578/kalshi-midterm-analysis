// Small inline SVG icons (currentColor, 1.5 px stroke, 20 px), so the buttons need no icon library or extra files.
const svg = (body: string, name: string, size = 20) => `<svg class="icon icon-${name}" width="${size}" height="${size}"
  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true" focusable="false" data-icon="${name}">${body}</svg>`.replace(/\s+/g, " ");

export const SUN = svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4
  M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>`, "sun");
export const MOON = svg(`<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>`, "moon");
export const FILTER = svg(`<path d="M4 7h3M11 7h9M4 12h9M17 12h3M4 17h1M9 17h11"/><circle cx="9" cy="7" r="2"/>
  <circle cx="15" cy="12" r="2"/><circle cx="7" cy="17" r="2"/>`, "filter");
export const INFO = svg(`<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.75" r="0.6"
  fill="currentColor"/>`, "info", 16);

/** The theme button's icon and label: the sun while the dark theme is on (a click switches to light), the moon
 * while the light theme is on. */
export function themeIcon(theme: "light" | "dark"): { icon: "sun" | "moon"; svg: string; label: string } {
  return theme === "dark" ? { icon: "sun", svg: SUN, label: "Switch to light theme" }
    : { icon: "moon", svg: MOON, label: "Switch to dark theme" };
}
