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

- Web UI: http://localhost:3100 (override via `WEB_PORT` in `ap/.env`)  · API docs: http://localhost:8000/docs
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

## Open-Source UI Redesign (2026-04-09)

The frontend was restructured for open-source release. Key changes:

### Authentication removed
- **No login required.** JWT auth middleware, `auth.py`, `routes/auth.py`, and
  `routes/playback.py` have been deleted from the API service.
- Frontend `auth-store.ts`, `AuthGuard.tsx`, and `app/login/` are removed.
- `lib/api.ts` no longer sends `Authorization` headers or handles 401 redirects.

### 3-Step Workflow (Persona → Evolution → Prediction)
The UI is simplified to three numbered workflow steps. The old multi-tab, split-panel,
inspector, command palette, and menu bar system has been replaced by:

- **`WorkflowSidebar`** (`components/shell/WorkflowSidebar.tsx`) — Left sidebar with
  3 numbered steps, expandable sub-items, project selector dropdown, and step status
  badges (locked/available/completed).
- **`panel-registry.ts`** — Reduced from 18+ panel types to 10. Exports
  `WORKFLOW_STEPS` array (replaces old `WORKFLOW_ORDER` / `WORKFLOW_SUB_ITEMS`).
- **`shell-store.ts`** — Simplified: removed `openPanels`, `activePanelId`, `layout`,
  `inspectorOpen`, `commandPaletteOpen` and all related actions. Kept workspace,
  jobs, and LLM status.

### Sidebar sub-items map to these panels:

| Step | Sub-item | Panel | Route |
|------|----------|-------|-------|
| 1. Persona | Setup | `PopulationSetupPanel` | `/workspaces/[id]/population-setup` |
| 1. Persona | Synthesis | `SynthesisResultPanel` | `/workspaces/[id]/synthesis` |
| 1. Persona | Explore | `PersonaPanel` | `/workspaces/[id]/persona` |
| 2. Evolution | News Sources | `EvolutionPanel` | `/workspaces/[id]/evolution` |
| 2. Evolution | Run Evolution | `EvolutionPanel` (runner tab) | `/workspaces/[id]/evolution-runner` |
| 2. Evolution | Dashboard | `EvolutionDashboardPanel` | `/workspaces/[id]/evolution-dashboard` |
| 2. Evolution | Agent Explorer | `AgentExplorerPanel` | `/workspaces/[id]/agent-explorer` |
| 3. Prediction | Setup | `PredictionPanel` | `/workspaces/[id]/prediction` |
| 3. Prediction | Run | `PredictionEvolutionDashboardPanel` | `/workspaces/[id]/prediction-evolution-dashboard` |
| 3. Prediction | Analysis | `PredictionAnalysisPanel` | `/workspaces/[id]/prediction-analysis` |

### Onboarding Wizard
`components/onboarding/OnboardingWizard.tsx` — Full-screen 4-step wizard shown when
`settings.onboarding_completed` is false (detected via `GET /api/settings` in
`DesktopShell`).

**Step 1 — API Keys:**
- Agent LLM vendors (default: OpenAI `gpt-4o-mini`). Add more via "+ Add another vendor".
- System LLM (default: OpenAI `o4-mini`) — used for non-agent tasks (news analysis,
  data parsing, election data OCR). Separate vendor/model/key. Blank key = reuse
  first agent vendor.
- Serper API Key (required).
- All three sections have **Test** buttons that call real APIs:
  - `POST /api/settings/test-vendor` — sends minimal chat completion to LLM
  - `POST /api/settings/test-serper` — sends search query to Serper

**Step 2 — Create Project:** Name + template selection (grouped National / State).

**Step 3 — Generate Personas:** Synthesize + generate with progress bar.

**Step 4 — Ready:** Summary + explanation of next steps (Evolution → Prediction).

### Prerequisite Gates
`components/shared/StepGate.tsx` — Shown when a panel's prerequisite step is incomplete:
- Evolution panels check `persona-result` — if empty, show "Persona Required" gate.
- Prediction panels check evolution job history — if no completed jobs, show
  "Evolution Required" gate.
- Gate UI: lock icon + bilingual message + redirect button.

Status is tracked by `hooks/use-workflow-status.ts` (`useWorkflowStatus` hook),
which polls `persona-result` and `evolution/history` every 10s.

### Guide Banners
`components/shared/GuideBanner.tsx` — Dismissible contextual help banners at the top
of key panels (`PopulationSetupPanel`, `PersonaPanel`, `EvolutionPanel`,
`PredictionPanel`). Dismissed state stored in `localStorage` under
`civatas_dismissed_guides`. Call `dismissAllGuides()` to dismiss all at once.

