"""
Leaning Profile — 政治傾向分佈管理

使用者上傳選舉/政治統計 CSV/JSON，系統解析為行政區級機率表。
Persona 生成時用 get_district_leaning() 做機率抽樣。
"""
from __future__ import annotations

import csv
import io
import json
import os
import random
from typing import Any

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
PROFILE_FILE = os.path.join(DATA_DIR, "leaning_profile.json")
SHARED_DIR = "/app/shared"
SHARED_PROFILE = os.path.join(SHARED_DIR, "leaning_profile.json")

# 5-level spectrum
SPECTRUM = ["偏左派", "中立", "偏右派"]

# ── Party → spectrum mapping ─────────────────────────────────────────
PARTY_SPECTRUM: dict[str, str] = {
    # 偏左派
    "民主進步黨": "偏左派",
    "民進黨": "偏左派",
    "台灣團結聯盟": "偏左派",
    "台聯":   "偏左派",
    "綠":     "偏左派",
    "DPP":    "偏左派",
    # 偏左派
    "時代力量": "偏左派",
    "台灣基進": "偏左派",
    "基進":     "偏左派",
    # 中立
    "台灣民眾黨": "中立",
    "民眾黨": "中立",
    "白":     "中立",
    "TPP":    "中立",
    "無黨籍": "中立",
    # 偏右派
    "中國國民黨": "偏右派",
    "國民黨": "偏右派",
    "親民黨": "偏右派",
    "藍":     "偏右派",
    "KMT":    "偏右派",
    # 偏右派
    "新黨":   "偏右派",
    "紅":     "偏右派",
}


# ── Parse uploaded file ──────────────────────────────────────────────

def _normalise_header(h: str) -> str:
    """Strip whitespace, BOM, and common prefixes."""
    return h.strip().replace("\ufeff", "")


def _detect_format(headers: list[str]) -> str:
    """Detect if CSV uses party-vote or direct-spectrum format."""
    normed = [_normalise_header(h) for h in headers]
    # Direct spectrum: headers contain spectrum labels
    if any(s in normed for s in SPECTRUM):
        return "spectrum"
    # Party vote: headers contain party names
    return "party"


def _party_to_spectrum_index(party: str) -> int:
    """Map a party column header to a spectrum index."""
    party_clean = _normalise_header(party)
    for keyword, leaning in PARTY_SPECTRUM.items():
        if keyword in party_clean:
            return SPECTRUM.index(leaning)
    return 2  # default: 中立


def parse_csv(content: str) -> dict[str, dict[str, float]]:
    """Parse CSV content into district → spectrum probability dict."""
    reader = csv.reader(io.StringIO(content))
    headers = next(reader)

    fmt = _detect_format(headers)
    district_col = 0  # assume first column is district

    profile: dict[str, dict[str, float]] = {}

    if fmt == "spectrum":
        # Direct format: columns are spectrum labels with probabilities
        col_map: dict[int, str] = {}
        for i, h in enumerate(headers):
            normed = _normalise_header(h)
            if normed in SPECTRUM:
                col_map[i] = normed

        for row in reader:
            if not row or not row[0].strip():
                continue
            district = row[district_col].strip()
            dist: dict[str, float] = {s: 0.0 for s in SPECTRUM}
            for col_idx, spectrum_label in col_map.items():
                try:
                    dist[spectrum_label] = float(row[col_idx])
                except (IndexError, ValueError):
                    pass
            # Normalise to sum=1
            total = sum(dist.values())
            if total > 0:
                dist = {k: v / total for k, v in dist.items()}
            else:
                dist = {s: 0.2 for s in SPECTRUM}
            profile[district] = dist

    else:
        # Party vote format: columns are party names with vote counts
        party_cols: list[tuple[int, int]] = []  # (col_idx, spectrum_idx)
        for i, h in enumerate(headers):
            if i == district_col:
                continue
            normed = _normalise_header(h)
            if normed:
                party_cols.append((i, _party_to_spectrum_index(h)))

        for row in reader:
            if not row or not row[0].strip():
                continue
            district = row[district_col].strip()
            votes: dict[str, float] = {s: 0.0 for s in SPECTRUM}
            for col_idx, spec_idx in party_cols:
                try:
                    val = float(row[col_idx].strip().replace(",", ""))
                    votes[SPECTRUM[spec_idx]] += val
                except (IndexError, ValueError):
                    pass
            total = sum(votes.values())
            if total > 0:
                dist = {k: v / total for k, v in votes.items()}
            else:
                dist = {s: 0.2 for s in SPECTRUM}
            profile[district] = dist

    return profile


