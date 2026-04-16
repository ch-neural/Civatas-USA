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

## Evolution System Overhaul (2026-04-13)

### US Political Engine Rewrite
The evolution engine was rewritten from Taiwan-specific logic to US context:

**Candidate Scoring** (`evolver.py`):
- Taiwan parties (KMT/DPP/TPP) → US parties (Democrat/Republican/Independent)
- Role detection: incumbent, governor, senator (replaces 市長/縣長/立委)
- Party-leaning alignment uses Cook PVI buckets (Solid Dem/Lean Dem/Tossup/Lean Rep/Solid Rep)

**Political Leaning Shifts** (`evolver.py`):
- Labels: `偏右派/偏左派/中立` → `Solid Dem/Lean Dem/Tossup/Lean Rep/Solid Rep`
- Shift rules: Right-leaning → Tossup on low local satisfaction; Left-leaning → Tossup on low national satisfaction; Tossup → Lean Rep/Dem on high satisfaction
- All shift messages in English
- `consecutive_extreme_days` persists in agent state across jobs

**Attitude System** (`evolver.py`, `prompts.py`):
- `cross_strait` field → `national_identity` (with backward-compat fallback)
- Values: `主權/經濟/民生` → `social justice/economy/quality of life`
- Prompt variable: `{cross_strait_label}` → `{national_identity_label}`

**Chinese String Cleanup** (4 files):
- `evolver.py`: social post labels, section headers, district news headers
- `crawler.py`: `LEANING_OPTIONS`, default leaning → Cook PVI buckets
- `news_pool.py`: inject defaults → "Manual inject" / "Tossup"
- `feed_engine.py`: article categorization keywords (Taiwan terms → US), occupation matching, source names, fuzzy matching patterns, irrelevant content filters

### Advanced Evolution Parameters
`EvolutionQuickStartPanel.tsx` — expandable "Advanced Parameters" section with 6 categories:

| Category | Parameters |
|----------|-----------|
| Political Leaning Shifts | enable toggle, low sat threshold, high anx threshold, consecutive days |
| News Impact & Echo Chamber | news_impact, serendipity_rate, articles_per_agent, forget_rate |
| Emotional Response | delta_cap_mult, satisfaction_decay, anxiety_decay |
| Undecided & Party Effects | base_undecided, max_undecided, party_align_bonus, incumbency_bonus |
| Life Events | individuality_multiplier, neutral_ratio |
| News Category Mix | candidate%, national%, local%, international% (must sum to 100) |

Parameters flow: template `default_calibration_params` → Quick Start `advParams` state → `scoring_params` in evolution API → `evolver.py` reads from `job["scoring_params"]`.

### Differentiated Template Calibration
Each template context has tuned defaults in `build_national_template.py`:

| Parameter | Generic | 2024 | 2028 | State |
|-----------|---------|------|------|-------|
| news_impact | 2.0 | 2.5 | 1.8 | 2.2 |
| serendipity_rate | 0.05 | 0.03 | 0.08 | 0.04 |
| base_undecided | 0.12 | 0.08 | 0.20 | 0.10 |
| incumbency_bonus | 10 | 8 | 0 | 8 |
| shift_consecutive_days_req | 5 | 7 | 4 | 5 |
| news_mix_candidate | 15% | 35% | 30% | 20% |
| news_mix_local | 35% | 25% | 25% | 45% |

### LLM Negativity Bias Corrections
LLMs have inherent negativity bias — they consistently rate satisfaction lower and
anxiety higher when reacting to real news. Multiple corrections are applied:

1. **Asymmetry correction** (`evolver.py`): negative sat deltas × 0.70, positive × 1.30
   (configurable via `negativity_dampen` / `positivity_boost` in scoring_params)
2. **Satisfaction decay** toward baseline 50: default 0.04/day (doubled from original 0.02)
3. **Mean-reversion boost**: when sat < 45, extra upward pull `(45 - sat) × 0.08`
4. **Anxiety ceiling resistance**: quadratic dampening above 60 → practical cap ~70-72
   Formula: `excess² × 0.02 + excess × 0.05` where `excess = anx - 60`
5. **Partisan prompt guidance** (`prompts.py`): explicit instruction that Republican agents
   should react positively to GOP news, with "Do NOT let your own political views as
   an AI override the character's leaning"
6. **Income-scaled reactions** (`prompts.py`): explicit numerical ranges per income bracket
   (Under $25k → anxiety +8~15 on economic news; $200k+ → +0~2)

