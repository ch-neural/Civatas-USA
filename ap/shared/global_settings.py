"""Global settings stored in shared/settings.json.

All microservices mount ./shared:/app/shared, so this file is accessible
across all containers.  On first load, if settings.json doesn't exist,
it is auto-populated from the current .env values (one-time migration).
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

_SETTINGS_PATH = Path(os.path.dirname(os.path.abspath(__file__))) / "settings.json"
_lock = threading.Lock()


# ── Schema Defaults ──────────────────────────────────────────────────

def _default_settings() -> dict:
    """Return the default settings structure."""
    return {
        "llm_mode": "multi",          # "multi" | "primary_fallback"
        "llm_vendors": [],             # list of VendorEntry dicts
        "active_vendors": [],          # vendor ids currently enabled (for multi mode)
        "vendor_ratio": "",            # colon-separated ratio string
        "primary_vendor_id": "",       # for primary_fallback mode
        "fallback_vendor_id": "",      # for primary_fallback mode
        "system_vendor_id": "",        # designated vendor for non-agent system tasks
        "serper_api_key": os.getenv("SERPER_API_KEY", ""),
        "tavily_api_key": os.getenv("TAVILY_API_KEY", ""),
        "onboarding_completed": False,  # onboarding wizard completion status
    }


def _vendor_entry(
    vendor_id: str,
    display_name: str,
    vendor_type: str,
    api_key: str,
    model: str,
    base_url: str = "",
    temperature: float | None = None,
) -> dict:
    """Build a single vendor entry dict."""
    return {
        "id": vendor_id,
        "display_name": display_name,
        "vendor_type": vendor_type,   # openai / gemini / xai / deepseek / moonshot / ollama
        "api_key": api_key,
        "model": model,
        "base_url": base_url,
        "temperature": temperature,
    }


# ── Migration from .env ─────────────────────────────────────────────

def _migrate_from_env() -> dict:
    """Read current .env values and build the initial settings.json."""
    try:
        from dotenv import load_dotenv
        env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
        load_dotenv(dotenv_path=env_path)
    except ImportError:
        pass  # python-dotenv not installed; env vars already set by Docker

    settings = _default_settings()
    vendors: list[dict] = []

    # ─ Vendor definitions to scan ─
    _vendor_defs = [
        ("openai",    "OpenAI",    "openai",    "LLM_API_KEY",      "LLM_MODEL",      "LLM_BASE_URL",      "gpt-4o-mini"),
        ("gemini",    "Gemini",    "gemini",    "GEMINI_API_KEY",   "GEMINI_MODEL",    None,                 "gemini-2.0-flash"),
        ("xai",       "xAI",       "xai",       "XAI_API_KEY",      "XAI_MODEL",       None,                 "grok-4-1-fast"),
        ("deepseek",  "DeepSeek",  "deepseek",  "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL",  "DEEPSEEK_BASE_URL",  "deepseek-chat"),
        ("moonshot",  "Moonshot",  "moonshot",  "MOONSHOT_API_KEY", "MOONSHOT_MODEL",  "MOONSHOT_BASE_URL",  "kimi-k2.5"),
        ("ollama",    "Ollama",    "ollama",    "OLLAMA_API_KEY",   "OLLAMA_MODEL",    "OLLAMA_BASE_URL",    "llama3"),
    ]

    for base_id, display, vtype, key_env, model_env, url_env, default_model in _vendor_defs:
        # Base vendor
        api_key = os.getenv(key_env, "")
        model = os.getenv(model_env, default_model)
        base_url = os.getenv(url_env, "") if url_env else ""

        # For ollama, treat missing key as "ollama"
        if vtype == "ollama" and not api_key and model:
            api_key = "ollama"

        if api_key:
            vendors.append(_vendor_entry(base_id, display, vtype, api_key, model, base_url))

        # Numbered variants (2-9)
        for n in range(2, 10):
            suffix = str(n)
            vkey = os.getenv(f"{key_env}{suffix}", "")
            vmodel = os.getenv(f"{model_env}{suffix}", default_model)
            vurl = os.getenv(f"{url_env}{suffix}", "") if url_env else ""
            if vtype == "ollama" and not vkey and vmodel:
                vkey = "ollama"
            if not vkey:
                continue
            vendors.append(_vendor_entry(
                f"{base_id}{suffix}",
                f"{display} #{suffix}",
                vtype,
                vkey,
                vmodel,
                vurl,
            ))

    settings["llm_vendors"] = vendors

    # Active vendors from LLM_VENDORS env
    raw_active = os.getenv("LLM_VENDORS", "openai")
    active_ids = [v.strip().lower() for v in raw_active.split(",") if v.strip()]
    settings["active_vendors"] = active_ids
    settings["vendor_ratio"] = os.getenv("LLM_VENDOR_RATIO", "1")

    # Default primary/fallback to first two active vendors if available
    if len(active_ids) >= 1:
        settings["primary_vendor_id"] = active_ids[0]
    if len(active_ids) >= 2:
        settings["fallback_vendor_id"] = active_ids[1]

    return settings


# ── Public API ───────────────────────────────────────────────────────

def load_settings() -> dict:
    """Load settings from settings.json, migrating from .env if needed."""
    with _lock:
        if _SETTINGS_PATH.exists():
            try:
                data = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
                # Merge with defaults so new keys are always present
                defaults = _default_settings()
                for k, v in defaults.items():
                    if k not in data:
                        data[k] = v
                return data
            except Exception:
                pass

        # First run: migrate from .env
        settings = _migrate_from_env()
        _save_unlocked(settings)
        return settings


def _save_unlocked(settings: dict) -> None:
    """Write settings without acquiring lock (caller must hold _lock)."""
    _SETTINGS_PATH.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def save_settings(settings: dict) -> None:
    """Persist settings to settings.json."""
    with _lock:
        _save_unlocked(settings)


def get_vendor_by_id(vendor_id: str) -> dict | None:
    """Lookup a single vendor entry by its id."""
    settings = load_settings()
    for v in settings.get("llm_vendors", []):
        if v["id"] == vendor_id:
            return v
    return None


def get_system_llm_credentials() -> dict:
    """Return credentials optimized for generic system LLM tasks.
    
    Checks `system_vendor_id` from global settings first. 
    If not set or not found, falls back directly to `.env` openAI defaults.
    """
    # Known vendor_type → default base_url map
    VENDOR_TYPE_BASE_URLS = {
        "xai": "https://api.x.ai/v1",
        "deepseek": "https://api.deepseek.com",
        "moonshot": "https://api.moonshot.ai/v1",
        "ollama": "http://host.docker.internal:11434/v1",
        "openai": "",   # OpenAI SDK uses default, leave None
        "gemini": "",   # Gemini also has its own SDK path
    }

    settings = load_settings()
    sys_vid = settings.get("system_vendor_id", "")
    
    if sys_vid:
        vendor = get_vendor_by_id(sys_vid)
        if vendor:
            vendor_type = vendor.get("vendor_type", "openai")
            base_url = vendor.get("base_url", "").strip()
            # Auto-fill base_url from known vendor type map if not set
            if not base_url:
                base_url = VENDOR_TYPE_BASE_URLS.get(vendor_type, "")
            return {
                "api_key": vendor.get("api_key", ""),
                "base_url": base_url or None,
                "model": vendor.get("model", "gpt-4o-mini"),
            }
            
    # Fallback to .env OPENAI defaults
    return {
        "api_key": os.getenv("LLM_API_KEY", ""),
        "base_url": os.getenv("LLM_BASE_URL", "") or None,
        "model": os.getenv("LLM_MODEL", "gpt-4o-mini"),
    }
