"""US news source taxonomy and media-habit map.

Replaces ap/services/evolution/app/feed_engine.DEFAULT_SOURCE_LEANINGS for
US workspaces. Schema is unchanged so feed_engine consumes it identically:

    {source_name: 5-tier leaning label}

The 5-tier labels are the canonical US labels from us_leaning.LEANING_SPECTRUM_5
(Solid Dem / Lean Dem / Tossup / Lean Rep / Solid Rep). Bias assignments draw
from the AllSides Media Bias Chart (v9) and the Ad Fontes Media Bias Chart;
where the two disagree we pick the more conservative (closer-to-Tossup)
classification.

DEFAULT_DIET_MAP maps the categorical media-habit values from the PA template
(see Civatas-USA/ap/data/templates/pennsylvania_sample.json) onto the source
set, so a persona with media_habit="Social Media (Facebook / X / TikTok)"
pulls from the social-media bucket below.

This file is plain data — it has no imports from feed_engine or evolver, so
it can be loaded standalone for tests and exposed via /api/runtime/news-sources.
"""
from __future__ import annotations


# ── Source → leaning ─────────────────────────────────────────────────
# 100+ outlets covering print, broadcast, cable, podcasts, social, fact-checkers.

DEFAULT_SOURCE_LEANINGS: dict[str, str] = {
    # ── Wire services / international (mostly Tossup) ────────────────
    "Reuters":                          "Tossup",
    "Associated Press":                 "Tossup",
    "AP News":                          "Tossup",
    "Bloomberg":                        "Tossup",
    "Bloomberg News":                   "Tossup",
    "Forbes":                           "Tossup",
    "The Economist":                    "Tossup",
    "BBC News":                         "Lean Dem",
    "The Christian Science Monitor":    "Tossup",
    "The Hill":                         "Tossup",
    "RealClearPolitics":                "Tossup",
    "Axios":                            "Tossup",
    "Newsweek":                         "Tossup",
    "USA Today":                        "Tossup",
    "Yahoo News":                       "Lean Dem",

    # ── Lean Dem (mainstream center-left) ──────────────────────────
    "The New York Times":               "Lean Dem",
    "The Washington Post":              "Lean Dem",
    "Los Angeles Times":                "Lean Dem",
    "The Boston Globe":                 "Lean Dem",
    "Chicago Tribune":                  "Lean Dem",
    "The Philadelphia Inquirer":        "Lean Dem",
    "The Atlantic":                     "Lean Dem",
    "Politico":                         "Lean Dem",
    "Time":                             "Lean Dem",
    "The Guardian (US)":                "Lean Dem",
    "ProPublica":                       "Lean Dem",
    "Vanity Fair":                      "Lean Dem",
    "The New Yorker":                   "Lean Dem",
    "Rolling Stone":                    "Lean Dem",
    "Vox":                              "Lean Dem",
    "Business Insider":                 "Lean Dem",
    "Insider":                          "Lean Dem",
    "Talking Points Memo":              "Lean Dem",
    "Slate":                            "Lean Dem",
    "BuzzFeed News":                    "Lean Dem",
    "NBC News":                         "Lean Dem",
    "ABC News":                         "Lean Dem",
    "CBS News":                         "Lean Dem",
    "CNN":                              "Lean Dem",
    "NPR":                              "Lean Dem",
    "PBS NewsHour":                     "Lean Dem",
    "PBS":                              "Lean Dem",

    # ── Solid Dem (strong progressive) ─────────────────────────────
    "MSNBC":                            "Solid Dem",
    "HuffPost":                         "Solid Dem",
    "Mother Jones":                     "Solid Dem",
    "The Nation":                       "Solid Dem",
    "Daily Kos":                        "Solid Dem",
    "Common Dreams":                    "Solid Dem",
    "Jacobin":                          "Solid Dem",
    "Democracy Now!":                   "Solid Dem",
    "The Young Turks":                  "Solid Dem",
    "Pod Save America":                 "Solid Dem",
    "The Intercept":                    "Solid Dem",
    "AlterNet":                         "Solid Dem",

    # ── Lean Rep (center-right / business / libertarian) ──────────
    "The Wall Street Journal":          "Lean Rep",
    "The Wall Street Journal Opinion":  "Solid Rep",
    "New York Post":                    "Lean Rep",
    "Reason":                           "Lean Rep",
    "National Review":                  "Lean Rep",
    "The Dispatch":                     "Lean Rep",
    "The Bulwark":                      "Tossup",
    "Washington Examiner":              "Lean Rep",
    "The American Conservative":        "Lean Rep",
    "The Spectator":                    "Lean Rep",
    "Commentary":                       "Lean Rep",
    "City Journal":                     "Lean Rep",

    # ── Solid Rep (strong conservative) ───────────────────────────
    "Fox News":                         "Solid Rep",
    "Fox Business":                     "Solid Rep",
    "Fox News Opinion":                 "Solid Rep",
    "The Washington Times":             "Solid Rep",
    "The Daily Wire":                   "Solid Rep",
    "Breitbart":                        "Solid Rep",
    "Breitbart News":                   "Solid Rep",
    "OANN":                             "Solid Rep",
    "One America News":                 "Solid Rep",
    "Newsmax":                          "Solid Rep",
    "The Federalist":                   "Solid Rep",
    "Daily Caller":                     "Solid Rep",
    "Townhall":                         "Solid Rep",
    "RedState":                         "Solid Rep",
    "PJ Media":                         "Solid Rep",
    "The Western Journal":              "Solid Rep",
    "The Blaze":                        "Solid Rep",
    "Drudge Report":                    "Lean Rep",
    "Real Clear Politics":              "Tossup",
    "The Joe Rogan Experience":         "Lean Rep",
    "The Ben Shapiro Show":             "Solid Rep",
    "The Tucker Carlson Show":          "Solid Rep",
    "Bannon's War Room":                "Solid Rep",

    # ── Reddit politics communities ────────────────────────────────
    "Reddit r/politics":                "Solid Dem",
    "Reddit r/PoliticalHumor":          "Solid Dem",
    "Reddit r/news":                    "Lean Dem",
    "Reddit r/worldnews":               "Lean Dem",
    "Reddit r/Conservative":            "Solid Rep",
    "Reddit r/Republican":              "Solid Rep",
    "Reddit r/Libertarian":             "Lean Rep",
    "Reddit r/moderatepolitics":        "Tossup",
    "Reddit r/PoliticalDiscussion":     "Tossup",
    "Reddit r/centrist":                "Tossup",
    "Reddit r/Ask_Politics":            "Tossup",

    # ── Major social platforms (audience-graded) ──────────────────
    "X (Twitter)":                      "Tossup",
    "Facebook":                         "Tossup",
    "TikTok":                           "Lean Dem",
    "Instagram":                        "Lean Dem",
    "YouTube":                          "Tossup",
    "YouTube News":                     "Tossup",
    "Threads":                          "Lean Dem",
    "Bluesky":                          "Lean Dem",
    "Truth Social":                     "Solid Rep",
    "Gab":                              "Solid Rep",
    "Parler":                           "Solid Rep",
    "Rumble":                           "Lean Rep",

    # ── Fact-checkers (treated as Tossup) ─────────────────────────
    "Snopes":                           "Lean Dem",
    "FactCheck.org":                    "Tossup",
    "PolitiFact":                       "Lean Dem",
    "Lead Stories":                     "Tossup",

    # ── Pennsylvania regional (for PA workspaces specifically) ────
    "Pittsburgh Post-Gazette":          "Tossup",
    "Pittsburgh Tribune-Review":        "Lean Rep",
    "The Patriot-News":                 "Tossup",
    "Erie Times-News":                  "Tossup",
    "WPXI Pittsburgh":                  "Tossup",
    "KDKA Pittsburgh":                  "Tossup",
    "WTAE Pittsburgh":                  "Tossup",
    "PennLive":                         "Tossup",
    "Philly.com":                       "Lean Dem",
    "Philadelphia Magazine":            "Lean Dem",
    "WHYY (NPR Philadelphia)":          "Lean Dem",

    # ── Generic catch-alls ─────────────────────────────────────────
    "Local News":                       "Tossup",
    "Local TV":                         "Tossup",
    "Manual Injection":                 "Tossup",
}


