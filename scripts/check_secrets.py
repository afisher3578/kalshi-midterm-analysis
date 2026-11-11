#!/usr/bin/env python3
"""Fail if any file looks like it contains a key or token.

Usage:
  python scripts/check_secrets.py            scan tracked files plus data/processed and data/raw
  python scripts/check_secrets.py --staged   scan files staged for commit (pre-commit hook)
  python scripts/check_secrets.py PATH ...   scan the given files or directories

Install as a pre-commit hook:
  ln -sf ../../scripts/hooks/pre-commit .git/hooks/pre-commit
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PATTERNS = [
    ("bearer token", re.compile(r"Bearer\s+[A-Za-z0-9\-._~+/%]{20,}=*")),
    ("sk- style key", re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}")),
    ("X app-only token", re.compile(r"A{10,}[A-Za-z0-9%]{20,}")),
    ("key/token assignment", re.compile(
        r"(?i)\b[A-Z0-9_]*(?:api[_-]?key|access[_-]?token|bearer[_-]?token|secret|password|client[_-]?secret|token)"
        r"[\"']?\s*[=:]\s*[\"']?(?:[A-Fa-f0-9]{24,}|[A-Za-z0-9+/_\-]{32,}={0,2})")),
    ("private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    # M2 key formats
    ("env key with a value", re.compile(
        r"\b(?:X_BEARER_TOKEN|MEDIACLOUD_API_KEY|GUARDIAN_API_KEY|NYT_API_KEY|BSKY_APP_PASSWORD|REDDIT_CLIENT_SECRET"
        r"|YOUTUBE_API_KEY)\s*=\s*[\"']?(?![^\s\"'#]*\$)[^\s\"'#]{8,}")),
    ("api-key in a URL", re.compile(r"[?&]api[-_]key=[A-Za-z0-9\-_]{12,}")),
    ("Media Cloud style token header", re.compile(r"\bToken\s+[A-Fa-f0-9]{30,}")),
    ("JWT (e.g. Bluesky session token)", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
]
# Wikipedia wikitext caches hold citation URLs from third-party sites with public token query parameters
# (seen for Oregon: ...cfDetail.do?...&OWASP_CSRFTOKEN=XXXX-...; Montana: ...?task=file.download&token=<hex>).
# They are page content, fetched with no key of ours. In those cache directories only, a token-named query
# parameter inside a URL is blanked before the patterns run; everything else is still scanned.
WIKITEXT_DIRS = (os.sep + "wikipedia_events" + os.sep, os.sep + "wikipedia_discovery" + os.sep)
WIKITEXT_EXEMPT = re.compile(r"(https?://[^\s|\]}\"]*?[?&])[A-Za-z_]*token=[A-Za-z0-9\-]+", re.I)
SKIP_DIRS = {".git", ".venv", "__pycache__", ".pytest_cache", "node_modules"}
MAX_BYTES = 20 * 1024 * 1024


def scan_text(text: str, wikitext: bool = False) -> list[tuple[str, int]]:
    hits = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if wikitext:
            line = WIKITEXT_EXEMPT.sub(r"\1", line)
        for label, rx in PATTERNS:
            if rx.search(line):
                hits.append((label, lineno))
    return hits


def scan_file(path: str) -> list[tuple[str, str, int]]:
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return []
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return []
    if b"\0" in raw[:4096]:
        return []
    wikitext = any(d in path for d in WIKITEXT_DIRS)
    return [(path, label, ln) for label, ln in scan_text(raw.decode("utf-8", "replace"), wikitext)]


def iter_files(paths: list[str]):
    for p in paths:
        if os.path.isdir(p):
            for dirpath, dirnames, filenames in os.walk(p):
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
                for fn in filenames:
                    yield os.path.join(dirpath, fn)
        elif os.path.isfile(p):
            yield p


def tracked_files() -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    return [os.path.join(ROOT, f) for f in out.decode().split("\0") if f]


def staged_files() -> list[str]:
    out = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], cwd=ROOT,
                         capture_output=True, check=True).stdout
    return [os.path.join(ROOT, f) for f in out.decode().split("\0") if f]


def default_targets() -> list[str]:
    return tracked_files() + [os.path.join(ROOT, "data", "processed"), os.path.join(ROOT, "data", "raw")]


def scan(paths: list[str]) -> list[tuple[str, str, int]]:
    seen, hits = set(), []
    for f in iter_files(paths):
        f = os.path.abspath(f)
        if f in seen:
            continue
        seen.add(f)
        hits.extend(scan_file(f))
    return hits


def main(argv: list[str]) -> int:
    if argv[:1] == ["--staged"]:
        targets = staged_files()
    elif argv:
        targets = argv
    else:
        targets = default_targets()
    hits = scan(targets)
    for path, label, ln in hits:
        print("possible secret (%s): %s:%d" % (label, os.path.relpath(path, ROOT), ln), file=sys.stderr)
    if hits:
        print("check_secrets: %d finding(s). Remove the secret, or fix the pattern if it is a false positive." % len(hits),
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
