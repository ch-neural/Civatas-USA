"""Pipeline orchestration routes.

Each endpoint calls the appropriate downstream microservice.
"""
from fastapi import APIRouter, File, UploadFile, Body, Request, BackgroundTasks
from fastapi.responses import JSONResponse
import httpx
import os
import json
import base64
import logging

log = logging.getLogger(__name__)

router = APIRouter()

INGESTION_URL = "http://ingestion:8000"
SYNTHESIS_URL = "http://synthesis:8000"
PERSONA_URL = "http://persona:8000"
SOCIAL_URL = "http://social:8000"
ADAPTER_URL = "http://adapter:8000"
SIMULATION_URL = "http://simulation:8000"
ANALYTICS_URL = "http://analytics:8000"
EVOLUTION_URL = "http://evolution:8000"


@router.post("/upload")
async def upload_statistics(file: UploadFile = File(...)):
    """Upload and parse a statistics file via the ingestion service."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        content = await file.read()
        resp = await client.post(
            f"{INGESTION_URL}/parse",
            files={"file": (file.filename, content, file.content_type)},
        )
    if resp.status_code != 200:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=resp.status_code, content=resp.json())

    result = resp.json()

    return result


@router.post("/extract-text")
async def extract_text_proxy(file: UploadFile = File(...)):
    """Upload any file and extract its text content via the ingestion service."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        content = await file.read()
        resp = await client.post(
            f"{INGESTION_URL}/extract-text",
            files={"file": (file.filename, content, file.content_type)},
        )
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())

    return resp.json()


@router.post("/leaning-profile/upload")
async def upload_leaning_profile_proxy(file: UploadFile = File(...)):
    """Upload leaning profile via the evolution service."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        content = await file.read()
        resp = await client.post(
            f"{EVOLUTION_URL}/leaning-profile/upload",
            files={"file": (file.filename, content, file.content_type)},
        )
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.get("/leaning-profile")
async def get_leaning_profile_proxy():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/leaning-profile")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.delete("/leaning-profile")
async def delete_leaning_profile_proxy():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.delete(f"{EVOLUTION_URL}/leaning-profile")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.post("/parse-election-data")
async def parse_election_data(payload: dict = Body(...)):
    """Use LLM to intelligently parse election data from any text/image input."""
    text_content = payload.get("text", "")
    image_base64 = payload.get("image_base64", "")

    from shared.global_settings import get_system_llm_credentials
    creds = get_system_llm_credentials()
    api_key = creds["api_key"] or os.getenv("OPENAI_API_KEY", "")
    model = creds["model"]
    base_url = creds["base_url"] or "https://api.openai.com/v1"

    if not api_key:
        return JSONResponse(status_code=500, content={"error": "LLM API key not configured"})

    system_prompt = """你是一個選舉資料解析專家。你的任務是從使用者提供的任何格式資料中，提取選舉候選人資訊。

請從輸入內容中提取以下欄位：
- name: 候選人姓名
- party: 所屬政黨（如：中國國民黨、民主進步黨、無黨籍及未經政黨推薦等）
- votes: 得票數（整數）
- pct: 得票率（百分比數值，不含%符號）

重要規則：
1. 如果資料中有數字帶逗號（如 799,107），請去除逗號
2. 如果得票率有 % 符號，請去除
3. 如果得票率缺失但有得票數，可根據總票數計算
4. 忽略非候選人的行（如標題行、合計行等）
5. 如果資料不包含選舉結果，返回空陣列

請以嚴格 JSON 格式回覆，不要包含其他文字。格式：
{"candidates": [{"name": "xxx", "party": "xxx", "votes": 12345, "pct": 12.34}]}"""

    messages = [{"role": "system", "content": system_prompt}]

    if image_base64:
        # Image + text mode (vision)
        user_content = []
        if text_content:
            user_content.append({"type": "text", "text": f"以下是使用者提供的資料，請解析選舉結果：\n\n{text_content}"})
        user_content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{image_base64}", "detail": "high"}
        })
        messages.append({"role": "user", "content": user_content})
        # Use vision model
        model = "gpt-4o-mini"
    else:
        messages.append({"role": "user", "content": f"以下是使用者提供的資料，請解析選舉結果：\n\n{text_content}"})

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                },
            )
        if resp.status_code != 200:
            log.error(f"LLM API error: {resp.status_code} {resp.text}")
            return JSONResponse(status_code=502, content={"error": f"LLM API returned {resp.status_code}"})

        result = resp.json()
        content = result["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        return {"candidates": parsed.get("candidates", []), "raw_response": content}
    except json.JSONDecodeError as e:
        log.error(f"Failed to parse LLM response as JSON: {e}")
        return JSONResponse(status_code=500, content={"error": "LLM 回覆格式錯誤", "raw": content})
    except Exception as e:
        log.error(f"LLM parsing failed: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/validate")
async def validate_statistics(file: UploadFile = File(...)):
    """Validate an uploaded statistics file."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        content = await file.read()
        resp = await client.post(
            f"{INGESTION_URL}/validate",
            files={"file": (file.filename, content, file.content_type)},
        )
    return resp.json()


@router.post("/synthesize")
async def synthesize(config: dict):
    """Generate synthetic population via the synthesis service."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{SYNTHESIS_URL}/generate", json=config)
    return resp.json()


@router.post("/persona")
async def generate_persona(payload: dict):
    """Generate personas via the persona service."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{PERSONA_URL}/generate", json=payload)
    return resp.json()


@router.post("/social")
async def generate_social(payload: dict):
    """Generate social graph via the social service."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{SOCIAL_URL}/generate", json=payload)
    return resp.json()


@router.post("/export")
async def export_agents(payload: dict):
    """Export agents to OASIS format via the adapter service."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{ADAPTER_URL}/export", json=payload)
    return resp.json()


@router.post("/simulate")
async def run_simulation(payload: dict):
    """Start an OASIS simulation via the simulation service."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{SIMULATION_URL}/run", json=payload)
    return resp.json()


@router.get("/simulation-status/{job_id}")
async def simulation_status(job_id: str):
    """Get the status of a running simulation."""
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.get(f"{SIMULATION_URL}/status/{job_id}")
        return resp.json()
    except httpx.ReadTimeout:
        return {"job_id": job_id, "status": "initializing", "error": None}


@router.get("/simulation-jobs")
async def simulation_jobs():
    """List all simulation jobs."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{SIMULATION_URL}/jobs")
    return resp.json()


@router.post("/analyze")
async def analyze(payload: dict):
    """Analyze simulation results via the analytics service."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{ANALYTICS_URL}/analyze", json=payload)
    return resp.json()


# ── Evolution service proxy routes ───────────────────────────────────

@router.get("/evolution/llm-vendors")
async def evo_llm_vendors():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/llm-vendors")
    return resp.json()


@router.get("/evolution/sources")
async def evo_list_sources():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/sources")
    return resp.json()


@router.post("/evolution/sources")
async def evo_add_source(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/sources", json=payload)
    return resp.json()


@router.delete("/evolution/sources/{source_id}")
async def evo_delete_source(source_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.delete(f"{EVOLUTION_URL}/sources/{source_id}")
    return resp.json()


@router.patch("/evolution/sources/{source_id}")
async def evo_patch_source(source_id: str, payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.patch(f"{EVOLUTION_URL}/sources/{source_id}", json=payload)
    return resp.json()


@router.post("/evolution/crawl")
async def evo_crawl():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/crawl")
    return resp.json()


@router.get("/evolution/news-pool")
async def evo_news_pool():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/news-pool")
    return resp.json()


@router.post("/evolution/news-pool/inject")
async def evo_inject(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/news-pool/inject", json=payload)
    return resp.json()


@router.post("/evolution/news-pool/clear")
async def evo_clear_pool():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/news-pool/clear")
    return resp.json()


@router.get("/evolution/dashboard")
async def evo_dashboard(job_id: str = ""):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/evolution/dashboard", params={"job_id": job_id})
    return resp.json()


@router.get("/evolution/news-center")
async def evo_news_center(workspace_id: str = ""):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/news-center", params={"workspace_id": workspace_id} if workspace_id else {})
    return resp.json()


@router.get("/evolution/news-center/{article_id}")
async def evo_news_center_detail(article_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/news-center/{article_id}")
    return resp.json()


@router.get("/evolution/diet-rules")
async def evo_get_diet():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/diet-rules")
    return resp.json()


@router.put("/evolution/diet-rules")
async def evo_update_diet(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.put(f"{EVOLUTION_URL}/diet-rules", json=payload)
    return resp.json()


@router.post("/evolution/preview-feed")
async def evo_preview_feed(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/preview-feed", json=payload)
    return resp.json()


@router.post("/evolution/evolve")
async def evo_start(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/evolve", json=payload)
    return resp.json()


@router.get("/evolution/evolve/status/{job_id}")
async def evo_status(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/evolve/status/{job_id}")
    return resp.json()


@router.get("/evolution/evolve/jobs")
async def evo_jobs():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/evolve/jobs")
    return resp.json()


@router.get("/evolution/evolve/latest")
async def evo_latest():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/evolve/latest")
    return resp.json()


@router.get("/evolution/evolve/history")
async def evo_history():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/evolve/history")
    return resp.json()


@router.post("/evolution/evolve/stop/{job_id}")
async def evo_stop(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/evolve/stop/{job_id}")
    return resp.json()


@router.get("/evolution/export-playback")
async def evo_export_playback():
    """Collect all evolution data for standalone HTML export."""
    async with httpx.AsyncClient(timeout=600.0) as client:
        dashboard_resp = await client.get(f"{EVOLUTION_URL}/evolution/dashboard")
        history_resp = await client.get(f"{EVOLUTION_URL}/evolve/history")
        jobs_resp = await client.get(f"{EVOLUTION_URL}/evolve/jobs")

    dashboard = dashboard_resp.json() if dashboard_resp.status_code == 200 else {}
    history = history_resp.json() if history_resp.status_code == 200 else []
    jobs = jobs_resp.json() if jobs_resp.status_code == 200 else {}

    return {
        "dashboard": dashboard,
        "history": history if isinstance(history, list) else history.get("history", []),
        "jobs": jobs.get("jobs", []) if isinstance(jobs, dict) else jobs,
    }


@router.post("/evolution/analyze")
async def evo_analyze(payload: dict = Body(...)):
    """Use System LLM to generate deep analysis of evolution dashboard data."""
    from shared.global_settings import get_system_llm_credentials
    creds = get_system_llm_credentials()
    api_key = creds["api_key"] or os.getenv("OPENAI_API_KEY", "")
    model = creds["model"]
    base_url = creds["base_url"] or "https://api.openai.com/v1"

    if not api_key:
        return JSONResponse(status_code=500, content={"error": "LLM API key not configured"})

    daily_trends = payload.get("daily_trends", [])
    leaning_trends = payload.get("leaning_trends", [])
    candidate_trends = payload.get("candidate_trends", [])
    candidate_names = payload.get("candidate_names", [])
    agent_count = payload.get("agent_count", 0)
    locale = payload.get("locale", "en")
    period_label = payload.get("period_label", "")

    lang_instruction = (
        "Respond entirely in Traditional Chinese (繁體中文)."
        if locale == "zh-TW" else
        "Respond entirely in English."
    )

    period_context = (
        f"\nYou are analyzing the period: {period_label}. Focus your analysis on changes and patterns within this specific window."
        if period_label else ""
    )

    system_prompt = f"""You are an expert political analyst reviewing agent-based election simulation data.
