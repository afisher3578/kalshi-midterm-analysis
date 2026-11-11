# Source: GDELT DOC 2.0 (gdelt, optional)

Checked 2026-11-11 (docs and terms; one live probe was rate limited).

- `GET https://api.gdeltproject.org/api/v2/doc/doc?query=...&mode=timelinevolraw&format=json&startdatetime=YYYYMMDDHHMMSS&enddatetime=...`.
  No key. `timelinevolraw` "returns the actual number of distinct articles"
  (https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/).
- Limit: one request per 5 seconds. The probe got HTTP 429 with a plain-text body asking for one request every 5
  seconds. The connector uses 6 s spacing and a single request per race.
- Terms (https://www.gdeltproject.org/about.html): open for any use; redistribution must cite the GDELT Project and
  link to https://www.gdeltproject.org/.
- Not in the default source list. The connector always adds a `degraded` reason ("optional ... never the default
  news series"); with the pilot's gaps it comes out `unusable`.
- UNVERIFIED: the live JSON shape (fixture follows the pilot script: `timeline[0].data[].date/value`; synthetic).
