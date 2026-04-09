"""US persona generation prompt for the persona service.

Output JSON schema:
    { "user_char": "...", "media_habit": "...", "political_leaning": "..." }

Notes:
  - Location cues are US (Pittsburgh, Philadelphia, suburban PA, rural Appalachia,
    Lehigh Valley, etc.).
  - Media habits draw from the US source taxonomy (Fox / MSNBC / NPR / Reddit /
    Joe Rogan / Pod Save America / local TV / etc.).
  - Political leaning uses the 5-tier Cook spectrum (Solid Dem ... Solid Rep).
  - Tone cues use US English idioms appropriate to the persona's age cohort.
"""
from __future__ import annotations


# 5-tier political leaning options that the LLM picks one of.
US_LEANING_OPTIONS = "Solid Dem, Lean Dem, Tossup, Lean Rep, Solid Rep"

# US news / media habit pool (matches us_feed_sources DEFAULT_DIET_MAP keys
# loosely so feed_engine can route articles correctly).
US_MEDIA_OPTIONS = (
    "CNN, Fox News, MSNBC, NPR, The New York Times, The Washington Post, "
    "The Wall Street Journal, USA Today, ABC News, NBC News, CBS News, "
    "Local TV news, Local newspaper, Reddit r/politics, Reddit r/Conservative, "
    "Facebook, X (Twitter), TikTok, YouTube, "
    "Pod Save America, The Joe Rogan Experience, The Daily Wire, "
    "Talk radio, Breitbart, HuffPost"
)


def build_persona_prompt_en(state_or_region: str = "Pennsylvania") -> str:
    """Return the English persona-generation system prompt.

    ``state_or_region`` is the geographic anchor — defaults to Pennsylvania
    since PA is the only state with a packaged template in Stage 1.5+. When
    additional state templates are added, pass their state name here.
    """
    region = state_or_region or "Pennsylvania"
    is_pa = region.lower().startswith("pennsylvania")

    # PA-specific location cues. For other states, the regional cues line is
    # generic and the LLM relies on its own knowledge of the state.
    if is_pa:
        location_cues = (
            "- Anchor the persona's life in Pennsylvania. Real PA places to draw "
            "from: Philadelphia (urban Dem), Pittsburgh + Allegheny suburbs "
            "(post-industrial mixed), Bucks/Montgomery/Chester/Delaware counties "
            "(suburban swing), Erie (Rust Belt swing), Lehigh Valley "
            "(manufacturing + Latino growth), Lancaster (Amish + Republican farming), "
            "Centre County (State College), Scranton/Wilkes-Barre (working-class), "
            "rural Appalachian counties (deep Republican)."
        )
    else:
        location_cues = (
            f"- Anchor the persona's life in {region}. Use real local places, "
            "regional industries, and cultural references that fit the area."
        )

    return (
        f"You are a US persona designer for {region} residents. Based on the "
        "demographic data below, write a vivid, realistic 100-180 word "
        f"first-person self-introduction for a real {region} resident.\n\n"

        "[Style requirements — VERY important]\n"
        "- Forbidden generic openers like \"Hi, I'm a XX-year-old YY who...\" — "
        "every persona must start differently.\n"
        f"{location_cues}\n"
        "- Voice must match the persona's age cohort:\n"
        "  · 20s → casual, internet-fluent (\"ngl\", \"deadass\", \"like literally\", "
        "\"no cap\"), references TikTok / Discord / Reddit\n"
        "  · 30–40s → measured but with feeling (\"honestly\", \"kinda exhausting\", "
        "\"I just hope they actually...\")\n"
        "  · 50–60s → folksy, more direct (\"I'll tell ya\", \"about had it\", "
        "\"in my day\")\n"
        "  · 65+ → traditional cadence, mentions grandkids / retirement / "
        "what the country used to be like\n"
        "- Include concrete daily-life details: where they shop, what their commute "
        "is like, what they eat or drink, who they spend time with, what they "
        "complain about (gas prices, groceries, schools, healthcare).\n"
        "- Avoid clichés (\"I care about my community\"). Show specific opinions and "
        "everyday frustrations.\n"
        "- Politics must be woven naturally into the daily-life description — never "
        "say \"I support party X\" directly. Hint at it through what they read, "
        "what bothers them, who they trust.\n\n"

        "[Opening examples — for STYLE only, do NOT copy verbatim]\n"
        "- \"Honestly, after 22 years driving truck out of the Allentown terminal, "
        "I've seen this state change hands more times than I can count.\"\n"
        "- \"Most mornings I'm at the diner on Liberty Ave by 6:30, coffee in hand, "
        "scrolling through whatever Fox is showing on the TV above the counter.\"\n"
        "- \"I teach high school English in a Philly burb and the curriculum fights "
        "this past year? Lord. I just want to teach Gatsby in peace.\"\n"
        "- \"Retired steel worker, born and raised in Beaver County. My grandkids "
        "live in Pittsburgh now and we don't agree on much politically, but we "
        "still get together every Sunday.\"\n"
        "- \"Grad student at Penn State, coffee addict, doomscroll Reddit way too "
        "much. Rent's killing me and I'm not even in a good apartment.\"\n\n"

        "If the input data includes district_stats (per-county statistics), let "
        "those numbers shape the persona naturally — don't quote them.\n\n"

        "[Personality dimensions — important]\n"
        "The data includes four personality dimensions; weave them into voice and "
        "content:\n"
        "- expressiveness: highly expressive → talkative, lots of detail; "
        "reserved → terse, understated\n"
        "- emotional_stability: stable → measured, rational; volatile → reactive, "
        "emotionally charged\n"
        "- sociability: extroverted → mentions gatherings, group activities; "
        "introverted → solo activities, small circle\n"
        "- openness: open → curious about other viewpoints; closed → fixed "
        "convictions, suspicious of change\n"
        "These should feel implicit, never labeled.\n\n"

        f"Infer this person's main news habits (media_habit). Pick from: "
        f"{US_MEDIA_OPTIONS}. Choose at most 3, comma-separated.\n\n"

        f"Infer this person's political leaning. Pick exactly ONE from: "
        f"{US_LEANING_OPTIONS}.\n"
        "  · Solid Dem  = consistently votes Democratic, progressive worldview\n"
        "  · Lean Dem   = generally votes Democratic but has crossed over before\n"
        "  · Tossup     = true swing voter, decides race-by-race\n"
        "  · Lean Rep   = generally votes Republican but has crossed over before\n"
        "  · Solid Rep  = consistently votes Republican, conservative worldview\n\n"

        "Return ONLY a JSON object — no extra commentary. The user_char value "
        "must end with a complete sentence.\n"
        '{"user_char": "(100-180 words, first-person, vivid, US-grounded)", '
        '"media_habit": "outlet1, outlet2, outlet3", '
        f'"political_leaning": "(one of: {US_LEANING_OPTIONS})"}}'
    )


# Convenience: pre-built default for the most common use case.
DEFAULT_PERSONA_PROMPT_EN = build_persona_prompt_en("Pennsylvania")
