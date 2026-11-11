"""Event list generator (spec section 7): `python -m raceattn events --race <id>`.

Reads the race's Wikipedia page (the first entry of `wikipedia_pages`) through the MediaWiki API at a fixed
revision, and proposes:
- poll release dates from the polling tables (one row per poll, deduped across tables),
- debates, from tables in sections whose title contains "Debate" that have a Date column,
- filing deadlines, only where the prose says "filing deadline ... <date>".
Every row gets status `needs_review` and cites the revision URL. Nothing is invented: a row is written only when
a date was parsed from the page, and rows that could not be parsed are counted and listed in the meta file.

Poll date rule: if the poll's cited source has a `date=` field on or after the end of fieldwork (and within 30
days of it), that is used as the release date; otherwise the end of fieldwork is used. The note says which.

polling_density = number of distinct polls whose chosen date falls in the race window.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import os
import re
import urllib.parse
from typing import Any

from raceattn.cache import Cache, query_hash
from raceattn.config import Race
from raceattn.connectors.base import now_utc
from raceattn.http import FetchError, HttpClient

API_URL = "https://en.wikipedia.org/w/api.php"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENTS_DIR = os.path.join(ROOT, "config", "events")
RAW_DIR = os.path.join(ROOT, "data", "raw")
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                      "september", "october", "november", "december"], 1)}
MONTHS.update({k[:3]: v for k, v in list(MONTHS.items())})
MONTHS["sept"] = 9
RELEASE_MAX_LAG_DAYS = 30
HEADING_RE = re.compile(r"^(={2,6})\s*(.*?)\s*\1\s*$", re.M)
DASH_RE = re.compile(r"\s*(?:–|\u2014|&ndash;|&mdash;|\{\{ndash\}\}|\{\{snd\}\}|\{\{spaced ndash\}\}|-)\s*")


# ------------------------------------------------------------------ wikitext helpers
def strip_comments(s: str) -> str:
    return re.sub(r"<!--.*?-->", "", s, flags=re.S)


def ref_bodies(text: str) -> dict[str, str]:
    """Named refs defined anywhere on the page: name -> body."""
    out = {}
    for m in re.finditer(r"<ref\s+name\s*=\s*\"?([^\">/]+?)\"?\s*>(.*?)</ref>", text, flags=re.S | re.I):
        out.setdefault(m.group(1).strip(), m.group(2))
    return out


def cell_refs(cell: str, named: dict[str, str]) -> list[str]:
    bodies = [m.group(1) for m in re.finditer(r"<ref(?:\s[^>]*)?(?<!/)>(.*?)</ref>", cell, flags=re.S | re.I)]
    for m in re.finditer(r"<ref\s+name\s*=\s*\"?([^\">/]+?)\"?\s*/>", cell, flags=re.I):
        if m.group(1).strip() in named:
            bodies.append(named[m.group(1).strip()])
    return bodies


def plain(s: str) -> str:
    """Rough plain text of a wikitext cell."""
    s = strip_comments(s)
    s = re.sub(r"<ref[^>]*/>", "", s, flags=re.I)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S | re.I)
    s = re.sub(r"\{\{(?:nbsp|nowrap\|)\}\}", " ", s)
    for _ in range(3):
        s = re.sub(r"\{\{(?:nowrap|abbr|small)\|([^{}|]*)(?:\|[^{}]*)?\}\}", r"\1", s, flags=re.I)
        s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[https?://\S+\s+([^\]]*)\]", r"\1", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("'''", "").replace("''", "").replace("&nbsp;", " ")
    s = s.replace("\u2013", "-").replace("\u2014", "-").replace("&ndash;", "-").replace("&mdash;", "-")
    return re.sub(r"\s+", " ", s).strip()


def split_top(s: str, sep: str) -> list[str]:
    """Split on sep outside [[...]] and {{...}}."""
    out, depth, cur, i = [], 0, [], 0
    while i < len(s):
        two = s[i:i + 2]
        if two in ("[[", "{{"):
            depth += 1
            cur.append(two)
            i += 2
            continue
        if two in ("]]", "}}") and depth:
            depth -= 1
            cur.append(two)
            i += 2
            continue
        if depth == 0 and s.startswith(sep, i):
            out.append("".join(cur))
            cur = []
            i += len(sep)
            continue
        cur.append(s[i])
        i += 1
    out.append("".join(cur))
    return out


def split_cell(raw: str) -> tuple[str, str]:
    """'style="x" rowspan=2 | content' -> (attrs, content). A single top-level | separates them."""
    parts = split_top(raw, "|")
    if len(parts) >= 2 and "[[" not in parts[0] and "{{" not in parts[0].strip()[:2] and "=" in parts[0]:
        return parts[0], "|".join(parts[1:])
    if len(parts) >= 2 and re.fullmatch(r"\s*\{\{party shading/[^}]*\}\}\s*", parts[0]):
        return parts[0], "|".join(parts[1:])
    return "", raw


def parse_tables(text: str) -> list[dict[str, Any]]:
    """Every top-level {| ... |} table: header cells and data rows (rowspans expanded)."""
    tables = []
    for m in re.finditer(r"^\{\|.*?^\|\}", text, flags=re.S | re.M):
        body = m.group(0)
        rows_raw = re.split(r"^\|-.*$", body, flags=re.M)
        headers: list[str] = []
        rows: list[list[str]] = []
        carry: dict[int, list] = {}  # column -> [remaining, content]
        for rr in rows_raw:
            cells: list[tuple[str, str, bool]] = []
            for line in rr.split("\n"):
                if line.startswith("|}") or line.startswith("|+") or line.startswith("{|"):
                    continue
                if line.startswith("!"):
                    for c in split_top(line[1:], "!!"):
                        a, content = split_cell(c)
                        cells.append((a, content, True))
                elif line.startswith("|"):
                    for c in split_top(line[1:], "||"):
                        a, content = split_cell(c)
                        cells.append((a, content, False))
                elif cells:  # continuation of the previous cell
                    a, content, h = cells[-1]
                    cells[-1] = (a, content + "\n" + line, h)
            if not cells:
                continue
            if all(h for _, _, h in cells) and not rows:
                headers.extend(plain(c) for _, c, _ in cells)
                continue
            row: list[str] = []
            col = 0
            pending = list(cells)
            while pending or carry.get(col):
                if carry.get(col) and carry[col][0] > 0:
                    row.append(carry[col][1])
                    carry[col][0] -= 1
                    col += 1
                    continue
                if not pending:
                    break
                a, content, _ = pending.pop(0)
                rs = re.search(r"rowspan\s*=\s*\"?(\d+)", a)
                if rs and int(rs.group(1)) > 1:
                    carry[col] = [int(rs.group(1)) - 1, content]
                row.append(content)
                col += 1
            rows.append(row)
        tables.append({"headers": headers, "rows": rows, "start": m.start(), "raw": body})
    return tables


def sections(text: str) -> list[dict[str, Any]]:
    """Headings with their level, title, level-2 parent and text span."""
    hs = [(m.start(), m.end(), len(m.group(1)), plain(m.group(2))) for m in HEADING_RE.finditer(text)]
    out, parent = [], ""
    for i, (s, e, lvl, title) in enumerate(hs):
        if lvl == 2:
            parent = title
        end = len(text)
        for s2, _, lvl2, _ in hs[i + 1:]:
            if lvl2 <= lvl:
                end = s2
                break
        out.append({"title": title, "level": lvl, "parent": parent, "start": e, "end": end})
    return out


# ------------------------------------------------------------------ dates
def _mon(word: str) -> int | None:
    return MONTHS.get(word.strip(".").lower())


def parse_date(s: str, default_year: int | None = None, default_month: int | None = None) -> dt.date | None:
    s = plain(s).strip(" ,")
    m = re.fullmatch(r"([A-Za-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})?", s)
    if m and _mon(m.group(1)):
        y = int(m.group(3)) if m.group(3) else default_year
        return dt.date(y, _mon(m.group(1)), int(m.group(2))) if y else None
    m = re.fullmatch(r"(\d{1,2})\s+([A-Za-z]+)\.?,?\s*(\d{4})?", s)
    if m and _mon(m.group(2)):
        y = int(m.group(3)) if m.group(3) else default_year
        return dt.date(y, _mon(m.group(2)), int(m.group(1))) if y else None
    m = re.fullmatch(r"(\d{1,2}),?\s*(\d{4})?", s)
    if m and default_month:
        y = int(m.group(2)) if m.group(2) else default_year
        return dt.date(y, default_month, int(m.group(1))) if y else None
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def parse_range_end(s: str) -> tuple[dt.date | None, dt.date | None]:
    """'October 31 – November 2, 2026' -> (start, end). Single dates give (d, d)."""
    s = plain(strip_comments(s))
    s = re.sub(r"^(?:through|until)\s+", "", s, flags=re.I)
    parts = [p for p in DASH_RE.split(s) if p.strip()]
    if not parts:
        return None, None
    year_m = re.search(r"(\d{4})\s*$", parts[-1])
    year = int(year_m.group(1)) if year_m else None
    end = parse_date(parts[-1], year)
    if end is None and len(parts) >= 2:  # "October 27-30, 2026": the month comes from the start
        m0 = re.match(r"([A-Za-z]+)", parts[0].strip())
        end = parse_date(parts[-1], year, _mon(m0.group(1)) if m0 and _mon(m0.group(1)) else None)
    if end is None:
        return None, None
    start = end
    if len(parts) >= 2:
        start = parse_date(parts[0], year, end.month) or end
        if start > end:
            start = parse_date(parts[0], year - 1, end.month) if year else end
    return start, end


def cite_date(bodies: list[str]) -> dt.date | None:
    for b in bodies:
        m = re.search(r"\|\s*date\s*=\s*([^|}]+)", b)
        if m:
            d = parse_date(m.group(1).strip())
            if d:
                return d
    return None


# ------------------------------------------------------------------ extraction
def _col(headers: list[str], *needles: str) -> int | None:
    for i, h in enumerate(headers):
        hl = h.lower()
        if any(n in hl for n in needles):
            return i
    return None


def extract_polls(text: str, window_start: dt.date, window_end: dt.date) -> dict[str, Any]:
    named = ref_bodies(text)
    secs = sections(text)
    polling = [s for s in secs if "polling" in s["title"].lower()]
    general = [s for s in polling if s["parent"].lower().startswith("general election")]
    use = general or polling
    polls: dict[tuple[str, str], dict[str, Any]] = {}
    unparsed: list[str] = []
    n_tables = 0
    for sec in use:
        for t in parse_tables(text[sec["start"]:sec["end"]]):
            h = t["headers"]
            if any("aggregat" in x.lower() for x in h):
                continue
            ci_src, ci_date = _col(h, "poll source", "pollster"), _col(h, "administered", "date")
            if ci_src is None or ci_date is None:
                continue
            n_tables += 1
            for row in t["rows"]:
                if len(row) <= max(ci_src, ci_date):
                    continue
                src_raw, date_raw = row[ci_src], row[ci_date]
                name = plain(src_raw)
                if not name or name.lower() in ("average",):
                    continue
                start, end = parse_range_end(date_raw)
                if end is None:
                    unparsed.append("%s: %r" % (name, plain(date_raw)))
                    continue
                key = (name, end.isoformat())
                if key in polls:
                    continue
                rel = cite_date(cell_refs(src_raw, named))
                if rel and end <= rel <= end + dt.timedelta(days=RELEASE_MAX_LAG_DAYS):
                    date, basis = rel, "release date (date field of the cited source)"
                else:
                    date, basis = end, "end of fieldwork (no release date listed)"
                polls[key] = {"pollster": name, "fieldwork": plain(date_raw), "fieldwork_end": end, "date": date,
                              "basis": basis}
    in_window = sorted((p for p in polls.values() if window_start <= p["date"] <= window_end),
                       key=lambda p: (p["date"], p["pollster"]))
    return {"polls": in_window, "n_polls_total": len(polls), "n_tables": n_tables, "unparsed": unparsed,
            "sections": ["%s > %s" % (s["parent"], s["title"]) for s in use]}


def extract_debates(text: str, window_start: dt.date, window_end: dt.date) -> list[dict[str, Any]]:
    out = []
    for sec in [s for s in sections(text) if "debate" in s["title"].lower()]:
        for t in parse_tables(text[sec["start"]:sec["end"]]):
            ci = _col(t["headers"], "date")
            if ci is None:
                continue
            for row in t["rows"]:
                if len(row) <= ci:
                    continue
                _, d = parse_range_end(row[ci])
                if d and window_start <= d <= window_end:
                    host = plain(row[ci + 1]) if len(row) > ci + 1 else ""
                    out.append({"date": d, "note": "debate listed in section %r%s" % (
                        sec["title"], (", host: " + host) if host else "")})
    return out


def extract_deadlines(text: str, window_start: dt.date, window_end: dt.date) -> list[dict[str, Any]]:
    out = []
    prose = re.sub(r"<ref[^>]*>.*?</ref>", "", strip_comments(text), flags=re.S | re.I)
    pat = re.compile(r"filing deadline[^.]{0,60}?\b([A-Z][a-z]+\.? \d{1,2}, \d{4})", re.I)
    for m in pat.finditer(prose):
        d = parse_date(m.group(1))
        if d and window_start <= d <= window_end:
            out.append({"date": d, "note": "filing deadline in the page text: %r" % plain(m.group(0))[:120]})
    return out


# ------------------------------------------------------------------ fetch and write
def fetch_page(race: Race, http: HttpClient, raw_dir: str = RAW_DIR, refresh: bool = False) -> dict[str, Any]:
    page = race.wikipedia_pages[0]
    params = {"action": "parse", "page": page, "prop": "wikitext|revid", "format": "json", "formatversion": 2,
              "redirects": 1}
    cache = Cache(raw_dir)
    path = cache.path("wikipedia_events", race.race_id, race.window.label, query_hash(API_URL, params), "parse")
    rec = None if refresh else cache.get(path)
    if rec is None:
        status, body = http.get_json(API_URL, params)
        if "error" in (body or {}):
            raise FetchError("MediaWiki API error for %s: %s" % (page, body["error"].get("info")))
        rec = {"request": {"endpoint": API_URL, "params": params}, "status": status, "fetched_at": now_utc(),
               "body": body}
        cache.put(path, rec)
    return rec


def revision_url(title: str, revid: int) -> str:
    return "https://en.wikipedia.org/w/index.php?title=%s&oldid=%d" % (urllib.parse.quote(title), revid)


def generate(race: Race, rec: dict[str, Any]) -> tuple[list[dict[str, str]], dict[str, Any]]:
    body = rec["body"]["parse"]
    title, revid, text = body["title"], int(body["revid"]), body["wikitext"]
    if isinstance(text, dict):  # formatversion=1 shape
        text = text.get("*", "")
    url = revision_url(title.replace(" ", "_"), revid)
    w0, w1 = race.window.start, race.window.end
    polls = extract_polls(text, w0, w1)
    rows = []
    for p in polls["polls"]:
        rows.append({"date_utc": p["date"].isoformat(), "type": "poll", "source_url": url,
                     "note": "%s, fieldwork %s; date = %s" % (p["pollster"], p["fieldwork"], p["basis"]),
                     "status": "needs_review"})
    for d in extract_debates(text, w0, w1):
        rows.append({"date_utc": d["date"].isoformat(), "type": "debate", "source_url": url, "note": d["note"],
                     "status": "needs_review"})
    for d in extract_deadlines(text, w0, w1):
        rows.append({"date_utc": d["date"].isoformat(), "type": "filing_deadline", "source_url": url,
                     "note": d["note"], "status": "needs_review"})
    rows.sort(key=lambda r: (r["date_utc"], r["type"], r["note"]))
    meta = {"race_id": race.race_id, "page": title, "revid": revid, "revision_url": url,
            "fetched_at": rec["fetched_at"], "generated_at": now_utc(), "window": [w0.isoformat(), w1.isoformat()],
            "polling_density": len(polls["polls"]),
            "polling_density_definition": "distinct polls (pollster + end of fieldwork) whose chosen date is in the "
                                          "window, from the polling tables on this revision",
            "polls_on_page": polls["n_polls_total"], "poll_tables_read": polls["n_tables"],
            "polling_sections": polls["sections"], "unparsed_poll_rows": polls["unparsed"],
            "counts": {t: sum(1 for r in rows if r["type"] == t) for t in ("poll", "debate", "filing_deadline")},
            "status": "needs_review",
            "note": "Draft. Every row needs a human check against the cited revision before its status is set to "
                    "confirmed. Debates and filing deadlines appear only if the page lists them with a date."}
    return rows, meta


def write(race: Race, rows: list[dict[str, str]], meta: dict[str, Any], events_dir: str = EVENTS_DIR) -> tuple[str, str]:
    os.makedirs(events_dir, exist_ok=True)
    path = os.path.join(events_dir, race.race_id + ".csv")
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["date_utc", "type", "source_url", "note", "status"], lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    mpath = os.path.join(events_dir, race.race_id + ".meta.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
        f.write("\n")
    return path, mpath
