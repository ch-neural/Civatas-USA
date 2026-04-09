"""Dynamic news search, scoring, and keyword adjustment for cycle-based evolution.

Each cycle:
  1. Search news for the date window via API gateway (Serper)
  2. Score news by impact (LLM)
  3. Assign scored news to individual days
  4. After evolution, analyze results and adjust keywords for next cycle
"""
from __future__ import annotations

import logging
import os
import json
import hashlib
import re
import time
from datetime import datetime, timedelta

import httpx

logger = logging.getLogger(__name__)

API_GATEWAY = os.getenv("API_GATEWAY_URL", "http://api:8000")
INTERNAL_TOKEN = os.getenv("INTERNAL_TOKEN", "civatas-internal-2026")
INTERNAL_HEADERS = {"X-Internal-Token": INTERNAL_TOKEN}


def _get_llm_credentials() -> dict:
    """Get system LLM credentials."""
    try:
        from shared.global_settings import get_system_llm_credentials
        return get_system_llm_credentials()
    except Exception:
        return {
            "api_key": os.getenv("LLM_API_KEY", ""),
            "base_url": os.getenv("LLM_BASE_URL", "") or None,
            "model": os.getenv("LLM_MODEL", "gpt-4o-mini"),
        }


async def _llm_call(prompt: str, max_tokens: int = 600) -> str:
    """Call LLM via OpenAI-compatible API."""
    from openai import AsyncOpenAI

    creds = _get_llm_credentials()
    if not creds.get("api_key"):
        raise ValueError("系統 LLM 未設定")

    client = AsyncOpenAI(
        api_key=creds["api_key"],
        base_url=creds.get("base_url") or None,
    )
    resp = await client.chat.completions.create(
        model=creds.get("model", "gpt-4o-mini"),
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=max_tokens,
    )
    return resp.choices[0].message.content.strip()


# US-only — delegate to us_news_keywords (Stage 1.9 cleanup removed TW dual path).
try:
    from .us_news_keywords import (  # type: ignore
        build_default_keywords as US_BUILD_KEYWORDS,
        SERPER_LOCALE as US_SERPER_LOCALE,
    )
except ImportError:
    from us_news_keywords import (  # type: ignore
        build_default_keywords as US_BUILD_KEYWORDS,
        SERPER_LOCALE as US_SERPER_LOCALE,
    )


def build_default_keywords(county: str) -> tuple[list[str], list[str]]:
    return US_BUILD_KEYWORDS(county)


