"""Alignment module — align agent states to election or satisfaction ground truth.

After historical evolution completes, this module adjusts agent states
(current_leaning, satisfaction, anxiety) so that the population distribution
matches real-world election results or survey satisfaction data.

Called by the snapshot/prediction pipeline before branching into prediction scenarios.
"""
from __future__ import annotations

import logging
import random
from typing import Any

logger = logging.getLogger(__name__)

# ── Leaning labels (same as predictor.py) ────────────────────────────

_LEANING_LABELS = ["偏藍", "偏綠", "偏白", "中立"]


# ── Public entry point ───────────────────────────────────────────────

def apply_alignment(
    states: dict[str, dict],
    profiles: list[dict],
    alignment_target: dict,
) -> dict[str, Any]:
    """Align agent states to ground-truth data.

    Args:
        states: {agent_id_str: {satisfaction, local_satisfaction,
                 national_satisfaction, anxiety, current_leaning, ...}}
        profiles: [{person_id, district, ...}, ...]
        alignment_target: {
            "mode": "election" | "satisfaction",
            # election mode:
            "election_type": str,  # e.g. "mayor", "president"
            "ad_year": int,
            "county": str,
            # satisfaction mode:
            "survey_items": [{
                "party": str,           # party name
                "satisfaction_pct": float,
                "role": "local" | "national",
            }, ...]
        }

    Returns:
        {
            "states": states,  # mutated in-place
            "computed_params": {
                "prediction_mode": "election" | "satisfaction",
                "party_base_scores": {name: score},
                "candidates": [...] | "survey_items": [...],
                ...
            }
        }
    """
    mode = alignment_target.get("mode", "election")

    if mode == "election":
        return _align_election(states, profiles, alignment_target)
    elif mode == "satisfaction":
        return _align_satisfaction(states, profiles, alignment_target)
    else:
        raise ValueError(f"Unknown alignment mode: {mode}")


# ── Election alignment ───────────────────────────────────────────────

