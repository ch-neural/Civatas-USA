"""Daily evolution engine.

For each agent:
  1. Receive a personalised news feed (from feed_engine)
  2. Call LLM to produce reasoning + detailed diary + numeric metrics
  3. Persist the diary entry and updated state
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any

logger = logging.getLogger(__name__)

# US-only English prompts. (The original Taiwan dual-path was removed in
# the Stage 1.9 cleanup — see docs/HISTORY.md.)
try:
    from .prompts import (
        EVOLUTION_PROMPT_TEMPLATE,
        DIARY_PROMPT_TEMPLATE,
        SCORING_PROMPT_TEMPLATE,
        RECENT_DIARY_HEADER,
    )
except ImportError:
    from prompts import (  # type: ignore
        EVOLUTION_PROMPT_TEMPLATE,
        DIARY_PROMPT_TEMPLATE,
        SCORING_PROMPT_TEMPLATE,
        RECENT_DIARY_HEADER,
    )

# ── Job store (persisted to disk to survive hot-reload / restart) ─────
DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
JOBS_FILE = os.path.join(DATA_DIR, "jobs.json")

_jobs: dict[str, dict] = {}
_stop_flags: dict[str, bool] = {}


def _load_jobs():
    """Load persisted jobs from disk on startup."""
    global _jobs
    if os.path.exists(JOBS_FILE):
        try:
            with open(JOBS_FILE, "r") as f:
                _jobs = json.load(f)
            # Mark any previously-running jobs as stopped (process was restarted)
            for job in _jobs.values():
                if job.get("status") in ("running", "pending"):
                    job["status"] = "stopped"
                    job["error"] = "Evolution engine restarted, job interrupted"
            _save_jobs()
            logger.info(f"Loaded {len(_jobs)} persisted jobs from {JOBS_FILE}")
        except Exception as e:
            logger.error(f"Failed to load jobs from {JOBS_FILE}: {e}")
            _jobs = {}


def _save_jobs():
    """Persist current jobs to disk."""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(JOBS_FILE, "w") as f:
            json.dump(_jobs, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"Failed to save jobs to {JOBS_FILE}: {e}")


# Load persisted jobs on module import
_load_jobs()


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)


def list_jobs() -> list[dict]:
    return list(_jobs.values())


def clear_jobs() -> int:
    """Clear all evolution jobs. Returns count of cleared jobs."""
    count = len(_jobs)
    _jobs.clear()
    _stop_flags.clear()
    _save_jobs()
    return count


def stop_job(job_id: str) -> bool:
    """Request a running job to stop. Returns True if job exists."""
    if job_id in _jobs:
        _stop_flags[job_id] = True
        return True
    return False


def should_stop(job_id: str) -> bool:
    """Check if a job should stop."""
    return _stop_flags.get(job_id, False)



def _build_articles_text(articles: list[dict]) -> str:
    parts = []
    for i, a in enumerate(articles, 1):
        title = a.get("title", "")
        summary = a.get("summary", "")
        source = a.get("source_tag", "")
        line = f"{i}. [{source}] {title}"
        if summary:
            line += f" — {summary}"
        parts.append(line)
    return "\n".join(parts)


# ── LLM Vendor Circuit Breaker ───────────────────────────────────────
# Tracks consecutive failures per vendor. After N failures, the vendor
# is suspended for X minutes to avoid wasting time on broken vendors.

_CIRCUIT_BREAKER_THRESHOLD = 5       # consecutive failures to trip
_CIRCUIT_BREAKER_COOLDOWN = 300      # seconds (5 minutes)

_vendor_failures: dict[str, int] = {}        # vendor → consecutive failure count
_vendor_tripped_at: dict[str, float] = {}    # vendor → timestamp when circuit tripped


def _is_vendor_available(vendor: str) -> bool:
    """Check if a vendor is available (not circuit-broken)."""
    if vendor not in _vendor_tripped_at:
        return True
    elapsed = time.time() - _vendor_tripped_at[vendor]
    if elapsed >= _CIRCUIT_BREAKER_COOLDOWN:
        # Cooldown expired, reset circuit breaker
        _vendor_failures.pop(vendor, None)
        _vendor_tripped_at.pop(vendor, None)
        logger.info(f"🔄 Circuit breaker reset for '{vendor}' (cooldown expired)")
        return True
    return False


def _record_vendor_failure(vendor: str):
    """Record a vendor failure and trip breaker if threshold reached."""
    _vendor_failures[vendor] = _vendor_failures.get(vendor, 0) + 1
    if _vendor_failures[vendor] >= _CIRCUIT_BREAKER_THRESHOLD:
        _vendor_tripped_at[vendor] = time.time()
        logger.warning(
            f"⛔ Circuit breaker TRIPPED for '{vendor}' "
            f"({_vendor_failures[vendor]} consecutive failures). "
            f"Suspended for {_CIRCUIT_BREAKER_COOLDOWN}s."
        )


def _record_vendor_success(vendor: str):
    """Reset failure count on success."""
    if vendor in _vendor_failures:
        _vendor_failures.pop(vendor, None)
        if vendor in _vendor_tripped_at:
            _vendor_tripped_at.pop(vendor, None)
            logger.info(f"✅ Circuit breaker recovered for '{vendor}'")


async def _call_llm(prompt: str, vendor: str | None = None, enabled_vendors: list[str] | None = None, expected_keys: list[str] | None = None, cancel_event: asyncio.Event | None = None, temperature_offset: float = 0.0) -> dict:
    """Call the LLM and parse the JSON response.

    On failure (API error OR truncated JSON), automatically retries with
    other available vendors until all vendors have been tried.
    Regex fallback is used only when ALL vendors produce invalid output.

    Args:
        enabled_vendors: If set, only these vendor names are allowed.
    """
    try:
        from openai import AsyncOpenAI
    except ImportError:
        raise RuntimeError("openai package not installed")

    # Build ordered vendor list: primary vendor first, then others shuffled
    try:
        from shared.llm_vendors import get_client_for_vendor, get_vendor_configs
        all_configs = get_vendor_configs()
        all_vendor_names = [c.name for c in all_configs]
    except Exception:
        all_vendor_names = []

    # Filter by enabled_vendors if provided
    if enabled_vendors is not None:
        all_vendor_names = [v for v in all_vendor_names if v in enabled_vendors]

    if vendor and vendor in all_vendor_names:
        # Vendor is enabled AND available: prioritize it first
        remaining = [v for v in all_vendor_names if v != vendor]
        import random as _rand
        _rand.shuffle(remaining)
        try_order = [vendor] + remaining
    elif vendor and (enabled_vendors is None or vendor not in enabled_vendors):
        # Vendor is disabled in the control panel: skip it, use only enabled vendors
        import random as _rand
        shuffled = list(all_vendor_names)
        _rand.shuffle(shuffled)
        try_order = shuffled  # Don't prepend the disabled vendor
        if vendor and enabled_vendors is not None and vendor not in enabled_vendors:
            logger.debug(f"Agent vendor '{vendor}' is disabled in control panel, using enabled vendors: {all_vendor_names[:3]}")
    else:
        # No specific vendor requested — try default env-based client first,
        # then fall back to named vendors if available.
        import random as _rand
        shuffled = list(all_vendor_names)
        _rand.shuffle(shuffled)
        try_order = [None] + shuffled

    # Sanitize prompt and system message to aggressively strip Unpaired Surrogates
    import unicodedata
    def _sanitize(s: str) -> str:
        if not s: return ""
        return ''.join(c for c in s if c in ('\n', '\t', '\r') or unicodedata.category(c) not in ('Cc', 'Cs'))

    safe_prompt = _sanitize(prompt)

    last_error = None
    last_text = None  # store last raw text for regex fallback
    for attempt_vendor in try_order:
        if cancel_event and cancel_event.is_set():
            raise asyncio.CancelledError("LLM call cancelled by user pause/stop.")
        # Circuit breaker: skip vendors that are suspended
        if attempt_vendor and not _is_vendor_available(attempt_vendor):
            continue

        temperature = 0.8
        resp_format_kwargs: dict = {"response_format": {"type": "json_object"}}

        if attempt_vendor:
            try:
                client, model, temp_override = get_client_for_vendor(attempt_vendor)
                if temp_override is not None:
                    temperature = temp_override
            except Exception:
                client = AsyncOpenAI(
                    api_key=os.getenv("LLM_API_KEY", ""),
                    base_url=os.getenv("LLM_BASE_URL") or None,
                    timeout=600.0,
                )
                model = os.getenv("LLM_MODEL", "gpt-4o-mini")
        else:
            client = AsyncOpenAI(
                api_key=os.getenv("LLM_API_KEY", ""),
                base_url=os.getenv("LLM_BASE_URL") or None,
                timeout=600.0,
            )
            model = os.getenv("LLM_MODEL", "gpt-4o-mini")

        # Some vendors/models don't support response_format
        if attempt_vendor and attempt_vendor.lower().startswith("moonshot"):
            resp_format_kwargs = {}
        if attempt_vendor and attempt_vendor.lower().startswith("ollama"):
            resp_format_kwargs = {"extra_body": {"options": {"num_ctx": 8192}}}

        # Reasoning models (deepseek-reasoner, o1, gpt-5) don't support response_format
        model_lower = model.lower() if model else ""
        if "reasoner" in model_lower or "reasoning" in model_lower or any(model_lower.startswith(p) for p in ("gpt-5", "o1", "o3", "o4")):
            resp_format_kwargs = {}

        # Newer OpenAI models (gpt-5, o1, o3) use max_completion_tokens instead of max_tokens
        token_kwargs: dict = {}
        if any(model_lower.startswith(p) for p in ("gpt-5", "o1", "o3", "o4")):
            token_kwargs["max_completion_tokens"] = 4096
            temperature = 1.0  # gpt-5/o-series only support temperature=1
        elif attempt_vendor and attempt_vendor.lower().startswith("ollama"):
            # Ollama qwen3.5 uses thinking mode that shares the token budget
            # with content output. 8192 gives enough room for thinking + longer diary JSON.
            token_kwargs["max_tokens"] = 8192
        else:
            token_kwargs["max_tokens"] = 4096

        # Reasoning models also only support temperature=1
        if "reasoner" in model_lower or "reasoning" in model_lower:
            temperature = 1.0

        # Ollama local models (especially qwen3.5) have a "thinking mode" that
        # consumes all max_tokens on internal chain-of-thought reasoning, leaving
        # the content field completely empty. Disable thinking with /no_think.
        system_msg = "You must respond ONLY with valid JSON. No markdown, no analysis, no explanation."
        if attempt_vendor and attempt_vendor.lower().startswith("ollama"):
            system_msg = "/no_think\n" + system_msg
        system_msg = _sanitize(system_msg)

        try:
            messages = []
            if system_msg:
                if any(model_lower.startswith(p) for p in ("gpt-5", "o1", "o3", "o4")):
                    messages.append({"role": "user", "content": f"{system_msg}\n\n{safe_prompt}"})
                else:
                    messages.append({"role": "system", "content": system_msg})
                    messages.append({"role": "user", "content": safe_prompt})
            else:
                messages.append({"role": "user", "content": safe_prompt})

            # Apply per-agent temperature offset for diversity
            _final_temp = max(0.1, min(2.0, temperature + temperature_offset))
            chat_coro = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=_final_temp,
                **token_kwargs,
                **resp_format_kwargs,
            )

            if cancel_event:
                # Run the coro and the event.wait() concurrently
                cancel_task = asyncio.create_task(cancel_event.wait())
                api_task = asyncio.create_task(chat_coro)
                # Wait for whichever finishes first
                done, pending = await asyncio.wait([api_task, cancel_task], return_when=asyncio.FIRST_COMPLETED)
                
                if cancel_task in done:
                    # Cancelled!
                    api_task.cancel()
                    raise asyncio.CancelledError("LLM call cancelled by user pause/stop.")
                else:
                    # Task completed
                    cancel_task.cancel()
                    resp = api_task.result()
            else:
                resp = await chat_coro
        except Exception as e:
            last_error = e
            fallback_label = attempt_vendor or "default"
            if attempt_vendor:
                _record_vendor_failure(attempt_vendor)
            logger.warning(f"LLM vendor '{fallback_label}' failed: {e}, trying next...")
            continue

        raw_content = resp.choices[0].message.content
        # Safety net: qwen3.5-style models may put output in reasoning field
        raw_reasoning = getattr(resp.choices[0].message, 'reasoning', None) or getattr(resp.choices[0].message, 'reasoning_content', None)
        if not raw_reasoning and hasattr(resp.choices[0].message, 'model_dump'):
            dump = resp.choices[0].message.model_dump()
            raw_reasoning = dump.get('reasoning') or dump.get('reasoning_content')
        
        fallback_label = attempt_vendor or "default"
        if not raw_content and raw_reasoning:
            # Extract the LAST JSON block from reasoning (actual answer is always at the end)
            import re as _re
            # Find all JSON-like blocks that contain actual values (not template placeholders)
            all_matches = list(_re.finditer(r'\{[^{}]*"(?:todays_diary|local_satisfaction|vote)"\s*:\s*(?:"[^"]+"|\d+)[^{}]*\}', raw_reasoning))
            if all_matches:
                # Use the LAST match (model's final answer, not a quoted template)
                raw_content = all_matches[-1].group()
                logger.warning(f"🔍 LLM '{fallback_label}' content empty, extracted last JSON from reasoning field.")
            else:
                logger.warning(f"🔍 LLM '{fallback_label}' content empty, reasoning has no valid JSON (len={len(raw_reasoning)}). Skipping.")
        elif not raw_content:
            msg_dict = resp.choices[0].message.model_dump() if hasattr(resp.choices[0].message, 'model_dump') else str(resp.choices[0].message)
            logger.warning(f"🔍 LLM '{fallback_label}' raw content is empty/None. Full message: {str(msg_dict)[:300]}")


        text = (raw_content or "").strip()

        # Strip markdown code fences if present
        if text.startswith("```"):
            first_line, _, rest = text.partition("\n")
            text = rest if rest else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
        last_text = text

        # Try parsing JSON
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            # Attempt 1: Try to repair truncated JSON (Ollama often truncates mid-string)
            repaired = text.rstrip()
            if repaired.startswith("{") and not repaired.endswith("}"):
                # Close any open string and object
                if repaired.count('"') % 2 == 1:
                    repaired += '"}'  # close open string + object
                else:
                    repaired += '}'   # just close object
                try:
                    parsed = json.loads(repaired)
                    logger.info(f"LLM response was truncated, repaired successfully")
                except json.JSONDecodeError:
                    parsed = None
            else:
                parsed = None

            # Attempt 2: Extract JSON object from surrounding text
            if parsed is None:
                import re as _re
                json_match = _re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text)
                if json_match:
                    try:
                        parsed = json.loads(json_match.group())
                        fallback_label = attempt_vendor or "default"
                        logger.info(f"LLM '{fallback_label}' returned JSON wrapped in text, extracted successfully")
                    except json.JSONDecodeError:
                        parsed = None

        if parsed is not None:
            if expected_keys is not None:
                missing = [k for k in expected_keys if k not in parsed]
                if not missing:
                    parsed["_llm_status"] = "ok_custom"
                    parsed["_llm_vendor"] = attempt_vendor or "default"
                    if attempt_vendor:
                        _record_vendor_success(attempt_vendor)
                    return parsed
                else:
                    fallback_label = attempt_vendor or "default"
                    logger.warning(f"⚠️ LLM '{fallback_label}' returned JSON missing {missing}, switching vendor...")
                    continue

            # Validate completeness: must have all 3 output fields
            has_local = "local_satisfaction" in parsed
            has_national = "national_satisfaction" in parsed
            has_anxiety = "updated_anxiety" in parsed
            has_old_sat = "updated_satisfaction" in parsed
            has_diary = "todays_diary" in parsed

            if (has_local and has_national and has_anxiety):
                # Perfect: all new fields present
                if attempt_vendor:
                    _record_vendor_success(attempt_vendor)
                if attempt_vendor != vendor and vendor is not None:
                    logger.info(f"LLM fallback: {vendor} → {attempt_vendor} succeeded")
                parsed["_llm_status"] = "ok"
                parsed["_llm_vendor"] = attempt_vendor or "default"
                return parsed
            elif has_old_sat and has_anxiety:
                # Old format but complete — accept with backward compat
                if attempt_vendor:
                    _record_vendor_success(attempt_vendor)
                if attempt_vendor != vendor and vendor is not None:
                    logger.info(f"LLM fallback: {vendor} → {attempt_vendor} succeeded (old format)")
                parsed["_llm_status"] = "ok_legacy"
                parsed["_llm_vendor"] = attempt_vendor or "default"
                return parsed
            elif has_diary or has_old_sat or has_local:
                # Partial response — has diary or at least one satisfaction field.
                # Fill in missing fields with safe defaults rather than rejecting.
                if not has_local and not has_old_sat:
                    parsed["updated_satisfaction"] = 50
                if not has_anxiety:
                    parsed["updated_anxiety"] = 50
                if attempt_vendor:
                    _record_vendor_success(attempt_vendor)
                fallback_label = attempt_vendor or "default"
                logger.info(f"LLM '{fallback_label}' returned partial JSON (diary present), filled defaults")
                parsed["_llm_status"] = "ok_partial"
                parsed["_llm_vendor"] = fallback_label
                return parsed
            else:
                # Truly truncated JSON — no useful fields at all, try next vendor
                missing = []
                if not has_local and not has_old_sat: missing.append("local_satisfaction")
                if not has_national and not has_old_sat: missing.append("national_satisfaction")
                if not has_anxiety: missing.append("updated_anxiety")
                if not has_diary: missing.append("todays_diary")
                fallback_label = attempt_vendor or "default"
                logger.warning(f"⚠️ LLM '{fallback_label}' returned empty JSON (missing: {', '.join(missing)}), switching vendor... Got keys: {list(parsed.keys())[:8]}, raw teaser: {str(parsed)[:200]}")
                continue
        else:
            # JSON parse failed entirely — try next vendor
            fallback_label = attempt_vendor or "default"
            logger.warning(f"⚠️ LLM '{fallback_label}' returned non-JSON, switching vendor... Text length: {len(text)}. Teaser: {text[:100]}")
            continue

    # ── All vendors exhausted — use regex fallback as last resort ──
    if last_text:
        import re
        local_m = re.search(r'"?local_satisfaction"?\s*[:=]\s*(\d+)', last_text)
        nat_m = re.search(r'"?national_satisfaction"?\s*[:=]\s*(\d+)', last_text)
        sat_m = re.search(r'"?updated_satisfaction"?\s*[:=]\s*(\d+)', last_text)
        anx_m = re.search(r'"?updated_anxiety"?\s*[:=]\s*(\d+)', last_text)
        diary_m = re.search(r'"?todays_diary"?\s*:\s*"([^"]*)', last_text)

        if not sat_m:
            sat_m = re.search(r'[Ss]atisfaction[:\s*]+(\d+)', last_text)
        if not anx_m:
            anx_m = re.search(r'[Aa]nxiety[:\s*]+(\d+)', last_text)

        if local_m or nat_m or sat_m or anx_m:
            local_val = int(local_m.group(1)) if local_m else (int(sat_m.group(1)) if sat_m else 50)
            nat_val = int(nat_m.group(1)) if nat_m else (int(sat_m.group(1)) if sat_m else 50)
            anx_val = int(anx_m.group(1)) if anx_m else 50
            logger.warning(f"⚠️ All vendors failed clean JSON. Regex recovered: local={local_val}, national={nat_val}, anx={anx_val}")
            return {
                "todays_diary": diary_m.group(1) if diary_m else last_text[:500],
                "local_satisfaction": local_val,
                "national_satisfaction": nat_val,
                "updated_satisfaction": int((local_val + nat_val) / 2),
                "updated_anxiety": anx_val,
                "_llm_status": "regex_fallback",
                "_llm_vendor": "regex",
            }

    logger.error(f"❌ All LLM vendors failed, no recoverable data")
    return {
        "todays_diary": (last_text or "")[:500],
        "local_satisfaction": 50,
        "national_satisfaction": 50,
        "updated_satisfaction": 50,
        "updated_anxiety": 50,
        "_llm_status": "all_failed",
        "_llm_vendor": "none",
    }


# ── Agent state management (workspace-scoped) ──────────────────────

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")

# Active workspace scoping — same pattern as news_pool.py
_active_ws: str = ""
_ACTIVE_WS_FILE = os.path.join(DATA_DIR, ".active_workspace")


def set_active_workspace(ws_id: str):
    """Set the active workspace. All state files will be scoped to this workspace."""
    global _active_ws
    if ws_id and ws_id != _active_ws:
        _active_ws = ws_id
        # Persist to disk so it survives service reload
        try:
            with open(_ACTIVE_WS_FILE, "w") as f:
                f.write(ws_id)
        except Exception:
            pass
        logger.info(f"[evolver] Active workspace set to: {ws_id}")


def _restore_active_workspace():
    """Restore active workspace from disk after service reload."""
    global _active_ws
    if not _active_ws:
        try:
            if os.path.isfile(_ACTIVE_WS_FILE):
                ws_id = open(_ACTIVE_WS_FILE).read().strip()
                if ws_id and os.path.isdir(os.path.join(DATA_DIR, "workspaces", ws_id)):
                    _active_ws = ws_id
                    logger.info(f"[evolver] Restored active workspace: {ws_id}")
        except Exception:
            pass


_restore_active_workspace()


def _ws_dir() -> str:
    """Return workspace-scoped data directory, creating if needed."""
    if _active_ws:
        d = os.path.join(DATA_DIR, "workspaces", _active_ws)
        os.makedirs(d, exist_ok=True)
        return d
    return DATA_DIR


def _state_file() -> str:
    return os.path.join(_ws_dir(), "agent_states.json")

def _diaries_file() -> str:
    return os.path.join(_ws_dir(), "diaries.json")

def _history_file() -> str:
    return os.path.join(_ws_dir(), "evolution_history.json")

def _profiles_file() -> str:
    return os.path.join(_ws_dir(), "agent_profiles.json")

# Legacy global paths (for backward compatibility)
STATE_FILE = os.path.join(DATA_DIR, "agent_states.json")
DIARIES_FILE = os.path.join(DATA_DIR, "diaries.json")
HISTORY_FILE = os.path.join(DATA_DIR, "evolution_history.json")
PROFILES_FILE = os.path.join(DATA_DIR, "agent_profiles.json")


def _load_states() -> dict[str, dict]:
    sf = _state_file()
    if os.path.isfile(sf):
        with open(sf) as f:
            return json.load(f)
    # Fallback to legacy global file
    if _active_ws and os.path.isfile(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def _save_states(states: dict):
    os.makedirs(_ws_dir(), exist_ok=True)
    with open(_state_file(), "w") as f:
        json.dump(states, f, ensure_ascii=False, indent=2)


def _load_profiles() -> dict[str, dict]:
    pf = _profiles_file()
    if os.path.isfile(pf):
        with open(pf) as f:
            return json.load(f)
    return {}


def _save_profiles(profiles: dict):
    os.makedirs(_ws_dir(), exist_ok=True)
    with open(_profiles_file(), "w") as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)


def _load_diaries() -> list[dict]:
    df = _diaries_file()
    if os.path.isfile(df):
        with open(df) as f:
            return json.load(f)
    if _active_ws and os.path.isfile(DIARIES_FILE):
        with open(DIARIES_FILE) as f:
            return json.load(f)
    return []


def _save_diaries(diaries: list[dict]):
    os.makedirs(_ws_dir(), exist_ok=True)
    with open(_diaries_file(), "w") as f:
        json.dump(diaries, f, ensure_ascii=False, indent=2)


def get_agent_diary(agent_id) -> list[dict]:
    """Get all diary entries for a specific agent."""
    diaries = _load_diaries()
    aid_str = str(agent_id)
    return [d for d in diaries if str(d.get("agent_id")) == aid_str or str(d.get("person_id")) == aid_str]


def get_agent_stats(agent_id: int) -> dict:
    """Get current dynamic metrics for a specific agent."""
    states = _load_states()
    key = str(agent_id)
    return states.get(key, {
        "agent_id": agent_id,
        "local_satisfaction": 50,
        "national_satisfaction": 50,
        "satisfaction": 50,
        "anxiety": 50,
        "days_evolved": 0,
    })


def get_all_agent_stats() -> dict[str, dict]:
    """Return all agents' current states (satisfaction, anxiety, etc) and shift logs."""
    states = _load_states()
    profiles = _load_profiles()
    
    # Merge leaning_shift_logs into the response
    for key, st in states.items():
        if key in profiles:
            st["leaning_shift_logs"] = profiles[key].get("leaning_shift_logs", [])
            st["persona_delta"] = profiles[key].get("persona_delta", "")
            
    return states


