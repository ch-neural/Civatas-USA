"""Layer 3: Persona Enrichment Service.

Transforms structured Person records into natural-language
agent personas suitable for OASIS. US-only (English).
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from shared.schemas import Person

from .generator import generate_personas

app = FastAPI(title="Civatas · Persona", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class PersonaRequest(BaseModel):
    persons: list[Person]
    strategy: str = "template"  # "template" | "llm" | "hybrid"
    locale: str = "en"
    template: str | None = None
    llm_prompt: str | None = None
    vendor_assignments: dict[str, str] | None = None  # {person_id: vendor_name}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "persona"}


@app.post("/generate")
async def generate(req: PersonaRequest):
    """Generate persona text for a list of persons."""
    agents = await generate_personas(
        persons=req.persons,
        strategy=req.strategy,
        locale="en",  # US-only
        template=req.template,
        llm_prompt=req.llm_prompt,
        vendor_assignments=req.vendor_assignments,
    )
    return {"count": len(agents), "agents": agents}

