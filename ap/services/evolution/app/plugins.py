"""Domain plugins: define extra fields, prompt addons, and metrics per prediction domain.

Plugins are stored as JSON files in the plugins directory.
Default plugins (election, fertility) are created automatically on first access.
"""
from __future__ import annotations

import json
import logging
import os

logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("EVOLUTION_DATA_DIR", "/data/evolution")
PLUGINS_DIR = os.path.join(DATA_DIR, "plugins")

# ── Default plugins ──────────────────────────────────────────────────

DEFAULT_PLUGINS = {
    "election": {
        "plugin_id": "election",
        "name": "選舉預測",
        "icon": "🗳️",
        "description": "模擬選舉情境，預測各黨得票率與投票率變化",
        "extra_fields": {
            "party_preference": {
                "label": "政黨傾向",
                "type": "enum",
                "options": ["執政黨", "最大在野黨", "第三勢力", "未決定"],
            },
            "vote_intention": {
                "label": "投票意願",
                "type": "int",
                "range": [0, 100],
                "default": 60,
            },
            "political_engagement": {
                "label": "政治參與度",
                "type": "enum",
                "options": ["高", "中", "低"],
            },
        },
        "prompt_addon": (
            "你也是一位選民。你的政黨傾向是{party_preference}，"
            "投票意願 {vote_intention}/100，政治參與度為{political_engagement}。"
            "面對政治新聞時，你會根據自己的政黨傾向做出判斷。"
        ),
        "prediction_metrics": [
            {"key": "vote_distribution", "label": "各黨得票率分布"},
            {"key": "turnout_rate", "label": "投票率"},
            {"key": "swing_voters_pct", "label": "搖擺選民比例"},
        ],
        "ground_truth_fields": [
            {"key": "party_a_vote", "label": "A黨得票率", "unit": "%"},
            {"key": "party_b_vote", "label": "B黨得票率", "unit": "%"},
            {"key": "party_c_vote", "label": "C黨得票率", "unit": "%"},
            {"key": "turnout", "label": "投票率", "unit": "%"},
        ],
    },
    "fertility": {
        "plugin_id": "fertility",
        "name": "生育政策影響",
        "icon": "👶",
        "description": "模擬育兒補助等政策對生育意願的影響",
        "extra_fields": {
            "children_count": {
                "label": "子女數",
                "type": "int",
                "range": [0, 5],
                "default": 0,
            },
            "fertility_intention": {
                "label": "生育意願",
                "type": "enum",
                "options": ["想生", "觀望", "不想生"],
            },
            "childcare_burden": {
                "label": "育兒負擔感受",
                "type": "int",
                "range": [0, 100],
                "default": 50,
            },
        },
        "prompt_addon": (
            "你目前有 {children_count} 個小孩，生育意願為「{fertility_intention}」，"
            "主觀育兒負擔感受 {childcare_burden}/100。"
            "面對育兒相關政策新聞時，你會從自身家庭狀況出發做出判斷。"
        ),
        "prediction_metrics": [
            {"key": "fertility_intention_shift", "label": "生育意願變化"},
            {"key": "avg_childcare_burden", "label": "平均育兒負擔"},
            {"key": "willing_to_birth_pct", "label": "願意生育比例"},
        ],
        "ground_truth_fields": [
            {"key": "fertility_rate", "label": "生育率", "unit": ""},
            {"key": "birth_count", "label": "出生人數", "unit": "人"},
            {"key": "policy_satisfaction", "label": "政策滿意度", "unit": "%"},
        ],
    },
    "consumer": {
        "plugin_id": "consumer",
        "name": "消費行為",
        "icon": "💰",
        "description": "模擬經濟政策或市場變化對消費者行為的影響",
        "extra_fields": {
            "monthly_income": {
                "label": "月收入級距",
                "type": "enum",
                "options": ["3萬以下", "3-5萬", "5-8萬", "8-12萬", "12萬以上"],
            },
            "spending_tendency": {
                "label": "消費傾向",
                "type": "enum",
                "options": ["節儉", "量入為出", "享樂消費"],
            },
            "economic_confidence": {
                "label": "經濟信心",
                "type": "int",
                "range": [0, 100],
                "default": 50,
            },
        },
        "prompt_addon": (
            "你的月收入為{monthly_income}，消費傾向偏向「{spending_tendency}」，"
            "你對未來經濟的信心為 {economic_confidence}/100。"
            "面對經濟或物價新聞時，你會根據自身經濟狀況做判斷。"
        ),
        "prediction_metrics": [
            {"key": "spending_change", "label": "消費行為變化"},
            {"key": "saving_rate", "label": "儲蓄率"},
            {"key": "confidence_index", "label": "消費者信心指數"},
        ],
        "ground_truth_fields": [
            {"key": "consumer_confidence", "label": "消費者信心指數", "unit": ""},
            {"key": "retail_growth", "label": "零售業成長率", "unit": "%"},
            {"key": "cpi_change", "label": "CPI 變化率", "unit": "%"},
        ],
    },
}


# ── Plugin management ────────────────────────────────────────────────

def _ensure_dir():
    os.makedirs(PLUGINS_DIR, exist_ok=True)


def _init_defaults():
    """Create default plugin files if they don't exist."""
    _ensure_dir()
    for plugin_id, plugin_data in DEFAULT_PLUGINS.items():
        path = os.path.join(PLUGINS_DIR, f"{plugin_id}.json")
        if not os.path.exists(path):
            with open(path, "w") as f:
                json.dump(plugin_data, f, ensure_ascii=False, indent=2)
            logger.info(f"Created default plugin: {plugin_id}")


def list_plugins() -> list[dict]:
    """List all available domain plugins."""
    _init_defaults()
    results = []
    for fname in sorted(os.listdir(PLUGINS_DIR)):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(PLUGINS_DIR, fname)) as f:
                data = json.load(f)
            # Return summary (without full prompt_addon for listing)
            results.append({
                "plugin_id": data.get("plugin_id", fname[:-5]),
                "name": data.get("name", ""),
                "icon": data.get("icon", ""),
                "description": data.get("description", ""),
                "extra_field_count": len(data.get("extra_fields", {})),
                "metric_count": len(data.get("prediction_metrics", [])),
            })
        except Exception:
            continue
    return results


def get_plugin(plugin_id: str) -> dict | None:
    """Get full plugin configuration."""
    _init_defaults()
    path = os.path.join(PLUGINS_DIR, f"{plugin_id}.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)
