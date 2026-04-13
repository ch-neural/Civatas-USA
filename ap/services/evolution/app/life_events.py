"""
Life Events — 隨機人生事件模組

每日為每位 agent 擲骰，依據年齡、性別、職業、行政區、人格特質、
婚姻狀態等條件判定是否觸發人生事件。事件會影響滿意度與焦慮指標，
並可透過 prompt_hint 注入 LLM 產生的日記中。
"""
from __future__ import annotations

import logging
import random
from typing import Any

logger = logging.getLogger(__name__)

# ── Global probability cap ──────────────────────────────────────────
# At most ~8 % of agents will experience ANY event on a given day.
GLOBAL_EVENT_PROB = 0.08

# ── Occupation groups (for eligibility shorthand) ───────────────────
_WHITE_COLLAR = {
    "工程師", "程式設計師", "軟體工程師", "教師", "教授", "醫師",
    "醫生", "護理師", "律師", "會計師", "金融業", "銀行員",
    "公務員", "行政人員", "設計師", "行銷", "業務", "經理",
    "主管", "研究員", "分析師", "顧問",
}
_BLUE_COLLAR = {
    "工人", "作業員", "技術員", "司機", "外送員", "店員",
    "服務業", "餐飲業", "保全", "清潔", "建築工", "水電工",
    "農", "農民", "漁民", "攤販", "小吃店",
}
_STUDENT = {"學生", "大學生", "研究生", "高中生", "國中生"}
_RETIRED = {"退休", "退休人員"}


# ── Event Catalog ───────────────────────────────────────────────────
# Each event is a dict with:
#   id, name, category, description, probability (daily, before global cap),
#   eligibility (dict of criteria), effects (satisfaction_delta, anxiety_delta),
#   cooldown_days, and optional prompt_hint.
#
# eligibility keys:
#   age_min, age_max        — inclusive
#   gender                  — "male" | "female" | None (any)
#   married                 — True | False | None (any)
#   occupation_include      — set of occupations (any match)
#   occupation_exclude      — set of occupations (none match)
#   has_children            — True | False | None

