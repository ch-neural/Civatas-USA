"""Workspace management routes."""
from fastapi import APIRouter, UploadFile, File
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import httpx

from ..store import (
    create_workspace,
    list_workspaces,
    get_workspace,
    delete_workspace,
    add_source,
    delete_source,
    get_merged_config,
    save_synthesis_result,
    get_synthesis_result,
    save_persona_result,
    get_persona_result,
    get_workspace_llm_config,
    update_workspace_llm_config,
    save_persona_snapshot,
    list_persona_snapshots,
    get_persona_snapshot,
    load_persona_snapshot,
    delete_persona_snapshot,
    get_workspace_ui_settings,
    update_workspace_ui_settings,
)

router = APIRouter()

INGESTION_URL = "http://ingestion:8000"
SYNTHESIS_URL = "http://synthesis:8000"
PERSONA_URL = "http://persona:8000"
EVOLUTION_URL = "http://evolution:8000"


class CreateWorkspaceRequest(BaseModel):
    name: str
    purpose: str = "election"


class SynthesizeRequest(BaseModel):
    target_count: int = 50
    filters: dict[str, list[str]] = {}
    selected_dimensions: list[str] | None = None
    age_min: int | None = None  # e.g. 20 — filter generated persons to this age range
    age_max: int | None = None  # e.g. 80

class GeneratePersonaRequest(BaseModel):
    strategy: str = "template"
    concurrency: int = 0  # 0 = auto (enabled_vendors × 2)


# ---------------------------------------------------------------------------
# Workspace CRUD
# ---------------------------------------------------------------------------

@router.get("")
async def api_list_workspaces():
    """List all workspaces."""
    return {"workspaces": list_workspaces()}


@router.get("/preset-sources")
async def api_get_preset_sources():
    """List available preset data sources, organized by category (folder)."""
    from pathlib import Path
    presets_dir = Path(__file__).parent.parent / "defaults" / "presets"
    if not presets_dir.exists():
        return {"categories": []}

    categories = []
    for cat_dir in sorted(presets_dir.iterdir()):
        if not cat_dir.is_dir():
            continue
        items = []
        for f in sorted(cat_dir.iterdir()):
            if f.is_file() and f.suffix.lower() in (".json", ".csv", ".tsv", ".txt", ".xlsx", ".xls", ".ods"):
                # Clean up display name: remove timestamp suffix like _20260321173909
                import re
                display = re.sub(r"_\d{14}$", "", f.stem)
                items.append({
                    "id": f"{cat_dir.name}/{f.name}",
                    "name": display,
                    "filename": f.name,
                })
        if items:
            categories.append({
                "category": cat_dir.name,
                "presets": items,
            })

    return {"categories": categories}


@router.get("/preset-sources/{category}/{filename}")
async def api_get_preset_source_detail(category: str, filename: str):
    """Get the parsed dimensions of a preset file for preview purposes."""
    from pathlib import Path
    import json
    import httpx
    import urllib.parse
    
    preset_path = Path(__file__).parent.parent / "defaults" / "presets" / category / urllib.parse.unquote(filename)
    if not preset_path.exists():
        return JSONResponse(status_code=404, content={"error": "預設資料包不存在"})
        
    # Read the file and pass to ingestion service parsing as if uploaded
    content = preset_path.read_bytes()
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(
            f"{INGESTION_URL}/parse",
            files={"file": (preset_path.name, content)},
        )
        
    if resp.status_code != 200:
        return JSONResponse(
            status_code=resp.status_code,
            content={"error": f"解析失敗: {resp.text[:200]}"},
        )
        
    config_data = resp.json()
    return config_data


@router.post("")
async def api_create_workspace(req: CreateWorkspaceRequest):
    """Create a new workspace."""
    meta = create_workspace(req.name, req.purpose)
    return meta


@router.get("/{ws_id}")
async def api_get_workspace(ws_id: str):
    """Get workspace details including sources."""
    ws = get_workspace(ws_id)
    if ws is None:
        return JSONResponse(status_code=404, content={"error": "專案不存在"})
    return ws


@router.delete("/{ws_id}")
async def api_delete_workspace(ws_id: str):
    """Delete workspace and all its data."""
    if not delete_workspace(ws_id):
        return JSONResponse(status_code=404, content={"error": "專案不存在"})
    return {"deleted": ws_id}


# ---------------------------------------------------------------------------
# Source management (upload to workspace)
# ---------------------------------------------------------------------------


