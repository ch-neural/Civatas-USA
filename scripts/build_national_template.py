"""Build US national presidential templates by aggregating ACS + Cook PVI.

Produces two files in data/templates/:

  presidential_national_generic.json
    - Generic two-party + Independent candidates ("Generic Democrat" /
      "Generic Republican" / "Generic Independent")
    - All 50 states + DC, all 3,142 counties, population-weighted
    - Cook PVI from 2020+2024 average
    - Default calibration params + macro context tuned for US presidential
    - Use this for "what-if" scenarios in any future cycle

  presidential_2024.json
    - Specific cycle: Donald Trump (R, 47th president, 2024 incumbent challenger)
      vs Kamala Harris (D, sitting VP)
    - Same demographic backbone as the generic template
    - Candidates carry the actual party labels and incumbency state for the
      2024 cycle
    - Use this for "rerun history" / calibration against the 2024 ground truth

Both templates carry demographics under `dimensions` plus an optional
`election` block:

  {
    ...existing fields (name, region, country, locale, target_count,
    metadata, dimensions)...,

    "election": {
      "type": "presidential",
      "scope": "national",
      "cycle": null | 2024,
      "is_generic": bool,
      "candidates": [
        {"id", "name", "party": "D"|"R"|"I", "party_label",
         "is_incumbent", "color", "description"}
      ],
      "party_palette": {"D": [colors], "R": [colors], "I": [colors]},
      "party_detection": {"D": [patterns], "R": [...], "I": [...]},
      "default_macro_context": {"en": ..., "zh-TW": ...},
      "default_search_keywords": {"local": ..., "national": ...},
      "default_calibration_params": {news_impact, decay_rate_mult, ...},
      "default_kol": {enabled, ratio, reach},
      "default_poll_groups": [{id, name, weight}],
      "party_base_scores": {"D": 50, "R": 50, "I": 25}
    }
  }

The `election` block is OPTIONAL — templates without it still load; the
panels fall back to the generic US defaults defined in `template-defaults.ts`.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CENSUS = ROOT / "data" / "census"
ELEC = ROOT / "data" / "elections"
TPL = ROOT / "data" / "templates"

# ── Sub-utilities ────────────────────────────────────────────────────


def round_weights(weighted: list[tuple[str, float]]) -> list[dict]:
    """Normalize and round weights to 4 dp; absorb residual into the largest."""
    total = sum(w for _, w in weighted)
    if total == 0:
        return [{"value": v, "weight": 0.0} for v, _ in weighted]
    rounded = [(v, round(w / total, 4)) for v, w in weighted]
    diff = round(1.0 - sum(w for _, w in rounded), 4)
    if diff != 0 and rounded:
        idx = max(range(len(rounded)), key=lambda i: rounded[i][1])
        v, w = rounded[idx]
        rounded[idx] = (v, round(w + diff, 4))
    return [{"value": v, "weight": w} for v, w in rounded]


def pvi_bucket(pvi: float) -> str:
    """5-way Cook-style bucket from continuous PVI."""
    n = pvi * 100
    if n >= 15:
        return "Solid Dem"
    if n >= 5:
        return "Lean Dem"
    if n > -5:
        return "Tossup"
    if n > -15:
        return "Lean Rep"
    return "Solid Rep"


# ── National aggregation ─────────────────────────────────────────────


def sum_field(entries: list[dict], path: str) -> float:
    """Sum a nested numeric field over a list of entries. path = 'sex.male'."""
    keys = path.split(".")
    total = 0.0
    for e in entries:
        node = e
        ok = True
        for k in keys:
            if not isinstance(node, dict) or k not in node:
                ok = False
                break
            node = node[k]
        if ok and isinstance(node, (int, float)):
            total += float(node)
    return total


def build_national_dimensions(counties: list[dict], leaning: dict) -> tuple[dict, dict]:
    """Aggregate all counties into national dimensions. Returns (dims, summary)."""
    pop_total = sum_field(counties, "population_total")

    # ── Gender ──
    male = sum_field(counties, "sex.male")
    female = sum_field(counties, "sex.female")
    gender_dim = {
        "type": "categorical",
        "categories": round_weights([("Male", male), ("Female", female)]),
    }

    # ── Age ──
    age_keys = [
        ("Under 18", "age.under_18"),
        ("18-24", "age.18_24"),
        ("25-34", "age.25_34"),
        ("35-44", "age.35_44"),
        ("45-54", "age.45_54"),
        ("55-64", "age.55_64"),
        ("65+", "age.65_plus"),
    ]
    age_totals = [(label, sum_field(counties, p)) for label, p in age_keys]
    age_dim = {
        "type": "range",
        "bins": [
            {"range": label, "weight": round(v / pop_total, 4) if pop_total else 0.0}
            for label, v in age_totals
        ],
    }
    s = sum(b["weight"] for b in age_dim["bins"]) or 1
    for b in age_dim["bins"]:
        b["weight"] = round(b["weight"] / s, 4)

    # ── State (use state_po as the value, weighted by county population) ──
    state_pop: dict[str, float] = {}
    for c in counties:
        sp = c.get("state_po") or "??"
        state_pop[sp] = state_pop.get(sp, 0.0) + (c.get("population_total") or 0.0)
    state_dim = {
        "type": "categorical",
        "categories": round_weights(
            sorted(state_pop.items(), key=lambda kv: -kv[1])
        ),
    }

    # ── Education (25+) ──
    edu_keys = [
        ("Less than High School", "education_25plus.less_than_high_school"),
        ("High School Graduate", "education_25plus.high_school"),
        ("Some College / Associate", "education_25plus.some_college_or_associate"),
        ("Bachelor's or Higher", "education_25plus.bachelors_or_higher"),
    ]
    edu_dim = {
        "type": "categorical",
        "categories": round_weights([(lbl, sum_field(counties, p)) for lbl, p in edu_keys]),
    }

    # ── Party lean — discretize PVI into 5 buckets, weighted by latest cycle turnout ──
    bucket_weight: dict[str, float] = {
        "Solid Dem": 0.0, "Lean Dem": 0.0, "Tossup": 0.0,
        "Lean Rep": 0.0, "Solid Rep": 0.0,
    }
    state_pvi_weighted = 0.0
    state_pvi_denom = 0.0
    counties_with_lean = 0
    for c in counties:
        fips = c["fips"]
        lp = leaning["counties"].get(fips)
        if not lp:
            continue
        # Use the latest available cycle for turnout weighting
        cycles_available = sorted(lp.get("cycles", {}).keys(), reverse=True)
        latest_cycle = lp["cycles"].get(cycles_available[0], {}) if cycles_available else {}
        turnout = (latest_cycle.get("dem", 0) + latest_cycle.get("rep", 0)) or 0
        bucket_weight[pvi_bucket(lp["pvi"])] += turnout
        state_pvi_weighted += lp["pvi"] * turnout
        state_pvi_denom += turnout
        counties_with_lean += 1

    party_lean_dim = {
        "type": "categorical",
        "categories": round_weights(list(bucket_weight.items())),
    }
    national_pvi = state_pvi_weighted / state_pvi_denom if state_pvi_denom else 0.0
    national_pvi_label = (
        f"D+{round(national_pvi * 100)}" if national_pvi > 0
        else f"R+{abs(round(national_pvi * 100))}" if national_pvi < 0
        else "Even"
    )

    # ── Employment status (16+) ──
    emp_keys = [
        ("Employed", "employment.civilian_employed"),
        ("Unemployed", "employment.civilian_unemployed"),
        ("Armed Forces", "employment.armed_forces"),
        ("Not in Labor Force", "employment.not_in_labor_force"),
    ]
    emp_dim = {
        "type": "categorical",
        "categories": round_weights([(lbl, sum_field(counties, p)) for lbl, p in emp_keys]),
    }

    # ── Tenure ──
    tenure_dim = {
        "type": "categorical",
        "categories": round_weights([
            ("Owner", sum_field(counties, "tenure.owner_occupied")),
            ("Renter", sum_field(counties, "tenure.renter_occupied")),
        ]),
    }

    # ── Media habit (Pew 2023 News Platform Fact Sheet defaults) ──
    media_dim = {
        "type": "categorical",
        "categories": [
            {"value": "TV News (Local + Cable)", "weight": 0.30},
            {"value": "Social Media (Facebook / X / TikTok)", "weight": 0.25},
            {"value": "News Websites / Apps", "weight": 0.20},
            {"value": "YouTube", "weight": 0.15},
            {"value": "Podcasts / Radio", "weight": 0.05},
            {"value": "Print Newspaper", "weight": 0.05},
        ],
    }

    # ── Race (B02001) ──
    race_keys = [
        ("White", "race.white"),
        ("Black or African American", "race.black"),
        ("Asian", "race.asian"),
        ("American Indian / Alaska Native", "race.american_indian"),
        ("Native Hawaiian / Pacific Islander", "race.pacific_islander"),
        ("Other", "race.other"),
        ("Two or More Races", "race.two_or_more"),
    ]
    race_dim = {
        "type": "categorical",
        "categories": round_weights([(lbl, sum_field(counties, p)) for lbl, p in race_keys]),
    }

    # ── Hispanic / Latino (B03003) ──
    hisp_total = sum(c.get("hispanic_or_latino", 0) or 0 for c in counties)
    non_hisp_total = sum(c.get("not_hispanic_or_latino", 0) or 0 for c in counties)
    hispanic_dim = {
        "type": "categorical",
        "categories": round_weights([
            ("Hispanic or Latino", hisp_total),
            ("Not Hispanic or Latino", non_hisp_total),
        ]),
    }

    # ── Household income (B19001, 7 brackets) ──
    income_keys = [
        ("Under $25k", "household_income_brackets.lt_25k"),
        ("$25k–$50k", "household_income_brackets.25k_50k"),
        ("$50k–$75k", "household_income_brackets.50k_75k"),
        ("$75k–$100k", "household_income_brackets.75k_100k"),
        ("$100k–$150k", "household_income_brackets.100k_150k"),
        ("$150k–$200k", "household_income_brackets.150k_200k"),
        ("$200k+", "household_income_brackets.gte_200k"),
    ]
    income_dim = {
        "type": "categorical",
        "categories": round_weights([(lbl, sum_field(counties, p)) for lbl, p in income_keys]),
    }

    # ── Household type (B11001) ──
    hh_family = sum(c.get("households", {}).get("family", 0) or 0 for c in counties)
    hh_nonfamily = sum(c.get("households", {}).get("nonfamily", 0) or 0 for c in counties)
    household_type_dim = {
        "type": "categorical",
        "categories": round_weights([
            ("Family Household", hh_family),
            ("Non-Family Household", hh_nonfamily),
        ]),
    }

    dims = {
        "gender": gender_dim,
        "age": age_dim,
        "state": state_dim,
        "race": race_dim,
        "hispanic_or_latino": hispanic_dim,
        "education": edu_dim,
        "household_income": income_dim,
        "household_type": household_type_dim,
        "party_lean": party_lean_dim,
        "employment_status": emp_dim,
        "household_tenure": tenure_dim,
        "media_habit": media_dim,
    }
    summary = {
        "national_pvi": round(national_pvi, 6),
        "national_pvi_label": national_pvi_label,
        "county_count": len(counties),
        "counties_with_lean": counties_with_lean,
        "state_count": len(state_pop),
        "population_total": int(pop_total),
    }
    return dims, summary


# ── Election block builders ──────────────────────────────────────────


# Shared US presidential party palette (5 shades each, base + light/dark/...)
US_PARTY_PALETTE = {
    "D": ["#1e40af", "#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe"],
    "R": ["#7f1d1d", "#ef4444", "#f87171", "#fca5a5", "#fecaca"],
    "I": ["#475569", "#94a3b8", "#cbd5e1", "#e2e8f0", "#f1f5f9"],
}

US_PARTY_DETECTION = {
    "D": [
        "democrat", "democratic", "(d)", " dem", "dem ", "biden", "harris",
        "obama", "clinton", "kerry", "gore",
    ],
    "R": [
        "republican", "(r)", " rep", "rep ", "gop", "trump", "vance",
        "pence", "romney", "mccain", "bush",
    ],
    "I": [
        "independent", "(i)", "libertarian", "green party", "no party",
        "non-affiliated", "kennedy",
    ],
}

# ── Per-context calibration params ──
#
# Each election context has tuned defaults reflecting its political dynamics.
# The Quick Start "Advanced Parameters" panel reads these as initial values.
#
# Key differences:
#   2024 — highly polarized, strong party loyalty, tight echo chambers,
#          harder for agents to shift leaning, fewer undecided
#   2028 — open race (no incumbent), more undecided, weaker party alignment,
#          higher serendipity (voters exploring options)
#   Generic — neutral baseline, moderate across all params
#   State — local news hits harder, slightly tighter echo chambers

_CALIB_COMMON = {
    # Scoring engine internals (not exposed in Quick Start UI)
    "recognition_penalty": 0.10,
    "party_divergence_mult": 0.5,
    "profile_match_mult": 3.0,
    "stature_cap": 12,
    "grassroots_cap": 8,
    "anxiety_sensitivity_mult": 0.15,
    "charm_mult": 8.0,
    "cross_appeal_mult": 0.6,
}

US_CALIB_GENERIC = {
    **_CALIB_COMMON,
    # News impact & echo chamber
    "news_impact": 2.0,
    "serendipity_rate": 0.05,
    "articles_per_agent": 3,
    "forget_rate": 0.15,
    # Emotional response
    "delta_cap_mult": 1.5,
    "decay_rate_mult": 0.5,
    "satisfaction_decay": 0.04,
    "anxiety_decay": 0.05,
    # Undecided & party effects
    "base_undecided": 0.12,
    "max_undecided": 0.45,
    "party_align_bonus": 15,
    "incumbency_bonus": 10,
    # Political leaning shifts
    "enable_dynamic_leaning": True,
    "shift_sat_threshold_low": 20,
    "shift_anx_threshold_high": 80,
    "shift_consecutive_days_req": 5,
    # Individuality & neutral
    "individuality_multiplier": 1.0,
    "neutral_ratio": 0.0,
    # News category mix — no specific candidates, balanced national/local
    "news_mix_candidate": 15,
    "news_mix_national": 35,
    "news_mix_local": 35,
    "news_mix_international": 15,
}

US_CALIB_2024 = {
    **_CALIB_COMMON,
    # 2024: highly polarized — news hits hard, echo chambers tight
    "news_impact": 2.5,
    "serendipity_rate": 0.03,        # strong echo chambers
    "articles_per_agent": 4,          # high-engagement election
    "forget_rate": 0.12,              # slower forgetting (memorable cycle)
    # Emotional response — bigger swings, slower decay
    "delta_cap_mult": 1.8,
    "decay_rate_mult": 0.4,
    "satisfaction_decay": 0.03,
    "anxiety_decay": 0.04,
    # Undecided — fewer undecided, strong party alignment
    "base_undecided": 0.08,
    "max_undecided": 0.35,
    "party_align_bonus": 20,          # high party loyalty
    "incumbency_bonus": 8,            # Biden withdrew → weak incumbency signal
    # Political leaning shifts — harder to shift in polarized environment
    "enable_dynamic_leaning": True,
    "shift_sat_threshold_low": 15,    # need very low satisfaction to shift
    "shift_anx_threshold_high": 85,   # need very high anxiety
    "shift_consecutive_days_req": 7,  # takes longer to shift
    # Individuality
    "individuality_multiplier": 1.0,
    "neutral_ratio": 0.0,
    # News mix — candidate-heavy for specific election cycle
    "news_mix_candidate": 35,
    "news_mix_national": 30,
    "news_mix_local": 25,
    "news_mix_international": 10,
}

US_CALIB_2028 = {
    **_CALIB_COMMON,
    # 2028: open race — more exploration, weaker party allegiance
    "news_impact": 1.8,               # less nationalized attention early
    "serendipity_rate": 0.08,         # voters exploring candidates
    "articles_per_agent": 3,
    "forget_rate": 0.18,              # faster forgetting (less memorable)
    # Emotional response — moderate
    "delta_cap_mult": 1.4,
    "decay_rate_mult": 0.5,
    "satisfaction_decay": 0.045,
    "anxiety_decay": 0.05,
    # Undecided — many undecided, weaker party pull
    "base_undecided": 0.20,           # open race = lots of undecided
    "max_undecided": 0.55,
    "party_align_bonus": 12,          # weaker party loyalty (primary dynamics)
    "incumbency_bonus": 0,            # no incumbent running
    # Political leaning shifts — easier to shift
    "enable_dynamic_leaning": True,
    "shift_sat_threshold_low": 25,    # easier to trigger
    "shift_anx_threshold_high": 75,
    "shift_consecutive_days_req": 4,
    # Individuality
    "individuality_multiplier": 1.1,  # more individual variation
    "neutral_ratio": 0.05,            # small bump to neutral pool
    # News mix — many candidates, lots of exploration
    "news_mix_candidate": 30,
    "news_mix_national": 30,
    "news_mix_local": 25,
    "news_mix_international": 15,
}

US_CALIB_STATE = {
    **_CALIB_COMMON,
    # State-level: local news has outsized impact, tighter communities
    "news_impact": 2.2,               # local news hits harder
    "serendipity_rate": 0.04,         # tighter local echo chambers
    "articles_per_agent": 3,
    "forget_rate": 0.14,
    # Emotional response
    "delta_cap_mult": 1.6,
    "decay_rate_mult": 0.5,
    "satisfaction_decay": 0.04,
    "anxiety_decay": 0.05,
    # Undecided & party effects
    "base_undecided": 0.10,
    "max_undecided": 0.40,
    "party_align_bonus": 18,
    "incumbency_bonus": 8,
    # Political leaning shifts
    "enable_dynamic_leaning": True,
    "shift_sat_threshold_low": 20,
    "shift_anx_threshold_high": 80,
    "shift_consecutive_days_req": 5,
    # Individuality
    "individuality_multiplier": 1.0,
    "neutral_ratio": 0.0,
    # News mix — state-level: heavy on local news
    "news_mix_candidate": 20,
    "news_mix_national": 25,
    "news_mix_local": 45,
    "news_mix_international": 10,
}

# Backward-compat alias used by build_state_template.py
US_PRES_CALIB_DEFAULTS = US_CALIB_GENERIC

US_DEFAULT_KOL = {"enabled": False, "ratio": 0.05, "reach": 0.40}

# Default poll groups for US presidential — single "Likely Voters" group.
# Multi-group setups (e.g. Likely Voters / Registered Voters / All Adults
# splits) are easy to add later via the prediction panel UI.
US_DEFAULT_POLL_GROUPS = [
    {"id": "likely_voters", "name": "Likely Voters", "weight": 100}
]

# Party base scores for the calibration scoring engine.
# Even D/R since Cook PVI already encodes the partisan tilt at the county
# level; the engine uses these as a starting "baseline support" before
# applying news/event modifiers. Independents start lower because they
# typically poll in single digits in US presidential races.
US_PARTY_BASE_SCORES = {"D": 50, "R": 50, "I": 25}

# Default Evolution-panel parameters for US presidential simulations.
# These seed the Historical Evolution panel's numeric controls when a US
# template is first loaded into a workspace. Tuned for a 60-day simulation
# window with news search every 3 days, moderate volatility, and a
# neutral-ratio that matches typical US two-party-with-undecideds polling.
US_DEFAULT_EVOLUTION_PARAMS = {
    "sim_days": 60,
    "search_interval": 3,
    "use_dynamic_search": True,
    "neutral_ratio": 0.10,
    "delta_cap_mult": 1.5,
    "individuality_mult": 1.0,
    "concurrency": 5,
}

# Default alignment-target settings. US templates don't currently integrate
# with the TW election DB, so we leave alignment off — users can still pick
# a satisfaction-survey alignment target if they want.
US_DEFAULT_ALIGNMENT = {"mode": "none"}


def build_election_generic() -> dict:
    return {
        "type": "presidential",
        "scope": "national",
        "cycle": None,
        "is_generic": True,
        "candidates": [
            {
                "id": "D",
                "name": "Generic Democrat",
                "party": "D",
                "party_label": "Democratic",
                "is_incumbent": False,
                "color": US_PARTY_PALETTE["D"][1],
                "description": "Generic Democratic nominee. Use this slot to test scenarios "
                               "without committing to a specific candidate profile.",
            },
            {
                "id": "R",
                "name": "Generic Republican",
                "party": "R",
                "party_label": "Republican",
                "is_incumbent": False,
                "color": US_PARTY_PALETTE["R"][1],
                "description": "Generic Republican nominee. Use this slot to test scenarios "
                               "without committing to a specific candidate profile.",
            },
            {
                "id": "I",
                "name": "Generic Independent",
                "party": "I",
                "party_label": "Independent",
                "is_incumbent": False,
                "color": US_PARTY_PALETTE["I"][1],
                "description": "Generic third-party / independent candidate. Typically polls "
                               "in single digits but can affect margin in close states.",
            },
        ],
        "party_palette": US_PARTY_PALETTE,
        "party_detection": US_PARTY_DETECTION,
        "default_macro_context": {
            "en": (
                "[Federal context — generic two-party scenario]\n"
                "This template models a generic US presidential race without committing "
                "to a specific incumbent. Adjust the macro context to match the cycle "
                "you want to simulate.\n\n"
                "Responsibility attribution principles:\n"
                "- National issues (inflation, gas prices, foreign policy, immigration, "
                "the economy) → typically pinned on whichever party holds the White House\n"
                "- State / local issues (housing costs, public safety, schools) → pinned "
                "on the in-state governing party"
            ),
            "zh-TW": (
                "【聯邦背景 — 兩黨通用情境】\n"
                "本 template 模擬一場通用的美國總統選舉，未指定執政黨。請根據您想模擬的"
                "週期調整此 macro context。\n\n"
                "責任歸屬原則：\n"
                "- 全國性議題（通膨、油價、外交、移民、經濟）→ 通常歸咎執政黨\n"
                "- 州 / 地方議題（住房、治安、教育）→ 歸咎州內執政黨"
            ),
        },
        "default_search_keywords": {
            "local": (
                "swing state polling\n"
                "Pennsylvania Michigan Wisconsin election\n"
                "Georgia Arizona Nevada North Carolina"
            ),
            "national": (
                "US presidential election polling\n"
                "inflation economy gas prices voters\n"
                "immigration border policy\n"
                "abortion rights post-Dobbs\n"
                "healthcare costs affordability"
            ),
        },
        "default_calibration_params": US_CALIB_GENERIC,
        "default_kol": US_DEFAULT_KOL,
        "default_poll_groups": US_DEFAULT_POLL_GROUPS,
        "party_base_scores": US_PARTY_BASE_SCORES,
        "default_evolution_params": US_DEFAULT_EVOLUTION_PARAMS,
        "default_alignment": US_DEFAULT_ALIGNMENT,
    }


def build_election_2024() -> dict:
    """Donald Trump (R) vs Kamala Harris (D) — actual 2024 cycle.

    Note: At the time the 2020+2024 PVI averaging was computed, Joe Biden was
    the sitting president; Kamala Harris became the Democratic nominee after
    he withdrew in July 2024. Trump was the 2024 challenger and is now the
    47th president (sworn in Jan 2025). For calibration purposes the
    `is_incumbent` flag here marks Trump as NOT incumbent (he was the
    challenger DURING the 2024 cycle); flip if rerunning post-inauguration.
    """
    return {
        "type": "presidential",
        "scope": "national",
        "cycle": 2024,
        "is_generic": False,
        "candidates": [
            {
                "id": "harris_2024",
                "name": "Kamala Harris",
                "party": "D",
                "party_label": "Democratic",
                "is_incumbent": True,  # sitting VP under Biden during the 2024 cycle
                "color": US_PARTY_PALETTE["D"][1],
                "description": (
                    "Sitting Vice President under Biden. Became the Democratic "
                    "nominee in July 2024 after Biden withdrew. Lost the general "
                    "election; Trump won 312 electoral votes to her 226."
                ),
            },
            {
                "id": "trump_2024",
                "name": "Donald Trump",
                "party": "R",
                "party_label": "Republican",
                "is_incumbent": False,  # challenger during the 2024 cycle
                "color": US_PARTY_PALETTE["R"][1],
                "description": (
                    "Republican nominee, 45th president (2017-2021), challenger "
                    "in 2024. Won the 2024 election with 312 electoral votes. "
                    "Sworn in as 47th president January 2025."
                ),
            },
        ],
        "party_palette": US_PARTY_PALETTE,
        "party_detection": US_PARTY_DETECTION,
        "default_macro_context": {
            "en": (
                "[2024 US presidential election — actual cycle]\n"
                "Joe Biden is the incumbent president (Democratic). Kamala Harris is the "
                "sitting Vice President and became the Democratic nominee in July 2024 "
                "after Biden's withdrawal. Donald Trump is the Republican nominee and "
                "the 45th president (2017-2021).\n\n"
                "Major issues driving the 2024 race:\n"
                "- Inflation and grocery / gas prices (peaked in 2022, still elevated in 2024)\n"
                "- Immigration and the southern border\n"
                "- Abortion rights post-Dobbs (June 2022 Supreme Court decision)\n"
                "- January 6 prosecutions and Trump's legal cases\n"
                "- Foreign policy: Ukraine war, Israel-Gaza conflict\n\n"
                "Responsibility attribution: as the incumbent Democratic administration, "
                "the Biden-Harris team is on the defensive about inflation and the border. "
                "Trump campaigns on a 'restoration' message."
            ),
            "zh-TW": (
                "【2024 美國總統大選 — 實際週期】\n"
                "Joe Biden 為現任總統（民主黨）。Kamala Harris 為現任副總統，於 2024 年 "
                "7 月 Biden 退選後成為民主黨提名人。Donald Trump 為共和黨提名人，曾任第 "
                "45 任總統（2017-2021）。\n\n"
                "2024 大選主要議題：\n"
                "- 通膨與生活物資 / 油價（2022 達峰，2024 仍高）\n"
                "- 移民與南方邊境\n"
                "- 後 Dobbs 案的墮胎權（2022 年 6 月最高法院判決）\n"
                "- 1/6 起訴與 Trump 的法律案件\n"
                "- 外交政策：烏俄戰爭、以哈衝突\n\n"
                "責任歸屬：身為現任民主黨政府，Biden-Harris 團隊在通膨與邊境問題上處於"
                "守勢。Trump 以「復興」為主軸競選。"
            ),
        },
        "default_search_keywords": {
            "local": (
                "Harris Trump swing state polling\n"
                "Pennsylvania Michigan Wisconsin election 2024\n"
                "Georgia Arizona Nevada North Carolina"
            ),
            "national": (
                "Harris Trump 2024 election\n"
                "inflation economy gas prices voters\n"
                "Biden withdrawal Harris nomination\n"
                "abortion rights Dobbs 2024\n"
                "January 6 Trump trials"
            ),
        },
        "default_calibration_params": US_CALIB_2024,
        "default_kol": US_DEFAULT_KOL,
        "default_poll_groups": US_DEFAULT_POLL_GROUPS,
        "party_base_scores": US_PARTY_BASE_SCORES,
        "default_evolution_params": US_DEFAULT_EVOLUTION_PARAMS,
        "default_alignment": US_DEFAULT_ALIGNMENT,
        # 2024-specific absolute window: 6 months before election day → election day.
        # Generic templates leave this off, falling back to "1 year ago → today".
        "default_evolution_window": {
            "start_date": "2024-05-05",
            "end_date":   "2024-11-05",
        },
    }


def build_election_2028() -> dict:
    """2028 US Presidential — potential candidates for future scenario simulation."""
    return {
        "type": "presidential",
        "scope": "national",
        "cycle": 2028,
        "is_generic": False,
        "candidates": [
            {
                "id": "vance_2028",
                "name": "JD Vance",
                "party": "R",
                "party_label": "Republican",
                "is_incumbent": True,
                "color": US_PARTY_PALETTE["R"][1],
                "description": (
                    "Sitting Vice President under Trump (2025-). Former US Senator "
                    "from Ohio. Author of 'Hillbilly Elegy'. Likely Republican "
                    "frontrunner if Trump endorses."
                ),
            },
            {
                "id": "newsom_2028",
                "name": "Gavin Newsom",
                "party": "D",
                "party_label": "Democratic",
                "is_incumbent": False,
                "color": US_PARTY_PALETTE["D"][1],
                "description": (
                    "Governor of California (2019-). Former Mayor of San Francisco. "
                    "High national profile, frequent media presence. Progressive "
                    "policy record on climate, immigration, gun control."
                ),
            },
            {
                "id": "desantis_2028",
                "name": "Ron DeSantis",
                "party": "R",
                "party_label": "Republican",
                "is_incumbent": False,
                "color": US_PARTY_PALETTE["R"][0],
                "description": (
                    "Governor of Florida (2019-). Ran in 2024 Republican primary. "
                    "Known for anti-'woke' policies, COVID reopening stance, "
                    "immigration enforcement."
                ),
            },
            {
                "id": "whitmer_2028",
                "name": "Gretchen Whitmer",
                "party": "D",
                "party_label": "Democratic",
                "is_incumbent": False,
                "color": US_PARTY_PALETTE["D"][0],
                "description": (
                    "Governor of Michigan (2019-). Key swing-state executive. "
                    "Known for Midwest pragmatism, reproductive rights advocacy, "
                    "infrastructure investment."
                ),
            },
            {
                "id": "haley_2028",
                "name": "Nikki Haley",
                "party": "R",
                "party_label": "Republican",
                "is_incumbent": False,
                "color": US_PARTY_PALETTE["R"][2],
                "description": (
                    "Former Governor of South Carolina, former UN Ambassador under "
                    "Trump. Strong 2024 primary showing. Positioned as moderate-"
                    "conservative alternative."
                ),
            },
            {
                "id": "shapiro_2028",
                "name": "Josh Shapiro",
                "party": "D",
                "party_label": "Democratic",
                "is_incumbent": False,
                "color": US_PARTY_PALETTE["D"][2],
                "description": (
                    "Governor of Pennsylvania (2023-). Former Attorney General. "
                    "Key swing-state figure. Centrist Democrat with bipartisan "
                    "appeal."
                ),
            },
        ],
        "party_palette": US_PARTY_PALETTE,
        "party_detection": US_PARTY_DETECTION,
        "default_macro_context": {
            "en": (
                "[2028 US presidential election — speculative scenario]\n"
                "Donald Trump is the sitting 47th president (Republican, term-limited). "
                "JD Vance is the sitting Vice President and likely Republican frontrunner.\n\n"
                "Potential Democratic challengers include governors Gavin Newsom (CA), "
                "Gretchen Whitmer (MI), and Josh Shapiro (PA). On the Republican side, "
                "Ron DeSantis (FL) and Nikki Haley may challenge Vance.\n\n"
                "Key issues likely to shape the 2028 race:\n"
                "- Economy, inflation aftermath, national debt\n"
                "- Immigration and border policy legacy\n"
                "- AI and technology regulation\n"
                "- Climate change and energy transition\n"
                "- Foreign policy: Ukraine, China-Taiwan, Middle East\n"
                "- Healthcare costs and insurance access\n"
                "- Social Security and Medicare solvency"
            ),
            "zh-TW": (
                "【2028 美國總統大選 — 假設情境】\n"
                "Donald Trump 為現任第 47 屆總統（共和黨，任期限制）。"
                "JD Vance 為現任副總統，可能的共和黨領跑者。\n\n"
                "潛在民主黨挑戰者包括加州州長 Gavin Newsom、密西根州長 "
                "Gretchen Whitmer、賓州州長 Josh Shapiro。共和黨方面，"
                "Ron DeSantis 和 Nikki Haley 可能挑戰 Vance。\n\n"
                "2028 大選可能的主要議題：\n"
                "- 經濟、通膨後遺症、國債\n"
                "- 移民與邊境政策\n"
                "- AI 與科技監管\n"
                "- 氣候變遷與能源轉型\n"
                "- 外交：烏克蘭、台海、中東\n"
                "- 醫療費用與保險\n"
                "- 社會安全與聯邦醫療保險"
            ),
        },
        "default_search_keywords": {
            "local": (
                "2028 election swing state polling\n"
                "Pennsylvania Michigan Wisconsin Arizona Georgia\n"
                "governor race state politics 2028"
            ),
            "national": (
                "2028 presidential election candidates\n"
                "Vance Newsom DeSantis Whitmer 2028\n"
                "economy jobs AI regulation voters\n"
                "immigration border policy debate\n"
                "Social Security Medicare reform"
            ),
        },
        "default_calibration_params": US_CALIB_2028,
        "default_kol": US_DEFAULT_KOL,
        "default_poll_groups": US_DEFAULT_POLL_GROUPS,
        "party_base_scores": {"D": 50, "R": 50, "I": 20},
        "default_evolution_params": US_DEFAULT_EVOLUTION_PARAMS,
        "default_alignment": US_DEFAULT_ALIGNMENT,
        "default_evolution_window": {
            "start_date": "2027-11-03",
            "end_date": "2028-11-02",
        },
    }


# ── Top-level builder ────────────────────────────────────────────────


def build_template(name: str, name_zh: str, dims: dict, summary: dict, election: dict) -> dict:
    return {
        "name": name,
        "name_zh": name_zh,
        "region": "United States",
        "region_code": "US",
        "fips": "00",
        "country": "US",
        "locale": "en-US",
        "target_count": 100,
        "metadata": {
            "source": {
                "demographics": "ACS 2024 5-year (via censusreporter.org)",
                "elections": "MEDSL countypres_2000-2024 (Harvard Dataverse)",
                "leaning": "Cook PVI computed from 2020+2024 two-party share",
            },
            "national_pvi": summary["national_pvi"],
            "national_pvi_label": summary["national_pvi_label"],
            "county_count": summary["county_count"],
            "counties_with_lean": summary["counties_with_lean"],
            "state_count": summary["state_count"],
            "population_total": summary["population_total"],
        },
        "dimensions": dims,
        "election": election,
    }


def main() -> int:
    TPL.mkdir(parents=True, exist_ok=True)

    counties_all = json.loads((CENSUS / "counties.json").read_text())
    leaning = json.loads((ELEC / "leaning_profile_us.json").read_text())

    # All counties (sorted by population for stable category ordering)
    counties = sorted(
        counties_all.values(),
        key=lambda c: -(c.get("population_total") or 0),
    )
    print(f"US: aggregating {len(counties)} counties across {len({c.get('state_po') for c in counties})} states/territories")
    pop_total = sum_field(counties, "population_total")
    print(f"  population total: {pop_total:,.0f}")

    dims, summary = build_national_dimensions(counties, leaning)

    print(f"  national PVI (turnout-weighted 2024): {summary['national_pvi_label']}  ({summary['national_pvi']:+.4f})")
    print(f"  party_lean buckets:")
    for cat in dims["party_lean"]["categories"]:
        print(f"    {cat['value']:>10}  {cat['weight']:.4f}")

    # ── Generic template ──
    generic = build_template(
        name="US Presidential — National (Generic)",
        name_zh="美國總統大選 — 全國（通用兩黨）",
        dims=dims,
        summary=summary,
        election=build_election_generic(),
    )
    out_generic = TPL / "presidential_national_generic.json"
    out_generic.write_text(json.dumps(generic, indent=2, ensure_ascii=False))
    print(f"  -> {out_generic.relative_to(ROOT)}")

    # ── 2024 cycle template (PVI from 2016+2020 — pre-election, no future data) ──
    leaning_2024 = ELEC / "leaning_profile_us_2016_2020.json"
    if leaning_2024.exists():
        leaning_pre = json.loads(leaning_2024.read_text())
        dims_2024, summary_2024 = build_national_dimensions(counties, leaning_pre)
        summary_2024["source"] = {
            "demographics": "ACS 2024 5-year (via censusreporter.org)",
            "elections": "MEDSL countypres_2000-2024 (Harvard Dataverse)",
            "leaning": "Cook PVI computed from 2016+2020 two-party share",
        }
        election_2024 = build_election_2024()
        election_2024["default_evolution_window"] = {
            "start_date": "2023-11-05",
            "end_date": "2024-11-04",
        }
        cycle_2024 = build_template(
            name="US Presidential — 2024 (Trump vs Harris)",
            name_zh="美國總統大選 — 2024（川普 vs 賀錦麗）",
            dims=dims_2024,
            summary=summary_2024,
            election=election_2024,
        )
        cycle_2024["metadata"]["source"] = summary_2024["source"]
        out_2024 = TPL / "presidential_2024.json"
        out_2024.write_text(json.dumps(cycle_2024, indent=2, ensure_ascii=False))
        print(f"  -> {out_2024.relative_to(ROOT)}  (PVI from 2016+2020)")

    # ── 2028 future template ──
    cycle_2028 = build_template(
        name="US Presidential — 2028 (Who's Next?)",
        name_zh="美國總統大選 — 2028（誰是下一位？）",
        dims=dims,
        summary=summary,
        election=build_election_2028(),
    )
    out_2028 = TPL / "presidential_2028.json"
    out_2028.write_text(json.dumps(cycle_2028, indent=2, ensure_ascii=False))
    print(f"  -> {out_2028.relative_to(ROOT)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
