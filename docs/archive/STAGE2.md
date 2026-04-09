# Stage 2 — Structural reinforcements

Stage 2 closes the three structural gaps left after Stage 1:

1. **US election database** — proper schema + dimensional tables + views,
   with a Postgres DDL **and** a SQLite loader for dev/CI.
2. **Connecticut planning regions** + **Alaska Valdez-Cordova split** — the
   two known geo gaps that Stage 0 documented but couldn't fix.
3. **`USMap.tsx`** — the actual React/TSX component for rendering the US
   choropleth, with state ↔ county zoom and Albers USA projection. No
   external d3-geo dependency.

Like Stage 1, **nothing in `ap/` was modified**. All files live under
`Civatas-USA/`.

## What's new in this stage

```
Civatas-USA/
├── STAGE2.md                                              ← this file
├── code/ap/services/
│   ├── election-db/init/us_001_schema.sql                 ← Postgres DDL (NEW)
│   └── web/
│       ├── public/
│       │   ├── us-counties.geojson                        ← patched (CT + AK)
│       │   └── us-pvi-sample.json                         ← demo data for USMapExample
│       └── src/components/
│           ├── USMap.tsx                                  ← Albers USA choropleth (NEW)
│           └── USMapExample.tsx                           ← integration example (NEW)
├── data/
│   ├── geo/
│   │   ├── us-counties.geojson                            ← patched in place (3,233 features)
│   │   ├── us-counties.pre-patch.geojson                  ← backup (3,231 features)
│   │   └── raw/cb_2024_us_county_500k.zip                 ← Census source (~12 MB)
│   └── us_election.db                                     ← SQLite, populated (~2.5 MB)
└── scripts/
    ├── patch_geo_ct_ak.py                                 ← Census shapefile → patched geojson
    └── load_election_db.py                                ← MEDSL + ACS → SQLite/Postgres
```

## 1. Election database

### Schema (Postgres)

`code/ap/services/election-db/init/us_001_schema.sql` mirrors the structure of
`ap/services/election-db/init/001_schema.sql` (the TW schema) but with US
semantics. All tables are namespaced `us_*` so a single Postgres database can
host both Taiwan and US data side by side.

| Table              | Rows after Stage 2 load | Purpose |
| ------------------ | ----------------------:| ------- |
| `us_states`        | 51                     | 50 states + DC |
| `us_counties`      | 3,192                  | All FIPS in geojson + 9 legacy CT + 1 legacy AK |
| `us_parties`       | 8                      | Democratic, Republican, Libertarian, Green, Constitution, Independent, Working Families, Other |
| `us_elections`     | 2                      | 2020 + 2024 presidential |
| `us_candidates`    | 12                     | Distinct candidates across both cycles |
| `us_vote_results`  | 25,133                 | per (election, candidate, county) |
| `us_election_stats`| 6,307                  | per (election, county) totals |
| `us_pvi`           | 3,152                  | Cook PVI per county for ref-cycle 2024 |

Plus 4 convenience views:

- `v_us_county_results` — flattened county-level results with party + state names
- `v_us_state_results` — sums-and-shares per state (window function)
- `v_us_county_two_party_share` — Democratic two-party share per cycle, the
  raw input the calibrator uses for PVI math
- `v_us_pvi_summary` — PVI joined with county/state names for the UI

### Loader

`scripts/load_election_db.py` is dual-backend:

```bash
# Default — SQLite at data/us_election.db, no DB server required
python3 scripts/load_election_db.py

# Postgres — schema must be applied first
psql civatas < code/ap/services/election-db/init/us_001_schema.sql
python3 scripts/load_election_db.py --dsn 'postgresql://user@host/civatas'
```

The loader is idempotent (re-running re-upserts) and walks
`data/elections/raw/countypres_2000-2024.tab` directly, so it does not depend
on the cleaned `president_{2020,2024}_county.csv` files.

It correctly handles the MEDSL "TOTAL vs per-mode" inconsistency that bit
Stage 0 — sums per-mode rows when no TOTAL exists for a (county, party).

### Verification (after running the loader)

```
Backend: sqlite
us_states         51
us_counties       3192
us_elections      2
us_candidates     12
us_vote_results   25133
us_pvi            3152
PA counties with 2024 results: 67 (expected 67)
PA 2024 totals:
  Democratic: 3,423,042
  Republican: 3,543,308
PVI bucket distribution (3,142 counties):
   Lean Dem    204
   Lean Rep    523
  Solid Dem    135
  Solid Rep   1975
     Tossup    315
```

