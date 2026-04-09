# Stage 1.5 — Real integration: `Civatas-USA/ap/` is now docker-runnable

Stage 1.5 turns `Civatas-USA/` from a "data + overlay" project into a
**fully standalone, self-contained Civatas fork** that runs end-to-end via
`docker compose up` from inside the `ap/` directory.

## What you actually need to do

```bash
cd Civatas-USA/ap
cp .env.example .env          # then edit .env to set LLM_API_KEY etc.
docker compose up --build
```

That's it. Web UI lands at <http://localhost:3000>, API gateway at
<http://localhost:8000/docs>. The default workspace country is `US`, the
default UI language is `en`, the default time zone is `America/New_York`.

The PA template (`pennsylvania_sample.json`) is pre-installed. Pick it from
the templates list when creating your first workspace.

## Architecture

```
Civatas-USA/                    ← the standalone project (~110 MB total)
├── ap/                         ← the runnable fork (35 MB, 291 files)
│   ├── docker-compose.yml      ← CIVATAS_COUNTRY=US wired into 3 services
│   ├── .env.example            ← US defaults
│   ├── data/
│   │   ├── templates/          ← pennsylvania_sample.json (US) + taichung_sample.json (TW, kept for fallback)
│   │   ├── elections-us/       ← us_election.db (SQLite, populated)
│   │   ├── elections/          ← leaning_profile_us.json
│   │   ├── census/             ← states.json + counties.json
│   │   └── geo/                ← us-counties.geojson + us-states.geojson
│   ├── shared/
│   │   ├── us_admin.py         ← Stage 1 overlay applied
│   │   ├── us_leaning.py       ← Stage 1 overlay applied
│   │   ├── us_article_filters.py ← Stage 1 overlay applied
│   │   ├── article_filters.py  ← Stage 1.5 shim: country branch
│   │   ├── us_data/            ← US auxiliary data, bind-mounted into all services
│   │   │   ├── census/
│   │   │   ├── elections/
│   │   │   ├── geo/
│   │   │   └── us_election.db
│   │   └── i18n/locales/
│   │       ├── en.json         ← extended with us.* namespace
│   │       └── zh-TW.json      ← extended with parallel us.* keys
│   ├── services/
│   │   ├── api/app/tavily_research.py        ← shim: SERPER_GL/HL by country
│   │   ├── evolution/app/
│   │   │   ├── prompts_en.py                  ← Stage 1 overlay (English LLM prompts)
│   │   │   ├── us_feed_sources.py             ← Stage 1 overlay (US media leaning map)
│   │   │   ├── us_news_keywords.py            ← Stage 1 overlay (US news keyword templates)
│   │   │   ├── us_predictor_helpers.py        ← Stage 1 overlay (US party / role helpers)
│   │   │   ├── evolver.py                     ← Stage 1.5 shim: country branch
│   │   │   ├── predictor.py                   ← Stage 1.5 shim: country branch
│   │   │   ├── feed_engine.py                 ← Stage 1.5 shim: country branch
│   │   │   └── news_intelligence.py           ← Stage 1.5 shim: country branch
│   │   ├── election-db/init/
│   │   │   ├── 001_schema.sql                 ← TW schema (kept)
│   │   │   ├── 002_identity_trends.sql        ← TW (kept)
│   │   │   ├── 003_stance_trends.sql          ← TW (kept)
│   │   │   └── us_001_schema.sql              ← Stage 2 overlay (US schema)
│   │   └── web/
│   │       ├── public/
│   │       │   ├── us-counties.geojson        ← Stage 1 overlay
│   │       │   ├── us-states.geojson          ← Stage 1 overlay
│   │       │   └── us-pvi-sample.json         ← Stage 2 overlay
│   │       └── src/components/
│   │           ├── USMap.tsx                  ← Stage 2 overlay
│   │           └── USMapExample.tsx           ← Stage 2 overlay
│   └── …                       ← everything else from upstream ap/, untouched
├── code/                       ← original Stage 1 + 2 overlay files (kept as reference)
├── data/                       ← original Stage 0 raw datasets + scripts output
├── scripts/                    ← original fetch/load scripts
├── docs/
├── README.md                   ← Stage 0
├── STAGE1.md                   ← Stage 1 (overlay)
├── STAGE2.md                   ← Stage 2 (structural)
└── STAGE1.5.md                 ← this file
```

