# Stage 1.7 — Bilingual sweep of Stage 1.6 deferred panels

Stage 1.7 closes the explicit scope cut in Stage 1.6:

> *Stage 1.6: "Inner sections of large panels (`PredictionPanel`, `CalibrationPanel`, `SandboxPanel`) keep their Chinese labels for now; they remain functional but visually mixed."*

This stage routes the **user-visible UI chrome** of those three panels (plus their helpers) through the existing `useTr()` / `lib/i18n.ts` infrastructure. Roughly **400+ new string keys** were added.

## What's done in Stage 1.7

### 1. Synthesis chart i18n (`SynthesisResultCharts.tsx`)
The four personality boxes (`🗣 表達意願`, `💆 情緒穩定度`, `👥 社交傾向`, `🧠 資訊接受度`) and their bar values (`中等表達`, `穩定冷靜`, `適度社交`, …) now translate. Implementation:
- Replaced hardcoded `TRAIT_MAPPING` / `PERSONALITY_DIMS` with i18n string-key maps resolved per render via `useTr()`.
- Pipes each bar `label` through `useLocalizePersonaValue()` (whose `PERSONA_VALUE_KEY` map already covered every Chinese persona value).
- Age bins switched from `30-39歲` to language-neutral `30–39`.

### 2. PredictionEvolutionDashboardPanel.tsx — full sweep
27 CJK lines → 0 visible CJK in UI (data-layer `LEAN_COLORS` keys / `_leanDisplay` map / TW district-suffix regex preserved). Translated header, stats cards, district overview, charts, persona detail, log title.

### 3. ParameterCalibrationMode.tsx — full UI sweep
TW-only sub-mode (Taichung mayor election), but every UI chrome string translated (section headers, field labels, training panel, result table, error messages). `partyColor()` TW party detection and agent default leaning kept as data-layer.

### 4. PredictionAnalysisPanel.tsx — full UI sweep
Hero card (`🗳️ 開票結果`), contrast comparison (`對比式分析`), system recommendation, LLM-vs-heuristic block, all stat cards, both trend charts, AI deep analysis block. The internal LLM prompt builder (`【基本資訊】…` summary string) is preserved as Chinese — it's an internal model input, not user-facing UI, and the LLM analysis output is also Chinese.

### 5. SandboxPanel.tsx — full sweep
- Sidebar wizard (`獨立沙盒實驗` / 5 steps)
- Five step pages including: snapshot picker, AI auto-fetch with date range / per-year-count / social toggle, scenario cards with placeholders, KOL settings, persona tracking picker
- Live status section (progress, by-leaning, satisfaction distribution, persona live tracking, sat/anx shorts)
- Results section (vote prediction, trend summary, history list)
- Every alert/error/confirm message

### 6. CalibrationPanel.tsx — full UI chrome sweep
Largest file (2766 lines / 361 CJK lines). All four wizard steps translated:
- **Step 1**: pack list, create-new pack panel (manual + preset), candidate table with locality/region inputs
- **Step 2**: date range, time-scale presets (`TIME_SCALE_PRESETS` restructured to use `labelKey`/`descKey`)
- **Step 3**: AI news search (local + national keywords, ratio slider, social toggle, fetch history)
- **Step 4**: macro context, KOL toggle, parameter workspace with three tabs (scoring/leaning/candidate base score). The **candidate impact preview** with ~36 reasoning strings was fully translated as `calib.reason.*` keys.
- Auto-calibration controls + iteration history table
- Results card, AI suggested params card
- Snapshot save / restore / list with expanded stats
- Live calibration progress overlay (event/agent progress bars, by-leaning tab, candidate-by-leaning table)

