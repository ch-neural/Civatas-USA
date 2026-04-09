"use client";
import { useState, useEffect } from "react";
import { WorkflowSidebar } from "./WorkflowSidebar";
import StatusBar from "./StatusBar";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import { OnboardingWizard } from "../onboarding/OnboardingWizard";
import { useSettings } from "@/hooks/use-settings";
import { Toaster } from "sonner";

export function DesktopShell({ children }: { children: React.ReactNode }) {
  const { data: settings, isLoading } = useSettings();
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [resizing, setResizing] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

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
      <div className="h-screen bg-[#0a0a1a] flex items-center justify-center">
        <div className="text-neutral-500 text-sm">Loading...</div>
      </div>
    );
  }

  if (settings && !settings.onboarding_completed) {
    return <OnboardingWizard />;
  }

  return (
    <div className="h-screen flex flex-col bg-[#1a1a2e] text-neutral-200 overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <div style={{ width: sidebarWidth, minWidth: 180 }} className="shrink-0">
          <WorkflowSidebar />
        </div>
        <div
          className="w-[3px] cursor-col-resize hover:bg-[#e94560]/30 transition-colors shrink-0"
          onMouseDown={() => setResizing(true)}
        />
        <main className="flex-1 overflow-y-auto bg-[#1a1a2e] p-6">
          {children}
        </main>
      </div>
      <StatusBar />
      <CreateWorkspaceDialog />
      <Toaster position="bottom-right" theme="dark" />
    </div>
  );
}
