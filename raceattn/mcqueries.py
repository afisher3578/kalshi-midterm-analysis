"""Media Cloud query config: config/queries/<race_id>.mediacloud.yaml (docs/mediacloud-search-criteria.md, section 9).

Loads and validates the file, and computes two hashes:
- query hash: sha256 of the canonical rendered query string (whitespace runs collapsed to one space, trimmed);
- config hash: sha256 of the parsed config as canonical JSON (sorted keys, dates as ISO strings). YAML comments
  and layout do not change it; any value does.

Every rendered query is `(<base>) AND language:<language>`. Compositions (race_either, race_both, any_either) are
declared under `compositions` and re-rendered here from their parts, so the stored strings cannot drift.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from typing import Any

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUERIES_DIR = os.path.join(ROOT, "config", "queries")
STATUSES = ("draft", "tuned", "frozen")
PHASES = ("tuning", "baseline", "analysis", "election")
# Queries that get per-source requests (breadth and top sources) when the file has no `per_source_queries` key.
DEFAULT_PER_SOURCE = ("talarico_race", "paxton_race", "race_either")
DERIVED_KINDS = {"share": ("numerator", "other"), "exclusive_share": ("numerator", "other", "both"),
                 "ratio": ("numerator", "denominator")}
NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
LOWER_OPS = re.compile(r"\b(and|or|not)\b")


class QueryConfigError(ValueError):
    """The Media Cloud query file is missing keys or has bad values."""


def canonical_query(q: str) -> str:
    return " ".join(str(q).split())


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def query_sha256(q: str) -> str:
    return sha256(canonical_query(q))


def wrap(base: str, language: str) -> str:
    """The one rendering rule: the base query in parentheses, then the language clause."""
    return "(%s) AND language:%s" % (canonical_query(base), language)


def unwrap(rendered: str, language: str) -> str | None:
    """The base query inside `(<base>) AND language:<language>`, or None if the string is not in that form."""
    q = canonical_query(rendered)
    tail = " AND language:%s" % language
    if not (q.startswith("(") and q.endswith(tail)):
        return None
    inner = q[: -len(tail)]
    depth = 0
    for i, ch in enumerate(_outside_quotes(inner)):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and i != len(inner) - 1:
                return None  # the first group closes before the end: "(a) OR (b) AND language:en"
    return inner[1:-1] if depth == 0 else None


def _outside_quotes(s: str) -> str:
    """s with every character inside double quotes replaced by a space (same length)."""
    out, inq = [], False
    for ch in s:
        if ch == '"':
            inq = not inq
            out.append(ch)
        else:
            out.append(" " if inq else ch)
    return "".join(out)


def syntax_problems(q: str) -> list[str]:
    """Checks that hold for any Media Cloud query: balanced quotes and parentheses, capitalized operators."""
    probs = []
    if q.count('"') % 2:
        probs.append("unbalanced double quotes")
    bare = _outside_quotes(q)
    depth = 0
    for ch in bare:
        depth += ch == "("
        depth -= ch == ")"
        if depth < 0:
            break
    if depth != 0:
        probs.append("unbalanced parentheses")
    low = LOWER_OPS.findall(bare)
    if low:
        probs.append("lower-case operator(s) %s outside quotes (AND, OR and NOT must be capitalized)"
                     % ", ".join(sorted(set(low))))
    return probs


@dataclass(frozen=True)
class Collection:
    key: str
    name: str | None
    id: int | None
    source_count: int | None = None
    looked_up_on: str | None = None

    @property
    def configured(self) -> bool:
        return self.id is not None


@dataclass(frozen=True)
class Derived:
    name: str
    kind: str
    refs: dict[str, str]


@dataclass(frozen=True)
class QueryConfig:
    race_id: str
    version: int
    status: str
    frozen_on: str | None
    language: str
    platform: str
    api_version: str | None
    timezone_note: str | None
    collections: tuple[Collection, ...]
    phases: dict[str, tuple[dt.date, dt.date]]
    queries: dict[str, str]  # name -> canonical rendered query, in file order
    compositions: dict[str, dict[str, Any]]
    derived_support: tuple[str, ...]
    derived: tuple[Derived, ...]
    audit: dict[str, Any]
    per_source_queries: tuple[str, ...]
    exclusions_log: tuple[Any, ...]
    changes_log: tuple[Any, ...]
    config_sha256: str
    path: str | None = field(default=None, compare=False)

    def query_hash(self, name: str) -> str:
        return query_sha256(self.queries[name])

    @property
    def configured_collections(self) -> list[Collection]:
        return [c for c in self.collections if c.configured]

    @property
    def unconfigured_collections(self) -> list[Collection]:
        return [c for c in self.collections if not c.configured]

    @property
    def core_queries(self) -> list[str]:
        return list(self.audit.get("core_queries") or [])

    def phase(self, name: str) -> tuple[dt.date, dt.date]:
        if name not in self.phases:
            raise QueryConfigError("unknown phase %r (have: %s)" % (name, ", ".join(self.phases)))
        return self.phases[name]

    def summary(self) -> dict[str, Any]:
        """What goes into the race JSON (no story data, only the criteria)."""
        return {"path": os.path.relpath(self.path, ROOT) if self.path and self.path.startswith(ROOT) else self.path,
                "version": self.version, "status": self.status, "frozen_on": self.frozen_on,
                "config_sha256": self.config_sha256, "language": self.language, "platform": self.platform,
                "api_version": self.api_version, "timezone_note": self.timezone_note,
                "phases": {k: [a.isoformat(), b.isoformat()] for k, (a, b) in self.phases.items()},
                "collections": {c.key: {"name": c.name, "id": c.id, "source_count": c.source_count,
                                        "looked_up_on": c.looked_up_on,
                                        "status": "configured" if c.configured else "not configured"}
                                for c in self.collections},
                "derived_support": list(self.derived_support),
                "per_source_queries": list(self.per_source_queries),
                "derived": {d.name: dict(d.refs, kind=d.kind) for d in self.derived},
                "exclusions_log": list(self.exclusions_log), "changes_log": list(self.changes_log)}


def path_for(race_id: str, queries_dir: str = QUERIES_DIR) -> str:
    return os.path.join(queries_dir, race_id + ".mediacloud.yaml")


def find(race_id: str, queries_dir: str = QUERIES_DIR) -> QueryConfig | None:
    """The race's query config if the file exists, else None (the connector then uses the old news_query path)."""
    p = path_for(race_id, queries_dir)
    return load(p) if os.path.isfile(p) else None


