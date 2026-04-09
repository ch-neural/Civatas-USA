# Open-Source UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure Civatas UI for open-source release: remove auth, add onboarding wizard, simplify to 3-step workflow (Persona → Evolution → Prediction), add prerequisite gates and guide banners.

**Architecture:** Remove JWT auth layer entirely. Replace NavTree + multi-tab panel system with a single-panel WorkflowSidebar. Add full-screen OnboardingWizard detected via empty settings. Prerequisite gates block steps that depend on incomplete prior steps.

**Tech Stack:** Next.js 14 (App Router), React 18, Zustand, TanStack Query, Tailwind CSS, FastAPI (Python backend)

**Spec:** `docs/superpowers/specs/2026-04-09-open-source-ui-redesign.md`

---

### Task 1: Backend — Remove Auth Middleware and Routes

**Files:**
- Modify: `ap/services/api/app/main.py`
- Delete: `ap/services/api/app/auth.py`
- Delete: `ap/services/api/app/routes/auth.py`
- Delete: `ap/services/api/app/routes/playback.py`

- [ ] **Step 1: Remove auth middleware from main.py**

In `ap/services/api/app/main.py`, remove the auth import, `_seed_default_user` call, `PUBLIC_PREFIXES`, `INTERNAL_SERVICE_TOKEN`, and the entire `auth_middleware` function. Remove the `auth.router` and `playback.router` includes. Keep CORS, health, runtime routes unchanged.

The file should become:

```python
import os, json
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .routes import projects, pipeline, templates, workspaces, settings

app = FastAPI(
    title="Civatas API",
    version="0.1.0",
    description="Universal Social Simulation Agent Generation Platform",
    redirect_slashes=False,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(projects.router, prefix="/api/projects", tags=["projects"])
app.include_router(pipeline.router, prefix="/api/pipeline", tags=["pipeline"])
app.include_router(templates.router, prefix="/api/templates", tags=["templates"])
app.include_router(workspaces.router, prefix="/api/workspaces", tags=["workspaces"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])

@app.get("/health")
async def health():
    return {"status": "ok"}

# Keep the existing /api/runtime and /api/runtime/news-sources routes unchanged
```

Copy the existing `/api/runtime` and `/api/runtime/news-sources` route handlers as-is from the current file.

- [ ] **Step 2: Delete auth files**

```bash
rm ap/services/api/app/auth.py
rm ap/services/api/app/routes/auth.py
rm ap/services/api/app/routes/playback.py
```

- [ ] **Step 3: Remove auth dependency from routes that import it**

Search for `from ..auth import` or `from .auth import` or `get_current_user` across all route files in `ap/services/api/app/routes/`. Remove those imports and remove `current_user: dict = Depends(get_current_user)` parameters from any endpoint function signatures.

```bash
cd /Volumes/AI02/Civatas-USA
grep -rn "get_current_user\|from.*auth import" ap/services/api/app/routes/*.py
```

For each match, remove the import and the `Depends(get_current_user)` parameter.

- [ ] **Step 4: Remove bcrypt and python-jose from requirements**

In `ap/services/api/requirements.txt`, remove the `bcrypt` and `python-jose[cryptography]` lines if present.

- [ ] **Step 5: Verify backend starts**

```bash
cd /Volumes/AI02/Civatas-USA/ap
docker compose build api
docker compose up api -d
sleep 3
curl http://localhost:8000/health
curl http://localhost:8000/api/settings
```

Expected: Both return JSON without 401 errors.

- [ ] **Step 6: Commit**

```bash
git add -A ap/services/api/
git commit -m "feat: remove auth middleware and login system for open-source release"
```

---

### Task 2: Backend — Add onboarding_completed to Settings

**Files:**
- Modify: `ap/shared/global_settings.py`
- Modify: `ap/services/api/app/routes/settings.py`

- [ ] **Step 1: Add onboarding_completed to default settings**

In `ap/shared/global_settings.py`, add `"onboarding_completed": False` to the `_default_settings()` return dict (after `"tavily_api_key"`).

- [ ] **Step 2: Add onboarding_completed to SettingsUpdate model**

In `ap/services/api/app/routes/settings.py`, add to the `SettingsUpdate` model:

```python
onboarding_completed: Optional[bool] = None
```

- [ ] **Step 3: Handle onboarding_completed in PUT handler**

In the `api_update_settings` function in `ap/services/api/app/routes/settings.py`, add after the existing settings updates:

```python
if req.onboarding_completed is not None:
    current["onboarding_completed"] = req.onboarding_completed
```

- [ ] **Step 4: Verify settings endpoint returns onboarding_completed**

```bash
curl http://localhost:8000/api/settings | python3 -m json.tool | grep onboarding
```

Expected: `"onboarding_completed": false`

- [ ] **Step 5: Commit**

```bash
git add ap/shared/global_settings.py ap/services/api/app/routes/settings.py
git commit -m "feat: add onboarding_completed field to settings"
```

---

### Task 3: Frontend — Remove Auth Code

**Files:**
- Delete: `ap/services/web/src/store/auth-store.ts`
- Delete: `ap/services/web/src/components/AuthGuard.tsx`
- Delete: `ap/services/web/src/app/login/page.tsx`
- Modify: `ap/services/web/src/lib/api.ts`
- Modify: `ap/services/web/src/components/AppShell.tsx`

- [ ] **Step 1: Simplify api.ts — remove auth headers and 401 handling**

In `ap/services/web/src/lib/api.ts`:

1. Remove `getAuthToken()` function entirely
2. In `buildHeaders()`, remove the `Authorization` header line
3. In `apiFetch()`, remove the 401 response handling block (the part that clears auth and redirects to `/login`)
4. In `apiFetch()`, remove the catch block that clears auth on network error
5. Remove the auth-related localStorage logic

The simplified `apiFetch` should be:

```typescript
export async function apiFetch(path: string, opts: RequestInit = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API_BASE}${path}${sep}_t=${Date.now()}`;
  const res = await fetch(url, {
    ...opts,
    headers: buildHeaders(opts.headers as Record<string, string>),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.detail || res.statusText);
  }
  return res.json();
}
```

And `buildHeaders`:

```typescript
function buildHeaders(custom?: Record<string, string>, isFormData?: boolean) {
  const h: Record<string, string> = { ...custom };
  if (!isFormData) h["Content-Type"] = "application/json";
  return h;
}
```

- [ ] **Step 2: Simplify AppShell.tsx — remove AuthGuard**

Replace `ap/services/web/src/components/AppShell.tsx` with:

```tsx
"use client";
import { usePathname } from "next/navigation";
import { DesktopShell } from "./shell/DesktopShell";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Playback is a standalone page without the shell chrome
  if (pathname?.startsWith("/playback")) {
    return <>{children}</>;
  }
  return <DesktopShell>{children}</DesktopShell>;
}
```

- [ ] **Step 3: Delete auth files**

```bash
rm ap/services/web/src/store/auth-store.ts
rm ap/services/web/src/components/AuthGuard.tsx
rm -rf ap/services/web/src/app/login
```

- [ ] **Step 4: Remove auth-store imports everywhere**

```bash
grep -rn "auth-store\|useAuthStore\|AuthGuard" ap/services/web/src/ --include="*.ts" --include="*.tsx"
```

Remove all remaining imports and usages found.

- [ ] **Step 5: Commit**

```bash
git add -A ap/services/web/src/
git commit -m "feat: remove auth system from frontend"
```

---

### Task 4: Frontend — Rewrite panel-registry for 3-Step Workflow

**Files:**
- Modify: `ap/services/web/src/store/panel-registry.ts`

- [ ] **Step 1: Rewrite panel-registry.ts**

Replace the entire file with the new simplified registry. Keep only the panels needed for the 3-step workflow plus global panels:

```typescript
/* ---- Panel Registry (Open-Source 3-Step Workflow) ---- */

export interface PanelTypeInfo {
  type: string;
  route: (wsId: string) => string;
  label: string;
  labelEn: string;
  icon: string;
  closeable?: boolean;
}

