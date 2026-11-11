"""Project-wide settings from config/project.yaml (licensing flag, default sources, connector settings)."""
from __future__ import annotations

import os
from typing import Any

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_CONFIG = os.path.join(ROOT, "config", "project.yaml")

DEFAULTS: dict[str, Any] = {
    "licensing_confirmed": False,
    "funding_disclosure_enabled": False,
    "funding_disclosure_text": "",
    "default_sources": ["kalshi", "wikipedia"],
    "connectors": {},
    "events": {"window_days": 2, "spike_threshold": 1.0, "reversion_days": 3, "reversion_fraction": 0.5,
               "min_price_move": 0.01},
}


def load_settings(path: str = PROJECT_CONFIG) -> dict[str, Any]:
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULTS.items()}
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        for k, v in data.items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k].update(v)
            else:
                out[k] = v
    return out
