"""Calibration back-test engine.

Runs a historical simulation by injecting events (news) at specific days,
then compares simulated outcomes to ground truth to compute calibration scores.

Workflow:
  1. Upload historical event sequence (list of {day, news_items})
  2. Upload ground truth (e.g. vote percentages)
  3. Run calibration simulation → agents evolve through the event timeline
  4. Aggregate final agent states → compute MAE against ground truth
"""
from __future__ import annotations

import asyncio
import importlib
import json
import logging
import math
import os
import time
import uuid

logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
CALIBRATION_DIR = os.path.join(DATA_DIR, "calibrations")

# ── Date stripping for calibration news ──────────────────────────────

import re

# Patterns for dates commonly found in Taiwan news
_DATE_PATTERNS = [
    # Full dates: 2019年1月10日, 2018年12月25日
    re.compile(r"\d{4}年\d{1,2}月\d{1,2}日"),
    # Year-month: 2019年1月
    re.compile(r"\d{4}年\d{1,2}月"),
    # Year only in context: 2019年
    re.compile(r"\d{4}年"),
    # Slash dates: 2019/1/10, 2019/01/10
    re.compile(r"\d{4}/\d{1,2}/\d{1,2}"),
    # Dash dates: 2019-01-10
    re.compile(r"\d{4}-\d{1,2}-\d{1,2}"),
    # ROC calendar: 民國108年, 107年度
    re.compile(r"民國?\d{2,3}年(?:度)?"),
]

# Contextual replacements: "於2019年1月22日公布" → "近日公布"
_CONTEXT_PATTERNS = [
    (re.compile(r"於\d{4}年\d{1,2}月\d{1,2}日"), "近日"),
    (re.compile(r"在\d{4}年\d{1,2}月\d{1,2}日"), "近日"),
    (re.compile(r"\d{4}年\d{1,2}月\d{1,2}日[，,]"), "近日，"),
]


def _strip_dates(text: str) -> str:
    """Remove literal dates from calibration news so agents treat it as fresh.
    
    Examples:
        "2019年1月10日，台灣立法院..." → "近日，台灣立法院..."
        "主計總處於2019年1月22日公布" → "主計總處近日公布"
        "1994年北一女自殺案件" → "北一女自殺案件"
    """
    if not text:
        return text

    # Apply contextual replacements first (more specific)
    for pattern, replacement in _CONTEXT_PATTERNS:
        text = pattern.sub(replacement, text)

    # Then strip remaining standalone dates
    for pattern in _DATE_PATTERNS:
        text = pattern.sub("", text)

    # Clean up double spaces, leading commas, etc.
    text = re.sub(r"  +", " ", text)
    text = re.sub(r"^[，,、\s]+", "", text)
    text = text.strip()

    return text

# ── Irrelevant article filter ────────────────────────────────────────

_IRRELEVANT_BOARD_PATTERNS = [
    # Entertainment / Lifestyle
    "joke", "食記", "food", "beauty", "gossiping_fake",
    "stupidclown", "lifeismoney", "pokemongo",
    # Sports
    "baseball", "nba", "lol", "mma", "sportlottery",
    # Media / Gaming
    "c_chat", "marvel", "movie", "koreadrama", "japandrama",
    "youtuber", "steam", "playstation", "nintendo",
    # Tech / Cars / Hardware (non-political)
    "car", "biker", "mobilcomm", "pc_shopping", "hardware",
    # Other non-political boards
    "sex", "babymother", "home-sale", "womentalk",
    "headphone", "audiophile", "diy", "recipe",
    # Social media non-political
    "mobile01", "eprice",
]

_IRRELEVANT_TITLE_KEYWORDS = [
    "[趣事]", "[笑話]", "[食記]", "[遊記]", "[閒聊]",
    "[討論]", "[問題]", "[請益]", "[心得]", "[試用]", "[評測]",
    "波多野", "AV女優", "A片",
    "看板youtuber", "看板car", "看板sex",
    "看板biker", "看板mobilcomm", "看板pc_shopping",
    "看板hardware", "看板womentalk", "看板babymother",
    "看板home-sale", "看板recipe",
    "看板e-appliance", "看板air-quality", "看板lifeismoney",
    "看板headphone", "看板audiophile",
    # Product review / consumer content keywords
    "空氣清淨機", "清淨機", "Dyson", "Blueair", "HEPA",
    "濾網", "濾材", "除濕機", "全熱交換", "冷氣",
    "空氣循環", "居家生活板", "E-appliance",
]

# Content-level keywords that indicate non-political articles
_NOISE_CONTENT_KEYWORDS = [
    "空氣清淨機", "清淨機", "Dyson", "Blueair", "HEPA",
    "濾網大家都多久換", "濾材", "空氣循環清淨機", "空氣過濾",
    "前置濾箱", "除濕機or", "冷氣PM2.5",
    "居家生活板", "E-appliance", "考試板",
    "專技高考", "環境工程技師",
]


def _is_irrelevant_article(title: str, source_tag: str = "", summary: str = "") -> bool:
    """Return True if the article title / source / summary indicates non-political content."""
    title_lower = title.lower()
    source_lower = source_tag.lower()
    for pattern in _IRRELEVANT_BOARD_PATTERNS:
        if pattern in title_lower or pattern in source_lower:
            return True
    for kw in _IRRELEVANT_TITLE_KEYWORDS:
        if kw in title:
            return True
    # Content-level noise check
    text = title + " " + summary
    for kw in _NOISE_CONTENT_KEYWORDS:
        if kw in text:
            return True
    return False

# ── Calibration pack storage ─────────────────────────────────────────

def _ensure_dir():
    os.makedirs(CALIBRATION_DIR, exist_ok=True)


def save_calibration_pack(
    name: str,
    plugin_id: str,
    ground_truth: dict,
    enable_kol: bool = False,
    kol_ratio: float = 0.05,
    kol_reach: float = 0.40,
    candidate_info: dict | None = None,
    scoring_params: dict | None = None,
    macro_context: str | None = None,
    election_date: str | None = None,
) -> dict:
    """Save a calibration pack (events + ground truth).

    events: list of {day: int, news: [{title, summary, source_tag}]}
    ground_truth: {key: value, ...} keyed by the plugin's ground_truth_fields
    candidate_info: {candidateName: description} for trait-based scoring
    scoring_params: tunable heuristic scoring parameters
    macro_context: general political background string
    """
    _ensure_dir()
    pack_id = uuid.uuid4().hex[:8]
    pack = {
        "pack_id": pack_id,
        "name": name,
        "plugin_id": plugin_id,
        "election_date": election_date,
        "events": [],
        "ground_truth": ground_truth,
        "candidate_info": candidate_info or {},
        "scoring_params": scoring_params or {},
        "macro_context": macro_context or "",
        "enable_kol": enable_kol,
        "kol_ratio": kol_ratio,
        "kol_reach": kol_reach,
        "created_at": time.time(),
        "results": None,
    }
    path = os.path.join(CALIBRATION_DIR, f"{pack_id}.json")
    with open(path, "w") as f:
        json.dump(pack, f, ensure_ascii=False, indent=2)
    logger.info(f"Calibration pack saved: {pack_id} ({name})")
    return pack


def list_calibration_packs() -> list[dict]:
    """List all calibration packs (summary only)."""
    _ensure_dir()
    results = []
    for fname in sorted(os.listdir(CALIBRATION_DIR)):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(CALIBRATION_DIR, fname)) as f:
                data = json.load(f)
            results.append({
                "pack_id": data["pack_id"],
                "name": data["name"],
                "plugin_id": data.get("plugin_id", ""),
                "event_count": len(data.get("events", [])),
                "has_results": data.get("results") is not None,
                "score": data.get("results", {}).get("score") if data.get("results") else None,
                "election_date": data.get("election_date"),
                "created_at": data.get("created_at"),
            })
        except Exception:
            continue
    results.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return results


def get_calibration_pack(pack_id: str) -> dict | None:
    """Get full calibration pack."""
    path = os.path.join(CALIBRATION_DIR, f"{pack_id}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)


def delete_calibration_pack(pack_id: str) -> bool:
    """Delete a calibration pack."""
    path = os.path.join(CALIBRATION_DIR, f"{pack_id}.json")
    if not os.path.isfile(path):
        return False
    os.remove(path)
    return True


# ── Event redistribution ─────────────────────────────────────────────

def _redistribute_events(events: list[dict], target_days: int) -> list[dict]:
    """Spread events evenly across target_days with quiet days in between.
    
    - If fewer events than days: space them out (e.g. 10 events on 60 days → days 6,12,...,60)
    - If more events than days: merge multiple events into same day
    """
    if not events or target_days <= 0:
        return events

    # Sort by original day to preserve chronological order
    sorted_events = sorted(events, key=lambda e: e.get("day", 0))
    n = len(sorted_events)

    if n <= target_days:
        # Fewer events than days: spread evenly
        interval = target_days / n
        for i, ev in enumerate(sorted_events):
            ev["day"] = round(interval * (i + 1))
        return sorted_events
    else:
        # More events than days: merge into target_days buckets
        merged = []
        for d in range(target_days):
            start = (d * n) // target_days
            end = ((d + 1) * n) // target_days
            bucket = sorted_events[start:end]
            if not bucket:
                continue
            # Merge all news from this bucket into one event-day
            combined_news = []
            for ev in bucket:
                if "news" in ev and isinstance(ev["news"], list):
                    combined_news.extend(ev["news"])
                elif ev.get("title") or ev.get("summary"):
                    # Flat event format (e.g. from news_store): treat the event itself as a news item
                    combined_news.append(ev)
            merged.append({"day": d + 1, "news": combined_news})
        return merged


# ── Calibration run ──────────────────────────────────────────────────

CALIB_JOBS_DIR = os.path.join(DATA_DIR, "calib_jobs")

# Store for running calibration jobs
_calib_jobs: dict[str, dict] = {}
_calib_stops: dict[str, bool] = {}
_calib_cancel_events: dict[str, asyncio.Event] = {}
_calib_pauses: dict[str, bool] = {}

# ── Auto-calibration job store ───────────────────────────────────────
_auto_calib_jobs: dict[str, dict] = {}


def _ensure_jobs_dir():
    os.makedirs(CALIB_JOBS_DIR, exist_ok=True)


def _save_job_checkpoint(job: dict, agents: list[dict], pack: dict, current_day: int):
    """Persist paused job state to disk so it can survive a container restart."""
    _ensure_jobs_dir()
    checkpoint = {
        "job": {
            k: v for k, v in job.items()
            if k not in ("live_messages",)  # drop transient UI data
        },
        "current_day": current_day,
        "pack": pack,
        "agents": agents,
    }
    path = os.path.join(CALIB_JOBS_DIR, f"{job['job_id']}.json")
    with open(path, "w") as f:
        json.dump(checkpoint, f, ensure_ascii=False, indent=2)
    logger.info(f"Checkpoint saved for job {job['job_id']} at day {current_day}")


def _delete_job_checkpoint(job_id: str):
    path = os.path.join(CALIB_JOBS_DIR, f"{job_id}.json")
    if os.path.isfile(path):
        os.remove(path)


def list_calib_checkpoints() -> list[dict]:
    """List all persisted paused calibration jobs."""
    if not os.path.isdir(CALIB_JOBS_DIR):
        return []
    results = []
    for fname in sorted(os.listdir(CALIB_JOBS_DIR), reverse=True):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(CALIB_JOBS_DIR, fname)) as f:
                data = json.load(f)
            job = data.get("job", {})
            results.append({
                "job_id": job.get("job_id"),
                "pack_name": job.get("pack_name", ""),
                "current_day": data.get("current_day", 0),
                "total_days": job.get("max_day", job.get("total_events", 0)),
                "agent_count": job.get("agent_count", 0),
                "started_at": job.get("started_at"),
                "paused_at": job.get("paused_at"),
                "enabled_vendors": job.get("enabled_vendors"),
            })
        except Exception:
            continue
    return results


