"""Race config loader and schema validation (spec section 4)."""
from __future__ import annotations

import datetime as dt
import os
import re
from dataclasses import dataclass, field
from typing import Any

import yaml

OFFICES = ("senate", "house", "governor", "national")
STATUSES = ("confirmed", "needs_review")
RACES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "races")
RACE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
STATE_RE = re.compile(r"^[A-Z]{2}$")
DISPLAY_DAYS_BEFORE = 90  # default display window: election_date - 90 days to election_date + 1 day


class ConfigError(ValueError):
    """Raised when a race config is missing keys or has bad values."""


@dataclass(frozen=True)
class Window:
    """Inclusive UTC date window."""

    start: dt.date
    end: dt.date

    @property
    def label(self) -> str:
        return "%s_%s" % (self.start.strftime("%Y%m%d"), self.end.strftime("%Y%m%d"))

    def days(self) -> list[dt.date]:
        n = (self.end - self.start).days + 1
        return [self.start + dt.timedelta(days=i) for i in range(n)]

    @property
    def n_days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def start_dt(self) -> dt.datetime:
        return dt.datetime(self.start.year, self.start.month, self.start.day, tzinfo=dt.timezone.utc)

    @property
    def end_exclusive_dt(self) -> dt.datetime:
        """(end + 1 day) 00:00 UTC, the exclusive upper bound for timestamp requests."""
        e = self.end + dt.timedelta(days=1)
        return dt.datetime(e.year, e.month, e.day, tzinfo=dt.timezone.utc)


@dataclass(frozen=True)
class Entity:
    name: str
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class KalshiTarget:
    series: str
    event: str
    followed_market: str


@dataclass(frozen=True)
class Race:
    race_id: str
    state: str
    office: str
    election_date: dt.date
    window: Window
    exclude_days: tuple[dt.date, ...]
    kalshi: KalshiTarget
    entities: tuple[Entity, ...]
    wikipedia_pages: tuple[str, ...]
    subreddits: tuple[str, ...] = ()
    news_query: str | None = None
    polling_density: int | None = None
    status: str = "confirmed"  # a file without a status (the hand-written Texas config) counts as confirmed
    # display window: the dates the display series cover (series.display_daily), never used by the metrics
    display_window: Window | None = None
    display_window_set: bool = False  # True when the config sets display_window (the display pull runs by default)
    discovery: dict[str, Any] | None = field(default=None, compare=False)
    source_path: str | None = field(default=None, compare=False)

    def summary(self) -> dict[str, Any]:
        return {
            "race_id": self.race_id,
            "state": self.state,
            "office": self.office,
            "election_date": self.election_date.isoformat(),
            "kalshi": {
                "series": self.kalshi.series,
                "event": self.kalshi.event,
                "followed_market": self.kalshi.followed_market,
            },
            "entities": [{"name": e.name, "aliases": list(e.aliases)} for e in self.entities],
            "wikipedia_pages": list(self.wikipedia_pages),
            "subreddits": list(self.subreddits),
            "news_query": self.news_query,
            "polling_density": self.polling_density,
            "status": self.status,
            "display_window": ({"start": self.display_window.start.isoformat(),
                                "end": self.display_window.end.isoformat(),
                                "source": "race config" if self.display_window_set else
                                "default: election_date - %d days to election_date + 1 day" % DISPLAY_DAYS_BEFORE}
                               if self.display_window else None),
        }


def _date(value: Any, where: str) -> dt.date:
    if isinstance(value, dt.datetime):
        raise ConfigError("%s: expected a date like 2026-11-03, got a datetime %r" % (where, value))
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        try:
            return dt.date.fromisoformat(value.strip())
        except ValueError:
            pass
    raise ConfigError("%s: expected a date like 2026-11-03, got %r" % (where, value))


def _str(d: dict, key: str, where: str, required: bool = True) -> str | None:
    if key not in d or d[key] is None:
        if required:
            raise ConfigError("%s: missing required key '%s'" % (where, key))
        return None
    v = d[key]
    if not isinstance(v, str) or not v.strip():
        raise ConfigError("%s.%s: expected a non-empty string, got %r" % (where, key, v))
    return v.strip()


