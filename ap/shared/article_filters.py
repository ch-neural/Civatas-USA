"""Shared article relevance filtering — used by calibrator and feed_engine.

US-only — delegates to us_article_filters.
"""

try:
    from . import us_article_filters as _us_filter  # type: ignore
except Exception:
    import us_article_filters as _us_filter  # type: ignore


def is_relevant_article(
    title: str = "",
    source: str = "",
    summary: str = "",
) -> bool:
    """Return True if the article is likely relevant to social/political simulation."""
    return _us_filter.is_relevant_article(title=title, source=source, summary=summary)
