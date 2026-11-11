# Source: manual news CSV (news_manual)

No API and no key. For when a user exports daily counts from a tool they have access to (for example a Media Cloud
web export).

- File: `data/raw/news_manual/<race_id>.csv` (git-ignored, like all raw data). Header `date,count`; one row per UTC
  day; `date` as YYYY-MM-DD; `count` a non-negative whole number.
- Validation stops with a clear error on: wrong header, bad date, bad or negative or fractional count, duplicate
  date. Rows outside the window are ignored and counted (`rows_outside_window_ignored` in quality).
- Missing days stay missing and the quality check reports them. Nothing is interpolated.
- If the file is missing the connector is skipped with the reason and the expected path.
- Series `news_manual/story_count`. The query hash is the sha256 of the file contents (first 16 characters), so a
  changed file changes the hash.
- Terms: whatever the export's source allows. The user is responsible; note the source in the race's notes.
