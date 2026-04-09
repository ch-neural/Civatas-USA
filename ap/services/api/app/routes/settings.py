"""Global settings API routes.

GET  /api/settings          → read current settings
PUT  /api/settings          → update settings
GET  /api/settings/vendor-types → list available vendor type presets
"""
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

router = APIRouter()


class VendorEntry(BaseModel):
    id: str
    display_name: str
    vendor_type: str          # openai / gemini / xai / deepseek / moonshot / ollama
    api_key: str
    model: str
    base_url: str = ""
    temperature: Optional[float] = None


class SettingsUpdate(BaseModel):
    llm_mode: str = "multi"                      # "multi" | "primary_fallback"
    llm_vendors: list[VendorEntry] = []
    active_vendors: list[str] = []
    vendor_ratio: str = "1"
    primary_vendor_id: str = ""
    fallback_vendor_id: str = ""
    system_vendor_id: str = ""
    serper_api_key: Optional[str] = None
    tavily_api_key: Optional[str] = None
    onboarding_completed: Optional[bool] = None


@router.get("")
async def api_get_settings():
    """Return the current global settings (with API keys masked)."""
    from shared.global_settings import load_settings
    settings = load_settings()

    # Mask API keys for display
    safe = dict(settings)
    safe_vendors = []
    for v in settings.get("llm_vendors", []):
        sv = dict(v)
        key = sv.get("api_key", "")
        sv["api_key_hint"] = f"***{key[-4:]}" if len(key) > 4 else "(未設定)"
        # Keep the actual key in a separate field for the edit form
        sv["api_key"] = key
        safe_vendors.append(sv)
    safe["llm_vendors"] = safe_vendors

    # Mask search API keys
    for k in ("serper_api_key", "tavily_api_key"):
        key = settings.get(k, "")
        safe[k] = key  # keep full key for edit form
        safe[f"{k}_hint"] = f"***{key[-4:]}" if len(key) > 4 else "(未設定)"

    return safe


@router.put("")
async def api_update_settings(req: SettingsUpdate):
    """Update global settings."""
    from shared.global_settings import load_settings, save_settings

    current = load_settings()

    # Build new vendor list, preserving keys that weren't changed
    new_vendors = []
    current_map = {v["id"]: v for v in current.get("llm_vendors", [])}
    for v in req.llm_vendors:
        entry = v.dict()
        # If api_key is the masked hint, keep the original
        if entry["api_key"].startswith("***") and entry["id"] in current_map:
            entry["api_key"] = current_map[entry["id"]]["api_key"]
        new_vendors.append(entry)

    updated = {
        "llm_mode": req.llm_mode,
        "llm_vendors": new_vendors,
        "active_vendors": req.active_vendors,
        "vendor_ratio": req.vendor_ratio,
        "primary_vendor_id": req.primary_vendor_id,
        "fallback_vendor_id": req.fallback_vendor_id,
        "system_vendor_id": req.system_vendor_id,
    }

    # Preserve search API keys — only update if explicitly provided (not masked)
    for k in ("serper_api_key", "tavily_api_key"):
        val = getattr(req, k, None)
        if val is not None and not val.startswith("***"):
            updated[k] = val
        else:
            updated[k] = current.get(k, "")

    # Update onboarding_completed if provided
    if req.onboarding_completed is not None:
        updated["onboarding_completed"] = req.onboarding_completed
    else:
        updated["onboarding_completed"] = current.get("onboarding_completed", False)

    save_settings(updated)
    return {"status": "ok"}


@router.get("/vendor-types")
async def api_vendor_types():
    """List available vendor type presets for the UI dropdown."""
    return {
        "types": [
            {"value": "openai",    "label": "OpenAI",    "default_base_url": "",                                                         "default_model": "gpt-4o-mini"},
            {"value": "gemini",    "label": "Gemini",    "default_base_url": "https://generativelanguage.googleapis.com/v1beta/openai",  "default_model": "gemini-2.0-flash"},
            {"value": "xai",       "label": "xAI (Grok)", "default_base_url": "https://api.x.ai/v1",                                     "default_model": "grok-4-1-fast"},
            {"value": "deepseek",  "label": "DeepSeek",  "default_base_url": "https://api.deepseek.com",                                "default_model": "deepseek-chat"},
            {"value": "moonshot",  "label": "Moonshot",  "default_base_url": "https://api.moonshot.ai/v1",                               "default_model": "kimi-k2.5"},
            {"value": "ollama",    "label": "Ollama (本地)", "default_base_url": "http://host.docker.internal:11434/v1",                  "default_model": "llama3"},
        ]
    }
