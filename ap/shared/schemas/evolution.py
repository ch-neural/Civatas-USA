"""Civatas shared schemas: evolution-related data models."""
from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel


class NewsArticle(BaseModel):
    """A single article in the central news pool."""
    article_id: str
    title: str
    summary: str = ""
    source_url: str
    source_tag: str
    crawled_at: str  # ISO datetime


class AgentDiary(BaseModel):
    """A single diary entry produced by the daily evolution loop."""
    agent_id: int
    day: int
    fed_articles: list[str] = []
    diary_text: str
    satisfaction: float
    anxiety: float
    extra_metrics: dict = {}


class DietRule(BaseModel):
    """A filter-bubble / media diet rule."""
    rule_id: str = ""
    condition: dict = {}
    preferred_sources: list[str] = []
    serendipity_rate: float = 0.05