@router.post("/{ws_id}/upload")
async def api_upload_to_workspace(ws_id: str, file: UploadFile = File(...)):
    """Upload a file to a workspace → parse → save."""
    # Verify workspace exists
    ws = get_workspace(ws_id)
    if ws is None:
        return JSONResponse(status_code=404, content={"error": "專案不存在"})

    content = await file.read()
    filename = file.filename or "unnamed"

    # Call ingestion service to parse
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(
            f"{INGESTION_URL}/parse",
            files={"file": (filename, content)},
        )

    if resp.status_code != 200:
        return JSONResponse(
            status_code=resp.status_code,
            content={"error": f"解析失敗: {resp.text[:200]}"},
        )

    config_data = resp.json()

    # Save to workspace
    meta = add_source(ws_id, filename, config_data)
    return {**meta, "dimensions": list(config_data.get("dimensions", {}).keys())}


@router.post("/{ws_id}/apply-template")
async def api_apply_template(ws_id: str, name: str):
    """Apply a built-in demographic template (e.g. presidential_state_PA) to a
    workspace as a source.

    The template JSON is read from /data/templates/{name}.json directly and
    saved as a workspace source — no transformation needed because the
    template schema already matches ProjectConfig (dimensions + region +
    locale + target_count).
    """
    import json as _json
    import os as _os
    from pathlib import Path as _Path

    ws = get_workspace(ws_id)
    if ws is None:
        return JSONResponse(status_code=404, content={"error": "workspace not found"})

    templates_dir = _Path("/data/templates")
    template_path = templates_dir / f"{name}.json"
    if not template_path.is_file():
        return JSONResponse(
            status_code=404,
            content={"error": f"template '{name}' not found in {templates_dir}"},
        )

    config_data = _json.loads(template_path.read_text())
    filename = f"template_{name}.json"

    # Remove any other census/template sources from this workspace so we
    # don't mix Taiwan and US data.
    sources_dir = _Path(_os.environ.get("CIVATAS_DATA_DIR", "/data/projects")) / "workspaces" / ws_id / "sources"
    if sources_dir.is_dir():
        for existing in sources_dir.iterdir():
            if (existing.name.startswith("census_") or existing.name.startswith("template_")) \
                    and existing.suffix == ".json" and existing.name != filename:
                existing.unlink()

    meta = add_source(ws_id, filename, config_data)
    return {
        **meta,
        "dimensions": list(config_data.get("dimensions", {}).keys()),
        "region": config_data.get("region", ""),
        "locale": config_data.get("locale", ""),
    }


@router.post("/{ws_id}/apply-census")
async def api_apply_census(ws_id: str, payload: dict):
    """Build ProjectConfig from census DB and save as workspace source."""
    ws = get_workspace(ws_id)
    if ws is None:
        return JSONResponse(status_code=404, content={"error": "專案不存在"})

    county = payload.get("county", "")
    if not county:
        return JSONResponse(status_code=400, content={"error": "county is required"})

    # Call evolution service to build config from census DB
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/election-db/build-config", json=payload)

    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())

    config_data = resp.json()
    ad_year = payload.get("ad_year", 2020)
    filename = f"census_{county}_{ad_year}.json"

    # Remove any existing census sources from this workspace (avoid mixing counties)
    from pathlib import Path as _Path
    import os as _os
    _sources_dir = _Path(_os.environ.get("CIVATAS_DATA_DIR", "/data/projects")) / "workspaces" / ws_id / "sources"
    if _sources_dir.is_dir():
        for existing in _sources_dir.iterdir():
            if existing.name.startswith("census_") and existing.suffix == ".json" and existing.name != filename:
                existing.unlink()


    # Save to workspace (same as upload flow)
    meta = add_source(ws_id, filename, config_data)
    return {
        **meta,
        "dimensions": list(config_data.get("dimensions", {}).keys()),
        "districts": len(config_data.get("district_profiles", {})),
    }


@router.post("/{ws_id}/upload-preset")
async def api_upload_preset_to_workspace(ws_id: str, preset_id: str):
    """Load a preset file into a workspace as a source.
    
    preset_id format: 'category_folder/filename'
    """
    from pathlib import Path
    
    presets_dir = Path(__file__).parent.parent / "defaults" / "presets"
    filepath = presets_dir / preset_id
    
    if not filepath.exists() or not filepath.is_file():
        return JSONResponse(status_code=404, content={"error": "預設資料包不存在"})
        
    # Verify workspace exists
    ws = get_workspace(ws_id)
    if ws is None:
        return JSONResponse(status_code=404, content={"error": "專案不存在"})
        
    content = filepath.read_bytes()
    filename = filepath.name
    
    # Call ingestion service to parse
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(
            f"{INGESTION_URL}/parse",
            files={"file": (filename, content)},
        )

    if resp.status_code != 200:
        return JSONResponse(
            status_code=resp.status_code,
            content={"error": f"解析失敗: {resp.text[:200]}"},
        )

    config_data = resp.json()

    # Save to workspace
    meta = add_source(ws_id, filename, config_data)
    return {**meta, "dimensions": list(config_data.get("dimensions", {}).keys())}


