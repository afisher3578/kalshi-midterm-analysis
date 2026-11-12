---
tags: [kalshi-grant, media-cloud, search-criteria, method]
created: 2026-11-11
related:
  - "kalshi-research-discovery-brief (Alex's notes, not in the repo)"
  - "attention-data-sources-and-prior-studies (Alex's notes, not in the repo)"
  - "race-attention-tool-spec: docs/spec.md (repo copy)"
note: "Repo copy of Alex's approved note. The tool's implementation is described in docs/mc1-notes.md."
---

# Media Cloud search criteria: Texas Senate (Talarico vs Paxton), first test

Scope: the reporting channel only (news). Media Cloud is the single source for this test. The criteria follow content-analysis practice (Lacy, Watson, Riffe and Lovejoy 2015, Journalism & Mass Communication Quarterly 92(4): sampling frame stated, reliability reported with at least two coefficients) and the way Media Cloud was used in Faris et al. 2017 (candidate-name queries inside fixed outlet collections). Query syntax checked against Media Cloud's query guide (https://www.mediacloud.org/documentation/query-guide) on Nov 11 2026.

## 1. Construct

Reporting attention to the race = number of English-language online news stories per UTC day in a fixed set of outlets that mention the race. The unit is a story, not a reader. The tool claims things about this proxy only.

## 2. Universe and sampling frame (state this in the paper)

