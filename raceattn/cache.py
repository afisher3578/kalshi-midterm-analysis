"""Disk cache for raw API responses and the query hash.

Layout: <raw_dir>/<source>/<race_id>/<window_label>/<query_hash>/<name>.json
Only the request (endpoint and params), fetch time, HTTP status and the JSON body are stored.
Headers, tokens and keys are never written.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Any

HASH_LEN = 16


def canonical_query(endpoint: str, params: dict[str, Any] | None = None) -> str:
    """Stable text form of a request: endpoint plus params sorted by key."""
    return json.dumps({"endpoint": endpoint, "params": params or {}}, sort_keys=True, separators=(",", ":"))


def query_hash(endpoint: str, params: dict[str, Any] | None = None) -> str:
    return hashlib.sha256(canonical_query(endpoint, params).encode("utf-8")).hexdigest()[:HASH_LEN]


def combine_hashes(hashes: list[str]) -> str:
    """Hash of several query hashes (order independent), for series built from several requests."""
    return hashlib.sha256("|".join(sorted(hashes)).encode("utf-8")).hexdigest()[:HASH_LEN]


class Cache:
    def __init__(self, root: str):
        self.root = root

    def dir_for(self, source: str, race_id: str, window_label: str, qhash: str) -> str:
        return os.path.join(self.root, source, race_id, window_label, qhash)

    def path(self, source: str, race_id: str, window_label: str, qhash: str, name: str) -> str:
        return os.path.join(self.dir_for(source, race_id, window_label, qhash), name + ".json")

    def get(self, path: str) -> dict[str, Any] | None:
        if not os.path.isfile(path):
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def put(self, path: str, record: dict[str, Any]) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=1, sort_keys=True)
            f.write("\n")
        os.replace(tmp, path)
