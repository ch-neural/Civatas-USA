"""US political leaning utilities — drop-in replacement for leaning.py.

Modeling decisions
==================
- **Continuous PVI is the source of truth** for partisan position. Each county
  has a Cook PVI float in roughly [-0.5, +0.5] (positive = D, negative = R),
  computed from 2020+2024 two-party share vs the national mean.
- The Civatas application code originally indexed everything on **discrete
  leaning labels** (偏左派/中立/偏右派). To keep call sites unchanged, we map
  the continuous PVI to a 5-bucket discretization that mirrors Cook's standard
  reporting language:

      Solid Dem   PVI ≥ +0.15
      Lean Dem    +0.05 ≤ PVI < +0.15
      Tossup      −0.05 < PVI < +0.05
      Lean Rep    −0.15 < PVI ≤ −0.05
      Solid Rep   PVI ≤ −0.15

  These five labels are the canonical 5-tier spectrum. The 3-tier spectrum
  collapses Solid+Lean on each side:

      Lean Dem   = {Solid Dem, Lean Dem}
      Tossup     = {Tossup}
      Lean Rep   = {Solid Rep, Lean Rep}

The original leaning.py stored Taiwan-style labels in the same string fields
("偏左派", "偏綠", etc.). For US workspaces, the same fields hold one of the
5-tier labels above plus the canonical party leanings ("Democratic-leaning",
"Republican-leaning", "Independent"). Existing TW workspaces are unaffected
because this module is imported only when ``country == "US"``.

Public API
----------
LEANING_SPECTRUM_3 = ["Lean Dem", "Tossup", "Lean Rep"]
LEANING_SPECTRUM_5 = ["Solid Dem", "Lean Dem", "Tossup", "Lean Rep", "Solid Rep"]
PARTY_LEANING:    dict[str, str]
FIVE_TO_THREE:    dict[str, str]

normalize_leaning(s)         -> canonical 3-tier label
leaning_distance(a, b)       -> 0.0..1.0
leaning_affinity(agent, art) -> 0.0..1.0  (1.0 = perfect match)
get_party_leaning(party)     -> 5-tier label

US-specific helpers:

pvi_to_label(pvi)            -> 5-tier label
label_to_pvi(label)          -> approximate centroid PVI for a label
load_county_pvi(path)        -> {fips → pvi float}
county_leaning(fips)         -> 5-tier label, looking up the loaded index
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

# Canonical 5-tier spectrum (US)
LEANING_SPECTRUM_5 = ["Solid Dem", "Lean Dem", "Tossup", "Lean Rep", "Solid Rep"]

# Canonical 3-tier spectrum (collapses Solid+Lean)
LEANING_SPECTRUM_3 = ["Lean Dem", "Tossup", "Lean Rep"]

# Party-name → 5-tier leaning. Synonyms cover both English and the names that
# show up in MEDSL csv ("DEMOCRAT" / "REPUBLICAN", upper case).
PARTY_LEANING: dict[str, str] = {
    # Major parties
    "democratic":           "Lean Dem",
    "democrat":             "Lean Dem",
    "democratic party":     "Lean Dem",
    "dem":                  "Lean Dem",
    "d":                    "Lean Dem",
    "republican":           "Lean Rep",
    "republican party":     "Lean Rep",
    "rep":                  "Lean Rep",
    "gop":                  "Lean Rep",
    "r":                    "Lean Rep",
    # Minor parties — bucketed by their dominant ideological lean
    "libertarian":          "Lean Rep",   # libertarians historically split GOP-leaning
    "libertarian party":    "Lean Rep",
    "green":                "Lean Dem",
    "green party":          "Lean Dem",
    "constitution":         "Lean Rep",
    "constitution party":   "Lean Rep",
    "working families":     "Lean Dem",
    "independence":         "Tossup",
    "independent":          "Tossup",
    "no party affiliation": "Tossup",
    "unaffiliated":         "Tossup",
    "nonpartisan":          "Tossup",
    "other":                "Tossup",
}

# 5-tier → 3-tier collapsing rule
FIVE_TO_THREE: dict[str, str] = {
    "Solid Dem":  "Lean Dem",
    "Lean Dem":   "Lean Dem",
    "Tossup":     "Tossup",
    "Lean Rep":   "Lean Rep",
    "Solid Rep":  "Lean Rep",
}

# Approximate centroid PVI for each 5-tier label (used when only the label is
# known and a numeric value is needed for downstream math).
LABEL_TO_PVI: dict[str, float] = {
    "Solid Dem":  +0.20,
    "Lean Dem":   +0.10,
    "Tossup":     +0.00,
    "Lean Rep":   -0.10,
    "Solid Rep":  -0.20,
}


# ── Continuous ↔ discrete ────────────────────────────────────────────


def pvi_to_label(pvi: float) -> str:
    """Convert a continuous Cook PVI to the canonical 5-tier label."""
    try:
        p = float(pvi)
    except (TypeError, ValueError):
        return "Tossup"
    if p >= 0.15:
        return "Solid Dem"
    if p >= 0.05:
        return "Lean Dem"
    if p > -0.05:
        return "Tossup"
    if p > -0.15:
        return "Lean Rep"
    return "Solid Rep"


def label_to_pvi(label: str) -> float:
    """Approximate centroid PVI for a 5-tier label (Tossup → 0)."""
    return LABEL_TO_PVI.get(normalize_leaning_5(label), 0.0)


# ── Normalization ────────────────────────────────────────────────────


def normalize_leaning_5(s: str) -> str:
    """Normalize any leaning string to the 5-tier spectrum.

    Accepts: 5-tier labels, 3-tier labels, party names, or "D+N"/"R+N" labels.
    """
    if not s:
        return "Tossup"
    s = str(s).strip()
    if s in LEANING_SPECTRUM_5:
        return s
    if s in LEANING_SPECTRUM_3:
        # 3-tier → 5-tier: pick the milder bucket
        return {"Lean Dem": "Lean Dem", "Tossup": "Tossup", "Lean Rep": "Lean Rep"}[s]
    s_lower = s.lower()
    if s_lower in PARTY_LEANING:
        return PARTY_LEANING[s_lower]
    # Cook-style "D+N" / "R+N"
    if s_lower.startswith("d+"):
        try:
            n = int(s_lower[2:])
            return pvi_to_label(n / 100.0)
        except ValueError:
            pass
    if s_lower.startswith("r+"):
        try:
            n = int(s_lower[2:])
            return pvi_to_label(-n / 100.0)
        except ValueError:
            pass
    if s_lower in {"even", "tossup", "swing"}:
        return "Tossup"
    return "Tossup"


def normalize_leaning(s: str) -> str:
    """Normalize to the canonical 3-tier spectrum (matches leaning.py API)."""
    five = normalize_leaning_5(s)
    return FIVE_TO_THREE.get(five, "Tossup")


def leaning_distance(a: str, b: str) -> float:
    """Distance between two leanings on the 3-tier spectrum (0.0 to 1.0)."""
    idx = {label: i for i, label in enumerate(LEANING_SPECTRUM_3)}
    a_idx = idx.get(normalize_leaning(a), 1)
    b_idx = idx.get(normalize_leaning(b), 1)
    return abs(a_idx - b_idx) / 2.0


def leaning_distance_5(a: str, b: str) -> float:
    """Distance on the 5-tier spectrum (0.0 to 1.0)."""
    idx = {label: i for i, label in enumerate(LEANING_SPECTRUM_5)}
    a_idx = idx.get(normalize_leaning_5(a), 2)
    b_idx = idx.get(normalize_leaning_5(b), 2)
    return abs(a_idx - b_idx) / 4.0


def leaning_affinity(agent_leaning: str, article_leaning: Optional[str]) -> float:
    """Affinity score (0.0 to 1.0) between an agent and article leaning."""
    if not article_leaning:
        return 0.5
    return 1.0 - leaning_distance(agent_leaning, article_leaning)


def get_party_leaning(party_name: str) -> str:
    """Map a US political party name to its 5-tier leaning."""
    return PARTY_LEANING.get((party_name or "").strip().lower(), "Tossup")


# ── County PVI index ─────────────────────────────────────────────────

_county_pvi: dict[str, float] = {}
_loaded_path: Path | None = None


def load_county_pvi(path: str | None = None) -> dict[str, float]:
    """Load the per-county PVI index from leaning_profile_us.json.

    If ``path`` is None, search upwards for ``data/elections/leaning_profile_us.json``.
    Returns the loaded {fips → pvi} mapping.
    """
    global _county_pvi, _loaded_path
    if path is None:
        here = Path(__file__).resolve()
        for parent in here.parents:
            cand = parent / "data" / "elections" / "leaning_profile_us.json"
            if cand.exists():
                path = str(cand)
                break
    if path is None:
        return _county_pvi
    p = Path(path)
    if _loaded_path == p and _county_pvi:
        return _county_pvi
    if not p.exists():
        return _county_pvi
    payload = json.loads(p.read_text())
    counties = payload.get("counties", {})
    _county_pvi = {fips: float(rec.get("pvi", 0.0)) for fips, rec in counties.items()}
    _loaded_path = p
    return _county_pvi


def county_pvi(fips: str) -> Optional[float]:
    if not _county_pvi:
        load_county_pvi()
    return _county_pvi.get((fips or "").zfill(5))


def county_leaning(fips: str) -> str:
    """Return the 5-tier label for a county FIPS, defaulting to Tossup."""
    p = county_pvi(fips)
    return pvi_to_label(p) if p is not None else "Tossup"
