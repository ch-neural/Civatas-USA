# Civatas Open-Source UI Redesign

**Date:** 2026-04-09
**Status:** Approved
**Scope:** Frontend UI overhaul + backend auth removal for open-source release

## Goal

Restructure the Civatas UI so that a new open-source user can:

1. Launch via `docker compose up --build`
2. Configure LLM and Serper API keys on first visit
3. Create a project with a template
4. Understand and execute the 3-step workflow: **Persona -> Evolution -> Prediction**

## Design Decisions

| Decision | Choice |
|----------|--------|
| Authentication | **Removed** — no login, direct access |
| First run | **Full onboarding wizard** — keys -> project -> persona -> ready |
| Navigation | **Left sidebar** with 3 numbered steps + expandable sub-items |
| Core workflow | **3 steps only:** Persona -> Evolution -> Prediction |
| LLM config | **Simplified multi-vendor** — default 1 vendor, "Add more" to expand |
| Serper key | **Required** in onboarding, with links to apply for a key |
| Guide mode | **Hybrid** — wizard first run, contextual banners after, dismissible |
| Removed panels | Calibration, Sandbox, Primary, Simulation, Analytics, Playback, Historical Evolution, StatModules |

## Architecture Changes

### 1. Remove Authentication

**Backend (`ap/services/api/`):**
- Remove JWT middleware from `app/main.py` — all routes become public
- Remove `app/auth.py` and `app/routes/auth.py`
- Remove `users.json` management from `app/store.py`
- Keep the `X-Internal-Token` header for inter-service calls (unchanged)

**Frontend (`ap/services/web/src/`):**
- Remove `store/auth-store.ts`
- Remove `components/AuthGuard.tsx`
- Remove `app/login/page.tsx`
- Remove auth token logic from `lib/api.ts` (no more `Authorization` header)

### 2. First-Run Onboarding Wizard

New component: `components/onboarding/OnboardingWizard.tsx`

**Detection:** On app load, call `GET /api/settings`. If no LLM vendors are configured (empty `llm_vendors` array or all keys blank), show the wizard full-screen instead of the main app.

**Wizard Steps:**

**Step 1 — API Key Setup**
- One default vendor card (OpenAI) with fields: vendor type dropdown, API key, model
- "Add another vendor" link to add more cards (Gemini, xAI, DeepSeek, Moonshot, Ollama)
- Serper API Key field (required, validated non-empty)
- Help links: direct URLs to each provider's API key page
  - OpenAI: `https://platform.openai.com/api-keys`
  - Gemini: `https://aistudio.google.com/apikey`
  - xAI: `https://console.x.ai/`
  - DeepSeek: `https://platform.deepseek.com/api_keys`
  - Serper: `https://serper.dev/api-key`
- "Test Connection" button per vendor — calls the vendor's API with a minimal request to verify the key works
- Save via `PUT /api/settings`

**Step 2 — Create Project**
- Project name text input
- Template picker: fetch from `GET /api/templates`, group by scope (National / State)
- Each template card shows: name, description, state count, candidate info
- On submit: `POST /api/workspaces` then `POST /api/workspaces/{id}/apply-template`

**Step 3 — Generate Personas**
- Show template-derived demographics summary (gender/age/education/party_lean/states)
- Target count input (default 100)
- "Generate Personas" button
- Progress bar with polling via `GET /api/workspaces/{id}/persona-progress`
- Wait for completion before enabling "Next"

**Step 4 — Ready**
- Summary: persona count generated, template applied
- Explain next steps: Evolution (feed news, shape opinions) then Prediction (run polls)
- "Enter Workspace" button -> navigate to main app with the created workspace active

**State persistence:** Store `onboarding_completed: true` in `settings.json` via a new field. Subsequent visits skip the wizard. A "Re-run Setup" option in Settings allows re-triggering.

### 3. Simplified Navigation (Left Sidebar)

Replace current `NavTree.tsx` with a new `WorkflowSidebar.tsx`.

