# Stage 1 — US localization code overlay

Stage 1 adds the **code** layer on top of Stage 0's data. Everything still
lives inside `Civatas-USA/`; nothing in `ap/` is modified. When you fork the
project, copy this `code/` overlay onto the fork and follow the integration
checklist below.

## What's in `code/`

The directory mirrors `ap/` so the file names line up 1:1 with the Civatas
modules they replace or extend. **All files are new — none of them overwrite
an existing `ap/` file.** They are designed to be imported alongside the
existing TW modules with a country switch (`country == "US"`).

```
code/
└── ap/
    ├── shared/
    │   ├── us_admin.py                       — replaces tw_admin.py
    │   ├── us_leaning.py                     — replaces leaning.py
    │   ├── us_article_filters.py             — replaces article_filters.py
    │   └── i18n/locales/
    │       ├── en.json                        — extends ap/shared/i18n/locales/en.json (adds `us.*` namespace)
    │       └── zh-TW-us-additions.json        — keys to merge into zh-TW.json
    └── services/
        ├── evolution/app/
        │   ├── prompts_en.py                  — English EVOLUTION/DIARY/SCORING/VOTING/CALIBRATOR templates
        │   ├── us_feed_sources.py             — replaces feed_engine.DEFAULT_SOURCE_LEANINGS + DEFAULT_DIET_MAP
        │   ├── us_news_keywords.py            — replaces news_intelligence.build_default_keywords()
        │   └── us_predictor_helpers.py        — replaces predictor._get_leaning_for_candidate() + role detection
        └── web/public/
            ├── us-states.geojson              — 56 features (50 + DC + territories)
            ├── us-counties.geojson            — 3,231 features
            └── MAP_INTEGRATION.md             — how to wire these into PlaybackViewer.tsx
```

All Python modules pass `python3 -c "import …"` and have working smoke tests
(see "Verifying the overlay" below).

## What still requires touching `ap/` (the integration shim)

The overlay is mostly drop-in, but six small `ap/` files need a country-aware
branch added. Each is a 5–20 line change. None of them changes Taiwan
behavior — the new branch only fires when `workspace.country == "US"`.

### 1. `ap/services/evolution/app/evolver.py`

- After the existing `EVOLUTION_PROMPT_TEMPLATE` definition (~line 93), add:

  ```python
  from .prompts_en import (
      EVOLUTION_PROMPT_TEMPLATE as EVOLUTION_PROMPT_TEMPLATE_EN,
      DIARY_PROMPT_TEMPLATE as DIARY_PROMPT_TEMPLATE_EN,
      SCORING_PROMPT_TEMPLATE as SCORING_PROMPT_TEMPLATE_EN,
  )

  def _get_evolution_template(country: str) -> str:
      return EVOLUTION_PROMPT_TEMPLATE_EN if country == "US" else EVOLUTION_PROMPT_TEMPLATE
  ```

- Wherever `EVOLUTION_PROMPT_TEMPLATE.format(...)` is called, switch to
  `_get_evolution_template(job["country"]).format(...)`.
- In the JSON-parse block (search for `cross_strait_shift`), accept the new
  field name `national_identity_shift` as a synonym when `country == "US"`,
  and extend `_shift_map` (~line 1490) so:

  ```python
  _shift_map = {
      "left": -3, "progressive": -3, "independence": -3, "inclusive": -3,
      "none": 0,
      "right": +3, "conservative": +3, "unification": +3, "restrictive": +3,
  }
  ```

### 2. `ap/services/evolution/app/predictor.py`

- Replace the body of `_get_leaning_for_candidate` (~line 150) with a country
  switch:

  ```python
  from .us_predictor_helpers import get_leaning_for_candidate as us_get_leaning

  def _get_leaning_for_candidate(candidate_key: str, country: str = "TW") -> str:
      if country == "US":
          return us_get_leaning(candidate_key)
      # … existing TW body …
  ```

- The voting prompt (`_prompt_base` at ~line 2164) follows the same pattern as
  the evolver template — pick `prompts_en.VOTING_PROMPT_TEMPLATE` when
  `country == "US"`.