# ── Media-habit → source set ─────────────────────────────────────────
# Keys must match the values in pennsylvania_sample.json under media_habit.

DEFAULT_DIET_MAP: dict[str, list[str]] = {
    "TV News (Local + Cable)": [
        "ABC News", "CBS News", "NBC News", "CNN", "Fox News", "MSNBC",
        "Local News", "Local TV", "PBS NewsHour",
    ],
    "Social Media (Facebook / X / TikTok)": [
        "Facebook", "X (Twitter)", "TikTok", "Instagram", "Threads",
        "Reddit r/news", "Reddit r/politics", "Reddit r/Conservative",
    ],
    "News Websites / Apps": [
        "The New York Times", "The Washington Post", "The Wall Street Journal",
        "USA Today", "Reuters", "Associated Press", "Politico", "Axios",
        "Bloomberg", "The Hill", "Yahoo News", "NPR",
    ],
    "YouTube": [
        "YouTube", "YouTube News", "MSNBC", "Fox News", "CNN",
        "The Joe Rogan Experience", "Pod Save America", "The Daily Wire",
    ],
    "Podcasts / Radio": [
        "NPR", "PBS NewsHour", "The Daily Wire", "The Joe Rogan Experience",
        "Pod Save America", "The Ben Shapiro Show", "The Young Turks",
    ],
    "Print Newspaper": [
        "The New York Times", "The Washington Post", "The Wall Street Journal",
        "USA Today", "Local News", "Pittsburgh Post-Gazette",
        "The Philadelphia Inquirer",
    ],
}

# Probability that a feed item leaks across media bubbles (matches feed_engine
# default for TW; tunable per workspace).
SERENDIPITY_RATE = 0.05


# ── Grouping helper for the UI ───────────────────────────────────────
# Returns sources organized by 5-tier bucket. Used by the
# /api/runtime/news-sources endpoint and by NewsCenterPanel.

def sources_by_bucket() -> dict[str, list[str]]:
    """Return {bucket_label: [source names]} sorted by name within each bucket."""
    buckets: dict[str, list[str]] = {
        "Solid Dem":  [],
        "Lean Dem":   [],
        "Tossup":     [],
        "Lean Rep":   [],
        "Solid Rep":  [],
    }
    for src, lean in DEFAULT_SOURCE_LEANINGS.items():
        if lean in buckets:
            buckets[lean].append(src)
    for lst in buckets.values():
        lst.sort()
    return buckets