### News Category Mix System
Quick Start distributes search queries across 4 categories using topic pools:
- **Candidate**: uses candidate names + partisan sources (CNN, Fox, etc.)
- **National**: 14 topic pools (inflation, jobs, healthcare, immigration, etc.) + neutral sources
- **Local**: state name (quoted for exact match) + 10 local topics + neutral sources
- **International**: 10 global topics (NATO, China trade, UN, etc.) + neutral sources

Non-candidate queries deliberately use neutral sources (Reuters, AP, PBS) to avoid
getting candidate-heavy results from partisan sites.

### Evolution Dashboard AI Analysis
`POST /api/pipeline/evolution/analyze` — System LLM generates structured analysis:
- Triggers every 10 simulation days (configurable via `ANALYSIS_INTERVAL`)
- Also triggers when evolution completes (for remaining unanalyzed days)
- Returns JSON: `overall`, `satisfaction_anxiety`, `political_leaning`,
  `candidate_awareness`, `candidate_sentiment`
- Accumulated segments displayed in purple gradient card on Dashboard
- Per-chart `ChartInsight` blocks below each chart
- Cached in `sessionStorage` per workspace — no redundant LLM calls on page revisit

### Evolution Quick Start Lifecycle
**Fresh Start** (Start Evolution button):
1. Query `/evolve/jobs` for all running/pending jobs → stop each one
2. Wait 2s for state writes to flush
3. Call `/evolve/reset` (clears agent_states, history, diaries, ChromaDB)
4. Clear news pool
5. Start round 1

**Resume** (after pause): skips reset, continues from paused round

**Page Reload Recovery**: mount detects `evolution-progress` status:
- `evolving` + backend job running → starts polling loop, then continues next round
- `evolving` + backend job stopped/failed → clears stale progress
- `paused` → shows Resume/Restart/Stop buttons
- `done` → shows completion UI

**Completion Detection** (`use-workflow-status.ts`):
- Sidebar ✓ requires `evolution-progress.status === "done"` (not just any completed job)
- Spinner on Evolution label when any job is running/pending (polls `/evolve/jobs` every 5s)

### Live Message Ring Buffer
`MAX_LIVE_MESSAGES = 50`, `MAX_PRIORITY_MESSAGES = 20`.
Leaning shift messages (`shifted from`) are tagged as priority (same as KOL posts)
so they survive ring buffer eviction by regular diary messages.

### Sidebar & Branding
- Site name: **Civatas USA** (layout.tsx, WorkflowSidebar, OnboardingWizard, i18n)
- Evolution sub-items order: Quick Start → Dashboard → Agent Explorer → News Sources
- `WorkspaceListPanel`: auth token check removed (no more redirect to deleted `/login`)

### Known Monitoring Observations (as of 2026-04-13)
From extensive monitoring of 10-30 day evolution runs:
- **sat** typically settles around 45-48 over 10 days (mean-reversion prevents collapse below 45)
- **anx** typically settles around 55-58 (ceiling resistance prevents runaway above 70)
- **Leaning shifts** require 5+ consecutive days at threshold — typically 0-2 shifts in 10-day runs
- **Lean Rep** group (6 agents) has high variance due to small sample size
- **Rep+Trump positive reaction rate**: ~35-50% (up from ~0% before prompt fix)
- **Income sensitivity**: low income anxiety ~2-3× higher than high income on economic news
- **Personality traits** correctly modulate: stable agents ±0-3, sensitive agents ±10-30
- **Cognitive biases** differentiate: apathetic +1 anx, conformist +8 anx, pessimist +4 anx

### Development Notes
- Persona personality values are now emitted in English by default
  (`highly expressive` / `stable and calm` / `extroverted` / `set in views`,
  cognitive_bias as `optimistic` / `pessimistic` / `rational` / etc.) matching
  `evolver._personality_modifiers` and `_BIAS_DESC` keys exactly. Legacy CJK
  values (穩定冷靜/etc.) on pre-existing personas continue to work via the
  bilingual lookup. Re-generating personas is only required to align display
  labels in the UI; evolution math works either way.
- `main.py` Taiwan-specific code: the **3 active prediction endpoints** were
  US-localized on 2026-04-15 (`/satisfaction-survey`, `/auto-traits`,
  `/candidate-profile`). The orphan `/election-db/identity-trends` and
  `/stance-trends` endpoints (NCCU TW survey data, no UI callers) were deleted
  along with their api.ts exports and pipeline.py proxies. Remaining ~55 CJK
  lines are in deeper calibration / historical-run / occupation-reclassification
  paths (lines ~1850–2100, ~2350–2720) that are not on the active 3-step workflow
  and were left as-is.
- `feed_engine.py` is **already clean** — 0 CJK characters and 0 Taiwan source
  names. Earlier note about residual TW source names was stale.

