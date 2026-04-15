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


# State code → (full name, representative cities/regions). Cities are chosen to
# span urban / suburban / rural and Dem / Rep / swing areas of each state, so
# the LLM can pick a believable place even for low-population agents.
US_STATE_PLACES: dict[str, tuple[str, str]] = {
    "AL": ("Alabama", "Birmingham, Montgomery, Mobile, Huntsville, Tuscaloosa, Auburn"),
    "AK": ("Alaska", "Anchorage, Fairbanks, Juneau, Wasilla, the Mat-Su Valley"),
    "AZ": ("Arizona", "Phoenix, Tucson, Mesa, Scottsdale, Flagstaff, Yuma"),
    "AR": ("Arkansas", "Little Rock, Fayetteville, Fort Smith, Jonesboro, Hot Springs"),
    "CA": ("California", "Los Angeles, San Francisco, San Diego, Sacramento, Fresno, Bakersfield, the Central Valley, Orange County, the Bay Area"),
    "CO": ("Colorado", "Denver, Colorado Springs, Aurora, Boulder, Fort Collins, the Western Slope"),
    "CT": ("Connecticut", "Hartford, New Haven, Bridgeport, Stamford, Waterbury"),
    "DE": ("Delaware", "Wilmington, Dover, Newark, Sussex County beach towns"),
    "DC": ("District of Columbia", "Capitol Hill, Anacostia, Georgetown, Shaw, Petworth"),
    "FL": ("Florida", "Miami, Tampa, Orlando, Jacksonville, Fort Lauderdale, the Panhandle, The Villages"),
    "GA": ("Georgia", "Atlanta, Savannah, Augusta, Macon, Athens, Columbus, the Atlanta suburbs (Cobb, Gwinnett)"),
    "HI": ("Hawaii", "Honolulu, Hilo, Kailua-Kona, Pearl City, Kaneohe, Maui's Kahului, the North Shore"),
    "ID": ("Idaho", "Boise, Meridian, Nampa, Idaho Falls, Coeur d'Alene"),
    "IL": ("Illinois", "Chicago, Aurora, Rockford, Naperville, Peoria, Springfield, downstate farm country"),
    "IN": ("Indiana", "Indianapolis, Fort Wayne, Evansville, South Bend, Bloomington, Gary"),
    "IA": ("Iowa", "Des Moines, Cedar Rapids, Davenport, Iowa City, Sioux City, rural farm towns"),
    "KS": ("Kansas", "Wichita, Overland Park, Kansas City KS, Topeka, Lawrence"),
    "KY": ("Kentucky", "Louisville, Lexington, Bowling Green, Owensboro, the Eastern Kentucky coal country"),
    "LA": ("Louisiana", "New Orleans, Baton Rouge, Shreveport, Lafayette, Metairie, the Cajun parishes"),
    "ME": ("Maine", "Portland, Lewiston, Bangor, Augusta, the rural Aroostook County"),
    "MD": ("Maryland", "Baltimore, Bethesda, Silver Spring, Annapolis, the DC suburbs, the Eastern Shore"),
    "MA": ("Massachusetts", "Boston, Worcester, Springfield, Cambridge, the South Shore, the Berkshires, Cape Cod"),
    "MI": ("Michigan", "Detroit, Grand Rapids, Lansing, Ann Arbor, Flint, the U.P., Macomb County"),
    "MN": ("Minnesota", "Minneapolis, Saint Paul, Rochester, Duluth, the Twin Cities suburbs, the Iron Range"),
    "MS": ("Mississippi", "Jackson, Gulfport, Hattiesburg, Tupelo, the Delta region"),
    "MO": ("Missouri", "St. Louis, Kansas City, Springfield, Columbia, Jefferson City, the Ozarks"),
    "MT": ("Montana", "Billings, Missoula, Bozeman, Great Falls, Helena, Flathead County"),
    "NE": ("Nebraska", "Omaha, Lincoln, Bellevue, Grand Island, Kearney"),
    "NV": ("Nevada", "Las Vegas, Henderson, Reno, North Las Vegas, Sparks, Carson City"),
    "NH": ("New Hampshire", "Manchester, Nashua, Concord, Portsmouth, the White Mountains"),
    "NJ": ("New Jersey", "Newark, Jersey City, Paterson, Trenton, Cherry Hill, the Jersey Shore, Bergen County"),
    "NM": ("New Mexico", "Albuquerque, Santa Fe, Las Cruces, Rio Rancho, the Navajo Nation"),
    "NY": ("New York", "New York City (Brooklyn, Queens, the Bronx, Manhattan), Buffalo, Rochester, Syracuse, Albany, Long Island, the Hudson Valley, the Southern Tier"),
    "NC": ("North Carolina", "Charlotte, Raleigh, Greensboro, Durham, the Research Triangle, Asheville, the Piedmont, the eastern tobacco country"),
    "ND": ("North Dakota", "Fargo, Bismarck, Grand Forks, Minot, the Bakken oil patch"),
    "OH": ("Ohio", "Columbus, Cleveland, Cincinnati, Toledo, Akron, Dayton, the Mahoning Valley, Appalachian southeast Ohio"),
    "OK": ("Oklahoma", "Oklahoma City, Tulsa, Norman, Broken Arrow, the rural panhandle"),
    "OR": ("Oregon", "Portland, Salem, Eugene, Bend, Medford, the Willamette Valley, rural eastern Oregon"),
    "PA": ("Pennsylvania", "Philadelphia, Pittsburgh, Allentown, Erie, Lancaster, Scranton, the Lehigh Valley, the Allegheny suburbs, rural Appalachia"),
    "RI": ("Rhode Island", "Providence, Warwick, Cranston, Pawtucket, Newport"),
    "SC": ("South Carolina", "Charleston, Columbia, Greenville, Myrtle Beach, the Lowcountry, the Upstate"),
    "SD": ("South Dakota", "Sioux Falls, Rapid City, Aberdeen, the Black Hills, the Pine Ridge Reservation"),
    "TN": ("Tennessee", "Nashville, Memphis, Knoxville, Chattanooga, the Tri-Cities, rural East Tennessee"),
    "TX": ("Texas", "Houston, Dallas, Austin, San Antonio, Fort Worth, El Paso, the Rio Grande Valley, the Panhandle, East Texas piney woods"),
    "UT": ("Utah", "Salt Lake City, West Valley City, Provo, Ogden, St. George"),
    "VT": ("Vermont", "Burlington, Rutland, Montpelier, the Northeast Kingdom"),
    "VA": ("Virginia", "Richmond, Virginia Beach, Norfolk, Arlington, the NoVA suburbs, the Shenandoah Valley, Southwest Virginia coal country"),
    "WA": ("Washington", "Seattle, Spokane, Tacoma, Vancouver WA, Bellevue, the Eastside, the Yakima Valley"),
    "WV": ("West Virginia", "Charleston, Huntington, Morgantown, Wheeling, the southern coalfields"),
    "WI": ("Wisconsin", "Milwaukee, Madison, Green Bay, Kenosha, the Fox Valley, the Driftless region, rural dairy country"),
    "WY": ("Wyoming", "Cheyenne, Casper, Laramie, Gillette, Jackson"),
}


