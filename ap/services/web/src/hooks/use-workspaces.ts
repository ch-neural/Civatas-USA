import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listWorkspaces, createWorkspace, deleteWorkspace, getWorkspace } from "@/lib/api";

export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const data = await listWorkspaces();
      return data.workspaces || [];
    },
  });
}

export function useWorkspace(wsId: string | null) {
  return useQuery({
    queryKey: ["workspace", wsId],
    queryFn: () => getWorkspace(wsId!),
    enabled: !!wsId,
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, purpose }: { name: string; purpose?: string }) =>
      createWorkspace(name, purpose),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (wsId: string) => deleteWorkspace(wsId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}
