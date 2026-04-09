"use client";

import { useEffect } from "react";
import { useShellStore } from "@/store/shell-store";
import { useLocaleStore, nextLocaleLabel } from "@/store/locale-store";
import { useTr } from "@/lib/i18n";

export default function StatusBar() {
  const { activeWorkspaceId, activeWorkspaceName, activeJobs, llmStatus, setLlmStatus } = useShellStore();
  const { locale, toggle } = useLocaleStore();
  const t = useTr();
  const isEn = locale === "en";

  useEffect(() => {
    const checkHealth = () => {
      fetch("/health")
        .then((res) => {
          if (res.ok) setLlmStatus("connected");
          else setLlmStatus("disconnected");
        })
        .catch(() => setLlmStatus("disconnected"));
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [setLlmStatus]);

  const runningJob = activeJobs.find((j) => j.status === "running");

  return (
    <div className="flex items-center justify-between h-[24px] px-3 bg-bg-sidebar border-t border-border-subtle text-[10px] shrink-0 select-none">
      {/* Left */}
      <div className="flex items-center gap-3 text-text-faint">
        {activeWorkspaceId && (
          <span className="font-cjk">
            {t("status.project")}: <span className="text-text-muted">{activeWorkspaceName || activeWorkspaceId.slice(0, 8)}</span>
          </span>
        )}
      </div>

      {/* Center - Job progress */}
      <div className="flex items-center gap-2">
        {runningJob && (
          <div className="flex items-center gap-2 text-text-muted">
            <div
              className="w-2.5 h-2.5 border border-accent border-t-transparent rounded-full"
              style={{ animation: "spin 0.8s linear infinite" }}
            />
            <span className="font-cjk">{runningJob.label}</span>
            <span>
              {runningJob.done}/{runningJob.total}
            </span>
          </div>
        )}
      </div>

      {/* Right - Language switcher + LLM status */}
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          title={isEn ? t("status.switch_to_zh") : t("status.switch_to_en")}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-border-subtle hover:bg-white/5 hover:border-accent transition-colors text-text-muted hover:text-text-primary"
          style={{ fontSize: 10 }}
        >
          🌐 <span style={{ fontWeight: 600 }}>{nextLocaleLabel(locale)}</span>
        </button>
        <div className="flex items-center gap-1.5">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              llmStatus === "connected"
                ? "bg-green"
                : llmStatus === "disconnected"
                ? "bg-pink"
                : "bg-yellow"
            }`}
          />
          <span className="text-text-faint font-cjk">
            {llmStatus === "connected" ? t("status.llm_connected")
              : llmStatus === "disconnected" ? t("status.llm_offline")
              : t("status.llm_checking")}
          </span>
        </div>
      </div>
    </div>
  );
}
