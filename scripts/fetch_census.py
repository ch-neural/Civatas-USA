"""Fetch ACS demographic data for all US states + counties via censusreporter.org.

Why censusreporter and not api.census.gov:
  api.census.gov is unreachable from this network. censusreporter mirrors the
  same ACS data, supports comma-separated batch geo_ids, and auto-falls back
  from acs2024_1yr to acs2024_5yr for small geographies (so all 3143 counties
  are covered without separate requests).

Tables fetched (mirrors what Civatas's persona/synthesis services need):
  B01001  Sex by Age                       (49 cols)
  B02001  Race                              (10 cols)
  B03003  Hispanic or Latino origin          (3 cols)
  B11001  Household Type                     (9 cols)
  B15003  Educational Attainment 25+        (25 cols)
  B19001  Household Income brackets         (17 cols)
  B19013  Median Household Income            (1 col)
  B23025  Employment Status                  (7 cols)
  B25003  Tenure (own/rent)                  (3 cols)

Outputs:
  data/census/raw/states.json                  raw API response, all 51 states
  data/census/raw/counties_<batch>.json        raw responses, batches of 50
  data/census/states.json                      cleaned per-state summary
  data/census/counties.json                    cleaned per-county summary (FIPS-keyed)
  data/census/release.json                     ACS release metadata
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CENSUS = ROOT / "data" / "census"
RAW = CENSUS / "raw"
GEO_COUNTIES = ROOT / "data" / "geo" / "us-counties.geojson"
GEO_STATES = ROOT / "data" / "geo" / "us-states.geojson"

API = "https://api.censusreporter.org/1.0/data/show/latest"
TABLES = [
    "B01001",  # Sex by Age
    "B02001",  # Race
    "B03003",  # Hispanic / Latino
    "B11001",  # Household Type
    "B15003",  # Educational Attainment 25+
    "B19001",  # Household Income brackets
    "B19013",  # Median household income
    "B23025",  # Employment Status
    "B25003",  # Tenure
]
BATCH = 50
HEADERS = {
    "User-Agent": "civatas-usa-fetch/0.1 (research; contact: civatas)",
    "Accept": "application/json",
}


def http_get_json(url: str, retries: int = 3) -> dict:
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            # 400 means at least one geo_id is invalid; don't retry, let caller split.
            if e.code == 400:
                raise
            last_err = e
            time.sleep(1.5 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"giving up after {retries}: {last_err}")


# 50 states + DC (FIPS). Excludes territories 60/66/69/72/78 which censusreporter
# does not always cover via acs2024_*.
US_50_DC = {
    "01","02","04","05","06","08","09","10","11","12","13","15","16","17","18",
    "19","20","21","22","23","24","25","26","27","28","29","30","31","32","33",
    "34","35","36","37","38","39","40","41","42","44","45","46","47","48","49",
    "50","51","53","54","55","56",
}

# Connecticut switched from 8 counties to 9 "planning regions" effective with the
# 2022 ACS release. The us-atlas geojson still has the old county codes (09001..),
# so we replace them with the new planning-region codes that censusreporter uses.
CT_OLD = {f"09{c:03d}" for c in (1, 3, 5, 7, 9, 11, 13, 15)}
CT_NEW = ["09110", "09120", "09130", "09140", "09150", "09160", "09170", "09180", "09190"]


def load_county_fips() -> list[str]:
    """All 5-digit county FIPS in 50 states + DC, sourced from us-atlas geojson,
    with Connecticut counties replaced by 2022+ planning regions."""
    data = json.loads(GEO_COUNTIES.read_text())
    fips = set()
    for f in data["features"]:
        fid = f.get("id")
        if fid and len(fid) == 5 and fid.isdigit() and fid[:2] in US_50_DC:
            if fid in CT_OLD:
                continue
            fips.add(fid)
    fips.update(CT_NEW)
    return sorted(fips)


def load_state_fips() -> list[str]:
    return sorted(US_50_DC)


def fetch_batch(geo_ids: list[str]) -> dict:
    geos = ",".join(geo_ids)
    tables = ",".join(TABLES)
    url = f"{API}?table_ids={tables}&geo_ids={geos}"
    return http_get_json(url)


def fetch_batch_tolerant(geo_ids: list[str], bad: list[str]) -> dict:
    """Fetch a batch; on 400 (some geo_id invalid), bisect to isolate bad ids.
    Returns merged response, appends invalid ids to ``bad``."""
    try:
        return fetch_batch(geo_ids)
    except urllib.error.HTTPError as e:
        if e.code != 400:
            raise
        if len(geo_ids) == 1:
            bad.append(geo_ids[0])
            return {"data": {}, "geography": {}, "release": None}
        mid = len(geo_ids) // 2
        a = fetch_batch_tolerant(geo_ids[:mid], bad)
        b = fetch_batch_tolerant(geo_ids[mid:], bad)
        merged = {
            "data": {**a.get("data", {}), **b.get("data", {})},
            "geography": {**a.get("geography", {}), **b.get("geography", {})},
            "release": a.get("release") or b.get("release"),
        }
        return merged


# ---------- table extraction helpers ----------

def _est(d: dict, table: str, col: str) -> float | None:
    try:
        return float(d[table]["estimate"][col])
    except (KeyError, TypeError, ValueError):
        return None


def summarize(geo_data: dict) -> dict:
    """Pull a clean, compact summary from one geography's table block."""
    s: dict = {}

    # Total population
    s["population_total"] = _est(geo_data, "B01001", "B01001001")

    # Sex
    male = _est(geo_data, "B01001", "B01001002")
    female = _est(geo_data, "B01001", "B01001026")
    s["sex"] = {"male": male, "female": female}

    # Age groups (collapse 5-year ACS bins into Civatas-style buckets)
    def sum_cols(table: str, cols: list[str]) -> float | None:
        vals = [_est(geo_data, table, c) for c in cols]
        if any(v is None for v in vals):
            return None
        return sum(vals)

    age = {
        "under_18": sum_cols("B01001", [
            "B01001003","B01001004","B01001005","B01001006",        # M <5..15-17
            "B01001027","B01001028","B01001029","B01001030",        # F <5..15-17
        ]),
        "18_24": sum_cols("B01001", [
            "B01001007","B01001008","B01001009","B01001010",
            "B01001031","B01001032","B01001033","B01001034",
        ]),
        "25_34": sum_cols("B01001", [
            "B01001011","B01001012",
            "B01001035","B01001036",
        ]),
        "35_44": sum_cols("B01001", [
            "B01001013","B01001014",
            "B01001037","B01001038",
        ]),
        "45_54": sum_cols("B01001", [
            "B01001015","B01001016",
            "B01001039","B01001040",
        ]),
        "55_64": sum_cols("B01001", [
            "B01001017","B01001018","B01001019",
            "B01001041","B01001042","B01001043",
        ]),
        "65_plus": sum_cols("B01001", [
            "B01001020","B01001021","B01001022","B01001023","B01001024","B01001025",
            "B01001044","B01001045","B01001046","B01001047","B01001048","B01001049",
        ]),
    }
    s["age"] = age

    # Race (B02001 — single race responses; B03003 for Hispanic ethnicity)
    s["race"] = {
        "white": _est(geo_data, "B02001", "B02001002"),
        "black": _est(geo_data, "B02001", "B02001003"),
        "american_indian": _est(geo_data, "B02001", "B02001004"),
        "asian": _est(geo_data, "B02001", "B02001005"),
        "pacific_islander": _est(geo_data, "B02001", "B02001006"),
        "other": _est(geo_data, "B02001", "B02001007"),
        "two_or_more": _est(geo_data, "B02001", "B02001008"),
    }
    s["hispanic_or_latino"] = _est(geo_data, "B03003", "B03003003")
    s["not_hispanic_or_latino"] = _est(geo_data, "B03003", "B03003002")

    # Education (population 25+; collapse to 4 levels)
    edu = {
        "less_than_high_school": sum_cols("B15003", [
            f"B15003{c:03d}" for c in range(2, 17)
        ]),  # No school..12th grade no diploma
        "high_school": sum_cols("B15003", [
            "B15003017", "B15003018",  # HS diploma + GED
        ]),
        "some_college_or_associate": sum_cols("B15003", [
            "B15003019", "B15003020", "B15003021",
        ]),
        "bachelors_or_higher": sum_cols("B15003", [
            "B15003022", "B15003023", "B15003024", "B15003025",
        ]),
    }
    s["education_25plus"] = edu

    # Household income
    s["median_household_income"] = _est(geo_data, "B19013", "B19013001")
    inc_brackets = {
        "lt_25k": sum_cols("B19001", [f"B19001{c:03d}" for c in range(2, 6)]),
        "25k_50k": sum_cols("B19001", [f"B19001{c:03d}" for c in range(6, 11)]),
        "50k_75k": sum_cols("B19001", [f"B19001{c:03d}" for c in range(11, 13)]),
        "75k_100k": _est(geo_data, "B19001", "B19001013"),
        "100k_150k": sum_cols("B19001", ["B19001014", "B19001015"]),
        "150k_200k": _est(geo_data, "B19001", "B19001016"),
        "gte_200k": _est(geo_data, "B19001", "B19001017"),
    }
    s["household_income_brackets"] = inc_brackets

    # Employment (16+)
    s["employment"] = {
        "in_labor_force": _est(geo_data, "B23025", "B23025002"),
        "civilian_employed": _est(geo_data, "B23025", "B23025004"),
        "civilian_unemployed": _est(geo_data, "B23025", "B23025005"),
        "armed_forces": _est(geo_data, "B23025", "B23025006"),
        "not_in_labor_force": _est(geo_data, "B23025", "B23025007"),
    }

    # Tenure (own vs rent)
    s["tenure"] = {
        "owner_occupied": _est(geo_data, "B25003", "B25003002"),
        "renter_occupied": _est(geo_data, "B25003", "B25003003"),
    }

    # Household type
    s["households"] = {
        "total": _est(geo_data, "B11001", "B11001001"),
        "family": _est(geo_data, "B11001", "B11001002"),
        "nonfamily": _est(geo_data, "B11001", "B11001007"),
    }

    return s