# ── Global evolution history ─────────────────────────────────────────

def _load_history() -> list[dict]:
    hf = _history_file()
    if os.path.isfile(hf):
        with open(hf) as f:
            return json.load(f)
    if _active_ws and os.path.isfile(HISTORY_FILE):
        with open(HISTORY_FILE) as f:
            return json.load(f)
    return []


def _save_history(history: list[dict]):
    os.makedirs(_ws_dir(), exist_ok=True)
    with open(_history_file(), "w") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)


def get_evolution_history() -> list[dict]:
    """Return the full cumulative evolution history across all runs."""
    return _load_history()


def get_total_evolved_days() -> int:
    """Return the total number of days evolved across all runs."""
    history = _load_history()
    return len(history)


# ── Personality modifiers for evolution ───────────────────────────────

def _personality_modifiers(personality: dict) -> dict:
    """Compute evolution modifiers from personality traits.

    Returns:
        decay_rate: how fast emotions drift back to baseline (higher = faster return)
        reaction_scale: multiplier for satisfaction/anxiety deltas (higher = more reactive)
        delta_cap: max absolute change per day (higher = more volatile)
    """
    # Defaults (moderate personality)
    decay_rate = 0.02  # retained for backward compat; satisfaction decay removed
    reaction_scale = 1.0
    delta_cap = 15  # raised from 8: allow meaningful daily shifts

    # Emotional stability → reaction_scale and delta_cap
    es = personality.get("emotional_stability", "fairly stable")
    if es in ("敏感衝動", "sensitive / impulsive"):
        reaction_scale *= 1.3
        delta_cap = 20  # raised from 10
        decay_rate = 0.015
    elif es in ("穩定冷靜", "stable and calm"):
        reaction_scale *= 0.7
        delta_cap = 10  # raised from 5
        decay_rate = 0.03

    # Expressiveness → amplifies reaction
    expr = personality.get("expressiveness", "moderate")
    if expr in ("高度表達", "highly expressive"):
        reaction_scale *= 1.15
    elif expr in ("沉默寡言", "reserved"):
        reaction_scale *= 0.85

    # Openness → affects how much opposing viewpoints influence
    # (This is handled in the prompt, but we also adjust decay slightly)
    op = personality.get("openness", "moderately open")
    if op in ("固守觀點", "set in views"):
        reaction_scale *= 0.9  # less affected overall
    elif op in ("開放多元", "open to new ideas"):
        reaction_scale *= 1.1  # more responsive to new info

    return {
        "decay_rate": decay_rate,
        "reaction_scale": reaction_scale,
        "delta_cap": delta_cap,
    }


