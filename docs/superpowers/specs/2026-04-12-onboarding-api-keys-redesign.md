# Onboarding API Keys Redesign — Spec

**Date:** 2026-04-12
**Status:** Draft

## Problem

The current onboarding wizard Step 1 mixes LLM provider credentials with role
assignment. Users who want to use the same vendor (e.g. OpenAI) for both System
LLM and Agent LLM must enter the API key in two different places with two
different formats. The flat layout is not intuitive for first-time users.

## Solution

Separate "provider credentials" from "role assignment" using a 3-section
accordion UI with progressive disclosure:

1. **LLM Providers** — add vendor name, API key, base URL
2. **Assign LLM Roles** — pick provider + model for System LLM and Agent LLM(s)
3. **Search API** — Serper API key

The Settings Panel API Keys tab is updated to use the same mental model.

---

## Data Model

### Conceptual separation

```
Provider (credentials, role-agnostic):
  id: string           // e.g. "openai-1", "gemini-1734567890"
  vendor_type: string  // openai | gemini | xai | deepseek | moonshot | ollama
  display_name: string // user-facing label
  api_key: string
  base_url: string     // optional custom endpoint

Role assignments (reference providers by id):
  system_llm: { provider_id: string, model: string }
  agent_llms: [{ provider_id: string, model: string }]
```

### Backend compatibility

The backend `SettingsUpdate` schema (`llm_vendors`, `active_vendors`,
`system_vendor_id`, `vendor_ratio`, etc.) is **not changed**. The frontend
reconstructs the existing `VendorEntry[]` format on save:

- Each agent LLM assignment becomes a `VendorEntry` in `llm_vendors` with its
  provider's credentials + the assigned model.
- The system LLM assignment becomes a `VendorEntry` with `id: "system-llm"`.
- `active_vendors` = list of agent LLM vendor entry IDs.
- `system_vendor_id` = `"system-llm"` (or first agent vendor if same credentials).

On load (`GET /api/settings`), the frontend reverses this: deduplicates vendors
by `(vendor_type, api_key, base_url)` to rebuild the provider list, then reads
`system_vendor_id` and `active_vendors` to reconstruct role assignments.

---

## Onboarding Wizard Step 1

### Layout: 3-section accordion

All three sections are on one page. Sections unlock progressively.

#### Section 1 — LLM Providers

- **Open by default.** Locked sections 2 and 3 are grey with lock icon.
- Each provider card shows:
  - Vendor type dropdown (OpenAI, Gemini, xAI, DeepSeek, Moonshot, Ollama)
  - API Key input (password field) + **Test** button
  - Base URL input (optional, placeholder shows vendor default)
  - "Get {Vendor} API Key →" link
  - Delete (✕) button (disabled if only 1 provider)
- "+ Add another provider" button at the bottom (dashed border).
- **Unlock condition for Section 2:** ≥ 1 provider with non-empty API key.
- **Completion indicator:** header shows green ✓ + "{N} providers configured".

#### Section 2 — Assign LLM Roles

- **Unlocked** when Section 1 has ≥ 1 provider.
- **Auto-opens** when Section 1 completes (first provider key filled in).
- Two sub-sections separated by a divider:

**System LLM:**
- Description: "Used for news analysis, data parsing, and other system tasks.
  A capable thinking model is recommended."
- Provider dropdown (populated from Section 1 providers).
- Model text input.
- Defaults: first provider, with a system-appropriate model
  (OpenAI → `o4-mini`, Gemini → `gemini-2.5-flash`, xAI → `grok-3-mini`,
  DeepSeek → `deepseek-chat`, Moonshot → `kimi-k2.5`, Ollama → `llama3`).

**Agent LLM:**
- Description: "Used for persona generation and agent simulation. Select one
  or more providers."
- List of all providers from Section 1, each as a checkbox row:
  - Checkbox + provider display name
  - Model text input (pre-filled with vendor default model, e.g. `gpt-4o-mini`)
  - Checked providers are visually highlighted (blue border).
  - Unchecked providers are dimmed.