async def search_news_for_window(
    local_keywords: list[str],
    national_keywords: list[str],
    start_date: str,
    end_date: str,
    seen_ids: set[str] | None = None,
    target_pool_size: int = 50,
) -> list[dict]:
    """Search news via API gateway's Tavily/Serper endpoint for a date window.

    Args:
        target_pool_size: Target number of articles per cycle. For 100 agents
            seeing 3 articles/day over 5 days, aim for ≥50 unique articles.

    Returns deduplicated list of news articles with article_id.
    """
    seen = seen_ids or set()
    all_news: list[dict] = []

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Search each keyword line — cap per_query at 20 (API limit),
        # scale up by having more keyword queries instead.
        total_queries = len(local_keywords) + len(national_keywords)
        for kw_list, channel in [(local_keywords, "地方"), (national_keywords, "國內")]:
            per_query = min(20, max(8, target_pool_size // max(total_queries, 1)))
            for query in kw_list:
                if not query.strip():
                    continue
                try:
                    resp = await client.post(
                        f"{API_GATEWAY}/api/pipeline/serper-news-raw",
                        json={
                            "query": query.strip(),
                            "start_date": start_date,
                            "end_date": end_date,
                            "max_results": per_query,
                        },
                        headers=INTERNAL_HEADERS,
                        timeout=30.0,
                    )
                    if resp.status_code == 200:
                        results = resp.json().get("results", [])
                        for r in results:
                            title = r.get("title", "").strip()
                            if not title:
                                continue
                            # Normalize title for dedup: collapse whitespace
                            _norm_title = re.sub(r'\s+', '', title)
                            aid = hashlib.md5(
                                (_norm_title + r.get("_parsed_date", r.get("date", ""))).encode()
                            ).hexdigest()[:12]
                            if aid not in seen:
                                seen.add(aid)
                                all_news.append({
                                    "article_id": aid,
                                    "title": title,
                                    "summary": r.get("snippet", "")[:200],
                                    "source_tag": r.get("source", "新聞"),
                                    "channel": channel,
                                    "date": r.get("_parsed_date", r.get("date", start_date)),
                                    "category": "",
                                    "leaning": "center",
                                    "impact_score": 5,
                                    "crawled_at": time.time(),
                                })
                    else:
                        logger.warning(f"Serper raw search failed ({resp.status_code}): {resp.text[:100]}")
                except Exception as e:
                    logger.warning(f"News search failed for '{query[:30]}': {e}")

    # ── Also search custom sources (from diet_rules) ──
    try:
        from .feed_engine import get_diet_rules
        custom_sources = get_diet_rules().get("custom_sources", [])
        for src in custom_sources:
            src_url = src.get("url", "").strip()
            src_name = src.get("name", "")
            src_channel = src.get("channel", "國內")
            src_leaning = src.get("leaning", "center")
            src_keywords = src.get("keywords", "").strip()
            if not src_name:
                continue
            # Search using source name as keyword (works best for both news sites and forums).
            # Google News indexes by source name, so "風傳媒 台中" or "Mobile01 政治" works well.
            query = src_name
            if src_keywords:
                query += f" {src_keywords}"
            try:
                resp = await client.post(
                    f"{API_GATEWAY}/api/pipeline/serper-news-raw",
                    json={
                        "query": query,
                        "start_date": start_date,
                        "end_date": end_date,
                        "max_results": 10,
                    },
                    headers=INTERNAL_HEADERS,
                    timeout=30.0,
                )
                if resp.status_code == 200:
                    results = resp.json().get("results", [])
                    for r in results:
                        title = r.get("title", "").strip()
                        if not title:
                            continue
                        _norm_title = re.sub(r'\s+', '', title)
                        aid = hashlib.md5(
                            (_norm_title + r.get("_parsed_date", r.get("date", ""))).encode()
                        ).hexdigest()[:12]
                        if aid not in seen:
                            seen.add(aid)
                            all_news.append({
                                "article_id": aid,
                                "title": title,
                                "summary": r.get("snippet", "")[:200],
                                "source_tag": src_name or r.get("source", domain),
                                "channel": src_channel,
                                "date": r.get("_parsed_date", r.get("date", start_date)),
                                "category": "",
                                "leaning": src_leaning,
                                "impact_score": 5,
                                "crawled_at": time.time(),
                            })
                    logger.info(f"Custom source '{src_name}' ({domain}): {len(results)} results")
            except Exception as e:
                logger.warning(f"Custom source '{src_name}' search failed: {e}")
    except Exception as e:
        logger.warning(f"Custom source loading failed: {e}")

    # ── Search social/forum platforms (PTT, Dcard, Mobile01) ──
    social_articles = await _search_social_platforms(
        local_keywords, national_keywords, start_date, end_date,
        seen, target_pool_size=max(10, target_pool_size // 4),
    )
    all_news.extend(social_articles)

    logger.info(f"Searched {start_date}~{end_date}: {len(all_news)} articles ({len(social_articles)} social, deduped)")
    return all_news


# ── Source tag mapping for social platform URLs ──
_SOCIAL_SOURCE_MAP = [
    ("ptt.cc", "PTT八卦版", "偏左派"),
    ("dcard.tw", "Dcard時事", "中立"),
    ("mobile01.com", "Mobile01", "中立"),
    ("lihkg.com", "LIHKG", "中立"),
]


def _classify_social_source(link: str, title: str) -> tuple[str, str]:
    """Map a social platform URL to (source_tag, leaning)."""
    link_lower = (link or "").lower()
    title_lower = (title or "").lower()
    for domain, tag, leaning in _SOCIAL_SOURCE_MAP:
        if domain in link_lower:
            # Refine PTT: detect board from URL or title
            if domain == "ptt.cc":
                if "hatepolitics" in link_lower or "政黑" in title_lower:
                    return "PTT政黑版", "偏左派"
                if "tech_job" in link_lower or "科技" in title_lower:
                    return "PTT科技版", "中立"
                if "gossiping" in link_lower or "八卦" in title_lower:
                    return "PTT八卦版", "偏左派"
                return tag, leaning
            return tag, leaning
    return "社群論壇", "中立"


async def _search_social_platforms(
    local_keywords: list[str],
    national_keywords: list[str],
    start_date: str,
    end_date: str,
    seen: set[str],
    target_pool_size: int = 15,
) -> list[dict]:
    """Search PTT, Dcard, Mobile01 via Serper site-scoped Google search.

    Uses the same keyword lists as news search but targets social platforms.
    Returns articles in the same format as news, with appropriate source_tags.
    """
    results: list[dict] = []

    # Build social queries: combine top keywords from both local & national
    # Use fewer queries to avoid API overuse (social is supplementary)
    social_queries: list[tuple[str, str]] = []
    for kw in local_keywords[:3]:
        if kw.strip():
            social_queries.append((kw.strip(), "地方"))
    for kw in national_keywords[:2]:
        if kw.strip():
            social_queries.append((kw.strip(), "國內"))

    if not social_queries:
        return results

    per_query = min(10, max(5, target_pool_size // max(len(social_queries), 1)))

    async with httpx.AsyncClient(timeout=60.0) as client:
        for query, channel in social_queries:
            try:
                resp = await client.post(
                    f"{API_GATEWAY}/api/pipeline/serper-social-raw",
                    json={
                        "query": query,
                        "start_date": start_date,
                        "end_date": end_date,
                        "max_results": per_query,
                    },
                    headers=INTERNAL_HEADERS,
                    timeout=30.0,
                )
                if resp.status_code == 200:
                    for r in resp.json().get("results", []):
                        title = r.get("title", "").strip()
                        if not title:
                            continue
                        _norm_title = re.sub(r'\s+', '', title)
                        aid = hashlib.md5(
                            (_norm_title + r.get("_parsed_date", r.get("date", ""))).encode()
                        ).hexdigest()[:12]
                        if aid in seen:
                            continue
                        seen.add(aid)

                        link = r.get("link", "")
                        source_tag, leaning = _classify_social_source(link, title)

                        results.append({
                            "article_id": aid,
                            "title": title,
                            "summary": r.get("snippet", "")[:200],
                            "source_tag": source_tag,
                            "channel": channel,
                            "date": r.get("_parsed_date", r.get("date", start_date)),
                            "category": "social",
                            "leaning": leaning,
                            "impact_score": 5,
                            "crawled_at": time.time(),
                        })
                else:
                    logger.warning(f"Social search failed ({resp.status_code}) for '{query[:30]}'")
            except Exception as e:
                logger.warning(f"Social search error for '{query[:30]}': {e}")

    logger.info(f"Social search {start_date}~{end_date}: {len(results)} forum posts")
    return results


async def score_news_impact(
    news: list[dict],
    county: str,
    candidate_names: list[str] | None = None,
    candidate_profiles: dict[str, str] | None = None,
) -> list[dict]:
    """Use LLM to score each news article's social impact (1-10).

    Returns the same list with updated impact_score field.
    """
    if not news:
        return news

    # Batch articles into chunks of 30 for LLM
    scored = []
    for i in range(0, len(news), 30):
        batch = news[i:i + 30]
        article_list = "\n".join(
            f"{j+1}. [{a.get('channel', '')}] {a['title']}"
            for j, a in enumerate(batch)
        )

        if candidate_names:
            # Build candidate profile section
            cand_profile_lines = []
            for cn in candidate_names:
                desc = (candidate_profiles or {}).get(cn, "") if candidate_profiles else ""
                if desc:
                    cand_profile_lines.append(f"- **{cn}**：{desc}")
                else:
                    cand_profile_lines.append(f"- **{cn}**")
            cand_profile_str = "\n".join(cand_profile_lines)

            prompt = f"""你是台灣社會輿論分析專家。評估以下新聞對「{county}」市民的社會影響力，並分析對各候選人的**差異化**情感影響。

## 新聞列表：
{article_list}

## 候選人背景（用於判斷新聞對誰影響更大）：
{cand_profile_str}

## 評分標準（1-10 分）：
- 10：重大國家/地方事件（選舉結果、重大災害、政策巨變、重大建設啟用）
- 7-9：高度關注（重要政策、大型建設完工/進展、社會爭議、重大施政成果）
- 4-6：一般關注（具體政策、經濟數據、地方具體事件、招商成果、就業數據改善）
- 1-3：低關注（瑣事、娛樂、與市民生活無關）

## 重要：正面新聞同樣有影響力！
- 重大建設完工/啟用、招商成功、就業率上升、交通改善等**正面施政成果**，對市民滿意度有實質影響，應依重要程度給 4-9 分
- 不要因為新聞是「正面的」就降低分數——市民同樣會關注好消息

## 必須給低分（1-2 分）的類型：
- 其他縣市的純地方新聞（如模擬「{county}」卻出現台中/高雄/台北的在地店家、地方活動）→ 給 1 分
- 純公關/形象宣傳/作秀（無實質施政內容的剪綵、握手）
- 年度回顧/年度盤點/十大話題（非具體事件，無法引發即時反應）
- 純學術論壇/研討會摘要（非政策行動）
- 一週大事整理/新聞懶人包（重複內容，非原始新聞）

## 重要：地理相關性
- 只有「{county}」當地的地方新聞才可能得 4 分以上
- 其他縣市的地方新聞（在地店家、地方建設、地方人物）一律 1-2 分
- 全國性新聞（兩岸、經濟政策、國會、總統施政）不受地理限制，正面與負面都應得到合理分數

## 全國性施政新聞的評分指引
- 總統/行政院的施政成果（如經濟數據改善、外交突破、國際評比上升）→ 4-8 分
- 中央政策利多（減稅、補助、福利提升）→ 5-7 分
- 國防/兩岸穩定的正面消息 → 4-6 分
- 不要因為新聞是「全國性」就降低分數——全國新聞同樣影響市民對中央的滿意度

## 候選人影響（candidates 欄位 — 最重要！）：
- 數值範圍：-1.0（極度負面）到 +1.0（極度正面）
- 0.0 代表此新聞與該候選人完全無關或影響中性。若新聞確實與候選人無關可填 0.0，但若有明確正面或負面影響則必須給出非零值

### 關鍵原則：同黨候選人必須差異化！
即使兩位候選人同屬一個政黨，同一則新聞對他們的影響程度也不同：
- **地方型候選人**（副縣長、議員、地方深耕）→ 地方施政/建設新聞影響更大
- **全國型候選人**（立委、黨主席、國會）→ 中央政策/兩岸/國防新聞影響更大
- **被點名的候選人** → 直接影響遠大於同黨其他人
- **現任/執政者** → 施政好壞直接歸因，非現任者受影響較小
- 範例：「縣府施政被批」→ 副縣長 -0.5，立委 -0.1（同黨但差距大）
- 範例：「國防預算爭議」→ 立委 -0.4，副縣長 -0.1

### 正面影響（+0.1 ~ +1.0）：
- 候選人被直接肯定 → +0.5~+0.8
- 所屬政黨形象提升 → +0.2~+0.4
- 選區建設利多 → +0.3（地方型更多）、+0.1（全國型較少）
### 負面影響（-0.1 ~ -1.0）：
- 被直接爆料弊案 → -0.6~-0.9
- 所屬政黨醜聞 → -0.2~-0.4
- 施政被批評 → 現任 -0.4、非現任同黨 -0.1

### 間接影響：
- 大多數政治新聞都至少間接影響一位候選人
- 根據候選人背景判斷影響程度的差異
- 只有完全無關的新聞（娛樂、科技等）才填空物件 {{}}

回傳 JSON 陣列，每個元素為物件，順序對應上方新聞：
[{{"impact": 分數, "candidates": {{"候選人名": 情感值}}}}, ...]
只回傳 JSON 陣列，不要其他文字。"""
        else:
            prompt = f"""你是台灣社會輿論分析專家。評估以下新聞對「{county}」市民的社會影響力。

## 新聞列表：
{article_list}

## 評分標準（1-10 分）：
- 10：重大國家/地方事件（選舉結果、重大災害、政策巨變、重大建設啟用）
- 7-9：高度關注（重要政策、大型建設完工/進展、社會爭議、重大施政成果）
- 4-6：一般關注（具體政策、經濟數據、地方具體事件、招商成果、就業數據改善）
- 1-3：低關注（瑣事、娛樂、與市民生活無關）

## 重要：正面新聞同樣有影響力！
- 重大建設完工/啟用、招商成功、就業率上升、交通改善等**正面施政成果**，對市民滿意度有實質影響，應依重要程度給 4-9 分
- 不要因為新聞是「正面的」就降低分數——市民同樣會關注好消息

## 必須給低分（1-2 分）的類型：
- 其他縣市的純地方新聞（如模擬「{county}」卻出現台中/高雄/台北的在地店家、地方活動）→ 給 1 分
- 純公關/形象宣傳/作秀（無實質施政內容的剪綵、握手）
- 年度回顧/年度盤點/十大話題（非具體事件，無法引發即時反應）
- 純學術論壇/研討會摘要（非政策行動）
- 一週大事整理/新聞懶人包（重複內容，非原始新聞）

## 重要：地理相關性
- 只有「{county}」當地的地方新聞才可能得 4 分以上
- 其他縣市的地方新聞（在地店家、地方建設、地方人物）一律 1-2 分
- 全國性新聞（兩岸、經濟政策、國會、總統施政）不受地理限制，正面與負面都應得到合理分數

## 全國性施政新聞的評分指引
- 總統/行政院的施政成果（如經濟數據改善、外交突破、國際評比上升）→ 4-8 分
- 中央政策利多（減稅、補助、福利提升）→ 5-7 分
- 國防/兩岸穩定的正面消息 → 4-6 分
- 不要因為新聞是「全國性」就降低分數——全國新聞同樣影響市民對中央的滿意度

回傳 JSON 陣列，每個元素是分數（整數 1-10），順序對應上方新聞：
[分數1, 分數2, ...]
只回傳 JSON 陣列，不要其他文字。"""

        try:
            max_tokens = 2000 if candidate_names else 200
            text = await _llm_call(prompt, max_tokens=max_tokens)
            # Parse scores — use greedy match for outermost [ ... ]
            # Non-greedy *? would stop at first ] inside nested dicts
            json_match = re.search(r'\[[\s\S]*\]', text)
            if json_match:
                try:
                    parsed = json.loads(json_match.group(0))
                except json.JSONDecodeError:
                    # Fallback: try non-greedy for simpler format [5, 7, ...]
                    json_match2 = re.search(r'\[[\s\S]*?\]', text)
                    parsed = json.loads(json_match2.group(0)) if json_match2 else None
            else:
                parsed = None

            if candidate_names:
                if parsed is None:
                    logger.warning(f"[news-sentiment] parsed=None, regex failed. text_len={len(text)}, last50: ...{text[-50:]}")
                elif len(parsed) == 0:
                    logger.warning(f"[news-sentiment] parsed=empty list")
                elif isinstance(parsed[0], dict):
                    _with_cands = sum(1 for p in parsed if isinstance(p, dict) and p.get("candidates"))
                    _sample_cands = [p.get("candidates", {}) for p in parsed if isinstance(p, dict) and p.get("candidates")][:3]
                    logger.info(f"[news-sentiment] {len(parsed)} articles, {_with_cands} have candidate sentiment. Samples: {_sample_cands}")
                else:
                    logger.warning(f"[news-sentiment] LLM returned old format: type={type(parsed[0]).__name__}, sample={parsed[0]}")

            for j, a in enumerate(batch):
                if parsed is not None and j < len(parsed):
                    entry = parsed[j]
                    if isinstance(entry, dict) and "impact" in entry:
                        a["impact_score"] = entry["impact"]
                        a["candidate_sentiment"] = entry.get("candidates", {})
                    elif isinstance(entry, int):
                        a["impact_score"] = entry
                        a["candidate_sentiment"] = {}
                    else:
                        a["impact_score"] = 5
                        a["candidate_sentiment"] = {}
                else:
                    a["impact_score"] = 5
                    a["candidate_sentiment"] = {}
                scored.append(a)

        except Exception as e:
            logger.warning(f"News scoring failed: {e}")
            for a in batch:
                a["impact_score"] = 5
                a["candidate_sentiment"] = {}
                scored.append(a)

    # Filter: keep impact >= 3
    kept = [a for a in scored if a.get("impact_score", 0) >= 3]

    # Hard geo-filter: remove articles clearly about other cities
    if county:
        _other_cities = ["臺北市", "台北市", "新北市", "桃園市", "臺中市", "台中市", "臺南市", "台南市",
                         "高雄市", "基隆市", "新竹市", "嘉義市", "新竹縣", "苗栗縣", "彰化縣", "南投縣",
                         "雲林縣", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "台東縣",
                         "澎湖縣", "金門縣", "連江縣"]
        # Normalize county for matching (e.g. 台中→臺中)
        _cn = county.replace("台", "臺")
        _other = [c for c in _other_cities if c != county and c != _cn and c.replace("臺", "台") != county]
        # Also build short names: 台中人, 高雄人, etc.
        _other_short = []
        for c in _other:
            short = c.replace("市", "").replace("縣", "")
            _other_short.append(f"{short}人")
            _other_short.append(short)

        before_geo = len(kept)
        geo_kept = []
        for a in kept:
            title = a.get("title", "") + " " + a.get("summary", "")
            # Check if title mentions another specific city as locality
            is_other_local = False
            for oc in _other + _other_short:
                if oc in title:
                    # But skip if our county is also mentioned (cross-county news is ok)
                    cn_short = county.replace("市", "").replace("縣", "")
                    if county not in title and cn_short not in title:
                        is_other_local = True
                        break
            if is_other_local:
                logger.debug(f"Geo-filtered: {a.get('title', '')[:50]}")
            else:
                geo_kept.append(a)
        kept = geo_kept
        geo_dropped = before_geo - len(kept)
        if geo_dropped > 0:
            logger.info(f"Geo-filtered {geo_dropped} articles about other cities (county={county})")

    dropped = len(scored) - len(kept)
    if dropped > 0:
        logger.info(f"Scored {len(scored)} articles, dropped {dropped} (impact<3 + geo), kept {len(kept)}")

    return kept


def compute_cycle_news_window(
    sim_start_date: str,
    sim_end_date: str,
    sim_days: int,
    cycle_sim_start: int,
    cycle_sim_days: int,
    buffer_sim_days: float = 0.5,
) -> tuple[str, str, float]:
    """Map a sim-day cycle to its proportional real-news date window.

    The platform supports **time compression**: a long real-news range
    (e.g. 1 year) is compressed into a short simulation (e.g. 30 sim days).
    Each sim day represents ``compression_ratio = news_total_days / sim_days``
    real days. This helper converts a cycle's sim-day range
    ``[cycle_sim_start, cycle_sim_start + cycle_sim_days)`` into the
    corresponding real-date window for news search.

    Args:
        sim_start_date: news range start (YYYY-MM-DD), also = sim day 0 anchor
        sim_end_date: news range end (YYYY-MM-DD); pass "" or invalid to fall
            back to 1:1 mapping (each sim day = 1 real calendar day)
        sim_days: total simulation days (the entire run)
        cycle_sim_start: 0-based sim day index where this cycle begins
        cycle_sim_days: number of sim days in this cycle
        buffer_sim_days: extra buffer at both ends, in sim-day units. Will be
            scaled by compression_ratio when applied to real days.

    Returns:
        (news_window_start_iso, news_window_end_iso, compression_ratio)

    Examples:
        # Time compression (1 year → 30 sim days, ratio ≈ 12.17)
        compute_cycle_news_window("2025-01-01", "2025-12-31", 30, 0, 5)
        # → ("2024-12-26", "2025-02-26", 12.17)  (cycle 1, ±0.5 sim-day buffer)

        # 1:1 fallback (no end_date)
        compute_cycle_news_window("2025-01-01", "", 30, 0, 5)
        # → ("2024-12-31", "2025-01-07", 1.0)
    """
    try:
        base = datetime.strptime(sim_start_date, "%Y-%m-%d")
    except (ValueError, TypeError):
        base = datetime.now()

    sim_days_safe = max(1, int(sim_days))

    # Resolve end date and compute compression ratio
    try:
        end = datetime.strptime(sim_end_date, "%Y-%m-%d")
        news_total = (end - base).days
        if news_total < sim_days_safe:
            # End is before start or shorter than sim_days → degrade to 1:1
            news_total = sim_days_safe
    except (ValueError, TypeError):
        # No valid end_date → 1:1 mapping (each sim day = 1 real day)
        news_total = sim_days_safe

    ratio = news_total / sim_days_safe

    # Compute real-day offsets for this cycle
    cycle_real_start = cycle_sim_start * ratio
    cycle_real_end = (cycle_sim_start + cycle_sim_days) * ratio

    # Apply buffer in sim-day units → real days
    buffer_real = buffer_sim_days * ratio
    cycle_real_start = max(0.0, cycle_real_start - buffer_real)
    cycle_real_end = min(float(news_total), cycle_real_end + buffer_real)

    news_start_dt = base + timedelta(days=cycle_real_start)
    news_end_dt = base + timedelta(days=cycle_real_end)

    return (
        news_start_dt.strftime("%Y-%m-%d"),
        news_end_dt.strftime("%Y-%m-%d"),
        round(ratio, 3),
    )


def assign_news_to_days(
    news: list[dict],
    cycle_sim_days: int,
    cycle_news_start: str,
    cycle_news_end: str,
) -> dict[int, list[dict]]:
    """Assign news articles to sim-day buckets within a cycle.

    Each article's real publication date is mapped proportionally onto the
    cycle's sim-day range, using the cycle's news window as the time scale.
    This is the **time-compressed** counterpart to the old date-based
    assignment — under compression, an article published 30 real days into
    a cycle whose news window spans 60 real days will land on sim day
    ``cycle_sim_days * 0.5`` (the middle of the cycle).

    Empty sim days steal one article from a non-empty neighbour to ensure
    every sim day has at least some news (avoiding "silent days").

    Args:
        news: scored articles for this cycle
        cycle_sim_days: number of sim days in the cycle
        cycle_news_start: this cycle's real-news window start (YYYY-MM-DD)
        cycle_news_end: this cycle's real-news window end (YYYY-MM-DD)

    Returns: {sim_day_offset: [articles]} where sim_day_offset is 0-based
    within the cycle.
    """
    cycle_sim_days = max(1, int(cycle_sim_days))
    day_map: dict[int, list[dict]] = {d: [] for d in range(cycle_sim_days)}

    if not news:
        return day_map

    try:
        ns = datetime.strptime(cycle_news_start, "%Y-%m-%d")
        ne = datetime.strptime(cycle_news_end, "%Y-%m-%d")
    except (ValueError, TypeError):
        # No valid window → all articles default to sim day 0
        for article in news:
            day_map[0].append(article)
        return day_map

    news_span = max(1, (ne - ns).days)

    # Proportional mapping: real-day offset → sim-day offset
    for article in news:
        article_date = article.get("_parsed_date") or article.get("date", "")
        try:
            ad = datetime.strptime(article_date[:10], "%Y-%m-%d")
            real_offset = (ad - ns).days
            real_offset = max(0, min(news_span, real_offset))
            fraction = real_offset / news_span
            sim_offset = int(fraction * cycle_sim_days)
            sim_offset = max(0, min(cycle_sim_days - 1, sim_offset))
        except (ValueError, TypeError):
            # Unparseable date → first sim day of cycle
            sim_offset = 0
        day_map[sim_offset].append(article)

    # Fill empty sim days by stealing from the nearest non-empty neighbour
    # (preserves rough temporal locality, no global redistribution)
    for d in range(cycle_sim_days):
        if day_map[d]:
            continue
        for offset in range(1, cycle_sim_days):
            stolen = False
            for nd in (d - offset, d + offset):
                if 0 <= nd < cycle_sim_days and len(day_map[nd]) > 1:
                    # Steal the lowest-impact article from neighbour
                    nd_sorted = sorted(day_map[nd], key=lambda a: a.get("impact_score", 0))
                    day_map[d].append(nd_sorted[0])
                    day_map[nd].remove(nd_sorted[0])
                    stolen = True
                    break
            if stolen:
                break

    return day_map


async def search_district_news(
    districts: list[str],
    county: str,
    start_date: str,
    end_date: str,
    seen_ids: set[str] | None = None,
    max_per_district: int = 5,
    district_agent_counts: dict[str, int] | None = None,
) -> dict[str, list[dict]]:
    """Search local news for each district via Serper.

    Returns {district_name: [articles]} for use as local life context.
    Limits API calls by batching districts into combined queries.
    """
    seen = seen_ids or set()
    result: dict[str, list[dict]] = {}

    # If more than 8 districts, keep only the top 8 by agent count
    active_districts = list(districts)
    if len(active_districts) > 8:
        if district_agent_counts:
            active_districts = sorted(
                active_districts,
                key=lambda d: district_agent_counts.get(d, 0),
                reverse=True,
            )[:8]
            logger.info(
                f"Too many districts ({len(districts)}), limiting to top 8 by population: "
                f"{active_districts}"
            )
        else:
            active_districts = active_districts[:8]
            logger.info(
                f"Too many districts ({len(districts)}), limiting to first 8 (no agent counts provided)"
            )

    async with httpx.AsyncClient(timeout=60.0) as client:
        for district in active_districts:
            articles: list[dict] = []
            queries = [
                f"{county}{district} 地方 新聞 事件",
                f"{county}{district} 建設 交通 生活",
            ]

            for query in queries:
                try:
                    resp = await client.post(
                        f"{API_GATEWAY}/api/pipeline/serper-news-raw",
                        json={
                            "query": query,
                            "start_date": start_date,
                            "end_date": end_date,
                            "max_results": max_per_district,
                        },
                        headers=INTERNAL_HEADERS,
                        timeout=30.0,
                    )
                    if resp.status_code == 200:
                        results = resp.json().get("results", [])
                        for r in results:
                            title = r.get("title", "").strip()
                            if not title:
                                continue
                            # Normalize title for dedup: collapse whitespace
                            _norm_title = re.sub(r'\s+', '', title)
                            aid = hashlib.md5(
                                (_norm_title + r.get("_parsed_date", r.get("date", ""))).encode()
                            ).hexdigest()[:12]
                            if aid in seen:
                                continue
                            seen.add(aid)
                            articles.append({
                                "article_id": aid,
                                "title": title,
                                "summary": r.get("snippet", "")[:200],
                                "source_tag": r.get("source", "新聞"),
                                "channel": "地方生活",
                                "district": district,
                                "date": r.get("_parsed_date", r.get("date", start_date)),
                                "category": "",
                                "leaning": "center",
                                "impact_score": 5,
                            })
                    else:
                        logger.warning(
                            f"District news search failed for {district} ({resp.status_code}): "
                            f"{resp.text[:100]}"
                        )
                except Exception as e:
                    logger.warning(f"District news search failed for '{district}': {e}")

            # Limit per district
            if len(articles) > max_per_district:
                articles = articles[:max_per_district]

            result[district] = articles
            logger.debug(f"District '{district}': found {len(articles)} local articles")

    total = sum(len(v) for v in result.values())
    logger.info(
        f"District news search {start_date}~{end_date}: "
        f"{len(active_districts)} districts, {total} total articles (deduped)"
    )
    return result


async def adjust_keywords(
    current_local_kw: list[str],
    current_national_kw: list[str],
    county: str,
    cycle_summary: dict,
    cycle_news_titles: list[str],
    already_covered_local: list[str] | None = None,
    already_covered_national: list[str] | None = None,
) -> tuple[list[str], list[str]]:
    """After a cycle completes, use LLM to generate supplementary keywords.

    Args:
        current_local_kw: previous LLM-suggested local keyword lines (for context)
        current_national_kw: previous LLM-suggested national keyword lines (for context)
        county: target county
        cycle_summary: {avg_satisfaction, avg_anxiety, leaning_shifts, notable_reactions}
        cycle_news_titles: titles of news that triggered strong reactions
        already_covered_local: keywords already searched by user-fixed + system-default
            layers — LLM should NOT duplicate these. The supplementary set should
            target gaps and emerging issues, not re-cover broad topics.
        already_covered_national: same, for national channel.

    Returns: (new_local_kw, new_national_kw)
    """
    _covered_local_text = (
        chr(10).join(f"- {k}" for k in (already_covered_local or [])[:30])
        if already_covered_local else "（無，請涵蓋廣泛議題）"
    )
    _covered_national_text = (
        chr(10).join(f"- {k}" for k in (already_covered_national or [])[:30])
        if already_covered_national else "（無，請涵蓋廣泛議題）"
    )

    prompt = f"""你是台灣新聞搜尋策略專家。根據上一輪社會模擬的結果，生成「補充搜尋關鍵字」。

## 目標縣市：{county}

## 系統與使用者已固定搜尋的關鍵字（每個週期都會搜，**請避免重複**）：
### 地方已涵蓋：
{_covered_local_text}

### 全國已涵蓋：
{_covered_national_text}

## 上一輪 LLM 補充關鍵字（可大幅調整）：
地方：{chr(10).join(current_local_kw) if current_local_kw else "（首次，無歷史）"}
全國：{chr(10).join(current_national_kw) if current_national_kw else "（首次，無歷史）"}

## 上一輪模擬結果：
- 平均滿意度：地方 {cycle_summary.get('avg_local_sat', 50):.0f} / 全國 {cycle_summary.get('avg_national_sat', 50):.0f}
- 平均焦慮度：{cycle_summary.get('avg_anxiety', 50):.0f}
- 引發強烈反應的新聞：
{chr(10).join(f"  - {t}" for t in cycle_news_titles[:10]) if cycle_news_titles else "  （無明顯反應）"}

## 生成規則：
1. **絕對不要重複**「已涵蓋」清單中的關鍵字 — 系統已經在搜了，補充組要針對「已涵蓋之外」的縫隙
2. 補充性的搜尋關鍵字，聚焦於：
   - 引發強烈反應的具體事件 → 搜尋後續發展、當事人姓名、政策代號
   - 正在延燒的時事人物（政治人物姓名 + 議題）
   - 突發新聞與爭議事件（具體事件名稱）
   - 候選人/政治人物的最新動態（姓名 + 政見/活動/爭議）
3. **正反面平衡**：包含正面（建設成果、政績亮點）和負面（爭議、抗議、問題）議題
4. 每行一組搜尋詞，地方 5-8 行，全國 5-8 行
5. 地方關鍵字每行都要包含 {county} 或其簡稱
6. **要具體**：事件名、人名、政策名、特定地點 — 不要產生「{county} 政治」這類已被涵蓋的泛化詞

回傳 JSON：
{{"local": "第一行\\n第二行\\n...", "national": "第一行\\n第二行\\n..."}}
只回傳 JSON。"""

    try:
        text = await _llm_call(prompt, max_tokens=800)

        json_match = re.search(r'\{[\s\S]*\}', text)
        if json_match:
            text = json_match.group(0)
        # Fix unescaped newlines in JSON string values
        text = re.sub(
            r'(?<=": ")(.*?)(?=")',
            lambda m: m.group(0).replace('\n', '\\n'),
            text, flags=re.DOTALL,
        )

        result = json.loads(text)
        new_local = [l.strip() for l in result.get("local", "").replace("\\n", "\n").split("\n") if l.strip()]
        new_national = [l.strip() for l in result.get("national", "").replace("\\n", "\n").split("\n") if l.strip()]

        if new_local and new_national:
            return new_local, new_national

    except Exception as e:
        logger.warning(f"Keyword adjustment failed: {e}")

    # Fallback: return originals unchanged
    return current_local_kw, current_national_kw
