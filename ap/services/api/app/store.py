"""Workspace-based project store.

Each workspace is a directory containing:
  meta.json           - workspace metadata (name, created_at, updated_at)
  sources/            - uploaded file configs as JSON
  results/            - synthesis results, persona results etc.
    synthesis.json    - saved synthesis output
"""
import json
import os
import time
import uuid
from pathlib import Path

DATA_DIR = Path(os.environ.get("CIVATAS_DATA_DIR", "/app/data/projects"))
WS_DIR = DATA_DIR / "workspaces"


# ---------------------------------------------------------------------------
# Workspace CRUD
# ---------------------------------------------------------------------------

def create_workspace(name: str, purpose: str = "election") -> dict:
    """Create a new workspace. Returns metadata.
    
    Args:
        name: Workspace display name
        purpose: One of 'election', 'consumer', 'birth_policy'
    """
    from shared.llm_vendors import get_default_vendor_names, get_default_ratio_str

    ws_id = str(uuid.uuid4())[:8]
    ws_path = WS_DIR / ws_id
    ws_path.mkdir(parents=True, exist_ok=True)
    (ws_path / "sources").mkdir(exist_ok=True)
    (ws_path / "results").mkdir(exist_ok=True)

    meta = {
        "id": ws_id,
        "name": name,
        "purpose": purpose,
        "llm_vendors": get_default_vendor_names(),
        "llm_vendor_ratio": get_default_ratio_str(),
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    (ws_path / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2)
    )
    return meta


def list_workspaces() -> list[dict]:
    """List all workspaces (metadata + source count)."""
    _migrate_legacy()
    if not WS_DIR.exists():
        return []

    result = []
    for d in sorted(WS_DIR.iterdir()):
        if not d.is_dir():
            continue
        meta_path = d / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text())
            sources_dir = d / "sources"
            meta["source_count"] = len(list(sources_dir.glob("*.json"))) if sources_dir.exists() else 0
            meta["has_synthesis"] = (d / "results" / "synthesis.json").exists()
            meta["has_personas"] = (d / "results" / "personas.json").exists()
            result.append(meta)
        except Exception:
            continue
    return result


def get_workspace(ws_id: str) -> dict | None:
    """Get workspace detail including sources list."""
    ws_path = WS_DIR / ws_id
    meta_path = ws_path / "meta.json"
    if not meta_path.exists():
        return None

    meta = json.loads(meta_path.read_text())
    # List sources
    sources = []
    sources_dir = ws_path / "sources"
    if sources_dir.exists():
        for f in sorted(sources_dir.glob("*.json")):
            try:
                data = json.loads(f.read_text())
                # Extract unique values per dimension from joint_tables
                jt_dims: dict[str, list[str]] = {}
                for jt in data.get("joint_tables") or []:
                    for dim_name in jt.get("dim_names", []):
                        if dim_name not in jt_dims:
                            jt_dims[dim_name] = set()
                        for row in jt.get("rows", []):
                            val = row.get(dim_name)
                            if val:
                                jt_dims[dim_name].add(str(val))
                # Convert sets to sorted lists
                jt_dims_list = {k: sorted(v) for k, v in jt_dims.items()}

                sources.append({
                    "id": f.stem,
                    "filename": data.get("_meta", {}).get("filename", f.name),
                    "name": data.get("name", f.stem),
                    "dimension_count": len(data.get("dimensions", {})),
                    "dimensions": data.get("dimensions", {}),
                    "joint_table_dims": jt_dims_list,
                    "district_profiles": data.get("district_profiles"),
                })
            except Exception:
                continue

    meta["sources"] = sources
    meta["has_synthesis"] = (ws_path / "results" / "synthesis.json").exists()
    meta["has_personas"] = (ws_path / "results" / "personas.json").exists()
    return meta


