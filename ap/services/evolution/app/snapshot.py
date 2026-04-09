"""Agent state snapshot: save & restore for calibration/prediction branching.

A snapshot captures the full state of all agents at a point in time,
including their satisfaction/anxiety scores and diary entries.
This enables the calibration→prediction workflow:
  1. Run calibration → get agents to a validated state
  2. Save snapshot
  3. Branch from snapshot for each prediction scenario
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import time
import uuid

logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
SNAPSHOTS_DIR = os.path.join(DATA_DIR, "snapshots")


def _ensure_dir():
    os.makedirs(SNAPSHOTS_DIR, exist_ok=True)


def save_snapshot(
    name: str,
    description: str = "",
    calibration_pack_id: str | None = None,
    workspace_id: str = "",
    alignment_target: dict | None = None,
) -> dict:
    """Save the current agent states + diaries as a named snapshot.

    Returns snapshot metadata.
    """
    from .evolver import _load_states, _load_diaries, _load_history, _load_profiles

    _ensure_dir()
    snap_id = uuid.uuid4().hex[:8]
    snap_dir = os.path.join(SNAPSHOTS_DIR, snap_id)
    os.makedirs(snap_dir, exist_ok=True)

    # Copy current state files into snapshot directory
    states = _load_states()
    diaries = _load_diaries()
    history = _load_history()
    profiles = _load_profiles()

    with open(os.path.join(snap_dir, "agent_states.json"), "w") as f:
        json.dump(states, f, ensure_ascii=False, indent=2)
    with open(os.path.join(snap_dir, "diaries.json"), "w") as f:
        json.dump(diaries, f, ensure_ascii=False, indent=2)
    with open(os.path.join(snap_dir, "evolution_history.json"), "w") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)
    with open(os.path.join(snap_dir, "agent_profiles.json"), "w") as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)

    meta = {
        "snapshot_id": snap_id,
        "name": name,
        "description": description,
        "calibration_pack_id": calibration_pack_id,
        "workspace_id": workspace_id,
        "agent_count": len(states),
        "diary_count": len(diaries),
        "history_days": len(history),
        "profiles_count": len(profiles),
        "created_at": time.time(),
        "alignment_target": alignment_target,
    }
    with open(os.path.join(snap_dir, "meta.json"), "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    logger.info(f"Snapshot saved: {snap_id} ({name}), {len(states)} agents, {len(diaries)} diaries")
    return meta


def restore_snapshot(snapshot_id: str) -> dict:
    """Restore agent states + diaries from a snapshot.

    This replaces the current global state with the snapshot's state.
    Returns the snapshot metadata.
    """
    from .evolver import _save_states, _save_diaries, _save_history, _save_profiles

    snap_dir = os.path.join(SNAPSHOTS_DIR, snapshot_id)
    meta_path = os.path.join(snap_dir, "meta.json")

    if not os.path.exists(meta_path):
        raise FileNotFoundError(f"Snapshot not found: {snapshot_id}")

    with open(meta_path) as f:
        meta = json.load(f)

    # Restore states
    states_path = os.path.join(snap_dir, "agent_states.json")
    if os.path.exists(states_path):
        with open(states_path) as f:
            states = json.load(f)
        _save_states(states)

    # Restore diaries
    diaries_path = os.path.join(snap_dir, "diaries.json")
    if os.path.exists(diaries_path):
        with open(diaries_path) as f:
            diaries = json.load(f)
        _save_diaries(diaries)

    # Restore history
    history_path = os.path.join(snap_dir, "evolution_history.json")
    if os.path.exists(history_path):
        with open(history_path) as f:
            history = json.load(f)
        _save_history(history)

    # Restore profiles
    profiles_path = os.path.join(snap_dir, "agent_profiles.json")
    if os.path.exists(profiles_path):
        with open(profiles_path) as f:
            profiles = json.load(f)
        _save_profiles(profiles)
    else:
        _save_profiles({})

    logger.info(f"Snapshot restored: {snapshot_id} ({meta.get('name', '')})")
    return meta


def list_snapshots() -> list[dict]:
    """List all available snapshots, newest first."""
    _ensure_dir()
    results = []
    for entry in os.listdir(SNAPSHOTS_DIR):
        meta_path = os.path.join(SNAPSHOTS_DIR, entry, "meta.json")
        if os.path.isfile(meta_path):
            try:
                with open(meta_path) as f:
                    meta = json.load(f)
                results.append(meta)
            except Exception:
                continue

    # Sort by created_at descending
    results.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return results


def get_snapshot(snapshot_id: str) -> dict | None:
    """Get metadata for a specific snapshot."""
    meta_path = os.path.join(SNAPSHOTS_DIR, snapshot_id, "meta.json")
    if not os.path.isfile(meta_path):
        return None
    with open(meta_path) as f:
        return json.load(f)


def delete_snapshot(snapshot_id: str) -> bool:
    """Delete a snapshot."""
    snap_dir = os.path.join(SNAPSHOTS_DIR, snapshot_id)
    if not os.path.isdir(snap_dir):
        return False
    shutil.rmtree(snap_dir)
    logger.info(f"Snapshot deleted: {snapshot_id}")
    return True
