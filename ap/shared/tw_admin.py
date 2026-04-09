"""
Taiwan Administrative Hierarchy — 台灣行政區階層匹配工具

Supports three-level hierarchy:
  Level 1: 縣市 (County/City) — e.g., 台北市, 新北市, 宜蘭縣
  Level 2: 鄉鎮市區 (Township/District) — e.g., 大安區, 宜蘭市
  Level 3: 村里 (Village) — e.g., 中山里

Storage format uses "|" as separator: "台北市|大安區|中山里"
"""
from __future__ import annotations


def parse_admin_key(key: str) -> tuple[str, ...]:
    """Parse a "|"-separated admin key into parts."""
    return tuple(p.strip() for p in key.split("|") if p.strip())


def build_admin_key(*parts: str) -> str:
    """Build a "|"-separated admin key from parts."""
    return "|".join(p for p in parts if p)


def detect_level(key: str) -> int:
    """Detect the admin level of a key (1=city, 2=town, 3=village)."""
    return len(parse_admin_key(key))


def match_district(district: str, keys: list[str]) -> str | None:
    """Match a persona's district string against available admin keys.

    Tries multiple strategies:
    1. Exact match
    2. Partial containment
    3. Suffix match (e.g., "大安區" matches "台北市|大安區")
    4. Parent match (e.g., "台北市|大安區" matches "台北市")
    """
    if not district or not keys:
        return None

    # 1) Exact match
    if district in keys:
        return district

    # 2) Key contains district or vice versa (simple flat string)
    for key in keys:
        flat_key = key.replace("|", "")
        if district in flat_key or flat_key in district:
            return key

    # 3) Suffix match — persona has "大安區", key is "台北市|大安區"
    for key in keys:
        parts = parse_admin_key(key)
        if district in parts:
            return key

    # 4) Parent match — persona has "台北市大安區", find key "台北市"
    for key in keys:
        parts = parse_admin_key(key)
        for part in parts:
            if part in district:
                return key

    return None


def aggregate_children(data: dict[str, dict], parent_key: str) -> dict | None:
    """Aggregate child-level data under a parent key.

    E.g., if parent_key = "台北市" and data has "台北市|大安區", "台北市|中正區",
    returns the averaged distribution.
    """
    children = {}
    for key, val in data.items():
        parts = parse_admin_key(key)
        # Check if this key is a child of parent_key
        parent_parts = parse_admin_key(parent_key)
        if len(parts) > len(parent_parts):
            if parts[:len(parent_parts)] == parent_parts:
                children[key] = val

    if not children:
        return None

    # Average numeric values
    result: dict[str, float] = {}
    count = len(children)
    for child_val in children.values():
        if isinstance(child_val, dict):
            for k, v in child_val.items():
                if isinstance(v, (int, float)):
                    result[k] = result.get(k, 0.0) + v / count

    return result if result else None


def normalise_district(city: str, town: str = "", vill: str = "") -> str:
    """Build a normalised admin key from city/town/village fields."""
    parts = [p for p in (city, town, vill) if p and p.strip()]
    return "|".join(parts)
