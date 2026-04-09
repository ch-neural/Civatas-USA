"""Civatas i18n helper for Python services."""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

LOCALES_DIR = Path(__file__).parent / "locales"
DEFAULT_LOCALE = os.getenv("DEFAULT_LOCALE", "zh-TW")


@lru_cache(maxsize=8)
def load_messages(locale: str | None = None) -> dict:
    locale = locale or DEFAULT_LOCALE
    path = LOCALES_DIR / f"{locale}.json"
    if not path.exists():
        path = LOCALES_DIR / f"{DEFAULT_LOCALE}.json"
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def t(key: str, locale: str | None = None) -> str:
    """Get a translated string by dot-separated key.

    Example: t("nav.projects") -> "專案管理" (zh-TW)
    """
    messages = load_messages(locale)
    parts = key.split(".")
    node = messages
    for part in parts:
        if isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return key
    return str(node)
