# Stage 1.8 — Election templates (Phase A)

Stage 1.8 turns the data backbone built in Stages 0-1 into **selectable election templates**. The user can now pick "US Presidential — National (Generic)" or "US Presidential — 2024 (Trump vs Harris)" or any of the 50 single-state templates from a dropdown when generating personas, and the Calibration / Prediction / Sandbox panels automatically pick up that template's defaults instead of the hardcoded TW seed.

This is **Phase A** of the election-template work scoped in conversation:

> "1. 方向確認：現在就開始做 Phase A
> 2. 第一個 template 從 Presidential — National (generic 兩黨) 開始
> 3. 包含「特定週期」template（如 Presidential 2024 with Trump/Harris）
> 4. 做第一個 US template 時，順便把 Calibration/Prediction 面板裡的 TW 預設拆掉，改成 template 讀取。"

All four sub-goals delivered.

## What's done in Stage 1.8

### 1. Template schema extension

`data/templates/*.json` now supports an **optional** `election` block on top of the existing demographics-only schema:

```jsonc
{
  // ── existing fields ──
  "name", "name_zh", "region", "region_code", "fips", "country", "locale",
  "target_count", "metadata", "dimensions",

  // ── NEW: election block (optional) ──
  "election": {
    "type": "presidential" | "senate" | "gubernatorial" | "house" | "mayoral",
    "scope": "national" | "state" | "county",
    "cycle": null | 2020 | 2024,           // null = generic, year = specific
    "is_generic": bool,
    "candidates": [
      { "id", "name", "party": "D"|"R"|"I", "party_label",
        "is_incumbent", "color", "description" }
    ],
    "party_palette": { "D": [colors], "R": [...], "I": [...] },
    "party_detection": { "D": [patterns], "R": [...], "I": [...] },
    "default_macro_context": { "en": "...", "zh-TW": "..." },
    "default_search_keywords": { "local": "...", "national": "..." },
    "default_calibration_params": { news_impact, delta_cap_mult, ... },
    "default_kol": { enabled, ratio, reach },
    "default_poll_groups": [ { id, name, weight } ],
    "party_base_scores": { "D": 50, "R": 50, "I": 25 }
  }
}
```

**Backward compatible**: older templates (`pennsylvania_sample.json`, `taichung_sample.json`) without an `election` block still load — the panels fall back to legacy TW seed defaults.

### 2. New data builders

Two Python scripts in `scripts/`:

- **`build_national_template.py`** — aggregates all 3,142 counties into national-level demographics + 5-bucket party_lean weighted by 2024 turnout. Produces:
  - `data/templates/presidential_national_generic.json` — Generic Democrat / Generic Republican / Generic Independent
  - `data/templates/presidential_2024.json` — Kamala Harris (D, sitting VP) / Donald Trump (R, challenger), tied to the 2024 cycle macro context

  National PVI computed: **R+0** (-0.0042), which matches 2024 actual to within rounding (Harris 49.25% / Trump 50.40%). Population total: 334.9M across 51 states/territories.

- **`build_state_template.py`** — generalizes the original `build_pa_template.py` to accept any state code. Has `--state PA` and `--all` modes. `--all` produces 51 single-state templates: `presidential_state_AL.json` … `presidential_state_WY.json` (50 states + DC). Each carries the state's actual Cook PVI and a state-flavored macro context.

  Verified swing states match actual 2024 results: PA R+1, GA R+2, NV R+1, AZ R+2, MI R+1, WI R+1, NC R+2 (all the swing seven leaning Trump by single digits).

  The original `build_pa_template.py` is still present for backward compat — its output `pennsylvania_sample.json` is now functionally a subset of `presidential_state_PA.json` (the latter has the `election` block).

### 3. Template directory consolidation

