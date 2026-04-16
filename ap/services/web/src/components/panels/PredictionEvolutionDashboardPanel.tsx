"use client";

import { useState, useEffect } from "react";
import { listRecordings, getPlaybackSteps, apiFetch, stopPredictionJob, pausePredictionJob, resumePredictionJob } from "@/lib/api";
import { useLocaleStore } from "@/store/locale-store";
import { useTr } from "@/lib/i18n";
import { StepGate } from "@/components/shared/StepGate";
import { useWorkflowStatus } from "@/hooks/use-workflow-status";
import { useShellStore } from "@/store/shell-store";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, Legend,
} from "recharts";

const LEAN_COLORS: Record<string, string> = {
  // 3-tier aggregate buckets
  "left": "#3b82f6", "center": "#94a3b8", "right": "#ef4444",
  // 5-tier per-agent labels
  "Solid Dem": "#1e40af", "Lean Dem": "#3b82f6",
  "Tossup": "#94a3b8",
  "Lean Rep": "#ef4444", "Solid Rep": "#991b1b",
};
const tooltipStyle = { background: "#1e1e2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11 };

/**
 * Prediction-specific evolution dashboard.
 * Reads from the latest prediction recording's steps (independent from historical evolution).
 */
export default function PredictionEvolutionDashboardPanel({ wsId }: { wsId: string }) {
  const t = useTr();
  const en = useLocaleStore((s) => s.locale) === "en";
  const _wsId = useShellStore((s) => s.activeWorkspaceId);
  const workflowStatus = useWorkflowStatus(_wsId);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<any[]>([]);
  const [selectedRecId, setSelectedRecId] = useState<string>("");

  // Live prediction job banner — polls every 3s. First checks sessionStorage
  // for an active job id (written by Setup on Start). If absent or the job
  // is terminal, falls back to the server's /predictions/jobs list and picks
  // any running/pending/paused job for this workspace. Banner disappears
  // once the job reaches a terminal state.
  const [liveJob, setLiveJob] = useState<any>(null);
  const [pausingPending, setPausingPending] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fetchJob = async (jid: string) => {
      try {
        return await apiFetch(`/api/pipeline/evolution/predictions/jobs/${jid}`);
      } catch { return null; }
    };
    const findAnyRunningJob = async () => {
      try {
        const res: any = await apiFetch(`/api/pipeline/evolution/predictions/jobs`);
        const list: any[] = res?.jobs || [];
        const pick = list
          .filter((j) => (!j.workspace_id || j.workspace_id === wsId) &&
                         (j.status === "running" || j.status === "pending" || j.status === "paused"))
          .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0];
        return pick ? await fetchJob(pick.job_id) : null;
      } catch { return null; }
    };
    const poll = async () => {
      try {
        let jobId: string | null = null;
        try { jobId = sessionStorage.getItem(`activePredictionJob_${wsId}`); } catch { /* ignore */ }
        let res: any = jobId ? await fetchJob(jobId) : null;
        const st1 = res?.status;
        if (!res || st1 === "completed" || st1 === "failed" || st1 === "cancelled" || st1 === "stopped") {
          // session key stale — try server-side discovery
          try { sessionStorage.removeItem(`activePredictionJob_${wsId}`); } catch { /* ignore */ }
          res = await findAnyRunningJob();
          if (res?.job_id) {
            try { sessionStorage.setItem(`activePredictionJob_${wsId}`, res.job_id); } catch { /* ignore */ }
          }
        }
        if (cancelled) return;
        setLiveJob(res || null);
      } catch { /* ignore */ }
    };
    poll();
    const h = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(h); };
  }, [wsId]);

  useEffect(() => {
    if (!pausingPending) return;
    const msgs: any[] = Array.isArray(liveJob?.live_messages) ? liveJob.live_messages : [];
    const recent = msgs.slice(-30).map((m: any) => typeof m === "string" ? m : (m?.text || ""));
    const saved = recent.some((t: string) => /Checkpoint saved|checkpoint.*saved/i.test(t));
    if (saved) setPausingPending(false);
    const s = liveJob?.status;
    if (s === "cancelled" || s === "completed" || s === "failed" || s === "stopped") setPausingPending(false);
  }, [liveJob?.live_messages, liveJob?.status, pausingPending]);

  const liveBanner = liveJob && (liveJob.status === "running" || liveJob.status === "pending" || liveJob.status === "paused") ? (() => {
    const ds = liveJob.current_daily_data || [];
    const simDays = liveJob.sim_days || 3;
    const curDay = liveJob.current_day ?? (ds.length > 0 ? ds[ds.length - 1].day : 0);
    const totScen = liveJob.total_scenarios || 1;
    const curScen = liveJob.current_scenario || 1;
    const pct = Math.min(99, Math.round(((Math.max(0, curScen - 1) * simDays + (curDay || 0)) / (totScen * simDays)) * 100));
    const phase = liveJob.phase || "";
    const agentsDone = liveJob.agents_processed;
    const agentsTotal = liveJob.agent_count;
    const liveMsgs: string[] = Array.isArray(liveJob.live_messages)
      ? liveJob.live_messages.map((m: any) => typeof m === "string" ? m : (m?.text || ""))
      : [];
    const elapsed = liveJob.started_at ? Math.max(0, Math.floor((Date.now() / 1000) - liveJob.started_at)) : 0;
    const fmtElapsed = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
    const phaseLabel = en
      ? ({ searching: "🔍 Searching news", scoring: "📊 Scoring news", district_news: "📰 District news", evolving: "🧠 Agent evolution", polling: "🗳️ Running poll", completing: "✨ Finalizing" } as Record<string, string>)[phase] || phase
      : ({ searching: "🔍 搜尋新聞中", scoring: "📊 新聞評分中", district_news: "📰 地方新聞", evolving: "🧠 Agent 演化中", polling: "🗳️ 投票中", completing: "✨ 結算中" } as Record<string, string>)[phase] || phase;
    return (
      <div style={{ padding: 14, borderRadius: 10, background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.3)", marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: pausingPending ? "#fbbf24" : "#c084fc", fontFamily: "var(--font-cjk)", display: "flex", alignItems: "center", gap: 6 }}>
              {pausingPending && (
                <span style={{ display: "inline-block", width: 11, height: 11, border: "2px solid #fbbf24", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              )}
              {pausingPending
                ? (en
                    ? `⏳ Pausing — waiting for Day ${curDay}/${simDays} to finish & checkpoint to save...`
                    : `⏳ 暫停中 — 等 Day ${curDay}/${simDays} 處理完 + checkpoint 寫入...`)
                : liveJob.status === "paused"
                ? (en ? "⏸ Prediction paused (checkpoint saved)" : "⏸ 預測已暫停（checkpoint 已儲存）")
                : (en ? "🟣 Prediction running" : "🟣 預測執行中")}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 4, display: "flex", flexWrap: "wrap", gap: 10 }}>
              <span>{en ? `Scenario ${curScen}/${totScen}` : `情境 ${curScen}/${totScen}`}</span>
              <span>·</span>
              <span>{en ? `Day ${curDay}/${simDays}` : `第 ${curDay}/${simDays} 天`}</span>
              <span>·</span>
              <span style={{ color: "#c084fc", fontWeight: 600 }}>{pct}%</span>
              {phaseLabel && (<><span>·</span><span style={{ color: "#fbbf24" }}>{phaseLabel}</span></>)}
              {typeof agentsDone === "number" && typeof agentsTotal === "number" && agentsTotal > 0 && (
                <><span>·</span><span>{en ? `Agents ${agentsDone}/${agentsTotal}` : `Agents ${agentsDone}/${agentsTotal}`}</span></>
              )}
              <span>·</span>
              <span style={{ color: "rgba(255,255,255,0.5)" }}>{en ? `Elapsed ${fmtElapsed}` : `已耗時 ${fmtElapsed}`}</span>
            </div>
            {liveMsgs.length > 0 && (
              <div style={{ marginTop: 8, maxHeight: 88, overflowY: "auto", fontSize: 10.5, color: "rgba(255,255,255,0.55)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: 1.55, background: "rgba(0,0,0,0.15)", borderRadius: 6, padding: "6px 10px" }}>
                {liveMsgs.slice(-6).map((m, i) => (
                  <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m}</div>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {pausingPending ? (
              <button disabled style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(251,191,36,0.3)", background: "rgba(251,191,36,0.08)", color: "rgba(251,191,36,0.6)", fontSize: 12, fontWeight: 700, cursor: "not-allowed", display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid #fbbf24", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                {en ? "Pausing…" : "暫停中…"}
              </button>
            ) : liveJob.status === "paused" ? (
              <button onClick={() => resumePredictionJob(liveJob.job_id).catch(() => {})} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#22c55e", color: "#0b1220", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                ▶ {en ? "Resume" : "繼續"}
              </button>
            ) : (
              <button onClick={() => { setPausingPending(true); pausePredictionJob(liveJob.job_id).catch(() => setPausingPending(false)); }} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                ⏸ {en ? "Pause" : "暫停"}
              </button>
            )}
            <button onClick={() => { if (confirm(en ? "Stop this prediction?" : "確定停止此次預測？")) stopPredictionJob(liveJob.job_id).catch(() => {}); }} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#ef4444", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              ■ {en ? "Stop" : "停止"}
            </button>
          </div>
        </div>
        <div style={{ marginTop: 8, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: "#a855f7", transition: "width 0.3s" }} />
        </div>
      </div>
    );
  })() : null;

  useEffect(() => {
    (async () => {
      try {
        const res = await listRecordings();
        // Include both completed AND in-progress prediction recordings so the
        // Dashboard can render partial charts while a prediction is running.
        const predRecs = (res.recordings || [])
          .filter((r: any) => r.type === "prediction")
          .sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0));
        setRecordings(predRecs);
        if (predRecs.length > 0) {
          const latest = predRecs[0];
          setSelectedRecId(latest.recording_id);
          await loadRecording(latest.recording_id, latest);
        } else {
          setLoading(false);
        }
      } catch { setLoading(false); }
    })();
  }, []);

  // While a prediction is live AND we have its recording_id, poll the recording
  // steps every 3s so the charts fill in as each simulated day completes.
  useEffect(() => {
    const recId = liveJob?.recording_id;
    if (!recId || !liveJob?.status || liveJob.status === "completed" || liveJob.status === "failed" || liveJob.status === "cancelled") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res: any = await getPlaybackSteps(recId);
        const steps = res?.steps || [];
        if (cancelled) return;
        if (steps.length > 0) {
          // Look up recording meta if we have it, else synthesize minimal meta
          const recMeta = recordings.find((r: any) => r.recording_id === recId) || { title: liveJob.question || "Live Prediction", total_steps: steps.length };
          const transformed = transformSteps(steps, recMeta);
          if (transformed) {
            setData(transformed);
            setLoading(false);
            setSelectedRecId(recId);
          }
        }
      } catch { /* ignore */ }
    };
    tick();
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); };
  }, [liveJob?.recording_id, liveJob?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRecording = async (recId: string, recMeta?: any) => {
    setLoading(true);
    try {
      const res = await getPlaybackSteps(recId);
      const steps = res.steps || [];
      const transformed = transformSteps(steps, recMeta);
      setData(transformed);
    } catch { }
    setLoading(false);
  };

  const handleRecChange = async (recId: string) => {
    setSelectedRecId(recId);
    const meta = recordings.find((r: any) => r.recording_id === recId);
    await loadRecording(recId, meta);
  };

  if (workflowStatus.prediction === "locked") {
    return (
      <StepGate
        requiredStep={2}
        requiredStepName="演化"
        requiredStepNameEn="Evolution"
        description="請先在第 2 步執行演化，讓代理人形成觀點後才能進行預測。"
        descriptionEn="Run evolution in Step 2 to shape agent opinions before making predictions."
        targetRoute={_wsId ? `/workspaces/${_wsId}/evolution` : "/workspaces"}
      />
    );
  }

  if (loading) return (
    <div style={{ padding: "20px 24px" }}>
      {liveBanner}
      <div style={{ padding: 40, textAlign: "center", color: "var(--text-faint)" }}>{t("predevodash.loading")}</div>
    </div>
  );
  if (!data || !data.daily_trends?.length) {
    return (
      <div style={{ padding: "20px 24px" }}>
        {liveBanner}
        <div style={{ padding: 40, textAlign: "center" }}>
          <span style={{ fontSize: 32 }}>📊</span>
          <p style={{ color: "var(--text-faint)", fontFamily: "var(--font-cjk)", fontSize: 13 }}>
            {t("predevodash.empty")}
          </p>
        </div>
      </div>
    );
  }

  const allTrends = data.daily_trends || [];
  const allLeanTrends = data.leaning_trends || [];
  const districts = data.district_stats || {};

  const trends = selectedDistrict && data.district_daily_trends?.[selectedDistrict]
    ? data.district_daily_trends[selectedDistrict] : allTrends;
  const leanTrends = selectedDistrict && data.district_leaning_trends?.[selectedDistrict]
    ? data.district_leaning_trends[selectedDistrict] : allLeanTrends;
  const latestDay = trends[trends.length - 1];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "auto" }}>
      <div style={{ padding: "12px clamp(12px, 2vw, 24px)", display: "flex", flexDirection: "column", gap: 12 }}>
        {liveBanner}

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h2 style={{ color: "#fff", fontSize: 18, fontWeight: 700, margin: 0, fontFamily: "var(--font-cjk)" }}>
              📊 {t("predevodash.title")}
            </h2>
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
              {t("predevodash.subtitle", { days: trends.length, agents: data.agent_count })}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {recordings.length > 1 && (
              <select
                value={selectedRecId}
                onChange={(e) => handleRecChange(e.target.value)}
                style={{
                  padding: "4px 8px", borderRadius: 4, fontSize: 11, fontFamily: "var(--font-cjk)",
                  border: "1px solid var(--border-input)", backgroundColor: "var(--bg-secondary)", color: "var(--text-secondary)",
                }}
              >
                {recordings.map((r: any) => (
                  <option key={r.recording_id} value={r.recording_id}>
                    {r.title || r.recording_id} ({t("predevodash.rec_days_suffix", { n: r.total_steps })})
                  </option>
                ))}
              </select>
            )}
            {selectedRecId && (
              <button
                onClick={async () => {
                  try {
                    const stepsRes: any = await getPlaybackSteps(selectedRecId);
                    const recMeta = recordings.find((r: any) => r.recording_id === selectedRecId) || {};
                    // Enrich with scenario_results by fetching the full prediction object.
                    // The /predictions list returns only summaries; results live in the
                    // full detail at /predictions/{pred_id} under `results.scenario_results`.
                    let scenarioResults: any[] = [];
                    let pollGroups: any[] = [];
                    try {
                      const preds: any = await apiFetch(`/api/pipeline/evolution/predictions`);
                      const predList = (preds?.predictions || []) as any[];
                      const completed = predList
                        .filter((p: any) => p.has_results || p.status === "completed")
                        .sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0));
                      // Pick most recent completed prediction (matching recording if possible)
                      const candidate = completed[0];
                      if (candidate?.prediction_id) {
                        const full: any = await apiFetch(`/api/pipeline/evolution/predictions/${candidate.prediction_id}`);
                        const sr = full?.results?.scenario_results || full?.scenario_results;
                        if (Array.isArray(sr)) scenarioResults = sr;
                        if (Array.isArray(full?.poll_groups)) pollGroups = full.poll_groups;
                      }
                    } catch (e) { console.warn("[download] fetch pred detail failed:", e); }
                    const { generatePredictionPlaybackHTML } = await import("@/lib/export-prediction-playback");
                    const html = generatePredictionPlaybackHTML({
                      recording: recMeta,
                      steps: stepsRes?.steps || [],
                      scenarioResults,
                      pollGroups,
                      locale: en ? "en" : "zh-TW",
                    });
                    const blob = new Blob([html], { type: "text/html" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `civatas-prediction-playback-${new Date().toISOString().slice(0, 10)}.html`;
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (e) {
                    console.error("Export prediction playback failed:", e);
                  }
                }}
                style={{
                  padding: "4px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                  fontFamily: "var(--font-cjk)", border: "1px solid rgba(168,85,247,0.4)",
                  background: "rgba(168,85,247,0.12)", color: "#a855f7", cursor: "pointer",
                }}
              >
                {en ? "📥 Download Playback" : "📥 下載回放頁面"}
              </button>
            )}
            {selectedDistrict && (
              <button onClick={() => setSelectedDistrict(null)} style={{
                padding: "4px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                fontFamily: "var(--font-cjk)", border: "1px solid #a78bfa",
                backgroundColor: "rgba(167,139,250,0.12)", color: "#a78bfa", cursor: "pointer",
              }}>
                ✕ {selectedDistrict}
              </button>
            )}
          </div>
        </div>

        {/* Stats Cards */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(() => {
            const ds = selectedDistrict && districts[selectedDistrict];
            const localSat = ds ? ds.avg_local_satisfaction : latestDay?.local_satisfaction;
            const nationalSat = ds ? ds.avg_national_satisfaction : latestDay?.national_satisfaction;
            const anxietyVal = ds ? ds.avg_anxiety : latestDay?.anxiety;
            const agentCount = ds ? ds.count : data.agent_count;
            return [
              { label: t("predevodash.stat.local_sat"), value: localSat, color: "#3b82f6" },
              { label: t("predevodash.stat.national_sat"), value: nationalSat, color: "#f97316" },
              { label: t("predevodash.stat.anxiety"), value: anxietyVal, color: anxietyVal > 60 ? "#ef4444" : "#22c55e" },
              { label: t("predevodash.stat.agent_count"), value: agentCount, color: "#a78bfa" },
              { label: t("predevodash.stat.days"), value: trends.length, color: "#94a3b8" },
            ];
          })().map((s, i) => (
            <div key={i} style={{
              flex: "1 1 120px", padding: "10px 14px", borderRadius: 8,
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", textAlign: "center",
            }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.color, fontFamily: "var(--font-mono)" }}>
                {typeof s.value === "number" ? (s.value % 1 === 0 ? s.value : s.value.toFixed(1)) : "—"}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-cjk)" }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* ── Candidate Prediction Section ── */}
        {(() => {
          const candNames: string[] = data.candidate_names || [];
          const candTrends: any[] = data.candidate_trends || [];
          const finalVote: { name: string; pct: number }[] = data.final_vote || [];
          const winner = data.winner;
          const awTrends: any[] = data.awareness_trends || [];
          const snTrends: any[] = data.sentiment_trends || [];
          if (candNames.length === 0 || candTrends.length === 0) return null;
          const candColor = (name: string, i: number) => {
            const n = name.toLowerCase();
            if (/trump|vance|pence|desantis|haley|republican/.test(n)) return "#ef4444";
            if (/harris|biden|newsom|whitmer|shapiro|democrat/.test(n)) return "#3b82f6";
            const palette = ["#a78bfa", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4"];
            return palette[i % palette.length];
          };
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Winner Banner */}
              {winner && (
                <div style={{ padding: "14px 18px", borderRadius: 10, background: "linear-gradient(90deg, rgba(250,204,21,0.12), rgba(168,85,247,0.08))", border: "1px solid rgba(250,204,21,0.35)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ fontSize: 34 }}>🏆</div>
                    <div>
                      <div style={{ fontSize: 11, color: "#fde68a", fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase" }}>
                        {en ? "Predicted Winner" : "預測勝選"}
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", fontFamily: "var(--font-cjk)", marginTop: 2 }}>
                        {winner.name}
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.65)", marginTop: 3 }}>
                        {winner.pct}% {winner.runner_up && `vs ${winner.runner_up} ${winner.runner_up_pct}%`}
                        {" · "}
                        <span style={{ color: winner.margin > 5 ? "#22c55e" : winner.margin > 1 ? "#fbbf24" : "#ef4444", fontWeight: 700 }}>
                          {en ? "Margin" : "差距"} {winner.margin > 0 ? "+" : ""}{winner.margin}%
                        </span>
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-cjk)", textAlign: "right", maxWidth: 220 }}>
                    {en
                      ? "Based on weighted LLM voting across all poll groups."
                      : "基於所有投票群組的加權 LLM 投票結果。"}
                  </div>
                </div>
              )}

              {/* Support Trend + Final Vote Share */}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: "2 1 420px", padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                    📈 {en ? "Candidate Support Trend" : "候選人支持度趨勢"}
                  </div>
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart data={candTrends}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                      <XAxis dataKey="day" stroke="#666" fontSize={10} />
                      <YAxis stroke="#666" fontSize={10} domain={[0, 100]} unit="%" />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {candNames.map((name, i) => (
                        <Line key={name} type="monotone" dataKey={name} stroke={candColor(name, i)} strokeWidth={2} dot={{ r: 3 }} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ flex: "1 1 280px", padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                    🗳️ {en ? "Final Vote Share" : "最終得票率"}
                  </div>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={finalVote} layout="vertical" margin={{ top: 6, right: 20, bottom: 6, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                      <XAxis type="number" domain={[0, 100]} stroke="#666" fontSize={10} unit="%" />
                      <YAxis dataKey="name" type="category" stroke="#fff" fontSize={11} width={110} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Bar dataKey="pct" radius={[0, 4, 4, 0]}>
                        {finalVote.map((d, i) => (
                          <Cell key={d.name} fill={candColor(d.name, i)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Awareness / Sentiment */}
              {(awTrends.length > 0 || snTrends.length > 0) && (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {awTrends.length > 0 && (
                    <div style={{ flex: "1 1 320px", padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 4 }}>
                        🧑‍💼 {en ? "Candidate Awareness" : "候選人認知度"}
                        <span style={{ fontSize: 9, fontWeight: 400, color: "var(--text-faint)", marginLeft: 6 }}>
                          {en ? "(0 = never heard, 100 = very well known)" : "(0 = 完全不認識, 100 = 非常熟悉)"}
                        </span>
                      </div>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={awTrends}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                          <XAxis dataKey="day" stroke="#666" fontSize={10} />
                          <YAxis stroke="#666" fontSize={10} domain={[0, 100]} unit="%" />
                          <Tooltip contentStyle={tooltipStyle} />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          {candNames.map((name, i) => (
                            <Line key={name} type="monotone" dataKey={name} stroke={candColor(name, i)} strokeWidth={2} dot={false} />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  {snTrends.length > 0 && (
                    <div style={{ flex: "1 1 320px", padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 4 }}>
                        ❤️ {en ? "Candidate Sentiment" : "候選人情感傾向"}
                        <span style={{ fontSize: 9, fontWeight: 400, color: "var(--text-faint)", marginLeft: 6 }}>
                          {en ? "(-100 = very negative, +100 = very positive)" : "(-100 = 非常負面, +100 = 非常正面)"}
                        </span>
                      </div>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={snTrends}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                          <XAxis dataKey="day" stroke="#666" fontSize={10} />
                          <YAxis stroke="#666" fontSize={10} domain={[-100, 100]} />
                          <Tooltip contentStyle={tooltipStyle} />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          {candNames.map((name, i) => (
                            <Line key={name} type="monotone" dataKey={name} stroke={candColor(name, i)} strokeWidth={2} dot={false} />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Main Grid */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>

          {/* Left: District Grid */}
          <div style={{ flex: "1 1 280px", minWidth: 280, padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
              {t("predevodash.districts_overview")} {selectedDistrict && <span style={{ color: "#a78bfa" }}>— {selectedDistrict}</span>}
            </div>
            {(() => {
              const sorted = Object.keys(districts)
                .map(d => ({ name: d, ...(districts[d] as any) }))
                .sort((a, b) => b.count - a.count);
              const satColor = (sat: number) => {
                if (sat >= 65) return { bg: "rgba(34,197,94,0.25)", border: "rgba(34,197,94,0.4)", text: "#22c55e" };
                if (sat >= 50) return { bg: "rgba(59,130,246,0.2)", border: "rgba(59,130,246,0.35)", text: "#3b82f6" };
                if (sat >= 35) return { bg: "rgba(245,158,11,0.2)", border: "rgba(245,158,11,0.35)", text: "#f59e0b" };
                return { bg: "rgba(239,68,68,0.2)", border: "rgba(239,68,68,0.35)", text: "#ef4444" };
              };
              return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {sorted.map(d => {
                    const avgSat = ((d.avg_local_satisfaction || 50) + (d.avg_national_satisfaction || 50)) / 2;
                    const c = satColor(avgSat);
                    const isSelected = selectedDistrict === d.name;
                    return (
                      <button key={d.name}
                        onClick={() => setSelectedDistrict(prev => prev === d.name ? null : d.name)}
                        style={{
                          padding: "6px 8px", borderRadius: 6, border: `1.5px solid ${isSelected ? "#a78bfa" : c.border}`,
                          background: isSelected ? "rgba(124,58,237,0.15)" : c.bg,
                          cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center",
                          minWidth: 56, gap: 2,
                        }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: isSelected ? "#c4b5fd" : c.text, fontFamily: "var(--font-cjk)" }}>
                          {d.name.replace(/[區鄉鎮市]$/, "")}
                        </span>
                        <span style={{ fontSize: 9, color: isSelected ? "#c4b5fd" : "rgba(255,255,255,0.4)", fontFamily: "var(--font-mono)" }}>
                          {t("predevodash.people_suffix", { n: d.count })}
                        </span>
                        <span style={{ fontSize: 8, color: c.text, fontFamily: "var(--font-mono)" }}>
                          {avgSat.toFixed(0)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })()}

            {selectedDistrict && districts[selectedDistrict] && (() => {
              const ds = districts[selectedDistrict] as any;
              return (
                <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: "rgba(124,58,237,0.06)", border: "1px solid rgba(124,58,237,0.12)", fontSize: 11, fontFamily: "var(--font-cjk)", color: "var(--text-secondary)" }}>
                  <div style={{ fontWeight: 700, marginBottom: 4, color: "#a78bfa" }}>{selectedDistrict}</div>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span>{t("predevodash.detail.count")}: <b>{ds.count}</b></span>
                    <span>{t("predevodash.detail.local")}: <b style={{ color: "#3b82f6" }}>{ds.avg_local_satisfaction}</b></span>
                    <span>{t("predevodash.detail.national")}: <b style={{ color: "#f97316" }}>{ds.avg_national_satisfaction}</b></span>
                    <span>{t("predevodash.detail.anxiety")}: <b style={{ color: ds.avg_anxiety > 60 ? "#ef4444" : "#22c55e" }}>{ds.avg_anxiety}</b></span>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    {Object.entries(ds.leanings || {}).map(([l, c]) => (
                      <span key={l} style={{ fontSize: 10, color: LEAN_COLORS[l] || "#9ca3af" }}>{l}:{String(c)}</span>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Right: Charts */}
          <div style={{ flex: "2 1 400px", display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>

            {/* Satisfaction Trend */}
            <div style={{ padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                {t("predevodash.chart.sat_anxiety")}{selectedDistrict && <span style={{ color: "#a78bfa" }}> — {selectedDistrict}</span>}
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={trends}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#9ca3af" }} tickFormatter={(d) => `D${d}`} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#9ca3af" }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Line type="monotone" dataKey="local_satisfaction" stroke="#3b82f6" name={t("predevodash.line.local")} strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="national_satisfaction" stroke="#f97316" name={t("predevodash.line.national")} strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="anxiety" stroke="#ef4444" name={t("predevodash.line.anxiety")} strokeWidth={2} strokeDasharray="5 5" dot={{ r: 3 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Leaning Trend */}
            <div style={{ padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                {t("predevodash.chart.lean_trend")}{selectedDistrict && <span style={{ color: "#a78bfa" }}> — {selectedDistrict}</span>}
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={leanTrends}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#9ca3af" }} tickFormatter={(d) => `D${d}`} />
                  <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  {/* Only render bars for keys present in the data — avoids
                      showing empty legend entries for the 5-tier labels that
                      transformSteps has already aggregated into left/center/right. */}
                  {(() => {
                    const keysInData = new Set<string>();
                    for (const row of leanTrends) {
                      for (const k of Object.keys(row)) if (k !== "day" && LEAN_COLORS[k] !== undefined) keysInData.add(k);
                    }
                    // Preferred order: 3-tier buckets first, then any 5-tier labels that slipped through
                    const ordered = ["left", "center", "right", "Solid Dem", "Lean Dem", "Tossup", "Lean Rep", "Solid Rep"].filter(k => keysInData.has(k));
                    return ordered.map(l => (
                      <Bar key={l} dataKey={l} stackId="lean" fill={LEAN_COLORS[l]} />
                    ));
                  })()}
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Live Messages */}
            {data.live_messages?.length > 0 && (
              <div style={{ padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", maxHeight: 200, overflow: "auto" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 6 }}>
                  {t("predevodash.log.title")}
                </div>
                {data.live_messages.map((m: any, i: number) => (
                  <div key={i} style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-cjk)", padding: "2px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                    {m}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Transform recording steps into dashboard-compatible format ── */
function transformSteps(steps: any[], recMeta?: any): any {
  if (!steps.length) return null;

  const _leanDisplay: Record<string, string> = {
    // Map any raw agent leaning label → 3-tier bucket
    "Solid Dem": "left", "Lean Dem": "left",
    "Tossup": "center",
    "Lean Rep": "right", "Solid Rep": "right",
    // Legacy CJK labels (pre-1.9 data compat)
    "偏綠": "left", "偏藍": "right", "偏白": "center",
    "中立": "center", "偏左派": "left", "偏右派": "right",
  };

  const daily_trends: any[] = [];
  const leaning_trends: any[] = [];
  const candidate_trends: any[] = [];
  const awareness_trends: any[] = [];
  const sentiment_trends: any[] = [];
  const district_daily_trends: Record<string, any[]> = {};
  const district_leaning_trends: Record<string, any[]> = {};
  let latestDistrictStats: Record<string, any> = {};
  const allMessages: string[] = [];
  const candidateSet = new Set<string>();

  for (const step of steps) {
    const day = step.day || 0;
    const agg = step.aggregate || {};
    const agents = step.agents || [];

    // Daily trend
    daily_trends.push({
      day,
      local_satisfaction: round(agg.avg_local_satisfaction),
      national_satisfaction: round(agg.avg_national_satisfaction),
      anxiety: round(agg.avg_anxiety),
      agent_count: agg.entries_count || agents.length,
    });

    // Leaning trend (from step.leanings or compute from agents)
    const leanRow: Record<string, number> = { day };
    if (step.leanings) {
      for (const [lean, info] of Object.entries(step.leanings as Record<string, any>)) {
        const display = _leanDisplay[lean] || lean;
        leanRow[display] = (leanRow[display] || 0) + (info.count || 0);
      }
    } else {
      for (const a of agents) {
        const display = _leanDisplay[a.political_leaning] || a.political_leaning || "center";
        leanRow[display] = (leanRow[display] || 0) + 1;
      }
    }
    leaning_trends.push(leanRow);

    // Per-district aggregation
    const districtAgents: Record<string, any[]> = {};
    for (const a of agents) {
      const dist = a.district || "未知";
      if (!districtAgents[dist]) districtAgents[dist] = [];
      districtAgents[dist].push(a);
    }

    for (const [dist, das] of Object.entries(districtAgents)) {
      if (!district_daily_trends[dist]) district_daily_trends[dist] = [];
      const n = das.length;
      district_daily_trends[dist].push({
        day,
        local_satisfaction: round(das.reduce((s, a) => s + (a.local_satisfaction || 50), 0) / n),
        national_satisfaction: round(das.reduce((s, a) => s + (a.national_satisfaction || 50), 0) / n),
        anxiety: round(das.reduce((s, a) => s + (a.anxiety || 50), 0) / n),
        agent_count: n,
      });

      if (!district_leaning_trends[dist]) district_leaning_trends[dist] = [];
      const dlRow: Record<string, number> = { day };
      for (const a of das) {
        const display = _leanDisplay[a.political_leaning] || a.political_leaning || "center";
        dlRow[display] = (dlRow[display] || 0) + 1;
      }
      district_leaning_trends[dist].push(dlRow);
    }

    // Build district stats from latest step
    if (step === steps[steps.length - 1]) {
      for (const [dist, das] of Object.entries(districtAgents)) {
        const n = das.length;
        const leanings: Record<string, number> = {};
        for (const a of das) {
          const display = _leanDisplay[a.political_leaning] || a.political_leaning || "center";
          leanings[display] = (leanings[display] || 0) + 1;
        }
        latestDistrictStats[dist] = {
          count: n,
          avg_local_satisfaction: round(das.reduce((s, a) => s + (a.local_satisfaction || 50), 0) / n),
          avg_national_satisfaction: round(das.reduce((s, a) => s + (a.national_satisfaction || 50), 0) / n),
          avg_anxiety: round(das.reduce((s, a) => s + (a.anxiety || 50), 0) / n),
          leanings,
        };
      }
    }

    // ── Candidate per-day data (support / awareness / sentiment) ──
    const dr = step.day_record || {};
    // Support: prefer weighted combined group, else first group, else candidate_estimate
    const groupEst = dr.group_estimates || {};
    let candRow: Record<string, any> | null = null;
    if (groupEst.__weighted_combined__) candRow = groupEst.__weighted_combined__;
    else {
      const firstKey = Object.keys(groupEst).find(k => !k.startsWith("__"));
      if (firstKey) candRow = groupEst[firstKey];
    }
    if (!candRow && dr.candidate_estimate) candRow = dr.candidate_estimate;
    if (candRow) {
      const row: any = { day };
      for (const [name, val] of Object.entries(candRow)) {
        if (name === "Undecided" || name === "未表態") continue;
        const v = typeof val === "number" ? val : (val as any)?.pct ?? 0;
        row[name] = round(v as number);
        candidateSet.add(name);
      }
      candidate_trends.push(row);
    }
    // Awareness / sentiment: from candidate_awareness_summary[name].__all__
    // Backend stores awareness on 0..1 scale → display as percentage.
    // Sentiment on roughly -1..1 scale.
    const caws = step.candidate_awareness_summary || dr.candidate_awareness_summary || {};
    if (caws && Object.keys(caws).length > 0) {
      const awRow: any = { day };
      const snRow: any = { day };
      for (const [name, info] of Object.entries(caws as Record<string, any>)) {
        const all = info?.__all__ || info?.all || info;
        if (!all) continue;
        if (typeof all.avg_awareness === "number") awRow[name] = round(all.avg_awareness * 100);
        if (typeof all.avg_sentiment === "number") snRow[name] = round(all.avg_sentiment * 100);
        candidateSet.add(name);
      }
      if (Object.keys(awRow).length > 1) awareness_trends.push(awRow);
      if (Object.keys(snRow).length > 1) sentiment_trends.push(snRow);
    }

    // Collect messages
    for (const m of (step.live_messages || [])) {
      const text = typeof m === "string" ? m : m.text || "";
      if (text) allMessages.push(text);
    }
  }

  const lastStep = steps[steps.length - 1];
  const totalAgents = lastStep?.aggregate?.entries_count || lastStep?.agents?.length || 0;

  // Build candidate final vote share from last trend row
  const candidateNames = Array.from(candidateSet);
  const finalCandRow = candidate_trends[candidate_trends.length - 1] || {};
  const finalVote: { name: string; pct: number }[] = candidateNames
    .map(n => ({ name: n, pct: Number(finalCandRow[n] || 0) }))
    .sort((a, b) => b.pct - a.pct);
  let winner: any = null;
  if (finalVote.length >= 1 && finalVote[0].pct > 0) {
    const margin = finalVote.length >= 2 ? finalVote[0].pct - finalVote[1].pct : finalVote[0].pct;
    winner = {
      name: finalVote[0].name,
      pct: finalVote[0].pct,
      runner_up: finalVote[1]?.name || "",
      runner_up_pct: finalVote[1]?.pct || 0,
      margin: round(margin),
    };
  }

  return {
    status: "completed",
    daily_trends,
    leaning_trends,
    candidate_trends,
    awareness_trends,
    sentiment_trends,
    candidate_names: candidateNames,
    final_vote: finalVote,
    winner,
    district_stats: latestDistrictStats,
    district_daily_trends,
    district_leaning_trends,
    agent_count: totalAgents,
    live_messages: allMessages.slice(-30),
    recording_title: recMeta?.title || "",
  };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
