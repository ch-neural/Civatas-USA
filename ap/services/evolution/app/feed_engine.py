"""Feed engine: selects which news articles to push to each agent.

Implements the 'algorithmic filter bubble' logic:
  - Match articles to agent based on media_habit / diet rules
  - Apply political leaning affinity scoring
  - Apply serendipity rate for occasional 'bubble breaking'
"""
from __future__ import annotations

import json
import logging
import os
import random
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
RULES_FILE = os.path.join(DATA_DIR, "diet_rules.json")

# ── US-only feed sources (Stage 1.9 cleanup removed TW dual-path) ──
try:
    from .us_feed_sources import (  # type: ignore
        DEFAULT_SOURCE_LEANINGS as _US_SOURCE_LEANINGS,
        DEFAULT_DIET_MAP as _US_DIET_MAP,
    )
except ImportError:
    from us_feed_sources import (  # type: ignore
        DEFAULT_SOURCE_LEANINGS as _US_SOURCE_LEANINGS,
        DEFAULT_DIET_MAP as _US_DIET_MAP,
    )

# 5-tier Cook spectrum
LEANING_SPECTRUM = ["Solid Dem", "Lean Dem", "Tossup", "Lean Rep", "Solid Rep"]

DEFAULT_SOURCE_LEANINGS: dict[str, str] = dict(_US_SOURCE_LEANINGS)
DEFAULT_DIET_MAP: dict[str, list[str]] = dict(_US_DIET_MAP)

SERENDIPITY_RATE = 0.05  # 5% chance of cross-bubble article


# ── Political leaning utilities ──────────────────────────────────────

def _leaning_index(leaning: str) -> int:
    """Return the index on the political spectrum (0=Solid Dem ... 4=Solid Rep)."""
    try:
        return LEANING_SPECTRUM.index(leaning)
    except ValueError:
        return 2  # default to Tossup

def _leaning_distance(a: str, b: str) -> int:
    """Distance between two leanings on the spectrum (0-4)."""
    return abs(_leaning_index(a) - _leaning_index(b))

def _leaning_affinity(agent_leaning: str, article_leaning: str) -> float:
    """Score 0.0-1.0 for how well an article's leaning matches an agent's."""
    dist = _leaning_distance(agent_leaning, article_leaning)
    # Distance 0 → 1.0, 1 → 0.5, 2 → 0.0 (Left vs Right)
    return max(0.0, 1.0 - dist * 0.5)


# ── Diet rules ───────────────────────────────────────────────────────

def get_diet_rules() -> dict:
    """Return the current diet configuration."""
    if os.path.isfile(RULES_FILE):
        with open(RULES_FILE) as f:
            return json.load(f)
    return {
        "diet_map": DEFAULT_DIET_MAP,
        "source_leanings": DEFAULT_SOURCE_LEANINGS,
        "serendipity_rate": SERENDIPITY_RATE,
        "articles_per_agent": 3,
        "channel_weight": 0.5,        # 50% weight for media channel match
        "leaning_weight": 0.3,        # 30% weight for political leaning
        "recency_weight": 0.2,        # 20% weight for article freshness
        "demographic_weight": 1.0,    # multiplier for demographic affinity (1.0 = full effect, 0 = disabled)
        "read_penalty": 0.3,          # score multiplier for already-read articles (lower = stronger dedup)
        "district_news_count": 2,     # max local news articles per district per day
        "kol_probability": 0.4,       # probability of KOL post reaching an agent
        "custom_sources": [],         # [{name, url, leaning, channel, keywords}]
    }


def update_diet_rules(rules: dict) -> dict:
    """Persist updated diet rules."""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(RULES_FILE, "w") as f:
        json.dump(rules, f, ensure_ascii=False, indent=2)
    return rules


# ── Time decay utilities ─────────────────────────────────────────────

