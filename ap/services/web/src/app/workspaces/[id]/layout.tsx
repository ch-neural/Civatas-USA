"use client";

import { useParams } from "next/navigation";
import { useEffect } from "react";
import { useShellStore } from "@/store/shell-store";
import { getWorkspace } from "@/lib/api";
import { useActiveTemplate } from "@/hooks/use-active-template";
import { useLocaleStore } from "@/store/locale-store";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const wsId = params.id as string;
  const { setActiveWorkspace, cacheWorkspaceName } = useShellStore();

  useEffect(() => {
    setActiveWorkspace(wsId);
    // Fetch workspace name and cache it
    getWorkspace(wsId)
      .then((ws) => {
        if (ws?.name) {
          setActiveWorkspace(wsId, ws.name);
          cacheWorkspaceName(wsId, ws.name);
        }
      })
      .catch(() => {});
    return () => setActiveWorkspace(null);
  }, [wsId, setActiveWorkspace, cacheWorkspaceName]);

  // Stage 1.8: when the workspace's active template is a US template, auto-
  // switch the UI locale to English so simulation results show in English by
  // default. The user can still toggle back to zh-TW via the StatusBar 🌐
  // button — and the locale store persists their choice across page loads.
  // This effect only runs once per workspace mount (not on every locale toggle).
  const { template: activeTemplate } = useActiveTemplate(wsId);
  const setLocale = useLocaleStore((s) => s.setLocale);
  useEffect(() => {
    if (!activeTemplate) return;
    const isUS = activeTemplate.locale === "en-US" || activeTemplate.country === "US";
    if (isUS) setLocale("en");
    // intentionally one-shot per template change — once switched, the user
    // is free to toggle back via the StatusBar button without us flipping again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplate?.id]);

  return <>{children}</>;
}
