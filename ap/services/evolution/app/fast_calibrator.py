"""Fast Parameter Calibration Engine.

Uses coordinate descent to optimize heuristic scoring parameters
against historical election ground truth from PostgreSQL.
No LLM calls — runs in seconds.
"""
from __future__ import annotations

import copy
import logging
import math
import re
import time
from typing import Any

logger = logging.getLogger(__name__)

# Parameters to optimize and their search ranges
PARAM_SPEC: list[tuple[str, float, float, float]] = [
    # (name, min, max, default)
    ("party_align_bonus",       0,    30,   15),
    ("incumbency_bonus",        0,    25,   12),
    ("party_divergence_mult",   0,     1,    0.5),
    ("profile_match_mult",      0,     5,    3.0),
    ("stature_cap",             0,    20,   10),
    ("grassroots_cap",          0,    16,    8),
    ("anxiety_sensitivity_mult",0,     0.5,  0.15),
    ("charm_mult",              0,    15,    8.0),
    ("cross_appeal_mult",       0,     1,    0.6),
    ("base_undecided",          0,     0.30, 0.08),
]


def _compute_vote_shares(
    agents: list[dict],
    candidates: list[dict],
    params: dict,
) -> dict[str, float]:
    """Run heuristic scoring for all agents and return vote share percentages.

    candidates: [{name, description}]
    Returns: {candidate_name: vote_share_pct, "不表態": pct}
    """
    from .predictor import _calculate_heuristic_score

    cand_names = [c["name"] for c in candidates]
    cand_descs = [c.get("description", "") for c in candidates]

    # Detect same-party group (by party keywords in description, no hardcoded names)
    kmt_count = sum(1 for i, n in enumerate(cand_names) if "國民黨" in cand_descs[i] or "中國國民黨" in cand_descs[i])
    dpp_count = sum(1 for i, n in enumerate(cand_names) if "民進黨" in cand_descs[i] or "民主進步黨" in cand_descs[i])
    same_party = (kmt_count == len(cand_names)) or (dpp_count == len(cand_names))

    # Extract scoring params
    news_impact = params.get("news_impact", 1.0)
    party_align_bonus = params.get("party_align_bonus", 15)
    incumbency_bonus = params.get("incumbency_bonus", 12)
    party_divergence_mult = params.get("party_divergence_mult", 0.5)
    candidate_traits = params.get("candidate_traits", None)
    profile_match_mult = params.get("profile_match_mult", 3.0)
    stature_cap = params.get("stature_cap", 10.0)
    grassroots_cap = params.get("grassroots_cap", 8.0)
    anxiety_sensitivity_mult = params.get("anxiety_sensitivity_mult", 0.15)
    charm_mult = params.get("charm_mult", 8.0)
    cross_appeal_mult = params.get("cross_appeal_mult", 0.6)
    base_undecided = params.get("base_undecided", 0.08)
    max_undecided = params.get("max_undecided", 0.45)
    close_race_weight = params.get("close_race_weight", 0.8)
    same_party_penalty = params.get("same_party_penalty", 0.06)
    no_match_penalty = params.get("no_match_penalty", 0.08)
    party_base = params.get("party_base", None)

    totals: dict[str, float] = {n: 0.0 for n in cand_names}
    totals["不表態"] = 0.0
    total_w = 0.0

    for agent in agents:
        leaning = agent.get("political_leaning", "中立")
        ag_local_sat = agent.get("local_satisfaction", agent.get("satisfaction", 50))
        ag_nat_sat = agent.get("national_satisfaction", agent.get("satisfaction", 50))
        ag_anx = agent.get("anxiety", 50)

        scores: dict[str, float] = {}
        for ci, cname in enumerate(cand_names):
            desc = cand_descs[ci]
            scores[cname] = _calculate_heuristic_score(
                cname, desc, leaning,
                ag_local_sat, ag_nat_sat, ag_anx,
                news_impact, party_align_bonus,
                party_base_override=party_base,
                incumbency_bonus=incumbency_bonus,
                party_divergence_mult=party_divergence_mult,
                candidate_traits=candidate_traits,
                profile_match_mult=profile_match_mult,
                stature_cap=stature_cap,
                grassroots_cap=grassroots_cap,
                anxiety_sensitivity_mult=anxiety_sensitivity_mult,
                same_party_in_group=same_party,
                charm_mult=charm_mult,
                cross_appeal_mult=cross_appeal_mult,
            )

        total_score = sum(scores.values()) or 1.0

        # Undecided probability (same logic as predictor.py)
        both_unhappy = max(0, (50 - ag_local_sat) + (50 - ag_nat_sat)) / 100
        sorted_scores = sorted(scores.values(), reverse=True)
        score_spread = (sorted_scores[0] - sorted_scores[-1]) / max(sorted_scores[0], 1) if len(sorted_scores) > 1 else 0.5
        close_bonus = max(0, 0.15 - score_spread) * close_race_weight
        sp_bonus = same_party_penalty if same_party else 0.0

        # Agent-party mismatch
        has_match = True
        if any(x in leaning for x in ["藍", "統", "右"]):
            has_match = kmt_count > 0
        elif any(x in leaning for x in ["綠", "本土", "獨", "左"]):
            has_match = dpp_count > 0
        elif any(x in leaning for x in ["白", "中間"]):
            has_match = any("民眾黨" in cand_descs[i] for i in range(len(cand_names)))
        nm_bonus = no_match_penalty if not has_match else 0.0

        undecided_prob = min(max_undecided, base_undecided + both_unhappy * 0.25 + close_bonus + sp_bonus + nm_bonus)

        for cname in cand_names:
            totals[cname] += (scores[cname] / total_score) * (1 - undecided_prob)
        totals["不表態"] += undecided_prob
        total_w += 1.0

    if total_w == 0:
        return {n: 0.0 for n in cand_names}

    return {n: round((v / total_w) * 100, 2) for n, v in totals.items()}


