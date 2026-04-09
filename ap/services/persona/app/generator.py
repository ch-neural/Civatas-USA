"""Persona generation strategies: template, LLM, hybrid."""
from __future__ import annotations

import json
import logging
import os
import random
from typing import Any

from shared.schemas import Person

from .templates import LOCALE_SEGMENTS, LOCALE_SEPARATOR

log = logging.getLogger(__name__)

# US-only English persona prompt (TW dual-path removed in Stage 1.9 cleanup).
try:
    from .prompts import build_persona_prompt_en as _BUILD_PERSONA_PROMPT_EN
except ImportError:
    from prompts import build_persona_prompt_en as _BUILD_PERSONA_PROMPT_EN  # type: ignore

# ── Stat module integration ──────────────────────────────────────────

_STAT_MODULES_PATH = "/app/shared/stat_modules/enabled.json"
_stat_cache: dict | None = None
_stat_cache_mtime: float = 0


def _load_enabled_stats() -> dict[str, dict]:
    """Load enabled stat modules from shared volume (cached by mtime)."""
    global _stat_cache, _stat_cache_mtime
    if not os.path.exists(_STAT_MODULES_PATH):
        return {}
    try:
        mtime = os.path.getmtime(_STAT_MODULES_PATH)
        if _stat_cache is not None and mtime == _stat_cache_mtime:
            return _stat_cache
        with open(_STAT_MODULES_PATH, encoding="utf-8") as f:
            data = json.load(f)
        _stat_cache = data.get("modules", {})
        _stat_cache_mtime = mtime
        log.info(f"Loaded {len(_stat_cache)} enabled stat modules")
        return _stat_cache
    except Exception as e:
        log.warning(f"Failed to load stat modules: {e}")
        return {}


def _get_district_stats(district: str) -> dict[str, Any]:
    """Get aggregated stats for a district from all enabled modules.

    Returns a flat dict like:
      {"2021公投_公投領票率": 0.38, "2022縣市長_領票率": 0.62, ...}
    """
    modules = _load_enabled_stats()
    if not modules or not district:
        return {}

    result: dict[str, Any] = {}
    for mod_id, mod_data in modules.items():
        district_data = _fuzzy_match_district(district, mod_data)
        if not district_data or not isinstance(district_data, dict):
            continue
        # Flatten with module prefix removed for cleaner output
        for field_name, field_val in district_data.items():
            if field_name == "sample_size":
                continue
            result[field_name] = field_val

    return result


def _normalize_district(name: str) -> str:
    """Normalize district name for comparison: 台↔臺, remove separators."""
    return (name
            .replace("台", "臺")
            .replace("|", "")
            .replace("｜", "")
            .replace(" ", "")
            .strip())


def _fuzzy_match_district(district: str, mod_data: dict) -> dict | None:
    """Match a district name against module data keys with fuzzy logic."""
    # 1) Direct match
    if district in mod_data:
        return mod_data[district]

    # 2) Normalized match (台↔臺, no separator)
    norm_district = _normalize_district(district)
    for key, val in mod_data.items():
        if _normalize_district(key) == norm_district:
            return val

    # 3) Partial / substring match (e.g. "士林區" matches "臺北市|士林區")
    for key, val in mod_data.items():
        norm_key = _normalize_district(key)
        if norm_key in norm_district or norm_district in norm_key:
            return val

    return None


# ── Rule-based media habit inference ─────────────────────────────────

_AGE_MEDIA_MAP = [
    # (age_min, age_max, habits_with_weights)
    (15, 24,  [("Dcard", 0.7), ("PTT", 0.4), ("Instagram", 0.5)]),
    (25, 34,  [("PTT", 0.6), ("Dcard", 0.3), ("Facebook社團", 0.3)]),
    (35, 49,  [("Facebook社團", 0.6), ("PTT", 0.3), ("LINE群組謠言", 0.3)]),
    (50, 64,  [("傳統電視新聞", 0.7), ("LINE群組謠言", 0.6), ("Facebook社團", 0.3)]),
    (65, 120, [("傳統電視新聞", 0.9), ("LINE群組謠言", 0.7)]),
]