EVENT_CATALOG: list[dict[str, Any]] = [
    # ────────────── Economic 經濟 ──────────────
    {
        "id": "eco_layoff",
        "name": "失業/裁員",
        "category": "economic",
        "description": "公司縮編，突然被通知不用來了，心情超差",
        "probability": 0.15,
        "eligibility": {
            "age_min": 22, "age_max": 60,
            "occupation_exclude": _STUDENT | _RETIRED,
        },
        "effects": {"satisfaction_delta": -10, "anxiety_delta": 15},
        "cooldown_days": 90,
        "prompt_hint": "最近被裁員了，正在找新工作",
    },
    {
        "id": "eco_raise",
        "name": "加薪",
        "category": "economic",
        "description": "主管通知下個月開始加薪，雖然不多但還是開心",
        "probability": 0.10,
        "eligibility": {
            "age_min": 23, "age_max": 60,
            "occupation_exclude": _STUDENT | _RETIRED,
        },
        "effects": {"satisfaction_delta": 7, "anxiety_delta": -5},
        "cooldown_days": 180,
        "prompt_hint": "最近剛加薪，心情不錯",
    },
    {
        "id": "eco_rent_up",
        "name": "房租漲價",
        "category": "economic",
        "description": "房東說下個月要漲房租，又多一筆開銷",
        "probability": 0.12,
        "eligibility": {
            "age_min": 20, "age_max": 45,
            "married": None,
        },
        "effects": {"satisfaction_delta": -5, "anxiety_delta": 8},
        "cooldown_days": 180,
        "prompt_hint": "房租剛漲價，經濟壓力變大",
    },
    {
        "id": "eco_invest_loss",
        "name": "投資虧損",
        "category": "economic",
        "description": "股票跌了一大波，看到帳面虧損心情很悶",
        "probability": 0.10,
        "eligibility": {
            "age_min": 25, "age_max": 70,
            "occupation_exclude": _STUDENT,
        },
        "effects": {"satisfaction_delta": -7, "anxiety_delta": 10},
        "cooldown_days": 60,
        "prompt_hint": "最近投資虧了不少錢",
    },
    {
        "id": "eco_windfall",
        "name": "中獎/意外之財",
        "category": "economic",
        "description": "刮刮樂中了幾千塊，雖然不多但今天運氣不錯",
        "probability": 0.05,
        "eligibility": {"age_min": 18, "age_max": 99},
        "effects": {"satisfaction_delta": 6, "anxiety_delta": -3},
        "cooldown_days": 120,
        "prompt_hint": "最近意外得到一筆小錢",
    },
    {
        "id": "eco_price_pressure",
        "name": "物價壓力",
        "category": "economic",
        "description": "去超市買個菜都變貴了，薪水根本追不上物價",
        "probability": 0.18,
        "eligibility": {
            "age_min": 20, "age_max": 75,
            "occupation_exclude": _STUDENT,
        },
        "effects": {"satisfaction_delta": -4, "anxiety_delta": 6},
        "cooldown_days": 30,
        "prompt_hint": "最近很在意物價上漲的問題",
    },

    # ────────────── Family 家庭 ──────────────
    {
        "id": "fam_marriage",
        "name": "結婚",
        "category": "family",
        "description": "終於要結婚了，雖然忙得要命但很幸福",
        "probability": 0.03,
        "eligibility": {
            "age_min": 25, "age_max": 45,
            "married": False,
        },
        "effects": {"satisfaction_delta": 12, "anxiety_delta": 5},
        "cooldown_days": 365,
        "prompt_hint": "最近剛結婚，生活有很大變化",
    },
    {
        "id": "fam_divorce",
        "name": "離婚",
        "category": "family",
        "description": "跟另一半談不攏，決定好聚好散",
        "probability": 0.02,
        "eligibility": {
            "age_min": 25, "age_max": 65,
            "married": True,
        },
        "effects": {"satisfaction_delta": -10, "anxiety_delta": 12},
        "cooldown_days": 365,
        "prompt_hint": "最近正在處理離婚的事",
    },
    {
        "id": "fam_newborn",
        "name": "懷孕/生子",
        "category": "family",
        "description": "家裡要多一個新成員了，既期待又緊張",
        "probability": 0.03,
        "eligibility": {
            "age_min": 24, "age_max": 42,
            "married": True,
        },
        "effects": {"satisfaction_delta": 10, "anxiety_delta": 8},
        "cooldown_days": 365,
        "prompt_hint": "家裡最近迎來新生兒",
    },
    {
        "id": "fam_child_exam",
        "name": "孩子升學考試",
        "category": "family",
        "description": "小孩要考試了，全家都跟著緊張",
        "probability": 0.08,
        "eligibility": {
            "age_min": 35, "age_max": 55,
            "has_children": True,
        },
        "effects": {"satisfaction_delta": -3, "anxiety_delta": 10},
        "cooldown_days": 120,
        "prompt_hint": "孩子最近有升學考試，家裡氣氛很緊張",
    },
    {
        "id": "fam_relative_sick",
        "name": "親人生病",
        "category": "family",
        "description": "家裡長輩身體出了狀況，要跑醫院照顧",
        "probability": 0.08,
        "eligibility": {"age_min": 25, "age_max": 70},
        "effects": {"satisfaction_delta": -6, "anxiety_delta": 10},
        "cooldown_days": 60,
        "prompt_hint": "家裡有親人生病，要花時間照顧",
    },
    {
        "id": "fam_bereavement",
        "name": "親人過世",
        "category": "family",
        "description": "家裡有人走了，心裡很難過，什麼事都提不起勁",
        "probability": 0.02,
        "eligibility": {"age_min": 20, "age_max": 85},
        "effects": {"satisfaction_delta": -12, "anxiety_delta": 12},
        "cooldown_days": 365,
        "prompt_hint": "最近有至親過世，情緒很低落",
    },

    # ────────────── Health 健康 ──────────────
    {
        "id": "hea_hospitalized",
        "name": "生病住院",
        "category": "health",
        "description": "身體不舒服去看醫生，結果被留院觀察",
        "probability": 0.05,
        "eligibility": {"age_min": 18, "age_max": 90},
        "effects": {"satisfaction_delta": -8, "anxiety_delta": 12},
        "cooldown_days": 90,
        "prompt_hint": "最近生了一場病住院",
    },
    {
        "id": "hea_checkup_abnormal",
        "name": "健檢異常",
        "category": "health",
        "description": "健康檢查報告出來，有幾個紅字要追蹤",
        "probability": 0.08,
        "eligibility": {"age_min": 30, "age_max": 85},
        "effects": {"satisfaction_delta": -5, "anxiety_delta": 10},
        "cooldown_days": 180,
        "prompt_hint": "最近健康檢查有異常指標",
    },
    {
        "id": "hea_sport_injury",
        "name": "運動受傷",
        "category": "health",
        "description": "打球的時候扭到腳，要休息好一陣子",
        "probability": 0.06,
        "eligibility": {"age_min": 16, "age_max": 55},
        "effects": {"satisfaction_delta": -4, "anxiety_delta": 5},
        "cooldown_days": 45,
        "prompt_hint": "最近運動受傷，行動不太方便",
    },
    {
        "id": "hea_mental_burnout",
        "name": "身心俱疲",
        "category": "health",
        "description": "最近壓力太大，整個人很累，什麼都不想做",
        "probability": 0.10,
        "eligibility": {
            "age_min": 22, "age_max": 55,
            "occupation_exclude": _RETIRED,
        },
        "effects": {"satisfaction_delta": -6, "anxiety_delta": 12},
        "cooldown_days": 60,
        "prompt_hint": "最近感覺身心俱疲，壓力很大",
    },

    # ────────────── Social 社交 ──────────────
    {
        "id": "soc_neighbor_fight",
        "name": "跟鄰居吵架",
        "category": "social",
        "description": "鄰居太吵被我唸了幾句，結果兩邊吵起來",
        "probability": 0.06,
        "eligibility": {"age_min": 20, "age_max": 80},
        "effects": {"satisfaction_delta": -4, "anxiety_delta": 7},
        "cooldown_days": 30,
        "prompt_hint": "最近跟鄰居起衝突",
    },
    {
        "id": "soc_community_event",
        "name": "參加社區活動",
        "category": "social",
        "description": "里長辦了個活動，去參加認識一些新朋友",
        "probability": 0.10,
        "eligibility": {"age_min": 18, "age_max": 85},
        "effects": {"satisfaction_delta": 5, "anxiety_delta": -3},
        "cooldown_days": 14,
        "prompt_hint": "最近參加了社區活動",
    },
    {
        "id": "soc_political_chat",
        "name": "朋友聚會聊政治",
        "category": "social",
        "description": "跟朋友吃飯聊到政治，大家意見不同差點翻臉",
        "probability": 0.12,
        "eligibility": {"age_min": 20, "age_max": 80},
        "effects": {"satisfaction_delta": -3, "anxiety_delta": 6},
        "cooldown_days": 14,
        "prompt_hint": "最近跟朋友聊政治意見不合",
    },
    {
        "id": "soc_online_argument",
        "name": "網路論戰",
        "category": "social",
        "description": "在網路上看到有人亂講，忍不住回了幾句結果被圍攻",
        "probability": 0.10,
        "eligibility": {"age_min": 16, "age_max": 50},
        "effects": {"satisfaction_delta": -3, "anxiety_delta": 7},
        "cooldown_days": 7,
        "prompt_hint": "最近在網路上跟人吵架",
    },
    {
        "id": "soc_volunteer",
        "name": "參加志工服務",
        "category": "social",
        "description": "去社區當志工幫忙，覺得做了有意義的事",
        "probability": 0.06,
        "eligibility": {"age_min": 18, "age_max": 75},
        "effects": {"satisfaction_delta": 5, "anxiety_delta": -4},
        "cooldown_days": 30,
        "prompt_hint": "最近當了志工，覺得蠻有意義的",
    },

    # ────────────── Career 職涯 ──────────────
    {
        "id": "car_promotion",
        "name": "升遷",
        "category": "career",
        "description": "努力終於被看到，升了一級，責任也變重了",
        "probability": 0.04,
        "eligibility": {
            "age_min": 26, "age_max": 55,
            "occupation_exclude": _STUDENT | _RETIRED,
        },
        "effects": {"satisfaction_delta": 10, "anxiety_delta": 5},
        "cooldown_days": 365,
        "prompt_hint": "最近剛升遷",
    },
    {
        "id": "car_job_change",
        "name": "轉職",
        "category": "career",
        "description": "決定跳槽到新公司，既期待又怕受傷害",
        "probability": 0.05,
        "eligibility": {
            "age_min": 23, "age_max": 50,
            "occupation_exclude": _STUDENT | _RETIRED,
        },
        "effects": {"satisfaction_delta": 3, "anxiety_delta": 10},
        "cooldown_days": 180,
        "prompt_hint": "最近剛換了新工作",
    },
    {
        "id": "car_retirement",
        "name": "退休",
        "category": "career",
        "description": "終於到了退休的年紀，輕鬆了但也有點不習慣",
        "probability": 0.03,
        "eligibility": {
            "age_min": 55, "age_max": 70,
            "occupation_exclude": _STUDENT | _RETIRED,
        },
        "effects": {"satisfaction_delta": 4, "anxiety_delta": 8},
        "cooldown_days": 365,
        "prompt_hint": "最近剛退休，生活型態在調整",
    },
    {
        "id": "car_work_stress",
        "name": "工作壓力大",
        "category": "career",
        "description": "案子一直來做不完，加班到很晚覺得快撐不住",
        "probability": 0.15,
        "eligibility": {
            "age_min": 22, "age_max": 60,
            "occupation_exclude": _STUDENT | _RETIRED,
        },
        "effects": {"satisfaction_delta": -5, "anxiety_delta": 10},
        "cooldown_days": 21,
        "prompt_hint": "最近工作壓力很大",
    },
    {
        "id": "car_colleague_conflict",
        "name": "同事衝突",
        "category": "career",
        "description": "跟同事意見不合吵了起來，上班氣氛很尷尬",
        "probability": 0.08,
        "eligibility": {
            "age_min": 22, "age_max": 60,
            "occupation_exclude": _STUDENT | _RETIRED,
        },
        "effects": {"satisfaction_delta": -4, "anxiety_delta": 7},
        "cooldown_days": 30,
        "prompt_hint": "最近跟同事有衝突",
    },
]