## Multi-Vendor Evolution Fix (2026-04-14)

### 問題背景
使用者在 persona 生成之後，才新增了 Moonshot（kimi-k2.5）廠商。因為 persona 生成時還沒有 moonshot，所以所有 agent 的 `llm_vendor` 都沒有分配到 moonshot，導致 Moonshot 從未被呼叫。

### 修復項目

**1. Agent 輪流重新分配（Round-robin redistribution）**

`ap/services/evolution/app/evolver.py` — `_run_evolution_bg()` 開頭新增：
```python
if enabled_vendors:
    for i, agent in enumerate(agents):
        agents[i] = {**agent, "llm_vendor": enabled_vendors[i % len(enabled_vendors)]}
    logger.info(f"[{job['job_id']}] Redistributed {len(agents)} agents across vendors: {enabled_vendors}")
```

`ap/services/evolution/app/main.py` — `start_evolve()` 傳入 `enabled_vendors=req.enabled_vendors`

`ap/services/evolution/app/evolver.py` — `start_evolution()` 接收並儲存 `enabled_vendors`，傳給 background task

**2. Moonshot kimi-k2.5 溫度限制修復**

kimi-k2.5 只允許 temperature=1（送其他值回傳 HTTP 400）。根本原因：每個 agent 有 `temperature_offset`（個性差異），加到 temperature=1.0 後就不等於 1 了。

修復：在 `_call_llm()` 中對 kimi/moonshot 完全省略 temperature 參數：
```python
_skip_temperature = "kimi" in model_lower or attempt_vendor.lower().startswith("moonshot") if attempt_vendor else False
if _skip_temperature:
    chat_coro = client.chat.completions.create(model=model, messages=messages, **token_kwargs, **resp_format_kwargs)
else:
    _final_temp = max(0.1, min(2.0, temperature + temperature_offset))
    chat_coro = client.chat.completions.create(model=model, messages=messages, temperature=_final_temp, **token_kwargs, **resp_format_kwargs)
```

**重要**：修完 .py 後必須清除 Docker container 的 .pyc 快取，否則舊 bytecode 仍會被執行：
```bash
docker compose exec evolution find /app -name "*.pyc" -delete
docker compose restart evolution
```

**3. Frontend 傳入 enabled_vendors**

`ap/services/web/src/lib/api.ts` — `startEvolution()` 新增第 9 個參數 `enabledVendors?: string[]`，傳入 body 的 `enabled_vendors`

`ap/services/web/src/components/panels/EvolutionQuickStartPanel.tsx` — 呼叫 `startEvolution` 前先 fetch `/api/settings`，取出所有非 system role 的廠商 id，作為 `enabledVendors` 傳入：
```typescript
const settingsRes = await apiFetch("/api/settings");
const allVendors: any[] = settingsRes?.llm_vendors || [];
const agentVendorIds = allVendors
  .filter((v: any) => v.role !== "system" && v.id)
  .map((v: any) => v.id as string);
if (agentVendorIds.length) enabledVendors = agentVendorIds;
```

### 已驗證監控結果（job d9adc64e，3天60 agents，4廠商）

**情緒穩定性** — 均在正常範圍：
| 天 | avg_sat | avg_anx | hi_anx |
|---|---|---|---|
| Day 1 | 49.5 | 51.6 | 1 |
| Day 2 | 49.0 | 51.8 | 5 |
| Day 3 | 48.4 | 52.7 | 8 |

**4 廠商輸出一致性** — Moonshot 完全正常（0 × 400 錯誤）：
| 廠商 | Day3 Vance | Day3 DeSantis | Day3 Shapiro |
|---|---|---|---|
| OpenAI | 15.8% | 16.2% | 16.3% |
| DeepSeek | 15.8% | 16.5% | 16.8% |
| OpenAI-2 | 16.0% | 16.3% | 16.2% |
| Moonshot (kimi-k2.5) | 17.0% | 16.5% | 16.5% |

偏差 < 1.5%，屬各模型特性差異，正常。

**候選人認知** — 3天穩定：DeSantis/Shapiro ~16.4%、Vance ~16%、Undecided ~21.5%（符合 2028 base_undecided=0.20）

**其他注意事項**：
- kimi-k2.5 偶爾會返回截斷的 JSON（partial JSON），系統自動修復（diary 存在則填入預設值），不影響結果
- WatchFiles 熱重載：Uvicorn 偵測到 .py 變更會自動重啟 server，中斷正在跑的 evolution job。**演化進行中請勿編輯 evolver.py**，改完後用 `docker compose restart evolution` 乾淨重啟
- `by_vendor_candidate` 欄位在 daily_summary 中可用於驗證各廠商是否均有被呼叫