@router.delete("/{ws_id}/sources/{source_id}")
async def api_delete_source(ws_id: str, source_id: str):
    """Delete a source from workspace."""
    if not delete_source(ws_id, source_id):
        return JSONResponse(status_code=404, content={"error": "資料來源不存在"})
    return {"deleted": source_id}


# ---------------------------------------------------------------------------
# Merged config
# ---------------------------------------------------------------------------

@router.get("/{ws_id}/merged-config")
async def api_get_merged_config(ws_id: str):
    """Get merged config from all sources in workspace."""
    config = get_merged_config(ws_id)
    if config is None:
        return JSONResponse(status_code=404, content={"error": "無資料來源"})
    return config


# ---------------------------------------------------------------------------
# Synthesis
# ---------------------------------------------------------------------------

@router.post("/{ws_id}/synthesize")
async def api_synthesize(ws_id: str, req: SynthesizeRequest):
    """Synthesize population from workspace data → auto-save results."""
    import traceback
    import random
    try:
        config = get_merged_config(ws_id)
        if config is None:
            return JSONResponse(status_code=400, content={"error": "無資料來源，請先上傳統計資料"})

        # If age range is restricted, oversample to compensate for filtering loss
        synth_count = req.target_count
        if req.age_min is not None or req.age_max is not None:
            synth_count = int(req.target_count * 1.6)
        config["target_count"] = synth_count
        config["filters"] = req.filters
        config["selected_dimensions"] = req.selected_dimensions

        # Inject region (county) into config so synthesis can use census DB
        # Priority: 1) config.region already set  2) workspace name  3) latest data source name
        if not config.get("region"):
            import re as _re_region
            _county_pattern = r"(臺北市|台北市|新北市|桃園市|臺中市|台中市|臺南市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|臺東縣|台東縣|澎湖縣|金門縣|連江縣)"
            # Normalize 台→臺 for DB consistency
            _normalize_county = {"台北市": "臺北市", "台中市": "臺中市", "台南市": "臺南市", "台東縣": "臺東縣"}
            # Try workspace name first (e.g. "國民黨台中市長初選")
            ws_meta = get_workspace_meta(ws_id)
            ws_name = ws_meta.get("name", "") if ws_meta else ""
            _m = _re_region.search(_county_pattern, ws_name)
            if _m:
                config["region"] = _normalize_county.get(_m.group(1), _m.group(1))
            else:
                # Fall back to data source names (prefer latest uploaded)
                sources = config.get("_meta", {}).get("sources") or [config.get("name", "")]
                for src_key in reversed(sources):  # latest first
                    _m = _re_region.search(_county_pattern, str(src_key))
                    if _m:
                        config["region"] = _normalize_county.get(_m.group(1), _m.group(1))
                        break

        # Call synthesis service + fetch leaning profile in parallel
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(
                f"{SYNTHESIS_URL}/generate",
                json=config,
            )
            # Fetch leaning profile from evolution service
            try:
                lp_resp = await client.get(f"{EVOLUTION_URL}/leaning-profile")
                leaning_data = lp_resp.json() if lp_resp.status_code == 200 else None
            except Exception:
                leaning_data = None

        if resp.status_code != 200:
            return JSONResponse(
                status_code=resp.status_code,
                content={"error": f"合成失敗: {resp.text[:500]}"},
            )

        result = resp.json()

        # Preserve the region (county) from source data into synthesis result
        region = config.get("region", "")
        if not region:
            # Try to extract from source name (e.g. "census_臺中市_2020")
            for src_key in (config.get("_meta", {}).get("sources") or [config.get("name", "")]):
                import re as _re
                m = _re.search(r"(臺北市|台北市|新北市|桃園市|臺中市|台中市|臺南市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|臺東縣|台東縣|澎湖縣|金門縣|連江縣)", str(src_key))
                if m:
                    region = m.group(1)
                    break
        if region:
            result["region"] = region

        # Filter persons by age range, trim to exact target count
        if req.age_min is not None or req.age_max is not None:
            lo = req.age_min if req.age_min is not None else 0
            hi = req.age_max if req.age_max is not None else 200
            original_count = len(result.get("persons", []))
            result["persons"] = [
                p for p in result.get("persons", [])
                if lo <= (p.get("age") or 0) <= hi
            ]
            # Trim to exact target (oversampling ensures enough)
            result["persons"] = result["persons"][:req.target_count]
            # Re-assign person_ids sequentially
            for idx, p in enumerate(result["persons"]):
                p["person_id"] = idx
            result["age_filtered"] = {
                "synthesized": original_count,
                "after_filter": len(result["persons"]),
                "age_min": lo,
                "age_max": hi,
            }

        # Assign political leaning to each person based on district
        if leaning_data and leaning_data.get("exists") and leaning_data.get("data"):
            districts_profile = leaning_data["data"].get("districts", {})
            if districts_profile:
                for person in result.get("persons", []):
                    district = person.get("district", "")
                    # Try exact match, then fuzzy match
                    dist = districts_profile.get(district)
                    if not dist:
                        for key, val in districts_profile.items():
                            if key in district or district in key:
                                dist = val
                                break
                    if dist:
                        # Backward compatibility: migrating old 5-tier labels to new 3-tier labels
                        remapped_dist = {}
                        for key_label, prob in dist.items():
                            val = float(prob)
                            if key_label in ["本土派", "中間偏本土", "偏左派"]:
                                remapped_dist["偏左派"] = remapped_dist.get("偏左派", 0.0) + val
                            elif key_label in ["統派", "中間偏統", "偏右派"]:
                                remapped_dist["偏右派"] = remapped_dist.get("偏右派", 0.0) + val
                            else:
                                remapped_dist["中立"] = remapped_dist.get("中立", 0.0) + val
                        
                        labels = list(remapped_dist.keys())
                        weights = [float(v) for v in remapped_dist.values()]
                        if sum(weights) > 0:
                            person["leaning"] = random.choices(labels, weights=weights, k=1)[0]

        # Auto-save synthesis result
        save_synthesis_result(ws_id, result)

        return result
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/{ws_id}/synthesis-result")
async def api_get_synthesis_result(ws_id: str):
    """Get saved synthesis result."""
    result = get_synthesis_result(ws_id)
    if result is None:
        return JSONResponse(status_code=404, content={"error": "尚未執行合成"})
    return result