**Structure:**
```
[CIVATAS logo]
[Project selector dropdown]
---
WORKFLOW
  (1) Persona          [checkmark + count when done]
      - Setup
      - Synthesis
      - Explore
  (2) Evolution        [locked if no personas]
      - News Sources
      - Run Evolution
      - Dashboard
      - Agent Explorer
  (3) Prediction       [locked if no evolution]
      - Setup Scenario
      - Run Prediction
      - Analysis
---
[Settings gear icon at bottom]
```

**Step states:**
- **Locked:** grayed out, shows lock icon + "Requires [previous step]"
- **Available:** normal color, clickable
- **Active:** highlighted with accent border, expanded sub-items
- **Completed:** shows green checkmark + summary (e.g., "100 agents")

**Sub-items map to panels:**

| Sidebar item | Panel component | Route |
|---|---|---|
| Persona > Setup | `PopulationSetupPanel` | `/workspaces/[id]/population-setup` |
| Persona > Synthesis | `SynthesisResultPanel` | `/workspaces/[id]/synthesis` |
| Persona > Explore | `PersonaPanel` | `/workspaces/[id]/persona` |
| Evolution > News Sources | `EvolutionPanel` (Sources tab) | `/workspaces/[id]/evolution` |
| Evolution > Run Evolution | `EvolutionPanel` (Runner tab) | `/workspaces/[id]/evolution-runner` |
| Evolution > Dashboard | `EvolutionDashboardPanel` | `/workspaces/[id]/evolution-dashboard` |
| Evolution > Agent Explorer | `AgentExplorerPanel` | `/workspaces/[id]/agent-explorer` |
| Prediction > Setup Scenario | `PredictionPanel` | `/workspaces/[id]/prediction` |
| Prediction > Run Prediction | `PredictionEvolutionDashboardPanel` | `/workspaces/[id]/prediction-evolution-dashboard` |
| Prediction > Analysis | `PredictionAnalysisPanel` | `/workspaces/[id]/prediction-analysis` |

### 4. Prerequisite Gates

Each step checks whether the previous step is completed before allowing access.

**Gate logic (frontend):**
- **Evolution panels:** Check `GET /api/workspaces/{id}/persona-result` — if empty/404, show gate
- **Prediction panels:** Check evolution job history — if no completed evolution jobs, show gate

**Gate UI:** Centered lock icon + message + "Go to [Step N]" button. Replaces the panel content entirely.

New component: `components/shared/StepGate.tsx`
```tsx
interface StepGateProps {
  step: number;           // required step number
  stepName: string;       // "Persona" | "Evolution"
  description: string;    // what needs to be done
  targetRoute: string;    // where the button navigates
}
```

### 5. Contextual Guide Banners

After the first-run wizard, show dismissible guide banners at the top of each panel on first visit.

New component: `components/shared/GuideBanner.tsx`

**Behavior:**
- Each panel has a unique `guideKey` (e.g., `"guide_population_setup"`)
- On first visit, show a banner with a lightbulb icon, title, and 1-2 sentence description
- Dismiss button stores `dismissed_guides: ["guide_population_setup", ...]` in localStorage
- "Skip Guide" button in the top-right area dismisses all remaining guides at once

**Banner content per panel:**
- Population Setup: "Your template has pre-configured demographics. Review the settings, adjust if needed, then generate personas."
- Persona Explore: "Browse your generated agents. Each has demographics, personality traits, and political leaning derived from census data."
- Evolution > News Sources: "Add RSS feeds or manually inject news articles. Agents will consume these during evolution to form opinions."
- Evolution > Run: "Start the evolution process. Agents read news, discuss with each other, and update their beliefs over simulated days."
- Evolution > Dashboard: "Monitor evolution progress in real-time. See how many agents have been processed per day."
- Prediction > Setup: "Define a poll question, select candidates, and configure the prediction scenario."
- Prediction > Analysis: "View poll results, candidate vote shares, and preference shifts over time."

### 6. Settings Panel Simplification

Retain `SettingsPanel.tsx` but simplify to 2 tabs:

**Tab 1 — API Keys**
- LLM vendors list (same as onboarding step 1, but editable anytime)
- Serper API Key
- Test connection buttons
- "Re-run Onboarding" button

**Tab 2 — Appearance**
- Dark/light mode toggle (keep existing)
- Language selector (en / zh-TW)

Remove: Recording management tab.

### 7. Panels to Remove

Delete these panel components and their routes:

- `CalibrationPanel.tsx`
- `SandboxPanel.tsx`
- `PrimaryPanel.tsx`
- `SimulationPanel.tsx`
- `AnalyticsPanel.tsx`
- `HistoricalEvolutionPanel.tsx`
- `NewsCenterPanel.tsx` (merge news viewing into Evolution panel)
- `SatisfactionSurveyPanel.tsx`
- `StatModulesPanel.tsx`
- `LeaningPanel.tsx` (leaning auto-applied from template)
- `DataSourcesPanel.tsx` (merge into PopulationSetupPanel)
- `PlaybackViewer.tsx` and playback routes
- `RecordingManager.tsx` / `RecordingButton.tsx`

### 8. Shell Simplification

**Remove:**
- `PanelTabBar.tsx` — no more multi-tab system; single panel view driven by sidebar
- `InspectorPanel.tsx` — remove right-side inspector; agent details shown inline or in modal
- `CommandPalette.tsx` — not needed for simplified workflow
- `MenuBar.tsx` — functionality moved to sidebar + settings
- `ResizeHandle.tsx` and split-panel layout logic from `LayoutRenderer.tsx`

**Keep:**
- `DesktopShell.tsx` — simplified to sidebar + single content area
- `StatusBar.tsx` — keep for locale toggle and background job status

### 9. Backend Changes

**New endpoint:**
- `GET /api/settings` add `onboarding_completed` boolean field
- `PUT /api/settings` accept `onboarding_completed` field

**Remove:**
- `app/routes/auth.py` — login/logout/me endpoints
- `app/auth.py` — JWT logic, user store
- Auth middleware in `app/main.py` — remove the `AuthMiddleware` class
- `app/routes/playback.py` — public playback API

**Keep unchanged:**
- All workspace, pipeline, evolution, prediction endpoints
- Template endpoints
- Settings endpoints (extend with `onboarding_completed`)
- Internal service communication

### 10. Route Simplification

**New route structure:**
```
/                           -> redirect to /workspaces or onboarding
/workspaces                 -> workspace list (project selector)
/workspaces/[id]/population-setup          -> Persona > Setup
/workspaces/[id]/synthesis                 -> Persona > Synthesis
/workspaces/[id]/persona                   -> Persona > Explore
/workspaces/[id]/evolution                 -> Evolution > News Sources
/workspaces/[id]/evolution-runner          -> Evolution > Run
/workspaces/[id]/evolution-dashboard       -> Evolution > Dashboard
/workspaces/[id]/agent-explorer            -> Evolution > Agent Explorer
/workspaces/[id]/prediction                -> Prediction > Setup
/workspaces/[id]/prediction-evolution-dashboard -> Prediction > Run
/workspaces/[id]/prediction-analysis       -> Prediction > Analysis
/settings                                  -> Global settings
```

**Remove routes:** `/login`, `/playback`, `/workspaces/[id]/calibration`, `/workspaces/[id]/sandbox`, `/workspaces/[id]/primary`, `/workspaces/[id]/simulation`, `/workspaces/[id]/analytics`, `/workspaces/[id]/historical-evolution`, `/workspaces/[id]/news-center`, `/workspaces/[id]/stat-modules`, `/workspaces/[id]/data-sources`, `/workspaces/[id]/leaning`, `/workspaces/[id]/satisfaction-survey`

## Non-Goals

- No changes to backend pipeline logic (ingestion, synthesis, persona, evolution services)
- No changes to template schema or data pipeline scripts
- No changes to docker-compose service architecture
- No new features — this is a simplification and UX improvement only
