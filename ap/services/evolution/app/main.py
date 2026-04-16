"""Social Evolution service — FastAPI entry point.

Provides REST endpoints for:
  - News source management (add/remove/list)
  - Crawling trigger
  - News pool retrieval + manual injection
  - Diet rule configuration
  - Evolution execution + monitoring
  - Agent diary/stats retrieval
  - RAG memory search
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile, File, Request
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Civatas Evolution Service", version="0.1.0")


# ── Startup: recover stale recordings ────────────────────────────────
@app.on_event("startup")
def _startup_recover_recordings():
    from .recorder import recover_stale_recordings
    recover_stale_recordings()


# ── Request / Response models ────────────────────────────────────────

class AddSourceRequest(BaseModel):
    name: str
    url: str
    tag: str = "custom"
    selector_title: str = "h1, h2, h3, article a"
    selector_summary: str = "p"
    max_items: int = 10


class InjectArticleRequest(BaseModel):
    title: str
    summary: str
    source_tag: str = "manual"
    workspace_id: str = ""


class DietRulesUpdate(BaseModel):
    diet_map: dict[str, list[str]] | None = None
    serendipity_rate: float | None = None
    articles_per_agent: int | None = None
    leaning_weight: float | None = None
    channel_weight: float | None = None
    recency_weight: float | None = None
    demographic_weight: float | None = None
    read_penalty: float | None = None
    district_news_count: int | None = None
    kol_probability: float | None = None
    custom_sources: list[dict] | None = None
    source_leanings: dict[str, str] | None = None


class PreviewFeedRequest(BaseModel):
    agent: dict


class StartEvolutionRequest(BaseModel):
    agents: list[dict]
    days: int = 30
    concurrency: int = 0  # 0 = auto (enabled_vendors × 2)
    enabled_vendors: list[str] | None = None
    candidate_names: list[str] | None = None
    scoring_params: dict | None = None  # tunable evolution parameters
    candidate_descriptions: dict | None = None  # name -> description text
    party_detection: dict | None = None  # {"D": [...], "R": [...], "I": [...]}
    workspace_id: str = ""  # scope state + news pool to this workspace


class MemorySearchRequest(BaseModel):
    agent_id: int
    query: str
    n_results: int = 5


# ── Health ───────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "evolution"}


@app.get("/llm-vendors")
def llm_vendors():
    """Return available LLM vendors and their config status."""
    from shared.llm_vendors import get_available_vendors
    return {"vendors": get_available_vendors()}


# ── Source management ────────────────────────────────────────────────

@app.get("/sources")
def list_sources():
    from .news_pool import get_sources
    return {"sources": get_sources()}


@app.post("/sources")
def add_source(req: AddSourceRequest):
    from .news_pool import add_source
    src = add_source(
        name=req.name,
        url=req.url,
        tag=req.tag,
        selector_title=req.selector_title,
        selector_summary=req.selector_summary,
        max_items=req.max_items,
    )
    return {"source": src}


@app.delete("/sources/{source_id}")
def delete_source(source_id: str):
    from .news_pool import remove_source
    ok = remove_source(source_id)
    if not ok:
        raise HTTPException(404, "Source not found or is a default source")
    return {"deleted": True}


class UpdateSourceRequest(BaseModel):
    max_items: int | None = None
    selector_title: str | None = None
    selector_summary: str | None = None
    tag: str | None = None


@app.patch("/sources/{source_id}")
def patch_source(source_id: str, req: UpdateSourceRequest):
    from .news_pool import update_source
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(400, "No fields to update")
    result = update_source(source_id, **updates)
    if not result:
        raise HTTPException(404, "Source not found")
    return {"source": result}

@app.post("/crawl")
async def trigger_crawl():
    """Trigger a full crawl of all sources. Returns the crawled articles."""
    from .crawler import crawl_all
    from .news_pool import get_crawl_sources, replace_pool

    sources = get_crawl_sources()
    articles = await crawl_all(sources)
    replace_pool(articles)
    return {
        "crawled": True,
        "article_count": len(articles),
        "articles": [
            {"title": a.title, "source_tag": a.source_tag, "summary": a.summary}
            for a in articles
        ],
    }


# ── News pool ────────────────────────────────────────────────────────

@app.get("/news-pool")
def get_news_pool():
    from .news_pool import get_pool
    pool = get_pool()
    return {"article_count": len(pool), "articles": pool}


@app.post("/news-pool/inject")
def inject_news(req: InjectArticleRequest):
    from .news_pool import inject_article, set_active_workspace
    if req.workspace_id:
        set_active_workspace(req.workspace_id)
    article = inject_article(req.title, req.summary, req.source_tag)
    return {"injected": True, "article": article}


@app.post("/news-pool/clear")
def clear_news_pool(workspace_id: str = ""):
    from .news_pool import clear_pool, set_active_workspace
    if workspace_id:
        set_active_workspace(workspace_id)
    clear_pool()
    return {"cleared": True}


@app.get("/evolution/dashboard")
def evolution_dashboard(job_id: str = "", workspace_id: str = ""):
    """Dashboard data: daily trends, per-district stats, agent activity.

    If job_id is provided, returns data for that specific run.
    Otherwise returns data from the latest completed or running run.
    """
    if workspace_id:
        from .evolver import set_active_workspace as set_evo_ws
        set_evo_ws(workspace_id)
    from .evolver import _load_diaries, _load_states

    # Find job — check both _historical_jobs (cycle-mode) and evolver._jobs (Quick Start)
    from .evolver import list_jobs as _list_evo_jobs
    _all_jobs = {**_historical_jobs}
    for ej in _list_evo_jobs():
        _all_jobs[ej["job_id"]] = ej

    job = None
    if job_id and job_id in _all_jobs:
        job = _all_jobs[job_id]
    else:
        # Find latest run
        for j in sorted(_all_jobs.values(), key=lambda x: x.get("started_at", 0), reverse=True):
            if j.get("status") in ("running", "completed"):
                job = j
                break

    diaries = _load_diaries()
    states = _load_states()

    if not diaries:
        return {
            "status": job.get("status") if job else "idle",
            "current_day": job.get("current_day", 0) if job else 0,
            "total_days": job.get("total_days", 0) if job else 0,
            "phase": job.get("phase", "") if job else "",
            "daily_trends": [],
            "district_stats": {},
            "leaning_trends": [],
            "live_messages": (job.get("live_messages", [])[-20:]) if job else [],
            "agent_count": 0,
        }

    # ── Daily trends ──
    days_data: dict[int, list[dict]] = {}
    for d in diaries:
        day = d.get("day", 0)
        if day not in days_data:
            days_data[day] = []
        days_data[day].append(d)

    # Map internal leaning labels (偏綠/偏藍/偏白 + US 5-tier) to the 3-tier
    # TW display buckets (偏左派/中立/偏右派). Civatas-USA Stage 1.5+: US labels
    # collapse to the TW 3-tier so the dashboard aggregation chart still works
    # without divergent code paths. Per-leaning JSON keys are TW, but the
    # frontend i18n will translate them to "Lean Dem / Tossup / Lean Rep" for
    # US workspaces at render time.
    _lean_display = {"偏綠": "left", "偏藍": "right", "偏白": "center", "中立": "center",
                     "偏左派": "left", "偏右派": "right",
                     # US 5-tier → TW 3-tier collapse
                     "Solid Dem": "left", "Lean Dem": "left",
                     "Tossup":    "center",
                     "Lean Rep":  "right", "Solid Rep": "right"}

    daily_trends = []
    # Also build per-district daily trends (populated after agent_district is ready)
    _per_day_entries: dict[int, list[dict]] = {}
    for day in sorted(days_data.keys()):
        entries = days_data[day]
        _per_day_entries[day] = entries
        n = len(entries)
        local_sat = sum(e.get("local_satisfaction", 50) for e in entries) / n
        national_sat = sum(e.get("national_satisfaction", 50) for e in entries) / n
        anxiety = sum(e.get("anxiety", 50) for e in entries) / n
        leanings = {}
        for e in entries:
            l = e.get("political_leaning", "Tossup")
            leanings[l] = leanings.get(l, 0) + 1
        relevance = {}
        for e in entries:
            r = e.get("news_relevance", "none")
            relevance[r] = relevance.get(r, 0) + 1

        daily_trends.append({
            "day": day,
            "local_satisfaction": round(local_sat, 1),
            "national_satisfaction": round(national_sat, 1),
            "anxiety": round(anxiety, 1),
            "agent_count": n,
            "leaning_dist": leanings,
            "relevance_dist": relevance,
        })

    # ── Build agent→district map from job, states, or workspace personas ──
    agent_district: dict = {}
    # Priority 1: from job's agent_districts (set at run start)
    if job and job.get("agent_districts"):
        agent_district = {int(k) if str(k).isdigit() else k: v for k, v in job["agent_districts"].items()}
    # Priority 2: from states
    if not agent_district:
        for sid, st in states.items():
            if st.get("district"):
                agent_district[int(sid) if sid.isdigit() else sid] = st["district"]
    # Priority 3: from job's original agents list (if stored)
    if not agent_district and job:
        for a in job.get("_agents_cache", []):
            agent_district[a.get("person_id", 0)] = a.get("district", "Unknown")

    # ── Per-district stats (latest day) ──
    latest_day = max(days_data.keys()) if days_data else 0
    district_stats: dict[str, dict] = {}
    for d in diaries:
        if d.get("day") != latest_day:
            continue
        aid = d.get("agent_id")
        district = agent_district.get(aid, "Unknown")
        if district not in district_stats:
            district_stats[district] = {
                "count": 0, "local_sat_sum": 0, "national_sat_sum": 0,
                "anxiety_sum": 0, "leanings": {},
            }
        ds = district_stats[district]
        ds["count"] += 1
        ds["local_sat_sum"] += d.get("local_satisfaction", 50)
        ds["national_sat_sum"] += d.get("national_satisfaction", 50)
        ds["anxiety_sum"] += d.get("anxiety", 50)
        l = d.get("political_leaning", "Tossup")
        ds["leanings"][l] = ds["leanings"].get(l, 0) + 1

    for k, ds in district_stats.items():
        n = ds["count"]
        ds["avg_local_satisfaction"] = round(ds.pop("local_sat_sum") / n, 1)
        ds["avg_national_satisfaction"] = round(ds.pop("national_sat_sum") / n, 1)
        ds["avg_anxiety"] = round(ds.pop("anxiety_sum") / n, 1)

    # ── Per-district daily trends & leaning trends ──
    district_daily_trends: dict[str, list[dict]] = {}
    district_leaning_trends: dict[str, list[dict]] = {}
    if agent_district:
        # Group entries by (day, district)
        _dd: dict[str, dict[int, list[dict]]] = {}  # district -> day -> entries
        for day, entries in _per_day_entries.items():
            for e in entries:
                aid = e.get("agent_id")
                dist = agent_district.get(aid, "Unknown")
                if dist not in _dd:
                    _dd[dist] = {}
                if day not in _dd[dist]:
                    _dd[dist][day] = []
                _dd[dist][day].append(e)

        for dist, day_entries in _dd.items():
            dt_list = []
            lt_list = []
            for day in sorted(day_entries.keys()):
                es = day_entries[day]
                n = len(es)
                ls = sum(e.get("local_satisfaction", 50) for e in es) / n
                ns = sum(e.get("national_satisfaction", 50) for e in es) / n
                ax = sum(e.get("anxiety", 50) for e in es) / n
                leanings = {}
                for e in es:
                    l = e.get("political_leaning", "Tossup")
                    leanings[l] = leanings.get(l, 0) + 1
                dt_list.append({
                    "day": day,
                    "local_satisfaction": round(ls, 1),
                    "national_satisfaction": round(ns, 1),
                    "anxiety": round(ax, 1),
                })
                total = sum(leanings.values()) or 1
                _dc: dict[str, float] = {"left": 0, "center": 0, "right": 0}
                for _ln, _cnt in leanings.items():
                    _dc[_lean_display.get(_ln, "center")] += _cnt
                lt_list.append({
                    "day": day,
                    "left": round(_dc["left"] / total * 100, 1),
                    "center": round(_dc["center"] / total * 100, 1),
                    "right": round(_dc["right"] / total * 100, 1),
                })
            district_daily_trends[dist] = dt_list
            district_leaning_trends[dist] = lt_list

    # ── Leaning trend (per day) ──
    # Reuse the _lean_display map defined above for the daily-trends loop, which
    # already includes the US 5-tier → TW 3-tier collapse. (Re-defining it here
    # without the US mappings — as we used to — caused every US agent to fall
    # through to the default "中立" bucket, making the leaning chart appear
    # entirely Tossup/gray for US workspaces.)
    leaning_trends = []
    for t in daily_trends:
        ld = t["leaning_dist"]
        total = sum(ld.values()) or 1
        # Aggregate by display label
        display_counts: dict[str, float] = {"left": 0, "center": 0, "right": 0}
        for lean, count in ld.items():
            display_label = _lean_display.get(lean, "center")
            display_counts[display_label] += count
        leaning_trends.append({
            "day": t["day"],
            "left": round(display_counts["left"] / total * 100, 1),
            "center": round(display_counts["center"] / total * 100, 1),
            "right": round(display_counts["right"] / total * 100, 1),
        })

    # ── Get agent_info from job or disk fallback ──
    agent_info = (job.get("agent_info", {}) if job else {})
    _agent_info_file = os.path.join(
        os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution"), "agent_info.json"
    )
    if not agent_info:
        # Fallback: load from persisted file
        try:
            if os.path.isfile(_agent_info_file):
                with open(_agent_info_file) as _f:
                    agent_info = json.load(_f)
        except Exception:
            pass

    # ── Recent agent activity (all entries of latest day for district filtering) ──
    recent_activity = []
    latest_entries = days_data.get(latest_day, [])
    for e in latest_entries:
        aid = e.get("agent_id")
        info = agent_info.get(aid, agent_info.get(str(aid), {}))
        recent_activity.append({
            "agent_id": aid,
            "day": e.get("day"),
            "diary": e.get("diary_text", "") or "",
            "relevance": e.get("news_relevance"),
            "local_satisfaction": e.get("local_satisfaction"),
            "national_satisfaction": e.get("national_satisfaction"),
            "anxiety": e.get("anxiety"),
            "leaning": e.get("political_leaning"),
            "news_titles": e.get("fed_titles", []),
            # Agent demographics
            "district": info.get("district", agent_district.get(aid, "Unknown")),
            "gender": info.get("gender", ""),
            "age": info.get("age", ""),
            "education": info.get("education", ""),
            "occupation": info.get("occupation", ""),
        })

    # ── Demographic breakdown stats (from agent_info) ──
    demo_stats: dict[str, dict[str, int]] = {
        "gender": {}, "education": {}, "occupation": {},
    }
    district_demo_stats: dict[str, dict[str, dict[str, int]]] = {}
    for aid_key, info in agent_info.items():
        for dim in demo_stats:
            val = info.get(dim, "Unknown") or "Unknown"
            demo_stats[dim][val] = demo_stats[dim].get(val, 0) + 1
        # Per-district demo stats
        dist = info.get("district", agent_district.get(int(aid_key) if str(aid_key).isdigit() else aid_key, "Unknown"))
        if dist not in district_demo_stats:
            district_demo_stats[dist] = {"gender": {}, "education": {}, "occupation": {}}
        for dim in ["gender", "education", "occupation"]:
            val = info.get(dim, "Unknown") or "Unknown"
            district_demo_stats[dist][dim][val] = district_demo_stats[dist][dim].get(val, 0) + 1

    # ── Cross-tabulation stats (latest day) ──
    cross_tabs: dict[str, list[dict]] = {}

    # Helper: bucket age into groups
    def _age_group(age) -> str:
        try:
            a = int(age)
        except (ValueError, TypeError):
            return "Unknown"
        if a < 30: return "20-29"
        if a < 40: return "30-39"
        if a < 50: return "40-49"
        if a < 60: return "50-59"
        if a < 70: return "60-69"
        return "70+"

    # Collect per-agent latest-day data with demographics
    _agent_rows: list[dict] = []
    for e in latest_entries:
        aid = e.get("agent_id")
        info = agent_info.get(aid, agent_info.get(str(aid), {}))
        _agent_rows.append({
            "leaning": e.get("political_leaning", "Tossup"),
            "local_sat": e.get("local_satisfaction", 50),
            "national_sat": e.get("national_satisfaction", 50),
            "anxiety": e.get("anxiety", 50),
            "age_group": _age_group(info.get("age", e.get("age", ""))),
            "gender": info.get("gender", "") or "Unknown",
            "occupation": info.get("occupation", "") or "Unknown",
            "education": info.get("education", "") or "Unknown",
            "district": info.get("district", agent_district.get(aid, "Unknown")),
        })

    # Build cross-tabs: dimension × leaning → {count, avg_local_sat, avg_national_sat, avg_anxiety}
    _dims = ["age_group", "gender", "occupation", "education", "district"]
    for dim in _dims:
        buckets: dict[str, dict[str, dict]] = {}  # {dim_value: {leaning: {sum_*, count}}}
        for r in _agent_rows:
            dv = r[dim]
            ln = _lean_display.get(r["leaning"], "center")  # map 偏綠→偏左派 etc.
            if dv not in buckets:
                buckets[dv] = {}
            if ln not in buckets[dv]:
                buckets[dv][ln] = {"count": 0, "local_sat_sum": 0, "national_sat_sum": 0, "anxiety_sum": 0}
            b = buckets[dv][ln]
            b["count"] += 1
            b["local_sat_sum"] += r["local_sat"]
            b["national_sat_sum"] += r["national_sat"]
            b["anxiety_sum"] += r["anxiety"]

        rows = []
        for dv, leanings_data in sorted(buckets.items()):
            row: dict = {"label": dv}
            for ln, b in leanings_data.items():
                n = b["count"]
                # ln is already a 3-tier bucket ("left"/"center"/"right") from line 477
                prefix = {"left": "left", "center": "neutral", "right": "right"}.get(ln, "other")
                row[f"{prefix}_count"] = n
                row[f"{prefix}_local_sat"] = round(b["local_sat_sum"] / n, 1)
                row[f"{prefix}_national_sat"] = round(b["national_sat_sum"] / n, 1)
                row[f"{prefix}_anxiety"] = round(b["anxiety_sum"] / n, 1)
            # Add totals
            total_n = sum(b["count"] for b in leanings_data.values())
            row["total_count"] = total_n
            if total_n > 0:
                row["avg_local_sat"] = round(sum(b["local_sat_sum"] for b in leanings_data.values()) / total_n, 1)
                row["avg_national_sat"] = round(sum(b["national_sat_sum"] for b in leanings_data.values()) / total_n, 1)
                row["avg_anxiety"] = round(sum(b["anxiety_sum"] for b in leanings_data.values()) / total_n, 1)
            rows.append(row)
        cross_tabs[dim] = rows

    # ── Candidate awareness/sentiment trends ──
    # Awareness: average from diary entries' candidate_awareness state.
    # Sentiment: derived from daily summary candidate_estimate — measures
    # net favorability: (candidate_pct - fair_share) / fair_share, clamped to [-1, 1].
    candidate_trends: list[dict] = []
    _cand_names_seen: set[str] = set()
    # Collect daily candidate estimates from ALL job summaries, mapped to global days.
    # Each job uses local day 1..N; we map to global using started_at ordering.
    # These are the authoritative per-day snapshots computed by evolver.py on each
    # simulation day from live agent states — NOT derived/smoothed.
    _daily_estimates: dict[int, dict] = {}
    _sorted_jobs = sorted(_all_jobs.values(), key=lambda x: x.get("started_at", 0))
    _global_offset = 0
    for sj in _sorted_jobs:
        for ds in sj.get("daily_summary", []):
            ce = ds.get("candidate_estimate", {})
            if ce:
                _daily_estimates[_global_offset + ds["day"]] = ce
                for cn in ce.keys():
                    if cn != "Undecided":
                        _cand_names_seen.add(cn)
        _total = sj.get("total_days", 0)
        if _total > 0:
            _global_offset += _total

    # Fallback: read candidate_estimate from persisted history file for days
    # not covered by in-memory jobs (e.g., after a service restart or reset).
    try:
        from .evolver import _load_history as _evolver_load_history
        _hist_entries = _evolver_load_history()
        for _he in _hist_entries:
            _gd = _he.get("global_day")
            if _gd and _gd not in _daily_estimates:
                _hce = _he.get("candidate_estimate", {})
                if _hce:
                    _daily_estimates[_gd] = _hce
                    for _cn in _hce.keys():
                        if _cn != "Undecided":
                            _cand_names_seen.add(_cn)
            # Also surface candidate names stored in history entries
            for _cn in _he.get("candidate_names", []):
                if _cn and _cn != "Undecided":
                    _cand_names_seen.add(_cn)
    except Exception:
        pass  # Non-fatal: in-memory data already used above

    # Merge the set of days we have data for: diary-derived days ∪ daily_summary days.
    # Diaries give awareness; daily_summary gives support + sentiment.
    all_days: set[int] = set(days_data.keys()) | set(_daily_estimates.keys())
    for day in sorted(all_days):
        entries = days_data.get(day, [])
        # Collect candidate_awareness from entries (may be empty if no tracked_candidates)
        cand_aw_sums: dict[str, float] = {}
        cand_counts: dict[str, int] = {}
        for e in entries:
            ca = e.get("candidate_awareness", {})
            for cn, val in ca.items():
                cand_aw_sums[cn] = cand_aw_sums.get(cn, 0) + val
                cand_counts[cn] = cand_counts.get(cn, 0) + 1
                _cand_names_seen.add(cn)

        est = _daily_estimates.get(day, {})
        # Skip days with neither awareness nor support data
        if not cand_counts and not est:
            continue

        row: dict = {"day": day}
        n_cands = max(len([c for c in _cand_names_seen if c != "Undecided"]), 2)
        # Fair share = decided votes only (excludes undecided), so a candidate at
        # exactly "fair" support sits at sentiment=0 rather than systematically negative.
        _undecided_pct = est.get("Undecided", 0)
        fair_share = (100.0 - _undecided_pct) / n_cands

        for cn in _cand_names_seen:
            cnt = cand_counts.get(cn, 0)
            # Emit null (not 0.0) when no agents reported awareness for this
            # candidate on this day. 0.0 is visually identical to "everyone
            # thinks 0%" and caused the chart to crash from a real value to 0
            # on partially-aggregated days mid-run. Recharts treats null as
            # a break in the line instead.
            row[f"{cn}_awareness"] = round(cand_aw_sums.get(cn, 0) / cnt, 3) if cnt else None
            # Sentiment from candidate estimate: how much above/below fair share
            pct = est.get(cn, fair_share)
            sentiment = max(-1.0, min(1.0, (pct - fair_share) / fair_share))
            row[f"{cn}_sentiment"] = round(sentiment, 3)
            # Raw support share (%) from candidate_estimate (fair_share fallback)
            row[f"{cn}_support"] = round(pct, 1)
        # Undecided share, if provided
        if "Undecided" in est:
            row["Undecided_support"] = round(est["Undecided"], 1)
        candidate_trends.append(row)

    # Candidate breakdown — latest daily_summary across all jobs (end-state snapshot)
    candidate_breakdown: dict = {}
    _latest_summary: dict | None = None
    for sj in reversed(_sorted_jobs):
        _ds_list = sj.get("daily_summary", [])
        if _ds_list:
            _latest_summary = _ds_list[-1]
            break
    if _latest_summary:
        candidate_breakdown = {
            "by_leaning": _latest_summary.get("by_leaning_candidate", {}),
            "by_gender": _latest_summary.get("by_gender_candidate", {}),
            "by_district": _latest_summary.get("by_district_candidate", {}),
            "by_vendor": _latest_summary.get("by_vendor_candidate", {}),
            "overall": _latest_summary.get("candidate_estimate", {}),
            "day": _latest_summary.get("day", 0),
        }

    # Get tracked candidate names from job
    tracked_candidate_names: list[str] = []
    if job:
        for tc in job.get("tracked_candidates", []):
            n = tc.get("name", "") if isinstance(tc, dict) else str(tc)
            if n: tracked_candidate_names.append(n)

    return {
        "status": job.get("status") if job else "completed",
        "current_day": _global_offset if _global_offset > 0 else (job.get("current_day", latest_day) if job else latest_day),
        "total_days": _global_offset if _global_offset > 0 else (job.get("total_days", latest_day) if job else latest_day),
        "phase": job.get("phase", "") if job else "",
        "daily_trends": daily_trends,
        "district_stats": district_stats,
        "leaning_trends": leaning_trends,
        "district_daily_trends": district_daily_trends,
        "district_leaning_trends": district_leaning_trends,
        "district_demo_stats": district_demo_stats,
        "demo_stats": demo_stats,
        "recent_activity": recent_activity,
        "cross_tabs": cross_tabs,
        "candidate_trends": candidate_trends,
        "candidate_breakdown": candidate_breakdown,
        "tracked_candidate_names": tracked_candidate_names or list(_cand_names_seen),
        "live_messages": (job.get("live_messages", [])[-30:]) if job else [],
        "agent_count": len(set(d.get("agent_id") for d in diaries)),
    }


@app.get("/news-center")
def news_center(workspace_id: str = ""):
    """Return all news articles with their distribution stats across agents.

    Aggregates from diaries: which articles were fed to which agents,
    and how agents reacted (relevance, satisfaction change).
    """
    from .evolver import _load_diaries
    from .news_pool import get_pool, set_active_workspace

    # Scope to workspace if provided
    if workspace_id:
        set_active_workspace(workspace_id)

    diaries = _load_diaries()
    pool = get_pool()

    # Build article lookup from pool.
    # IMPORTANT: ``assigned_day`` is the sim day this article was MEANT to be
    # delivered on (set by assign_news_to_days). It is **never** overwritten
    # by diary aggregation. ``first_seen_day`` is kept as a backward-compat
    # alias but now equals ``assigned_day``. Actual read days are tracked
    # separately in ``read_days`` and exposed via ``read_day_min/max/spread``.
    article_map: dict[str, dict] = {}
    for a in pool:
        aid = a.get("article_id", "")
        if aid:
            _assigned = a.get("assigned_day")
            article_map[aid] = {
                "article_id": aid,
                "title": a.get("title", ""),
                "summary": a.get("summary", ""),
                "source_tag": a.get("source_tag", ""),
                "channel": a.get("channel", ""),
                "date": a.get("date", ""),
                "impact_score": a.get("impact_score", 0),
                "fed_to": [],       # agent_ids
                "reactions": [],     # {agent_id, day, relevance, local_sat, national_sat, anxiety}
                "assigned_day": _assigned,           # what assign_news_to_days decided
                "first_seen_day": _assigned,         # backward-compat alias (frozen at assigned)
                "read_days_set": set(),              # actual sim days agents read this on
                "feed_count": 0,
            }

    # Aggregate from diaries
    for entry in diaries:
        day = entry.get("day", 0)
        agent_id = entry.get("agent_id", "")
        fed_ids = entry.get("fed_articles", [])
        fed_titles = entry.get("fed_titles", [])
        relevance = entry.get("news_relevance", "")
        local_sat = entry.get("local_satisfaction", 50)
        national_sat = entry.get("national_satisfaction", 50)
        anxiety = entry.get("anxiety", 50)

        for i, aid in enumerate(fed_ids):
            if aid not in article_map:
                # Article not in current pool — reconstruct from diary.
                # No assigned_day available since the original pool entry is lost.
                title = fed_titles[i] if i < len(fed_titles) else ""
                article_map[aid] = {
                    "article_id": aid,
                    "title": title,
                    "summary": "",
                    "source_tag": "",
                    "channel": "",
                    "date": "",
                    "impact_score": 0,
                    "fed_to": [],
                    "reactions": [],
                    "assigned_day": None,
                    "first_seen_day": None,
                    "read_days_set": set(),
                    "feed_count": 0,
                }

            art = article_map[aid]
            art["feed_count"] += 1
            if agent_id not in art["fed_to"]:
                art["fed_to"].append(agent_id)
            art["read_days_set"].add(day)
            # Reconstruction fallback: if assigned_day was unknown, fill it
            # with the earliest observed read day (matches old behaviour for
            # diary-only articles).
            if art["assigned_day"] is None:
                if art["first_seen_day"] is None or day < art["first_seen_day"]:
                    art["first_seen_day"] = day
                    art["assigned_day"] = day
            art["reactions"].append({
                "agent_id": agent_id,
                "day": day,
                "relevance": relevance,
                "local_satisfaction": local_sat,
                "national_satisfaction": national_sat,
                "anxiety": anxiety,
            })

    # Convert to sorted list (by first_seen_day, then feed_count desc)
    articles = sorted(
        article_map.values(),
        key=lambda a: (a.get("first_seen_day") or 999, -a.get("feed_count", 0)),
    )

    # Summary stats per article — with temporal-drift detection
    for a in articles:
        reactions = a["reactions"]
        # ── Read-day spread (truth metric) ────────────────────────────
        read_days = sorted(a.pop("read_days_set"))
        if read_days:
            a["read_day_min"] = read_days[0]
            a["read_day_max"] = read_days[-1]
            a["read_day_spread"] = len(read_days)  # distinct sim days
        else:
            a["read_day_min"] = None
            a["read_day_max"] = None
            a["read_day_spread"] = 0
        # ── Temporal drift: assigned vs actual ────────────────────────
        # The news pool is cumulative — once an article is added on its
        # assigned day, it remains visible to all subsequent sim days
        # (subject to read_history dedup and select_feed scoring). So:
        #
        #   drift_min < 0  → article was read BEFORE its assigned day
        #                    → genuine causality violation (future-leak bug)
        #   drift_min == 0 → article first read on assigned day (clean)
        #   drift_max > 0  → article persisted into later days (NORMAL pool behaviour)
        #
        # Only ``drift_min < 0`` is a real bug worth flagging. Persistence
        # (drift_max > 0) is by design and not a warning.
        if a.get("assigned_day") is not None and read_days:
            a["temporal_drift_min"] = read_days[0] - a["assigned_day"]   # negative = past leak
            a["temporal_drift_max"] = read_days[-1] - a["assigned_day"]  # positive = pool persistence (OK)
            a["temporal_drift_warn"] = a["temporal_drift_min"] < 0       # only past-leaks are bugs
        else:
            a["temporal_drift_min"] = None
            a["temporal_drift_max"] = None
            a["temporal_drift_warn"] = False

        if reactions:
            high = sum(1 for r in reactions if r["relevance"] == "high")
            medium = sum(1 for r in reactions if r["relevance"] == "medium")
            low = sum(1 for r in reactions if r["relevance"] in ("low", "none"))
            a["relevance_summary"] = {"high": high, "medium": medium, "low": low}
            a["agent_count"] = len(a["fed_to"])
        else:
            a["relevance_summary"] = {"high": 0, "medium": 0, "low": 0}
            a["agent_count"] = 0

        # Remove verbose reactions list for the summary endpoint (keep fed_to)
        del a["reactions"]

    # ── Top-level drift summary (so the UI can show a banner) ────────
    drift_count = sum(1 for a in articles if a.get("temporal_drift_warn"))
    return {
        "total": len(articles),
        "articles": articles,
        "temporal_drift": {
            "articles_with_drift": drift_count,
            "drift_pct": round(100 * drift_count / max(1, len(articles)), 1),
        },
    }


@app.get("/news-center/{article_id}")
def news_center_detail(article_id: str):
    """Return detailed agent reactions for a specific article."""
    from .evolver import _load_diaries

    diaries = _load_diaries()
    reactions = []
    for entry in diaries:
        if article_id in (entry.get("fed_articles") or []):
            reactions.append({
                "agent_id": entry.get("agent_id"),
                "day": entry.get("day"),
                "relevance": entry.get("news_relevance"),
                "local_satisfaction": entry.get("local_satisfaction"),
                "national_satisfaction": entry.get("national_satisfaction"),
                "anxiety": entry.get("anxiety"),
                "diary_text": entry.get("diary_text", ""),
                "reasoning": entry.get("reasoning", ""),
                "political_leaning": entry.get("political_leaning", ""),
            })
    return {"article_id": article_id, "reactions": reactions}


# ── Diet rules ───────────────────────────────────────────────────────

@app.get("/diet-rules")
def get_diet():
    from .feed_engine import get_diet_rules
    return get_diet_rules()


@app.put("/diet-rules")
def update_diet(req: DietRulesUpdate):
    from .feed_engine import get_diet_rules, update_diet_rules
    current = get_diet_rules()
    if req.diet_map is not None:
        current["diet_map"] = req.diet_map
    if req.serendipity_rate is not None:
        current["serendipity_rate"] = req.serendipity_rate
    if req.articles_per_agent is not None:
        current["articles_per_agent"] = req.articles_per_agent
    if req.leaning_weight is not None:
        current["leaning_weight"] = req.leaning_weight
    if req.channel_weight is not None:
        current["channel_weight"] = req.channel_weight
    if req.recency_weight is not None:
        current["recency_weight"] = req.recency_weight
    if req.demographic_weight is not None:
        current["demographic_weight"] = req.demographic_weight
    if req.read_penalty is not None:
        current["read_penalty"] = req.read_penalty
    if req.district_news_count is not None:
        current["district_news_count"] = req.district_news_count
    if req.kol_probability is not None:
        current["kol_probability"] = req.kol_probability
    if req.custom_sources is not None:
        current["custom_sources"] = req.custom_sources
    if req.source_leanings is not None:
        current["source_leanings"] = req.source_leanings
    return update_diet_rules(current)


# ── Leaning profile ──────────────────────────────────────────────────

@app.post("/leaning-profile/upload")
async def upload_leaning_profile(file: UploadFile = File(...)):
    """Upload a CSV or JSON file to build the district leaning profile."""
    from .leaning_profile import parse_csv, parse_json, save_profile

    raw = (await file.read()).decode("utf-8-sig")
    filename = file.filename or "data.csv"

    try:
        if filename.lower().endswith(".json"):
            profile = parse_json(raw)
        else:
            profile = parse_csv(raw)
    except Exception as e:
        raise HTTPException(400, f"Parse failed: {e}")

    if not profile:
        raise HTTPException(400, "No district data detected")

    data = save_profile(profile)
    return {"status": "ok", "districts": len(profile), "data": data}


@app.get("/leaning-profile")
def get_leaning_profile():
    from .leaning_profile import load_profile, has_profile
    if not has_profile():
        return {"exists": False, "data": None}
    return {"exists": True, "data": load_profile()}


@app.delete("/leaning-profile")
def delete_leaning_profile():
    from .leaning_profile import delete_profile
    deleted = delete_profile()
    return {"status": "ok", "deleted": deleted}


@app.get("/leaning-profile/sample")
def sample_leaning(district: str = ""):
    """Sample a political leaning for a district (for testing)."""
    from .leaning_profile import get_district_leaning
    leaning = get_district_leaning(district)
    return {"district": district, "leaning": leaning}


# ── Stat modules ─────────────────────────────────────────────────────

@app.get("/stat-modules")
def list_stat_modules():
    from .stat_modules import list_modules
    return {"modules": list_modules()}


@app.put("/stat-modules/{module_id}/toggle")
def toggle_stat_module(module_id: str, enabled: bool = True):
    from .stat_modules import toggle_module
    return toggle_module(module_id, enabled)


@app.get("/stat-modules/{module_id}")
def get_stat_module(module_id: str):
    from .stat_modules import get_module
    mod = get_module(module_id)
    if not mod:
        raise HTTPException(404, "Module not found")
    return mod


class CreateModuleRequest(BaseModel):
    name: str
    description: str = ""
    type: str = "custom"
    admin_level: str = "town"


@app.post("/stat-modules/upload")
async def upload_stat_module(files: list[UploadFile] = File(...),
                              name: str = "",
                              description: str = "",
                              mod_type: str = "custom",
                              save_as_module: bool = True):
    """Upload CSV/JSON/XLSX files. Supports multi-file (data + codebook)."""
    from .leaning_profile import parse_json
    from .stat_modules import create_module, analyze_module_data

    data: dict = {}
    primary_filename = ""

    # Separate files by type
    xlsx_files: list[tuple[str, bytes]] = []
    text_files: list[tuple[str, bytes]] = []

    for f in files:
        raw = await f.read()
        fname = f.filename or "data"
        if fname.lower().endswith((".xlsx", ".xls")):
            xlsx_files.append((fname, raw))
        else:
            text_files.append((fname, raw))
        if not primary_filename:
            primary_filename = fname

    try:
        if xlsx_files:
            # XLSX path: auto-detect codebook + aggregate
            from .xlsx_parser import process_xlsx_upload
            data = process_xlsx_upload(xlsx_files)
        elif text_files:
            fname, raw = text_files[0]
            if fname.lower().endswith(".json"):
                # JSON: simple key-value parsing
                raw_str = None
                for enc in ("utf-8-sig", "big5", "latin-1"):
                    try:
                        raw_str = raw.decode(enc)
                        break
                    except (UnicodeDecodeError, LookupError):
                        continue
                if raw_str is None:
                    raise HTTPException(400, "Unable to detect file encoding")
                data = parse_json(raw_str)
            else:
                # CSV: generic auto-aggregate parser
                from .xlsx_parser import parse_generic_csv
                data = parse_generic_csv(raw)
    except Exception as e:
        raise HTTPException(400, f"Parse failed: {e}")

    if not data:
        raise HTTPException(400, "No data detected")

    if save_as_module:
        enriched_desc = await analyze_module_data(primary_filename, data, description)
        mod_name = name or primary_filename.rsplit(".", 1)[0]
        result = create_module(mod_name, enriched_desc, mod_type, data)
        return {"status": "ok", "module": result}
    else:
        return {"status": "ok", "districts": len(data), "data": data}


class UpdateModuleRequest(BaseModel):
    name: str | None = None
    description: str | None = None


@app.put("/stat-modules/{module_id}")
def update_stat_module_meta(module_id: str, req: UpdateModuleRequest):
    from .stat_modules import update_module
    result = update_module(module_id, req.name, req.description)
    if not result:
        raise HTTPException(404, "Module not found or is built-in")
    return result


@app.delete("/stat-modules/{module_id}")
def delete_stat_module(module_id: str):
    from .stat_modules import delete_module
    ok = delete_module(module_id)
    if not ok:
        raise HTTPException(400, "Cannot delete (built-in or not found)")
    return {"status": "ok"}



@app.post("/preview-feed")
def preview_feed(req: PreviewFeedRequest):
    from .feed_engine import preview_feed
    from .news_pool import get_pool
    pool = get_pool()
    return preview_feed(req.agent, pool)


# ── Evolution ────────────────────────────────────────────────────────

@app.post("/evolve")
async def start_evolve(req: StartEvolutionRequest):
    from .evolver import start_evolution
    # Scope state + news pool to this workspace BEFORE starting the job.
    if req.workspace_id:
        from .news_pool import set_active_workspace as set_news_ws
        from .evolver import set_active_workspace as set_evo_ws
        set_news_ws(req.workspace_id)
        set_evo_ws(req.workspace_id)
    concurrency = req.concurrency if req.concurrency > 0 else (len(req.enabled_vendors) if req.enabled_vendors else 5)
    result = await start_evolution(
        req.agents, req.days, concurrency=concurrency,
        candidate_names=req.candidate_names,
        scoring_params=req.scoring_params,
        candidate_descriptions=req.candidate_descriptions,
        party_detection=req.party_detection,
        enabled_vendors=req.enabled_vendors,
    )
    return result


@app.get("/evolve/status/{job_id}")
def evolve_status(job_id: str):
    from .evolver import get_job
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@app.get("/evolve/jobs")
def evolve_jobs():
    from .evolver import list_jobs
    return {"jobs": list_jobs()}


@app.get("/evolve/latest")
def evolve_latest():
    """Return the most recent evolution job (for restoring page state)."""
    from .evolver import list_jobs
    jobs = list_jobs()
    if not jobs:
        return {"job": None}
    latest = max(jobs, key=lambda j: j.get("started_at", ""))
    return {"job": latest}


@app.get("/evolve/history")
def evolve_history():
    from .evolver import get_evolution_history
    return {"history": get_evolution_history()}


@app.post("/evolve/stop/{job_id}")
def evolve_stop(job_id: str):
    """Stop a running evolution job."""
    from .evolver import stop_job, get_job
    ok = stop_job(job_id)
    if not ok:
        raise HTTPException(404, "Job not found")
    return {"status": "stopping", "job_id": job_id}


@app.post("/evolve/reset")
def evolve_reset(workspace_id: str = ""):
    """Clear all jobs, evolution history, agent states, and diaries."""
    global _historical_jobs
    from .evolver import clear_jobs, _save_history, _save_states, _save_diaries, set_active_workspace as set_evo_ws
    from .news_pool import set_active_workspace as set_news_ws
    if workspace_id:
        set_evo_ws(workspace_id)
        set_news_ws(workspace_id)
    cleared = clear_jobs()
    _historical_jobs = {}   # Clear cycle-mode jobs so stale offsets don't pollute Quick Start
    _save_history([])      # Reset history file
    _save_states({})       # Reset agent states (satisfaction, anxiety, days_evolved)
    _save_diaries([])      # Reset all diary entries

    # Delete all on-disk checkpoint files so they don't get re-restored on next container restart
    try:
        import glob as _glob
        checkpoint_dir = _evo_jobs_dir()
        for cp_file in _glob.glob(os.path.join(checkpoint_dir, "*.json")):
            try:
                os.remove(cp_file)
                logger.info(f"[evo-reset] Deleted checkpoint: {os.path.basename(cp_file)}")
            except Exception as e:
                logger.warning(f"[evo-reset] Could not delete checkpoint {cp_file}: {e}")
    except Exception as e:
        logger.warning(f"[evo-reset] Checkpoint cleanup failed: {e}")

    # Clear ChromaDB vector memory
    try:
        from .memory import _get_collection
        coll = _get_collection()
        if coll and coll.count() > 0:
            # Delete all documents in the collection
            all_ids = coll.get()["ids"]
            if all_ids:
                coll.delete(ids=all_ids)
            logger.info(f"Cleared {len(all_ids)} entries from ChromaDB")
    except Exception as e:
        logger.warning(f"Could not clear ChromaDB: {e}")

    return {"status": "ok", "cleared_jobs": cleared}


# ── Agent data ───────────────────────────────────────────────────────

@app.get("/agents/all-stats")
def all_agent_stats():
    """Return all agents' current states for bulk retrieval and grouping."""
    from .evolver import get_all_agent_stats
    return {"agents": get_all_agent_stats()}


