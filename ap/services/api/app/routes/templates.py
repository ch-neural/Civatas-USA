"""Template management routes.

Provides built-in demographic templates (e.g., Taiwan cities,
US states) that users can use as starting points.

Stage 1.8: GET /templates now returns metadata for each template (name,
region, country, election type/scope/cycle) so the frontend can group
templates by election type and let users pick one when creating a
workspace. Older templates without an `election` block are still listed —
their election fields come back as null.
"""
import json
import os

from fastapi import APIRouter

router = APIRouter()

TEMPLATES_DIR = "/data/templates"


def _load_template_meta(filename: str) -> dict | None:
    """Load just the metadata-relevant fields of a template file."""
    path = os.path.join(TEMPLATES_DIR, filename)
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None

    election = data.get("election") or {}
    return {
        "id": filename.replace(".json", ""),
        "name": data.get("name") or filename,
        "name_zh": data.get("name_zh"),
        "region": data.get("region"),
        "region_code": data.get("region_code"),
        "fips": data.get("fips"),  # 2-digit state FIPS — used by frontend USMap to highlight
        "country": data.get("country", "TW"),
        "locale": data.get("locale", "zh-TW"),
        "election": {
            "type": election.get("type"),
            "scope": election.get("scope"),
            "cycle": election.get("cycle"),
            "is_generic": election.get("is_generic"),
            "candidate_count": len(election.get("candidates") or []),
        } if election else None,
        "metadata": data.get("metadata"),
    }


@router.get("")
async def list_templates():
    """List available demographic templates with metadata.

    Returns:
      {
        "templates": [
          {
            "id": "presidential_national_generic",
            "name": "US Presidential — National (Generic)",
            "region": "United States",
            "country": "US",
            "locale": "en-US",
            "election": {"type": "presidential", "scope": "national",
                         "cycle": null, "is_generic": true,
                         "candidate_count": 3},
            "metadata": {...}
          },
          ...
        ]
      }
    """
    if not os.path.isdir(TEMPLATES_DIR):
        return {"templates": []}

    templates = []
    for filename in sorted(os.listdir(TEMPLATES_DIR)):
        if not filename.endswith(".json"):
            continue
        meta = _load_template_meta(filename)
        if meta is not None:
            templates.append(meta)

    return {"templates": templates}


@router.get("/{template_name}")
async def get_template(template_name: str):
    """Get a specific template (full body)."""
    path = os.path.join(TEMPLATES_DIR, f"{template_name}.json")
    if not os.path.isfile(path):
        return {"error": f"Template '{template_name}' not found"}
    with open(path) as f:
        return json.load(f)
