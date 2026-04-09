"""Civatas API Gateway.

Central API that orchestrates calls to downstream microservices
(ingestion, synthesis, persona, social, adapter, simulation, analytics).
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routes import projects, pipeline, templates, workspaces, settings

app = FastAPI(
    title="Civatas API",
    version="0.1.0",
    description="Universal Social Simulation Agent Generation Platform",
    # Disable trailing-slash 307 redirects. When the gateway is fronted by a
    # reverse proxy (e.g. Next.js rewrites), Starlette would otherwise emit a
    # 307 with a Location header containing the upstream Host (e.g.
    # http://api:8000/...), which the browser cannot resolve. Routes are
    # registered without trailing slashes; clients always call the canonical
    # path.
    redirect_slashes=False,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# ── Routers ─────────────────────────────────────────────────────────
app.include_router(projects.router, prefix="/api/projects", tags=["projects"])
app.include_router(pipeline.router, prefix="/api/pipeline", tags=["pipeline"])
app.include_router(templates.router, prefix="/api/templates", tags=["templates"])
app.include_router(workspaces.router, prefix="/api/workspaces", tags=["workspaces"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])


@app.get("/health")
async def health():
    return {"status": "ok", "service": "api-gateway"}


@app.get("/api/runtime")
async def runtime_info():
    """Lightweight endpoint exposing the runtime locale config to the frontend.
    The project is US-only; locale defaults to English but the frontend may
    toggle to additional languages (zh-TW, ja, ko, …) via the i18n system.
    """
    import os as _os
    return {
        "country": "US",
        "locale": _os.environ.get("DEFAULT_LOCALE", "en"),
    }


@app.get("/api/runtime/news-sources")
async def runtime_news_sources():
    """Return the news source taxonomy: ~130 US outlets bucketed into 5 Cook
    tiers (Solid Dem / Lean Dem / Tossup / Lean Rep / Solid Rep).
    """
    try:
        from pathlib import Path as _Path
        import json as _json
        snap = _Path("/app/shared/us_data/us_feed_sources.json")
        if snap.exists():
            payload = _json.loads(snap.read_text())
            return payload
    except Exception:
        pass
    # Fallback: minimal hardcoded set if the snapshot is missing.
    return {
        "country": "US",
        "schema": "5-tier Cook bucket",
        "buckets": {
            "Solid Dem": ["MSNBC", "HuffPost", "Mother Jones"],
            "Lean Dem":  ["The New York Times", "The Washington Post", "CNN", "NPR"],
            "Tossup":    ["Reuters", "Associated Press", "Bloomberg"],
            "Lean Rep":  ["The Wall Street Journal", "New York Post", "National Review"],
            "Solid Rep": ["Fox News", "Breitbart", "The Daily Wire"],
        },
    }