def _align_election(
    states: dict[str, dict],
    profiles: list[dict],
    target: dict,
) -> dict[str, Any]:
    """Align agents to historical election vote shares."""
    from .election_db import build_ground_truth
    from .predictor import _get_leaning_for_candidate

    election_type = target["election_type"]
    ad_year = target["ad_year"]
    county = target["county"]

    ground_truth = build_ground_truth(election_type, ad_year, county)

    # Separate district data from county-level totals
    by_district: dict[str, dict[str, float]] = ground_truth.pop("__by_district__", {})

    # Build candidate → leaning mapping and county-level vote shares
    candidate_leanings: dict[str, str] = {}
    county_shares: dict[str, float] = {}  # candidate_key → pct
    for cand_key, pct in ground_truth.items():
        candidate_leanings[cand_key] = _get_leaning_for_candidate(cand_key)
        county_shares[cand_key] = pct

    candidates = list(county_shares.keys())
    if not candidates:
        logger.warning("No candidates found for %s/%s/%s", election_type, ad_year, county)
        return {
            "states": states,
            "computed_params": {
                "prediction_mode": "election",
                "party_base_scores": {},
                "candidates": [],
            },
        }

    # Aggregate vote shares by leaning
    leaning_shares: dict[str, float] = {}
    for cand_key, pct in county_shares.items():
        ln = candidate_leanings[cand_key]
        leaning_shares[ln] = leaning_shares.get(ln, 0.0) + pct

    # Build profile lookup: person_id → district
    profile_map: dict[str, str] = {}
    for p in profiles:
        pid = str(p.get("person_id", p.get("agent_id", "")))
        profile_map[pid] = p.get("district", "")

    # ── Step 1: Redistribute current_leaning proportionally to vote shares ──
    agent_ids = list(states.keys())
    total_agents = len(agent_ids)
    if total_agents == 0:
        return {
            "states": states,
            "computed_params": {
                "prediction_mode": "election",
                "party_base_scores": {},
                "candidates": candidates,
            },
        }

    # Calculate target counts per leaning
    target_counts: dict[str, int] = {}
    remaining = total_agents
    sorted_leanings = sorted(leaning_shares.keys(), key=lambda k: leaning_shares[k], reverse=True)
    for i, ln in enumerate(sorted_leanings):
        if i == len(sorted_leanings) - 1:
            target_counts[ln] = remaining  # last one gets the remainder
        else:
            cnt = round(total_agents * leaning_shares[ln] / 100.0)
            target_counts[ln] = cnt
            remaining -= cnt

    # Shuffle and assign leanings to match target distribution
    random.shuffle(agent_ids)
    idx = 0
    for ln, cnt in target_counts.items():
        for _ in range(cnt):
            if idx < total_agents:
                states[agent_ids[idx]]["current_leaning"] = ln
                idx += 1

    # ── Step 2: Adjust satisfaction based on party alignment with local vote shares ──
    for aid in agent_ids:
        st = states[aid]
        agent_leaning = st.get("current_leaning", "中立")
        district = profile_map.get(aid, "")

        # Get district-level shares for this agent's district
        dist_shares = by_district.get(district, county_shares)

        # Compute alignment boost: how well does the agent's leaning match
        # the dominant party in their district?
        aligned_share = 0.0
        total_share = 0.0
        for cand_key, pct in dist_shares.items():
            total_share += pct
            if candidate_leanings.get(cand_key, "中立") == agent_leaning:
                aligned_share += pct

        if total_share > 0:
            alignment_ratio = aligned_share / total_share
        else:
            alignment_ratio = 0.5

        # Agents in majority party → higher satisfaction; minority → lower
        # Scale: alignment_ratio 0→1 maps to satisfaction adjustment -15→+15
        sat_adjustment = (alignment_ratio - 0.5) * 30.0

        local_sat = st.get("local_satisfaction", st.get("satisfaction", 50))
        national_sat = st.get("national_satisfaction", st.get("satisfaction", 50))

        st["local_satisfaction"] = _clamp(local_sat + sat_adjustment * 0.7)
        st["national_satisfaction"] = _clamp(national_sat + sat_adjustment * 0.3)
        st["satisfaction"] = round(
            (st["local_satisfaction"] + st["national_satisfaction"]) / 2
        )

        # ── Step 3: Adjust anxiety based on district competitiveness ──
        # Close race → high anxiety; dominant winner → low anxiety
        if dist_shares:
            sorted_shares = sorted(dist_shares.values(), reverse=True)
            if len(sorted_shares) >= 2:
                margin = sorted_shares[0] - sorted_shares[1]
            else:
                margin = sorted_shares[0] if sorted_shares else 50.0
            # margin 0 (dead heat) → anxiety boost +20; margin 50+ → anxiety -10
            anxiety_adj = 20.0 - (margin * 0.6)
        else:
            anxiety_adj = 0.0

        base_anxiety = st.get("anxiety", 50)
        st["anxiety"] = _clamp(base_anxiety + anxiety_adj)

    # ── Step 4: Compute party_base_scores (vote share normalized to 5-70) ──
    party_base_scores: dict[str, float] = {}
    if county_shares:
        min_pct = min(county_shares.values())
        max_pct = max(county_shares.values())
        pct_range = max_pct - min_pct if max_pct > min_pct else 1.0
        for cand_key, pct in county_shares.items():
            normalized = 5.0 + (pct - min_pct) / pct_range * 65.0
            party_base_scores[cand_key] = round(normalized, 1)

    logger.info(
        "Election alignment applied: %d agents, %d candidates, county=%s",
        total_agents, len(candidates), county,
    )

    return {
        "states": states,
        "computed_params": {
            "prediction_mode": "election",
            "party_base_scores": party_base_scores,
            "candidates": candidates,
            "election_type": election_type,
            "ad_year": ad_year,
            "county": county,
            "leaning_distribution": {
                ln: target_counts.get(ln, 0) for ln in _LEANING_LABELS
            },
        },
    }


