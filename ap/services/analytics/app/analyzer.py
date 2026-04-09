"""Analyze OASIS simulation results."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


def analyze_interviews(
    db_path: str, group_by: list[str] = []
) -> dict[str, Any]:
    """Read interview traces from an OASIS .db and return summary stats.

    Returns overall results and optionally grouped results.
    """
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        cursor.execute(
            "SELECT user_id, info, created_at FROM trace "
            "WHERE action = 'interview' ORDER BY created_at"
        )
        rows = cursor.fetchall()
        conn.close()
    except Exception as e:
        return {"error": str(e), "interviews": [], "summary": {}}

    interviews = []
    for user_id, info_json, timestamp in rows:
        try:
            info = json.loads(info_json)
        except json.JSONDecodeError:
            info = {"raw": info_json}
        interviews.append({
            "user_id": user_id,
            "prompt": info.get("prompt", ""),
            "response": info.get("response", ""),
            "timestamp": timestamp,
        })

    return {
        "total_interviews": len(interviews),
        "interviews": interviews,
        "summary": {},  # TODO: implement classification & grouping
    }