# ── Quick lookup ────────────────────────────────────────────────────
_EVENT_BY_ID: dict[str, dict[str, Any]] = {e["id"]: e for e in EVENT_CATALOG}


# ── Eligibility check ──────────────────────────────────────────────

def _check_eligibility(event: dict, agent: dict) -> bool:
    """Return True if *agent* meets all eligibility criteria for *event*."""
    elig = event.get("eligibility", {})

    # Age
    age = agent.get("age")
    if age is not None:
        if age < elig.get("age_min", 0):
            return False
        if age > elig.get("age_max", 999):
            return False

    # Gender
    required_gender = elig.get("gender")
    if required_gender is not None:
        agent_gender = agent.get("gender", "").lower()
        if agent_gender != required_gender:
            return False

    # Marital status
    required_married = elig.get("married")
    if required_married is not None:
        # Accept various representations
        agent_married = agent.get("married") or agent.get("marital_status")
        if isinstance(agent_married, str):
            agent_married = agent_married in ("已婚", "married", "True", "true")
        if bool(agent_married) != required_married:
            return False

    # has_children
    required_children = elig.get("has_children")
    if required_children is not None:
        has = agent.get("has_children")
        if isinstance(has, str):
            has = has in ("True", "true", "是")
        if bool(has) != required_children:
            return False

    # Occupation include (agent must have one of these)
    occ_include = elig.get("occupation_include")
    if occ_include:
        agent_occ = agent.get("occupation", "")
        if not any(kw in agent_occ for kw in occ_include):
            return False

    # Occupation exclude (agent must NOT have any of these)
    occ_exclude = elig.get("occupation_exclude")
    if occ_exclude:
        agent_occ = agent.get("occupation", "")
        if any(kw in agent_occ for kw in occ_exclude):
            return False

    # Race (race_not = exclude this race)
    race_not = elig.get("race_not")
    if race_not is not None:
        agent_race = agent.get("race", "")
        if agent_race == race_not:
            return False

    # Hispanic/Latino
    required_hisp = elig.get("hispanic_or_latino")
    if required_hisp is not None:
        agent_hisp = agent.get("hispanic_or_latino", "")
        if agent_hisp != required_hisp:
            return False

    # Tenure (Owner/Renter)
    required_tenure = elig.get("tenure")
    if required_tenure is not None:
        agent_tenure = agent.get("household_type", agent.get("tenure", ""))
        if required_tenure not in str(agent_tenure):
            return False

    return True