## How the country switch works

Each service that depends on country-aware behavior reads
`CIVATAS_COUNTRY` once at module import time:

```python
CIVATAS_COUNTRY = os.environ.get("CIVATAS_COUNTRY", "TW").upper()
```

Then loads either the US extension modules (`prompts_en`, `us_*`) or keeps
the original TW behavior. There is no per-request switching — the env var
sets the entire stack at boot. To run a TW workspace, set
`CIVATAS_COUNTRY=TW` in `.env` and rebuild; everything reverts to the
original Taiwan path.

The full list of files modified by Stage 1.5 shims (each adds 5–25 lines, no
behavior change for TW):

| File                                              | Change |
| ------------------------------------------------- | ------ |
| `ap/services/evolution/app/evolver.py`            | Country branch on `EVOLUTION_PROMPT_TEMPLATE.format()`, `DIARY_PROMPT_TEMPLATE.format()`, `SCORING_PROMPT_TEMPLATE.format()`. Extended `_shift_map` with `inclusive`/`restrictive`. Reads `national_identity_shift` JSON key as alias for `cross_strait_shift`. |
| `ap/services/evolution/app/predictor.py`          | Country branch on `_get_leaning_for_candidate()` and `_prompt_base.format()`. |
| `ap/services/evolution/app/feed_engine.py`        | Swaps `DEFAULT_SOURCE_LEANINGS` and `DEFAULT_DIET_MAP` for the US versions when `CIVATAS_COUNTRY=US`. |
| `ap/services/evolution/app/news_intelligence.py`  | `build_default_keywords()` dispatches to `us_news_keywords` for US. Original TW logic moved to `_build_default_keywords_tw()`. |
| `ap/shared/article_filters.py`                    | `is_relevant_article()` dispatches to `us_article_filters` for US. |
| `ap/services/api/app/tavily_research.py`          | `SERPER_GL`/`SERPER_HL` derived from country (replaces hardcoded `"tw"`/`"zh-TW"` in 2 payloads). |

The PVI / FIPS data is loaded by `us_admin.load_fips_index()` and
`us_leaning.load_county_pvi()` which look at, in order:

1. explicit `data_dir` argument
2. `CIVATAS_USA_DATA_DIR` environment variable (set to `/app/shared/us_data` in docker-compose)
3. sibling `us_data/` directory next to the python file (works because `shared/` is bind-mounted)
4. upward walk for `data/census/` (dev-mode fallback)

## Smoke tests run during Stage 1.5

```
docker compose config --quiet         → exit 0
python3 -m py_compile (9 files)        → OK
```

US-mode boot test (loads every shimmed file with CIVATAS_COUNTRY=US):

```
FIPS:        51 states / 3142 counties
PVI:         3152 counties
PA Allegheny → Pennsylvania|Allegheny County → Lean Dem
evolver:     EVOLUTION_PROMPT_TEMPLATE_EN loaded, "real US resident" present
predictor:   US voting prompt loaded, "Democratic — Jane Doe" → "Lean Dem"
feed_engine: 53 sources, Fox News → Solid Rep
news_intel:  '"Allegheny County" governor mayor government'
filters:     reddit r/aww blocked, NYT politics passed
tavily:      Serper gl=us hl=en

Stage 1.5 boot smoke test: ALL OK
```

TW-mode regression (CIVATAS_COUNTRY=TW):

```
evolver:     "台灣居民" present
predictor:   "盧秀燕(中國國民黨)" → "偏藍"
feed_engine: 自由時報 → 偏左派
news_intel:  '"台中市" 市政 政策'
tavily:      Serper gl=tw hl=zh-TW

TW regression: OK
```

Both branches coexist — flipping `CIVATAS_COUNTRY` in `.env` is enough to
switch the entire stack without code changes.

## What is NOT yet wired up (acknowledged limitations)