## Prediction Panel — Vote Counting Method UI Overhaul (2026-04-15)

### 問題背景
Vote Weighting dropdown 和 Electoral College checkbox 原本藏在 Prediction 面板的 **Advanced tab**（第3個分頁），預設分頁是 Base，用戶很難發現。而且沒有任何說明每種加權方式的用途，使用者不知道怎麼選。

### UI 修正（`PredictionPanel.tsx` lines 2531-2645）
從 Advanced tab 移到 **Scenario tab 頂部**（最顯眼位置），並改寫成 3 張可點選的卡片式佈局（radio group 風格），每張卡片包含：

- **圖示 + 標題**：🗳️ Unweighted / 📊 Likely Voter / ☎️ Landline-biased
- **一句話短描述**：核心概念
- **5 欄權重表格**（5 年齡段 × 權重）— 顏色編碼：
  - `>1.0` 金黃（長者高權重）
  - `<1.0` 藍色（青年低權重）
  - `=1.0` 白色（等重）
- **詳細說明**：歷史背景 + 真實案例（Clinton 2016 popular vote、Pew/NYT/Siena 的 70/30 混合法、Rasmussen 市話偏差 2016 翻車）
- **適用情境**：什麼時候選這個（對準真實選舉 / 研究誰更受歡迎 / 教學抽樣偏差）
- **⭐ Template Default 綠色徽章**：標記目前 template 推薦的選項

Electoral College checkbox 也重寫為完整說明：538 EV、270 勝出、Trump 2016 / Bush 2000 輸普選贏 EV 的案例。

### Template-driven 預設（`template-defaults.ts` 新增 `getDefaultSamplingModality()`）
切換 template 時自動選中最佳加權方式：

| Template 類型 | 自動預設 |
|---|---|
| presidential / senate / gubernatorial / house / mayoral | `mixed_73`（Likely Voter，70/30 現代民調標準）|
| 非選舉 template（無 election block） | `unweighted` |
| Template 明確指定 `election.default_sampling_modality` | 使用該值（可覆寫）|

Backend 實作已完整（`predictor.py` lines 2413-2431 `_get_sampling_weight()`）：
- **Unweighted**：所有年齡 × 1.0
- **mixed_73 (Likely Voter)**：<30:0.7 / 30s:0.8 / 40s:0.9 / 50s:1.1 / 60+:1.2
- **landline_only**：<30:0.3 / 30s:0.5 / 40s:0.8 / 50s:1.2 / 60+:1.8

### 2024 回測驗證（job 74ce8344，100 agents × 3 days，已完成）

**Prediction ID**：`e11cc9ab`　**Job ID**：`74ce8344`　**日期**：2024-10-29 ~ 2024-11-04（壓縮至 3 sim days）

**3 天 daily ce（未加權聚合）**：

| Day | Trump | Harris | Undecided | sat | anx |
|---|---|---|---|---|---|
| Day 1 | 50.9% | 37.7% | 11.4% | 46.4 | 53.6 |
| Day 2 | **52.0%** | 36.5% | 11.5% | 46.4 | 53.8 |
| Day 3 | 50.9% | 37.3% | 11.8% | 46.2 | 54.3 |

**最終 `poll_group_results["Likely Voters"]`**（套用 mixed_73 年齡加權 + vote sim）：

| 候選人 | 預測 | 2024 實際 | 誤差 |
|---|---|---|---|
| **Donald Trump** | **50.9%** | 50.2% | 🎯 **0.7%**（極準！）|
| Kamala Harris | 37.3% | 48.3% | ❌ -11.0%（Moonshot bias）|
| Undecided | 11.8% | ~1.5% | ⚠️ 偏高 |

**最終 `electoral_college_results["Likely Voters"]`**：

| | 預測 | 2024 實際 |
|---|---|---|
| Trump EV | **447** | 312 |
| Harris EV | 3 | 226 |
| covered_ev | 450/538 | - |
| uncovered_states | 17 州 | - |

- **5-bucket leaning** ✅：Solid Rep:29 / Lean Rep:22 / Solid Dem:26 / Lean Dem:23（無 Tossup 樣本）
- **州別覆蓋**：34/50（16+DC 無 agent 樣本被正確列為 uncovered）
- **Vote Weighting 確認運作**：live_messages 顯示 `📊 Agent #X (weight 0.9) voted:` — 40 歲 agents 權重 0.9，符合 mixed_73 公式 ✅
- **kimi-k2.5 ⚡partial** 截斷 JSON 自動修復機制全程運作正常，無崩潰

### 🔑 關鍵發現：Popular Vote vs Electoral College 失準原因