**Preserved as TW seed data** (translating wouldn't make the panel work for US data):
- Default macro context block (mentions 蔡英文/盧秀燕/民進黨/國民黨)
- Default search query templates (Taichung-specific keyword lists)
- `partyColor()` party detection (TW party names)
- Default `electionType = "市長選舉"` and the 4 election type tag templates
- Party-detection logic in the impact preview (`if p.includes("國民黨")…`)

### 7. PredictionPanel.tsx — partial sweep (visible surfaces only)
Largest file in the project (5512 lines / 754 CJK lines). **Stage 1.7 translates only the high-visibility surfaces** that match the user's screenshots:
- `🔮 未來情境預測 — 使用說明` GuidePanel (title, intro, 5 steps, 3 tips)
- Header (`基於快照：…`, calib count badge)
- Mode toggle (`🗳️ 選舉預測` / `📊 滿意度調查`)
- Wizard tabs (`① 基礎設定` / `② 預測分組|調查對象` / `③ ⚙️ 進階參數`)
- Section 1 header (`① 基礎設定`) and snapshot picker label / empty state
- Section 2 header (`② 預測分組`)
- Start button (`🚀 開始預測` / `📊 開始滿意度調查` / `執行中…`)
- Results section header `📊 預測結果對照` (both occurrences)
- Empty state (`完成設定並點擊「開始預測」後…`)
- Survey results title (`📊 滿意度調查結果`)
- `prediction.alert.no_groups` alert

**Deferred to Stage 1.8** (still Chinese inside `PredictionPanel.tsx`):
- All form labels and helper text inside the four wizard sections
- Advanced parameters tab body (sliders, descriptions, presets)
- Polling group editor inner controls
- Calibration analysis block (`AI 建議參數`, summary tables)
- Live progress overlay (live messages, daily breakdown tables)
- History list inner formatting
- Recording / past predictions UI

The reason for the cut: ~600+ remaining UI strings inside this single file would more than double the i18n dictionary again. The visible "looks Chinese at a glance" complaint from the user is resolved.

## i18n dictionary growth

| Stage | New keys |
|---|---:|
| Stage 1.5/1.6 baseline | ~280 |
| Stage 1.7 additions    | **~500** |
| Total                  | ~780 |

New namespaces in `lib/i18n.ts`:
- `synthesis.chart.*` (added: `gender`, `district`, `express`, `stable`, `social`, `openness`, `empty`)
- `predevodash.*` (existing 2 → ~25 keys)
- `calparam.*` (full TW election parameter calibration mode)
- `predanalysis.*` (full election analysis panel)
- `sandbox.*` (full sandbox panel: 5 steps + live status + results + history)
- `calib.*` (largest namespace — wizard, params, results, snapshots, live progress, ~36 reasoning strings)
- `prediction.*` (partial — visible surfaces only)

## Verification

Each panel was edited incrementally with the `web` Docker container watching. After every panel:

```
docker compose logs --tail=20 web
```

… was checked for `✓ Compiled` confirmation. No panel was marked complete until its compile succeeded.

## Known issues / followups

1. **`PredictionPanel.tsx` is still ~80% Chinese internally.** The visible surfaces (everything in the screenshots) translate, but inner form labels do not. Stage 1.8 should finish this — estimated ~600 more keys.
2. **Internal LLM prompt builders remain Chinese.** Several panels (`PredictionAnalysisPanel.tsx` line 87-132, calibration result analysis) build summary strings for downstream LLM analysis. These are not UI strings and should not be translated — the LLM output is also Chinese.
3. **TW seed data is intentionally Chinese.** The default macro context, default search queries, and `partyColor`/`partyBaseScore` party detection in `CalibrationPanel.tsx` and `ParameterCalibrationMode.tsx` reference Taiwan politicians and parties. They will need a separate "US calibration mode" rebuild rather than translation when the calibration panel is wired up to US election data.
4. **Date locale switching**: PredictionAnalysisPanel, SandboxPanel, CalibrationPanel now use `locale === "en" ? "en-US" : "zh-TW"` for `toLocaleDateString` / `toLocaleString`. There are still a few `"zh-TW"` literals inside `PredictionPanel.tsx` that weren't touched as part of the Stage 1.7 surface-only sweep.
