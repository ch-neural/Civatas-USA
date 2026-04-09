"""Validate a ProjectConfig for completeness and consistency."""
from __future__ import annotations

from shared.schemas import DimensionType, ProjectConfig

REQUIRED_DIMENSIONS = {"age", "gender", "district"}


def validate_config(config: ProjectConfig) -> dict:
    """Return a validation report."""
    errors: list[str] = []
    warnings: list[str] = []

    missing = REQUIRED_DIMENSIONS - set(config.dimensions.keys())
    if missing:
        errors.append(f"Missing required dimensions: {missing}")

    for name, dim in config.dimensions.items():
        if dim.type == DimensionType.CATEGORICAL and dim.categories:
            total = sum(c.weight for c in dim.categories)
            if abs(total - 1.0) > 0.05:
                warnings.append(
                    f"Dimension '{name}' weights sum to {total:.3f} "
                    f"(expected ~1.0). Will be auto-normalized."
                )
        elif dim.type == DimensionType.RANGE and dim.bins:
            total = sum(b.weight for b in dim.bins)
            if abs(total - 1.0) > 0.05:
                warnings.append(
                    f"Dimension '{name}' weights sum to {total:.3f} "
                    f"(expected ~1.0). Will be auto-normalized."
                )

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
    }