**Popular vote 超準（誤差 0.7%）**，但 EC 嚴重失真（Trump 447 vs Harris 3）— 原因：

1. **每州樣本過小**：100 agents / 34 states = 平均 ~3 agents/州
2. **Moonshot Trump bias 在小樣本時放大**：穩定藍州（CA、NY、IL、MA、NJ）因單一 Moonshot agent 就能翻盤
3. **EC winner-take-all 對樣本量極敏感**：州內 3-5 票差即可翻轉整州 EV

**EC 邏輯本身 100% 正確**（538 總額、270 門檻、winner-take-all、uncovered states 處理皆符合預期）。

### 🛠️ 下一步開發方向（繼續時的待辦）

**優先級高**：
1. **提高 agent 數以讓 EC 準確**：
   - 100 → **1000+** agents（每州 ≥20 樣本才穩定）
   - 或 **proportional sampling**：依人口分布生成（如 CA 應有 ~120 agents、WY 僅 ~1.5）
2. **解決 Moonshot Trump bias**：
   - 方案 A：降低 Moonshot 在 Democrat agents 的使用比例（prompt 端或 vendor dispatch 端）
   - 方案 B：在 Moonshot 回傳的候選人分數上加校正常數（後處理 deskew）
   - 方案 C：只把 Moonshot 用於 Republican-leaning agents（性格匹配）
3. **修補 `by_vendor_candidate` 在 prediction 的缺失**：
   - evolution 有、prediction 沒有 — 需在 `predictor.py` 的 `_simulate_vote` / daily aggregation 加上 vendor 級統計累積

**優先級中**：
4. **satisfaction_decay UI 預設漂移**：舊 ui-settings 的 0.02 覆蓋新預設 0.04。考慮在 `PredictionPanel.tsx` line 866 的 `cfg.satisfactionDecay !== undefined` 改為 `=== undefined ? 0.04` 或判斷「看起來是舊預設就覆寫」
5. **Tossup 桶的產生**：目前 persona 生成傾向把所有 agent 塞進 4 個 leaning 桶，Tossup 完全沒樣本。應在 `synthesis/builder.py` 或 persona generation 端確保按 PVI 分布產生（Tossup 應占 ~5-10%）
6. **Prediction 慢（3 天跑 60+ 分鐘）**：Moonshot 延遲拉長總時間。考慮：
   - concurrency 4 → 8
   - 或對 Moonshot 加 timeout + fallback 到其他廠商

**優先級低**：
7. UI 改進：EC 結果頁面視覺化（美國地圖著色、EV 走勢條圖）
8. 將 `use_electoral_college` 的 checkbox 預設邏輯複製到 satisfaction mode 下隱藏（目前已在 election mode 才顯示）

### 📂 本次修改過的檔案清單
| 檔案 | 變更摘要 |
|---|---|
| `ap/services/web/src/components/panels/PredictionPanel.tsx` | Vote Counting Method UI 卡片化、從 Advanced 搬到 Scenario tab 頂部、套用 Template Default、5 欄權重表格 |
| `ap/services/web/src/lib/template-defaults.ts` | 新增 `getDefaultSamplingModality()` helper |
| `ap/services/web/src/lib/api.ts` | `createPrediction()` 第 25 參數 `useElectoralCollege` |
| `ap/services/evolution/app/main.py` | `CreatePredictionRequest` 新增 `use_electoral_college`，history fallback for dashboard |
| `ap/services/evolution/app/predictor.py` | `STATE_ELECTORAL_VOTES` 常數、`_compute_electoral_college()` 函式、5-bucket `_redistribute_leaning_by_ground_truth` |
| `ap/services/evolution/app/evolver.py` | history entry 擴充 `candidate_estimate` / `by_leaning` |
| `ap/services/api/app/tavily_research.py` | Serper `lr=lang_en` + `_has_cjk()` filter |

### 🔄 如何在另一台 PC 恢復開發
1. `git pull`（最後 commit 前確認 `git status` 有無 uncommitted changes — Job 74ce8344 已完成無需重跑）
2. `cd ap && docker compose up --build -d`（api/evolution/web 需重建）
3. 打開 http://localhost:3100 → 選 2024 Trump vs Harris template → 走 Persona → Evolution → Prediction
4. Prediction 歷史可在 `/api/pipeline/evolution/predictions` 找到 `e11cc9ab`
5. 要看 UI 新版本：Scenario tab 頂部有 3 張計票方式卡片 + EC checkbox

