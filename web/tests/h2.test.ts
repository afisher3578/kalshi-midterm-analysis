import { describe, expect, it } from "vitest";
import { DATA_ATTRIBUTION, DATA_SOURCES, REPO_LINK_TEXT, REPO_URL } from "../src/config";
import { footerItems } from "../src/race";

describe("footer data attribution", () => {
  it("reads exactly Data: Kalshi, Media Cloud, Wikimedia.", () => {
    expect(DATA_ATTRIBUTION).toBe("Data: Kalshi, Media Cloud, Wikimedia.");
  });
  it("links each source name to its site", () => {
    expect(DATA_SOURCES.map((s) => `${s.name}|${s.url}`)).toEqual(["Kalshi|https://kalshi.com",
      "Media Cloud|https://www.mediacloud.org", "Wikimedia|https://www.wikimedia.org"]);
  });
  it("footer markup has the attribution and the GitHub link, all four links same tab with rel noopener noreferrer", () => {
    const html = footerItems();
    const links = [...html.matchAll(/<a href="([^"]+)" rel="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[3]}|${m[1]}|${m[2]}`);
    expect(links).toEqual(["Kalshi|https://kalshi.com|noopener noreferrer", "Media Cloud|https://www.mediacloud.org|noopener noreferrer",
      "Wikimedia|https://www.wikimedia.org|noopener noreferrer", `${REPO_LINK_TEXT}|${REPO_URL}|noopener noreferrer`]);
    expect((html.match(/<a /g) ?? []).length).toBe(4);
    expect(html).not.toContain("target=");
    expect(html.replace(/<[^>]+>/g, "")).toBe(`${DATA_ATTRIBUTION}${REPO_LINK_TEXT}`);
    expect(html).toMatch(/<p class="attrib">.*<\/p><p class="repo">.*<\/p>/);
  });
});