You are given daily evolution trends from a social simulation where AI agents read news and update their satisfaction, anxiety, and political leaning.{period_context}

{lang_instruction}

Analyze the data and return a JSON object with these keys:
- "overall": A 3-5 sentence deep analysis of this period — identify the most significant changes, compare the start vs end of the period, highlight any emerging patterns or turning points, and explain what might be driving them. Be specific with day numbers and values.
- "satisfaction_anxiety": 2-3 sentences analyzing the Satisfaction & Anxiety trends in this period. Note divergences between local vs national satisfaction, anxiety spikes or declines, which political groups are most affected, and what real-world dynamics this might reflect.
- "political_leaning": 2-3 sentences analyzing the Political Leaning distribution changes. Note any shifts between left/center/right, which groups gained or lost members, and what threshold conditions might be triggering shifts.
- "candidate_awareness": 2-3 sentences analyzing candidate awareness trends (if data exists, otherwise null). Which candidates are gaining/losing visibility and why?
- "candidate_sentiment": 2-3 sentences analyzing candidate sentiment trends (if data exists, otherwise null). Which candidates have improving/declining sentiment and what news might be driving it?

Be concise but insightful. Compare beginning vs end of the period. Identify the most noteworthy change. Do NOT repeat raw data — interpret it.
Return ONLY valid JSON, no markdown fencing."""

    # Build compact data summary for the prompt
    data_text = f"Agent count: {agent_count}\n"
    if period_label:
        data_text += f"Analysis period: {period_label}\n"
    data_text += "\n"
    data_text += "Daily Trends (day, local_sat, national_sat, anxiety):\n"
    for d in daily_trends:
        data_text += f"  Day {d.get('day')}: local_sat={d.get('local_satisfaction')}, national_sat={d.get('national_satisfaction')}, anxiety={d.get('anxiety')}\n"

    if leaning_trends:
        data_text += "\nPolitical Leaning Trends (day, left%, center%, right%):\n"
        for d in leaning_trends:
            data_text += f"  Day {d.get('day')}: left={d.get('left')}%, center={d.get('center')}%, right={d.get('right')}%\n"

    if candidate_trends and candidate_names:
        data_text += f"\nTracked Candidates: {', '.join(candidate_names)}\n"
        data_text += "Candidate Trends (day, awareness, sentiment per candidate):\n"
        for d in candidate_trends:
            parts = [f"Day {d.get('day')}:"]
            for cn in candidate_names:
                aw = d.get(f"{cn}_awareness", "")
                st = d.get(f"{cn}_sentiment", "")
                if aw != "": parts.append(f"{cn} aw={aw:.0%}" if isinstance(aw, (int, float)) else f"{cn} aw={aw}")
                if st != "": parts.append(f"sent={st:.2f}" if isinstance(st, (int, float)) else f"sent={st}")
            data_text += f"  {' '.join(parts)}\n"

    import httpx as _httpx
    async with _httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": data_text},
                ],
                "temperature": 0.3,
                "max_tokens": 800,
            },
        )
    if resp.status_code != 200:
        return JSONResponse(status_code=502, content={"error": f"LLM API error: {resp.status_code}"})

    import json
    raw = resp.json()["choices"][0]["message"]["content"].strip()
    # Strip markdown fencing if present
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3].strip()

    try:
        analysis = json.loads(raw)
    except json.JSONDecodeError:
        analysis = {"overall": raw, "satisfaction_anxiety": None, "political_leaning": None, "candidate_awareness": None, "candidate_sentiment": None}

    return analysis


@router.post("/evolution/evolve/reset")
async def evo_reset():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/evolve/reset")
    return resp.json()


@router.get("/evolution/agents/all-stats")
async def evo_all_stats():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/agents/all-stats")
    return resp.json()


@router.get("/evolution/agents/{agent_id}/diary")
async def evo_diary(agent_id: int, recording_id: str = ""):
    async with httpx.AsyncClient(timeout=600.0) as client:
        params = {"recording_id": recording_id} if recording_id else {}
        resp = await client.get(f"{EVOLUTION_URL}/agents/{agent_id}/diary", params=params)
    return resp.json()


@router.get("/evolution/agents/{agent_id}/stats")
async def evo_stats(agent_id: int):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/agents/{agent_id}/stats")
    return resp.json()


@router.post("/evolution/memory/search")
async def evo_memory_search(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/memory/search", json=payload)
    return resp.json()


# ── Stat modules ─────────────────────────────────────────────────────

@router.get("/evolution/stat-modules")
async def stat_modules_list():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/stat-modules")
    return resp.json()


@router.put("/evolution/stat-modules/{module_id}/toggle")
async def stat_modules_toggle(module_id: str, enabled: bool = True):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.put(
            f"{EVOLUTION_URL}/stat-modules/{module_id}/toggle",
            params={"enabled": enabled},
        )
    return resp.json()


@router.get("/evolution/stat-modules/{module_id}")
async def stat_modules_get(module_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/stat-modules/{module_id}")
    return resp.json()


from fastapi import Request

@router.post("/evolution/stat-modules/upload")
async def stat_modules_upload(request: Request):
    """Proxy multi-file upload to evolution service."""
    from starlette.datastructures import UploadFile as StarletteUpload
    form = await request.form()

    # Collect files and form fields
    files_list = []
    data = {}
    for key, value in form.multi_items():
        if key == "files" and hasattr(value, "read"):
            content = await value.read()
            files_list.append(("files", (value.filename, content, value.content_type)))
        else:
            data[key] = str(value)

    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(
            f"{EVOLUTION_URL}/stat-modules/upload",
            files=files_list,
            data=data,
        )
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=resp.status_code, content=resp.json())


@router.put("/evolution/stat-modules/{module_id}")
async def stat_modules_update(module_id: str, payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.put(
            f"{EVOLUTION_URL}/stat-modules/{module_id}", json=payload
        )
    return resp.json()


@router.delete("/evolution/stat-modules/{module_id}")
async def stat_modules_delete(module_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.delete(f"{EVOLUTION_URL}/stat-modules/{module_id}")
    return resp.json()


# ── Leaning profile ──────────────────────────────────────────────────

@router.post("/evolution/leaning-profile/upload")
async def leaning_upload(file: UploadFile = File(...)):
    async with httpx.AsyncClient(timeout=600.0) as client:
        content = await file.read()
        resp = await client.post(
            f"{EVOLUTION_URL}/leaning-profile/upload",
            files={"file": (file.filename, content, file.content_type)},
        )
    return resp.json()


@router.get("/evolution/leaning-profile")
async def leaning_get():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/leaning-profile")
    return resp.json()


@router.delete("/evolution/leaning-profile")
async def leaning_delete():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.delete(f"{EVOLUTION_URL}/leaning-profile")
    return resp.json()


# ── Snapshots ────────────────────────────────────────────────────────

@router.post("/evolution/snapshots/save")
async def snapshot_save(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/snapshots/save", json=payload)
    return resp.json()


@router.post("/evolution/snapshots/restore")
async def snapshot_restore(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/snapshots/restore", json=payload)
    return resp.json()


@router.get("/evolution/snapshots")
async def snapshot_list():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/snapshots")
    return resp.json()


@router.get("/evolution/snapshots/{snapshot_id}/agent-ids")
async def snapshot_agent_ids(snapshot_id: str):
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.get(f"{EVOLUTION_URL}/snapshots/{snapshot_id}/agent-ids")
        if resp.status_code != 200:
            try:
                detail = resp.json()
            except Exception:
                detail = {"detail": resp.text or f"Evolution returned {resp.status_code}"}
            return JSONResponse(status_code=resp.status_code, content=detail)
        return resp.json()
    except Exception as e:
        return JSONResponse(status_code=502, content={"detail": f"Evolution proxy error: {str(e)}"})


@router.get("/evolution/snapshots/{snapshot_id}/stats")
async def snapshot_stats(snapshot_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/snapshots/{snapshot_id}/stats")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.get("/evolution/snapshots/{snapshot_id}")
async def snapshot_get(snapshot_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/snapshots/{snapshot_id}")
    return resp.json()


@router.delete("/evolution/snapshots/{snapshot_id}")
async def snapshot_delete(snapshot_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.delete(f"{EVOLUTION_URL}/snapshots/{snapshot_id}")
    return resp.json()


# ── Domain Plugins ───────────────────────────────────────────────────

@router.get("/evolution/plugins")
async def plugin_list():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/plugins")
    return resp.json()


@router.get("/evolution/plugins/{plugin_id}")
async def plugin_get(plugin_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/plugins/{plugin_id}")
    return resp.json()


# ── Calibration Packs ────────────────────────────────────────────────

@router.post("/evolution/calibration/packs")
async def calib_pack_create(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/calibration/packs", json=payload)
    return resp.json()


@router.get("/evolution/calibration/packs")
async def calib_pack_list():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/calibration/packs")
    return resp.json()


@router.get("/evolution/calibration/packs/{pack_id}")
async def calib_pack_get(pack_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/calibration/packs/{pack_id}")
    return resp.json()


@router.delete("/evolution/calibration/packs/{pack_id}")
async def calib_pack_delete(pack_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.delete(f"{EVOLUTION_URL}/calibration/packs/{pack_id}")
    return resp.json()


@router.post("/evolution/calibration/run")
async def calib_run(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/calibration/run", json=payload)
    return resp.json()


@router.post("/evolution/calibration/auto-calibrate")
async def calib_auto(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/calibration/auto-calibrate", json=payload)
    return resp.json()


@router.get("/evolution/calibration/auto-calibrate/{job_id}")
async def calib_auto_status(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/calibration/auto-calibrate/{job_id}")
    return resp.json()


@router.post("/evolution/calibration/auto-calibrate/{job_id}/stop")
async def calib_auto_stop(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/calibration/auto-calibrate/{job_id}/stop")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.get("/evolution/calibration/jobs/{job_id}")
async def calib_job_status(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/calibration/jobs/{job_id}")
    return resp.json()


@router.post("/evolution/calibration/stop/{job_id}")
async def calib_job_stop(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/calibration/stop/{job_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()
@router.post("/evolution/calibration/stop-and-save/{job_id}")
async def calib_job_stop_and_save(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/calibration/stop-and-save/{job_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.post("/evolution/calibration/pause/{job_id}")
async def calib_job_pause(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/calibration/pause/{job_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.post("/evolution/calibration/resume/{job_id}")
async def calib_job_resume(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/calibration/resume/{job_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()
@router.get("/evolution/calibration/checkpoints")
async def calib_list_checkpoints():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/calibration/checkpoints")
    return resp.json()


@router.post("/evolution/calibration/resume-checkpoint/{job_id}")
async def calib_resume_checkpoint(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/calibration/resume-checkpoint/{job_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


# ── Candidate Profile (Wikipedia + LLM) ──────────────────────────────

@router.post("/evolution/candidate-profile")
async def candidate_profile_proxy(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/candidate-profile", json=payload)
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()



# ── Auto Candidate Traits ─────────────────────────────────────────

@router.post("/evolution/auto-traits")
async def auto_traits_proxy(payload: dict):
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/auto-traits", json=payload)
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


# ── News Fetch Storage ────────────────────────────────────────

@router.post("/evolution/news-fetches")
async def news_fetch_save(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/news-fetches", json=payload)
    return resp.json()


@router.get("/evolution/news-fetches")
async def news_fetch_list():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/news-fetches")
    return resp.json()


@router.get("/evolution/news-fetches/{fetch_id}")
async def news_fetch_get(fetch_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/news-fetches/{fetch_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.delete("/evolution/news-fetches/{fetch_id}")
async def news_fetch_delete(fetch_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.delete(f"{EVOLUTION_URL}/news-fetches/{fetch_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()

@router.post("/parse-events-data")
async def parse_events_data(payload: dict = Body(...)):
    """Use LLM to parse unstructured text into a structured events timeline."""
    text_content = payload.get("text", "")
    target_days = payload.get("target_days")

    from shared.global_settings import get_system_llm_credentials
    creds = get_system_llm_credentials()
    api_key = creds["api_key"] or os.getenv("OPENAI_API_KEY", "")
    model = creds["model"]
    base_url = creds["base_url"] or "https://api.openai.com/v1"

    if not api_key:
        return JSONResponse(status_code=500, content={"error": "LLM API key not configured"})

    target_days_instruction = f"4. 使用者指定要將事件打散至 {target_days} 天內。請嚴格確保最終的 day 數量分配為剛好 {target_days} 天（Day 1 到 Day {target_days}）。" if target_days else "4. 請依據文本的時間跨度合理決定天數的長短。"

    system_prompt = f"""你是一個歷史事件與新聞解析專家。你的任務是從使用者提供的整段文字中，提取出隨時間發展的「事件序列（Events Timeline）」。

