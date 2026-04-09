"""News Fetch persistence store.

Saves raw news fetch results to JSON files in /data/evolution/news_fetches/
so they can be reloaded across calibration sessions.
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid

logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
NEWS_FETCH_DIR = os.path.join(DATA_DIR, "news_fetches")


def _ensure_dir():
    os.makedirs(NEWS_FETCH_DIR, exist_ok=True)


def save_news_fetch(
    query: str,
    start_date: str,
    end_date: str,
    events: list[dict],
    social_events: list[dict] | None = None,
) -> dict:
    """Save a news fetch result.

    Args:
        query: The search query (multi-line topics)
        start_date: YYYY-MM-DD
        end_date: YYYY-MM-DD
        events: News events from LLM (list of {date, title, summary, category, source, source_type})
        social_events: Social events (optional)

    Returns:
        The saved fetch metadata dict.
    """
    _ensure_dir()
    fetch_id = uuid.uuid4().hex[:8]

    all_events = list(events)
    if social_events:
        all_events.extend(social_events)

    # Build summary label
    topics = [line.strip() for line in query.strip().split("\n") if line.strip()]
    label = " / ".join(topics[:3])
    if len(topics) > 3:
        label += f" …(+{len(topics) - 3})"

    fetch = {
        "fetch_id": fetch_id,
        "label": label,
        "query": query,
        "start_date": start_date,
        "end_date": end_date,
        "news_count": len(events),
        "social_count": len(social_events) if social_events else 0,
        "total_count": len(all_events),
        "events": all_events,
        "created_at": time.time(),
    }

    path = os.path.join(NEWS_FETCH_DIR, f"{fetch_id}.json")
    with open(path, "w") as f:
        json.dump(fetch, f, ensure_ascii=False, indent=2)
    logger.info(f"News fetch saved: {fetch_id} ({label}) — {len(all_events)} events")
    return {
        "fetch_id": fetch_id,
        "label": label,
        "news_count": len(events),
        "social_count": len(social_events) if social_events else 0,
        "total_count": len(all_events),
        "created_at": fetch["created_at"],
    }


def list_news_fetches() -> list[dict]:
    """List all saved news fetches (summary only)."""
    _ensure_dir()
    results = []
    for fname in sorted(os.listdir(NEWS_FETCH_DIR)):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(NEWS_FETCH_DIR, fname)) as f:
                data = json.load(f)
            results.append({
                "fetch_id": data["fetch_id"],
                "label": data.get("label", ""),
                "query": data.get("query", ""),
                "start_date": data.get("start_date", ""),
                "end_date": data.get("end_date", ""),
                "news_count": data.get("news_count", 0),
                "social_count": data.get("social_count", 0),
                "total_count": data.get("total_count", 0),
                "created_at": data.get("created_at"),
            })
        except Exception:
            continue
    results.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return results


def get_news_fetch(fetch_id: str) -> dict | None:
    """Get full news fetch data."""
    path = os.path.join(NEWS_FETCH_DIR, f"{fetch_id}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)


def delete_news_fetch(fetch_id: str) -> bool:
    """Delete a news fetch."""
    path = os.path.join(NEWS_FETCH_DIR, f"{fetch_id}.json")
    if not os.path.isfile(path):
        return False
    os.remove(path)
    return True
