"""Civatas shared schema: distribution configuration."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class DimensionType(str, Enum):
    CATEGORICAL = "categorical"
    RANGE = "range"


class CategoryItem(BaseModel):
    value: str
    weight: float = Field(ge=0)


class RangeBin(BaseModel):
    range: str  # e.g. "18-24", "65+"
    weight: float = Field(ge=0)


class Dimension(BaseModel):
    type: DimensionType
    categories: list[CategoryItem] | None = None
    bins: list[RangeBin] | None = None

    @field_validator("categories", "bins")
    @classmethod
    def at_least_one(cls, v: Any, info):
        return v


class CrossCorrelationRule(BaseModel):
    """Boost/suppress probability for specific dimension combinations."""
    conditions: dict[str, str]
    boost: float = Field(default=1.0, gt=0)


class CrossCorrelation(BaseModel):
    dims: list[str]
    rules: list[CrossCorrelationRule]


class JointTable(BaseModel):
    """Preserved cross-tabulation from a single data source.

    Captures the full joint distribution of multiple dimensions
    from one file, enabling correlated sampling.
    """
    source: str                    # source filename
    dim_names: list[str]           # e.g., ["district", "gender", "age", "education"]
    rows: list[dict[str, str]]     # each row = {dim_name: value, ...}
    weights: list[float]           # parallel array, same length as rows


class DistrictProfile(BaseModel):
    """Per-district population distributions."""
    name: str
    population: int = 0
    dimensions: dict[str, Dimension] = Field(default_factory=dict)


class ProjectConfig(BaseModel):
    """Top-level project configuration uploaded by the user."""
    name: str
    region: str = ""
    locale: str = "zh-TW"
    target_count: int = Field(default=1000, ge=1)
    dimensions: dict[str, Dimension]
    district_profiles: dict[str, DistrictProfile] = Field(default_factory=dict)
    cross_correlations: list[CrossCorrelation] = Field(default_factory=list)
    joint_tables: list[JointTable] = Field(default_factory=list)
    filters: dict[str, list[str]] = Field(default_factory=dict)
    selected_dimensions: list[str] | None = None