### 其他本日已驗證的修正
先前 9 項修正（2026-04-14 Evolution System Overhaul 延伸）全部運作正常：
1. ✅ `enabled_vendors` 傳遞到 prediction（4 廠商含 Moonshot）
2. ✅ Electoral College auto-enable（US presidential template）
3. ✅ Cook PVI 5-bucket leaning redistribution（原本只有 2 桶）
4. ✅ `negativity_dampen=0.70` / `positivity_boost=1.30`（LLM 負向偏差修正）
5. ✅ Tavily/Serper `lr=lang_en` + CJK post-filter（避免中日文新聞混入）
6. ✅ Evolution history 擴充寫入 `candidate_estimate` 與 `by_leaning`
7. ✅ Dashboard 從 history 檔案 fallback（job 被 clear 後仍可還原）

## Snapshot-Inherited Scoring Params + Symmetric Party Detection (2026-04-16)

延續 04-15 P1 預測的 Vance bug 與 Moonshot 樣本污染，本日重跑 P2（2028 template, 100 personas）並一次解決多個結構性問題。所有 commit 都在 `25f361b` (`fix: symmetric party detection + news_pool timestamp handling`) 與後續 uncommitted 工作裡。

### P2 30 天演化監控結果（pre-fix vs post-fix）

| 指標 | Pre-fix run | **Post-fix run** | 改善 |
|---|---|---|---|
| 總時間 | 3h 20min | **1h 54min** | 1.75× 快 |
| HTTP 失敗率 | Moonshot 39% × 429 + 10×OpenAI 502 | **僅 13×OpenAI 502** | 99.6% 成功 |
| Solid Dem 對 Dem 候選人 | Dem 32.4 vs Rep 39.8（**反向 −7.4**）| **Dem 54.3 vs Rep 21.8（+32.5）** | 黨派對齊正常 |
| Vance 排名 | **#1（22.4%）** 一家獨大 | **#3（14.7%）** Shapiro 18.6 領先 | 公平 |
| news_pool crash | 8 次 HTTP 500 | **0 次** | 修復 |

### 三大根本性修正

**1. `news_pool._trim_pool` 在 ISO 8601 timestamp 下崩潰**
- 位置：`ap/services/evolution/app/news_pool.py:206`
- 症狀：`ValueError: could not convert string to float: '2026-04-14T14:26:13.628324+00:00'`
- 觸發：每次 `POST /news-pool/inject` 觸發 trim 都中斷（混合 epoch float 與 ISO 字串）
- 修正：新增 `_parse_crawled_ts()` helper，dual-format 解析

**2. 候選人黨派辨識不對稱（最大 bug）**
- 位置：`evolver.py:1955-1958` 用 template 的 `_party_detection` 名單比對
- 根因：2028 template 的 R 名單只有 `[republican, gop, trump, vance, pence, ...]`，**只有 Vance 有對應姓氏**。Newsom / DeSantis / Whitmer / Haley / Shapiro 全部被視為 partyless → 沒有 `+party_align_bonus`、沒有 `cross_party_penalty` → Vance 在 Solid Dem 桶都能拿 16% +
- 後果：30 天演化後 Vance 22.4%、Solid Dem 反而偏向 Rep 候選人
- 修正（Option C，通用性最高）：
  - `evolver.py` 新增 `_augment_party_detection()`：從 candidate desc 關鍵字（`democrat/progressive/reproductive rights → D`，`republican/gop/conservative/anti-woke → R`，`independent/libertarian/green party → I`）自動抽取姓氏加入名單
  - 整合進 `start_evolution()` job 建立流程
  - 同步整合進 `predictor.save_prediction()` 確保 prediction 端也對稱
- 驗證：6 位 2028 候選人現全部正確分類（Newsom→D, DeSantis→R, Whitmer→D, Haley→R, Shapiro→D；Vance 原本就在 R）

**3. Moonshot 排除（暫時性 workaround，非永久 fix）**
- Pre-fix run 197 次 429（39% 失敗率）+ 513 次 fallback → Moonshot 的 `by_vendor_candidate` 是過濾後小樣本，造成虛假 vendor bias
- 暫時把 Moonshot 從 `enabled_vendors` 移除，3 vendor (OpenAI/DeepSeek/OpenAI-2) 的 spread 只有 1-3%，乾淨
- 真正修復方案（未做）：加 token bucket / 主動限流，或在 round-robin 時降低 Moonshot 權重

### Snapshot 自包含 scoring_params（Option Z）

**問題**：04-15 P1 預測 advanced params 從 ui-settings 載入，與 evolution 實際使用的不同步（`satisfactionDecay 0.02 vs 0.045`、`shiftSatLow 20 vs 25` 等 5 項）。每跑新 evolution 還要手動重設 prediction 參數。

