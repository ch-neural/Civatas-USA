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

  const evolutionQuery = useQuery({
    queryKey: ["evolution-history", wsId],
    queryFn: () => apiFetch(`/api/pipeline/evolution/evolve/history`),
    enabled: !!wsId,
    retry: false,
    refetchInterval: 10_000,
  });

  // Jobs endpoint has status field (running/pending/completed) — history does not
  const evolutionJobsQuery = useQuery({
    queryKey: ["evolution-jobs", wsId],
    queryFn: () => apiFetch(`/api/pipeline/evolution/evolve/jobs`),
    enabled: !!wsId,
    retry: false,
    refetchInterval: 5_000,
  });

  const personaCount =
    personaQuery.data?.agents?.length ?? personaQuery.data?.length ?? 0;
  const hasPersonas = personaCount > 0;

  // Jobs: check running and completion status
  const jobsList: any[] = evolutionJobsQuery.data?.jobs ?? [];
  const isEvolutionRunning = jobsList.some(
    (j: any) => j.status === "running" || j.status === "pending"
  );

  // Evolution is "completed" only when there are completed jobs AND nothing
  // is still running. Quick Start runs multi-round evolution where each round
  // is a separate job — intermediate rounds complete but the overall flow is
  // not done until the last round finishes and no new round starts.
  const hasCompletedJobs = jobsList.some(
    (j: any) => j.status === "completed" || j.status === "done"
  );
  const hasEvolution = hasCompletedJobs && !isEvolutionRunning;

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
