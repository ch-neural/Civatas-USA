"""Export agent records to OASIS-compatible formats."""
from __future__ import annotations

import io
import json

import pandas as pd


def to_twitter_csv(agents: list[dict], edges: list[dict] = []) -> str:
    """Convert agent dicts to OASIS Twitter CSV string."""
    following_map: dict[int, list[int]] = {}
    for e in edges:
        following_map.setdefault(e["follower"], []).append(e["followee"])

    rows = []
    for a in agents:
        pid = a.get("person_id", 0)
        rows.append({
            "name": a.get("name", f"user_{pid}"),
            "username": a.get("username", f"civatas_{pid:05d}"),
            "user_char": a.get("user_char", ""),
            "description": a.get("description", ""),
            "following_agentid_list": str(following_map.get(pid, [])),
            "previous_tweets": "[]",
        })

    df = pd.DataFrame(rows)
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    return buf.getvalue()


def to_reddit_json(agents: list[dict]) -> str:
    """Convert agent dicts to OASIS Reddit JSON string."""
    records = []
    for a in agents:
        records.append({
            "realname": a.get("name", ""),
            "username": a.get("username", ""),
            "bio": a.get("description", ""),
            "persona": a.get("user_char", ""),
            "age": a.get("age", 30),
            "gender": a.get("gender", "unknown"),
            "mbti": a.get("mbti", "ISTJ"),
            "country": a.get("country", ""),
        })
    return json.dumps(records, ensure_ascii=False, indent=2)