請將內容整理成連續的天數（day），且每一天可以包含多則新聞（news）。
每個 news 項目應包含：
- title: 新聞/事件標題（簡短摘要）
- summary: 事件詳細內容
- source_tag: 新聞來源或事件標籤（例如：TVBS、聯合報、歷史事件等；若無明確來源，請填寫「歷史事件」）

重要規則：
1. 根據文本的時間順序或段落，依序分配 `day` (從 1 開始，依序遞增。若文本描述的是同一天發生的多件事，應放在同一個 `day` 的陣列中)。
2. 若文本沒有明確天數，請依段落邏輯將其分拆成連續的 day。
3. 請移除與事件發展無關的雜訊。
{target_days_instruction}

請嚴格只回覆 JSON 格式，必須是一個 array，裡面包含 object。不要包含其他說明文字、不要加上 markdown ```json 標籤。
格式範例：
""" + """[
  {
    "day": 1,
    "news": [
      {
        "title": "藍白合破局，各自參選",
        "summary": "國民黨與民眾黨在君悅飯店的協商最終不歡而散，確定各自推派人選。",
        "source_tag": "TVBS"
      }
    ]
  },
  {
    "day": 2,
    "news": [
      {
        "title": "第二天的其他事件",
        "summary": "事件詳細說明。",
        "source_tag": "中時電子報"
      }
    ]
  }
]"""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"以下是使用者提供的歷史文字描述，請將其轉換為事件序列 JSON：\n\n{text_content}"}
    ]

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": 0.3,
                }
            )
            resp.raise_for_status()
            data = resp.json()

        content = data["choices"][0]["message"]["content"].strip()
        # Clean markdown formatting if present
        if content.startswith("```json"):
            content = content[7:]
        elif content.startswith("```"):
            content = content[3:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()

        parsed_json = json.loads(content)
        # Ensure it's a list
        if isinstance(parsed_json, dict) and "events" in parsed_json:
             parsed_json = parsed_json["events"]
        elif not isinstance(parsed_json, list):
             parsed_json = [parsed_json]
             
        return {"events": parsed_json}

    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"LLM 解析失敗: {str(e)}"})