_OCCUPATION_MEDIA = {
    "資訊": ["PTT", "PTT 科技版"],
    "科技": ["PTT", "PTT 科技版"],
    "工程": ["PTT", "PTT 科技版"],
    "軟體": ["PTT", "PTT 科技版"],
    "電子": ["PTT 科技版"],
    "學生": ["Dcard", "PTT"],
    "教師": ["Facebook社團", "PTT"],
    "教育": ["Facebook社團", "PTT"],
    "醫": ["PTT", "Facebook社團"],
    "公務": ["傳統電視新聞", "Facebook社團"],
    "軍": ["傳統電視新聞", "LINE群組謠言"],
    "農": ["傳統電視新聞", "LINE群組謠言"],
    "退休": ["傳統電視新聞", "LINE群組謠言"],
    "家管": ["傳統電視新聞", "LINE群組謠言", "Facebook社團"],
    "服務": ["Facebook社團", "LINE群組謠言"],
    "商": ["Facebook社團", "LINE群組謠言"],
}

_EDUCATION_MEDIA = {
    "大學": ["PTT", "Dcard"],
    "碩士": ["PTT"],
    "博士": ["PTT"],
    "研究": ["PTT"],
    "高中": ["Dcard", "Facebook社團"],
    "國中": ["Facebook社團", "傳統電視新聞"],
    "國小": ["傳統電視新聞", "LINE群組謠言"],
}


def infer_media_habit(age: int, occupation: str, education: str,
                      political_leaning: str = "") -> str:
    """Infer likely media habits from demographics using weighted rules.

    Also appends a news-leaning category (偏獨新聞/中間新聞/偏統新聞)
    based on political_leaning, so the feed engine can match agents to
    appropriately-leaning news sources.
    """
    habits: dict[str, float] = {}

    # 1) Age-based inference
    for age_min, age_max, entries in _AGE_MEDIA_MAP:
        if age_min <= age <= age_max:
            for media, weight in entries:
                habits[media] = max(habits.get(media, 0), weight)
            break

    # 2) Occupation-based boost
    for keyword, media_list in _OCCUPATION_MEDIA.items():
        if keyword in (occupation or ""):
            for m in media_list:
                habits[m] = max(habits.get(m, 0), 0.6)

    # 3) Education-based boost
    for keyword, media_list in _EDUCATION_MEDIA.items():
        if keyword in (education or ""):
            for m in media_list:
                habits[m] = max(habits.get(m, 0), 0.4)

    # Select top habits (weight > 0.3, max 3)
    if not habits:
        habits = {"傳統電視新聞": 0.5, "Facebook社團": 0.3}

    selected = sorted(habits.items(), key=lambda x: -x[1])
    # Pick top ones, add some randomness
    result = []
    for media, weight in selected:
        if weight >= 0.3 and (len(result) < 3 or random.random() < weight):
            result.append(media)
        if len(result) >= 3:
            break

    # 4) Append news-leaning category based on political leaning
    # This maps to diet_map entries: 偏獨新聞→[自由時報,三立,民視], 偏統新聞→[中時,聯合,TVBS], 中間新聞→[ETtoday,壹蘋]
    _leaning_news = {"偏左派": "偏獨新聞", "偏右派": "偏統新聞", "中立": "中間新聞"}
    news_cat = _leaning_news.get(political_leaning, "中間新聞")
    if news_cat not in result:
        result.append(news_cat)

    return ", ".join(result)


# ── Rule-based political leaning inference ────────────────────────────

_OCCUPATION_LEANING: dict[str, tuple[str, float]] = {
    "軍":     ("偏右派", 0.7),
    "公務":   ("偏右派", 0.5),
    "退休":   ("偏右派", 0.4),
    "教師":   ("偏左派", 0.4),
    "教育":   ("偏左派", 0.4),
    "學生":   ("偏左派", 0.5),
    "科技":   ("偏左派", 0.5),
    "資訊":   ("偏左派", 0.5),
    "軟體":   ("偏左派", 0.5),
    "工程":   ("偏左派", 0.4),
    "農":     ("偏右派", 0.4),
    "服務":   ("中立", 0.3),
    "商":     ("中立", 0.3),
    "醫":     ("中立", 0.3),
    "自由":   ("中立", 0.3),
    "家管":   ("中立", 0.3),
}

_AGE_LEANING = [
    # (age_min, age_max, leaning, weight)
    (18, 29,  "偏左派", 0.5),
    (30, 39,  "偏左派", 0.3),
    (40, 49,  "中立",       0.3),
    (50, 59,  "偏右派",   0.3),
    (60, 120, "偏右派",   0.5),
]

_LEANING_SPECTRUM = ["偏左派", "中立", "偏右派"]


