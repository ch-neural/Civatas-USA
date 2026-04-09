# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This working directory holds **two distinct but related projects**:

1. **`/` (Civatas-USA, Stage 0+ data backbone)** — Public, redistributable US data
   (geo, ACS census, MEDSL elections, computed Cook PVI) plus the Python fetch/transform
   scripts that produced it. No application code lives at the top level. See `README.md`.
2. **`ap/` (Civatas application)** — The full 9-service Dockerized "Universal Social
   Simulation Agent Generation Platform". **US-only as of Stage 1.9 cleanup** — the
   legacy Taiwan dual-path was removed; English is the source-of-truth language and
   the i18n system supports additional locales (`zh-TW` today, `ja` / `ko` planned).
   See `ap/README.md`.

The `ap/` tree is **the live application**; the top-level scripts feed data into it
via templates that are schema-compatible with the US presidential templates under
`data/templates/presidential_*.json`.
`code/ap/` and `source/oasis` are vendored / reference trees — do not edit unless asked.

`docs/HISTORY.md` summarises the localization stages (1.0 → 1.9). The original
`STAGE*.md` working documents are archived under `docs/archive/` for reference.

## Common commands

### Data pipeline (top-level Python scripts)

Run from the repo root. Scripts are **idempotent** — they cache raw responses under
each subdirectory's `raw/`. Delete `raw/` to force a clean re-fetch.

```bash
python3 scripts/fetch_geo.py             # → data/geo/us-{counties,states}.geojson
python3 scripts/fetch_elections.py       # → data/elections/president_{2020,2024}_county.csv
python3 scripts/fetch_census.py          # ~60s, 63 batches → data/census/{states,counties}.json
python3 scripts/compute_pvi.py           # → data/elections/leaning_profile_us.json
python3 scripts/build_national_template.py  # → data/templates/presidential_{national_generic,2024}.json
python3 scripts/build_state_template.py --all  # → 51 single-state templates
python3 scripts/load_election_db.py      # → data/us_election.db
python3 scripts/patch_geo_ct_ak.py       # one-off geo fixes (CT planning regions, AK 02261)
```

`fetch_census.py` uses `censusreporter.org` (not `api.census.gov`, which is unreachable
from the build network) and auto-falls-back from `acs2024_1yr` to `acs2024_5yr` for
geographies under 65k population.

### Civatas application (`ap/`)

```bash
cd ap
cp .env.example .env
docker compose up --build                   # core: web + api + ingestion + synthesis + persona + adapter
docker compose --profile full up --build    # adds simulation + analytics
bash scripts/test_pipeline.sh               # end-to-end pipeline smoke test
```

- Web UI: http://localhost:3000  · API docs: http://localhost:8000/docs
- Each service is its own container in `ap/services/<name>/` with its own Dockerfile.

### Convenience

`./start_claude_danger.sh` launches `claude --dangerously-skip-permissions` in this dir.

## Architecture

### Civatas application pipeline (`ap/`)

Civatas is a 7-layer pipeline exposed as 9 Docker services. The API gateway
orchestrates downstream services; data flows linearly:

```
upload → ingestion(8001) → synthesis(8002) → persona(8003) → social(8004)
       → adapter(8005) → simulation(8006, OASIS) → analytics(8007)
              ↑                                              ↑
            api(8000) FastAPI gateway     web(3000) Next.js frontend
```

- **ingestion** parses CSV/JSON/Excel demographic statistics into the internal format.
- **synthesis** generates a synthetic population matching the input distributions.
- **persona** turns structured records into natural-language US-resident personas
  via LLM. Personality dimensions, cognitive bias, and income band are emitted
  in English.
- **social** (optional) builds a follow graph with homophily bias.
- **adapter** exports agents as OASIS-compatible CSV/JSON.
- **simulation** runs OASIS; **analytics** parses the resulting `.db` files.
- **evolution** (`ap/services/evolution/`) holds the news-source taxonomy and
  opinion-evolution prompts. `us_feed_sources.py` is the US 130-outlet, 5-tier-PVI
  source list; it is also snapshotted to `ap/shared/us_data/us_feed_sources.json`
  so the API gateway can serve it without importing the evolution module.
- **election-db** has separate `init/` and `importer/` subservices.

Shared schemas and i18n locales live in `ap/shared/` and are mounted into multiple
services — if you change a schema there, rebuild the services that consume it.

### Localization data flow (top-level → `ap/`)

The top-level `data/` tree is the **US data backbone** that feeds the application:

```
data/geo/        →  frontend map (us-counties.geojson rendered by USMap.tsx)
data/census/     →  synthesis layer demographic distributions (ACS B01001, B15003, B23025, B25003, ...)
data/elections/  →  party_lean dimension via Cook PVI (5 buckets: Solid D / Lean D / Tossup / Lean R / Solid R)
data/templates/presidential_national_generic.json  →  generic D/R/I two-party national template
data/templates/presidential_2024.json              →  Trump vs Harris cycle template
data/templates/presidential_state_<XX>.json        →  51 single-state templates (50 states + DC)
data/templates/pennsylvania_counties.json          →  per-county detail used by the state template
```

The system supports **one state, multiple states, or all 50 states** as the
agent generation scope, selected via the `PopulationSetupPanel` template picker.

### Cook PVI computation

