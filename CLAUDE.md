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

## 語言規則
- 思考過程（thinking）可以使用英文
- 所有最終回覆必須使用繁體中文
