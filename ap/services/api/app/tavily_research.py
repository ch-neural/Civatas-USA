"""News Research module using Serper.dev (Google News API).

Uses Serper's Google News API to find news articles within a precise date range,
then filters results with LLM to keep only significant, relevant events.

Advantages over Tavily:
  - Google has excellent US news coverage in English
  - Precise date range filtering via tbs parameter
  - Native English results (gl=us, hl=en)
  - No need for post-search language filtering
"""
from __future__ import annotations

import json
import logging
import re
import os
from datetime import datetime, timedelta

import re

import httpx

import unicodedata

# Serper locale: US English news.
SERPER_GL = "us"
SERPER_HL = "en"

logger = logging.getLogger(__name__)

def _sanitize_prompt(s: str) -> str:
    """Sanitize prompt: strip null bytes, control chars, and unpaired surrogates (Cs)."""
    return ''.join(
        c for c in s
        if c in ('\n', '\t', '\r') or unicodedata.category(c) not in ('Cc', 'Cs')
    )


def _split_topics(query: str) -> list[str]:
    """Split a multi-topic query string into individual search lines.

    Rules:
      - Each line is treated as one independent search query.
      - Within a line, commas (,、，) are treated as AND (space-joined).
      - Within a line, semicolons (;；) are treated as OR.
      - If the user writes AND / OR explicitly, they are preserved as-is.
    """
    lines = query.strip().splitlines()
    topics: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        # If user already uses AND / OR explicitly, keep as-is
        if " AND " in line or " OR " in line:
            topics.append(line)
            continue
        # Replace semicolons → OR, commas → AND (space)
        line = re.sub(r'[;；]+', ' OR ', line)
        parts = re.split(r'[,，、]+', line)
        joined = ' '.join(p.strip() for p in parts if p.strip())
        if joined:
            topics.append(joined)
    return topics if topics else [query.strip()]


def _get_serper_key() -> str:
    """Get the Serper API key from settings (fallback to env)."""
    try:
        from shared.global_settings import load_settings
        api_key = load_settings().get("serper_api_key", "")
    except Exception:
        api_key = ""
    if not api_key:
        api_key = os.getenv("SERPER_API_KEY", "")
    if not api_key:
        raise ValueError("SERPER_API_KEY 未設定。請在控制台「搜尋引擎」中設定。")
    return api_key


