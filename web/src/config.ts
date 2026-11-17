// Site-wide constants. PROJECT_NAME is the working title (spec section 15); change it here only.
export const PROJECT_NAME = "kalshi-midterm-analysis";
export const DEFAULT_RACE = "tx-senate-2026";

// Kalshi grant funding disclosure (spec section 12). Off until the grant is awarded.
// Turn on at build time with VITE_FUNDING_DISCLOSURE=on npm run build.
export const SHOW_FUNDING_DISCLOSURE = import.meta.env.VITE_FUNDING_DISCLOSURE === "on";
export const FUNDING_DISCLOSURE =
  "This research was funded in part by a grant from Kalshi Inc. under the Kalshi Midterm Election Research " +
  "Grant Program. Kalshi did not direct, review, or approve the research or its conclusions.";

export const MIN_PAIRS = 20;

// Attention sources from the spec catalog (section 6) and the keys they need (section 11).
// `needs` says which race config field makes the source apply to a race. Ids match the --sources names used by
// raceattn/connectors. `built: false` marks connectors that do not exist yet (reddit, youtube: M4).
export interface CatalogSource {
  id: string;
  label: string;
  channel: string;
  needs: "entities" | "news_query" | "subreddits";
  env: string[];
  envNote?: string;
  milestone: string;
  built?: boolean;
}

export const SOURCE_CATALOG: CatalogSource[] = [
  { id: "x", label: "X (Twitter) post counts", channel: "talking", needs: "entities", env: ["X_BEARER_TOKEN"],
    milestone: "M2" },
  { id: "bluesky", label: "Bluesky post counts", channel: "talking", needs: "entities",
    env: ["BSKY_HANDLE", "BSKY_APP_PASSWORD"], envNote: "optional, search may work without a session", milestone: "M2" },
  { id: "news_mediacloud", label: "Media Cloud story counts", channel: "reporting", needs: "news_query",
    env: ["MEDIACLOUD_API_KEY"], milestone: "M2" },
  { id: "news_guardian", label: "Guardian article counts", channel: "reporting", needs: "news_query",
    env: ["GUARDIAN_API_KEY"], milestone: "M2" },
  { id: "news_nyt", label: "New York Times article counts", channel: "reporting", needs: "news_query",
    env: ["NYT_API_KEY"], milestone: "M2" },
  { id: "news_manual", label: "News counts from a manual CSV", channel: "reporting", needs: "news_query", env: [],
    envNote: "needs a date,count export at data/raw/news_manual/<race_id>.csv", milestone: "M2" },
  { id: "gdelt", label: "GDELT DOC article counts", channel: "reporting", needs: "news_query", env: [],
    milestone: "M4" },
  { id: "reddit", label: "Reddit post counts", channel: "talking", needs: "subreddits",
    env: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"], milestone: "M4", built: false },
  { id: "youtube", label: "YouTube video counts", channel: "video", needs: "entities", env: ["YOUTUBE_API_KEY"],
    milestone: "M4", built: false },
];

// Licensing notes, as recorded in docs/sources/*.md.
export const SOURCE_NOTES: Record<string, { name: string; note: string; url: string }> = {
  kalshi: {
    name: "Kalshi public market data API",
    note: "Unauthenticated, read-only candlesticks. Only aggregates are published. Kalshi's terms on " +
      "redistributing derived aggregates were not yet reviewed (docs/sources/kalshi.md).",
    url: "https://docs.kalshi.com/getting_started/quick_start_market_data",
  },
  wikipedia: {
    name: "Wikimedia Analytics API (pageviews)",
    note: "Pageview data is CC0 1.0; use of the API is under the Wikimedia Terms of Use (docs/sources/wikipedia.md).",
    url: "https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html",
  },
};

export const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  PR: "Puerto Rico", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// The race detail views (race page charts, lag tables, drawers, the News (Media Cloud) view, breakdowns, top
// sources, quality tables and downloads). Off: the page is the map plus one line chart. Turn on to bring them back.
export const SHOW_DETAILS = false;

// Page title block and the map heading.
export const TITLE = "2026 U.S. Midterms";
export const SUBTITLE = "Kalshi results and media attention";
export const MAP_TITLE = "Kalshi volume by state and media attention";
// The info button next to "media attention" in the map heading shows this sentence.
export const MEDIA_ATTENTION_DEF =
  "Media attention is how often the race appears in the news each day, counted as stories that mention the candidates or race.";
// The line above the chart. {state} is the state name, {office} the office ("Senate"), {year} the election year.
export const CHART_TITLE = "{state} {office} Race {year}: Kalshi price, Kalshi volume and media attention";
export function chartTitle(state: string, office: string, year: string): string {
  return CHART_TITLE.replace("{state}", state).replace("{office}", office).replace("{year}", year);
}

// The page footer: the data attribution (each source name a link) and one link to the code and data.
export const DATA_ATTRIBUTION = "Data: Kalshi, Media Cloud, Wikimedia.";
export const DATA_SOURCES: readonly { name: string; url: string }[] = [
  { name: "Kalshi", url: "https://kalshi.com" },
  { name: "Media Cloud", url: "https://www.mediacloud.org" },
  { name: "Wikimedia", url: "https://www.wikimedia.org" },
];
export const REPO_URL = "https://github.com/afisher3578/kalshi-midterm-analysis";
export const REPO_LINK_TEXT = "Code and data on GitHub";
