import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getSynthesisResult, synthesizeInWorkspace } from "@/lib/api";

export function useSynthesisResult(wsId: string | null) {
  return useQuery({
    queryKey: ["synthesis", wsId],
    queryFn: () => getSynthesisResult(wsId!),
    enabled: !!wsId,
  });
}

export function useSynthesize() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      wsId,
      targetCount,
      filters,
      selectedDims,
    }: {
      wsId: string;
      targetCount: number;
      filters?: Record<string, string[]>;
      selectedDims?: string[];
    }) => synthesizeInWorkspace(wsId, targetCount, filters, selectedDims),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["synthesis", vars.wsId] });
    },
  });
}