async def _search_serper_news(query: str, start_date: str, end_date: str, num: int = 10, skip_date_filter: bool = False) -> list[dict]:
    """Search Google News via Serper API with precise date range.

    Args:
        query: Search query in Chinese
        start_date: YYYY-MM-DD
        end_date: YYYY-MM-DD
        num: Number of results (max 100)
        skip_date_filter: If True, skip post-fetch date filtering (for cycle mode)

    Returns:
        List of raw result dicts from Serper
    """
    api_key = _get_serper_key()
    
    # Use Google's tbs parameter for date range (proven reliable via debug testing)
    try:
        dt_start = datetime.strptime(start_date, "%Y-%m-%d")
        dt_end = datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"日期格式錯誤: {start_date}, {end_date}")
    
    tbs = f"cdr:1,cd_min:{dt_start.strftime('%m/%d/%Y')},cd_max:{dt_end.strftime('%m/%d/%Y')}"
    
    payload = {
        "q": query,
        "gl": SERPER_GL,
        "hl": SERPER_HL,
        "lr": "lang_en",   # Restrict results to English-language articles
        "num": min(num, 100),
        "tbs": tbs,
    }

    headers = {
        "X-API-KEY": api_key,
        "Content-Type": "application/json",
    }
    
    
    async with httpx.AsyncClient(timeout=600.0) as client:
        try:
            resp = await client.post(
                "https://google.serper.dev/news",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 400:
                body = e.response.text[:200]
                logger.warning(f"Serper news 400 for '{query[:30]}': {body}")
                return []  # Skip rather than crash
            raise
    
    raw_results = data.get("news", [])

    def _has_cjk(text: str) -> bool:
        """Return True if the text contains any CJK unified ideograph characters."""
        return any('\u4e00' <= c <= '\u9fff' or '\u3400' <= c <= '\u4dbf' or
                   '\u3040' <= c <= '\u30ff' for c in (text or ""))

    # Pre-filter: parse Serper dates and reject results outside range + CJK
    filtered = []
    cjk_rejected = 0
    for r in raw_results:
        title = r.get("title", "")
        snippet = r.get("snippet", "")
        # Reject CJK-language articles — this is an English-only US simulation
        if _has_cjk(title) or _has_cjk(snippet):
            logger.info(f"  ✗ CJK-filter rejected: '{title[:60]}'")
            cjk_rejected += 1
            continue
        raw_date = r.get("date", "")
        iso_date = _parse_serper_date(raw_date)
        if iso_date:
            r["_parsed_date"] = iso_date
            if not skip_date_filter and (iso_date < start_date or iso_date > end_date):
                logger.info(f"  ✗ Pre-filter rejected: [{iso_date}] '{title[:40]}' (range: {start_date}~{end_date})")
                continue
        filtered.append(r)

    rejected = len(raw_results) - len(filtered)
    if rejected > 0:
        logger.info(f"Serper news '{query[:30]}': {len(raw_results)} raw → {len(filtered)} after filters ({cjk_rejected} CJK, {rejected - cjk_rejected} date)")
    else:
        logger.info(f"Serper news '{query[:30]}': {len(filtered)} results")
    return filtered


def _parse_serper_date(date_str: str) -> str | None:
    """Parse Serper's date string into YYYY-MM-DD format.

    Serper returns dates in many formats:
      - ISO: "2024-03-20", "2024-03-20T..."
      - English absolute: "Mar 20, 2024", "March 20, 2024", "2024/03/20"
      - English relative: "3 days ago", "2 hours ago", "1 month ago"
      - Chinese absolute: "2025年10月15日", "2025年10月", "2025/10/15"
        (Taiwanese news sources almost always use this format!)
      - Chinese relative numeric: "3 天前", "2 小時前", "5個月前"
      - Chinese relative non-numeric: "一個月前", "半年前", "去年"

    Returns ISO date string or None if unparseable.
    """
    if not date_str or not date_str.strip():
        return None

    date_str = date_str.strip()
    now = datetime.now()

    # ── 1. ISO format (most common from APIs) ──
    if re.match(r'^\d{4}-\d{2}-\d{2}', date_str):
        return date_str[:10]

    # ── 2. English absolute formats ──
    for fmt in ["%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y", "%Y/%m/%d", "%Y.%m.%d"]:
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue

    # ── 3. Chinese absolute formats: 2025年10月15日 / 2025年10月 / 2025年10月15 ──
    # Capture year, month, optional day
    cn_abs = re.match(r'(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})?\s*日?', date_str)
    if cn_abs:
        try:
            y = int(cn_abs.group(1))
            m = int(cn_abs.group(2))
            d = int(cn_abs.group(3)) if cn_abs.group(3) else 15  # default mid-month
            return f"{y:04d}-{m:02d}-{d:02d}"
        except (ValueError, TypeError):
            pass

    # ── 4. English relative dates ──
    rel_match = re.match(r'(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago', date_str, re.IGNORECASE)
    if rel_match:
        amount = int(rel_match.group(1))
        unit = rel_match.group(2).lower()
        if unit in ("second", "minute", "hour"):
            return now.strftime("%Y-%m-%d")
        elif unit == "day":
            return (now - timedelta(days=amount)).strftime("%Y-%m-%d")
        elif unit == "week":
            return (now - timedelta(weeks=amount)).strftime("%Y-%m-%d")
        elif unit == "month":
            return (now - timedelta(days=amount * 30)).strftime("%Y-%m-%d")
        elif unit == "year":
            return (now - timedelta(days=amount * 365)).strftime("%Y-%m-%d")

    # ── 5. Chinese relative dates: numeric form ──
    cn_match = re.match(r'(\d+)\s*(秒|分鐘|分|小時|時|天|日|週|周|星期|個月|月|年)前', date_str)
    if cn_match:
        amount = int(cn_match.group(1))
        unit = cn_match.group(2)
        if unit in ("秒", "分鐘", "分", "小時", "時"):
            return now.strftime("%Y-%m-%d")
        elif unit in ("天", "日"):
            return (now - timedelta(days=amount)).strftime("%Y-%m-%d")
        elif unit in ("週", "周", "星期"):
            return (now - timedelta(weeks=amount)).strftime("%Y-%m-%d")
        elif unit in ("個月", "月"):
            return (now - timedelta(days=amount * 30)).strftime("%Y-%m-%d")
        elif unit == "年":
            return (now - timedelta(days=amount * 365)).strftime("%Y-%m-%d")

    # ── 6. Chinese relative dates: non-numeric form ──
    # 一/兩/三/半/幾 + 天/週/個月/年 + 前
    _cn_num = {"一": 1, "兩": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "半": 0.5, "幾": 3}
    cn_word_match = re.match(r'([一兩二三四五六七八九十半幾])\s*(天|日|週|周|星期|個月|月|年)前', date_str)
    if cn_word_match:
        amount = _cn_num.get(cn_word_match.group(1), 1)
        unit = cn_word_match.group(2)
        if unit in ("天", "日"):
            return (now - timedelta(days=int(amount))).strftime("%Y-%m-%d")
        elif unit in ("週", "周", "星期"):
            return (now - timedelta(weeks=int(amount))).strftime("%Y-%m-%d")
        elif unit in ("個月", "月"):
            return (now - timedelta(days=int(amount * 30))).strftime("%Y-%m-%d")
        elif unit == "年":
            return (now - timedelta(days=int(amount * 365))).strftime("%Y-%m-%d")

    # ── 7. Standalone Chinese: 昨天/前天/今天/去年/前年 ──
    _cn_standalone = {
        "今天": 0, "今日": 0,
        "昨天": 1, "昨日": 1,
        "前天": 2, "前日": 2,
        "上週": 7, "上周": 7, "上星期": 7,
        "上個月": 30, "上月": 30,
        "去年": 365, "前年": 730,
    }
    for word, days in _cn_standalone.items():
        if word in date_str:
            return (now - timedelta(days=days)).strftime("%Y-%m-%d")

    # ── 8. Last resort: extract year + month if present ──
    # E.g. "2025年第三季" → 2025-08-15 (mid Q3); "2025年" → 2025-06-15
    year_only = re.search(r'(\d{4})\s*年', date_str)
    if year_only:
        y = int(year_only.group(1))
        # Try to detect quarter
        q_match = re.search(r'第\s*([一二三四1234])\s*季', date_str)
        if q_match:
            q_map = {"一": 1, "1": 1, "二": 2, "2": 2, "三": 3, "3": 3, "四": 4, "4": 4}
            q = q_map.get(q_match.group(1), 1)
            month = (q - 1) * 3 + 2  # mid-quarter
            return f"{y:04d}-{month:02d}-15"
        return f"{y:04d}-06-15"

    # ── 9. Year-only fallback ──
    year_match = re.search(r'20[12]\d', date_str)
    if year_match:
        return f"{year_match.group()}-06-15"

    return None


async def _expand_search_queries(question: str) -> list[str]:
    """Use LLM to expand a question into diverse search queries for comprehensive news coverage."""
    from openai import AsyncOpenAI

    from shared.global_settings import get_system_llm_credentials
    creds = get_system_llm_credentials()
    api_key = creds["api_key"]
    base_url = creds["base_url"]
    model = creds["model"]
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    prompt = f"""你是一位社會科學研究分析師。使用者想研究以下問題：

「{question}」

你的任務是產生 15-18 個多元化的 Google News 搜尋關鍵字。

⚠️ 關鍵原則：搜尋不能只集中在問題本身！必須涵蓋所有「間接影響因素」。

例如：
- 如果問題是「選舉」→ 不能只搜選舉新聞，還要搜經濟、物價、治安、國際情勢、社會事件、醜聞等，因為這些都會影響投票
- 如果問題是「某政策是否被接受」→ 不能只搜政策本身，還要搜民眾反應、類似案例、產業影響、反對意見等

請按以下結構產生搜尋：

A. 直接相關（3-4 組）：問題本身的核心動態
B. 經濟面（2-3 組）：相關的經濟、產業、就業、物價、房價等
C. 社會面（2-3 組）：治安、重大事件、公安、食安、民生等
D. 政策/法規面（2 組）：相關的政策變動、法規調整
E. 國際/外部因素（1-2 組）：國際情勢、外交、貿易等影響
F. 爭議/負面（1-2 組）：醜聞、弊案、反對聲音
G. 文化/教育/其他（1-2 組）：其他可能間接影響的面向

規則：
- 每個字串 3-5 個繁體中文關鍵字
- A 類最多 4 組！其餘至少 10 組要分散在 B-G 類
- 根據問題自動辨識相關的地區/機構名稱加入搜尋

直接回覆 JSON 陣列：
["直接相關搜尋1", "經濟面搜尋1", "社會面搜尋1", ...]"""

    llm_queries = []
    try:
        clean_prompt = _sanitize_prompt(prompt)
        kwargs = {
            "model": model,
            "messages": [{"role": "user", "content": clean_prompt}],
        }
        if any(m in model.lower() for m in ["o1", "o3", "gpt-5"]):
            kwargs["max_completion_tokens"] = 4096
        else:
            kwargs["max_tokens"] = 600
            kwargs["temperature"] = 0.5
        resp = await client.chat.completions.create(**kwargs)
        text = resp.choices[0].message.content.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
        
        queries = json.loads(text)
        if isinstance(queries, list) and len(queries) > 0:
            llm_queries = queries[:18]
            logger.info(f"LLM expanded '{question}' into {len(llm_queries)} queries")
    except Exception as e:
        logger.warning(f"Query expansion failed, using fallback: {e}")
        # Generic fallback: just use the question itself with variations
        llm_queries = [
            question,
            f"{question} 影響 分析",
            f"{question} 民意 反應",
            f"{question} 爭議 討論",
        ]
    
    # Deduplicate
    seen = set()
    unique = []
    for q in llm_queries:
        key = q[:15]
        if key not in seen:
            seen.add(key)
            unique.append(q)
    
    logger.info(f"Total search queries: {len(unique)}")
    return unique


async def research_news(
    query: str,
    start_date: str,
    end_date: str,
    max_results: int = 30,
    locale: str = "zh-TW",
) -> list[dict]:
    """Search for news articles relevant to a query within a precise date range.

    Simplified strategy:
    - Use the user's keyword lines directly (no LLM expansion)
    - 1 Serper request per keyword line, ~30 results each
    - LLM filtering at the end to rank/summarize
    
    Multi-topic support: If the query contains multiple topics separated by
    newlines, each topic gets one search request.
    """
    import asyncio
    
    # Validate dates
    try:
        dt_start = datetime.strptime(start_date, "%Y-%m-%d")
        dt_end = datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"日期格式錯誤。請使用 YYYY-MM-DD 格式。start={start_date}, end={end_date}")

    total_days = (dt_end - dt_start).days
    if total_days <= 0:
        raise ValueError("結束日期必須晚於開始日期")

    # Step 1: Use keyword lines directly — no LLM expansion
    search_queries = _split_topics(query)
    logger.info(f"Search queries ({len(search_queries)} keywords): {search_queries}")

    # Calculate how many results per keyword to reach max_results
    per_query_num = max(10, min(30, (max_results * 2) // max(1, len(search_queries))))

    # Step 2: One request per keyword, rate-limited
    _news_sem = asyncio.Semaphore(5)

    async def _do_search(sq: str) -> list[dict]:
        """Single search with rate limiting and retry."""
        async with _news_sem:
            await asyncio.sleep(0.3)
            for attempt in range(3):
                try:
                    results = await _search_serper_news(sq, start_date, end_date, num=per_query_num)
                    return [{
                        "title": r.get("title", ""),
                        "url": r.get("link", ""),
                        "content": r.get("snippet", ""),
                        "published_date": r.get("_parsed_date", r.get("date", "")),
                        "source": r.get("source", ""),
                    } for r in results]
                except Exception as e:
                    err_str = str(e)
                    if ("disconnect" in err_str.lower() or "429" in err_str) and attempt < 2:
                        wait = 2.0 * (attempt + 1)
                        logger.warning(f"Search retry {attempt+1} for '{sq[:20]}': {e}, wait {wait}s")
                        await asyncio.sleep(wait)
                        continue
                    logger.warning(f"Search failed '{sq}': {e}")
                    return []
            return []

    tasks = [_do_search(sq) for sq in search_queries]
    logger.info(f"Launching {len(tasks)} searches ({per_query_num} results each)")
    
    results_list = await asyncio.gather(*tasks)
    
    # Flatten results
    all_results = []
    for batch in results_list:
        all_results.extend(batch)

    if not all_results:
        return []

    logger.info(f"Total raw results: {len(all_results)}")

    # Step 3: Deduplicate by title similarity
    seen_titles = set()
    unique_results = []
    for r in all_results:
        title_key = r["title"][:20]
        if title_key not in seen_titles:
            seen_titles.add(title_key)
            unique_results.append(r)

    logger.info(f"Unique results after dedup: {len(unique_results)}")

    # Step 4: LLM filter and summarize into clean events
    events = await _llm_filter_events(query, unique_results, max_results, start_date, end_date)
    
    # Post-filter: strictly enforce user's date range
    filtered = []
    for ev in events:
        ev_date = ev.get("date", "").replace("/", "-")
        if ev_date and (ev_date < start_date or ev_date > end_date):
            logger.warning(f"Final filter removed: {ev_date} (user range {start_date}~{end_date}) - {ev.get('title', '')}")
            continue
        filtered.append(ev)
    
    # Sort by date
    filtered.sort(key=lambda e: e.get("date", "").replace("/", "-"))
    
    logger.info(f"Final events: {len(filtered)}")
    return filtered


async def _llm_filter_events(
    query: str,
    raw_results: list[dict],
    max_results: int,
    start_date: str = "",
    end_date: str = "",
) -> list[dict]:
    """Use LLM to filter, summarize, and rank results."""
    from openai import AsyncOpenAI

    from shared.global_settings import get_system_llm_credentials
    creds = get_system_llm_credentials()
    api_key = creds["api_key"]
    base_url = creds["base_url"]
    model = creds["model"]
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    articles_text = ""
    for i, r in enumerate(raw_results[:60], 1):
        source = r.get('source', '')
        source_note = f" [來源: {source}]" if source else ""
        articles_text += f"\n{i}. 標題: {r['title']}{source_note}\n   日期: {r.get('published_date', '未知')}\n   摘要: {r['content'][:300]}\n"

    date_range_note = f"\n此批次的日期區間：{start_date} 至 {end_date}。" if start_date and end_date else ""

    prompt = f"""你是一位新聞編輯，負責整理與研究問題相關的重要新聞事件。

用戶搜尋的關鍵字組合：
「{query}」

⚡ 第一步：請從上面的關鍵字組合中，推斷出用戶研究的「核心地區」和「核心主題」。
例如：如果關鍵字有「台中市 AND 競爭力」「台中市 AND 心聲」「盧秀燕」等，
→ 核心地區 = 台中市，核心主題 = 台中市政/市長選舉

⚡ 第二步：根據推斷出的核心地區與主題，用以下標準過濾新聞：

【保留 ✅】
- 直接提及核心地區/核心主題的人物、政策、事件
- 全國性政策（經濟、兩岸、國防、民生物價）→ 會影響全國選民情緒，保留
- 核心主題相關的政黨/陣營的全國性事件（如：黨中央決策、黨內初選）→ 保留

【排除 ❌】
- ⛔ 其他縣市的純地方新聞且與核心地區/主題無關（如：核心地區是台中，則「台北市長柯文哲」「高雄港擴建」「新北三重票倉」「台南謝龍介」等一律排除）
- ⛔ 與核心主題完全無關的政治人物地方選舉新聞
- ⛔ 純娛樂/體育/八卦
- ⛔ 重複報導（同一事件只保留一則）
- ⛔ 日期不在 {start_date} ~ {end_date} 範圍內的新聞（例如提及「2024」「2025」「近日」「3天前」等）

【標題要求】
- 具體，包含人名、機構名、地名、數字（50字以內）
- 直接描述事件本身
- ⛔ 每個事件標題必須獨特！不可出現「XX市政府推動YY政策以改善ZZ」這類通用格式重複套用。每條新聞必須對應一個具體、不同的事件

【摘要要求】
- 60-100字繁體中文
- 客觀描述：發生什麼事、涉及誰、有什麼影響
- 不要加入主觀推測

【分類】
根據研究問題的性質，自動選擇合適的分類標籤（例如：政策、產業、民意、法規、經濟、社會、國際、技術、爭議等）

新聞列表：
{articles_text}

回覆 JSON（全部繁體中文）：
{{
  "events": [
    {{
      "date": "YYYY-MM-DD",
      "title": "繁體中文標題",
      "summary": "繁體中文摘要",
      "category": "自動分類標籤",
      "source": "新聞來源名稱（如：自由時報、中時電子報、TVBS、聯合新聞網。必須從原始資料的 [來源] 欄位取得，不可捏造）"
    }}
  ]
}}

盡量保留 {max_results} 則事件，按時間排序。{date_range_note}

⚠️ 嚴格規則：
1. 不可捏造事件，只能使用上面列表中存在的事件
2. ⛔ 嚴禁竄改地名！如果原文是關於「台北中正橋」，不可改寫成「台中中正橋」。如果一則新聞不是關於核心地區的，就純粹排除它，而不是修改內容。
3. 今天是 {datetime.now().strftime('%Y-%m-%d')}，不可出現未來日期
4. ⛔ 所有事件的 date 欄位必須在 {start_date} 到 {end_date} 之間，超出此範圍一律不收錄"""

    try:
        clean_prompt = _sanitize_prompt(prompt)
        # Truncate if overly long to avoid token limits
        if len(clean_prompt) > 15000:
            clean_prompt = clean_prompt[:15000] + "\n\n[...truncated...]"

        kwargs = {
            "model": model,
            "messages": [{"role": "user", "content": clean_prompt}],
        }
        if any(m in model.lower() for m in ["o1", "o3", "gpt-5"]):
            kwargs["max_completion_tokens"] = 8192
        else:
            kwargs["max_tokens"] = 4000
            kwargs["temperature"] = 0.1
        resp = await client.chat.completions.create(**kwargs)
        text = resp.choices[0].message.content.strip()
        
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

        parsed = json.loads(text)
        events = parsed.get("events", parsed if isinstance(parsed, list) else [])
        
        # Post-filter: remove events outside allowed date range
        today_str = datetime.now().strftime("%Y-%m-%d")
        range_start = start_date or "1900-01-01"
        range_end = end_date or today_str
        filtered_events = []
        for ev in events:
            ev_date = ev.get("date", "").replace("/", "-")
            if not ev_date:
                filtered_events.append(ev)
                continue
            if ev_date > today_str:
                logger.warning(f"Removed future event: {ev_date} - {ev.get('title', '')}")
                continue
            if ev_date < range_start or ev_date > range_end:
                logger.warning(f"Removed out-of-range event: {ev_date} (range {range_start}~{range_end}) - {ev.get('title', '')}")
                continue
            filtered_events.append(ev)
        
        return filtered_events

    except (json.JSONDecodeError, Exception) as e:
        logger.warning(f"LLM filter or proxy encoding failed, falling back to raw formatting. Error: {e}")
        return [
            {
                "date": r.get("published_date", "") or r.get("date", ""),
                "title": r.get("title", "")[:80],
                "summary": r.get("content", r.get("snippet", ""))[:150],
                "category": "政治" if "政治" in query or "選舉" in query else "綜合",
                "source": r.get("source", "網路新聞"),
            }
            for r in raw_results[:max_results]
        ]


# ─────────────────────────────────────────────────────────────────────
# Social Media / Forum Search (Serper Search API)
# ─────────────────────────────────────────────────────────────────────

SOCIAL_SITES = "site:ptt.cc OR site:dcard.tw OR site:mobile01.com OR site:lihkg.com"


async def _search_serper_social(query: str, start_date: str, end_date: str, num: int = 10) -> list[dict]:
    """Search Google (regular) via Serper targeting social/forum sites."""
    api_key = _get_serper_key()

    try:
        dt_start = datetime.strptime(start_date, "%Y-%m-%d")
        dt_end = datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"日期格式錯誤: {start_date}, {end_date}")

    tbs = f"cdr:1,cd_min:{dt_start.strftime('%m/%d/%Y')},cd_max:{dt_end.strftime('%m/%d/%Y')}"

    # Append site filter to query
    full_query = f"{query} ({SOCIAL_SITES})"

    payload = {
        "q": full_query,
        "gl": SERPER_GL,
        "hl": SERPER_HL,
        "num": min(num, 100),
        "tbs": tbs,
    }
    headers = {
        "X-API-KEY": api_key,
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=600.0) as client:
        try:
            resp = await client.post(
                "https://google.serper.dev/search",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as e:
            body = e.response.text[:200] if e.response else ""
            logger.warning(f"Serper social {e.response.status_code} for '{query[:30]}': {body}")
            return []

    raw_results = data.get("organic", [])
    
    # Pre-filter: parse Serper dates and reject results outside range
    filtered = []
    for r in raw_results:
        raw_date = r.get("date", "")
        iso_date = _parse_serper_date(raw_date)
        if iso_date:
            r["_parsed_date"] = iso_date
            if iso_date < start_date or iso_date > end_date:
                logger.info(f"  ✗ Social pre-filter rejected: [{iso_date}] '{r.get('title', '')[:40]}' (range: {start_date}~{end_date})")
                continue
        filtered.append(r)
    
    rejected = len(raw_results) - len(filtered)
    if rejected > 0:
        logger.info(f"Serper social '{query[:30]}': {len(raw_results)} raw → {len(filtered)} after date pre-filter ({rejected} rejected)")
    else:
        logger.info(f"Serper social '{query[:30]}': {len(filtered)} results")
    return filtered


async def _expand_social_queries(question: str) -> list[str]:
    """Generate search queries optimized for forum/social media discussions."""
    from openai import AsyncOpenAI

    from shared.global_settings import get_system_llm_credentials
    creds = get_system_llm_credentials()
    api_key = creds["api_key"]
    base_url = creds["base_url"]
    model = creds["model"]
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    prompt = f"""你是社群輿情分析師。使用者想研究：

「{question}」

請產生 8-10 個搜尋關鍵字，專門用來搜尋 PTT、Dcard、Mobile01 等論壇上的討論。

重點方向：
A. 民眾直接討論（3 組）：使用論壇常用語、口語化表達
B. 情緒/抱怨（2 組）：民怨、不滿、支持相關的討論
C. 八卦/爆料（2 組）：爆卦、爆料、內幕
D. 生活影響（2 組）：對日常生活的實際影響討論

規則：
- 每個字串 2-4 個繁體中文關鍵字
- 使用論壇常見用語（如：怎麼看、有卦嗎、心得）
- 不要加 site: 等搜尋語法

直接回覆 JSON 陣列：["搜尋1", "搜尋2", ...]"""

    try:
        clean_prompt = _sanitize_prompt(prompt)
        kwargs = {
            "model": model,
            "messages": [{"role": "user", "content": clean_prompt}],
        }
        if any(m in model.lower() for m in ["o1", "o3", "gpt-5"]):
            kwargs["max_completion_tokens"] = 4096
        else:
            kwargs["max_tokens"] = 400
            kwargs["temperature"] = 0.5
        resp = await client.chat.completions.create(**kwargs)
        text = resp.choices[0].message.content.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

        queries = json.loads(text)
        if isinstance(queries, list) and len(queries) > 0:
            logger.info(f"LLM expanded social queries: {len(queries)}")
            return queries[:10]
    except Exception as e:
        logger.warning(f"Social query expansion failed: {e}")

    return [question, f"{question} 討論", f"{question} 怎麼看"]


async def research_social(
    query: str,
    start_date: str,
    end_date: str,
    max_results: int = 20,
) -> list[dict]:
    """Search social media / forums for discussions relevant to a topic.

    Simplified strategy: 1 request per keyword line, no LLM expansion.
    """
    import asyncio

    dt_start = datetime.strptime(start_date, "%Y-%m-%d")
    dt_end = datetime.strptime(end_date, "%Y-%m-%d")
    total_days = (dt_end - dt_start).days
    if total_days <= 0:
        raise ValueError("結束日期必須晚於開始日期")

    # Use keyword lines directly — no LLM expansion
    search_queries = _split_topics(query)
    logger.info(f"Social: {len(search_queries)} keyword(s): {search_queries}")

    per_query_num = max(10, min(30, (max_results * 2) // max(1, len(search_queries))))

    # Rate-limited search (max 5 concurrent, 0.3s delay)
    _serper_sem = asyncio.Semaphore(5)

    async def _do_social(sq: str) -> list[dict]:
        async with _serper_sem:
            await asyncio.sleep(0.3)
            for attempt in range(3):
                try:
                    results = await _search_serper_social(sq, start_date, end_date, num=per_query_num)
                    return [{
                        "title": r.get("title", ""),
                        "url": r.get("link", ""),
                        "content": r.get("snippet", ""),
                        "published_date": r.get("date", ""),
                        "source": _extract_source(r.get("link", "")),
                        "type": "社群",
                    } for r in results]
                except Exception as e:
                    err_str = str(e)
                    if ("disconnect" in err_str.lower() or "429" in err_str) and attempt < 2:
                        wait = 2.0 * (attempt + 1)
                        logger.warning(f"Social retry {attempt+1} for '{sq[:20]}': {e}, wait {wait}s")
                        await asyncio.sleep(wait)
                        continue
                    logger.warning(f"Social search failed '{sq}': {e}")
                    return []
            return []

    tasks = [_do_social(sq) for sq in search_queries]
    logger.info(f"Social search: {len(tasks)} tasks ({per_query_num} results each)")
    results_list = await asyncio.gather(*tasks)


    all_results = []
    for batch in results_list:
        all_results.extend(batch)

    if not all_results:
        return []

    # Dedup
    seen = set()
    unique = []
    for r in all_results:
        key = r["title"][:20]
        if key not in seen:
            seen.add(key)
            unique.append(r)

    logger.info(f"Social unique results: {len(unique)}")

    # Step 4: LLM summarize into events format
    from openai import AsyncOpenAI

    from shared.global_settings import get_system_llm_credentials
    creds = get_system_llm_credentials()
    api_key = creds["api_key"]
    base_url = creds["base_url"]
    model = creds["model"]
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    sample = unique[:40]
    def _fmt_social(r: dict) -> str:
        dp = "(" + r["published_date"] + ") " if r.get("published_date") else ""
        src = r['source']
        ttl = r['title']
        snip = r['content'][:80]
        return f"- [{src}] {dp}{ttl}: {snip}"
    raw_text = "\n".join(_fmt_social(r) for r in sample)

    prompt = f"""從以下社群 / 論壇搜尋結果中，挑選最多 {max_results} 則重要的社群討論，轉換為事件格式。

用戶搜尋的關鍵字組合：「{query}」
搜尋範圍：{start_date} 至 {end_date}

⚡ 請先從關鍵字推斷「核心地區」和「核心主題」，然後嚴格過濾：
- ✅ 保留：討論核心地區/主題的貼文、全國性影響選民情緒的議題（經濟、兩岸、民生）
- ❌ 排除：其他縣市的純地方討論（如核心地區是台中，則台北/高雄/台南的地方事務排除）、純娛樂八卦、完全無關的討論

搜尋結果：
{raw_text}

要求：
1. 每則事件需有 date, title, summary, category
2. date 必須是 YYYY-MM-DD 格式。請根據文章內容推斷合理日期：
   - 若標題或摘要提到具體時間（如「2020年」「去年」），根據線索推斷
   - ⚠️ 絕對不要所有事件都用同一個日期！必須分散在不同月份
3. ⛔ 嚴格排除！若文章的日期明顯在 {start_date} ~ {end_date} 範圍外（例如提及 2024、2025、2026，或日期欄位寫「3天前」「1小時前」等近期），必須排除該文章，不可收錄！
4. category 只能是：民怨, 支持, 爭議, 八卦, 生活, 其他
5. summary 要客觀描述社群討論內容，30-50字
6. title 用口語但不失專業
7. ⛔ 嚴禁竄改地名！如果原文討論的是台北的事，不可改寫成台中。不相關的貼文應純粹排除，而不是修改內容硬套。

回覆 JSON：{{"events": [{{"date": "YYYY-MM-DD", "title": "...", "summary": "...", "category": "..."}}]}}"""

    try:
        clean_prompt = _sanitize_prompt(prompt)
        kwargs = {
            "model": model,
            "messages": [{"role": "user", "content": clean_prompt}],
        }
        if any(m in model.lower() for m in ["o1", "o3", "gpt-5"]):
            kwargs["max_completion_tokens"] = 8192
        else:
            kwargs["max_tokens"] = 2000
            kwargs["temperature"] = 0.3
        resp = await client.chat.completions.create(**kwargs)
        text = resp.choices[0].message.content.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        parsed = json.loads(text.strip())
        events = parsed.get("events", [])
        # Tag all as social and filter by date range
        today_str = datetime.now().strftime("%Y-%m-%d")
        filtered = []
        for ev in events:
            ev["source_type"] = "社群"
            ev_date = ev.get("date", "").replace("/", "-")
            if ev_date and (ev_date < start_date or ev_date > end_date or ev_date > today_str):
                logger.warning(f"Social: removed out-of-range event: {ev_date} - {ev.get('title', '')}")
                continue
            filtered.append(ev)
        return filtered
    except Exception as e:
        logger.error(f"Social LLM summarize failed: {e}")
        return [{
            "date": start_date,
            "title": r["title"][:50],
            "summary": r["content"][:100],
            "category": "其他",
            "source_type": "社群",
        } for r in unique[:max_results]]


def _extract_source(url: str) -> str:
    """Extract recognizable source name from URL."""
    if "ptt.cc" in url:
        return "PTT"
    if "dcard.tw" in url:
        return "Dcard"
    if "mobile01.com" in url:
        return "Mobile01"
    if "lihkg.com" in url:
        return "LIHKG"
    try:
        from urllib.parse import urlparse
        return urlparse(url).netloc.replace("www.", "")
    except Exception:
        return "論壇"

