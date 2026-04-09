import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getWorkspacePersonas,
  getPersonaProgress,
  generateWorkspacePersonas,
  cancelPersonaGeneration,
  savePersonaSnapshot,
  listPersonaSnapshots,
  loadPersonaSnapshot,
  deletePersonaSnapshot,
} from "@/lib/api";

export function usePersonas(wsId: string | null) {
  return useQuery({
    queryKey: ["personas", wsId],
    queryFn: () => getWorkspacePersonas(wsId!),
    enabled: !!wsId,
  });
}

export function usePersonaProgress(wsId: string | null, enabled = false) {
  return useQuery({
    queryKey: ["persona-progress", wsId],
    queryFn: () => getPersonaProgress(wsId!),
    enabled: !!wsId && enabled,
    refetchInterval: enabled ? 1500 : false,
  });
}

export function useGeneratePersonas() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      wsId,
      strategy = "template",
      concurrency = 5,
    }: {
      wsId: string;
      strategy?: string;
      concurrency?: number;
    }) => generateWorkspacePersonas(wsId, strategy, concurrency),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["personas", vars.wsId] });
      queryClient.invalidateQueries({ queryKey: ["persona-progress", vars.wsId] });
    },
  });
}

export function useCancelPersonas() {
  return useMutation({
    mutationFn: (wsId: string) => cancelPersonaGeneration(wsId),
  });
}

export function usePersonaSnapshots(wsId: string | null) {
  return useQuery({
    queryKey: ["persona-snapshots", wsId],
    queryFn: () => listPersonaSnapshots(wsId!),
    enabled: !!wsId,
  });
}

export function useSavePersonaSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ wsId, name, metadata }: { wsId: string; name: string; metadata?: any }) =>
      savePersonaSnapshot(wsId, name, metadata),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["persona-snapshots", vars.wsId] });
    },
  });
}

export function useLoadPersonaSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ wsId, snapshotId }: { wsId: string; snapshotId: string }) =>
      loadPersonaSnapshot(wsId, snapshotId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["personas", vars.wsId] });
    },
  });
}

export function useDeletePersonaSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ wsId, snapshotId }: { wsId: string; snapshotId: string }) =>
      deletePersonaSnapshot(wsId, snapshotId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["persona-snapshots", vars.wsId] });
    },
  });
}
