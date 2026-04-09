"""Auto-repair strategies for corrupted uploads.

When a file cannot be parsed, this module tries:
1. Encoding fixes (BOM removal, Big5 → UTF-8, Latin-1)
2. JSON cleanup (trailing commas, comments, truncated data)
3. Government API fallback — re-download from known public APIs
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime

import urllib.request

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Known government data sources  (keyword in filename → API builder)
# ---------------------------------------------------------------------------

_GOV_SOURCES: list[dict] = [
    {
        "keywords": ["人口結構", "各區人口"],
        "api_builder": "_fetch_taichung_demographics",
        "description": "臺中市各區人口結構（年齡 × 性別 × 區域）",
    },
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def try_repair_content(filename: str, content: bytes) -> bytes | None:
    """Try to repair file content. Returns fixed bytes or None."""

    # Strategy 1: BOM removal
    fixed = _strip_bom(content)
    if fixed != content and _is_valid_json(fixed):
        logger.info("Repaired: removed BOM")
        return fixed

    # Strategy 2: Try Big5 encoding (common for Taiwan gov data)
    try:
        text = content.decode("big5")
        fixed = text.encode("utf-8")
        if _is_valid_json(fixed):
            logger.info("Repaired: Big5 → UTF-8")
            return fixed
    except (UnicodeDecodeError, UnicodeEncodeError):
        pass

    # Strategy 3: Fix common JSON issues
    try:
        text = content.decode("utf-8", errors="replace")
        fixed_text = _fix_json_issues(text)
        if fixed_text != text and _is_valid_json(fixed_text.encode("utf-8")):
            logger.info("Repaired: fixed JSON syntax issues")
            return fixed_text.encode("utf-8")
    except Exception:
        pass

    return None


def try_fetch_from_gov_api(filename: str) -> bytes | None:
    """If filename matches a known government dataset, fetch it from the API."""
    for source in _GOV_SOURCES:
        if any(kw in filename for kw in source["keywords"]):
            builder_name = source["api_builder"]
            builder = globals().get(builder_name)
            if builder:
                try:
                    data = builder()
                    if data:
                        logger.info(f"Auto-fetched from government API: {source['description']}")
                        return data
                except Exception as e:
                    logger.warning(f"Government API fetch failed: {e}")
    return None


# ---------------------------------------------------------------------------
# Government API fetchers
# ---------------------------------------------------------------------------

def _fetch_taichung_demographics() -> bytes | None:
    """Fetch Taichung population structure from demographics API.

    API: https://demographics.taichung.gov.tw/Demographic/WebService/APIReport02.aspx
    Returns age × gender × district data.
    """
    # Use latest available data (current year in ROC calendar, latest month)
    now = datetime.now()
    roc_year = now.year - 1911
    # Try from current month backward to find available data
    for month_offset in range(0, 6):
        month = now.month - month_offset
        year = roc_year
        if month <= 0:
            month += 12
            year -= 1

        url = (
            f"https://demographics.taichung.gov.tw/Demographic/WebService/"
            f"APIReport02.aspx?Year={year}&Month={month:02d}"
        )
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=600.0) as resp:
                if resp.status == 200:
                    data_bytes = resp.read()
                    import json as _json
                    parsed = _json.loads(data_bytes)
                    if isinstance(parsed, list) and len(parsed) > 0:
                        return data_bytes
        except Exception:
            continue

    return None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _strip_bom(content: bytes) -> bytes:
    """Remove UTF-8 BOM if present."""
    if content.startswith(b"\xef\xbb\xbf"):
        return content[3:]
    return content


def _is_valid_json(content: bytes) -> bool:
    """Quick check if content is valid JSON."""
    try:
        json.loads(content)
        return True
    except (json.JSONDecodeError, UnicodeDecodeError):
        return False


def _fix_json_issues(text: str) -> str:
    """Fix common JSON syntax issues."""
    # Remove single-line comments
    text = re.sub(r"//.*$", "", text, flags=re.MULTILINE)
    # Remove trailing commas before } or ]
    text = re.sub(r",\s*([}\]])", r"\1", text)
    # Remove control characters (except newlines/tabs)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    return text