@router.get("/leaning-profile/defaults")
async def get_default_leaning_profiles():
    """List available default leaning profiles, grouped by categories like city."""
    defaults_dir = os.path.join(os.path.dirname(__file__), "../defaults/leaning_profiles")
    if not os.path.exists(defaults_dir):
        return JSONResponse(status_code=200, content={"categories": {}})
        
    categories = {}
    for f in os.listdir(defaults_dir):
        if not (f.endswith(".csv") or f.endswith(".json") or f.endswith(".txt")):
            continue
        # Skip JSON files that are demographics configs
        if f.endswith(".json"):
            try:
                with open(os.path.join(defaults_dir, f), encoding="utf-8-sig") as fh:
                    data = json.loads(fh.read())
                if isinstance(data, dict) and "dimensions" in data:
                    continue
            except Exception:
                pass
                
        name = f.rsplit(".", 1)[0]
        
        # Determine category based on filename
        category = "未分類 (Uncategorized)"
        if "臺中" in name or "台中" in name:
            category = "臺中市 (Taichung City)"
        elif "臺北" in name or "台北" in name:
            category = "臺北市 (Taipei City)"
        elif "新北" in name:
            category = "新北市 (New Taipei City)"
        elif "桃園" in name:
            category = "桃園市 (Taoyuan City)"
        elif "臺南" in name or "台南" in name:
            category = "臺南市 (Tainan City)"
        elif "高雄" in name:
            category = "高雄市 (Kaohsiung City)"
            
        if category not in categories:
            categories[category] = []
        categories[category].append({"id": f, "name": name})
        
    return JSONResponse(status_code=200, content={"categories": categories})


@router.get("/leaning-profile/defaults/{filename}")
async def get_default_leaning_profile_detail(filename: str):
    """Parse and return a default leaning profile for preview without applying it."""
    import csv
    import io

    defaults_dir = os.path.join(os.path.dirname(__file__), "../defaults/leaning_profiles")
    file_path = os.path.join(defaults_dir, filename)
    
    if not os.path.exists(file_path):
        return JSONResponse(status_code=404, content={"error": f"預設檔案 {filename} 不存在"})
        
    try:
        with open(file_path, "rb") as f:
            content = f.read()
            
        text_content = None
        if filename.endswith(".csv") or filename.endswith(".txt"):
            try:
                text_content = content.decode("big5")
            except (UnicodeDecodeError, Exception):
                pass
        if text_content is None:
            try:
                text_content = content.decode("utf-8-sig")
            except UnicodeDecodeError:
                text_content = content.decode("big5", errors="ignore")

        if filename.endswith(".json"):
            try:
                json_data = json.loads(text_content)
            except json.JSONDecodeError:
                return JSONResponse(status_code=400, content={"error": "JSON 檔案格式錯誤"})
            return json_data

        first_line = text_content.split("\n")[0]
        delimiter = "\t" if "\t" in first_line else ","
        reader = csv.reader(io.StringIO(text_content), delimiter=delimiter)
        header = next(reader, None)
        if not header:
            return JSONResponse(status_code=400, content={"error": "CSV 檔案為空"})

        _NON_CANDIDATE_KEYWORDS = {"行政區", "區別", "村里", "投開票", "投票率", "得票率", "選舉人", "序號", "號次"}
        candidate_cols = []
        for i, col in enumerate(header):
            col = col.strip()
            if not col:
                continue
            if "（" in col and "）" in col:
                name_part = col.split("（")[0].strip()
                party_part = col.split("（")[1].split("）")[0].strip()
                candidate_cols.append((i, name_part, party_part))
            elif not any(kw in col for kw in _NON_CANDIDATE_KEYWORDS) and len(col) <= 10:
                candidate_cols.append((i, col, "無黨籍"))

        if not candidate_cols:
            return JSONResponse(status_code=400, content={"error": "預覽時無法解析候選人資料，請嘗試直接上傳套用由 LLM 解析。"})

        PARTY_SPECTRUM = {
            "民主進步黨": "偏左派", "民進黨": "偏左派", "台灣基進": "偏左派", "時代力量": "偏左派",
            "台灣民眾黨": "中立", "民眾黨": "中立", "中國國民黨": "偏右派", "國民黨": "偏右派",
            "親民黨": "偏右派", "新黨": "偏右派", "無": "中立", "無黨籍": "中立",
        }

        leaning_profile = {}
        for row in reader:
            if len(row) < len(header):
                continue
            district = row[0].strip()
            if not district or district in ("合計", "總計", "小計"):
                continue

            votes = {}
            total_votes = 0
            for col_idx, name, party in candidate_cols:
                try:
                    v = int(row[col_idx].strip().replace(",", "").replace('"', ''))
                except (ValueError, IndexError):
                    v = 0
                spectrum_key = PARTY_SPECTRUM.get(party, "中立")
                votes[spectrum_key] = votes.get(spectrum_key, 0) + v
                total_votes += v

            if total_votes == 0:
                continue

            leaning_profile[district] = {
                "偏左派": round(votes.get("偏左派", 0) / total_votes, 4),
                "中立": round(votes.get("中立", 0) / total_votes, 4),
                "偏右派": round(votes.get("偏右派", 0) / total_votes, 4),
            }

        if not leaning_profile:
            return JSONResponse(status_code=400, content={"error": "CSV 中找不到有效的行政區選舉數據"})

        return {"districts": leaning_profile}
        
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"預覽解析失敗: {str(e)}"})


@router.post("/leaning-profile/defaults/{filename}")
async def apply_default_leaning_profile(filename: str):
    """Apply a default leaning profile directly on the backend.
    
    Instead of using the LLM (which is unreliable for structured CSVs),
    parse the election CSV deterministically with Python.
    """
    import csv
    import io

    defaults_dir = os.path.join(os.path.dirname(__file__), "../defaults/leaning_profiles")
    file_path = os.path.join(defaults_dir, filename)
    
    if not os.path.exists(file_path):
        return JSONResponse(status_code=404, content={"error": f"預設檔案 {filename} 不存在"})
        
    try:
        # Read the default file
        with open(file_path, "rb") as f:
            content = f.read()
            
        # Decode: Big5 first for .csv and .txt, fallback to UTF-8
        text_content = None
        if filename.endswith(".csv") or filename.endswith(".txt"):
            try:
                text_content = content.decode("big5")
            except (UnicodeDecodeError, Exception):
                pass
        if text_content is None:
            try:
                text_content = content.decode("utf-8-sig")
            except UnicodeDecodeError:
                text_content = content.decode("big5", errors="ignore")

        # If it's a pre-processed JSON file, validate and upload
        if filename.endswith(".json"):
            try:
                json_data = json.loads(text_content)
            except json.JSONDecodeError:
                return JSONResponse(status_code=400, content={"error": "JSON 檔案格式錯誤"})
            
            # Reject demographics config files (they have "dimensions" key)
            if isinstance(json_data, dict) and "dimensions" in json_data:
                return JSONResponse(
                    status_code=400,
                    content={"error": "此檔案是人口特徵統計設定檔（用於人口合成），非政治傾向光譜資料。請上傳選舉得票資料（CSV/JSON/TXT）。"}
                )
            
            async with httpx.AsyncClient(timeout=600.0) as client:
                resp = await client.post(
                    f"{EVOLUTION_URL}/leaning-profile/upload",
                    files={"file": (filename, content, "application/json")},
                )
            if resp.status_code != 200:
                return JSONResponse(status_code=resp.status_code, content=resp.json())
            return resp.json()

        # ── Deterministic CSV/TSV parser for Taiwan election data ──
        # Auto-detect delimiter: if the header contains tabs, use tab; otherwise comma
        first_line = text_content.split("\n")[0]
        delimiter = "\t" if "\t" in first_line else ","
        reader = csv.reader(io.StringIO(text_content), delimiter=delimiter)
        header = next(reader, None)
        if not header:
            return JSONResponse(status_code=400, content={"error": "CSV 檔案為空"})

        # Identify candidate columns from header
        # Header format: 行政區別, 村里別, 投開票所別, 候選人1（黨籍）, 候選人2（黨籍）, ..., 投票率
        # Candidates with party: "林佳龍（民主進步黨）" 
        # Independent candidates: just a name like "宋原通"
        _NON_CANDIDATE_KEYWORDS = {"行政區", "區別", "村里", "投開票", "投票率", "得票率", "選舉人", "序號", "號次"}
        candidate_cols = []  # list of (col_index, name, party)
        for i, col in enumerate(header):
            col = col.strip()
            # Skip empty columns
            if not col:
                continue
            # Match patterns like "蔡其昌（民主進步黨）" or "盧秀燕（中國國民黨）"
            if "（" in col and "）" in col:
                name_part = col.split("（")[0].strip()
                party_part = col.split("（")[1].split("）")[0].strip()
                candidate_cols.append((i, name_part, party_part))
            elif not any(kw in col for kw in _NON_CANDIDATE_KEYWORDS) and len(col) <= 10:
                # Likely an independent candidate (short name, not a known header)
                candidate_cols.append((i, col, "無黨籍"))

        if not candidate_cols:
            # Fallback: send to LLM if we can't parse candidates
            payload = {"text": text_content}
            parsed_result = await parse_leaning_profile(payload)
            if isinstance(parsed_result, JSONResponse):
                return parsed_result
            parsed_json = json.dumps(parsed_result, ensure_ascii=False).encode("utf-8")
            async with httpx.AsyncClient(timeout=600.0) as client:
                resp = await client.post(
                    f"{EVOLUTION_URL}/leaning-profile/upload",
                    files={"file": ("default_profile.json", parsed_json, "application/json")},
                )
            if resp.status_code != 200:
                return JSONResponse(status_code=resp.status_code, content=resp.json())
            return resp.json()

        # Map party names to 5-point political spectrum
        # 偏左派 (pro-independence) | 偏左派 | 中立 | 偏右派 | 偏右派 (pro-unification)
        PARTY_SPECTRUM = {
            "民主進步黨": "偏左派",
            "民進黨": "偏左派",
            "台灣基進": "偏左派",
            "時代力量": "偏左派",
            "台灣民眾黨": "中立",
            "民眾黨": "中立",
            "中國國民黨": "偏右派",
            "國民黨": "偏右派",
            "親民黨": "偏右派",
            "新黨": "偏右派",
            "無": "中立",
            "無黨籍": "中立",
        }

        # Parse each district row
        leaning_profile = {}
        for row in reader:
            if len(row) < len(header):
                continue
            district = row[0].strip()
            if not district or district in ("合計", "總計", "小計"):
                continue

            # Parse vote counts (may have commas like "17,446")
            votes = {}
            total_votes = 0
            for col_idx, name, party in candidate_cols:
                try:
                    v = int(row[col_idx].strip().replace(",", "").replace('"', ''))
                except (ValueError, IndexError):
                    v = 0
                spectrum_key = PARTY_SPECTRUM.get(party, "中立")
                votes[spectrum_key] = votes.get(spectrum_key, 0) + v
                total_votes += v

            if total_votes == 0:
                continue

            # Convert to probability distribution
            leaning_profile[district] = {
                "偏左派": round(votes.get("偏左派", 0) / total_votes, 4),
                "中立": round(votes.get("中立", 0) / total_votes, 4),
                "偏右派": round(votes.get("偏右派", 0) / total_votes, 4),
            }

        if not leaning_profile:
            return JSONResponse(status_code=400, content={"error": "CSV 中找不到有效的行政區選舉數據"})

        log.info(f"Parsed default profile: {len(leaning_profile)} districts from {filename}")

        # Upload the parsed JSON to evolution service for persistence
        parsed_json = json.dumps(leaning_profile, ensure_ascii=False).encode("utf-8")
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(
                f"{EVOLUTION_URL}/leaning-profile/upload",
                files={"file": ("default_profile.json", parsed_json, "application/json")},
            )
        if resp.status_code != 200:
            return JSONResponse(status_code=resp.status_code, content=resp.json())
        return resp.json()
        
    except Exception as e:
        log.exception(f"Failed to apply default profile: {e}")
        return JSONResponse(status_code=500, content={"error": f"套用預設檔案失敗: {str(e)}"})


