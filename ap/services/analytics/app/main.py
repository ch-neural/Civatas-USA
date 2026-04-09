"""Layer 7: Analytics Service.

Reads OASIS simulation results (.db) and produces
poll statistics, group analysis, and exportable reports.
"""
import sqlite3

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .analyzer import analyze_interviews

app = FastAPI(title="Civatas · Analytics", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyticsRequest(BaseModel):
    db_path: str
    group_by: list[str] = []


@app.get("/health")
async def health():
    return {"status": "ok", "service": "analytics"}


@app.post("/analyze")
async def analyze(req: AnalyticsRequest):
    """Analyze interview results from an OASIS .db file."""
    results = analyze_interviews(req.db_path, req.group_by)
    return results