// ── Workspace-scoped panels ──
export const WORKSPACE_PANEL_TYPES: Record<string, PanelTypeInfo> = {
  // Step 1: Persona
  "population-setup": {
    type: "population-setup",
    route: (id) => `/workspaces/${id}/population-setup`,
    label: "人口設定", labelEn: "Population Setup", icon: "👥",
  },
  synthesis: {
    type: "synthesis",
    route: (id) => `/workspaces/${id}/synthesis`,
    label: "合成結果", labelEn: "Synthesis Result", icon: "🧬",
  },
  persona: {
    type: "persona",
    route: (id) => `/workspaces/${id}/persona`,
    label: "人設管理", labelEn: "Persona Explorer", icon: "🎭",
  },
  // Step 2: Evolution
  evolution: {
    type: "evolution",
    route: (id) => `/workspaces/${id}/evolution`,
    label: "新聞來源", labelEn: "News Sources", icon: "📰",
  },
  "evolution-runner": {
    type: "evolution-runner",
    route: (id) => `/workspaces/${id}/evolution-runner`,
    label: "執行演化", labelEn: "Run Evolution", icon: "▶️",
  },
  "evolution-dashboard": {
    type: "evolution-dashboard",
    route: (id) => `/workspaces/${id}/evolution-dashboard`,
    label: "演化儀表板", labelEn: "Evolution Dashboard", icon: "📊",
  },
  "agent-explorer": {
    type: "agent-explorer",
    route: (id) => `/workspaces/${id}/agent-explorer`,
    label: "Agent 探索器", labelEn: "Agent Explorer", icon: "🔍",
  },
  // Step 3: Prediction
  prediction: {
    type: "prediction",
    route: (id) => `/workspaces/${id}/prediction`,
    label: "預測設定", labelEn: "Prediction Setup", icon: "🔮",
  },
  "prediction-evolution-dashboard": {
    type: "prediction-evolution-dashboard",
    route: (id) => `/workspaces/${id}/prediction-evolution-dashboard`,
    label: "執行預測", labelEn: "Run Prediction", icon: "📊",
  },
  "prediction-analysis": {
    type: "prediction-analysis",
    route: (id) => `/workspaces/${id}/prediction-analysis`,
    label: "預測分析", labelEn: "Prediction Analysis", icon: "📈",
  },
};

// ── Global panels ──
export const GLOBAL_PANEL_TYPES: Record<string, PanelTypeInfo> = {
  "workspace-list": {
    type: "workspace-list",
    route: () => "/workspaces",
    label: "專案管理", labelEn: "Projects", icon: "🗂️",
    closeable: false,
  },
  settings: {
    type: "settings",
    route: () => "/settings",
    label: "設定", labelEn: "Settings", icon: "⚙️",
  },
};

// ── 3-Step Workflow Definition ──
export interface WorkflowStep {
  key: string;
  number: number;
  label: string;
  labelEn: string;
  icon: string;
  mainPanel: string;        // default panel when clicking the step
  subItems: string[];       // panel types shown as sub-items
  requiresStep?: number;    // prerequisite step number
}

export const WORKFLOW_STEPS: WorkflowStep[] = [
  {
    key: "persona",
    number: 1,
    label: "人設生成", labelEn: "Persona",
    icon: "👥",
    mainPanel: "population-setup",
    subItems: ["population-setup", "synthesis", "persona"],
  },
  {
    key: "evolution",
    number: 2,
    label: "演化", labelEn: "Evolution",
    icon: "📰",
    mainPanel: "evolution",
    subItems: ["evolution", "evolution-runner", "evolution-dashboard", "agent-explorer"],
    requiresStep: 1,
  },
  {
    key: "prediction",
    number: 3,
    label: "預測", labelEn: "Prediction",
    icon: "🔮",
    mainPanel: "prediction",
    subItems: ["prediction", "prediction-evolution-dashboard", "prediction-analysis"],
    requiresStep: 2,
  },
];

// ── Helpers ──
export function panelLabel(info: PanelTypeInfo, locale: string): string {
  return locale === "en" && info.labelEn ? info.labelEn : info.label;
}

export function routeToPanelType(pathname: string): { type: string; wsId?: string } | null {
  // Check workspace routes: /workspaces/{id}/{panel}
  const wsMatch = pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)/);
  if (wsMatch) {
    const [, wsId, panel] = wsMatch;
    if (WORKSPACE_PANEL_TYPES[panel]) return { type: panel, wsId };
  }
  // Check global routes
  if (pathname === "/workspaces") return { type: "workspace-list" };
  if (pathname === "/settings") return { type: "settings" };
  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add ap/services/web/src/store/panel-registry.ts
git commit -m "feat: simplify panel-registry to 3-step workflow"
```

---

### Task 5: Frontend — Create WorkflowSidebar Component

**Files:**
- Create: `ap/services/web/src/components/shell/WorkflowSidebar.tsx`
- Create: `ap/services/web/src/hooks/use-workflow-status.ts`

- [ ] **Step 1: Create use-workflow-status hook**

This hook checks whether each step's prerequisites are met by querying backend state.

```typescript
// ap/services/web/src/hooks/use-workflow-status.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export type StepStatus = "locked" | "available" | "completed";

export interface WorkflowStatus {
  persona: StepStatus;
  evolution: StepStatus;
  prediction: StepStatus;
  personaCount: number;
  evolutionCompleted: boolean;
}

export function useWorkflowStatus(wsId: string | null) {
  // Check persona result
  const personaQuery = useQuery({
    queryKey: ["persona-result", wsId],
    queryFn: () => apiFetch(`/api/workspaces/${wsId}/persona-result`),
    enabled: !!wsId,
    retry: false,
    refetchInterval: 10_000,
  });

  // Check evolution history
  const evolutionQuery = useQuery({
    queryKey: ["evolution-history", wsId],
    queryFn: () => apiFetch(`/api/pipeline/evolution/evolve/history`),
    enabled: !!wsId,
    retry: false,
    refetchInterval: 10_000,
  });

  const personaCount =
    personaQuery.data?.agents?.length ?? personaQuery.data?.length ?? 0;
  const hasPersonas = personaCount > 0;

  const evolutionJobs: any[] = evolutionQuery.data?.jobs ?? evolutionQuery.data ?? [];
  const hasEvolution = evolutionJobs.some(
    (j: any) => j.status === "completed" || j.status === "done"
  );

  const status: WorkflowStatus = {
    persona: "available",
    evolution: hasPersonas ? (hasEvolution ? "completed" : "available") : "locked",
    prediction: hasEvolution ? "available" : "locked",
    personaCount,
    evolutionCompleted: hasEvolution,
  };

  // Mark persona completed if we have personas
  if (hasPersonas) status.persona = "completed";

  return status;
}
```

- [ ] **Step 2: Create WorkflowSidebar component**

```typescript
// ap/services/web/src/components/shell/WorkflowSidebar.tsx
"use client";
import { useRouter, usePathname } from "next/navigation";
import { useShellStore } from "@/store/shell-store";
import { useLocaleStore } from "@/store/locale-store";
import { useWorkflowStatus, StepStatus } from "@/hooks/use-workflow-status";
import {
  WORKFLOW_STEPS,
  WORKSPACE_PANEL_TYPES,
  panelLabel,
} from "@/store/panel-registry";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useState } from "react";

