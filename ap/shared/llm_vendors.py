"""Centralized LLM vendor configuration.

Reads vendor settings from shared/global_settings.py (settings.json)
and provides helpers to assign vendors to agents and create API clients.

Backward-compatible: if settings.json does not exist yet, the first load
will auto-migrate the current .env values.
"""
from __future__ import annotations

import os
import random
from dataclasses import dataclass, field
from typing import Any


@dataclass
class VendorConfig:
    """Configuration for a single LLM vendor."""
    name: str
    api_key: str
    base_url: str | None  # None → use default
    model: str
    temperature: float | None = None  # None → use caller default

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "api_key_hint": f"***{self.api_key[-4:]}" if len(self.api_key) > 4 else "***",
            "base_url": self.base_url or "(default)",
            "model": self.model,
        }


# ── Vendor type → default base_url mapping ───────────────────────────

_VENDOR_TYPE_DEFAULTS: dict[str, dict[str, Any]] = {
    "openai": {"base_url": None, "temperature": None},
    "gemini": {"base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "temperature": None},
    "xai":    {"base_url": "https://api.x.ai/v1", "temperature": None},
    "deepseek": {"base_url": "https://api.deepseek.com", "temperature": None},
    "moonshot": {"base_url": "https://api.moonshot.ai/v1", "temperature": 1.0},
    "ollama":   {"base_url": "http://localhost:11434/v1", "temperature": None},
}


def _vendor_entry_to_config(entry: dict) -> VendorConfig:
    """Convert a settings.json vendor entry dict → VendorConfig."""
    vtype = entry.get("vendor_type", "openai")
    defaults = _VENDOR_TYPE_DEFAULTS.get(vtype, {})

    base_url = entry.get("base_url") or defaults.get("base_url")
    temperature = entry.get("temperature")
    if temperature is None:
        temperature = defaults.get("temperature")

    return VendorConfig(
        name=entry["id"],
        api_key=entry.get("api_key", ""),
        base_url=base_url or None,
        model=entry.get("model", ""),
        temperature=temperature,
    )


# ── Public API ───────────────────────────────────────────────────────

def _load_all_vendor_configs() -> dict[str, VendorConfig]:
    """Build {vendor_id: VendorConfig} from settings.json."""
    from shared.global_settings import load_settings
    settings = load_settings()
    result: dict[str, VendorConfig] = {}
    for entry in settings.get("llm_vendors", []):
        vid = entry.get("id", "")
        if vid:
            result[vid] = _vendor_entry_to_config(entry)
    return result


def get_vendor_configs(vendor_names: list[str] | None = None) -> list[VendorConfig]:
    """Get VendorConfig list for the given vendor names.

    If vendor_names is None, reads from settings.json active_vendors.
    Falls back to ["openai"] if nothing is configured.
    """
    all_configs = _load_all_vendor_configs()

    if vendor_names is None:
        from shared.global_settings import load_settings
        settings = load_settings()
        vendor_names = settings.get("active_vendors", [])
        if not vendor_names:
            vendor_names = list(all_configs.keys())

    configs = []
    for name in vendor_names:
        cfg = all_configs.get(name)
        if cfg and cfg.api_key:
            configs.append(cfg)

    # Fallback: if no valid vendor, try first available
    if not configs and all_configs:
        for cfg in all_configs.values():
            if cfg.api_key:
                configs.append(cfg)
                break

    return configs


def parse_ratios(ratio_str: str | None, count: int) -> list[float]:
    """Parse a colon-separated ratio string into normalized floats."""
    if not ratio_str:
        return [1.0 / count] * count if count > 0 else []

    sep = ":" if ":" in ratio_str else ","
    parts = [float(x.strip()) for x in ratio_str.split(sep) if x.strip()]

    while len(parts) < count:
        parts.append(parts[-1] if parts else 1.0)
    parts = parts[:count]

    total = sum(parts)
    if total <= 0:
        return [1.0 / count] * count
    return [p / total for p in parts]


def assign_vendors(
    n: int,
    vendor_names: list[str] | None = None,
    ratio_str: str | None = None,
) -> list[str]:
    """Assign vendor names to n agents based on ratios.

    In primary_fallback mode, all agents get the primary vendor.
    """
    from shared.global_settings import load_settings
    settings = load_settings()
    mode = settings.get("llm_mode", "multi")

    if mode == "primary_fallback":
        primary = settings.get("primary_vendor_id", "")
        if primary:
            return [primary] * n
        # Fallback if primary not set
        configs = get_vendor_configs()
        name = configs[0].name if configs else "openai"
        return [name] * n

    # Multi mode
    if vendor_names is None:
        vendor_names = settings.get("active_vendors", [])

    if ratio_str is None:
        ratio_str = settings.get("vendor_ratio", "1")

    configs = get_vendor_configs(vendor_names)
    available_names = [c.name for c in configs]

    if not available_names:
        return ["openai"] * n

    ratios = parse_ratios(ratio_str, len(available_names))

    assignments: list[str] = []
    for name, ratio in zip(available_names, ratios):
        count = round(n * ratio)
        assignments.extend([name] * count)

    while len(assignments) < n:
        assignments.append(available_names[0])
    assignments = assignments[:n]

    random.shuffle(assignments)
    return assignments


def get_client_for_vendor(vendor_name: str) -> tuple[Any, str, float | None]:
    """Create an AsyncOpenAI client for the given vendor.

    Returns (client, model_name, temperature_override).
    """
    from openai import AsyncOpenAI

    configs = get_vendor_configs([vendor_name])
    if not configs:
        configs = get_vendor_configs()

    cfg = configs[0]
    client = AsyncOpenAI(
        api_key=cfg.api_key,
        base_url=cfg.base_url,
        timeout=600.0,
    )
    return client, cfg.model, cfg.temperature


def get_fallback_vendor() -> str | None:
    """Return the fallback vendor id if in primary_fallback mode."""
    from shared.global_settings import load_settings
    settings = load_settings()
    if settings.get("llm_mode") == "primary_fallback":
        return settings.get("fallback_vendor_id") or None
    return None


def get_available_vendors() -> list[dict[str, str]]:
    """Return list of available vendors with their display info."""
    from shared.global_settings import load_settings
    settings = load_settings()
    active = set(settings.get("active_vendors", []))
    all_configs = _load_all_vendor_configs()
    result = []
    for name, cfg in all_configs.items():
        result.append({
            "name": name,
            "available": bool(cfg.api_key),
            "enabled": name in active if active else bool(cfg.api_key),
            "model": cfg.model,
            "api_key_hint": f"***{cfg.api_key[-4:]}" if len(cfg.api_key) > 4 else "(未設定)",
        })
    return result


def get_default_ratio_str() -> str:
    """Return the default ratio string from settings."""
    from shared.global_settings import load_settings
    settings = load_settings()
    return settings.get("vendor_ratio", "1")


def get_default_vendor_names() -> list[str]:
    """Return the default active vendor name list."""
    from shared.global_settings import load_settings
    settings = load_settings()
    active = settings.get("active_vendors", [])
    if active:
        return active
    # Fallback to all configured vendors
    return [v["id"] for v in settings.get("llm_vendors", []) if v.get("api_key")]


def get_default_concurrency() -> int:
    """Return default concurrency = 1:1 matching LLM count."""
    configs = get_vendor_configs()
    return max(1, len(configs))