def _compute_mae(predicted: dict[str, float], ground_truth: dict[str, float]) -> float:
    """Compute Mean Absolute Error between predicted and ground truth vote shares.

    ground_truth keys may include party in parentheses: "盧秀燕(中國國民黨)"
    predicted keys are just names: "盧秀燕"
    """
    errors = []
    for gt_key, gt_val in ground_truth.items():
        if gt_key.startswith("__"):
            continue
        if not isinstance(gt_val, (int, float)):
            continue

        # Match predicted key: strip party from gt_key
        gt_name = re.sub(r"[（(].+?[）)]", "", gt_key).strip()
        pred_val = predicted.get(gt_name) or predicted.get(gt_key)

        if pred_val is not None:
            errors.append(abs(float(pred_val) - float(gt_val)))

    return sum(errors) / len(errors) if errors else 999.0


def _simulate_and_score(
    agents: list[dict],
    candidates: list[dict],
    params: dict,
    training_elections: list[dict],
    gt_cache: dict[str, dict],
) -> float:
    """Run heuristic simulation across all training elections and return weighted MAE."""
    total_weighted_mae = 0.0
    total_weight = 0.0

    for te in training_elections:
        te_key = f"{te['election_type']}_{te['ad_year']}_{te['county']}"
        gt = gt_cache.get(te_key)
        if not gt:
            continue

        # Build candidate list from ground truth keys
        te_candidates = []
        for gt_key in gt:
            if gt_key.startswith("__"):
                continue
            name = re.sub(r"[（(].+?[）)]", "", gt_key).strip()
            party_m = re.search(r"[（(](.+?)[）)]", gt_key)
            party = party_m.group(1) if party_m else ""
            te_candidates.append({"name": gt_key, "description": f"{name}、{party}"})

        predicted = _compute_vote_shares(agents, te_candidates, params)
        mae = _compute_mae(predicted, gt)

        weight = te.get("weight", 1.0)
        total_weighted_mae += mae * weight
        total_weight += weight

    return total_weighted_mae / total_weight if total_weight > 0 else 999.0


