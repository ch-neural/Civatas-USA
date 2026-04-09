"""US news search keyword templates — drop-in replacement for the
``build_default_keywords()`` function in ap/services/evolution/app/news_intelligence.py.

Same signature: ``build_default_keywords(county_or_state) -> (local, national)``.

The 10+10 set covers the dimensions that drive US social-simulation state
changes. The mapping from TW dimensions to US dimensions:

  TW                            US
  ─────────────────────────────────────────────────────────────────────
  市政・施政                    Governor / Mayor / city government
  議會質詢                      State legislature / city council
  選舉・候選人・民調              Elections / polls / candidates
  建設・交通                    Infrastructure / transit / roads
  房價・物價                    Cost of living / housing prices / inflation
  就業・產業                    Jobs / unemployment / wages
  教育                          K-12 / school board / colleges
  醫療・長照                    Healthcare / Medicare / Medicaid / opioid
  治安・犯罪                    Crime / police / public safety
  環境・空污・災害              Environment / climate / wildfire / hurricane
  ─────────────────────────────────────────────────────────────────────
  國家層級
  總統府・行政院                White House / President / Cabinet
  立法院                        Congress / Senate / House
  選舉・政黨                    Elections / parties / national polls
  兩岸・國防                    Foreign policy / military / Ukraine / Israel
  美中・外交                    China / trade / diplomacy
  經濟・物價                    Economy / inflation / Fed
  房市・利率                    Housing market / mortgage rates / Fed
  就業・薪資                    Jobs report / wages / labor
  半導體・科技                  Tech / AI / chips / regulation
  醫療・教育                    Healthcare reform / student loans
"""
from __future__ import annotations


def build_default_keywords(region: str) -> tuple[list[str], list[str]]:
    """Build the default fixed keyword set for US news search.

    ``region`` is either a state name ("Pennsylvania") or a "State|County" key
    ("Pennsylvania|Allegheny County"). The local templates substitute the
    most-specific name available; if the caller passes a state-only key the
    queries will scope to the state.
    """
    if region and "|" in region:
        parts = [p.strip() for p in region.split("|") if p.strip()]
        loc = parts[-1] if parts else "United States"
        scope = parts[0] if len(parts) > 1 else loc
    else:
        loc = region or "United States"
        scope = loc

    # Local / state-and-below queries
    local = [
        # Governor / city / county government
        f'"{loc}" governor mayor government',
        # Legislature / council
        f'"{loc}" legislature council vote',
        # Elections / candidates / polls
        f'"{loc}" election candidate poll',
        # Infrastructure / transit
        f'"{loc}" infrastructure roads transit',
        # Cost of living / housing
        f'"{loc}" housing rent cost of living',
        # Jobs / economy
        f'"{loc}" jobs unemployment business',
        # Schools / education
        f'"{loc}" schools education',
        # Healthcare
        f'"{loc}" healthcare hospital Medicaid',
        # Crime / public safety
        f'"{loc}" crime police safety',
        # Environment / disasters
        f'"{loc}" environment storm wildfire flood',
    ]

    # National queries — region-independent
    national = [
        # White House / President / executive
        '"United States" president White House Cabinet',
        # Congress / Senate / House
        '"United States" Congress Senate House bill',
        # Elections / parties / national polls
        '"United States" election Democrats Republicans poll',
        # Foreign policy / military
        '"United States" military Ukraine Israel foreign policy',
        # China / trade / diplomacy
        '"United States" China trade tariff diplomacy',
        # Economy / inflation / Fed
        '"United States" economy inflation Federal Reserve',
        # Housing market / mortgage / Fed
        '"United States" housing mortgage rates',
        # Jobs report / labor / wages
        '"United States" jobs report wages labor',
        # Tech / AI / chips
        '"United States" technology AI semiconductor regulation',
        # Healthcare / student loans
        '"United States" healthcare Medicare student loans',
    ]
    return local, national


# ── Serper / search backend defaults ─────────────────────────────────
# These should be passed through to ``api/tavily_research.py`` when the
# workspace's country is "US". They replace the hard-coded
# ``gl=tw, hl=zh-TW`` in the existing implementation.

SERPER_LOCALE = {
    "gl": "us",
    "hl": "en",
    "google_domain": "google.com",
}