# ── Cooldown check ─────────────────────────────────────────────────

def _is_on_cooldown(event_id: str, state: dict, day: int) -> bool:
    """Return True if the event is still within its cooldown window."""
    history: list[dict] = state.get("life_event_history", [])
    event_def = _EVENT_BY_ID.get(event_id)
    if event_def is None:
        return True  # unknown event — block it
    cooldown = event_def.get("cooldown_days", 0)
    for record in history:
        if record.get("event_id") == event_id:
            last_day = record.get("day", 0)
            if day - last_day < cooldown:
                return True
    return False


# ── Public API ──────────────────────────────────────────────────────

def roll_life_event(
    agent: dict,
    state: dict,
    day: int,
    *,
    rng: random.Random | None = None,
) -> dict | None:
    """Attempt to trigger a random life event for *agent* on *day*.

    Parameters
    ----------
    agent : dict
        Agent demographic profile (age, gender, occupation, married, etc.).
    state : dict
        Mutable agent state dict; must contain ``life_event_history``
        (list of ``{"event_id": str, "day": int}``).  Will be updated
        in-place if an event fires.
    day : int
        Current simulation day number (0-indexed is fine).
    rng : random.Random, optional
        Deterministic RNG for reproducibility.  Falls back to
        ``random`` module if not provided.

    Returns
    -------
    dict | None
        The matched event dict (including ``effects`` and optional
        ``prompt_hint``), or ``None`` if no event fires today.
    """
    r = rng or random

    # ── Global gate: most agents get no event today ─────────────
    if r.random() > GLOBAL_EVENT_PROB:
        return None

    # ── Build eligible candidate list ───────────────────────────
    candidates: list[dict] = []
    weights: list[float] = []

    for event in EVENT_CATALOG:
        if not _check_eligibility(event, agent):
            continue
        if _is_on_cooldown(event["id"], state, day):
            continue
        candidates.append(event)
        weights.append(event["probability"])

    if not candidates:
        return None

    # ── Weighted random selection among eligible events ─────────
    chosen = r.choices(candidates, weights=weights, k=1)[0]

    # ── Record in history ───────────────────────────────────────
    if "life_event_history" not in state:
        state["life_event_history"] = []
    state["life_event_history"].append({
        "event_id": chosen["id"],
        "day": day,
    })

    logger.info(
        "Agent %s triggered life event [%s] %s on day %d",
        agent.get("person_id", agent.get("id", "?")),
        chosen["id"],
        chosen["name"],
        day,
    )

    return chosen


def get_event_by_id(event_id: str) -> dict | None:
    """Look up an event definition by its id."""
    return _EVENT_BY_ID.get(event_id)


def list_events(category: str | None = None) -> list[dict]:
    """Return all events, optionally filtered by category."""
    if category is None:
        return list(EVENT_CATALOG)
    return [e for e in EVENT_CATALOG if e["category"] == category]
