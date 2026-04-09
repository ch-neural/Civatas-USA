"""OASIS simulation runner.

Implements the full simulation pipeline:
  1. Create LLM model via camel ModelFactory
  2. Load agent CSV → generate_twitter_agent_graph / reddit
  3. oasis.make() to create environment
  4. env.step() with LLMAction for social interaction rounds
  5. env.step() with ManualAction(INTERVIEW) for polling
  6. env.close() and return .db path
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
import time
import uuid
from typing import Any

logger = logging.getLogger(__name__)

# ── Job store (in-memory) ─────────────────────────────────────────────
# For production, use Redis or a DB. For MVP, dict is fine.
_jobs: dict[str, dict[str, Any]] = {}


def get_job(job_id: str) -> dict[str, Any] | None:
    return _jobs.get(job_id)


def list_jobs() -> list[dict[str, Any]]:
    return list(_jobs.values())


# ── Main entry point ──────────────────────────────────────────────────

async def start_simulation(req: Any) -> dict:
    """Create a simulation job and run it in background.

    Returns immediately with a job_id for status polling.
    """
    job_id = str(uuid.uuid4())[:8]
    db_path = f"/data/outputs/sim_{job_id}.db"

    job = {
        "job_id": job_id,
        "status": "pending",
        "agent_file": req.agent_file,
        "platform": req.platform,
        "llm_model": req.llm_model,
        "steps": req.steps,
        "interview_prompts": req.interview_prompts,
        "db_path": db_path,
        "current_step": 0,
        "total_steps": req.steps + 1,  # +1 for interview round
        "agent_count": 0,
        "interview_count": 0,
        "started_at": time.time(),
        "completed_at": None,
        "error": None,
    }
    _jobs[job_id] = job

    asyncio.create_task(_run_simulation_background(job, req))
    return {"job_id": job_id, "status": "pending", "db_path": db_path}


async def _run_simulation_background(job: dict, req: Any) -> None:
    """Execute the OASIS simulation in background."""
    try:
        job["status"] = "initializing"
        logger.info(f"[{job['job_id']}] Initializing simulation...")

        # ── 1. Import OASIS ───────────────────────────────────
        try:
            import oasis
            from oasis import (
                ActionType,
                LLMAction,
                ManualAction,
                generate_twitter_agent_graph,
                generate_reddit_agent_graph,
            )
            from camel.models import ModelFactory
            from camel.types import ModelPlatformType, ModelType
        except ImportError as e:
            raise RuntimeError(
                f"OASIS not available. Ensure OASIS source is mounted "
                f"at /opt/oasis. Error: {e}"
            )

        # ── 2. Create LLM model ──────────────────────────────
        model_map = {
            "gpt-4o-mini": ModelType.GPT_4O_MINI,
            "gpt-4o": ModelType.GPT_4O,
            "gpt-4": ModelType.GPT_4,
            "gpt-3.5-turbo": ModelType.GPT_3_5_TURBO,
        }
        model_type = model_map.get(req.llm_model, ModelType.GPT_4O_MINI)

        model_kwargs = {}
        api_key = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
        base_url = os.getenv("LLM_BASE_URL")
        if base_url:
            model_kwargs["api_key"] = api_key
            model_kwargs["url"] = base_url

        openai_model = ModelFactory.create(
            model_platform=ModelPlatformType.OPENAI,
            model_type=model_type,
            **model_kwargs,
        )

        # ── 3. Build AgentGraph ───────────────────────────────
        available_actions = [
            ActionType.CREATE_POST,
            ActionType.LIKE_POST,
            ActionType.REPOST,
            ActionType.FOLLOW,
            ActionType.DO_NOTHING,
        ]

        agent_file = req.agent_file
        # Resolve relative paths under /data/outputs
        if not os.path.isabs(agent_file):
            agent_file = os.path.join("/data/outputs", agent_file)

        if not os.path.isfile(agent_file):
            raise FileNotFoundError(f"Agent file not found: {agent_file}")

        job["status"] = "loading_agents"
        logger.info(f"[{job['job_id']}] Loading agents from {agent_file}")

        if req.platform == "reddit":
            agent_graph = await generate_reddit_agent_graph(
                profile_path=agent_file,
                model=openai_model,
                available_actions=available_actions,
            )
        else:
            agent_graph = await generate_twitter_agent_graph(
                profile_path=agent_file,
                model=openai_model,
                available_actions=available_actions,
            )

        agent_count = agent_graph.get_num_nodes()
        job["agent_count"] = agent_count
        logger.info(f"[{job['job_id']}] Loaded {agent_count} agents")

        # ── 4. Create environment ─────────────────────────────
        db_path = job["db_path"]
        if os.path.exists(db_path):
            os.remove(db_path)

        platform_type = (
            oasis.DefaultPlatformType.REDDIT
            if req.platform == "reddit"
            else oasis.DefaultPlatformType.TWITTER
        )
        os.environ["OASIS_DB_PATH"] = os.path.abspath(db_path)

        env = oasis.make(
            agent_graph=agent_graph,
            platform=platform_type,
            database_path=db_path,
        )
        await env.reset()
        job["status"] = "running"
        logger.info(f"[{job['job_id']}] Environment ready, starting simulation")

        # ── 5. Run interaction steps ──────────────────────────
        all_agent_ids = list(range(agent_count))
        concurrency = min(req.concurrency, agent_count)

        for step_num in range(req.steps):
            job["current_step"] = step_num + 1
            logger.info(
                f"[{job['job_id']}] Step {step_num + 1}/{req.steps}"
            )

            # Activate a random batch of agents each step
            batch_size = min(concurrency, agent_count)
            active_ids = random.sample(all_agent_ids, batch_size)

            actions = {
                agent: LLMAction()
                for _, agent in env.agent_graph.get_agents(active_ids)
            }
            await env.step(actions)

        # ── 6. Run INTERVIEW round ────────────────────────────
        if req.interview_prompts:
            job["status"] = "interviewing"
            job["current_step"] = req.steps + 1
            logger.info(f"[{job['job_id']}] Running interviews...")

            # Determine which agents to interview
            sample_count = max(
                1, int(agent_count * req.interview_sample_ratio)
            )
            interview_ids = random.sample(all_agent_ids, sample_count)

            for prompt in req.interview_prompts:
                actions = {}
                for agent_id in interview_ids:
                    actions[env.agent_graph.get_agent(agent_id)] = ManualAction(
                        action_type=ActionType.INTERVIEW,
                        action_args={"prompt": prompt},
                    )
                await env.step(actions)

            job["interview_count"] = len(interview_ids) * len(
                req.interview_prompts
            )
            logger.info(
                f"[{job['job_id']}] Completed {job['interview_count']} interviews"
            )

        # ── 7. Close ──────────────────────────────────────────
        await env.close()

        job["status"] = "completed"
        job["completed_at"] = time.time()
        elapsed = job["completed_at"] - job["started_at"]
        logger.info(
            f"[{job['job_id']}] Simulation completed in {elapsed:.1f}s. "
            f"DB: {db_path}"
        )

    except Exception as e:
        logger.exception(f"[{job['job_id']}] Simulation failed: {e}")
        job["status"] = "failed"
        job["error"] = str(e)
        job["completed_at"] = time.time()


# ── Legacy entry point (kept for compatibility) ──────────────────────

async def run_simulation(req: Any) -> dict:
    """Synchronous wrapper — starts background job and returns immediately."""
    return await start_simulation(req)
