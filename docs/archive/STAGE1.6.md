# Stage 1.6 — Bilingual UI sweep + expanded US news sources

> **Update (Stage 1.7):** the deferred panel scope cut documented in this file
> has been reversed. `CalibrationPanel`, `SandboxPanel`, the prediction analysis
> panels, and the **visible surfaces** of `PredictionPanel` are now fully
> bilingual — see `STAGE1.7.md`. Inner form details inside `PredictionPanel.tsx`
> are still Chinese and tracked for Stage 1.8.

Stage 1.6 closes two requests:

1. **News sources rewritten for the US**, categorized by 5-tier political lean
2. **Workflow panels made bilingual** so the user can switch between English
   (default) and Traditional Chinese via the StatusBar `🌐 中文 / EN` button

> **Important: this is a focused sweep, not a full translation.** The
> Civatas codebase has 100k+ Chinese characters across 25 panels — fully
> translating every tooltip and inner section would be a multi-day effort.
> This stage translates the **highest-visibility surfaces** the user
> actually clicks through in the demo workflow. Inner sections of large
> panels (`PredictionPanel`, `CalibrationPanel`, `SandboxPanel`) keep their
> Chinese labels for now; they remain functional but visually mixed.
> *(Superseded for `CalibrationPanel` / `SandboxPanel` and visible surfaces of
> `PredictionPanel` by Stage 1.7.)*

## What's done in Stage 1.6

### 1. Expanded US news sources (130 outlets across 5 tiers)

**`ap/services/evolution/app/us_feed_sources.py`** now contains 130 outlets
mapped to the 5-tier Cook spectrum:

| Bucket      | Count | Examples |
| ----------- | ----: | -------- |
| Solid Dem   | 14 | MSNBC · HuffPost · Mother Jones · The Nation · Daily Kos · Pod Save America · The Intercept · Reddit r/politics |
| Lean Dem    | 40 | NYT · WaPo · CNN · NBC · CBS · ABC · NPR · The Atlantic · Politico · The Guardian US · ProPublica · BBC News · Yahoo News · TikTok |
| Tossup      | 35 | Reuters · AP · Bloomberg · USA Today · Forbes · The Economist · The Hill · Axios · Newsweek · Real Clear Politics · X (Twitter) · Facebook · YouTube |
| Lean Rep    | 15 | WSJ · NY Post · Reason · National Review · The Dispatch · Washington Examiner · The American Conservative · Drudge Report · Joe Rogan |
| Solid Rep   | 26 | Fox News · Newsmax · OANN · Breitbart · The Daily Wire · The Federalist · Daily Caller · Townhall · The Blaze · Truth Social · Tucker Carlson · Ben Shapiro · Bannon's War Room |

Plus **PA-regional**: Pittsburgh Post-Gazette, Tribune-Review, Philly.com,
Philadelphia Magazine, WHYY (NPR Philly), KDKA, WPXI, WTAE, PennLive, etc.

Bias classification follows the **AllSides Media Bias Chart v9** + **Ad Fontes
Media Bias Chart**; ties go to the more conservative (closer-to-Tossup) call.

The full source set is ALSO snapshotted as JSON at
`ap/shared/us_data/us_feed_sources.json` so the API gateway container can
serve it without importing the evolution module.

### 2. Backend `/api/runtime/news-sources`

New endpoint at `ap/services/api/app/main.py` that returns the 130 sources
bucketed by tier. Frontend hits this to render the news source panel without
needing to know Python data shapes.

```bash
curl http://localhost:8000/api/runtime/news-sources | jq '.buckets | to_entries | map({key, count: (.value | length)})'
# [{"key": "Solid Dem", "count": 14}, {"key": "Lean Dem", "count": 40}, ...]
```

### 3. Locale store (Stage 1.5+) wired into 11 surfaces

`ap/services/web/src/store/locale-store.ts` (Stage 1.5) is now consumed by:

| File | What changed |
|---|---|
| `components/shell/StatusBar.tsx` | Language toggle button (`🌐 中文 / EN`), bilingual `Project: / 專案:`, `LLM connected / 已連線` |
| `components/shell/NavTree.tsx` | All side-nav menu items use `panelLabel(info, locale)` |
| `components/shell/PanelTabBar.tsx` | Panel tabs use bilingual labels |
| `store/panel-registry.ts` | Every panel entry got `labelEn` (21 workspace panels + 2 global panels). New `panelLabel(info, locale)` helper |
| `components/panels/PopulationSetupPanel.tsx` | All US-branch labels (header, template card, target/age/strategy inputs, generate button) |
| `components/panels/SynthesisResultPanel.tsx` | Title, summary stats labels (Total / Male / Female / Counties), bilingual gender count tolerant of 男/女/Male/Female |
| `components/panels/EvolutionDashboardPanel.tsx` | "Districts overview" / "各行政區概覽" + USMap branch with 5-tier lean colors |
| `components/panels/EvolutionPanel.tsx` | All 3 sub-tab headers (News pool / Filter bubble recipe / Evolution engine) |
| `components/panels/NewsCenterPanel.tsx` | Title, intro paragraph, **new "US News Sources by Political Lean" section** showing 130 sources colored by bucket |
| `components/panels/PersonaPanel.tsx` | Title, intro, leaningColors extended to 5-tier US |
| `components/panels/HistoricalEvolutionPanel.tsx` | Title |
| `components/panels/AgentExplorerPanel.tsx` | "Counties / 行政區" + leaningColors extended to 5-tier US |
| `components/panels/PredictionPanel.tsx` | Title, leaningColors extended |
| `components/panels/PredictionEvolutionDashboardPanel.tsx` | Title + subtitle, leaningColors extended |
| `components/panels/LeaningPanel.tsx` | Title + intro |