def _jsonable(o: Any) -> Any:
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (dt.date, dt.datetime)):
        return o.isoformat()
    return o


def config_hash(data: dict[str, Any]) -> str:
    return sha256(json.dumps(_jsonable(data), sort_keys=True, separators=(",", ":"), ensure_ascii=False))


def _date(v: Any, where: str) -> dt.date:
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    try:
        return dt.date.fromisoformat(str(v))
    except ValueError:
        raise QueryConfigError("%s: bad date %r (use YYYY-MM-DD)" % (where, v))


def load(path: str) -> QueryConfig:
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    try:
        return parse(data, path)
    except QueryConfigError as e:
        raise QueryConfigError("%s: %s" % (os.path.relpath(path, ROOT) if path.startswith(ROOT) else path, e))


def parse(data: Any, path: str | None = None) -> QueryConfig:
    if not isinstance(data, dict):
        raise QueryConfigError("expected a mapping at the top level")
    errs: list[str] = []
    for k in ("version", "status", "language", "collections", "phases", "queries"):
        if k not in data:
            errs.append("missing key %r" % k)
    if errs:
        raise QueryConfigError("; ".join(errs))
    version = data["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        errs.append("version must be a whole number >= 1")
    status = data["status"]
    if status not in STATUSES:
        errs.append("status must be one of %s" % ", ".join(STATUSES))
    frozen_on = data.get("frozen_on")
    if frozen_on is not None:
        frozen_on = _date(frozen_on, "frozen_on").isoformat()
    if status == "frozen" and frozen_on is None:
        errs.append("status frozen needs a frozen_on date")
    language = data["language"]
    if not isinstance(language, str) or not re.fullmatch(r"[a-z]{2}", language):
        errs.append("language must be a two-letter code")

    colls = []
    if not isinstance(data["collections"], dict) or not data["collections"]:
        errs.append("collections must be a non-empty mapping")
    else:
        for key, c in data["collections"].items():
            if not NAME_RE.match(str(key)) or not isinstance(c, dict):
                errs.append("collection %r: key must be lower_snake and the value a mapping" % key)
                continue
            cid = c.get("id")
            if cid is not None and (not isinstance(cid, int) or isinstance(cid, bool) or cid <= 0):
                errs.append("collection %s: id must be a positive integer or null" % key)
                continue
            if c.get("name") is not None and not isinstance(c["name"], str):
                errs.append("collection %s: name must be text or null" % key)
            looked = c.get("looked_up_on")
            colls.append(Collection(str(key), c.get("name"), cid, c.get("source_count"),
                                    _date(looked, "collection %s looked_up_on" % key).isoformat() if looked else None))
        if colls and not any(c.configured for c in colls):
            errs.append("no collection has an id")

    phases: dict[str, tuple[dt.date, dt.date]] = {}
    if not isinstance(data["phases"], dict):
        errs.append("phases must be a mapping")
    else:
        for name in PHASES:
            p = data["phases"].get(name)
            if not isinstance(p, dict) or "start" not in p or "end" not in p:
                errs.append("phase %s needs start and end" % name)
                continue
            a, b = _date(p["start"], "phase %s start" % name), _date(p["end"], "phase %s end" % name)
            if b < a:
                errs.append("phase %s ends before it starts" % name)
            phases[name] = (a, b)

    queries: dict[str, str] = {}
    if not isinstance(data["queries"], dict) or not data["queries"]:
        errs.append("queries must be a non-empty mapping")
    else:
        for name, q in data["queries"].items():
            if not NAME_RE.match(str(name)):
                errs.append("query name %r must be lower_snake" % name)
                continue
            if not isinstance(q, str) or not q.strip():
                errs.append("query %s is empty" % name)
                continue
            cq = canonical_query(q)
            for p in syntax_problems(cq):
                errs.append("query %s: %s" % (name, p))
            if unwrap(cq, language) is None:
                errs.append("query %s must have the form `(<query>) AND language:%s`" % (name, language))
            queries[str(name)] = cq

    comps = data.get("compositions") or {}
    for name, comp in comps.items():
        if name not in queries:
            errs.append("composition %s is not in queries" % name)
            continue
        if not isinstance(comp, dict) or comp.get("op") not in ("AND", "OR") or len(comp.get("of") or []) < 2:
            errs.append("composition %s needs op (AND or OR) and at least two queries in `of`" % name)
            continue
        parts = []
        for part in comp["of"]:
            if part not in queries:
                errs.append("composition %s uses unknown query %s" % (name, part))
                break
            parts.append(unwrap(queries[part], language))
        else:
            expect = wrap((" %s " % comp["op"]).join("(%s)" % p for p in parts), language)
            if queries[name] != expect:
                errs.append("query %s does not match its composition %s of %s; expected: %s"
                            % (name, comp["op"], ", ".join(comp["of"]), expect))

    support = tuple(data.get("derived_support") or ())
    for s in support:
        if s not in queries:
            errs.append("derived_support lists unknown query %s" % s)

    derived = []
    for name, d in (data.get("derived") or {}).items():
        if not NAME_RE.match(str(name)) or not isinstance(d, dict) or d.get("kind") not in DERIVED_KINDS:
            errs.append("derived %s needs kind in %s" % (name, ", ".join(DERIVED_KINDS)))
            continue
        if name in queries:
            errs.append("derived series name %s collides with a query name" % name)
        refs = {}
        for role in DERIVED_KINDS[d["kind"]]:
            if d.get(role) not in queries:
                errs.append("derived %s: %s must name a query (got %r)" % (name, role, d.get(role)))
            refs[role] = d.get(role)
        derived.append(Derived(str(name), d["kind"], refs))

    audit = dict(data.get("audit") or {})
    for q in audit.get("core_queries") or []:
        if q not in queries:
            errs.append("audit.core_queries lists unknown query %s" % q)
    n = audit.get("per_query_per_collection", 100)
    if not isinstance(n, int) or n < 1:
        errs.append("audit.per_query_per_collection must be a positive whole number")
    if "per_source_queries" in data:
        per_source = data["per_source_queries"] or []
        if not isinstance(per_source, list):
            errs.append("per_source_queries must be a list of query names")
            per_source = []
        for q in per_source:
            if q not in queries:
                errs.append("per_source_queries lists unknown query %s" % q)
    else:
        per_source = [q for q in DEFAULT_PER_SOURCE if q in queries]
    for k in ("exclusions_log", "changes_log"):
        if not isinstance(data.get(k) or [], list):
            errs.append("%s must be a list" % k)
    race_id = data.get("race_id")
    if path and race_id and not os.path.basename(path).startswith(str(race_id) + "."):
        errs.append("race_id %s does not match the file name %s" % (race_id, os.path.basename(path)))
    if errs:
        raise QueryConfigError("; ".join(errs))
    if not race_id and path:
        race_id = os.path.basename(path).split(".")[0]
    return QueryConfig(race_id=str(race_id), version=version, status=status, frozen_on=frozen_on, language=language,
                       platform=str(data.get("platform") or "onlinenews-mediacloud"),
                       api_version=data.get("api_version"), timezone_note=data.get("timezone_note"),
                       collections=tuple(colls), phases=phases, queries=queries, compositions=dict(comps),
                       derived_support=support, derived=tuple(derived), audit=audit,
                       per_source_queries=tuple(str(q) for q in per_source),
                       exclusions_log=tuple(data.get("exclusions_log") or ()),
                       changes_log=tuple(data.get("changes_log") or ()), config_sha256=config_hash(data), path=path)