def infer_political_leaning(age: int, occupation: str, education: str) -> str:
    """Infer likely political leaning from demographics."""
    # Accumulate weighted leaning scores
    scores: dict[str, float] = {lean: 0.0 for lean in _LEANING_SPECTRUM}
    scores["中立"] = 0.2  # slight prior toward neutral

    # 1) Age-based
    for age_min, age_max, leaning, weight in _AGE_LEANING:
        if age_min <= age <= age_max:
            scores[leaning] += weight
            break

    # 2) Occupation-based
    for keyword, (leaning, weight) in _OCCUPATION_LEANING.items():
        if keyword in (occupation or ""):
            scores[leaning] += weight

    # 3) party_lean override (if available, handled in _person_fields)

    # Pick highest scoring leaning
    return max(scores, key=lambda k: scores[k])


# ── Personality trait inference ──────────────────────────────────────

# Four simplified personality dimensions (inspired by Big Five, adapted for simulation)
# Each dimension has 3 levels for simplicity.

_PERSONALITY_DIMS = {
    "expressiveness": ["高度表達", "中等表達", "沉默寡言"],
    "emotional_stability": ["穩定冷靜", "一般穩定", "敏感衝動"],
    "sociability": ["外向社交", "適度社交", "內向獨處"],
    "openness": ["開放多元", "中等開放", "固守觀點"],
}


def infer_personality(
    age: int, gender: str, occupation: str, education: str,
) -> dict[str, str]:
    """Infer personality traits from demographics with noise.

    Uses heuristic weights based on cross-cultural psychology literature:
    - Age → emotional stability increases with age (Roberts et al., 2006)
    - Age → openness peaks in young adulthood, decreases in old age
    - Occupation → sociability correlated with client-facing roles
    - Education → openness slightly correlated with higher education
    - ~25% noise factor prevents rigid stereotyping

    Returns dict with keys: expressiveness, emotional_stability, sociability, openness
    """
    result = {}
    occ = occupation or ""
    edu = education or ""
    gen = gender or ""

    # ── 1) Expressiveness: age-driven, younger = more expressive ──
    if age < 30:
        weights = [45, 40, 15]
    elif age < 50:
        weights = [30, 45, 25]
    else:
        weights = [20, 35, 45]
    # Gender nuance: slight adjustment (small effect size)
    if "女" in gen:
        weights[0] += 5  # slightly more expressive
        weights[2] -= 5
    result["expressiveness"] = random.choices(
        _PERSONALITY_DIMS["expressiveness"], weights=weights, k=1
    )[0]

    # ── 2) Emotional stability: increases with age ──
    if age < 25:
        weights = [20, 40, 40]
    elif age < 40:
        weights = [30, 45, 25]
    elif age < 60:
        weights = [40, 40, 20]
    else:
        weights = [50, 35, 15]
    result["emotional_stability"] = random.choices(
        _PERSONALITY_DIMS["emotional_stability"], weights=weights, k=1
    )[0]

    # ── 3) Sociability: occupation-driven ──
    weights = [30, 45, 25]  # default: slightly extraverted
    # Client-facing → more sociable
    for kw in ["業務", "銷售", "服務", "教師", "老師", "醫師", "護理", "記者", "公關"]:
        if kw in occ:
            weights = [50, 35, 15]
            break
    # Technical / solo work → more introverted
    for kw in ["工程", "程式", "會計", "研究", "資訊", "IT", "分析"]:
        if kw in occ:
            weights = [15, 35, 50]
            break
    # Retired / elderly → mixed
    if age >= 65:
        weights = [25, 40, 35]
    result["sociability"] = random.choices(
        _PERSONALITY_DIMS["sociability"], weights=weights, k=1
    )[0]

    # ── 4) Openness: education and age driven ──
    if age < 30:
        weights = [45, 35, 20]  # young → more open
    elif age < 50:
        weights = [35, 40, 25]
    else:
        weights = [20, 35, 45]  # older → more conservative
    # Higher education → slightly more open
    for kw in ["大學", "碩士", "博士", "研究所", "大專"]:
        if kw in edu:
            weights[0] += 10
            weights[2] -= 10
            break
    result["openness"] = random.choices(
        _PERSONALITY_DIMS["openness"], weights=weights, k=1
    )[0]

    return result


