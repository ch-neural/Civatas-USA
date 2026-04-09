"""Playwright-based web crawler that simulates human browsing behaviour.

Fetches headlines and summaries from preconfigured and user-provided URLs.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# ── Political leaning options ────────────────────────────────────────

LEANING_OPTIONS = ["偏左派", "中立", "偏右派"]

# ── Default source registry ──────────────────────────────────────────

@dataclass
class CrawlSource:
    source_id: str
    name: str
    url: str
    tag: str                 # e.g. "PTT八卦版", "Yahoo新聞"
    selector_title: str      # CSS selector for headline elements
    selector_summary: str    # CSS selector for summary text
    max_items: int = 10
    is_default: bool = True
    leaning: str = "中立"    # political leaning of this source

DEFAULT_SOURCES: list[dict[str, Any]] = [
    {
        "name": "Yahoo 新聞 — 焦點",
        "url": "https://tw.news.yahoo.com/",
        "tag": "Yahoo新聞",
        "leaning": "中立",
        "selector_title": "h3 a, .Cf a",
        "selector_summary": "p",
        "max_items": 10,
    },
    {
        "name": "TVBS 新聞",
        "url": "https://news.tvbs.com.tw/realtime",
        "tag": "TVBS新聞",
        "leaning": "偏右派",
        "selector_title": ".news_list h2 a, .list-item a .title",
        "selector_summary": ".list-item a .txt, .news_list .summary",
        "max_items": 10,
    },
    {
        "name": "自由時報 — 即時",
        "url": "https://news.ltn.com.tw/list/breakingnews",
        "tag": "自由時報",
        "leaning": "偏左派",
        "selector_title": ".tit a, .title a",
        "selector_summary": ".summary, .cont p",
        "max_items": 10,
    },
    {
        "name": "中時電子報",
        "url": "https://www.chinatimes.com/realtimenews/?chdtv",
        "tag": "中時電子報",
        "leaning": "偏右派",
        "selector_title": ".title a, h3 a",
        "selector_summary": ".intro, .summary",
        "max_items": 10,
    },
    {
        "name": "聯合新聞網",
        "url": "https://udn.com/news/breaknews/1",
        "tag": "聯合新聞網",
        "leaning": "偏右派",
        "selector_title": ".story-list__text h2 a, .title a",
        "selector_summary": ".story-list__text p, .summary",
        "max_items": 10,
    },
    {
        "name": "三立新聞",
        "url": "https://www.setn.com/ViewAll.aspx",
        "tag": "三立新聞",
        "leaning": "偏左派",
        "selector_title": ".newsItems h3 a, .view-li-title a",
        "selector_summary": ".newsItems p, .view-li-summary",
        "max_items": 10,
    },
    {
        "name": "PTT 八卦版",
        "url": "https://www.ptt.cc/bbs/Gossiping/index.html",
        "tag": "PTT八卦版",
        "leaning": "偏左派",
        "selector_title": ".r-ent .title a",
        "selector_summary": "",
        "max_items": 10,
    },
    {
        "name": "PTT 政黑版",
        "url": "https://www.ptt.cc/bbs/HatePolitics/index.html",
        "tag": "PTT政黑版",
        "leaning": "偏左派",
        "selector_title": ".r-ent .title a",
        "selector_summary": "",
        "max_items": 10,
    },
    {
        "name": "PTT 科技版",
        "url": "https://www.ptt.cc/bbs/Tech_Job/index.html",
        "tag": "PTT科技版",
        "leaning": "中立",
        "selector_title": ".r-ent .title a",
        "selector_summary": "",
        "max_items": 10,
    },
    {
        "name": "Dcard 時事版",
        "url": "https://www.dcard.tw/f/trending",
        "tag": "Dcard時事",
        "leaning": "中立",
        "selector_title": "h2, [class*='PostEntry'] h2",
        "selector_summary": "[class*='PostEntry'] p, [class*='excerpt']",
        "max_items": 10,
    },
]


def _make_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:12]


def build_default_sources() -> list[CrawlSource]:
    """Return the default source list as CrawlSource objects."""
    results = []
    for s in DEFAULT_SOURCES:
        results.append(CrawlSource(
            source_id=_make_id(s["url"]),
            name=s["name"],
            url=s["url"],
            tag=s["tag"],
            selector_title=s["selector_title"],
            selector_summary=s.get("selector_summary", ""),
            max_items=s.get("max_items", 10),
            is_default=True,
            leaning=s.get("leaning", "中立"),
        ))
    return results


# ── Crawl engine ─────────────────────────────────────────────────────

@dataclass
class CrawledArticle:
    article_id: str
    title: str
    summary: str
    source_url: str
    source_tag: str
    source_leaning: str  # political leaning of the source
    crawled_at: str  # ISO format


async def crawl_source(source: CrawlSource) -> list[CrawledArticle]:
    """Use Playwright to crawl a single source URL and extract articles."""
    articles: list[CrawledArticle] = []
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        logger.error("Playwright not installed — cannot crawl.")
        return articles

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                locale="zh-TW",
            )
            page = await context.new_page()

            # PTT requires age verification cookie
            if "ptt.cc" in source.url:
                await context.add_cookies([{
                    "name": "over18",
                    "value": "1",
                    "domain": ".ptt.cc",
                    "path": "/",
                }])

            logger.info(f"Crawling {source.name}: {source.url}")
            await page.goto(source.url, wait_until="domcontentloaded", timeout=600.0)

            # Give dynamic pages a moment to render
            await page.wait_for_timeout(2000)

            html = await page.content()
            await browser.close()

        # Parse with BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")

        # Extract titles
        title_els = soup.select(source.selector_title) if source.selector_title else []
        title_els = title_els[:source.max_items]

        # Extract summaries (if selector provided)
        summary_els = (
            soup.select(source.selector_summary)
            if source.selector_summary
            else []
        )

        now = datetime.now(timezone.utc).isoformat()

        for i, title_el in enumerate(title_els):
            raw_title = title_el.get_text(strip=True)
            if not raw_title or len(raw_title) < 4:
                continue
            # Clean title
            title = re.sub(r"\s+", " ", raw_title)[:120]

            # Try to get a matching summary
            summary = ""
            if i < len(summary_els):
                summary = summary_els[i].get_text(strip=True)[:100]

            aid = _make_id(f"{source.url}:{title}")
            articles.append(CrawledArticle(
                article_id=aid,
                title=title,
                summary=summary,
                source_url=source.url,
                source_tag=source.tag,
                source_leaning=source.leaning,
                crawled_at=now,
            ))

        logger.info(f"  → {len(articles)} articles from {source.name}")

    except Exception as e:
        logger.exception(f"Failed to crawl {source.name}: {e}")

    return articles


async def crawl_all(sources: list[CrawlSource]) -> list[CrawledArticle]:
    """Crawl all sources sequentially (share one browser instance to save RAM)."""
    all_articles: list[CrawledArticle] = []
    for src in sources:
        batch = await crawl_source(src)
        all_articles.extend(batch)
        # Be polite — small delay between sources
        await asyncio.sleep(1)
    return all_articles