- First provider is checked by default.

- **Unlock condition for Section 3:** System LLM provider selected + ≥ 1
  Agent LLM checked.
- **Completion indicator:** header shows green ✓ + summary like
  "System: OpenAI o4-mini · Agent: 2 models".

#### Section 3 — Search API

- **Unlocked** when Section 2 is complete.
- **Auto-opens** when Section 2 completes.
- Serper API Key input (password field) + **Test** button.
- "Get Serper API Key (Google Search) →" link.
- **Completion indicator:** header shows green ✓ + "Configured".

### Accordion interaction rules

- **Locked sections:** grey, not clickable, show lock icon + hint text
  (e.g. "Add a provider first").
- **Unlocked sections:** clickable to expand/collapse freely. Users can go back.
- **Auto-advance:** when a section completes, the next section auto-expands.
- **Completed sections:** header right side shows green ✓ + summary text.
  Section body can still be re-opened to edit.
- **"Next: Create Project →" button:** enabled only when all 3 sections are
  complete (≥ 1 provider, roles assigned, serper key filled).

### System LLM default model mapping

When a provider is selected for System LLM, auto-fill the model field:

| vendor_type | System LLM default model |
|-------------|-------------------------|
| openai      | o4-mini                 |
| gemini      | gemini-2.5-flash        |
| xai         | grok-3-mini             |
| deepseek    | deepseek-chat           |
| moonshot    | kimi-k2.5               |
| ollama      | llama3                  |

These are distinct from the Agent LLM defaults (which use the existing
`VENDOR_PRESETS.defaultModel`).

---

## Settings Panel — API Keys Tab

Updated to match the same "provider → role" mental model, with additional
advanced options not shown in onboarding.

### Layout (top to bottom)

1. **LLM Providers** — same CRUD as onboarding Section 1. Add/edit/delete
   providers. Edit opens an inline form or modal with: vendor type, display
   name, API key, base URL, Test button.

2. **System LLM** — dropdown to select provider + model input. Same as
   onboarding Section 2.

3. **Agent LLM** — checkbox multi-select from providers + model per provider.
   Additional controls (not in onboarding):
   - **Mode selector:** radio for "Multi (ratio-based)" vs "Primary + Fallback"
   - **Vendor ratio** input (visible in multi mode, e.g. `2:1:1`)
   - **Primary / Fallback dropdowns** (visible in primary_fallback mode)

4. **Search API** — Serper key + Test button.

5. **Re-run Onboarding Wizard** button (existing, kept as-is).

### Save behavior

Single "Save" button at the bottom. On save:
- Reconstruct `llm_vendors` array from providers + role assignments.
- Send `PUT /api/settings` with full settings payload.
- Show success toast.

---

## API Changes

**None.** The backend API (`GET/PUT /api/settings`, `POST /test-vendor`,
`POST /test-serper`, `GET /vendor-types`) remains unchanged. The restructuring
is purely frontend — the frontend maps between the new UI model and the existing
`SettingsUpdate` schema on save/load.

---

## Files to modify

### Onboarding Wizard
- `ap/services/web/src/components/onboarding/OnboardingWizard.tsx` — rewrite
  Step 1 with accordion sections, new state management for providers vs roles.

### Settings Panel
- `ap/services/web/src/components/panels/SettingsPanel.tsx` — restructure API
  Keys tab to provider → role layout, add advanced Agent LLM controls.

### No backend changes
- `ap/services/api/app/routes/settings.py` — no changes
- `ap/shared/global_settings.py` — no changes

---

## Out of scope

- Backend schema changes (keeping `llm_vendors` + `system_vendor_id` format).
- Ratio / mode settings in onboarding wizard (Settings Panel only).
- Temperature per-model in onboarding (Settings Panel only).
- Changes to Steps 2–4 of the onboarding wizard.