- The party-keyword regex blocks in `_calculate_heuristic_score` (KMT/DPP/TPP
  detection) need a US branch using
  `us_predictor_helpers.detect_party()`,
  `is_incumbent_keyword()`, `is_admin_keyword()`. The five lines of bonuses
  underneath them stay the same; only the keyword sets change.

### 3. `ap/services/evolution/app/feed_engine.py`

- Replace the constant `DEFAULT_SOURCE_LEANINGS` with a function that
  picks the right map by country:

  ```python
  from . import us_feed_sources

  def _source_leanings(country: str) -> dict[str, str]:
      return us_feed_sources.DEFAULT_SOURCE_LEANINGS if country == "US" else _TW_DEFAULT_SOURCE_LEANINGS
  ```

  (The existing dict literal becomes `_TW_DEFAULT_SOURCE_LEANINGS`.)
- Same treatment for `DEFAULT_DIET_MAP`.
- The diet rules accessor `get_diet_rules()` already accepts a `country` arg
  in the call sites — thread it through to `_source_leanings()`.

### 4. `ap/services/evolution/app/news_intelligence.py`

- Replace `build_default_keywords` with a country-aware wrapper:

  ```python
  from . import us_news_keywords

  def build_default_keywords(region: str, country: str = "TW") -> tuple[list[str], list[str]]:
      if country == "US":
          return us_news_keywords.build_default_keywords(region)
      # … existing TW body …
  ```

- In `search_news_for_window`, when `country == "US"` pass
  `us_news_keywords.SERPER_LOCALE` (gl=us, hl=en) to the Serper request
  instead of the hard-coded `gl=tw, hl=zh-TW`. Same change in
  `ap/services/api/app/tavily_research.py`.

### 5. `ap/shared/article_filters.py`

- Wrap the existing function to dispatch by country:

  ```python
  from . import us_article_filters

  def is_relevant_article(title="", source="", summary="", country="TW"):
      if country == "US":
          return us_article_filters.is_relevant_article(title, source, summary)
      # … existing TW body …
  ```

### 6. Frontend — `ap/services/web/`

- Drop `code/ap/services/web/public/us-{states,counties}.geojson` into
  `ap/services/web/public/`.
- Add a `country` field to the workspace schema (whatever shape your
  `Workspace` type uses) and default new workspaces to `"US"`.
- Update `PlaybackViewer.tsx` per `MAP_INTEGRATION.md` (Albers USA projection,
  state→county zoom, FIPS filter).
- Wire `i18n/locales/en.json` → use the new `us.*` namespace; merge
  `zh-TW-us-additions.json` into `zh-TW.json`.
- Set the default UI language to `en` (the user explicitly asked for English
  default with a language switch).

## Verifying the overlay (no app code required)

Run from the repo root (`/Volumes/AI02/Civatas-V01/`):

```bash
cd Civatas-USA
python3 - <<'PY'
import sys
sys.path.insert(0, "code/ap/shared")
sys.path.insert(0, "code/ap/services/evolution/app")

import us_admin
us_admin.load_fips_index("data")
assert len(us_admin.all_state_fips()) == 51
assert len(us_admin.all_county_fips()) == 3142
assert us_admin.fips_to_key("42003") == "Pennsylvania|Allegheny County"

import us_leaning
us_leaning.load_county_pvi()
assert us_leaning.county_leaning("42101") == "Solid Dem"          # Philadelphia
assert us_leaning.county_leaning("42003") in {"Lean Dem", "Tossup"}  # Allegheny
assert us_leaning.normalize_leaning("Democratic") == "Lean Dem"

import prompts_en
assert "real US resident" in prompts_en.EVOLUTION_PROMPT_TEMPLATE
assert "real American voter" in prompts_en.VOTING_PROMPT_TEMPLATE

import us_predictor_helpers as P
assert P.get_leaning_for_candidate("Democratic — Jane Doe") == "Lean Dem"
assert P.is_incumbent_keyword("Two-term Governor of Pennsylvania")

import us_news_keywords as K
local, national = K.build_default_keywords("Pennsylvania|Allegheny County")
assert any("Allegheny" in q for q in local)
assert any("United States" in q for q in national)

import us_feed_sources as F
assert F.DEFAULT_SOURCE_LEANINGS["Fox News"] == "Solid Rep"
assert F.DEFAULT_SOURCE_LEANINGS["NPR"] == "Lean Dem"

import us_article_filters as A
assert A.is_relevant_article(title="Senate vote on bill", source="nytimes.com") is True
assert A.is_relevant_article(title="Cute dogs", source="reddit.com/r/aww") is False

print("Stage 1 overlay smoke test: OK")
PY
```