`scripts/compute_pvi.py` consumes both 2020 and 2024 MEDSL county presidential CSVs.
**Both per-mode rows (`ELECTION DAY`, `ABSENTEE`, ...) and `mode == TOTAL` rows
must be handled** — different states report differently and the script reconciles
both. National two-party Dem share matches official numbers exactly (2020: 52.27%,
2024: 49.25%) — treat any deviation as a bug.

## Known data quirks (do not "fix" without understanding)

- **Alaska FIPS 02261** (Valdez-Cordova, dissolved 2019 into 02063 + 02066) exists in
  the older us-atlas geojson but not in modern ACS releases. Currently dropped.
  Tracked as a future fix to patch the geojson or merge old/new boundaries.
- **Connecticut** switched from 8 counties to 9 *planning regions* in 2022. Fetch
  scripts pull ACS using the new planning-region FIPS (`09110..09190`), but the
  us-atlas geojson still draws the old 8 counties — they will not line up until
  CT polygons are replaced with TIGER planning-region shapes.
- The `raw/` directories under each `data/` subdir are **caches** (~27 MB total),
  not source-of-truth. Delete to force re-fetch; never edit by hand.

## Election templates

Templates live in `data/templates/*.json` (top-level — `ap/docker-compose.yml` mounts
this dir into the api container at `/data/templates`). The schema has two parts:

1. **Demographics block** (`dimensions`) — ACS-derived gender / age / county / state /
   education / party_lean / employment / tenure / media_habit categorical distributions
2. **Election block** (`election`, OPTIONAL) — election-specific defaults: candidates,
   party_palette, party_detection patterns, default_macro_context, default_search_keywords,
   default_calibration_params, default_kol, default_poll_groups, party_base_scores,
   default_evolution_params, default_alignment, default_evolution_window.

Backward compatible: templates without an `election` block still load — the panels
fall back to the generic US defaults defined in `template-defaults.ts`.

**Builders:**
- `scripts/build_national_template.py` → `presidential_national_generic.json` + `presidential_2024.json`
- `scripts/build_state_template.py --all` → 51 single-state templates `presidential_state_<XX>.json`

**API:** `GET /api/templates` returns metadata for all templates (id, name, region,
country, locale, election type / scope / cycle, candidate count). Frontend groups
by election scope (national / state / other) in the picker.

**Active template per workspace:** stored in `localStorage[\`activeTemplate_${wsId}\`]`.
The `useActiveTemplate(wsId)` hook (in `ap/services/web/src/hooks/use-active-template.ts`)
returns the full template body reactively. `PopulationSetupPanel` calls
`setActiveTemplateId(wsId, id)` when the user clicks Generate.

**Template-driven defaults:** `ap/services/web/src/lib/template-defaults.ts` exposes
`getDefaultMacroContext()`, `getDefaultLocalKeywords()`, `getDefaultElectionType()`,
`getDefaultCalibParams()`, `getDefaultCandidates()`, `getDefaultCandidateBaseScores()`,
`makePartyColorResolver()`, `makePartyIdResolver()`, etc. Each helper accepts the
(possibly-null) active template and returns either the template-provided value or
a generic US fallback. `CalibrationPanel`, `PredictionPanel`, and `SandboxPanel`
consume these helpers — when a template is active, they auto-seed macro context /
search keywords / party colors / candidates with template values; otherwise they
fall back to generic English defaults.

**When adding a new election type:**
1. Write the data fetcher (`scripts/fetch_<type>.py` for any new MEDSL/TIGER datasets)
2. Write the builder (`scripts/build_<type>_template.py`) following the `build_national_template.py` pattern
3. The new template's `election.type` should be one of: `presidential` / `senate` / `gubernatorial` / `house` / `mayoral`
4. No frontend changes needed unless you introduce new election-type-specific UI

## i18n / multi-language UI

`ap/services/web/` is multi-locale via `useTr()` / `lib/i18n.ts`. **English is
the source of truth and the default**. The StatusBar `🌐` button cycles
through available locales — currently `en` and `zh-TW`; `ja` / `ko` planned.

**Adding a new language:**
1. Extend the `UiLocale` union in `ap/services/web/src/store/locale-store.ts` and
   add the new code to `LOCALE_CYCLE` + `LOCALE_LABEL`.
2. Add the new key to every entry in `STRINGS` inside `ap/services/web/src/lib/i18n.ts`
   (each entry is `{ en, "zh-TW", … }`). Until a translation lands, set the new
   locale's value to the English source — `tr()` already falls back to `en`.

**Persona data values** (personality dimensions, cognitive bias, income band, gender)
are emitted by the persona service in **English**. Pre-1.9 personas may still have
Chinese stored values; the `PERSONA_VALUE_KEY` map in `lib/i18n.ts` converts those
to localized labels at render time via `useLocalizePersonaValue()`.

## When changing things

- Editing a top-level fetch script? Re-run it and verify outputs match the row counts
  / national vote shares quoted in `docs/data_inventory.md` and `README.md`.
- Editing a service in `ap/services/<x>/`? Rebuild just that container with
  `docker compose up --build <x>`.
- Editing `ap/shared/`? Rebuild all services that mount it.
- Editing `us_feed_sources.py`? Re-snapshot to `ap/shared/us_data/us_feed_sources.json`.
- Touching templates? They must remain schema-compatible with the existing
  `data/templates/presidential_state_PA.json` reference template.

## 語言規則
- 思考過程（thinking）可以使用英文
- 所有最終回覆必須使用繁體中文