# ---------------------------------------------------------------------------
# Persona Generation (background + progress)
# ---------------------------------------------------------------------------

# In-memory progress tracker: { ws_id: { "total": N, "done": M, "running": bool, "error": str|None } }
_persona_progress: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# LLM Vendor Config API
# ---------------------------------------------------------------------------

@router.get("/{ws_id}/llm-config")
async def api_get_llm_config(ws_id: str):
    """Get LLM vendor configuration for this workspace."""
    return get_workspace_llm_config(ws_id)


class LLMConfigUpdate(BaseModel):
    vendors: list[str]
    ratio: str


@router.put("/{ws_id}/llm-config")
async def api_update_llm_config(ws_id: str, req: LLMConfigUpdate):
    """Update LLM vendor configuration for this workspace."""
    result = update_workspace_llm_config(ws_id, req.vendors, req.ratio)
    if not result:
        return JSONResponse(status_code=404, content={"error": "Workspace not found"})
    return result


@router.post("/{ws_id}/persona")
async def api_generate_persona(ws_id: str, req: GeneratePersonaRequest):
    """Start persona generation in background with progress tracking."""
    import asyncio, traceback
    from shared.llm_vendors import assign_vendors

    # Check if already running
    prog = _persona_progress.get(ws_id, {})
    if prog.get("running"):
        return {"status": "running", "total": prog["total"], "done": prog["done"]}

    synth = get_synthesis_result(ws_id)
    if synth is None or not synth.get("persons"):
        return JSONResponse(status_code=400, content={"error": "無合成資料，請先執行人口合成"})

    persons = synth["persons"]
    total = len(persons)

    # Auto-resolve concurrency
    from shared.llm_vendors import get_default_concurrency
    batch_size = req.concurrency if req.concurrency > 0 else get_default_concurrency()

    # Get workspace LLM vendor config and assign vendors to each person
    llm_cfg = get_workspace_llm_config(ws_id)
    vendor_assignments = assign_vendors(
        n=total,
        vendor_names=llm_cfg["vendors"],
        ratio_str=llm_cfg["ratio"],
    )

    _persona_progress[ws_id] = {"total": total, "done": 0, "running": True, "error": None, "cancelled": False}

    async def _run():
        all_agents = []
        try:
            # Auto-reset evolution results since personas are changing
            try:
                async with httpx.AsyncClient(timeout=600.0) as client:
                    await client.post(f"{EVOLUTION_URL}/evolve/reset")
            except Exception:
                pass  # Evolution service may not be running

            for i in range(0, total, batch_size):
                # Check if cancelled
                if _persona_progress[ws_id].get("cancelled"):
                    _persona_progress[ws_id]["running"] = False
                    break

                batch = persons[i:i + batch_size]
                # Build vendor_assignments map for this batch
                batch_start = i
                batch_vendors = {}
                for j, person in enumerate(batch):
                    pid = person.get("person_id", batch_start + j)
                    if batch_start + j < len(vendor_assignments):
                        batch_vendors[str(pid)] = vendor_assignments[batch_start + j]

                payload = {
                    "persons": batch,
                    "strategy": req.strategy,
                    "locale": "zh-TW",
                    "vendor_assignments": batch_vendors,
                }
                try:
                    async with httpx.AsyncClient(timeout=600.0) as client:
                        resp = await client.post(
                            f"{PERSONA_URL}/generate",
                            json=payload,
                        )
                except Exception as http_err:
                    # Network/timeout error calling persona service
                    print(f"[ERROR] Persona batch {i} HTTP error: {type(http_err).__name__}: {http_err}")
                    _persona_progress[ws_id]["error"] = f"Batch {i} 連線失敗: {type(http_err).__name__}: {str(http_err)[:200]}"
                    # Fallback to template
                    try:
                        async with httpx.AsyncClient(timeout=120.0) as client:
                            fb = await client.post(f"{PERSONA_URL}/generate", json={"persons": batch, "strategy": "template", "locale": "zh-TW"})
                        if fb.status_code == 200:
                            all_agents.extend(fb.json().get("agents", []))
                    except Exception:
                        pass
                    _persona_progress[ws_id]["done"] = len(all_agents)
                    continue

                if resp.status_code != 200:
                    # LLM batch failed — log full error detail
                    err_detail = ""
                    try:
                        err_detail = resp.text[:500]
                    except Exception:
                        pass
                    print(f"[WARN] Persona batch {i} LLM failed (HTTP {resp.status_code}): {err_detail}")
                    _persona_progress[ws_id]["error"] = f"Batch {i} LLM 失敗 (HTTP {resp.status_code}): {err_detail[:200]}"
                    # Fallback to template for this batch
                    try:
                        async with httpx.AsyncClient(timeout=120.0) as client:
                            fb = await client.post(f"{PERSONA_URL}/generate", json={"persons": batch, "strategy": "template", "locale": "zh-TW"})
                        if fb.status_code == 200:
                            all_agents.extend(fb.json().get("agents", []))
                            print(f"[INFO] Batch {i} template fallback succeeded ({len(batch)} agents)")
                        else:
                            print(f"[ERROR] Template fallback also failed for batch {i}: {fb.status_code}")
                    except Exception as fb_err:
                        print(f"[ERROR] Template fallback exception for batch {i}: {fb_err}")
                    _persona_progress[ws_id]["done"] = len(all_agents)
                    continue

                result = resp.json()
                all_agents.extend(result.get("agents", []))
                _persona_progress[ws_id]["done"] = len(all_agents)

                # Save partial results after each batch so frontend can display them progressively
                partial = {"count": len(all_agents), "agents": all_agents}
                save_persona_result(ws_id, partial)

            # Final save (same data, just ensures consistency)
            _persona_progress[ws_id]["running"] = False
        except Exception as e:
            traceback.print_exc()
            _persona_progress[ws_id]["error"] = str(e)
            _persona_progress[ws_id]["running"] = False

    asyncio.create_task(_run())
    return {"status": "started", "total": total, "done": 0}


