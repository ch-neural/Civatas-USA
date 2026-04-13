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

  // History: check if any evolution has completed (history entries don't have status)
  const rawEvo = evolutionQuery.data?.history ?? evolutionQuery.data?.jobs ?? evolutionQuery.data;
  const evolutionHistory: any[] = Array.isArray(rawEvo) ? rawEvo : [];
  const hasEvolution = evolutionHistory.length > 0 || (evolutionJobsQuery.data?.jobs ?? []).some(
    (j: any) => j.status === "completed" || j.status === "done"
  );

  // Jobs: check if any job is currently running
  const jobsList: any[] = evolutionJobsQuery.data?.jobs ?? [];
  const isEvolutionRunning = jobsList.some(
    (j: any) => j.status === "running" || j.status === "pending"
  );

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
