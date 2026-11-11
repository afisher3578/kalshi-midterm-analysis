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
    ]
    for s in samples:
        assert cs.scan_text(s), s


def test_patterns_ignore_benign():
    benign = [
        "X_BEARER_TOKEN=",
        '"query_hash": "3a78a4d7647fd9c4"',
        "Token goes through an Authorization header from an environment variable",
        "api_key = os.environ.get('MEDIACLOUD_API_KEY')",
    ]
    for s in benign:
        assert not cs.scan_text(s), s