@router.get("/{ws_id}/persona-progress")
async def api_persona_progress(ws_id: str):
    """Get persona generation progress."""
    prog = _persona_progress.get(ws_id)
    if prog is None:
        return {"status": "idle", "total": 0, "done": 0}
    return {
        "status": "running" if prog["running"] else ("cancelled" if prog.get("cancelled") else ("error" if prog.get("error") else "done")),
        "total": prog["total"],
        "done": prog["done"],
        "error": prog.get("error"),
    }


@router.post("/{ws_id}/persona-cancel")
async def api_cancel_persona(ws_id: str):
    """Cancel an ongoing persona generation."""
    prog = _persona_progress.get(ws_id)
    if prog and prog.get("running"):
        prog["cancelled"] = True
        prog["running"] = False  # Immediately mark as not running so frontend updates
        return {"status": "cancelled", "done": prog["done"], "total": prog["total"]}
    return {"status": "not_running"}


@router.get("/{ws_id}/persona-result")
async def api_get_persona_result(ws_id: str):
    """Get saved persona results."""
    result = get_persona_result(ws_id)
    if result is None:
        return JSONResponse(status_code=404, content={"error": "尚未執行 Persona 生成"})
    return result


@router.post("/{ws_id}/persona-reassign-vendors")
async def api_reassign_persona_vendors(ws_id: str):
    """Reassign all existing agents' llm_vendor fields evenly across configured vendors."""
    from shared.llm_vendors import assign_vendors, get_default_vendor_names
    import os

    result = get_persona_result(ws_id)
    if result is None or not result.get("agents"):
        return JSONResponse(status_code=400, content={"error": "尚未生成 Persona"})

    agents = result["agents"]
    total = len(agents)

    # Get workspace LLM vendor config
    llm_cfg = get_workspace_llm_config(ws_id)
    vendor_assignments = assign_vendors(
        n=total,
        vendor_names=llm_cfg["vendors"],
        ratio_str=llm_cfg["ratio"],
    )

    # Reassign
    for i, agent in enumerate(agents):
        agent["llm_vendor"] = vendor_assignments[i]

    # Count per vendor
    from collections import Counter
    vendor_counts = dict(Counter(vendor_assignments))

    # Save
    save_persona_result(ws_id, {"count": total, "agents": agents})

    return {
        "status": "ok",
        "total": total,
        "vendor_distribution": vendor_counts,
    }