def get_calib_checkpoint(job_id: str) -> dict | None:
    """Load a checkpoint from disk."""
    path = os.path.join(CALIB_JOBS_DIR, f"{job_id}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)


# Track which jobs need checkpoint written after next pause confirmation
_checkpoint_pending: dict[str, bool] = {}
_checkpoint_agents: dict[str, list] = {}  # Store agents for checkpoint
_checkpoint_packs: dict[str, dict] = {}   # Store packs for checkpoint
_checkpoint_days: dict[str, int] = {}     # Store current day for checkpoint
_calib_save_on_stop: dict[str, bool] = {}  # When True, stop gracefully and compute final result



def stop_calib_job(job_id: str) -> bool:
    """Request a running calibration job to stop (discard results)."""
    _calib_stops[job_id] = True
    _calib_save_on_stop.pop(job_id, None)  # ensure no save flag
    if job_id in _calib_jobs:
        _calib_jobs[job_id]["status"] = "stopping"  # intermediate: agents still finishing
        _push_calib_live(_calib_jobs[job_id], "⚠️ 停止指令已發送，等待當前 Agent 完成...")
    return True


def stop_and_save_calib_job(job_id: str) -> bool:
    """Stop the calibration run but compute and save results with data collected so far."""
    _calib_save_on_stop[job_id] = True
    _calib_stops[job_id] = True
    if job_id in _calib_jobs:
        _calib_jobs[job_id]["status"] = "stopping"
        _push_calib_live(_calib_jobs[job_id], "💾 停止並儲存目前結果...請稍候")
    return True


def pause_calib_job(job_id: str) -> bool:
    """Request a running calibration job to pause. Sets 'pausing' status immediately."""
    _calib_pauses[job_id] = True
    _checkpoint_pending[job_id] = True  # background loop will write checkpoint
    if job_id in _calib_jobs and _calib_jobs[job_id]["status"] == "running":
        _calib_jobs[job_id]["status"] = "pausing"  # intermediate: agents still finishing
        _calib_jobs[job_id]["paused_at"] = time.time()
        if ev := _calib_cancel_events.get(job_id):
            ev.set()
        _push_calib_live(_calib_jobs[job_id], "⏸️ 暫停指令已發送，等待當前 Agent 完成...")
    return True


def resume_calib_job(job_id: str) -> bool:
    """Request a paused calibration job to resume (same process only)."""
    _calib_pauses[job_id] = False
    if job_id in _calib_jobs and _calib_jobs[job_id]["status"] == "paused":
        _calib_jobs[job_id]["status"] = "running"
        _push_calib_live(_calib_jobs[job_id], "▶️ 校準已繼續")
    return True


async def resume_from_checkpoint(job_id: str, concurrency: int | None = None) -> dict:
    """Resume a previously paused job from its disk checkpoint (survives restarts)."""
    checkpoint = get_calib_checkpoint(job_id)
    if not checkpoint:
        raise FileNotFoundError(f"No checkpoint found for job {job_id}")

    saved_job = checkpoint["job"]
    agents = checkpoint["agents"]
    pack = checkpoint["pack"]
    resume_from_day = checkpoint["current_day"] + 1  # next unprocessed day

    # Restore job to memory with paused state
    saved_job["status"] = "pending"
    saved_job["live_messages"] = []
    saved_job["resumed_at"] = time.time()
    _calib_jobs[job_id] = saved_job
    _calib_pauses[job_id] = False
    _calib_stops[job_id] = False

    if concurrency is None:
        concurrency = len(saved_job.get("enabled_vendors") or []) or 4

    asyncio.create_task(_run_calibration_bg(saved_job, pack, agents, concurrency, start_day=resume_from_day))
    logger.info(f"Resuming job {job_id} from day {resume_from_day}")
    return {"job_id": job_id, "status": "pending", "resumed_from_day": resume_from_day}


def get_calib_job(job_id: str) -> dict | None:
    return _calib_jobs.get(job_id)


async def run_calibration(
    pack_id: str,
    agents: list[dict],
    concurrency: int = 5,
    target_days: int = 0,
    enable_kol: bool = False,
    kol_ratio: float = 0.05,
    kol_reach: float = 0.40,
    sampling_modality: str = "unweighted",
    enabled_vendors: list[str] | None = None,
) -> dict:
    """Start a calibration run as a background task.

    Args:
        target_days: If > 0, redistribute events evenly across this many days
                     (adding quiet days between events). 0 = use original days.
    """
    if enabled_vendors:
        non_ollama = [v for v in enabled_vendors if "ollama" not in v.lower()]
        if len(non_ollama) == 0:
            # Pure Ollama — clamp to 1 to prevent GPU OOM
            logger.info(f"Pure-Ollama vendors detected. Hard-clamping concurrency from {concurrency} to 1 to prevent local GPU OOM.")
            concurrency = 1
        else:
            # Mixed or pure-cloud — use at least len(non_ollama) as concurrency
            min_conc = len(non_ollama)
            if concurrency < min_conc:
                concurrency = min_conc
            logger.info(f"Mixed vendors: {len(non_ollama)} cloud + {len(enabled_vendors) - len(non_ollama)} ollama → concurrency={concurrency}")
    elif not enabled_vendors and os.getenv("LLM_VENDORS", "") == "ollama":
        logger.info(f"Ollama detected as fallback vendor. Hard-clamping concurrency from {concurrency} to 1 to prevent local GPU OOM.")
        concurrency = 1
    pack = get_calibration_pack(pack_id)
    if not pack:
        raise FileNotFoundError(f"Calibration pack not found: {pack_id}")

    # Deep copy events so redistribution doesn't mutate the stored pack
    import copy
    events = copy.deepcopy(pack.get("events", []))
    if target_days > 0:
        events = _redistribute_events(events, target_days)
        logger.info(f"Redistributed {len(events)} events across {target_days} days")

    logger.info(f"debug_kol: enable_kol={enable_kol}")
    job_id = uuid.uuid4().hex[:8]
    job = {
        "job_id": job_id,
        "pack_id": pack_id,
        "pack_name": pack["name"],
        "status": "pending",
        "current_event": 0,
        "total_events": len(events),
        "target_days": target_days,
        "enable_kol": enable_kol,
        "kol_ratio": kol_ratio,
        "kol_reach": kol_reach,
        "sampling_modality": sampling_modality,
        "enabled_vendors": enabled_vendors,
        "scoring_params": pack.get("scoring_params", {}),
        "macro_context": pack.get("macro_context", ""),
        "agent_count": len(agents),
        "started_at": time.time(),
        "completed_at": None,
        "error": None,
        "daily_summary": [],
        "live_messages": [],
    }
    _calib_jobs[job_id] = job

    # Pass redistributed events directly (not from pack)
    run_pack = {**pack, "events": events}
    asyncio.create_task(_run_calibration_bg(job, run_pack, agents, concurrency))
    return {"job_id": job_id, "status": "pending", "target_days": target_days or "auto"}


async def _run_calibration_bg(
    job: dict, pack: dict, agents: list[dict], concurrency: int,
    start_day: int = 1,
    scoring_params_override: dict | None = None,
):
    """Background: run the calibration evolution through all events."""
    from .evolver import (
        evolve_one_day, _save_states, _save_diaries, _save_history,
        _load_states, _save_profiles,
    )
    from .news_pool import replace_pool

    try:
        job["status"] = "running"
        events = pack.get("events", [])
        ground_truth = pack.get("ground_truth", {})

        # Override scoring_params if provided (auto-calibration iteration)
        if scoring_params_override:
            job["scoring_params"] = scoring_params_override
            logger.info(f"Scoring params overridden for job {job['job_id']}: {list(scoring_params_override.keys())}")

        # Reset agent states only on fresh start (not checkpoint resume)
        if start_day <= 1:
            _save_states({})
            _save_diaries([])
            _save_history([])
            _save_profiles({})
        else:
            _push_calib_live(job, f"🔄 從斷點第 {start_day} 天繼續校準...")

        # Sort events by day
        events.sort(key=lambda e: e.get("day", 0))

        # Determine total simulation days (max event day)
        max_day = max((e.get("day", 1) for e in events), default=1)
        # Respect target_days if it is larger (e.g. timeline jobs with few/no events)
        if job.get("target_days") and job["target_days"] > max_day:
            max_day = job["target_days"]
        job["max_day"] = max_day  # persist for checkpoint display
        current_pool: list[dict] = []
        event_idx = 0
        _seen_titles: set[str] = set()  # Cross-day title dedup

        # Build agent lookup maps for per-group stats
        agent_leaning_map: dict[str, str] = {}
        current_agent_states: dict[str, dict] = {}
        for a in agents:
            aid = str(a.get("person_id", 0))
            leaning = a.get("political_leaning", "中立")
            agent_leaning_map[aid] = leaning
            current_agent_states[aid] = {"satisfaction": 50, "anxiety": 50, "local_satisfaction": 50, "national_satisfaction": 50, "leaning": leaning, "agent_id": aid}

        for day in range(1, max_day + 1):
            # Skip days already processed (checkpoint resume)
            if day < start_day:
                continue

            # Per-day cancel event: set this to immediately stop pending agents in current day
            day_cancel_event = asyncio.Event()
            _calib_cancel_events[job["job_id"]] = day_cancel_event

            # Pause loop: entered when pause flag is set. Agents finishing last LLM calls will
            # check cancel_event and skip if not yet started.
            while _calib_pauses.get(job["job_id"]):
                if _calib_stops.get(job["job_id"]):
                    break
                if job["status"] not in ("paused",):
                    job["status"] = "paused"  # now actually paused (agents finished)
                    day_cancel_event.set()  # stop any still-pending agents for current day
                    _push_calib_live(job, "⏸️ 校準已暫停，等待重啟或繼續")
                # Write checkpoint if triggered
                if _checkpoint_pending.pop(job["job_id"], False):
                    _save_job_checkpoint(job, agents, pack, day - 1)  # day-1 = last completed
                    _push_calib_live(job, f"💾 斷點已儲存 (Day {day - 1})，重啟後可繼續")
                await asyncio.sleep(1)
            
            # Post-pause restore status if not stopped
            if not _calib_stops.get(job["job_id"]) and job["status"] in ("paused", "pausing"):
                job["status"] = "running"
                _push_calib_live(job, "▶️ 校準已繼續")

            if _calib_stops.get(job["job_id"]):
                day_cancel_event.set()  # stop pending agents immediately
                if _calib_save_on_stop.get(job["job_id"]):
                    # Graceful stop: break without cancelling, let post-loop scoring run
                    _push_calib_live(job, f"📊 經提前停止，正在計算當前結果...")
                    _delete_job_checkpoint(job["job_id"])
                    break  # status remains "running" → post-loop scoring will execute
                else:
                    job["status"] = "cancelled"
                    _push_calib_live(job, "⚠️ 校準已中斷")
                    _delete_job_checkpoint(job["job_id"])  # remove checkpoint on stop
                    break

            # Inject news for this day if there's a matching event
            day_event_titles: list[str] = []
            while event_idx < len(events) and events[event_idx].get("day", 0) <= day:
                event = events[event_idx]
                
                # Check for nested news array just in case, otherwise treat event as the news item
                if "news" in event and isinstance(event["news"], list) and len(event["news"]) > 0:
                    news_items = event["news"]
                else:
                    if event.get("title") or event.get("summary"):
                        news_items = [event]
                    else:
                        news_items = []

                for item in news_items:
                    title_text = _strip_dates(item.get("title", ""))
                    summary_text = item.get("summary", "")

                    if _is_irrelevant_article(title_text, item.get("source_tag", ""), summary_text):
                        continue

                    title_key = title_text[:12].strip()
                    if title_key and title_key in _seen_titles:
                        continue
                    if title_key:
                        _seen_titles.add(title_key)

                    current_pool.append({
                        "article_id": uuid.uuid4().hex[:8],
                        "title": title_text,
                        "summary": _strip_dates(item.get("summary", "")),
                        "source_tag": item.get("source_tag", "歷史事件"),
                        "channel": item.get("channel", "國內"),
                        "leaning": item.get("leaning", "center"),
                        "crawled_at": time.time(),
                    })
                    if title_text:
                        day_event_titles.append(title_text)
                event_idx += 1
                job["current_event"] = event_idx

            # ── News pool forgetting: remove oldest articles each day ──
            sp = scoring_params_override or job.get("scoring_params", {})
            forget_rate = sp.get("forget_rate", 0.0)  # 0=keep all, 1=only today's news
            if forget_rate > 0 and len(current_pool) > 0:
                today_count = len(day_event_titles)  # articles added today
                old_count = len(current_pool) - today_count
                if old_count > 0:
                    remove_n = int(old_count * forget_rate)
                    if remove_n > 0:
                        current_pool = current_pool[remove_n:]  # remove oldest items (front of list)
                        logger.info(f"News forgetting: removed {remove_n} oldest articles (forget_rate={forget_rate}), pool now {len(current_pool)}")

            # Replace the global news pool
            replace_pool(current_pool)

            # Push live message
            msg = f"📅 校準演化: Day {day}/{max_day} — 新聞池 {len(current_pool)} 則"
            _push_calib_live(job, msg)

            # Evolve one day
            job["agent_leaning_map"] = agent_leaning_map
            # Pass ground truth candidate names and descriptions for incremental candidate estimate
            # For timeline jobs (pack has no ground_truth), determine active pack first
            gt_keys = list(pack.get("ground_truth", {}).keys())
            if not gt_keys and "timeline_packs" in job:
                # Find active pack for this day (earliest pack whose eval day >= current day)
                sorted_tps = sorted(job["timeline_packs"], key=lambda tp: job.get("timeline_pack_days", {}).get(tp["pack_id"], 0))
                _active_tp_pre = None
                for tp in sorted_tps:
                    pack_day = job.get("timeline_pack_days", {}).get(tp["pack_id"], 0)
                    if day <= pack_day:
                        _active_tp_pre = tp
                        break
                if not _active_tp_pre and sorted_tps:
                    _active_tp_pre = sorted_tps[-1]
                if _active_tp_pre:
                    gt_keys = [k for k in _active_tp_pre.get("ground_truth", {}).keys() if k != "__by_district__"]
                    logger.info(f"Timeline Day {day}: active_pack={_active_tp_pre.get('name','?')}, candidates={gt_keys}")
            job["candidate_names"] = gt_keys
            # Merge candidate_info from pack with ground_truth keys as fallback descriptions
            stored_info = pack.get("candidate_info", {})
            # For timeline jobs, find candidate_info from the active pack
            if not stored_info and "timeline_packs" in job:
                sorted_tps = sorted(job["timeline_packs"], key=lambda tp: job.get("timeline_pack_days", {}).get(tp["pack_id"], 0))
                for tp in sorted_tps:
                    pack_day = job.get("timeline_pack_days", {}).get(tp["pack_id"], 0)
                    if day <= pack_day:
                        stored_info = tp.get("candidate_info", {})
                        break
                if not stored_info and sorted_tps:
                    stored_info = sorted_tps[-1].get("candidate_info", {})
            if not stored_info:
                # Auto-derive descriptions from ground_truth keys (e.g. "盧秀燕(中國國民黨)")
                import re
                for k in gt_keys:
                    m = re.search(r'[（(](.+?)[）)]', k)
                    party = m.group(1) if m else ""
                    name = re.sub(r'[（(].+?[）)]', '', k).strip()
                    # Include full name + party for complete keyword matching
                    desc = f"{name}、{party}" if party else name
                    # Auto-tag well-known traits from name/party
                    if any(w in k for w in ["市長", "縣長", "院長"]):
                        desc += "、市政、市長、現任、執政"
                    if any(w in k for w in ["副市長", "副縣長"]):
                        desc += "、副市長、市政、行政經驗、執政團隊"
                    if any(w in k for w in ["立委", "議員"]):
                        desc += "、民意代表、立委"
                    if any(w in k for w in ["立法院"]):
                        desc += "、立法院、國會"
                    if any(w in k for w in ["副院長"]):
                        desc += "、副院長、立法院、全國"
                    if any(w in k for w in ["黨主席", "黨魁"]):
                        desc += "、黨主席、全國知名、黨中央"
                    # Tag as independent if no major/minor party
                    if not party or any(w in party for w in ["無黨", "無所屬", "無黨籍", "未經政黨推薦"]):
                        if not any(w in desc for w in ["國民黨", "民進黨", "民眾黨", "時代力量", "台灣基進"]):
                            desc += "、無黨籍"
                    stored_info[k] = desc
                logger.info(f"Auto-derived candidate_info: {stored_info}")
            else:
                # No auto-supplement: incumbency tags are set by the user via the frontend checkbox
                logger.info(f"Using user-provided candidate_info as-is (no auto-supplement)")
            job["candidate_descriptions"] = {k: stored_info.get(k, k) for k in gt_keys}
            logger.info(f"Candidate descriptions for scoring: {job['candidate_descriptions']}")
            logger.info(f"debug_hang: starting evolve_one_day for day {day}")
            entries = await evolve_one_day(
                agents, current_pool, day,
                feed_fn=None,
                memory_fn=None,
                job=job,
                concurrency=concurrency,
                cancel_event=day_cancel_event,
            )

            logger.info(f"debug_hang: evolve_one_day finished for day {day}, entries len={len(entries)}")
            # Update global state for agents that were active today
            for e in entries:
                aid = str(e.get("agent_id", ""))
                if aid in current_agent_states:
                    current_agent_states[aid]["satisfaction"] = e.get("satisfaction", 50)
                    current_agent_states[aid]["anxiety"] = e.get("anxiety", 50)
                    if "local_satisfaction" in e:
                        current_agent_states[aid]["local_satisfaction"] = e["local_satisfaction"]
                    if "national_satisfaction" in e:
                        current_agent_states[aid]["national_satisfaction"] = e["national_satisfaction"]

            # Aggregate daily stats globally
            if current_agent_states:
                avg_sat = sum(s["satisfaction"] for s in current_agent_states.values()) / len(current_agent_states)
                avg_anx = sum(s["anxiety"] for s in current_agent_states.values()) / len(current_agent_states)
            else:
                avg_sat = avg_anx = 50

            # Per-leaning-group stats (Global)
            leaning_stats: dict[str, dict] = {}
            sat_buckets = {"0-20": 0, "20-40": 0, "40-60": 0, "60-80": 0, "80-100": 0}
            high_sat_count = 0
            high_anx_count = 0
            for aid, st in current_agent_states.items():
                leaning = st["leaning"]
                sat = st["satisfaction"]
                anx = st["anxiety"]

                if leaning not in leaning_stats:
                    leaning_stats[leaning] = {"sat_sum": 0, "anx_sum": 0, "count": 0}
                leaning_stats[leaning]["sat_sum"] += sat
                leaning_stats[leaning]["anx_sum"] += anx
                leaning_stats[leaning]["count"] += 1

                # Bucket
                if sat < 20: sat_buckets["0-20"] += 1
                elif sat < 40: sat_buckets["20-40"] += 1
                elif sat < 60: sat_buckets["40-60"] += 1
                elif sat < 80: sat_buckets["60-80"] += 1
                else: sat_buckets["80-100"] += 1

                if sat > 60: high_sat_count += 1
                if anx > 60: high_anx_count += 1

            by_leaning = {}
            for ln, st in leaning_stats.items():
                c = st["count"] or 1
                by_leaning[ln] = {"avg_sat": round(st["sat_sum"] / c, 1), "avg_anx": round(st["anx_sum"] / c, 1), "count": c}

            # Find existing summary from incremental updates (created by evolve_one_day)
            existing_summary = None
            for s in job["daily_summary"]:
                if s["day"] == day:
                    existing_summary = s
                    break

            # Safely establish candidate union from timeline packs if executing auto-calibration
            pack_candidates = []
            gt_keys = job.get("candidate_names", [])
            active_tp = None
            
            if not gt_keys and "timeline_packs" in job:
                # Sort packs by their target evaluation day to find the correct active period
                sorted_tps = sorted(job["timeline_packs"], key=lambda tp: job.get("timeline_pack_days", {}).get(tp["pack_id"], 0))
                
                for tp in sorted_tps:
                    pack_day = job.get("timeline_pack_days", {}).get(tp["pack_id"], 0)
                    if day <= pack_day:
                        active_tp = tp
                        break
                
                if not active_tp and sorted_tps:
                    active_tp = sorted_tps[-1]
                
                if active_tp:
                    gt_keys = list(active_tp.get("ground_truth", {}).keys())
            
            pack_candidates = [c for c in gt_keys if c != "__by_district__"]

            # Compute heuristic candidate estimates for timeline charting
            candidate_estimate = {}
            by_leaning_candidate = {}
            if pack_candidates:
                from .predictor import _calculate_heuristic_score
                
                cand_info = pack.get("candidate_info", {})
                if not cand_info and active_tp:
                    cand_info = active_tp.get("candidate_info", {})
                        
                scores_all = {c: 0.0 for c in pack_candidates}
                scores_all["不表態"] = 0.0
                leaning_scores = {}
                
                sp = scoring_params_override or job.get("scoring_params", {})
                news_impact = sp.get("news_impact", 1.0)
                party_align_bonus = sp.get("party_align_bonus", 15)
                
                for aid, st in current_agent_states.items():
                    ag_leaning = st.get("leaning", "中立")
                    ag_sat = st.get("satisfaction", 50)
                    ag_anx = st.get("anxiety", 50)
                    
                    ag_scores = {}
                    for c in pack_candidates:
                        desc = cand_info.get(c, "")
                        ag_scores[c] = _calculate_heuristic_score(
                            c, desc, ag_leaning, ag_sat, ag_sat, ag_anx, news_impact, party_align_bonus
                        )
                    
                    tot_s = sum(ag_scores.values()) or 1.0
                    no_op = max(0.0, 1.0 - sum(ag_scores.get(c, 0)/tot_s for c in pack_candidates))
                    
                    for c in pack_candidates:
                        frac = ag_scores[c] / tot_s
                        scores_all[c] += frac
                        if ag_leaning not in leaning_scores:
                            leaning_scores[ag_leaning] = {cn: 0.0 for cn in pack_candidates}
                            leaning_scores[ag_leaning]["不表態"] = 0.0
                            leaning_scores[ag_leaning]["_count"] = 0.0
                        leaning_scores[ag_leaning][c] += frac
                        
                    scores_all["不表態"] += no_op
                    if ag_leaning in leaning_scores:
                        leaning_scores[ag_leaning]["不表態"] += no_op
                        leaning_scores[ag_leaning]["_count"] += 1.0
                
                total_w = len(current_agent_states) or 1.0
                candidate_estimate = {c: round((v / total_w) * 100, 1) for c, v in scores_all.items()}
                
                for ln, lsc in leaning_scores.items():
                    cnt = lsc.pop("_count", 1.0) or 1.0
                    by_leaning_candidate[ln] = {c: round((v / cnt) * 100, 1) for c, v in lsc.items()}

            # NOTE: candidate_estimate and by_leaning_candidate are intentionally
            # NOT included here. The evolver.py incremental calculation (which
            # includes recognition_penalty, undecided probability, incumbency
            # bonus, etc.) produces correct results. Including them here would
            # overwrite with the simplified _calculate_heuristic_score that
            # lacks those factors, causing a false "三分天下" effect.
            day_record = {
                "day": day,
                "completed_at": time.time(),
                "avg_satisfaction": round(avg_sat, 1),
                "avg_anxiety": round(avg_anx, 1),
                "entries_count": len(entries),
                "by_leaning": by_leaning,
                "sat_distribution": sat_buckets,
                "high_sat_count": high_sat_count,
                "high_anx_count": high_anx_count,
                "event_titles": day_event_titles,
            }

            if existing_summary:
                # Update in-place, remove internal tracking fields
                existing_summary.update(day_record)
                existing_summary.pop("_sum_sat", None)
                existing_summary.pop("_sum_anx", None)
                for ls in existing_summary.get("by_leaning", {}).values():
                    if isinstance(ls, dict):
                        ls.pop("_sum_sat", None)
                        ls.pop("_sum_anx", None)
            else:
                job["daily_summary"].append(day_record)

            # Live message with candidate estimates
            if candidate_estimate:
                est_str = " | ".join(f"{c}:{v}%" for c, v in candidate_estimate.items() if c != "不表態")
                _push_calib_live(job, f"  📊 Day {day}: {est_str}")

            await asyncio.sleep(0.3)

        # ── Compute calibration score at checkpoints or at the end ────────────────────────────────
        if job["status"] != "cancelled":
            # Check if this is a timeline job with individual packs
            timeline_packs = job.get("timeline_packs", [])
            timeline_pack_days = job.get("timeline_pack_days", {})
            evaluations = job.get("timeline_evaluations", {})
            
            # Identify packs that need to be evaluated today
            packs_to_evaluate = []
            if timeline_packs:
                for p in timeline_packs:
                    pid = p["pack_id"]
                    # If this pack's target day map to current day, and we haven't evaluated it yet
                    # We evaluate it either when we hit its exact day, or if we reach the end of the simulation
                    # and haven't evaluated it yet.
                    target_day = timeline_pack_days.get(pid, 1)
                    if (day == target_day or day == max_day) and pid not in evaluations:
                        packs_to_evaluate.append(p)
            else:
                # Traditional single-pack run (fallback), evaluate on the last day
                if day == max_day:
                    packs_to_evaluate.append(pack)

            if packs_to_evaluate:
                final_states = _load_states()
                
                for eval_pack in packs_to_evaluate:
                    pid = eval_pack.get("pack_id", "single")
                    ground_truth = eval_pack.get("ground_truth", {})
                    
                    # Store current statuses
                    prev_status = job["status"]
                    job["status"] = "simulating_votes"
                    modality = job.get("sampling_modality", "unweighted")
                    model_text = "全市話權重" if modality == "landline_only" else ("七三比權重" if modality == "mixed_73" else "無加權")
                    _push_calib_live(job, f"🗳️ (Day {day}) 開始模擬投票: {eval_pack.get('name', '未命名')}... ({len(agents)} 位) [{model_text}]")
                    
                    vote_result = await _simulate_votes(agents, final_states, ground_truth, concurrency, job, modality, job.get("enabled_vendors"))
                    
                    if job["status"] == "cancelled":
                        break
                        
                    simulated = _aggregate_simulated_results(final_states, agents)
                    # Unpack vote result (may be {vote_shares, by_district} or flat dict for backward compat)
                    if isinstance(vote_result, dict) and "vote_shares" in vote_result:
                        simulated["vote_shares"] = vote_result["vote_shares"]
                        simulated["by_district"] = vote_result.get("by_district", {})
                    else:
                        simulated["vote_shares"] = vote_result
    
                    score_result = _compute_calibration_score(simulated, ground_truth)
                    
                    # Generate parameter recommendations for this checkpoint
                    try:
                        recs = recommend_params(
                            score_result,
                            job.get("daily_summary", []),
                            job.get("scoring_params", {}),
                        )
                        score_result["recommended_params"] = recs
                    except Exception as rec_err:
                        logger.warning(f"Parameter recommendation failed for pack {pid}: {rec_err}")
                        score_result["recommended_params"] = {}
                        
                    # Apply recommended global parameters immediately (Online Assimilation)
                    if pid == "timeline" or True: # Apply for all continuous runs
                        if score_result["recommended_params"]:
                            new_params = dict(job.get("scoring_params", {}))
                            for k, v in score_result["recommended_params"].items():
                                new_params[k] = v.get("recommended", v.get("current"))
                            job["scoring_params"] = new_params
                            _push_calib_live(job, f"⚙️ 已套用新的全域參數: {list(new_params.keys())}")

                    # Perform District-Level Agent State Assimilation
                    gt_by_district = ground_truth.get("__by_district__")
                    sim_by_district = simulated.get("by_district")
                    if gt_by_district and sim_by_district:
                        _assimilate_district_agents(agents, final_states, gt_by_district, sim_by_district, job)
                        # Save the assimilated states to Redis so tomorrow starts with corrected agents
                        _save_states(final_states)
                        
                    # Save results to the original pack file
                    if pid != "timeline":
                        eval_pack["results"] = score_result
                        pack_path = os.path.join(CALIBRATION_DIR, f"{pid}.json")
                        with open(pack_path, "w") as f:
                            json.dump(eval_pack, f, ensure_ascii=False, indent=2)
                            
                    # Store in timeline evaluations
                    evaluations[pid] = score_result
                    _push_calib_live(job, f"✅ {eval_pack.get('name', pid)} 校準檢核與同化完成，MAE 誤差: {score_result['mae']:.2f}%")
                    
                    # Restore status to running if there are more days, otherwise it will drop down to completion
                    if day < max_day and prev_status == "running":
                        job["status"] = "running"
                        
            # If we reached the end of the simulation timeline
            if day == max_day and job["status"] != "cancelled":
                job["status"] = "completed"
                job["completed_at"] = time.time()
                
                # Expose final evaluations to the subjob explicitly
                job["timeline_evaluations"] = evaluations
                job["final_agents"] = _load_states()
                _delete_job_checkpoint(job["job_id"])
                
                logger.info(f"Calibration timeline completed: {job['job_id']}")
                # Generate parameter recommendations based on overall evaluations
                # Timeline jobs: we just evaluate each point, no final massive save for 'pack' 
                # unless it's a legacy single pack run.
                try:
                    # In single pack runs, 'score_result' comes from the last evaluation
                    # For timeline jobs, 'score_result' was stored in the iterations
                    if "score_result" in locals():
                        recs = recommend_params(
                            score_result,
                            job.get("daily_summary", []),
                            job.get("scoring_params", {}),
                        )
                        job["recommended_params"] = recs
                        if "pack_path" in locals() and "eval_pack" in locals() and pid != "timeline":
                            eval_pack["results"]["recommended_params"] = recs
                            with open(pack_path, "w") as f:
                                json.dump(eval_pack, f, ensure_ascii=False, indent=2)
                        _push_calib_live(job, f"🤖 已生成 {len(recs)} 項參數建議")
                except Exception as rec_err:
                    logger.warning(f"Parameter recommendation failed: {rec_err}")
                    job["recommended_params"] = {}
                # ── Persist calibration-tracked state to disk before profile & snapshot ──
                # current_agent_states accumulates sat/anx from all evolve_one_day entries.
                # evolve_one_day writes to disk, but only for agents that produced entries.
                # This merge ensures ALL agents have correct values in the state file.
                _disk_states = _load_states()
                for aid_str, cal_state in current_agent_states.items():
                    if aid_str not in _disk_states:
                        _disk_states[aid_str] = {"agent_id": aid_str}
                    # Calibration-tracked sat/anx takes precedence (accumulated from entries)
                    _disk_states[aid_str]["satisfaction"] = cal_state.get("satisfaction", 50)
                    _disk_states[aid_str]["anxiety"] = cal_state.get("anxiety", 50)
                    # Preserve leaning from calibration tracker if not in disk
                    if "leaning" in cal_state and "leaning" not in _disk_states[aid_str]:
                        _disk_states[aid_str]["leaning"] = cal_state["leaning"]
                    # Also ensure local/national sat are set if missing
                    if "local_satisfaction" not in _disk_states[aid_str]:
                        _disk_states[aid_str]["local_satisfaction"] = cal_state.get("satisfaction", 50)
                    if "national_satisfaction" not in _disk_states[aid_str]:
                        _disk_states[aid_str]["national_satisfaction"] = cal_state.get("satisfaction", 50)
                _save_states(_disk_states)
                final_states = _disk_states  # Use merged states for profile extraction
                job["final_agents"] = final_states
                logger.info(f"Persisted calibration states for {len(_disk_states)} agents before snapshot")

                # ── Extract and save Agent Profiles (Delta) ──
                agent_profiles = {}
                for aid_str, state in final_states.items():
                    sat = state.get("satisfaction", 50)
                    anx = state.get("anxiety", 50)
                    
                    reaction_scale = 1.0
                    decay_rate = 1.0
                    persona_text = ""
                    
                    if anx >= 70:
                        persona_text += "近期經歷導致焦慮度大幅提高，對負面新聞及民生壓力變得更加敏感。 "
                        reaction_scale += 0.2
                    elif anx <= 30:
                        persona_text += "目前情緒相對安定，較不易受短期政治事件恐慌影響。 "
                        reaction_scale -= 0.1
                        
                    if sat >= 70:
                        persona_text += "對現狀十分滿意，政治態度趨向保守固守現有體制。 "
                        decay_rate += 0.2
                    elif sat <= 30:
                        persona_text += "對現狀強烈不滿，渴望改變，對於批評執政的言論產生高度共鳴。 "
                        reaction_scale += 0.2
                        decay_rate -= 0.1
                        
                    if not persona_text:
                        persona_text = "校正期間情緒變化平穩，價值觀無重大偏移。"
                        
                    agent_profiles[aid_str] = {
                        "persona_delta": persona_text.strip(),
                        "param_adjustments": {
                            "reaction_scale_multiplier": round(reaction_scale, 2),
                            "decay_rate_multiplier": round(decay_rate, 2),
                        }
                    }
                    
                _save_profiles(agent_profiles)
                _push_calib_live(job, f"🧩 已萃取 {len(agent_profiles)} 位 Agent 的特徵與人設變化值")

                # ── Auto-save snapshot on calibration completion ──
                try:
                    from .snapshot import save_snapshot
                    import datetime
                    pack_name = pack.get("name", "calibration")
                    ts = datetime.datetime.now().strftime("%m%d_%H%M")
                    snap_name = f"自動快照: {pack_name} ({ts})"
                    snap_desc = f"校準完成自動儲存。分數: {score_result.get('score', 'N/A')}"
                    snap_meta = save_snapshot(snap_name, snap_desc, pack.get("pack_id"))
                    job["auto_snapshot_id"] = snap_meta["snapshot_id"]
                    job["auto_snapshot_name"] = snap_name
                    logger.info(f"Auto-snapshot saved: {snap_meta['snapshot_id']} ({snap_name})")
                except Exception as snap_err:
                    logger.warning(f"Auto-snapshot failed: {snap_err}")
        else:
            job["completed_at"] = time.time()
            logger.info(f"Calibration cancelled: {job['job_id']}")

    except Exception as e:
        logger.exception(f"Calibration failed: {e}")
        job["status"] = "failed"
        job["error"] = str(e)
        job["completed_at"] = time.time()


async def _simulate_votes(
    agents: list[dict], 
    final_states: dict, 
    ground_truth: dict,
    concurrency: int,
    job: dict,
    sampling_modality: str = "unweighted",
    enabled_vendors: list[str] | None = None,
) -> dict[str, float]:
    """Simulate voting preference for each agent based on final state."""
    from .evolver import _call_llm, get_agent_diary

    def _get_sampling_weight(modality: str, age_str: str) -> float:
        if modality == "unweighted" or not modality:
            return 1.0
        import re
        m = re.search(r'\d+', str(age_str))
        age = int(m.group()) if m else 40
        if modality == "landline_only":
            if age < 30: return 0.3
            if age < 40: return 0.5
            if age < 50: return 0.8
            if age < 60: return 1.2
            return 1.8
        elif modality == "mixed_73":
            if age < 30: return 0.7
            if age < 40: return 0.8
            if age < 50: return 0.9
            if age < 60: return 1.1
            return 1.2
        return 1.0

    # Extract candidate names from ground truth keys (e.g. "盧秀燕(中國國民黨)")
    candidates = list(ground_truth.keys())
    if not candidates:
        return {}

    prompt_template = """你是一位真實的台灣選民。以下是你的基本資料與政治傾向：
【基本資料】
{persona_desc}

【政治光譜與傾向】
- 你的政治傾向為：{political_leaning}

在經歷了這段時間的選戰事件後，你目前的心理狀態：
- 對政府施政滿意度: {satisfaction}/100
- 經濟與生活焦慮度: {anxiety}/100

最近幾天的日記紀錄：
{recent_diary}

請基於你的政治傾向、目前的滿意度與焦慮度，以及日記中的情緒，決定你要把票投給以下哪位候選人？
候選人名單：
{candidates}

請注意：
- 偏左派/偏左派 較容易投給民進黨
- 偏右派/偏右派 較容易投給國民黨
- 如果滿意度極低且焦慮度極高，可能會考慮第三勢力或無黨籍
- 如果各方都不滿意，也可能選擇「不投票」或「廢票」

請嚴格只回傳 JSON 格式，包含你的投票選擇（必須是上述候選人名單中的一個字串，或者 "不投票"）：
{{
  "vote": "候選人名稱"
}}"""

    import asyncio
    _vendor_sems = {}
    votes = []

    async def _vote(agent: dict):
        if _calib_stops.get(job["job_id"]):
            job["status"] = "cancelled"
            return

        aid = agent.get("person_id", 0)
        v_name = agent.get("llm_vendor", "openai")
        if v_name not in _vendor_sems:
            _vendor_sems[v_name] = asyncio.Semaphore(1)

        state = final_states.get(str(aid), {})
        sat = state.get("satisfaction", 50)
        anx = state.get("anxiety", 50)
        
        persona_desc = agent.get("user_char", "")
        # Get last 3 diaries
        diaries = get_agent_diary(aid)
        diaries.sort(key=lambda x: x.get("day", 0), reverse=True)
        recent = diaries[:3]
        recent.reverse()
        diary_lines = [f"- Day {d.get('day')}: {d.get('diary_text')}" for d in recent]
        diary_text = "\n".join(diary_lines) if diary_lines else "無特別紀錄"

        cands_text = "\n".join(f"- {c}" for c in candidates)
        
        political_leaning = agent.get("political_leaning") or "中立"

        prompt = prompt_template.format(
            persona_desc=persona_desc,
            political_leaning=political_leaning,
            satisfaction=sat,
            anxiety=anx,
            recent_diary=diary_text,
            candidates=cands_text
        )

        async with _vendor_sems[v_name]:
            try:
                # Provide custom expected_keys to ensure fallback handles voting structure properly
                parsed_res = await _call_llm(
                    prompt=prompt,
                    enabled_vendors=enabled_vendors,
                    vendor=v_name,
                    expected_keys=["vote"]
                )
                vote = parsed_res.get("vote", "")
            except Exception as e:
                logger.error(f"Vote simulation failed for agent {aid}: {e}")
                vote = "錯誤"

        # Try mapping vote to candidates (exact or substring)
        matched_cand = "不投票/廢票"
        if vote and vote != "不投票" and vote != "廢票":
            for c in candidates:
                if vote in c or c in vote:
                    matched_cand = c
                    break
                    
        # Get sampling weight
        age_str = agent.get("context", {}).get("age", "40")
        weight = _get_sampling_weight(sampling_modality, age_str)
        district = agent.get("district", agent.get("context", {}).get("district", "未知"))

        votes.append((matched_cand, weight, district))
        # Removed individual voting push to prevent overriding the timeline news feed
        # _push_calib_live(job, f"🗳️ Agent #{aid} [{district}] (權重{weight}) 決定投給: {matched_cand}")

    await asyncio.gather(*[_vote(a) for a in agents])

    # Calculate percentages
    if not votes:
        return {}
        
    counts = {}
    valid_votes_weight = 0.0
    # Also track per-district
    district_counts: dict[str, dict[str, float]] = {}
    district_weights: dict[str, float] = {}
    for v, w, dist in votes:
        if v in candidates:
            counts[v] = counts.get(v, 0.0) + w
            valid_votes_weight += w
            # District-level
            if dist not in district_counts:
                district_counts[dist] = {}
                district_weights[dist] = 0.0
            district_counts[dist][v] = district_counts[dist].get(v, 0.0) + w
            district_weights[dist] += w
            
    if valid_votes_weight == 0:
        return {c: 0.0 for c in candidates}
        
    shares = {c: round((counts.get(c, 0) / valid_votes_weight) * 100, 2) for c in candidates}
    
    # Build per-district shares
    by_district = {}
    for dist, dcounts in district_counts.items():
        dw = district_weights.get(dist, 0.0)
        if dw > 0:
            by_district[dist] = {c: round((dcounts.get(c, 0) / dw) * 100, 2) for c in candidates}
    
    return {"vote_shares": shares, "by_district": by_district}


def _aggregate_simulated_results(states: dict, agents: list[dict]) -> dict:
    """Aggregate final agent states into simulated metrics."""
    if not states:
        return {"avg_satisfaction": 50, "avg_anxiety": 50}

    sats = [s.get("satisfaction", 50) for s in states.values()]
    anxs = [s.get("anxiety", 50) for s in states.values()]

    return {
        "avg_satisfaction": round(sum(sats) / len(sats), 1),
        "avg_anxiety": round(sum(anxs) / len(anxs), 1),
        "agent_count": len(states),
    }


def _compute_calibration_score(simulated: dict, ground_truth: dict) -> dict:
    """Compare simulated results against ground truth.

    Computes MAE for each overlapping key, and an overall calibration score (100 - MAE).
    Supports district-level scoring when ground_truth contains '__by_district__'.
    """
    comparisons = []
    errors = []

    # Get simulated vote shares (if available) or use top-level simulated dict
    sim_data = simulated.get("vote_shares", simulated)

    for key, true_val in ground_truth.items():
        if key == "__by_district__":
            continue  # handled separately below
        sim_val = sim_data.get(key)
        if sim_val is not None and isinstance(true_val, (int, float)):
            diff = abs(float(sim_val) - float(true_val))
            errors.append(diff)
            comparisons.append({
                "key": key,
                "simulated": float(sim_val),
                "actual": float(true_val),
                "difference": round(diff, 2),
            })

    mae = round(sum(errors) / len(errors), 2) if errors else 0
    score = round(max(0, min(100, 100 - mae)), 1)

    # ── District-level scoring ──
    district_comparisons = []
    district_errors = []
    gt_districts = ground_truth.get("__by_district__", {})
    sim_districts = simulated.get("by_district", {})
    if gt_districts and sim_districts:
        for dist, gt_cands in gt_districts.items():
            sim_dist = sim_districts.get(dist)
            if not sim_dist:
                continue
            for cand, true_val in gt_cands.items():
                sim_val = sim_dist.get(cand)
                if sim_val is not None and isinstance(true_val, (int, float)):
                    diff = abs(float(sim_val) - float(true_val))
                    district_errors.append(diff)
                    district_comparisons.append({
                        "key": f"{dist}:{cand}",
                        "district": dist,
                        "candidate": cand,
                        "simulated": float(sim_val),
                        "actual": float(true_val),
                        "difference": round(diff, 2),
                    })

    district_mae = round(sum(district_errors) / len(district_errors), 2) if district_errors else None
    district_score = round(max(0, min(100, 100 - district_mae)), 1) if district_mae is not None else None

    result = {
        "score": score,
        "mae": mae,
        "comparisons": comparisons,
        "simulated": simulated,
        "ground_truth": ground_truth,
        "computed_at": time.time(),
    }
    if district_comparisons:
        result["district_score"] = district_score
        result["district_mae"] = district_mae
        result["district_comparisons"] = district_comparisons
    return result

def _assimilate_district_agents(agents: list[dict], states: dict[str, dict], gt_by_dist: dict, sim_by_dist: dict, job: dict):
    """
    Online Data Assimilation: Adjust agent satisfaction/leaning to match ground truth.
    Performs specific tuning per district to pull the simulation closer to reality.
    """
    def get_party_leaning(cand_name):
        if "國民黨" in cand_name or "藍" in cand_name: return "藍營"
        if "民進黨" in cand_name or "綠" in cand_name: return "綠營"
        if "民眾黨" in cand_name or "白" in cand_name or "柯文哲" in cand_name: return "白營"
        return "中立"

    messages = []
    total_corrected_districts = 0
    import random

    for dist, gt_dist_data in gt_by_dist.items():
        sim_dist_data = sim_by_dist.get(dist, {})
        if not sim_dist_data: continue
        
        # Find agents in this district
        dist_agents = [a for a in agents if str(a.get("district", "")) == dist]
        if not dist_agents: continue
        
        errors = {}
        for cand, truth_val in gt_dist_data.items():
            sim_val = sim_dist_data.get(cand, 0)
            errors[cand] = truth_val - sim_val # positive means we need MORE votes
            
        total_abs_err = sum(abs(v) for v in errors.values())
        if total_abs_err < 1.0:
            continue # very close, skip
             
        max_err_cand = max(errors, key=lambda c: abs(errors[c]))
        district_corrected = False

        for cand, err_val in errors.items():
            if abs(err_val) < 2.0: continue
            target_leaning = get_party_leaning(cand)
            
            # Find agents
            matching_aids = [str(a["person_id"]) for a in dist_agents if states.get(str(a["person_id"]), {}).get("leaning") == target_leaning]
            neutral_aids = [str(a["person_id"]) for a in dist_agents if states.get(str(a["person_id"]), {}).get("leaning") == "中立"]
            
            if err_val > 0:
                # Need MORE votes for this candidate
                for aid in matching_aids:
                    st = states.get(aid)
                    if st:
                        st["satisfaction"] = min(100, st.get("satisfaction", 50) + (err_val * 0.8))
                        st["anxiety"] = max(0, st.get("anxiety", 50) - (err_val * 0.3))
                
                # Convert some neutral agents
                num_to_convert = max(1, int(len(dist_agents) * (err_val / 100.0) * 0.5))
                to_convert = random.sample(neutral_aids, min(num_to_convert, len(neutral_aids)))
                for aid in to_convert:
                    st = states.get(aid)
                    if st:
                        st["leaning"] = target_leaning
                        st["satisfaction"] = min(100, st.get("satisfaction", 50) + 10)
                district_corrected = True
                        
            elif err_val < 0:
                # Need LESS votes for this candidate
                for aid in matching_aids:
                    st = states.get(aid)
                    if st:
                        st["satisfaction"] = max(0, st.get("satisfaction", 50) + (err_val * 1.2)) # err_val is negative
                        st["anxiety"] = min(100, st.get("anxiety", 50) - (err_val * 0.5))
                district_corrected = True

        if district_corrected:
            total_corrected_districts += 1
            if abs(errors[max_err_cand]) > 5.0 and len(messages) < 5:
                messages.append(f"{dist} ({max_err_cand} 誤差 {errors[max_err_cand]:+.1f}%)")

    if total_corrected_districts > 0:
        _push_calib_live(job, f"🔄 已執行同化 (共微調 {total_corrected_districts} 個次分區 Agent 狀態)")
        if messages:
            _push_calib_live(job, f"   ↳ 重大修正區: {', '.join(messages)}")


def recommend_params(
    score_result: dict,
    daily_summary: list[dict],
    current_params: dict,
) -> dict:
    """Analyze calibration results and recommend optimal Layer-2 parameters.

    Returns dict of {param_key: {current, recommended, reason}}.
    """
    recommendations: dict[str, dict] = {}
    comparisons = score_result.get("comparisons", [])
    ground_truth = score_result.get("ground_truth", {})

    # ── Current values (with defaults) ──
    cur_news_impact = current_params.get("news_impact", 1.0)
    cur_delta_cap = current_params.get("delta_cap_mult", 1.0)
    cur_decay_rate = current_params.get("decay_rate_mult", 1.0)
    cur_recognition = current_params.get("recognition_penalty", 0.15)
    cur_party_bonus = current_params.get("party_align_bonus", 15)
    cur_incumbency = current_params.get("incumbency_bonus", 12)
    cur_shift_sat_low = current_params.get("shift_sat_threshold_low", 25)
    cur_shift_anx_high = current_params.get("shift_anx_threshold_high", 75)
    cur_shift_days = current_params.get("shift_consecutive_days_req", 3)

    # ── 1. Analyze emotion volatility across days → news_impact ──
    if len(daily_summary) >= 2:
        sats = [d.get("avg_satisfaction", 50) for d in daily_summary]
        # Standard deviation of daily satisfaction
        mean_sat = sum(sats) / len(sats)
        std_sat = (sum((s - mean_sat) ** 2 for s in sats) / len(sats)) ** 0.5

        if std_sat < 1.5:
            rec_news = min(cur_news_impact + 0.3, 3.0)
            reason = f"情緒波動極低（σ={std_sat:.1f}），新聞對 Agent 影響不足，建議調高"
        elif std_sat > 8.0:
            rec_news = max(cur_news_impact - 0.3, 0.3)
            reason = f"情緒波動過大（σ={std_sat:.1f}），新聞影響過強，建議調低"
        else:
            rec_news = cur_news_impact
            reason = f"情緒波動適中（σ={std_sat:.1f}），維持現值"

        recommendations["news_impact"] = {
            "label": "新聞影響力 (News Impact)",
            "current": cur_news_impact,
            "recommended": round(rec_news, 2),
            "reason": reason,
        }

    # ── 2. Analyze satisfaction distribution → delta_cap_mult ──
    if daily_summary:
        last_day = daily_summary[-1]
        sat_dist = last_day.get("sat_distribution", {})
        total = sum(sat_dist.values()) if sat_dist else 1
        mid_pct = sat_dist.get("40-60", 0) / max(total, 1) * 100

        if mid_pct > 80:
            rec_cap = min(cur_delta_cap + 0.5, 3.0)
            reason = f"最後一天 {mid_pct:.0f}% 的 Agent 落在 40-60 區間，情緒變動可能被壓抑，建議放寬上限"
        elif mid_pct < 30:
            rec_cap = max(cur_delta_cap - 0.3, 0.3)
            reason = f"最後一天僅 {mid_pct:.0f}% 在 40-60 區間，情緒分化劇烈，建議收窄上限"
        else:
            rec_cap = cur_delta_cap
            reason = f"情緒分布合理（中間區 {mid_pct:.0f}%），維持現值"

        recommendations["delta_cap_mult"] = {
            "label": "情緒變動上限 (Delta Cap)",
            "current": cur_delta_cap,
            "recommended": round(rec_cap, 2),
            "reason": reason,
        }

    # ── 3. Analyze mean-reversion → decay_rate_mult ──
    if len(daily_summary) >= 3:
        # Check if satisfaction regresses to 50 too fast
        last_3 = daily_summary[-3:]
        avg_last3 = sum(d.get("avg_satisfaction", 50) for d in last_3) / 3
        distance_from_50 = abs(avg_last3 - 50)

        if distance_from_50 < 2:
            rec_decay = max(cur_decay_rate - 0.2, 0.1)
            reason = f"後期滿意度過度回歸中位（均值 {avg_last3:.1f}），衰減過快，建議降低"
        elif distance_from_50 > 15:
            rec_decay = min(cur_decay_rate + 0.2, 2.0)
            reason = f"後期滿意度偏離中位（均值 {avg_last3:.1f}），衰減不足，建議提高"
        else:
            rec_decay = cur_decay_rate
            reason = f"衰減速率適中（後期均值 {avg_last3:.1f}），維持現值"

        recommendations["decay_rate_mult"] = {
            "label": "情緒衰減速率 (Decay Rate)",
            "current": cur_decay_rate,
            "recommended": round(rec_decay, 2),
            "reason": reason,
        }

    # ── 4. Analyze per-candidate errors → recognition_penalty, party_bonus, incumbency ──
    import re
    _indep_kw = ["無黨", "無所屬", "無黨籍", "未經政黨推薦"]
    _exec_kw = ["市長", "縣長", "總統"]

    for comp in comparisons:
        key = comp["key"]
        sim = comp["simulated"]
        actual = comp["actual"]
        diff = sim - actual  # positive = over-estimate

        # Independent / minor party candidate
        if any(k in key for k in _indep_kw):
            if diff < -3:
                rec_recog = max(cur_recognition - 0.05, 0.0)
                reason = f"「{key}」模擬 {sim:.1f}% vs 實際 {actual:.1f}%，小黨/無黨被低估，建議降低知名度懲罰"
            elif diff > 3:
                rec_recog = min(cur_recognition + 0.05, 0.5)
                reason = f"「{key}」模擬 {sim:.1f}% vs 實際 {actual:.1f}%，小黨/無黨被高估，建議提高知名度懲罰"
            else:
                rec_recog = cur_recognition
                reason = f"「{key}」偏差合理（{diff:+.1f}%），維持現值"
            recommendations["recognition_penalty"] = {
                "label": "知名度懲罰 (Recognition Penalty)",
                "current": cur_recognition,
                "recommended": round(rec_recog, 3),
                "reason": reason,
            }

        # Major party candidate (check party_align_bonus)
        if any(k in key for k in ["國民黨", "民進黨", "民主進步黨", "中國國民黨"]):
            if diff > 5:
                rec_party = max(cur_party_bonus - 3, 0)
                reason = f"「{key}」模擬 {sim:.1f}% vs 實際 {actual:.1f}%，大黨加成過高，建議降低"
            elif diff < -5:
                rec_party = min(cur_party_bonus + 3, 30)
                reason = f"「{key}」模擬 {sim:.1f}% vs 實際 {actual:.1f}%，大黨加成不足，建議提高"
            else:
                rec_party = cur_party_bonus
                reason = f"「{key}」偏差合理（{diff:+.1f}%），維持現值"
            recommendations["party_align_bonus"] = {
                "label": "政黨對齊加成 (Party Align Bonus)",
                "current": cur_party_bonus,
                "recommended": round(rec_party, 1),
                "reason": reason,
            }

        # Incumbent detection
        gt_info = str(ground_truth.get(key, ""))
        if any(k in key for k in _exec_kw) or any(k in gt_info for k in _exec_kw):
            if diff > 5:
                rec_inc = max(cur_incumbency - 3, 0)
                reason = f"「{key}」模擬 {sim:.1f}% vs 實際 {actual:.1f}%，現任者優勢過高，建議降低"
            elif diff < -5:
                rec_inc = min(cur_incumbency + 3, 25)
                reason = f"「{key}」模擬 {sim:.1f}% vs 實際 {actual:.1f}%，現任者優勢不足，建議提高"
            else:
                rec_inc = cur_incumbency
                reason = f"「{key}」偏差合理（{diff:+.1f}%），維持現值"
            recommendations["incumbency_bonus"] = {
                "label": "現任者加成 (Incumbency Bonus)",
                "current": cur_incumbency,
                "recommended": round(rec_inc, 1),
                "reason": reason,
            }

    # ── 5. Dynamic leaning shift ──
    if len(daily_summary) >= 3:
        first_leaning = daily_summary[0].get("by_leaning", {})
        last_leaning = daily_summary[-1].get("by_leaning", {})

        total_shift = 0
        for ln in first_leaning:
            if ln in last_leaning:
                first_sat = first_leaning[ln].get("avg_sat", 50)
                last_sat = last_leaning[ln].get("avg_sat", 50)
                total_shift += abs(last_sat - first_sat)

        if total_shift < 2:
            rec_sat_low = min(cur_shift_sat_low + 5, 45)
            rec_anx_high = max(cur_shift_anx_high - 5, 55)
            reason = f"光譜族群間滿意度幾乎無變化（總移動 {total_shift:.1f}），閾值過嚴，建議放寬"
        else:
            rec_sat_low = cur_shift_sat_low
            rec_anx_high = cur_shift_anx_high
            reason = f"光譜動態轉移正常（總移動 {total_shift:.1f}），維持現值"

        recommendations["dynamic_leaning"] = {
            "label": "政治傾向動態轉移 (Dynamic Leaning)",
            "current": {
                "shift_sat_threshold_low": cur_shift_sat_low,
                "shift_anx_threshold_high": cur_shift_anx_high,
                "shift_consecutive_days_req": cur_shift_days,
            },
            "recommended": {
                "shift_sat_threshold_low": rec_sat_low,
                "shift_anx_threshold_high": rec_anx_high,
                "shift_consecutive_days_req": cur_shift_days,
            },
            "reason": reason,
        }

    # Set defaults for any missing recommendations
    for key, label, cur_val in [
        ("news_impact", "新聞影響力 (News Impact)", cur_news_impact),
        ("delta_cap_mult", "情緒變動上限 (Delta Cap)", cur_delta_cap),
        ("decay_rate_mult", "情緒衰減速率 (Decay Rate)", cur_decay_rate),
        ("recognition_penalty", "知名度懲罰 (Recognition Penalty)", cur_recognition),
        ("party_align_bonus", "政黨對齊加成 (Party Align Bonus)", cur_party_bonus),
        ("incumbency_bonus", "現任者加成 (Incumbency Bonus)", cur_incumbency),
    ]:
        if key not in recommendations:
            recommendations[key] = {
                "label": label,
                "current": cur_val,
                "recommended": cur_val,
                "reason": "校準資料不足以分析，維持現值",
            }

    logger.info(f"Parameter recommendations generated: {len(recommendations)} items")
    return recommendations


def flatten_recommendations(recs: dict) -> dict:
    """Convert recommend_params() output to a flat {key: value} dict for auto-apply."""
    flat: dict = {}
    for key, rec in recs.items():
        if key == "dynamic_leaning":
            # Nested dict with sub-keys
            recommended = rec.get("recommended", {})
            if isinstance(recommended, dict):
                for sub_key, sub_val in recommended.items():
                    flat[sub_key] = sub_val
        else:
            flat[key] = rec.get("recommended", rec.get("current"))
    return flat


def _push_calib_live(job: dict, msg: str):
    """Push a live message to the calibration job."""
    if "live_messages" not in job:
        job["live_messages"] = []
    job["live_messages"].append({"ts": time.time(), "text": msg})
    if len(job["live_messages"]) > 8:
        job["live_messages"] = job["live_messages"][-8:]


# ── Multi-round auto-calibration ─────────────────────────────────────

def stop_auto_calib_job(job_id: str) -> bool:
    job = _auto_calib_jobs.get(job_id)
    if not job:
        return False
    job["status"] = "cancelled"
    # also stop current sub_job
    sub_id = job.get("current_sub_job")
    if sub_id:
        stop_calib_job(sub_id)
    return True


def get_auto_calib_job(job_id: str) -> dict | None:
    job = _auto_calib_jobs.get(job_id)
    if job is None:
        return None
    # Map 'iterations' → 'iteration_history' with frontend-expected field names
    if "iterations" in job and "iteration_history" not in job:
        job["iteration_history"] = [
            {
                "avg_score": it.get("avg_score", 0),
                "score_change": it.get("score_delta", 0) or 0,
                "iteration": it.get("iteration", 0),
                "pack_scores": it.get("pack_scores", {}),
            }
            for it in job["iterations"]
        ]
    return job


async def run_auto_calibration(
    pack_ids: list[str],
    agents: list[dict],
    concurrency: int = 5,
    start_date: str = "2023-12-13",
    end_date: str = "2024-01-13",
    sim_time_scale: int = 30,
    max_iterations: int = 5,
    convergence_threshold: float = 1.0,
    initial_scoring_params: dict | None = None,
    enable_kol: bool = False,
    kol_ratio: float = 0.05,
    kol_reach: float = 0.40,
    sampling_modality: str = "unweighted",
    enabled_vendors: list[str] | None = None,
) -> dict:
    """Start multi-round auto-calibration as a background task.

    Runs through multiple iterations, each time running calibration on all
    provided packs, collecting scores, generating parameter recommendations,
    and auto-applying them for the next iteration.
    """
    job_id = uuid.uuid4().hex[:8]
    job = {
        "job_id": job_id,
        "type": "auto_calibration",
        "pack_ids": pack_ids,
        "status": "pending",
        "max_iterations": max_iterations,
        "convergence_threshold": convergence_threshold,
        "sim_time_scale": sim_time_scale,
        "current_iteration": 0,
        "iterations": [],
        "best_iteration": None,
        "best_score": 0,
        "best_params": initial_scoring_params or {},
        "current_params": initial_scoring_params or {},
        "agent_count": len(agents),
        "started_at": time.time(),
        "completed_at": None,
        "error": None,
        "live_messages": [],
    }
    _auto_calib_jobs[job_id] = job
    asyncio.create_task(_run_auto_calibration_bg(
        job, pack_ids, agents, concurrency, start_date, end_date, sim_time_scale,
        max_iterations, convergence_threshold,
        enable_kol, kol_ratio, kol_reach,
        sampling_modality, enabled_vendors,
    ))
    return {"job_id": job_id, "status": "pending", "max_iterations": max_iterations}


async def _run_auto_calibration_bg(
    job: dict,
    pack_ids: list[str],
    agents: list[dict],
    concurrency: int,
    start_date: str,
    end_date: str,
    sim_time_scale: int,
    max_iterations: int,
    convergence_threshold: float,
    enable_kol: bool,
    kol_ratio: float,
    kol_reach: float,
    sampling_modality: str,
    enabled_vendors: list[str] | None,
):
    """Background: run multi-iteration auto-calibration."""
    import copy

    try:
        job["status"] = "running"
        current_params = dict(job.get("current_params", {}))
        prev_score = 0.0

        for iteration in range(1, max_iterations + 1):
            job["current_iteration"] = iteration
            _push_auto_live(job, f"🔄 第 {iteration}/{max_iterations} 輪校正開始...")

            # Run calibration on each pack and collect results
            pack_scores = []
            pack_recs = []
            all_daily_summaries = []

            # Sort packs chronologically by election_date for continuous simulation timeline
            loaded_packs = []
            for pack_id in pack_ids:
                pack = get_calibration_pack(pack_id)
                if pack:
                    loaded_packs.append(pack)
                else:
                    _push_auto_live(job, f"⚠️ 校準包 {pack_id} 不存在，跳過")

            loaded_packs.sort(key=lambda p: p.get("election_date") or "9999-99-99")

            import datetime

            for i, pack in enumerate(loaded_packs):
                pack_id = pack["pack_id"]
                _push_auto_live(job, f"  📦 執行校準包: {pack.get('name', pack_id)} ({pack.get('election_date', '無日期')})")

            # Merge events from all calibration packs and news_store (outside the pack loop)
            events = []
            for lp in loaded_packs:
                pack_events = lp.get("events", [])
                if pack_events:
                    events.extend(pack_events)
                    logger.info(f"Merged {len(pack_events)} events from pack '{lp.get('name', '?')}'")

            # Supplement with news from the previously saved AI fetches (news_store)
            try:
                from .news_store import list_news_fetches, get_news_fetch
                all_fetches = list_news_fetches()
                news_store_count = 0
                for f_meta in all_fetches:
                    f_start = f_meta.get("start_date", "")
                    f_end = f_meta.get("end_date", "")
                    # Simple overlap check
                    if f_start <= end_date and f_end >= start_date:
                        f_data = get_news_fetch(f_meta["fetch_id"])
                        if f_data and "events" in f_data:
                            events.extend(f_data["events"])
                            news_store_count += len(f_data["events"])
                
                if news_store_count > 0:
                    _push_auto_live(job, f"  📰 新聞庫補充 {news_store_count} 則")
                logger.info(f"News store: {news_store_count} events loaded from {len(all_fetches)} fetches")
            except Exception as e:
                logger.error(f"Failed to fetch news for auto_calib: {e}")
                
            # Determine simulation length and configure timeline sub_job
            try:
                import datetime
                d1 = datetime.datetime.strptime(start_date, "%Y-%m-%d")
                d2 = datetime.datetime.strptime(end_date, "%Y-%m-%d")
                total_real_days = max(1, (d2 - d1).days)
                pack_target_days = max(1, int(sim_time_scale * ((total_real_days) / 365.0)))
            except ValueError:
                pack_target_days = sim_time_scale

            # Sort and redistribute events across the virtual timeline
            events.sort(key=lambda e: e.get("date", ""))
            if events:
                _push_auto_live(job, f"  📰 共 {len(events)} 則新聞用於整條時間軸")
            else:
                _push_auto_live(job, f"  ⚠️ 沒有新聞事件可供模擬，將在無新聞狀態下進行校準")
                logger.warning("No events found for timeline calibration — running without news")
            if pack_target_days > 0 and len(events) > 0:
                events = _redistribute_events(events, pack_target_days)

            # Assign specific execution days to packs — evenly distribute across virtual timeline
            # With N packs sorted chronologically, pack i evaluates at ((i+1)/N) * total_days
            # This ensures each pack gets a fair simulation window with its own candidates
            pack_days = {}
            n_packs = len(loaded_packs)
            for i, p in enumerate(loaded_packs):
                v_day = max(1, int(((i + 1) / n_packs) * pack_target_days))
                while v_day in pack_days.values():
                    v_day += 1
                pack_days[p["pack_id"]] = v_day
            logger.info(f"Timeline pack_days (evenly spaced): {[(p.get('name','?'), pack_days.get(p['pack_id'])) for p in loaded_packs]}")
                
            _push_auto_live(job, f"⏳ 建立連續時間軸 (共 {pack_target_days} 虛擬天)")

            # Create a single sub-job for the whole timeline
            sub_job_id = f"{job['job_id']}_i{iteration}_timeline"
            sub_job = {
                "job_id": sub_job_id,
                "pack_id": "timeline",
                "pack_name": f"迭代 {iteration} 時間軸",
                "status": "pending",
                "current_event": 0,
                "total_events": len(events),
                "target_days": pack_target_days,
                "enable_kol": enable_kol,
                "kol_ratio": kol_ratio,
                "kol_reach": kol_reach,
                "sampling_modality": sampling_modality,
                "enabled_vendors": enabled_vendors,
                "scoring_params": current_params,
                # merge macro context from all packs
                "macro_context": "\n".join(p.get("macro_context", "") for p in loaded_packs if p.get("macro_context")),
                "agent_count": len(agents),
                "started_at": time.time(),
                "completed_at": None,
                "error": None,
                "daily_summary": [],
                "live_messages": [],
                
                # Extended info for continuous pack evaluation
                "timeline_packs": loaded_packs,
                "timeline_pack_days": pack_days,
                "timeline_evaluations": {}  # Store {pack_id: score_result}
            }
            job["current_sub_job"] = sub_job_id
            _calib_jobs[sub_job_id] = sub_job
            _calib_pauses[sub_job_id] = False
            _calib_stops[sub_job_id] = False            # Run the timeline calibration synchronously
            # Pack is a dummy container for events, actual ground truth is in sub_job config
            run_pack = {"events": events}
            await _run_calibration_bg(
                sub_job, run_pack, importlib.import_module("copy").deepcopy(agents), concurrency,
                scoring_params_override=current_params,
            )

            # Collect results from all pack checkpoints evaluated during the timeline
            evals = sub_job.get("timeline_evaluations", {})
            pack_scores = []
            pack_recs = []
            all_daily_summaries = sub_job.get("daily_summary", [])
            
            for p in loaded_packs:
                pid = p["pack_id"]
                if pid in evals:
                    res = evals[pid]
                    score = res.get("score", 0)
                    pack_scores.append(score)
                    if res.get("recommended_params"):
                        pack_recs.append(res["recommended_params"])
                    _push_auto_live(job, f"  ✅ {p.get('name', pid)} (Day {pack_days.get(pid)}) 分數: {score}")
                else:
                    _push_auto_live(job, f"  ❌ {p.get('name', pid)} 未產生評估結果")

            if sub_job.get("status") != "completed" and sub_job.get("status") != "simulating_votes":
                 _push_auto_live(job, f"  ❌ 時間軸執行異常中斷")

            # Calculate average score for this iteration
            if pack_scores:
                avg_score = sum(pack_scores) / len(pack_scores)
            else:
                avg_score = 0
                _push_auto_live(job, f"⚠️ 第 {iteration} 輪沒有有效結果")
                job["status"] = "failed"
                job["error"] = "No valid pack results in iteration"
                break

            # Merge recommendations from all packs
            merged_recs = {}
            if pack_recs:
                # Average the recommended values across packs
                all_keys = set()
                for r in pack_recs:
                    all_keys.update(r.keys())
                for key in all_keys:
                    values = [r[key] for r in pack_recs if key in r]
                    if not values:
                        continue
                    first = values[0]
                    if key == "dynamic_leaning":
                        # Special: average sub-keys
                        merged_rec = dict(first.get("recommended", {}))
                        merged_recs[key] = {**first, "recommended": merged_rec}
                    else:
                        avg_rec = sum(v.get("recommended", v.get("current", 0)) for v in values) / len(values)
                        merged_recs[key] = {**first, "recommended": round(avg_rec, 3)}

            # Generate flat params for next iteration
            new_params = flatten_recommendations(merged_recs) if merged_recs else current_params

            # Record this iteration
            iteration_record = {
                "iteration": iteration,
                "avg_score": round(avg_score, 2),
                "score_delta": round(avg_score - prev_score, 2) if iteration > 1 else None,
                "pack_scores": {pid: evals.get(pid, {}).get("score", 0) for pid in pack_ids},
                "params_used": dict(current_params),
                "params_recommended": dict(new_params),
                "recommendations": merged_recs,
            }
            job["iterations"].append(iteration_record)

            # Track best
            if avg_score > job["best_score"]:
                job["best_score"] = round(avg_score, 2)
                job["best_iteration"] = iteration
                job["best_params"] = dict(new_params)

            _push_auto_live(job, f"📊 第 {iteration} 輪平均分數: {avg_score:.1f} (Δ={avg_score - prev_score:+.1f})")

            # Check convergence
            if iteration > 1 and abs(avg_score - prev_score) < convergence_threshold:
                _push_auto_live(job, f"✅ 參數已收斂（分數變化 {abs(avg_score - prev_score):.2f} < {convergence_threshold}），停止迭代")
                break

            # Apply new params for next iteration
            current_params = dict(new_params)
            job["current_params"] = current_params
            prev_score = avg_score

            if iteration < max_iterations:
                param_changes = []
                for k, v in new_params.items():
                    old = iteration_record["params_used"].get(k)
                    if old is not None and old != v:
                        param_changes.append(f"{k}: {old}→{v}")
                if param_changes:
                    _push_auto_live(job, f"  🔧 自動調整: {', '.join(param_changes[:5])}")

        # Completed
        if job["status"] == "running":
            job["status"] = "completed"
        job["completed_at"] = time.time()
        job["current_params"] = job["best_params"]

        # Auto-save snapshot with best params (only if we have valid results)
        if job.get("best_iteration") is not None and job.get("best_score", 0) > 0:
            try:
                from .snapshot import save_snapshot, SNAPSHOTS_DIR
                import datetime
                ts = datetime.datetime.now().strftime("%m%d_%H%M")
                snap_name = f"自動校正快照 ({ts}) — 分數 {job['best_score']}"
                snap_desc = (
                    f"多輪自動校正完成。最佳分數: {job['best_score']}，"
                    f"最佳迭代: 第 {job['best_iteration']} 輪，"
                    f"共 {len(job['iterations'])} 輪"
                )
                # Save best_params into the snapshot's scoring_params
                snap_meta = save_snapshot(snap_name, snap_desc, pack_ids[0] if pack_ids else None)
                # Also persist best_params to the snapshot meta file
                snap_id = snap_meta.get("snapshot_id", "")
                if snap_id:
                    meta_path = os.path.join(SNAPSHOTS_DIR, snap_id, "meta.json")
                    if os.path.isfile(meta_path):
                        with open(meta_path) as f:
                            snap_data = json.load(f)
                        snap_data["scoring_params"] = job["best_params"]
                        snap_data["auto_calib_job_id"] = job["job_id"]
                        with open(meta_path, "w") as f:
                            json.dump(snap_data, f, ensure_ascii=False, indent=2)
                job["auto_snapshot_id"] = snap_meta.get("snapshot_id")
                job["auto_snapshot_name"] = snap_name
                _push_auto_live(job, f"📸 已自動儲存快照: {snap_name}")
            except Exception as snap_err:
                logger.warning(f"Auto-snapshot failed for auto-calibration: {snap_err}")
        else:
            _push_auto_live(job, f"⚠️ 無有效校準結果，不儲存快照")

        _push_auto_live(job, f"🎉 自動校正完成！最佳分數: {job['best_score']}（第 {job['best_iteration']} 輪）")
        logger.info(f"Auto-calibration completed: {job['job_id']}, best_score={job['best_score']}, iterations={len(job['iterations'])}")

    except Exception as e:
        logger.exception(f"Auto-calibration failed: {e}")
        job["status"] = "failed"
        job["error"] = str(e)
        job["completed_at"] = time.time()


def _push_auto_live(job: dict, msg: str):
    """Push a live message to the auto-calibration job."""
    if "live_messages" not in job:
        job["live_messages"] = []
    job["live_messages"].append({"ts": time.time(), "text": msg})
    if len(job["live_messages"]) > 20:
        job["live_messages"] = job["live_messages"][-20:]
