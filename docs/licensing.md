# Licensing and publishing (spec section 12)

## Repository license

The code and documentation are MIT licensed ([LICENSE](../LICENSE)), chosen Nov 17 2026. The data in
`data/processed` is not covered by it; a data license follows once Kalshi's terms are confirmed
([data/README.md](../data/README.md)). `licensing_confirmed` in `config/project.yaml` is about publishing data
counts, not the code license, and stays false.

Status: open. Nothing here is legal advice. Alex decides before anything is published.

## What we publish
- Counts per time bucket and metrics computed from them. Never post text, user names, handles, user ids, dids or
  post uris. Raw API responses stay in the git-ignored `data/raw/` cache; Bluesky's cache holds counts only.

## Open question: may we redistribute aggregate counts?

| Source | What the terms say (as read 2026-11-11) | Open question |
|---|---|---|
| X | Developer Policy (https://docs.x.com/developer-terms/policy) restricts redistribution of X Content; only Post, DM and user IDs may be shared. Under benchmarking it says do not "Calculate aggregate X Post metrics, such as the total number of Posts posted per day". The Developer Agreement defines X Content to include data from the API "and any copies and derivative works thereof". | Whether publishing hourly post counts for a research report is allowed. The policy wording reads against it. Treat as not allowed until confirmed. |
| Reddit | Not built (M4). Official API needs approval; terms not read in this session. | Same question for counts per hour; Arctic Shift dumps have an unresolved terms question. |
| Bluesky | Developer guidelines could not be read (docs pages now render only with JavaScript). robots.txt allows crawling the public API. The ToS says nothing specific about research counts. | Whether publishing counts is fine (likely, since no content is stored), and whether deletions must be reflected in stored counts. |
| Media Cloud | Terms of use allow using, reproducing and distributing "Platform Outputs", which include aggregated data such as "number of media mentions". Attribution recommended. Not for commercial use. | Probably fine; confirm. |
| Guardian | Terms forbid keeping "OP Content" (content and data) longer than 24 hours and require "Powered by The Guardian" on tools based on it; non-commercial only. | Whether a daily `total` is OP Content. If yes, committed counts would break the 24-hour rule. |
| NYT | Terms forbid commercial use and "providing archived or cached data sets containing Content"; attribution required. | Whether hit counts are Content. Probably fine for non-commercial display with attribution; confirm. |
| GDELT | Open for any use; redistribution must cite the GDELT Project and link to gdeltproject.org. | None, if cited. |
| Kalshi | Terms on redistributing derived aggregates not read (see docs/sources/kalshi.md). | Confirm before publishing. |
| Wikipedia | Pageview data is public; article text CC BY-SA. | None for counts. |

## The publish warning
- `config/project.yaml` has `licensing_confirmed: false`. While it is false:
  - `python -m raceattn run` adds a `LICENSING WARNING` line to its log and to `notes` and `licensing.warning` in the
    processed JSON whenever the output contains counts from X, Bluesky, Reddit, Media Cloud, Guardian, NYT or
    GDELT.
  - `python -m raceattn publish` lists every processed race with such counts, prints the warning and exits 1.
    It uploads or sends nothing; it is a check to run before Alex copies files anywhere.
- Set `licensing_confirmed: true` only after the questions above are answered for every source in the output.

## Dependencies

Licenses of the direct dependencies, read from installed package metadata on Nov 17 2026. All are compatible with
MIT. Only the npm runtime dependencies end up in the dashboard build; the rest are dev tools or Python packages that
are installed, not bundled.

| Package | Version | License | Where |
|---|---|---|---|
| @observablehq/plot | 0.6.19 | ISC | npm, bundled |
| d3 | 7.9.2 | ISC | npm, bundled |
| topojson-client | 3.1.0 | ISC | npm, bundled |
| us-atlas | 3.0.1 | ISC | npm, map shapes shipped with notice in `web/src/geo/LICENSE-us-atlas` |
| @axe-core/playwright | 4.14.0 | MPL-2.0 | npm dev |
| @types/d3 | 7.4.3 | MIT | npm dev |
| @types/node | 22.20.5 | MIT | npm dev |
| @types/topojson-client | 3.1.5 | MIT | npm dev |
| lighthouse | 13.6.0 | Apache-2.0 | npm dev |
| playwright | 1.65.0 | Apache-2.0 | npm dev |
| typescript | 7.0.2 | Apache-2.0 | npm dev |
| vite | 8.3.8 | MIT | npm dev |
| vitest | 5.1.0 | MIT | npm dev |
| certifi | 2026.10.23 | MPL-2.0 | Python, dependency (not bundled) |
| charset-normalizer | 3.5.2 | MIT | Python |
| idna | 3.20 | BSD-3-Clause | Python |
| PyYAML | 6.0.3 | MIT | Python |
| requests | 2.34.2 | Apache-2.0 | Python |
| urllib3 | 2.8.0 | MIT | Python |

Nothing is outside MIT, BSD, ISC, Apache-2.0 or MPL-2.0. The us-atlas notice must stay in `web/src/geo/`.

## Funding disclosure
- The grant requires this line in the published deliverable: "This research was funded in part by a grant from
  Kalshi Inc. under the Kalshi Midterm Election Research Grant Program. Kalshi did not direct, review, or approve the
  research or its conclusions."
- It lives in `config/project.yaml` (`funding_disclosure_text`) behind `funding_disclosure_enabled: false`. The
  publish step prints the flag state. The dashboard (M1) has its own flag in `web/src/config.ts`; both must be switched on when the
  grant is awarded.