### Removed panels and components (24 files)
**Panels:** Calibration, Sandbox, Primary, Simulation, Analytics, HistoricalEvolution,
NewsCenter, SatisfactionSurvey, StatModules, Leaning, DataSources.

**Shell:** PanelTabBar, InspectorPanel, CommandPalette, MenuBar, Toolbar,
LayoutRenderer, ResizeHandle, MainWorkspace, NavTree, SplitPaneHeader.

**Other:** PlaybackViewer, RecordingManager, RecordingButton, AgentInspector, GuidePanel.

### Settings Panel
Simplified to 2 tabs:
- **API Keys** — LLM vendor CRUD + Serper key + "Re-run Onboarding Wizard" button
- **Appearance** — Theme + language selector

### Design documents
- Spec: `docs/superpowers/specs/2026-04-09-open-source-ui-redesign.md`
- Plan: `docs/superpowers/plans/2026-04-09-open-source-ui-redesign.md`

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

**API:** `GET /api/templates` returns `{ templates: [...] }` with metadata for all
templates (id, name, region, country, locale, election type / scope / cycle, candidate
count). Frontend groups by election scope (national / state / other) in the picker.

**Active template per workspace:** stored in `localStorage[\`activeTemplate_${wsId}\`]`.
The `useActiveTemplate(wsId)` hook (in `ap/services/web/src/hooks/use-active-template.ts`)
returns the full template body reactively. `PopulationSetupPanel` calls
`setActiveTemplateId(wsId, id)` when the user clicks Generate.

**Template-driven defaults:** `ap/services/web/src/lib/template-defaults.ts` exposes
`getDefaultMacroContext()`, `getDefaultLocalKeywords()`, `getDefaultElectionType()`,
`getDefaultCalibParams()`, `getDefaultCandidates()`, `getDefaultCandidateBaseScores()`,
`makePartyColorResolver()`, `makePartyIdResolver()`, etc. Each helper accepts the
(possibly-null) active template and returns either the template-provided value or
a generic US fallback.

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

## Onboarding & API Keys Redesign (2026-04-12)

### Onboarding Wizard Improvements
- **Step 1**: Replaced 3-section accordion with flat card-based layout:
  - LLM Providers section (vendor + API key + Base URL + Test per card)
  - Role Cards: left column = System LLM (cyan dot), right column = Agent LLM(s) (red dot) + dashed "Add Agent LLM" button
  - Search API (Serper) section
  - Loading spinner on initial settings fetch; saving spinner on transition
- **Step 2**: Template selector now loads from API with `election.scope` flattened; grouped by National / State. "Data Sources" info button shows dynamic per-template statistics (population, counties, PVI, source descriptions).
- **Step 3**: Persona generation with animated color-coded blocks (political leaning colors), hover detail panel (fixed bottom overlay with Demographics / Political / Personality / Individuality), statistics modal with bar charts, loading spinner.
- **Step 4**: Redirects to Evolution Quick Start (not Population Setup).
- Settings load on mount via `parseSettingsToProvidersAndRoles`.
- `finishOnboarding` partial update bug fixed — `PUT /api/settings` now preserves existing vendors when only `onboarding_completed` is sent.

### Settings Panel
- API Keys tab redesigned to match Onboarding card-based layout (same Provider cards + System/Agent LLM role cards).
- All text bilingual (en/zh-TW).

