"""Race discovery (spec section 4): `python -m raceattn discover --office senate|governor [--state XX]`.

For each state it looks for a 2026 race in two places and writes a draft config only when both agree:

- Kalshi: every public event is listed through `GET /events` (status open, closed and settled, cursor paging).
  Events are matched by title, never by ticker pattern: "<State> Senate winner?" or "<State> Governor winner?"
  (an optional "(Party)" or "(Person)" suffix is allowed) with "2026" in the sub title. The Kentucky event, for
  example, is `SENATELA-26`, which no ticker rule would find. The event's markets come from
  `GET /events/{ticker}`; the followed market is the Democratic party contract (same rule as Texas).
- Wikipedia: the race article title is checked through the MediaWiki query API with redirects resolved
  ("2026 United States Senate election in <State>", and the "special election" title, which is where Ohio and
  Florida 2026 live). The article's election infobox gives the nominees and their article titles.

Every field gets a confidence note (high, medium or low, why, and the URL or ticker it came from). Drafts carry
`status: needs_review`; a human moves them to config/races/ and sets `status: confirmed`.

Only the Elections events whose title mentions Senate or Governor are kept in the cache; nothing else from the
listing is stored.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable

import yaml

from raceattn.cache import Cache, query_hash
from raceattn.config import RACES_DIR, load_race, validate
from raceattn.connectors.base import now_utc
from raceattn.connectors.kalshi import BASE_URL as KALSHI_URL
from raceattn.events import API_URL as WIKI_API, split_top
from raceattn.http import FetchError, HttpClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "data", "raw")
DRAFTS_DIR = os.path.join(RACES_DIR, "drafts")
YEAR = 2026
DEFAULT_ELECTION_DATE = dt.date(2026, 11, 3)
WINDOW_START = dt.date(2026, 9, 1)  # same rule as Texas: September 1 to the day after election day
EVENT_STATUSES = ("open", "closed", "settled")
PAGE_LIMIT = 200
MAX_PAGES = 1000  # per status; on 2026-11-11: open 100 pages, closed 3, settled (with min_close_ts) 267
# The settled listing holds every settled event Kalshi ever ran (well over 80,000), so it is cut to events with a
# market closing on or after election day 00:00 UTC; every 2026 general election winner event closes after that.
MIN_SHARE = 5.0  # a nominee with under 5% of the vote is not a major nominee
OFFICE_WORD = {"senate": "Senate", "governor": "Governor"}

STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming",
}
NAME_SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv"}


def note(level: str, why: str, source: str) -> dict[str, str]:
    return {"confidence": level, "why": why, "source": source}


def wiki_url(title: str) -> str:
    return "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))


def kalshi_event_url(ticker: str) -> str:
    return "%s/events/%s" % (KALSHI_URL, ticker)


def race_page_titles(state: str, office: str) -> list[str]:
    """Candidate race article titles, regular first."""
    name = STATES[state]
    if office == "governor":
        return ["%d %s gubernatorial election" % (YEAR, name)]
    return ["%d United States Senate election in %s" % (YEAR, name),
            "%d United States Senate special election in %s" % (YEAR, name)]


def title_regex(state: str, office: str) -> re.Pattern:
    return re.compile(r"^%s %s winner\?(?:\s*\((?:party|person)\))?$" % (re.escape(STATES[state]), OFFICE_WORD[office]),
                      re.I)


def surname(name: str) -> str:
    parts = [p for p in re.split(r"\s+", name.strip()) if p]
    while len(parts) > 1 and parts[-1].lower().strip(",") in NAME_SUFFIXES:
        parts.pop()
    return parts[-1].strip(",") if parts else name


# ------------------------------------------------------------------ cached requests
class Fetcher:
    """Cached GETs for discovery. Layout: <raw>/<source>/<key>/<label>/<query hash>/<name>.json."""

    def __init__(self, http: HttpClient, raw_dir: str = RAW_DIR, refresh: bool = False,
                 log: Callable[[str], None] = print):
        self.http = http
        self.cache = Cache(raw_dir)
        self.refresh = refresh
        self.log = log
        self.fetches = 0
        self.hits = 0

    def get(self, source: str, key: str, label: str, endpoint: str, params: dict[str, Any], name: str,
            ok_status: tuple[int, ...] = (200,)) -> dict[str, Any]:
        path = self.cache.path(source, key, label, query_hash(endpoint, params), name)
        rec = None if self.refresh else self.cache.get(path)
        if rec is not None:
            self.hits += 1
            return rec
        status, body = self.http.get_json(endpoint, params, ok_status=ok_status)
        self.fetches += 1
        rec = {"request": {"endpoint": endpoint, "params": params}, "query_hash": query_hash(endpoint, params),
               "status": status, "fetched_at": now_utc(), "body": body}
        self.cache.put(path, rec)
        return rec

    def kalshi_events(self, status: str) -> dict[str, Any]:
        """Every event with this status (cursor paging), reduced to Elections events about Senate or Governor
        races. One cache record per status."""
        endpoint = KALSHI_URL + "/events"
        params: dict[str, Any] = {"status": status, "limit": PAGE_LIMIT}
        if status == "settled":
            params["min_close_ts"] = int(dt.datetime(DEFAULT_ELECTION_DATE.year, DEFAULT_ELECTION_DATE.month,
                                                     DEFAULT_ELECTION_DATE.day, tzinfo=dt.timezone.utc).timestamp())
        path = self.cache.path("kalshi_discovery", "events", "all", query_hash(endpoint, params), "walk")
        rec = None if self.refresh else self.cache.get(path)
        if rec is not None:
            self.hits += 1
            return rec
        kept, seen, pages, cursor = [], 0, 0, None
        cursors: set[str] = set()
        tickers: set[str] = set()
        while True:
            p = dict(params)
            if cursor:
                p["cursor"] = cursor
            _, body = self.http.get_json(endpoint, p)
            self.fetches += 1
            pages += 1
            evs = (body or {}).get("events") or []
            seen += len(evs)
            kept += [e for e in evs if e.get("event_ticker") not in tickers and e.get("category") == "Elections"
                     and re.search(r"senate|governor|gubernatorial", e.get("title") or "", re.I)]
            new = [e for e in evs if e.get("event_ticker") not in tickers]
            tickers.update(e.get("event_ticker") for e in evs)
            cursor = (body or {}).get("cursor")
            if pages % 20 == 0:
                self.log("   kalshi /events status=%s: %d page(s) so far" % (status, pages))
            if not cursor or not evs or not new or cursor in cursors:
                break  # end of the listing, or the API repeats itself
            if pages >= MAX_PAGES:
                raise FetchError("Kalshi /events status=%s: still paging after %d pages; stopping" % (status, pages))
            cursors.add(cursor)
        self.log("   kalshi /events status=%s: %d page(s), %d event(s), %d Senate/Governor election event(s) kept"
                 % (status, pages, seen, len(kept)))
        rec = {"request": {"endpoint": endpoint, "params": params}, "query_hash": query_hash(endpoint, params),
               "status": 200, "fetched_at": now_utc(), "pages": pages, "events_seen": seen,
               "kept": "category == Elections and the title mentions Senate, Governor or gubernatorial",
               "events": kept}
        self.cache.put(path, rec)
        return rec

    def kalshi_event(self, ticker: str) -> dict[str, Any]:
        return self.get("kalshi_discovery", "event", ticker, kalshi_event_url(ticker), {}, "event")

    def wiki_query(self, key: str, titles: list[str], extra: dict[str, Any] | None = None) -> dict[str, Any]:
        params = {"action": "query", "titles": "|".join(titles), "redirects": 1, "format": "json",
                  "formatversion": 2, **(extra or {})}
        return self.get("wikipedia_discovery", key, "query", WIKI_API, params, "query")

    def wiki_parse(self, race_id: str, window_label: str, page: str) -> dict[str, Any]:
        """Same request and cache path as `python -m raceattn events`, so the generator reuses this revision."""
        params = {"action": "parse", "page": page, "prop": "wikitext|revid", "format": "json", "formatversion": 2,
                  "redirects": 1}
        return self.get("wikipedia_events", race_id, window_label, WIKI_API, params, "parse")


def resolve_titles(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """MediaWiki query result -> {requested title: {"title": final title or None, "redirected": bool, ...}}."""
    q = (body or {}).get("query") or {}
    norm = {n["from"]: n["to"] for n in q.get("normalized") or []}
    redir = {r["from"]: r["to"] for r in q.get("redirects") or []}
    pages = {p["title"]: p for p in q.get("pages") or []}
    out = {}
    for req in set(norm) | set(redir) | set(pages):
        t = norm.get(req, req)
        hops = 0
        while t in redir and hops < 5:
            t, hops = redir[t], hops + 1
        p = pages.get(t)
        out[req] = {"title": None if (p is None or p.get("missing") or p.get("invalid")) else t,
                    "redirected": hops > 0, "page": p}
    return out


def lookup(resolved: dict[str, dict[str, Any]], title: str) -> dict[str, Any]:
    for k in (title, title.replace("_", " ")):
        if k in resolved:
            return resolved[k]
    return {"title": None, "redirected": False, "page": None}


# ------------------------------------------------------------------ infobox
def infobox(text: str) -> dict[str, str]:
    """Parameters of the first {{Infobox election ...}} template (top-level | split)."""
    m = re.search(r"\{\{\s*Infobox election", text, re.I)
    if not m:
        return {}
    i, depth = m.start(), 0
    j = i
    while j < len(text) - 1:
        two = text[j:j + 2]
        if two == "{{":
            depth += 1
            j += 2
            continue
        if two == "}}":
            depth -= 1
            j += 2
            if depth == 0:
                break
            continue
        j += 1
    body = text[i + 2:j - 2]
    out = {}
    for part in split_top(body, "|")[1:]:
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip().lower()] = v.strip()
    return out


def first_link(value: str) -> tuple[str, str] | None:
    """'''[[James Talarico]]''' -> (target, display)."""
    m = re.search(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]", value)
    if not m:
        return None
    target = m.group(1).strip()
    return target, (m.group(2) or target).strip()


def _num(s: str) -> float | None:
    s = re.sub(r"[^0-9.]", "", re.sub(r"<ref.*?(</ref>|/>)", "", s or "", flags=re.S))
    try:
        return float(s) if s else None
    except ValueError:
        return None


def nominees(box: dict[str, str]) -> list[dict[str, Any]]:
    out = []
    for k in sorted((k for k in box if re.fullmatch(r"nominee\d+", k)), key=lambda k: int(k[7:])):
        i = k[7:]
        link = first_link(box[k])
        plain_name = re.sub(r"'{2,}|\[\[|\]\]|<[^>]+>", "", box[k]).split("|")[-1].strip()
        party = re.sub(r"\[\[|\]\]", "", box.get("party" + i, "")).split("|")[0].strip()
        out.append({"slot": int(i), "target": link[0] if link else None, "name": (link[1] if link else plain_name),
                    "party": party, "percentage": _num(box.get("percentage" + i, ""))})
    return [n for n in out if n["name"]]


def parse_election_date(box: dict[str, str]) -> dt.date | None:
    v = re.sub(r"\{\{[^}]*\}\}|<[^>]+>", "", box.get("election_date", "")).strip()
    for fmt in ("%B %d, %Y", "%d %B %Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(v, fmt).date()
        except ValueError:
            pass
    return None


# ------------------------------------------------------------------ result types
@dataclass
class Discovery:
    state: str
    office: str
    race_id: str
    resolved: bool = False
    problems: list[str] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)
    notes: dict[str, Any] = field(default_factory=dict)
    found: dict[str, Any] = field(default_factory=dict)  # what was found even when unresolved
    draft_path: str | None = None


def match_events(events: list[dict[str, Any]], state: str, office: str) -> list[dict[str, Any]]:
    rx = title_regex(state, office)
    out, seen = [], set()
    for e in events:
        if e["event_ticker"] in seen:
            continue
        if rx.match((e.get("title") or "").strip()) and str(YEAR) in (e.get("sub_title") or ""):
            seen.add(e["event_ticker"])
            out.append(e)
    return out


def party_market(markets: list[dict[str, Any]], party: str) -> dict[str, Any] | None:
    for m in markets:
        sub = (m.get("subtitle") or "").lower()
        if sub.startswith(party.lower()) or m.get("ticker", "").endswith("-" + party[0].upper()):
            return m
    return None


def discover_race(f: Fetcher, events: list[dict[str, Any]], state: str, office: str) -> Discovery:
    rid = "%s-%s-%d" % (state.lower(), office, YEAR)
    d = Discovery(state=state, office=office, race_id=rid)
    name = STATES[state]

    # Kalshi event by title
    cands = match_events(events, state, office)
    d.found["kalshi_title_matches"] = [{"event": e["event_ticker"], "title": e["title"], "sub_title": e.get("sub_title")}
                                       for e in cands]
    party_events = []
    for e in cands:
        rec = f.kalshi_event(e["event_ticker"])
        mk = (rec["body"] or {}).get("markets") or []
        dm = party_market(mk, "Democratic")
        if dm is not None and party_market(mk, "Republican") is not None:
            party_events.append((e, mk, dm))
    if len(party_events) > 1:  # e.g. Alaska: a party event and a "(Person)" event; the party event wins
        by_party = [pe for pe in party_events if "(person)" not in pe[0]["title"].lower()]
        if len(by_party) == 1:
            d.found["kalshi_note"] = "picked the party event over the (Person) event(s)"
            party_events = by_party
    event = mk = dm = None
    if not cands:
        d.problems.append("no Kalshi event titled '%s %s winner?' with 2026 in the sub title"
                          % (name, OFFICE_WORD[office]))
    elif not party_events:
        d.problems.append("Kalshi event(s) %s have no Democratic and Republican party contracts"
                          % ", ".join(e["event_ticker"] for e in cands))
    elif len(party_events) > 1:
        d.problems.append("ambiguous: several Kalshi party events match: %s"
                          % ", ".join(e["event_ticker"] for e, _, _ in party_events))
    else:
        event, mk, dm = party_events[0]

    # Wikipedia race page (regular and special titles; redirects resolved)
    titles = race_page_titles(state, office)
    res = resolve_titles(f.wiki_query(rid, titles)["body"])
    found_pages = {}
    for t in titles:
        r = lookup(res, t)
        if r["title"]:
            found_pages[t] = r
    d.found["wikipedia_titles_checked"] = {t: (lookup(res, t)["title"]) for t in titles}
    distinct = sorted({r["title"] for r in found_pages.values()})
    page = page_note = None
    special_ticker = bool(event and re.fullmatch(r"SENATE%sS" % state, event["series_ticker"] or ""))
    if not distinct:
        d.problems.append("no Wikipedia page: %s" % " / ".join(titles))
    elif len(distinct) == 1:
        page = distinct[0]
        via = [t for t, r in found_pages.items() if r["redirected"]]
        page_note = note("high", "the article exists" + ("; %s redirects to it" % ", ".join(repr(v) for v in via)
                                                         if via else ""), wiki_url(page))
    else:
        special = [p for p in distinct if "special election" in p]
        regular = [p for p in distinct if "special election" not in p]
        pick = (special if special_ticker else regular) or distinct
        page = pick[0]
        page_note = note("medium", "both a regular and a special election article exist (%s); picked %s because the "
                                   "Kalshi series %s %s a special-election series"
                         % (", ".join(distinct), page, event["series_ticker"] if event else "(none)",
                            "looks like" if special_ticker else "does not look like"), wiki_url(page))
    if page is None or event is None:
        return d

    # The parse is cached under the race window like the events generator, so the window has to be known before
    # the page is read. General election day 2026 is fixed by law; the infobox date is checked against it below.
    election_date = DEFAULT_ELECTION_DATE
    window_end = election_date + dt.timedelta(days=1)
    label = "%s_%s" % (WINDOW_START.strftime("%Y%m%d"), window_end.strftime("%Y%m%d"))
    rec = f.wiki_parse(rid, label, page.replace(" ", "_"))
    body = (rec["body"] or {})
    if "error" in body:
        d.problems.append("MediaWiki parse error for %s: %s" % (page, body["error"].get("info")))
        return d
    parse = body["parse"]
    text = parse["wikitext"] if isinstance(parse["wikitext"], str) else parse["wikitext"].get("*", "")
    revid = int(parse["revid"])
    rev_url = "https://en.wikipedia.org/w/index.php?title=%s&oldid=%d" % (urllib.parse.quote(page.replace(" ", "_")), revid)
    box = infobox(text)
    box_date = parse_election_date(box)
    if box_date and box_date != election_date:
        d.problems.append("infobox election_date %s differs from %s" % (box_date, election_date))
        return d
    noms = nominees(box)
    d.found["infobox_nominees"] = noms
    with_share = [n for n in noms if n["percentage"] is not None]
    major = [n for n in noms if n["percentage"] is not None and n["percentage"] >= MIN_SHARE] if with_share else noms
    major = [n for n in major if n["target"]]
    if not major:
        d.problems.append("no candidates found: the infobox of %s lists no nominee with an article link" % page)
        return d

    # resolve candidate article titles and the bare surname pages (for the news query rule)
    sn = {n["name"]: surname(n["name"]) for n in major}
    q = f.wiki_query(rid + "-candidates", [n["target"] for n in major] + sorted(set(sn.values())),
                     {"prop": "pageprops|categories", "ppprop": "disambiguation", "cllimit": "max"})
    cres = resolve_titles(q["body"])
    entities, pages = [], [page.replace(" ", "_")]
    missing = []
    for n in major:
        r = lookup(cres, n["target"])
        if not r["title"]:
            missing.append(n["name"])
            continue
        n["article"] = r["title"].replace(" ", "_")
        entities.append({"name": n["name"], "aliases": [sn[n["name"]]]})
        pages.append(n["article"])
    if missing:
        d.problems.append("candidate article missing on Wikipedia: %s" % ", ".join(missing))
        return d

    # news query terms: the bare surname when its own page is missing or is a surname list, else the full name
    terms, term_why = [], []
    for n in major:
        s = sn[n["name"]]
        r = lookup(cres, s)
        p = r["page"] or {}
        cats = [c.get("title", "") for c in p.get("categories") or []]
        is_disambig = "pageprops" in p and "disambiguation" in (p.get("pageprops") or {})
        if r["title"] is None:
            terms.append(s)
            term_why.append("%s: no article titled %r, so the surname alone" % (n["name"], s))
        elif r["title"].replace(" ", "_") == n["article"]:
            terms.append(s)
            term_why.append("%s: %r redirects to the candidate, so the surname alone" % (n["name"], s))
        elif not is_disambig and not r["redirected"] and any(c.lower().endswith("surnames") for c in cats):
            terms.append(s)
            term_why.append("%s: %r is a surname list page, so the surname alone" % (n["name"], s))
        else:
            terms.append(n["name"])
            term_why.append("%s: %r is %s, so the full name" % (
                n["name"], s, "a disambiguation page" if is_disambig else
                ("a redirect to %s" % r["title"]) if r["redirected"] else "another topic's article"))
    news_query = "(%s) AND %s" % (" OR ".join('"%s"' % t for t in terms), OFFICE_WORD[office])

    # Kalshi followed market and the cross-check against the infobox
    dem = [n for n in major if "democratic" in n["party"].lower()]  # also "Texas Democratic Party"
    yes_name = (dm.get("yes_sub_title") or "").strip()
    cross = any(yes_name.lower() == n["name"].lower() for n in major)
    kalshi_level = "high" if cross else "medium"
    kalshi_why = ("event matched by title %r (sub title %r); followed market is the Democratic party contract "
                  "(default rule, same as Texas)" % (event["title"], event.get("sub_title")))
    kalshi_why += ("; its candidate %r is a nominee in the Wikipedia infobox" % yes_name if cross else
                   "; its candidate %r is not among the infobox nominees (%s), check by hand"
                   % (yes_name, ", ".join(n["name"] for n in major)))
    if not dem:
        kalshi_level = "low"
        kalshi_why += "; no Democratic nominee in the infobox"

    ex = [election_date, election_date + dt.timedelta(days=1)]
    d.config = {
        "race_id": rid, "state": state, "office": office, "election_date": election_date,
        "window": {"start": WINDOW_START, "end": window_end}, "exclude_days": ex,
        "kalshi": {"series": event["series_ticker"], "event": event["event_ticker"], "followed_market": dm["ticker"]},
        "entities": entities, "wikipedia_pages": pages, "subreddits": [], "news_query": news_query,
        "polling_density": None, "status": "needs_review",
    }
    shares = ", ".join("%s %s%%" % (n["name"], n["percentage"]) for n in with_share) or "no vote shares listed"
    d.notes = {
        "generated_at": now_utc(),
        "race_id": note("high", "<state>-<office>-%d" % YEAR, "rule"),
        "election_date": note("high" if box_date else "medium",
                              "infobox election_date" if box_date else "general election day 2026 (infobox has no "
                              "parseable election_date)", rev_url),
        "window": note("high", "same rule as Texas: September 1 to the day after election day", "rule"),
        "exclude_days": note("high", "same rule as Texas: election day and the day after (election night in UTC)",
                             "rule"),
        "kalshi": note(kalshi_level, kalshi_why, kalshi_event_url(event["event_ticker"])),
        "entities": note("high" if len(major) >= 2 else "medium",
                         "infobox nominees with at least %g%% of the vote (%s); aliases default to the surname"
                         % (MIN_SHARE, shares) if with_share else
                         "infobox nominees (no vote shares yet); aliases default to the surname", rev_url),
        "wikipedia_pages": note("high" if page_note["confidence"] == "high" else page_note["confidence"],
                                "race article: %s; candidate articles from the infobox links, redirects resolved"
                                % page_note["why"], rev_url),
        "subreddits": note("low", "left empty: no reliable source; add by hand after checking each subreddit exists",
                           "none"),
        "news_query": note("medium", "; ".join(term_why), WIKI_API),
        "polling_density": note("low", "null until `python -m raceattn events --race %s` counts the polls" % rid,
                                "rule"),
        "revision": rev_url,
    }
    d.found["followed_market_candidate"] = yes_name
    d.found["markets"] = [{"ticker": m["ticker"], "subtitle": m.get("subtitle"), "yes_sub_title": m.get("yes_sub_title"),
                           "status": m.get("status"), "result": m.get("result")} for m in mk]
    d.resolved = True
    return d


# ------------------------------------------------------------------ writing
def _q(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def render_yaml(d: Discovery) -> str:
    c = d.config
    lines = [
        "# Draft written by `python -m raceattn discover` at %s. Review every field against the sources in the" % d.notes["generated_at"],
        "# discovery block, then move the file to config/races/ and set status: confirmed.",
        "race_id: %s" % c["race_id"],
        "state: %s" % c["state"],
        "office: %s" % c["office"],
        "election_date: %s" % c["election_date"].isoformat(),
        "window: {start: %s, end: %s}   # UTC dates, inclusive" % (c["window"]["start"], c["window"]["end"]),
        "exclude_days: [%s]          # election night, left out of the main metrics"
        % ", ".join(x.isoformat() for x in c["exclude_days"]),
        "kalshi:",
        "  series: %s" % c["kalshi"]["series"],
        "  event: %s" % c["kalshi"]["event"],
        "  followed_market: %s" % c["kalshi"]["followed_market"],
        "entities:",
    ]
    for e in c["entities"]:
        lines.append("  - {name: %s, aliases: [%s]}" % (_q(e["name"]), ", ".join(_q(a) for a in e["aliases"])))
    lines.append("wikipedia_pages:")
    lines += ["  - %s" % p for p in c["wikipedia_pages"]]
    lines += [
        "subreddits: []",
        "news_query: %s" % yaml.safe_dump(c["news_query"], default_style="'", width=1000).strip().split("\n")[0],
        "polling_density: null",
        "status: %s" % c["status"],
        "discovery:",
    ]
    body = yaml.safe_dump(d.notes, sort_keys=False, allow_unicode=True, width=1000)
    lines += ["  " + ln for ln in body.rstrip("\n").split("\n")]
    return "\n".join(lines) + "\n"


def compare(draft: dict[str, Any], hand: dict[str, Any]) -> list[dict[str, Any]]:
    """Field-by-field comparison of two race summaries (Race.summary()). Returns one entry per field."""
    out = []
    for k in ("race_id", "state", "office", "election_date", "window", "exclude_days", "kalshi", "entities",
              "wikipedia_pages", "subreddits", "news_query", "polling_density"):
        a, b = draft.get(k), hand.get(k)
        out.append({"field": k, "match": a == b, "draft": a, "hand": b})
    return out


def summary_of(race) -> dict[str, Any]:
    s = race.summary()
    s["window"] = {"start": race.window.start.isoformat(), "end": race.window.end.isoformat()}
    s["exclude_days"] = [x.isoformat() for x in race.exclude_days]
    return s


def discover(office: str, states: list[str] | None = None, http: HttpClient | None = None, raw_dir: str = RAW_DIR,
             drafts_dir: str = DRAFTS_DIR, races_dir: str = RACES_DIR, refresh: bool = False,
             log: Callable[[str], None] = print, write: bool = True) -> dict[str, Any]:
    if office not in OFFICE_WORD:
        raise ValueError("office must be senate or governor, got %r" % office)
    f = Fetcher(http or HttpClient(sleep=2.0, backoff=4.0), raw_dir, refresh, log)  # MediaWiki returned 429 at 1 s spacing
    log("== kalshi: listing events (statuses %s)" % ", ".join(EVENT_STATUSES))
    events: list[dict[str, Any]] = []
    walks = {}
    for st in EVENT_STATUSES:
        rec = f.kalshi_events(st)
        walks[st] = {"pages": rec["pages"], "events_seen": rec["events_seen"], "kept": len(rec["events"]),
                     "fetched_at": rec["fetched_at"]}
        events += rec["events"]
    results = []
    for st in (states or sorted(STATES)):
        st = st.upper()
        if st not in STATES:
            raise ValueError("unknown state code %r" % st)
        try:
            r = discover_race(f, events, st, office)
        except FetchError as e:  # one state's failed request must not stop the others; re-run to retry it
            r = Discovery(state=st, office=office, race_id="%s-%s-%d" % (st.lower(), office, YEAR),
                          problems=["request failed, re-run discover to retry (cached responses are kept): %s" % e])
        if r.resolved:
            path = os.path.join(drafts_dir, r.race_id + ".yaml")
            text = render_yaml(r)
            validate(yaml.safe_load(text), source_path=path)  # the draft must load as a race config
            if write:
                os.makedirs(drafts_dir, exist_ok=True)
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(text)
            r.draft_path = path
            log("   %s: resolved -> %s (%s, %s)" % (st, os.path.relpath(path, ROOT), r.config["kalshi"]["event"],
                                                     r.config["kalshi"]["followed_market"]))
        else:
            log("   %s: not resolved: %s" % (st, "; ".join(r.problems)))
        results.append(r)

    comparisons = {}
    for r in results:
        hand_path = os.path.join(races_dir, r.race_id + ".yaml")
        if r.resolved and os.path.isfile(hand_path):
            hand = load_race(hand_path)
            if hand.discovery is None:  # a hand-written config, not a confirmed draft
                comparisons[r.race_id] = compare(summary_of(validate(yaml.safe_load(render_yaml(r)))), summary_of(hand))
    report = {"office": office, "generated_at": now_utc(), "kalshi_event_walk": walks,
              "requests": {"fetched": f.fetches, "from_cache": f.hits},
              "resolved": [{"state": r.state, "race_id": r.race_id, "draft": os.path.relpath(r.draft_path, ROOT),
                            "kalshi_event": r.config["kalshi"]["event"],
                            "followed_market": r.config["kalshi"]["followed_market"],
                            "wikipedia_page": r.config["wikipedia_pages"][0],
                            "entities": [e["name"] for e in r.config["entities"]],
                            "confidence": {k: v["confidence"] for k, v in r.notes.items() if isinstance(v, dict)}}
                           for r in results if r.resolved],
              "unresolved": [{"state": r.state, "race_id": r.race_id, "reasons": r.problems, "found": r.found}
                             for r in results if not r.resolved],
              "comparisons": comparisons}
    if write:
        os.makedirs(drafts_dir, exist_ok=True)
        with open(os.path.join(drafts_dir, "discover-report-%s.json" % office), "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=1, default=str)
            fh.write("\n")
        with open(os.path.join(drafts_dir, "discover-report-%s.md" % office), "w", encoding="utf-8") as fh:
            fh.write(report_markdown(report))
    return report


def report_markdown(rep: dict[str, Any]) -> str:
    L = ["# Discover report: %s" % rep["office"], "",
         "Generated %s by `python -m raceattn discover --office %s`. Drafts are `status: needs_review`." % (
             rep["generated_at"], rep["office"]), "",
         "Kalshi `/events` walk: " + "; ".join("%s %d page(s), %d event(s), %d kept" % (
             k, v["pages"], v["events_seen"], v["kept"]) for k, v in rep["kalshi_event_walk"].items()) + ".",
         "Requests: %d fetched, %d from cache." % (rep["requests"]["fetched"], rep["requests"]["from_cache"]), "",
         "## Resolved (%d)" % len(rep["resolved"]), "",
         "| State | Draft | Kalshi event | Followed market | Wikipedia page | Nominees | Low-confidence fields |",
         "|---|---|---|---|---|---|---|"]
    for r in rep["resolved"]:
        low = [k for k, v in r["confidence"].items() if v != "high"]
        L.append("| %s | `%s` | `%s` | `%s` | %s | %s | %s |" % (
            r["state"], r["draft"], r["kalshi_event"], r["followed_market"], r["wikipedia_page"],
            ", ".join(r["entities"]), ", ".join("%s (%s)" % (k, r["confidence"][k]) for k in low) or "none"))
    L += ["", "## Not resolved (%d)" % len(rep["unresolved"]), "", "| State | Why |", "|---|---|"]
    for r in rep["unresolved"]:
        L.append("| %s | %s |" % (r["state"], "; ".join(r["reasons"]).replace("|", "/")))
    for rid, rows in rep["comparisons"].items():
        L += ["", "## %s: draft vs hand-written config" % rid, "", "| Field | Match | Draft | Hand-written |",
              "|---|---|---|---|"]
        for c in rows:
            L.append("| %s | %s | `%s` | `%s` |" % (c["field"], "yes" if c["match"] else "NO",
                                                  json.dumps(c["draft"], default=str), json.dumps(c["hand"], default=str)))
    return "\n".join(L) + "\n"