@app.get("/agents/{agent_id}/diary")
def agent_diary(agent_id: int, recording_id: str = ""):
    from .evolver import get_agent_diary
    entries = get_agent_diary(agent_id)

    # If recording_id is provided, append prediction diary entries from recording steps
    if recording_id:
        from .recorder import get_all_steps
        steps = get_all_steps(recording_id)
        if steps:
            # Determine day offset: prediction days continue after evolution days
            max_evo_day = max((e.get("day", 0) for e in entries), default=0)
            aid_str = str(agent_id)
            for step in steps:
                pred_day = step.get("day", 0)
                offset_day = max_evo_day + pred_day
                for a in step.get("agents", []):
                    if str(a.get("agent_id", "")) == aid_str:
                        entries.append({
                            "agent_id": agent_id,
                            "day": offset_day,
                            "diary_text": a.get("diary_text", ""),
                            "local_satisfaction": a.get("local_satisfaction", 50),
                            "national_satisfaction": a.get("national_satisfaction", 50),
                            "satisfaction": (a.get("local_satisfaction", 50) + a.get("national_satisfaction", 50)) // 2,
                            "anxiety": a.get("anxiety", 50),
                            "political_leaning": a.get("political_leaning", ""),
                            "fed_titles": a.get("fed_titles", []),
                            "news_relevance": a.get("news_relevance", ""),
                            "phase": "prediction",
                        })
                        break

    return {"agent_id": agent_id, "entries": entries}