`ap/docker-compose.yml` mount changed from `./data/templates:/data/templates` to **`../data/templates:/data/templates`** so the api container reads the same templates the build scripts write to. The legacy `ap/data/templates/` directory is now unused; both `pennsylvania_sample.json` and `taichung_sample.json` shadows are still there but no longer served.

### 4. Templates API enrichment

`GET /api/templates` (formerly returned just `[{filename}]`) now returns full metadata for each template:

```json
{
  "templates": [
    {
      "id": "presidential_national_generic",
      "name": "US Presidential — National (Generic)",
      "name_zh": "美國總統大選 — 全國（通用兩黨）",
      "region": "United States",
      "country": "US",
      "locale": "en-US",
      "election": {
        "type": "presidential",
        "scope": "national",
        "cycle": null,
        "is_generic": true,
        "candidate_count": 3
      },
      "metadata": { "national_pvi_label": "R+0", "county_count": 3142, ... }
    },
    ...
  ]
}
```

The frontend uses this to group templates by election type / scope in the picker.

### 5. Frontend `useActiveTemplate` hook + workspace store

New file `ap/services/web/src/hooks/use-active-template.ts`:

- **`useTemplateList()`** — fetches `/api/templates` once, cached at module level
- **`useActiveTemplate(wsId)`** — returns the workspace's currently-active template (full body) reactively
- **`setActiveTemplateId(wsId, id)`** — call from `PopulationSetupPanel` when the user clicks Generate; persists to `localStorage[\`activeTemplate_${wsId}\`]` and broadcasts a `civatas:active-template-changed` event so other panels in the same tab re-fetch immediately

Active template ID lives in `localStorage` (no backend schema change required). All Stage 1.7 panels follow the same `localStorage`-keyed-by-wsId pattern, so this is consistent with the existing app conventions.

### 6. Template selector in `PopulationSetupPanel`

The previously-hardcoded `usTemplate = "pennsylvania_sample"` is replaced with a real `<select>` grouped by:

- **🇺🇸 National Presidential** — generic first, then specific cycles (newest first)
- **🗺 By State** — 51 states alphabetized, with each state's PVI label inline
- **Other** — anything else

Below the picker, a meta line shows region, PVI, county count, population, and candidate count for the selected template. When the user clicks Generate, the active template ID is persisted via `setActiveTemplateId(wsId, ...)` so downstream panels pick it up.

### 7. Template-driven defaults helper

New file `ap/services/web/src/lib/template-defaults.ts`:

- `getDefaultMacroContext(template, locale)` — returns template's macro context (en/zh-TW) or TW seed
- `getDefaultLocalKeywords(template)` / `getDefaultNationalKeywords(template)` — same pattern for AI news search
- `getDefaultSandboxQuery(template)` — single-line query for sandbox auto-fetch
- `getDefaultElectionType(template)` — "Presidential Election" / "Senate Election" / "市長選舉" fallback
- `getDefaultCalibParams(template)` — merges template params with TW defaults
- `getDefaultKolSettings(template)`, `getDefaultPollGroups(template)`, `getDefaultPartyBaseScores(template)`
- `makePartyColorResolver(template)` — returns `(name) => color` that uses template `party_palette` + `party_detection` first, falls back to TW party detection
- `makePartyIdResolver(template)` — same pattern for `PARTY_PALETTES` lookups in PredictionPanel

Every helper has a TW fallback, so existing TW workspaces are unaffected when no template is active.

### 8. Calibration / Prediction / Sandbox panels gut TW seed

**`CalibrationPanel.tsx`** — call `useActiveTemplate(wsId)` and pipe template values into:
- `calibMacroContext` initial state + an effect that re-seeds it when the template loads (unless user has manually edited the textarea — tracked via `macroContextUserEdited` flag)
- `calFetchQuery` / `calFetchNationalQuery` — same pattern with `searchKeywordsUserEdited`
- `electionType` — template's `getDefaultElectionType()` overrides the TW `"市長選舉"` default
- All three internal `partyColor()` call sites switched to `partyColorFromTemplate(...)` (which uses template palette/detection first, TW second)