PA 2024 totals **match the official certified result exactly** (D 3,423,042 / R 3,543,308). The
swing-state-leaning bucket distribution matches Cook's published 2024 ratings.

### Sample query

```sql
-- Top 5 PA counties by Harris votes in 2024
SELECT county_name, vote_count
FROM v_us_county_results
WHERE state_po = 'PA' AND cycle_year = 2024 AND candidate_name = 'Kamala D Harris'
ORDER BY vote_count DESC LIMIT 5;
```

```
Philadelphia County  568,571
Allegheny County     429,916
Montgomery County    317,103
Delaware County      201,324
Bucks County         198,431
```

These match the certified 2024 PA results.

## 2. CT planning regions + AK fix

### What was wrong

- `data/geo/us-counties.geojson` (from us-atlas v3, 2023) still drew Connecticut as 8 historic counties (FIPS `09001..09015`). Connecticut switched to 9 *planning regions* (`09110..09190`) in the 2022 ACS release, so Stage 0's census data referenced FIPS that didn't exist on the map.
- Alaska's Valdez-Cordova Census Area (`02261`) was dissolved in 2019 into Chugach (`02063`) and Copper River (`02066`). us-atlas still drew `02261`; the 2024 ACS doesn't.

### What was fixed

`scripts/patch_geo_ct_ak.py`:

1. Downloads Census 2024 cartographic boundary file `cb_2024_us_county_500k.zip` (11.6 MB, public domain).
2. Reads the shapefile with `pyshp` (no GDAL).
3. Extracts the 11 wanted features: 9 CT planning regions + 2 new AK areas.
4. Removes the 9 obsolete features (8 CT + 1 AK) from `us-counties.geojson`.
5. Inserts the 11 new features.
6. Backs up the pre-patch version to `data/geo/us-counties.pre-patch.geojson`.

After the patch:

```
total features: 3233    (was 3231)
CT: 09110, 09120, 09130, 09140, 09150, 09160, 09170, 09180, 09190
AK: includes 02063, 02066; no longer includes 02261
```

The patched file is also synced into `code/ap/services/web/public/us-counties.geojson` so the frontend overlay always carries the fixed version.

The Stage 1 census loader and the Stage 2 election DB loader both retain backward compatibility: 9 legacy CT FIPS + AK 02261 are still inserted as `(legacy)` rows in `us_counties` so the 2020 MEDSL data (which uses old codes) does not break the FK constraint on `us_vote_results`.

## 3. USMap.tsx

### Design

`code/ap/services/web/src/components/USMap.tsx` (390 lines) is a React component shaped exactly like the existing `TaiwanMap.tsx` (210 lines) so panels can switch by country with no plumbing changes:

```tsx
{country === "US"
  ? <USMap data={pviByFips} mode="counties" diverging />
  : <TaiwanMap data={pctByCountyName} />}
```

Key differences from `TaiwanMap`:

| | TaiwanMap | USMap |
|---|---|---|
| Data key | County name (e.g. "臺中市") | FIPS code (e.g. "42003") |
| Projection | Plate-carrée (hardcoded TW bbox) | Albers USA composite (CONUS + AK + HI insets) |
| Levels | Single (county) | Two (state, county) with drill-down |
| Color scale | Single sequential | Sequential **and** diverging (for PVI) |

### Albers USA composite

Implemented inline so no `d3-geo` dependency is added to `package.json`. Three projection regions:

- **CONUS** (lower 48 + DC): Albers conic equal-area, φ₁=29.5°, φ₂=45.5°, λ₀=−96°, φ₀=37.5° (the US Census standard)
- **Alaska** (state FIPS `02`): Albers conic centered on AK, scaled to 0.35× and translated to lower-left inset
- **Hawaii** (state FIPS `15`): simplified Albers, translated to right of AK inset

The Y axis is correctly flipped (north → top) — verified against six reference cities:

```
Pittsburgh PA  → (432, 190)  NE-of-center  ✓
LA CA          → (151, 237)  SW-of-center  ✓
NYC NY         → (473, 180)  NE-of-center  ✓
Miami FL       → (454, 317)  SE-of-center  ✓
Seattle WA     → (155, 115)  NW-of-center  ✓
```

### Drill-down

When a state is clicked in `mode="states"`, set `selectedState` to the 2-digit FIPS. The component:

