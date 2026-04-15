"""Recording engine for evolution and prediction processes.

Captures step-by-step snapshots during evolution/prediction runs so
they can be replayed in the public playback page.

Storage layout:
  /data/evolution/recordings/
    {rec_id}.json          — metadata (title, description, public, type, etc.)
    {rec_id}/
      step_{N}.json        — per-day aggregate snapshot
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid

logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
RECORDINGS_DIR = os.path.join(DATA_DIR, "recordings")


def _ensure_dir():
    os.makedirs(RECORDINGS_DIR, exist_ok=True)


def recover_stale_recordings():
    """Mark any recordings stuck in 'recording' status as 'failed'.

    Called on application startup to clean up recordings whose jobs were
    lost due to server restart, crash, or uvicorn reload.
    """
    _ensure_dir()
    count = 0
    for fname in os.listdir(RECORDINGS_DIR):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(RECORDINGS_DIR, fname)
        try:
            with open(path) as f:
                data = json.load(f)
            if data.get("status") == "recording":
                data["status"] = "failed"
                data["completed_at"] = time.time()
                with open(path, "w") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                count += 1
                logger.info(f"[recorder] Recovered stale recording {data.get('recording_id', fname)}: recording → failed")
        except Exception:
            continue
    if count:
        logger.info(f"[recorder] Recovered {count} stale recording(s) on startup")


# ── Metadata CRUD ───────────────────────────────────────────────────

def create_recording(
    title: str,
    description: str,
    rec_type: str = "evolution",    # "evolution" | "prediction"
    source_job_id: str = "",
    project_name: str = "",
) -> dict:
    """Create a new recording metadata file. Returns the recording dict."""
    _ensure_dir()
    rec_id = uuid.uuid4().hex[:10]
    rec = {
        "recording_id": rec_id,
        "project_name": project_name,
        "title": title,
        "description": description,
        "type": rec_type,
        "source_job_id": source_job_id,
        "is_public": False,
        "status": "recording",   # recording | completed | failed
        "total_steps": 0,
        "agent_count": 0,
        "created_at": time.time(),
        "completed_at": None,
        "agent_info": {},         # demographics summary
        "scenarios": [],          # for predictions
    }
    _save_meta(rec_id, rec)
    os.makedirs(os.path.join(RECORDINGS_DIR, rec_id), exist_ok=True)
    return rec


def _meta_path(rec_id: str) -> str:
    return os.path.join(RECORDINGS_DIR, f"{rec_id}.json")


def _save_meta(rec_id: str, data: dict):
    with open(_meta_path(rec_id), "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_recording(rec_id: str) -> dict | None:
    path = _meta_path(rec_id)
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)


def list_recordings(public_only: bool = False) -> list[dict]:
    _ensure_dir()
    results = []
    for fname in os.listdir(RECORDINGS_DIR):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(RECORDINGS_DIR, fname)) as f:
                data = json.load(f)
            if public_only and not data.get("is_public"):
                continue
            # Return summary (no step data)
            results.append({
                "recording_id": data["recording_id"],
                "project_name": data.get("project_name", ""),
                "title": data.get("title", ""),
                "description": data.get("description", ""),
                "type": data.get("type", "evolution"),
                "is_public": data.get("is_public", False),
                "status": data.get("status", "recording"),
                "total_steps": data.get("total_steps", 0),
                "agent_count": data.get("agent_count", 0),
                "created_at": data.get("created_at"),
                "completed_at": data.get("completed_at"),
                "scenarios": data.get("scenarios", []),
            })
        except Exception:
            continue
    results.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return results


def update_recording(rec_id: str, updates: dict) -> dict | None:
    rec = get_recording(rec_id)
    if not rec:
        return None
    rec.update(updates)
    _save_meta(rec_id, rec)
    return rec


def delete_recording(rec_id: str) -> bool:
    import shutil
    path = _meta_path(rec_id)
    if not os.path.isfile(path):
        return False
    os.remove(path)
    step_dir = os.path.join(RECORDINGS_DIR, rec_id)
    if os.path.isdir(step_dir):
        shutil.rmtree(step_dir)
    return True


# ── Step recording ──────────────────────────────────────────────────

def save_step(rec_id: str, step_num: int, step_data: dict):
    """Save a single step snapshot to the recording."""
    step_dir = os.path.join(RECORDINGS_DIR, rec_id)
    os.makedirs(step_dir, exist_ok=True)
    path = os.path.join(step_dir, f"step_{step_num:04d}.json")
    with open(path, "w") as f:
        json.dump(step_data, f, ensure_ascii=False)
    logger.info(f"[recorder] Saved step {step_num} for recording {rec_id} ({len(step_data.get('agents', []))} agent samples)")

    # Update total_steps in metadata
    try:
        rec = get_recording(rec_id)
        if rec and step_num > rec.get("total_steps", 0):
            rec["total_steps"] = step_num
            _save_meta(rec_id, rec)
    except Exception as e:
        logger.warning(f"[recorder] Failed to update metadata for {rec_id}: {e}")


def get_step(rec_id: str, step_num: int) -> dict | None:
    path = os.path.join(RECORDINGS_DIR, rec_id, f"step_{step_num:04d}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)


def get_all_steps(rec_id: str) -> list[dict]:
    """Load all steps for a recording (for playback)."""
    step_dir = os.path.join(RECORDINGS_DIR, rec_id)
    if not os.path.isdir(step_dir):
        return []
    # Collect all step files, sort numerically
    step_files = []
    for fname in os.listdir(step_dir):
        if fname.startswith("step_") and fname.endswith(".json"):
            try:
                num = int(fname.replace("step_", "").replace(".json", ""))
                step_files.append((num, fname))
            except ValueError:
                continue
    step_files.sort(key=lambda x: x[0])
    steps = []
    for _, fname in step_files:
        with open(os.path.join(step_dir, fname)) as f:
            steps.append(json.load(f))
    return steps


# ── Helper: build a step snapshot from evolution data ───────────────

def build_evolution_step(
    day: int,
    agents: list[dict],
    entries: list[dict],
    states: dict,
    news_articles: list[dict] | None = None,
    live_messages: list[str] | None = None,
    scenario_name: str = "",
    job: dict | None = None,
) -> dict:
    """Build a step snapshot dict from evolution day data.

    Captures aggregate stats, per-district breakdowns, per-leaning
    breakdowns, sampled agent details, plus richer context (candidate
    awareness/sentiment, cycle metadata, news pool size, live-message tail)
    for the playback dashboard.
    """
    # Build O(1) agent lookup — person_id can be int or str
    agent_map: dict[str, dict] = {}
    for a in agents:
        pid = str(a.get("person_id", ""))
        if pid:
            agent_map[pid] = a

    def _get_agent(entry: dict) -> dict | None:
        aid = str(entry.get("agent_id", ""))
        return agent_map.get(aid)

    # Aggregate stats
    n = len(entries) or 1
    avg_local = sum(e.get("local_satisfaction", e.get("satisfaction", 50)) for e in entries) / n
    avg_national = sum(e.get("national_satisfaction", e.get("satisfaction", 50)) for e in entries) / n
    avg_anxiety = sum(e.get("anxiety", 50) for e in entries) / n

    # Per-district and per-leaning breakdown — single pass
    district_stats: dict[str, dict] = {}
    leaning_stats: dict[str, dict] = {}
    for e in entries:
        agent = _get_agent(e)
        dist = agent.get("district", "未知") if agent else "未知"
        lean = agent.get("political_leaning", "中立") if agent else "中立"
        local_sat = e.get("local_satisfaction", e.get("satisfaction", 50))
        nat_sat = e.get("national_satisfaction", e.get("satisfaction", 50))
        anx = e.get("anxiety", 50)

        if dist not in district_stats:
            district_stats[dist] = {"local_sat": [], "national_sat": [], "anxiety": [], "count": 0}
        ds = district_stats[dist]
        ds["local_sat"].append(local_sat)
        ds["national_sat"].append(nat_sat)
        ds["anxiety"].append(anx)
        ds["count"] += 1

        if lean not in leaning_stats:
            leaning_stats[lean] = {"local_sat": [], "national_sat": [], "anxiety": [], "count": 0}
        ls = leaning_stats[lean]
        ls["local_sat"].append(local_sat)
        ls["national_sat"].append(nat_sat)
        ls["anxiety"].append(anx)
        ls["count"] += 1

    district_summary = {}
    for dist, ds in district_stats.items():
        c = ds["count"] or 1
        district_summary[dist] = {
            "count": ds["count"],
            "avg_local_satisfaction": round(sum(ds["local_sat"]) / c, 1),
            "avg_national_satisfaction": round(sum(ds["national_sat"]) / c, 1),
            "avg_anxiety": round(sum(ds["anxiety"]) / c, 1),
        }

    leaning_summary = {}
    for lean, ls in leaning_stats.items():
        c = ls["count"] or 1
        leaning_summary[lean] = {
            "count": ls["count"],
            "avg_local_satisfaction": round(sum(ls["local_sat"]) / c, 1),
            "avg_national_satisfaction": round(sum(ls["national_sat"]) / c, 1),
            "avg_anxiety": round(sum(ls["anxiety"]) / c, 1),
        }

    # All agent details with full diary for playback
    agent_samples = []
    for e in entries:
        agent = _get_agent(e)
        agent_samples.append({
            "agent_id": e.get("agent_id"),
            "name": agent.get("name", "") if agent else "",
            "district": agent.get("district", "") if agent else "",
            "age": agent.get("age", "") if agent else "",
            "gender": agent.get("gender", "") if agent else "",
            "political_leaning": e.get("political_leaning", agent.get("political_leaning", "") if agent else ""),
            "occupation": agent.get("occupation", "") if agent else "",
            "education": agent.get("education", "") if agent else "",
            "income": agent.get("income_level", "") if agent else "",
            "race": agent.get("race", "") if agent else "",
            "hispanic_or_latino": agent.get("hispanic_or_latino", "") if agent else "",
            "household_income": agent.get("household_income", "") if agent else "",
            "household_type": agent.get("household_type", "") if agent else "",
            "local_satisfaction": e.get("local_satisfaction", e.get("satisfaction", 50)),
            "national_satisfaction": e.get("national_satisfaction", e.get("satisfaction", 50)),
            "anxiety": e.get("anxiety", 50),
            "diary_text": e.get("diary_text", "") or "",
            "reasoning": e.get("reasoning", "") or "",
            "news_relevance": e.get("news_relevance", ""),
            "fed_titles": e.get("fed_titles", [])[:5],
            "life_event": e.get("life_event"),
            "llm_vendor": e.get("llm_vendor", ""),
        })

    # ── Richer news summary: keep more articles + more metadata ──
    # Include date, channel, impact_score, candidate_sentiment so the
    # playback can render a "what news happened today" feed and link
    # articles to candidates.
    news_summary = []
    if news_articles:
        # Pick top-30 by impact score (fall back to original order)
        sorted_news = sorted(
            news_articles,
            key=lambda a: -(a.get("impact_score") or 0),
        )[:30]
        for a in sorted_news:
            news_summary.append({
                "title": a.get("title", ""),
                "source_tag": a.get("source_tag", ""),
                "leaning": a.get("leaning", ""),
                "channel": a.get("channel", ""),
                "date": a.get("date", "") or a.get("_parsed_date", ""),
                "impact_score": a.get("impact_score") or 0,
                "assigned_day": a.get("assigned_day"),
                "candidate_sentiment": a.get("candidate_sentiment", {}),
            })

    # ── Candidate awareness + sentiment summary (per-leaning aggregation) ──
    # Reads ``candidate_awareness`` and ``candidate_sentiment`` from each
    # agent's state and aggregates by political_leaning. This is the data
    # the playback needs to show "張啓楷 awareness=99% +0.09" per leaning.
    candidate_awareness_summary: dict[str, dict] = {}
    if states:
        # Build leaning lookup from agent_map
        agent_leaning_lookup: dict[str, str] = {}
        for pid, agent in agent_map.items():
            agent_leaning_lookup[pid] = agent.get("political_leaning", "中立")

        # Collect awareness/sentiment per candidate per leaning
        # Structure: cand_name -> leaning -> {aware_sum, sent_sum, count}
        per_cand: dict[str, dict[str, dict]] = {}
        for sid, st in states.items():
            if not isinstance(st, dict):
                continue
            cw = st.get("candidate_awareness") or {}
            cs = st.get("candidate_sentiment") or {}
            lean = agent_leaning_lookup.get(str(sid), "中立")
            for cn, aval in cw.items():
                if cn not in per_cand:
                    per_cand[cn] = {}
                if lean not in per_cand[cn]:
                    per_cand[cn][lean] = {"aw_sum": 0.0, "se_sum": 0.0, "count": 0}
                per_cand[cn][lean]["aw_sum"] += float(aval or 0)
                per_cand[cn][lean]["se_sum"] += float(cs.get(cn, 0) or 0)
                per_cand[cn][lean]["count"] += 1

        # Compute averages
        for cn, lean_data in per_cand.items():
            candidate_awareness_summary[cn] = {}
            for lean, d in lean_data.items():
                c = d["count"] or 1
                candidate_awareness_summary[cn][lean] = {
                    "avg_awareness": round(d["aw_sum"] / c, 3),
                    "avg_sentiment": round(d["se_sum"] / c, 3),
                    "count": d["count"],
                }
            # Also add overall (all leanings combined)
            total_aw = sum(d["aw_sum"] for d in lean_data.values())
            total_se = sum(d["se_sum"] for d in lean_data.values())
            total_n = sum(d["count"] for d in lean_data.values()) or 1
            candidate_awareness_summary[cn]["__all__"] = {
                "avg_awareness": round(total_aw / total_n, 3),
                "avg_sentiment": round(total_se / total_n, 3),
                "count": total_n,
            }

    # ── Cycle / time-compression / keyword-layer context (from job) ──
    cycle_info: dict = {}
    keyword_layers: dict = {}
    compression_info: dict = {}
    if job:
        # Capture whatever the cycle loop has stashed on the job
        cycle_info = {
            "current_day": job.get("current_day"),
            "total_days": job.get("total_days"),
            "phase": job.get("phase", ""),
        }
        # These fields are not always set, but capture if present
        for k in ("cycle_idx", "num_cycles", "interval", "county"):
            if k in job:
                cycle_info[k] = job[k]
        # Keyword layer counts (set in main.py logging)
        for k in ("L1_local", "L1_national", "L2_local", "L2_national",
                  "L3_local", "L3_national", "LLM_local", "LLM_national"):
            if k in job:
                keyword_layers[k] = job[k]
        # Compression info
        for k in ("compression_ratio", "news_range_start", "news_range_end"):
            if k in job:
                compression_info[k] = job[k]

    # Voting stats if available in states
    vote_stats: dict = {}
    for key, st in (states or {}).items():
        vote = st.get("vote_intention") or st.get("candidate_preference")
        if vote:
            vote_stats[vote] = vote_stats.get(vote, 0) + 1

    return {
        "day": day,
        "scenario": scenario_name,
        "timestamp": time.time(),
        "aggregate": {
            "avg_local_satisfaction": round(avg_local, 1),
            "avg_national_satisfaction": round(avg_national, 1),
            "avg_anxiety": round(avg_anxiety, 1),
            "entries_count": len(entries),
        },
        "districts": district_summary,
        "leanings": leaning_summary,
        "vote_stats": vote_stats,
        "agents": agent_samples,
        "news": news_summary,
        # Tail of live messages (last 20) so playback can show what
        # was happening at this moment without bloating the file
        "live_messages": (live_messages or [])[-20:],
        # ── New rich-context fields (graceful fallback if missing) ──
        "candidate_awareness_summary": candidate_awareness_summary,
        "cycle_info": cycle_info,
        "keyword_layers": keyword_layers,
        "compression_info": compression_info,
        "news_pool_size": len(news_articles or []),
    }