def delete_workspace(ws_id: str) -> bool:
    """Delete a workspace and all its data."""
    ws_path = WS_DIR / ws_id
    if not ws_path.exists():
        return False
    import shutil
    shutil.rmtree(ws_path)
    return True


# ---------------------------------------------------------------------------
# Source management
# ---------------------------------------------------------------------------

def add_source(ws_id: str, filename: str, config_data: dict) -> dict:
    """Save an uploaded file config to a workspace."""
    ws_path = WS_DIR / ws_id
    sources_dir = ws_path / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)

    slug = _slugify(filename)
    source_path = sources_dir / f"{slug}.json"

    metadata = {
        "id": slug,
        "filename": filename,
        "name": config_data.get("name", filename),
        "uploaded_at": time.time(),
    }

    stored = {"_meta": metadata, **config_data}
    source_path.write_text(json.dumps(stored, ensure_ascii=False, indent=2))

    # Update workspace timestamp
    _touch_workspace(ws_id)

    return metadata


def get_source(ws_id: str, source_id: str) -> dict | None:
    """Get full source config."""
    path = WS_DIR / ws_id / "sources" / f"{source_id}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    data.pop("_meta", None)
    return data


def delete_source(ws_id: str, source_id: str) -> bool:
    """Delete a source from workspace."""
    path = WS_DIR / ws_id / "sources" / f"{source_id}.json"
    if path.exists():
        path.unlink()
        _touch_workspace(ws_id)
        return True
    return False


# ---------------------------------------------------------------------------
# Merged config (merge all sources in workspace)
# ---------------------------------------------------------------------------