# ---------------------------------------------------------------------------
# Persona Snapshots
# ---------------------------------------------------------------------------

class SaveSnapshotRequest(BaseModel):
    name: str
    description: str = ""


@router.post("/{ws_id}/persona-snapshots")
async def api_save_persona_snapshot(ws_id: str, req: SaveSnapshotRequest):
    """Save current personas as a named snapshot."""
    try:
        meta = save_persona_snapshot(ws_id, req.name, req.description)
        return meta
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@router.get("/{ws_id}/persona-snapshots")
async def api_list_persona_snapshots(ws_id: str):
    """List all persona snapshots (metadata only)."""
    return {"snapshots": list_persona_snapshots(ws_id)}


@router.get("/{ws_id}/persona-snapshots/{snapshot_id}")
async def api_get_persona_snapshot(ws_id: str, snapshot_id: str):
    """Get full snapshot data."""
    snap = get_persona_snapshot(ws_id, snapshot_id)
    if snap is None:
        return JSONResponse(status_code=404, content={"error": "快照不存在"})
    return snap


@router.post("/{ws_id}/persona-snapshots/{snapshot_id}/load")
async def api_load_persona_snapshot(ws_id: str, snapshot_id: str):
    """Load a snapshot as the current persona result."""
    result = load_persona_snapshot(ws_id, snapshot_id)
    if result is None:
        return JSONResponse(status_code=404, content={"error": "快照不存在或資料為空"})
    return result


@router.delete("/{ws_id}/persona-snapshots/{snapshot_id}")
async def api_delete_persona_snapshot(ws_id: str, snapshot_id: str):
    """Delete a persona snapshot."""
    if not delete_persona_snapshot(ws_id, snapshot_id):
        return JSONResponse(status_code=404, content={"error": "快照不存在"})
    return {"deleted": snapshot_id}


# ---------------------------------------------------------------------------
# Evolution Controls (proxy to evolution service)
# ---------------------------------------------------------------------------

@router.post("/{ws_id}/evolution/stop/{job_id}")
async def api_evolution_stop(ws_id: str, job_id: str):
    """Stop a running evolution job."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/evolve/stop/{job_id}")
    return resp.json()


@router.post("/{ws_id}/evolution/reset")
async def api_evolution_reset(ws_id: str):
    """Reset all evolution jobs and history."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/evolve/reset")
    return resp.json()


# ---------------------------------------------------------------------------
# KMT Primary Election Simulation
# ---------------------------------------------------------------------------

class PrimarySimulateRequest(BaseModel):
    candidate_a: str  # KMT candidate A (e.g. 江啟臣)
    candidate_b: str  # KMT candidate B (e.g. 楊瓊瓔)
    opponent: str     # DPP opponent (e.g. 何欣純)
    concurrency: int = 5


class PrimarySimulateResponse(BaseModel):
    comparative_a: float  # candidate_a win rate in party vs party (excluding undecided)
    comparative_b: float  # candidate_b win rate in party vs party (excluding undecided)
    intraparty_a: float   # candidate_a win rate in intraparty comparison (excluding undecided)
    intraparty_b: float   # candidate_b win rate in intraparty comparison (excluding undecided)
    final_score_a: float  # 0.85*comparative_a + 0.15*intraparty_a
    final_score_b: float  # 0.85*comparative_b + 0.15*intraparty_b
    undecided_rate: float
    total_simulated: int
    detail: list[dict]