# ── Satisfaction alignment ───────────────────────────────────────────

def _align_satisfaction(
    states: dict[str, dict],
    profiles: list[dict],
    target: dict,
) -> dict[str, Any]:
    """Align agents to satisfaction survey data."""
    survey_items: list[dict] = target.get("items", []) or target.get("survey_items", [])
    if not survey_items:
        logger.warning("No survey items provided for satisfaction alignment")
        return {
            "states": states,
            "computed_params": {
                "prediction_mode": "satisfaction",
                "party_base_scores": {},
                "survey_items": [],
            },
        }

    # ── Step 1: Infer political leaning distribution from survey parties ──
    # Each survey item has a party and satisfaction level.
    # Higher satisfaction for a party → more agents should lean that way.
    from .predictor import _get_leaning_for_candidate

    party_sat: dict[str, float] = {}  # party → satisfaction_pct
    party_roles: dict[str, str] = {}  # party → "local" | "national"
    for item in survey_items:
        party = item.get("party", "")
        sat_pct = float(item.get("satisfaction_pct", 50.0))
        role = item.get("role", "national")
        party_sat[party] = sat_pct
        party_roles[party] = role

    # Map parties to leanings
    party_leanings: dict[str, str] = {}
    for party in party_sat:
        party_leanings[party] = _get_leaning_for_candidate(f"({party})")

    # Compute leaning distribution — use realistic baseline with satisfaction adjustment.
    # Even if all survey items are same party (e.g. both DPP), we still need diverse leanings.
    # Base distribution reflects typical Taiwan political landscape.
    leaning_base: dict[str, float] = {"偏綠": 0.35, "偏藍": 0.30, "中立": 0.25, "偏白": 0.10}

    # Adjust based on ruling party satisfaction: high satisfaction → more supporters
    avg_sat = sum(party_sat.values()) / max(len(party_sat), 1)
    unique_leanings = set(party_leanings.values())
    if len(unique_leanings) == 1:
        # All same party — adjust that leaning's share based on satisfaction
        ruling_lean = list(unique_leanings)[0]
        # sat=80% → ruling gets +15%, sat=50% → no change, sat=30% → ruling gets -10%
        boost = (avg_sat - 50) * 0.005
        leaning_base[ruling_lean] = min(0.60, max(0.20, leaning_base.get(ruling_lean, 0.3) + boost))
    else:
        for party, lean in party_leanings.items():
            sat = party_sat[party]
            boost = (sat - 50) * 0.004
            leaning_base[lean] = min(0.55, max(0.15, leaning_base.get(lean, 0.25) + boost))

    # Normalize
    total_weight = sum(leaning_base.values()) or 1.0
    for ln in leaning_base:
        leaning_base[ln] /= total_weight

    # Redistribute agent leanings
    agent_ids = list(states.keys())
    total_agents = len(agent_ids)
    if total_agents == 0:
        return {
            "states": states,
            "computed_params": {
                "prediction_mode": "satisfaction",
                "party_base_scores": {},
                "survey_items": survey_items,
            },
        }

    target_counts: dict[str, int] = {}
    remaining = total_agents
    sorted_leanings = sorted(leaning_base.keys(), key=lambda k: leaning_base[k], reverse=True)
    for i, ln in enumerate(sorted_leanings):
        if i == len(sorted_leanings) - 1:
            target_counts[ln] = remaining
        else:
            cnt = round(total_agents * leaning_base[ln])
            target_counts[ln] = cnt
            remaining -= cnt

    random.shuffle(agent_ids)
    idx = 0
    for ln, cnt in target_counts.items():
        for _ in range(cnt):
            if idx < total_agents:
                states[agent_ids[idx]]["current_leaning"] = ln
                idx += 1

    # ── Step 2: Adjust satisfaction using survey targets with party alignment ──
    # Compute average local and national satisfaction targets
    _local_roles = {"市長", "縣長", "副市長", "副縣長", "議長"}
    _national_roles = {"總統", "行政院長", "院長", "部長"}
    local_targets: list[float] = []
    national_targets: list[float] = []
    for item in survey_items:
        sat_pct = float(item.get("satisfaction_pct", 50.0))
        role = item.get("role", "")
        if role in _local_roles:
            local_targets.append(sat_pct)
        elif role in _national_roles:
            national_targets.append(sat_pct)
        else:
            national_targets.append(sat_pct)

    avg_local_target = sum(local_targets) / len(local_targets) if local_targets else 50.0
    avg_national_target = sum(national_targets) / len(national_targets) if national_targets else 50.0

    # Build party → leaning for alignment boosting
    party_leaning_map: dict[str, str] = {}
    for party in party_sat:
        party_leaning_map[party] = _get_leaning_for_candidate(f"({party})")

    for aid in agent_ids:
        st = states[aid]
        agent_leaning = st.get("current_leaning", "中立")

        # Party alignment booster: if agent leans toward a high-satisfaction party,
        # boost their satisfaction; otherwise dampen it
        alignment_boost = 0.0
        for party, sat_pct in party_sat.items():
            if party_leaning_map.get(party) == agent_leaning:
                # Aligned party: satisfaction above 50 → positive boost
                alignment_boost += (sat_pct - 50.0) * 0.2

        # Apply local satisfaction
        current_local = st.get("local_satisfaction", st.get("satisfaction", 50))
        local_delta = (avg_local_target - current_local) * 0.6 + alignment_boost * 0.7
        st["local_satisfaction"] = _clamp(current_local + local_delta)

        # Apply national satisfaction
        current_national = st.get("national_satisfaction", st.get("satisfaction", 50))
        national_delta = (avg_national_target - current_national) * 0.6 + alignment_boost * 0.3
        st["national_satisfaction"] = _clamp(current_national + national_delta)

        st["satisfaction"] = round(
            (st["local_satisfaction"] + st["national_satisfaction"]) / 2
        )

        # ── Step 3: Adjust anxiety inversely to average satisfaction ──
        avg_sat = st["satisfaction"]
        # High satisfaction → low anxiety; low satisfaction → high anxiety
        target_anxiety = _clamp(100 - avg_sat + random.gauss(0, 5))
        current_anxiety = st.get("anxiety", 50)
        st["anxiety"] = _clamp(current_anxiety + (target_anxiety - current_anxiety) * 0.5)

    # ── Step 4: Compute party_base_scores keyed by person name ──
    # Use satisfaction % directly mapped to 5-70 range (absolute, not relative)
    # 0% sat → 5, 50% sat → 37.5, 100% sat → 70
    party_base_scores: dict[str, float] = {}
    for item in survey_items:
        name = item.get("name", "")
        sat_pct = float(item.get("satisfaction_pct", 50))
        base = 5.0 + sat_pct * 0.65  # 0%→5, 50%→37.5, 100%→70
        party_base_scores[name] = round(base, 1)

    logger.info(
        "Satisfaction alignment applied: %d agents, %d survey items",
        total_agents, len(survey_items),
    )

    return {
        "states": states,
        "computed_params": {
            "prediction_mode": "satisfaction",
            "party_base_scores": party_base_scores,
            "survey_items": survey_items,
            "leaning_distribution": {
                ln: target_counts.get(ln, 0) for ln in _LEANING_LABELS
            },
        },
    }


# ── Helpers ──────────────────────────────────────────────────────────

def _clamp(value: float, lo: int = 0, hi: int = 100) -> int:
    """Clamp and round a value to [lo, hi]."""
    return max(lo, min(hi, round(value)))