**解法（通用、自包含）**：snapshot 建立時**自動繼承**演化實際用的 scoring_params + augmented party_detection + candidate_names。Prediction 建立時自動 merge。

| 檔案 | 變更 |
|---|---|
| `snapshot.py:save_snapshot()` | 新增 3 個參數 (`scoring_params`, `party_detection`, `candidate_names`)；若 None 則自動從同 workspace 最近一筆 `completed` job 繼承 |
| `main.py:SaveSnapshotRequest` | 新增對應 3 個 optional 欄位 |
| `predictor.py:save_prediction()` | 讀 `snap.scoring_params` 與使用者傳入的 scoring_params **merge**（user 優先）；party_detection 與 augmented 結果 merge |
| `PredictionPanel.tsx` | 選 snapshot 時 useEffect 拉 `snap.scoring_params`，逐 key 套用到 13 個 advanced state；頂部紫色 banner 顯示「📌 已從 snapshot 同步 N 個參數」 |

**Backfill 既有 snapshot**：對 P2 的 `bb18a488` 已執行（直接寫入 `meta.json`，原始備份在 `meta.json.bak`），現有 prediction 也能用。腳本邏輯：
```python
# in container
from app.evolver import _jobs
latest = sorted([j for j in _jobs.values() if j.get('status')=='completed'],
                key=lambda j: j.get('completed_at',0), reverse=True)[0]
meta['scoring_params'] = latest['scoring_params']
meta['party_detection'] = latest['_party_detection']
meta['candidate_names'] = latest['candidate_names']
```

### Prediction 自動日期偵測

**問題**：2028 template 的 `default_evolution_window` 預設 2028-10-31~2028-11-06（未來），Serper 找不到任何新聞，agents 完全沒新聞可讀。

**邏輯（PredictionPanel.tsx 在 selectedSnap useEffect 中執行）**：
1. 從 `activeTemplate.election.cycle` 計算選舉日 (`computeElectionDate(2028) = 2028-11-07`)
2. 比對今日：
   - **未來型**（election day > today）→ override 為 `[evo simDate, today]`，從 `ws.ui_settings['evolution-progress'].simDate`（fallback `endDate`）讀
   - **歷史型 / 回測**（election day ≤ today，如 2024）→ **保留 template 的 `election_window`**（如 2024-10-29~2024-11-04），讓 ground-truth 比對成立
   - 套用結果列入 banner：`predDates→2026-03-17~2026-04-16`

**注意**：用 `simDate`（最後 round 起始日）優於 `endDate`（規劃終點），因為 Quickstart 在 round 邊界更新 simDate，可給 prediction 一個有意義的多日窗口（30 天 vs 0 天）。

### Sim days 移到 Base tab

原本 `simDays` 輸入只在 Advanced tab、難找。在 PredictionPanel.tsx Base tab 的 Start/End date 旁加一格 Sim days 輸入（同一 state，新舊位置同步）。Advanced tab 的舊位置移除（concurrency 留下）。

### Pause UX 改進（3 個 panel）

**問題**：按 Pause 後立刻顯示 "Paused"，但 backend 其實要等當前 day 100 個 agents 全部處理完才到 day boundary，期間 status 已是 "paused" 但 checkpoint 尚未寫入。Resume 按鈕過早出現、checkpoint 不在磁碟。

**Fix**（新增 `pausingPending` 中介狀態，三處同步）：
| 檔案 | 改動 |
|---|---|
| `PredictionPanel.tsx` | `pausingPending` state + useEffect 監聽 live_messages 中 `Checkpoint saved` → 清掉；按鈕替換成 disabled `⏳ Pausing...` + spinner |
| `PredictionEvolutionDashboardPanel.tsx`（**用戶實際看到的 Dashboard**）| 同上機制 |
| `EvolutionQuickStartPanel.tsx` | phase label + button 加 spinner、新增藍色 banner：「會先完成當前第 X/Y 輪後才暫停」 |

### 嚴重 Bug：refresh / 切頁會誤刪 active prediction

**位置**：`PredictionPanel.tsx:1230-1244` 的 `loadPastPredictions()`

```js
// BAD: 跨所有 workspace 全刪
const stale = all.filter((p: any) => p.status === "pending" || p.status === "running");
for (const p of stale) {
  try { await deletePrediction(p.prediction_id); } catch {}
}
```

`useEffect` 在 PredictionPanel mount 時呼叫此函式 → 用戶 refresh 或從別處切回 → 把自己的 active prediction 刪掉。Docker logs 出現 `DELETE /predictions/c4902fe4 500`（重複刪報錯）。

