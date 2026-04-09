import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export function useNewsSources(wsId: string | null) {
  return useQuery({
    queryKey: ["evolution-sources", wsId],
    queryFn: () => apiFetch(`/api/pipeline/evolution/sources?ws_id=${wsId}`),
    enabled: !!wsId,
  });
}

export function useNewsPool(wsId: string | null) {
  return useQuery({
    queryKey: ["news-pool", wsId],
    queryFn: () => apiFetch(`/api/pipeline/evolution/news-pool?ws_id=${wsId}`),
    enabled: !!wsId,
  });
}

export function useEvolutionStatus(wsId: string | null, jobId: string | null, enabled = false) {
  return useQuery({
    queryKey: ["evolution-status", wsId, jobId],
    queryFn: () => apiFetch(`/api/pipeline/evolution/evolve/status/${jobId}?ws_id=${wsId}`),
    enabled: !!wsId && !!jobId && enabled,
    refetchInterval: enabled ? 5000 : false,
  });
}