@app.get("/agents/{agent_id}/stats")
def agent_stats(agent_id: int):
    from .evolver import get_agent_stats
    return get_agent_stats(agent_id)


# ── RAG Memory ───────────────────────────────────────────────────────

@app.post("/memory/search")
def search_memory(req: MemorySearchRequest):
    from .memory import search_memories
    results = search_memories(req.agent_id, req.query, req.n_results)
    return {"agent_id": req.agent_id, "query": req.query, "results": results}


# ── Snapshots (calibration → prediction) ─────────────────────────────

class SaveSnapshotRequest(BaseModel):
    name: str
    description: str = ""
    calibration_pack_id: str | None = None
    workspace_id: str = ""
    alignment_target: dict | None = None


class RestoreSnapshotRequest(BaseModel):
    snapshot_id: str


@app.post("/snapshots/save")
def snapshot_save(req: SaveSnapshotRequest):
    """Save the current agent state as a named snapshot."""
    from .snapshot import save_snapshot
    meta = save_snapshot(req.name, req.description, req.calibration_pack_id,
                         workspace_id=req.workspace_id or "",
                         alignment_target=req.alignment_target)
    return meta


@app.post("/snapshots/restore")
def snapshot_restore(req: RestoreSnapshotRequest):
    """Restore agent state from a snapshot (for prediction branching)."""
    from .snapshot import restore_snapshot
    try:
        meta = restore_snapshot(req.snapshot_id)
        return {"status": "restored", **meta}
    except FileNotFoundError:
        raise HTTPException(404, "Snapshot not found")


@app.get("/snapshots")
def snapshot_list():
    """List all available snapshots."""
    from .snapshot import list_snapshots
    return {"snapshots": list_snapshots()}


@app.get("/snapshots/{snapshot_id}")
def snapshot_get(snapshot_id: str):
    """Get metadata for a specific snapshot."""
    from .snapshot import get_snapshot
    meta = get_snapshot(snapshot_id)
    if not meta:
        raise HTTPException(404, "Snapshot not found")
    return meta


@app.get("/snapshots/{snapshot_id}/agent-ids")
def snapshot_agent_ids(snapshot_id: str):
    """Return the agent IDs that were part of the calibration for this snapshot."""
    import os, json
    from .snapshot import SNAPSHOTS_DIR
    states_path = os.path.join(SNAPSHOTS_DIR, snapshot_id, "agent_states.json")
    if not os.path.isfile(states_path):
        raise HTTPException(404, "Snapshot not found")
    with open(states_path) as f:
        states = json.load(f)
    return {"agent_ids": list(states.keys()), "count": len(states)}


@app.get("/snapshots/{snapshot_id}/stats")
def snapshot_stats(snapshot_id: str):
    """Compute candidate support stats from a snapshot's agent states."""
    import os, json
    from .snapshot import SNAPSHOTS_DIR
    states_path = os.path.join(SNAPSHOTS_DIR, snapshot_id, "agent_states.json")
    if not os.path.isfile(states_path):
        raise HTTPException(404, "Snapshot not found")
    with open(states_path) as f:
        states = json.load(f)

    total = len(states)
    if total == 0:
        return {"total": 0, "candidates": {}, "candidate_names": {}, "avg_satisfaction": 0, "avg_anxiety": 0}

    # Aggregate leaning counts
    leaning_counts: dict[str, int] = {}
    sat_sum = 0.0
    anx_sum = 0.0
    for agent in states.values():
        leaning = agent.get("leaning") or agent.get("current_leaning") or "Undecided"
        leaning_counts[leaning] = leaning_counts.get(leaning, 0) + 1
        sat_sum += agent.get("satisfaction", 50)
        anx_sum += agent.get("anxiety", 50)

    # Convert to percentages
    candidates = {k: round(v / total * 100, 1) for k, v in leaning_counts.items()}

    # Try to map leaning labels to candidate names via calibration pack
    candidate_names: dict[str, str] = {}  # leaning -> "name（party）"
    meta_path = os.path.join(SNAPSHOTS_DIR, snapshot_id, "meta.json")
    if os.path.isfile(meta_path):
        with open(meta_path) as f:
            meta = json.load(f)
        pack_id = meta.get("calibration_pack_id")
        if pack_id:
            try:
                from .calibrator import get_calibration_pack
                pack = get_calibration_pack(pack_id)
                if pack:
                    ci = pack.get("candidate_info", {})
                    # candidate_info keys are "name(party)" — parse party from key
                    import re
                    # US party → leaning bucket
                    PARTY_SPECTRUM = {
                        "Democratic": "left", "Democrat": "left", "D": "left",
                        "Republican": "right", "R": "right",
                        "Independent": "center", "I": "center",
                        "Libertarian": "center", "Green": "left",
                    }
                    for key in ci.keys():
                        # Parse "Kamala Harris(Democratic)" or "Donald Trump(Republican)"
                        m = re.match(r'^(.+?)\((.+?)\)', key)
                        if m:
                            name_part = m.group(1).strip()
                            party_part = m.group(2).strip()
                            leaning_label = PARTY_SPECTRUM.get(party_part, "center")
                            candidate_names[leaning_label] = f"{name_part} ({party_part})"
            except Exception:
                pass

    return {
        "total": total,
        "candidates": candidates,
        "candidate_names": candidate_names,
        "avg_satisfaction": round(sat_sum / total, 1),
        "avg_anxiety": round(anx_sum / total, 1),
    }


@app.delete("/snapshots/{snapshot_id}")
def snapshot_delete(snapshot_id: str):
    """Delete a snapshot."""
    from .snapshot import delete_snapshot
    if not delete_snapshot(snapshot_id):
        raise HTTPException(404, "Snapshot not found")
    return {"deleted": snapshot_id}


# ── Domain Plugins ───────────────────────────────────────────────────

@app.get("/plugins")
def plugin_list():
    """List all available domain plugins."""
    from .plugins import list_plugins
    return {"plugins": list_plugins()}


@app.get("/plugins/{plugin_id}")
def plugin_get(plugin_id: str):
    """Get a specific domain plugin configuration."""
    from .plugins import get_plugin
    plugin = get_plugin(plugin_id)
    if not plugin:
        raise HTTPException(404, "Plugin not found")
    return plugin


# ── Calibration Packs ────────────────────────────────────────────────

class CreateCalibPackRequest(BaseModel):
    name: str
    plugin_id: str
    ground_truth: dict
    enable_kol: bool = False
    kol_ratio: float = 0.05
    kol_reach: float = 0.40
    candidate_info: dict | None = None  # {candidateName: description}
    scoring_params: dict | None = None  # tunable heuristic scoring parameters
    macro_context: str | None = None
    election_date: str | None = None


class RunCalibrationRequest(BaseModel):
    pack_id: str
    agents: list[dict]
    concurrency: int = 0  # 0 = auto (enabled_vendors × 2)
    target_days: int = 0  # 0 = use original days; >0 = redistribute events
    enable_kol: bool = False
    kol_ratio: float = 0.05
    kol_reach: float = 0.40
    sampling_modality: str = "unweighted"
    enabled_vendors: list[str] | None = None
    min_voting_age: int = 18  # exclude agents younger than this


@app.post("/calibration/packs")
def calib_pack_create(req: CreateCalibPackRequest):
    from .calibrator import save_calibration_pack
    return save_calibration_pack(
        req.name, req.plugin_id, req.ground_truth,
        req.enable_kol, req.kol_ratio, req.kol_reach, req.candidate_info,
        req.scoring_params, req.macro_context, req.election_date
    )


@app.get("/calibration/packs")
def calib_pack_list():
    from .calibrator import list_calibration_packs
    return {"packs": list_calibration_packs()}


@app.get("/calibration/packs/{pack_id}")
def calib_pack_get(pack_id: str):
    from .calibrator import get_calibration_pack
    pack = get_calibration_pack(pack_id)
    if not pack:
        raise HTTPException(404, "Calibration pack not found")
    # Strip internal __by_district__ from ground_truth for frontend display
    gt = pack.get("ground_truth")
    if isinstance(gt, dict) and "__by_district__" in gt:
        pack = dict(pack)
        pack["ground_truth"] = {k: v for k, v in gt.items() if k != "__by_district__"}
    return pack


@app.delete("/calibration/packs/{pack_id}")
def calib_pack_delete(pack_id: str):
    from .calibrator import delete_calibration_pack
    if not delete_calibration_pack(pack_id):
        raise HTTPException(404, "Calibration pack not found")
    return {"deleted": pack_id}


@app.post("/calibration/run")
async def calib_run(req: RunCalibrationRequest):
    from .calibrator import run_calibration
    from shared.llm_vendors import get_available_vendors
    # Filter out agents below voting age for election calibration
    agents = req.agents
    if req.min_voting_age > 0:
        agents = [a for a in agents if (a.get("age") or 0) >= req.min_voting_age]
        if len(agents) < len(req.agents):
            logger.info(f"[calibration-run] Excluded {len(req.agents) - len(agents)} agents under {req.min_voting_age} years old")
    concurrency = len(req.enabled_vendors) if req.enabled_vendors else len(get_available_vendors())
    try:
        result = await run_calibration(
            req.pack_id, agents, concurrency, req.target_days,
            req.enable_kol, req.kol_ratio, req.kol_reach, req.sampling_modality,
            req.enabled_vendors
        )
        return result
    except FileNotFoundError:
        raise HTTPException(404, "Calibration pack not found")


@app.get("/calibration/jobs/{job_id}")
def calib_job_status(job_id: str):
    from .calibrator import get_calib_job
    job = get_calib_job(job_id)
    if not job:
        raise HTTPException(404, "Calibration job not found")
    return job


@app.post("/calibration/stop/{job_id}")
async def calib_job_stop(job_id: str):
    """Stop a running calibration job."""
    from .calibrator import stop_calib_job
    ok = stop_calib_job(job_id)
    if not ok:
        raise HTTPException(404, "Calibration job not found")
    return {"status": "stopping", "job_id": job_id}


@app.post("/calibration/pause/{job_id}")
async def calib_job_pause(job_id: str):
    """Pause a running calibration job."""
    from .calibrator import pause_calib_job
    ok = pause_calib_job(job_id)
    if not ok:
        raise HTTPException(404, "Calibration job not found")
    return {"status": "pausing", "job_id": job_id}


@app.post("/calibration/stop-and-save/{job_id}")
async def calib_job_stop_and_save(job_id: str):
    """Stop a running calibration job and compute final results from data collected so far."""
    from .calibrator import stop_and_save_calib_job
    stop_and_save_calib_job(job_id)
    return {"status": "stopping", "save": True, "job_id": job_id}


@app.post("/calibration/resume/{job_id}")
async def calib_job_resume(job_id: str):
    """Resume a paused calibration job."""
    from .calibrator import resume_calib_job
    ok = resume_calib_job(job_id)
    if not ok:
        raise HTTPException(404, "Calibration job not found")
    return {"status": "resuming", "job_id": job_id}


@app.get("/calibration/checkpoints")
def calib_list_checkpoints():
    """List all persisted paused calibration jobs (survives restarts)."""
    from .calibrator import list_calib_checkpoints
    return {"checkpoints": list_calib_checkpoints()}


@app.post("/calibration/resume-checkpoint/{job_id}")
async def calib_resume_checkpoint(job_id: str):
    """Resume a paused job from its disk checkpoint (cross-restart resume)."""
    from .calibrator import resume_from_checkpoint, get_calib_checkpoint
    from shared.llm_vendors import get_available_vendors
    checkpoint = get_calib_checkpoint(job_id)
    if not checkpoint:
        raise HTTPException(404, "Checkpoint not found")
    enabled_vendors = checkpoint.get("job", {}).get("enabled_vendors")
    concurrency = len(enabled_vendors) if enabled_vendors else len(get_available_vendors())
    try:
        result = await resume_from_checkpoint(job_id, concurrency=concurrency)
        return result
    except FileNotFoundError:
        raise HTTPException(404, "Checkpoint not found")

# ── Auto-Calibration (Multi-round) ──────────────────────────────────

class AutoCalibrateRequest(BaseModel):
    pack_ids: list[str]
    agents: list[dict]
    concurrency: int = 0
    start_date: str = "2023-12-13"
    end_date: str = "2024-01-13"
    sim_time_scale: int = 30  # how many days = 1 year
    max_iterations: int = 5
    convergence_threshold: float = 1.0
    initial_scoring_params: dict | None = None
    enable_kol: bool = False
    kol_ratio: float = 0.05
    kol_reach: float = 0.40
    sampling_modality: str = "unweighted"
    enabled_vendors: list[str] | None = None