def parse_json(content: str) -> dict[str, dict[str, float]]:
    """Parse JSON content — expect {district: {spectrum: prob}} or similar."""
    data = json.loads(content)
    profile: dict[str, dict[str, float]] = {}

    for district, values in data.items():
        if isinstance(values, dict):
            dist = {s: 0.0 for s in SPECTRUM}
            for key, val in values.items():
                key_clean = _normalise_header(key)
                # Try direct spectrum match
                if key_clean in SPECTRUM:
                    dist[key_clean] = float(val)
                else:
                    # Try party mapping
                    idx = _party_to_spectrum_index(key_clean)
                    dist[SPECTRUM[idx]] += float(val)

            total = sum(dist.values())
            if total > 0:
                dist = {k: v / total for k, v in dist.items()}
            else:
                dist = {s: 0.2 for s in SPECTRUM}
            profile[district] = dist

    return profile


# ── Storage ──────────────────────────────────────────────────────────

def save_profile(
    profile: dict[str, dict[str, float]],
    *,
    description: str = "",
    data_sources: list[str] | None = None,
) -> dict:
    """Save profile to disk and shared volume, return summary.
    
    Args:
        profile: {district: {leaning: probability}}
        description: Human-readable description of this profile
        data_sources: List of data source descriptions (e.g. election names)
    """
    import time as _time

    os.makedirs(DATA_DIR, exist_ok=True)
    data = {
        "description": description,
        "data_sources": data_sources or [],
        "created_at": _time.strftime("%Y-%m-%d %H:%M:%S"),
        "spectrum": SPECTRUM,
        "count": len(profile),
        "districts": profile,
    }
    with open(PROFILE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    # Sync to shared volume for cross-service access
    try:
        os.makedirs(SHARED_DIR, exist_ok=True)
        with open(SHARED_PROFILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return data


def load_profile() -> dict | None:
    """Load saved profile, return None if not exists."""
    if not os.path.exists(PROFILE_FILE):
        return None
    with open(PROFILE_FILE, encoding="utf-8") as f:
        return json.load(f)


def delete_profile() -> bool:
    """Delete profile file (and shared copy)."""
    deleted = False
    if os.path.exists(PROFILE_FILE):
        os.remove(PROFILE_FILE)
        deleted = True
    try:
        if os.path.exists(SHARED_PROFILE):
            os.remove(SHARED_PROFILE)
    except OSError:
        pass
    return deleted


def has_profile() -> bool:
    """Check if a leaning profile exists."""
    return os.path.exists(PROFILE_FILE)


# ── Query ────────────────────────────────────────────────────────────

def get_district_leaning(district: str) -> str:
    """Sample a political leaning for a given district based on probability.
    Returns empty string if no profile exists.
    """
    profile_data = load_profile()
    if not profile_data:
        return ""

    districts = profile_data.get("districts", {})

    # Try exact match first
    dist = districts.get(district)

    # Try fuzzy match (partial containment)
    if not dist:
        for key, val in districts.items():
            if key in district or district in key:
                dist = val
                break

    if not dist:
        # No match → uniform distribution
        dist = {s: 0.2 for s in SPECTRUM}

    # Weighted random sampling
    labels = list(dist.keys())
    weights = list(dist.values())
    return random.choices(labels, weights=weights, k=1)[0]