@router.post("/{ws_id}/primary-simulate")
async def api_primary_simulate(ws_id: str, req: PrimarySimulateRequest):
    """
    Simulate KMT primary election polling using LLM for each synthetic person.
    Applies KMT formula: final = comparative * 0.85 + intraparty * 0.15
    Undecided responses are excluded from the denominator.
    """
    import os, asyncio, re

    # 1. Load synthesis result
    result = get_synthesis_result(ws_id)
    if not result or not result.get("persons"):
        return JSONResponse(status_code=400, content={"error": "尚未合成虛擬人口，請先執行合成"})

    persons = result["persons"]

    # 2. Load persona results for per-agent vendor info
    persona_result = get_persona_result(ws_id)
    agent_vendor_map: dict[str, str] = {}
    if persona_result and persona_result.get("agents"):
        for agent in persona_result["agents"]:
            pid = str(agent.get("person_id", ""))
            vendor = agent.get("llm_vendor", "")
            if pid and vendor:
                agent_vendor_map[pid] = vendor

    # 3. Build vendor-specific API configs
    from shared.llm_vendors import get_vendor_configs, get_default_vendor_names
    vendor_names = list(set(agent_vendor_map.values())) if agent_vendor_map else get_default_vendor_names()
    vendor_configs = {c.name: c for c in get_vendor_configs(vendor_names)}

    # Fallback defaults
    default_api_base = os.environ.get("OPENAI_API_BASE", "https://api.openai.com/v1")
    default_api_key = os.environ.get("OPENAI_API_KEY", "")
    default_model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

    sem = asyncio.Semaphore(req.concurrency)

    def _get_api_config(person_id: str) -> tuple[str, str, str]:
        """Return (api_base, api_key, model) for this person's vendor."""
        vendor_name = agent_vendor_map.get(person_id, "")
        if vendor_name and vendor_name in vendor_configs:
            vc = vendor_configs[vendor_name]
            base = vc.base_url or "https://api.openai.com/v1"
            return base, vc.api_key, vc.model
        return default_api_base, default_api_key, default_model

    async def simulate_person(person: dict) -> dict:
        age = person.get("age", "未知")
        gender = person.get("gender", "未知")
        district = person.get("district", "未知")
        education = person.get("education", "未知")
        party_lean = person.get("party_lean", "")

        profile = f"年齡{age}歲、{gender}、居住{district}、教育程度{education}"
        if party_lean:
            profile += f"、政治傾向{party_lean}"

        system_prompt = (
            "你是一位台中市市民，正在接受一個民調電話的訪問。"
            "請你根據自己的背景資料，真實地回答以下問題。"
            "回答必須只輸出以下格式的 JSON，不要加任何說明：\n"
            '{"comparative": "<候選人姓名或ABSTAIN>", "intraparty": "<候選人姓名或ABSTAIN>"}'
        )

        user_prompt = (
            f"您的背景：{profile}\n\n"
            f"問題一（政黨對比式）：如果國民黨推派{req.candidate_a}，民進黨推派{req.opponent}，"
            f"請問您比較支持哪一位？若不確定請回答 ABSTAIN。\n\n"
            f"問題二（黨內互比式）：在國民黨有意參選的{req.candidate_a}與{req.candidate_b}中，"
            f"請問您比較支持哪一位？若不確定請回答 ABSTAIN。\n\n"
            "請只輸出 JSON，不要其他說明。"
        )

        async with sem:
            try:
                person_id = str(person.get("person_id", ""))
                p_api_base, p_api_key, p_model = _get_api_config(person_id)
                async with httpx.AsyncClient(timeout=600.0) as client:
                        if any(m in p_model.lower() for m in ["o1", "o3", "gpt-5"]):
                            messages = [{"role": "user", "content": f"{system_prompt}\n\n{user_prompt}"}]
                            payload = {
                                "model": p_model,
                                "messages": messages,
                                "max_completion_tokens": 1024,
                                "temperature": 1.0,
                            }
                        else:
                            messages = [
                                {"role": "system", "content": system_prompt},
                                {"role": "user", "content": user_prompt},
                            ]
                            payload = {
                                "model": p_model,
                                "messages": messages,
                                "max_tokens": 80,
                                "temperature": 0.3,
                            }

                        resp = await client.post(
                            f"{p_api_base}/chat/completions",
                            headers={"Authorization": f"Bearer {p_api_key}", "Content-Type": "application/json"},
                            json=payload,
                        )
                raw = resp.json()["choices"][0]["message"]["content"].strip()
                # Extract JSON from response
                m = re.search(r'\{.*?\}', raw, re.DOTALL)
                if m:
                    import json
                    parsed = json.loads(m.group())
                    return {
                        "comparative": parsed.get("comparative", "ABSTAIN"),
                        "intraparty": parsed.get("intraparty", "ABSTAIN"),
                        "person_id": person.get("person_id", ""),
                    }
            except Exception as e:
                import logging
                logging.getLogger(__name__).error(f"Poll LLM failed for {person_id}: {e}")
                pass
            return {"comparative": "ABSTAIN", "intraparty": "ABSTAIN", "person_id": person.get("person_id", "")}

    # 3. Run simulations concurrently
    tasks = [simulate_person(p) for p in persons]
    detail = await asyncio.gather(*tasks)

    # 4. Calculate KMT formula
    comp_a = comp_b = comp_abstain = 0
    intra_a = intra_b = intra_abstain = 0

    for d in detail:
        c = d.get("comparative", "ABSTAIN")
        if req.candidate_a in c:
            comp_a += 1
        elif req.candidate_b in c or req.opponent in c:
            comp_b += 1
        else:
            comp_abstain += 1

        p = d.get("intraparty", "ABSTAIN")
        if req.candidate_a in p:
            intra_a += 1
        elif req.candidate_b in p:
            intra_b += 1
        else:
            intra_abstain += 1

    comp_total = comp_a + comp_b
    intra_total = intra_a + intra_b
    total = len(detail)

    comparative_a = comp_a / comp_total if comp_total > 0 else 0.5
    comparative_b = comp_b / comp_total if comp_total > 0 else 0.5
    intraparty_a = intra_a / intra_total if intra_total > 0 else 0.5
    intraparty_b = intra_b / intra_total if intra_total > 0 else 0.5

    final_a = comparative_a * 0.85 + intraparty_a * 0.15
    final_b = comparative_b * 0.85 + intraparty_b * 0.15
    undecided = comp_abstain / total if total > 0 else 0

    return {
        "candidate_a": req.candidate_a,
        "candidate_b": req.candidate_b,
        "opponent": req.opponent,
        "comparative_a": round(comparative_a, 4),
        "comparative_b": round(comparative_b, 4),
        "intraparty_a": round(intraparty_a, 4),
        "intraparty_b": round(intraparty_b, 4),
        "final_score_a": round(final_a, 4),
        "final_score_b": round(final_b, 4),
        "undecided_rate": round(undecided, 4),
        "total_simulated": total,
        "detail": list(detail),
    }