async def generate_personas(
    persons: list[Person],
    strategy: str = "template",
    locale: str = "zh-TW",
    template: str | None = None,
    llm_prompt: str | None = None,
    vendor_assignments: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    if strategy == "template":
        return [_from_template(p, locale, template, vendor_assignments) for p in persons]
    if strategy == "llm":
        import asyncio
        tasks = [_safe_llm_call(p, locale, llm_prompt, template, vendor_assignments) for p in persons]
        return list(await asyncio.gather(*tasks))
    if strategy == "hybrid":
        import asyncio
        tasks = [_safe_hybrid_call(p, locale, template, llm_prompt, vendor_assignments) for p in persons]
        return list(await asyncio.gather(*tasks))
    raise ValueError(f"Unknown strategy: {strategy}")


async def _safe_llm_call(
    p: Person, locale: str, llm_prompt: str | None,
    template: str | None, vendor_assignments: dict[str, str] | None,
    max_retries: int = 2,
) -> dict[str, Any]:
    """Call _from_llm with retry → vendor failover → template fallback."""
    import asyncio

    original_vendor = "openai"
    if vendor_assignments:
        original_vendor = vendor_assignments.get(str(p.person_id), "openai")

    errors: list[str] = []

    # Phase 1: Retry with original vendor
    for attempt in range(max_retries + 1):
        try:
            return await _from_llm(p, locale, llm_prompt, vendor_assignments)
        except Exception as e:
            err_msg = f"[{original_vendor}] attempt {attempt+1}: {e}"
            errors.append(err_msg)
            print(f"[WARN] Person {p.person_id} {err_msg}")
            if attempt < max_retries:
                await asyncio.sleep(1.0 * (attempt + 1))

    # Phase 2: Try alternate vendors
    try:
        from shared.llm_vendors import get_available_vendors
        all_vendors = [v["name"] for v in get_available_vendors() if v.get("available")]
    except Exception:
        all_vendors = []

    alt_vendors = [v for v in all_vendors if v != original_vendor]
    for alt_vendor in alt_vendors:
        try:
            alt_assignments = dict(vendor_assignments or {})
            alt_assignments[str(p.person_id)] = alt_vendor
            result = await _from_llm(p, locale, llm_prompt, alt_assignments)
            result["llm_vendor"] = alt_vendor
            result["_fallback_vendor"] = alt_vendor
            result["_original_vendor"] = original_vendor
            print(f"[INFO] Person {p.person_id} succeeded with fallback vendor: {alt_vendor}")
            return result
        except Exception as e:
            err_msg = f"[{alt_vendor}] fallback: {e}"
            errors.append(err_msg)
            print(f"[WARN] Person {p.person_id} {err_msg}")

    # Phase 3: Template fallback
    print(f"[WARN] Person {p.person_id} all LLM vendors failed, using template. Errors: {errors}")
    result = _from_template(p, locale, template, vendor_assignments)
    result["llm_vendor"] = "template"
    result["_llm_error"] = " | ".join(errors)[:500]
    return result


async def _safe_hybrid_call(
    p: Person, locale: str, template: str | None,
    llm_prompt: str | None, vendor_assignments: dict[str, str] | None,
    max_retries: int = 2,
) -> dict[str, Any]:
    """Call _hybrid with retry → vendor failover → template fallback."""
    import asyncio

    original_vendor = "openai"
    if vendor_assignments:
        original_vendor = vendor_assignments.get(str(p.person_id), "openai")

    errors: list[str] = []

    # Phase 1: Retry with original vendor
    for attempt in range(max_retries + 1):
        try:
            return await _hybrid(p, locale, template, llm_prompt, vendor_assignments)
        except Exception as e:
            err_msg = f"[{original_vendor}] attempt {attempt+1}: {e}"
            errors.append(err_msg)
            print(f"[WARN] Person {p.person_id} {err_msg}")
            if attempt < max_retries:
                await asyncio.sleep(1.0 * (attempt + 1))

    # Phase 2: Try alternate vendors
    try:
        from shared.llm_vendors import get_available_vendors
        all_vendors = [v["name"] for v in get_available_vendors() if v.get("available")]
    except Exception:
        all_vendors = []

    alt_vendors = [v for v in all_vendors if v != original_vendor]
    for alt_vendor in alt_vendors:
        try:
            alt_assignments = dict(vendor_assignments or {})
            alt_assignments[str(p.person_id)] = alt_vendor
            result = await _hybrid(p, locale, template, llm_prompt, alt_assignments)
            result["llm_vendor"] = alt_vendor
            result["_fallback_vendor"] = alt_vendor
            result["_original_vendor"] = original_vendor
            return result
        except Exception as e:
            errors.append(f"[{alt_vendor}] fallback: {e}")

    # Phase 3: Template fallback
    print(f"[WARN] Person {p.person_id} all LLM vendors failed, using template. Errors: {errors}")
    result = _from_template(p, locale, template, vendor_assignments)
    result["llm_vendor"] = "template"
    result["_llm_error"] = " | ".join(errors)[:500]
    return result


def _from_template(
    p: Person, locale: str, template: str | None,
    vendor_assignments: dict[str, str] | None = None,
) -> dict[str, Any]:
    fields = _person_fields(p)
    media_habit = fields.get("media_habit", "")

    if template:
        user_char = template.format(**fields)
    else:
        user_char = _build_from_segments(fields, locale)

    # Determine vendor for this agent
    vendor = "template"  # template strategy doesn't use LLM
    if vendor_assignments:
        vendor = vendor_assignments.get(str(p.person_id), vendor)

    return {
        "person_id": p.person_id,
        "age": p.age,
        "gender": p.gender or "未知",
        "district": p.district or "未知",
        "education": fields.get("education", ""),
        "occupation": fields.get("occupation", ""),
        "marital_status": fields.get("marital_status", ""),
        "income_band": fields.get("income_band", ""),
        "name": f"user_{p.person_id}",
        "username": f"civatas_{p.person_id:05d}",
        "traits": [v for k, v in fields.items() if k not in ("person_id", "district_stats") and v],
        "user_char": user_char,
        "description": user_char[:500],
        "media_habit": media_habit,
        "political_leaning": fields.get("political_leaning", "Tossup"),
        "llm_vendor": vendor,
        "personality": (_pers := {
            "expressiveness": fields.get("expressiveness", "moderate"),
            "emotional_stability": fields.get("emotional_stability", "fairly stable"),
            "sociability": fields.get("sociability", "moderately social"),
            "openness": fields.get("openness", "moderately open"),
        }),
        "individuality": compute_individuality(
            _pers,
            age=int(str(p.age or 40).replace("歲", "")),
            occupation=fields.get("occupation", ""),
            income_band=fields.get("income_band", ""),
        ),
    }


def _build_from_segments(fields: dict[str, str], locale: str) -> str:
    """Build persona text from locale-specific segments, skipping empty fields."""
    segments = LOCALE_SEGMENTS.get(locale, LOCALE_SEGMENTS["zh-TW"])
    separator = LOCALE_SEPARATOR.get(locale, "，")

    parts: list[str] = []
    for fmt, required_keys in segments:
        # Include this segment only if ALL required fields have values
        if all(fields.get(k) for k in required_keys):
            try:
                parts.append(fmt.format(**fields))
            except (KeyError, ValueError):
                continue

    return separator.join(parts)


async def _from_llm(
    p: Person, locale: str, prompt: str | None,
    vendor_assignments: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Call LLM to generate a richer persona description."""
    try:
        from openai import AsyncOpenAI
    except ImportError:
        return _from_template(p, locale, None, vendor_assignments)

    # Determine vendor for this person
    vendor = "openai"  # default
    if vendor_assignments:
        vendor = vendor_assignments.get(str(p.person_id), "openai")

    # Use vendor-specific client
    try:
        from shared.llm_vendors import get_client_for_vendor
        client, model, temperature = get_client_for_vendor(vendor)
    except Exception as e:
        # Fallback to env-based config
        print(f"[WARN] Fallback due to exception in get_client_for_vendor: {e}")
        client = AsyncOpenAI(
            api_key=os.getenv("LLM_API_KEY", ""),
            base_url=os.getenv("LLM_BASE_URL") or None,
            timeout=600.0,
        )
        model = os.getenv("LLM_MODEL", "gpt-4o-mini")
        temperature = None

    fields = _person_fields(p)
    # Auto-detect county from leaning profile for prompt localization
    _county_for_prompt = ""
    if not prompt:
        try:
            import re as _re_county
            _lp_path = "/app/shared/leaning_profile.json"
            if os.path.exists(_lp_path):
                with open(_lp_path, encoding="utf-8") as _lf:
                    _lp_data = json.load(_lf)
                for _src in (_lp_data.get("data_sources") or []):
                    _m = _re_county.search(r"(臺北市|台北市|新北市|桃園市|臺中市|台中市|臺南市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|臺東縣|台東縣|澎湖縣|金門縣|連江縣)", str(_src))
                    if _m:
                        _county_for_prompt = _m.group(1)
                        break
        except Exception:
            pass
    system = prompt or _default_llm_prompt(locale, county=_county_for_prompt)
    user_content = "\n".join(f"- {k}: {v}" for k, v in fields.items() if v)

    # Sanitize content to prevent LLM API 400 errors (null bytes, control chars)
    user_content = user_content.replace('\x00', '').encode('utf-8', 'ignore').decode('utf-8')
    system = system.replace('\x00', '').encode('utf-8', 'ignore').decode('utf-8')

    kwargs = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ]
    }
    if temperature is not None:
        kwargs["temperature"] = temperature

    resp = await client.chat.completions.create(**kwargs)
    raw = resp.choices[0].message.content.strip()
    finish_reason = resp.choices[0].finish_reason  # 'stop' or 'length'

    # Try to parse JSON response for structured output
    media_habit = fields.get("media_habit", "")
    political_leaning = fields.get("political_leaning", "Tossup")
    user_char = raw

    # Strip markdown code fences (Gemini often wraps JSON in ```json ... ```)
    cleaned = raw
    if cleaned.startswith("```"):
        # Remove opening fence (```json or ```)
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    try:
        parsed = json.loads(cleaned)
        user_char = parsed.get("user_char", cleaned)
        if parsed.get("media_habit"):
            media_habit = parsed["media_habit"]
        if parsed.get("political_leaning"):
            political_leaning = parsed["political_leaning"]
    except (json.JSONDecodeError, AttributeError):
        # Fallback: try to extract user_char from partial/malformed JSON via regex
        import re
        m = re.search(r'"user_char"\s*:\s*"((?:[^"\\]|\\.)*)"', cleaned, re.DOTALL)
        if m:
            user_char = m.group(1).replace('\\"', '"').replace('\\n', '\n')
        else:
            # Last resort: strip any leading JSON wrapper like { "user_char": "
            user_char = re.sub(r'^\s*\{\s*"user_char"\s*:\s*"?', '', cleaned)
            user_char = re.sub(r'"?\s*\}\s*$', '', user_char)
            user_char = user_char.strip()

    # Fix truncated descriptions
    user_char = _fix_truncated_text(user_char)

    return {
        "person_id": p.person_id,
        "age": p.age,
        "gender": p.gender or "未知",
        "district": p.district or "未知",
        "education": fields.get("education", ""),
        "occupation": fields.get("occupation", ""),
        "marital_status": fields.get("marital_status", ""),
        "income_band": fields.get("income_band", ""),
        "name": f"user_{p.person_id}",
        "username": f"civatas_{p.person_id:05d}",
        "traits": [v for k, v in fields.items() if k not in ("person_id", "district_stats") and v],
        "user_char": user_char,
        "description": user_char[:500],
        "media_habit": media_habit,
        "political_leaning": political_leaning,
        "llm_vendor": vendor,
        "personality": (_pers := {
            "expressiveness": fields.get("expressiveness", "中等表達"),
            "emotional_stability": fields.get("emotional_stability", "一般穩定"),
            "sociability": fields.get("sociability", "適度社交"),
            "openness": fields.get("openness", "中等開放"),
        }),
        "individuality": compute_individuality(
            _pers,
            age=int(str(p.age or 40).replace("歲", "")),
            occupation=fields.get("occupation", ""),
            income_band=fields.get("income_band", ""),
        ),
    }


async def _hybrid(
    p: Person,
    locale: str,
    template: str | None,
    llm_prompt: str | None,
    vendor_assignments: dict[str, str] | None = None,
) -> dict[str, Any]:
    base = _from_template(p, locale, template, vendor_assignments)
    try:
        enriched = await _from_llm(p, locale, llm_prompt, vendor_assignments)
        base["user_char"] = enriched["user_char"]
        base["description"] = enriched["description"]
        if enriched.get("media_habit"):
            base["media_habit"] = enriched["media_habit"]
        if enriched.get("political_leaning"):
            base["political_leaning"] = enriched["political_leaning"]
        base["llm_vendor"] = enriched.get("llm_vendor", base.get("llm_vendor", "openai"))
    except Exception:
        pass
    return base


def compute_individuality(personality: dict, age: int = 40, occupation: str = "", income_band: str = "") -> dict:
    """Compute per-agent individuality parameters from personality traits.

    These numeric values are used by the evolution engine to differentiate
    agent responses. They are stored in persona data and can be edited later.
    """
    import random as _rng

    es = personality.get("emotional_stability", "一般穩定")
    expr = personality.get("expressiveness", "中等表達")
    op = personality.get("openness", "中等開放")

    # noise_scale: emotional volatility amplitude
    noise_base = {"敏感衝動": 1.5, "一般穩定": 1.0, "穩定冷靜": 0.3}.get(es, 1.0)
    if op == "開放多元": noise_base *= 1.2
    elif op == "固守觀點": noise_base *= 0.7
    noise_scale = noise_base + _rng.uniform(-0.2, 0.2)

    # temperature_offset: LLM creativity variance
    temp_base = {"敏感衝動": 0.15, "一般穩定": 0.0, "穩定冷靜": -0.10}.get(es, 0.0)
    temperature_offset = temp_base + _rng.uniform(-0.05, 0.05)

    # reaction_multiplier: how strongly they react to news
    react_base = {"敏感衝動": 1.3, "一般穩定": 1.0, "穩定冷靜": 0.7}.get(es, 1.0)
    if expr == "高度表達": react_base *= 1.15
    elif expr == "沉默寡言": react_base *= 0.85
    reaction_multiplier = react_base + _rng.uniform(-0.1, 0.1)

    # memory_inertia: resistance to opinion change
    inertia_base = {"穩定冷靜": 0.25, "一般穩定": 0.15, "敏感衝動": 0.05}.get(es, 0.15)
    memory_inertia = inertia_base + _rng.uniform(-0.03, 0.03)

    # delta_cap: max daily emotional swing
    delta_cap = {"敏感衝動": 20, "一般穩定": 15, "穩定冷靜": 10}.get(es, 15)

    # cognitive_bias: affects HOW they interpret news (direction, not just magnitude)
    bias_pool = []
    if es == "敏感衝動": bias_pool += ["悲觀偏向", "轉嫁怨氣", "從眾型"]
    elif es == "穩定冷靜": bias_pool += ["理性分析", "無感冷漠"]
    else: bias_pool += ["理性分析", "樂觀偏向", "從眾型"]
    if op == "固守觀點": bias_pool += ["陰謀論傾向"]
    if op == "開放多元": bias_pool += ["理性分析", "樂觀偏向"]
    if income_band in ("高收入", "中高收入"): bias_pool += ["樂觀偏向"]
    if income_band in ("低收入", "中低收入"): bias_pool += ["悲觀偏向", "轉嫁怨氣"]
    if age < 30: bias_pool += ["從眾型"]
    if age > 60: bias_pool += ["悲觀偏向"]
    cognitive_bias = _rng.choice(bias_pool) if bias_pool else "理性分析"

    return {
        "noise_scale": round(max(0.2, min(3.0, noise_scale)), 2),
        "temperature_offset": round(max(-0.3, min(0.3, temperature_offset)), 2),
        "reaction_multiplier": round(max(0.4, min(2.0, reaction_multiplier)), 2),
        "memory_inertia": round(max(0.0, min(0.5, memory_inertia)), 2),
        "delta_cap": delta_cap,
        "cognitive_bias": cognitive_bias,
    }


def _person_fields(p: Person) -> dict[str, str]:
    # Auto-infer political leaning FIRST (media_habit depends on it)
    political_leaning = ""
    party_lean = p.party_lean or ""

    # Civatas-USA Stage 1.5+: when running US, the party_lean from synthesis
    # The party_lean from US templates is already a 5-tier Cook label.
    # Pass it through directly as the political_leaning.
    _US_LEANING_5 = {"Solid Dem", "Lean Dem", "Tossup", "Lean Rep", "Solid Rep"}
    if party_lean in _US_LEANING_5:
        political_leaning = party_lean
    else:
        # No party_lean from template → try the per-county PVI lookup,
        # else default to Tossup.
        try:
            import sys as _sys
            _sys.path.insert(0, "/app/shared")
            import us_leaning  # type: ignore
            us_leaning.load_county_pvi()
            fips_for = None
            _d = (p.district or "").strip()
            if _d.isdigit() and len(_d) == 5:
                fips_for = _d
            if fips_for:
                political_leaning = us_leaning.county_leaning(fips_for)
        except Exception:
            pass
        if not political_leaning:
            political_leaning = "Tossup"

    # Fallback to inference if still empty
    if not political_leaning:
        political_leaning = infer_political_leaning(
            age=p.age,
            occupation=p.occupation or "",
            education=p.education or "",
        )

    # Auto-infer media_habit (now that political_leaning is known)
    media_habit = p.media_habit or ""
    if not media_habit:
        media_habit = infer_media_habit(
            age=p.age,
            occupation=p.occupation or "",
            education=p.education or "",
            political_leaning=political_leaning,
        )

    # Gather district-level stats from enabled modules
    district_key = p.district or ""
    district_stats = _get_district_stats(district_key)
    stats_text = ""
    if district_stats:
        parts = []
        # Exclude fields that duplicate individual attributes or are raw counts
        _skip = {
            "avg_age", "male_ratio", "平均年齡", "男性比例",      # Duplicate of individual age/gender
            "有效票數", "無效票數", "投票數", "選舉人數", "發出票數",  # Raw counts, not useful
            "vote_rate",                                          # Duplicate of 投票率
        }
        for k, v in district_stats.items():
            if k in _skip or k.endswith("票數"):
                continue
            if isinstance(v, float):
                if v <= 1.0:
                    parts.append(f"{k}={v:.1%}")
                else:
                    parts.append(f"{k}={v:.1f}")
            else:
                parts.append(f"{k}={v}")
        stats_text = "；".join(parts)

    # Infer personality traits
    personality = infer_personality(
        age=p.age,
        gender=p.gender or "",
        occupation=p.occupation or "",
        education=p.education or "",
    )

    # Auto-infer income_band if missing
    income_band = p.income_band or ""
    if not income_band:
        _occ = p.occupation or ""
        _age = p.age or 30
        _income_map = {
            "公務員": "中高收入", "教育": "中高收入", "金融保險": "高收入",
            "資訊科技": "高收入", "醫療": "高收入", "科技業": "高收入",
            "製造業": "中等收入", "營建業": "中等收入", "運輸倉儲": "中等收入",
            "批發零售": "中等收入", "住宿餐飲": "中低收入", "服務業": "中等收入",
            "自營商": "中等收入", "農林漁牧": "中低收入",
            "退休": "中等收入", "家管": "低收入", "待業": "低收入", "學生": "低收入",
        }
        income_band = _income_map.get(_occ, "中等收入")
        if _age < 25 and income_band in ("中等收入", "中高收入"):
            income_band = "中低收入"
        elif 35 <= _age <= 55 and income_band == "中等收入":
            income_band = random.choice(["中等收入", "中高收入"])

    # issue_1 / issue_2: only use if explicitly provided in source data
    # Do NOT auto-infer — would introduce stereotype bias
    issue_1 = p.issue_1 or ""
    issue_2 = p.issue_2 or ""

    # Fix district name format (remove stray spaces like "中 區" → "中區")
    _district = (p.district or "").replace(" ", "")

    fields = {
        "person_id": str(p.person_id),
        "age": str(p.age),
        "gender": p.gender,
        "district": _district,
        "education": p.education or "",
        "occupation": p.occupation or "",
        "income_band": income_band,
        "household_type": p.household_type or "",
        "marital_status": p.marital_status or "",
        "party_lean": party_lean,
        "issue_1": issue_1,
        "issue_2": issue_2,
        "media_habit": media_habit,
        "political_leaning": political_leaning,
        "mbti": p.mbti or "",
        "expressiveness": personality["expressiveness"],
        "emotional_stability": personality["emotional_stability"],
        "sociability": personality["sociability"],
        "openness": personality["openness"],
    }
    if stats_text:
        fields["district_stats"] = stats_text
    return fields


def _fix_truncated_text(text: str) -> str:
    """Fix LLM-generated text that was truncated mid-sentence."""
    if not text:
        return text
    # If ends with proper punctuation, it's fine
    _END_PUNCTUATION = set("。！？；…」）)!?.;")
    if text[-1] in _END_PUNCTUATION:
        return text
    # Truncated: find the last complete sentence boundary
    for i in range(len(text) - 1, -1, -1):
        if text[i] in _END_PUNCTUATION:
            return text[:i + 1]
    # No sentence boundary found at all, append a period
    return text + "。"


def _default_llm_prompt(locale: str, county: str = "") -> str:
    # US-only persona prompt. The county arg accepts a state name; default
    # to Pennsylvania for backward compat with the original PA pilot.
    return _BUILD_PERSONA_PROMPT_EN(county or "Pennsylvania")
