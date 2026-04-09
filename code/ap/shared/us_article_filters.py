"""US article relevance filtering — drop-in replacement for article_filters.py.

Same public API as ap/shared/article_filters.py:
  IRRELEVANT_SOURCE_PATTERNS  set[str]
  IRRELEVANT_KEYWORDS         list[str]
  is_relevant_article(title, source, summary) -> bool

The patterns and keywords are tuned for English-language US news / social.
"""
from __future__ import annotations

import re
from typing import Optional

# Source patterns (substring match, lower-cased) that signal non-political content.
IRRELEVANT_SOURCE_PATTERNS: set[str] = {
    # Sports
    "espn", "bleacherreport", "sbnation", "theathletic", "fantasypros",
    "draftkings", "fanduel", "rotowire",
    # Entertainment / celebrity
    "tmz", "people.com", "etonline", "us weekly", "perez", "deadline.com",
    "variety.com", "hollywoodreporter", "billboard.com",
    # Lifestyle / shopping / recipes
    "allrecipes", "food52", "epicurious", "delish", "tasty",
    "buzzfeed/quizzes", "wirecutter", "thespruce", "apartmenttherapy",
    "dealsite", "slickdeals", "groupon",
    # Gaming
    "ign", "gamespot", "polygon", "kotaku", "rockpapershotgun",
    # Pets
    "petmd", "rover.com", "thedodo",
    # Beauty / fashion
    "cosmopolitan", "elle.com", "vogue", "glamour", "instyle",
    # Reddit non-political subs (matched on the subreddit slug)
    "/r/aww", "/r/funny", "/r/gaming", "/r/pics", "/r/movies", "/r/television",
    "/r/sports", "/r/nba", "/r/nfl", "/r/mlb", "/r/soccer",
    "/r/relationships", "/r/personalfinance", "/r/cooking",
    # Astrology / horoscope
    "horoscope", "astrology",
    # Travel
    "tripadvisor", "lonelyplanet", "travelandleisure",
}

IRRELEVANT_KEYWORDS: list[str] = [
    # Reviews / commerce
    "unboxing", "review:", "deal alert", "best of", "top 10", "buying guide",
    "gift guide", "amazon prime day",
    # Entertainment chatter
    "binge-watch", "netflix tonight", "streaming guide", "spoiler",
    "season finale recap", "celebrity feud",
    # Lifestyle
    "horoscope", "zodiac", "tarot", "astrology",
    "recipe", "meal plan", "food review",
    "travel guide", "vacation tips",
    # Sports brackets
    "fantasy football", "march madness bracket", "draft pick",
    # Empty clickbait
    "you won't believe", "doctors hate", "this one trick",
]

_keyword_pattern: Optional[re.Pattern] = None


def _get_keyword_pattern() -> re.Pattern:
    global _keyword_pattern
    if _keyword_pattern is None:
        escaped = [re.escape(k) for k in IRRELEVANT_KEYWORDS]
        _keyword_pattern = re.compile("|".join(escaped), re.IGNORECASE)
    return _keyword_pattern


def is_relevant_article(title: str = "", source: str = "", summary: str = "") -> bool:
    """Return True if the article is likely relevant to political simulation."""
    source_lower = (source or "").lower().strip()
    for pat in IRRELEVANT_SOURCE_PATTERNS:
        if pat in source_lower:
            return False
    text = f"{title or ''} {summary or ''}"
    if _get_keyword_pattern().search(text):
        return False
    return True
