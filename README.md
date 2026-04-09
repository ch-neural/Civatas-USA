# Civatas-USA

Localization data and ingest scripts for porting **Civatas** (a Taiwan-focused
LLM social-simulation platform) to the **United States**.

This directory is **Stage 0** of the localization effort: it contains only
public, redistributable data plus the scripts that built it. **No Civatas
application code is modified by anything in here.** When the localization is
ready to be cut as a separate project, this folder can be lifted out and used
as the data backbone of `Civatas-USA`.

## What's inside

```
Civatas-USA/
├── data/
│   ├── geo/                    US state + county boundaries (GeoJSON)
│   ├── census/                 ACS demographic data (51 states + 3142 counties)
│   ├── elections/              MEDSL 2020+2024 county results + Cook PVI
│   └── templates/              Pennsylvania-shaped Civatas template (Stage 1 demo)
├── scripts/                    Idempotent fetch + transform scripts
└── docs/                       Inventory and design notes
```

Run any script with `python3 scripts/<name>.py` from this directory. They are
idempotent — re-running uses cached raw responses under each subdirectory's
`raw/`. Delete the `raw/` directory to force a clean re-fetch.

## Stage 1 scope

| Decision               | Choice                                                       |
| ---------------------- | ------------------------------------------------------------ |
| Granularity            | County (3,143 counties × 50 states + DC)                     |
| Stage 1 demo state     | **Pennsylvania** (67 counties, swing state, R+1 in 2024)     |
| Political spectrum     | **Cook PVI** as continuous float, plus 5-bucket discretization |
| Election cycles        | 2020 and 2024 only                                           |
| UI language            | Bilingual (English default, Traditional Chinese opt-in)      |

A user will be able to select **one state, multiple states, or all 50 states**
as the agent generation scope once the application code is updated.

## Data sources and licensing

| Dataset                | Source                                                                | License        |
| ---------------------- | --------------------------------------------------------------------- | -------------- |
| County boundaries      | [us-atlas](https://github.com/topojson/us-atlas) v3 `counties-10m`    | CC0 1.0        |
| State boundaries       | us-atlas v3 `states-10m`                                              | CC0 1.0        |
| Demographics (ACS)     | US Census Bureau ACS 2024 1yr/5yr via [censusreporter.org](https://censusreporter.org) | Public Domain  |
| Election results       | [MEDSL countypres 2000-2024](https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/VOQCHQ) | CC0 1.0        |
| Cook PVI               | Computed locally from MEDSL                                            | derived        |

`api.census.gov` was unreachable from the build network, so ACS data was
fetched via censusreporter.org's mirror, which auto-falls-back from
`acs2024_1yr` to `acs2024_5yr` for geographies under 65,000 population. All
3,143 counties are covered (1 missing FIPS — see "Known data issues" below).

## Known data issues

- **Alaska FIPS 02261** (Valdez-Cordova Census Area, dissolved in 2019 into
  02063 Chugach + 02066 Copper River) is present in the older us-atlas geojson
  but not in the modern ACS release. It is currently dropped. Fix in Stage 2:
  patch the geojson, or merge old/new boundaries.
- **Connecticut** switched from 8 counties to 9 *planning regions* in 2022.
  The fetch scripts use the new planning-region FIPS (`09110..09190`) when
  pulling ACS, but the us-atlas geojson still draws the old 8 counties.
  Fix in Stage 2: replace CT polygons with the planning-region shapes from
  Census TIGER.
- **MEDSL 2020 vs 2024 mode rows.** Some states report only `mode == TOTAL`
  rows in MEDSL, others report only per-mode rows (`ELECTION DAY`, `ABSENTEE`,
  …) without a TOTAL. `compute_pvi.py` handles both cases.
- **National two-party share** matches official numbers exactly:
  2020 D = 52.27% (Biden 51.31% / Trump 46.85%), 2024 D = 49.25%.

## How the data flows

```
fetch_geo.py             → data/geo/us-{counties,states}.geojson
fetch_elections.py       → data/elections/president_{2020,2024}_county.csv
fetch_census.py          → data/census/{states,counties}.json
                            (uses us-counties.geojson to enumerate FIPS)
compute_pvi.py           → data/elections/leaning_profile_us.json
                            (consumes the two president CSVs)
build_national_template.py  → data/templates/presidential_{national_generic,2024}.json
build_state_template.py     → data/templates/presidential_state_<XX>.json (× 51)
                            (both consume census + leaning_profile)
```

To rebuild from scratch:

```bash
python3 scripts/fetch_geo.py
python3 scripts/fetch_elections.py
python3 scripts/fetch_census.py             # ~60 seconds, 63 batches
python3 scripts/compute_pvi.py
python3 scripts/build_national_template.py  # 2 national templates
python3 scripts/build_state_template.py --all  # 51 state templates
```

## Pennsylvania template summary

`data/templates/presidential_state_PA.json` is the per-state Pennsylvania
template, generated by `build_state_template.py --state PA`.

| Dimension          | Source         | Notes                                                                 |
| ------------------ | -------------- | --------------------------------------------------------------------- |
| `gender`           | ACS B01001     | Male / Female (binary as ACS reports)                                 |
| `age`              | ACS B01001     | 7 bins: Under 18 / 18-24 / 25-34 / 35-44 / 45-54 / 55-64 / 65+        |
| `county`           | ACS B01001     | All 67 PA counties weighted by population                              |
| `education`        | ACS B15003     | 4 levels (25+): <HS, HS, Some College/Assoc, BA+                      |
| `party_lean`       | Cook PVI + 2024 turnout | 5 buckets: Solid Dem, Lean Dem, Tossup, Lean Rep, Solid Rep |
| `employment_status`| ACS B23025     | Employed / Unemployed / Armed Forces / Not in Labor Force             |
| `household_tenure` | ACS B25003     | Owner / Renter                                                        |
| `media_habit`      | Pew defaults   | Placeholder; tune in Stage 2 with real US media-mix data              |

State-level computed PVI for PA (turnout-weighted across all 67 counties):
**R+1** (-0.0104 continuous), with PVI bucket distribution
Solid D 10.2% / Lean D 26.9% / Tossup 19.0% / Lean R 19.8% / Solid R 24.0%.

## What is NOT in here yet (deferred to Stage 1+)

- US-context LLM prompts (English rewrite of `evolver.py`, `predictor.py`, `calibrator.py`)
- US news source taxonomy and media bias map (replaces PTT/Dcard/Mobile01)
- News search localization (`gl=us, hl=en` + English keyword templates)
- Election DB schema redesign (replaces `roc_year` etc.)
- Frontend i18n hookup and map component (`taiwan-counties.json` → `us-counties.geojson`)
- Scope: `Civatas-USA/` is *only* the data backbone right now.

## License

Data files are redistributed under their original licenses (see table above).
The fetch and transform scripts in `scripts/` are released under MIT.