This script is what the project's CI should run to keep the overlay green.

## Stage 1 scope summary

| Concern                          | Stage 1 status |
| -------------------------------- | -------------- |
| Admin hierarchy (state/county)   | ✅ overlay ready |
| Political leaning taxonomy (PVI) | ✅ overlay ready |
| LLM prompts (English)            | ✅ overlay ready |
| News source map / keywords / locale | ✅ overlay ready |
| Article relevance filter         | ✅ overlay ready |
| i18n keys                        | ✅ overlay ready |
| Map GeoJSON files                | ✅ overlay ready |
| Map component code (TSX)         | ⛔ documented, not implemented (see MAP_INTEGRATION.md) |
| Country branch in evolver / predictor / feed_engine / news_intelligence / article_filters / tavily_research | ⛔ documented, applied during fork |
| Election DB schema               | ⛔ deferred to Stage 2 — current setup uses leaning_profile_us.json directly |
| Calibrator wiring                | ⛔ prompt provided, integration deferred to Stage 2 |
| Backend tests                    | ⛔ Stage 2 |

## Stage 2 candidates

1. **Election DB schema**. Replace the Taiwan-only Postgres schema in
   `ap/services/election-db/init/001_schema.sql` with a US-friendly version
   that stores 2020 + 2024 county-level results from MEDSL. Importer rewrite.
2. **Connecticut planning regions** in `us-counties.geojson` — replace 8 old
   county polygons with 9 planning-region polygons from TIGER 2024. Same fix
   for Alaska FIPS 02261 (Valdez-Cordova → 02063 / 02066).
3. **Sub-county granularity**. ACS exposes block-group data; the synthesis
   service could optionally drill below county for dense urban states.
4. **Real US media-habit calibration**. The current `media_habit` distribution
   in `pennsylvania_sample.json` is Pew defaults — refine with actual Pew News
   Platform Fact Sheet 2024 numbers per age cohort.
5. **Calibrator integration**. Add `prompts_en.CALIBRATOR_PROMPT_TEMPLATE` as
   a country branch in `calibrator.py` and refit with 2024 Pennsylvania
   gubernatorial / senate results as the held-out target.
6. **Multi-state simulation runner**. The user explicitly asked for "select
   one state, multiple states, or all 50". The synthesis pipeline currently
   takes one template; extend it to merge multiple state templates with
   population-weighted dimensions.
7. **Backend test suite** covering both TW and US branches in evolver /
   predictor / feed_engine.

## Files this stage produced

```
Civatas-USA/
├── STAGE1.md                                  ← this file
└── code/ap/
    ├── shared/
    │   ├── us_admin.py                        272 lines
    │   ├── us_leaning.py                      210 lines
    │   ├── us_article_filters.py               85 lines
    │   └── i18n/locales/
    │       ├── en.json                         (extended)
    │       └── zh-TW-us-additions.json
    └── services/
        ├── evolution/app/
        │   ├── prompts_en.py                  220 lines (5 templates)
        │   ├── us_feed_sources.py             125 lines
        │   ├── us_news_keywords.py             95 lines
        │   └── us_predictor_helpers.py        110 lines
        └── web/public/
            ├── us-counties.geojson            (3.2 MB, copied from Stage 0)
            ├── us-states.geojson              (608 KB, copied from Stage 0)
            └── MAP_INTEGRATION.md
```
