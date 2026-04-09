"""Shared political leaning utilities — spectrum, normalization, distance."""

from typing import Optional

# Canonical 3-tier spectrum
LEANING_SPECTRUM_3 = ["偏左派", "中立", "偏右派"]

# 5-tier spectrum (used in some data sources)
LEANING_SPECTRUM_5 = ["強烈左派", "偏左派", "中立", "偏右派", "強烈右派"]

# Taiwan party leaning mapping
PARTY_LEANING: dict[str, str] = {
    "民主進步黨": "偏綠",
    "民進黨": "偏綠",
    "DPP": "偏綠",
    "中國國民黨": "偏藍",
    "國民黨": "偏藍",
    "KMT": "偏藍",
    "台灣民眾黨": "偏白",
    "民眾黨": "偏白",
    "TPP": "偏白",
    "時代力量": "偏綠",
    "新黨": "偏藍",
    "親民黨": "偏藍",
    "台灣基進": "偏綠",
    "無黨籍": "中立",
}

# 5-tier → 3-tier mapping
FIVE_TO_THREE: dict[str, str] = {
    "強烈左派": "偏左派",
    "偏左派": "偏左派",
    "中立": "中立",
    "偏右派": "偏右派",
    "強烈右派": "偏右派",
}


def normalize_leaning(s: str) -> str:
    """Normalize any leaning string to the canonical 3-tier spectrum."""
    s = s.strip()
    if s in LEANING_SPECTRUM_3:
        return s
    if s in FIVE_TO_THREE:
        return FIVE_TO_THREE[s]
    # Fuzzy matching
    s_lower = s.lower()
    for label in LEANING_SPECTRUM_3:
        if label in s:
            return label
    return "中立"


def leaning_distance(a: str, b: str) -> float:
    """Distance between two leanings on the 3-tier spectrum (0.0 to 1.0)."""
    a_norm = normalize_leaning(a)
    b_norm = normalize_leaning(b)
    idx = {label: i for i, label in enumerate(LEANING_SPECTRUM_3)}
    a_idx = idx.get(a_norm, 1)
    b_idx = idx.get(b_norm, 1)
    return abs(a_idx - b_idx) / 2.0


def leaning_affinity(agent_leaning: str, article_leaning: Optional[str]) -> float:
    """Affinity score (0.0 to 1.0) between an agent and article leaning."""
    if not article_leaning:
        return 0.5  # neutral for unknown
    dist = leaning_distance(agent_leaning, article_leaning)
    return 1.0 - dist


def get_party_leaning(party_name: str) -> str:
    """Map a Taiwan political party name to its leaning."""
    return PARTY_LEANING.get(party_name, "中立")
