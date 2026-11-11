import importlib.util
import os

from tests.conftest import ROOT

spec = importlib.util.spec_from_file_location("check_secrets", os.path.join(ROOT, "scripts", "check_secrets.py"))
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)


def test_repo_has_no_secrets():
    hits = cs.scan(cs.default_targets())
    assert hits == [], "possible secrets: %s" % [(os.path.relpath(p, ROOT), l, n) for p, l, n in hits]


def test_patterns_catch_examples():
    # built at runtime so this file itself never matches
    samples = [
        "Authorization: " + "Bearer " + "abcDEF0123456789abcDEF0123456789",
        "OPENAI=" + "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2",
        "A" * 22 + "%2Fabc1234567890abcdefghij",
        "GUARDIAN_API_KEY" + "=" + "0123456789abcdef0123456789abcdef",
        "token" + ": " + "QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVuIHNlc2FtZQ==",
        "NYT_API_KEY" + "=" + "abcd1234efgh",
        "BSKY_APP_PASSWORD" + "=" + "abcd-efgh-ijkl-mnop",
        "https://content.guardianapis.com/search?q=x&" + "api-key=" + "0f1e2d3c-4b5a-6978-8a9b",
        "Authorization: " + "Token " + "0123456789abcdef0123456789abcdef01234567",
        "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiJkaWQ6cGxjIn0" + "." + "c2lnbmF0dXJlLXZhbHVl",
    ]
    for s in samples:
        assert cs.scan_text(s), s


def test_patterns_ignore_benign():
    benign = [
        "X_BEARER_TOKEN=",
        '"query_hash": "3a78a4d7647fd9c4"',
        "Token goes through an Authorization header from an environment variable",
        "api_key = os.environ.get('MEDIACLOUD_API_KEY')",
        "BSKY_APP_PASSWORD=",
        "X_BEARER_TOKEN" + "=fake-$(uuidgen) python -m raceattn run",  # shell substitution, not a value
        '"cursor": "eyJzIjpbMTc5MDg5NDcxODAwMCwiZGlkOnBsYzplb2FneGZvbzZnanhodW5sZmVscGJkeXAiXX0"',
        '"trade_id": "07273658-a2b9-964e-6d5b-6d5587f6b376"',
        'return {"Authorization": "Bearer " + self._access}',
    ]
    for s in benign:
        assert not cs.scan_text(s), s