def _str_list(d: dict, key: str, where: str, required: bool = True) -> tuple[str, ...]:
    if key not in d or d[key] is None:
        if required:
            raise ConfigError("%s: missing required key '%s'" % (where, key))
        return ()
    v = d[key]
    if not isinstance(v, list) or not all(isinstance(x, str) and x.strip() for x in v):
        raise ConfigError("%s.%s: expected a list of non-empty strings, got %r" % (where, key, v))
    return tuple(x.strip() for x in v)


def validate(data: Any, source_path: str | None = None) -> Race:
    """Validate a parsed YAML mapping and return a Race. Raises ConfigError with a clear message."""
    where = os.path.basename(source_path) if source_path else "race config"
    if not isinstance(data, dict):
        raise ConfigError("%s: top level must be a mapping, got %s" % (where, type(data).__name__))

    race_id = _str(data, "race_id", where)
    if not RACE_ID_RE.match(race_id):
        raise ConfigError("%s.race_id: use lowercase letters, digits and dashes, got %r" % (where, race_id))
    state = _str(data, "state", where)
    if not STATE_RE.match(state):
        raise ConfigError("%s.state: expected a two-letter uppercase code like TX, got %r" % (where, state))
    office = _str(data, "office", where)
    if office not in OFFICES:
        raise ConfigError("%s.office: must be one of %s, got %r" % (where, " | ".join(OFFICES), office))
    if "election_date" not in data:
        raise ConfigError("%s: missing required key 'election_date'" % where)
    election_date = _date(data["election_date"], where + ".election_date")

    w = data.get("window")
    if w is None:
        raise ConfigError("%s: missing required key 'window'" % where)
    if not isinstance(w, dict) or "start" not in w or "end" not in w:
        raise ConfigError("%s.window: expected {start: YYYY-MM-DD, end: YYYY-MM-DD}, got %r" % (where, w))
    window = Window(_date(w["start"], where + ".window.start"), _date(w["end"], where + ".window.end"))
    if window.start > window.end:
        raise ConfigError("%s.window: start %s is after end %s" % (where, window.start, window.end))

    ex_raw = data.get("exclude_days")
    if ex_raw is None:
        ex_raw = []
    if not isinstance(ex_raw, list):
        raise ConfigError("%s.exclude_days: expected a list of dates, got %r" % (where, ex_raw))
    exclude = []
    lo, hi = window.start - dt.timedelta(days=1), window.end + dt.timedelta(days=1)
    for i, v in enumerate(ex_raw):
        d = _date(v, "%s.exclude_days[%d]" % (where, i))
        if not lo <= d <= hi:
            raise ConfigError("%s.exclude_days[%d]: %s is not inside or adjacent to the window %s..%s"
                              % (where, i, d, window.start, window.end))
        exclude.append(d)

    dw = data.get("display_window")
    if dw is None:
        display = Window(election_date - dt.timedelta(days=DISPLAY_DAYS_BEFORE), election_date + dt.timedelta(days=1))
        dwhere = "%s.display_window (default from election_date)" % where
    else:
        if not isinstance(dw, dict) or "start" not in dw or "end" not in dw or set(dw) - {"start", "end"}:
            raise ConfigError("%s.display_window: expected {start: YYYY-MM-DD, end: YYYY-MM-DD}, got %r" % (where, dw))
        display = Window(_date(dw["start"], where + ".display_window.start"),
                         _date(dw["end"], where + ".display_window.end"))
        dwhere = "%s.display_window" % where
    if display.start > display.end:
        raise ConfigError("%s: start %s is after end %s" % (dwhere, display.start, display.end))
    if display.start > window.start or display.end < window.end:
        raise ConfigError("%s: %s..%s must contain the analysis window %s..%s (start <= window.start, "
                          "end >= window.end)" % (dwhere, display.start, display.end, window.start, window.end))

    k = data.get("kalshi")
    if k is None:
        raise ConfigError("%s: missing required key 'kalshi'" % where)
    if not isinstance(k, dict):
        raise ConfigError("%s.kalshi: expected a mapping with series, event, followed_market" % where)
    kalshi = KalshiTarget(_str(k, "series", where + ".kalshi"), _str(k, "event", where + ".kalshi"),
                          _str(k, "followed_market", where + ".kalshi"))

    ents_raw = data.get("entities")
    if not isinstance(ents_raw, list) or not ents_raw:
        raise ConfigError("%s.entities: expected a non-empty list of {name, aliases}, got %r" % (where, ents_raw))
    entities = []
    for i, e in enumerate(ents_raw):
        ew = "%s.entities[%d]" % (where, i)
        if not isinstance(e, dict):
            raise ConfigError("%s: expected a mapping like {name: ..., aliases: [...]}, got %r" % (ew, e))
        entities.append(Entity(_str(e, "name", ew), _str_list(e, "aliases", ew, required=False)))

    pages = _str_list(data, "wikipedia_pages", where)
    if not pages:
        raise ConfigError("%s.wikipedia_pages: list is empty" % where)
    if len(set(pages)) != len(pages):
        raise ConfigError("%s.wikipedia_pages: duplicate titles in %r" % (where, list(pages)))
    subreddits = _str_list(data, "subreddits", where, required=False)
    news_query = _str(data, "news_query", where, required=False)
    pd_ = data.get("polling_density")
    if pd_ is not None and (isinstance(pd_, bool) or not isinstance(pd_, int) or pd_ < 0):
        raise ConfigError("%s.polling_density: expected null or a non-negative integer, got %r" % (where, pd_))

    status = data.get("status", "confirmed")
    if status not in STATUSES:
        raise ConfigError("%s.status: must be one of %s, got %r" % (where, " | ".join(STATUSES), status))
    discovery = data.get("discovery")
    if discovery is not None and not isinstance(discovery, dict):
        raise ConfigError("%s.discovery: expected a mapping of field -> confidence note, got %r" % (where, discovery))

    known = {"race_id", "state", "office", "election_date", "window", "exclude_days", "kalshi", "entities",
             "wikipedia_pages", "subreddits", "news_query", "polling_density", "status", "discovery", "display_window"}
    unknown = sorted(set(data) - known)
    if unknown:
        raise ConfigError("%s: unknown keys %s (typo?)" % (where, ", ".join(unknown)))

    return Race(race_id=race_id, state=state, office=office, election_date=election_date, window=window,
                exclude_days=tuple(sorted(set(exclude))), kalshi=kalshi, entities=tuple(entities),
                wikipedia_pages=pages, subreddits=subreddits, news_query=news_query, polling_density=pd_,
                status=status, display_window=display, display_window_set=dw is not None, discovery=discovery,
                source_path=source_path)