def main() -> int:
    CENSUS.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)

    # ---- States ----
    print("[1/3] Fetching states …")
    state_fips = load_state_fips()
    print(f"  {len(state_fips)} state geographies")
    states_raw_path = RAW / "states.json"
    if states_raw_path.exists():
        states_raw = json.loads(states_raw_path.read_text())
        print("  cached")
    else:
        states_raw = fetch_batch([f"04000US{f}" for f in state_fips])
        states_raw_path.write_text(json.dumps(states_raw))
        print(f"  fetched, {len(states_raw.get('data', {}))} states")

    # ---- Counties ----
    print("[2/3] Fetching counties …")
    county_fips = load_county_fips()
    print(f"  {len(county_fips)} counties to fetch in batches of {BATCH}")
    counties_raw: dict[str, dict] = {}
    counties_geo_meta: dict[str, dict] = {}
    bad_fips: list[str] = []
    n_batches = (len(county_fips) + BATCH - 1) // BATCH
    for i in range(0, len(county_fips), BATCH):
        batch_idx = i // BATCH + 1
        chunk = county_fips[i:i + BATCH]
        cache = RAW / f"counties_{batch_idx:03d}.json"
        if cache.exists():
            data = json.loads(cache.read_text())
        else:
            geo_ids = [f"05000US{f}" for f in chunk]
            data = fetch_batch_tolerant(geo_ids, bad_fips)
            cache.write_text(json.dumps(data))
            time.sleep(0.2)  # be polite
        for geo_id, payload in data.get("data", {}).items():
            counties_raw[geo_id] = payload
        for geo_id, meta in data.get("geography", {}).items():
            counties_geo_meta[geo_id] = meta
        if batch_idx % 10 == 0 or batch_idx == n_batches:
            print(f"  batch {batch_idx}/{n_batches}  cumulative: {len(counties_raw)} counties")
    if bad_fips:
        print(f"  WARNING: {len(bad_fips)} FIPS not in censusreporter: {bad_fips}")
        (RAW / "missing_fips.json").write_text(json.dumps(bad_fips, indent=2))

    # ---- Transform ----
    print("[3/3] Transforming …")
    state_summary: dict[str, dict] = {}
    for geo_id, payload in states_raw.get("data", {}).items():
        fips = geo_id.replace("04000US", "")
        meta = states_raw.get("geography", {}).get(geo_id, {})
        state_summary[fips] = {
            "fips": fips,
            "name": meta.get("name", ""),
            **summarize(payload),
        }

    county_summary: dict[str, dict] = {}
    for geo_id, payload in counties_raw.items():
        fips = geo_id.replace("05000US", "")
        meta = counties_geo_meta.get(geo_id, {})
        # name comes back like "Adams County, PA"
        name_full = meta.get("name", "")
        if "," in name_full:
            county_name, state_po = [s.strip() for s in name_full.rsplit(",", 1)]
        else:
            county_name, state_po = name_full, ""
        county_summary[fips] = {
            "fips": fips,
            "name": county_name,
            "state_po": state_po,
            **summarize(payload),
        }

    (CENSUS / "states.json").write_text(json.dumps(state_summary, indent=2))
    (CENSUS / "counties.json").write_text(json.dumps(county_summary, indent=2))

    release = states_raw.get("release") or {}
    (CENSUS / "release.json").write_text(json.dumps({
        "states_release": release,
        "tables": TABLES,
        "source": "https://censusreporter.org",
        "license": "ACS data is public domain (US Census Bureau)",
        "note": "censusreporter auto-falls-back from acs2024_1yr to acs2024_5yr for geographies under 65k population.",
    }, indent=2))

    print(f"  states summary: {len(state_summary)}")
    print(f"  counties summary: {len(county_summary)}")
    print(f"  release: {release.get('id')}")
    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