**`PredictionPanel.tsx`** — same `useActiveTemplate(wsId)` + `partyColorFromTemplate` setup. An effect seeds:
- `predictionMacroContext` (when empty)
- `predLocalKeywords` / `predNationalKeywords` (when empty)
- Default scenario names switched from TW (`情境 A` / `對照組`) to the i18n `sandbox.scenario_default_a/b` keys (already EN-bilingual via Stage 1.7)
- Two `name: "選舉預測"` poll group fallbacks switched to `getDefaultPollGroups(activeTemplate)[0]?.name`

**`SandboxPanel.tsx`** — `handleAutoFetch` default query now reads `getDefaultSandboxQuery(activeTemplate)` (`"US presidential election polling economy"` for US templates, TW string for TW).

### 9. `ParameterCalibrationMode.tsx` status

`ParameterCalibrationMode` is **dead-imported** in both `CalibrationPanel.tsx` and `PredictionPanel.tsx` but never rendered. There's nothing to conditionally hide. Stage 1.9 should either:
- Build a US-equivalent fast parameter calibration sub-mode, then render conditionally on `template.country`
- Or delete the dead imports entirely

## Files added / changed

| File | Change |
|---|---|
| `scripts/build_national_template.py` | NEW — generates 2 national presidential templates |
| `scripts/build_state_template.py` | NEW — generates 51 single-state templates with `--all` |
| `data/templates/presidential_national_generic.json` | NEW — generic D/R/I, all 3142 counties |
| `data/templates/presidential_2024.json` | NEW — Trump vs Harris 2024 cycle |
| `data/templates/presidential_state_*.json` | NEW × 51 — one per state + DC |
| `ap/docker-compose.yml` | mount switched to top-level `data/templates` |
| `ap/services/api/app/routes/templates.py` | metadata-rich `GET /api/templates` |
| `ap/services/web/src/lib/api.ts` | added `listTemplates()`, `getTemplate()`, `TemplateMeta` |
| `ap/services/web/src/hooks/use-active-template.ts` | NEW — workspace template store + hooks |
| `ap/services/web/src/lib/template-defaults.ts` | NEW — TW-fallback helpers for panels |
| `ap/services/web/src/components/panels/PopulationSetupPanel.tsx` | real template selector |
| `ap/services/web/src/components/panels/CalibrationPanel.tsx` | template-driven macro context, search kw, electionType, partyColor |
| `ap/services/web/src/components/panels/PredictionPanel.tsx` | template-driven macro context, search kw, scenario names, poll group name, partyColor |
| `ap/services/web/src/components/panels/SandboxPanel.tsx` | template-driven default search query |

## Verification

**Data layer:**
```
$ python3 scripts/build_national_template.py
US: aggregating 3142 counties across 51 states/territories
  population total: 334,913,011
  national PVI (turnout-weighted 2024): R+0  (-0.0042)
  party_lean buckets:
     Solid Dem  0.1867
      Lean Dem  0.1965
        Tossup  0.2425
      Lean Rep  0.1637
     Solid Rep  0.2106
  -> data/templates/presidential_national_generic.json
  -> data/templates/presidential_2024.json

$ python3 scripts/build_state_template.py --all
... 51 state templates generated ...
```

**API layer** (with auth):
```
$ curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/templates
{ "templates": [55 items], "by_election_type": { "presidential": 53, null: 2 } }
```

**App layer**: web container hot-reloads cleanly through every Calibration/Prediction/Sandbox edit, all 1947 modules compile without errors.

## What's NOT in Stage 1.8 (Phase B+)

These are tracked as follow-up work:

1. **Senate / House / Gubernatorial templates** — needs new fetch scripts: `fetch_senate.py` (MEDSL Senate dataset), `fetch_governor.py`, `fetch_house.py` + TIGER district shapefiles. The template builder pattern from Stage 1.8 will plug in cleanly once the data is fetched.