def resolve_race_path(race: str, races_dir: str = RACES_DIR) -> str:
    """Accept a race id (config/races/<id>.yaml) or a path to a yaml file."""
    if race.endswith((".yaml", ".yml")) or os.sep in race or os.path.exists(race):
        if not os.path.isfile(race):
            raise ConfigError("race config file not found: %s" % race)
        return race
    path = os.path.join(races_dir, race + ".yaml")
    if not os.path.isfile(path):
        avail = sorted(f[:-5] for f in os.listdir(races_dir) if f.endswith(".yaml")) if os.path.isdir(races_dir) else []
        raise ConfigError("no race config for id %r (looked for %s). Available: %s"
                          % (race, path, ", ".join(avail) or "none"))
    return path


def confirmed_races(races_dir: str = RACES_DIR) -> tuple[list[Race], dict[str, str]]:
    """Every config/races/*.yaml with status confirmed (drafts/ is a subdirectory and is not read).
    Returns the races and {file name: reason} for files that were left out."""
    races, left_out = [], {}
    for fn in sorted(os.listdir(races_dir)) if os.path.isdir(races_dir) else []:
        if not fn.endswith((".yaml", ".yml")):
            continue
        r = load_race(os.path.join(races_dir, fn))
        if r.status != "confirmed":
            left_out[fn] = "status is %s, not confirmed" % r.status
            continue
        races.append(r)
    return races, left_out


def load_race(race: str, races_dir: str = RACES_DIR) -> Race:
    path = resolve_race_path(race, races_dir)
    with open(path, encoding="utf-8") as f:
        try:
            data = yaml.safe_load(f)
        except yaml.YAMLError as e:
            raise ConfigError("%s: not valid YAML: %s" % (path, e)) from e
    return validate(data, source_path=path)