# ── Core evolution loop ──────────────────────────────────────────────

async def evolve_one_day(
    agents: list[dict],
    news_pool: list[dict],
    day: int,
    feed_fn,
    memory_fn=None,
    job: dict | None = None,
    concurrency: int = 5,
    enabled_vendors: list[str] | None = None,
    cancel_event: "asyncio.Event | None" = None,
    district_news: dict[str, list[dict]] | None = None,
) -> list[dict]:
    """Run one day of evolution for all agents (concurrent).

    Returns list of diary entries produced this day.
    `concurrency` controls max parallel LLM calls (default 5).
    `district_news` is a dict mapping district → local articles for that area.
    """
    # Auto-derive enabled_vendors from agents' llm_vendor if not specified
    if enabled_vendors is None:
        agent_vendors = {a.get("llm_vendor") for a in agents if a.get("llm_vendor")}
        if agent_vendors:
            enabled_vendors = list(agent_vendors)
    from .feed_engine import select_feed, get_diet_rules
    from .life_events import roll_life_event
    import asyncio

    _feed_rules = get_diet_rules() or {}

    # Inject tracked candidate names into feed rules for candidate news boost
    if job and job.get("candidate_names"):
        _feed_rules["tracked_candidate_names"] = [n.lower() for n in job["candidate_names"] if n]

    states = _load_states()
    diaries = _load_diaries()
    agent_profiles = _load_profiles()

    # Pre-build per-agent read history and recent diary context
    agent_read_history: dict[int, set] = {}
    agent_recent_diaries: dict[int, str] = {}
    for d in diaries:
        aid_d = d.get("agent_id", -1)
        # Build read history (all article_ids this agent has ever seen)
        if aid_d not in agent_read_history:
            agent_read_history[aid_d] = set()
        for art_id in (d.get("fed_articles") or []):
            if art_id:
                agent_read_history[aid_d].add(art_id)

    # Build recent diary strings (last 3 entries per agent)
    from collections import defaultdict
    agent_diary_list: dict[int, list[dict]] = defaultdict(list)
    for d in diaries:
        agent_diary_list[d.get("agent_id", -1)].append(d)
    for aid_d, dlist in agent_diary_list.items():
        # Sort by day descending and take last 3
        recent = sorted(dlist, key=lambda x: x.get("day", 0), reverse=True)[:3]
        recent.reverse()  # chronological order
        lines = []
        for i, rd in enumerate(recent):
            _dtxt = rd.get('diary_text', '')
            is_latest = (i == len(recent) - 1)
            # Latest diary gets more text to preserve key sentiments
            max_len = 200 if is_latest else 120
            if len(_dtxt) > max_len:
                _dtxt = _dtxt[:max_len] + "…"
            tag = " (recent)" if is_latest else ""
            lines.append(f"- Day {rd.get('day', '?')}{tag}: {_dtxt}")
        if lines:
            # Build long-term memory section from agent state
            _ltm = ""
            _agent_state = states.get(str(aid_d), states.get(aid_d, {}))
            _mem_lines = _agent_state.get("memory_summary", []) if isinstance(_agent_state, dict) else []
            if _mem_lines:
                _ltm = "Your long-term memory (impressions from past significant events):\n" + "\n".join(f"  {m}" for m in _mem_lines) + "\n\n"
            agent_recent_diaries[aid_d] = RECENT_DIARY_HEADER.format(
                long_term_memory=_ltm,
                diary_entries="\n".join(lines),
            )

    # ── Social interaction: collect previous day's "social posts" ──
    # High-expression, high-anxiety agents' diaries become social posts
    social_posts: list[dict] = []
    if day > 1:
        import random as _rng
        prev_day = day - 1
        for d in diaries:
            if d.get("day") != prev_day:
                continue
            d_aid = d.get("agent_id", -1)
            d_text = d.get("diary_text", "")
            if not d_text or len(d_text) < 15:
                continue
            d_anx = d.get("anxiety", 50)
            # Find the agent record for this diary
            _ag = next((a for a in agents if a.get("person_id") == d_aid), None)
            if not _ag:
                continue
            expr = _ag.get("personality", {}).get("expressiveness", "moderate")
            # Only high-expression or high-anxiety agents produce social posts
            if expr in ("高度表達", "highly expressive") or d_anx >= 65:
                social_posts.append({
                    "agent_id": d_aid,
                    "district": _ag.get("district", ""),
                    "age": _ag.get("age", 40),
                    "leaning": d.get("political_leaning", _ag.get("political_leaning", "Tossup")),
                    "text": d_text[:150],
                    "anxiety": d_anx,
                })
        _rng.shuffle(social_posts)
        if social_posts and job is not None:
            _push_live(job, f"💬 {len(social_posts)} social posts circulating among neighbors today")

    # Reload feed rules each day so mid-evolution changes take effect
    _feed_rules = get_diet_rules()

    # ── Candidate awareness: extract candidate names from job for mention tracking ──
    _job_cand_names: list[str] = []
    if job:
        _job_cand_names = job.get("candidate_names", [])
        if not _job_cand_names:
            # Also collect from poll_groups
            for _pg in job.get("poll_groups", []):
                for _pc in _pg.get("candidates", []):
                    _n = _pc.get("name", "")
                    if _n and _n not in _job_cand_names:
                        _job_cand_names.append(_n)
    # Strip party suffix for matching: "徐欣瑩（國民黨）" → also match "徐欣瑩"
    import re as _re_cand
    _cand_short_names: dict[str, str] = {}  # short_name → full_name
    for _cn in _job_cand_names:
        _short = _re_cand.sub(r'[（(].+?[）)]', '', _cn).strip()
        _cand_short_names[_short] = _cn
        _cand_short_names[_cn] = _cn  # also match full name

    sem = asyncio.Semaphore(concurrency)
    # Shared mutable containers for collecting results
    day_entries: list[dict] = []
    state_updates: dict[str, dict] = {}
    _processed_count = [0]  # mutable counter for incremental save
    _incremental_lock = asyncio.Lock()

    async def _process_agent(agent: dict):
        # Skip this agent if a cancellation/pause was requested
        if cancel_event is not None and cancel_event.is_set():
            return
        aid = agent.get("person_id", 0)
        agent_name = agent.get("name", f"Agent #{aid}")
        key = str(aid)

        # Current state (or defaults)
        state = states.get(key, {
            "local_satisfaction": 50,
            "national_satisfaction": 50,
            "satisfaction": 50,
            "anxiety": 50,
            "days_evolved": 0,
        })

        # Load current state — no artificial decay toward midpoint.
        # Satisfaction persists from prior day; only LLM responses change it.
        local_satisfaction = state.get("local_satisfaction", state.get("satisfaction", 50))
        national_satisfaction = state.get("national_satisfaction", state.get("satisfaction", 50))
        anxiety = state.get("anxiety", 50)
        personality = agent.get("personality", {})
        individuality = agent.get("individuality", {})
        # Global multiplier scales all per-agent individuality values
        _idv_mult = (job.get("scoring_params", {}) if job else {}).get("individuality_multiplier", 1.0)
        modifiers = _personality_modifiers(personality)

        # Apply calibrated parameters if any
        prof = agent_profiles.get(key, {})
        param_adj = prof.get("param_adjustments", {})

        # Apply user-tunable multipliers from scoring_params
        sp = job.get("scoring_params", {}) if job else {}

        # Select personalised feed (with read dedup + temporal causality filter)
        read_hist = agent_read_history.get(aid)
        feed = select_feed(agent, news_pool, rules=_feed_rules, read_history=read_hist, current_day=day)

        # Inject KOL posts if enabled
        if job is not None and job.get("enable_kol"):
            trending = job.get("trending_posts", [])
            my_leaning = agent.get("political_leaning", "Tossup")
            
            def is_in_chamber(kol_ln, my_ln):
                if kol_ln == my_ln: return True
                if my_ln in ("中立", "Tossup") or kol_ln in ("中立", "Tossup"): return True
                if any(x in kol_ln for x in ("Dem","left")) and any(x in my_ln for x in ("Dem","left")): return True
                if any(x in kol_ln for x in ("Rep","right")) and any(x in my_ln for x in ("Rep","right")): return True
                return False

            import random
            for tp in trending:
                if isinstance(tp, dict) and is_in_chamber(tp.get("leaning", "中立"), my_leaning):
                    # 加入隨機推播機率，模擬社群演算法的觸及率 (從 diet rules 讀取)
                    _kol_prob = _feed_rules.get("kol_probability", 0.4) if _feed_rules else 0.4
                    if random.random() < _kol_prob:
                        kol_preview = tp['text'][:25] + "..." if len(tp.get('text', '')) > 25 else tp.get('text', '')
                        feed.append({
                            "article_id": f"kol-{hash(tp['text'])}",
                            "title": f"社群轉貼：{tp['text']}",
                            "summary": "",
                            "source_tag": "社群熱議",
                        })
                        if job is not None:
                            _push_live(job, f"📱 Agent #{aid} {agent_name} saw a shared post: \"{kol_preview}\"")

        # ── Feature 2: Personal Life Event (US catalog) ──
        life_event = None
        life_event_text = ""
        try:
            from .us_life_events import US_EVENT_CATALOG
            from .life_events import roll_life_event
            # Monkey-patch the catalog for US events
            import importlib
            le_mod = importlib.import_module(".life_events", package="app")
            _orig_catalog = getattr(le_mod, "EVENT_CATALOG", [])
            le_mod.EVENT_CATALOG = US_EVENT_CATALOG
            life_event = roll_life_event(agent, state, current_day)
            le_mod.EVENT_CATALOG = _orig_catalog  # restore
            if life_event:
                life_event_text = (
                    f"[Personal life event today]\n"
                    f"{life_event.get('prompt_hint', life_event.get('description', ''))}\n"
                    f"This event should strongly color your diary and mood today.\n"
                )
                _push_live(job, f"🎲 Agent #{aid} life event: {life_event['name']}")
        except Exception as e:
            logger.debug(f"Life event roll failed for agent {aid}: {e}")

        # ── Feature 1: Social Interaction — match nearby social posts ──
        import random as _rng
        my_district = agent.get("district", "")
        my_age = int(agent.get("age", 40)) if str(agent.get("age", "")).isdigit() else 40
        my_leaning_social = state.get("current_leaning", agent.get("political_leaning", "Tossup"))
        matched_posts: list[dict] = []
        for sp in social_posts:
            if sp["agent_id"] == aid:
                continue  # skip own posts
            # Match criteria: same district, OR similar age (±15), OR same leaning
            same_district = sp["district"] == my_district and my_district
            sp_age = int(sp.get("age", 40)) if str(sp.get("age", "")).isdigit() else 40
            similar_age = abs(sp_age - my_age) <= 15
            same_leaning = sp["leaning"] == my_leaning_social
            if same_district or (similar_age and same_leaning):
                if _rng.random() < 0.35:  # 35% chance of seeing each matched post
                    matched_posts.append(sp)
            if len(matched_posts) >= 3:  # cap at 3 social posts per agent
                break
        social_posts_text = ""
        if matched_posts:
            lines = [f"- 「{p['text'][:60]}」" for p in matched_posts]
            social_posts_text = f"【你也聽到身邊的人在說】\n" + "\n".join(lines)

        # ── Feature 3: District local news ──
        district_news_titles: list[str] = []
        district_news_text = ""
        if district_news and my_district:
            d_articles = district_news.get(my_district, [])
            if d_articles:
                # Pick up to N district articles (configurable via diet rules)
                _dn_count = _feed_rules.get("district_news_count", 2) if _feed_rules else 2
                d_feed = d_articles[:_dn_count]
                district_news_titles = [a.get("title", "") for a in d_feed]
                lines = [f"- {a['title']}" + (f"：{a['summary'][:50]}" if a.get('summary') else "") for a in d_feed]
                district_news_text = f"【你所在的{my_district}最近發生的事】\n" + "\n".join(lines)

        # ── Feature 5: Candidate Awareness Tracking ──
        # Load existing awareness from state; initialize from candidate visibility if first time
        cand_awareness: dict[str, float] = dict(state.get("candidate_awareness", {}))
        cand_sentiment: dict[str, float] = dict(state.get("candidate_sentiment", {}))
        # Per-candidate awareness floor derived from visibility settings.
        # A nationally-famous figure (e.g. TV anchor, sitting legislator) should
        # not decay below a baseline tied to their nationalVisibility, otherwise
        # 30 days of local news silence collapses their recognition to ~5% and
        # the vote-prediction LLM treats them as unknown. Always rebuild from
        # job (cheap) so the floor applies even on resumed runs.
        _cand_awareness_floor: dict[str, float] = {}
        _poll_groups_init = job.get("poll_groups", []) if job else []
        for _pg_i in _poll_groups_init:
            for _pc_i in _pg_i.get("candidates", []):
                _pcn = _pc_i.get("name", "")
                if not _pcn:
                    continue
                _nat_vis = float(_pc_i.get("nationalVisibility", _pc_i.get("national_visibility", 30))) / 100.0
                _loc_vis = float(_pc_i.get("localVisibility", _pc_i.get("local_visibility", 50))) / 100.0
                _origin_str = str(_pc_i.get("originDistricts", _pc_i.get("origin_districts", "")))
                _origins = [d.strip() for d in _origin_str.split(",") if d.strip()]
                _is_home = any(od in my_district or my_district in od for od in _origins) if my_district and _origins else False
                # Floor: 50% of home-district visibility OR 30% of national visibility,
                # whichever is higher. Hard minimum of 0.05 preserved for unknowns.
                _floor = max(0.05, 0.5 * _loc_vis if _is_home else 0.0, 0.3 * _nat_vis)
                _cand_awareness_floor[_pcn] = _floor
                if _pcn not in cand_awareness:
                    cand_awareness[_pcn] = _loc_vis if _is_home else _nat_vis

        # Count candidate mentions in today's feed + district news + social posts
        _all_text_today = " ".join(
            [a.get("title", "") + " " + a.get("summary", "") for a in feed]
            + district_news_titles
            + [p.get("text", "") for p in matched_posts]
        )
        _mention_boost = 0.08   # per mention
        _decay_rate = 0.02      # daily decay for unmentioned candidates
        _max_awareness = 1.0
        for _short, _full in _cand_short_names.items():
            if _short in _all_text_today:
                old_val = cand_awareness.get(_full, 0.1)
                cand_awareness[_full] = min(_max_awareness, old_val + _mention_boost)
                # Accumulate sentiment from today's articles (EWMA)
                _article_sents = [
                    a.get("candidate_sentiment", {}).get(_full, 0.0)
                    for a in feed
                    if _full in a.get("candidate_sentiment", {}) or _short in (a.get("title", "") + " " + a.get("summary", ""))
                ]
                if _article_sents:
                    _avg_sent = sum(_article_sents) / len(_article_sents)
                    old_sent = cand_sentiment.get(_full, 0.0)
                    cand_sentiment[_full] = old_sent * 0.7 + _avg_sent * 0.3
        # Decay candidates not mentioned today
        for _cn in list(cand_awareness.keys()):
            _short_match = any(s in _all_text_today for s, f in _cand_short_names.items() if f == _cn)
            if not _short_match:
                cand_awareness[_cn] = max(0.05, cand_awareness[_cn] - _decay_rate)
                # Sentiment decays toward neutral
                cand_sentiment[_cn] = cand_sentiment.get(_cn, 0.0) * 0.9

        # Build awareness text for LLM prompt
        _awareness_labels = {
            (0.0, 0.15): "完全沒聽過",
            (0.15, 0.30): "只聽過名字",
            (0.30, 0.50): "略有印象",
            (0.50, 0.70): "有一定認識",
            (0.70, 0.85): "相當熟悉",
            (0.85, 1.01): "非常了解",
        }
        def _aw_label(v: float) -> str:
            for (lo, hi), label in _awareness_labels.items():
                if lo <= v < hi:
                    return label
            return "略有印象"

        candidate_awareness_text = ""
        if cand_awareness:
            lines = [f"- {cn}：{_aw_label(v)}（{int(v*100)}%）" for cn, v in sorted(cand_awareness.items(), key=lambda x: -x[1])]
            candidate_awareness_text = "[Your awareness of the following candidates]\n" + "\n".join(lines) + "\nYour familiarity level affects how you evaluate them. For less-known candidates, your impression is vaguer and more susceptible to a single news story.\n"

        # Inject tracked person OBJECTIVE FACTS
        # Use pre-computed objective facts from job (generated once at evolution start)
        if job and not candidate_awareness_text:
            _obj_facts = job.get("_candidate_objective_facts", {})
            _cand_facts_lines = []
            _sources = []
            for _pg in job.get("poll_groups", []):
                _sources.extend(_pg.get("candidates", []))
            if not _sources:
                _sources = job.get("tracked_candidates", [])
            for _pc in _sources:
                _cn = _pc.get("name", "")
                _cp = _pc.get("party", "")
                # Use LLM-extracted objective fact if available, otherwise just name+party
                if _cn in _obj_facts:
                    _cand_facts_lines.append(f"- {_obj_facts[_cn]}")
                elif _cn:
                    _cand_facts_lines.append(f"- {_cn}（{_cp}）" if _cp else f"- {_cn}")
            if _cand_facts_lines:
                candidate_awareness_text = "[Candidates you are tracking]\n" + "\n".join(_cand_facts_lines) + "\nIf today's news mentions any of these people, pay special attention.\n"
        elif cand_awareness and job:
            # Add objective facts to existing awareness text
            _obj_facts = job.get("_candidate_objective_facts", {})
            _desc_lines = []
            for _pg in job.get("poll_groups", []):
                for _pc in _pg.get("candidates", []):
                    _cn = _pc.get("name", "")
                    if _cn and _cn in cand_awareness and _cn in _obj_facts:
                        _desc_lines.append(f"  {_obj_facts[_cn]}")
            if _desc_lines:
                candidate_awareness_text += "\n".join(_desc_lines) + "\n"

        if not feed and not life_event and not matched_posts:
            avg_sat = round((local_satisfaction + national_satisfaction) / 2, 1)
            state_updates[key] = {
                "agent_id": aid,
                "district": agent.get("district", state.get("district", "")),
                "local_satisfaction": round(local_satisfaction, 1),
                "national_satisfaction": round(national_satisfaction, 1),
                "satisfaction": avg_sat,
                "anxiety": round(anxiety, 1),
                "days_evolved": state.get("days_evolved", 0) + 1,
                "candidate_awareness": cand_awareness,
                "candidate_sentiment": cand_sentiment,
            }
            day_entries.append({
                "agent_id": aid,
                "day": day,
                "fed_articles": [],
                "fed_titles": [],
                "diary_text": "",
                "local_satisfaction": round(local_satisfaction, 1),
                "national_satisfaction": round(national_satisfaction, 1),
                "satisfaction": avg_sat,
                "anxiety": round(anxiety, 1),
            })
            return

        # Push live message: processing this agent
        if job is not None:
            news_preview = feed[0]["title"][:30] + "..." if feed else "(no news)"
            extra = ""
            if life_event:
                extra += f" ⚡{life_event['name']}"
            if matched_posts:
                extra += f" 💬{len(matched_posts)} social"
            _push_live(job, f"🔄 Agent #{aid} {agent_name} reading news... ({news_preview}){extra}")

        # Build recent diary context for short-term memory
        recent_diary_text = agent_recent_diaries.get(aid, "")

        # Build the evolution prompt
        persona_desc = agent.get("user_char", "") or agent.get("description", "")
        p_delta = prof.get("persona_delta", "")
        if p_delta:
            persona_desc = f"{persona_desc}\n【經歷近期事件後的價值觀變化】：{p_delta}"

        current_leaning = state.get("current_leaning", agent.get("political_leaning", "Tossup"))
        political_leaning = current_leaning
        articles_text = _build_articles_text(feed)

        # ── Feature 4: Multi-dimensional political attitudes ──
        attitudes = state.get("political_attitudes")
        if not attitudes:
            # Initialize from coarse leaning
            if current_leaning == "偏左派":
                attitudes = {"economic_stance": 35, "social_values": 30, "cross_strait": 25, "issue_priority": "主權"}
            elif current_leaning == "偏右派":
                attitudes = {"economic_stance": 65, "social_values": 70, "cross_strait": 75, "issue_priority": "經濟"}
            else:
                attitudes = {"economic_stance": 50, "social_values": 50, "cross_strait": 50, "issue_priority": "民生"}

        # Convert attitude scores to descriptive labels for the LLM prompt.
        def _att_label(val: int) -> str:
            if val <= 20: return "strongly left"
            if val <= 35: return "left"
            if val <= 45: return "slightly left"
            if val <= 55: return "centrist"
            if val <= 65: return "slightly right"
            if val <= 80: return "right"
            return "strongly right"
        _econ_label = _att_label(attitudes["economic_stance"])
        _social_label = _att_label(attitudes["social_values"])
        _cross_label = _att_label(attitudes["cross_strait"])

        agent_vendor = agent.get("llm_vendor")
        _ev = enabled_vendors or (job.get("enabled_vendors") if job else None)
        is_ollama = (agent_vendor and agent_vendor.lower().startswith("ollama"))

        if is_ollama:
            # ── Multi-step mode for local models ──
            # Step 1: Generate diary
            diary_prompt = DIARY_PROMPT_TEMPLATE.format(
                persona_desc=persona_desc,
                political_leaning=political_leaning,
                income_band=agent.get("income_band", agent.get("context", {}).get("income_band", "")) or "not provided",
                marital_status=agent.get("marital_status", agent.get("context", {}).get("marital_status", "")) or "not provided",
                media_habit=agent.get("media_habit", agent.get("context", {}).get("media_habit", "")) or "not provided",
                expressiveness=personality.get("expressiveness", "moderate"),
                articles_text=articles_text,
            )
            try:
                step1 = await _call_llm(diary_prompt, vendor=agent_vendor, enabled_vendors=_ev, expected_keys=["todays_diary"], cancel_event=cancel_event)
            except (Exception, asyncio.CancelledError) as e:
                if isinstance(e, asyncio.CancelledError):
                    _push_live(job, f"⚠️ Agent #{aid} cancelled (interrupt)")
                    return
                logger.error(f"LLM step1 (diary) failed for agent {aid}: {e}")
                return

            diary_text = step1.get("todays_diary", "")

            # Step 2: Score satisfaction from diary
            scoring_prompt = SCORING_PROMPT_TEMPLATE.format(
                political_leaning=political_leaning,
                local_satisfaction=round(local_satisfaction),
                national_satisfaction=round(national_satisfaction),
                anxiety=round(anxiety),
                diary=diary_text,
            )
            try:
                step2 = await _call_llm(scoring_prompt, vendor=agent_vendor, enabled_vendors=_ev, expected_keys=["local_satisfaction"], cancel_event=cancel_event)
            except (Exception, asyncio.CancelledError) as e:
                if isinstance(e, asyncio.CancelledError):
                    _push_live(job, f"⚠️ Agent #{aid} cancelled (interrupt)")
                    return
                logger.error(f"LLM step2 (scoring) failed for agent {aid}: {e}")
                return

            # Merge results
            result = {**step1, **step2}
            result["_llm_status"] = step2.get("_llm_status", "ok")
            result["_llm_vendor"] = step1.get("_llm_vendor", agent_vendor)
        else:
            # ── Single-call mode for commercial APIs ──
            macro_context = job.get("macro_context", "").strip() if job else ""
            macro_context_text = f"[Macro political & economic context]\n{macro_context}\n" if macro_context else ""

            # Extract demographic fields for richer prompt
            _ag_age = agent.get("age", agent.get("context", {}).get("age", ""))
            _ag_gender = agent.get("gender", agent.get("context", {}).get("gender", ""))
            _ag_occupation = agent.get("occupation", agent.get("context", {}).get("occupation", ""))
            _ag_race = agent.get("race", agent.get("context", {}).get("race", "")) or "not provided"
            _ag_hispanic = agent.get("hispanic_or_latino", agent.get("context", {}).get("hispanic_or_latino", "")) or "not provided"
            _ag_income = agent.get("household_income", agent.get("income_band", agent.get("context", {}).get("income_band", ""))) or "not provided"
            _ag_marital = agent.get("marital_status", agent.get("context", {}).get("marital_status", "")) or "not provided"
            _ag_household = agent.get("household_type", agent.get("context", {}).get("household_type", "")) or "not provided"
            _ag_media = agent.get("media_habit", agent.get("context", {}).get("media_habit", "")) or "not provided"
            _ag_issue1 = agent.get("issue_1", agent.get("context", {}).get("issue_1", ""))
            _ag_issue2 = agent.get("issue_2", agent.get("context", {}).get("issue_2", ""))
            _ag_issues = ", ".join(filter(None, [_ag_issue1, _ag_issue2])) or "none specified"

            # Build cognitive bias text from individuality
            _cog_bias = individuality.get("cognitive_bias", "")
            _BIAS_DESC = {
                "optimistic": "You tend to see things on the bright side. Even negative news, you find a positive read on. When economic data is bad, you feel \"the worst is behind us\". Your satisfaction does not drop easily.",
                "pessimistic": "You tend to worry about the worst outcome. Negative news makes you especially anxious; good news feels \"too good to last\". Your anxiety rises easily.",
                "rational": "You judge things with data and logic. You're not easily moved by clickbait — you read the substance first. Your emotional swings are small; satisfaction and anxiety move gently.",
                "conformist": "You care a lot about what people around you think. If everyone is complaining, you join in; if friends say it's fine, you feel okay too. Social-media posts influence you a lot.",
                "conspiracy-prone": "You're skeptical of mainstream media and official statements. You often feel there's a hidden story behind events. You favor alternative information sources and treat official numbers with suspicion.",
                "scapegoating": "Whatever bad happens, you blame the people in power. Personal misfortunes also get attributed to politics. Your local/federal satisfaction drops sharply on negative news.",
                "apathetic": "You're basically apathetic about political news. Unless it directly affects your life (prices, paycheck), it won't change your mood. Your numerical changes should be small.",
            }
            cognitive_bias_text = ""
            if _cog_bias and _cog_bias in _BIAS_DESC:
                cognitive_bias_text = (
                    f"[Your cognitive bias: {_cog_bias}]\n{_BIAS_DESC[_cog_bias]}\n"
                    f"This bias shapes how you interpret news and which way your emotions move. "
                    f"Make sure your diary and numbers reflect it.\n"
                )

            # Generate semantic descriptions for current state
            _ls = round(local_satisfaction)
            _ns = round(national_satisfaction)
            _ax = round(anxiety)
            _local_desc = "quite satisfied" if _ls >= 70 else "fairly satisfied" if _ls >= 55 else "neutral" if _ls >= 45 else "somewhat dissatisfied" if _ls >= 30 else "very dissatisfied"
            _national_desc = "quite satisfied" if _ns >= 70 else "fairly satisfied" if _ns >= 55 else "neutral" if _ns >= 45 else "somewhat dissatisfied" if _ns >= 30 else "very dissatisfied"
            _anxiety_desc = "highly anxious" if _ax >= 70 else "moderately anxious" if _ax >= 55 else "average" if _ax >= 40 else "relaxed"

            _issue_priority = attitudes.get("issue_priority", "cost of living")

            prompt = EVOLUTION_PROMPT_TEMPLATE.format(
                persona_desc=persona_desc,
                political_leaning=political_leaning,
                race=_ag_race,
                hispanic_or_latino=_ag_hispanic,
                household_income=_ag_income,
                marital_status=_ag_marital,
                household_type=_ag_household,
                media_habit=_ag_media,
                issues=_ag_issues,
                economic_stance_label=_econ_label,
                social_values_label=_social_label,
                cross_strait_label=_cross_label,
                issue_priority=_issue_priority,
                local_satisfaction=round(local_satisfaction),
                national_satisfaction=round(national_satisfaction),
                anxiety=round(anxiety),
                local_sentiment_desc=_local_desc,
                national_sentiment_desc=_national_desc,
                anxiety_desc=_anxiety_desc,
                n_articles=len(feed),
                articles_text=articles_text,
                recent_diary=recent_diary_text,
                macro_context_text=macro_context_text,
                life_event_text=life_event_text,
                social_posts_text=social_posts_text,
                district_news_text=district_news_text,
                candidate_awareness_text=candidate_awareness_text,
                cognitive_bias_text=cognitive_bias_text,
                expressiveness=personality.get("expressiveness", "moderate"),
                emotional_stability=personality.get("emotional_stability", "fairly stable"),
                sociability=personality.get("sociability", "moderately social"),
                openness=personality.get("openness", "moderately open"),
                age_hint=str(_ag_age)[:5] if _ag_age else "?",
                race_hint=str(_ag_race)[:25] if _ag_race and _ag_race != "not provided" else "",
                gender_hint=str(_ag_gender)[:2] if _ag_gender else "?",
                occupation_hint=str(_ag_occupation)[:10] if _ag_occupation else "?",
            )

            # (C) Temperature variance: per-agent temperature offset from individuality
            _temp_offset = individuality.get("temperature_offset", 0.0) * _idv_mult

            async with sem:
                try:
                    result = await _call_llm(prompt, vendor=agent_vendor, enabled_vendors=_ev, cancel_event=cancel_event, temperature_offset=_temp_offset)
                except Exception as e:
                    if isinstance(e, asyncio.CancelledError):
                        _push_live(job, f"⚠️ Agent #{aid} cancelled (interrupt)")
                        return
                    logger.error(f"LLM call failed for agent {aid}: {e}")
                    return

        diary_text = result.get("todays_diary", "")
        reasoning_text = result.get("reasoning", "")
        news_relevance = result.get("news_relevance", "medium")
        llm_status = result.get("_llm_status", "ok")
        llm_vendor_used = result.get("_llm_vendor", "")
        # Parse dual satisfaction — backward compat: fallback to single updated_satisfaction
        raw_local = result.get("local_satisfaction", result.get("updated_satisfaction", round(local_satisfaction)))
        raw_national = result.get("national_satisfaction", result.get("updated_satisfaction", round(national_satisfaction)))
        new_anxiety = result.get("updated_anxiety", round(anxiety))

        # ── Parse multi-dimensional attitude shifts from LLM ──
        # Civatas-USA Stage 1.5: extended with US enums (inclusive/restrictive)
        # for the third axis. The cross_strait field name is reused but US
        # workspaces emit national_identity_shift instead — both are accepted.
        _shift_map = {"left": -3, "progressive": -3, "independence": -3, "inclusive": -3,
                      "none": 0, "": 0,
                      "right": +3, "conservative": +3, "unification": +3, "restrictive": +3}
        _econ_shift_raw = str(result.get("economic_stance_shift", "none")).strip().lower()
        _social_shift_raw = str(result.get("social_values_shift", "none")).strip().lower()
        _cross_shift_raw = str(
            result.get("cross_strait_shift",
                       result.get("national_identity_shift", "none"))
        ).strip().lower()
        new_attitudes = {
            "economic_stance": max(0, min(100, attitudes["economic_stance"] + _shift_map.get(_econ_shift_raw, 0))),
            "social_values": max(0, min(100, attitudes["social_values"] + _shift_map.get(_social_shift_raw, 0))),
            "cross_strait": max(0, min(100, attitudes["cross_strait"] + _shift_map.get(_cross_shift_raw, 0))),
            "issue_priority": result.get("issue_priority", attitudes.get("issue_priority", "民生")),
        }

        # Apply personality modulation to deltas
        reaction_scale = modifiers["reaction_scale"]
        reaction_scale *= param_adj.get("reaction_scale_multiplier", 1.0)
        delta_cap = modifiers["delta_cap"]
        # Override delta_cap from individuality if available
        if individuality.get("delta_cap"):
            delta_cap = individuality["delta_cap"]

        # ── Individual Differentiation (from agent.individuality) ──
        import random as _idv_rng
        _idv_seed = hash(f"{aid}_{day}") & 0xFFFFFFFF
        _idv_rng.seed(_idv_seed)

        # Read per-agent individuality (computed at persona generation)
        # Fall back to personality-based defaults if not present
        _idv_react = 1.0 + (individuality.get("reaction_multiplier", 1.0) - 1.0) * _idv_mult
        reaction_scale *= _idv_react

        # Apply user-tunable delta_cap multiplier from scoring_params
        delta_cap_mult = sp.get("delta_cap_mult", 1.0)
        delta_cap *= delta_cap_mult

        # Apply news_relevance scaling: reduce deltas when news is irrelevant
        # Raised floors so that even tangential news produces observable shifts
        relevance_scale = {"none": 0.2, "low": 0.5, "medium": 0.8, "high": 1.0}.get(news_relevance, 0.7)

        local_delta = raw_local - local_satisfaction
        national_delta = raw_national - national_satisfaction
        anx_delta = new_anxiety - anxiety

        # Scale the delta by personality reaction factor AND news relevance
        local_delta = local_delta * reaction_scale * relevance_scale
        national_delta = national_delta * reaction_scale * relevance_scale
        anx_delta = anx_delta * reaction_scale * relevance_scale

        # Asymmetry correction: LLMs tend to produce lower satisfaction values,
        # causing persistent downward drift. Slightly dampen negative deltas
        # and slightly boost positive deltas to counterbalance this bias.
        if local_delta < 0:
            local_delta *= 0.85  # dampen negative
        elif local_delta > 0:
            local_delta *= 1.15  # boost positive
        if national_delta < 0:
            national_delta *= 0.85
        elif national_delta > 0:
            national_delta *= 1.15
        if anx_delta > 0:
            anx_delta *= 0.85  # dampen anxiety increases
        elif anx_delta < 0:
            anx_delta *= 1.15  # boost anxiety decreases

        # ── Apply life event effects directly (bypasses LLM modulation) ──
        if life_event:
            local_delta += life_event.get("effects", {}).get("local_satisfaction_delta", 0)
            national_delta += life_event.get("effects", {}).get("national_satisfaction_delta", 0)
            anx_delta += life_event.get("effects", {}).get("anxiety_delta", 0)
            local_delta += life_event.get("effects", {}).get("satisfaction_delta", 0)

        # Cap the delta to prevent extreme swings
        local_delta = max(-delta_cap, min(delta_cap, local_delta))
        national_delta = max(-delta_cap, min(delta_cap, national_delta))
        anx_delta = max(-delta_cap, min(delta_cap, anx_delta))

        new_local_sat = local_satisfaction + local_delta
        new_national_sat = national_satisfaction + national_delta
        new_anxiety = anxiety + anx_delta

        # Per-agent noise from individuality (pre-computed at persona generation)
        _idv_noise = individuality.get("noise_scale", 1.0) * 5 * _idv_mult  # base amplitude 5, scaled by agent × global mult
        if _idv_noise > 0:
            new_local_sat += _idv_rng.gauss(0, _idv_noise * 0.5)
            new_national_sat += _idv_rng.gauss(0, _idv_noise * 0.5)
            new_anxiety += _idv_rng.gauss(0, _idv_noise * 0.4)

        # Per-agent memory inertia from individuality
        _idv_inertia = individuality.get("memory_inertia", 0.15) * _idv_mult
        if _idv_inertia > 0:
            new_local_sat = new_local_sat * (1 - _idv_inertia) + local_satisfaction * _idv_inertia
            new_national_sat = new_national_sat * (1 - _idv_inertia) + national_satisfaction * _idv_inertia
            new_anxiety = new_anxiety * (1 - _idv_inertia) + anxiety * _idv_inertia

        # Apply decay toward baseline — configurable via scoring_params
        # Decay pulls values toward 50 (neutral). This prevents runaway extremes
        # but can also fight against calibrated starting points if too strong.
        _sp_decay = job.get("scoring_params", {}) if job else {}
        _anxiety_decay = _sp_decay.get("anxiety_decay", 0.05)
        _satisfaction_decay = _sp_decay.get("satisfaction_decay", 0.02)
        if _anxiety_decay > 0:
            new_anxiety = new_anxiety * (1 - _anxiety_decay) + 50 * _anxiety_decay
        if _satisfaction_decay > 0:
            new_local_sat = new_local_sat * (1 - _satisfaction_decay) + 50 * _satisfaction_decay
            new_national_sat = new_national_sat * (1 - _satisfaction_decay) + 50 * _satisfaction_decay

        # Clamp
        new_local_sat = max(0, min(100, int(new_local_sat)))
        new_national_sat = max(0, min(100, int(new_national_sat)))
        new_anxiety = max(0, min(100, int(new_anxiety)))
        new_satisfaction = int((new_local_sat + new_national_sat) / 2)  # backward compat

        # ── Unified Dynamic Leaning Shift Logic ──
        sp = job.get("scoring_params", {}) if job else {}
        shift_enabled = sp.get("enable_dynamic_leaning", True)
        # Use UI slider values for thresholds (UI default is usually 25-35)
        shift_sat_low = sp.get("shift_sat_threshold_low", 20)
        shift_sat_high = 100 - shift_sat_low
        shift_anx_high = sp.get("shift_anx_threshold_high", 80)
        shift_days_req = sp.get("shift_consecutive_days_req", 5)

        consecutive_extreme_days = state.get("consecutive_extreme_days", 0)
        leaning_shifted = False

        if shift_enabled:
            target_leaning = current_leaning
            shift_msg = ""

            # Evaluate threshold conditions directionally
            if current_leaning == "偏右派" and new_local_sat <= shift_sat_low:
                target_leaning = "中立"
                shift_msg = "對在地施政嚴重不滿，政治傾向轉為中立"
            elif current_leaning == "偏右派" and new_anxiety >= shift_anx_high and new_local_sat < 50:
                # High anxiety + below-average local satisfaction: disenchanted with ruling party
                target_leaning = "中立"
                shift_msg = "高焦慮且對在地施政不滿，政治傾向軟化為中立"
            elif current_leaning == "偏左派" and new_national_sat <= shift_sat_low:
                target_leaning = "中立"
                shift_msg = "對中央施政嚴重不滿，政治傾向轉為中立"
            elif current_leaning == "偏左派" and new_anxiety >= shift_anx_high and new_national_sat < 50:
                # High anxiety + below-average national satisfaction: disenchanted with ruling party
                target_leaning = "中立"
                shift_msg = "高焦慮且對中央施政不滿，政治傾向軟化為中立"
            elif current_leaning == "中立":
                if new_local_sat >= shift_sat_high and new_national_sat < 50:
                    target_leaning = "偏右派"
                    shift_msg = "高度認同在地施政，政治傾向轉為偏右派"
                elif new_national_sat >= shift_sat_high and new_local_sat < 50:
                    target_leaning = "偏左派"
                    shift_msg = "高度認同中央施政，政治傾向轉為偏左派"

            if target_leaning != current_leaning:
                # Threshold condition met; increment consecutive days
                consecutive_extreme_days += 1
                if consecutive_extreme_days >= shift_days_req:
                    leaning_shifted = True
            else:
                # Reset counter if condition naturally breaks
                consecutive_extreme_days = 0

            # Execute the shift if verified
            if leaning_shifted:
                old_leaning = current_leaning
                current_leaning = target_leaning
                consecutive_extreme_days = 0
                
                # Append to persona delta
                prof = agent_profiles.get(key, {})
                old_delta = prof.get("persona_delta", "")
                if shift_msg not in old_delta:
                    prof["persona_delta"] = f"{old_delta} [{shift_msg}]".strip()
                
                # Create detailed UI shift log
                causal_news = feed[-1].get("title", "未知新聞") if feed else "累積情緒"
                shift_log = {
                    "day": day,
                    "from": old_leaning,
                    "to": current_leaning,
                    "news": causal_news,
                    "reasoning": reasoning_text
                }
                prof_logs = prof.get("leaning_shift_logs", [])
                prof_logs.append(shift_log)
                prof["leaning_shift_logs"] = prof_logs
                agent_profiles[key] = prof
                
                if job is not None: _push_live(job, f"🔄 Agent #{aid} {shift_msg}")
                diary_text = f"[傾向轉變: {shift_msg}]\n{diary_text}"

        # NOTE: Attitude-derived leaning shift is DISABLED.
        # In modern Taiwan, cross_strait attitudes cluster at 30-60 even for partisan voters
        # (per NCCU 2025 stance data), causing att_score to collapse to ~50 for everyone.
        # This made nearly all 偏右派 agents drift to 中立 within 2 days.
        # Leaning shifts now rely solely on satisfaction/anxiety threshold-based logic above,
        # which correctly captures disenchantment with governance rather than attitude misalignment.

        # Update the mutable agent dict so it carries over to predictor
        agent["political_leaning"] = current_leaning

        # Push live message: diary generated
        if job is not None:
            old_avg = int((local_satisfaction + national_satisfaction) / 2)
            anx_icon = "😰" if new_anxiety > anxiety else "😌"
            snippet = diary_text[:40] + ("..." if len(diary_text) > 40 else "")
            status_tag = ""
            if llm_status == "regex_fallback":
                status_tag = " ⚠️regex"
            elif llm_status == "all_failed":
                status_tag = " ❌failed"
            elif llm_status == "ok_legacy":
                status_tag = " 🔄legacy"
            if llm_status == "ok_partial":
                status_tag = " ⚡partial"
            rel_tag = f" [{news_relevance}]" if news_relevance != "medium" else ""
            _push_live(job, f"📝 Agent #{aid} wrote diary: \"{snippet}\"  Local {new_local_sat} Nat'l {new_national_sat} {anx_icon}{int(new_anxiety)}{rel_tag}{status_tag}")

        # Create diary entry
        entry = {
            "agent_id": aid,
            "day": day,
            "fed_articles": [a.get("article_id") for a in feed],
            "fed_titles": [a.get("title") for a in feed],
            "diary_text": diary_text,
            "reasoning": reasoning_text,
            "political_leaning": current_leaning,
            "news_relevance": news_relevance,
            "local_satisfaction": new_local_sat,
            "national_satisfaction": new_national_sat,
            "satisfaction": new_satisfaction,
            "anxiety": new_anxiety,
            "llm_status": llm_status,
            "llm_vendor": llm_vendor_used,
            # New features
            "life_event": {"id": life_event["id"], "name": life_event["name"], "description": life_event["description"]} if life_event else None,
            "social_posts_seen": [{"from_agent": p["agent_id"], "text": p["text"][:60]} for p in matched_posts] if matched_posts else [],
            "district_news_titles": district_news_titles,
            "political_attitudes": new_attitudes,
            "candidate_awareness": dict(cand_awareness),
            "candidate_sentiment": dict(cand_sentiment),
        }
        day_entries.append(entry)
        diaries.append(entry)

        # Store to vector memory if available (non-blocking)
        if memory_fn:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(memory_fn, aid, day, diary_text, {
                        "local_satisfaction": new_local_sat,
                        "national_satisfaction": new_national_sat,
                        "satisfaction": new_satisfaction,
                        "anxiety": new_anxiety,
                    }),
                    timeout=600.0,
                )
            except asyncio.TimeoutError:
                logger.warning(f"Memory store timed out for agent {aid} day {day}, skipping")
            except Exception as e:
                logger.warning(f"Memory store failed for agent {aid}: {e}")

        # Collect state update
        _event_history = list(state.get("life_event_history", []))
        if life_event:
            _event_history.append({"event_id": life_event["id"], "day": day})
        state_updates[key] = {
            "agent_id": aid,
            "district": agent.get("district", state.get("district", "")),
            "local_satisfaction": new_local_sat,
            "national_satisfaction": new_national_sat,
            "satisfaction": new_satisfaction,
            "anxiety": new_anxiety,
            "days_evolved": state.get("days_evolved", 0) + 1,
            "current_leaning": current_leaning,
            "consecutive_extreme_days": consecutive_extreme_days,
            "actual_vendor": llm_vendor_used or agent.get("llm_vendor", ""),
            "political_attitudes": new_attitudes,
            "life_event_history": _event_history,
            "candidate_awareness": cand_awareness,
            "candidate_sentiment": cand_sentiment,
            "_derived_leaning_prev": state.get("_derived_leaning_prev"),
            "_derived_leaning_days": state.get("_derived_leaning_days", 0),
        }

        # Incremental update job daily summary for real-time UI
        if job is not None and "daily_summary" in job:
            # Find or create the summary object for the current day
            daily_summaries = job["daily_summary"]
            current_summary = None
            for s in daily_summaries:
                if s["day"] == day:
                    current_summary = s
                    break
            
            if not current_summary:
                current_summary = {
                    "day": day,
                    "avg_satisfaction": 50,
                    "avg_anxiety": 50,
                    "entries_count": 0,
                    "by_leaning": {},
                    "sat_distribution": {"0-20": 0, "20-40": 0, "40-60": 0, "60-80": 0, "80-100": 0},
                    "high_sat_count": 0,
                    "high_anx_count": 0,
                }
                
                # Pre-populate all known leanings so the UI doesn't drop rows
                leaning_map = job.get("agent_leaning_map", {})
                all_leanings = set(leaning_map.values()) if leaning_map else {"中立", "偏左派", "偏右派"}
                for l in all_leanings:
                    total_for_leaning = sum(1 for v in leaning_map.values() if v == l) if leaning_map else 0
                    current_summary["by_leaning"][l] = {
                        "avg_sat": 0,
                        "avg_anx": 0,
                        "count": 0,
                        "total_count": total_for_leaning,
                    }
                    
                daily_summaries.append(current_summary)
            
            # Update the partial running totals for the UI
            current_summary["entries_count"] += 1

            # ── 1. Initialize Global Accumulators ──
            g_sat_sum = 0
            g_anx_sum = 0
            g_count = 0
            g_sat_dist = {"0-20": 0, "20-40": 0, "40-60": 0, "60-80": 0, "80-100": 0}
            g_hi_sat = 0
            g_hi_anx = 0
            g_by_leaning = {}

            cand_names = job.get("candidate_names", [])
            sp = job.get("scoring_params", {})
            party_base: dict = sp.get("party_base", {})
            party_align_bonus = sp.get("party_align_bonus", 15)
            incumbency_bonus = sp.get("incumbency_bonus", 12)
            news_impact = sp.get("news_impact", 1.0)
            recognition_penalty = sp.get("recognition_penalty", 0.15)
            cand_descs = job.get("candidate_descriptions", {})

            # Build candidate visibility lookup from poll_groups
            _poll_groups = job.get("poll_groups", [])
            _cand_visibility: dict[str, dict] = {}  # cname -> {lv, nv, origins}
            for _pg in _poll_groups:
                for _pc in _pg.get("candidates", []):
                    _pcname = _pc.get("name", "")
                    if _pcname:
                        _cand_visibility[_pcname] = {
                            "lv": float(_pc.get("localVisibility", _pc.get("local_visibility", 50))) / 100.0,
                            "nv": float(_pc.get("nationalVisibility", _pc.get("national_visibility", 50))) / 100.0,
                            "origins": [d.strip() for d in str(_pc.get("originDistricts", _pc.get("origin_districts", ""))).split(",") if d.strip()],
                        }

            # Helper for candidate score lookup
            _major_keywords = ["國民黨", "民進黨", "民主進步黨", "中國國民黨"]
            _minor_keywords = ["民眾黨", "台灣民眾黨", "臺灣民眾黨", "時代力量", "台灣基進"]
            _indep_keywords = ["無黨", "無所屬", "無黨籍", "未經政黨推薦"]

            def _resolve_base(party_name: str) -> float:
                if party_name in party_base: return float(party_base[party_name])
                if any(k in party_name for k in _major_keywords): return 50.0
                if any(k in party_name for k in _minor_keywords): return 30.0
                if any(k in party_name for k in _indep_keywords): return 5.0
                return 30.0

            g_cand_sums = {c: 0.0 for c in cand_names}
            g_cand_sums["不表態"] = 0.0
            g_total_w = 0.0
            g_lean_cand_sums = {}
            g_dim_cand_district = {}
            g_dim_cand_gender = {}
            g_dim_cand_vendor = {}

            # Build a fast lookup for actual vendor from today's diary entries
            # (day_entries captures llm_vendor_used for already-completed agents)
            day_entry_vendor_map: dict[str, str] = {
                str(e["agent_id"]): e["llm_vendor"]
                for e in day_entries
                if e.get("llm_vendor") and e.get("agent_id") is not None
            }

            import re as _re

            # ── 2. Global Pass Over ALL Agents ──
            for ag in agents:
                ag_id = str(ag.get("person_id", 0))
                
                # Fetch state: priority is live update > loaded state > traits default
                if ag_id in state_updates:
                    ag_local_sat = state_updates[ag_id].get("local_satisfaction", state_updates[ag_id].get("satisfaction", 50))
                    ag_nat_sat = state_updates[ag_id].get("national_satisfaction", state_updates[ag_id].get("satisfaction", 50))
                    ag_sat = state_updates[ag_id]["satisfaction"]
                    ag_anx = state_updates[ag_id]["anxiety"]
                else:
                    ag_state = states.get(ag_id, {})
                    ag_local_sat = ag_state.get("local_satisfaction", ag_state.get("satisfaction", 50))
                    ag_nat_sat = ag_state.get("national_satisfaction", ag_state.get("satisfaction", 50))
                    ag_sat = ag_state.get("satisfaction", 50)
                    ag_anx = ag_state.get("anxiety", 50)
                
                ag_leaning = ag.get("political_leaning", "中立")

                # Accumulate Global Satisfaction / Anxiety
                g_sat_sum += ag_sat
                g_anx_sum += ag_anx
                g_count += 1
                
                if ag_sat < 20: g_sat_dist["0-20"] += 1
                elif ag_sat < 40: g_sat_dist["20-40"] += 1
                elif ag_sat < 60: g_sat_dist["40-60"] += 1
                elif ag_sat < 80: g_sat_dist["60-80"] += 1
                else: g_sat_dist["80-100"] += 1

                if ag_sat > 60: g_hi_sat += 1
                if ag_anx > 60: g_hi_anx += 1

                if ag_leaning not in g_by_leaning:
                    g_by_leaning[ag_leaning] = {"sat_sum": 0, "anx_sum": 0, "count": 0}
                g_by_leaning[ag_leaning]["sat_sum"] += ag_sat
                g_by_leaning[ag_leaning]["anx_sum"] += ag_anx
                g_by_leaning[ag_leaning]["count"] += 1

                # Accumulate Global Candidate Estimates (if names exist)
                if cand_names:
                    cand_scores_local: dict[str, float] = {}
                    for ci, cname in enumerate(cand_names):
                        desc = cand_descs.get(cname, cname)
                        _pm = _re.search(r'[（(](.+?)[）)]', cname)
                        cand_party = _pm.group(1) if _pm else ""

                        # ── Party detection: use cand_party (from name) first, desc as fallback ──
                        party_src = cand_party or desc
                        is_kmt = any(k in party_src for k in ["國民黨", "中國國民黨"])
                        is_dpp = any(k in party_src for k in ["民進黨", "民主進步黨"])
                        is_tpp = any(k in party_src for k in ["民眾黨", "台灣民眾黨", "臺灣民眾黨"])
                        is_npp = any(k in party_src for k in ["時代力量", "台灣基進"])
                        is_independent = any(k in party_src for k in ["無黨", "無所屬", "無黨籍", "未經政黨推薦"])
                        is_major = is_kmt or is_dpp

                        score = _resolve_base(cand_party) if cand_party else (_resolve_base(desc) if not is_independent else 5.0)

                        if is_kmt and ("統" in ag_leaning or "藍" in ag_leaning): score += party_align_bonus
                        if is_dpp and ("本土" in ag_leaning or "綠" in ag_leaning): score += party_align_bonus
                        if is_tpp and ("中間" in ag_leaning or "中立" in ag_leaning): score += party_align_bonus * 0.6
                        if is_major and "中立" in ag_leaning: score += 3

                        # ── Trait detection (expanded for primary elections) ──
                        is_reform = any(k in desc for k in ["改革", "清新", "學者", "博士", "青年", "革新", "新世代"])
                        is_trad = any(k in desc for k in ["基層", "里長", "農漁會", "組織力", "深耕", "偏左派", "地方樁腳", "婦女會"])

                        # ── Executive / Admin detection (expanded) ──
                        is_exec = bool(_re.search(r'(現任|曾任)?[^，。,.\\n]{0,6}(市長|縣長|總統)', desc))
                        is_local_admin = any(k in desc for k in ["副市長", "副縣長", "局長", "處長", "秘書長", "市政", "行政經驗", "執政團隊"])
                        is_national_figure = any(k in desc for k in ["黨主席", "黨魁", "立法院", "副院長", "院長", "全國", "中央", "全國知名", "黨中央"])
                        is_legislator = any(k in desc for k in ["立委", "立法委員", "民意代表", "議員", "國會"])

                        # ── Dual Satisfaction Scoring ──
                        local_delta = (ag_local_sat - 50) * news_impact
                        national_delta = (ag_nat_sat - 50) * news_impact
                        anx_delta = (ag_anx - 50) * news_impact

                        if is_exec:
                            # Incumbent: strong base advantage, moderate local sensitivity
                            score += incumbency_bonus + local_delta * 0.8
                            if anx_delta > 0:
                                score += anx_delta * 0.5
                        elif is_local_admin:
                            # Local admin (e.g. 副市長): inherits some incumbent advantage
                            score += local_delta * 0.6
                            score += 3  # administrative competence bonus
                            if anx_delta > 0:
                                score += anx_delta * 0.3
                        elif is_national_figure:
                            # National figure (e.g. 黨主席/立法院副院長): national dynamics matter more
                            score += national_delta * 0.8
                            score += local_delta * 0.3
                            score += 4  # visibility/brand bonus
                            if anx_delta > 0:
                                score += anx_delta * 0.4
                        elif is_dpp:
                            score += national_delta * 1.2
                            score += local_delta * 0.3
                            score += anx_delta * 0.5
                        elif is_kmt and not is_exec:
                            score -= local_delta * 0.8
                            score -= national_delta * 1.0
                            score -= anx_delta * 0.3
                        elif is_reform:
                            score += anx_delta * 0.8 - local_delta * 0.5 - national_delta * 0.5
                        elif is_major:
                            score += local_delta * 0.5
                        else:
                            score += (local_delta + national_delta) * 0.15

                        if is_trad: score -= anx_delta * 0.5
                        if is_legislator and not is_national_figure:
                            score += national_delta * 0.4

                        # ── Trait-leaning affinity bonuses ──
                        if is_reform and ("中間" in ag_leaning or "中立" in ag_leaning): score += 4
                        if is_trad and "統" in ag_leaning: score += 4
                        if is_exec and is_kmt and ("統" in ag_leaning or "藍" in ag_leaning): score += 5
                        if is_exec and is_dpp and ("本土" in ag_leaning or "綠" in ag_leaning): score += 5
                        if is_local_admin and ("統" in ag_leaning or "藍" in ag_leaning): score += 3
                        if is_local_admin and is_trad: score += 2
                        if is_national_figure and ("中間" in ag_leaning or "中立" in ag_leaning): score += 4
                        if is_national_figure and is_reform: score += 2
                        dim_str = f"{ag.get('district', '')}_{ag.get('gender', '')}_{ag.get('llm_vendor', '')}_{cname}"
                        score += (hash(dim_str) % 40) / 10.0 - 2.0

                        # Recognition penalty: independents without party or exec backing
                        # are virtually unknown to voters
                        if is_independent and not is_exec:
                            score *= recognition_penalty

                        # Visibility-based awareness scaling
                        # Use dynamic awareness from evolution state if available
                        _dyn_aw_src = (state_updates.get(ag_id) or states.get(ag_id) or {}).get("candidate_awareness", {})
                        _dyn_aw_val = _dyn_aw_src.get(cname)
                        _vis = _cand_visibility.get(cname)
                        if _dyn_aw_val is not None:
                            _aw = float(_dyn_aw_val)
                            _ag_dist = ag.get("district", "")
                            _is_hometown = False
                            if _vis:
                                _is_hometown = any(od in _ag_dist or _ag_dist in od for od in _vis["origins"]) if _ag_dist and _vis["origins"] else False
                            score *= (0.3 + 0.7 * _aw)
                            if _is_hometown:
                                score += 8
                        elif _vis:
                            _ag_dist = ag.get("district", "")
                            _is_hometown = any(od in _ag_dist or _ag_dist in od for od in _vis["origins"]) if _ag_dist and _vis["origins"] else False
                            _aw = _vis["lv"] if _is_hometown else _vis["nv"]
                            score *= (0.3 + 0.7 * _aw)
                            if _is_hometown:
                                score += 8  # hometown bonus

                        cand_scores_local[cname] = max(0, score)

                    total_score = sum(cand_scores_local.values()) or 1.0

                    # Undecided probability: agents unhappy with ALL candidates abstain
                    # Base and max are user-tunable via scoring_params.
                    _base_undecided = sp.get("base_undecided", 0.10)
                    _max_undecided = sp.get("max_undecided", 0.45)
                    _both_unhappy = max(0, (50 - ag_local_sat) + (50 - ag_nat_sat)) / 100  # 0~1
                    _top_score = max(cand_scores_local.values()) if cand_scores_local else 0
                    _weak_field = max(0, (15 - _top_score) / 15) * 0.1  # 0~0.1 if no candidate excited them
                    undecided_prob = min(_max_undecided, _base_undecided + _both_unhappy * 0.30 + _weak_field)
                    
                    for cn in cand_names:
                        g_cand_sums[cn] += (cand_scores_local[cn] / total_score) * (1 - undecided_prob)
                    g_cand_sums["不表態"] += undecided_prob
                    g_total_w += 1.0

                    if ag_leaning not in g_lean_cand_sums:
                        g_lean_cand_sums[ag_leaning] = {c: 0.0 for c in cand_names}
                        g_lean_cand_sums[ag_leaning]["_count"] = 0.0
                    for cn in cand_names:
                        g_lean_cand_sums[ag_leaning][cn] += (cand_scores_local[cn] / total_score) * (1 - undecided_prob)
                    g_lean_cand_sums[ag_leaning]["_count"] += 1.0

                    # Use actual vendor: diary entry > state_updates > static persona
                    ag_id_str = str(ag.get("person_id", 0))
                    ag_actual_vendor = (
                        day_entry_vendor_map.get(ag_id_str)
                        or state_updates.get(ag_id_str, {}).get("actual_vendor")
                        or ag.get("llm_vendor", "未知")
                    )
                    for dim_name, dim_val in [("district", ag.get("district", "未知")), ("gender", ag.get("gender", "未知")), ("llm_vendor", ag_actual_vendor)]:
                        acc_dict = g_dim_cand_district if dim_name == "district" else (g_dim_cand_gender if dim_name == "gender" else g_dim_cand_vendor)
                        if dim_val not in acc_dict:
                            acc_dict[dim_val] = {c: 0.0 for c in cand_names}
                            acc_dict[dim_val]["_count"] = 0.0
                        for cn in cand_names:
                            acc_dict[dim_val][cn] += (cand_scores_local[cn] / total_score) * (1 - undecided_prob)
                        acc_dict[dim_val]["_count"] += 1.0

            # ── 3. Apply Global Accumulators to UI Summary ──
            if g_count > 0:
                current_summary["avg_satisfaction"] = round(g_sat_sum / g_count, 1)
                current_summary["avg_anxiety"] = round(g_anx_sum / g_count, 1)
            current_summary["sat_distribution"] = g_sat_dist
            current_summary["high_sat_count"] = g_hi_sat
            current_summary["high_anx_count"] = g_hi_anx

            for ln, st in g_by_leaning.items():
                if ln not in current_summary["by_leaning"]:
                    ex_tc = 1
                else:
                    ex_tc = current_summary["by_leaning"][ln].get("total_count", 1)
                
                c = st["count"] or 1
                current_summary["by_leaning"][ln] = {
                    "avg_sat": round(st["sat_sum"] / c, 1),
                    "avg_anx": round(st["anx_sum"] / c, 1),
                    "count": c,
                    "total_count": ex_tc,
                }

            if cand_names and g_total_w > 0:
                current_summary["candidate_estimate"] = {c: round((v / g_total_w) * 100, 1) for c, v in g_cand_sums.items()}
                
                def _build_dim_pcts(acc: dict) -> dict:
                    res = {}
                    for gn, sc in acc.items():
                        cnt = sc.get("_count", 1.0) or 1.0
                        res[gn] = {c: round((sc.get(c, 0) / cnt) * 100, 1) for c in cand_names}
                    return res

                current_summary["by_leaning_candidate"] = _build_dim_pcts(g_lean_cand_sums)
                current_summary["by_district_candidate"] = _build_dim_pcts(g_dim_cand_district)
                current_summary["by_gender_candidate"] = _build_dim_pcts(g_dim_cand_gender)
                current_summary["by_vendor_candidate"] = _build_dim_pcts(g_dim_cand_vendor)

        # Incremental save every 5 agents so bottom panel stays fresh
        _processed_count[0] += 1
        if job is not None:
            job["agents_processed"] = _processed_count[0]
            # Push progress message at regular intervals
            total = len(agents)
            progress_interval = max(1, total // 10)  # ~10 progress updates per day
            if _processed_count[0] % progress_interval == 0 or _processed_count[0] == total:
                pct = round(_processed_count[0] / total * 100)
                _push_live(job, f"👤 Progress: {_processed_count[0]}/{total} done ({pct}%)")
        if _processed_count[0] % 5 == 0:
            async with _incremental_lock:
                _tmp = _load_states()
                _tmp.update(state_updates)
                _save_states(_tmp)

    # Run all agents concurrently (limited by semaphore)
    if job is not None:
        job["agents_processed"] = 0
        job["agents_total"] = len(agents)
        _push_live(job, f"⚡ Processing {len(agents)} agents (concurrency {concurrency})")
    await asyncio.gather(*[_process_agent(a) for a in agents])

    # Apply all state updates atomically
    states.update(state_updates)
    _save_states(states)
    _save_diaries(diaries)
    _save_profiles(agent_profiles)

    # Collection of KOL trending posts for tomorrow
    if job is not None and job.get("enable_kol"):
        if "kol_agents" not in job:
            kol_ratio = job.get("kol_ratio", 0.05)
            total = len(agents)
            kol_count = max(1, int(total * kol_ratio))
            
            # Weighted random selection favoring extreme leanings
            weights = []
            for a in agents:
                ln = a.get("political_leaning", "")
                if ln in ["偏左派", "偏右派"]:
                    weights.append(3.0)
                elif ln in ["偏左派", "偏右派"]:
                    weights.append(1.5)
                else:
                    weights.append(1.0)
            
            import random
            total_weight = sum(weights)
            if total_weight > 0:
                probs = [w / total_weight for w in weights]
                try:
                    import numpy as np
                    kols = np.random.choice(agents, size=min(kol_count, total), replace=False, p=probs)
                    job["kol_agents"] = [k.get("person_id") for k in kols]
                except ImportError:
                    job["kol_agents"] = [k.get("person_id") for k in random.sample(agents, min(kol_count, total))]
            else:
                job["kol_agents"] = [k.get("person_id") for k in random.sample(agents, min(kol_count, total))]
            
            _push_live(job, f"📣 Loaded {len(job['kol_agents'])} KOL (key opinion leaders)")

        # Collect today's KOL diaries
        kol_ids = set(job.get("kol_agents", []))
        kol_diaries = []
        agent_leaning_map = {a.get("person_id"): a.get("political_leaning", "中立") for a in agents}
        
        for e in day_entries:
            aid = e.get("agent_id")
            if aid in kol_ids and e.get("diary_text"):
                kol_diaries.append({
                    "text": e.get("diary_text"),
                    "leaning": agent_leaning_map.get(aid, "中立")
                })

        if kol_diaries:
            import random
            random.shuffle(kol_diaries)
            job["trending_posts"] = kol_diaries[:5]
            _push_live(job, f"📢 {len(kol_diaries[:5])} popular social posts circulating among voters today")
        else:
            job["trending_posts"] = []

    return day_entries



# ── Live message helper ──────────────────────────────────────────────

MAX_LIVE_MESSAGES = 30
MAX_KOL_MESSAGES = 10  # KOL messages are kept separately

def _push_live(job: dict, msg: str):
    """Push a live activity message to the job (ring buffer).
    KOL messages (📱/📢/📣) are tagged and retained with higher priority."""
    if "live_messages" not in job:
        job["live_messages"] = []
    is_kol = any(icon in msg for icon in ["📱", "📢", "📣"])
    entry = {"ts": time.time(), "text": msg, "kol": is_kol}
    job["live_messages"].append(entry)
    # When over limit: remove oldest non-KOL messages first, then oldest KOL
    if len(job["live_messages"]) > MAX_LIVE_MESSAGES:
        # Separate KOL vs regular
        kol_msgs = [m for m in job["live_messages"] if m.get("kol")]
        reg_msgs = [m for m in job["live_messages"] if not m.get("kol")]
        # Trim regular first
        if len(reg_msgs) > MAX_LIVE_MESSAGES - MAX_KOL_MESSAGES:
            reg_msgs = reg_msgs[-(MAX_LIVE_MESSAGES - MAX_KOL_MESSAGES):]
        # Trim KOL if still too many
        if len(kol_msgs) > MAX_KOL_MESSAGES:
            kol_msgs = kol_msgs[-MAX_KOL_MESSAGES:]
        # Re-merge in chronological order
        merged = sorted(reg_msgs + kol_msgs, key=lambda m: m["ts"])
        job["live_messages"] = merged[-MAX_LIVE_MESSAGES:]


# ── Background job runner ────────────────────────────────────────────

async def start_evolution(
    agents: list[dict],
    days: int = 30,
    news_pool: list[dict] | None = None,
    concurrency: int = 5,
    candidate_names: list[str] | None = None,
) -> dict:
    """Start a multi-day evolution run as a background job."""
    from .news_pool import get_pool

    job_id = uuid.uuid4().hex[:8]
    pool = news_pool or get_pool()

    job = {
        "job_id": job_id,
        "status": "pending",
        "total_days": days,
        "current_day": 0,
        "agent_count": len(agents),
        "concurrency": concurrency,
        "started_at": time.time(),
        "completed_at": None,
        "error": None,
        "daily_summary": [],
        "live_messages": [],
        "candidate_names": candidate_names or [],
    }
    _jobs[job_id] = job
    _save_jobs()

    asyncio.create_task(_run_evolution_bg(job, agents, pool, days, concurrency))
    return {"job_id": job_id, "status": "pending", "total_days": days, "concurrency": concurrency}


async def _run_evolution_bg(
    job: dict, agents: list[dict], pool: list[dict], days: int, concurrency: int = 5
):
    """Background task: run evolution for N days."""
    try:
        job["status"] = "running"
        _save_jobs()
        memory_fn = None
        try:
            from .memory import store_diary
            memory_fn = store_diary
        except Exception:
            logger.warning("ChromaDB memory not available; skipping vector store.")

        # Load history to determine global day offset
        history = _load_history()
        global_day_offset = len(history)
        pool_article_count = len(pool)

        for day in range(1, days + 1):
            # Check stop flag
            if should_stop(job["job_id"]):
                job["status"] = "stopped"
                job["completed_at"] = time.time()
                _save_jobs()
                logger.info(f"[{job['job_id']}] Evolution stopped by user at day {day}")
                return

            job["current_day"] = day
            logger.info(f"[{job['job_id']}] Evolving day {day}/{days}")

            _push_live(job, f"🌅 Day {day} started — {len(agents)} agents receiving news...")
            
            # Setup agent leaning map for incremental updates
            agent_leaning_map = {}
            for a in agents:
                aid = str(a.get("person_id", 0))
                agent_leaning_map[aid] = a.get("political_leaning", "中立")
            job["agent_leaning_map"] = agent_leaning_map

            entries = await evolve_one_day(
                agents, pool, day,
                feed_fn=None,
                memory_fn=memory_fn,
                job=job,
                concurrency=concurrency,
            )

            # Aggregate daily stats
            if entries:
                avg_sat = sum(e["satisfaction"] for e in entries) / len(entries)
                avg_anx = sum(e["anxiety"] for e in entries) / len(entries)
            else:
                avg_sat = avg_anx = 50

            # Ensure the day_summary built incrementally by evolve_one_day is synced
            found_summary = None
            for s in job["daily_summary"]:
                if s["day"] == day:
                    found_summary = s
                    break
            
            if not found_summary:
                job["daily_summary"].append({
                    "day": day,
                    "completed_at": time.time(),
                    "avg_satisfaction": round(avg_sat, 1),
                    "avg_anxiety": round(avg_anx, 1),
                    "entries_count": len(entries),
                })
            else:
                # Finalize
                found_summary["avg_satisfaction"] = round(avg_sat, 1)
                found_summary["avg_anxiety"] = round(avg_anx, 1)
            _save_jobs()

            # Append to global history with injection marker
            global_day = global_day_offset + day
            history.append({
                "global_day": global_day,
                "run_day": day,
                "job_id": job["job_id"],
                "avg_satisfaction": round(avg_sat, 1),
                "avg_anxiety": round(avg_anx, 1),
                "entries_count": len(entries),
                "is_injection_point": day == 1,  # first day of each run = new news injection
                "pool_article_count": pool_article_count if day == 1 else None,
                "timestamp": time.time(),
            })
            _save_history(history)

            # Small delay between days to avoid flooding the LLM
            await asyncio.sleep(0.5)

        job["status"] = "completed"
        job["completed_at"] = time.time()
        _save_jobs()
        logger.info(f"[{job['job_id']}] Evolution completed ({days} days)")

    except Exception as e:
        logger.exception(f"[{job['job_id']}] Evolution failed: {e}")
        job["status"] = "failed"
        job["error"] = str(e)
        job["completed_at"] = time.time()
        _save_jobs()
