"""Layer 5: OASIS Adapter Service.

Converts enriched agent records into OASIS-compatible
CSV (Twitter) or JSON (Reddit) format.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .exporter import to_twitter_csv, to_reddit_json

app = FastAPI(title="Civatas · Adapter", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ExportRequest(BaseModel):
    agents: list[dict]
    edges: list[dict] = []
    format: str = "twitter_csv"  # "twitter_csv" | "reddit_json"


@app.get("/health")
async def health():
    return {"status": "ok", "service": "adapter"}


@app.post("/export")
async def export(req: ExportRequest):
    """Export agents to OASIS format and return as a downloadable file."""
    if req.format == "twitter_csv":
        content = to_twitter_csv(req.agents, req.edges)
        return StreamingResponse(
            iter([content]),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=agents.csv"},
        )
    elif req.format == "reddit_json":
        content = to_reddit_json(req.agents)
        return StreamingResponse(
            iter([content]),
            media_type="application/json",
            headers={"Content-Disposition": "attachment; filename=agents.json"},
        )
    return {"error": f"Unknown format: {req.format}"}
