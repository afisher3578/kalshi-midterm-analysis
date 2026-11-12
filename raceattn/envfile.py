""".env support: `<repo root>/.env` (git-ignored) is read at startup by the CLI.

Stdlib parser for `NAME=value` lines (an optional `export ` prefix, `#` comments, single or double quotes around
the value). A variable already in the environment is never overridden, and empty values are not set. Values are
never printed or logged; only the names of the variables that were set are returned.
"""
from __future__ import annotations

import os
import re
from typing import MutableMapping

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(ROOT, ".env")
LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def parse(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = LINE_RE.match(line)
        if not m:
            continue  # not a NAME=value line; skipped without echoing it (it could hold a secret)
        name, val = m.group(1), m.group(2)
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        else:
            val = re.split(r"\s+#", val, maxsplit=1)[0].strip()
        out[name] = val
    return out


def load_env(path: str | None = None, environ: MutableMapping[str, str] | None = None) -> list[str]:
    """Set variables from the .env file that are not already set. Returns the names set (never the values)."""
    path = path or ENV_PATH
    environ = os.environ if environ is None else environ
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8-sig") as f:
        values = parse(f.read())
    loaded = []
    for name, val in values.items():
        if val and name not in environ:
            environ[name] = val
            loaded.append(name)
    return loaded
