/* ---- Panel Registry (Open-Source 3-Step Workflow) ---- */

export interface PanelTypeInfo {
  type: string;
  route: (wsId: string) => string;
  label: string;
  labelEn: string;
  icon: string;
  closeable?: boolean;
}

export const WORKSPACE_PANEL_TYPES: Record<string, PanelTypeInfo> = {
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
  "evolution-quickstart": {
    type: "evolution-quickstart",
    route: (id) => `/workspaces/${id}/evolution-quickstart`,
    label: "快速演化", labelEn: "Quick Start", icon: "⚡",
  },
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

export interface WorkflowStep {
  key: string;
  number: number;
  label: string;
  labelEn: string;
  icon: string;
  mainPanel: string;
  subItems: string[];
  requiresStep?: number;
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
    subItems: ["evolution-quickstart", "evolution-dashboard", "agent-explorer", "evolution"],
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

export function panelLabel(info: PanelTypeInfo, locale: string): string {
  return locale === "en" && info.labelEn ? info.labelEn : info.label;
}

export function routeToPanelType(pathname: string): { type: string; wsId?: string } | null {
  const wsMatch = pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)/);
  if (wsMatch) {
    const [, wsId, panel] = wsMatch;
    if (WORKSPACE_PANEL_TYPES[panel]) return { type: panel, wsId };
  }
  if (pathname === "/workspaces") return { type: "workspace-list" };
  if (pathname === "/settings") return { type: "settings" };
  return null;
}