@router.post("/parse-leaning-profile")
async def parse_leaning_profile(payload: dict = Body(...)):
    """Use LLM to intelligently parse district election data into a leaning profile."""
    text_content = payload.get("text", "")
    image_base64 = payload.get("image_base64", "")

    # Heuristic to shrink massive CEC election CSV files
    if len(text_content) > 50000:
        try:
            import csv, io
            reader = csv.reader(io.StringIO(text_content))
            rows = list(reader)
            
            # Detect if it's a CEC format by looking for keywords in the first 10 rows
            is_cec = False
            for r in rows[:10]:
                row_str = "".join(r)
                if "行政區別" in row_str and "村里別" in row_str and "投開票所別" in row_str:
                    is_cec = True
                    break
                    
            if is_cec:
                compressed_rows = []
                for i, row in enumerate(rows):
                    if i < 10:
                        compressed_rows.append(row)
                        continue
                    # In CEC format, district total rows have district name in col 0, but empty col 1 and 2
                    if len(row) >= 3:
                        if row[0].strip() and not row[1].strip() and not row[2].strip():
                            compressed_rows.append(row)
                
                out = io.StringIO()
                writer = csv.writer(out)
                writer.writerows(compressed_rows)
                text_content = out.getvalue()
        except Exception:
            pass  # Fallback to original text if anything fails


    from shared.global_settings import get_system_llm_credentials
    creds = get_system_llm_credentials()
    api_key = creds["api_key"] or os.getenv("OPENAI_API_KEY", "")
    model = creds["model"]
    base_url = creds["base_url"] or "https://api.openai.com/v1"

    if not api_key:
        return JSONResponse(status_code=500, content={"error": "LLM API key not configured"})

    system_prompt = """你是一個台灣選舉資料與政治光譜分析專家。
你的任務是從使用者提供的「各行政區選舉得票統計資料」中，萃取出每個行政區的五大政治光譜傾向比例。

五大政治光譜為：
- 偏左派 (民進黨, 台聯, 綠黨, 基進黨等泛綠陣營)
- 偏左派 (時代力量等無明確統獨但偏向本土的勢力)
- 中立 (民眾黨, 無黨籍, 或中間選民)
- 偏右派 (國民黨, 親民黨等泛藍陣營)
- 偏右派 (新黨, 中華統一促進黨等)

重要規則：
1. 請幫我將使用者提供的各區票數，根據上述陣營加總並轉換為「百分比機率」（各光譜加總為 1.0）。
2. 如果資料缺乏某個光譜的資料，可給予 0.0。若無法判斷，可將剩餘比例分配給「中立」。
3. 請回傳一個嚴格的 JSON 格式物件，Key 為行政區名稱，Value 為五大光譜的比例。

請以嚴格 JSON 格式回覆，不要包含任何其他文字或 Markdown 標籤。格式範例：
{
  "大安區": {
    "偏左派": 0.37,
    "中立": 0.13,
    "偏右派": 0.50
  },
  "左營區": {
    ...
  }
}
"""

    messages = [{"role": "system", "content": system_prompt}]

    if image_base64:
        user_content = []
        if text_content:
            user_content.append({"type": "text", "text": f"以下是使用者提供的各區得票資料，請解析並轉換為光譜比例：\n\n{text_content}"})
        user_content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{image_base64}", "detail": "high"}
        })
        messages.append({"role": "user", "content": user_content})
        model = "gpt-4o-mini"
    else:
        messages.append({"role": "user", "content": f"以下是使用者提供的各區得票資料，請解析並轉換為光譜比例：\n\n{text_content}"})

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": 0.1,
                    "response_format": {"type": "json_object"},
                },
            )
        if resp.status_code != 200:
            # Assuming 'log' is defined elsewhere or needs to be imported/defined.
            # For this task, I'll assume it's available or replace with print for demonstration.
            # If 'log' is not defined, this line will cause an error.
            # For now, I'll comment it out or replace with a placeholder if 'log' is not standard.
            # log.error(f"LLM API error (LeaningProfile): {resp.status_code} {resp.text}")
            print(f"LLM API error (LeaningProfile): {resp.status_code} {resp.text}") # Placeholder
            return JSONResponse(status_code=502, content={"error": f"LLM API returned {resp.status_code}"})

        result = resp.json()
        content = result["choices"][0]["message"]["content"]
        
        parsed_json = json.loads(content)
        
        # Validation: simple check to ensure it at least has district-like names and some non-zero probs
        valid_districts = 0
        for district, probs in parsed_json.items():
            if isinstance(probs, dict):
                # If "districts" or "spectrum" comes up, it's a hallucination
                if district.lower() in ["districts", "spectrum", "count", "data"]:
                    continue
                # Check if it has any valid political spectrum values > 0
                if any(v > 0 for v in probs.values() if isinstance(v, (int, float))):
                    valid_districts += 1
                    
        if valid_districts == 0:
            return JSONResponse(
                status_code=400, 
                content={"error": "LLM 找不到任何有效的選舉得票數據。請確定您提供的內容包含各區的候選人或政黨得票數！"}
            )
            
        return parsed_json

    except Exception as e:

        # Assuming 'log' is defined elsewhere or needs to be imported/defined.
        # For this task, I'll assume it's available or replace with print for demonstration.
        # If 'log' is not defined, this line will cause an error.
        # For now, I'll comment it out or replace with a placeholder if 'log' is not standard.
        # log.error(f"/parse-leaning-profile exception: {e}")
        print(f"/parse-leaning-profile exception: {e}") # Placeholder
        return JSONResponse(status_code=500, content={"error": f"LLM 解析失敗: {str(e)}"})


# ── Predictions ──────────────────────────────────────────────────────

