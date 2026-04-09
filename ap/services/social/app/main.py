"""Layer 4: Social Graph Service.

Generates follow relationships and optional seed posts
based on agent similarity (district, age, party_lean, etc.).
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .graph import build_follow_graph

app = FastAPI(title="Civatas · Social Graph", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class GraphRequest(BaseModel):
    agents: list[dict]
    density: float = 0.02
    homophily_fields: list[str] = ["district", "party_lean"]


@app.get("/health")
async def health():
    return {"status": "ok", "service": "social"}


@app.post("/generate")
async def generate(req: GraphRequest):
    """Generate follow relationships for agents."""
    edges = build_follow_graph(
        agents=req.agents,
        density=req.density,
        homophily_fields=req.homophily_fields,
    )
    return {"edge_count": len(edges), "edges": edges}
