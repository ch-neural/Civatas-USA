# Civatas-USA Localization History

This file summarises the staged port of the original Taiwan-based Civatas
application to a US-only build. The original working documents that drove each
stage live under `docs/archive/`.

## Stage 0 — US data backbone (Q4 2025)

Built the public, redistributable US data tree under `data/`:

- `data/geo/` — TIGER 2024 county / state geojson
- `data/census/` — ACS 2024 demographics for all counties + states
- `data/elections/` — MEDSL 2020 + 2024 county presidential CSVs
- `data/elections/leaning_profile_us.json` — Cook PVI computed from MEDSL,
  bucketed into 5 tiers (Solid Dem / Lean Dem / Tossup / Lean Rep / Solid Rep)
- `data/us_election.db` — SQLite snapshot of MEDSL elections used by the
  evolution / calibration services

## Stage 1 — Pennsylvania pilot

First end-to-end US workspace: a single PA-statewide template that exercised
every layer (ingestion → synthesis → persona → adapter) on US data.

## Stage 1.5 — Country switch (`CIVATAS_COUNTRY`)

Introduced `CIVATAS_COUNTRY=US|TW` env var; backend services and frontend
panels branched on the value. Goal was to keep the existing TW workflow
working as a fallback while US support landed.

## Stage 1.6 / 1.7 — UI bilingualism

`ap/services/web/` was made bilingual via `useTr()` / `lib/i18n.ts` with
`en` and `zh-TW` locale slots. The English path became the default; the TW
path stayed as fallback.

## Stage 1.8 — Election templates

Templates under `data/templates/*.json` gained an `election` block carrying
candidates, party_palette, party_detection patterns, default macro context,
search keywords, calibration params, KOL settings, poll groups, party base
scores, evolution params, alignment, and evolution window. Builders for
national + per-state presidential templates were added; the
`useActiveTemplate(wsId)` hook + `template-defaults.ts` helpers wired the
Calibration / Prediction / Sandbox panels to the active template.

## Stage 1.9 — TW removal (this cleanup)

The application is **US-only**. The `CIVATAS_COUNTRY` env var, all
`if CIVATAS_COUNTRY == "US"` branches, and the inline TW prompt templates
were deleted from every backend service. The frontend stripped TW seed
defaults, the `TaiwanMap` component, the `taichung_sample.json` template,
the `pennsylvania_sample.json` legacy template, and the `build_pa_template.py`
legacy builder. The persona service now emits English values for personality
dimensions, cognitive bias, income band, and gender directly, instead of
emitting Chinese and translating at render time.

The i18n system was kept multi-locale (English source-of-truth, `zh-TW` slots
preserved as English fallback). Future locales (`ja`, `ko`) can be added by
extending `LOCALE_CYCLE` in `store/locale-store.ts` and adding the new key
to every entry in `STRINGS`.

**Files removed in 1.9 cleanup:**

- `ap/templates/taichung_sample.json`
- `ap/data/templates/taichung_sample.json`
- `ap/data/templates/pennsylvania_sample.json`
- `data/templates/pennsylvania_sample.json`
- `scripts/build_pa_template.py`
- `ap/services/web/src/components/TaiwanMap.tsx`
- `ap/services/web/src/components/panels/ParameterCalibrationMode.tsx`

**Behavioural changes in 1.9:**

- `ap/services/evolution/app/prompts.py` is now the only prompt module
  (the dual `prompts.py` + `prompts_en.py` was collapsed). Same for
  `ap/services/persona/app/prompts.py`.
- `ap/services/api/app/main.py` `/api/runtime` always returns
  `{"country": "US", "locale": "en"}`.
- `evolver.py` `_BIAS_DESC` is English-only; the cognitive_bias_text wrapper,
  `_local_desc` / `_national_desc` / `_anxiety_desc`, and `_att_label` all
  emit English directly. The TW life-event catalog is disabled (US life
  events not yet implemented).
- `predictor.py` always uses `prompts.VOTING_PROMPT_TEMPLATE`; the legacy TW
  `_prompt_base` voting prompt was removed.
- `election_db.py` is now a thin shim around `election_db_us.py` (every
  public function delegates).
- `feed_engine.py` only loads US source leanings + diet map.
- `news_intelligence.py` only builds US default keywords.
- `template-defaults.ts` `getDefaultMacroContext / getDefaultLocalKeywords /
  getDefaultNationalKeywords / getDefaultElectionType / getDefaultSandboxQuery /
  getDefaultCalibParams` all return generic US English defaults when no
  template is active.

**Deferred to a follow-up cleanup:**

- The deep parameter tooltips (~1000 CJK lines) inside
  `PredictionPanel.tsx` and `CalibrationPanel.tsx` `title=` attributes and
  slider hint text. These are visible only on hover and don't block normal
  use; they need contextual translation rather than mechanical replacement.
- A US life-event catalog to replace the disabled TW one.
