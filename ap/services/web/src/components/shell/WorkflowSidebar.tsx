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

  const { data: workspacesRaw } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => apiFetch("/api/workspaces"),
  });
  const workspaces: any[] = Array.isArray(workspacesRaw) ? workspacesRaw : workspacesRaw?.workspaces ?? [];

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

  const getStepStatus = (step: typeof WORKFLOW_STEPS[number]): StepStatus => {
    if (step.key === "persona") return workflowStatus.persona;
    if (step.key === "evolution") return workflowStatus.evolution;
    if (step.key === "prediction") return workflowStatus.prediction;
    return "available";
  };

  const getStatusBadge = (status: StepStatus, step: typeof WORKFLOW_STEPS[number]) => {
    if (status === "completed") {
      const label =
        step.key === "persona" ? `✓ ${workflowStatus.personaCount}` : "✓";
      return <span className="ml-auto text-xs text-green-400">{label}</span>;
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
        <div className="text-[#e94560] font-bold text-lg tracking-wide">CIVATAS</div>
        <div className="text-neutral-500 text-[10px] mt-0.5">Open Source Edition</div>
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
              const store = useShellStore.getState();
              if (typeof store.setActiveWorkspace === "function") {
                store.setActiveWorkspace(id, ws?.name ?? id);
              } else {
                useShellStore.setState({
                  activeWorkspaceId: id,
                  activeWorkspaceName: ws?.name ?? id,
                });
              }
              // Navigate based on workspace state
              const hasPersonas = ws?.has_personas;
              router.push(`/workspaces/${id}/${hasPersonas ? "evolution-quickstart" : "population-setup"}`);
            } else {
              router.push("/workspaces");
            }
          }}
        >
          <option value="">{en ? "Select project..." : "選擇專案..."}</option>
          {(workspaces ?? []).map((ws: any) => (
            <option key={ws.id} value={ws.id}>{ws.name}</option>
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
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  status === "completed"
                    ? "bg-green-500 text-white"
                    : isLocked
                    ? "bg-neutral-700 text-neutral-500"
                    : "bg-[#e94560] text-white"
                }`}>
                  {status === "completed" ? "✓" : step.number}
                </div>
                <span className={`font-medium ${isLocked ? "text-neutral-600" : "text-neutral-200"}`}>
                  {stepLabel}
                </span>
                {step.key === "evolution" && workflowStatus.evolutionRunning && (
                  <span
                    className="ml-1 inline-block w-3.5 h-3.5 rounded-full border-2 border-[#e94560]/30 border-t-[#e94560]"
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                )}
                {getStatusBadge(status, step)}
              </button>

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
