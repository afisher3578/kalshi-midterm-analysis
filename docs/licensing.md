# Licensing and publishing (spec section 12)

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

## Funding disclosure
- The grant requires this line in the published deliverable: "This research was funded in part by a grant from
  Kalshi Inc. under the Kalshi Midterm Election Research Grant Program. Kalshi did not direct, review, or approve the
  research or its conclusions."
- It lives in `config/project.yaml` (`funding_disclosure_text`) behind `funding_disclosure_enabled: false`. The
  publish step prints the flag state. The dashboard (M1) has its own flag in `web/src/config.ts`; both must be switched on when the
  grant is awarded.
