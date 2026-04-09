"""
Statistics Modules — 統計模組管理

CRUD operations for reusable statistical data modules.
Supports built-in (pre-processed) and user-uploaded modules.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import uuid
from typing import Any

log = logging.getLogger(__name__)

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
MODULES_DIR = os.path.join(DATA_DIR, "stat_modules")
SHARED_DIR = "/app/shared"
SHARED_MODULES_DIR = os.path.join(SHARED_DIR, "stat_modules")
BUILTIN_DIR = os.path.join(SHARED_DIR, "builtin_modules")


# ── LLM analysis ─────────────────────────────────────────────────────

async def analyze_module_data(filename: str, data: dict,
                               user_description: str = "") -> str:
    """Use LLM to analyze uploaded module data and generate a description."""
    try:
        from openai import AsyncOpenAI
    except ImportError:
        log.warning("openai not installed, skipping LLM analysis")
        return user_description

    api_key = os.getenv("LLM_API_KEY", "")
    if not api_key:
        return user_description

    client = AsyncOpenAI(
        api_key=api_key,
        base_url=os.getenv("LLM_BASE_URL") or None,
    )
    model = os.getenv("LLM_MODEL", "gpt-4o-mini")

    # Build a concise data summary for the prompt
    districts = list(data.keys())
    sample_keys = districts[:3]
    fields = list(next(iter(data.values()), {}).keys()) if data else []
    samples = {k: data[k] for k in sample_keys}

    prompt = f"""你是一位資料分析專家。使用者上傳了一份統計模組檔案，請分析並產生繁體中文的詳細說明。

檔案名稱：{filename}
使用者說明：{user_description or "（未提供）"}
行政區數量：{len(districts)}
欄位：{', '.join(fields)}
前 {len(sample_keys)} 筆樣本資料：
{json.dumps(samples, ensure_ascii=False, indent=2)}
部分行政區名稱：{', '.join(districts[:8])}{'...' if len(districts) > 8 else ''}

請回覆：
1. 📋 資料概述（1-2 句，說明這份資料是什麼）
2. 📊 包含欄位（列出每個欄位名稱與推測含義）
3. 💡 建議用途（2-3 個在社會模擬/人口合成中的具體應用）
4. ⚠️ 注意事項（如有資料限制或使用上需注意的事）

