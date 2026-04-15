"""Civatas shared schema: intermediate person record."""
from __future__ import annotations

from pydantic import BaseModel


class Person(BaseModel):
    """Intermediate person record produced by the synthesis layer.

    Required fields are always present. Optional fields depend on
    which dimensions the user uploaded.
    """
    person_id: int
    age: int
    gender: str
    district: str

    education: str | None = None
    occupation: str | None = None
    race: str | None = None
    hispanic_or_latino: str | None = None
    household_income: str | None = None
    income_band: str | None = None
    household_type: str | None = None
    household_tenure: str | None = None
    marital_status: str | None = None
    party_lean: str | None = None
    issue_1: str | None = None
    issue_2: str | None = None
    media_habit: str | None = None
    mbti: str | None = None
    vote_probability: float | None = None

    custom_fields: dict[str, str] = {}