- Universe: online news stories in the Media Cloud archive.
- Frame: two collections, run separately and never silently merged.
  - US national: "United States - National", id 34412234 (the id used in the Media Cloud client's tests; confirm name and id with the key).
  - Texas state and local: look up the Texas state-and-local collection with the collections search once the key works. Record its name, id, number of sources and the lookup date. If none exists, say so and use outlet-domain filters for a short Texas panel instead.
- Media Cloud's source list is the frame, so outlets it does not crawl are out, and paywalled content is thin. This is a limitation, not something to fix.
- Counting the full frame (a census of the frame), not a sample. Samples are used only for the audit (section 6).

## 3. Dates (relative to election day E = Nov 3, 2026)

| Phase | Dates (UTC) | Use |
|---|---|---|
| Tuning | Aug 1 to Aug 24 | Develop and test queries and read samples. No prices |
| Baseline | Aug 25 to Aug 31 | First 7-day baseline for surprise scores |
| Analysis | Sept 1 to Nov 2 | Main tests |
| Election | Nov 3 to Nov 4 | Shown, excluded from main tests |

Record which timezone Media Cloud uses for the publish date and say so in the output. Stories are dated by publish date as Media Cloud records it.

## 4. Query logic

Rules from the query guide: AND, OR and NOT must be capitalized; terms side by side are ANDed; exact phrase in double quotes; `-` or NOT for negation; `article_title:` searches titles only; `"a b"~10` is proximity; `language:en` restricts language; no regular expressions. The dev must confirm each form against the live API, keep the logic below, and adapt syntax if needed.

Each candidate has two versions, because Paxton is also the state's attorney general and much of that coverage is not about the race:

- Race-context (main series): the name together with a race-context term.
- Any-mention (sensitivity series): the name alone, with false-match exclusions.

Race-context terms: `Senate OR "U.S. Senate" OR "Senate race" OR campaign OR election OR candidate OR nominee OR runoff OR poll OR polls OR debate OR Cornyn`, plus the opponent's surname.

Draft queries (all end with `AND language:en`):

| Series | Query |
|---|---|
| talarico_race | `("James Talarico" OR Talarico) AND (Senate OR "U.S. Senate" OR "Senate race" OR campaign OR election OR candidate OR nominee OR poll OR polls OR debate OR Paxton)` |
| paxton_race | `("Ken Paxton" OR "Kenneth Paxton" OR Paxton) AND (Senate OR "U.S. Senate" OR "Senate race" OR campaign OR election OR candidate OR nominee OR runoff OR poll OR polls OR debate OR Cornyn OR Talarico) NOT "Bill Paxton"` |
| race_either | talarico_race OR paxton_race |
| race_both | stories matching both talarico_race and paxton_race (head-to-head coverage) |
| talarico_any | `("James Talarico" OR Talarico)` |
| paxton_any | `("Ken Paxton" OR "Kenneth Paxton" OR Paxton) NOT "Bill Paxton"` |
| headline_either | `article_title:(Talarico OR "Ken Paxton" OR Paxton) AND (Senate OR Talarico OR Paxton OR campaign OR poll)` (headline prominence; check the grammar of the title field on the live API) |

Bare "Paxton" is accepted only with a context term in the main series. Add exclusions only after at least three false matches are seen in a tuning sample, and log each one. Cornyn and Crockett are context terms, not entities.

Derived series (computed by the tool):
- Talarico share = talarico_race / (talarico_race + paxton_race), per day (mention share; stories mentioning both count in both). Also an exclusive version (only-Talarico vs only-Paxton).
- Core vs broad ratio = race_either / (talarico_any + paxton_any union), to show how much the query choice matters.

## 5. Normalization and breadth

- Store the raw daily story count and Media Cloud's normalized ratio (matching stories divided by all stories in the collection that day) with the total count, so a change in how many stories Media Cloud ingests does not look like a change in attention.
- Breadth: distinct sources per day, if the API gives per-source counts over time. If not, skip it and say so.
- Top sources over the analysis window (a bar chart for the dashboard), if the API supports it.
- Syndication: Media Cloud may or may not collapse wire copy. Estimate the duplicate rate in the audit sample (same normalized title on several domains) and report it. Do not dedupe silently.

## 6. Validation (what the audit sample is for)

1. Tuning audit (Aug 1 to 24): pull 100 random stories per core query per collection, read them, mark relevant, not relevant or unclear (and for Paxton, race, attorney-general office, or other). Compute precision. If a core query is below 90%, revise on this period only and redraw. Then freeze.
2. Final audit (Sept 1 to Nov 2, after the freeze): 100 random stories per core query per collection. Report precision with a Wilson 95% interval.
3. Reliability: a second coder codes a representative subsample. Lacy et al. advise against a fixed percentage of the population; set the size from a reliability-sample calculation and report why. Report at least two coefficients: simple agreement and Krippendorff's alpha. Target above 0.8; drop any coded variable below 0.7 (Lacy et al. 2015). This replaces the earlier "second coder on 15 to 20% with Cohen's kappa" line in the brief.
4. Recall: compare core against broad (section 4). Optional known-item check: news URLs cited on the race's Wikipedia page that fall in the window; see how many Media Cloud has.
5. Known-spike test and top-days review: list the ten largest days with their story headlines, read them, confirm they concern the race.
6. Local only: the audit sample (title, source, date, URL, coding columns) is a git-ignored file. Published output contains counts and metrics only, no story text.

## 7. Quality gate

At least 95% of days present for the analysis window; no stretch of two or more near-zero days where neighbors are normal; zero counts that Media Cloud returns explicitly are real zeros, missing dates are missing. A series that fails is marked degraded or unusable and kept out of the metrics, as in the existing quality module.

## 8. Freeze and record

Query strings, collection ids and names, lookup dates, API version, timezone note and the query hash go into the config file and into every output. Any change after the freeze is logged with the reason and date, and creates a new version.

## 9. Config shape (`config/queries/tx-senate-2026.mediacloud.yaml`)

```yaml
version: 1
status: draft            # draft | tuned | frozen
frozen_on: null
language: en
collections:
  national: {name: "United States - National", id: 34412234}
  texas_local: {name: null, id: null}      # fill from the collections lookup
phases:
  tuning:   {start: 2026-08-01, end: 2026-08-24}
  baseline: {start: 2026-08-25, end: 2026-08-31}
  analysis: {start: 2026-09-01, end: 2026-11-02}
  election: {start: 2026-11-03, end: 2026-11-04}
queries:
  talarico_race: '...'     # as in section 4
  paxton_race: '...'
  race_either: '...'
  race_both: '...'
  talarico_any: '...'
  paxton_any: '...'
  headline_either: '...'
exclusions_log: []        # each added exclusion: term, date, the false matches seen
audit:
  per_query_per_collection: 100
  precision_target: 0.90
  reliability_targets: {agreement: report, krippendorff_alpha: 0.80, drop_below: 0.70}
```

## 10. Request budget

Default quota is 4,000 requests a week; some endpoints allow 2 requests a minute (https://www.mediacloud.org/documentation/faqs). Seven queries across two collections is about 14 count requests per run, plus story-listing pages for the audit samples. Cache every response and pace requests.

## 11. Not verified

The collection id and name behind 34412234; whether a Texas state-and-local collection exists and its id; the exact grammar for title searches on the live API; whether per-source daily counts and a normalized ratio are available from the search API; the publish-date timezone. All need the API key.