請直接以繁體中文段落回覆，不要用 JSON 格式。控制在 200 字以內。"""

    try:
        kwargs = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
        }
        if any(m in model.lower() for m in ["o1", "o3", "gpt-5"]):
            kwargs["max_completion_tokens"] = 4096
            kwargs["temperature"] = 1.0
        else:
            kwargs["max_tokens"] = 400
            kwargs["temperature"] = 0.3

        resp = await client.chat.completions.create(**kwargs)
        llm_desc = resp.choices[0].message.content.strip()

        # Combine user description with LLM analysis
        parts = []
        if user_description:
            parts.append(user_description)
        if llm_desc:
            parts.append(f"\n\n--- AI 分析 ---\n{llm_desc}")
        return "\n".join(parts) if parts else ""

    except Exception as e:
        log.warning(f"LLM analysis failed: {e}")
        return user_description

# ── Built-in module definitions ──────────────────────────────────────

BUILTIN_MODULES: list[dict[str, Any]] = [
    {
        "id": "voter_2024",
        "name": "🗳️ 2024 選舉人投票行為",
        "description": (
            "來源：中選會第 16 任總統副總統及第 11 屆立法委員選舉合併檔。"
            "包含全台 276 個鄉鎮市區的投票率、平均年齡、男女比。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "voter_2024.json",
        "fields": ["vote_rate", "avg_age", "male_ratio", "sample_size"],
    },
    {
        "id": "referendum_2021",
        "name": "🗳️ 2021 全國性公民投票（第17-20案）",
        "description": (
            "來源：中選會 110 年全國性公民投票案合併檔。"
            "第17案（核四商轉）、第18案（反萊豬）、"
            "第19案（公投綁大選）、第20案（珍愛藻礁）。"
            "包含 286 個鄉鎮市區的各案領票率、平均年齡、男性比例。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "referendum_2021.json",
        "fields": ["公投領票率", "平均年齡", "男性比例", "sample_size"],
    },
    {
        "id": "referendum_r1_2022",
        "name": "🗳️ 2022 憲法修正案公民複決第1案",
        "description": (
            "來源：中選會 111 年地方公職人員選舉及憲法修正案公民複決合併檔。"
            "18 歲公民權修憲案的公民複決領票率，涵蓋 285 個鄉鎮市區。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "referendum_r1_2022.json",
        "fields": ["領票率", "平均年齡", "男性比例", "sample_size"],
    },
    {
        "id": "election_mayor_2022",
        "name": "🏛️ 2022 縣市長選舉",
        "description": (
            "來源：中選會 111 年地方公職人員選舉合併檔。"
            "2022 九合一選舉縣市長選舉領票率，涵蓋 285 個鄉鎮市區。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "election_mayor_2022.json",
        "fields": ["領票率", "平均年齡", "男性比例", "sample_size"],
    },
    {
        "id": "election_township_head_2022",
        "name": "🏛️ 2022 鄉鎮市長選舉",
        "description": (
            "來源：中選會 111 年地方公職人員選舉合併檔。"
            "2022 九合一選舉鄉鎮市長選舉領票率，涵蓋 285 個鄉鎮市區。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "election_township_head_2022.json",
        "fields": ["領票率", "平均年齡", "男性比例", "sample_size"],
    },
    {
        "id": "election_village_head_2022",
        "name": "🏛️ 2022 村里長選舉",
        "description": (
            "來源：中選會 111 年地方公職人員選舉合併檔。"
            "2022 九合一選舉村里長選舉領票率，涵蓋 285 個鄉鎮市區。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "election_village_head_2022.json",
        "fields": ["領票率", "平均年齡", "男性比例", "sample_size"],
    },
    {
        "id": "election_council_2022",
        "name": "🏛️ 2022 縣市議員選舉（區域）",
        "description": (
            "來源：中選會 111 年地方公職人員選舉合併檔。"
            "2022 九合一選舉縣市議員（區域）選舉領票率，涵蓋 285 個鄉鎮市區。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "election_council_2022.json",
        "fields": ["領票率", "平均年齡", "男性比例", "sample_size"],
    },
    {
        "id": "election_council_indigenous_2022",
        "name": "🏛️ 2022 縣市議員選舉（平地原住民）",
        "description": (
            "來源：中選會 111 年地方公職人員選舉合併檔。"
            "2022 九合一選舉縣市議員（平地原住民）選舉領票率，涵蓋 285 個鄉鎮市區。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "election_council_indigenous_2022.json",
        "fields": ["領票率", "平均年齡", "男性比例", "sample_size"],
    },
    {
        "id": "election_township_rep_2022",
        "name": "🏛️ 2022 鄉鎮市民代表選舉（區域）",
        "description": (
            "來源：中選會 111 年地方公職人員選舉合併檔。"
            "2022 九合一選舉鄉鎮市民代表（區域）選舉領票率，涵蓋 285 個鄉鎮市區。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "election_township_rep_2022.json",
        "fields": ["領票率", "平均年齡", "男性比例", "sample_size"],
    },
    {
        "id": "president_2024",
        "name": "🗳️ 2024 總統大選各區得票率",
        "description": (
            "來源：中選會第 16 任總統副總統選舉各投票所得票明細。"
            "包含全台 368 個鄉鎮市區的三組候選人得票率及投票率。"
            "藍：國民黨侯友宜/趙少康、綠：民進黨賴清德/蕭美琴、"
            "白：民眾黨柯文哲/吳欣盈。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "president_2024.json",
        "fields": ["國民黨_侯友宜_得票率", "民進黨_賴清德_得票率",
                   "民眾黨_柯文哲_得票率", "投票率"],
    },
    {
        "id": "president_2020_taichung",
        "name": "🗳️ 2020年總統大選得票數（台中市）",
        "description": (
            "來源：自行匯入。包含台中市 29 個行政區的三組候選人得票率及投票率。"
            "橘：親民黨宋楚瑜/余湘、藍：國民黨韓國瑜/張善政、"
            "綠：民進黨蔡英文/賴清德。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "president_2020_taichung.json",
        "fields": ["親民黨_宋楚瑜_得票率", "國民黨_韓國瑜_得票率", 
                   "民進黨_蔡英文_得票率", "投票率"],
    },
    {
        "id": "legislator_2024",
        "name": "🏛️ 2024 區域立法委員選舉各區得票率",
        "description": (
            "來源：中選會第 11 屆區域立法委員選舉得票明細。"
            "包含全台 368 個鄉鎮市區的國民黨、民進黨、民眾黨候選人得票率。"
            "注意：民眾黨僅在部分選區提名，未提名選區得票率為 0。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "legislator_2024.json",
        "fields": ["國民黨_得票率", "民進黨_得票率", "民眾黨_得票率", "投票率"],
    },
    {
        "id": "mayor_2022",
        "name": "🏛️ 2022 縣市長選舉各區得票率",
        "description": (
            "來源：中選會 111 年直轄市長及縣市長選舉候選人得票數一覽表。"
            "包含全台 366 個鄉鎮市區的國民黨與民進黨候選人得票率。"
            "直轄市（6都）及一般縣市合併計算。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "mayor_2022.json",
        "fields": ["國民黨_得票率", "民進黨_得票率", "投票率"],
    },
    {
        "id": "township_head_2022",
        "name": "🏛️ 2022 鄉鎮市長選舉各區得票率",
        "description": (
            "來源：中選會 111 年鄉（鎮、市）長選舉候選人得票數一覽表。"
            "包含全台 198 個鄉鎮市的國民黨與民進黨候選人得票率。"
            "注意：許多鄉鎮僅單一政黨提名或無主要政黨候選人。"
        ),
        "type": "voting_behavior",
        "admin_level": "town",
        "data_file": "township_head_2022.json",
        "fields": ["國民黨_得票率", "民進黨_得票率", "投票率"],
    },
]


def _ensure_dirs():
    os.makedirs(MODULES_DIR, exist_ok=True)
    os.makedirs(SHARED_MODULES_DIR, exist_ok=True)


def _state_file() -> str:
    return os.path.join(MODULES_DIR, "_state.json")


def _load_state() -> dict:
    """Load module enable/disable state."""
    path = _state_file()
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def _save_state(state: dict):
    _ensure_dirs()
    with open(_state_file(), "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def _module_path(module_id: str) -> str:
    return os.path.join(MODULES_DIR, f"{module_id}.json")


def _shared_module_path(module_id: str) -> str:
    return os.path.join(SHARED_MODULES_DIR, f"{module_id}.json")


# ── CRUD ─────────────────────────────────────────────────────────────

def list_modules() -> list[dict]:
    """List all modules (built-in + user-uploaded) with enable state."""
    _ensure_dirs()
    state = _load_state()
    modules = []

    # 1) Built-in modules
    for bm in BUILTIN_MODULES:
        mod = {
            "id": bm["id"],
            "name": bm["name"],
            "description": bm["description"],
            "type": bm["type"],
            "admin_level": bm.get("admin_level", ""),
            "fields": bm.get("fields", []),
            "builtin": True,
            "enabled": state.get(bm["id"], {}).get("enabled", False),
        }
        # Count districts
        data = _load_builtin_data(bm["id"])
        if data:
            mod["district_count"] = len(data)
        modules.append(mod)

    # 2) User-uploaded modules
    for fname in os.listdir(MODULES_DIR):
        if fname.startswith("_") or not fname.endswith(".json"):
            continue
        mod_id = fname[:-5]
        if any(bm["id"] == mod_id for bm in BUILTIN_MODULES):
            continue  # skip if same as builtin
        try:
            with open(_module_path(mod_id), encoding="utf-8") as f:
                meta = json.load(f)
            modules.append({
                "id": mod_id,
                "name": meta.get("name", mod_id),
                "description": meta.get("description", ""),
                "type": meta.get("type", "custom"),
                "admin_level": meta.get("admin_level", ""),
                "fields": list(next(iter(meta.get("data", {}).values()), {}).keys()) if meta.get("data") else [],
                "builtin": False,
                "enabled": state.get(mod_id, {}).get("enabled", False),
                "district_count": len(meta.get("data", {})),
            })
        except Exception:
            pass

    return modules


def toggle_module(module_id: str, enabled: bool) -> dict:
    """Enable or disable a module."""
    state = _load_state()
    state[module_id] = {"enabled": enabled}
    _save_state(state)

    # Sync to shared
    _sync_enabled_modules()

    return {"id": module_id, "enabled": enabled}


def get_module(module_id: str) -> dict | None:
    """Get a single module's full data."""
    # Check builtin
    for bm in BUILTIN_MODULES:
        if bm["id"] == module_id:
            data = _load_builtin_data(module_id)
            return {**bm, "builtin": True, "data": data}

    # Check user
    path = _module_path(module_id)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return {**json.load(f), "builtin": False}

    return None


