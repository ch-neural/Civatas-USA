import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface JobStatus {
  id: string;
  label: string;
  total: number;
  done: number;
  status: "running" | "paused" | "completed" | "error";
}

interface ShellState {
  // Workspace
  activeWorkspaceId: string | null;
  activeWorkspaceName: string | null;

  // Nav tree
  navTreeCollapsed: boolean;

  // Create dialog
  showCreateDialog: boolean;

  // Status
  activeJobs: JobStatus[];
  llmStatus: "connected" | "disconnected" | "checking";

  // Workspace name cache
  workspaceNames: Record<string, string>;

  // Actions
  setActiveWorkspace: (wsId: string | null, wsName?: string | null) => void;
  toggleNavTree: () => void;
  setShowCreateDialog: (v: boolean) => void;
  cacheWorkspaceName: (wsId: string, name: string) => void;

  // Jobs
  addJob: (job: JobStatus) => void;
  updateJob: (jobId: string, updates: Partial<JobStatus>) => void;
  removeJob: (jobId: string) => void;
  setLlmStatus: (status: "connected" | "disconnected" | "checking") => void;
}

export const useShellStore = create<ShellState>()(
  persist(
    (set, get) => ({
      activeWorkspaceId: null,
      activeWorkspaceName: null,
      navTreeCollapsed: false,
      showCreateDialog: false,
      activeJobs: [],
      llmStatus: "checking",
      workspaceNames: {},

      setActiveWorkspace: (wsId, wsName) => {
        const updates: Partial<ShellState> = { activeWorkspaceId: wsId, activeWorkspaceName: wsName || null };
        if (wsId && wsName) {
          updates.workspaceNames = { ...get().workspaceNames, [wsId]: wsName };
        }
        set(updates as any);
      },

      toggleNavTree: () => set((s) => ({ navTreeCollapsed: !s.navTreeCollapsed })),
      setShowCreateDialog: (v) => set({ showCreateDialog: v }),

      cacheWorkspaceName: (wsId, name) =>
        set((s) => ({ workspaceNames: { ...s.workspaceNames, [wsId]: name } })),

      addJob: (job) => set((s) => ({ activeJobs: [...s.activeJobs, job] })),
      updateJob: (jobId, updates) =>
        set((s) => ({
          activeJobs: s.activeJobs.map((j) => (j.id === jobId ? { ...j, ...updates } : j)),
        })),
      removeJob: (jobId) =>
        set((s) => ({ activeJobs: s.activeJobs.filter((j) => j.id !== jobId) })),
      setLlmStatus: (status) => set({ llmStatus: status }),
    }),
    {
      name: "civatas-shell",
      storage: {
        getItem: (name) => {
          if (typeof window === "undefined") return null;
          const str = sessionStorage.getItem(name);
          return str ? JSON.parse(str) : null;
        },
        setItem: (name, value) => {
          if (typeof window === "undefined") return;
          sessionStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: (name) => {
          if (typeof window === "undefined") return;
          sessionStorage.removeItem(name);
        },
      },
      partialize: (state) => ({
        navTreeCollapsed: state.navTreeCollapsed,
        workspaceNames: state.workspaceNames,
      } as unknown as ShellState),
    }
  )
);