### 4. Lean color extensions

Every panel that previously used `LEAN_COLORS = { "偏左派": ..., "中立": ...,
"偏右派": ... }` now also recognizes the 5 US labels:

```ts
"Solid Dem": "#1e40af",   // dark blue
"Lean Dem":  "#3b82f6",   // medium blue
"Tossup":    "#94a3b8",   // gray
"Lean Rep":  "#ef4444",   // red
"Solid Rep": "#991b1b",   // dark red
```

So when an evolution job runs in US mode, charts that color by `political_leaning`
will pick the correct US color automatically — no panel rewrite needed.

## What's NOT done (deferred to Stage 1.7+)

The minimal-but-impactful pattern means the following are still Chinese:

1. **PredictionPanel inner sections** (~33k chars). The header now says
   "Prediction Mode" but candidate edit dialog, poll group config, scoring
   sliders, vote-day context input — all still Chinese.
2. **CalibrationPanel** (18k chars) — fully Chinese; deferred entirely.
3. **SandboxPanel** (7k chars) — fully Chinese.
4. **HistoricalEvolutionPanel inner sections** — only the title is bilingual.
5. **PersonaPanel inner sections** — only the header is bilingual.
6. **NewsCenterPanel deep tooltips** — the field-explanation `<details>`
   block is still Chinese.
7. **MenuBar / CommandPalette / CreateWorkspaceDialog / SettingsPanel** — not
   touched.
8. **`PopulationSetupPanel` TW branch** — unchanged. Only the US branch is
   bilingual.

These all still **work** in either locale; they just display Chinese text
inside their inner sections.

## Verification

```
Python compile (main.py + us_feed_sources.py):  OK
TS check (14 modified files):                    0 errors
US news sources count:                           130
News sources buckets:                            14 / 40 / 35 / 15 / 26
```

## How to test

```bash
cd Civatas-USA/ap
docker compose restart api web
```

Cmd+Shift+R refresh the browser. You should see:

1. **StatusBar** (bottom-right): `🌐 中文` button — click to toggle
2. **NavTree** (left side): all menu items in English by default
   (`Population Setup`, `Synthesis Result`, `Persona Management`,
   `Historical Evolution`, `News Center`, `Evolution Dashboard`, `Agent
   Explorer`, `Prediction Mode`, `Race Analysis`, `Political Leaning`, ...)
3. **NewsCenter panel**: open **News Center** from the nav. Top of the panel
   has a new collapsible section **"📰 US News Sources by Political Lean
   (130 outlets)"** showing all sources color-coded by their 5-tier bucket.
   Same panel works in both languages.
4. **Population Setup**: button says `🚀 Generate Pennsylvania Population` in
   English mode, `🚀 生成賓州人口` after toggle.
5. **Synthesis Result**: title `🧬 Synthesis Result`, gender stats now show
   correct Male/Female counts (the bilingual gender tolerance fix).

## Files added/modified in Stage 1.6

```
new:
  STAGE1.6.md
  ap/shared/us_data/us_feed_sources.json   (130 sources, snapshot)

modified:
  ap/services/api/app/main.py                                    (+ news-sources endpoint)
  ap/services/evolution/app/us_feed_sources.py                   (53 → 130 sources)
  ap/services/web/src/store/panel-registry.ts                    (+ labelEn fields + panelLabel helper)
  ap/services/web/src/components/shell/StatusBar.tsx             (bilingual + 🌐 button — Stage 1.5)
  ap/services/web/src/components/shell/NavTree.tsx               (panelLabel)
  ap/services/web/src/components/shell/PanelTabBar.tsx           (panelLabel)
  ap/services/web/src/components/panels/PopulationSetupPanel.tsx (US branch bilingual)
  ap/services/web/src/components/panels/SynthesisResultPanel.tsx (bilingual + USMap)
  ap/services/web/src/components/panels/EvolutionDashboardPanel.tsx (USMap branch + bilingual)
  ap/services/web/src/components/panels/EvolutionPanel.tsx       (3 sub-tab headers)
  ap/services/web/src/components/panels/NewsCenterPanel.tsx      (US source list section)
  ap/services/web/src/components/panels/PersonaPanel.tsx         (header)
  ap/services/web/src/components/panels/HistoricalEvolutionPanel.tsx (header)
  ap/services/web/src/components/panels/AgentExplorerPanel.tsx   (Counties label + lean colors)
  ap/services/web/src/components/panels/PredictionPanel.tsx      (header)
  ap/services/web/src/components/panels/PredictionEvolutionDashboardPanel.tsx (header)
  ap/services/web/src/components/panels/LeaningPanel.tsx         (header)
  ap/services/web/src/components/USMap.tsx                       (Stage 1.5)
```

## Known issues / next iterations

- **PredictionPanel** inner UI is still Chinese — biggest gap. Stage 1.7
  should focus here since prediction is a key user destination.
- **CalibrationPanel** is fully Chinese and uses TW-only assumptions — will
  need both bilingual sweep AND a country-aware calibrator wiring.
- The **`/api/runtime/news-sources`** endpoint reads
  `/app/shared/us_data/us_feed_sources.json` inside the api container — bind
  mount path is `./shared:/app/shared`. If the snapshot file is missing the
  endpoint falls back to a tiny built-in dict (~15 sources).