def run_fast_calibration(
    target_election: dict,
    training_elections: list[dict],
    agents: list[dict],
    current_params: dict,
    candidate_info: list[dict] | None = None,
    grid_resolution: int = 7,
    max_rounds: int = 3,
) -> dict:
    """Run fast parameter calibration using coordinate descent.

    Args:
        target_election: {election_type, ad_year, county}
        training_elections: [{election_type, ad_year, county, weight}]
        agents: list of agent dicts with political_leaning, satisfaction, anxiety
        current_params: current scoring parameter values
        candidate_info: [{name, description}] for target election display
        grid_resolution: number of values to test per parameter per round
        max_rounds: coordinate descent iterations

    Returns:
        {best_params, baseline_mae, optimized_mae, improvement_pct,
         per_election_breakdown, per_candidate_accuracy, elapsed_seconds}
    """
    from . import election_db

    t0 = time.time()

    # Load ground truth for all training elections
    gt_cache: dict[str, dict] = {}
    for te in training_elections:
        te_key = f"{te['election_type']}_{te['ad_year']}_{te['county']}"
        try:
            gt = election_db.build_ground_truth(te["election_type"], te["ad_year"], te["county"])
            if gt:
                gt_cache[te_key] = gt
                logger.info(f"Loaded ground truth: {te_key} → {len(gt) - (1 if '__by_district__' in gt else 0)} candidates")
        except Exception as e:
            logger.warning(f"Failed to load ground truth for {te_key}: {e}")

    if not gt_cache:
        return {"error": "No ground truth data found for any training election"}

    # Compute baseline MAE with current params
    baseline_mae = _simulate_and_score(agents, [], current_params, training_elections, gt_cache)
    logger.info(f"Baseline MAE: {baseline_mae:.2f}%")

    # Coordinate descent
    best_params = dict(current_params)
    best_mae = baseline_mae

    for round_num in range(max_rounds):
        improved_this_round = False

        for param_name, p_min, p_max, p_default in PARAM_SPEC:
            current_val = best_params.get(param_name, p_default)

            # Generate search values centered on current best
            if round_num == 0:
                # First round: cover full range
                values = [p_min + (p_max - p_min) * i / (grid_resolution - 1) for i in range(grid_resolution)]
            else:
                # Subsequent rounds: narrow around current best
                span = (p_max - p_min) / (2 ** round_num)
                lo = max(p_min, current_val - span / 2)
                hi = min(p_max, current_val + span / 2)
                values = [lo + (hi - lo) * i / (grid_resolution - 1) for i in range(grid_resolution)]

            best_val = current_val
            best_val_mae = best_mae

            for v in values:
                trial_params = dict(best_params)
                trial_params[param_name] = v
                mae = _simulate_and_score(agents, [], trial_params, training_elections, gt_cache)
                if mae < best_val_mae:
                    best_val_mae = mae
                    best_val = v

            if best_val != current_val:
                best_params[param_name] = best_val
                best_mae = best_val_mae
                improved_this_round = True

        logger.info(f"Round {round_num + 1}: MAE {best_mae:.2f}% (improved={improved_this_round})")
        if not improved_this_round:
            break

    # Compute per-election breakdown
    per_election = []
    for te in training_elections:
        te_key = f"{te['election_type']}_{te['ad_year']}_{te['county']}"
        gt = gt_cache.get(te_key)
        if not gt:
            continue

        # MAE before
        mae_before = _simulate_and_score(agents, [], current_params, [te], gt_cache)
        # MAE after
        mae_after = _simulate_and_score(agents, [], best_params, [te], gt_cache)

        per_election.append({
            "election_type": te["election_type"],
            "ad_year": te["ad_year"],
            "county": te["county"],
            "weight": te.get("weight", 1.0),
            "mae_before": round(mae_before, 2),
            "mae_after": round(mae_after, 2),
        })

    # Compute per-candidate accuracy for target election
    per_candidate = []
    target_key = f"{target_election['election_type']}_{target_election['ad_year']}_{target_election['county']}"
    target_gt = gt_cache.get(target_key)

    if target_gt:
        # Build candidates from target ground truth
        target_cands = []
        for gt_key in target_gt:
            if gt_key.startswith("__"):
                continue
            name = re.sub(r"[（(].+?[）)]", "", gt_key).strip()
            party_m = re.search(r"[（(](.+?)[）)]", gt_key)
            party = party_m.group(1) if party_m else ""
            # Use user-provided candidate_info descriptions if available
            desc = f"{name}、{party}"
            if candidate_info:
                for ci in candidate_info:
                    if ci["name"] == name or ci["name"] == gt_key:
                        desc = ci.get("description", desc)
                        break
            target_cands.append({"name": gt_key, "description": desc})

        predicted_before = _compute_vote_shares(agents, target_cands, current_params)
        predicted_after = _compute_vote_shares(agents, target_cands, best_params)

        for gt_key, gt_val in target_gt.items():
            if gt_key.startswith("__") or not isinstance(gt_val, (int, float)):
                continue
            gt_name = re.sub(r"[（(].+?[）)]", "", gt_key).strip()
            pred_b = predicted_before.get(gt_key, predicted_before.get(gt_name, 0))
            pred_a = predicted_after.get(gt_key, predicted_after.get(gt_name, 0))
            per_candidate.append({
                "candidate": gt_key,
                "actual": float(gt_val),
                "predicted_before": round(float(pred_b), 2),
                "predicted_after": round(float(pred_a), 2),
                "error_before": round(abs(float(pred_b) - float(gt_val)), 2),
                "error_after": round(abs(float(pred_a) - float(gt_val)), 2),
            })

    # Build param diff
    param_changes = []
    for param_name, p_min, p_max, p_default in PARAM_SPEC:
        old_val = current_params.get(param_name, p_default)
        new_val = best_params.get(param_name, p_default)
        if old_val != new_val:
            param_changes.append({
                "param": param_name,
                "old": round(old_val, 4),
                "new": round(new_val, 4),
                "direction": "up" if new_val > old_val else "down",
            })

    elapsed = round(time.time() - t0, 2)
    improvement = round((1 - best_mae / baseline_mae) * 100, 1) if baseline_mae > 0 else 0

    result = {
        "best_params": {k: round(v, 4) if isinstance(v, float) else v for k, v in best_params.items()},
        "baseline_mae": round(baseline_mae, 2),
        "optimized_mae": round(best_mae, 2),
        "improvement_pct": improvement,
        "param_changes": param_changes,
        "per_election": per_election,
        "per_candidate": per_candidate,
        "rounds_completed": min(max_rounds, round_num + 1) if 'round_num' in dir() else max_rounds,
        "elapsed_seconds": elapsed,
    }

    logger.info(f"Fast calibration complete: MAE {baseline_mae:.2f}% → {best_mae:.2f}% ({improvement:+.1f}%) in {elapsed}s")
    return result