def get_merged_config(ws_id: str) -> dict | None:
    """Merge all source configs in a workspace into one."""
    sources_dir = WS_DIR / ws_id / "sources"
    if not sources_dir.exists():
        return None

    source_files = []
    all_configs = []
    for f in sorted(sources_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            data.pop("_meta", None)
            source_files.append(data.get("name", f.stem))
            all_configs.append(data)
        except Exception:
            continue

    if not all_configs:
        return None

    # Simple merge: combine all dimensions and joint tables
    merged_dims = {}
    all_joint_tables = []
    merged_district_profiles = {}
    for config in all_configs:
        for k, v in config.get("dimensions", {}).items():
            # Keep dimension with more categories (finer granularity)
            if k in merged_dims:
                existing_count = len(
                    (merged_dims[k].get("categories") or []) +
                    (merged_dims[k].get("bins") or [])
                )
                new_count = len(
                    (v.get("categories") or []) +
                    (v.get("bins") or [])
                )
                if new_count > existing_count:
                    merged_dims[k] = v
            else:
                merged_dims[k] = v
        for jt in config.get("joint_tables") or []:
            all_joint_tables.append(jt)
        # Merge district_profiles: keep the one with more dimensions per district
        for dist_name, profile in (config.get("district_profiles") or {}).items():
            if dist_name in merged_district_profiles:
                existing_dim_count = len(merged_district_profiles[dist_name].get("dimensions", {}))
                new_dim_count = len(profile.get("dimensions", {}))
                if new_dim_count > existing_dim_count:
                    merged_district_profiles[dist_name] = profile
            else:
                merged_district_profiles[dist_name] = profile

    # Extract region from first source that has one
    region = ""
    for config in all_configs:
        if config.get("region"):
            region = config["region"]
            break

    result = {
        "name": "合併資料集",
        "locale": "zh-TW",
        "dimensions": merged_dims,
        "district_profiles": merged_district_profiles,
        "joint_tables": all_joint_tables,
        "source_files": source_files,
        "dimension_count": len(merged_dims),
    }
    if region:
        result["region"] = region
    return result


# ---------------------------------------------------------------------------
# Synthesis results
# ---------------------------------------------------------------------------

def save_synthesis_result(ws_id: str, result: dict) -> None:
    """Save synthesis result to workspace."""
    results_dir = WS_DIR / ws_id / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    path = results_dir / "synthesis.json"
    path.write_text(json.dumps(result, ensure_ascii=False))
    _touch_workspace(ws_id)


def get_synthesis_result(ws_id: str) -> dict | None:
    """Get saved synthesis result."""
    path = WS_DIR / ws_id / "results" / "synthesis.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


def save_persona_result(ws_id: str, result: dict) -> None:
    """Save persona generation result to workspace."""
    results_dir = WS_DIR / ws_id / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    path = results_dir / "personas.json"
    path.write_text(json.dumps(result, ensure_ascii=False))
    _touch_workspace(ws_id)


def get_persona_result(ws_id: str) -> dict | None:
    """Get saved persona results."""
    path = WS_DIR / ws_id / "results" / "personas.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# Persona Snapshots
# ---------------------------------------------------------------------------

def _compute_persona_stats(agents: list[dict]) -> dict:
    """Extract summary statistics from an agents list for snapshot metadata."""
    vendor_counts: dict[str, int] = {}
    gender_counts: dict[str, int] = {}
    leaning_counts: dict[str, int] = {}
    districts: set[str] = set()
    strategies: set[str] = set()

    for a in agents:
        v = a.get("llm_vendor", "未知")
        vendor_counts[v] = vendor_counts.get(v, 0) + 1
        g = a.get("gender", "未知")
        gender_counts[g] = gender_counts.get(g, 0) + 1
        l = a.get("political_leaning", "未知")
        leaning_counts[l] = leaning_counts.get(l, 0) + 1
        d = a.get("district", "")
        if d:
            districts.add(d)
        lv = a.get("llm_vendor", "")
        if lv == "template":
            strategies.add("template")
        elif lv:
            strategies.add("llm")

    return {
        "agent_count": len(agents),
        "strategy": "/".join(sorted(strategies)) or "unknown",
        "llm_vendors": vendor_counts,
        "gender_dist": gender_counts,
        "leaning_dist": leaning_counts,
        "district_count": len(districts),
    }


def save_persona_snapshot(ws_id: str, name: str, description: str = "") -> dict:
    """Save current personas.json as a named snapshot."""
    current = get_persona_result(ws_id)
    if not current or not current.get("agents"):
        raise ValueError("目前沒有已生成的 Persona 可存檔")

    agents = current["agents"]
    stats = _compute_persona_stats(agents)

    snap_dir = WS_DIR / ws_id / "results" / "persona_snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)

    snapshot_id = str(uuid.uuid4())[:8]
    snapshot = {
        "snapshot_id": snapshot_id,
        "name": name,
        "description": description,
        "created_at": time.time(),
        **stats,
        "agents": agents,
    }
    (snap_dir / f"{snapshot_id}.json").write_text(
        json.dumps(snapshot, ensure_ascii=False)
    )
    return {k: v for k, v in snapshot.items() if k != "agents"}


def list_persona_snapshots(ws_id: str) -> list[dict]:
    """List all persona snapshots (metadata only, no agents)."""
    snap_dir = WS_DIR / ws_id / "results" / "persona_snapshots"
    if not snap_dir.exists():
        return []

    snapshots = []
    for f in sorted(snap_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(f.read_text())
            meta = {k: v for k, v in data.items() if k != "agents"}
            snapshots.append(meta)
        except Exception:
            continue
    return snapshots


def get_persona_snapshot(ws_id: str, snapshot_id: str) -> dict | None:
    """Get full snapshot data including agents."""
    path = WS_DIR / ws_id / "results" / "persona_snapshots" / f"{snapshot_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


def load_persona_snapshot(ws_id: str, snapshot_id: str) -> dict | None:
    """Load a snapshot as the current persona result."""
    snapshot = get_persona_snapshot(ws_id, snapshot_id)
    if not snapshot or not snapshot.get("agents"):
        return None

    result = {"count": len(snapshot["agents"]), "agents": snapshot["agents"]}
    save_persona_result(ws_id, result)
    return {"loaded": snapshot_id, "count": result["count"]}


def delete_persona_snapshot(ws_id: str, snapshot_id: str) -> bool:
    """Delete a persona snapshot."""
    path = WS_DIR / ws_id / "results" / "persona_snapshots" / f"{snapshot_id}.json"
    if path.exists():
        path.unlink()
        return True
    return False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slugify(name: str) -> str:
    """Convert a filename to a URL-safe slug."""
    import re
    name = re.sub(r"\.(json|csv|xlsx|xls|tsv)$", "", name, flags=re.IGNORECASE)
    slug = re.sub(r"[^\w\u4e00-\u9fff\u3400-\u4dbf-]", "_", name)
    slug = re.sub(r"_+", "_", slug).strip("_")
    return slug or "unnamed"


# ---------------------------------------------------------------------------
# LLM Vendor Config
# ---------------------------------------------------------------------------

def get_workspace_llm_config(ws_id: str) -> dict:
    """Get workspace LLM vendor config, falling back to env defaults."""
    from shared.llm_vendors import get_default_vendor_names, get_default_ratio_str, get_available_vendors

    meta_path = WS_DIR / ws_id / "meta.json"
    vendors = get_default_vendor_names()
    ratio = get_default_ratio_str()

    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        vendors = meta.get("llm_vendors", vendors)
        ratio = meta.get("llm_vendor_ratio", ratio)

    return {
        "vendors": vendors,
        "ratio": ratio,
        "available": get_available_vendors(),
    }


def update_workspace_llm_config(ws_id: str, vendors: list[str], ratio: str) -> dict:
    """Update workspace LLM vendor config."""
    meta_path = WS_DIR / ws_id / "meta.json"
    if not meta_path.exists():
        return {}
    meta = json.loads(meta_path.read_text())
    meta["llm_vendors"] = vendors
    meta["llm_vendor_ratio"] = ratio
    meta["updated_at"] = time.time()
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    return {"vendors": vendors, "ratio": ratio}


def get_workspace_ui_settings(ws_id: str, panel: str) -> dict:
    """Get persisted UI settings for a specific panel in a workspace."""
    meta_path = WS_DIR / ws_id / "meta.json"
    if not meta_path.exists():
        return {}
    meta = json.loads(meta_path.read_text())
    return meta.get("ui_settings", {}).get(panel, {})


def update_workspace_ui_settings(ws_id: str, panel: str, settings: dict) -> dict:
    """Persist UI settings for a specific panel in a workspace."""
    meta_path = WS_DIR / ws_id / "meta.json"
    if not meta_path.exists():
        return {}
    meta = json.loads(meta_path.read_text())
    if "ui_settings" not in meta:
        meta["ui_settings"] = {}
    meta["ui_settings"][panel] = settings
    meta["updated_at"] = time.time()
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    return settings


def _touch_workspace(ws_id: str) -> None:
    """Update workspace timestamp."""
    meta_path = WS_DIR / ws_id / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        meta["updated_at"] = time.time()
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))


def _migrate_legacy() -> None:
    """One-time migration: move old /data/projects/*.json to a default workspace."""
    if not DATA_DIR.exists():
        return
    # Check for legacy files (JSON files directly in DATA_DIR)
    legacy_files = list(DATA_DIR.glob("*.json"))
    if not legacy_files:
        return

    # Create default workspace
    WS_DIR.mkdir(parents=True, exist_ok=True)
    default_ws = WS_DIR / "default"
    if default_ws.exists():
        return  # Already migrated

    default_ws.mkdir(exist_ok=True)
    (default_ws / "sources").mkdir(exist_ok=True)
    (default_ws / "results").mkdir(exist_ok=True)

    meta = {
        "id": "default",
        "name": "預設專案",
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    (default_ws / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2)
    )

    # Move legacy files to default workspace sources
    for f in legacy_files:
        dest = default_ws / "sources" / f.name
        f.rename(dest)