@app.post("/calibration/auto-calibrate")
async def auto_calibrate(req: AutoCalibrateRequest):
    from .calibrator import run_auto_calibration
    from shared.llm_vendors import get_available_vendors
    concurrency = len(req.enabled_vendors) if req.enabled_vendors else len(get_available_vendors())
    try:
        result = await run_auto_calibration(
            pack_ids=req.pack_ids,
            agents=req.agents,
            concurrency=concurrency,
            start_date=req.start_date,
            end_date=req.end_date,
            sim_time_scale=req.sim_time_scale,
            max_iterations=req.max_iterations,
            convergence_threshold=req.convergence_threshold,
            initial_scoring_params=req.initial_scoring_params,
            enable_kol=req.enable_kol,
            kol_ratio=req.kol_ratio,
            kol_reach=req.kol_reach,
            sampling_modality=req.sampling_modality,
            enabled_vendors=req.enabled_vendors,
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.get("/calibration/auto-calibrate/{job_id}")
def auto_calib_status(job_id: str):
    from .calibrator import get_auto_calib_job
    job = get_auto_calib_job(job_id)
    if not job:
        raise HTTPException(404, "Auto-calibration job not found")
    return job


@app.post("/calibration/auto-calibrate/{job_id}/stop")
def stop_auto_calibrate(job_id: str):
    from .calibrator import stop_auto_calib_job
    if not stop_auto_calib_job(job_id):
        raise HTTPException(404, "Auto-calibration job not found")
    return {"status": "stopped"}


# ── News Fetch Storage ───────────────────────────────────────────────

class SaveNewsFetchRequest(BaseModel):
    query: str
    start_date: str
    end_date: str
    events: list[dict]
    social_events: list[dict] | None = None


@app.post("/news-fetches")
def news_fetch_save(req: SaveNewsFetchRequest):
    from .news_store import save_news_fetch
    return save_news_fetch(
        req.query, req.start_date, req.end_date,
        req.events, req.social_events
    )


@app.get("/news-fetches")
def news_fetch_list():
    from .news_store import list_news_fetches
    return {"fetches": list_news_fetches()}


@app.get("/news-fetches/{fetch_id}")
def news_fetch_get(fetch_id: str):
    from .news_store import get_news_fetch
    data = get_news_fetch(fetch_id)
    if not data:
        raise HTTPException(404, "News fetch not found")
    return data


@app.delete("/news-fetches/{fetch_id}")
def news_fetch_delete(fetch_id: str):
    from .news_store import delete_news_fetch
    if not delete_news_fetch(fetch_id):
        raise HTTPException(404, "News fetch not found")
    return {"deleted": fetch_id}


# ── Predictions ──────────────────────────────────────────────────────

# ── Historical Evolution ──────────────────────────────────────────────

class HistoricalRunRequest(BaseModel):
    agents: list[dict]
    events: list[dict] = []  # [{day: int, news: [{title, summary, source_tag}]}] — legacy mode
    sim_days: int = 60
    concurrency: int = 0
    enabled_vendors: list[str] | None = None
    macro_context: str = ""
    snapshot_name: str = ""
    scoring_params: dict | None = None
    # Cycle-based dynamic news search
    search_interval: int = 0           # 0 = legacy (use pre-fetched events), >0 = days per search cycle
    local_keywords: str = ""           # fixed local keywords (always searched every cycle)
    national_keywords: str = ""        # fixed national keywords (always searched every cycle)
    county: str = ""
    start_date: str = ""               # YYYY-MM-DD
    end_date: str = ""
    min_voting_age: int = 18           # exclude agents younger than this from election simulations
    recording_id: str = ""             # if set, record step data for playback
    workspace_id: str = ""             # workspace that owns this run
    tracked_candidates: list[dict] = []  # [{name, party?, visibility?}] — candidates agents track awareness of
    alignment_target: dict | None = None  # {mode: "election"|"satisfaction", ...}


_historical_jobs: dict[str, dict] = {}

# ─── Pause / stop signals (mirrors predictor.py pattern) ─────────────
_historical_pauses: dict[str, bool] = {}
_historical_stops: dict[str, bool] = {}


# ═════════════════════════════════════════════════════════════════════
# Historical-evolution job persistence
# ═════════════════════════════════════════════════════════════════════
# Auto-checkpoints every completed sim day so a uvicorn --reload, container
# restart, or unexpected crash never loses an in-flight evolution.
#
# On startup the worker scans the checkpoint directory and rehydrates each
# job into ``_historical_jobs`` with status="interrupted". The user can
# then resume via POST /evolution/historical-run/{job_id}/resume which
# replays the cycle loop starting from the last completed sim day.
#
# Layout:
#   ${EVOLUTION_DATA_DIR}/historical_jobs/{job_id}.json
#
# Schema (version 2):
#   {
#     "version": 2,
#     "job_id": "...",
#     "saved_at": float,
#     "saved_after_day": int,            # last completed global sim day
#     "saved_cycle_idx": int,            # cycle that contained that day
#     "request": HistoricalRunRequest dict (full),
#     "job_metadata": {... excluding live_messages ...},
#     "seen_article_ids": [str],
#     "llm_local_kw": [str],             # latest LLM-supplementary keywords
#     "llm_national_kw": [str],
#     "current_pool_count": int,         # for sanity check
#     "global_day": int,                 # last day completed
#   }
# ═════════════════════════════════════════════════════════════════════

def _evo_jobs_dir() -> str:
    """Return the on-disk directory for evolution job checkpoints."""
    base = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
    path = os.path.join(base, "historical_jobs")
    os.makedirs(path, exist_ok=True)
    return path


def _evo_checkpoint_path(job_id: str) -> str:
    return os.path.join(_evo_jobs_dir(), f"{job_id}.json")


def _save_evo_checkpoint(
    job: dict,
    request_dict: dict,
    seen_article_ids: set[str],
    llm_local_kw: list[str],
    llm_national_kw: list[str],
    cycle_idx: int,
    global_day: int,
    current_pool_count: int,
) -> None:
    """Persist a snapshot of the in-flight job state to disk.

    Called after every completed sim day. Idempotent — overwrites the
    previous checkpoint atomically. Failures are logged but don't crash
    the running job.
    """
    try:
        # Strip live_messages to keep file small (they're rolling and rebuildable)
        job_meta = {k: v for k, v in job.items() if k != "live_messages"}
        checkpoint = {
            "version": 2,
            "job_id": job["job_id"],
            "saved_at": time.time(),
            "saved_after_day": global_day,
            "saved_cycle_idx": cycle_idx,
            "request": request_dict,
            "job_metadata": job_meta,
            "seen_article_ids": sorted(seen_article_ids),
            "llm_local_kw": list(llm_local_kw),
            "llm_national_kw": list(llm_national_kw),
            "current_pool_count": current_pool_count,
            "global_day": global_day,
        }
        path = _evo_checkpoint_path(job["job_id"])
        tmp_path = path + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(checkpoint, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)  # atomic rename
        logger.debug(f"[evo-checkpoint] Saved {job['job_id']} after day {global_day}")
    except Exception as e:
        logger.warning(f"[evo-checkpoint] Failed to save {job.get('job_id', '?')}: {e}")


def _delete_evo_checkpoint(job_id: str) -> None:
    """Remove a job checkpoint file (called on completion / hard stop)."""
    try:
        path = _evo_checkpoint_path(job_id)
        if os.path.isfile(path):
            os.remove(path)
            logger.info(f"[evo-checkpoint] Deleted {job_id}")
    except Exception as e:
        logger.warning(f"[evo-checkpoint] Failed to delete {job_id}: {e}")


def _load_evo_checkpoint(job_id: str) -> dict | None:
    """Load a single checkpoint by job_id."""
    path = _evo_checkpoint_path(job_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"[evo-checkpoint] Failed to load {job_id}: {e}")
        return None


def _list_evo_checkpoints() -> list[dict]:
    """Return summary of all on-disk evolution checkpoints."""
    out = []
    try:
        for fname in sorted(os.listdir(_evo_jobs_dir()), reverse=True):
            if not fname.endswith(".json") or fname.endswith(".tmp"):
                continue
            try:
                with open(os.path.join(_evo_jobs_dir(), fname)) as f:
                    cp = json.load(f)
                meta = cp.get("job_metadata", {})
                out.append({
                    "job_id": cp.get("job_id"),
                    "version": cp.get("version", 1),
                    "saved_at": cp.get("saved_at"),
                    "saved_after_day": cp.get("saved_after_day", 0),
                    "saved_cycle_idx": cp.get("saved_cycle_idx", 0),
                    "total_days": meta.get("total_days", cp.get("request", {}).get("sim_days", 0)),
                    "agent_count": meta.get("agent_count", len(cp.get("request", {}).get("agents", []))),
                    "county": cp.get("request", {}).get("county", ""),
                    "snapshot_name": cp.get("request", {}).get("snapshot_name", ""),
                    "workspace_id": cp.get("request", {}).get("workspace_id", ""),
                    "current_pool_count": cp.get("current_pool_count", 0),
                    "status": meta.get("status", "interrupted"),
                })
            except Exception as e:
                logger.warning(f"[evo-checkpoint] Skipping unreadable {fname}: {e}")
    except FileNotFoundError:
        pass
    return out


def _restore_evo_jobs_on_startup() -> None:
    """On worker startup, rehydrate checkpoints into _historical_jobs as 'interrupted'.

    Does NOT auto-resume — the user must explicitly call POST /resume.
    This is intentional: if a previous worker crashed mid-evolution we
    don't want to silently restart it, since the LLM costs and the user's
    intent should be confirmed.
    """
    restored = 0
    for cp in _list_evo_checkpoints():
        job_id = cp["job_id"]
        if not job_id or job_id in _historical_jobs:
            continue
        # Build a minimal job dict that the dashboard / status endpoint can serve
        meta = cp.get("status")  # already extracted above
        full_cp = _load_evo_checkpoint(job_id)
        if not full_cp:
            continue
        job_meta = full_cp.get("job_metadata", {})
        job_meta["status"] = "interrupted"
        job_meta["interrupted_at"] = time.time()
        job_meta["live_messages"] = [
            {"ts": time.time(), "text": f"💾 Previous progress preserved (last completed Day {cp.get('saved_after_day', 0)}). Call /resume to continue."}
        ]
        _historical_jobs[job_id] = job_meta
        restored += 1
    if restored:
        logger.info(f"[evo-checkpoint] Restored {restored} interrupted job(s) from disk")


# Run restoration immediately on module load (uvicorn worker startup)
try:
    _restore_evo_jobs_on_startup()
except Exception as _e:
    logger.warning(f"[evo-checkpoint] Restore failed at module load: {_e}")


def _apply_neutral_ratio(agents: list[dict], neutral_ratio: float) -> list[dict]:
    """Reassign a portion of partisan agents to the neutral bucket.

    Civatas-USA Stage 1.5+: country-aware. Recognizes both TW labels
    (偏左派 / 中立 / 偏右派) and US 5-tier labels
    (Solid Dem / Lean Dem / Tossup / Lean Rep / Solid Rep).
    """
    if neutral_ratio <= 0:
        return agents

    import random
    neutral_label = "Tossup"
    left_labels = {"Solid Dem", "Lean Dem"}
    right_labels = {"Solid Rep", "Lean Rep"}

    current_neutral = sum(1 for a in agents if a.get("political_leaning") == neutral_label)
    target_neutral = max(current_neutral, int(len(agents) * neutral_ratio))
    need = target_neutral - current_neutral
    if need <= 0:
        return agents

    left = [i for i, a in enumerate(agents) if a.get("political_leaning") in left_labels]
    right = [i for i, a in enumerate(agents) if a.get("political_leaning") in right_labels]
    total_partisan = len(left) + len(right)
    if total_partisan == 0:
        return agents

    need = min(need, total_partisan)
    from_left = round(need * len(left) / total_partisan)
    from_right = need - from_left

    random.shuffle(left)
    random.shuffle(right)
    to_flip = left[:from_left] + right[:from_right]

    for idx in to_flip:
        agents[idx]["political_leaning"] = neutral_label

    logger.info(f"[neutral_ratio] Applied {neutral_ratio:.0%}: flipped {len(to_flip)} agents to {neutral_label} "
                f"(from_left={from_left}, from_right={from_right})")
    return agents


def _diversify_initial_states(agents: list[dict], stance: dict | None = None) -> dict[str, dict]:
    """Generate differentiated initial satisfaction/anxiety and political attitudes.

    Args:
        agents: List of agent dicts with persona traits.
        stance: Optional NCCU stance data for the simulation year, used to
                distribute cross_strait attitudes realistically.

    Returns a dict keyed by str(person_id) with initial state values.
    """
    import random
    states: dict[str, dict] = {}

    # Build stance-based cross_strait distribution weights
    # Maps each stance category to a cross_strait score range (0=independence, 100=unification)
    # and uses the NCCU survey percentages as sampling weights
    stance_buckets: list[tuple[float, int, int]] = []
    if stance:
        # (weight, score_min, score_max)
        stance_buckets = [
            (float(stance.get("asap_independence", 5)),   0, 10),   # 儘快獨立 → 0~10
            (float(stance.get("lean_independence", 20)),  10, 30),  # 偏向獨立 → 10~30
            (float(stance.get("status_quo_indef", 25)),   30, 45),  # 永遠維持現狀 → 30~45
            (float(stance.get("status_quo_decide", 30)),  40, 60),  # 維持現狀再決定 → 40~60
            (float(stance.get("lean_unification", 10)),   65, 85),  # 偏向統一 → 65~85
            (float(stance.get("asap_unification", 2)),    85, 100), # 儘快統一 → 85~100
        ]

    def _sample_cross_strait(leaning: str) -> int:
        """Sample a cross_strait value from stance distribution, adjusted by leaning."""
        if stance_buckets:
            weights = [b[0] for b in stance_buckets]
            # Adjust weights by political leaning
            if leaning in ("偏左派", "Solid Dem", "Lean Dem"):
                # Boost independence-leaning buckets
                weights = [w * 1.8 if i < 2 else w * 0.5 if i >= 4 else w
                           for i, w in enumerate(weights)]
            elif leaning in ("偏右派", "Solid Rep", "Lean Rep"):
                # Boost unification-leaning buckets
                weights = [w * 0.5 if i < 2 else w * 1.8 if i >= 4 else w
                           for i, w in enumerate(weights)]
            # Weighted random selection
            total_w = sum(weights)
            r = random.random() * total_w
            cumulative = 0
            for i, (_, lo, hi) in enumerate(stance_buckets):
                cumulative += weights[i]
                if r <= cumulative:
                    return random.randint(lo, hi)
            return random.randint(40, 60)
        else:
            # Fallback: simple leaning-based defaults with variance
            if leaning in ("偏左派", "Solid Dem", "Lean Dem"):
                return random.randint(15, 40)
            elif leaning in ("偏右派", "Solid Rep", "Lean Rep"):
                return random.randint(60, 85)
            return random.randint(35, 65)

    for agent in agents:
        aid = str(agent.get("person_id", 0))
        leaning = agent.get("political_leaning", "Tossup")
        age = agent.get("age", 40)
        income = agent.get("income_band", agent.get("income_level", ""))

        # Base values with slight randomization (±8 around 50)
        base_local = 50 + random.randint(-8, 8)
        base_national = 50 + random.randint(-8, 8)
        base_anxiety = 50 + random.randint(-8, 8)

        # Income effect: lower income → higher anxiety, lower satisfaction
        income_lower = str(income).lower() if income else ""
        if any(k in income_lower for k in ["低", "low", "貧", "基層"]):
            base_anxiety += random.randint(5, 12)
            base_local -= random.randint(2, 6)
            base_national -= random.randint(3, 8)
        elif any(k in income_lower for k in ["高", "high", "富"]):
            base_anxiety -= random.randint(3, 8)
            base_local += random.randint(2, 5)

        # Age effect: elderly more anxious about economy; young more dissatisfied
        if isinstance(age, (int, float)):
            if age >= 65:
                base_anxiety += random.randint(2, 6)
            elif age <= 30:
                base_national -= random.randint(2, 5)

        # Leaning effect: partisans start slightly more satisfied with their side
        if leaning == "偏右派":
            base_local += random.randint(1, 5)
        elif leaning in ("偏左派", "Solid Dem", "Lean Dem"):
            base_national += random.randint(1, 5)

        # Generate cross_strait attitude from stance data distribution
        cross_strait = _sample_cross_strait(leaning)

        # Economic and social attitudes based on leaning with variance
        if leaning in ("偏左派", "Solid Dem", "Lean Dem"):
            econ = random.randint(25, 45)
            social = random.randint(20, 40)
        elif leaning in ("偏右派", "Solid Rep", "Lean Rep"):
            econ = random.randint(55, 80)
            social = random.randint(60, 80)
        else:
            econ = random.randint(35, 65)
            social = random.randint(35, 65)

        # Age modulates social values: younger → more progressive, older → more conservative
        if isinstance(age, (int, float)):
            if age <= 30:
                social = max(0, social - random.randint(5, 12))
            elif age >= 60:
                social = min(100, social + random.randint(5, 10))

        issue_map = {"偏左派": "主權", "偏右派": "經濟", "中立": "民生"}
        states[aid] = {
            "local_satisfaction": max(15, min(85, base_local)),
            "national_satisfaction": max(15, min(85, base_national)),
            "satisfaction": max(15, min(85, (base_local + base_national) // 2)),
            "anxiety": max(15, min(85, base_anxiety)),
            "days_evolved": 0,
            "political_attitudes": {
                "economic_stance": max(0, min(100, econ)),
                "social_values": max(0, min(100, social)),
                "cross_strait": max(0, min(100, cross_strait)),
                "issue_priority": issue_map.get(leaning, "民生"),
            },
        }

    return states


def _refine_occupations(agents: list[dict]) -> list[dict]:
    """Reclassify '無工作' and '無' into meaningful subcategories.

    Based on age, gender, education:
      65+                         → 退休
      15-24 & education ∈ 大專+   → 學生
      gender=女 & 25-64           → 家管
      else                        → 待業
    """
    import random as _rng
    changed = 0
    for a in agents:
        occ = a.get("occupation", "")
        if occ not in ("無工作", "無", ""):
            continue
        age = 0
        try:
            age = int(a.get("age", 0))
        except (ValueError, TypeError):
            pass
        gender = a.get("gender", "")
        edu = a.get("education", "")

        if age >= 65:
            a["occupation"] = "退休"
        elif age <= 24 and any(k in edu for k in ("大專", "大學", "碩士", "博士", "專科")):
            a["occupation"] = "學生"
        elif age <= 22 and age >= 15:
            # Young without higher edu — could be student or early career
            a["occupation"] = _rng.choice(["學生", "打工族"]) if age <= 19 else "待業"
        elif gender == "女" and 25 <= age < 65:
            # Probabilistic: ~60% homemaker, ~40% job seeker (reflects reality)
            a["occupation"] = "家管" if _rng.random() < 0.6 else "待業"
        else:
            a["occupation"] = "待業"
        changed += 1

    if changed:
        logger.info(f"[refine] Reclassified {changed} '無工作' agents into subcategories")
    return agents


@app.post("/evolution/historical-run")
async def historical_run(req: HistoricalRunRequest):
    """Run historical evolution: agents read news day-by-day, save snapshot at end."""
    return await _historical_run_inner(req, _resume_state=None)


async def _historical_run_inner(req: HistoricalRunRequest, _resume_state: dict | None = None):
    """Core historical-run implementation. Called both by the POST endpoint
    (fresh run) and by the resume endpoint (with _resume_state populated).

    When ``_resume_state`` is provided, the existing ``job_id`` is reused and
    the cycle loop will fast-forward past previously-completed days using
    the data restored from the on-disk checkpoint.
    """
    from .evolver import evolve_one_day, _load_states, _save_states, _save_diaries, _save_history, _save_profiles, _push_live
    from .news_pool import replace_pool
    from .snapshot import save_snapshot
    from shared.llm_vendors import get_available_vendors
    import asyncio, uuid, time, copy

    if _resume_state:
        logger.info(f"[historical-run] RESUME mode: job_id={_resume_state.get('job_id')}, from_day={_resume_state.get('from_day')}")
    else:
        logger.info(f"[historical-run] recording_id='{req.recording_id}', workspace_id='{req.workspace_id}', agents={len(req.agents)}, sim_days={req.sim_days}")

    # Scope all data stores to this workspace
    if req.workspace_id:
        from .news_pool import set_active_workspace as set_news_ws
        from .evolver import set_active_workspace as set_evo_ws
        set_news_ws(req.workspace_id)
        set_evo_ws(req.workspace_id)

    sp = req.scoring_params or {}

    # Apply neutral_ratio: reassign a portion of partisan agents to 中立
    neutral_ratio = sp.get("neutral_ratio", 0.0)
    if neutral_ratio > 0:
        req.agents = _apply_neutral_ratio(req.agents, neutral_ratio)

    # Filter out agents below voting age for election simulations
    if req.min_voting_age > 0:
        before = len(req.agents)
        req.agents = [a for a in req.agents if (a.get("age") or 0) >= req.min_voting_age]
        if len(req.agents) < before:
            logger.info(f"[historical-run] Excluded {before - len(req.agents)} agents under {req.min_voting_age} years old ({len(req.agents)} remaining)")

    # Reclassify '無工作' into meaningful subcategories
    req.agents = _refine_occupations(req.agents)

    concurrency = req.concurrency or len(req.enabled_vendors or []) or len(get_available_vendors())
    # Build candidate_names from tracked_candidates for awareness tracking
    _tracked_cand_names = [c.get("name", "") for c in req.tracked_candidates if c.get("name")]
    # Build poll_groups-like structure for visibility initialization
    _tracked_poll_groups = []
    if req.tracked_candidates:
        _tracked_poll_groups = [{"name": "tracked", "candidates": req.tracked_candidates}]

    if _resume_state:
        # Reuse the existing job_id and merge resume hints into the job dict
        job_id = _resume_state["job_id"]
        existing_job = _historical_jobs.get(job_id, {})
        existing_job.update({
            "job_id": job_id,
            "status": "running",
            "total_days": req.sim_days,
            "agent_count": len(req.agents),
            "resumed_at": time.time(),
            "completed_at": None,
            "daily_summary": existing_job.get("daily_summary", []),
            "live_messages": existing_job.get("live_messages", []),
            "snapshot_id": None,
            "enabled_vendors": req.enabled_vendors,
            "scoring_params": sp,
            "macro_context": req.macro_context,
            "candidate_names": _tracked_cand_names,
            "poll_groups": _tracked_poll_groups,
            # Resume hints consumed by _run_cycle_mode
            "_resume_from_day": _resume_state.get("from_day", 0),
            "_resume_llm_local_kw": list(_resume_state.get("llm_local_kw", [])),
            "_resume_llm_national_kw": list(_resume_state.get("llm_national_kw", [])),
            "_resume_seen_article_ids": set(_resume_state.get("seen_article_ids", [])),
        })
        job = existing_job
        _historical_jobs[job_id] = job
    else:
        job_id = uuid.uuid4().hex[:8]
        job = {
            "job_id": job_id, "status": "running", "current_day": 0,
            "total_days": req.sim_days, "agent_count": len(req.agents),
            "started_at": time.time(), "completed_at": None,
            "daily_summary": [], "live_messages": [], "snapshot_id": None,
            "enabled_vendors": req.enabled_vendors,
            "scoring_params": sp,
            "macro_context": req.macro_context,
            "candidate_names": _tracked_cand_names,
            "poll_groups": _tracked_poll_groups,
        }
        _historical_jobs[job_id] = job

    use_cycles = req.search_interval > 0 and req.start_date
    logger.info(f"[historical-run] search_interval={req.search_interval}, county='{req.county}', start_date='{req.start_date}', use_cycles={use_cycles}")

    async def _run():
        try:
            # NCCU TW cross-strait stance survey is not relevant for US workspaces.
            # The cross_strait field is repurposed for national_identity / immigration.
            stance_data = None

            # Generate diversified initial states based on persona traits + stance
            initial_states = _diversify_initial_states(req.agents, stance=stance_data)
            _save_states(initial_states)
            _save_diaries([])
            _save_history([])
            _save_profiles({})

            # ── Apply alignment target as starting point (BEFORE evolution) ──
            # Alignment calibrates agent initial states (leaning, satisfaction, anxiety)
            # to match known real-world data (election results or poll numbers).
            # Evolution then runs FROM this calibrated starting point.
            if req.alignment_target and req.alignment_target.get("mode"):
                try:
                    from .alignment import apply_alignment
                    _align_states = _load_states()
                    _align_profiles = []  # profiles not yet generated at this point
                    _align_result = apply_alignment(
                        _align_states, _align_profiles,
                        req.alignment_target,
                    )
                    _save_states(_align_result["states"])
                    # Store computed params for snapshot metadata later
                    job["_alignment_computed"] = {
                        **req.alignment_target,
                        "computed_params": _align_result.get("computed_params", {}),
                    }
                    _push_live(job, f"🎯 Alignment complete ({req.alignment_target.get('mode')}) — Agent initial state calibrated")
                except Exception as _ae:
                    logger.exception(f"[alignment] Failed: {_ae}")
                    _push_live(job, f"⚠️ Alignment calibration failed: {_ae}")

            # ── Extract objective facts about tracked candidates (one-time LLM call) ──
            _all_tracked = list(req.tracked_candidates or [])
            if not _all_tracked:
                for _pg in getattr(req, 'poll_groups', []) or []:
                    if isinstance(_pg, dict):
                        _all_tracked.extend(_pg.get("candidates", []))
            logger.info(f"[objective-facts] _all_tracked={len(_all_tracked)} names={[c.get('name','') for c in _all_tracked]}")
            if _all_tracked:
                try:
                    from shared.llm_vendors import get_available_vendors, get_client_for_vendor

                    # Check if any candidate has a meaningful description
                    _has_descriptions = any(len(c.get("description", "")) > 10 for c in _all_tracked)

                    if not _has_descriptions:
                        # No descriptions available — just use name + party (no LLM needed)
                        _obj_facts: dict[str, str] = {}
                        for c in _all_tracked:
                            cn = c.get("name", "")
                            cp = c.get("party", "")
                            if cn:
                                _obj_facts[cn] = f"{cn}（{cp}）" if cp else cn
                        if _obj_facts:
                            job["_candidate_objective_facts"] = _obj_facts
                            _push_live(job, f"📋 Set up {len(_obj_facts)} tracked candidates (party only, no detailed background)")
                            logger.info(f"[objective-facts] No descriptions, using name+party: {_obj_facts}")
                    else:
                        # Has descriptions — use LLM to extract objective facts
                        _cand_input = "\n".join(
                            f"- {c.get('name','')} (Party: {c.get('party','Unknown')}): {c.get('description','')}"
                            for c in _all_tracked if c.get("name")
                        )
                        _facts_text = ""
                        if _cand_input.strip():
                            _facts_prompt = f"""Below are background descriptions of political figures. Extract only objective facts for each person, removing all subjective adjectives and evaluations.

Input:
{_cand_input}

Rules:
- Keep only: name, party, occupation, current/former offices held, education
- Remove: adjectives (charismatic, pragmatic, warm, aggressive), evaluative statements (strong grassroots support, popular image), predictive statements
- One person per line, format: "Name (Party, Office1, Office2)"
- If information is insufficient, write only name and party
- Do NOT look up or add information beyond what is provided above

Example output:
Kamala Harris (Democratic, Vice President, former US Senator, former AG of California)
Donald Trump (Republican, 45th President, businessman)

Output the result directly, no extra text."""

                            _vendors = get_available_vendors()
                            _v_name = _vendors[0]["name"] if _vendors else None
                            if _v_name:
                                _of_client, _of_model, _ = get_client_for_vendor(_v_name)
                                _of_resp = await _of_client.chat.completions.create(
                                    model=_of_model,
                                    messages=[{"role": "user", "content": _facts_prompt}],
                                    temperature=0.2,
                                    max_tokens=500,
                                )
                                _facts_text = _of_resp.choices[0].message.content.strip()
                                logger.info(f"[objective-facts] LLM returned: {_facts_text[:200]}")

                        _obj_facts: dict[str, str] = {}
                        for line in _facts_text.strip().split("\n") if _facts_text else []:
                            line = line.strip().lstrip("- ").strip()
                            if not line:
                                continue
                            # Match "Name（...）" pattern
                            for c in _all_tracked:
                                cn = c.get("name", "")
                                if cn and cn in line:
                                    _obj_facts[cn] = line
                                    break
                        if _obj_facts:
                            job["_candidate_objective_facts"] = _obj_facts
                            _push_live(job, f"📋 Extracted objective facts for {len(_obj_facts)} tracked candidates")
                            logger.info(f"[objective-facts] {_obj_facts}")
                except Exception as _of_err:
                    logger.warning(f"[objective-facts] Failed (non-fatal): {_of_err}")

            if use_cycles:
                await _run_cycle_mode(job, req, concurrency)
            else:
                await _run_legacy_mode(job, req, concurrency)

        except Exception as e:
            logger.exception(f"Historical run failed: {e}")
            job["status"] = "failed"
            job["error"] = str(e)
            job["completed_at"] = time.time()
            # Finalize recording as failed
            if req.recording_id:
                try:
                    from .recorder import update_recording
                    update_recording(req.recording_id, {"status": "failed", "completed_at": time.time()})
                except Exception:
                    logger.exception(f"Failed to finalize recording {req.recording_id} on error")

    async def _run_legacy_mode(job, req, concurrency):
        """Original mode: pre-fetched events assigned to days."""
        job["agent_districts"] = {a.get("person_id", i): a.get("district", "Unknown") for i, a in enumerate(req.agents)}
        job["agent_info"] = {
            a.get("person_id", i): {
                "district": a.get("district", ""), "gender": a.get("gender", ""),
                "age": a.get("age", ""), "education": a.get("education", ""),
                "occupation": a.get("occupation", ""), "political_leaning": a.get("political_leaning", ""),
            } for i, a in enumerate(req.agents)
        }
        # Persist agent_info to disk for dashboard fallback
        _ai_path = os.path.join(os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution"), "agent_info.json")
        try:
            with open(_ai_path, "w") as _f:
                json.dump(job["agent_info"], _f, ensure_ascii=False)
        except Exception:
            pass
        events = sorted(req.events, key=lambda e: e.get("day", 0))
        replace_pool([])  # Clear news pool from previous workspace/run
        current_pool: list[dict] = []
        event_idx = 0

        # Build agent leaning map for incremental summary total_count.
        job["agent_leaning_map"] = {
            str(a.get("person_id", i)): a.get("political_leaning", "Tossup")
            for i, a in enumerate(req.agents)
        }

        for day in range(1, req.sim_days + 1):
            if job["status"] == "cancelled":
                break

            job["current_day"] = day

            while event_idx < len(events) and events[event_idx].get("day", 0) <= day:
                ev = events[event_idx]
                news_items = ev.get("news", [ev] if ev.get("title") else [])
                for item in news_items:
                    current_pool.append({
                        "article_id": uuid.uuid4().hex[:8],
                        "title": item.get("title", ""),
                        "summary": item.get("summary", ""),
                        "source_tag": item.get("source_tag", "歷史新聞"),
                        "channel": item.get("channel", "國內"),
                        "leaning": item.get("leaning", "center"),
                        "crawled_at": time.time(),
                    })
                event_idx += 1

            replace_pool(current_pool)
            _push_live(job, f"📅 Day {day}/{req.sim_days} — news pool {len(current_pool)} articles")

            entries = await evolve_one_day(
                req.agents, current_pool, day,
                feed_fn=None, memory_fn=None, job=job,
                concurrency=concurrency,
            )

            if entries:
                avg_sat = sum(e.get("satisfaction", 50) for e in entries) / len(entries)
                avg_anx = sum(e.get("anxiety", 50) for e in entries) / len(entries)
            else:
                avg_sat = avg_anx = 50

            # Update existing incremental summary or create new one
            existing = next((s for s in job["daily_summary"] if s["day"] == day), None)
            if existing:
                existing["avg_satisfaction"] = round(avg_sat, 1)
                existing["avg_anxiety"] = round(avg_anx, 1)
                existing["entries_count"] = len(entries)
            else:
                job["daily_summary"].append({
                    "day": day, "avg_satisfaction": round(avg_sat, 1),
                    "avg_anxiety": round(avg_anx, 1), "entries_count": len(entries),
                })

            # ── Recording: save step snapshot ──
            if req.recording_id and entries:
                try:
                    from .recorder import save_step, build_evolution_step
                    from .evolver import _load_states
                    step_data = build_evolution_step(
                        day=day, agents=req.agents, entries=entries,
                        states=_load_states(), news_articles=current_pool,
                        live_messages=job.get("live_messages", [])[-20:],
                        job=job,
                    )
                    save_step(req.recording_id, day, step_data)
                except Exception as _rec_err:
                    logger.exception(f"Recording step {day} failed")

            await asyncio.sleep(0.1)

        # Alignment was applied at the START of evolution (in _run()).
        # Here we just pass the metadata to the snapshot.
        _alignment_meta = job.get("_alignment_computed")

        snap_name = req.snapshot_name or f"Historical Evolution {time.strftime('%m/%d %H:%M')}"
        snap_desc = f"Historical Evolution {req.sim_days} days"
        snap = save_snapshot(snap_name, snap_desc, None,
                            workspace_id=req.workspace_id,
                            alignment_target=_alignment_meta)
        job["snapshot_id"] = snap["snapshot_id"]
        job["alignment_target"] = _alignment_meta
        job["status"] = "completed"
        job["completed_at"] = time.time()
        # Persist final agent states to disk
        from .evolver import _load_states, _save_states
        _save_states(_load_states())
        _push_live(job, f"✅ Evolution complete — snapshot saved: {snap_name}")

        # ── Recording: finalize ──
        if req.recording_id:
            try:
                from .recorder import update_recording
                update_recording(req.recording_id, {
                    "status": "completed", "completed_at": time.time(),
                    "total_steps": req.sim_days, "agent_count": len(req.agents),
                })
                logger.info(f"[recorder] Finalized recording {req.recording_id} (legacy)")
            except Exception as _e:
                logger.exception(f"Failed to finalize recording {req.recording_id}")

    async def _run_cycle_mode(job, req, concurrency):
        """Cycle mode: dynamic news search every N days.

        Honours resume hints on ``job``:
          - ``_resume_from_day`` — fast-forward past completed days
          - ``_resume_llm_local_kw`` / ``_resume_llm_national_kw``
          - ``_resume_seen_article_ids``
        """
        from .news_intelligence import (
            search_news_for_window, score_news_impact,
            assign_news_to_days, adjust_keywords, search_district_news,
            build_default_keywords, compute_cycle_news_window,
        )
        from datetime import datetime, timedelta

        interval = req.search_interval
        county = req.county or "台灣"

        # ── Resume support: detect & extract hints, then preserve pool ──
        _resume_from_day = job.pop("_resume_from_day", 0) or 0
        _resume_llm_local = job.pop("_resume_llm_local_kw", []) or []
        _resume_llm_national = job.pop("_resume_llm_national_kw", []) or []
        _resume_seen = job.pop("_resume_seen_article_ids", set()) or set()
        _is_resume = _resume_from_day > 0

        if _is_resume:
            # Keep the existing pool from disk (loaded by replace_pool earlier)
            # so previously-fetched articles are available to skipped days.
            from .news_pool import get_pool
            _existing_pool = list(get_pool())
            logger.info(f"[cycle-mode] RESUME: preserving {len(_existing_pool)} articles from previous run")
            _push_live(job, f"💾 Resume: pool has {len(_existing_pool)} articles + {len(_resume_seen)} seen article_ids")
        else:
            replace_pool([])  # fresh start clears the pool
        # ── Three-layer keyword architecture ──────────────────────────────
        # Layer 1: USER FIXED — user-entered in UI, always searched every cycle
        # Layer 2: SYSTEM DEFAULT — auto-generated baseline coverage for politics,
        #          economy, society, infrastructure, services, safety, environment.
        #          Always searched every cycle (does NOT get replaced by LLM).
        # Layer 3: CANDIDATE-INJECTED — auto-derived from tracked_candidates and
        #          poll_groups. Always searched every cycle so candidate news
        #          (which drives candidate_sentiment & candidate_awareness) is
        #          guaranteed to be found.
        # Layer 4 (orthogonal): LLM SUPPLEMENTARY — emerging issues identified
        #          by adjust_keywords() after each cycle. Refreshed cycle-by-
        #          cycle. Does NOT replace any of the above layers.
        # ──────────────────────────────────────────────────────────────────
        _cn_short = county.replace("市", "").replace("縣", "")

        # Layer 1: user fixed
        fixed_local_kw = [l.strip() for l in req.local_keywords.split("\n") if l.strip()]
        fixed_national_kw = [l.strip() for l in req.national_keywords.split("\n") if l.strip()]

        # Layer 2: system default (auto-generated baseline coverage)
        sys_local_kw, sys_national_kw = build_default_keywords(county)

        # Layer 3: candidate-injected (tracked candidates + poll group candidates)
        cand_local_kw: list[str] = []
        cand_national_kw: list[str] = []
        _tracked_names = [c.get("name", "") for c in req.tracked_candidates if c.get("name")]
        for cname in _tracked_names:
            cparty = next((c.get("party", "") for c in req.tracked_candidates if c.get("name") == cname), "")
            cand_local_kw.append(f'"{cname}" {county}')
            if cparty:
                cand_local_kw.append(f'"{cname}" "{cparty}" {_cn_short}')
            cand_national_kw.append(f'"{cname}" policy platform election')
        if _tracked_names:
            logger.info(f"[cycle-mode] Auto-injected {len(_tracked_names)} tracked candidates into search keywords: {_tracked_names}")

        _poll_cand_names = set(_tracked_names)
        for pg in getattr(req, 'poll_groups', []) or []:
            for c in (pg if isinstance(pg, list) else pg.get("candidates", [])):
                n = c.get("name", "") if isinstance(c, dict) else ""
                if n and n not in _poll_cand_names:
                    cand_local_kw.append(f'"{n}" {_cn_short}')
                    _poll_cand_names.add(n)

        # Layer 4: LLM supplementary — starts empty, grows after each cycle.
        # NOTE: this is INTENTIONALLY separate from the always-on layers above
        # so adjust_keywords() can refresh it without losing baseline coverage.
        llm_local_kw: list[str] = []
        llm_national_kw: list[str] = []

        # Helper: dedupe combined search list while preserving layer order
        def _combine_kws(*layers: list[str]) -> list[str]:
            seen = set()
            result = []
            for layer in layers:
                for k in layer:
                    if k and k not in seen:
                        seen.add(k)
                        result.append(k)
            return result

        if not fixed_local_kw and not fixed_national_kw:
            _push_live(job, f"📝 No user keywords set — using system defaults: {len(sys_local_kw)} local + {len(sys_national_kw)} national (fixed per cycle)")
        base_date = datetime.strptime(req.start_date, "%Y-%m-%d")

        # On resume: seed seen_article_ids, current_pool, llm keywords from checkpoint
        seen_article_ids: set[str] = set(_resume_seen) if _is_resume else set()
        current_pool: list[dict] = list(_existing_pool) if _is_resume else []
        if _is_resume and _resume_llm_local:
            llm_local_kw = list(_resume_llm_local)
        if _is_resume and _resume_llm_national:
            llm_national_kw = list(_resume_llm_national)
        total_days = req.sim_days
        num_cycles = (total_days + interval - 1) // interval
        global_day = 0

        # Store agent→district mapping in job for dashboard
        # Cache agent info for dashboard
        job["agent_districts"] = {a.get("person_id", i): a.get("district", "Unknown") for i, a in enumerate(req.agents)}
        job["agent_info"] = {
            a.get("person_id", i): {
                "district": a.get("district", ""), "gender": a.get("gender", ""),
                "age": a.get("age", ""), "education": a.get("education", ""),
                "occupation": a.get("occupation", ""), "political_leaning": a.get("political_leaning", ""),
            } for i, a in enumerate(req.agents)
        }
        # Persist agent_info to disk for dashboard fallback
        _ai_path = os.path.join(os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution"), "agent_info.json")
        try:
            with open(_ai_path, "w") as _f:
                json.dump(job["agent_info"], _f, ensure_ascii=False)
        except Exception:
            pass
        # Build agent leaning map for incremental summary total_count.
        job["agent_leaning_map"] = {
            str(a.get("person_id", i)): a.get("political_leaning", "Tossup")
            for i, a in enumerate(req.agents)
        }

        # ── Time compression report ──
        # If end_date is provided, the platform compresses the long real-news
        # range into the short sim_days. Each sim day represents
        # ``compression_ratio = news_total_days / sim_days`` real days. If
        # end_date is empty (or invalid), the system falls back to 1:1 mapping.
        _full_news_start, _full_news_end, _global_ratio = compute_cycle_news_window(
            req.start_date, req.end_date or "", total_days, 0, total_days, buffer_sim_days=0,
        )
        logger.info(f"[cycle-mode] county={county}, interval={interval}, days={total_days}, cycles={num_cycles}")
        logger.info(f"[cycle-mode] L1 fixed_local_kw={len(fixed_local_kw)} fixed_national_kw={len(fixed_national_kw)}")
        logger.info(f"[cycle-mode] L2 sys_local_kw={len(sys_local_kw)} sys_national_kw={len(sys_national_kw)}")
        logger.info(f"[cycle-mode] L3 cand_local_kw={len(cand_local_kw)} cand_national_kw={len(cand_national_kw)}")
        logger.info(
            f"[cycle-mode] news_range={_full_news_start}~{_full_news_end} → sim_days={total_days} "
            f"(compression ratio={_global_ratio:.2f}x)"
        )
        if _global_ratio > 1.05:
            _push_live(
                job,
                f"⏱️ Time compression: {_full_news_start}~{_full_news_end} ({(_global_ratio*total_days):.0f} real days) "
                f"→ {total_days} sim days (ratio {_global_ratio:.1f}×)"
            )

        for cycle_idx in range(num_cycles):
            if job["status"] == "cancelled":
                break

            cycle_start_day = cycle_idx * interval
            cycle_days = min(interval, total_days - cycle_start_day)

            # ── Resume: skip entire cycle if all its days are already done ──
            if _is_resume and (cycle_start_day + cycle_days) <= _resume_from_day:
                global_day = cycle_start_day + cycle_days  # advance counter
                logger.info(f"[cycle-mode] RESUME: skipping cycle {cycle_idx+1} (days {cycle_start_day+1}~{cycle_start_day+cycle_days})")
                continue

            # ── Compute the REAL-NEWS date window for this cycle ──
            # Under time compression, the cycle's real-news span ≠ its sim-day span.
            # LLM-supplementary keywords use a tight buffer (±0.5 sim days),
            # persistent layers use a wider buffer (±2 sim days) to find sparse topics.
            llm_news_start, llm_news_end, _ratio = compute_cycle_news_window(
                req.start_date, req.end_date or "", total_days,
                cycle_start_day, cycle_days, buffer_sim_days=0.5,
            )
            persistent_news_start, persistent_news_end, _ = compute_cycle_news_window(
                req.start_date, req.end_date or "", total_days,
                cycle_start_day, cycle_days, buffer_sim_days=2.0,
            )

            # ── Phase 1: Search news ──
            job["phase"] = "searching"
            # ── Always-on layers (every cycle): user fixed + system default + candidate ──
            persistent_local = _combine_kws(fixed_local_kw, sys_local_kw, cand_local_kw)
            persistent_national = _combine_kws(fixed_national_kw, sys_national_kw, cand_national_kw)
            # ── Combined with LLM supplementary (refreshed each cycle) ──
            combined_local = _combine_kws(persistent_local, llm_local_kw)
            combined_national = _combine_kws(persistent_national, llm_national_kw)
            _push_live(
                job,
                f"🔍 Cycle {cycle_idx+1}/{num_cycles} — sim days {cycle_start_day+1}~{cycle_start_day+cycle_days}"
                f" ↔ real news {llm_news_start}~{llm_news_end}"
                f" (user {len(fixed_local_kw)+len(fixed_national_kw)} + system {len(sys_local_kw)+len(sys_national_kw)}"
                f" + candidate {len(cand_local_kw)+len(cand_national_kw)} + LLM {len(llm_local_kw)+len(llm_national_kw)})"
            )

            # Target pool: enough unique articles for all agents to have diverse feeds
            _articles_per = sp.get("articles_per_agent", 3) if (sp := job.get("scoring_params", {})) else 3
            _target = max(50, len(req.agents) * _articles_per * cycle_days // 3)

            # Search persistent (always-on) keywords with the wider buffer first
            fixed_news = []
            if persistent_local or persistent_national:
                fixed_news = await search_news_for_window(
                    persistent_local, persistent_national, persistent_news_start, persistent_news_end, seen_article_ids,
                    target_pool_size=max(20, (len(persistent_local) + len(persistent_national)) * 8),
                )
                for n in fixed_news:
                    seen_article_ids.add(n["article_id"])
                if fixed_news:
                    _push_live(job, f"📌 Fixed+system+candidate keywords found {len(fixed_news)} relevant articles")

            # Then search LLM-supplementary keywords with the tight cycle window.
            # Skip any that already overlap the persistent layers.
            _persistent_set = set(persistent_local) | set(persistent_national)
            new_news = await search_news_for_window(
                [k for k in llm_local_kw if k not in _persistent_set],
                [k for k in llm_national_kw if k not in _persistent_set],
                llm_news_start, llm_news_end, seen_article_ids,
                target_pool_size=_target,
            )
            new_news = fixed_news + new_news
            for n in new_news:
                seen_article_ids.add(n["article_id"])

            # ── Phase 2: Score news impact (with candidate sentiment if tracked) ──
            _evo_cand_names = job.get("candidate_names", [])
            _evo_cand_profiles = {}
            for _tc in req.tracked_candidates:
                _tcn = _tc.get("name", "")
                _tcp = _tc.get("party", "")
                if _tcn:
                    _evo_cand_profiles[_tcn] = f"{_tcp}" if _tcp else ""
            if new_news:
                job["phase"] = "scoring"
                _push_live(job, f"⚖️ Scoring {len(new_news)} articles for social impact...")
                new_news = await score_news_impact(new_news, county, _evo_cand_names or None, _evo_cand_profiles or None)
                _push_live(job, f"📊 Kept {len(new_news)} articles (impact ≥ 3)")
            else:
                _push_live(job, f"⚠️ No news found this cycle (date range may be too old) — agents will evolve without news input")

            # ── Phase 2b: Search district-specific local news ──
            # District news uses the same compressed cycle window as LLM kw
            _districts = list(set(a.get("district", "") for a in req.agents if a.get("district")))
            cycle_district_news: dict[str, list[dict]] = {}
            if _districts:
                job["phase"] = "district_news"
                _push_live(job, f"🏘️ Searching local news for {len(_districts)} districts...")
                try:
                    _dist_counts = {}
                    for a in req.agents:
                        d = a.get("district", "")
                        if d:
                            _dist_counts[d] = _dist_counts.get(d, 0) + 1
                    cycle_district_news = await search_district_news(
                        _districts, county, llm_news_start, llm_news_end,
                        seen_ids=seen_article_ids,
                        district_agent_counts=_dist_counts,
                    )
                    _total_dn = sum(len(v) for v in cycle_district_news.values())
                    if _total_dn:
                        _push_live(job, f"🏘️ Found {_total_dn} local articles (covering {len(cycle_district_news)} districts)")
                except Exception as e:
                    logger.warning(f"District news search failed: {e}")

            # ── Phase 3: Assign news to sim days (time-compressed) & evolve ──
            # Map each article's REAL publication date proportionally onto
            # the cycle's sim-day buckets, then tag with the GLOBAL sim day
            # number so select_feed can filter "future" news.
            day_news = assign_news_to_days(
                new_news,
                cycle_sim_days=cycle_days,
                cycle_news_start=llm_news_start,
                cycle_news_end=llm_news_end,
            )
            for d_offset, d_arts in day_news.items():
                _tag_day = cycle_start_day + d_offset + 1  # 1-based global sim day
                for a in d_arts:
                    a["assigned_day"] = _tag_day

            # Add all cycle's news to pool at once (agents pick via feed_engine scoring,
            # filtered by current_day in select_feed to prevent future leakage)
            current_pool.extend(new_news)
            # Also merge district-specific local news into the main pool.
            # District news has no per-article date precision under compression,
            # so spread it evenly across the cycle's sim days.
            _dist_articles_flat = []
            for _dist_name, _dist_arts in cycle_district_news.items():
                for _da in _dist_arts:
                    if _da.get("article_id") not in seen_article_ids:
                        _da["channel"] = "地方"
                        _dist_articles_flat.append(_da)
                        seen_article_ids.add(_da["article_id"])
            for _i, _da in enumerate(_dist_articles_flat):
                _da["assigned_day"] = cycle_start_day + (_i % cycle_days) + 1
                current_pool.append(_da)
            replace_pool(current_pool)

            cycle_entries_all: list[dict] = []
            for d_offset in range(cycle_days):
                global_day += 1

                # ── Resume fast-forward ──
                # Skip days that completed before the worker died.
                # The agent state files (states.json, diaries.json) and the
                # news_pool.json are restored on disk; we only need to avoid
                # re-running evolve_one_day for days we already finished.
                if _is_resume and global_day <= _resume_from_day:
                    job["current_day"] = global_day
                    if d_offset == 0:
                        _push_live(job, f"⏩ Resume: skipping completed Day 1~{_resume_from_day}")
                    continue

                # ── Pause support ────────────────────────────────
                # When the user clicks pause, we suspend at the start of
                # the next sim day (after the previous day's checkpoint
                # was already written), then resume in-place when the
                # pause flag clears. Stop is honoured during pause too.
                while _historical_pauses.get(job["job_id"]):
                    if _historical_stops.get(job["job_id"]) or job["status"] == "cancelled":
                        break
                    if job["status"] != "paused":
                        job["status"] = "paused"
                        _push_live(job, "⏸️ Evolution paused (checkpoint saved to disk)")
                    await asyncio.sleep(1)
                if not _historical_pauses.get(job["job_id"]) and job["status"] == "paused":
                    job["status"] = "running"
                    _push_live(job, "▶️ Evolution resumed")

                # ── Stop support ─────────────────────────────────
                if _historical_stops.get(job["job_id"]) or job["status"] == "cancelled":
                    job["status"] = "cancelled"
                    break

                day_num = global_day
                job["current_day"] = day_num
                job["phase"] = "evolving"

                # Pre-evolve preview: how many articles are eligible for this sim day
                # (i.e. assigned_day <= day_num — what select_feed will see).
                _eligible_count = sum(
                    1 for a in current_pool
                    if (a.get("assigned_day") is None) or (a.get("assigned_day", 0) <= day_num)
                )
                _today_assigned = sum(
                    1 for a in current_pool if a.get("assigned_day") == day_num
                )
                _push_live(
                    job,
                    f"📅 Day {day_num}/{total_days} — pool {len(current_pool)} articles"
                    f", eligible {_eligible_count} (today assigned {_today_assigned})"
                )

                entries = await evolve_one_day(
                    req.agents, current_pool, day_num,
                    feed_fn=None, memory_fn=None, job=job,
                    concurrency=concurrency,
                    district_news=cycle_district_news,
                )

                if entries:
                    avg_sat = sum(e.get("satisfaction", 50) for e in entries) / len(entries)
                    avg_anx = sum(e.get("anxiety", 50) for e in entries) / len(entries)
                    avg_local = sum(e.get("local_satisfaction", e.get("satisfaction", 50)) for e in entries) / len(entries)
                    avg_national = sum(e.get("national_satisfaction", e.get("satisfaction", 50)) for e in entries) / len(entries)
                    # ── Truthful feed stats (post-evolve) ────────────────
                    # Compute actual articles delivered to agents (NOT what
                    # assign_news_to_days hoped for). Detect any temporal
                    # drift: if an agent on day N read an article assigned
                    # to day > N, that's a future-leak bug.
                    _pool_assigned: dict = {a.get("article_id"): a.get("assigned_day") for a in current_pool}
                    _total_reads = 0
                    _read_articles: set = set()
                    _future_leaks = 0
                    _past_leaks = 0
                    for e in entries:
                        for art_id in (e.get("fed_articles") or []):
                            _total_reads += 1
                            _read_articles.add(art_id)
                            _aday = _pool_assigned.get(art_id)
                            if _aday is not None:
                                if _aday > day_num:
                                    _future_leaks += 1   # should be 0 with select_feed filter
                                elif _aday < day_num - 1:
                                    _past_leaks += 1     # acceptable but worth tracking
                    _avg_per_agent = _total_reads / len(entries) if entries else 0
                    _msg = (
                        f"📖 Day {day_num} done — avg {_avg_per_agent:.1f} articles per agent"
                        f", {len(_read_articles)} unique articles used"
                    )
                    if _future_leaks > 0:
                        _msg += f"  ⚠️ Future-news leak {_future_leaks}x!"
                    _push_live(job, _msg)
                else:
                    avg_sat = avg_anx = avg_local = avg_national = 50

                # Update existing incremental summary or create new one
                existing = next((s for s in job["daily_summary"] if s["day"] == day_num), None)
                if existing:
                    existing["avg_satisfaction"] = round(avg_sat, 1)
                    existing["avg_anxiety"] = round(avg_anx, 1)
                    existing["entries_count"] = len(entries)
                else:
                    job["daily_summary"].append({
                        "day": day_num, "avg_satisfaction": round(avg_sat, 1),
                        "avg_anxiety": round(avg_anx, 1), "entries_count": len(entries),
                    })
                # ── Recording: save step snapshot (cycle mode) ──
                if req.recording_id and entries:
                    try:
                        from .recorder import save_step, build_evolution_step
                        from .evolver import _load_states
                        step_data = build_evolution_step(
                            day=day_num, agents=req.agents, entries=entries,
                            states=_load_states(), news_articles=current_pool,
                            live_messages=job.get("live_messages", [])[-20:],
                            job=job,
                        )
                        save_step(req.recording_id, day_num, step_data)
                    except Exception as _rec_err:
                        logger.exception(f"Recording step {day_num} failed")

                cycle_entries_all.extend(entries)

                # Civatas-USA Stage 1.5+: incrementally flush diaries to disk
                # so the agent_diary endpoint + Agent Explorer panel can show
                # them mid-run. (Cycle mode previously only kept them in
                # memory until cycle end → user couldn't read diaries until
                # the cycle finished, and a restart wiped everything.)
                try:
                    from .evolver import _load_diaries, _save_diaries
                    _existing = _load_diaries()
                    _existing.extend(entries)
                    _save_diaries(_existing)
                except Exception as _diary_err:
                    logger.warning(f"[diary-flush] day {day_num} failed: {_diary_err}")

                # ── Auto-checkpoint after every completed sim day ──
                # Lets the job survive uvicorn --reload, container restart,
                # and unexpected crashes. Persists to disk via atomic rename.
                try:
                    _save_evo_checkpoint(
                        job=job,
                        request_dict=req.dict() if hasattr(req, "dict") else dict(req),
                        seen_article_ids=seen_article_ids,
                        llm_local_kw=llm_local_kw,
                        llm_national_kw=llm_national_kw,
                        cycle_idx=cycle_idx,
                        global_day=global_day,
                        current_pool_count=len(current_pool),
                    )
                except Exception as _cp_err:
                    logger.warning(f"[checkpoint] save failed for day {global_day}: {_cp_err}")

                await asyncio.sleep(0.1)

            # ── Phase 3.5: Build long-term memory summaries from this cycle ──
            if cycle_entries_all:
                try:
                    from .evolver import _load_states, _save_states
                    _mem_states = _load_states()
                    # Collect key events from this cycle's diaries
                    cycle_diaries: dict[str, list[str]] = {}
                    for e in cycle_entries_all:
                        eid = str(e.get("agent_id", e.get("person_id", "")))
                        dtxt = e.get("diary_text", e.get("todays_diary", ""))
                        if dtxt and eid:
                            if eid not in cycle_diaries:
                                cycle_diaries[eid] = []
                            cycle_diaries[eid].append(dtxt[:150])

                    # Use the REAL-news window for memory labeling under time compression,
                    # so an agent's memory reflects the actual date span they "lived through".
                    cycle_label = f"{llm_news_start}~{llm_news_end}"
                    _tracked_names_for_mem = [c.get("name", "") for c in req.tracked_candidates if c.get("name")] if req.tracked_candidates else []
                    for eid, dtxts in cycle_diaries.items():
                        if eid not in _mem_states:
                            continue
                        st = _mem_states[eid]
                        if "memory_summary" not in st:
                            st["memory_summary"] = []
                        # Build summary: overall sentiment + candidate mentions
                        all_text = " ".join(dtxts)
                        local_sat = st.get("local_satisfaction", 50)
                        national_sat = st.get("national_satisfaction", 50)
                        sentiment = "positive" if (local_sat + national_sat) / 2 > 55 else "negative" if (local_sat + national_sat) / 2 < 45 else "neutral"

                        # Extract candidate impression snippets from this cycle's diaries
                        cand_impressions = []
                        for cname in _tracked_names_for_mem:
                            for dtxt in dtxts:
                                if cname in dtxt:
                                    # Find the sentence containing the candidate name
                                    for sent in dtxt.replace("。", "。\n").replace("，", "，\n").split("\n"):
                                        if cname in sent and len(sent.strip()) > 5:
                                            # Take a brief snippet around the mention
                                            snippet = sent.strip()[:60]
                                            cand_impressions.append(f"{cname}：{snippet}")
                                            break
                                    break  # One mention per candidate per cycle is enough

                        summary_line = f"[{cycle_label}] Overall {sentiment}. "
                        if dtxts:
                            summary_line += dtxts[0][:40]
                        if cand_impressions:
                            summary_line += " | " + "; ".join(cand_impressions[:3])
                        st["memory_summary"].append(summary_line)
                        # Keep last 10 cycle summaries (covers ~30 days at 3-day cycles)
                        if len(st["memory_summary"]) > 10:
                            st["memory_summary"] = st["memory_summary"][-10:]
                    _save_states(_mem_states)
                except Exception as _mem_err:
                    logger.warning(f"[memory] Failed to build cycle summaries: {_mem_err}")

            # ── Phase 4: Analyze & adjust keywords for next cycle ──
            if cycle_idx < num_cycles - 1 and cycle_entries_all:
                job["phase"] = "adjusting"
                _push_live(job, f"🧠 Analyzing evolution results, adjusting search strategy for next cycle...")

                # Find high-reaction news
                high_reaction = [
                    (e.get("fed_titles") or [""])[0]
                    for e in cycle_entries_all
                    if e.get("news_relevance") == "high" and (e.get("fed_titles") or [""])
                ]
                # Deduplicate
                high_reaction = list(dict.fromkeys(high_reaction))[:10]

                cycle_summary = {
                    "avg_local_sat": sum(e.get("local_satisfaction", 50) for e in cycle_entries_all) / len(cycle_entries_all),
                    "avg_national_sat": sum(e.get("national_satisfaction", 50) for e in cycle_entries_all) / len(cycle_entries_all),
                    "avg_anxiety": sum(e.get("anxiety", 50) for e in cycle_entries_all) / len(cycle_entries_all),
                }

                try:
                    # Refresh ONLY the LLM supplementary layer. The persistent
                    # layers (user fixed + system default + candidate) are
                    # never replaced — they're passed to adjust_keywords as
                    # "already covered" so the LLM avoids duplicating them.
                    llm_local_kw, llm_national_kw = await adjust_keywords(
                        llm_local_kw, llm_national_kw, county,
                        cycle_summary, high_reaction,
                        already_covered_local=persistent_local,
                        already_covered_national=persistent_national,
                    )
                    # Drop anything that overlaps the persistent layers
                    _persistent_set_post = set(persistent_local) | set(persistent_national)
                    llm_local_kw = [k for k in llm_local_kw if k not in _persistent_set_post]
                    llm_national_kw = [k for k in llm_national_kw if k not in _persistent_set_post]
                    _push_live(
                        job,
                        f"🔄 LLM supplementary keywords updated (+{len(llm_local_kw)} local / +{len(llm_national_kw)} national)"
                        f"; user+system+candidate {len(persistent_local)+len(persistent_national)} groups unchanged"
                    )
                except Exception as e:
                    logger.warning(f"Keyword adjustment failed: {e}")
                    _push_live(job, "⚠️ Dynamic keyword update failed — falling back to previous round")

        # Alignment was applied at the START of evolution (in _run()).
        # Here we just pass the metadata to the snapshot.
        _alignment_meta = job.get("_alignment_computed")

        snap_name = req.snapshot_name or f"Historical Evolution {time.strftime('%m/%d %H:%M')}"
        snap_desc = f"Dynamic evolution {total_days} days / {num_cycles} cycles"
        snap = save_snapshot(snap_name, snap_desc, None,
                            workspace_id=req.workspace_id,
                            alignment_target=_alignment_meta)
        job["snapshot_id"] = snap["snapshot_id"]
        job["alignment_target"] = _alignment_meta
        job["status"] = "completed"
        job["completed_at"] = time.time()
        # Persist final agent states to disk
        from .evolver import _load_states, _save_states
        _save_states(_load_states())
        _push_live(job, f"✅ Evolution complete ({num_cycles} search cycles) — snapshot saved: {snap_name}")

        # ── Clean up checkpoint on successful completion ──
        _delete_evo_checkpoint(job["job_id"])
        _historical_pauses.pop(job["job_id"], None)
        _historical_stops.pop(job["job_id"], None)

        # ── Recording: finalize (cycle mode) ──
        if req.recording_id:
            try:
                from .recorder import update_recording
                update_recording(req.recording_id, {
                    "status": "completed", "completed_at": time.time(),
                    "total_steps": total_days, "agent_count": len(req.agents),
                })
                logger.info(f"[recorder] Finalized recording {req.recording_id} (cycle)")
            except Exception as _e:
                logger.exception(f"Failed to finalize recording {req.recording_id}")

    asyncio.create_task(_run())
    return {"job_id": job_id, "status": "running"}


@app.get("/evolution/historical-run/{job_id}")
def historical_run_status(job_id: str):
    job = _historical_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@app.post("/evolution/historical-run/{job_id}/stop")
def historical_run_stop(job_id: str):
    """Hard-stop a running or paused evolution job. Deletes its checkpoint."""
    from .evolver import _push_live
    job = _historical_jobs.get(job_id)
    if not job:
        # Even if not in memory, try to delete a stale checkpoint so the
        # interrupted-list UI cleans up.
        _delete_evo_checkpoint(job_id)
        raise HTTPException(404, "Job not found")
    _historical_stops[job_id] = True
    _historical_pauses[job_id] = False  # release any pause-loop
    job["status"] = "cancelled"
    try:
        _push_live(job, "🛑 Evolution stopped (checkpoint deleted)")
    except Exception:
        pass
    _delete_evo_checkpoint(job_id)
    return {"stopped": True}


@app.post("/evolution/historical-run/{job_id}/pause")
def historical_run_pause(job_id: str):
    """Request a running evolution job to pause at the next sim-day boundary.

    The job continues until it finishes the current LLM call wave, then
    halts. The latest checkpoint (which is auto-saved every sim day) is
    sufficient to resume — no extra writing needed here.
    """
    job = _historical_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    _historical_pauses[job_id] = True
    return {"status": "pausing", "job_id": job_id}


@app.post("/evolution/historical-run/{job_id}/resume")
async def historical_run_resume(job_id: str):
    """Resume a paused or interrupted evolution job from its checkpoint.

    Two scenarios:
      1. **Paused (in memory)**: clear the pause flag — the existing
         coroutine wakes up at the next sim-day boundary.
      2. **Interrupted (worker restart)**: reload checkpoint from disk,
         reconstruct the request, and start a fresh ``_run_cycle_mode``
         coroutine that fast-forwards past completed days.
    """
    job = _historical_jobs.get(job_id)

    # Case 1: still in memory and just paused → simple flag flip
    if job and job.get("status") == "paused":
        _historical_pauses[job_id] = False
        return {"status": "resuming", "job_id": job_id, "from_day": job.get("current_day", 0)}

    # Case 2: interrupted by worker restart → reload from disk
    cp = _load_evo_checkpoint(job_id)
    if not cp:
        raise HTTPException(404, "No checkpoint found for this job")

    request_dict = cp.get("request", {})
    if not request_dict:
        raise HTTPException(500, "Checkpoint missing request data")

    # Rehydrate as a HistoricalRunRequest. Use parse_obj for forward compat.
    try:
        req = HistoricalRunRequest.parse_obj(request_dict)
    except Exception as e:
        raise HTTPException(500, f"Checkpoint request rehydrate failed: {e}")

    # Restore job metadata into _historical_jobs (will be merged in _historical_run_inner)
    job_meta = cp.get("job_metadata", {})
    job_meta["status"] = "running"
    job_meta["resumed_at"] = time.time()
    job_meta["live_messages"] = job_meta.get("live_messages", [])
    _historical_jobs[job_id] = job_meta
    _historical_pauses[job_id] = False
    _historical_stops[job_id] = False
    try:
        from .evolver import _push_live
        _push_live(job_meta, f"▶️ Resuming from checkpoint (completed Day {cp.get('saved_after_day', 0)})")
    except Exception:
        pass

    # Delegate to the inner runner with resume hints. This reuses the same
    # cycle loop as fresh runs, with fast-forward logic gated on
    # ``job["_resume_from_day"]``.
    return await _historical_run_inner(req, _resume_state={
        "job_id": job_id,
        "from_day": cp.get("saved_after_day", 0),
        "llm_local_kw": cp.get("llm_local_kw", []),
        "llm_national_kw": cp.get("llm_national_kw", []),
        "seen_article_ids": cp.get("seen_article_ids", []),
    })


@app.get("/evolution/historical-run-checkpoints")
def historical_run_list_checkpoints():
    """List all on-disk checkpoints (for the resume-UI to enumerate)."""
    return {"checkpoints": _list_evo_checkpoints()}


@app.get("/evolution/historical-runs")
def historical_runs_list():
    """List all in-memory job summaries (running + interrupted + completed)."""
    out = []
    for jid, job in _historical_jobs.items():
        out.append({
            "job_id": jid,
            "status": job.get("status"),
            "phase": job.get("phase", ""),
            "current_day": job.get("current_day", 0),
            "total_days": job.get("total_days", 0),
            "agent_count": job.get("agent_count", 0),
            "started_at": job.get("started_at"),
            "interrupted_at": job.get("interrupted_at"),
            "completed_at": job.get("completed_at"),
            "snapshot_id": job.get("snapshot_id", ""),
        })
    out.sort(key=lambda j: j.get("started_at") or j.get("interrupted_at") or 0, reverse=True)
    return {"jobs": out}


class CreatePredictionRequest(BaseModel):
    question: str
    snapshot_id: str
    scenarios: list[dict]  # [{id, name, news}]
    sim_days: int = 30
    concurrency: int = 0  # 0 = auto (enabled_vendors × 2)
    enable_kol: bool = False
    kol_ratio: float = 0.05
    kol_reach: float = 0.40
    sampling_modality: str = "unweighted"
    poll_options: list[dict] = []  # [{name, description}]
    max_choices: int = 1
    poll_groups: list[dict] = []  # [{name, candidates: [{name, description}]}]
    scoring_params: dict | None = None  # tunable heuristic scoring parameters
    macro_context: str | None = None
    enabled_vendors: list[str] | None = None
    use_calibration_result_leaning: bool = True
    # Cycle-based dynamic news search (same as historical evolution)
    search_interval: int = 0           # 0 = legacy static news, >0 = days per search cycle
    local_keywords: str = ""
    national_keywords: str = ""
    county: str = ""
    start_date: str = ""               # YYYY-MM-DD
    end_date: str = ""
    prediction_mode: str = "election"   # "election" or "satisfaction"
    enable_news_search: bool = True    # if False, skip cycle search and run on snapshot state alone
    use_electoral_college: bool = False  # US presidential: compute state-level winner-take-all EV


class RunPredictionRequest(BaseModel):
    prediction_id: str
    agents: list[dict]
    tracked_ids: list[str] | None = None
    min_voting_age: int = 18  # exclude agents younger than this
    recording_id: str = ""    # if set, record step data for playback
    workspace_id: str = ""


@app.post("/predictions")
def prediction_create(req: CreatePredictionRequest):
    from .predictor import save_prediction
    from shared.llm_vendors import get_available_vendors
    concurrency = len(req.enabled_vendors) if req.enabled_vendors else len(get_available_vendors())
    return save_prediction(
        req.question, req.snapshot_id, req.scenarios, req.sim_days, concurrency,
        req.enable_kol, req.kol_ratio, req.kol_reach, req.sampling_modality,
        req.poll_options, req.max_choices, req.poll_groups, req.scoring_params, req.macro_context,
        req.enabled_vendors, req.use_calibration_result_leaning,
        search_interval=req.search_interval, local_keywords=req.local_keywords,
        national_keywords=req.national_keywords, county=req.county,
        start_date=req.start_date, end_date=req.end_date,
        prediction_mode=req.prediction_mode,
        enable_news_search=req.enable_news_search,
        use_electoral_college=req.use_electoral_college,
    )


@app.get("/predictions")
def prediction_list():
    from .predictor import list_predictions
    return {"predictions": list_predictions()}


@app.get("/predictions/jobs")
def prediction_jobs_list_early():
    """Return all in-memory prediction jobs (lightweight summary).
    Registered BEFORE /predictions/{pred_id} so "jobs" isn't captured as pred_id."""
    from .predictor import list_pred_jobs
    return {"jobs": list_pred_jobs()}


@app.get("/predictions/{pred_id}")
def prediction_get(pred_id: str):
    from .predictor import get_prediction
    pred = get_prediction(pred_id)
    if not pred:
        raise HTTPException(404, "Prediction not found")
    return pred


@app.delete("/predictions/{pred_id}")
def prediction_delete(pred_id: str):
    from .predictor import delete_prediction
    if not delete_prediction(pred_id):
        raise HTTPException(404, "Prediction not found")
    return {"deleted": pred_id}


@app.post("/predictions/run")
async def prediction_run(req: RunPredictionRequest):
    from .predictor import run_prediction
    # Scope all data stores to this workspace
    if req.workspace_id:
        from .news_pool import set_active_workspace as set_news_ws
        from .evolver import set_active_workspace as set_evo_ws
        set_news_ws(req.workspace_id)
        set_evo_ws(req.workspace_id)
    # Filter out agents below voting age for election predictions
    agents = req.agents
    if req.min_voting_age > 0:
        agents = [a for a in agents if (a.get("age") or 0) >= req.min_voting_age]
        if len(agents) < len(req.agents):
            logger.info(f"[prediction-run] Excluded {len(req.agents) - len(agents)} agents under {req.min_voting_age} years old")
    # Reclassify '無工作' into meaningful subcategories
    agents = _refine_occupations(agents)
    try:
        result = await run_prediction(req.prediction_id, agents, tracked_ids=req.tracked_ids, recording_id=req.recording_id, workspace_id=req.workspace_id or "")
        return result
    except FileNotFoundError:
        raise HTTPException(404, "Prediction not found")


@app.get("/predictions/jobs")
def prediction_jobs_list():
    """Return all in-memory prediction jobs (lightweight summary)."""
    from .predictor import list_pred_jobs
    return {"jobs": list_pred_jobs()}


@app.get("/predictions/jobs/{job_id}")
def prediction_job_status(job_id: str):
    from .predictor import get_pred_job
    job = get_pred_job(job_id)
    if not job:
        raise HTTPException(404, "Prediction job not found")
    return job


@app.post("/satisfaction-survey")
async def satisfaction_survey(request: Request):
    """Run a satisfaction survey on evolved agents.

    Body: {
        snapshot_id: str,           # which snapshot to survey
        person_name: str,           # e.g. "Joe Biden"
        person_role: str,           # e.g. "President", "Governor of Texas", "Senate candidate"
        person_party: str,          # e.g. "Democrat" / "Republican" / "Independent"
    }
    Returns 5-level satisfaction distribution.
    """
    from .snapshot import restore_snapshot
    from .evolver import _load_states, _load_diaries

    body = await request.json()
    snapshot_id = body.get("snapshot_id", "")
    person_name = body.get("person_name", "").strip()
    person_role = body.get("person_role", "").strip()
    person_party = body.get("person_party", "").strip()

    if not person_name:
        raise HTTPException(400, "person_name required")

    # Restore snapshot to get agent states
    if snapshot_id:
        try:
            restore_snapshot(snapshot_id)
        except FileNotFoundError:
            raise HTTPException(404, f"Snapshot not found: {snapshot_id}")

    states = _load_states()
    diaries = _load_diaries()

    # Load agent profiles for personality/individuality (for undecided calculation)
    from .evolver import _load_profiles
    profiles = _load_profiles()
    _profile_map: dict[str, dict] = {}
    if isinstance(profiles, dict):
        for pid, p in profiles.items():
            if isinstance(p, dict):
                _profile_map[str(pid)] = p
    elif isinstance(profiles, list):
        for p in profiles:
            pid = str(p.get("person_id", p.get("agent_id", "")))
            _profile_map[pid] = p

    if not states:
        raise HTTPException(400, "No agent states available")

    # Determine which satisfaction metric to use
    _role_lower = person_role.lower()
    is_national = any(k in _role_lower for k in [
        "president", "vice president", "vp ", "secretary", "cabinet", "federal",
        "senate", "senator", "house", "congress", "congressman", "congresswoman",
        "representative", "speaker",
    ])
    is_local = any(k in _role_lower for k in [
        "governor", "lt. governor", "lieutenant governor", "mayor", "council",
        "councilman", "councilwoman", "councilmember", "state senator",
        "state assembly", "state representative", "sheriff", "district attorney",
        "da ", "school board", "county", "city ", "local",
    ])
    is_candidate = any(k in _role_lower for k in [
        "candidate", "nominee", "primary", "challenger", "running for",
    ])

    # Compute per-agent satisfaction level
    results = {"Very satisfied": 0, "Fairly satisfied": 0, "Somewhat dissatisfied": 0, "Very dissatisfied": 0, "Undecided": 0}
    agent_details = []

    for aid, state in states.items():
        if not isinstance(state, dict):
            continue
        sat = state.get("satisfaction", 50)
        local_sat = state.get("local_satisfaction", sat)
        national_sat = state.get("national_satisfaction", sat)
        anxiety = state.get("anxiety", 50)
        leaning = state.get("current_leaning", "Tossup")
        cand_sent = (state.get("candidate_sentiment") or {}).get(person_name, None)
        cand_aw = (state.get("candidate_awareness") or {}).get(person_name, None)

        # Choose base score
        if is_candidate and cand_sent is not None:
            # For candidates: convert sentiment (-1~+1) to satisfaction (0~100)
            base_score = 50 + cand_sent * 40  # -1→10, 0→50, +1→90
        elif is_national:
            base_score = national_sat
        elif is_local:
            base_score = local_sat
        else:
            # Mixed: average of local and national, adjusted by candidate sentiment if available
            base_score = (local_sat + national_sat) / 2
            if cand_sent is not None:
                base_score = base_score * 0.5 + (50 + cand_sent * 40) * 0.5

        # Party alignment adjustment (US two-party + Cook PVI buckets)
        if person_party:
            _pp = person_party.lower()
            is_rep = any(k in _pp for k in ["republican", "gop", "rep ", "rep."]) or _pp.strip() in {"r", "rep"}
            is_dem = any(k in _pp for k in ["democrat", "democratic", "dem "]) or _pp.strip() in {"d", "dem"}
            is_ind = any(k in _pp for k in ["independent", "ind ", "third party", "libertarian", "green"]) or _pp.strip() in {"i", "ind"}
            _lean = leaning or ""
            lean_rep = any(k in _lean for k in ["Solid Rep", "Lean Rep"])
            lean_dem = any(k in _lean for k in ["Solid Dem", "Lean Dem"])
            lean_tossup = "Tossup" in _lean
            if is_rep and lean_rep:
                base_score += 8
            elif is_rep and lean_dem:
                base_score -= 8
            elif is_dem and lean_dem:
                base_score += 8
            elif is_dem and lean_rep:
                base_score -= 8
            elif is_ind and lean_tossup:
                base_score += 4  # independents get a smaller bump from swing voters

        # ── Multi-factor undecided probability ──
        # Real people don't just abstain because they don't know someone.
        # Factors: political apathy, personality, awareness, indecision.
        import random as _srv_rng
        profile = _profile_map.get(str(aid), {})
        idv = profile.get("individuality", {})
        pers = profile.get("personality", {})
        cog_bias = idv.get("cognitive_bias", "")
        sociability = pers.get("sociability", "適度社交")

        undecided_prob = 0.0

        # Factor 1: Political apathy (matches both legacy CJK and English persona values)
        if cog_bias in ("無感冷漠", "Apathetic", "apathetic"):
            undecided_prob += 0.40  # 40% chance of not caring
        elif cog_bias in ("理性分析", "Analytical", "analytical"):
            undecided_prob += 0.05  # rational people usually have an opinion

        # Factor 2: Unwilling to express (introverts don't share opinions)
        if sociability in ("獨立自處", "Independent", "independent"):
            undecided_prob += 0.15
        elif sociability in ("適度社交", "Moderately social", "moderately social"):
            undecided_prob += 0.03

        # Factor 3: Low awareness (but not absolute — some still guess)
        if cand_aw is not None and cand_aw < 0.15:
            undecided_prob += 0.30  # very unfamiliar → likely undecided
        elif cand_aw is not None and cand_aw < 0.3:
            undecided_prob += 0.10  # somewhat unfamiliar → slight chance
            # But some people will random-pick even if unfamiliar
            if _srv_rng.random() < 0.4:
                # "聽說過" → randomly lean toward a vague impression
                base_score += _srv_rng.gauss(0, 8)

        # Factor 4: Indecision (score near middle = genuinely torn)
        if 42 < base_score < 58:
            undecided_prob += 0.12  # on the fence

        # Factor 5: High anxiety + swing-voter leaning → confused/overwhelmed
        if anxiety > 70 and ("Tossup" in (leaning or "") or "中立" in (leaning or "")):
            undecided_prob += 0.10

        # Cap and apply
        undecided_prob = min(0.70, undecided_prob)

        # Map to 5-level first (before undecided override)
        base_score = max(0, min(100, base_score))
        if base_score >= 75:
            level = "Very satisfied"
        elif base_score >= 55:
            level = "Fairly satisfied"
        elif base_score >= 45:
            level = "Somewhat dissatisfied" if base_score < 50 else "Fairly satisfied"
        elif base_score >= 25:
            level = "Somewhat dissatisfied"
        else:
            level = "Very dissatisfied"

        # Apply undecided probability
        if _srv_rng.random() < undecided_prob:
            level = "Undecided"

        results[level] += 1
        agent_details.append({
            "agent_id": aid,
            "score": round(base_score, 1),
            "level": level,
            "leaning": leaning,
        })

    total = sum(results.values())
    satisfied = results["Very satisfied"] + results["Fairly satisfied"]
    dissatisfied = results["Somewhat dissatisfied"] + results["Very dissatisfied"]

    return {
        "person_name": person_name,
        "person_role": person_role,
        "person_party": person_party,
        "total": total,
        "results": results,
        "percentages": {k: round(v / max(total, 1) * 100, 1) for k, v in results.items()},
        "satisfied_total": round(satisfied / max(total, 1) * 100, 1),
        "dissatisfied_total": round(dissatisfied / max(total, 1) * 100, 1),
        "undecided_total": round(results["Undecided"] / max(total, 1) * 100, 1),
        "agent_details": agent_details,
        # By leaning breakdown
        "by_leaning": _survey_by_leaning(agent_details),
    }


def _survey_by_leaning(details: list[dict]) -> dict:
    """Group survey results by political leaning (US Cook PVI buckets)."""
    _LEVELS = ["Very satisfied", "Fairly satisfied", "Somewhat dissatisfied", "Very dissatisfied", "Undecided"]
    groups: dict[str, dict[str, int]] = {}
    for d in details:
        lean = d.get("leaning") or "Tossup"
        if lean not in groups:
            groups[lean] = {k: 0 for k in _LEVELS}
            groups[lean]["total"] = 0
        # Defensive: legacy snapshots may still emit CJK levels; bucket them under matching English key
        _lvl = d["level"]
        if _lvl not in groups[lean]:
            groups[lean][_lvl] = 0
        groups[lean][_lvl] += 1
        groups[lean]["total"] += 1
    for lean, data in groups.items():
        t = data["total"] or 1
        for k in _LEVELS:
            data[f"{k}_pct"] = round(data.get(k, 0) / t * 100, 1)
    return groups


@app.patch("/predictions/jobs/{job_id}")
def prediction_job_patch(job_id: str, updates: dict):
    """Hot-patch fields on a running prediction job (e.g. poll_groups)."""
    from .predictor import patch_pred_job
    job = patch_pred_job(job_id, updates)
    if not job:
        raise HTTPException(404, "Prediction job not found")
    return {"ok": True, "patched_keys": list(updates.keys())}


@app.post("/predictions/stop/{job_id}")
async def prediction_job_stop(job_id: str):
    """Stop a running prediction job."""
    from .predictor import stop_pred_job
    ok = stop_pred_job(job_id)
    if not ok:
        raise HTTPException(404, "Prediction job not found")
    return {"status": "stopping", "job_id": job_id}


@app.post("/predictions/pause/{job_id}")
async def prediction_job_pause(job_id: str):
    """Pause a running prediction job."""
    from .predictor import pause_pred_job
    ok = pause_pred_job(job_id)
    if not ok:
        raise HTTPException(404, "Prediction job not found")
    return {"status": "pausing", "job_id": job_id}


@app.post("/predictions/resume/{job_id}")
async def prediction_job_resume(job_id: str):
    """Resume a paused prediction job."""
    from .predictor import resume_pred_job
    ok = resume_pred_job(job_id)
    if not ok:
        raise HTTPException(404, "Prediction job not found")
    return {"status": "resuming", "job_id": job_id}


@app.get("/predictions/checkpoints")
def pred_list_checkpoints():
    """List all persisted paused prediction jobs (survives restarts)."""
    from .predictor import list_pred_checkpoints
    return {"checkpoints": list_pred_checkpoints()}


@app.post("/predictions/analyze")
async def pred_analyze(request: Request):
    """Use LLM to generate deep analysis of prediction results."""
    from .evolver import _call_llm
    body = await request.json()
    results_summary = body.get("results_summary", "")
    question = body.get("question", "")

    prompt = f"""You are a senior US election analyst with deep experience in polling, voter behavior, and campaign strategy.

Below is the full dataset of a "synthetic voter simulation." Calibrated AI voter agents read real news each day, updated their mindset, and finally cast a vote. The data is rich — read every section carefully before analyzing.

[Prediction Question]
{question}

[Full Simulation Dataset]
{results_summary}

Produce a **deep, thorough** election analysis report. Required sections:

## 📊 Overall Conclusion
— Final weighted ranking; is the leading margin decisive, narrow, or within noise?
— Back every claim with specific percentages.

## 🏆 Weighted-Score Interpretation
— How did each poll group's weight affect the final ranking?
— What does the difference between party-member groups (if filtered) and general-voter groups reveal?
— Is the Undecided rate unusually high? What drove it (primary contest? anxiety?)?

## 📈 Daily Trend Deep-Read
— Candidate support trajectory from Day 1 to final day.
— Which days show clear turning points, and which news events plausibly caused them?
— How did satisfaction and anxiety shifts translate into support changes?

## 📰 News-Sentiment Impact Analysis
— Which news items hit which candidate hardest (positive/negative)?
— How does cumulative news sentiment differ between candidates, and does it match vote share?
— Any "bad news that still raised awareness" effect?

## 🏛️ Voter Segment Analysis
— Voting preferences across political leanings (Solid Dem / Lean Dem / Tossup / Lean Rep / Solid Rep).
— Which voter groups are the pivotal swing bloc?
— Any leaning shifts observed (e.g. Lean Rep → Tossup), and their political meaning.

## 🔮 Risks & Uncertainty
— Simulation limits and potential biases (sample size, sim-day count, negativity bias).
— External shocks that could flip the result.
— Predicted final destination of Undecided voters.

## 💡 Strategic Recommendations
— Concrete, actionable campaign recommendations per candidate.
— Each candidate's biggest strength and biggest weakness, grounded in the data.

Write the entire report **in English**, using Markdown formatting, citing specific data points. Target length: 1500-2500 words."""

    # Call system LLM for free-form text analysis
    try:
        from openai import AsyncOpenAI
        from shared.global_settings import get_system_llm_credentials
        creds = get_system_llm_credentials()
        client = AsyncOpenAI(
            api_key=creds.get("api_key", ""),
            base_url=creds.get("base_url") or None,
            timeout=120.0,
        )
        model = creds.get("model", "gpt-4o-mini")
        resp = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "You are a senior US election analyst. Answer in English. Use Markdown formatting."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.7,
            max_completion_tokens=4096,
        )
        analysis_text = resp.choices[0].message.content or ""
    except Exception as e:
        analysis_text = f"Analysis generation failed: {str(e)}"

    return {"analysis": analysis_text}

@app.post("/predictions/resume-checkpoint/{job_id}")
async def pred_resume_checkpoint(job_id: str):
    """Resume a paused prediction from its disk checkpoint (cross-restart resume)."""
    from .predictor import resume_pred_from_checkpoint, get_pred_checkpoint
    from shared.llm_vendors import get_available_vendors
    checkpoint = get_pred_checkpoint(job_id)
    if not checkpoint:
        raise HTTPException(404, "Checkpoint not found")
    enabled_vendors = checkpoint.get("job", {}).get("enabled_vendors")
    concurrency = len(enabled_vendors) if enabled_vendors else len(get_available_vendors())
    try:
        result = await resume_pred_from_checkpoint(job_id, concurrency=concurrency)
        return result
    except FileNotFoundError:
        raise HTTPException(404, "Checkpoint not found")


# ── Rolling Prediction (Primary Election Mode) ─────────────────────


class RollingInitRequest(BaseModel):
    prediction_id: str
    agents: list[dict]
    tracked_ids: list[str] | None = None


class RollingAdvanceRequest(BaseModel):
    prediction_id: str
    daily_news: str  # News text to inject for the new day
    agents: list[dict]


@app.post("/predictions/{pred_id}/rolling/init")
async def rolling_init(pred_id: str, req: RollingInitRequest):
    """Initialize rolling prediction: bridge evolution + Day 0 baseline (runs in background)."""
    import asyncio
    from .predictor import init_rolling_prediction, get_prediction
    pred = get_prediction(req.prediction_id)
    if not pred:
        raise HTTPException(404, "Prediction not found")
    # Start as background task — returns job stub immediately
    job_stub = await init_rolling_prediction(req.prediction_id, req.agents, req.tracked_ids, start_background=True)
    return job_stub


@app.post("/predictions/{pred_id}/rolling/advance")
async def rolling_advance(pred_id: str, req: RollingAdvanceRequest):
    """Advance one day in rolling prediction: inject daily news → run simulation."""
    from .predictor import advance_rolling_day
    try:
        result = await advance_rolling_day(req.prediction_id, req.daily_news, req.agents)
        return result
    except FileNotFoundError:
        raise HTTPException(404, "Prediction not found")


@app.get("/predictions/{pred_id}/rolling/history")
def rolling_history(pred_id: str):
    """Get rolling prediction timeline data."""
    from .predictor import get_rolling_history
    result = get_rolling_history(pred_id)
    if not result:
        raise HTTPException(404, "Prediction not found")
    return result


# ── Wikipedia Candidate Profile Generation ──────────────────────────

class CandidateProfileRequest(BaseModel):
    name: str  # candidate name to search, e.g. "盧秀燕"
    party: str = ""  # optional party context


@app.post("/candidate-profile")
async def candidate_profile(req: CandidateProfileRequest):
    """Fetch Wikipedia content for a candidate and use LLM to generate a political profile."""
    import httpx
    import os

    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Candidate name is required")

    # 1. Search Wikipedia for the candidate — locale auto-detected from name
    wiki_text = ""
    wiki_title = ""
    search_url = _wiki_host_for(name)
    _is_cjk_wiki = "zh.wikipedia" in search_url
    try:
        async with httpx.AsyncClient(
            timeout=600.0,
            follow_redirects=True,
            headers={"User-Agent": "CivatasBot/1.0 (https://civatas.app; civatas@example.com)"},
        ) as client:
            # Step A: Direct title lookup
            extract_params = {
                "action": "query",
                "format": "json",
                "titles": name,
                "prop": "extracts",
                "exintro": False,
                "explaintext": True,
                "exsectionformat": "plain",
                "redirects": 1,
            }
            if _is_cjk_wiki:
                extract_params["variant"] = "zh-tw"
                extract_params["uselang"] = "zh-tw"
            resp = await client.get(search_url, params=extract_params)
            data = resp.json()
            logger.info(f"Wiki direct lookup for '{name}': pages={list(data.get('query', {}).get('pages', {}).keys())}")
            pages = data.get("query", {}).get("pages", {})
            for page_id, page in pages.items():
                if page_id != "-1":
                    wiki_text = page.get("extract", "")[:6000]
                    wiki_title = page.get("title", name)
                    break

            # Step B: Full-text search fallback
            if not wiki_text:
                search_params = {
                    "action": "query",
                    "format": "json",
                    "list": "search",
                    "srsearch": name,
                    "srlimit": 5,
                    "srprop": "",
                }
                if _is_cjk_wiki:
                    search_params["variant"] = "zh-tw"
                resp2 = await client.get(search_url, params=search_params)
                search_data = resp2.json()
                search_results = search_data.get("query", {}).get("search", [])
                logger.info(f"Wiki search for '{name}': found {len(search_results)} results: {[r.get('title') for r in search_results[:3]]}")

                for sr in search_results:
                    sr_title = sr.get("title", "")
                    if not sr_title:
                        continue
                    # Relevance check: search result must share at least one character with the query name
                    # Relevance check: any shared character/word with the query
                    if _is_cjk_wiki:
                        if not any(ch in sr_title for ch in name):
                            continue
                    else:
                        nlow = name.lower()
                        tlow = sr_title.lower()
                        if not any(part in tlow for part in nlow.split() if part):
                            continue
                    extract_params["titles"] = sr_title
                    resp3 = await client.get(search_url, params=extract_params)
                    data3 = resp3.json()
                    pages3 = data3.get("query", {}).get("pages", {})
                    for page_id, page in pages3.items():
                        if page_id != "-1":
                            extract = page.get("extract", "")
                            if len(extract) > 100:  # Skip stubs
                                wiki_text = extract[:6000]
                                wiki_title = sr_title
                                break
                    if wiki_text:
                        break
    except Exception as e:
        logger.warning(f"Wikipedia fetch failed for '{name}': {e}")

    if not wiki_text:
        raise HTTPException(404, f"Wikipedia page not found for '{name}'")

    _wiki_is_stub = len(wiki_text) < 200  # Very short article — LLM may give unreliable numbers

    # 2. Use System LLM to generate a structured political profile
    from openai import AsyncOpenAI
    from shared.global_settings import get_system_llm_credentials
    creds = get_system_llm_credentials()
    api_key = creds.get("api_key") or os.getenv("LLM_API_KEY", "") or os.getenv("OPENAI_API_KEY", "")
    model = creds.get("model") or os.getenv("LLM_MODEL", "gpt-4o-mini")
    base_url = creds.get("base_url") or os.getenv("LLM_BASE_URL") or None
    if not api_key:
        raise HTTPException(500, "No LLM API key configured. Set a System LLM in Settings.")
    llm_client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    party_ctx = f" (party: {req.party})" if req.party else ""
    prompt = f"""Based on the following Wikipedia content, produce a structured political profile for "{name}"{party_ctx}.

Reply in JSON with these fields:
{{
  "party": "Full party name (e.g. Democratic Party, Republican Party, Independent, Libertarian Party, Green Party)",
  "description": "200–350 word profile. Must include: party affiliation; current and prior offices held; education; core policy positions or area of expertise; personal style (e.g. populist, technocratic, moderate, hardline, grassroots organizer); electoral strengths and weaknesses.",
  "origin_districts": "The candidate's primary base of support at the sub-state level — comma-separated counties, congressional districts, or metro areas. Example: 'Wayne County, Oakland County, Macomb County' or 'CA-12, San Francisco'. Leave empty string for purely statewide / national figures.",
  "local_visibility": 0–100 integer, name recognition within their home state / district. Sitting / former governor or big-city mayor = 90–95, sitting US House member or state-level office = 60–75, state legislator / county exec = 40–60, newcomer = 10–30,
  "national_visibility": 0–100 integer, name recognition nationwide. President / former President / VP = 95+, presidential candidates / Senate leadership / cabinet secretary / national party chair = 75–90, governors of large states / prominent senators = 60–80, rank-and-file US Representatives = 20–40, state-level officials / newcomers = 5–20
}}

JSON only — no extra text.

Wikipedia content:
{wiki_text}"""

    try:
        kwargs = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a US political analyst. Write concise, factual candidate profiles based on the supplied Wikipedia content."},
                {"role": "user", "content": prompt},
            ],
        }
        if any(m in model.lower() for m in ["o1", "o3", "gpt-5"]):
            kwargs["max_completion_tokens"] = 4096
            kwargs["temperature"] = 1.0
        else:
            kwargs["max_tokens"] = 1024
            kwargs["temperature"] = 0.3

        resp = await llm_client.chat.completions.create(**kwargs)
        raw_content = resp.choices[0].message.content.strip()
    except Exception as e:
        logger.error(f"LLM profile generation failed for '{name}': {e}")
        raise HTTPException(500, f"LLM generation failed: {str(e)}")

    # Parse structured JSON response
    import json as _json
    description = raw_content
    origin_districts = ""
    local_visibility = 50
    national_visibility = 50
    try:
        # Strip markdown code fences if present
        _text = raw_content
        if _text.startswith("```"):
            _text = _text.split("\n", 1)[1] if "\n" in _text else _text[3:]
        if _text.endswith("```"):
            _text = _text[:-3]
        _text = _text.strip()
        parsed = _json.loads(_text)
        description = parsed.get("description", raw_content)
        party_result = parsed.get("party", "")
        origin_districts = parsed.get("origin_districts", "")
        local_visibility = int(parsed.get("local_visibility", 0))
        national_visibility = int(parsed.get("national_visibility", 0))
    except (_json.JSONDecodeError, ValueError):
        logger.warning(f"Wiki profile for '{name}' returned non-JSON, using raw text as description")
        party_result = ""

    # If wiki is a stub and LLM returned 0, mark as unreliable (null)
    _local_vis_out = max(0, min(100, local_visibility)) if local_visibility > 0 else None
    _national_vis_out = max(0, min(100, national_visibility)) if national_visibility > 0 else None
    if _wiki_is_stub:
        logger.info(f"Wiki stub for '{name}' ({len(wiki_text)} chars), visibility may be unreliable: local={local_visibility} national={national_visibility}")

    return {
        "name": name,
        "party": party_result or req.party or "",
        "description": description,
        "origin_districts": origin_districts,
        "local_visibility": _local_vis_out,
        "national_visibility": _national_vis_out,
        "wiki_source": (("https://zh.wikipedia.org/wiki/" if _is_cjk_wiki else "https://en.wikipedia.org/wiki/") + (wiki_title or name).replace(" ", "_")),
        "wiki_length": len(wiki_text),
    }



# ── Auto Candidate Traits (Wikipedia + LLM) ─────────────────────────────

class AutoTraitsRequest(BaseModel):
    candidates: list[dict]  # [{name, description, party}]


def _wiki_host_for(name: str) -> str:
    """Pick Wikipedia locale by name script. Non-CJK names → en.wikipedia."""
    has_cjk = any('\u4e00' <= ch <= '\u9fff' for ch in name or "")
    return "https://zh.wikipedia.org/w/api.php" if has_cjk else "https://en.wikipedia.org/w/api.php"


async def _wiki_fetch_text(name: str) -> tuple[str, str]:
    """Return (wiki_text, wiki_title) for a candidate name via Wikipedia API.
    English host for ASCII/Latin names, Chinese host for CJK names — so US
    candidates get the authoritative English article rather than a thin zh
    translation (which also biases the downstream LLM toward Chinese).
    """
    import httpx
    search_url = _wiki_host_for(name)
    is_cjk = "zh.wikipedia" in search_url
    extract_params = {
        "action": "query", "format": "json", "titles": name,
        "prop": "extracts", "exintro": False, "explaintext": True,
        "exsectionformat": "plain", "redirects": 1,
    }
    if is_cjk:
        extract_params.update({"variant": "zh-tw", "uselang": "zh-tw"})
    try:
        async with httpx.AsyncClient(
            timeout=25.0, follow_redirects=True,
            headers={"User-Agent": "CivatasBot/1.0 (https://civatas.app)"},
        ) as client:
            resp = await client.get(search_url, params=extract_params)
            pages = resp.json().get("query", {}).get("pages", {})
            for pid, page in pages.items():
                if pid != "-1":
                    text = page.get("extract", "")[:6000]
                    if text:
                        return text, page.get("title", name)
            # Fallback: full-text search
            search_params = {"action": "query", "format": "json", "list": "search",
                             "srsearch": name, "srlimit": 5, "srprop": ""}
            if is_cjk:
                search_params["variant"] = "zh-tw"
            resp2 = await client.get(search_url, params=search_params)
            for sr in resp2.json().get("query", {}).get("search", []):
                title = sr.get("title", "")
                if not title:
                    continue
                extract_params["titles"] = title
                resp3 = await client.get(search_url, params=extract_params)
                for pid3, page3 in resp3.json().get("query", {}).get("pages", {}).items():
                    if pid3 != "-1":
                        extract = page3.get("extract", "")
                        if len(extract) > 100:
                            return extract[:6000], title
    except Exception as e:
        logger.warning(f"[auto-traits] Wiki fetch failed for '{name}': {e}")
    return "", ""


@app.post("/auto-traits")
async def auto_traits(req: AutoTraitsRequest):
    """Use Wikipedia + LLM to compute 5 candidate trait dimensions with reasoning."""
    import asyncio
    import os
    import json as _json
    from openai import AsyncOpenAI
    from shared.global_settings import get_system_llm_credentials

    if not req.candidates:
        raise HTTPException(400, "candidates list is required")

    # Prefer System LLM credentials (configured in Settings / Onboarding);
    # fall back to env vars if the user hasn't set up a System LLM yet.
    creds = get_system_llm_credentials()
    api_key = creds.get("api_key") or os.getenv("LLM_API_KEY", "") or os.getenv("OPENAI_API_KEY", "")
    model = creds.get("model") or os.getenv("LLM_MODEL", "gpt-4o-mini")
    base_url = creds.get("base_url") or os.getenv("LLM_BASE_URL") or None
    if not api_key:
        raise HTTPException(500, "No LLM API key configured. Set a System LLM in Settings or LLM_API_KEY in .env")
    llm_client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    async def compute_one(cand: dict) -> dict:
        name = (cand.get("name") or "").strip()
        description = (cand.get("description") or "").strip()
        party = (cand.get("party") or "").strip()
        if not name:
            return {"name": name, "error": "empty name", "traits": {}, "reasoning": {}, "wiki_found": False}

        # 1. Wikipedia lookup
        wiki_text, _ = await _wiki_fetch_text(name)
        wiki_found = bool(wiki_text)

        # 2. Build context
        context_parts = []
        if wiki_text:
            context_parts.append(f"Wikipedia article:\n{wiki_text[:4000]}")
        if description:
            context_parts.append(f"Candidate description:\n{description[:800]}")
        if not context_parts:
            context_parts.append(f"Candidate name: {name}" + (f", party: {party}" if party else ""))
        context = "\n\n".join(context_parts)

        party_ctx = f" (party: {party})" if party else ""
        prompt = f"""You are a US political analyst. Score the candidate "{name}"{party_ctx} on five trait dimensions used in a voter psychology model. Each score is an integer in 0–80.

## Dimensions
1. **loc (local)** — exposure & influence on state / local issues (state policy, schools, infrastructure, public safety, county/city services). Sitting governor / mayor / state legislator deeply rooted in their state = high (50–75). Pure federal-only figure = low (10–30).
2. **nat (national)** — exposure & influence on federal issues (federal policy, foreign policy, federal economy, congressional leadership). President / Speaker / Senate leader / cabinet secretary = high (50–75). Pure local figure = low (10–25).
3. **anx (anxiety)** — connection to negative / scandal news cycles. Major scandals or persistent controversy = high (40–65). Clean reputation / political newcomer = low (5–20).
4. **charm** — personal charisma, likability, popular appeal. Strong social-media following / retail-politics natural = high (50–70). Wonk / hardliner = low (20–40).
5. **cross (cross-party)** — ability to attract voters from the other party / independents. Moderates, swing-state Dems/Reps, well-known Independents = high (40–65). Hardline base-only figures (far-right MAGA hardliner / progressive-only Dem) = low (10–25).

Reply in JSON only:
{{"loc": int, "loc_reason": "<15 words", "nat": int, "nat_reason": "<15 words", "anx": int, "anx_reason": "<15 words", "charm": int, "charm_reason": "<15 words", "cross": int, "cross_reason": "<15 words"}}

JSON only — no extra text.

---
{context}"""

        try:
            kwargs: dict = {
                "model": model,
                "messages": [
                    {"role": "system", "content": "You are a US political analyst specializing in voter behavior and candidate trait assessment."},
                    {"role": "user", "content": prompt},
                ],
            }
            if any(m in model.lower() for m in ["o1", "o3", "gpt-5"]):
                kwargs["max_completion_tokens"] = 512
                kwargs["temperature"] = 1.0
            else:
                kwargs["max_tokens"] = 512
                kwargs["temperature"] = 0.3
            resp = await llm_client.chat.completions.create(**kwargs)
            raw = resp.choices[0].message.content.strip()
        except Exception as e:
            logger.error(f"[auto-traits] LLM failed for '{name}': {e}")
            return {
                "name": name, "wiki_found": wiki_found, "error": str(e),
                "traits": {"loc": 30, "nat": 20, "anx": 15, "charm": 35, "cross": 20},
                "reasoning": {},
            }

        # Parse JSON
        try:
            _t = raw
            if _t.startswith("```"):
                _t = _t.split("\n", 1)[1] if "\n" in _t else _t[3:]
            if _t.endswith("```"):
                _t = _t[:-3]
            parsed = _json.loads(_t.strip())

            def clamp(v: object, lo: int = 0, hi: int = 80) -> int:
                try:
                    return max(lo, min(hi, int(v)))  # type: ignore[arg-type]
                except Exception:
                    return (lo + hi) // 2

            return {
                "name": name,
                "wiki_found": wiki_found,
                "traits": {
                    "loc":   clamp(parsed.get("loc",   30)),
                    "nat":   clamp(parsed.get("nat",   20)),
                    "anx":   clamp(parsed.get("anx",   15)),
                    "charm": clamp(parsed.get("charm", 35)),
                    "cross": clamp(parsed.get("cross", 20)),
                },
                "reasoning": {
                    "loc":   str(parsed.get("loc_reason",   "")),
                    "nat":   str(parsed.get("nat_reason",   "")),
                    "anx":   str(parsed.get("anx_reason",   "")),
                    "charm": str(parsed.get("charm_reason", "")),
                    "cross": str(parsed.get("cross_reason", "")),
                },
            }
        except Exception as e:
            logger.warning(f"[auto-traits] JSON parse failed for '{name}': {e}")
            return {
                "name": name, "wiki_found": wiki_found,
                "traits": {"loc": 30, "nat": 20, "anx": 15, "charm": 35, "cross": 20},
                "reasoning": {},
            }

    results = await asyncio.gather(*[compute_one(c) for c in req.candidates])
    return {"results": list(results)}


# ── Election Database endpoints ────────────────────────────────────────

@app.get("/election-db/census-counties")
def election_db_census_counties(ad_year: int = 2020):
    from .election_db import list_census_counties
    return {"counties": list_census_counties(ad_year)}


@app.post("/election-db/build-config")
def election_db_build_config(payload: dict):
    """Build a ProjectConfig from census DB data."""
    county = payload.get("county", "")
    districts = payload.get("districts", None)
    ad_year = payload.get("ad_year", 2020)
    include_dims = payload.get("include_dims", None)
    if not county:
        raise HTTPException(400, "county is required")
    from .election_db import build_project_config
    config = build_project_config(county, districts, ad_year, include_dims)
    if not config:
        raise HTTPException(404, f"No census data found for {county} in {ad_year}")
    return config


@app.post("/election-db/apply-leaning-profile")
def election_db_apply_leaning(payload: dict):
    """Build a leaning profile from election DB and save it as the active profile."""
    election_type = payload.get("election_type", "")
    ad_year = payload.get("ad_year", 0)
    county = payload.get("county", "")
    if not election_type or not ad_year or not county:
        raise HTTPException(400, "election_type, ad_year, county are required")

    from .election_db import build_leaning_profile
    from .leaning_profile import save_profile

    result = build_leaning_profile(election_type, ad_year, county)
    if not result or not result.get("districts"):
        raise HTTPException(404, "No district-level vote data found for this election")

    # Save as active leaning profile (same format as upload)
    saved = save_profile(
        result["districts"],
        description=result.get("description", ""),
        data_sources=result.get("data_sources", []),
    )
    return {
        "status": "ok",
        "description": result["description"],
        "count": result["count"],
        "districts": result["districts"],
    }


@app.get("/election-db/health")
def election_db_health():
    from .election_db import check_db
    return check_db()


@app.get("/election-db/elections")
def election_db_list(election_type: str = None, scope: str = None, min_year: int = None, max_year: int = None):
    from .election_db import list_elections
    return {"elections": list_elections(election_type, scope, min_year, max_year)}


@app.get("/election-db/elections-by-county")
def election_db_by_county(county: str = ""):
    """List elections available for a specific county, with display names."""
    from .election_db import list_elections

    elections = list_elections()
    result = []
    type_display = {
        "president":            "US Presidential Election",
        "us_senator":           "US Senate Election",
        "us_representative":    "US House Election",
        "governor":             "Gubernatorial Election",
        "state_senator":        "State Senate Election",
        "state_representative": "State House Election",
        "mayor":                "Mayoral Election",
        "ballot_measure":       "Ballot Measure",
    }
    seen_keys: set[str] = set()
    nationwide_label = "United States"
    national_etypes = ("president", "us_senator", "us_representative")

    for e in elections:
        etype = e["election_type"]
        display = f"{e['ad_year']} {type_display.get(etype, etype)}"
        scope = e.get("scope", "")
        if county:
            if etype in national_etypes:
                # For national elections: keep county-specific or nationwide, dedupe per cycle.
                if scope not in (nationwide_label, county):
                    continue
                dedup_key = f"{etype}_{e['ad_year']}"
                if dedup_key in seen_keys:
                    continue
                seen_keys.add(dedup_key)
            else:
                if scope != county:
                    continue
        result.append({**e, "display_name": display})
    return {"elections": result}


@app.get("/election-db/ground-truth")
def election_db_ground_truth(election_type: str = "", ad_year: int = 0, county: str = ""):
    if not election_type or not ad_year or not county:
        raise HTTPException(400, "election_type, ad_year, county are required")
    from .election_db import build_ground_truth
    gt = build_ground_truth(election_type, ad_year, county)
    if not gt:
        raise HTTPException(404, "No ground truth found for this election")
    return gt


@app.get("/election-db/historical-trend")
def election_db_trend(county: str = "", election_type: str = "mayor", min_year: int = 2010):
    if not county:
        raise HTTPException(400, "county is required")
    from .election_db import get_historical_trend
    return {"trend": get_historical_trend(county, election_type, min_year)}


@app.get("/election-db/spectrum")
def election_db_spectrum(county: str = "", election_type: str = "president", ad_year: int = None):
    if not county:
        raise HTTPException(400, "county is required")
    from .election_db import get_spectrum_summary
    return get_spectrum_summary(county, election_type, ad_year)


# ── Fast Parameter Calibration ─────────────────────────────────────────

class FastCalibrateRequest(BaseModel):
    target_election: dict
    training_elections: list[dict]
    agents: list[dict]
    current_params: dict = {}
    candidate_info: list[dict] = []
    grid_resolution: int = 7
    max_rounds: int = 3


@app.post("/calibration/fast")
def fast_calibrate(req: FastCalibrateRequest):
    from .fast_calibrator import run_fast_calibration
    result = run_fast_calibration(
        target_election=req.target_election,
        training_elections=req.training_elections,
        agents=req.agents,
        current_params=req.current_params,
        candidate_info=req.candidate_info,
        grid_resolution=req.grid_resolution,
        max_rounds=req.max_rounds,
    )
    if "error" in result:
        raise HTTPException(400, result["error"])
    return result


# ── Recording endpoints ─────────────────────────────────────────────

class CreateRecordingRequest(BaseModel):
    title: str
    description: str = ""
    rec_type: str = "evolution"  # "evolution" | "prediction"
    source_job_id: str = ""
    project_name: str = ""


class UpdateRecordingRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    is_public: bool | None = None
    project_name: str | None = None


@app.post("/recordings")
def recording_create(req: CreateRecordingRequest):
    from .recorder import create_recording
    return create_recording(req.title, req.description, req.rec_type, req.source_job_id, req.project_name)


@app.get("/recordings")
def recording_list(public_only: bool = False):
    from .recorder import list_recordings
    return {"recordings": list_recordings(public_only)}


@app.get("/recordings/{rec_id}")
def recording_get(rec_id: str):
    from .recorder import get_recording
    rec = get_recording(rec_id)
    if not rec:
        raise HTTPException(404, "Recording not found")
    return rec


@app.put("/recordings/{rec_id}")
def recording_update(rec_id: str, req: UpdateRecordingRequest):
    from .recorder import update_recording
    updates = {k: v for k, v in req.dict().items() if v is not None}
    rec = update_recording(rec_id, updates)
    if not rec:
        raise HTTPException(404, "Recording not found")
    return rec


@app.delete("/recordings/{rec_id}")
def recording_delete(rec_id: str):
    from .recorder import delete_recording
    if not delete_recording(rec_id):
        raise HTTPException(404, "Recording not found")
    return {"deleted": rec_id}


@app.get("/recordings/{rec_id}/steps")
def recording_steps(rec_id: str):
    from .recorder import get_recording, get_all_steps
    rec = get_recording(rec_id)
    if not rec:
        raise HTTPException(404, "Recording not found")
    return {"steps": get_all_steps(rec_id)}


@app.get("/recordings/{rec_id}/steps/{step_num}")
def recording_step(rec_id: str, step_num: int):
    from .recorder import get_step
    step = get_step(rec_id, step_num)
    if not step:
        raise HTTPException(404, "Step not found")
    return step