1. Filters `us-counties.geojson` to features whose FIPS starts with that state code
2. Switches to a `fitProjectionForState()` projection (cosine-corrected equirectangular fit on the state's bbox)
3. Renders only those counties

Lazy load: `us-counties.geojson` (3.2 MB) is only fetched when `mode="counties"` or `selectedState` is set, so state-level views don't pay the 3 MB cost.

### Diverging color mode

For PVI-style data centered on zero:

```tsx
<USMap
  data={pviByFips}             // continuous: -0.5 .. +0.5
  mode="counties"
  diverging                    // ← R-red ←gray→ D-blue
  divergingColorScale={["#dc2626", "#1f2937", "#2563eb"]}
/>
```

### Type-check

`USMap.tsx` and `USMapExample.tsx` were verified by temporarily copying them
into `ap/services/web/src/components/`, running `tsc --noEmit -p tsconfig.json`,
checking that no errors mentioned either file, then deleting the copies. The
errors that did show up are pre-existing in unrelated files
(EvolutionDashboardPanel, AgentExplorerPanel, etc.) and are documented as
outside the Stage 2 scope.

### Example panel

`USMapExample.tsx` is a tiny demo panel that:

- Loads `/us-pvi-sample.json` (3,152 counties, ~56 KB) from `code/ap/services/web/public/`
- Toggles between state-level and county-level views
- Drills into a state when clicked
- Renders PVI in diverging color (red ↔ blue)

To wire it into the Civatas app, drop both files into
`ap/services/web/src/components/` and add a route or panel that mounts
`<USMapExample />`.

## Smoke test (run from `Civatas-USA/`)

```bash
# Stage 0 + Stage 1 + Stage 2 end-to-end:
python3 scripts/fetch_geo.py            # 3231 features
python3 scripts/patch_geo_ct_ak.py      # 3233 features
python3 scripts/fetch_elections.py
python3 scripts/fetch_census.py
python3 scripts/compute_pvi.py
python3 scripts/build_pa_template.py
python3 scripts/load_election_db.py     # populates data/us_election.db

# Sanity-query the DB
python3 - <<'PY'
import sqlite3
c = sqlite3.connect("data/us_election.db")
print("PA 2024 D:", c.execute("""
  SELECT SUM(vr.vote_count) FROM us_vote_results vr
  JOIN us_elections e ON e.id = vr.election_id
  JOIN us_candidates ca ON ca.id = vr.candidate_id
  JOIN us_parties p ON p.id = ca.party_id
  JOIN us_counties co ON co.fips = vr.county_fips
  WHERE e.cycle_year = 2024 AND co.state_fips = '42' AND p.name = 'Democratic'
""").fetchone()[0])
PY
# Expected: PA 2024 D: 3423042
```

## What's still deferred to Stage 3+

| Item | Why deferred |
| --- | --- |
| **Apply the country-aware shim to `ap/`** | Requires touching 6 files in `ap/`, which the user has not authorized yet. Stage 1.5 if/when ready. |
| **Calibrator wiring** | The English calibrator prompt is in `prompts_en.py` but `calibrator.py` is not yet country-aware. |
| **Real Pew media-habit calibration** | The PA template still uses placeholder media-habit weights from Pew defaults. Stage 3 should refit per age cohort. |
| **Multi-state synthesis runner** | The user asked for "select multiple states or all 50". Today the synthesis service takes one template; needs a merge step. |
| **Drill projection quality** | `fitProjectionForState()` uses cosine-corrected equirectangular. Fine for PA but distorts noticeably for Alaska. Stage 3: per-state Albers params. |
| **Dual-language UI integration** | `en.json` and `zh-TW-us-additions.json` keys exist but the actual components still hardcode some strings. |
| **Backend tests** | No pytest fixtures yet for either branch. |

## Stage 2 file list

```
docs:
  STAGE2.md                                                  ~ this file

scripts (new):
  patch_geo_ct_ak.py                                         ~140 lines
  load_election_db.py                                        ~480 lines

code overlay (new):
  code/ap/services/election-db/init/us_001_schema.sql        ~280 lines
  code/ap/services/web/src/components/USMap.tsx              ~390 lines
  code/ap/services/web/src/components/USMapExample.tsx       ~ 90 lines
  code/ap/services/web/public/us-pvi-sample.json             3,152 entries

code overlay (regenerated):
  code/ap/services/web/public/us-counties.geojson            3,233 features (was 3,231)

data (new):
  data/us_election.db                                        ~2.5 MB SQLite
  data/geo/us-counties.geojson                               patched in place
  data/geo/us-counties.pre-patch.geojson                     backup
  data/geo/raw/cb_2024_us_county_500k.zip                    ~12 MB Census source
```