# ── Agent individuality patch ────────────────────────────────────────

@router.patch("/{ws_id}/agents/{agent_id}/individuality")
async def api_patch_agent_individuality(ws_id: str, agent_id: int, payload: dict):
    """Update an agent's individuality parameters without re-generating persona."""
    persona_result = get_persona_result(ws_id)
    if not persona_result or not persona_result.get("agents"):
        return JSONResponse(status_code=404, content={"error": "No personas found"})

    agents = persona_result["agents"]
    agent = None
    for a in agents:
        if a.get("person_id") == agent_id or a.get("person_id") == str(agent_id):
            agent = a
            break

    if agent is None:
        return JSONResponse(status_code=404, content={"error": f"Agent {agent_id} not found"})

    # Merge updates into existing individuality
    current = agent.get("individuality", {})
    for key, value in payload.items():
        if key in ("noise_scale", "temperature_offset", "reaction_multiplier", "memory_inertia", "delta_cap", "cognitive_bias"):
            current[key] = value
    agent["individuality"] = current

    # Save back
    save_persona_result(ws_id, persona_result)
    return {"ok": True, "agent_id": agent_id, "individuality": current}


@router.patch("/{ws_id}/agents/batch-individuality")
async def api_batch_patch_individuality(ws_id: str, payload: dict):
    """Batch update individuality for multiple agents.

    Body: {"updates": {"0": {"cognitive_bias": "悲觀偏向"}, "5": {"noise_scale": 2.0}}}
    OR: {"filter": {"emotional_stability": "敏感衝動"}, "set": {"noise_scale": 2.0}}
    """
    persona_result = get_persona_result(ws_id)
    if not persona_result or not persona_result.get("agents"):
        return JSONResponse(status_code=404, content={"error": "No personas found"})

    agents = persona_result["agents"]
    updated = 0

    if "updates" in payload:
        # Per-agent updates
        for agent_id_str, changes in payload["updates"].items():
            agent_id = int(agent_id_str)
            for a in agents:
                if a.get("person_id") == agent_id or a.get("person_id") == str(agent_id):
                    current = a.get("individuality", {})
                    for k, v in changes.items():
                        if k in ("noise_scale", "temperature_offset", "reaction_multiplier", "memory_inertia", "delta_cap", "cognitive_bias"):
                            current[k] = v
                    a["individuality"] = current
                    updated += 1
                    break

    elif "filter" in payload and "set" in payload:
        # Filter-based batch update
        filter_cond = payload["filter"]
        set_values = payload["set"]
        for a in agents:
            match = True
            for fk, fv in filter_cond.items():
                # Check in personality or top-level fields
                agent_val = a.get("personality", {}).get(fk, a.get(fk))
                if agent_val != fv:
                    match = False
                    break
            if match:
                current = a.get("individuality", {})
                for k, v in set_values.items():
                    if k in ("noise_scale", "temperature_offset", "reaction_multiplier", "memory_inertia", "delta_cap", "cognitive_bias"):
                        current[k] = v
                a["individuality"] = current
                updated += 1

    save_persona_result(ws_id, persona_result)
    return {"ok": True, "updated": updated}


# ── UI Settings persistence ──────────────────────────────────────────

@router.get("/{ws_id}/ui-settings/{panel}")
async def api_get_ui_settings(ws_id: str, panel: str):
    return get_workspace_ui_settings(ws_id, panel)


@router.put("/{ws_id}/ui-settings/{panel}")
async def api_update_ui_settings(ws_id: str, panel: str, payload: dict):
    return update_workspace_ui_settings(ws_id, panel, payload)
