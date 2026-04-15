"use client";
import { useState, useEffect } from "react";
import { WorkflowSidebar } from "./WorkflowSidebar";
import StatusBar from "./StatusBar";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import { OnboardingWizard } from "../onboarding/OnboardingWizard";
import { useSettings } from "@/hooks/use-settings";
import { Toaster } from "sonner";
import { useThemeEffect } from "@/store/theme-store";

export function DesktopShell({ children }: { children: React.ReactNode }) {
  const { data: settings, isLoading } = useSettings();
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [resizing, setResizing] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);
  useThemeEffect();

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      setSidebarWidth(Math.max(180, Math.min(360, e.clientX)));
    };
    const onUp = () => setResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);

  if (!mounted || isLoading) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ backgroundColor: "var(--bg-primary)" }}>
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>Loading...</div>
      </div>
    );
  }

  if (settings && !settings.onboarding_completed) {
    return <OnboardingWizard />;
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}>
      <div className="flex flex-1 overflow-hidden">
        <div style={{ width: sidebarWidth, minWidth: 180 }} className="shrink-0">
          <WorkflowSidebar />
        </div>
        <div
          className="w-[3px] cursor-col-resize transition-colors shrink-0"
          style={{ backgroundColor: "transparent" }}
          onMouseDown={() => setResizing(true)}
        />
        <main className="flex-1 overflow-y-auto p-6" style={{ backgroundColor: "var(--bg-primary)" }}>
          {children}
        </main>
      </div>
      <StatusBar />
      <CreateWorkspaceDialog />
      <Toaster position="bottom-right" />
    </div>
  );
}