def state_anchor_block(district: str) -> str:
    """Build a per-agent geography anchor line. Empty string if district isn't a state code."""
    if not district:
        return ""
    code = district.strip().upper()
    place = US_STATE_PLACES.get(code)
    if not place:
        return ""
    full, cities = place
    return (
        f"GEOGRAPHY ANCHOR — REQUIRED (instructions for you, never quote in the output):\n"
        f"This agent lives in {full}. Anchor the persona's daily life — workplace, "
        f"commute, shops, neighborhood, weekend trips — in REAL {full} places. "
        f"Pick from: {cities}. Do NOT mention cities, landmarks, or regions from "
        f"any other state. The voice should feel unmistakably like a {full} resident. "
        f"Do NOT echo, paraphrase, or reference this anchor block in user_char — "
        f"the persona's own narration must read naturally, not like a system note."
    )

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
    # Geography is now anchored per-agent via the GEOGRAPHY ANCHOR block in
    # the user content (see state_anchor_block). The system prompt only needs
    # to enforce the rule, not list cities for one specific state.
    location_cues = (
        "- Each agent's user content begins with a 'GEOGRAPHY ANCHOR — REQUIRED' "
        "block naming the agent's actual state and a curated list of real cities "
        "and regions in that state. You MUST anchor the persona to one of those "
        "places. Do not invent or borrow places from other states. If the anchor "
        "block is missing, default to a generic US setting consistent with the "
        "agent's other demographic data."
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