def create_module(name: str, description: str, mod_type: str,
                  data: dict, admin_level: str = "town") -> dict:
    """Create a new user module."""
    _ensure_dirs()
    mod_id = f"user_{uuid.uuid4().hex[:8]}"
    # Extract field names from first data entry
    fields = []
    if data:
        first_val = next(iter(data.values()))
        if isinstance(first_val, dict):
            fields = list(first_val.keys())
    meta = {
        "id": mod_id,
        "name": name,
        "description": description,
        "type": mod_type,
        "admin_level": admin_level,
        "fields": fields,
        "data": data,
    }
    with open(_module_path(mod_id), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return {"id": mod_id, "name": name, "district_count": len(data), "fields": fields}


def update_module(module_id: str, name: str | None = None,
                  description: str | None = None) -> dict | None:
    """Update a user module's metadata."""
    path = _module_path(module_id)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        meta = json.load(f)
    if name is not None:
        meta["name"] = name
    if description is not None:
        meta["description"] = description
    with open(path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return meta


def delete_module(module_id: str) -> bool:
    """Delete a user module. Cannot delete builtins."""
    if any(bm["id"] == module_id for bm in BUILTIN_MODULES):
        return False  # cannot delete builtin
    path = _module_path(module_id)
    if os.path.exists(path):
        os.remove(path)
        # Remove from state
        state = _load_state()
        state.pop(module_id, None)
        _save_state(state)
        _sync_enabled_modules()
        return True
    return False


# ── Data loading ─────────────────────────────────────────────────────

def _load_builtin_data(module_id: str) -> dict | None:
    """Load data for a built-in module from shared/builtin_modules/."""
    bm = next((b for b in BUILTIN_MODULES if b["id"] == module_id), None)
    if not bm:
        return None
    data_file = os.path.join(BUILTIN_DIR, bm["data_file"])
    if not os.path.exists(data_file):
        return None
    with open(data_file, encoding="utf-8") as f:
        return json.load(f)


def _sync_enabled_modules():
    """Sync enabled module data to shared volume for cross-service access."""
    _ensure_dirs()
    state = _load_state()

    # Build merged output: a JSON with all enabled modules' data
    enabled_data: dict[str, dict] = {}

    for mod_id, mod_state in state.items():
        if not mod_state.get("enabled"):
            continue

        # Try builtin
        data = _load_builtin_data(mod_id)
        if data:
            enabled_data[mod_id] = data
            continue

        # Try user module
        path = _module_path(mod_id)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                meta = json.load(f)
            if meta.get("data"):
                enabled_data[mod_id] = meta["data"]

    # Write merged file
    output = {
        "modules": enabled_data,
        "count": len(enabled_data),
    }
    with open(os.path.join(SHARED_MODULES_DIR, "enabled.json"), "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    # Also maintain legacy leaning_profile.json compatibility
    _sync_leaning_profile(enabled_data)


def _sync_leaning_profile(enabled_data: dict):
    """If any political leaning module is enabled, sync to leaning_profile.json."""
    from .leaning_profile import save_profile as _save_lp, delete_profile as _del_lp

    leaning_modules = {}
    for mod_id, data in enabled_data.items():
        # Check if data contains spectrum fields
        sample = next(iter(data.values()), {}) if data else {}
        if any(k in sample for k in ["偏左派", "偏左派", "偏右派"]):
            leaning_modules.update(data)

    if leaning_modules:
        # Convert pipe-separated keys to flat for leaning_profile
        flat = {}
        for key, val in leaning_modules.items():
            flat_key = key.replace("|", "")
            flat[flat_key] = val
        _save_lp(flat)
    else:
        _del_lp()