@router.post("/evolution/predictions")
async def prediction_create(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/predictions", json=payload)
    return resp.json()


@router.get("/evolution/predictions")
async def prediction_list():
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/predictions")
    return resp.json()


@router.get("/evolution/predictions/{pred_id}")
async def prediction_get(pred_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/predictions/{pred_id}")
    return resp.json()


@router.delete("/evolution/predictions/{pred_id}")
async def prediction_delete(pred_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.delete(f"{EVOLUTION_URL}/predictions/{pred_id}")
    return resp.json()


@router.post("/evolution/predictions/run")
async def prediction_run(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/predictions/run", json=payload)
    return resp.json()


@router.post("/evolution/predictions/analyze")
async def prediction_analyze(request: Request):
    payload = await request.json()
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/predictions/analyze", json=payload)
    return resp.json()


@router.post("/evolution/satisfaction-survey")
async def satisfaction_survey_proxy(request: Request):
    payload = await request.json()
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/satisfaction-survey", json=payload)
    return resp.json()


@router.get("/evolution/predictions/jobs/{job_id}")
async def prediction_job_status(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/predictions/jobs/{job_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.post("/evolution/predictions/stop/{job_id}")
async def prediction_job_stop(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/predictions/stop/{job_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.post("/evolution/predictions/pause/{job_id}")
async def prediction_job_pause(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/predictions/pause/{job_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.post("/evolution/predictions/resume/{job_id}")
async def prediction_job_resume(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/predictions/resume/{job_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


# ── Tavily News Research ──────────────────────────────────────────────

@router.post("/tavily-research")
async def tavily_research(payload: dict = Body(...)):
    """Use Tavily AI to search for relevant news within a date range.
    
    Body: {query, start_date (YYYY-MM-DD), end_date (YYYY-MM-DD), max_results?}
    Returns: {events: [{date, title, category}]}
    """
    from ..tavily_research import research_news

    query = payload.get("query", "")
    start_date = payload.get("start_date", "")
    end_date = payload.get("end_date", "")
    max_results = payload.get("max_results", 30)

    if not query or not start_date or not end_date:
        return JSONResponse(
            status_code=400,
            content={"error": "query, start_date, end_date 為必填欄位"},
        )

    try:
        events = await research_news(
            query=query,
            start_date=start_date,
            end_date=end_date,
            max_results=max_results,
        )
        return {"events": events}
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Tavily 搜尋失敗: {str(e)}"})


@router.post("/social-research")
async def social_research(payload: dict = Body(...)):
    """Search social media / forums (PTT, Dcard, Mobile01) for relevant discussions.

    Body: {query, start_date (YYYY-MM-DD), end_date (YYYY-MM-DD), max_results?}
    Returns: {events: [{date, title, summary, category, source_type: "社群"}]}
    """
    from ..tavily_research import research_social

    query = payload.get("query", "")
    start_date = payload.get("start_date", "")
    end_date = payload.get("end_date", "")
    max_results = payload.get("max_results", 20)

    if not query or not start_date or not end_date:
        return JSONResponse(
            status_code=400,
            content={"error": "query, start_date, end_date 為必填欄位"},
        )

    try:
        events = await research_social(
            query=query,
            start_date=start_date,
            end_date=end_date,
            max_results=max_results,
        )
        return {"events": events}
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"社群搜尋失敗: {str(e)}"})


# ── Election Database proxy ────────────────────────────────────────

# ── Historical Evolution proxy ─────────────────────────────────

@router.post("/evolution/historical-run")
async def historical_run(payload: dict):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/evolution/historical-run", json=payload)
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.get("/evolution/historical-run/{job_id}")
async def historical_run_status(job_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/evolution/historical-run/{job_id}")
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.post("/evolution/historical-run/{job_id}/stop")
async def historical_run_stop(job_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/evolution/historical-run/{job_id}/stop")
    return resp.json()


@router.post("/evolution/historical-run/{job_id}/pause")
async def historical_run_pause(job_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/evolution/historical-run/{job_id}/pause")
    return resp.json()


@router.post("/evolution/historical-run/{job_id}/resume")
async def historical_run_resume(job_id: str):
    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/evolution/historical-run/{job_id}/resume")
    return resp.json()


@router.get("/evolution/historical-run-checkpoints")
async def historical_run_list_checkpoints():
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/evolution/historical-run-checkpoints")
    return resp.json()


@router.get("/evolution/historical-runs")
async def historical_runs_list():
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/evolution/historical-runs")
    return resp.json()


@router.get("/evolution/election-db/census-counties")
async def election_db_census_counties(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/election-db/census-counties", params=dict(request.query_params))
    return resp.json()


@router.post("/evolution/election-db/build-config")
async def election_db_build_config(payload: dict):
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/election-db/build-config", json=payload)
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.post("/evolution/election-db/apply-leaning-profile")
async def election_db_apply_leaning(payload: dict):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/election-db/apply-leaning-profile", json=payload)
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.post("/serper-news-raw")
async def serper_news_raw(payload: dict = Body(...)):
    """Raw Serper news search — no LLM filtering. Used by evolution cycle mode.

    Body: {query, start_date, end_date, max_results?}
    Returns: {results: [{title, snippet, date, source, link}]}
    """
    from ..tavily_research import _search_serper_news

    query = payload.get("query", "")
    start_date = payload.get("start_date", "")
    end_date = payload.get("end_date", "")
    num = payload.get("max_results", 10)

    if not query or not start_date or not end_date:
        return JSONResponse(status_code=400, content={"error": "query, start_date, end_date required"})

    try:
        results = await _search_serper_news(query, start_date, end_date, num=num, skip_date_filter=True)
        return {"results": results}
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/serper-social-raw")
async def serper_social_raw(payload: dict = Body(...)):
    """Raw Serper social/forum search (PTT, Dcard, Mobile01). Used by evolution cycle mode.

    Body: {query, start_date, end_date, max_results?}
    Returns: {results: [{title, snippet, date, link}]}
    """
    from ..tavily_research import _search_serper_social

    query = payload.get("query", "")
    start_date = payload.get("start_date", "")
    end_date = payload.get("end_date", "")
    num = payload.get("max_results", 10)

    if not query or not start_date or not end_date:
        return JSONResponse(status_code=400, content={"error": "query, start_date, end_date required"})

    try:
        results = await _search_serper_social(query, start_date, end_date, num=num)
        return {"results": results}
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/candidate-visibility")
async def candidate_visibility(payload: dict = Body(...)):
    """Auto-calculate candidate local/national visibility from news search volume.

    Uses multi-tier search (tight + broad queries) to differentiate candidates
    even when both have high search volume.

    Body: {name: str, county: str}
    Returns: {local_visibility: int, national_visibility: int, local_count: int, national_count: int, detail: dict}
    """
    from ..tavily_research import _search_serper_news
    import math

    name = payload.get("name", "").strip()
    county = payload.get("county", "").strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "name required"})

    try:
        import httpx as _hx
        import urllib.parse
        from datetime import datetime, timedelta

        # ── Wikipedia pageviews (primary signal, most reliable) ──
        async def _wiki_pageviews(article_name: str, days: int = 90) -> int:
            """Get Wikipedia zh pageviews via Wikimedia REST API."""
            encoded = urllib.parse.quote(article_name)
            end = datetime.now()
            start = end - timedelta(days=days)
            url = (
                f"https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
                f"zh.wikipedia/all-access/all-agents/{encoded}/daily/"
                f"{start.strftime('%Y%m%d')}/{end.strftime('%Y%m%d')}"
            )
            async with _hx.AsyncClient(timeout=15.0) as client:
                try:
                    resp = await client.get(url, headers={"User-Agent": "Civatas/1.0"})
                    if resp.status_code != 200:
                        return 0
                    items = resp.json().get("items", [])
                    return sum(i.get("views", 0) for i in items)
                except Exception:
                    return 0

        # ── Serper web search count (secondary signal) ──
        serper_key = ""
        try:
            with open("/app/shared/settings.json") as _sf:
                serper_key = json.load(_sf).get("serper_api_key", "")
        except Exception:
            pass
        if not serper_key:
            serper_key = os.environ.get("SERPER_API_KEY", "")

        async def _web_search_count(query: str) -> int:
            if not serper_key:
                return 0
            async with _hx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    "https://google.serper.dev/search",
                    json={"q": query, "gl": "tw", "hl": "zh-TW", "num": 10},
                    headers={"X-API-KEY": serper_key, "Content-Type": "application/json"},
                )
                return len(resp.json().get("organic", []))

        # ── Gather data ──
        wiki_90d = await _wiki_pageviews(name, days=90)
        wiki_30d = await _wiki_pageviews(name, days=30)
        google_name = await _web_search_count(f'"{name}"')
        google_local = await _web_search_count(f'"{name}" "{county}"') if county else 0

        # ── Wikipedia content keyword analysis for local/national profile ──
        async def _wiki_keyword_ratio(article_name: str, county_name: str) -> tuple[int, int]:
            """Analyze Wikipedia content for local vs national keyword density.
            Returns (local_kw_count, national_kw_count)."""
            encoded = urllib.parse.quote(article_name)
            url = (
                f"https://zh.wikipedia.org/w/api.php?action=query&titles={encoded}"
                f"&prop=extracts&exintro=false&explaintext=true&format=json"
            )
            async with _hx.AsyncClient(timeout=15.0) as client:
                try:
                    resp = await client.get(url, headers={"User-Agent": "Civatas/1.0"})
                    pages = resp.json().get("query", {}).get("pages", {})
                    text = ""
                    for pid, p in pages.items():
                        text = p.get("extract", "")
                except Exception:
                    text = ""

            # Also include user-supplied description if available
            desc = payload.get("description", "")
            text = text + " " + desc

            county_short = county_name.replace("縣", "").replace("市", "") if county_name else ""
            local_kw = ["議員", "議會", "副縣長", "鄉長", "鎮長", "區長", "里長",
                        "服務處", "地方", "基層", "選區"]
            if county_short:
                local_kw.append(county_short)
            national_kw = ["立法委員", "立委", "國會", "院長", "副院長", "部長",
                          "黨主席", "全國", "中央", "總統", "行政院", "監察院"]

            local_c = sum(text.count(kw) for kw in local_kw)
            national_c = sum(text.count(kw) for kw in national_kw)
            return local_c, national_c

        wiki_local_kw, wiki_national_kw = await _wiki_keyword_ratio(name, county)

        # ── Scoring: Wikipedia pageviews as primary ──
        def wiki_score(views_90d: int, views_30d: int) -> int:
            if views_90d <= 0:
                return 10
            recency_ratio = views_30d / max(views_90d, 1)
            trend_bonus = 5 if recency_ratio > 0.45 else 0
            # sqrt scale: 1K→21, 10K→35, 40K→55, 65K→65, 100K→78, 200K→90
            s = 15 + math.sqrt(views_90d) / 5
            return min(90, max(10, int(s + trend_bonus)))

        base_vis = wiki_score(wiki_90d, wiki_30d)

        # ── Local vs National differentiation from keyword analysis ──
        total_kw = wiki_local_kw + wiki_national_kw
        if total_kw > 0:
            local_ratio = wiki_local_kw / total_kw  # 0.0 (pure national) ~ 1.0 (pure local)
        else:
            local_ratio = 0.5  # unknown → assume balanced

        # local_ratio adjusts visibility: local-heavy → higher local, lower national
        # Adjustment range: ±15 from base
        local_vis = max(10, min(90, int(base_vis + (local_ratio - 0.5) * 30)))
        national_vis = max(10, min(90, int(base_vis + (0.5 - local_ratio) * 30)))

        return {
            "local_visibility": local_vis,
            "national_visibility": national_vis,
            "local_count": google_local,
            "national_count": google_name,
            "detail": {
                "wiki_90d": wiki_90d,
                "wiki_30d": wiki_30d,
                "wiki_local_kw": wiki_local_kw,
                "wiki_national_kw": wiki_national_kw,
                "local_ratio": round(local_ratio, 2),
                "base_vis": base_vis,
                "google_name": google_name,
                "google_local": google_local,
            },
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/evolution/election-db/health")
async def election_db_health():
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/election-db/health")
    return resp.json()


@router.get("/evolution/election-db/elections")
async def election_db_list(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/election-db/elections", params=dict(request.query_params))
    return resp.json()


@router.get("/evolution/election-db/elections-by-county")
async def election_db_by_county(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/election-db/elections-by-county", params=dict(request.query_params))
    return resp.json()


@router.get("/evolution/election-db/ground-truth")
async def election_db_ground_truth(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/election-db/ground-truth", params=dict(request.query_params))
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


@router.get("/evolution/election-db/historical-trend")
async def election_db_trend(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/election-db/historical-trend", params=dict(request.query_params))
    return resp.json()


@router.get("/evolution/election-db/spectrum")
async def election_db_spectrum(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/election-db/spectrum", params=dict(request.query_params))
    return resp.json()


@router.get("/evolution/election-db/identity-trends")
async def election_db_identity_trends(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/election-db/identity-trends", params=dict(request.query_params))
    return resp.json()


@router.get("/evolution/election-db/stance-trends")
async def election_db_stance_trends(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/election-db/stance-trends", params=dict(request.query_params))
    return resp.json()


# ── Fast Parameter Calibration proxy ───────────────────────────────

@router.post("/evolution/calibration/fast")
async def fast_calibrate(payload: dict):
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/calibration/fast", json=payload)
    if resp.status_code != 200:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    return resp.json()


# ── Smart Keywords (Serper + LLM) ─────────────────────────────────────

@router.post("/generate-macro-context")
async def generate_macro_context(payload: dict = Body(...)):
    """Generate macro political/economic context by searching recent news and using LLM.

    Body: {county, start_date, end_date, candidates: [...], prediction_mode: "election"|"satisfaction"}
    """
    from ..tavily_research import _search_serper_news
    from shared.global_settings import get_system_llm_credentials
    from openai import AsyncOpenAI
    import asyncio

    county = payload.get("county", "")
    start_date = payload.get("start_date", "")
    end_date = payload.get("end_date", "")
    candidates = payload.get("candidates", [])
    prediction_mode = payload.get("prediction_mode", "election")

    try:
        # ── Search for US political context news ──
        # The queries are structured around how US voters process political
        # information: federalism (3 layers), two-party dynamics, economic
        # kitchen-table issues, and culture-war flashpoints.
        region = county or "United States"
        queries = [
            # Federal governance — the layer that drives national_satisfaction
            '"United States" president executive order policy agenda',
            '"United States" Congress Senate House legislation filibuster',
            # Economy — the #1 driver of voter anxiety in US elections
            '"United States" inflation grocery prices rent mortgage interest rates',
            '"United States" jobs report unemployment wages economy',
            # State-level — drives local_satisfaction
            f'"{region}" governor state budget legislature',
            f'"{region}" election primary poll swing state',
            # Culture-war issues — unique to US, high emotional valence
            '"United States" abortion immigration gun control Supreme Court',
            # Foreign policy — secondary but matters for national mood
            '"United States" foreign policy China tariffs Ukraine Israel',
        ]
        # Add candidate-specific queries
        for c in candidates[:5]:
            name = c.split("(")[0].strip() if "(" in c else c.strip()
            if name:
                queries.append(f'"{name}" campaign rally policy approval')

        tasks = [_search_serper_news(q, start_date or "2024-01-01", end_date or "2026-04-05", num=5) for q in queries]
        all_results = await asyncio.gather(*tasks, return_exceptions=True)

        titles = []
        for res in all_results:
            if isinstance(res, Exception):
                continue
            for r in res:
                t = r.get("title", "").strip()
                if t and t not in titles:
                    titles.append(t)
        titles = titles[:50]

        # ── Use LLM to synthesize context ──
        creds = get_system_llm_credentials()
        if not creds.get("api_key"):
            return JSONResponse(status_code=400, content={"error": "System LLM not configured"})

        client = AsyncOpenAI(api_key=creds["api_key"], base_url=creds.get("base_url") or None)

        cand_text = "\n".join(f"- {c}" for c in candidates) if candidates else "(not specified)"
        mode_text = "satisfaction survey" if prediction_mode == "satisfaction" else "election prediction"

        prompt = f"""You are a senior US political analyst writing a briefing for an AI-driven social simulation of American voters. The simulation needs to understand the macro environment so that simulated agents (virtual voters) react realistically to news.

## Simulation parameters
- State / region: {region}
- Time window: {start_date or "recent"} to {end_date or "present"}
- Simulation type: {mode_text}
- Key figures being tracked:
{cand_text}

## Recent US news headlines (for reference)
{chr(10).join(f"- {t}" for t in titles) if titles else "(no search results)"}

## Your task
Write a 6-10 line factual briefing covering these dimensions of the US political landscape. Each line should be one concise statement. The briefing tells the AI system "this is the world the voters live in."

1. **White House & executive branch**: Who is the sitting President? What is the administration's signature agenda? Approval rating trend?
2. **Congress**: Which party controls the House and Senate? Is government unified or divided? What major legislation is pending or recently passed?
3. **Economy (kitchen-table issues)**: What are voters feeling about inflation, grocery prices, gas, rent/mortgage, interest rates, jobs? Is the economy seen as improving or worsening?
4. **State-level dynamics** (for {region}): Who is the Governor? Party control of the state legislature? Any major state-level controversies?
5. **Election context**: What is the relevant upcoming or recent election? Who are the main candidates? What do polls show? What are the swing-state dynamics?
6. **Culture-war & social issues**: Where does the national mood stand on abortion, immigration, gun control, LGBTQ rights, or other hot-button issues that mobilize voters?
7. **Foreign policy & security**: Any overseas conflicts (Ukraine, Middle East, China/Taiwan, tariffs) that affect voter anxiety or the national mood?
8. **Blame dynamics**: When things go wrong, whom do voters in this region tend to blame — the President, Congress, the Governor, a specific party, or "the system"?

## Format rules
- Plain text, one topic per line. No markdown, no bullet points, no headers.
- Be specific: name real people, real parties, real numbers where possible.
- Be factual and neutral — this is a briefing, not an opinion piece.

Example output (for illustration only):
Federal: Republican President Donald Trump took office January 2025; unified Republican government with slim majorities in both chambers; policy agenda focused on tariffs, immigration enforcement, and deregulation.
Economy: Inflation cooling to ~3% but grocery and housing costs remain elevated; mortgage rates near 7%; unemployment low at 3.9% but wage growth stagnating; consumer sentiment mixed.
State (Pennsylvania): Democratic Governor Josh Shapiro; legislature split (R Senate, D House); key battleground state in 2024 with razor-thin margins.
..."""

        resp = await client.chat.completions.create(
            model=creds.get("model", "gpt-4o-mini"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            max_tokens=800,
        )
        text = resp.choices[0].message.content.strip()
        # Clean up any markdown
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3].strip()

        return {"macro_context": text}

    except Exception as e:
        log.exception("generate-macro-context failed")
        return JSONResponse(status_code=500, content={"error": f"Generation failed: {str(e)}"})


@router.post("/suggest-keywords")
async def suggest_keywords(payload: dict = Body(...)):
    """Use Serper to find recent news, then LLM to generate optimal search keywords.

    Body: {county: "臺中市", start_date: "2024-01-14", end_date: "2024-06-30"}
    Returns: {local_keywords: "...", national_keywords: "..."}
    """
    from ..tavily_research import _search_serper_news
    from shared.global_settings import get_system_llm_credentials
    from openai import AsyncOpenAI

    county = payload.get("county", "")
    start_date = payload.get("start_date", "")
    end_date = payload.get("end_date", "")
    candidates = payload.get("candidates", [])  # [{name, party}]

    if not county or not start_date or not end_date:
        return JSONResponse(status_code=400, content={"error": "county, start_date, end_date 為必填"})

    try:
        import asyncio

        # Step 1: Search news via Serper — multiple queries in parallel for broader coverage
        local_queries = [
            f'"{county}" governor mayor government',
            f'"{county}" state legislature council',
            f'"{county}" infrastructure roads transit',
            f'"{county}" jobs unemployment economy',
            f'"{county}" schools education',
            f'"{county}" crime police safety',
            f'"{county}" healthcare hospital',
            f'"{county}" election candidate poll',
        ]
        national_queries = [
            '"United States" president White House Cabinet',
            '"United States" Congress Senate House bill',
            '"United States" economy inflation Federal Reserve',
            '"United States" jobs report wages labor',
            '"United States" election Democrats Republicans poll',
            '"United States" foreign policy China Ukraine',
            '"United States" immigration border',
            '"United States" healthcare Medicare student loans',
        ]

        # Add candidate-specific queries
        for c in candidates:
            cname = c.get("name", "")
            cparty = c.get("party", "")
            if cname:
                local_queries.append(f"{cname} {county}")
                if cparty:
                    local_queries.append(f"{cname} {cparty}")
                national_queries.append(f'{cname} policy election')

        local_tasks = [_search_serper_news(q, start_date, end_date, num=10) for q in local_queries]
        national_tasks = [_search_serper_news(q, start_date, end_date, num=10) for q in national_queries]

        all_results = await asyncio.gather(*local_tasks, *national_tasks, return_exceptions=True)

        # Deduplicate by title
        seen = set()
        local_titles, national_titles = [], []
        for i, res in enumerate(all_results):
            if isinstance(res, Exception):
                continue
            target = local_titles if i < len(local_queries) else national_titles
            for r in res:
                t = r.get("title", "").strip()
                if t and t not in seen:
                    seen.add(t)
                    target.append(t)

        local_titles = local_titles[:30]
        national_titles = national_titles[:30]

        # Step 2: LLM to extract keywords
        creds = get_system_llm_credentials()
        if not creds.get("api_key"):
            return JSONResponse(status_code=400, content={"error": "尚未設定系統 LLM，請在控制台設定"})

        client = AsyncOpenAI(
            api_key=creds["api_key"],
            base_url=creds.get("base_url") or None,
        )

        # Build candidate context for prompt
        cand_context = ""
        if candidates:
            cand_lines = [f"- {c.get('name','')} ({c.get('party','')})" for c in candidates if c.get("name")]
            cand_context = f"""
## Tracked candidates / political figures:
{chr(10).join(cand_lines)}
Generate at least 1-2 dedicated search lines for each tracked person (name + issue/platform/controversy/activity).
"""

        prompt = f"""You are a US news analyst. Based on the news headlines below from {start_date} to {end_date}, generate Google News search keyword sets for "{county}" (state/region level).

## Local news for {county} ({len(local_titles)} headlines):
{chr(10).join(f"- {t}" for t in local_titles) if local_titles else "(no results)"}

## National / international news ({len(national_titles)} headlines):
{chr(10).join(f"- {t}" for t in national_titles) if national_titles else "(no results)"}
{cand_context}
## Requirements:
Produce keyword sets for Google News search, one set per line.

### Local keywords (local):
- Must focus on state/region-level issues for "{county}", not single-city stories.
- Each line is one search query and SHOULD contain "{county}" (or a recognizable abbreviation).
- Cover dimensions: governance (Governor / Mayor / state legislature), infrastructure (roads / transit), elections, public safety, jobs and economy, schools, healthcare, environment / climate, major construction.
- **MUST include dedicated search lines for every tracked person** (e.g. `"Josh Shapiro" Pennsylvania budget`, `"John Fetterman" Senate vote`).
- Generate 10-15 lines. Examples: `"Pennsylvania" SEPTA funding bill`, `"Pennsylvania" fracking permit drilling`.

### National keywords (national):
- Major US national and international stories during this period.
- Cover dimensions: federal politics (President / Cabinet / Congress), economy (Federal Reserve / inflation / jobs report), foreign policy (China / Ukraine / Israel / immigration / border), social issues (abortion / guns / education), major events.
- **If a tracked person is a national figure, include dedicated search lines for them.**
- Generate 10-15 lines. Examples: `"United States" Federal Reserve interest rate`, `"United States" Senate impeachment vote`.

### Format rules:
- Do NOT repeat similar keywords.
- Do NOT focus on a single event — diversify across dimensions.
- Avoid generic terms ("news", "report", "latest", "event").
- Return JSON:
{{"local": "line1\\nline2\\n...", "national": "line1\\nline2\\n..."}}
Return ONLY the JSON, no other text."""

        resp = await client.chat.completions.create(
            model=creds.get("model", "gpt-4o-mini"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            max_tokens=800,
        )

        text = resp.choices[0].message.content.strip()
        log.info(f"suggest-keywords LLM raw response: {text[:500]}")

        # Parse JSON from response — handle various LLM quirks
        # Strip markdown code blocks
        if "```" in text:
            parts = text.split("```")
            for part in parts[1:]:
                candidate = part.strip()
                if candidate.startswith("json"):
                    candidate = candidate[4:].strip()
                if candidate.startswith("{"):
                    text = candidate
                    break

        # Find the JSON object in the text
        import re
        json_match = re.search(r'\{[\s\S]*\}', text)
        if json_match:
            text = json_match.group(0)

        # Some LLMs use actual newlines in JSON string values — escape them
        # Replace unescaped newlines inside string values
        text = re.sub(r'(?<=": ")(.*?)(?=")', lambda m: m.group(0).replace('\n', '\\n'), text, flags=re.DOTALL)

        try:
            result = json.loads(text)
        except json.JSONDecodeError:
            # Last resort: try to extract local/national from raw text
            log.warning(f"JSON parse failed, attempting fallback extraction from: {text[:300]}")
            local_match = re.search(r'"local"\s*:\s*"(.*?)"', text, re.DOTALL)
            national_match = re.search(r'"national"\s*:\s*"(.*?)"', text, re.DOTALL)
            if local_match or national_match:
                result = {
                    "local": (local_match.group(1) if local_match else "").replace("\\n", "\n"),
                    "national": (national_match.group(1) if national_match else "").replace("\\n", "\n"),
                }
            else:
                # Ultimate fallback: split raw text in half
                lines = [l.strip() for l in text.split("\n") if l.strip() and not l.strip().startswith(("{", "}", '"', "```"))]
                mid = len(lines) // 2
                result = {
                    "local": "\n".join(lines[:mid]) if lines else f"{county} 市政 建設",
                    "national": "\n".join(lines[mid:]) if lines else "台灣 政治 經濟",
                }

        return {
            "local_keywords": result.get("local", f"{county} 市政 建設").replace("\\n", "\n"),
            "national_keywords": result.get("national", "台灣 政治 經濟").replace("\\n", "\n"),
        }
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        log.exception("suggest-keywords failed")
        return JSONResponse(status_code=500, content={"error": f"關鍵字生成失敗: {str(e)}"})


# ─── Recording management (proxy to evolution service) ──────────────

@router.post("/recordings")
async def recording_create(payload: dict):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{EVOLUTION_URL}/recordings", json=payload)
    return resp.json()


@router.get("/recordings")
async def recording_list(public_only: bool = False):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/recordings", params={"public_only": public_only})
    return resp.json()


@router.get("/recordings/{rec_id}")
async def recording_get(rec_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/recordings/{rec_id}")
    return resp.json()


@router.put("/recordings/{rec_id}")
async def recording_update(rec_id: str, payload: dict):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.put(f"{EVOLUTION_URL}/recordings/{rec_id}", json=payload)
    return resp.json()


@router.delete("/recordings/{rec_id}")
async def recording_delete(rec_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.delete(f"{EVOLUTION_URL}/recordings/{rec_id}")
    return resp.json()


@router.get("/recordings/{rec_id}/steps")
async def recording_steps(rec_id: str):
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/recordings/{rec_id}/steps")
    return resp.json()


@router.get("/recordings/{rec_id}/steps/{step_num}")
async def recording_step(rec_id: str, step_num: int):
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{EVOLUTION_URL}/recordings/{rec_id}/steps/{step_num}")
    return resp.json()
