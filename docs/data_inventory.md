# Data Inventory

Generated for the Stage 0 fetch (build date: 2026-04-08).

## Geo

| File | Bytes | Features | Source | Notes |
|---|---:|---:|---|---|
| `data/geo/us-counties.geojson` | 3,226,736 | 3,231 | us-atlas v3 `counties-10m` | 50 states + DC + PR + AS + GU + MP + VI. County id = 5-digit FIPS. |
| `data/geo/us-states.geojson` | 607,997 | 56 | us-atlas v3 `states-10m` | id = 2-digit FIPS, properties.name = state name. |
| `data/geo/raw/counties-10m.topo.json` | 842,143 | — | jsdelivr CDN | Raw TopoJSON kept for re-conversion. |
| `data/geo/raw/states-10m.topo.json` | 114,554 | — | jsdelivr CDN | |

## Elections

| File | Bytes | Rows | Source |
|---|---:|---:|---|
| `data/elections/raw/countypres_2000-2024.tab` | 10,222,208 | full 2000-2024 | MEDSL Harvard Dataverse file id 13573089 |
| `data/elections/president_2020_county.csv` | 2,098,012 | 22,093 | extracted from above |
| `data/elections/president_2024_county.csv` | 2,008,344 | 21,534 | extracted from above |
| `data/elections/leaning_profile_us.json` | 1,479,682 | 3,152 counties | computed by `compute_pvi.py` |

**National two-party Dem share** (from MEDSL, matches official):

| Cycle | D votes | R votes | D share |
|---|---:|---:|---:|
| 2020 | 81,263,372 | 74,218,914 | **52.27%** |
| 2024 | 75,012,514 | 77,302,467 | **49.25%** |

**PVI distribution across 3,152 counties:** min `-0.474` (R+47), median `-0.213` (R+21), max `+0.431` (D+43). Strong Dem (>D+20): 82 counties. Strong Rep (>R+20): 1,652 counties. Median is heavily R-skewed because the US has many small rural R-leaning counties; the popular vote is roughly even because D counties contain the bulk of the population.

## Census (ACS)

Source: censusreporter.org mirror of ACS, release `acs2024_1yr` (auto-falls-back to `acs2024_5yr` for areas under 65k pop).

Tables fetched:

| Table | Description | Cols used |
|---|---|---:|
| B01001 | Sex by Age | 49 → collapsed to 2 sex × 7 age bins |
| B02001 | Race | 7 single-race + 1 multi |
| B03003 | Hispanic or Latino origin | Hispanic / not Hispanic |
| B11001 | Household Type | total / family / nonfamily |
| B15003 | Educational Attainment 25+ | collapsed to 4 levels |
| B19001 | Household Income brackets | collapsed to 7 brackets |
| B19013 | Median Household Income | 1 |
| B23025 | Employment Status | 5 |
| B25003 | Tenure | owner / renter |

| File | Bytes | Records |
|---|---:|---:|
| `data/census/states.json` | 77,928 | 51 |
| `data/census/counties.json` | 4,625,337 | 3,142 |
| `data/census/raw/states.json` | 303,564 | 1 batch |
| `data/census/raw/counties_001.json` … `counties_063.json` | ~275 KB each | 50 counties per batch (last batch 42) |
| `data/census/raw/missing_fips.json` | 20 | `["05000US02261"]` (Valdez-Cordova AK, dissolved 2019) |
| `data/census/release.json` | 466 | release metadata + table list |

## Templates

| File | Bytes | Notes |
|---|---:|---|
| `data/templates/presidential_national_generic.json` | 12,083 | Generic D/R/I two-party national presidential template (3142 counties aggregated). |
| `data/templates/presidential_2024.json` | 12,606 | 2024 presidential cycle (Trump vs Harris). |
| `data/templates/presidential_state_<XX>.json` × 51 | varies | Per-state presidential templates (50 states + DC), state-level dimensions + Cook PVI. |
| `data/templates/pennsylvania_counties.json` | 130,975 | Per-county detail (67 PA counties), demographics + PVI + 2020/2024 election results. Used by multi-county simulations. |

### PA template at a glance

- Population: 13,078,751
- Counties: 67
- State PVI (turnout-weighted from 67 counties): **R+1** (`-0.0104`)
- Party-lean bucket distribution:

| Bucket | Weight |
|---|---:|
| Solid Dem  | 10.2% |
| Lean Dem   | 26.9% |
| Tossup     | 19.0% |
| Lean Rep   | 19.8% |
| Solid Rep  | 24.0% |

This matches PA's actual political character: a few large D urban counties (Philadelphia 12.1%, Allegheny 9.5% of pop), some Lean D suburbs (Montgomery, Bucks, Delaware, Chester, Lehigh), a handful of true tossups, and a long tail of small R-leaning rural counties.

## Total disk usage

| Subdirectory | Size |
|---|---:|
| `data/census/` | 21 MB |
| `data/elections/` | 15 MB |
| `data/geo/` | 4.6 MB |
| `data/templates/` | 140 KB |
| `scripts/` | 48 KB |
| **Total** | **~41 MB** |

If size matters for the eventual Civatas-USA project, the `raw/` directories (~27 MB) can be deleted after the cleaned outputs are produced — the scripts will simply re-fetch on next run.