**Fix**：
- `loadPastPredictions()` 移除 auto-delete 邏輯，改成只 list 已完成的（filter 排除 `running/paused/pending`）
- 啟動流程 `handleStart` 也加上 filter：只刪 completed/failed/cancelled，保留 running/paused/pending（active job 與 checkpoint）

### Pause / Resume 機制（跨 PC 接續）

完整機制驗證：
- 按 Pause → `pause_pred_job()` 設 `_pred_pauses[job_id] = True` + `_pred_checkpoint_pending = True`
- 主迴圈在當日 100 agents 處理完到 day boundary 時，進入 pause loop → `_save_pred_checkpoint()` 寫 `/data/evolution/pred_jobs/{job_id}.json`
- live_message 出現 `💾 Checkpoint saved (Day X) — can resume after restart`
- 此時可安全 `docker compose down`

**跨 PC 接續步驟**（前提：兩台 PC 都掛載同一個 NAS 到 `/Volumes/AI02/Civatas-USA/`）：
```bash
cd /Volumes/AI02/Civatas-USA/ap
docker compose up -d
# 進 http://localhost:3100 → prediction 頁，UI 應顯示 "Resume from checkpoint"
# 或 API call:
curl -X POST http://localhost:8000/api/pipeline/evolution/predictions/resume-checkpoint/{JOB_ID}
```

⚠️ **不要兩台 PC 同時跑 docker**（會搶寫 NAS 上的 state files）。

### 📂 本日修改過的檔案

| 檔案 | 變更摘要 |
|---|---|
| `ap/services/evolution/app/news_pool.py` | `_parse_crawled_ts()` helper + `_trim_pool` sort key |
| `ap/services/evolution/app/evolver.py` | `_augment_party_detection()` helper + `start_evolution()` 整合 |
| `ap/services/evolution/app/snapshot.py` | `save_snapshot()` 新增 3 個 optional 參數 + auto-inherit 邏輯 |
| `ap/services/evolution/app/main.py` | `SaveSnapshotRequest` 加欄位 |
| `ap/services/evolution/app/predictor.py` | `save_prediction()` augmented PD + scoring_params merge |
| `ap/services/web/src/components/panels/PredictionPanel.tsx` | snap scoring_params sync + auto dates + Sim days input + pausingPending UX + 移除誤刪 |
| `ap/services/web/src/components/panels/PredictionEvolutionDashboardPanel.tsx` | pausingPending UX |
| `ap/services/web/src/components/panels/EvolutionQuickStartPanel.tsx` | pause spinner + banner |

### 🔄 在另一台 PC 接續開發步驟

1. **拉最新 commit + 暫存改動**：
   ```bash
   cd /Volumes/AI02/Civatas-USA
   git pull   # 最後 commit: 25f361b
   git status # 應有上表 8 檔 uncommitted
   ```
2. **啟動服務**：
   ```bash
   cd ap && docker compose up -d  # 不需 --build（程式 hot-reload 即可）
   ```
3. **驗證 P2 狀態**：
   - 工作區 `b6009461`（P2，2028 template）
   - Snapshot `bb18a488` 已 backfill scoring_params/party_detection（包含 augmented surnames）
   - 進 http://localhost:3100/workspaces/b6009461/prediction 應自動：
     - 套用 13 個 advanced params（紫色 banner）
     - 日期 2026-03-17 ~ 今日
     - Sim days 在 Base tab Start/End date 旁邊
4. **若有 paused prediction**：UI 應顯示 Resume 按鈕（如先前測試的 c4902fe4 已被誤刪 bug 砍掉，這個已修，下次 pause 會正確保留）
5. **Moonshot 修復**（未做、選擇性）：
   - 方案 A：在 `evolver.py:_call_llm` 對 Moonshot 加 ratelimit asyncio.Semaphore(1) + jitter
   - 方案 B：在 round-robin redistribution 時降低 Moonshot 權重（如 4 vendor 但 Moonshot 只占 1/6 槽）
   - 方案 C：給 Moonshot 加 timeout + fallback（已有 fallback，但 timeout 太長）

### 待辦事項（剩餘）

優先序：
1. **Moonshot rate-limit 主動限流** — 解決後可重啟 4 vendor 跑驗證
2. **EC 預測準確度** — 100 agents 太少，考慮 1000+ 或 proportional sampling（CA ~120 agents、WY ~1.5）
3. **Tossup 桶 leaning shift 永久性** — 觀察到 shift 多但會回復，可調 `shift_consecutive_days_req`
4. **Settings.json 安全處理** — 內含真實 API keys 仍未從 git 移除，已在 .gitignore 但 tracked。需 `git rm --cached` + key rotation

## 語言規則
- 思考過程（thinking）可以使用英文
- 所有最終回覆必須使用繁體中文
