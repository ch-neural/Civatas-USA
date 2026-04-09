"""Layer 2: Population Synthesis Service.

Generates a structurally representative population sample
from user-provided distribution configurations.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from shared.schemas import ProjectConfig

from .builder import build_population, build_population_flat

app = FastAPI(title="Civatas · Synthesis", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "synthesis"}


@app.post("/generate")
async def generate(config: ProjectConfig):
    """Generate synthetic population from a ProjectConfig."""
    persons = build_population_flat(config)
    return {
        "count": len(persons),
        "persons": persons,
    }
