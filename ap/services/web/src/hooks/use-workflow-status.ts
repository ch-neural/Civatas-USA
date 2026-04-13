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

  const personaCount =
    personaQuery.data?.agents?.length ?? personaQuery.data?.length ?? 0;
  const hasPersonas = personaCount > 0;

  const rawEvo = evolutionQuery.data?.jobs ?? evolutionQuery.data;
  const evolutionJobs: any[] = Array.isArray(rawEvo) ? rawEvo : [];
  const hasEvolution = evolutionJobs.some(
    (j: any) => j.status === "completed" || j.status === "done"
  );
  const isEvolutionRunning = evolutionJobs.some(
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
