"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import PanelErrorBoundary from "@/components/ui/PanelErrorBoundary";
import LoadingSpinner from "@/components/ui/LoadingSpinner";

export interface PanelContentProps {
  wsId: string;
}

export interface GlobalPanelContentProps {
  wsId?: string;
}

const Loading = () => <LoadingSpinner label="載入面板..." />;

const registry: Record<string, ComponentType<PanelContentProps>> = {
  "population-setup": dynamic(() => import("./PopulationSetupPanel"), { loading: Loading }),
  synthesis: dynamic(() => import("./SynthesisResultPanel"), { loading: Loading }),
  persona: dynamic(() => import("./PersonaPanel"), { loading: Loading }),
  evolution: dynamic(() => import("./EvolutionPanel"), { loading: Loading }),
  prediction: dynamic(() => import("./PredictionPanel"), { loading: Loading }),
  "prediction-analysis": dynamic(() => import("./PredictionAnalysisPanel"), { loading: Loading }),
  "evolution-dashboard": dynamic(() => import("./EvolutionDashboardPanel"), { loading: Loading }),
  "agent-explorer": dynamic(() => import("./AgentExplorerPanel"), { loading: Loading }),
  settings: dynamic(() => import("./SettingsPanel"), { loading: Loading }) as ComponentType<PanelContentProps>,
  "workspace-list": dynamic(() => import("./WorkspaceListPanel"), { loading: Loading }) as ComponentType<PanelContentProps>,
};

export function getPanelComponent(type: string): ComponentType<PanelContentProps> | null {
  return registry[type] || null;
}

export function PanelContentRenderer({
  type,
  wsId,
}: {
  type: string;
  wsId: string;
}) {
  const Comp = getPanelComponent(type);
  if (!Comp) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)", fontFamily: "var(--font-cjk)", fontSize: 12 }}>
        未知面板類型: {type}
      </div>
    );
  }
  return (
    <PanelErrorBoundary>
      <Comp wsId={wsId} />
    </PanelErrorBoundary>
  );
}
