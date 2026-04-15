"""Prediction execution engine.

Runs multi-scenario predictions by:
  1. Restoring a snapshot (calibrated agent state)
  2. Injecting scenario-specific news
  3. Running evolution simulation
  4. Collecting results for each scenario
  5. Producing comparison report

Each scenario runs sequentially: restore → inject → evolve → collect.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid

logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
PREDICTIONS_DIR = os.path.join(DATA_DIR, "predictions")

# US-only English prompts and helpers (TW dual-path removed in Stage 1.9 cleanup).
try:
    from .prompts import VOTING_PROMPT_TEMPLATE as US_VOTING_PROMPT
    from .us_predictor_helpers import (
        get_leaning_for_candidate as us_get_leaning,
        detect_party as us_detect_party,
        is_incumbent_keyword as us_is_incumbent,
        is_admin_keyword as us_is_admin,
    )
except ImportError:
    from prompts import VOTING_PROMPT_TEMPLATE as US_VOTING_PROMPT  # type: ignore
    from us_predictor_helpers import (  # type: ignore
        get_leaning_for_candidate as us_get_leaning,
        detect_party as us_detect_party,
        is_incumbent_keyword as us_is_incumbent,
        is_admin_keyword as us_is_admin,
    )

# ── Prediction storage ───────────────────────────────────────────────

def _ensure_dir():
    os.makedirs(PREDICTIONS_DIR, exist_ok=True)


def save_prediction(
    question: str,
    snapshot_id: str,
    scenarios: list[dict],
    sim_days: int,
    concurrency: int,
    enable_kol: bool = False,
    kol_ratio: float = 0.05,
    kol_reach: float = 0.40,
    sampling_modality: str = "unweighted",
    poll_options: list[dict] = None,
    max_choices: int = 1,
    poll_groups: list[dict] = None,
    scoring_params: dict | None = None,
    macro_context: str | None = None,
    enabled_vendors: list[str] | None = None,
    use_calibration_result_leaning: bool = True,
    # Cycle-based dynamic news search
    search_interval: int = 0,
    local_keywords: str = "",
    national_keywords: str = "",
    county: str = "",
    start_date: str = "",
    end_date: str = "",
    prediction_mode: str = "election",
    enable_news_search: bool = True,
) -> dict:
    """Create a new prediction record."""
    _ensure_dir()
    pred_id = uuid.uuid4().hex[:8]
    # Backward compat: if poll_groups not provided, create one from poll_options
    effective_groups = poll_groups or []
    if not effective_groups and poll_options:
        effective_groups = [{"name": "default", "candidates": poll_options}]
    pred = {
        "prediction_id": pred_id,
        "question": question,
        "snapshot_id": snapshot_id,
        "scenarios": scenarios,  # [{id, name, news}]
        "sim_days": sim_days,
        "concurrency": concurrency,
        "enable_kol": enable_kol,
        "kol_ratio": kol_ratio,
        "kol_reach": kol_reach,
        "sampling_modality": sampling_modality,
        "poll_options": poll_options or [],
        "poll_groups": effective_groups,
        "max_choices": max_choices,
        "scoring_params": scoring_params or {},
        "macro_context": macro_context or "",
        "enabled_vendors": enabled_vendors,
        "use_calibration_result_leaning": use_calibration_result_leaning,
        "prediction_mode": prediction_mode,
        # Cycle-based dynamic news search
        "search_interval": search_interval,
        "local_keywords": local_keywords,
        "national_keywords": national_keywords,
        "county": county,
        "start_date": start_date,
        "end_date": end_date,
        "enable_news_search": enable_news_search,
        "status": "pending",
        "results": None,
        "created_at": time.time(),
    }
    path = os.path.join(PREDICTIONS_DIR, f"{pred_id}.json")
    with open(path, "w") as f:
        json.dump(pred, f, ensure_ascii=False, indent=2)
    return pred


def list_predictions() -> list[dict]:
    """List all predictions (summary)."""
    _ensure_dir()
    results = []
    for fname in sorted(os.listdir(PREDICTIONS_DIR)):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(PREDICTIONS_DIR, fname)) as f:
                data = json.load(f)
            results.append({
                "prediction_id": data["prediction_id"],
                "question": data.get("question", ""),
                "snapshot_id": data.get("snapshot_id", ""),
                "status": data.get("status", "pending"),
                "scenario_count": len(data.get("scenarios", [])),
                "sim_days": data.get("sim_days", 0),
                "created_at": data.get("created_at"),
                "has_results": data.get("results") is not None,
            })
        except Exception:
            continue
    results.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return results


def get_prediction(pred_id: str) -> dict | None:
    """Get full prediction details including results."""
    path = os.path.join(PREDICTIONS_DIR, f"{pred_id}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)


def delete_prediction(pred_id: str) -> bool:
    """Delete a prediction."""
    path = os.path.join(PREDICTIONS_DIR, f"{pred_id}.json")
    if not os.path.isfile(path):
        return False
    os.remove(path)
    return True


# ── Prediction execution ─────────────────────────────────────────────


def _get_leaning_for_candidate(candidate_key: str) -> str:
    """Map a ground-truth candidate key to a political_leaning label.

    Example: 'Democratic — Jane Doe' → 'Lean Dem'
    """
    if us_get_leaning is not None:
        return us_get_leaning(candidate_key)
    return "Tossup"  # fallback if helper unavailable

# ── Candidate trait registry ──
# Empty by default. Traits should be provided via UI scoring_params override.
# If a candidate is not found here and no UI override is provided,
# hash-based defaults are generated in _candidate_sensitivity().
# Keys: loc (local issues sensitivity), nat (national issues), anx (anxiety),
#        charm (personal appeal), cross (cross-party appeal)
CANDIDATE_TRAITS: dict[str, dict[str, float]] = {}

def _candidate_sensitivity(cname: str, trait_override: dict | None = None) -> dict:
    """Look up candidate sensitivity from trait registry or override.
    Falls back to hash-based defaults for unknown candidates."""
    # Check UI override first
    if trait_override and cname in trait_override:
        t = trait_override[cname]
        return {
            "loc": float(t.get("loc", 0.3)), "nat": float(t.get("nat", 0.2)),
            "anx": float(t.get("anx", 0.15)),
            "charm": float(t.get("charm", 0.35)), "cross": float(t.get("cross", 0.20)),
        }
    # Check built-in registry (partial name match)
    for key, traits in CANDIDATE_TRAITS.items():
        if key in cname:
            return dict(traits)
    # Fallback: hash-based for unknown candidates
    import hashlib
    h = hashlib.md5(cname.encode()).digest()
    loc_w = 0.2 + (h[0] % 30) / 100.0
    nat_w = 0.1 + (h[1] % 20) / 100.0
    anx_w = 0.1 + (h[2] % 15) / 100.0
    return {"loc": loc_w, "nat": nat_w, "anx": anx_w, "charm": 0.35, "cross": 0.20}

def _calculate_heuristic_score(
    cname: str, desc: str, leaning: str,
    ag_local_sat: float, ag_nat_sat: float, anx: float,
    news_impact: float, party_align_bonus: float,
    party_base_override: dict | None = None,
    incumbency_bonus: float = 12,
    party_divergence_mult: float = 0.5,
    candidate_traits: dict | None = None,
    # ── New tunable params for candidate differentiation ──
    profile_match_mult: float = 3.0,
    keyword_bonus_cap: float = 10.0,
    anxiety_sensitivity_mult: float = 0.15,
    same_party_in_group: bool = False,
    # ── Charm & cross-party appeal (新增) ──
    charm_mult: float = 8.0,
    cross_appeal_mult: float = 0.6,
    # ── Visibility & origin district (新增) ──
    awareness: float = 1.0,           # 0.0~1.0, derived from visibility
    sentiment: float = 0.0,           # -1.0~+1.0 from news sentiment tracking
    sentiment_mult: float = 0.15,     # UI-tunable multiplier
    hometown_match: bool = False,     # agent district matches candidate origin
    hometown_bonus: float = 8.0,      # bonus when hometown matches
) -> float:
    import re as _re_pred
    _major_kw = ["國民黨", "民進黨", "民主進步黨", "中國國民黨"]
    _minor_kw = ["民眾黨", "台灣民眾黨", "臺灣民眾黨", "時代力量", "台灣基進"]
    _indep_kw = ["無黨", "無所屬", "無黨籍", "未經政黨推薦"]

    # Use per-candidate base score if provided by UI, otherwise fall back to party defaults
    if party_base_override and cname in party_base_override:
        score = float(party_base_override[cname])
    else:
        score = 30.0
        if any(k in desc for k in _major_kw): score = 50.0
        elif any(k in desc for k in _minor_kw): score = 30.0
        elif any(k in desc for k in _indep_kw): score = 5.0

    _cpn = _re_pred.search(r'[（(](.+?)[）)]', cname)
    _cand_party = _cpn.group(1) if _cpn else ""
    _psrc = _cand_party or desc

    is_kmt = any(k in _psrc for k in ["國民黨", "中國國民黨"])
    is_dpp = any(k in _psrc for k in ["民進黨", "民主進步黨"])
    is_tpp = any(k in _psrc for k in ["民眾黨", "台灣民眾黨", "臺灣民眾黨"])

    # Party alignment: skip when all candidates in the group share the same party
    # (in a same-party primary, party loyalty doesn't differentiate)
    _effective_align = 0 if same_party_in_group else party_align_bonus
    if is_kmt and any(x in leaning for x in ["統", "藍", "右"]):
        score += _effective_align
    if is_dpp and any(x in leaning for x in ["本土", "綠", "左", "獨"]):
        score += _effective_align
    if is_tpp and any(x in leaning for x in ["白", "中間", "中立"]):
        score += _effective_align * 0.6
    if not same_party_in_group and (is_kmt or is_dpp) and "中立" in leaning:
        score += 3

    # Party loyalty floor: in cross-party races, penalise voting against own party.
    # This prevents >50 % of a party's base from defecting, which is unrealistic
    # in Taiwan's strong party-ID environment.
    # cross_appeal trait SOFTENS this penalty: high cross (e.g. 江啟臣 0.65) → less drag
    # on opposite-leaning voters, modelling his ability to attract 18% light-green voters.
    if not same_party_in_group:
        _is_opposite = False
        if is_kmt and any(x in leaning for x in ["本土", "綠", "左", "獨"]):
            _is_opposite = True
        elif is_dpp and any(x in leaning for x in ["統", "藍", "右"]):
            _is_opposite = True
        if _is_opposite:
            _cross_sens = _candidate_sensitivity(cname, candidate_traits).get("cross", 0.20)
            # Base drag = 25%, softened by cross appeal: e.g. cross=0.65 → drag=25%×(1-0.65×0.6)=15.3%
            _drag = 0.25 * (1 - _cross_sens * cross_appeal_mult)
            score *= (1 - max(0.05, _drag))  # at least 5% drag remains

    is_exec = bool(_re_pred.search(r'(現任|曾任)?[^，。,.\\n]{0,8}(市長|縣長|總統|院長|黨主席)', desc))
    is_admin = any(k in desc for k in ["副市長", "局長", "處長", "立委", "議員", "立法委員"])
    if is_exec: score += incumbency_bonus
    elif is_admin: score += max(2, incumbency_bonus * 0.2)

    # ── Direct candidate profile scoring ──
    # These bonuses differentiate candidates INDEPENDENT of satisfaction delta,
    # so even when satisfaction is near 50 the candidates still diverge.
    sens = _candidate_sensitivity(cname, candidate_traits)

    # 1a. Direct profile clarity bonus: candidates with a strong specialty
    #     get a flat bonus regardless of agent state. This ensures differentiation
    #     even when agent local_sat ≈ nat_sat.
    #     e.g. 楊瓊瓔 loc=0.60 → dominant_strength=0.50, bonus=0.50*6=3.0
    #     e.g. 江啟臣 nat=0.55 → dominant_strength=0.40, bonus=0.40*6=2.4
    _dominant = max(sens["loc"], sens["nat"], sens["anx"])
    _second = sorted([sens["loc"], sens["nat"], sens["anx"]])[-2]
    _dominant_strength = _dominant - _second  # how specialized this candidate is
    score += _dominant_strength * 6  # flat specialty bonus

    # 1b. Profile match: local-type vs national-type × agent satisfaction gap
    local_profile_bonus = sens["loc"] * 8
    national_profile_bonus = sens["nat"] * 8
    # Use both the raw sat difference AND a sign-based component so even small
    # differences (e.g. local_sat=52 vs nat_sat=48) produce meaningful effect
    _sat_diff = ag_local_sat - ag_nat_sat
    _sign_boost = (1.0 if _sat_diff > 0 else (-1.0 if _sat_diff < 0 else 0)) * 5  # ±5 base
    agent_local_pref = (_sat_diff + _sign_boost) / 50.0
    profile_match = agent_local_pref * (local_profile_bonus - national_profile_bonus)
    score += profile_match * profile_match_mult

    # 2. Anxiety sensitivity: high-anxiety voters favor crisis handlers
    if anx > 55:
        score += sens["anx"] * (anx - 50) * anxiety_sensitivity_mult

    # 3. Recognition / stature bonus from desc keywords
    _stature_kw = {"市長": 6, "縣長": 5, "院長": 5, "副院長": 4, "黨主席": 5,
                   "部長": 4, "全國知名度": 4, "接班人": 3, "中霸天": 3}
    stature_score = sum(v for k, v in _stature_kw.items() if k in desc)
    score += min(stature_score, keyword_bonus_cap)

    # 4. Grassroots / local-service bonus
    _grassroots_kw = {"地方實力": 4, "民意代表": 3, "服務處": 3, "樁腳": 3,
                      "里長": 2, "地方服務": 3, "基層": 3}
    grassroots_score = sum(v for k, v in _grassroots_kw.items() if k in desc)
    score += min(grassroots_score, keyword_bonus_cap)

    # 5. Charm / likability bonus (好感度/溫暖度)
    # Calibrated from 艾普羅民調: 江6.8/10, 何5.5/10, 楊5.3/10
    # charm_mult=8 → 江=0.80×8=6.4, 何=0.45×8=3.6, 楊=0.20×8=1.6 (差距 4.8 pts)
    # charm² weighting: high charm candidates get disproportionately more (模擬好感度的非線性效應)
    _charm = sens.get("charm", 0.35)
    score += (_charm ** 1.3) * charm_mult  # 0.80^1.3×8=6.0, 0.20^1.3×8=1.1 → gap widens

    # 6. Cross-party appeal bonus
    # 民調：江啟臣吸引18.2%淺綠+80%藍白；楊瓊瓔藍營僅45%、白營47.8%
    # cross appeal affects ALL voters (not just neutral) — high cross = broad tent
    _cross = sens.get("cross", 0.20)
    # Neutral/white voters: strong bonus
    if any(x in leaning for x in ["中立", "白", "中間", "Tossup"]):
        score += _cross * charm_mult * 0.8
    # Same-party voters: weak consolidation penalty for low cross
    # (楊瓊瓔 cross=0.05 → 藍營voters get -3.8 pts; 江 cross=0.75 → -1.0 pts)
    elif (is_kmt and any(x in leaning for x in ["統", "藍", "右"])) or \
         (is_dpp and any(x in leaning for x in ["本土", "綠", "左", "獨"])):
        # Low cross = can't even consolidate own base (楊瓊瓔 45% KMT problem)
        _consolidation_penalty = (0.5 - _cross) * 8 if _cross < 0.5 else 0
        score -= _consolidation_penalty

    # ── Satisfaction-driven delta (original mechanism, now supplementary) ──
    local_delta = (ag_local_sat - 50) * news_impact
    national_delta = (ag_nat_sat - 50) * news_impact
    # Anxiety delta uses sqrt scaling to prevent runaway divergence at extreme values.
    # e.g. anx=70→delta=√20*news≈8.9  anx=90→delta=√40*news≈12.6  (vs linear: 40 vs 80)
    import math
    _raw_anx_diff = anx - 50
    anx_delta = math.copysign(math.sqrt(abs(_raw_anx_diff)), _raw_anx_diff) * news_impact

    # Party-directional delta scaled by divergence multiplier
    if is_kmt:
        score += party_divergence_mult * (local_delta * sens["loc"] - national_delta * sens["nat"] + anx_delta * sens["anx"])
    elif is_dpp:
        score += party_divergence_mult * (-local_delta * sens["loc"] + national_delta * sens["nat"] - anx_delta * sens["anx"])
    else:
        score += party_divergence_mult * (anx_delta * sens["anx"])

    # 7. Awareness scaling: low-visibility candidates get score penalty
    # awareness=1.0 → no penalty; awareness=0.3 → score × 0.51
    score *= (0.3 + 0.7 * awareness) * (1.0 + sentiment * sentiment_mult)

    # 8. Hometown/origin district bonus: agent in candidate's turf
    if hometown_match:
        score += hometown_bonus

    return max(score, 1.0)


def _redistribute_leaning_by_ground_truth(
    agents: list[dict],
    snapshot_id: str,
    pred: dict | None = None,
) -> None:
    """Redistribute agents' `political_leaning` proportionally to match the
    ground-truth vote distribution stored in the calibration pack linked to this
    snapshot.  Modifies agent dicts **in-place**.

    Algorithm:
    1. Find calibration pack linked to the snapshot.
    2. Parse each candidate key → leaning group.
    3. Compute desired agent count per group from vote share.
    4. Shuffle agents and reassign leanings.
    """
    try:
        from .snapshot import get_snapshot
        from .calibrator import get_calibration_pack
        import random

        snap_meta = get_snapshot(snapshot_id)
        if not snap_meta:
            logger.warning(f"[leaning-redist] Snapshot not found: {snapshot_id}")
            return

        # ── Ground-truth resolution order ──
        # 1. Snapshot's calibration pack (classic calibration workflow)
        # 2. Snapshot's alignment_target (auto-snapshot from evolution may
        #    embed the template's declared ground truth here)
        # 3. None → snapshot already carries meaningful leanings from evolution,
        #    so silently keep them (not a warning; this is the default path
        #    for evolution-then-predict workflows in Civatas-USA)
        ground_truth: dict = {}

        pack_id = snap_meta.get("calibration_pack_id")
        if pack_id:
            pack = get_calibration_pack(pack_id)
            if pack:
                ground_truth = pack.get("ground_truth", {}) or {}
            else:
                logger.warning(f"[leaning-redist] Calibration pack not found: {pack_id}")

        if not ground_truth:
            # Try snapshot's alignment_target — auto-snapshots embed the
            # template's election ground truth here when available.
            at = snap_meta.get("alignment_target") or {}
            if isinstance(at, dict) and at.get("ground_truth"):
                ground_truth = at["ground_truth"]

        if not ground_truth:
            logger.info(
                "[leaning-redist] No calibration pack or alignment ground truth; "
                "keeping evolution-derived leanings as-is (expected for "
                "evolution-based predictions)."
            )
            return

        # Compute total vote to allow for percentage or fraction inputs
        def _extract_numeric(v):
            """Extract numeric value from ground_truth entry (may be float, str, or dict)."""
            if isinstance(v, dict):
                # Try common keys: percentage, votes, value, pct
                for key in ("percentage", "votes", "value", "pct", "vote_share"):
                    if key in v:
                        return float(v[key])
                # Fallback: first numeric value in the dict
                for val in v.values():
                    try:
                        return float(val)
                    except (TypeError, ValueError):
                        continue
                return 0.0
            return float(v) if v else 0.0

        total_votes = sum(_extract_numeric(v) for v in ground_truth.values())
        if total_votes <= 0:
            return

        # Assemble party lookup from multiple sources: pred.party_detection +
        # snapshot alignment_target.party_detection. Supports both formats:
        # {"D": ["harris", ...]} and {"Harris": "D"}.
        pd_sources = []
        if pred:
            pd_sources.append(pred.get("_party_detection") or pred.get("party_detection") or {})
        at = snap_meta.get("alignment_target") or {}
        if isinstance(at, dict):
            pd_sources.append(at.get("party_detection") or {})

        name_to_code: dict[str, str] = {}
        code_to_kws: dict[str, list[str]] = {"D": [], "R": [], "I": []}
        for pd in pd_sources:
            if not isinstance(pd, dict):
                continue
            for k, v in pd.items():
                if isinstance(v, list):
                    if k in code_to_kws:
                        code_to_kws[k].extend([str(x).lower() for x in v])
                    for name in v:
                        name_to_code[str(name).lower()] = k
                else:
                    name_to_code[str(k).lower()] = str(v)

        def _leaning_for(cand_key: str) -> str:
            key_l = (cand_key or "").lower()
            code = name_to_code.get(key_l)
            if not code:
                for c, kws in code_to_kws.items():
                    if any(k and k in key_l for k in kws):
                        code = c
                        break
            if code == "D":
                return "Lean Dem"
            if code == "R":
                return "Lean Rep"
            if code == "I":
                return "Tossup"
            return _get_leaning_for_candidate(cand_key)

        # Map leaning → desired proportion
        leaning_share: dict[str, float] = {}
        for cand, votes in ground_truth.items():
            ln = _leaning_for(cand)
            leaning_share[ln] = leaning_share.get(ln, 0.0) + _extract_numeric(votes) / total_votes

        n = len(agents)
        if n == 0:
            return

        # Build ordered list of leaning assignments
        assignment: list[str] = []
        remaining = n
        items = list(leaning_share.items())
        for i, (ln, share) in enumerate(items):
            if i == len(items) - 1:
                count = remaining  # give leftovers to last group
            else:
                count = round(share * n)
            assignment.extend([ln] * count)
            remaining -= count

        # Shuffle agents and assign leanings
        indices = list(range(n))
        random.shuffle(indices)
        for idx, agent_idx in enumerate(indices):
            new_leaning = assignment[min(idx, len(assignment) - 1)]
            agents[agent_idx]["political_leaning"] = new_leaning

        summary = {ln: assignment.count(ln) for ln in set(assignment)}
        logger.info(f"[leaning-redist] Redistributed {n} agents: {summary}")

    except Exception as e:
        logger.warning(f"[leaning-redist] Failed to redistribute leanings: {e}")


_pred_jobs: dict[str, dict] = {}
_pred_stops: dict[str, bool] = {}
_pred_pauses: dict[str, bool] = {}
_pred_cancel_events: dict[str, asyncio.Event] = {}

# ── Prediction checkpoint persistence (cross-restart resume) ─────────
PRED_JOBS_DIR = os.path.join(DATA_DIR, "pred_jobs")
_pred_checkpoint_pending: dict[str, bool] = {}
_pred_checkpoint_agents: dict[str, list] = {}
_pred_checkpoint_pred: dict[str, dict] = {}
_pred_checkpoint_day: dict[str, int] = {}
_pred_checkpoint_scenario: dict[str, int] = {}
_pred_checkpoint_pool: dict[str, list] = {}
_pred_checkpoint_daily_data: dict[str, list] = {}


def _ensure_pred_jobs_dir():
    os.makedirs(PRED_JOBS_DIR, exist_ok=True)


def _save_pred_checkpoint(job: dict, agents: list[dict], pred: dict,
                          current_day: int, current_scenario_idx: int,
                          current_pool: list[dict], daily_data: list[dict]):
    """Persist paused prediction job state to disk for cross-restart resume."""
    _ensure_pred_jobs_dir()
    checkpoint = {
        "job": {k: v for k, v in job.items() if k not in ("live_messages",)},
        "current_day": current_day,
        "current_scenario_idx": current_scenario_idx,
        "pred": pred,
        "agents": agents,
        "current_pool": current_pool,
        "daily_data": daily_data,
    }
    path = os.path.join(PRED_JOBS_DIR, f"{job['job_id']}.json")
    with open(path, "w") as f:
        json.dump(checkpoint, f, ensure_ascii=False, indent=2)
    logger.info(f"Prediction checkpoint saved for job {job['job_id']} at scenario {current_scenario_idx} day {current_day}")


def _delete_pred_checkpoint(job_id: str):
    path = os.path.join(PRED_JOBS_DIR, f"{job_id}.json")
    if os.path.isfile(path):
        os.remove(path)


def list_pred_checkpoints() -> list[dict]:
    """List all persisted paused prediction jobs."""
    if not os.path.isdir(PRED_JOBS_DIR):
        return []
    results = []
    for fname in sorted(os.listdir(PRED_JOBS_DIR), reverse=True):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(PRED_JOBS_DIR, fname)) as f:
                data = json.load(f)
            job = data.get("job", {})
            results.append({
                "job_id": job.get("job_id"),
                "prediction_id": job.get("prediction_id"),
                "question": job.get("question", ""),
                "current_day": data.get("current_day", 0),
                "sim_days": job.get("sim_days", 0),
                "current_scenario_idx": data.get("current_scenario_idx", 0),
                "total_scenarios": job.get("total_scenarios", 0),
                "agent_count": job.get("agent_count", 0),
                "started_at": job.get("started_at"),
                "enabled_vendors": job.get("enabled_vendors"),
            })
        except Exception:
            continue
    return results


def get_pred_checkpoint(job_id: str) -> dict | None:
    """Load a prediction checkpoint from disk."""
    path = os.path.join(PRED_JOBS_DIR, f"{job_id}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)


async def resume_pred_from_checkpoint(job_id: str, concurrency: int | None = None) -> dict:
    """Resume a previously paused prediction job from its disk checkpoint."""
    checkpoint = get_pred_checkpoint(job_id)
    if not checkpoint:
        raise FileNotFoundError(f"No prediction checkpoint found for job {job_id}")

    saved_job = checkpoint["job"]
    agents = checkpoint["agents"]
    pred = checkpoint["pred"]
    resume_day = checkpoint["current_day"]  # resume from this day (not yet completed)
    resume_scenario = checkpoint.get("current_scenario_idx", 0)
    saved_pool = checkpoint.get("current_pool", [])
    saved_daily = checkpoint.get("daily_data", [])

    # Restore job to memory
    saved_job["status"] = "pending"
    saved_job["live_messages"] = []
    saved_job["resumed_at"] = time.time()
    _pred_jobs[job_id] = saved_job
    _pred_pauses[job_id] = False
    _pred_stops[job_id] = False

    if concurrency is None:
        concurrency = len(saved_job.get("enabled_vendors") or []) or 4

    asyncio.create_task(_run_prediction_bg(
        saved_job, pred, agents,
        pred["sim_days"], concurrency,
        tracked_ids=set(saved_job.get("tracked_persona_ids", [])),
        start_day=resume_day,
        start_scenario=resume_scenario,
        initial_pool=saved_pool,
        initial_daily_data=saved_daily,
    ))
    logger.info(f"Resuming prediction job {job_id} from scenario {resume_scenario} day {resume_day}")
    return {"job_id": job_id, "status": "pending", "resumed_from_day": resume_day}


def stop_pred_job(job_id: str) -> bool:
    """Request a running prediction job to stop."""
    if job_id in _pred_jobs:
        _pred_stops[job_id] = True
        _pred_jobs[job_id]["status"] = "cancelled"
        _push_pred_live(_pred_jobs[job_id], "⚠️ Prediction stopped")
        if ev := _pred_cancel_events.get(job_id):
            ev.set()
        _delete_pred_checkpoint(job_id)  # remove checkpoint on stop
        return True
    return False


def pause_pred_job(job_id: str) -> bool:
    """Request a running prediction job to pause."""
    if job_id in _pred_jobs:
        _pred_pauses[job_id] = True
        _pred_checkpoint_pending[job_id] = True  # trigger checkpoint write
        if _pred_jobs[job_id]["status"] == "running":
            _pred_jobs[job_id]["status"] = "paused"
            _push_pred_live(_pred_jobs[job_id], "⏸️ Prediction paused")
        if ev := _pred_cancel_events.get(job_id):
            ev.set()
        return True
    return False


def list_pred_jobs() -> list[dict]:
    """Return a lightweight summary of all in-memory prediction jobs.
    Used by UI to find an active prediction without relying on sessionStorage
    (e.g. after a tab close/reload, the Dashboard can still surface a running
    job's live progress)."""
    out = []
    for jid, j in _pred_jobs.items():
        out.append({
            "job_id": jid,
            "prediction_id": j.get("prediction_id"),
            "status": j.get("status"),
            "phase": j.get("phase"),
            "current_scenario": j.get("current_scenario"),
            "total_scenarios": j.get("total_scenarios"),
            "current_day": j.get("current_day"),
            "sim_days": j.get("sim_days"),
            "agent_count": j.get("agent_count"),
            "agents_processed": j.get("agents_processed"),
            "workspace_id": j.get("workspace_id") or "",
            "started_at": j.get("started_at"),
            "recording_id": j.get("recording_id"),
            "live_messages": (j.get("live_messages") or [])[-8:],
        })
    return out


def resume_pred_job(job_id: str) -> bool:
    """Request a paused prediction job to resume."""
    if job_id in _pred_jobs:
        _pred_pauses[job_id] = False
        if _pred_jobs[job_id]["status"] == "paused":
            _pred_jobs[job_id]["status"] = "running"
            _push_pred_live(_pred_jobs[job_id], "▶️ Prediction resumed")
        return True
    return False


def get_pred_job(job_id: str) -> dict | None:
    return _pred_jobs.get(job_id)


def patch_pred_job(job_id: str, updates: dict) -> dict | None:
    """Hot-patch fields on a running prediction job (e.g. poll_groups)."""
    job = _pred_jobs.get(job_id)
    if not job:
        return None
    for k, v in updates.items():
        job[k] = v
    return job


async def run_prediction(
    pred_id: str,
    agents: list[dict],
    tracked_ids: list[str] | None = None,
    recording_id: str = "",
    workspace_id: str = "",
) -> dict:
    """Start a multi-scenario prediction as a background task.

    For each scenario:
      1. Restore the snapshot to get clean calibrated state
      2. Inject scenario news into the pool
      3. Run evolution for sim_days
      4. Collect final states and daily summaries
    """
    pred = get_prediction(pred_id)
    if not pred:
        raise FileNotFoundError(f"Prediction not found: {pred_id}")

    job_id = uuid.uuid4().hex[:8]

    # Build persona_list for frontend dropdown/filter
    persona_list = []
    for a in agents:
        traits = a.get("traits", [])
        # traits format: ['年齡', '性別', '行政區', '教育', '媒體習慣', '政治傾向']
        age = traits[0] if len(traits) > 0 else ""
        gender = traits[1] if len(traits) > 1 else ""
        district = traits[2] if len(traits) > 2 else ""
        leaning = a.get("political_leaning", "Tossup")
        category = f"{age} {gender}" if age and gender else leaning
        persona_list.append({
            "id": str(a.get("person_id", 0)),
            "name": a.get("name", f"Agent {a.get('person_id', 0)}"),
            "category": category,
            "political_leaning": leaning,
            "age": age,
            "gender": gender,
            "district": district,
            "media_habit": a.get("media_habit", ""),
            "user_char": a.get("user_char", "") or a.get("description", ""),
        })

    # Use user-provided tracked_ids if available, otherwise track none
    if tracked_ids:
        tracked_ids_set: set[str] = set(tracked_ids)
    else:
        tracked_ids_set = set()  # No detailed tracking unless user selects

    job = {
        "job_id": job_id,
        "prediction_id": pred_id,
        "question": pred["question"],
        "status": "pending",
        "current_scenario": 0,
        "total_scenarios": len(pred["scenarios"]),  # will be updated after dedup
        "agent_count": len(agents),
        "sim_days": pred["sim_days"],
        "enable_kol": pred.get("enable_kol", False),
        "kol_ratio": pred.get("kol_ratio", 0.05),
        "kol_reach": pred.get("kol_reach", 0.40),
        "sampling_modality": pred.get("sampling_modality", "unweighted"),
        "poll_options": pred.get("poll_options", []),
        "poll_groups": pred.get("poll_groups", []),
        "prediction_mode": pred.get("prediction_mode", "election"),
        "max_choices": pred.get("max_choices", 1),
        "scoring_params": pred.get("scoring_params", {}),
        "macro_context": pred.get("macro_context", ""),
        "enabled_vendors": pred.get("enabled_vendors"),
        "persona_list": persona_list,
        "tracked_persona_ids": list(tracked_ids_set),
        "started_at": time.time(),
        "completed_at": None,
        "error": None,
        "scenario_results": [],
        "live_messages": [],
        "recording_id": recording_id,
        "workspace_id": workspace_id,
    }
    _pred_jobs[job_id] = job

    asyncio.create_task(_run_prediction_bg(
        job, pred, agents,
        pred["sim_days"],
        pred["concurrency"],
        tracked_ids_set,
    ))
    return {"job_id": job_id, "status": "pending"}


async def _run_prediction_bg(
    job: dict,
    pred: dict,
    agents: list[dict],
    sim_days: int,
    concurrency: int,
    tracked_ids: set[str] | None = None,
    start_day: int = 1,
    start_scenario: int = 0,
    initial_pool: list[dict] | None = None,
    initial_daily_data: list[dict] | None = None,
):
    """Background: run each scenario sequentially. Supports resume from checkpoint."""
    from .snapshot import restore_snapshot
    from .evolver import evolve_one_day, _load_states
    from .news_pool import replace_pool

    try:
        job["status"] = "running"
        snapshot_id = pred["snapshot_id"]
        scenarios = pred["scenarios"]

        # Filter out empty and duplicate scenarios
        # When dynamic search is enabled (search_interval > 0), scenarios don't need
        # pre-written news text — real news will be fetched from the web.
        _has_dynamic_search = (pred.get("search_interval", 0) or 0) > 0 and pred.get("start_date")
        _has_structured_events = any(
            len(s.get("events", [])) > 0 and any(
                len(ev.get("news", [])) > 0 for ev in s.get("events", [])
            ) for s in scenarios
        )
        _is_satisfaction_snapshot = pred.get("prediction_mode") == "satisfaction"
        seen_news: set[str] = set()
        filtered_scenarios: list[tuple[int, dict]] = []
        for si, scenario in enumerate(scenarios):
            news_text = (scenario.get("news", "") or "").strip()
            if not news_text and not _has_dynamic_search and not _has_structured_events and not _is_satisfaction_snapshot:
                _push_pred_live(job, f"⏭️ Skipping scenario {scenario.get('name', f'Scenario {si+1}')} (no news content)")
                continue
            if news_text and news_text in seen_news:
                _push_pred_live(job, f"⏭️ Skipping scenario {scenario.get('name', f'Scenario {si+1}')} (same content as previous scenario)")
                continue
            if news_text:
                seen_news.add(news_text)
            filtered_scenarios.append((si, scenario))

        job["total_scenarios"] = len(filtered_scenarios)
        if not filtered_scenarios:
            job["status"] = "failed"
            job["error"] = "All scenarios are empty or duplicates — cannot run prediction."
            return

        for fsi, (si, scenario) in enumerate(filtered_scenarios):
            # Skip already-processed scenarios (checkpoint resume)
            if si < start_scenario:
                continue
            if _pred_stops.get(job["job_id"]):
                job["status"] = "cancelled"
                break

            scenario_id = scenario.get("id", str(si))
            scenario_name = scenario.get("name", f"Scenario {scenario_id}")
            news_text = scenario.get("news", "")

            _push_pred_live(job, f"🔄 Starting scenario {scenario_name} ({fsi+1}/{len(filtered_scenarios)})")
            job["current_scenario"] = fsi + 1

            # 1. Restore snapshot
            try:
                restore_snapshot(snapshot_id)
                _push_pred_live(job, f"📸 Snapshot restored: {snapshot_id}")
            except FileNotFoundError:
                job["status"] = "failed"
                job["error"] = f"Snapshot not found: {snapshot_id}"
                return

            # 1a. Clear calibration diaries & reset days_evolved so prediction starts from D1
            from .evolver import _load_states, _save_states, _save_diaries, _load_profiles, _save_profiles
            _save_diaries([])  # wipe calibration diary history
            _pred_states = _load_states()
            snap_agent_count = len(_pred_states)
            for _k in _pred_states:
                _pred_states[_k]["days_evolved"] = 0
                _pred_states[_k]["consecutive_extreme_days"] = 0  # prevent calibration carryover
            _save_states(_pred_states)
            # Clear old leaning shift logs from profiles (carried over from snapshot)
            _pred_profiles = _load_profiles()
            for _pk in _pred_profiles:
                _pred_profiles[_pk]["leaning_shift_logs"] = []
            _save_profiles(_pred_profiles)
            pred_agent_count = len(agents)
            _push_pred_live(job, f"🔄 Calibration history cleared, prediction starts from Day 1 (snapshot {snap_agent_count} agents, predicting {pred_agent_count} agents)")

            # 1b. Optionally redistribute agent leanings to match calibration result
            if pred.get("use_calibration_result_leaning", True):
                _redistribute_leaning_by_ground_truth(agents, snapshot_id, pred)
                # Sync redistributed leaning into agent_states.current_leaning, otherwise
                # evolver will re-read the stale snapshot value and overwrite our change
                # on day 1 (evolver.py writes agent["political_leaning"] = current_leaning).
                _pred_states_redist = _load_states()
                for _ag in agents:
                    _aid = str(_ag.get("person_id", ""))
                    if _aid and _aid in _pred_states_redist:
                        _new_ln = _ag.get("political_leaning")
                        if _new_ln:
                            _pred_states_redist[_aid]["current_leaning"] = _new_ln
                            _pred_states_redist[_aid]["leaning"] = _new_ln
                _save_states(_pred_states_redist)
                _push_pred_live(job, "🗳️ Initial political leaning distribution reset from election results")
            else:
                # Reset current_leaning in agent_states back to the original leaning
                # (calibration may have shifted leanings via dynamic_leaning; undo that)
                _reset_count = 0
                for _k in _pred_states:
                    _orig = _pred_states[_k].get("leaning", _pred_states[_k].get("current_leaning"))
                    if _orig and _pred_states[_k].get("current_leaning") != _orig:
                        _pred_states[_k]["current_leaning"] = _orig
                        _reset_count += 1
                if _reset_count:
                    _save_states(_pred_states)
                _push_pred_live(job, f"🔄 Preserving original leaning distribution (restored {_reset_count} agents' calibration drift)")

            # 2. Determine news mode: cycle-based dynamic search vs static.
            # If user disabled news_search, force off — predictions will run
            # with empty news pool (agents only react to existing snapshot state).
            _search_interval = pred.get("search_interval", 0)
            _enable_news = pred.get("enable_news_search", True)
            _use_cycle_mode = _enable_news and _search_interval > 0 and pred.get("start_date")
            if not _enable_news:
                _push_pred_live(job, "🚫 News search disabled — voting based purely on evolution snapshot state")

            # 3. Initialize common tracking structures
            daily_data = list(initial_daily_data) if (si == start_scenario and initial_daily_data) else []
            agent_timeline: dict[str, list[dict]] = {}
            if tracked_ids:
                for tid in tracked_ids:
                    agent_timeline[tid] = []

            agent_demographics_map: dict[str, dict] = {}
            for a in agents:
                aid = str(a.get("person_id", 0))
                agent_demographics_map[aid] = {
                    "leaning": a.get("political_leaning", "Tossup"),
                    "district": a.get("district", "Unknown"),
                    "gender": a.get("gender", "Unknown"),
                    "llm_vendor": a.get("llm_vendor", "Unknown"),
                }

            poll_opts = pred.get("poll_options", [])

            # Extract unique candidate names + profiles for news sentiment scoring
            _all_cand_names = list(dict.fromkeys(
                c.get("name") for g in pred.get("poll_groups", [])
                for c in g.get("candidates", []) if c.get("name")
            ))
            _cand_profiles: dict[str, str] = {}
            for g in pred.get("poll_groups", []):
                for c in g.get("candidates", []):
                    cn = c.get("name", "")
                    if cn and cn not in _cand_profiles:
                        desc = c.get("description", "")
                        _cand_profiles[cn] = desc[:150] if desc else ""

            if _use_cycle_mode:
                # ══════════════════════════════════════════════════════════
                # ── Cycle-based dynamic news search (same as historical) ─
                # ══════════════════════════════════════════════════════════
                from .news_intelligence import (
                    search_news_for_window, score_news_impact,
                    assign_news_to_days, search_district_news,
                    build_default_keywords, compute_cycle_news_window,
                )
                from datetime import datetime, timedelta

                interval = _search_interval
                county = pred.get("county", "") or "台灣"
                _cn_short = county.replace("市", "").replace("縣", "")

                # ── Three-layer keyword architecture (matches main.py) ──
                # Layer 1: user fixed
                fixed_local_kw = [l.strip() for l in (pred.get("local_keywords", "") or "").split("\n") if l.strip()]
                fixed_national_kw = [l.strip() for l in (pred.get("national_keywords", "") or "").split("\n") if l.strip()]
                # Layer 2: system default (single source of truth — same as evolution)
                sys_local_kw, sys_national_kw = build_default_keywords(county)
                # Layer 3: candidate-injected from poll_groups
                cand_local_kw: list[str] = []
                cand_national_kw: list[str] = []
                for cname in _all_cand_names:
                    cand_local_kw.append(f'"{cname}" {_cn_short}')
                    cand_national_kw.append(f'"{cname}" 政策 選舉')
                if _all_cand_names:
                    logger.info(f"[pred-cycle] Auto-injected {len(_all_cand_names)} candidates into search: {_all_cand_names}")

                # Helper: dedupe combined search list while preserving layer order
                def _combine_kws_pred(*layers: list[str]) -> list[str]:
                    seen = set()
                    result = []
                    for layer in layers:
                        for k in layer:
                            if k and k not in seen:
                                seen.add(k)
                                result.append(k)
                    return result

                base_date = datetime.strptime(pred["start_date"], "%Y-%m-%d")

                seen_article_ids: set[str] = set()
                current_pool_pred: list[dict] = []
                num_cycles = (sim_days + interval - 1) // interval
                global_day = 0
                sp = pred.get("scoring_params", {}) or {}

                # Also build scenario-specific news from scenario.news text (hypothetical)
                scenario_extra_pool = _build_scenario_pool(news_text) if news_text.strip() else []

                # ── Time compression report (prediction) ──
                _pred_news_start, _pred_news_end, _pred_ratio = compute_cycle_news_window(
                    pred["start_date"], pred.get("end_date") or "", sim_days, 0, sim_days, buffer_sim_days=0,
                )
                _push_pred_live(job, f"🔄 Dynamic search: 1 cycle per {interval} sim days, {num_cycles} cycles total")
                if _pred_ratio > 1.05:
                    _push_pred_live(
                        job,
                        f"⏱️ Time compression: {_pred_news_start}~{_pred_news_end} ({(_pred_ratio*sim_days):.0f} real days) "
                        f"→ {sim_days} sim days (compression {_pred_ratio:.1f}×)"
                    )

                for cycle_idx in range(num_cycles):
                    if _pred_stops.get(job["job_id"]):
                        job["status"] = "cancelled"
                        _push_pred_live(job, "⚠️ Prediction interrupted")
                        break

                    cycle_start_day = cycle_idx * interval
                    cycle_days = min(interval, sim_days - cycle_start_day)

                    # ── Compute compressed real-news window for this cycle ──
                    pred_news_start, pred_news_end, _ = compute_cycle_news_window(
                        pred["start_date"], pred.get("end_date") or "", sim_days,
                        cycle_start_day, cycle_days, buffer_sim_days=0.5,
                    )

                    # ── Search news ──
                    job["phase"] = "searching"
                    # Combine all three persistent layers (fixed + system + candidate)
                    combined_local = _combine_kws_pred(fixed_local_kw, sys_local_kw, cand_local_kw)
                    combined_national = _combine_kws_pred(fixed_national_kw, sys_national_kw, cand_national_kw)
                    # Last cycle: add weather & lifestyle keywords (affects voting-day mood)
                    if cycle_idx == num_cycles - 1:
                        combined_local.append(f"{county} 活動 假日 節慶 市集")
                    _push_pred_live(
                        job,
                        f"🔍 Cycle {cycle_idx+1}/{num_cycles} — sim days {cycle_start_day+1}~{cycle_start_day+cycle_days}"
                        f" ↔ real news {pred_news_start}~{pred_news_end}"
                        f" (user {len(fixed_local_kw)+len(fixed_national_kw)} + system {len(sys_local_kw)+len(sys_national_kw)}"
                        f" + candidate {len(cand_local_kw)+len(cand_national_kw)})"
                    )

                    _articles_per = sp.get("articles_per_agent", 3)
                    _target = max(50, len(agents) * _articles_per * cycle_days // 3)
                    new_news = await search_news_for_window(
                        combined_local, combined_national, pred_news_start, pred_news_end, seen_article_ids,
                        target_pool_size=_target,
                    )
                    for n in new_news:
                        seen_article_ids.add(n["article_id"])

                    # ── Score news impact ──
                    if new_news:
                        job["phase"] = "scoring"
                        _push_pred_live(job, f"⚖️ Scoring {len(new_news)} articles for social impact...")
                        new_news = await score_news_impact(new_news, county, _all_cand_names or None, _cand_profiles or None)
                        _push_pred_live(job, f"📊 Kept {len(new_news)} articles (impact ≥ 3)")
                    else:
                        _push_pred_live(job, f"⚠️ No news found this cycle — agents will evolve without news input")

                    # ── Search district-specific local news ──
                    _districts = list(set(a.get("district", "") for a in agents if a.get("district")))
                    cycle_district_news: dict[str, list[dict]] = {}
                    if _districts:
                        job["phase"] = "district_news"
                        try:
                            _dist_counts = {}
                            for a in agents:
                                d = a.get("district", "")
                                if d:
                                    _dist_counts[d] = _dist_counts.get(d, 0) + 1
                            cycle_district_news = await search_district_news(
                                _districts, county, pred_news_start, pred_news_end,
                                seen_ids=seen_article_ids,
                                district_agent_counts=_dist_counts,
                            )
                            _total_dn = sum(len(v) for v in cycle_district_news.values())
                            if _total_dn:
                                _push_pred_live(job, f"🏘️ Found {_total_dn} local articles (covering {len(cycle_district_news)} districts)")
                        except Exception as e:
                            logger.warning(f"[prediction] District news search failed: {e}")

                    # ── Assign news to sim days (time-compressed) ──
                    day_news = assign_news_to_days(
                        new_news,
                        cycle_sim_days=cycle_days,
                        cycle_news_start=pred_news_start,
                        cycle_news_end=pred_news_end,
                    )
                    for d_offset, d_arts in day_news.items():
                        _tag_day = cycle_start_day + d_offset + 1
                        for a in d_arts:
                            a["assigned_day"] = _tag_day

                    # ── Add news to pool + evolve ──
                    current_pool_pred.extend(new_news)
                    # Spread district news evenly across this cycle's sim days
                    _dist_flat = []
                    for _dn, _das in cycle_district_news.items():
                        for _da in _das:
                            if _da.get("article_id") not in seen_article_ids:
                                _da["channel"] = "地方"
                                _dist_flat.append(_da)
                                seen_article_ids.add(_da["article_id"])
                    for _i, _da in enumerate(_dist_flat):
                        _da["assigned_day"] = cycle_start_day + (_i % cycle_days) + 1
                        current_pool_pred.append(_da)
                    # Also add scenario-specific hypothetical news to pool
                    if scenario_extra_pool and cycle_idx == 0:
                        for _se in scenario_extra_pool:
                            _se.setdefault("assigned_day", 1)
                        current_pool_pred.extend(scenario_extra_pool)
                        _push_pred_live(job, f"📰 Added {len(scenario_extra_pool)} scenario-specific articles")
                    replace_pool(current_pool_pred)

                    job["phase"] = "evolving"
                    for d_offset in range(cycle_days):
                        global_day += 1
                        day = global_day

                        if si == start_scenario and day < start_day:
                            continue

                        if _pred_stops.get(job["job_id"]):
                            job["status"] = "cancelled"
                            _push_pred_live(job, "⚠️ Prediction interrupted")
                            break

                        day_cancel_event = asyncio.Event()
                        _pred_cancel_events[job["job_id"]] = day_cancel_event

                        # Pause support
                        while _pred_pauses.get(job["job_id"]):
                            if _pred_stops.get(job["job_id"]):
                                break
                            if job["status"] != "paused":
                                job["status"] = "paused"
                                day_cancel_event.set()
                                _push_pred_live(job, "⏸️ Prediction paused")
                            await asyncio.sleep(1)
                        if not _pred_stops.get(job["job_id"]) and job["status"] == "paused":
                            job["status"] = "running"

                        job["current_day"] = day
                        # Pre-evolve preview: how many articles are eligible for this sim day
                        _eligible = sum(
                            1 for a in current_pool_pred
                            if (a.get("assigned_day") is None) or (a.get("assigned_day", 0) <= day)
                        )
                        _today_assigned = sum(
                            1 for a in current_pool_pred if a.get("assigned_day") == day
                        )
                        _push_pred_live(
                            job,
                            f"📅 Day {day}/{sim_days} — 池 {len(current_pool_pred)} 則"
                            f"，可讀 {_eligible} 則（今日新分配 {_today_assigned}）"
                        )

                        entries = await evolve_one_day(
                            agents, current_pool_pred, day,
                            feed_fn=None, memory_fn=None, job=job,
                            concurrency=concurrency,
                            cancel_event=day_cancel_event,
                            district_news=cycle_district_news,
                        )

                        # ── Truthful feed stats (post-evolve) ────────────
                        if entries:
                            _pool_assigned: dict = {a.get("article_id"): a.get("assigned_day") for a in current_pool_pred}
                            _total_reads = 0
                            _read_articles: set = set()
                            _future_leaks = 0
                            for e in entries:
                                for art_id in (e.get("fed_articles") or []):
                                    _total_reads += 1
                                    _read_articles.add(art_id)
                                    _aday = _pool_assigned.get(art_id)
                                    if _aday is not None and _aday > day:
                                        _future_leaks += 1
                            _avg_per_agent = _total_reads / len(entries)
                            _msg = (
                                f"📖 Day {day} 完成 — 平均每人讀 {_avg_per_agent:.1f} 篇"
                                f"，實際使用 {len(_read_articles)} 篇不同文章"
                            )
                            if _future_leaks > 0:
                                _msg += f"  ⚠️ 未來新聞洩漏 {_future_leaks} 次！"
                            _push_pred_live(job, _msg)

                        # ── Compute day record (heuristic scores etc.) ──
                        day_record = _compute_day_record(entries, day, agent_demographics_map, pred, job, news_pool=current_pool_pred)
                        daily_data.append(day_record)

                        # ── Recording: save prediction step (cycle mode) ──
                        _rec_id = job.get("recording_id", "")
                        if _rec_id and entries:
                            try:
                                from .recorder import save_step, build_evolution_step
                                from .evolver import _load_states
                                _step = build_evolution_step(
                                    day=day, agents=agents, entries=entries,
                                    states=_load_states(), news_articles=current_pool_pred,
                                    live_messages=job.get("live_messages", [])[-20:],
                                    scenario_name=scenario_name,
                                    job=job,
                                )
                                _step["day_record"] = day_record
                                _step_num = (fsi * sim_days) + day
                                save_step(_rec_id, _step_num, _step)
                            except Exception as _re:
                                logger.exception(f"Recording pred step failed")

                        # Update live data on job for frontend charting
                        job["current_daily_data"] = daily_data
                        job["current_scenario_name"] = scenario_name
                        job["total_days"] = sim_days

                        ce = day_record.get("candidate_estimate", {})
                        if ce:
                            est_str = " | ".join(f"{c}:{v}%" for c, v in ce.items() if c != "Undecided")
                            _push_pred_live(job, f"  📅 {scenario_name} Day {day}/{sim_days}: {est_str}")
                        else:
                            _push_pred_live(job, f"  📅 {scenario_name} Day {day}/{sim_days}: sat={day_record.get('avg_satisfaction',0)} anx={day_record.get('avg_anxiety',0)}")

                        # Track pinned personas
                        if tracked_ids and entries:
                            for e in entries:
                                eid = str(e.get("agent_id", e.get("person_id", "")))
                                if eid in agent_timeline:
                                    agent_timeline[eid].append({
                                        "day": day,
                                        "satisfaction": e.get("satisfaction", 50),
                                        "anxiety": e.get("anxiety", 50),
                                        "local_satisfaction": e.get("local_satisfaction", e.get("satisfaction", 50)),
                                        "national_satisfaction": e.get("national_satisfaction", e.get("satisfaction", 50)),
                                        "candidate_awareness": e.get("candidate_awareness") or {},
                                        "candidate_sentiment": e.get("candidate_sentiment") or {},
                                        "political_leaning": e.get("political_leaning", ""),
                                    })

                    if _pred_stops.get(job["job_id"]):
                        break

            else:
                # ══════════════════════════════════════════════════════════
                # ── Legacy static news mode (original behavior) ──────────
                # ══════════════════════════════════════════════════════════
                structured_events = scenario.get("events", [])

                if structured_events:
                    day_pool_map_struct: dict[int, list[dict]] = {}
                    _seen_titles_pred: set[str] = set()
                    for ev in sorted(structured_events, key=lambda e: e.get("day", 0)):
                        ev_day = int(ev.get("day", 0))
                        for item in ev.get("news", []):
                            title_text = item.get("title", "")
                            summary_text = item.get("summary", "")
                            title_key = title_text[:12].strip()
                            if title_key and title_key in _seen_titles_pred:
                                continue
                            if title_key:
                                _seen_titles_pred.add(title_key)
                            day_pool_map_struct.setdefault(ev_day, []).append({
                                "article_id": uuid.uuid4().hex[:8],
                                "title": title_text,
                                "summary": summary_text,
                                "source_tag": item.get("source_tag", "歷史事件"),
                                "channel": item.get("channel", "國內"),
                                "leaning": item.get("leaning", "center"),
                                "crawled_at": time.time(),
                            })
                    total_struct = sum(len(v) for v in day_pool_map_struct.values())
                    _push_pred_live(job, f"📅 Structured event mode: {total_struct} articles injected by day ({len(structured_events)} days with events)")
                    use_structured = True
                    current_pool_pred: list[dict] = []
                    undated_items = []
                    day_pool_map = {}
                else:
                    scenario_pool = _build_scenario_pool(news_text)
                    replace_pool(scenario_pool)

                    dated_items: list[tuple[str, dict]] = []
                    undated_items = []
                    for item in scenario_pool:
                        d = item.get("event_date")
                        if d:
                            dated_items.append((d, item))
                        else:
                            undated_items.append(item)

                    if dated_items:
                        dated_items.sort(key=lambda x: x[0])
                        unique_dates = sorted(set(d for d, _ in dated_items))
                        date_to_day: dict[str, int] = {}
                        if len(unique_dates) == 1:
                            date_to_day[unique_dates[0]] = 1
                        else:
                            for idx, dt in enumerate(unique_dates):
                                mapped = 1 + int(idx * (sim_days - 1) / (len(unique_dates) - 1))
                                date_to_day[dt] = min(mapped, sim_days)
                        day_pool_map = {}
                        for d, item in dated_items:
                            sim_day = date_to_day[d]
                            day_pool_map.setdefault(sim_day, []).append(item)
                    else:
                        day_pool_map = {}

                    total_dated = len(dated_items)
                    total_undated = len(undated_items)
                    _push_pred_live(job, f"📰 Injected {total_dated + total_undated} scenario articles ({total_dated} date-specific, {total_undated} always-visible)")
                    use_structured = False
                    current_pool_pred = []

                # Restore pool on resume
                if si == start_scenario and initial_pool:
                    current_pool_pred = list(initial_pool)
                    replace_pool(current_pool_pred)
                    _push_pred_live(job, f"🔄 Resuming prediction from checkpoint Day {start_day}...")

                for day in range(1, sim_days + 1):
                    if si == start_scenario and day < start_day:
                        continue

                    day_cancel_event = asyncio.Event()
                    _pred_cancel_events[job["job_id"]] = day_cancel_event

                    while _pred_pauses.get(job["job_id"]):
                        if _pred_stops.get(job["job_id"]):
                            break
                        if job["status"] != "paused":
                            job["status"] = "paused"
                            day_cancel_event.set()
                            _push_pred_live(job, "⏸️ Prediction paused")
                        if _pred_checkpoint_pending.pop(job["job_id"], False):
                            _save_pred_checkpoint(
                                job, agents, pred, day, si,
                                current_pool_pred if use_structured else [],
                                daily_data,
                            )
                            _push_pred_live(job, f"💾 Checkpoint saved (Day {day}) — can resume after restart")
                        await asyncio.sleep(1)

                    if not _pred_stops.get(job["job_id"]) and job["status"] == "paused":
                        job["status"] = "running"
                        _push_pred_live(job, "▶️ Prediction resumed")

                    if _pred_stops.get(job["job_id"]):
                        job["status"] = "cancelled"
                        day_cancel_event.set()
                        _push_pred_live(job, "⚠️ Prediction interrupted")
                        break

                    if use_structured:
                        current_pool_pred = current_pool_pred + day_pool_map_struct.get(day, [])
                        replace_pool(current_pool_pred)
                        today_pool = current_pool_pred
                        _push_pred_live(job, f"📅 Day {day}/{sim_days} — news pool {len(today_pool)} articles (cumulative)")
                    else:
                        today_pool = list(undated_items) + day_pool_map.get(day, [])
                        replace_pool(today_pool)

                    entries = await evolve_one_day(
                        agents, today_pool, day,
                        feed_fn=None,
                        memory_fn=None,
                        job=job,
                        concurrency=concurrency,
                        cancel_event=day_cancel_event,
                    )

                    if entries:
                        avg_sat = sum(e["satisfaction"] for e in entries) / len(entries)
                        avg_anx = sum(e["anxiety"] for e in entries) / len(entries)
                    else:
                        avg_sat = avg_anx = 50

                    # Per-leaning-group stats
                    leaning_stats: dict[str, dict] = {}
                    sat_buckets = {"0-20": 0, "20-40": 0, "40-60": 0, "60-80": 0, "80-100": 0}
                    high_sat_count = 0
                    high_anx_count = 0
                    for e in entries:
                        aid = str(e.get("agent_id", e.get("person_id", "")))
                        demographics = agent_demographics_map.get(aid, {})
                    
                        # Read the mutated leaning from the diary entry and sync demographics map
                        leaning = e.get("political_leaning") or demographics.get("leaning", "Tossup")
                        if leaning != demographics.get("leaning") and aid in agent_demographics_map:
                            agent_demographics_map[aid]["leaning"] = leaning
                        
                        sat = e["satisfaction"]
                        anx = e["anxiety"]

                        if leaning not in leaning_stats:
                            leaning_stats[leaning] = {"sat_sum": 0, "anx_sum": 0, "count": 0}
                        leaning_stats[leaning]["sat_sum"] += sat
                        leaning_stats[leaning]["anx_sum"] += anx
                        leaning_stats[leaning]["count"] += 1

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

                    # All agents' full details (every agent runs LLM anyway)
                    agent_details = []
                    if entries:
                        for e in entries:
                            aid = str(e.get("agent_id", e.get("person_id", "")))
                            sat = round(e.get("satisfaction", 50), 1)
                            anx = round(e.get("anxiety", 50), 1)
                            diary = e.get("diary_text", "")
                            fed = e.get("fed_titles", [])
                            agent_details.append({
                                "id": aid,
                                "satisfaction": sat,
                                "anxiety": anx,
                                "diary": diary[:100] if diary else "",
                                "fed_titles": fed[:3] if fed else [],
                            })
                            if aid in agent_timeline:
                                agent_timeline[aid].append({
                                    "day": day,
                                    "satisfaction": sat,
                                    "anxiety": anx,
                                    "local_satisfaction": e.get("local_satisfaction", e.get("satisfaction", 50)),
                                    "national_satisfaction": e.get("national_satisfaction", e.get("satisfaction", 50)),
                                    "candidate_awareness": e.get("candidate_awareness") or {},
                                    "candidate_sentiment": e.get("candidate_sentiment") or {},
                                    "political_leaning": e.get("political_leaning", ""),
                                })

                    if job["status"] == "cancelled":
                        break

                    # ── Heuristic candidate estimate per group ──
                    candidate_estimate: dict[str, float] = {}
                    by_leaning_candidate: dict[str, dict[str, float]] = {}
                    group_estimates: dict[str, dict[str, float]] = {}
                    group_leaning_candidate: dict[str, dict[str, dict[str, float]]] = {}

                    # Read scoring_params for news_impact
                    sp = job.get("scoring_params", {})
                    news_impact = sp.get("news_impact", 1.0)
                    party_align_bonus = sp.get("party_align_bonus", 15)
                    party_base = sp.get("party_base", None)  # per-candidate base scores from UI
                    incumbency_bonus = sp.get("incumbency_bonus", 12)
                    party_divergence_mult = sp.get("party_divergence_mult", 0.5)
                    candidate_traits = sp.get("candidate_traits", None)
                    # ── New tunable params ──
                    # Candidate differentiation
                    profile_match_mult = sp.get("profile_match_mult", 1.5)
                    anxiety_sensitivity_mult = sp.get("anxiety_sensitivity_mult", 0.15)
                    # Charm & cross-party appeal
                    charm_mult = sp.get("charm_mult", 8.0)
                    cross_appeal_mult = sp.get("cross_appeal_mult", 0.6)
                    # Undecided formula
                    close_race_weight = sp.get("close_race_weight", 0.8)
                    same_party_penalty = sp.get("same_party_penalty", 0.06)
                    no_match_penalty = sp.get("no_match_penalty", 0.08)

                    _major_kw = ["國民黨", "民進黨", "民主進步黨", "中國國民黨"]
                    _minor_kw = ["民眾黨", "台灣民眾黨", "臺灣民眾黨", "時代力量", "台灣基進"]
                    _indep_kw = ["無黨", "無所屬", "無黨籍", "未經政黨推薦"]
                    def _base_score(desc: str) -> float:
                        if any(k in desc for k in _major_kw): return 50.0
                        if any(k in desc for k in _minor_kw): return 30.0
                        if any(k in desc for k in _indep_kw): return 5.0
                        return 30.0

                    # Build effective groups for daily estimate
                    daily_groups = pred.get("poll_groups", [])
                    if not daily_groups and poll_opts:
                        daily_groups = [{"name": "default", "candidates": poll_opts}]

                    _is_satisfaction_mode = pred.get("prediction_mode") == "satisfaction" or (pred.get("question", "").startswith("滿意度調查"))

                    # ══════════════════════════════════════════════════
                    # Satisfaction mode: independent 5-level per person
                    # ══════════════════════════════════════════════════
                    if _is_satisfaction_mode and daily_groups and entries:
                        import random as _sat_rng
                        for gi, group in enumerate(daily_groups):
                            group_name = group.get("name", f"組別{gi+1}")
                            group_cands = group.get("candidates", [])
                            cand_names = [c.get("name") for c in group_cands if c.get("name")]
                            if not cand_names:
                                continue

                            # Per-candidate independent satisfaction
                            per_cand_results: dict[str, dict[str, float]] = {}
                            per_cand_leaning: dict[str, dict[str, dict[str, float]]] = {}

                            for ci, cname in enumerate(cand_names):
                                desc = group_cands[ci].get("description", "")
                                _role_lower = desc.lower()
                                is_national = any(k in _role_lower for k in ["總統", "行政院", "中央", "院長", "部長", "國家元首"])
                                is_local = any(k in _role_lower for k in ["市長", "縣長", "副市長", "副縣長", "議長", "地方"])
                                is_incumbent = group_cands[ci].get("isIncumbent", False) or "現任" in desc

                                # Detect party
                                _cand_party = ""
                                if any(k in desc for k in ["國民黨", "藍"]): _cand_party = "kmt"
                                elif any(k in desc for k in ["民進黨", "綠"]): _cand_party = "dpp"
                                elif any(k in desc for k in ["民眾黨"]): _cand_party = "tpp"

                                levels = {"非常滿意": 0, "還算滿意": 0, "不太滿意": 0, "非常不滿意": 0, "未表態": 0}
                                leaning_levels: dict[str, dict[str, int]] = {}

                                for e in entries:
                                    sat = e.get("satisfaction", 50)
                                    local_sat = e.get("local_satisfaction", sat)
                                    national_sat = e.get("national_satisfaction", sat)
                                    anxiety = e.get("anxiety", 50)
                                    leaning = e.get("leaning", "Tossup")
                                    cand_sent = (e.get("candidate_sentiment") or {}).get(cname, None)

                                    # Choose base score depending on role
                                    if cand_sent is not None:
                                        base_score = 50 + cand_sent * 40
                                    elif is_national:
                                        base_score = national_sat
                                    elif is_local:
                                        base_score = local_sat
                                    else:
                                        base_score = (local_sat + national_sat) / 2

                                    # Party alignment
                                    if _cand_party == "kmt" and any(x in leaning for x in ["右", "藍", "統"]):
                                        base_score += 8
                                    elif _cand_party == "kmt" and any(x in leaning for x in ["左", "綠", "獨"]):
                                        base_score -= 8
                                    elif _cand_party == "dpp" and any(x in leaning for x in ["左", "綠", "獨"]):
                                        base_score += 8
                                    elif _cand_party == "dpp" and any(x in leaning for x in ["右", "藍", "統"]):
                                        base_score -= 8

                                    # Incumbent bonus
                                    if is_incumbent:
                                        base_score += 5

                                    # Charm bonus from traits
                                    _traits = (sp.get("candidate_traits") or {}).get(cname, {})
                                    _charm = _traits.get("charm", 0.35)
                                    base_score += _charm * (sp.get("charm_mult", 8.0) or 8.0) * 0.3

                                    # Anxiety effect
                                    if anxiety > 60:
                                        base_score -= (anxiety - 60) * 0.15

                                    # Undecided probability
                                    undecided_prob = sp.get("base_undecided", 0.10)
                                    if 42 < base_score < 58:
                                        undecided_prob += 0.10
                                    if anxiety > 70 and ("中立" in leaning or leaning == "Tossup"):
                                        undecided_prob += 0.08
                                    undecided_prob = min(sp.get("max_undecided", 0.45), undecided_prob)

                                    # Map to 5-level
                                    base_score = max(0, min(100, base_score))
                                    if _sat_rng.random() < undecided_prob:
                                        level = "未表態"
                                    elif base_score >= 75:
                                        level = "非常滿意"
                                    elif base_score >= 55:
                                        level = "還算滿意"
                                    elif base_score >= 45:
                                        level = "還算滿意" if base_score >= 50 else "不太滿意"
                                    elif base_score >= 25:
                                        level = "不太滿意"
                                    else:
                                        level = "非常不滿意"

                                    levels[level] += 1

                                    if leaning not in leaning_levels:
                                        leaning_levels[leaning] = {"非常滿意": 0, "還算滿意": 0, "不太滿意": 0, "非常不滿意": 0, "未表態": 0, "_count": 0}
                                    leaning_levels[leaning][level] += 1
                                    leaning_levels[leaning]["_count"] += 1

                                total_resp = sum(levels.values())
                                pcts = {k: round(v / max(total_resp, 1) * 100, 1) for k, v in levels.items()}
                                satisfied = pcts["非常滿意"] + pcts["還算滿意"]
                                dissatisfied = pcts["不太滿意"] + pcts["非常不滿意"]

                                per_cand_results[cname] = {
                                    "percentages": pcts,
                                    "satisfied_total": round(satisfied, 1),
                                    "dissatisfied_total": round(dissatisfied, 1),
                                    "undecided_total": pcts["未表態"],
                                    "total": total_resp,
                                }

                                # Per-leaning breakdown
                                lean_bd = {}
                                for ln, lv in leaning_levels.items():
                                    cnt = lv.pop("_count", 1) or 1
                                    lean_bd[ln] = {
                                        "total": int(cnt),
                                        **{f"{k}_pct": round(v / cnt * 100, 1) for k, v in lv.items()},
                                    }
                                per_cand_leaning[cname] = lean_bd

                            group_estimates[group_name] = per_cand_results
                            group_leaning_candidate[group_name] = per_cand_leaning
                            if gi == 0:
                                candidate_estimate = per_cand_results
                                by_leaning_candidate = per_cand_leaning

                    elif daily_groups and entries:
                        for gi, group in enumerate(daily_groups):
                            group_name = group.get("name", f"組別{gi+1}")
                            group_cands = group.get("candidates", [])
                            cand_names = [c.get("name") for c in group_cands if c.get("name")]
                            if not cand_names:
                                continue

                            cand_scores: dict[str, float] = {c: 0.0 for c in cand_names}
                            cand_scores["Undecided"] = 0.0
                            leaning_cand_scores: dict[str, dict[str, float]] = {}
                            total_w = 0.0

                            # Detect if all candidates in this group share the same party
                            _group_descs = [cand_names[ci] + "," + (group_cands[ci].get("description") or "") for ci in range(len(cand_names))]
                            _g_kmt = sum(1 for f in _group_descs if "國民黨" in f or "中國國民黨" in f)
                            _g_dpp = sum(1 for f in _group_descs if "民進黨" in f or "民主進步黨" in f)
                            _same_party_in_group = (_g_kmt == len(cand_names)) or (_g_dpp == len(cand_names))

                            # Per-group agent filter: only count agents whose leaning matches
                            _agent_filter = group.get("agentFilter") or {}
                            _filter_leanings = set(_agent_filter.get("leanings", []))

                            for e in entries:
                                aid = str(e.get("agent_id", e.get("person_id", "")))
                                demographics = agent_demographics_map.get(aid, {})
                                leaning = demographics.get("leaning", "Tossup")
                                if _filter_leanings and leaning not in _filter_leanings:
                                    continue
                                sat = e.get("satisfaction", 50)
                                anx = e.get("anxiety", 50)
                                ag_local_sat = e.get("local_satisfaction", sat)
                                ag_nat_sat = e.get("national_satisfaction", sat)
                                agent_w = 1.0
                                ag_district = demographics.get("district", "")
                                scores: dict[str, float] = {}
                                for ci, cname in enumerate(cand_names):
                                    desc = (group_cands[ci].get("description") or "")

                                    # Compute per-agent awareness from candidate visibility
                                    _cand_local_vis = float(group_cands[ci].get("localVisibility", group_cands[ci].get("local_visibility", 50))) / 100.0
                                    _cand_nat_vis = float(group_cands[ci].get("nationalVisibility", group_cands[ci].get("national_visibility", 50))) / 100.0
                                    _cand_origin = str(group_cands[ci].get("originDistricts", group_cands[ci].get("origin_districts", "")))
                                    _origin_list = [d.strip() for d in _cand_origin.split(",") if d.strip()] if _cand_origin else []
                                    _hometown_match = any(od in ag_district or ag_district in od for od in _origin_list) if ag_district and _origin_list else False
                                    # Use dynamic awareness from evolution if available; fall back to static visibility
                                    _dyn_awareness = (e.get("candidate_awareness") or {}).get(cname)
                                    if _dyn_awareness is not None:
                                        _awareness = float(_dyn_awareness)
                                    else:
                                        _awareness = _cand_local_vis if _hometown_match else _cand_nat_vis

                                    _cand_sent = (e.get("candidate_sentiment") or {}).get(cname, 0.0)
                                    score = _calculate_heuristic_score(
                                        cname, desc, leaning,
                                        ag_local_sat, ag_nat_sat, anx,
                                        news_impact, party_align_bonus,
                                        party_base_override=party_base,
                                        incumbency_bonus=incumbency_bonus,
                                        party_divergence_mult=party_divergence_mult,
                                        candidate_traits=candidate_traits,
                                        profile_match_mult=profile_match_mult,
                                        keyword_bonus_cap=sp.get("keyword_bonus_cap", 10.0),
                                        anxiety_sensitivity_mult=anxiety_sensitivity_mult,
                                        same_party_in_group=_same_party_in_group,
                                        charm_mult=charm_mult,
                                        cross_appeal_mult=cross_appeal_mult,
                                        awareness=_awareness,
                                        sentiment=_cand_sent,
                                        sentiment_mult=sp.get("sentiment_mult", 0.15),
                                        hometown_match=_hometown_match,
                                    )
                                    scores[cname] = score

                                total_score = sum(scores.values()) or 1.0
                                # Undecided: considers agent satisfaction AND candidate-pair factors
                                _base_undecided = sp.get("base_undecided", 0.08)
                                _max_undecided = sp.get("max_undecided", 0.45)
                                _both_unhappy = max(0, (50 - ag_local_sat) + (50 - ag_nat_sat)) / 100

                                # Score spread: if candidates are very close, undecided rises
                                _sorted_scores = sorted(scores.values(), reverse=True)
                                _score_spread = (_sorted_scores[0] - _sorted_scores[-1]) / max(_sorted_scores[0], 1) if len(_sorted_scores) > 1 else 0.5
                                _close_race_bonus = max(0, 0.15 - _score_spread) * close_race_weight

                                # Same-party penalty: when both candidates share a party, voters are more confused
                                # Use candidate names + descriptions to detect party (includes auto-supplemented tags)
                                _cand_full = [cand_names[ci] + "," + (group_cands[ci].get("description") or "") for ci in range(len(cand_names))]
                                _kmt_count = sum(1 for f in _cand_full if "國民黨" in f or "中國國民黨" in f)
                                _dpp_count = sum(1 for f in _cand_full if "民進黨" in f or "民主進步黨" in f)
                                _same_party_bonus = same_party_penalty if (_kmt_count >= 2 or _dpp_count >= 2) else 0.0

                                # Agent-party mismatch: if agent leaning doesn't match any candidate's party
                                _has_match = False
                                if any(x in leaning for x in ["藍", "統", "右"]):
                                    _has_match = _kmt_count > 0
                                elif any(x in leaning for x in ["綠", "本土", "獨", "左"]):
                                    _has_match = _dpp_count > 0
                                elif any(x in leaning for x in ["白", "中間"]):
                                    _has_match = any("民眾黨" in f for f in _cand_full)
                                else:
                                    _has_match = True  # neutral voters don't get extra undecided
                                _no_match_bonus = no_match_penalty if not _has_match else 0.0

                                undecided_prob = min(_max_undecided, _base_undecided + _both_unhappy * 0.25 + _close_race_bonus + _same_party_bonus + _no_match_bonus)
                                for cname in cand_names:
                                    cand_scores[cname] += (scores[cname] / total_score) * (1 - undecided_prob) * agent_w
                                cand_scores["Undecided"] += undecided_prob * agent_w
                                total_w += agent_w

                                if leaning not in leaning_cand_scores:
                                    leaning_cand_scores[leaning] = {c: 0.0 for c in cand_names}
                                    leaning_cand_scores[leaning]["_count"] = 0.0
                                for cname in cand_names:
                                    leaning_cand_scores[leaning][cname] += (scores[cname] / total_score) * (1 - undecided_prob)
                                leaning_cand_scores[leaning]["_count"] += 1.0

                            g_est = {}
                            if total_w > 0:
                                g_est = {c: round((v / total_w) * 100, 1) for c, v in cand_scores.items()}
                            g_lean = {}
                            for ln, sc in leaning_cand_scores.items():
                                cnt = sc.pop("_count", 1.0) or 1.0
                                g_lean[ln] = {c: round((v / cnt) * 100, 1) for c, v in sc.items()}

                            group_estimates[group_name] = g_est
                            group_leaning_candidate[group_name] = g_lean

                            # First group's data as backward-compat flat fields
                            if gi == 0:
                                candidate_estimate = g_est
                                by_leaning_candidate = g_lean

                        # ── Weighted combination across groups ──
                        combine_mode = sp.get("combine_mode", "independent")
                        if combine_mode == "weighted" and len(daily_groups) > 1:
                            weighted_scores: dict[str, float] = {}
                            total_weight = 0.0
                            for gi2, group in enumerate(daily_groups):
                                gn = group.get("name", f"組別{gi2+1}")
                                gw = float(group.get("weight", 100)) / 100.0
                                g_est2 = group_estimates.get(gn, {})
                                for cname, pct in g_est2.items():
                                    if cname == "Undecided":
                                        continue
                                    weighted_scores[cname] = weighted_scores.get(cname, 0.0) + float(pct) * gw
                                total_weight += gw
                            # Normalize and store as special group
                            if total_weight > 0 and weighted_scores:
                                combined = {c: round(v / total_weight, 1) for c, v in weighted_scores.items()}
                                group_estimates["__weighted_combined__"] = combined

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
                        "agent_details": agent_details,
                        "candidate_estimate": candidate_estimate,
                        "by_leaning_candidate": by_leaning_candidate,
                        "group_estimates": group_estimates,
                        "group_leaning_candidate": group_leaning_candidate,
                    }
                    daily_data.append(day_record)

                    # ── Recording: save prediction step (legacy mode) ──
                    _rec_id = job.get("recording_id", "")
                    if _rec_id and entries:
                        try:
                            from .recorder import save_step, build_evolution_step
                            from .evolver import _load_states
                            _step = build_evolution_step(
                                day=day, agents=agents, entries=entries,
                                states=_load_states(),
                                news_articles=today_pool,
                                live_messages=job.get("live_messages", [])[-20:],
                                scenario_name=scenario_name,
                                job=job,
                            )
                            _step["day_record"] = day_record
                            _step_num = (fsi * sim_days) + day
                            save_step(_rec_id, _step_num, _step)
                        except Exception as _re:
                            logger.warning(f"Recording pred step failed: {_re}")

                    # Update live data on job for frontend charting
                    job["current_daily_data"] = daily_data
                    job["current_scenario_name"] = scenario_name

                    if candidate_estimate:
                        est_str = " | ".join(f"{c}:{v}%" for c, v in candidate_estimate.items() if c != "Undecided")
                        _push_pred_live(job, f"  📅 {scenario_name} Day {day}/{sim_days}: {est_str}")
                    else:
                        _push_pred_live(job, f"  📅 {scenario_name} Day {day}/{sim_days}: sat={round(avg_sat,1)} anx={round(avg_anx,1)}")

                    await asyncio.sleep(0.3)

            # 4. Collect final states
            final_states = _load_states()
            sats = [s.get("satisfaction", 50) for s in final_states.values()]
            anxs = [s.get("anxiety", 50) for s in final_states.values()]

            # 5. Compute political leaning distribution & vote share estimate
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

            modality = pred.get("sampling_modality", "unweighted")

            # Map agents to their political leanings
            leaning_counts: dict[str, float] = {}
            ruling_support = 0.0  # agents satisfied with ruling party (sat > 50)
            opposition_support = 0.0  # agents dissatisfied (sat < 50)
            neutral_count = 0.0
            total_weight = 0.0
            for agent in agents:
                aid = str(agent.get("person_id", 0))
                state = final_states.get(aid, {})
                leaning = agent.get("political_leaning", "Tossup")
                sat = state.get("satisfaction", 50)
                
                # Get weight
                age_str = agent.get("context", {}).get("age", "40")
                weight = _get_sampling_weight(modality, age_str)
                
                total_weight += weight
                leaning_counts[leaning] = leaning_counts.get(leaning, 0.0) + weight
                if sat > 55:
                    ruling_support += weight
                elif sat < 45:
                    opposition_support += weight
                else:
                    neutral_count += weight
            
            total_weight = total_weight or 1.0
            leaning_pct = {k: round((v / total_weight) * 100, 1) for k, v in sorted(leaning_counts.items())}
            
            # Simple vote share model: ruling/neutral/opposition distribution
            vote_prediction = {
                "執政黨支持": round((ruling_support / total_weight) * 100, 1),
                "中間選民": round((neutral_count / total_weight) * 100, 1),
                "在野黨支持": round((opposition_support / total_weight) * 100, 1),
            }

            # Heuristic results from last day
            last_day_data = daily_data[-1] if daily_data else {}
            poll_group_results = last_day_data.get("group_estimates", {})
            first_group_key = next(iter(poll_group_results), None)
            first_group_results = poll_group_results.get(first_group_key, {}) if first_group_key else {}

            # LLM-based evaluation on final day
            llm_poll_group_results: dict = {}
            _is_sat_mode = pred.get("prediction_mode") == "satisfaction"
            # Store current news pool on job for voting-day context extraction
            try:
                job["_current_pool"] = current_pool_pred
            except NameError:
                job["_current_pool"] = []
            try:
                daily_groups = pred.get("poll_groups", [])
                if daily_groups and agents and final_states:
                    if _is_sat_mode:
                        _survey_method = pred.get("scoring_params", {}).get("survey_method", "mobile")
                        _push_pred_live(job, "📊 Starting LLM satisfaction survey (final day)...")
                        llm_poll_group_results = await _run_llm_satisfaction_survey(
                            agents, final_states, daily_groups, concurrency, job,
                            survey_method=_survey_method,
                        )
                        _push_pred_live(job, f"✅ LLM satisfaction survey complete ({len(llm_poll_group_results)} groups)")
                    else:
                        _push_pred_live(job, "🗳️ Starting LLM voting (final day)...")
                        llm_poll_group_results = await _run_llm_voting_for_groups(
                            agents, final_states, daily_groups,
                            pred.get("max_choices", 1), concurrency, job,
                            pred.get("sampling_modality", "unweighted"),
                        )
                        _push_pred_live(job, f"✅ LLM voting complete ({len(llm_poll_group_results)} groups)")
            except Exception as e:
                logger.warning(f"LLM voting failed (non-fatal): {e}")
                _push_pred_live(job, f"⚠️ LLM voting failed (heuristic results unaffected): {e}")

            scenario_result = {
                "scenario_id": scenario_id,
                "scenario_name": scenario_name,
                "news_injected": news_text,
                "daily_summary": daily_data,
                "final_avg_satisfaction": round(sum(sats) / len(sats), 1) if sats else 50,
                "final_avg_anxiety": round(sum(anxs) / len(anxs), 1) if anxs else 50,
                "agent_count": len(final_states),
                "leaning_distribution": leaning_pct,
                "vote_prediction": first_group_results if first_group_results else vote_prediction,
                "poll_group_results": poll_group_results,
                "llm_poll_group_results": llm_poll_group_results,
                "per_agent_timeline": agent_timeline,
            }
            job["scenario_results"].append(scenario_result)
            if poll_group_results:
                summary_parts = []
                for gn, gr in poll_group_results.items():
                    if gr:
                        # Satisfaction mode: values are dicts with satisfied_total
                        first_val = next(iter(gr.values()), None)
                        if isinstance(first_val, dict) and "satisfied_total" in first_val:
                            parts = [f"{cn} 滿意{v['satisfied_total']}%" for cn, v in gr.items()]
                            summary_parts.append(f"{gn}: {' / '.join(parts)}")
                        else:
                            top = max(gr.items(), key=lambda x: x[1] if isinstance(x[1], (int, float)) else 0)
                            summary_parts.append(f"{gn}: {top[0]} {top[1]}%")
                _push_pred_live(job, f"✅ {scenario_name} complete: {' │ '.join(summary_parts)}")
            else:
                _push_pred_live(job, f"✅ {scenario_name} complete: sat={scenario_result['final_avg_satisfaction']} incumbent={vote_prediction.get('執政黨支持', vote_prediction.get('incumbent', 0))}% opposition={vote_prediction.get('在野黨支持', vote_prediction.get('opposition', 0))}%")

            if job["status"] == "cancelled":
                break

        if job["status"] != "cancelled":
            # 4.5. Compute contrast-style (對比式) comparison if applicable
            # For multi-group elections where each group is a 1v1 matchup,
            # compute margins and determine who performs better vs the common opponent.
            for sr in job["scenario_results"]:
                pgr = sr.get("llm_poll_group_results") or sr.get("poll_group_results", {})
                if len(pgr) >= 2:
                    # Check if groups share a common opponent
                    all_cands_per_group = {}
                    for gn, gr in pgr.items():
                        cands_in_group = set(k for k in gr.keys() if k != "Undecided")
                        all_cands_per_group[gn] = cands_in_group
                    all_cands = [c for cs in all_cands_per_group.values() for c in cs]
                    from collections import Counter
                    cand_freq = Counter(all_cands)
                    common_opponents = [c for c, freq in cand_freq.items() if freq >= 2]
                    if common_opponents:
                        opponent = common_opponents[0]  # e.g. 王美惠
                        contrast_results = []
                        for gn, gr in pgr.items():
                            cands = [c for c in gr.keys() if c != "Undecided" and c != opponent]
                            if not cands:
                                continue
                            challenger = cands[0]  # e.g. 翁壽良 or 張啓楷
                            c_pct = gr.get(challenger, 0)
                            o_pct = gr.get(opponent, 0)
                            # Handle satisfaction mode (dict values)
                            if isinstance(c_pct, dict): c_pct = c_pct.get("satisfied_total", 0)
                            if isinstance(o_pct, dict): o_pct = o_pct.get("satisfied_total", 0)
                            margin = round(c_pct - o_pct, 1)
                            contrast_results.append({
                                "group": gn,
                                "challenger": challenger,
                                "opponent": opponent,
                                "challenger_pct": c_pct,
                                "opponent_pct": o_pct,
                                "margin": margin,
                                "winner": challenger if margin > 0 else opponent,
                            })
                        if contrast_results:
                            # Sort by margin descending — the one who beats opponent by the most wins
                            contrast_results.sort(key=lambda x: x["margin"], reverse=True)
                            best = contrast_results[0]
                            sr["contrast_comparison"] = {
                                "type": "對比式",
                                "common_opponent": opponent,
                                "groups": contrast_results,
                                "recommended": best["challenger"],
                                "recommended_margin": best["margin"],
                            }
                            _push_pred_live(job, f"📊 Head-to-head results: {' vs '.join(r['challenger'] for r in contrast_results)} vs {opponent}")
                            for r in contrast_results:
                                sign = "+" if r["margin"] > 0 else ""
                                _push_pred_live(job, f"  {r['challenger']}: {r['challenger_pct']}% vs {opponent} {r['opponent_pct']}% (margin {sign}{r['margin']}%)")
                            _push_pred_live(job, f"  ✅ Recommended: {best['challenger']} (largest margin vs {opponent} {'+' if best['margin']>0 else ''}{best['margin']}%)")

            # 5. Save results to prediction file
            pred["results"] = {
                "scenario_results": job["scenario_results"],
                "completed_at": time.time(),
            }
            pred["status"] = "completed"
            pred_path = os.path.join(PREDICTIONS_DIR, f"{pred['prediction_id']}.json")
            with open(pred_path, "w") as f:
                json.dump(pred, f, ensure_ascii=False, indent=2)

            job["status"] = "completed"
            job["completed_at"] = time.time()
            _delete_pred_checkpoint(job["job_id"])  # remove checkpoint on success
            logger.info(f"Prediction completed: {job['job_id']}")

            # ── Recording: finalize prediction recording ──
            _rec_id = job.get("recording_id", "")
            if _rec_id:
                try:
                    from .recorder import update_recording
                    update_recording(_rec_id, {
                        "status": "completed", "completed_at": time.time(),
                        "total_steps": len(filtered_scenarios) * sim_days,
                        "agent_count": len(agents),
                        "scenarios": [s.get("name", f"情境{i+1}") for i, s in enumerate(pred.get("scenarios", []))],
                    })
                    logger.info(f"[recorder] Finalized prediction recording {_rec_id}")
                except Exception:
                    logger.exception(f"Failed to finalize recording {_rec_id}")
        else:
            job["completed_at"] = time.time()
            logger.info(f"Prediction cancelled: {job['job_id']}")
            # ── Recording: mark as cancelled ──
            _rec_id = job.get("recording_id", "")
            if _rec_id:
                try:
                    from .recorder import update_recording
                    update_recording(_rec_id, {"status": "cancelled", "completed_at": time.time()})
                except Exception:
                    logger.exception(f"Failed to finalize recording {_rec_id} on cancel")

    except Exception as e:
        logger.exception(f"Prediction failed: {e}")
        job["status"] = "failed"
        job["error"] = str(e)
        job["completed_at"] = time.time()
        # ── Recording: mark as failed ──
        _rec_id = job.get("recording_id", "")
        if _rec_id:
            try:
                from .recorder import update_recording
                update_recording(_rec_id, {"status": "failed", "completed_at": time.time()})
            except Exception:
                logger.exception(f"Failed to finalize recording {_rec_id} on error")


def _build_semantic_state(state: dict) -> str:
    """Convert numeric state to natural language description for LLM."""
    local_sat = state.get("local_satisfaction", 50)
    national_sat = state.get("national_satisfaction", 50)
    anxiety = state.get("anxiety", 50)
    lines = []
    if local_sat >= 70: lines.append("- 對地方施政：相當滿意（覺得市政有在做事、生活品質有改善）")
    elif local_sat >= 55: lines.append("- 對地方施政：還算滿意（有些進步但也有不足）")
    elif local_sat >= 45: lines.append("- 對地方施政：普通（沒特別好也沒特別差）")
    elif local_sat >= 30: lines.append("- 對地方施政：不太滿意（覺得很多問題沒解決）")
    else: lines.append("- 對地方施政：很不滿意（生活環境和公共服務讓你失望）")
    if national_sat >= 70: lines.append("- 對中央施政：相當滿意（覺得國家方向正確、經濟有希望）")
    elif national_sat >= 55: lines.append("- 對中央施政：還算滿意（整體尚可但有隱憂）")
    elif national_sat >= 45: lines.append("- 對中央施政：普通（好壞參半）")
    elif national_sat >= 30: lines.append("- 對中央施政：不太滿意（物價壓力大、政策無感）")
    else: lines.append("- 對中央施政：很不滿意（覺得政府無能、前景悲觀）")
    if anxiety >= 70: lines.append("- 生活焦慮感：高度焦慮（對經濟前景和生活壓力感到很不安）")
    elif anxiety >= 55: lines.append("- 生活焦慮感：中等偏高（有些擔心但還能應對）")
    elif anxiety >= 40: lines.append("- 生活焦慮感：一般（生活壓力在可接受範圍）")
    else: lines.append("- 生活焦慮感：低（生活穩定、心態輕鬆）")
    return "\n".join(lines)


def _build_long_term_memory(state: dict) -> str:
    """Build long-term memory section from agent state."""
    mem = state.get("memory_summary", [])
    if not mem:
        return ""
    return "【長期記憶（過去重大事件的印象）】\n" + "\n".join(f"  {m}" for m in mem) + "\n\n"


def _build_voting_day_context(job: dict) -> str:
    """Extract weather, lifestyle, and polling context from job's news pool for voting day.

    Scans articles in the current pool for weather/天氣, poll/民調, and lifestyle/活動 content,
    and builds a brief context description for the voting prompt.
    """
    _weather_kw = ["天氣", "氣溫", "降雨", "豪雨", "颱風", "高溫", "寒流", "空氣品質", "紫外線"]
    _poll_kw = ["民調", "支持度", "滿意度", "最新民調"]
    _lifestyle_kw = ["停水", "停電", "塞車", "連假", "節慶"]

    pool = job.get("_current_pool", [])
    if not pool:
        return ""

    weather_lines = []
    poll_lines = []
    lifestyle_lines = []

    for art in pool:
        title = art.get("title", "")
        summary = art.get("summary", "")
        text = title + " " + summary
        if any(k in text for k in _weather_kw) and len(weather_lines) < 2:
            weather_lines.append(title)
        if any(k in text for k in _poll_kw) and len(poll_lines) < 2:
            poll_lines.append(title)
        if any(k in text for k in _lifestyle_kw) and len(lifestyle_lines) < 1:
            lifestyle_lines.append(title)

    parts = []
    if weather_lines:
        parts.append("今天的天氣狀況：" + "；".join(weather_lines))
    if poll_lines:
        parts.append("最近的民調消息：" + "；".join(poll_lines))
    if lifestyle_lines:
        parts.append("生活注意事項：" + "；".join(lifestyle_lines))

    if not parts:
        return ""

    return "\n".join(parts) + "\n請考慮以上情境對你投票意願的影響（例如天氣不好可能降低出門投票的意願）。"


async def _predict_votes(
    agents: list[dict],
    final_states: dict,
    poll_opts: list[dict],
    max_choices: int,
    concurrency: int,
    job: dict,
    sampling_modality: str = "unweighted",
    voting_day_context: str = "",
) -> dict[str, float]:
    """Execute LLM call to let agents vote among custom poll options."""
    from .evolver import _call_llm, get_agent_diary

    # Extract candidate names
    candidates = [opt.get("name") for opt in poll_opts if opt.get("name")]
    if not candidates:
        return {}

    import random as _vote_rng

    def _awareness_label(v: float) -> str:
        """Human-readable awareness band for the voting prompt."""
        if v >= 0.85: return f"very familiar ({int(v*100)}%)"
        if v >= 0.70: return f"quite familiar ({int(v*100)}%)"
        if v >= 0.50: return f"reasonably familiar ({int(v*100)}%)"
        if v >= 0.30: return f"vaguely aware ({int(v*100)}%)"
        if v >= 0.15: return f"only heard the name ({int(v*100)}%)"
        return f"never heard of them ({int(v*100)}%)"

    def _sentiment_label(s: float) -> str:
        """Human-readable sentiment band. Range -1.0 ~ +1.0."""
        if s >= 0.5: return f"very positive ({s:+.2f}) — you really like them"
        if s >= 0.2: return f"somewhat positive ({s:+.2f})"
        if s >= 0.05: return f"mildly positive ({s:+.2f})"
        if s > -0.05: return f"neutral ({s:+.2f}) — no strong feelings either way"
        if s > -0.2: return f"mildly negative ({s:+.2f})"
        if s > -0.5: return f"somewhat negative ({s:+.2f})"
        return f"very negative ({s:+.2f}) — you dislike them"

    def _build_cand_details_for_agent(agent_district: str, agent_state: dict | None = None) -> str:
        """Build per-agent candidate profile with BOTH awareness AND sentiment.

        Critical distinction: awareness is "how well does this voter know
        the candidate" — sentiment is "does this voter LIKE the candidate".
        High awareness ≠ favorability! A polished media figure can be
        well-known but disliked due to scandals; a quiet local doctor can
        have low awareness but neutral-to-positive impressions.

        This function exposes BOTH signals to the LLM voter so it can make
        decisions that match real-world voting psychology:
          - high awareness + positive sentiment → likely vote for
          - high awareness + negative sentiment → likely vote against (or undecided)
          - low awareness + any sentiment → fall back to party identification
          - low awareness + strong negative → likely "undecided / heard bad things"

        Returns a multi-line string with one block per candidate, each
        showing 認識程度 + 整體印象 + 簡介 (when awareness is high enough).
        """
        dyn_awareness = (agent_state or {}).get("candidate_awareness", {}) or {}
        dyn_sentiment = (agent_state or {}).get("candidate_sentiment", {}) or {}
        lines = []
        for opt in poll_opts:
            cname = opt.get("name", "")
            desc = opt.get("description", "")
            lv = float(opt.get("localVisibility", opt.get("local_visibility", 50))) / 100.0
            nv = float(opt.get("nationalVisibility", opt.get("national_visibility", 50))) / 100.0
            od_str = str(opt.get("originDistricts", opt.get("origin_districts", "")))
            od_list = [d.strip() for d in od_str.split(",") if d.strip()] if od_str else []
            is_hometown = any(od in agent_district or agent_district in od for od in od_list) if agent_district and od_list else False
            # Prefer evolved awareness; fall back to static visibility setting.
            _dyn = dyn_awareness.get(cname)
            if _dyn is not None:
                try:
                    awareness = float(_dyn)
                except (TypeError, ValueError):
                    awareness = lv if is_hometown else nv
            else:
                awareness = lv if is_hometown else nv
            # Sentiment defaults to 0 (neutral) when no signal accumulated
            try:
                sentiment = float(dyn_sentiment.get(cname, 0.0) or 0.0)
            except (TypeError, ValueError):
                sentiment = 0.0

            # Build per-candidate block: name + awareness + sentiment + bio
            block = [f"[{cname}]"]
            block.append(f"  - Your familiarity with this candidate: {_awareness_label(awareness)}")
            block.append(f"  - Your overall impression of them: {_sentiment_label(sentiment)}")
            # Description visibility: stochastic, gated by awareness
            if _vote_rng.random() < awareness:
                if desc:
                    block.append(f"  - Candidate background: {desc}")
            else:
                block.append(f"  - Candidate background: (You don't know this candidate well, so you don't see the full bio)")
            lines.append("\n".join(block))
        return "\n\n".join(lines)

    _max_ch = max_choices
    _prompt_base = """You are a real American voter. Below is your personal profile and political leaning.
[Personal profile]
{persona_desc}

[Political leaning]
- Your political leaning: {political_leaning}

{long_term_memory}[Your current overall mood]
{semantic_state}

Your recent diary entries (entries marked "latest" are today's mindset; more recent matters more):
{recent_diary}

A poll is being conducted. Here are the options and the information you have about each candidate (**Note: "familiarity" and "impression" are two INDEPENDENT signals — consider them separately**):
{cand_details}

{voting_day_context}[Voting considerations]
- Party labels (Democratic / Republican / Independent) may appear next to candidate names.
- ⚠️ **Familiarity ≠ Favorability**: you may know a candidate very well yet dislike them because of scandals/controversies, or you may have a mildly positive impression of a lesser-known candidate (scattered favorable reports).
- Weight the four factors roughly in this order:
  1. **Overall impression** (sentiment) — the most direct signal
  2. **Party identification** — your alignment with or aversion to the candidate's party
  3. **Familiarity** (awareness) — how well you know the candidate
  4. **Policies / competence / image** — specifics from the bio
- Decision heuristics:
  - High familiarity + positive impression → strong vote for
  - High familiarity + negative impression → **do NOT vote for them** (even if well-known); switch to opponent or answer Undecided
  - Low familiarity + same party → default to party-line vote
  - Low familiarity + different party → Undecided or cross-over to opponent
  - Neutral impression + modest familiarity → follow your party leaning
- In head-to-head polls with two candidates, pick one or answer "Undecided".

You may select at most {max_choices} option(s). Give the honest choice you would make as this voter (you may also answer "Undecided" or "Spoiled ballot").
Return your choice as JSON (array of strings):
{{
  "votes": ["Option 1", "Option 2"]
}}"""

    import asyncio
    sem = asyncio.Semaphore(concurrency)
    _vendor_sems = {}
    votes = []

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

    async def _vote(agent: dict):
        if _pred_stops.get(job["job_id"]):
            job["status"] = "cancelled"
            return

        aid = str(agent.get("person_id", 0))
        state = final_states.get(aid, {})
        sat = state.get("satisfaction", 50)
        anx = state.get("anxiety", 50)
        
        persona_desc = agent.get("user_char", "")
        # Get last 3 diaries
        diaries = get_agent_diary(aid)
        diaries.sort(key=lambda x: x.get("day", 0), reverse=True)
        total_days = len(diaries)
        # Give more text to recent diaries, less to older ones
        recent = diaries[:5]
        recent.reverse()
        diary_lines = []
        for i, d in enumerate(recent):
            day_num = d.get("day", "?")
            text = d.get("diary_text", d.get("todays_diary", ""))
            is_latest = (i == len(recent) - 1)
            # Latest diary: full text; older: progressively shorter
            if is_latest:
                excerpt = text[:400]  # most recent: detailed
                tag = "（最新）"
            elif i >= len(recent) - 2:
                excerpt = text[:200]  # second most recent: moderate
                tag = "（前一天）"
            else:
                excerpt = text[:100]  # older: brief
                tag = ""
            diary_lines.append(f"- 第{day_num}天{tag}: {excerpt}")
        diary_text = "\n".join(diary_lines) if diary_lines else "無特別紀錄"

        political_leaning = agent.get("political_leaning") or "Tossup"
        agent_district = agent.get("district", agent.get("context", {}).get("district", ""))
        cand_details = _build_cand_details_for_agent(agent_district, state)

        _vdc = voting_day_context or ""
        prompt = US_VOTING_PROMPT.format(
            persona_desc=persona_desc,
            political_leaning=political_leaning,
            long_term_memory=_build_long_term_memory(state),
            semantic_state=_build_semantic_state(state),
            recent_diary=diary_text,
            cand_details=cand_details,
            voting_day_context=f"[Voting day context]\n{_vdc}\n\n" if _vdc else "",
            max_choices=_max_ch,
        )

        async with sem:
            try:
                res = await _call_llm(prompt, enabled_vendors=job.get("enabled_vendors"), expected_keys=["votes"])
                selected = res.get("votes", [])
                if isinstance(selected, str):
                    selected = [selected]
            except Exception as e:
                logger.error(f"Vote simulation failed for agent {aid}: {e}")
                selected = []

        # Get sampling weight
        age_str = agent.get("context", {}).get("age", "40")
        weight = _get_sampling_weight(sampling_modality, age_str)

        matched_cands = []
        for choice in selected[:max_choices]:
            for c in candidates:
                if choice in c or c in choice:
                    matched_cands.append(c)
                    break
        
        if not matched_cands:
            matched_cands = ["Undecided"]
            
        votes.append((matched_cands, weight))
        _push_pred_live(job, f"📊 Agent #{aid} (weight {weight}) voted: {', '.join(matched_cands)}")

    await asyncio.gather(*[_vote(a) for a in agents])

    if not votes:
        return {}
        
    counts = {}
    valid_weight = 0.0
    for cand_list, w in votes:
        is_valid = False
        for cand in cand_list:
            if cand in candidates:
                counts[cand] = counts.get(cand, 0.0) + w
                is_valid = True
        # Count agent's valid weight once (e.g. for total voter turnout base)
        valid_weight += w
            
    if valid_weight == 0:
        return {c: 0.0 for c in candidates}
        
    shares = {c: round((counts.get(c, 0) / valid_weight) * 100, 2) for c in candidates}
    return shares


async def _run_llm_satisfaction_survey(
    agents: list[dict],
    final_states: dict,
    poll_groups: list[dict],
    concurrency: int,
    job: dict,
    survey_method: str = "mobile",
) -> dict[str, dict]:
    """Run LLM-based satisfaction survey for each person in each group.

    survey_method: "phone" (市話), "mobile" (手機), "online" (網路), "street" (街頭)
    Each method uses a different approach prompt to simulate realistic survey conditions.

    Returns {group_name: {person_name: {percentages, satisfied_total, ...}}}
    """
    from .evolver import _call_llm, get_agent_diary

    results: dict[str, dict] = {}
    for gi, group in enumerate(poll_groups):
        group_name = group.get("name", f"組別{gi+1}")
        candidates = group.get("candidates", [])
        if not candidates:
            continue

        cand_names = [c.get("name") for c in candidates if c.get("name")]
        if not cand_names:
            continue

        _push_pred_live(job, f"📊 LLM satisfaction survey — {', '.join(cand_names)} ({len(agents)} agents)...")

        # Build candidate descriptions
        cand_desc_map = {}
        for c in candidates:
            cn = c.get("name", "")
            desc = c.get("description", "")
            cand_desc_map[cn] = desc

        # Helper to format awareness/sentiment per agent (mirrors _build_cand_details_for_agent)
        def _aw_label_survey(v: float) -> str:
            if v >= 0.85: return f"非常熟悉（{int(v*100)}%）"
            if v >= 0.70: return f"相當熟悉（{int(v*100)}%）"
            if v >= 0.50: return f"有一定認識（{int(v*100)}%）"
            if v >= 0.30: return f"略有印象（{int(v*100)}%）"
            if v >= 0.15: return f"只聽過名字（{int(v*100)}%）"
            return f"完全沒聽過（{int(v*100)}%）"

        def _se_label_survey(s: float) -> str:
            if s >= 0.5: return f"非常正面（{s:+.2f}）"
            if s >= 0.2: return f"略偏正面（{s:+.2f}）"
            if s >= 0.05: return f"微正面（{s:+.2f}）"
            if s > -0.05: return f"中性（{s:+.2f}）"
            if s > -0.2: return f"微負面（{s:+.2f}）"
            if s > -0.5: return f"略偏負面（{s:+.2f}）"
            return f"非常負面（{s:+.2f}）"

        def _build_cand_list_for_agent(agent_state: dict | None) -> str:
            """Build per-agent candidate list with awareness + sentiment labels."""
            dyn_aw = (agent_state or {}).get("candidate_awareness", {}) or {}
            dyn_se = (agent_state or {}).get("candidate_sentiment", {}) or {}
            blocks = []
            for cn in cand_names:
                desc = cand_desc_map.get(cn, "")
                aw = float(dyn_aw.get(cn, 0.0) or 0.0)
                se = float(dyn_se.get(cn, 0.0) or 0.0)
                lines = [f"- {cn}（{desc}）"]
                lines.append(f"    認識程度：{_aw_label_survey(aw)}")
                lines.append(f"    整體印象：{_se_label_survey(se)}")
                blocks.append("\n".join(lines))
            return "\n".join(blocks)

        # Static fallback used only if agent_state is empty (legacy behavior)
        cand_list_str = "\n".join(
            f"- {cn}（{cand_desc_map.get(cn, '')}）" for cn in cand_names
        )

        # Survey method-specific approach descriptions
        _method_intros = {
            "phone": (
                "現在你家的市話電話響了，接起來是一位民調訪問員。"
                "他語氣禮貌地說：「您好，我們是XXX民調中心，想佔用您幾分鐘時間做一份施政滿意度調查。」\n"
                "【你是接市話的人】你可能會比較客氣、認真回答，也可能覺得被打擾而敷衍。"
            ),
            "mobile": (
                "現在你的手機響了，是一個陌生號碼。接起來是一位民調訪問員。"
                "「您好，打擾了，我們是XXX民調中心，想請教您對幾位政治人物施政表現的看法。」\n"
                "【手機調查】你在外面或正在忙，可能回答比較直接簡短。"
            ),
            "online": (
                "你在滑手機時看到一個網路問卷的連結：「2分鐘填完！您對政治人物施政的看法」。"
                "你點進去，開始填寫。\n"
                "【網路問卷】你可以慢慢想，不受訪問員影響，回答比較反映你真實想法。"
            ),
            "street": (
                "你今天在路上（車站/商圈/市場）被一位拿著平板的訪問員攔住。"
                "「不好意思，可以花一分鐘回答幾個問題嗎？是關於政治人物施政滿意度的調查。」\n"
                "【街頭訪談】面對面，你可能會稍微保守一些，或者因為趕時間而快速回答。"
            ),
        }
        method_intro = _method_intros.get(survey_method, _method_intros["mobile"])
        method_label = {"phone": "市話調查", "mobile": "手機調查", "online": "網路問卷", "street": "街頭訪談"}.get(survey_method, "手機調查")

        _push_pred_live(job, f"📋 Survey method: {method_label}")

        prompt_template = """你是一位真實的台灣市民。以下是你的基本資料：
【基本資料】
{persona_desc}

【政治傾向】{political_leaning}

{long_term_memory}【你目前的整體心態】
{semantic_state}

最近幾天你的生活日記（標注「最新」的是你今天的心態，越近期的越重要）：
{recent_diary}

""" + method_intro + """

「請問您對以下每位政治人物的施政表現，滿不滿意？」

下方每位人物附帶**兩個獨立訊號**，請分別看清楚：
- **認識程度**：你對此人多熟悉（高低不代表好惡）
- **整體印象**：你目前對此人的好感（這才是你「滿不滿意」的主要依據）

{cand_list}

請針對每位人物，從以下五個選項中選一個：
1. 非常滿意
2. 還算滿意
3. 不太滿意
4. 非常不滿意
5. 不知道/未表態

【回答原則】
- ⚠️ 「認識程度」≠「滿意度」：你可能很熟悉某人但不滿意他（如有爭議的名人），也可能對某人不熟所以選「不知道」
- 主要依據「整體印象」訊號 + 你的政治傾向 + 生活經驗綜合判斷
- 如果認識程度很低（&lt;30%），請優先選「不知道/未表態」，除非你的政黨傾向有強烈傾向
- 高認識 + 正面印象 → 「非常滿意」或「還算滿意」
- 高認識 + 負面印象 → 「不太滿意」或「非常不滿意」
- 你的回答應該跟你的日記中表達的心態一致
- 你的回答方式要符合調查情境（市話/手機/網路/街頭）的特性

請以 JSON 回傳：
{{
{json_keys}
}}

每個值只能是以下之一："非常滿意"、"還算滿意"、"不太滿意"、"非常不滿意"、"未表態"
"""

        json_keys = ",\n".join(f'  "{cn}": "你的評價"' for cn in cand_names)

        import asyncio
        sem = asyncio.Semaphore(concurrency)
        agent_responses: list[dict] = []
        progress_count = 0

        async def _survey_one(agent: dict) -> dict | None:
            nonlocal progress_count
            async with sem:
                aid = str(agent.get("person_id", agent.get("id", "")))
                state = final_states.get(aid, {})
                if not state:
                    return None

                leaning = state.get("current_leaning", agent.get("political_leaning", "Tossup"))
                local_sat = state.get("local_satisfaction", state.get("satisfaction", 50))
                national_sat = state.get("national_satisfaction", state.get("satisfaction", 50))
                anxiety = state.get("anxiety", 50)

                # Build persona description
                parts = []
                if agent.get("age"): parts.append(f"{agent['age']}歲")
                if agent.get("gender"): parts.append(agent["gender"])
                if agent.get("district"): parts.append(f"住在{agent['district']}")
                if agent.get("occupation"): parts.append(agent["occupation"])
                if agent.get("education"): parts.append(agent["education"])
                persona_desc = "、".join(parts) if parts else "一般市民"

                try:
                    all_diary = get_agent_diary(int(aid)) if aid.isdigit() else get_agent_diary(aid)
                except (TypeError, ValueError):
                    all_diary = []
                # Recent diaries with recency weighting: latest gets full text, older ones abbreviated
                diary = all_diary[-5:] if all_diary else []
                diary_lines = []
                for di, d in enumerate(diary):
                    text = d.get('content', d.get('todays_diary', d.get('diary_text', '')))
                    day_num = d.get('day', '?')
                    is_latest = (di == len(diary) - 1)
                    if is_latest:
                        excerpt = text[:400]
                        tag = "（最新）"
                    elif di >= len(diary) - 2:
                        excerpt = text[:200]
                        tag = "（前一天）"
                    else:
                        excerpt = text[:100]
                        tag = ""
                    diary_lines.append(f"- 第{day_num}天{tag}: {excerpt}")
                diary_text = "\n".join(diary_lines) or "（最近沒有日記）"

                # Use per-agent candidate list with awareness/sentiment labels
                per_agent_cand_list = _build_cand_list_for_agent(state)
                prompt = prompt_template.format(
                    persona_desc=persona_desc,
                    political_leaning=leaning,
                    long_term_memory=_build_long_term_memory(state),
                    semantic_state=_build_semantic_state(state),
                    recent_diary=diary_text,
                    cand_list=per_agent_cand_list,
                    json_keys=json_keys,
                )

                try:
                    # _call_llm returns parsed dict directly (handles JSON extraction internally)
                    parsed = await _call_llm(
                        prompt,
                        expected_keys=cand_names,
                        temperature_offset=0.2,
                    )
                    if parsed and isinstance(parsed, dict):
                        progress_count += 1
                        if progress_count % 10 == 0:
                            _push_pred_live(job, f"📊 Satisfaction survey progress: {progress_count}/{len(agents)}")
                        return parsed
                except Exception as e:
                    logger.warning(f"[llm-survey] Agent {aid} failed: {e}")
                return None

        tasks = [_survey_one(a) for a in agents]
        agent_responses = await asyncio.gather(*tasks)
        agent_responses = [r for r in agent_responses if r]

        _push_pred_live(job, f"📊 Collected {len(agent_responses)}/{len(agents)} valid responses")

        # Aggregate results per candidate
        valid_levels = {"非常滿意", "還算滿意", "不太滿意", "非常不滿意", "未表態"}
        group_result: dict[str, dict] = {}
        for cn in cand_names:
            counts = {"非常滿意": 0, "還算滿意": 0, "不太滿意": 0, "非常不滿意": 0, "未表態": 0}
            for resp in agent_responses:
                answer = resp.get(cn, "未表態")
                # Normalize
                if "不知道" in str(answer):
                    answer = "未表態"
                if answer not in valid_levels:
                    answer = "未表態"
                counts[answer] += 1

            total = sum(counts.values()) or 1
            pcts = {k: round(v / total * 100, 1) for k, v in counts.items()}
            satisfied = pcts["非常滿意"] + pcts["還算滿意"]
            dissatisfied = pcts["不太滿意"] + pcts["非常不滿意"]

            group_result[cn] = {
                "percentages": pcts,
                "satisfied_total": round(satisfied, 1),
                "dissatisfied_total": round(dissatisfied, 1),
                "undecided_total": pcts["未表態"],
                "total": total,
            }

            _push_pred_live(job, f"  {cn}: Satisfied {satisfied}% / Dissatisfied {dissatisfied}% / Undecided {pcts.get('Undecided', pcts.get('未表態', 0))}%")

        results[group_name] = group_result

    return results


async def _run_llm_voting_for_groups(
    agents: list[dict],
    final_states: dict,
    poll_groups: list[dict],
    max_choices: int,
    concurrency: int,
    job: dict,
    sampling_modality: str = "unweighted",
) -> dict[str, dict[str, float]]:
    """Run LLM-based voting for each poll group. Returns {group_name: {candidate: pct}}."""
    # Build voting day context from weather/lifestyle articles in the news pool
    voting_day_context = _build_voting_day_context(job)

    results: dict[str, dict[str, float]] = {}
    for gi, group in enumerate(poll_groups):
        group_name = group.get("name", f"組別{gi+1}")
        candidates = group.get("candidates", [])
        if not candidates:
            continue
        _push_pred_live(job, f"🗳️ LLM voting — {group_name} ({len(agents)} agents)...")
        group_result = await _predict_votes(
            agents, final_states, candidates, max_choices, concurrency, job, sampling_modality,
            voting_day_context=voting_day_context,
        )
        results[group_name] = group_result
        if group_result:
            top = sorted(group_result.items(), key=lambda x: -x[1])
            parts = [f"{c}:{v}%" for c, v in top[:5]]
            _push_pred_live(job, f"🗳️ {group_name} LLM results: {' | '.join(parts)}")
    return results


# ── Rolling prediction (primary election mode) ───────────────────────

_rolling_jobs: dict[str, dict] = {}


def _compute_news_weight(event_date: str | None, cutoff_date: str) -> float:
    """Compute time-decay weight for background news.

    More recent news gets higher weight:
      0-30 days:   1.0
      31-90 days:  0.7
      91-180 days: 0.4
      181-365 days: 0.2
      >365 days:   0.1
    """
    if not event_date:
        return 0.5  # undated news gets moderate weight
    from datetime import datetime
    try:
        ev = datetime.strptime(event_date[:10], "%Y-%m-%d")
        co = datetime.strptime(cutoff_date[:10], "%Y-%m-%d")
        delta_days = (co - ev).days
        if delta_days < 0:
            return 1.0  # future news (shouldn't happen, but keep full weight)
        if delta_days <= 30:
            return 1.0
        if delta_days <= 90:
            return 0.7
        if delta_days <= 180:
            return 0.4
        if delta_days <= 365:
            return 0.2
        return 0.1
    except (ValueError, TypeError):
        return 0.5


async def init_rolling_prediction(
    pred_id: str,
    agents: list[dict],
    tracked_ids: list[str] | None = None,
    start_background: bool = False,
) -> dict:
    """Initialize rolling prediction with bridge evolution phase.

    Phase 1: Bridge Evolution — run sim_days of evolution using background news
             (distributed by date, same as batch prediction) to bridge the gap
             between calibration snapshot and primary start date.
    Phase 2: Save evolved state as Day 0 baseline for rolling mode.

    If start_background=True, returns job stub immediately and runs in background.
    """

    pred = get_prediction(pred_id)
    if not pred:
        raise FileNotFoundError(f"Prediction not found: {pred_id}")

    job_id = uuid.uuid4().hex[:8]
    rolling_state = pred.get("rolling_state") or {}
    background_cutoff = rolling_state.get("background_cutoff", "2026-03-24")
    sim_days = pred.get("sim_days", 30)

    job = {
        "job_id": job_id,
        "prediction_id": pred_id,
        "type": "rolling",
        "status": "running",
        "current_day": 0,
        "bridge_day": 0,
        "bridge_total": sim_days,
        "started_at": time.time(),
        "scenario_results": [],
        "live_messages": [],
        "daily_results": [],
        "bridge_results": [],
        "scoring_params": pred.get("scoring_params", {}),
        "enabled_vendors": pred.get("enabled_vendors"),
    }
    _rolling_jobs[job_id] = job
    _pred_jobs[job_id] = job

    if start_background:
        # Return immediately, run bridge evolution in background
        asyncio.create_task(_run_rolling_init_bg(job, pred, agents, sim_days, background_cutoff))
        return {"job_id": job_id, "status": "running", "bridge_total": sim_days}

    # Synchronous mode (for direct await)
    await _run_rolling_init_bg(job, pred, agents, sim_days, background_cutoff)
    return job


async def _run_rolling_init_bg(
    job: dict,
    pred: dict,
    agents: list[dict],
    sim_days: int,
    background_cutoff: str,
):
    """Background worker for rolling init: bridge evolution + Day 0 baseline."""
    from .snapshot import restore_snapshot
    from .evolver import evolve_one_day, _load_states
    from .news_pool import replace_pool

    pred_id = job["prediction_id"]

    try:
        # 1. Restore calibration snapshot
        snapshot_id = pred["snapshot_id"]
        try:
            restore_snapshot(snapshot_id)
            _push_pred_live(job, f"📸 Calibration snapshot restored: {snapshot_id}")
        except FileNotFoundError:
            job["status"] = "failed"
            job["error"] = f"Snapshot not found: {snapshot_id}"
            return

        # 1a. Clear calibration diaries & reset days_evolved so prediction starts from D1
        from .evolver import _load_states, _save_states, _save_diaries
        _save_diaries([])  # wipe calibration diary history
        _pred_states = _load_states()
        for _k in _pred_states:
            _pred_states[_k]["days_evolved"] = 0
        _save_states(_pred_states)
        _push_pred_live(job, "🔄 Calibration history cleared, prediction starts from Day 1")

        # 1b. Optionally redistribute agent leanings to match calibration result
        if pred.get("use_calibration_result_leaning", True):
            _redistribute_leaning_by_ground_truth(agents, snapshot_id, pred)
            from .evolver import _load_states as _ld, _save_states as _sv
            _rst = _ld()
            for _ag in agents:
                _aid = str(_ag.get("person_id", ""))
                if _aid and _aid in _rst:
                    _new_ln = _ag.get("political_leaning")
                    if _new_ln:
                        _rst[_aid]["current_leaning"] = _new_ln
                        _rst[_aid]["leaning"] = _new_ln
            _sv(_rst)
            _push_pred_live(job, "🗳️ Initial political leaning distribution reset from election results")

        # 2. Build background news pool
        scenarios = pred.get("scenarios", [])
        all_news_text = "\n".join(s.get("news", "") for s in scenarios)
        background_pool = _build_scenario_pool(all_news_text)

        _push_pred_live(job, f"📰 Loaded {len(background_pool)} background articles (cutoff: {background_cutoff})")
        _push_pred_live(job, f"🔗 Bridge evolution: distributing {len(background_pool)} articles across {sim_days} days")

        # 3. Split pool by date for day-based injection (same as batch prediction)
        dated_items: list[tuple[str, dict]] = []
        undated_items: list[dict] = []
        for item in background_pool:
            d = item.get("event_date")
            if d:
                dated_items.append((d, item))
            else:
                undated_items.append(item)

        # Map real dates → simulation days proportionally
        day_pool_map: dict[int, list[dict]] = {}
        if dated_items:
            dated_items.sort(key=lambda x: x[0])
            unique_dates = sorted(set(d for d, _ in dated_items))
            date_to_day: dict[str, int] = {}
            if len(unique_dates) == 1:
                date_to_day[unique_dates[0]] = 1
            else:
                for idx, dt in enumerate(unique_dates):
                    mapped = 1 + int(idx * (sim_days - 1) / (len(unique_dates) - 1))
                    date_to_day[dt] = min(mapped, sim_days)
            for d, item in dated_items:
                sim_day = date_to_day[d]
                day_pool_map.setdefault(sim_day, []).append(item)

        total_dated = len(dated_items)
        total_undated = len(undated_items)
        _push_pred_live(job, f"📊 News distribution: {total_dated} date-specific, {total_undated} always-visible")

        # 4. Build agent demographics map
        agent_demographics_map: dict[str, dict] = {}
        for a in agents:
            aid = str(a.get("person_id", 0))
            agent_demographics_map[aid] = {
                "leaning": a.get("political_leaning", "Tossup"),
                "district": a.get("district", "Unknown"),
                "gender": a.get("gender", "Unknown"),
                "llm_vendor": a.get("llm_vendor", "Unknown"),
            }

        concurrency = pred.get("concurrency", 6)

        # ═══ Phase 1: Bridge Evolution ═══
        _push_pred_live(job, f"🔗 Starting bridge evolution (0/{sim_days} days)...")
        bridge_results = []

        for day in range(1, sim_days + 1):
            job["bridge_day"] = day
            today_pool = list(undated_items) + day_pool_map.get(day, [])
            today_new = len(day_pool_map.get(day, []))

            entries = await evolve_one_day(
                agents, today_pool, day,
                feed_fn=None, memory_fn=None, job=job, concurrency=concurrency,
            )

            # Compute bridge day summary (lightweight — no full candidate estimate)
            if entries:
                avg_sat = sum(e["satisfaction"] for e in entries) / len(entries)
                avg_anx = sum(e["anxiety"] for e in entries) / len(entries)
            else:
                avg_sat = avg_anx = 50

            bridge_day_record = {
                "bridge_day": day,
                "avg_satisfaction": round(avg_sat, 1),
                "avg_anxiety": round(avg_anx, 1),
                "entries_count": len(entries),
                "new_news_count": today_new,
            }
            bridge_results.append(bridge_day_record)
            job["bridge_results"] = bridge_results

            if day % 5 == 0 or day == sim_days:
                _push_pred_live(job, f"🔗 Bridge Day {day}/{sim_days} — sat:{round(avg_sat,1)} anx:{round(avg_anx,1)} (+{today_new} articles)")

        _push_pred_live(job, f"✅ Bridge evolution complete ({sim_days} days) — agents evolved to primary starting state")

        # ═══ Phase 2: Compute Day 0 Baseline (from bridged state) ═══
        _push_pred_live(job, "📊 Computing Day 0 baseline prediction...")

        # Run one more evolution day to get fresh candidate estimates from the bridged state
        all_pool_for_baseline = list(undated_items)  # just undated context, no new injection
        entries = await evolve_one_day(
            agents, all_pool_for_baseline, sim_days + 1,
            feed_fn=None, memory_fn=None, job=job, concurrency=concurrency,
        )

        day_record = _compute_day_record(entries, 0, agent_demographics_map, pred, job)
        job["daily_results"].append(day_record)
        job["current_day"] = 0

        # 6. Save rolling snapshot (for next day continuation)
        _save_rolling_snapshot(pred_id, 0)

        # 7. Update prediction file
        if "rolling_state" not in pred:
            pred["rolling_state"] = {}
        pred["rolling_state"]["current_day"] = 0
        pred["rolling_state"]["daily_results"] = [day_record]
        pred["rolling_state"]["bridge_results"] = bridge_results
        pred["rolling_state"]["bridge_days"] = sim_days
        pred["rolling_state"]["background_cutoff"] = background_cutoff
        pred["rolling_state"]["background_count"] = len(background_pool)
        pred["rolling_state"]["daily_news"] = {}
        pred["rolling_state"]["job_id"] = job["job_id"]
        pred["status"] = "rolling_active"
        _save_pred(pred)

        job["status"] = "waiting_for_news"
        est = day_record.get("candidate_estimate", {})
        est_str = " | ".join(f"{c}:{v}%" for c, v in est.items() if c != "Undecided") if est else ""
        _push_pred_live(job, f"✅ Day 0 baseline: {est_str}")
        _push_pred_live(job, f"📅 Waiting to inject Day 1 news...")
        logger.info(f"Rolling prediction Day 0 complete (bridged {sim_days} days): {job['job_id']}")

    except Exception as e:
        logger.exception(f"Rolling init failed: {e}")
        job["status"] = "failed"
        job["error"] = str(e)

    return job


async def advance_rolling_day(
    pred_id: str,
    daily_news_text: str,
    agents: list[dict],
) -> dict:
    """Advance one day in rolling prediction: inject new daily news → run simulation."""
    from .evolver import evolve_one_day, _load_states
    from .news_pool import replace_pool

    pred = get_prediction(pred_id)
    if not pred:
        raise FileNotFoundError(f"Prediction not found: {pred_id}")

    rolling_state = pred.get("rolling_state", {})
    current_day = rolling_state.get("current_day", 0)
    next_day = current_day + 1
    background_cutoff = rolling_state.get("background_cutoff", "2026-03-24")
    job_id = rolling_state.get("job_id")

    # Get or create job
    job = _rolling_jobs.get(job_id) or _pred_jobs.get(job_id)
    if not job:
        # Create new job entry
        job_id = uuid.uuid4().hex[:8]
        job = {
            "job_id": job_id,
            "prediction_id": pred_id,
            "type": "rolling",
            "status": "running",
            "current_day": current_day,
            "started_at": time.time(),
            "scenario_results": [],
            "live_messages": [],
            "daily_results": rolling_state.get("daily_results", []),
            "scoring_params": pred.get("scoring_params", {}),
            "enabled_vendors": pred.get("enabled_vendors"),
        }
        _rolling_jobs[job_id] = job
        _pred_jobs[job_id] = job

    job["status"] = "running"
    _push_pred_live(job, f"🔄 Day {next_day}: injecting news and advancing...")

    try:
        # 1. Restore rolling snapshot from previous day
        _restore_rolling_snapshot(pred_id, current_day)
        _push_pred_live(job, f"📸 Restored Day {current_day} state")

        # 2. Build pool: weighted background + all previous daily news + today's new news
        scenarios = pred.get("scenarios", [])
        all_bg_text = "\n".join(s.get("news", "") for s in scenarios)
        background_pool = _build_scenario_pool(all_bg_text)
        for item in background_pool:
            item["news_weight"] = _compute_news_weight(item.get("event_date"), background_cutoff)

        # Add all previous daily news (weight=1.0, already happened)
        prev_daily = rolling_state.get("daily_news", {})
        for day_str, news_text in prev_daily.items():
            for item in _build_scenario_pool(news_text):
                item["news_weight"] = 1.0
                background_pool.append(item)

        # Add today's new news (weight=1.0)
        new_items = _build_scenario_pool(daily_news_text)
        for item in new_items:
            item["news_weight"] = 1.0
        background_pool.extend(new_items)

        replace_pool(background_pool)
        _push_pred_live(job, f"📰 Day {next_day}: background {rolling_state.get('background_count', 0)} + new {len(new_items)} → total {len(background_pool)}")

        # 3. Build agent demographics
        agent_demographics_map: dict[str, dict] = {}
        for a in agents:
            aid = str(a.get("person_id", 0))
            agent_demographics_map[aid] = {
                "leaning": a.get("political_leaning", "Tossup"),
                "district": a.get("district", "Unknown"),
                "gender": a.get("gender", "Unknown"),
                "llm_vendor": a.get("llm_vendor", "Unknown"),
            }

        # 4. Run evolution for 1 day
        concurrency = pred.get("concurrency", 6)
        entries = await evolve_one_day(
            agents, background_pool, next_day + 1,  # day param (1-indexed for evolver)
            feed_fn=None, memory_fn=None, job=job, concurrency=concurrency,
        )

        # 5. Compute day record
        day_record = _compute_day_record(entries, next_day, agent_demographics_map, pred, job)
        job["daily_results"].append(day_record)
        job["current_day"] = next_day

        # 6. Save rolling snapshot
        _save_rolling_snapshot(pred_id, next_day)

        # 7. Update prediction file
        rolling_state["current_day"] = next_day
        rolling_state["daily_news"][str(next_day)] = daily_news_text
        if "daily_results" not in rolling_state:
            rolling_state["daily_results"] = []
        rolling_state["daily_results"].append(day_record)
        rolling_state["job_id"] = job_id
        pred["rolling_state"] = rolling_state
        _save_pred(pred)

        job["status"] = "waiting_for_news"
        est = day_record.get("candidate_estimate", {})
        est_str = " | ".join(f"{c}:{v}%" for c, v in est.items() if c != "Undecided") if est else ""
        _push_pred_live(job, f"✅ Day {next_day} complete: {est_str}")

    except Exception as e:
        logger.exception(f"Rolling advance failed: {e}")
        job["status"] = "failed"
        job["error"] = str(e)

    return job


def get_rolling_history(pred_id: str) -> dict | None:
    """Get rolling prediction timeline data."""
    pred = get_prediction(pred_id)
    if not pred:
        return None
    rolling_state = pred.get("rolling_state", {})
    job_id = rolling_state.get("job_id")
    job = _rolling_jobs.get(job_id) or _pred_jobs.get(job_id)
    return {
        "prediction_id": pred_id,
        "prediction_mode": pred.get("prediction_mode", "batch"),
        "current_day": rolling_state.get("current_day", 0),
        "background_count": rolling_state.get("background_count", 0),
        "background_cutoff": rolling_state.get("background_cutoff"),
        "bridge_days": rolling_state.get("bridge_days", 0),
        "bridge_results": rolling_state.get("bridge_results", []),
        "daily_results": rolling_state.get("daily_results", []),
        "daily_news": rolling_state.get("daily_news", {}),
        "job_id": job_id,
        "job_status": job["status"] if job else None,
        "bridge_day": job.get("bridge_day", 0) if job else 0,
        "bridge_total": job.get("bridge_total", 0) if job else 0,
        "live_messages": job.get("live_messages", []) if job else [],
    }


def _compute_day_record(
    entries: list[dict],
    day: int,
    agent_demographics_map: dict[str, dict],
    pred: dict,
    job: dict,
    news_pool: list[dict] | None = None,
) -> dict:
    """Compute daily statistics and candidate estimates (shared by batch and rolling)."""
    if entries:
        avg_sat = sum(e["satisfaction"] for e in entries) / len(entries)
        avg_anx = sum(e["anxiety"] for e in entries) / len(entries)
    else:
        avg_sat = avg_anx = 50

    # Per-leaning-group stats
    leaning_stats: dict[str, dict] = {}
    sat_buckets = {"0-20": 0, "20-40": 0, "40-60": 0, "60-80": 0, "80-100": 0}
    high_sat_count = 0
    high_anx_count = 0
    for e in entries:
        aid = str(e.get("agent_id", e.get("person_id", "")))
        demographics = agent_demographics_map.get(aid, {})
        leaning = demographics.get("leaning", "Tossup")
        sat = e["satisfaction"]
        anx = e["anxiety"]

        if leaning not in leaning_stats:
            leaning_stats[leaning] = {"sat_sum": 0, "anx_sum": 0, "count": 0}
        leaning_stats[leaning]["sat_sum"] += sat
        leaning_stats[leaning]["anx_sum"] += anx
        leaning_stats[leaning]["count"] += 1

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

    # Heuristic candidate estimate per group (reuse batch logic)
    candidate_estimate: dict[str, float] = {}
    group_estimates: dict[str, dict[str, float]] = {}
    group_leaning_candidate: dict[str, dict[str, dict[str, float]]] = {}
    group_district_candidate: dict[str, dict[str, dict[str, float]]] = {}
    group_gender_candidate: dict[str, dict[str, dict[str, float]]] = {}
    group_vendor_candidate: dict[str, dict[str, dict[str, float]]] = {}

    sp = pred.get("scoring_params", {}) or job.get("scoring_params", {})
    news_impact = sp.get("news_impact", 1.0)
    party_align_bonus = sp.get("party_align_bonus", 15)
    party_base = sp.get("party_base", None)
    incumbency_bonus = sp.get("incumbency_bonus", 12)
    party_divergence_mult = sp.get("party_divergence_mult", 0.5)
    candidate_traits = sp.get("candidate_traits", None)
    profile_match_mult = sp.get("profile_match_mult", 1.5)
    anxiety_sensitivity_mult = sp.get("anxiety_sensitivity_mult", 0.15)

    import re as _re_pred
    _major_kw = ["國民黨", "民進黨", "民主進步黨", "中國國民黨"]
    _minor_kw = ["民眾黨", "台灣民眾黨", "臺灣民眾黨", "時代力量", "台灣基進"]
    _indep_kw = ["無黨", "無所屬", "無黨籍", "未經政黨推薦"]

    def _base_score(desc: str) -> float:
        if any(k in desc for k in _major_kw): return 50.0
        if any(k in desc for k in _minor_kw): return 30.0
        if any(k in desc for k in _indep_kw): return 5.0
        return 30.0

    # Prefer job's poll_groups (can be hot-patched at runtime) over pred's
    daily_groups = job.get("poll_groups") or pred.get("poll_groups", [])
    poll_opts = pred.get("poll_options", [])
    if not daily_groups and poll_opts:
        daily_groups = [{"name": "default", "candidates": poll_opts}]

    _is_satisfaction_mode_cycle = pred.get("prediction_mode") == "satisfaction" or (pred.get("question", "").startswith("滿意度調查"))

    # ══════════════════════════════════════════════════
    # Satisfaction mode: independent 5-level per person (cycle path)
    # ══════════════════════════════════════════════════
    if _is_satisfaction_mode_cycle and daily_groups and entries:
        import random as _sat_rng_c
        for gi, group in enumerate(daily_groups):
            group_name = group.get("name", f"組別{gi+1}")
            group_cands = group.get("candidates", [])
            cand_names = [c.get("name") for c in group_cands if c.get("name")]
            if not cand_names:
                continue

            per_cand_results: dict[str, dict] = {}
            per_cand_leaning: dict[str, dict] = {}

            for ci, cname in enumerate(cand_names):
                desc = group_cands[ci].get("description", "")
                _role_lower = desc.lower()
                is_national = any(k in _role_lower for k in ["總統", "行政院", "中央", "院長", "部長", "國家元首"])
                is_local = any(k in _role_lower for k in ["市長", "縣長", "副市長", "副縣長", "議長", "地方"])
                is_incumbent = group_cands[ci].get("isIncumbent", False) or "現任" in desc

                _cand_party = ""
                if any(k in desc for k in ["國民黨", "藍"]): _cand_party = "kmt"
                elif any(k in desc for k in ["民進黨", "綠"]): _cand_party = "dpp"
                elif any(k in desc for k in ["民眾黨"]): _cand_party = "tpp"

                levels = {"非常滿意": 0, "還算滿意": 0, "不太滿意": 0, "非常不滿意": 0, "未表態": 0}
                leaning_levels: dict[str, dict] = {}

                for e in entries:
                    sat = e.get("satisfaction", 50)
                    local_sat = e.get("local_satisfaction", sat)
                    national_sat = e.get("national_satisfaction", sat)
                    anxiety = e.get("anxiety", 50)
                    leaning = e.get("leaning", "Tossup")
                    cand_sent = (e.get("candidate_sentiment") or {}).get(cname, None)

                    if cand_sent is not None:
                        base_score = 50 + cand_sent * 40
                    elif is_national:
                        base_score = national_sat
                    elif is_local:
                        base_score = local_sat
                    else:
                        base_score = (local_sat + national_sat) / 2

                    if _cand_party == "kmt" and any(x in leaning for x in ["右", "藍", "統"]):
                        base_score += 8
                    elif _cand_party == "kmt" and any(x in leaning for x in ["左", "綠", "獨"]):
                        base_score -= 8
                    elif _cand_party == "dpp" and any(x in leaning for x in ["左", "綠", "獨"]):
                        base_score += 8
                    elif _cand_party == "dpp" and any(x in leaning for x in ["右", "藍", "統"]):
                        base_score -= 8

                    if is_incumbent:
                        base_score += 5

                    _traits = (sp.get("candidate_traits") or {}).get(cname, {})
                    _charm = _traits.get("charm", 0.35)
                    base_score += _charm * (sp.get("charm_mult", 8.0) or 8.0) * 0.3

                    if anxiety > 60:
                        base_score -= (anxiety - 60) * 0.15

                    undecided_prob = sp.get("base_undecided", 0.10)
                    if 42 < base_score < 58:
                        undecided_prob += 0.10
                    if anxiety > 70 and ("中立" in leaning or leaning == "Tossup"):
                        undecided_prob += 0.08
                    undecided_prob = min(sp.get("max_undecided", 0.45), undecided_prob)

                    base_score = max(0, min(100, base_score))
                    if _sat_rng_c.random() < undecided_prob:
                        level = "未表態"
                    elif base_score >= 75:
                        level = "非常滿意"
                    elif base_score >= 55:
                        level = "還算滿意"
                    elif base_score >= 45:
                        level = "還算滿意" if base_score >= 50 else "不太滿意"
                    elif base_score >= 25:
                        level = "不太滿意"
                    else:
                        level = "非常不滿意"

                    levels[level] += 1
                    if leaning not in leaning_levels:
                        leaning_levels[leaning] = {"非常滿意": 0, "還算滿意": 0, "不太滿意": 0, "非常不滿意": 0, "未表態": 0, "_count": 0}
                    leaning_levels[leaning][level] += 1
                    leaning_levels[leaning]["_count"] += 1

                total_resp = sum(levels.values())
                pcts = {k: round(v / max(total_resp, 1) * 100, 1) for k, v in levels.items()}
                satisfied = pcts["非常滿意"] + pcts["還算滿意"]
                dissatisfied = pcts["不太滿意"] + pcts["非常不滿意"]

                per_cand_results[cname] = {
                    "percentages": pcts,
                    "satisfied_total": round(satisfied, 1),
                    "dissatisfied_total": round(dissatisfied, 1),
                    "undecided_total": pcts["未表態"],
                    "total": total_resp,
                }

                lean_bd = {}
                for ln, lv in leaning_levels.items():
                    cnt = lv.pop("_count", 1) or 1
                    lean_bd[ln] = {"total": int(cnt), **{f"{k}_pct": round(v / cnt * 100, 1) for k, v in lv.items()}}
                per_cand_leaning[cname] = lean_bd

            group_estimates[group_name] = per_cand_results
            group_leaning_candidate[group_name] = per_cand_leaning
            if gi == 0:
                candidate_estimate = per_cand_results

    elif daily_groups and entries:
        for gi, group in enumerate(daily_groups):
            group_name = group.get("name", f"組別{gi+1}")
            group_cands = group.get("candidates", [])
            cand_names = [c.get("name") for c in group_cands if c.get("name")]
            if not cand_names:
                continue

            cand_scores: dict[str, float] = {c: 0.0 for c in cand_names}
            cand_scores["Undecided"] = 0.0
            leaning_cand_scores: dict[str, dict[str, float]] = {}
            district_cand_scores: dict[str, dict[str, float]] = {}
            district_cand_counts: dict[str, float] = {}
            gender_cand_scores: dict[str, dict[str, float]] = {}
            gender_cand_counts: dict[str, float] = {}
            vendor_cand_scores: dict[str, dict[str, float]] = {}
            vendor_cand_counts: dict[str, float] = {}
            total_w = 0.0

            # Detect same-party group
            # Detect party from description text (no hardcoded names)
            _gd2 = [cand_names[ci] + "," + (group_cands[ci].get("description") or "") for ci in range(len(cand_names))]
            _gk2 = sum(1 for f in _gd2 if "國民黨" in f or "中國國民黨" in f)
            _gd2_dpp = sum(1 for f in _gd2 if "民進黨" in f or "民主進步黨" in f)
            _same_party2 = (_gk2 == len(cand_names)) or (_gd2_dpp == len(cand_names))

            # Per-group agent filter: only count agents whose leaning matches
            _agent_filter2 = group.get("agentFilter") or {}
            _filter_leanings2 = set(_agent_filter2.get("leanings", []))

            for e in entries:
                aid = str(e.get("agent_id", e.get("person_id", "")))
                demographics = agent_demographics_map.get(aid, {})
                leaning = demographics.get("leaning", "Tossup")
                if _filter_leanings2 and leaning not in _filter_leanings2:
                    continue
                sat = e.get("satisfaction", 50)
                anx = e.get("anxiety", 50)
                ag_local_sat = e.get("local_satisfaction", sat)
                ag_nat_sat = e.get("national_satisfaction", sat)
                ag_district2 = demographics.get("district", "")
                agent_w = 1.0
                scores: dict[str, float] = {}
                for ci, cname in enumerate(cand_names):
                    desc = (group_cands[ci].get("description") or "")
                    # Compute awareness & hometown match
                    _cv_lv2 = float(group_cands[ci].get("localVisibility", group_cands[ci].get("local_visibility", 50))) / 100.0
                    _cv_nv2 = float(group_cands[ci].get("nationalVisibility", group_cands[ci].get("national_visibility", 50))) / 100.0
                    _cv_od2 = str(group_cands[ci].get("originDistricts", group_cands[ci].get("origin_districts", "")))
                    _ol2 = [d.strip() for d in _cv_od2.split(",") if d.strip()] if _cv_od2 else []
                    _hm2 = any(od in ag_district2 or ag_district2 in od for od in _ol2) if ag_district2 and _ol2 else False
                    # Use dynamic awareness from evolution if available
                    _dyn_aw2 = (e.get("candidate_awareness") or {}).get(cname)
                    _aw2 = float(_dyn_aw2) if _dyn_aw2 is not None else (_cv_lv2 if _hm2 else _cv_nv2)
                    _cand_sent = (e.get("candidate_sentiment") or {}).get(cname, 0.0)
                    score = _calculate_heuristic_score(
                        cname, desc, leaning,
                        ag_local_sat, ag_nat_sat, anx,
                        news_impact, party_align_bonus,
                        party_base_override=party_base,
                        incumbency_bonus=incumbency_bonus,
                        party_divergence_mult=party_divergence_mult,
                        candidate_traits=candidate_traits,
                        profile_match_mult=profile_match_mult,
                        keyword_bonus_cap=sp.get("keyword_bonus_cap", 10.0),
                        anxiety_sensitivity_mult=anxiety_sensitivity_mult,
                        same_party_in_group=_same_party2,
                        awareness=_aw2,
                        sentiment=_cand_sent,
                        sentiment_mult=sp.get("sentiment_mult", 0.15),
                        hometown_match=_hm2,
                    )
                    scores[cname] = score

                total_score = sum(scores.values()) or 1.0

                # Undecided probability (same logic as legacy path)
                _base_und = sp.get("base_undecided", 0.25)
                _max_und = sp.get("max_undecided", 0.50)
                _both_unhappy = max(0, (50 - sat) + (50 - (e.get("national_satisfaction", sat)))) / 100
                _sorted_sc = sorted(scores.values(), reverse=True)
                _sc_spread = (_sorted_sc[0] - _sorted_sc[-1]) / max(_sorted_sc[0], 1) if len(_sorted_sc) > 1 else 0.5
                _close_bonus = max(0, 0.15 - _sc_spread) * sp.get("close_race_weight", 0.8)
                _same_bonus = sp.get("same_party_penalty", 0.06) if _same_party2 else 0.0
                undecided_prob = min(_max_und, _base_und + _both_unhappy * 0.25 + _close_bonus + _same_bonus)

                for cname in cand_names:
                    frac = scores.get(cname, 0) / total_score
                    cand_scores[cname] += frac * (1 - undecided_prob) * agent_w

                    if leaning not in leaning_cand_scores:
                        leaning_cand_scores[leaning] = {c: 0.0 for c in cand_names}
                        leaning_cand_scores[leaning]["_count"] = 0.0
                    leaning_cand_scores[leaning][cname] = leaning_cand_scores[leaning].get(cname, 0) + frac * (1 - undecided_prob) * agent_w

                cand_scores["Undecided"] += undecided_prob * agent_w
                total_w += agent_w
                if leaning in leaning_cand_scores:
                    leaning_cand_scores[leaning]["_count"] = leaning_cand_scores[leaning].get("_count", 0) + agent_w

                # Per-district candidate tracking
                _ag_dist = ag_district2 or "未知"
                if _ag_dist not in district_cand_scores:
                    district_cand_scores[_ag_dist] = {c: 0.0 for c in cand_names}
                    district_cand_counts[_ag_dist] = 0.0
                _vote_fracs = {cname: (scores.get(cname, 0) / total_score) * (1 - undecided_prob) * agent_w for cname in cand_names}
                for cname in cand_names:
                    district_cand_scores[_ag_dist][cname] = district_cand_scores[_ag_dist].get(cname, 0) + _vote_fracs[cname]
                district_cand_counts[_ag_dist] += agent_w

                # Per-gender tracking
                _ag_gender = demographics.get("gender", "未知")
                if _ag_gender not in gender_cand_scores:
                    gender_cand_scores[_ag_gender] = {c: 0.0 for c in cand_names}
                    gender_cand_counts[_ag_gender] = 0.0
                for cname in cand_names:
                    gender_cand_scores[_ag_gender][cname] = gender_cand_scores[_ag_gender].get(cname, 0) + _vote_fracs[cname]
                gender_cand_counts[_ag_gender] += agent_w

                # Per-vendor tracking
                _ag_vendor = demographics.get("llm_vendor", "未知")
                if _ag_vendor not in vendor_cand_scores:
                    vendor_cand_scores[_ag_vendor] = {c: 0.0 for c in cand_names}
                    vendor_cand_counts[_ag_vendor] = 0.0
                for cname in cand_names:
                    vendor_cand_scores[_ag_vendor][cname] = vendor_cand_scores[_ag_vendor].get(cname, 0) + _vote_fracs[cname]
                vendor_cand_counts[_ag_vendor] += agent_w

            g_est = {}
            if total_w > 0:
                g_est = {c: round((v / total_w) * 100, 1) for c, v in cand_scores.items()}

            g_lean = {}
            for ln, sc in leaning_cand_scores.items():
                cnt = sc.pop("_count", 1.0) or 1.0
                g_lean[ln] = {c: round((v / cnt) * 100, 1) for c, v in sc.items()}

            g_dist: dict[str, dict[str, float]] = {}
            for dist, sc in district_cand_scores.items():
                cnt = district_cand_counts.get(dist, 1.0) or 1.0
                g_dist[dist] = {c: round((v / cnt) * 100, 1) for c, v in sc.items()}

            g_gender: dict[str, dict[str, float]] = {}
            for gnd, sc in gender_cand_scores.items():
                cnt = gender_cand_counts.get(gnd, 1.0) or 1.0
                g_gender[gnd] = {c: round((v / cnt) * 100, 1) for c, v in sc.items()}

            g_vendor: dict[str, dict[str, float]] = {}
            for vnd, sc in vendor_cand_scores.items():
                cnt = vendor_cand_counts.get(vnd, 1.0) or 1.0
                g_vendor[vnd] = {c: round((v / cnt) * 100, 1) for c, v in sc.items()}

            group_estimates[group_name] = g_est
            group_leaning_candidate[group_name] = g_lean
            group_district_candidate[group_name] = g_dist
            group_gender_candidate[group_name] = g_gender
            group_vendor_candidate[group_name] = g_vendor

            if gi == 0:
                candidate_estimate = g_est

    agent_details = []
    for e in entries:
        aid = str(e.get("agent_id", e.get("person_id", "")))
        agent_details.append({
            "id": aid,
            "satisfaction": round(e.get("satisfaction", 50), 1),
            "anxiety": round(e.get("anxiety", 50), 1),
            "diary": (e.get("diary_text", "") or "")[:100],
            "fed_titles": (e.get("fed_titles", []) or [])[:3],
        })

    # ── Per-candidate news impact tracking ──
    candidate_news_impact: dict[str, list[dict]] = {}
    _article_tracker: dict[str, dict] = {}  # article_id -> {title, candidate_sentiment, agents_exposed}
    for e in entries:
        for i, art_id in enumerate(e.get("fed_articles") or []):
            if not art_id or art_id.startswith("kol-"):
                continue
            titles = e.get("fed_titles") or []
            title = titles[i] if i < len(titles) else ""
            if art_id not in _article_tracker:
                _article_tracker[art_id] = {
                    "title": title,
                    "candidate_sentiment": {},
                    "agents_exposed": 0,
                }
            _article_tracker[art_id]["agents_exposed"] += 1
    # Build article-level candidate_sentiment lookup from news pool
    _pool_sent: dict[str, dict[str, float]] = {}  # article_id -> {candidate: sentiment}
    if news_pool:
        for art in news_pool:
            aid = art.get("article_id", "")
            cs = art.get("candidate_sentiment")
            if aid and cs:
                _pool_sent[aid] = cs
    # Build final structure: use article-level sentiment from pool
    for art_id, tracker in _article_tracker.items():
        art_sent = _pool_sent.get(art_id, {})
        for cand_name, sent_val in art_sent.items():
            if cand_name not in candidate_news_impact:
                candidate_news_impact[cand_name] = []
            candidate_news_impact[cand_name].append({
                "title": tracker["title"],
                "sentiment": round(float(sent_val), 2),
                "agents_exposed": tracker["agents_exposed"],
            })
    # Sort each candidate's articles by absolute sentiment (most impactful first)
    for cand_name in candidate_news_impact:
        candidate_news_impact[cand_name].sort(key=lambda x: abs(x["sentiment"]), reverse=True)
        # Keep top 10 per candidate per day
        candidate_news_impact[cand_name] = candidate_news_impact[cand_name][:10]

    return {
        "day": day,
        "completed_at": time.time(),
        "avg_satisfaction": round(avg_sat, 1),
        "avg_anxiety": round(avg_anx, 1),
        "entries_count": len(entries),
        "by_leaning": by_leaning,
        "sat_distribution": sat_buckets,
        "high_sat_count": high_sat_count,
        "high_anx_count": high_anx_count,
        "agent_details": agent_details,
        "candidate_estimate": candidate_estimate,
        "group_estimates": group_estimates,
        "group_leaning_candidate": group_leaning_candidate,
        "group_district_candidate": group_district_candidate,
        "group_gender_candidate": group_gender_candidate,
        "group_vendor_candidate": group_vendor_candidate,
        "candidate_news_impact": candidate_news_impact,
    }


def _save_rolling_snapshot(pred_id: str, day: int):
    """Save agent states for rolling prediction continuation."""
    from .evolver import _load_states, _load_diaries
    snap_dir = os.path.join(PREDICTIONS_DIR, f"{pred_id}_rolling")
    os.makedirs(snap_dir, exist_ok=True)
    states = _load_states()
    diaries = _load_diaries()
    with open(os.path.join(snap_dir, f"states_day{day}.json"), "w") as f:
        json.dump(states, f, ensure_ascii=False)
    with open(os.path.join(snap_dir, f"diaries_day{day}.json"), "w") as f:
        json.dump(diaries, f, ensure_ascii=False)
    logger.info(f"Rolling snapshot saved: pred={pred_id} day={day}")


def _restore_rolling_snapshot(pred_id: str, day: int):
    """Restore agent states from a rolling snapshot."""
    from .evolver import _save_states, _save_diaries
    snap_dir = os.path.join(PREDICTIONS_DIR, f"{pred_id}_rolling")
    states_path = os.path.join(snap_dir, f"states_day{day}.json")
    diaries_path = os.path.join(snap_dir, f"diaries_day{day}.json")
    if os.path.exists(states_path):
        with open(states_path) as f:
            _save_states(json.load(f))
    if os.path.exists(diaries_path):
        with open(diaries_path) as f:
            _save_diaries(json.load(f))
    logger.info(f"Rolling snapshot restored: pred={pred_id} day={day}")


def _save_pred(pred: dict):
    """Persist updated prediction data to disk."""
    pred_path = os.path.join(PREDICTIONS_DIR, f"{pred['prediction_id']}.json")
    with open(pred_path, "w") as f:
        json.dump(pred, f, ensure_ascii=False, indent=2)


def _build_scenario_pool(news_text: str) -> list[dict]:
    """Convert scenario news text (one headline per line) into news pool items.

    Lines starting with [YYYY-MM-DD] will have their date extracted and stored
    as event_date for day-based injection scheduling.
    """
    import re
    date_pattern = re.compile(r'^\[(\d{4}-\d{2}-\d{2})\]\s*')
    pool = []
    for line in news_text.strip().split("\n"):
        line = line.strip()
        if not line or len(line) < 4:
            continue
        # Try to parse date prefix
        m = date_pattern.match(line)
        event_date = None
        title = line
        if m:
            event_date = m.group(1)
            title = line[m.end():].strip()
            # Also strip summary after " — "
            if " — " in title:
                title = title.split(" — ")[0].strip()
        pool.append({
            "article_id": uuid.uuid4().hex[:8],
            "title": title,
            "summary": "",
            "source_tag": "情境注入",
            "channel": "國內",
            "leaning": "center",
            "crawled_at": time.time(),
            "event_date": event_date,
        })
    return pool


def _push_pred_live(job: dict, msg: str):
    """Push a live message to the prediction job."""
    if "live_messages" not in job:
        job["live_messages"] = []
    job["live_messages"].append({"ts": time.time(), "text": msg})
    if len(job["live_messages"]) > 12:
        job["live_messages"] = job["live_messages"][-12:]