export function WorkflowSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocaleStore((s) => s.locale);
  const wsId = useShellStore((s) => s.activeWorkspaceId);
  const wsName = useShellStore((s) => s.activeWorkspaceName);
  const workflowStatus = useWorkflowStatus(wsId);

  // Workspace list for project selector
  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => apiFetch("/api/workspaces"),
  });

  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set([1]));

  const en = locale === "en";

  const toggleStep = (num: number) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
  };

  const getStepStatus = (step: typeof WORKFLOW_STEPS[0]): StepStatus => {
    if (step.key === "persona") return workflowStatus.persona;
    if (step.key === "evolution") return workflowStatus.evolution;
    if (step.key === "prediction") return workflowStatus.prediction;
    return "available";
  };

  const getStatusBadge = (status: StepStatus, step: typeof WORKFLOW_STEPS[0]) => {
    if (status === "completed") {
      const label =
        step.key === "persona" ? `✓ ${workflowStatus.personaCount}` : "✓";
      return (
        <span className="ml-auto text-xs text-green-400">{label}</span>
      );
    }
    if (status === "locked") {
      return (
        <span className="ml-auto text-[10px] bg-neutral-700 text-neutral-500 px-1.5 py-0.5 rounded">
          {en ? "Locked" : "未解鎖"}
        </span>
      );
    }
    return null;
  };

  const navigateTo = (panelType: string) => {
    if (!wsId) return;
    const info = WORKSPACE_PANEL_TYPES[panelType];
    if (!info) return;
    router.push(info.route(wsId));
  };

  const isActivePanel = (panelType: string) => {
    if (!wsId) return false;
    const info = WORKSPACE_PANEL_TYPES[panelType];
    if (!info) return false;
    return pathname === info.route(wsId);
  };

  return (
    <div className="h-full flex flex-col bg-[#16213e] text-sm select-none">
      {/* Logo */}
      <div className="px-4 py-3 border-b border-[#0f3460]">
        <div className="text-[#e94560] font-bold text-lg tracking-wide">
          CIVATAS
        </div>
        <div className="text-neutral-500 text-[10px] mt-0.5">
          Open Source Edition
        </div>
      </div>

      {/* Project selector */}
      <div className="px-4 py-2.5 border-b border-[#0f3460]">
        <div className="text-neutral-500 text-[10px] uppercase tracking-wider mb-1">
          {en ? "Project" : "專案"}
        </div>
        <select
          className="w-full bg-[#0f3460] text-neutral-300 text-xs rounded px-2 py-1.5 border-none outline-none cursor-pointer"
          value={wsId ?? ""}
          onChange={(e) => {
            const id = e.target.value;
            if (id) {
              const ws = (workspaces ?? []).find((w: any) => w.id === id);
              useShellStore.getState().setActiveWorkspace(id, ws?.name ?? id);
              router.push(`/workspaces/${id}/population-setup`);
            } else {
              router.push("/workspaces");
            }
          }}
        >
          <option value="">{en ? "Select project..." : "選擇專案..."}</option>
          {(workspaces ?? []).map((ws: any) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </select>
      </div>

      {/* Workflow steps */}
      <div className="flex-1 overflow-y-auto py-2">
        <div className="px-4 py-1 text-neutral-600 text-[9px] uppercase tracking-widest">
          {en ? "Workflow" : "工作流程"}
        </div>

        {WORKFLOW_STEPS.map((step) => {
          const status = getStepStatus(step);
          const isLocked = status === "locked";
          const isExpanded = expandedSteps.has(step.number);
          const stepLabel = en ? step.labelEn : step.label;

          return (
            <div key={step.key}>
              {/* Step header */}
              <button
                className={`w-full flex items-center gap-2 px-4 py-2 mt-1 text-left transition-colors ${
                  isLocked
                    ? "opacity-40 cursor-not-allowed"
                    : "hover:bg-white/5 cursor-pointer"
                }`}
                onClick={() => {
                  if (isLocked) return;
                  toggleStep(step.number);
                  if (!isExpanded) navigateTo(step.mainPanel);
                }}
                disabled={isLocked}
              >
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    status === "completed"
                      ? "bg-green-500 text-white"
                      : isLocked
                      ? "bg-neutral-700 text-neutral-500"
                      : "bg-[#e94560] text-white"
                  }`}
                >
                  {status === "completed" ? "✓" : step.number}
                </div>
                <span
                  className={`font-medium ${
                    isLocked ? "text-neutral-600" : "text-neutral-200"
                  }`}
                >
                  {stepLabel}
                </span>
                {getStatusBadge(status, step)}
              </button>

              {/* Sub-items */}
              {isExpanded && !isLocked && (
                <div className="ml-4">
                  {step.subItems.map((panelType) => {
                    const info = WORKSPACE_PANEL_TYPES[panelType];
                    if (!info) return null;
                    const active = isActivePanel(panelType);
                    return (
                      <button
                        key={panelType}
                        className={`w-full text-left px-4 py-1.5 pl-8 text-xs transition-colors ${
                          active
                            ? "text-[#e94560] bg-[#e94560]/10 border-l-2 border-[#e94560]"
                            : "text-neutral-400 hover:text-neutral-200 hover:bg-white/5 border-l-2 border-transparent"
                        }`}
                        onClick={() => navigateTo(panelType)}
                      >
                        {panelLabel(info, locale)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Settings at bottom */}
      <div className="border-t border-[#0f3460] px-4 py-2.5">
        <button
          className="flex items-center gap-2 text-neutral-500 hover:text-neutral-300 text-xs transition-colors w-full"
          onClick={() => router.push("/settings")}
        >
          <span>⚙️</span>
          <span>{en ? "Settings" : "設定"}</span>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add ap/services/web/src/hooks/use-workflow-status.ts ap/services/web/src/components/shell/WorkflowSidebar.tsx
git commit -m "feat: add WorkflowSidebar with 3-step workflow navigation"
```

---

### Task 6: Frontend — Create StepGate Component

**Files:**
- Create: `ap/services/web/src/components/shared/StepGate.tsx`

- [ ] **Step 1: Create StepGate component**

```tsx
// ap/services/web/src/components/shared/StepGate.tsx
"use client";
import { useRouter } from "next/navigation";
import { useLocaleStore } from "@/store/locale-store";

interface StepGateProps {
  requiredStep: number;
  requiredStepName: string;
  requiredStepNameEn: string;
  description: string;
  descriptionEn: string;
  targetRoute: string;
}

export function StepGate({
  requiredStep,
  requiredStepName,
  requiredStepNameEn,
  description,
  descriptionEn,
  targetRoute,
}: StepGateProps) {
  const router = useRouter();
  const en = useLocaleStore((s) => s.locale) === "en";

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
      <div className="text-5xl mb-4">🔒</div>
      <h2 className="text-xl font-semibold text-neutral-200 mb-2">
        {en
          ? `Step ${requiredStep}: ${requiredStepNameEn} Required`
          : `需要先完成第 ${requiredStep} 步：${requiredStepName}`}
      </h2>
      <p className="text-neutral-500 text-sm mb-6 max-w-md">
        {en ? descriptionEn : description}
      </p>
      <button
        className="bg-[#e94560] hover:bg-[#d63851] text-white px-6 py-2.5 rounded-lg text-sm font-medium transition-colors"
        onClick={() => router.push(targetRoute)}
      >
        {en
          ? `Go to ${requiredStepNameEn} →`
          : `前往${requiredStepName} →`}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ap/services/web/src/components/shared/StepGate.tsx
git commit -m "feat: add StepGate prerequisite component"
```

---

### Task 7: Frontend — Create GuideBanner Component

**Files:**
- Create: `ap/services/web/src/components/shared/GuideBanner.tsx`

- [ ] **Step 1: Create GuideBanner component**

```tsx
// ap/services/web/src/components/shared/GuideBanner.tsx
"use client";
import { useState, useEffect } from "react";
import { useLocaleStore } from "@/store/locale-store";

interface GuideBannerProps {
  guideKey: string;
  title: string;
  titleEn: string;
  message: string;
  messageEn: string;
}

const STORAGE_KEY = "civatas_dismissed_guides";

function getDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function dismiss(key: string) {
  const current = getDismissed();
  if (!current.includes(key)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...current, key]));
  }
}

export function dismissAllGuides() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(["__all__"]));
}

export function GuideBanner({
  guideKey,
  title,
  titleEn,
  message,
  messageEn,
}: GuideBannerProps) {
  const en = useLocaleStore((s) => s.locale) === "en";
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const dismissed = getDismissed();
    if (dismissed.includes("__all__") || dismissed.includes(guideKey)) {
      setVisible(false);
    } else {
      setVisible(true);
    }
  }, [guideKey]);

  if (!visible) return null;

  return (
    <div className="bg-[#e94560]/10 border border-[#e94560]/25 rounded-lg px-4 py-3 mb-4 flex items-start gap-3">
      <span className="text-lg mt-0.5">💡</span>
      <div className="flex-1 min-w-0">
        <div className="text-neutral-200 text-sm font-medium">
          {en ? titleEn : title}
        </div>
        <div className="text-neutral-400 text-xs mt-1 leading-relaxed">
          {en ? messageEn : message}
        </div>
      </div>
      <button
        className="text-neutral-500 hover:text-neutral-300 text-lg shrink-0"
        onClick={() => {
          dismiss(guideKey);
          setVisible(false);
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ap/services/web/src/components/shared/GuideBanner.tsx
git commit -m "feat: add dismissible GuideBanner component"
```

---

### Task 8: Frontend — Create OnboardingWizard

**Files:**
- Create: `ap/services/web/src/components/onboarding/OnboardingWizard.tsx`

- [ ] **Step 1: Create OnboardingWizard component**

This is a full-screen wizard with 4 steps. It's shown when `onboarding_completed` is false in settings.

```tsx
// ap/services/web/src/components/onboarding/OnboardingWizard.tsx
"use client";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useLocaleStore } from "@/store/locale-store";
import { useShellStore } from "@/store/shell-store";
import { useQueryClient } from "@tanstack/react-query";

// Vendor type presets
const VENDOR_PRESETS: Record<string, { label: string; defaultModel: string; keyUrl: string }> = {
  openai:   { label: "OpenAI",   defaultModel: "gpt-4o",           keyUrl: "https://platform.openai.com/api-keys" },
  gemini:   { label: "Gemini",   defaultModel: "gemini-2.5-flash", keyUrl: "https://aistudio.google.com/apikey" },
  xai:      { label: "xAI",      defaultModel: "grok-3-mini",      keyUrl: "https://console.x.ai/" },
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-chat",    keyUrl: "https://platform.deepseek.com/api_keys" },
  moonshot: { label: "Moonshot", defaultModel: "moonshot-v1-auto",  keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  ollama:   { label: "Ollama",   defaultModel: "llama3",           keyUrl: "" },
};

interface VendorConfig {
  id: string;
  vendor_type: string;
  display_name: string;
  api_key: string;
  model: string;
  base_url: string;
}

interface TemplateInfo {
  id: string;
  name: string;
  region?: string;
  region_code?: string;
  country?: string;
  scope?: string;
  cycle?: string;
  candidate_count?: number;
}

export function OnboardingWizard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const en = useLocaleStore((s) => s.locale) === "en";
  const [step, setStep] = useState(1);

  // Step 1: API Keys
  const [vendors, setVendors] = useState<VendorConfig[]>([
    { id: "openai-1", vendor_type: "openai", display_name: "OpenAI", api_key: "", model: "gpt-4o", base_url: "" },
  ]);
  const [serperKey, setSerperKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [testResults, setTestResults] = useState<Record<string, "ok" | "fail" | "testing">>({});

  // Step 2: Project
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [projectName, setProjectName] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [createdWsId, setCreatedWsId] = useState("");

  // Step 3: Persona
  const [targetCount, setTargetCount] = useState(100);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [personaDone, setPersonaDone] = useState(false);

  // Add vendor
  const addVendor = () => {
    const usedTypes = vendors.map((v) => v.vendor_type);
    const availableType = Object.keys(VENDOR_PRESETS).find((t) => !usedTypes.includes(t)) || "openai";
    const preset = VENDOR_PRESETS[availableType];
    setVendors([
      ...vendors,
      {
        id: `${availableType}-${Date.now()}`,
        vendor_type: availableType,
        display_name: preset.label,
        api_key: "",
        model: preset.defaultModel,
        base_url: "",
      },
    ]);
  };

  const updateVendor = (idx: number, updates: Partial<VendorConfig>) => {
    setVendors((prev) => prev.map((v, i) => {
      if (i !== idx) return v;
      const updated = { ...v, ...updates };
      // Auto-fill defaults when vendor_type changes
      if (updates.vendor_type && updates.vendor_type !== v.vendor_type) {
        const preset = VENDOR_PRESETS[updates.vendor_type];
        updated.display_name = preset.label;
        updated.model = preset.defaultModel;
        updated.id = `${updates.vendor_type}-${Date.now()}`;
      }
      return updated;
    }));
  };

  const removeVendor = (idx: number) => {
    if (vendors.length <= 1) return;
    setVendors((prev) => prev.filter((_, i) => i !== idx));
  };

  // Test connection
  const testVendor = async (idx: number) => {
    const v = vendors[idx];
    setTestResults((prev) => ({ ...prev, [v.id]: "testing" }));
    try {
      // Save settings first, then check health
      await saveKeys(false);
      await apiFetch("/health");
      setTestResults((prev) => ({ ...prev, [v.id]: "ok" }));
    } catch {
      setTestResults((prev) => ({ ...prev, [v.id]: "fail" }));
    }
  };

  // Save API keys
  const saveKeys = async (advance = true) => {
    const validVendors = vendors.filter((v) => v.api_key.trim());
    if (validVendors.length === 0) {
      setKeyError(en ? "At least one LLM API key is required" : "至少需要一組 LLM API Key");
      return false;
    }
    if (!serperKey.trim()) {
      setKeyError(en ? "Serper API key is required for news search" : "Serper API Key 為必填（用於新聞搜尋）");
      return false;
    }
    setKeyError("");
    try {
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          llm_mode: "multi",
          llm_vendors: validVendors.map((v) => ({
            id: v.id,
            display_name: v.display_name,
            vendor_type: v.vendor_type,
            api_key: v.api_key,
            model: v.model,
            base_url: v.base_url,
          })),
          active_vendors: validVendors.map((v) => v.id),
          vendor_ratio: validVendors.map(() => "1").join(":"),
          serper_api_key: serperKey,
        }),
      });
      if (advance) {
        loadTemplates();
        setStep(2);
      }
      return true;
    } catch (e: any) {
      setKeyError(e.message || "Failed to save");
      return false;
    }
  };

  // Load templates
  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const data = await apiFetch("/api/templates");
      setTemplates(data);
      if (data.length > 0) setSelectedTemplate(data[0].id);
    } catch { /* ignore */ }
    setLoadingTemplates(false);
  };

  // Create project
  const createProject = async () => {
    if (!projectName.trim()) return;
    if (!selectedTemplate) return;
    try {
      const ws = await apiFetch("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: projectName, purpose: "election" }),
      });
      const wsId = ws.id;
      setCreatedWsId(wsId);

      // Apply template
      await apiFetch(`/api/workspaces/${wsId}/apply-template`, {
        method: "POST",
        body: JSON.stringify({ template_id: selectedTemplate }),
      });

      // Cache workspace
      useShellStore.getState().setActiveWorkspace(wsId, projectName);

      setStep(3);
    } catch (e: any) {
      setKeyError(e.message || "Failed to create project");
    }
  };

  // Generate personas
  const generatePersonas = useCallback(async () => {
    if (!createdWsId) return;
    setGenerating(true);
    setProgress({ done: 0, total: targetCount });

    try {
      // Synthesize first
      await apiFetch(`/api/workspaces/${createdWsId}/synthesize`, {
        method: "POST",
        body: JSON.stringify({ target_count: targetCount }),
      });

      // Generate personas
      await apiFetch(`/api/workspaces/${createdWsId}/persona`, {
        method: "POST",
        body: JSON.stringify({ strategy: "template", concurrency: 5 }),
      });

      // Poll progress
      const poll = async () => {
        try {
          const p = await apiFetch(`/api/workspaces/${createdWsId}/persona-progress`);
          setProgress({ done: p.done ?? 0, total: p.total ?? targetCount });
          if (p.done >= p.total || p.status === "done" || p.status === "completed") {
            setPersonaDone(true);
            setGenerating(false);
            return;
          }
        } catch { /* continue polling */ }
        if (!personaDone) setTimeout(poll, 2000);
      };
      setTimeout(poll, 2000);
    } catch (e: any) {
      setKeyError(e.message || "Failed to generate");
      setGenerating(false);
    }
  }, [createdWsId, targetCount, personaDone]);

  // Finish onboarding
  const finishOnboarding = async () => {
    await apiFetch("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ onboarding_completed: true }),
    });
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    router.push(`/workspaces/${createdWsId}/population-setup`);
  };

  // Group templates
  const nationalTemplates = templates.filter((t) => t.scope === "national");
  const stateTemplates = templates.filter((t) => t.scope === "state");

  return (
    <div className="fixed inset-0 bg-[#0a0a1a] z-50 flex flex-col items-center justify-center overflow-y-auto">
      <div className="w-full max-w-2xl px-6 py-12">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#e94560] tracking-wider">CIVATAS</h1>
          <p className="text-neutral-500 text-sm mt-1">
            {en ? "Social Simulation Agent Platform" : "社會模擬代理人平台"}
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-0 mb-10">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                  s <= step
                    ? "bg-[#e94560] text-white"
                    : "bg-neutral-800 text-neutral-500"
                }`}
              >
                {s < step ? "✓" : s}
              </div>
              {s < 4 && (
                <div
                  className={`w-16 h-0.5 ${
                    s < step ? "bg-[#e94560]" : "bg-neutral-800"
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: API Keys */}
        {step === 1 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              {en ? "Configure API Keys" : "設定 API Key"}
            </h2>
            <p className="text-neutral-500 text-sm mb-6">
              {en
                ? "Add at least one LLM provider and your Serper key for news search."
                : "新增至少一個 LLM 供應商，以及用於新聞搜尋的 Serper Key。"}
            </p>

            {/* Vendor cards */}
            {vendors.map((v, idx) => (
              <div
                key={v.id}
                className="bg-[#16213e] rounded-lg p-4 mb-3 border border-[#0f3460]"
              >
                <div className="flex items-center gap-3 mb-3">
                  <select
                    className="bg-[#0f3460] text-neutral-300 text-sm rounded px-2 py-1.5 border-none outline-none"
                    value={v.vendor_type}
                    onChange={(e) => updateVendor(idx, { vendor_type: e.target.value })}
                  >
                    {Object.entries(VENDOR_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>{preset.label}</option>
                    ))}
                  </select>
                  <input
                    className="flex-1 bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none"
                    placeholder="Model"
                    value={v.model}
                    onChange={(e) => updateVendor(idx, { model: e.target.value })}
                  />
                  {vendors.length > 1 && (
                    <button
                      className="text-neutral-600 hover:text-red-400 text-sm"
                      onClick={() => removeVendor(idx)}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none font-mono"
                    type="password"
                    placeholder="API Key"
                    value={v.api_key}
                    onChange={(e) => updateVendor(idx, { api_key: e.target.value })}
                  />
                  <button
                    className="text-xs bg-[#0f3460] text-neutral-400 hover:text-white px-3 py-1.5 rounded transition-colors"
                    onClick={() => testVendor(idx)}
                  >
                    {testResults[v.id] === "testing"
                      ? "..."
                      : testResults[v.id] === "ok"
                      ? "✓ OK"
                      : testResults[v.id] === "fail"
                      ? "✕ Fail"
                      : en ? "Test" : "測試"}
                  </button>
                </div>
                {VENDOR_PRESETS[v.vendor_type]?.keyUrl && (
                  <a
                    href={VENDOR_PRESETS[v.vendor_type].keyUrl}
                    target="_blank"
                    rel="noopener"
                    className="text-[10px] text-blue-400 hover:underline mt-2 inline-block"
                  >
                    {en ? `Get ${VENDOR_PRESETS[v.vendor_type].label} API Key →` : `申請 ${VENDOR_PRESETS[v.vendor_type].label} API Key →`}
                  </a>
                )}
              </div>
            ))}

            <button
              className="text-sm text-green-400 hover:text-green-300 mb-6"
              onClick={addVendor}
            >
              + {en ? "Add another vendor" : "新增供應商"}
            </button>

            {/* Serper key */}
            <div className="bg-[#16213e] rounded-lg p-4 mb-4 border border-[#0f3460]">
              <div className="text-neutral-400 text-xs mb-2">
                Serper API Key <span className="text-[#e94560]">*</span>
              </div>
              <input
                className="w-full bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none font-mono"
                type="password"
                placeholder="Serper API Key"
                value={serperKey}
                onChange={(e) => setSerperKey(e.target.value)}
              />
              <a
                href="https://serper.dev/api-key"
                target="_blank"
                rel="noopener"
                className="text-[10px] text-blue-400 hover:underline mt-2 inline-block"
              >
                {en ? "Get Serper API Key (Google Search) →" : "申請 Serper API Key（Google 搜尋）→"}
              </a>
            </div>

            {keyError && (
              <div className="text-red-400 text-sm mb-4">{keyError}</div>
            )}

            <button
              className="w-full bg-[#e94560] hover:bg-[#d63851] text-white py-2.5 rounded-lg font-medium transition-colors"
              onClick={() => saveKeys()}
            >
              {en ? "Next: Create Project →" : "下一步：建立專案 →"}
            </button>
          </div>
        )}

        {/* Step 2: Create Project */}
        {step === 2 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              {en ? "Create Your First Project" : "建立第一個專案"}
            </h2>
            <p className="text-neutral-500 text-sm mb-6">
              {en
                ? "Name your project and select an election template."
                : "為專案命名並選擇選舉模板。"}
            </p>

            <div className="bg-[#16213e] rounded-lg p-4 mb-4 border border-[#0f3460]">
              <div className="text-neutral-400 text-xs mb-2">
                {en ? "Project Name" : "專案名稱"}
              </div>
              <input
                className="w-full bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-2 border-none outline-none"
                placeholder={en ? "e.g. 2024 Presidential Election" : "例：2024 總統大選"}
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />
            </div>

            <div className="text-neutral-400 text-xs mb-2">
              {en ? "Select Template" : "選擇模板"}
            </div>

            {loadingTemplates ? (
              <div className="text-neutral-500 text-sm py-8 text-center">Loading...</div>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-1.5 mb-6">
                {nationalTemplates.length > 0 && (
                  <>
                    <div className="text-neutral-600 text-[10px] uppercase tracking-wider py-1">
                      {en ? "National" : "全國"}
                    </div>
                    {nationalTemplates.map((t) => (
                      <button
                        key={t.id}
                        className={`w-full text-left rounded-lg p-3 transition-colors ${
                          selectedTemplate === t.id
                            ? "bg-[#e94560]/15 border border-[#e94560]"
                            : "bg-[#16213e] border border-[#0f3460] hover:border-neutral-600"
                        }`}
                        onClick={() => setSelectedTemplate(t.id)}
                      >
                        <div className={`text-sm font-medium ${selectedTemplate === t.id ? "text-[#e94560]" : "text-neutral-300"}`}>
                          {t.name}
                        </div>
                        <div className="text-neutral-500 text-[11px] mt-0.5">
                          {t.cycle && `${t.cycle} · `}{t.candidate_count ? `${t.candidate_count} candidates` : ""}
                        </div>
                      </button>
                    ))}
                  </>
                )}
                {stateTemplates.length > 0 && (
                  <>
                    <div className="text-neutral-600 text-[10px] uppercase tracking-wider py-1 mt-3">
                      {en ? "By State" : "各州"}
                    </div>
                    {stateTemplates.map((t) => (
                      <button
                        key={t.id}
                        className={`w-full text-left rounded-lg p-3 transition-colors ${
                          selectedTemplate === t.id
                            ? "bg-[#e94560]/15 border border-[#e94560]"
                            : "bg-[#16213e] border border-[#0f3460] hover:border-neutral-600"
                        }`}
                        onClick={() => setSelectedTemplate(t.id)}
                      >
                        <div className={`text-sm font-medium ${selectedTemplate === t.id ? "text-[#e94560]" : "text-neutral-300"}`}>
                          {t.name}
                        </div>
                        <div className="text-neutral-500 text-[11px] mt-0.5">
                          {t.region_code ?? t.region ?? ""}
                        </div>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}

            <button
              className="w-full bg-[#e94560] hover:bg-[#d63851] text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-40"
              disabled={!projectName.trim() || !selectedTemplate}
              onClick={createProject}
            >
              {en ? "Next: Generate Personas →" : "下一步：生成 Persona →"}
            </button>
          </div>
        )}

        {/* Step 3: Generate Personas */}
        {step === 3 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              {en ? "Generate Personas" : "生成 Persona"}
            </h2>
            <p className="text-neutral-500 text-sm mb-6">
              {en
                ? "Create synthetic agents based on your template's demographic data."
                : "根據模板的人口統計資料，建立合成代理人。"}
            </p>

            <div className="bg-[#16213e] rounded-lg p-4 mb-4 border border-[#0f3460]">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-neutral-400">{en ? "Target count" : "目標數量"}</span>
                <input
                  className="w-20 bg-[#0f3460] text-[#e94560] text-sm text-right rounded px-2 py-0.5 border-none outline-none font-medium"
                  type="number"
                  min={10}
                  max={1000}
                  value={targetCount}
                  onChange={(e) => setTargetCount(Number(e.target.value) || 100)}
                  disabled={generating || personaDone}
                />
              </div>
            </div>

            {progress && (
              <div className="mb-4">
                <div className="bg-neutral-800 rounded-full h-2 overflow-hidden mb-1">
                  <div
                    className="bg-[#e94560] h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }}
                  />
                </div>
                <div className="text-neutral-500 text-xs">
                  {progress.done}/{progress.total} {en ? "personas generated" : "persona 已生成"}
                  {generating && " ..."}
                </div>
              </div>
            )}

            {keyError && (
              <div className="text-red-400 text-sm mb-4">{keyError}</div>
            )}

            {!personaDone ? (
              <button
                className="w-full bg-green-600 hover:bg-green-700 text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-40"
                disabled={generating}
                onClick={generatePersonas}
              >
                {generating
                  ? (en ? "Generating..." : "生成中...")
                  : (en ? "Generate Personas" : "生成 Persona")}
              </button>
            ) : (
              <button
                className="w-full bg-[#e94560] hover:bg-[#d63851] text-white py-2.5 rounded-lg font-medium transition-colors"
                onClick={() => setStep(4)}
              >
                {en ? "Next →" : "下一步 →"}
              </button>
            )}
          </div>
        )}

        {/* Step 4: Ready */}
        {step === 4 && (
          <div className="text-center">
            <div className="text-5xl mb-4">🎉</div>
            <h2 className="text-xl font-semibold text-white mb-2">
              {en ? "You're All Set!" : "設定完成！"}
            </h2>
            <p className="text-neutral-500 text-sm mb-8">
              {en
                ? "Your project is ready. Here's what to do next:"
                : "專案已準備就緒，以下是接下來的步驟："}
            </p>

            <div className="space-y-3 text-left max-w-md mx-auto mb-8">
              <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                <div className="text-green-400 text-sm font-medium">
                  ✓ {progress?.done ?? targetCount} {en ? "Personas Generated" : "Persona 已生成"}
                </div>
              </div>
              <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                <div className="text-neutral-200 text-sm">
                  {en ? "Next:" : "下一步："}{" "}
                  <strong className="text-[#e94560]">{en ? "Evolution" : "演化"}</strong>
                </div>
                <div className="text-neutral-500 text-xs mt-1">
                  {en
                    ? "Feed news to your agents and let them form opinions over simulated days."
                    : "餵入新聞讓代理人在模擬時間中形成觀點。"}
                </div>
              </div>
              <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                <div className="text-neutral-200 text-sm">
                  {en ? "Then:" : "然後："}{" "}
                  <strong className="text-neutral-400">{en ? "Prediction" : "預測"}</strong>
                </div>
                <div className="text-neutral-500 text-xs mt-1">
                  {en
                    ? "Run poll predictions and analyze election outcomes."
                    : "執行民調預測並分析選舉結果。"}
                </div>
              </div>
            </div>

            <button
              className="bg-[#e94560] hover:bg-[#d63851] text-white px-8 py-2.5 rounded-lg font-medium transition-colors"
              onClick={finishOnboarding}
            >
              {en ? "Enter Workspace →" : "進入工作區 →"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ap/services/web/src/components/onboarding/OnboardingWizard.tsx
git commit -m "feat: add full-screen OnboardingWizard for first-run setup"
```

---

### Task 9: Frontend — Simplify DesktopShell Layout

**Files:**
- Modify: `ap/services/web/src/components/shell/DesktopShell.tsx`
- Modify: `ap/services/web/src/components/AppShell.tsx`

- [ ] **Step 1: Rewrite DesktopShell.tsx**

Replace the entire component to use WorkflowSidebar instead of NavTree, remove PanelTabBar, InspectorPanel, CommandPalette, MenuBar, Toolbar, and the split-panel layout system. Keep StatusBar.

```tsx
// ap/services/web/src/components/shell/DesktopShell.tsx
"use client";
import { useState, useEffect } from "react";
import { WorkflowSidebar } from "./WorkflowSidebar";
import { StatusBar } from "./StatusBar";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { OnboardingWizard } from "../onboarding/OnboardingWizard";
import { useSettings } from "@/hooks/use-settings";
import { Toaster } from "sonner";

export function DesktopShell({ children }: { children: React.ReactNode }) {
  const { data: settings, isLoading } = useSettings();
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [resizing, setResizing] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  // Sidebar resize handler
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      setSidebarWidth(Math.max(180, Math.min(360, e.clientX)));
    };
    const onUp = () => setResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);

  if (!mounted || isLoading) {
    return (
      <div className="h-screen bg-[#0a0a1a] flex items-center justify-center">
        <div className="text-neutral-500 text-sm">Loading...</div>
      </div>
    );
  }

  // Show onboarding if not completed
  if (settings && !settings.onboarding_completed) {
    return <OnboardingWizard />;
  }

  return (
    <div className="h-screen flex flex-col bg-[#1a1a2e] text-neutral-200 overflow-hidden">
      {/* Main area: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div style={{ width: sidebarWidth, minWidth: 180 }} className="shrink-0">
          <WorkflowSidebar />
        </div>
        {/* Resize handle */}
        <div
          className="w-[3px] cursor-col-resize hover:bg-[#e94560]/30 transition-colors shrink-0"
          onMouseDown={() => setResizing(true)}
        />
        {/* Content */}
        <main className="flex-1 overflow-y-auto bg-[#1a1a2e] p-6">
          {children}
        </main>
      </div>
      {/* Status bar */}
      <StatusBar />
      {/* Dialogs */}
      <CreateWorkspaceDialog />
      <Toaster position="bottom-right" theme="dark" />
    </div>
  );
}
```

- [ ] **Step 2: Update AppShell to remove playback path**

In `ap/services/web/src/components/AppShell.tsx`, the playback path check can be removed since we deleted playback routes. Simplify to:

```tsx
"use client";
import { DesktopShell } from "./shell/DesktopShell";

export function AppShell({ children }: { children: React.ReactNode }) {
  return <DesktopShell>{children}</DesktopShell>;
}
```

- [ ] **Step 3: Commit**

```bash
git add ap/services/web/src/components/shell/DesktopShell.tsx ap/services/web/src/components/AppShell.tsx
git commit -m "feat: simplify DesktopShell to sidebar + content layout with onboarding gate"
```

---

### Task 10: Frontend — Simplify SettingsPanel

**Files:**
- Modify: `ap/services/web/src/components/panels/SettingsPanel.tsx`

- [ ] **Step 1: Simplify SettingsPanel to 2 tabs**

Rewrite `SettingsPanel.tsx` keeping only the LLM vendor configuration + Serper key (tab 1) and appearance (tab 2). Remove the recording management tab and the search engine tab (merge Serper into tab 1). Add a "Re-run Onboarding" button.

Key changes:
1. Remove Tab 3 (recording management) and Tab 4 (if exists)
2. Move Serper API Key field from the search tab into the LLM tab (at the bottom)
3. Add a "Re-run Onboarding" button at the bottom of tab 1 that sets `onboarding_completed: false` and reloads the page
4. Keep the existing vendor CRUD UI (add/edit/delete vendors, mode selector, etc.)
5. Remove Tavily API Key field (not needed for core workflow)
6. Tab 2 keeps dark/light mode toggle and language selector

The exact edits depend on the current file structure — the key structural change is reducing to 2 tabs and adding the onboarding reset button:

```tsx
// Add at bottom of the API Keys tab:
<div className="border-t border-neutral-700 mt-6 pt-4">
  <button
    className="text-sm text-neutral-500 hover:text-[#e94560] transition-colors"
    onClick={async () => {
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ onboarding_completed: false }),
      });
      window.location.reload();
    }}
  >
    {en ? "Re-run Onboarding Wizard" : "重新執行設定精靈"}
  </button>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add ap/services/web/src/components/panels/SettingsPanel.tsx
git commit -m "feat: simplify SettingsPanel to 2 tabs with onboarding reset"
```

---

### Task 11: Frontend — Add StepGates to Evolution and Prediction Panels

**Files:**
- Modify: `ap/services/web/src/components/panels/EvolutionPanel.tsx`
- Modify: `ap/services/web/src/components/panels/EvolutionDashboardPanel.tsx`
- Modify: `ap/services/web/src/components/panels/AgentExplorerPanel.tsx`
- Modify: `ap/services/web/src/components/panels/PredictionPanel.tsx`
- Modify: `ap/services/web/src/components/panels/PredictionEvolutionDashboardPanel.tsx`
- Modify: `ap/services/web/src/components/panels/PredictionAnalysisPanel.tsx`

- [ ] **Step 1: Add gate to Evolution panels**

At the top of each Evolution panel component's render function, add a prerequisite check. The pattern is the same for all three Evolution panels (`EvolutionPanel.tsx`, `EvolutionDashboardPanel.tsx`, `AgentExplorerPanel.tsx`):

```tsx
import { StepGate } from "@/components/shared/StepGate";
import { useWorkflowStatus } from "@/hooks/use-workflow-status";
import { useShellStore } from "@/store/shell-store";

// Inside the component, before existing return:
const wsId = useShellStore((s) => s.activeWorkspaceId);
const status = useWorkflowStatus(wsId);

if (status.evolution === "locked") {
  return (
    <StepGate
      requiredStep={1}
      requiredStepName="人設生成"
      requiredStepNameEn="Persona"
      description="請先在第 1 步生成 Persona，才能進行演化。"
      descriptionEn="Generate personas in Step 1 before running evolution."
      targetRoute={wsId ? `/workspaces/${wsId}/population-setup` : "/workspaces"}
    />
  );
}
```

- [ ] **Step 2: Add gate to Prediction panels**

Same pattern for `PredictionPanel.tsx`, `PredictionEvolutionDashboardPanel.tsx`, `PredictionAnalysisPanel.tsx`:

```tsx
import { StepGate } from "@/components/shared/StepGate";
import { useWorkflowStatus } from "@/hooks/use-workflow-status";
import { useShellStore } from "@/store/shell-store";

// Inside the component, before existing return:
const wsId = useShellStore((s) => s.activeWorkspaceId);
const status = useWorkflowStatus(wsId);

if (status.prediction === "locked") {
  return (
    <StepGate
      requiredStep={2}
      requiredStepName="演化"
      requiredStepNameEn="Evolution"
      description="請先在第 2 步執行演化，讓代理人形成觀點後才能進行預測。"
      descriptionEn="Run evolution in Step 2 to shape agent opinions before making predictions."
      targetRoute={wsId ? `/workspaces/${wsId}/evolution` : "/workspaces"}
    />
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add ap/services/web/src/components/panels/EvolutionPanel.tsx \
       ap/services/web/src/components/panels/EvolutionDashboardPanel.tsx \
       ap/services/web/src/components/panels/AgentExplorerPanel.tsx \
       ap/services/web/src/components/panels/PredictionPanel.tsx \
       ap/services/web/src/components/panels/PredictionEvolutionDashboardPanel.tsx \
       ap/services/web/src/components/panels/PredictionAnalysisPanel.tsx
git commit -m "feat: add prerequisite StepGates to Evolution and Prediction panels"
```

---

### Task 12: Frontend — Add GuideBanners to Panels

**Files:**
- Modify: `ap/services/web/src/components/panels/PopulationSetupPanel.tsx`
- Modify: `ap/services/web/src/components/panels/PersonaPanel.tsx`
- Modify: `ap/services/web/src/components/panels/EvolutionPanel.tsx`
- Modify: `ap/services/web/src/components/panels/PredictionPanel.tsx`

- [ ] **Step 1: Add GuideBanner to key panels**

Add a `<GuideBanner>` at the top of each panel's JSX return (after any gate checks, before existing content):

**PopulationSetupPanel.tsx:**
```tsx
import { GuideBanner } from "@/components/shared/GuideBanner";

// At top of returned JSX:
<GuideBanner
  guideKey="guide_population_setup"
  title="開始設定"
  titleEn="Getting Started"
  message="您的模板已預先設定好人口統計參數。檢視設定，調整後按「生成 Persona」建立代理人群體。"
  messageEn="Your template has pre-configured demographics. Review the settings, adjust if needed, then click Generate Personas to create your agent population."
/>
```

**PersonaPanel.tsx:**
```tsx
<GuideBanner
  guideKey="guide_persona"
  title="探索代理人"
  titleEn="Explore Agents"
  message="瀏覽已生成的代理人。每個代理人有人口特徵、人格特質和政治傾向。準備好後前往第 2 步：演化。"
  messageEn="Browse your generated agents. Each has demographics, personality traits, and political leaning. When ready, proceed to Step 2: Evolution."
/>
```

**EvolutionPanel.tsx** (after the StepGate check):
```tsx
<GuideBanner
  guideKey="guide_evolution"
  title="設定新聞來源"
  titleEn="Configure News Sources"
  message="新增 RSS 來源或手動注入新聞。代理人會在演化過程中閱讀這些新聞並形成觀點。"
  messageEn="Add RSS feeds or manually inject news articles. Agents will consume these during evolution to form opinions."
/>
```

**PredictionPanel.tsx** (after the StepGate check):
```tsx
<GuideBanner
  guideKey="guide_prediction"
  title="設定預測情境"
  titleEn="Setup Prediction"
  message="定義民調問題、選擇候選人，並設定預測參數。系統會讓演化後的代理人模擬投票行為。"
  messageEn="Define a poll question, select candidates, and configure the prediction scenario. Evolved agents will simulate voting behavior."
/>
```

- [ ] **Step 2: Commit**

```bash
git add ap/services/web/src/components/panels/PopulationSetupPanel.tsx \
       ap/services/web/src/components/panels/PersonaPanel.tsx \
       ap/services/web/src/components/panels/EvolutionPanel.tsx \
       ap/services/web/src/components/panels/PredictionPanel.tsx
git commit -m "feat: add contextual GuideBanners to key workflow panels"
```

---

### Task 13: Frontend — Remove Unused Panels and Routes

**Files:**
- Delete: multiple panel components and route directories
- Modify: `ap/services/web/src/components/shell/CreateWorkspaceDialog.tsx` (minor cleanup)

- [ ] **Step 1: Delete unused panel components**

```bash
cd /Volumes/AI02/Civatas-USA/ap/services/web/src

# Panels to remove
rm -f components/panels/CalibrationPanel.tsx
rm -f components/panels/SandboxPanel.tsx
rm -f components/panels/PrimaryPanel.tsx
rm -f components/panels/SimulationPanel.tsx
rm -f components/panels/AnalyticsPanel.tsx
rm -f components/panels/HistoricalEvolutionPanel.tsx
rm -f components/panels/NewsCenterPanel.tsx
rm -f components/panels/SatisfactionSurveyPanel.tsx
rm -f components/panels/StatModulesPanel.tsx
rm -f components/panels/LeaningPanel.tsx
rm -f components/panels/DataSourcesPanel.tsx

# Shell components to remove
rm -f components/shell/PanelTabBar.tsx
rm -f components/shell/InspectorPanel.tsx
rm -f components/shell/CommandPalette.tsx
rm -f components/shell/MenuBar.tsx
rm -f components/shell/Toolbar.tsx
rm -f components/shell/LayoutRenderer.tsx
rm -f components/shell/ResizeHandle.tsx
rm -f components/shell/MainWorkspace.tsx

# Other components to remove
rm -f components/PlaybackViewer.tsx
rm -f components/RecordingManager.tsx
rm -f components/RecordingButton.tsx
rm -f components/AgentInspector.tsx
rm -f components/GuidePanel.tsx
```

- [ ] **Step 2: Delete unused route directories**

```bash
cd /Volumes/AI02/Civatas-USA/ap/services/web/src/app

# Remove login route (already done in Task 3, verify)
rm -rf login

# Remove playback route
rm -rf playback

# Remove unused workspace panel routes if they exist as directories
# (Most panel routes are handled dynamically via [panel] catch-all)
```

Check if there's a `[panel]/page.tsx` or similar dynamic route handler — if so, update it to only handle the panels that remain in `WORKSPACE_PANEL_TYPES`.

- [ ] **Step 3: Fix imports — search for references to deleted components**

```bash
grep -rn "CalibrationPanel\|SandboxPanel\|PrimaryPanel\|SimulationPanel\|AnalyticsPanel\|HistoricalEvolutionPanel\|NewsCenterPanel\|SatisfactionSurveyPanel\|StatModulesPanel\|LeaningPanel\|DataSourcesPanel\|PanelTabBar\|InspectorPanel\|CommandPalette\|MenuBar\|Toolbar\|LayoutRenderer\|MainWorkspace\|PlaybackViewer\|RecordingManager\|RecordingButton\|AgentInspector\|GuidePanel" ap/services/web/src/ --include="*.tsx" --include="*.ts"
```

Remove all imports and references found. Common locations:
- Dynamic panel renderers that map panel type → component
- Any lazy imports or dynamic imports of these components
- The old NavTree.tsx (already replaced by WorkflowSidebar)

- [ ] **Step 4: Commit**

```bash
git add -A ap/services/web/src/
git commit -m "feat: remove unused panels, shell components, and routes"
```

---

### Task 14: Frontend — Create Evolution Runner Route

**Files:**
- Create: `ap/services/web/src/app/workspaces/[id]/evolution-runner/page.tsx`

- [ ] **Step 1: Create evolution-runner page**

The sidebar has an "evolution-runner" sub-item that maps to the Runner tab of EvolutionPanel. Create a page that renders the EvolutionPanel with the Runner tab active:

```tsx
// ap/services/web/src/app/workspaces/[id]/evolution-runner/page.tsx
import { EvolutionPanel } from "@/components/panels/EvolutionPanel";

export default function EvolutionRunnerPage() {
  return <EvolutionPanel defaultTab="runner" />;
}
```

If `EvolutionPanel` doesn't accept a `defaultTab` prop, add one — check the component and add a prop that sets the initial active tab to "runner" (the tab that starts the evolution job).

- [ ] **Step 2: Commit**

```bash
git add ap/services/web/src/app/workspaces/[id]/evolution-runner/
git commit -m "feat: add evolution-runner route for Run Evolution sidebar item"
```

---

### Task 15: Frontend — Update shell-store (Remove Unused State)

**Files:**
- Modify: `ap/services/web/src/store/shell-store.ts`

- [ ] **Step 1: Simplify shell-store**

Remove state and actions related to the multi-tab/split-panel system that is no longer used:

1. Remove `openPanels`, `activePanelId`, `layout` state fields
2. Remove `openPanel`, `closePanel`, `closeOtherPanels`, `setActivePanel`, `setActivePanelByRoute`, `splitPanel`, `unsplitPanel`, `resetLayout` actions
3. Remove `inspectorOpen`, `inspectorAgents`, `inspectorCandidateNames`, `toggleInspector`, `setInspectorAgents` (inspector removed)
4. Remove `commandPaletteOpen`, `toggleCommandPalette` (command palette removed)
5. Keep: `activeWorkspaceId`, `activeWorkspaceName`, `showCreateDialog`, `activeJobs`, `llmStatus`, `workspaceNames`
6. Keep: `setActiveWorkspace`, `addJob`, `updateJob`, `removeJob`, `setLlmStatus`, `cacheWorkspaceName`

Add a `setActiveWorkspace(id, name)` action if not already present (consolidating the separate setters).

- [ ] **Step 2: Fix all references to removed state/actions**

```bash
grep -rn "openPanel\|closePanel\|setActivePanel\|splitPanel\|inspectorOpen\|toggleInspector\|commandPaletteOpen\|toggleCommandPalette\|setActivePanelByRoute\|activePanelId\|openPanels" ap/services/web/src/ --include="*.ts" --include="*.tsx"
```

Remove or replace all references found. Most should have been cleaned up by removing the old shell components, but check panel components and hooks.

- [ ] **Step 3: Commit**

```bash
git add ap/services/web/src/store/shell-store.ts
git add -A ap/services/web/src/
git commit -m "feat: simplify shell-store — remove multi-tab and split-panel state"
```

---

### Task 16: Frontend — Update StatusBar

**Files:**
- Modify: `ap/services/web/src/components/shell/StatusBar.tsx`

- [ ] **Step 1: Simplify StatusBar**

Remove references to the old shell-store fields (`activeWorkspaceName` may still exist — keep that one). Update to use simplified store. Keep: locale toggle, LLM status indicator, workspace name display, job progress display.

Remove any references to deleted store fields. The StatusBar should continue to work as-is since it only reads `activeWorkspaceName`, `activeJobs`, `llmStatus`, and `locale` — all of which are kept.

Verify no broken imports:

```bash
cd /Volumes/AI02/Civatas-USA
npx tsc --noEmit --project ap/services/web/tsconfig.json 2>&1 | head -50
```

Fix any type errors found.

- [ ] **Step 2: Commit**

```bash
git add ap/services/web/src/components/shell/StatusBar.tsx
git commit -m "fix: update StatusBar for simplified store"
```

---

### Task 17: Full Build Verification

- [ ] **Step 1: Run TypeScript type check**

```bash
cd /Volumes/AI02/Civatas-USA/ap/services/web
npx tsc --noEmit 2>&1 | head -100
```

Fix any type errors. Common issues:
- Imports of deleted modules
- References to removed store fields
- Missing props on refactored components

- [ ] **Step 2: Run Next.js build**

```bash
cd /Volumes/AI02/Civatas-USA/ap/services/web
npm run build 2>&1 | tail -30
```

Fix any build errors.

- [ ] **Step 3: Docker compose build**

```bash
cd /Volumes/AI02/Civatas-USA/ap
docker compose build web api
```

- [ ] **Step 4: Smoke test**

```bash
cd /Volumes/AI02/Civatas-USA/ap
docker compose up web api -d
sleep 5
# API should respond without auth
curl http://localhost:8000/health
curl http://localhost:8000/api/settings
# Web should serve without login redirect
curl -s http://localhost:3000 | head -20
```

- [ ] **Step 5: Commit any fixes**

```bash
git add -A ap/
git commit -m "fix: resolve build errors from UI redesign"
```
