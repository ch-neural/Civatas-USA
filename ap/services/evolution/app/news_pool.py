"""Central news pool: in-memory store for crawled articles.

For production, swap with a persistent DB (PostgreSQL / SQLite).
For MVP, a JSON file + in-memory dict works well.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

from .crawler import CrawledArticle, CrawlSource, build_default_sources, _make_id

logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
SOURCES_FILE = os.path.join(DATA_DIR, "sources.json")
POOL_FILE = os.path.join(DATA_DIR, "news_pool.json")  # legacy global
POOLS_DIR = os.path.join(DATA_DIR, "news_pools")
MAX_POOL_SIZE = 1000  # FIFO cap — oldest articles are trimmed first

# ── Active workspace tracking ───────────────────────────────────────
_active_workspace_id: str = ""


def set_active_workspace(ws_id: str):
    """Set the active workspace for news pool scoping."""
    global _active_workspace_id, _pool
    if ws_id != _active_workspace_id:
        _active_workspace_id = ws_id
        _pool = []  # Force reload from correct file
        _load_pool()
        logger.info(f"News pool switched to workspace: {ws_id or 'global'}")


def _pool_file() -> str:
    """Return the pool file path for the active workspace."""
    if _active_workspace_id:
        os.makedirs(POOLS_DIR, exist_ok=True)
        return os.path.join(POOLS_DIR, f"{_active_workspace_id}.json")
    return POOL_FILE


def _ensure_dir():
    os.makedirs(DATA_DIR, exist_ok=True)


# ── Source management ────────────────────────────────────────────────

_sources: list[CrawlSource] = []


def _load_sources() -> list[CrawlSource]:
    """Load source list from disk, initialising with defaults if absent."""
    global _sources
    _ensure_dir()
    if os.path.isfile(SOURCES_FILE):
        with open(SOURCES_FILE) as f:
            raw = json.load(f)
        _sources = [CrawlSource(**s) for s in raw]
    else:
        _sources = build_default_sources()
        _save_sources()
    return _sources


def _save_sources():
    _ensure_dir()
    with open(SOURCES_FILE, "w") as f:
        json.dump([_as_dict(s) for s in _sources], f, ensure_ascii=False, indent=2)


def _as_dict(obj) -> dict:
    if hasattr(obj, "__dataclass_fields__"):
        from dataclasses import asdict
        return asdict(obj)
    return dict(obj)


def get_sources() -> list[dict]:
    if not _sources:
        _load_sources()
    return [_as_dict(s) for s in _sources]


def add_source(
    name: str,
    url: str,
    tag: str,
    selector_title: str = "h1, h2, h3, article a",
    selector_summary: str = "p",
    max_items: int = 10,
) -> dict:
    """Add a user-provided URL as a crawl source."""
    if not _sources:
        _load_sources()
    src = CrawlSource(
        source_id=_make_id(url),
        name=name,
        url=url,
        tag=tag,
        selector_title=selector_title,
        selector_summary=selector_summary,
        max_items=max_items,
        is_default=False,
    )
    _sources.append(src)
    _save_sources()
    return _as_dict(src)


def remove_source(source_id: str) -> bool:
    """Remove a source by its ID. Cannot remove defaults."""
    if not _sources:
        _load_sources()
    for i, s in enumerate(_sources):
        if s.source_id == source_id:
            if s.is_default:
                return False  # protect defaults
            _sources.pop(i)
            _save_sources()
            return True
    return False


def update_source(source_id: str, **kwargs) -> dict | None:
    """Update fields on an existing source (e.g. max_items)."""
    if not _sources:
        _load_sources()
    for s in _sources:
        if s.source_id == source_id:
            for k, v in kwargs.items():
                if hasattr(s, k) and k not in ("source_id", "is_default"):
                    setattr(s, k, v)
            _save_sources()
            return _as_dict(s)
    return None


def get_crawl_sources() -> list[CrawlSource]:
    """Return actual CrawlSource objects for the crawler."""
    if not _sources:
        _load_sources()
    return list(_sources)


# ── News pool ────────────────────────────────────────────────────────

_pool: list[dict] = []


def _load_pool():
    global _pool
    _ensure_dir()
    pf = _pool_file()
    if os.path.isfile(pf):
        with open(pf) as f:
            _pool = json.load(f)
    else:
        _pool = []


def _save_pool():
    _ensure_dir()
    pf = _pool_file()
    os.makedirs(os.path.dirname(pf), exist_ok=True)
    with open(pf, "w") as f:
        json.dump(_pool, f, ensure_ascii=False, indent=2)


def get_pool() -> list[dict]:
    if not _pool:
        _load_pool()
    return list(_pool)


def _trim_pool():
    """Keep only the newest MAX_POOL_SIZE articles, balanced across channels.

    Without balancing, trim falls back to insertion order (because most
    articles share the same crawled_at) and the channel iterated first
    crowds out the others. We instead split by channel, sort each bucket
    by crawled_at desc, and round-robin pick until we hit MAX_POOL_SIZE.
    """
    global _pool
    if len(_pool) <= MAX_POOL_SIZE:
        return

    from collections import defaultdict
    buckets: dict[str, list] = defaultdict(list)
    for a in _pool:
        buckets[a.get("channel", "") or "_unknown"].append(a)
    for ch in buckets:
        buckets[ch].sort(key=lambda a: float(a.get("crawled_at", 0) or 0), reverse=True)

    kept: list = []
    cursors = {ch: 0 for ch in buckets}
    channels = list(buckets.keys())
    while len(kept) < MAX_POOL_SIZE:
        progressed = False
        for ch in channels:
            if cursors[ch] < len(buckets[ch]):
                kept.append(buckets[ch][cursors[ch]])
                cursors[ch] += 1
                progressed = True
                if len(kept) >= MAX_POOL_SIZE:
                    break
        if not progressed:
            break

    trimmed = len(_pool) - len(kept)
    _pool = kept
    if trimmed > 0:
        logger.info(f"Trimmed {trimmed} old articles from pool (cap={MAX_POOL_SIZE}, channel-balanced)")


def replace_pool(articles: list[CrawledArticle]):
    """Replace the entire pool with freshly crawled articles."""
    global _pool
    _pool = [_as_dict(a) for a in articles]
    _trim_pool()
    _save_pool()
    logger.info(f"News pool updated: {len(_pool)} articles")


def inject_article(title: str, summary: str, source_tag: str = "手動注入", source_leaning: str = "中立") -> dict:
    """Manually inject a breaking-news event into the pool (God mode)."""
    if not _pool:
        _load_pool()
    article = {
        "article_id": uuid.uuid4().hex[:12],
        "title": title,
        "summary": summary,
        "source_url": "manual://inject",
        "source_tag": source_tag,
        "source_leaning": source_leaning,
        "crawled_at": datetime.now(timezone.utc).isoformat(),
    }
    _pool.append(article)
    _trim_pool()
    _save_pool()
    return article
