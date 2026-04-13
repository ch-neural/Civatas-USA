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
  evolutionRunning: boolean;
}

export function useWorkflowStatus(wsId: string | null) {
  const personaQuery = useQuery({
    queryKey: ["persona-result", wsId],
    queryFn: () => apiFetch(`/api/workspaces/${wsId}/persona-result`),
    enabled: !!wsId,
    retry: false,
    refetchInterval: 10_000,
  });

  // Jobs endpoint has status field (running/pending/completed)
  const evolutionJobsQuery = useQuery({
    queryKey: ["evolution-jobs", wsId],
    queryFn: () => apiFetch(`/api/pipeline/evolution/evolve/jobs`),
    enabled: !!wsId,
    retry: false,
    refetchInterval: 5_000,
  });

  // Quick Start progress — tracks multi-round evolution state
  const evolutionProgressQuery = useQuery({
    queryKey: ["evolution-progress", wsId],
    queryFn: () => apiFetch(`/api/workspaces/${wsId}/ui-settings/evolution-progress`),
    enabled: !!wsId,
    retry: false,
    refetchInterval: 5_000,
  });

  const personaCount =
    personaQuery.data?.agents?.length ?? personaQuery.data?.length ?? 0;
  const hasPersonas = personaCount > 0;

  // Jobs: check running status
  const jobsList: any[] = evolutionJobsQuery.data?.jobs ?? [];
  const isEvolutionRunning = jobsList.some(
    (j: any) => j.status === "running" || j.status === "pending"
  );

  // Evolution is "completed" only when Quick Start finished all rounds.
  // Quick Start saves evolution-progress with status "done" on completion
  // and "idle" after reset. Intermediate states (paused/evolving) or
  // having completed individual jobs does NOT mean evolution is done —
  // Quick Start may have been stopped at round 2/10.
  const progressStatus = evolutionProgressQuery.data?.status;
  const hasCompletedJobs = jobsList.some(
    (j: any) => j.status === "completed" || j.status === "done"
  );
  const hasEvolution =
    progressStatus === "done" ||                          // Quick Start reported full completion
    (hasCompletedJobs && !isEvolutionRunning && progressStatus === "idle");  // Reset then completed cleanly

  const status: WorkflowStatus = {
    persona: hasPersonas ? "completed" : "available",
    evolution: hasPersonas ? (hasEvolution ? "completed" : "available") : "locked",
    prediction: hasEvolution ? "available" : "locked",
    personaCount,
    evolutionCompleted: hasEvolution,
    evolutionRunning: isEvolutionRunning,
  };

  return status;
}
