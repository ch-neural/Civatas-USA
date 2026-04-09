"""US Administrative Hierarchy — drop-in replacement for tw_admin.py.

Hierarchy (mirrors the 3 levels of tw_admin):
  Level 1: State            — e.g. "Pennsylvania", "California"
  Level 2: County           — e.g. "Allegheny County", "Los Angeles County"
  Level 3: (reserved)       — sub-county tract or municipality, populated later

Storage format mirrors tw_admin: pipe-separated key, e.g.
    "Pennsylvania|Allegheny County"
    "California|Los Angeles County|Sub-tract X"

Canonical IDs are 2-digit (state) and 5-digit (county) US Census FIPS codes.
A separate ``fips_to_key`` / ``key_to_fips`` lookup is exposed for callers
that key on FIPS instead of human names.

Public API is the same as tw_admin.py so the call sites do not need to know
which country they're running in:
  parse_admin_key(key)        -> tuple[str, ...]
  build_admin_key(*parts)     -> str
  detect_level(key)           -> int
  match_district(name, keys)  -> str | None
  aggregate_children(d, key)  -> dict | None
  normalise_district(state, county, sub="") -> str

Plus US-specific helpers:
  load_fips_index(census_dir) -> populates the FIPS↔key lookups
  state_name(fips)            -> state name for a 2-digit FIPS
  county_name(fips)           -> county name for a 5-digit FIPS
  state_of_county(fips)       -> 2-digit state FIPS for a 5-digit county FIPS
  all_state_fips()            -> list[str]
  all_county_fips()           -> list[str]

Data is loaded lazily from Civatas-USA/data/census/{states,counties}.json
on first call to ``load_fips_index()``. The path is configurable so the
production deployment can point at its own copy of those files.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

# ── Public hierarchy helpers (mirror tw_admin signatures) ────────────


def parse_admin_key(key: str) -> tuple[str, ...]:
    """Parse a "|"-separated admin key into parts."""
    return tuple(p.strip() for p in (key or "").split("|") if p.strip())


def build_admin_key(*parts: str) -> str:
    """Build a "|"-separated admin key from parts."""
    return "|".join(p for p in parts if p)


def detect_level(key: str) -> int:
    """Detect the admin level of a key (1=state, 2=county, 3=sub-county)."""
    return len(parse_admin_key(key))


def normalise_district(state: str = "", county: str = "", sub: str = "") -> str:
    """Build a normalised admin key from state/county/sub fields.

    "PA"            → "Pennsylvania"           (auto-resolves the state code)
    "PA", "Allegheny" → "Pennsylvania|Allegheny County"
    "Pennsylvania", "Allegheny County" → "Pennsylvania|Allegheny County"
    """
    state_full = _resolve_state(state) or state
    county_full = _resolve_county(state_full, county) or county
    parts = [p for p in (state_full, county_full, sub) if p and p.strip()]
    return "|".join(parts)


def match_district(district: str, keys: list[str]) -> str | None:
    """Match a persona's district string against available admin keys.

    Tries multiple strategies (mirrors tw_admin.match_district):
      1. Exact match
      2. Substring containment (flat key vs district)
      3. Suffix/part match
      4. Parent match
    Additionally, if ``district`` looks like a FIPS code (5 digits), try the
    FIPS lookup directly.
    """
    if not district or not keys:
        return None

    # FIPS shortcut
    if district.isdigit() and len(district) == 5:
        key = _county_fips_to_key.get(district)
        if key and key in keys:
            return key

    if district in keys:
        return district

    flat_lookup = {k.replace("|", "").lower(): k for k in keys}
    if district.lower() in flat_lookup:
        return flat_lookup[district.lower()]
    for flat, key in flat_lookup.items():
        if district.lower() in flat or flat in district.lower():
            return key

    for key in keys:
        parts = parse_admin_key(key)
        if district in parts:
            return key

    for key in keys:
        for part in parse_admin_key(key):
            if part and part in district:
                return key
    return None


def aggregate_children(data: dict[str, dict], parent_key: str) -> dict | None:
    """Aggregate child-level data under a parent key.

    Same semantics as tw_admin.aggregate_children — averages numeric values
    across all children of ``parent_key``.
    """
    parent_parts = parse_admin_key(parent_key)
    children = {}
    for key, val in data.items():
        parts = parse_admin_key(key)
        if len(parts) > len(parent_parts) and parts[: len(parent_parts)] == parent_parts:
            children[key] = val
    if not children:
        return None
    result: dict[str, float] = {}
    n = len(children)
    for child_val in children.values():
        if isinstance(child_val, dict):
            for k, v in child_val.items():
                if isinstance(v, (int, float)):
                    result[k] = result.get(k, 0.0) + v / n
    return result if result else None


# ── FIPS index (US-specific) ──────────────────────────────────────────

_state_fips_to_name: dict[str, str] = {}
_state_name_to_fips: dict[str, str] = {}
_state_po_to_fips: dict[str, str] = {}
_county_fips_to_name: dict[str, str] = {}
_county_fips_to_state_fips: dict[str, str] = {}
_county_fips_to_key: dict[str, str] = {}
_loaded = False
_default_data_dir: Path | None = None


# Static fallback so the module is usable even before load_fips_index() is
# called. This covers the 50 states + DC.
_STATIC_STATE_PO = {
    "01": ("AL", "Alabama"), "02": ("AK", "Alaska"), "04": ("AZ", "Arizona"),
    "05": ("AR", "Arkansas"), "06": ("CA", "California"), "08": ("CO", "Colorado"),
    "09": ("CT", "Connecticut"), "10": ("DE", "Delaware"), "11": ("DC", "District of Columbia"),
    "12": ("FL", "Florida"), "13": ("GA", "Georgia"), "15": ("HI", "Hawaii"),
    "16": ("ID", "Idaho"), "17": ("IL", "Illinois"), "18": ("IN", "Indiana"),
    "19": ("IA", "Iowa"), "20": ("KS", "Kansas"), "21": ("KY", "Kentucky"),
    "22": ("LA", "Louisiana"), "23": ("ME", "Maine"), "24": ("MD", "Maryland"),
    "25": ("MA", "Massachusetts"), "26": ("MI", "Michigan"), "27": ("MN", "Minnesota"),
    "28": ("MS", "Mississippi"), "29": ("MO", "Missouri"), "30": ("MT", "Montana"),
    "31": ("NE", "Nebraska"), "32": ("NV", "Nevada"), "33": ("NH", "New Hampshire"),
    "34": ("NJ", "New Jersey"), "35": ("NM", "New Mexico"), "36": ("NY", "New York"),
    "37": ("NC", "North Carolina"), "38": ("ND", "North Dakota"), "39": ("OH", "Ohio"),
    "40": ("OK", "Oklahoma"), "41": ("OR", "Oregon"), "42": ("PA", "Pennsylvania"),
    "44": ("RI", "Rhode Island"), "45": ("SC", "South Carolina"), "46": ("SD", "South Dakota"),
    "47": ("TN", "Tennessee"), "48": ("TX", "Texas"), "49": ("UT", "Utah"),
    "50": ("VT", "Vermont"), "51": ("VA", "Virginia"), "53": ("WA", "Washington"),
    "54": ("WV", "West Virginia"), "55": ("WI", "Wisconsin"), "56": ("WY", "Wyoming"),
}


def _bootstrap_static() -> None:
    if _state_fips_to_name:
        return
    for fips, (po, name) in _STATIC_STATE_PO.items():
        _state_fips_to_name[fips] = name
        _state_name_to_fips[name.lower()] = fips
        _state_po_to_fips[po.lower()] = fips


_bootstrap_static()


def set_default_data_dir(path: str | os.PathLike) -> None:
    """Configure where load_fips_index() reads from when called with no arg."""
    global _default_data_dir
    _default_data_dir = Path(path)


def load_fips_index(data_dir: str | os.PathLike | None = None) -> None:
    """Load the full FIPS lookup tables from data/census/{states,counties}.json.

    Idempotent — repeat calls are no-ops unless ``data_dir`` differs from the
    previously loaded path.
    """
    global _loaded
    base = Path(data_dir) if data_dir else _default_data_dir
    if base is None:
        # Best-effort: assume we're co-located with Civatas-USA/data/
        here = Path(__file__).resolve()
        for parent in here.parents:
            candidate = parent / "data" / "census"
            if candidate.is_dir():
                base = parent / "data"
                break
    if base is None:
        # Static fallback already covers the 51 states; we just lack counties.
        _loaded = True
        return
    states_path = Path(base) / "census" / "states.json"
    counties_path = Path(base) / "census" / "counties.json"
    if states_path.exists():
        states = json.loads(states_path.read_text())
        for fips, rec in states.items():
            name = rec.get("name") or _state_fips_to_name.get(fips, fips)
            _state_fips_to_name[fips] = name
            _state_name_to_fips[name.lower()] = fips
    if counties_path.exists():
        counties = json.loads(counties_path.read_text())
        for fips, rec in counties.items():
            cname = rec.get("name", "")
            state_fips = fips[:2]
            state_name = _state_fips_to_name.get(state_fips, "")
            full_county = cname if cname.lower().endswith(("county", "parish", "borough", "city", "municipio", "census area", "planning region")) else f"{cname} County"
            _county_fips_to_name[fips] = full_county
            _county_fips_to_state_fips[fips] = state_fips
            if state_name:
                _county_fips_to_key[fips] = f"{state_name}|{full_county}"
    _loaded = True


# ── US-specific lookups ──────────────────────────────────────────────


def state_name(fips: str) -> str | None:
    return _state_fips_to_name.get((fips or "").zfill(2))


def state_po(fips: str) -> str | None:
    f = (fips or "").zfill(2)
    rec = _STATIC_STATE_PO.get(f)
    return rec[0] if rec else None


def county_name(fips: str) -> str | None:
    return _county_fips_to_name.get((fips or "").zfill(5))


def state_of_county(county_fips: str) -> str | None:
    return _county_fips_to_state_fips.get((county_fips or "").zfill(5))


def all_state_fips() -> list[str]:
    return sorted(_state_fips_to_name.keys())


def all_county_fips() -> list[str]:
    return sorted(_county_fips_to_name.keys())


def fips_to_key(fips: str) -> str | None:
    """Convert a state or county FIPS to a pipe-separated admin key."""
    f = (fips or "").strip()
    if len(f) == 2:
        name = _state_fips_to_name.get(f)
        return name
    if len(f) == 5:
        return _county_fips_to_key.get(f)
    return None


# ── Internal name resolvers used by normalise_district() ─────────────


def _resolve_state(s: str) -> str | None:
    if not s:
        return None
    s_lower = s.strip().lower()
    if s_lower in _state_name_to_fips:
        return _state_fips_to_name[_state_name_to_fips[s_lower]]
    if s_lower in _state_po_to_fips:
        return _state_fips_to_name[_state_po_to_fips[s_lower]]
    if s.isdigit() and s.zfill(2) in _state_fips_to_name:
        return _state_fips_to_name[s.zfill(2)]
    return None


def _resolve_county(state_full: str, county: str) -> str | None:
    if not county:
        return None
    c = county.strip()
    if not state_full:
        return c
    # Try direct match against the loaded county index
    target = f"{state_full}|{c}"
    for key in _county_fips_to_key.values():
        if key == target:
            return c
    # Try with " County" suffix
    target_full = f"{state_full}|{c} County"
    for key in _county_fips_to_key.values():
        if key == target_full:
            return f"{c} County"
    return c