def _recency_score(crawled_at: str | None, now: datetime | None = None) -> float:
    """Score 0.0-1.0 based on article freshness.

    Within 1 day → 1.0, 3 days → 0.7, 7 days → 0.4, older → 0.1.
    """
    if not crawled_at:
        return 0.5  # unknown age → neutral
    try:
        ts = datetime.fromisoformat(crawled_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return 0.5
    if now is None:
        now = datetime.now(timezone.utc)
    age_hours = max(0, (now - ts).total_seconds() / 3600)
    if age_hours <= 24:
        return 1.0
    elif age_hours <= 72:
        return 0.7
    elif age_hours <= 168:
        return 0.4
    else:
        return 0.1


# ── Irrelevant article filter ────────────────────────────────────────

# PTT boards and keywords that indicate non-political content
_IRRELEVANT_BOARD_PATTERNS = [
    # Entertainment / Lifestyle
    "joke", "食記", "food", "beauty", "gossiping_fake",
    "stupidclown", "lifeismoney", "pokemongo",
    # Sports
    "baseball", "nba", "lol", "mma", "sportlottery",
    # Media / Gaming
    "c_chat", "marvel", "movie", "koreadrama", "japandrama",
    "youtuber", "steam", "playstation", "nintendo",
    # Tech / Cars / Hardware (non-political)
    "car", "biker", "mobilcomm", "pc_shopping", "hardware",
    # Other non-political boards
    "sex", "babymother", "home-sale", "womentalk",
    "headphone", "audiophile", "diy", "recipe",
    # Social media non-political
    "mobile01", "eprice",
]

_IRRELEVANT_TITLE_KEYWORDS = [
    "[趣事]", "[笑話]", "[食記]", "[遊記]", "[閒聊]",
    "[討論]", "[問題]", "[請益]", "[心得]", "[試用]", "[評測]",
    "波多野", "AV女優", "A片",
    "看板youtuber", "看板car", "看板sex",
    "看板biker", "看板mobilcomm", "看板pc_shopping",
    "看板hardware", "看板womentalk", "看板babymother",
    "看板home-sale", "看板recipe",
    "看板e-appliance", "看板air-quality", "看板lifeismoney",
    "看板headphone", "看板audiophile",
    # Product review / consumer content keywords
    "空氣清淨機", "清淨機", "Dyson", "Blueair", "HEPA",
    "濾網", "濾材", "除濕機", "全熱交換", "冷氣",
    "空氣循環", "居家生活板", "E-appliance",
]

# Content-level keywords that indicate non-political articles even if title looks political
_NOISE_CONTENT_KEYWORDS = [
    # Product reviews disguised with PM2.5 / air quality framing
    "空氣清淨機", "清淨機", "Dyson", "Blueair", "HEPA",
    "濾網大家都多久換", "濾材", "空氣循環清淨機", "空氣過濾",
    "前置濾箱", "除濕機or", "冷氣PM2.5",
    # Non-political forum discussions
    "居家生活板", "E-appliance", "考試板",
    "專技高考", "環境工程技師",
]


def _is_relevant_article(article: dict) -> bool:
    """Return True if the article is likely politically relevant."""
    title = article.get("title", "")
    source = article.get("source_tag", "")
    summary = article.get("summary", "")

    # Check board patterns
    for pattern in _IRRELEVANT_BOARD_PATTERNS:
        if pattern.lower() in title.lower() or pattern.lower() in source.lower():
            return False

    # Check title keywords
    for kw in _IRRELEVANT_TITLE_KEYWORDS:
        if kw in title:
            return False

    # Check content-level noise (title + summary)
    text = title + " " + summary
    for kw in _NOISE_CONTENT_KEYWORDS:
        if kw in text:
            return False

    return True


# ── Semantic Categorization ──────────────────────────────────────────

def _categorize_article(title: str, summary: str) -> str:
    """Classify the article into a primary demographic impact category."""
    text = (title + " " + summary).lower()
    
    cat_keywords = {
        "Economy": ["物價", "通膨", "漲跌", "經濟", "股市", "薪資", "電價", "房價", "買房", "外銷", "景氣", "加薪", "基本工資"],
        "CrossStrait": ["兩岸", "中國", "中共", "台海", "武統", "共軍", "統獨", "九二共識", "美國", "國防", "軍售", "疑美"],
        "Livelihood": ["交通", "行人", "車禍", "違停", "補助", "育兒", "托育", "停電", "治安", "詐騙", "黑道"],
        "GenderSocial": ["平權", "性騷", "metoo", "女權", "同志", "同婚", "少子化", "性別"],
        "Politics": ["選舉", "立法院", "質詢", "立委", "總統", "貪污", "弊案", "圖利", "罷免", "初選"]
    }
    
    # Simple highest-match logic
    best_cat = "General"
    max_hits = 0
    for cat, kws in cat_keywords.items():
        hits = sum(1 for kw in kws if kw in text)
        if hits > max_hits:
            max_hits = hits
            best_cat = cat
            
    return best_cat


def _demographic_affinity(agent: dict, category: str) -> float:
    """Calculate how strongly this agent cares about this category. Returns 0.0 to 1.5 multiplier."""
    affinity = 1.0
    
    age_str = agent.get("context", {}).get("age", "40")
    try:
        age_num = int("".join(c for c in str(age_str) if c.isdigit()))
    except ValueError:
        age_num = 40
        
    gender = agent.get("context", {}).get("gender", "")
    occupation = agent.get("context", {}).get("occupation", "")
    leaning = agent.get("political_leaning", "中立")
    
    if category == "Economy":
        # Older people, business owners, workers care more about economy/inflation
        if age_num > 40: affinity += 0.2
        if any(w in occupation for w in ["商人", "企業", "勞工", "上班族", "金融", "服務業"]): affinity += 0.3
        
    elif category == "CrossStrait":
        # Strong partisans and older generations often track cross-strait more closely
        if leaning in ["偏左派", "偏右派"]: affinity += 0.3
        if age_num > 50: affinity += 0.2
        
    elif category == "Livelihood":
        # Broadly appealing, slightly higher for parents/young adults
        if 25 <= age_num <= 45: affinity += 0.3
        
    elif category == "GenderSocial":
        # Strongly appeals to younger cohorts and females
        if age_num < 35: affinity += 0.4
        if "女" in gender: affinity += 0.3
        
    elif category == "Politics":
        if leaning in ["偏左派", "偏右派"]: affinity += 0.2
        
    return min(affinity, 1.8)  # Cap the multiplier


# ── Feed generation ──────────────────────────────────────────────────

def select_feed(
    agent: dict,
    news_pool: list[dict],
    rules: dict | None = None,
    read_history: set | None = None,
    current_day: int | None = None,
) -> list[dict]:
    """Pick N articles from the news pool for a specific agent.

    Uses a combined scoring approach:
      - Media channel match (agent's media_habit vs article source_tag)
      - Political leaning affinity (agent's political_leaning vs source leaning)
      - Time decay (newer articles score higher)
      - Demographic Affinity (Agent's Age/Gender vs Article Category)
      - Read dedup (articles the agent already read are penalised)
      - Temporal causality: when ``current_day`` is supplied, articles
        whose ``assigned_day`` is greater than the current sim day are
        excluded — agents cannot read "future" news. Articles without
        an ``assigned_day`` (e.g. legacy events, KOL posts) bypass the
        filter.
    """
    if not news_pool:
        return []

    # ── Strict temporal causality filter ───────────────────────────
    # Prevents agents on sim day N from reading articles assigned to
    # sim day N+1 or later. Critical under time compression where the
    # cycle's news pool spans many real days mapped onto few sim days.
    if current_day is not None:
        news_pool = [
            a for a in news_pool
            if a.get("assigned_day") is None or a.get("assigned_day") <= current_day
        ]
        if not news_pool:
            return []

    if rules is None:
        rules = get_diet_rules()

    diet_map = rules.get("diet_map", DEFAULT_DIET_MAP)
    source_leanings = rules.get("source_leanings", DEFAULT_SOURCE_LEANINGS)
    n = rules.get("articles_per_agent", 3)
    serendipity = rules.get("serendipity_rate", SERENDIPITY_RATE)
    channel_w = rules.get("channel_weight", 0.5)
    leaning_w = rules.get("leaning_weight", 0.3)
    recency_w = rules.get("recency_weight", 0.2)
    demo_w = rules.get("demographic_weight", 1.0)
    read_pen = rules.get("read_penalty", 0.3)

    # ── Determine agent preferences ─────────────────────────────────
    media_habit = agent.get("media_habit") or ""
    agent_leaning = agent.get("political_leaning") or "中立"

    preferred_tags: set[str] = set()
    for habit_key, tag_list in diet_map.items():
        if habit_key in media_habit:
            preferred_tags.update(tag_list)

    # Fallback to mainstream if no match
    if not preferred_tags:
        preferred_tags = {"Yahoo新聞", "ETtoday"}

    now = datetime.now(timezone.utc)

    def _fuzzy_match_source(source_tag: str, known_names: set[str]) -> str | None:
        """Fuzzy match a Serper source_tag to a known diet_map source name.
        E.g. 'TVBS新聞網' matches 'TVBS新聞', '自由財經' matches '自由時報'.
        """
        if source_tag in known_names:
            return source_tag
        for name in known_names:
            # Strip common suffixes and check containment
            core = name.replace("新聞", "").replace("時事", "").replace("電子報", "")
            tag_core = source_tag.replace("新聞網", "").replace("新聞雲", "").replace("新聞", "").replace("財經網", "").replace("財經", "").replace("評論網", "").replace("股市", "")
            if len(core) >= 2 and (core in source_tag or core in tag_core or tag_core in name):
                return name
        return None

    # Build set of all known source names for fuzzy matching
    _all_known_sources = set(source_leanings.keys())
    for tag_list in diet_map.values():
        _all_known_sources.update(tag_list)

    # ── Score each article ──────────────────────────────────────────
    scored: list[tuple[float, dict]] = []
    for article in news_pool:
        # Skip irrelevant articles (PTT jokes, food reviews, etc.)
        if not _is_relevant_article(article):
            continue

        tag = article.get("source_tag", "")
        # Fuzzy match source_tag to known names for both channel and leaning scoring
        matched_name = _fuzzy_match_source(tag, _all_known_sources)
        effective_tag = matched_name or tag

        art_leaning = (
            article.get("source_leaning")
            or source_leanings.get(effective_tag, source_leanings.get(tag, "中立"))
        )

        # Channel match: 1.0 if in preferred set (fuzzy), 0.0 if not
        # Special: "情境注入" articles always get delivered (prediction scenarios)
        if tag in ("情境注入", "手動注入"):
            channel_score = 1.0
            rec_score = 1.0  # Always fresh
        else:
            channel_score = 1.0 if effective_tag in preferred_tags else 0.0
            # Time decay: newer articles score higher
            rec_score = _recency_score(article.get("crawled_at"), now)

        # Political leaning affinity
        leaning_score = _leaning_affinity(agent_leaning, art_leaning)
        
        # Demographic Topical Affinity
        art_category = _categorize_article(article.get("title", ""), article.get("summary", ""))
        demo_mult = _demographic_affinity(agent, art_category)

        # Combined score
        base_total = channel_w * channel_score + leaning_w * leaning_score + recency_w * rec_score
        # Apply demographic affinity as interpolated multiplier (0=no effect, 1=full effect)
        effective_demo = 1.0 + (demo_mult - 1.0) * demo_w
        total = base_total * effective_demo

        # Candidate boost: articles mentioning tracked candidates get priority
        # This ensures candidate news reaches agents despite competing with general news
        _title_summary = (article.get("title", "") + " " + article.get("summary", "")).lower()
        _tracked = rules.get("tracked_candidate_names", []) if rules else []
        if any(cn in _title_summary for cn in _tracked):
            total *= 1.8  # significant boost for candidate-related articles

        # Read dedup: penalise articles the agent already saw
        if read_history and article.get("article_id") in read_history:
            total *= read_pen

        scored.append((total, article))

    # Sort by score descending, with some randomness for equal scores
    random.shuffle(scored)  # shuffle first for tiebreaking
    scored.sort(key=lambda x: x[0], reverse=True)

    # If pool is smaller than N, just return all
    if len(scored) <= n:
        return [a for _, a in scored]

    # Add jitter when scores are too uniform (common with 情境注入)
    unique_scores = set(s for s, _ in scored)
    if len(unique_scores) <= 2:
        scored = [(s + random.uniform(-0.2, 0.2), a) for s, a in scored]
        scored.sort(key=lambda x: x[0], reverse=True)

    # ── Pick top-N with serendipity ─────────────────────────────────
    high_score = [a for s, a in scored if s >= 0.5]
    low_score = [a for s, a in scored if s < 0.5]

    feed: list[dict] = []
    for _ in range(n):
        # Serendipity: small chance to pick from low-scoring articles
        if low_score and random.random() < serendipity:
            pick = random.choice(low_score)
            low_score.remove(pick)
        elif high_score:
            pick = high_score.pop(0)
        elif low_score:
            pick = low_score.pop(0)
        else:
            break
        feed.append(pick)

    return feed


def preview_feed(agent: dict, news_pool: list[dict]) -> dict:
    """Preview what a specific agent would see today."""
    feed = select_feed(agent, news_pool)
    return {
        "agent_id": agent.get("person_id"),
        "media_habit": agent.get("media_habit", ""),
        "political_leaning": agent.get("political_leaning", "中立"),
        "articles_count": len(feed),
        "articles": feed,
    }
