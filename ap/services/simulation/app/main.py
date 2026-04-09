"""Layer 6: Simulation Runner Service.

Orchestrates OASIS simulation execution, including
agent loading, social interaction, and INTERVIEW polling.
Simulations run in the background; poll /status/{job_id} for progress.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .runner import run_simulation, get_job, list_jobs

app = FastAPI(title="Civatas · Simulation", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SimulationRequest(BaseModel):
    agent_file: str
    platform: str = "twitter"  # "twitter" | "reddit"
    llm_model: str = "gpt-4o-mini"
    steps: int = 3
    concurrency: int = 64
    interview_prompts: list[str] = []
    interview_sample_ratio: float = 1.0


@app.get("/health")
async def health():
    return {"status": "ok", "service": "simulation"}


@app.post("/run")
async def run(req: SimulationRequest):
    """Start an OASIS simulation run (background).

    Returns a job_id immediately. Poll /status/{job_id} for progress.
    """
    result = await run_simulation(req)
    return result


@app.get("/status/{job_id}")
async def status(job_id: str):
    """Get the status of a running simulation."""
    job = get_job(job_id)
    if job is None:
        return {"error": f"Job {job_id} not found"}
    return job


@app.get("/jobs")
async def jobs():
    """List all simulation jobs."""
    return {"jobs": list_jobs()}