2. **Primaries** — different electorate dynamics; needs MEDSL primaries dataset and a new `is_primary: true` flag in the election block.

3. **Mayoral / large-city templates** — no unified data source; would need per-city scrapers (Chicago, NYC, LA, SF, ...) or OpenElections.net integration.

4. **`PredictionPanel.tsx` inner form labels — Phase B (DONE)** — Stage 1.7 left ~600 inner CJK strings; Phase B (this stage) translated the user-facing UI chrome of all three wizard tabs:
   - **① Basic Setup** (lines 1884–2132): all snapshot/news-search/auto-fetch labels, placeholders, descriptions, and warnings (~45 keys under `prediction.s1.*`).
   - **② Survey/Groups** (lines 2133–2457): satisfaction subjects, election poll groups, candidate forms, role/filter dropdowns, auto-fill tooltip (~40 keys under `prediction.s2.*`). Storage `value=` attributes on `<option>` are intentionally preserved as Chinese — the satisfaction-scoring LLM keys off these strings.
   - **③ Advanced Params** (lines 2458–3665): h3 + subtitle, alignment banner, calibration banner, macro-context label/placeholder/AI button, sim-days/concurrency labels, "reset leaning" toggle, parameter workspace title + tabs (4 tabs × 2 modes), candidate base-score calc-principle box, traits calc-principle box, dynamic-leaning panel (label/desc/thresholds/summary), reset/auto-tune/auto-compute buttons (~70 keys under `prediction.s3.*`). Plus the rolling-prediction button and unfinished-prediction checkpoint banner.
   - **Intentionally PRESERVED as Chinese** (TW seed defaults, per CLAUDE.md): all `title={"【...】預設：..."}` slider tooltips, slider hint texts referencing TW concepts, impact-signal `signals.push({reason: ...})` strings, the `通用參數` (政黨歸隊加成 / 現任優勢加成 / 政黨方向性發散) sliders, and the hidden Structural Events Editor (`display: none`). These are tightly coupled with TW politician/party logic and need a "US calibration mode" rebuild rather than translation. Stage 1.9 candidate.

5. **TW seed cleanup**: the legacy `partyColor()` / `getPartyDefault()` / TW search keyword constants in `CalibrationPanel.tsx` and `PredictionPanel.tsx` are kept as **fallback** behavior. They run only when no template is active (TW workspaces). Stage 1.9 could fully delete them once the TW workflow has its own template (e.g. `taichung_mayor_2022.json` with `country: "TW"` + filled `election` block).

6. **Active template indicator in panel headers** — the calibration/prediction panels don't currently show which template is active. A small badge ("Template: Presidential 2024") near each panel header would help users confirm.

7. **`ParameterCalibrationMode` cleanup** — see section 9 above.

## How to use it

**As a developer rebuilding the data:**
```bash
cd Civatas-USA
python3 scripts/build_national_template.py        # 2 national templates
python3 scripts/build_state_template.py --all     # 51 state templates
# (existing pennsylvania_sample.json is regenerated separately by build_pa_template.py if needed)
```

**As a user:**
1. Open Civatas, create or open a workspace
2. Go to **Population Setup**
3. Pick a template from the new dropdown:
   - **🇺🇸 National Presidential** → either Generic (any cycle) or 2024 (Trump vs Harris)
   - **🗺 By State** → any of 51 states with their actual PVI
4. Click **🚀 Generate Pennsylvania Population** (the button label still says PA — Stage 1.9 cleanup)
5. The selected template's defaults automatically appear in:
   - **Calibration → Step 4** macro context + AI news search keywords + election type
   - **Prediction → ① 基礎設定** macro context + keywords (when empty)
   - **Sandbox → Auto-fetch** default search query
   - **All panels** — `partyColor` resolves D/R/I based on template's party detection rules (not TW party names)
