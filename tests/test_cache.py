import os

from raceattn.cache import Cache, canonical_query, combine_hashes, query_hash


def test_query_hash_stable_and_param_order_independent():
    a = query_hash("https://x/y", {"a": 1, "b": 2})
    b = query_hash("https://x/y", {"b": 2, "a": 1})
    assert a == b and len(a) == 16 and all(c in "0123456789abcdef" for c in a)


def test_query_hash_changes_with_endpoint_and_params():
    base = query_hash("https://x/y", {"a": 1})
    assert query_hash("https://x/z", {"a": 1}) != base
    assert query_hash("https://x/y", {"a": 2}) != base
    assert query_hash("https://x/y") != base


def test_canonical_query_text():
    assert canonical_query("e", {"b": 1, "a": "x"}) == '{"endpoint":"e","params":{"a":"x","b":1}}'


def test_combine_hashes_order_independent():
    assert combine_hashes(["a", "b"]) == combine_hashes(["b", "a"]) != combine_hashes(["a", "c"])


def test_cache_layout_and_roundtrip(tmp_path):
    c = Cache(str(tmp_path))
    p = c.path("kalshi", "tx-senate-2026", "20260901_20261104", "abc123", "chunk_1_2")
    assert p == os.path.join(str(tmp_path), "kalshi", "tx-senate-2026", "20260901_20261104", "abc123", "chunk_1_2.json")
    assert c.get(p) is None
    c.put(p, {"body": {"x": 1}})
    assert c.get(p) == {"body": {"x": 1}}


def test_cached_get_reuses_cache_and_refresh_refetches(tmp_path):
    from raceattn.config import load_race
    from raceattn.connectors.base import RenderedQuery
    from raceattn.connectors.wikipedia import WikipediaConnector

    class FakeHttp:
        calls = 0

        def get_json(self, url, params=None, ok_status=(200,)):
            FakeHttp.calls += 1
            return 200, {"items": []}

    race = load_race("tx-senate-2026")
    q = RenderedQuery("https://example.invalid/a", {"k": 1})
    c = WikipediaConnector(http=FakeHttp(), cache=Cache(str(tmp_path)))
    rec1 = c.cached_get(race, race.window, q, q.query_hash, "daily")
    rec2 = c.cached_get(race, race.window, q, q.query_hash, "daily")
    assert FakeHttp.calls == 1 and rec1 == rec2 and c.cache_hits == 1
    assert set(rec1) == {"request", "query_hash", "status", "fetched_at", "body"}  # never headers
    c2 = WikipediaConnector(http=FakeHttp(), cache=Cache(str(tmp_path)), refresh=True)
    c2.cached_get(race, race.window, q, q.query_hash, "daily")
    assert FakeHttp.calls == 2