### Template System
- **3 national templates**: Generic, 2024 (Trump vs Harris, PVI from 2016+2020), 2028 (Who's Next? — Vance/Newsom/DeSantis/Whitmer/Haley/Shapiro)
- **2024 uses pre-election PVI** (2016+2020 only, no future data leakage)
- **2028** uses 2020+2024 PVI with 6 potential candidates
- `fetch_elections.py` now extracts 2016+2020+2024 from MEDSL
- `compute_pvi.py` supports configurable year pairs via `compute(years, suffix)`
- `build_national_template.py` generates all 3 templates + uses latest available cycle for turnout weighting

### New Demographics Dimensions
- **Race** (B02001): White, Black, Asian, American Indian, Pacific Islander, Other, Two or More
- **Hispanic/Latino** (B03003): Hispanic or Latino / Not Hispanic or Latino
- **Household Income** (B19001): 7 brackets from Under $25k to $200k+
- **Household Type** (B11001): Family / Non-Family
- Added to `shared/schemas/person.py`, `synthesis/builder.py`, `persona/generator.py`
- Templates now carry 12 dimensions total
- All persona display surfaces updated (Onboarding Step 3, PopulationSetupPanel stats, tooltips)

### Evolution Quick Start (`/workspaces/[id]/evolution-quickstart`)
- New panel registered in `panel-registry.ts`, route page created
- One-click automated evolution: crawl news → evolve agents → repeat for N rounds
- **Serper news by political leaning**: searches 5 Cook PVI buckets separately (site: restriction), injects with known source name for diet rules matching
- **Template-driven defaults**: dates, candidates, keywords from template's `election` block
- **Pause/Resume/Stop**: state persisted to server via `saveUiSettings`; survives page close
- **News pool auto-clear** before each fresh start
- **Candidate names** passed to evolution backend for tracking
- **Download Playback** button: generates self-contained HTML with Chart.js, animated charts, play/pause controls

### US News Sources
- `crawler.py` `DEFAULT_SOURCES` replaced: 10 Taiwan sources → 12 US sources (Reuters, AP, The Hill, NYT, CNN, NPR, WashPost, Fox News, WSJ, NY Post, MSNBC, Breitbart)
- `CrawlSource.leaning` default: "中立" → "Tossup"
- Cached `data/evolution/sources.json` deleted to force re-init

### US Life Events (`us_life_events.py`)
- 27 US-context life events across 8 categories: economic, family, health, community, education, political, immigration (Hispanic-specific), race (non-White specific), natural disaster
- Each event has eligibility filters (age, gender, race, tenure, hispanic_or_latino)
- Enabled in `evolver.py` (was disabled — TW catalog would leak CJK into English diaries)
- `life_events.py` eligibility checker extended with `race_not`, `hispanic_or_latino`, `tenure` filters

### Evolution Prompt Enhancements (`prompts.py`)
- **Race/ethnicity identity** added to agent prompt: `Race / ethnicity: {race}, {hispanic_or_latino}`
- **Demographic reaction rules** expanded: race-specific (Black → policing/civil rights, Hispanic → immigration, Asian → hate crimes), income-bracket-specific ($50k/$100k/$150k thresholds), family structure
- **Diary differentiation**: tone by race (Black dialect, Hispanic familia references, Asian reserve, White rural folksy, White suburban measured), by education level (simple → analytical), by income (survival → policy), by media habit (YouTube/Reddit/NPR/Facebook/Print)
- **Candidate tracking text** changed from Chinese to English

### Evolution Dashboard & Panels
- `EvolutionPanel`: Evolution Engine tab removed from sub-tabs (functionality moved to Quick Start); all Chinese strings replaced with bilingual `en ? "..." : "..."` pattern
- `EvolutionDashboardPanel`: all hardcoded Chinese replaced with bilingual
- `GroupedStatsPanel`: 9 Chinese titles replaced (By Political Leaning, By LLM Vendor, By State, By Gender, etc.)
- `PopulationSetupPanel`: existing personas show inline stats (Political, Race, Gender, Income, Education, Top States); button changes to "Re-generate" with orange color; age range defaults 18–95; persona strategy selector hidden (always LLM)
- Template change confirmation popup when personas exist

### Settings Persistence
- `PopulationSetupPanel`: targetCount, ageMin, ageMax persisted via `saveUiSettings`
- `EvolutionQuickStartPanel`: simDays, crawlInterval, concurrency persisted via `saveUiSettings`
- `PredictionPanel`: already had full persistence (~45 fields)
- All settings stored per workspace via `PUT /api/workspaces/{wsId}/ui-settings/{panel}`

### Evolution Playback Export
- `GET /api/pipeline/evolution/export-playback` — collects dashboard + history + jobs data
- `lib/export-playback.ts` — generates self-contained HTML with:
  - Chart.js from CDN
  - Embedded evolution data as JSON
  - Play/Pause controls with speed slider
  - 4 animated charts: Satisfaction/Anxiety, Political Leaning, Candidate Awareness, Full History
  - Bilingual (follows current locale)
  - Downloadable as `.html` file

### WorkflowSidebar
- Project selector navigates to Quick Start (if has_personas) or Population Setup
- Evolution sub-items: Quick Start, News Sources, Evolution Dashboard, Agent Explorer (Run Evolution removed)

### Bug Fixes
- `WorkflowSidebar`: `workspaces` API returns `{workspaces: [...]}` not array — added unwrap
- `use-workflow-status.ts`: `evolutionJobs` guard with `Array.isArray`
- `StartEvolutionRequest`: added missing `enabled_vendors` and `candidate_names` fields
- `start_evolve`: removed undefined `get_available_vendors()`, uses `req.concurrency` with fallback
- `api_update_settings`: preserves existing `llm_vendors` when partial update (e.g. only `onboarding_completed`)
- `news_pool.py`: added `clear_pool()` function + API endpoint
- `evolver.py`: `(無新聞)` → `(no news)`, candidate awareness text Chinese → English

## 語言規則
- 思考過程（thinking）可以使用英文
- 所有最終回覆必須使用繁體中文
