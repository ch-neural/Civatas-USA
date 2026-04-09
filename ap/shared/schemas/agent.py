"""Civatas shared schema: final agent record for OASIS."""
from __future__ import annotations

from pydantic import BaseModel


class TwitterAgent(BaseModel):
    """Agent record in OASIS Twitter CSV format."""
    name: str
    username: str
    user_char: str
    description: str
    following_agentid_list: str = "[]"
    previous_tweets: str = "[]"


class RedditAgent(BaseModel):
    """Agent record in OASIS Reddit JSON format."""
    realname: str
    username: str
    bio: str
    persona: str
    age: int
    gender: str
    mbti: str = "ISTJ"
    country: str = ""