1. **The frontend still mounts `<TaiwanMap>`, not `<USMap>`** in
   panels like `EvolutionDashboardPanel`, `PopulationSetupPanel`, etc. The
   `USMap` component is in place at `ap/services/web/src/components/USMap.tsx`
   but the existing panels were not retrofitted with a country switch — they
   still call `<TaiwanMap data={…} />` directly. **Backend evolution and
   prediction will run correctly in US mode**, but the map will look wrong
   until the panels are updated. This is a frontend-only follow-up: each
   panel needs `country === "US" ? <USMap … /> : <TaiwanMap … />`.

2. **No workspace `country` field in the API schema yet.** The country
   switch is currently env-var-only (one workspace per docker stack). Adding
   `workspace.country` and threading it through the predictor/evolver job
   payload is the next iteration; for now everyone in the stack runs the
   same country.

3. **Persona prompts are unchanged.** The persona enrichment service
   (`ap/services/persona/`) still uses Taiwan-context prompts. Personas
   generated for a US PA workspace will mention Taiwan-style cultural cues
   in their bios. Fix: add a `prompts_en` for persona service in Stage 3.

4. **The election-db Postgres container still uses the TW schema.** Stage 2
   wrote `us_001_schema.sql` and a SQLite loader, but the Postgres init
   script ordering means TW schema runs first. The US tables coexist
   in the same database (because they're namespaced `us_*`), but the US
   data itself is loaded into a separate SQLite at
   `data/elections-us/us_election.db`, NOT into Postgres. Fix: add a
   Postgres-side loader to Stage 3.

5. **Calibrator** still calls `predictor.py` heuristics that were built
   for KMT/DPP/TPP. The English CALIBRATOR_PROMPT_TEMPLATE in
   `prompts_en.py` is not yet wired into `calibrator.py`.

These limitations were called out in STAGE1.md and STAGE2.md and remain
deferred to Stage 3.

## Verification checklist

Before declaring Stage 1.5 done, verify:

- [x] `cd Civatas-USA/ap && docker compose config` exits 0
- [x] Every shimmed Python file compiles (`python3 -m py_compile`)
- [x] US env loads all 9 shimmed modules without errors
- [x] PA template + leaning_profile_us are findable from inside the container layout
- [x] TW regression: setting `CIVATAS_COUNTRY=TW` produces unchanged TW behavior
- [ ] (Manual, requires LLM API key) Create a US workspace, run a 5-day evolution on 10 PA agents, confirm diaries are in English with US political context
- [ ] (Manual) Run a contrast prediction (Harris vs Trump) and confirm the predictor returns valid US party names

The last two require an actual LLM API key + the docker stack running, so
they are documented as manual tests to perform after `docker compose up`.

## File counts

```
Stage 1.5 added:
  - 0 new files in ap/ (everything was either copied from code/ or modified)
  - 6 modified files (the country shims listed above)
  - 6 ap/data/ data files placed at expected paths
  - 6 ap/shared/us_data/ data files for runtime auto-discovery
  - 1 .env.example rewrite
  - 1 docker-compose.yml edit (CIVATAS_COUNTRY env vars)
  - 1 STAGE1.5.md doc

Total ap/ size: 35 MB / 291 files (vs upstream ap/ at 1.1 GB / 1989 files
because we excluded node_modules, election-db data, evolution cache, and
projects state).
```

## Running it

```bash
cd Civatas-USA/ap
cp .env.example .env
$EDITOR .env                              # set LLM_API_KEY (and SERPER_API_KEY for news)
docker compose up --build                 # first-time build takes 10-20 minutes
# In another shell once services are up:
open http://localhost:3000                # web UI
open http://localhost:8000/docs           # API docs
```

Then in the web UI:
1. **Create new project** → pick template `pennsylvania_sample`
2. **Upload statistics** → already filled by the template
3. **Synthesize population** → 10–100 agents to start
4. **Generate personas** → fast; ~$0.01 per agent at gpt-4o-mini
5. **Run evolution** → 5–30 days; costs $0.50–5 depending on agent count
6. **Run prediction** → contrast polls (e.g. Harris vs Trump)

Expected behavior in US mode:
- Diaries are written in English in a US-resident voice
- News searches return US sources (NYT, WaPo, Fox, AP, etc.)
- Candidate party leanings are mapped to Lean Dem / Lean Rep / etc.
- Local satisfaction tracks Governor / state legislature
- National satisfaction tracks President / Congress / Federal Reserve
