"""Build single-state US presidential templates by aggregating ACS + Cook PVI.

Accepts a `--state PA` arg and produces:

  data/templates/presidential_state_<XX>.json

…where XX is the 2-letter state code (PA, CA, FL, TX, …, DC).

The `--all` flag generates all 51 states (50 + DC) in one pass.

Each output template carries demographics under `dimensions` plus an
optional `election` block (see build_national_template.py for the schema
spec) keyed to the state's PVI and including the state name in the macro
context — useful for state-level prediction runs.

Usage:
  python3 scripts/build_state_template.py --state PA       # one state
  python3 scripts/build_state_template.py --all            # all 51
  python3 scripts/build_state_template.py --state PA --include-counties  # also write per-county detail file
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Reuse the national builder's helpers + election-block constants
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_national_template import (  # noqa: E402
    round_weights,
    pvi_bucket,
    sum_field,
    US_PARTY_PALETTE,
    US_PARTY_DETECTION,
    US_PRES_CALIB_DEFAULTS,
    US_DEFAULT_KOL,
    US_DEFAULT_POLL_GROUPS,
    US_PARTY_BASE_SCORES,
    US_DEFAULT_EVOLUTION_PARAMS,
    US_DEFAULT_ALIGNMENT,
)

ROOT = Path(__file__).resolve().parent.parent
CENSUS = ROOT / "data" / "census"
ELEC = ROOT / "data" / "elections"
TPL = ROOT / "data" / "templates"

# State name + traditional Chinese label (for the bilingual `name_zh`).
# Source: standard USPS state codes + Wikipedia zh-TW state names.
STATE_INFO: dict[str, dict] = {
    "AL": {"fips": "01", "name": "Alabama",         "name_zh": "阿拉巴馬州"},
    "AK": {"fips": "02", "name": "Alaska",          "name_zh": "阿拉斯加州"},
    "AZ": {"fips": "04", "name": "Arizona",         "name_zh": "亞利桑那州"},
    "AR": {"fips": "05", "name": "Arkansas",        "name_zh": "阿肯色州"},
    "CA": {"fips": "06", "name": "California",      "name_zh": "加利福尼亞州"},
    "CO": {"fips": "08", "name": "Colorado",        "name_zh": "科羅拉多州"},
    "CT": {"fips": "09", "name": "Connecticut",     "name_zh": "康乃狄克州"},
    "DE": {"fips": "10", "name": "Delaware",        "name_zh": "德拉瓦州"},
    "DC": {"fips": "11", "name": "District of Columbia", "name_zh": "華盛頓特區"},
    "FL": {"fips": "12", "name": "Florida",         "name_zh": "佛羅里達州"},
    "GA": {"fips": "13", "name": "Georgia",         "name_zh": "喬治亞州"},
    "HI": {"fips": "15", "name": "Hawaii",          "name_zh": "夏威夷州"},
    "ID": {"fips": "16", "name": "Idaho",           "name_zh": "愛達荷州"},
    "IL": {"fips": "17", "name": "Illinois",        "name_zh": "伊利諾州"},
    "IN": {"fips": "18", "name": "Indiana",         "name_zh": "印第安納州"},
    "IA": {"fips": "19", "name": "Iowa",            "name_zh": "愛荷華州"},
    "KS": {"fips": "20", "name": "Kansas",          "name_zh": "堪薩斯州"},
    "KY": {"fips": "21", "name": "Kentucky",        "name_zh": "肯塔基州"},
    "LA": {"fips": "22", "name": "Louisiana",       "name_zh": "路易斯安那州"},
    "ME": {"fips": "23", "name": "Maine",           "name_zh": "緬因州"},
    "MD": {"fips": "24", "name": "Maryland",        "name_zh": "馬里蘭州"},
    "MA": {"fips": "25", "name": "Massachusetts",   "name_zh": "麻薩諸塞州"},
    "MI": {"fips": "26", "name": "Michigan",        "name_zh": "密西根州"},
    "MN": {"fips": "27", "name": "Minnesota",       "name_zh": "明尼蘇達州"},
    "MS": {"fips": "28", "name": "Mississippi",     "name_zh": "密西西比州"},
    "MO": {"fips": "29", "name": "Missouri",        "name_zh": "密蘇里州"},
    "MT": {"fips": "30", "name": "Montana",         "name_zh": "蒙大拿州"},
    "NE": {"fips": "31", "name": "Nebraska",        "name_zh": "內布拉斯加州"},
    "NV": {"fips": "32", "name": "Nevada",          "name_zh": "內華達州"},
    "NH": {"fips": "33", "name": "New Hampshire",   "name_zh": "新罕布夏州"},
    "NJ": {"fips": "34", "name": "New Jersey",      "name_zh": "紐澤西州"},
    "NM": {"fips": "35", "name": "New Mexico",      "name_zh": "新墨西哥州"},
    "NY": {"fips": "36", "name": "New York",        "name_zh": "紐約州"},
    "NC": {"fips": "37", "name": "North Carolina",  "name_zh": "北卡羅來納州"},
    "ND": {"fips": "38", "name": "North Dakota",    "name_zh": "北達科他州"},
    "OH": {"fips": "39", "name": "Ohio",            "name_zh": "俄亥俄州"},
    "OK": {"fips": "40", "name": "Oklahoma",        "name_zh": "奧克拉荷馬州"},
    "OR": {"fips": "41", "name": "Oregon",          "name_zh": "奧勒岡州"},
    "PA": {"fips": "42", "name": "Pennsylvania",    "name_zh": "賓夕法尼亞州"},
    "RI": {"fips": "44", "name": "Rhode Island",    "name_zh": "羅德島州"},
    "SC": {"fips": "45", "name": "South Carolina",  "name_zh": "南卡羅來納州"},
    "SD": {"fips": "46", "name": "South Dakota",    "name_zh": "南達科他州"},
    "TN": {"fips": "47", "name": "Tennessee",       "name_zh": "田納西州"},
    "TX": {"fips": "48", "name": "Texas",           "name_zh": "德克薩斯州"},
    "UT": {"fips": "49", "name": "Utah",            "name_zh": "猶他州"},
    "VT": {"fips": "50", "name": "Vermont",         "name_zh": "佛蒙特州"},
    "VA": {"fips": "51", "name": "Virginia",        "name_zh": "維吉尼亞州"},
    "WA": {"fips": "53", "name": "Washington",      "name_zh": "華盛頓州"},
    "WV": {"fips": "54", "name": "West Virginia",   "name_zh": "西維吉尼亞州"},
    "WI": {"fips": "55", "name": "Wisconsin",       "name_zh": "威斯康辛州"},
    "WY": {"fips": "56", "name": "Wyoming",         "name_zh": "懷俄明州"},
}


def build_state_dimensions(state_po: str, counties: list[dict], state: dict, leaning: dict) -> tuple[dict, dict]:
    """Build dimensions for a single state."""
    pop_total = state.get("population_total") or 0

    # ── Gender ──
    dims = {
        "gender": {
            "type": "categorical",
            "categories": round_weights([
                ("Male", state["sex"]["male"] or 0),
                ("Female", state["sex"]["female"] or 0),
            ]),
        }
    }

    # ── Age ──
    age_map = [
        ("Under 18", state["age"]["under_18"]),
        ("18-24", state["age"]["18_24"]),
        ("25-34", state["age"]["25_34"]),
        ("35-44", state["age"]["35_44"]),
        ("45-54", state["age"]["45_54"]),
        ("55-64", state["age"]["55_64"]),
        ("65+", state["age"]["65_plus"]),
    ]
    dims["age"] = {
        "type": "range",
        "bins": [
            {"range": label, "weight": round((v or 0) / (pop_total or 1), 4)}
            for label, v in age_map
        ],
    }
    s = sum(b["weight"] for b in dims["age"]["bins"]) or 1
    for b in dims["age"]["bins"]:
        b["weight"] = round(b["weight"] / s, 4)

    # ── County (population-weighted within the state) ──
    dims["county"] = {
        "type": "categorical",
        "categories": round_weights([
            (c["name"], c["population_total"] or 0) for c in counties
        ]),
    }

    # ── Education (25+) ──
    edu = state["education_25plus"]
    dims["education"] = {
        "type": "categorical",
        "categories": round_weights([
            ("Less than High School", edu["less_than_high_school"] or 0),
            ("High School Graduate", edu["high_school"] or 0),
            ("Some College / Associate", edu["some_college_or_associate"] or 0),
            ("Bachelor's or Higher", edu["bachelors_or_higher"] or 0),
        ]),
    }

    # ── Party lean (5 buckets, weighted by 2024 turnout) ──
    bucket_weight: dict[str, float] = {
        "Solid Dem": 0.0, "Lean Dem": 0.0, "Tossup": 0.0,
        "Lean Rep": 0.0, "Solid Rep": 0.0,
    }
    state_pvi_weighted = 0.0
    state_pvi_denom = 0.0
    for c in counties:
        fips = c["fips"]
        lp = leaning["counties"].get(fips)
        if not lp:
            continue
        cycle24 = lp["cycles"].get("2024", {})
        turnout = (cycle24.get("dem", 0) + cycle24.get("rep", 0)) or 0
        bucket_weight[pvi_bucket(lp["pvi"])] += turnout
        state_pvi_weighted += lp["pvi"] * turnout
        state_pvi_denom += turnout

    dims["party_lean"] = {
        "type": "categorical",
        "categories": round_weights(list(bucket_weight.items())),
    }
    state_pvi = state_pvi_weighted / state_pvi_denom if state_pvi_denom else 0.0
    state_pvi_label = (
        f"D+{round(state_pvi * 100)}" if state_pvi > 0
        else f"R+{abs(round(state_pvi * 100))}" if state_pvi < 0
        else "Even"
    )

    # ── Employment ──
    emp = state["employment"]
    dims["employment_status"] = {
        "type": "categorical",
        "categories": round_weights([
            ("Employed", emp["civilian_employed"] or 0),
            ("Unemployed", emp["civilian_unemployed"] or 0),
            ("Armed Forces", emp["armed_forces"] or 0),
            ("Not in Labor Force", emp["not_in_labor_force"] or 0),
        ]),
    }

    # ── Tenure ──
    ten = state["tenure"]
    dims["household_tenure"] = {
        "type": "categorical",
        "categories": round_weights([
            ("Owner", ten["owner_occupied"] or 0),
            ("Renter", ten["renter_occupied"] or 0),
        ]),
    }

    # ── Race (B02001) ──
    race = state.get("race", {})
    dims["race"] = {
        "type": "categorical",
        "categories": round_weights([
            ("White", race.get("white", 0) or 0),
            ("Black or African American", race.get("black", 0) or 0),
            ("Asian", race.get("asian", 0) or 0),
            ("American Indian / Alaska Native", race.get("american_indian", 0) or 0),
            ("Native Hawaiian / Pacific Islander", race.get("pacific_islander", 0) or 0),
            ("Other", race.get("other", 0) or 0),
            ("Two or More Races", race.get("two_or_more", 0) or 0),
        ]),
    }

    # ── Hispanic / Latino (B03003) ──
    hisp = state.get("hispanic_or_latino", 0) or 0
    non_hisp = state.get("not_hispanic_or_latino", 0) or 0
    dims["hispanic_or_latino"] = {
        "type": "categorical",
        "categories": round_weights([
            ("Hispanic or Latino", hisp),
            ("Not Hispanic or Latino", non_hisp),
        ]),
    }

    # ── Household income (B19001, 7 brackets) ──
    inc = state.get("household_income_brackets", {})
    dims["household_income"] = {
        "type": "categorical",
        "categories": round_weights([
            ("Under $25k", inc.get("lt_25k", 0) or 0),
            ("$25k–$50k", inc.get("25k_50k", 0) or 0),
            ("$50k–$75k", inc.get("50k_75k", 0) or 0),
            ("$75k–$100k", inc.get("75k_100k", 0) or 0),
            ("$100k–$150k", inc.get("100k_150k", 0) or 0),
            ("$150k–$200k", inc.get("150k_200k", 0) or 0),
            ("$200k+", inc.get("gte_200k", 0) or 0),
        ]),
    }

    # ── Household type (B11001) ──
    hh = state.get("households", {})
    dims["household_type"] = {
        "type": "categorical",
        "categories": round_weights([
            ("Family Household", hh.get("family", 0) or 0),
            ("Non-Family Household", hh.get("nonfamily", 0) or 0),
        ]),
    }

    # ── Media habit (Pew defaults) ──
    dims["media_habit"] = {
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

    summary = {
        "state_pvi": round(state_pvi, 6),
        "state_pvi_label": state_pvi_label,
        "county_count": len(counties),
        "population_total": int(pop_total),
    }
    return dims, summary


def build_state_election(state_name: str, state_po: str, pvi_label: str) -> dict:
    """Build the election block for a state-level presidential template."""
    return {
        "type": "presidential",
        "scope": "state",
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
                "description": f"Generic Democratic nominee for {state_name}.",
            },
            {
                "id": "R",
                "name": "Generic Republican",
                "party": "R",
                "party_label": "Republican",
                "is_incumbent": False,
                "color": US_PARTY_PALETTE["R"][1],
                "description": f"Generic Republican nominee for {state_name}.",
            },
            {
                "id": "I",
                "name": "Generic Independent",
                "party": "I",
                "party_label": "Independent",
                "is_incumbent": False,
                "color": US_PARTY_PALETTE["I"][1],
                "description": f"Generic third-party / independent candidate for {state_name}.",
            },
        ],
        "party_palette": US_PARTY_PALETTE,
        "party_detection": US_PARTY_DETECTION,
        "default_macro_context": {
            "en": (
                f"[{state_name} presidential context]\n"
                f"This template models a generic US presidential race within {state_name} "
                f"({state_po}). The state's Cook PVI is {pvi_label} based on 2020+2024 "
                "two-party share averages. Adjust the macro context to match the cycle "
                "and incumbent party you want to simulate.\n\n"
                "Responsibility attribution principles:\n"
                "- National issues (inflation, foreign policy, immigration) → typically "
                "pinned on whichever party holds the White House\n"
                f"- {state_name} state issues → pinned on the in-state governing party"
            ),
            "zh-TW": (
                f"【{state_name}（{state_po}）總統選舉背景】\n"
                f"本 template 模擬一場 {state_name} 內的通用美國總統選舉。該州的 Cook PVI "
                f"為 {pvi_label}（基於 2020 + 2024 兩黨得票率平均）。請依您想模擬的週期"
                "與執政黨調整 macro context。\n\n"
                "責任歸屬原則：\n"
                "- 全國性議題（通膨、外交、移民）→ 通常歸咎執政黨\n"
                f"- {state_name} 州內議題 → 歸咎州內執政黨"
            ),
        },
        "default_search_keywords": {
            "local": (
                f"{state_name} election polling\n"
                f"{state_name} ({state_po}) governor senate\n"
                f"{state_name} economy housing"
            ),
            "national": (
                "US presidential election polling\n"
                "inflation economy gas prices voters\n"
                "immigration border policy\n"
                "abortion rights post-Dobbs"
            ),
        },
        "default_calibration_params": US_PRES_CALIB_DEFAULTS,
        "default_kol": US_DEFAULT_KOL,
        "default_poll_groups": US_DEFAULT_POLL_GROUPS,
        "party_base_scores": US_PARTY_BASE_SCORES,
        "default_evolution_params": US_DEFAULT_EVOLUTION_PARAMS,
        "default_alignment": US_DEFAULT_ALIGNMENT,
    }


def build_one_state(state_po: str, states: dict, counties_all: dict, leaning: dict, write_counties: bool = False) -> Path:
    info = STATE_INFO.get(state_po)
    if not info:
        raise ValueError(f"unknown state code: {state_po}")

    state = states.get(info["fips"])
    if not state:
        raise ValueError(f"state {state_po} (fips {info['fips']}) not in census data")

    state_counties = sorted(
        [c for c in counties_all.values() if c.get("state_po") == state_po],
        key=lambda c: -(c.get("population_total") or 0),
    )

    dims, summary = build_state_dimensions(state_po, state_counties, state, leaning)

    template = {
        "name": f"{info['name']} Sample (US)",
        "name_zh": f"{info['name_zh']}樣本",
        "region": info["name"],
        "region_code": state_po,
        "fips": info["fips"],
        "country": "US",
        "locale": "en-US",
        "target_count": 100,
        "metadata": {
            "source": {
                "demographics": "ACS 2024 5-year (via censusreporter.org)",
                "elections": "MEDSL countypres_2000-2024 (Harvard Dataverse)",
                "leaning": "Cook PVI computed from 2020+2024 two-party share",
            },
            "state_pvi": summary["state_pvi"],
            "state_pvi_label": summary["state_pvi_label"],
            "county_count": summary["county_count"],
            "population_total": summary["population_total"],
        },
        "dimensions": dims,
        "election": build_state_election(info["name"], state_po, summary["state_pvi_label"]),
    }

    out = TPL / f"presidential_state_{state_po}.json"
    out.write_text(json.dumps(template, indent=2, ensure_ascii=False))

    if write_counties:
        per_county = {}
        for c in state_counties:
            fips = c["fips"]
            lp = leaning["counties"].get(fips, {})
            per_county[fips] = {
                "fips": fips,
                "name": c["name"],
                "state_po": state_po,
                "population": c.get("population_total"),
                "pvi": lp.get("pvi"),
                "pvi_label": lp.get("pvi_label"),
                "median_household_income": c.get("median_household_income"),
                "demographics": {
                    "sex": c.get("sex"),
                    "age": c.get("age"),
                    "race": c.get("race"),
                    "hispanic_or_latino": c.get("hispanic_or_latino"),
                    "education_25plus": c.get("education_25plus"),
                    "household_income_brackets": c.get("household_income_brackets"),
                    "employment": c.get("employment"),
                    "tenure": c.get("tenure"),
                    "households": c.get("households"),
                },
                "elections": lp.get("cycles", {}),
            }
        counties_out = TPL / f"presidential_state_{state_po}_counties.json"
        counties_out.write_text(json.dumps(per_county, indent=2, ensure_ascii=False))

    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", help="Two-letter state code (e.g. PA)")
    parser.add_argument("--all", action="store_true", help="Generate all 50 states + DC")
    parser.add_argument("--include-counties", action="store_true",
                        help="Also write per-county detail file (only with --state)")
    args = parser.parse_args()

    if not args.state and not args.all:
        parser.print_help()
        print("\nERROR: pass either --state XX or --all", file=sys.stderr)
        return 1

    TPL.mkdir(parents=True, exist_ok=True)

    states = json.loads((CENSUS / "states.json").read_text())
    counties_all = json.loads((CENSUS / "counties.json").read_text())
    leaning = json.loads((ELEC / "leaning_profile_us.json").read_text())

    if args.all:
        targets = list(STATE_INFO.keys())
    else:
        targets = [args.state.upper()]

    print(f"Generating {len(targets)} state template(s) → data/templates/")
    for state_po in targets:
        try:
            out = build_one_state(
                state_po, states, counties_all, leaning,
                write_counties=args.include_counties and len(targets) == 1,
            )
            n_counties = sum(1 for c in counties_all.values() if c.get("state_po") == state_po)
            print(f"  {state_po}  {STATE_INFO[state_po]['name']:<22}  {n_counties:>3} counties → {out.name}")
        except Exception as e:
            print(f"  {state_po}  ERROR: {e}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
