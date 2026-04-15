"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getEvolutionDashboard, analyzeEvolution, apiFetch } from "@/lib/api";
import USMap from "@/components/USMap";
import { useTr } from "@/lib/i18n";
import { useLocaleStore } from "@/store/locale-store";
import { StepGate } from "@/components/shared/StepGate";
import { useWorkflowStatus } from "@/hooks/use-workflow-status";
import { useShellStore } from "@/store/shell-store";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area, BarChart, Bar, Cell, Legend,
} from "recharts";

const LEAN_COLORS: Record<string, string> = {
  // 3-tier aggregate buckets (from evolution dashboard API)
  "left": "#3b82f6",     // Dem-leaning = blue
  "center": "#94a3b8",   // Tossup = slate
  "right": "#ef4444",    // Rep-leaning = red
  // 5-tier per-agent labels (used in agent inspector / per-agent displays)
  "Solid Dem": "#1e40af", "Lean Dem": "#3b82f6",
  "Tossup": "#94a3b8",
  "Lean Rep": "#ef4444", "Solid Rep": "#991b1b",
};
const REL_COLORS: Record<string, string> = { high: "#ef4444", medium: "#f59e0b", low: "#6b7280", none: "#374151" };

function ChartInsight({ text }: { text?: string | Record<string, any> | null }) {
  if (!text) return null;
  // The analyze endpoint sometimes returns a per-candidate dict like
  // {"Kamala Harris": "...", "Donald Trump": "..."} instead of a single
  // string — render each entry on its own line so React doesn't crash on
  // a raw object child.
  const entries: Array<[string | null, string]> = [];
  if (typeof text === "string") {
    entries.push([null, text]);
  } else if (typeof text === "object") {
    for (const [k, v] of Object.entries(text)) {
      if (v == null) continue;
      entries.push([k, typeof v === "string" ? v : JSON.stringify(v)]);
    }
  }
  if (entries.length === 0) return null;
  return (
    <div style={{
      marginTop: 6, padding: "6px 10px", borderRadius: 6,
      background: "rgba(139,92,246,0.04)", borderLeft: "2px solid rgba(139,92,246,0.3)",
      fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.6,
    }}>
      {entries.map(([label, body], i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span style={{ color: "#a78bfa", fontSize: 10, flexShrink: 0 }}>💡</span>
          <span>
            {label && <strong style={{ color: "var(--text-secondary)", marginRight: 4 }}>{label}:</strong>}
            {body}
          </span>
        </div>
      ))}
    </div>
  );
}
const tooltipStyle = { background: "var(--bg-sidebar)", border: "1px solid var(--border-subtle)", borderRadius: 8, fontSize: 11, color: "var(--text-primary)" };

export default function EvolutionDashboardPanel({ wsId }: { wsId: string }) {
  const _wsId = useShellStore((s) => s.activeWorkspaceId);
  const workflowStatus = useWorkflowStatus(_wsId);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null);
  const [crossTabDim, setCrossTabDim] = useState<string>("age_group");
  const [crossTabMetric, setCrossTabMetric] = useState<string>("count");
  const t = useTr();
  const en = useLocaleStore((s) => s.locale) === "en";
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // AI Analysis state — accumulated per 10-day period, cached in sessionStorage
  const ANALYSIS_INTERVAL = 5;
  const cacheKey = `evo_analysis_${_wsId || "default"}`;
  const resetKey = `evo_reset_${_wsId || "default"}`;
  // Invalidate stale cache: if QuickStart wrote a newer reset timestamp, discard old analysis
  const _initCache = (() => {
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const lastReset = parseInt(sessionStorage.getItem(resetKey) || "0");
      if (lastReset > 0 && (parsed.savedAt || 0) < lastReset) return {}; // stale — discard
      return parsed;
    } catch { return {}; }
  })();
  const [analysisSegments, setAnalysisSegments] = useState<{ dayRange: string; data: Record<string, string | null> }[]>(_initCache.segments || []);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const lastAnalyzedDayRef = useRef<number>(_initCache.lastDay || 0);

  const requestAnalysis = useCallback(async (dashData: any, fromDay: number, toDay: number) => {
    if (analysisLoading) return;
    const allTrends = dashData.daily_trends || [];
    const allLean = dashData.leaning_trends || [];
    const allCand = dashData.candidate_trends || [];
    // Slice the window for this 10-day segment
    const windowTrends = allTrends.filter((d: any) => d.day >= fromDay && d.day <= toDay);
    const windowLean = allLean.filter((d: any) => d.day >= fromDay && d.day <= toDay);
    const windowCand = allCand.filter((d: any) => d.day >= fromDay && d.day <= toDay);
    if (!windowTrends.length) return;

    setAnalysisLoading(true);
    try {
      const result = await analyzeEvolution({
        daily_trends: windowTrends,
        leaning_trends: windowLean,
        candidate_trends: windowCand,
        candidate_names: dashData.tracked_candidate_names || [],
        agent_count: dashData.agent_count || 0,
        locale: en ? "en" : "zh-TW",
        period_label: `Day ${fromDay}–${toDay}`,
      });
      const label = fromDay === toDay ? `Day ${fromDay}` : `Day ${fromDay}–${toDay}`;
      setAnalysisSegments((prev) => {
        const updated = [...prev, { dayRange: label, data: result }];
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ segments: updated, lastDay: toDay, savedAt: Date.now() })); } catch {}
        return updated;
      });
      lastAnalyzedDayRef.current = toDay;
    } catch (e) {
      console.warn("Analysis failed:", e);
    } finally {
      setAnalysisLoading(false);
    }
  }, [en, analysisLoading]);

  const fetchData = async () => {
    try {
      const d = await getEvolutionDashboard();
      setData(d);
      setLoading(false);

      // Auto-poll if running
      if (d.status === "running" && !pollRef.current) {
        pollRef.current = setInterval(async () => {
          try {
            const updated = await getEvolutionDashboard();
            setData(updated);
            if (updated.status !== "running") {
              if (pollRef.current) clearInterval(pollRef.current);
              pollRef.current = null;
            }
          } catch { }
        }, 5000);
      }
    } catch { setLoading(false); }
  };

  useEffect(() => {
    fetchData();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Auto-trigger analysis every ANALYSIS_INTERVAL days or when evolution completes
  useEffect(() => {
    if (!data?.daily_trends?.length) return;
    const dayCount = data.daily_trends.length;
    const maxDay = Math.max(...data.daily_trends.map((d: any) => d.day || 0));
    const isDone = data.status !== "running";

    // Detect evolution reset: if current max day is less than what we already analyzed,
    // the evolution history was cleared — discard stale analysis segments
    if (lastAnalyzedDayRef.current > 0 && maxDay < lastAnalyzedDayRef.current) {
      setAnalysisSegments([]);
      lastAnalyzedDayRef.current = 0;
      try { sessionStorage.removeItem(cacheKey); } catch {}
      return;
    }

    // Determine next analysis milestone
    const nextMilestone = Math.ceil((lastAnalyzedDayRef.current + 1) / ANALYSIS_INTERVAL) * ANALYSIS_INTERVAL;
    const shouldAnalyze =
      // Hit a 10-day milestone
      (dayCount >= nextMilestone && nextMilestone > lastAnalyzedDayRef.current) ||
      // Evolution finished (or viewing completed run) — analyze remaining unanalyzed days
      (isDone && dayCount > lastAnalyzedDayRef.current);

    if (shouldAnalyze) {
      const fromDay = lastAnalyzedDayRef.current + 1;
      const toDay = dayCount;
      requestAnalysis(data, fromDay, toDay);
    }
  }, [data, requestAnalysis]);

  if (workflowStatus.evolution === "locked") {
    return (
      <StepGate
        requiredStep={1}
        requiredStepName={en ? "Persona Generation" : "人設生成"}
        requiredStepNameEn="Persona"
        description={en ? "Generate Personas in Step 1 before running evolution." : "請先在第 1 步生成 Persona，才能進行演化。"}
        descriptionEn="Generate personas in Step 1 before running evolution."
        targetRoute={_wsId ? `/workspaces/${_wsId}/population-setup` : "/workspaces"}
      />
    );
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-faint)" }}>{en ? "Loading..." : "載入中..."}</div>;
  if (!data || !data.daily_trends?.length) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <span style={{ fontSize: 32 }}>📊</span>
        <p style={{ color: "var(--text-faint)", fontFamily: "var(--font-cjk)", fontSize: 13 }}>
          {en ? "No evolution data yet. Start evolution in Quick Start." : "尚無演化資料。請先開始演化。"}
        </p>
      </div>
    );
  }

  const isLive = data.status === "running";
  const allTrends = data.daily_trends || [];
  const allLeanTrends = data.leaning_trends || [];
  const districts = data.district_stats || {};
  const activity = data.recent_activity || [];
  const messages = data.live_messages || [];
  const districtDailyTrends = data.district_daily_trends || {};
  const districtLeaningTrends = data.district_leaning_trends || {};
  const districtDemoStats = data.district_demo_stats || {};

  // Use per-district data when a district is selected
  const trends = selectedDistrict && districtDailyTrends[selectedDistrict]
    ? districtDailyTrends[selectedDistrict] : allTrends;
  const leanTrends = selectedDistrict && districtLeaningTrends[selectedDistrict]
    ? districtLeaningTrends[selectedDistrict] : allLeanTrends;
  const latestDay = trends[trends.length - 1];

  // Map data: district → satisfaction color
  const districtMapData = Object.fromEntries(
    Object.entries(districts).map(([d, s]: [string, any]) => [d, s.count])
  );

  // Filter activity by district
  const filteredActivity = selectedDistrict
    ? activity.filter((a: any) => a.district === selectedDistrict)
    : activity;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "auto" }}>
      <div style={{ padding: "12px clamp(12px, 2vw, 24px)", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ color: "#fff", fontSize: 18, fontWeight: 700, margin: 0, fontFamily: "var(--font-cjk)" }}>
              📊 {t("evodash.title")}
            </h2>
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
              {isLive ? (
                <span style={{ color: "#22c55e" }}>
                  🟢 Day {data.current_day}/{data.total_days}
                  {data.phase && ` (${data.phase})`}
                </span>
              ) : (
                <span>{t("evodash.subtitle", { days: trends.length, agents: data.agent_count })}</span>
              )}
            </span>
          </div>
          {selectedDistrict && (
            <button onClick={() => setSelectedDistrict(null)} style={{
              padding: "4px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600,
              fontFamily: "var(--font-cjk)", border: "1px solid #a78bfa",
              backgroundColor: "rgba(167,139,250,0.12)", color: "#a78bfa", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 4,
            }}>
              ✕ {selectedDistrict}
            </button>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {!isLive && trends.length > 0 && (
              <button
                onClick={async () => {
                  try {
                    const exportData = await apiFetch("/api/pipeline/evolution/export-playback");
                    const { generatePlaybackHTML } = await import("@/lib/export-playback");
                    const html = generatePlaybackHTML({
                      ...exportData,
                      templateName: "",
                      locale: en ? "en" : "zh-TW",
                    });
                    const blob = new Blob([html], { type: "text/html" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `civatas-evolution-playback-${new Date().toISOString().slice(0, 10)}.html`;
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (e) {
                    console.error("Export failed:", e);
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
            <button onClick={fetchData} style={{
              padding: "4px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600,
              fontFamily: "var(--font-cjk)", border: "1px solid var(--border-input)",
              backgroundColor: "transparent", color: "var(--text-secondary)", cursor: "pointer",
            }}>
              {t("evodash.refresh")}
            </button>
          </div>
        </div>

        {/* ── Stats Cards ── */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(() => {
            const ds = selectedDistrict && districts[selectedDistrict];
            const localSat = ds ? ds.avg_local_satisfaction : latestDay?.local_satisfaction;
            const nationalSat = ds ? ds.avg_national_satisfaction : latestDay?.national_satisfaction;
            const anxietyVal = ds ? ds.avg_anxiety : latestDay?.anxiety;
            const agentCount = ds ? ds.count : data.agent_count;
            return [
              { label: t("evodash.stat.local_sat"), value: localSat, color: "#3b82f6" },
              { label: t("evodash.stat.national_sat"), value: nationalSat, color: "#f97316" },
              { label: t("evodash.stat.anxiety"), value: anxietyVal, color: anxietyVal > 60 ? "#ef4444" : "#22c55e" },
              { label: t("evodash.stat.agents"), value: agentCount, color: "#a78bfa" },
              { label: t("evodash.stat.days"), value: trends.length, color: "#94a3b8" },
            ];
          })().map((s, i) => (
            <div key={i} style={{
              flex: "1 1 120px", padding: "10px 14px", borderRadius: 8,
              background: "var(--bg-card)", border: "1px solid var(--border-subtle)", textAlign: "center",
            }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.color, fontFamily: "var(--font-mono)" }}>
                {typeof s.value === "number" ? (s.value % 1 === 0 ? s.value : s.value.toFixed(1)) : "—"}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-cjk)" }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* ── Top Row: Districts overview (left) + AI Analysis (right) ── */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>

          {/* Left: Map or District Grid */}
          <div style={{ flex: "1 1 280px", minWidth: 280, padding: 12, borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
              {t("evodash.districts_title")} {selectedDistrict && <span style={{ color: "#a78bfa" }}>— {selectedDistrict}</span>}
            </div>
            {(() => {
              const districtNames = Object.keys(districts);

              // US workspaces: draw USMap with PA highlighted by default,
              // OR show a flat district grid (county/district list) if there
              // is district-level data.
              if (districtNames.length === 0) {
                return (
                  <USMap
                    mode="states"
                    selectedFeature="42"
                    data={{ "42": 1 }}
                    colorScale={["#1e293b", "#3b82f6"]}
                    width={420}
                    height={260}
                    title={t("evodash.us_state_pa")}
                    valueLabel={t("evodash.us_counties_unit")}
                    showLegend={false}
                  />
                );
              }

              const sorted = districtNames
                .map(d => ({ name: d, ...(districts[d] as any) }))
                .sort((a, b) => b.count - a.count);

              const maxCount = Math.max(...sorted.map(d => d.count), 1);

              // Color based on satisfaction (green=high, red=low)
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
                          minWidth: 56, gap: 2, transition: "all 0.15s",
                        }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: isSelected ? "#c4b5fd" : c.text, fontFamily: "var(--font-cjk)", lineHeight: 1.1, textAlign: "center" }}>
                          {d.name}
                        </span>
                        <span style={{ fontSize: 9, color: isSelected ? "#c4b5fd" : "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                          {t("common.people_count", { n: d.count })}
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

            {/* District detail panel */}
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

          {/* Right: AI Analysis */}
          {(analysisSegments.length > 0 || analysisLoading) && (
          <div style={{
            flex: "1 1 280px", minWidth: 280, padding: "14px 16px", borderRadius: 10,
            background: "linear-gradient(135deg, rgba(139,92,246,0.06), rgba(59,130,246,0.04))",
            border: "1px solid rgba(139,92,246,0.15)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
              <span style={{ fontSize: 14 }}>🧠</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa" }}>
                {en ? "AI Analysis" : "AI 分析"}
                {analysisSegments.length > 0 && (
                  <span style={{ fontWeight: 400, color: "rgba(167,139,250,0.5)", marginLeft: 6 }}>
                    ({analysisSegments.length} {en ? "segments" : "段"})
                  </span>
                )}
              </span>
              {analysisLoading && (
                <span style={{ width: 12, height: 12, border: "2px solid rgba(167,139,250,0.3)", borderTopColor: "#a78bfa", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
              )}
              {analysisSegments.length > 0 && !analysisLoading && (
                <button onClick={() => { setAnalysisSegments([]); lastAnalyzedDayRef.current = 0; try { sessionStorage.removeItem(cacheKey); } catch {} }}
                  style={{ marginLeft: "auto", background: "none", border: "1px solid rgba(139,92,246,0.2)", color: "rgba(167,139,250,0.6)", fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer" }}>
                  {en ? "Clear" : "清除"}
                </button>
              )}
            </div>
            {analysisSegments.map((seg, i) => (
              <div key={i} style={{
                marginBottom: i < analysisSegments.length - 1 ? 12 : 0,
                paddingBottom: i < analysisSegments.length - 1 ? 12 : 0,
                borderBottom: i < analysisSegments.length - 1 ? "1px solid rgba(139,92,246,0.1)" : "none",
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa", marginBottom: 4 }}>
                  📅 {seg.dayRange}
                </div>
                {seg.data.overall && (
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7, margin: "0 0 4px" }}>
                    {seg.data.overall}
                  </p>
                )}
              </div>
            ))}
            {analysisLoading && analysisSegments.length === 0 && (
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
                {en ? "Analyzing evolution trends..." : "分析演化趨勢中..."}
              </p>
            )}
            {analysisLoading && analysisSegments.length > 0 && (
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0 0" }}>
                {en ? "Analyzing next period..." : "分析下一段趨勢中..."}
              </p>
            )}
          </div>
          )}
        </div>

        {/* ── Charts (full width below top row) ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Satisfaction Trend */}
            <div style={{ padding: 12, borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border-subtle)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                {t("evodash.chart.satanx_title")}{selectedDistrict && <span style={{ color: "#a78bfa" }}> — {selectedDistrict}</span>}
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={trends}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={(d) => `D${d}`} />
                  <YAxis domain={["dataMin - 5", "dataMax + 5"]} tick={{ fontSize: 10, fill: "#6b7280" }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Line type="monotone" dataKey="local_satisfaction" stroke="#3b82f6" strokeWidth={2} dot={false} name={t("evodash.chart.local_sat")} />
                  <Line type="monotone" dataKey="national_satisfaction" stroke="#f97316" strokeWidth={2} dot={false} name={t("evodash.chart.national_sat")} />
                  <Line type="monotone" dataKey="anxiety" stroke="#ef4444" strokeWidth={1.5} dot={false} strokeDasharray="4 4" name={t("evodash.chart.anxiety")} />
                  <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-secondary)" }} />
                </LineChart>
              </ResponsiveContainer>
              <ChartInsight text={analysisSegments.length > 0 ? analysisSegments[analysisSegments.length - 1].data.satisfaction_anxiety : null} />
            </div>

            {/* Political Leaning Trend */}
            <div style={{ padding: 12, borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border-subtle)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                {t("evodash.chart.leaning_title")}{selectedDistrict && <span style={{ color: "#a78bfa" }}> — {selectedDistrict}</span>}
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <AreaChart data={leanTrends}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={(d) => `D${d}`} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#6b7280" }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Area type="monotone" dataKey="left" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.6} name={t("evodash.chart.lean_left")} />
                  <Area type="monotone" dataKey="center" stackId="1" stroke="#94a3b8" fill="#94a3b8" fillOpacity={0.4} name={t("evodash.chart.lean_neutral")} />
                  <Area type="monotone" dataKey="right" stackId="1" stroke="#ef4444" fill="#ef4444" fillOpacity={0.6} name={t("evodash.chart.lean_right")} />
                  <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-secondary)" }} />
                </AreaChart>
              </ResponsiveContainer>
              <ChartInsight text={analysisSegments.length > 0 ? analysisSegments[analysisSegments.length - 1].data.political_leaning : null} />
            </div>

            {/* Candidate Tracking Charts */}
            {(() => {
              const breakdown = data.candidate_breakdown || {};
              const trends = (data.candidate_trends || []) as any[];
              const hasTrends = trends.length > 0;
              const hasBreakdown = breakdown && (
                Object.keys(breakdown.overall || {}).length > 0 ||
                Object.keys(breakdown.by_leaning || {}).length > 0
              );
              if (!hasTrends && !hasBreakdown) return null;
              const CAND_COLORS = ["#8b5cf6", "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#ec4899"];
              // Derive candidate names: prefer tracked list → trends → breakdown.overall
              let candNames: string[] = (data.tracked_candidate_names || []) as string[];
              if (candNames.length === 0 && hasBreakdown) {
                candNames = Object.keys(breakdown.overall || {}).filter((k) => k !== "Undecided");
              }
              if (candNames.length === 0) return null;
              const latest = hasTrends ? trends[trends.length - 1] : {};
              const first = hasTrends ? trends[0] : {};
              type CandSummary = { name: string; support: number; supportDelta: number; awareness: number; sentiment: number; color: string };
              const overall = breakdown.overall || {};
              const summaries: CandSummary[] = candNames.map((cn, i) => {
                const supportLatest = (latest[`${cn}_support`] ?? overall[cn] ?? 0) as number;
                const supportFirst = (first[`${cn}_support`] ?? supportLatest) as number;
                return {
                  name: cn,
                  support: supportLatest,
                  supportDelta: supportLatest - supportFirst,
                  awareness: (latest[`${cn}_awareness`] ?? 0) as number,
                  sentiment: (latest[`${cn}_sentiment`] ?? 0) as number,
                  color: CAND_COLORS[i % CAND_COLORS.length],
                };
              }).sort((a, b) => b.support - a.support);
              const undecided = (latest["Undecided_support"] ?? overall["Undecided"] ?? null) as number | null;

              const renderBreakdown = (title: string, acc: Record<string, Record<string, number>>) => {
                const groups = Object.keys(acc || {}).filter((g) => g !== "_count");
                if (!groups.length) return null;
                // sort groups by total sample count desc if present; else by first candidate's share
                const rows = groups.map((g) => ({
                  name: g,
                  ...Object.fromEntries(candNames.map((cn) => [cn, (acc[g] as any)?.[cn] ?? 0])),
                }));
                const isManyGroups = rows.length > 6;
                return (
                  <div style={{ padding: 12, borderRadius: 8, background: "rgba(139,92,246,0.03)", border: "1px solid rgba(139,92,246,0.12)" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>{title}</div>
                    <ResponsiveContainer width="100%" height={Math.max(140, rows.length * (isManyGroups ? 20 : 28))}>
                      <BarChart data={rows} layout="vertical" margin={{ left: 70, right: 20 }} stackOffset="expand">
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                        <XAxis type="number" domain={[0, 1]} tick={{ fontSize: 9, fill: "#6b7280" }} tickFormatter={(v: any) => `${Math.round(v * 100)}%`} />
                        <YAxis dataKey="name" type="category" tick={{ fontSize: 9, fill: "#9ca3af" }} width={70} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => `${Number(v).toFixed(1)}%`} />
                        {candNames.map((cn, i) => (
                          <Bar key={cn} dataKey={cn} stackId="s" fill={CAND_COLORS[i % CAND_COLORS.length]} />
                        ))}
                        <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-secondary)" }} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                );
              };

              return (
                <>
                  {/* Candidate Summary Card (A) */}
                  <div style={{ padding: 12, borderRadius: 8, background: "rgba(139,92,246,0.05)", border: "1px solid rgba(139,92,246,0.2)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa", fontFamily: "var(--font-cjk)", marginBottom: 10 }}>
                      {t("evodash.cand.summary_title")}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "32px 1fr 80px 80px 80px 80px", gap: 6, fontSize: 10, color: "var(--text-faint)", padding: "4px 8px", borderBottom: "1px solid var(--border-subtle)" }}>
                      <span>{t("evodash.cand.col_rank")}</span>
                      <span>{t("evodash.cand.col_name")}</span>
                      <span style={{ textAlign: "right" }}>{t("evodash.cand.col_support")}</span>
                      <span style={{ textAlign: "right" }}>{t("evodash.cand.col_delta")}</span>
                      <span style={{ textAlign: "right" }}>{t("evodash.cand.col_awareness")}</span>
                      <span style={{ textAlign: "right" }}>{t("evodash.cand.col_sentiment")}</span>
                    </div>
                    {summaries.map((s, i) => {
                      const deltaColor = s.supportDelta > 0.5 ? "#22c55e" : s.supportDelta < -0.5 ? "#ef4444" : "var(--text-muted)";
                      const deltaArrow = s.supportDelta > 0.5 ? "▲" : s.supportDelta < -0.5 ? "▼" : "—";
                      const sentColor = s.sentiment > 0.1 ? "#22c55e" : s.sentiment < -0.1 ? "#ef4444" : "var(--text-muted)";
                      return (
                        <div key={s.name} style={{ display: "grid", gridTemplateColumns: "32px 1fr 80px 80px 80px 80px", gap: 6, fontSize: 11, padding: "8px", alignItems: "center", borderBottom: "1px solid var(--border-subtle)" }}>
                          <span style={{ fontWeight: 700, color: i === 0 ? "#fbbf24" : "var(--text-secondary)" }}>#{i + 1}</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-cjk)" }}>
                            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: s.color }} />
                            <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{s.name}</span>
                          </span>
                          <span style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text-primary)" }}>{s.support.toFixed(1)}%</span>
                          <span style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: deltaColor }}>
                            {deltaArrow} {Math.abs(s.supportDelta).toFixed(1)}
                          </span>
                          <span style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{(s.awareness * 100).toFixed(0)}%</span>
                          <span style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: sentColor }}>{s.sentiment >= 0 ? "+" : ""}{s.sentiment.toFixed(2)}</span>
                        </div>
                      );
                    })}
                    {undecided !== null && (
                      <div style={{ display: "grid", gridTemplateColumns: "32px 1fr 80px 80px 80px 80px", gap: 6, fontSize: 11, padding: "8px", alignItems: "center", color: "var(--text-muted)" }}>
                        <span>—</span>
                        <span style={{ fontFamily: "var(--font-cjk)", fontStyle: "italic" }}>{t("evodash.cand.undecided")}</span>
                        <span style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{Number(undecided).toFixed(1)}%</span>
                        <span /><span /><span />
                      </div>
                    )}
                  </div>

                  {/* Candidate Support Trend */}
                  {hasTrends && (
                  <div style={{ padding: 12, borderRadius: 8, background: "rgba(139,92,246,0.03)", border: "1px solid rgba(139,92,246,0.12)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                      {t("evodash.cand.support_title")}
                    </div>
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={data.candidate_trends}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                        <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={(d: any) => `D${d}`} />
                        <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={(v: any) => `${Number(v).toFixed(0)}%`} padding={{ top: 10, bottom: 10 }} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => `${Number(v).toFixed(1)}%`} />
                        {candNames.map((cn: string, i: number) => (
                          <Line key={cn} type="monotone" dataKey={`${cn}_support`} stroke={CAND_COLORS[i % CAND_COLORS.length]} strokeWidth={2} dot={false} name={t("evodash.cand.support_suffix", { name: cn })} />
                        ))}
                        <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-secondary)" }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  )}

                  {/* Candidate Awareness Trend */}
                  {hasTrends && (() => {
                    const allZero = trends.every((row: any) =>
                      candNames.every((cn: string) => !row[`${cn}_awareness`])
                    );
                    return (
                    <div style={{ padding: 12, borderRadius: 8, background: "rgba(139,92,246,0.03)", border: "1px solid rgba(139,92,246,0.12)" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                        {t("evodash.cand.awareness_title")}
                      </div>
                      {allZero ? (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "16px 0", textAlign: "center" }}>
                          {en
                            ? "No awareness data — candidate names were not tracked in this run. Use a template with specific candidates (e.g. 2028) to enable mention tracking."
                            : "無候選人知名度資料 — 本次演化未追蹤候選人名字。請使用含特定候選人的模板（如 2028）以啟用追蹤。"}
                        </div>
                      ) : (
                        <ResponsiveContainer width="100%" height={160}>
                          <LineChart data={data.candidate_trends}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                            <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={(d: any) => `D${d}`} />
                            <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={(v: any) => `${Math.round(v * 100)}%`} padding={{ top: 10, bottom: 10 }} />
                            <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => `${(v * 100).toFixed(0)}%`} />
                            {candNames.map((cn: string, i: number) => (
                              <Line key={cn} type="monotone" dataKey={`${cn}_awareness`} stroke={CAND_COLORS[i % CAND_COLORS.length]} strokeWidth={2} dot={false} name={t("evodash.cand.awareness_suffix", { name: cn })} />
                            ))}
                            <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-secondary)" }} />
                          </LineChart>
                        </ResponsiveContainer>
                      )}
                      <ChartInsight text={analysisSegments.length > 0 ? analysisSegments[analysisSegments.length - 1].data.candidate_awareness : null} />
                    </div>
                    );
                  })()}

                  {/* Candidate Sentiment Trend */}
                  {hasTrends && (
                  <div style={{ padding: 12, borderRadius: 8, background: "rgba(139,92,246,0.03)", border: "1px solid rgba(139,92,246,0.12)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                      {t("evodash.cand.sentiment_title")}
                    </div>
                    <ResponsiveContainer width="100%" height={160}>
                      <LineChart data={data.candidate_trends}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                        <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={(d: any) => `D${d}`} />
                        <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#6b7280" }} padding={{ top: 10, bottom: 10 }} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => v.toFixed(2)} />
                        {candNames.map((cn: string, i: number) => (
                          <Line key={cn} type="monotone" dataKey={`${cn}_sentiment`} stroke={CAND_COLORS[i % CAND_COLORS.length]} strokeWidth={2} dot={false} name={t("evodash.cand.sentiment_suffix", { name: cn })} />
                        ))}
                        {/* Zero line */}
                        <Line type="monotone" dataKey={() => 0} stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="4 4" dot={false} name="" legendType="none" />
                        <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-secondary)" }} />
                      </LineChart>
                    </ResponsiveContainer>
                    <ChartInsight text={analysisSegments.length > 0 ? analysisSegments[analysisSegments.length - 1].data.candidate_sentiment : null} />
                  </div>
                  )}

                  {/* Candidate Support Breakdown (B) */}
                  {(breakdown.by_leaning || breakdown.by_gender || breakdown.by_district) && (
                    <div style={{ padding: 12, borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border-subtle)" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 10 }}>
                        {t("evodash.cand.breakdown_title")}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
                        {renderBreakdown(t("evodash.cand.breakdown_by_leaning"), breakdown.by_leaning || {})}
                        {renderBreakdown(t("evodash.cand.breakdown_by_gender"), breakdown.by_gender || {})}
                        {renderBreakdown(t("evodash.cand.breakdown_by_district"), breakdown.by_district || {})}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}

            {/* District Bar Chart */}
            {Object.keys(districts).length > 1 && (
              <div style={{ padding: 12, borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border-subtle)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                  {t("evodash.section.district_sat")}{selectedDistrict && <span style={{ color: "#a78bfa" }}> — {selectedDistrict}</span>}
                </div>
                <ResponsiveContainer width="100%" height={Math.max(120, Object.keys(districts).length * 22)}>
                  <BarChart
                    data={Object.entries(districts)
                      .map(([d, s]: [string, any]) => ({
                        name: d, local: s.avg_local_satisfaction, national: s.avg_national_satisfaction, anxiety: s.avg_anxiety,
                      }))
                      .sort((a, b) => b.local - a.local)}
                    layout="vertical"
                    margin={{ left: 50 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 9, fill: "#6b7280" }} />
                    <YAxis dataKey="name" type="category" tick={({ x, y, payload }: any) => (
                      <text x={x} y={y} dy={4} textAnchor="end" fontSize={9} fontWeight={selectedDistrict === payload.value ? 700 : 400}
                        fill={selectedDistrict === payload.value ? "#a78bfa" : "#9ca3af"}>{payload.value}</text>
                    )} width={50} />
                    <Tooltip contentStyle={tooltipStyle} itemStyle={{ color: "var(--text-primary)" }} labelStyle={{ color: "var(--text-primary)", fontWeight: 700 }} />
                    <Bar dataKey="local" name={t("evodash.chart.local_governance")} fill="#3b82f6" barSize={8} radius={[0, 3, 3, 0]}>
                      {Object.entries(districts)
                        .map(([d]: [string, any]) => d)
                        .sort((a, b) => (districts[b] as any).avg_local_satisfaction - (districts[a] as any).avg_local_satisfaction)
                        .map((d, i) => (
                          <Cell key={i} fill={selectedDistrict === d ? "#60a5fa" : selectedDistrict ? "rgba(59,130,246,0.25)" : "#3b82f6"} />
                        ))}
                    </Bar>
                    <Bar dataKey="national" name={t("evodash.chart.federal_governance")} fill="#f97316" barSize={8} radius={[0, 3, 3, 0]}>
                      {Object.entries(districts)
                        .map(([d]: [string, any]) => d)
                        .sort((a, b) => (districts[b] as any).avg_local_satisfaction - (districts[a] as any).avg_local_satisfaction)
                        .map((d, i) => (
                          <Cell key={i} fill={selectedDistrict === d ? "#fb923c" : selectedDistrict ? "rgba(249,115,22,0.25)" : "#f97316"} />
                        ))}
                    </Bar>
                    <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-secondary)" }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
        </div>

        {/* ── Demographic Stats ── */}
        {data.demo_stats && Object.values(data.demo_stats).some((v: any) => Object.keys(v).length > 0) && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {[
              { key: "gender", label: t("evodash.section.gender") },
              { key: "education", label: t("evodash.section.education") },
              { key: "occupation", label: t("evodash.section.occupation") },
            ].map(({ key, label }) => {
              const demoSource = selectedDistrict && districtDemoStats[selectedDistrict]
                ? districtDemoStats[selectedDistrict] : data.demo_stats;
              const stats = demoSource[key] || {};
              const entries = Object.entries(stats).sort((a: any, b: any) => b[1] - a[1]);
              if (entries.length === 0) return null;
              const max = Math.max(...entries.map((e: any) => e[1]), 1);
              const total = entries.reduce((s: number, e: any) => s + e[1], 0);
              return (
                <div key={key} style={{ flex: "1 1 200px", minWidth: 200, padding: 12, borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border-subtle)" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 6 }}>{label}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {entries.slice(0, 8).map(([name, count]: any) => (
                      <div key={name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ minWidth: 55, fontSize: 10, fontFamily: "var(--font-cjk)", color: "var(--text-muted)", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                        <div style={{ flex: 1, height: 8, borderRadius: 3, background: "var(--bg-input)", overflow: "hidden" }}>
                          <div style={{ height: "100%", borderRadius: 3, width: `${(count / max) * 100}%`, background: "#a78bfa", opacity: 0.7 }} />
                        </div>
                        <span style={{ minWidth: 35, fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-faint)", textAlign: "right" }}>
                          {count} ({((count / total) * 100).toFixed(0)}%)
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Cross-tabulation Charts ── */}
        {data.cross_tabs && Object.keys(data.cross_tabs).length > 0 && (() => {
          const dimLabels: Record<string, string> = {
            age_group: t("evodash.cross.dim.age_group"),
            gender: t("evodash.cross.dim.gender"),
            occupation: t("evodash.cross.dim.occupation"),
            education: t("evodash.cross.dim.education"),
            district: t("evodash.cross.dim.district"),
          };
          const metricLabels: Record<string, string> = {
            count: t("evodash.cross.metric.count"),
            avg_local_sat: t("evodash.cross.metric.local_sat"),
            avg_national_sat: t("evodash.cross.metric.national_sat"),
            avg_anxiety: t("evodash.cross.metric.anxiety"),
          };
          const metricKeys: Record<string, { left: string; neutral: string; right: string }> = {
            count: { left: "left_count", neutral: "neutral_count", right: "right_count" },
            avg_local_sat: { left: "left_local_sat", neutral: "neutral_local_sat", right: "right_local_sat" },
            avg_national_sat: { left: "left_national_sat", neutral: "neutral_national_sat", right: "right_national_sat" },
            avg_anxiety: { left: "left_anxiety", neutral: "neutral_anxiety", right: "right_anxiety" },
          };
          const rows = data.cross_tabs[crossTabDim] || [];
          const mk = metricKeys[crossTabMetric] || metricKeys.count;
          const isCount = crossTabMetric === "count";

          return (
            <div style={{ padding: 12, borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border-subtle)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)" }}>
                  {t("evodash.section.cross_analysis")}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {Object.entries(dimLabels).map(([k, v]) => (
                    <button key={k} onClick={() => setCrossTabDim(k)}
                      style={{
                        padding: "3px 8px", borderRadius: 4, fontSize: 10, cursor: "pointer", fontFamily: "var(--font-cjk)",
                        border: crossTabDim === k ? "1px solid #a78bfa" : "1px solid var(--border-input)",
                        background: crossTabDim === k ? "rgba(167,139,250,0.15)" : "transparent",
                        color: crossTabDim === k ? "#a78bfa" : "var(--text-faint)",
                      }}>
                      {v}
                    </button>
                  ))}
                  <span style={{ width: 1, background: "var(--border-input)", margin: "0 2px" }} />
                  {Object.entries(metricLabels).map(([k, v]) => (
                    <button key={k} onClick={() => setCrossTabMetric(k)}
                      style={{
                        padding: "3px 8px", borderRadius: 4, fontSize: 10, cursor: "pointer", fontFamily: "var(--font-cjk)",
                        border: crossTabMetric === k ? "1px solid #f59e0b" : "1px solid var(--border-input)",
                        background: crossTabMetric === k ? "rgba(245,158,11,0.15)" : "transparent",
                        color: crossTabMetric === k ? "#f59e0b" : "var(--text-faint)",
                      }}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              {rows.length > 0 ? (
                <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 32 + 40)}>
                  <BarChart data={rows} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} domain={isCount ? [0, "auto"] : [0, 100]} />
                    <YAxis type="category" dataKey="label" width={70} tick={{ fontSize: 10, fill: "#9ca3af", fontFamily: "var(--font-cjk)" }} />
                    <Tooltip contentStyle={{ ...tooltipStyle, fontFamily: "var(--font-cjk)" }}
                      formatter={(val: any, name: string) => [isCount ? `${val}` : `${val}`, name]} />
                    <Legend wrapperStyle={{ fontSize: 10, fontFamily: "var(--font-cjk)", color: "var(--text-secondary)" }} />
                    <Bar dataKey={mk.left} name={t("evodash.chart.lean_left")} fill="#3b82f6" radius={[0, 3, 3, 0]} barSize={8} />
                    <Bar dataKey={mk.neutral} name={t("evodash.chart.lean_neutral")} fill="#94a3b8" radius={[0, 3, 3, 0]} barSize={8} />
                    <Bar dataKey={mk.right} name={t("evodash.chart.lean_right")} fill="#ef4444" radius={[0, 3, 3, 0]} barSize={8} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p style={{ textAlign: "center", color: "var(--text-faint)", fontSize: 11, padding: 20 }}>{t("evodash.cross.no_data")}</p>
              )}
            </div>
          );
        })()}

        {/* ── Agent Activity Feed ── */}
        <div style={{ padding: 12, borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border-subtle)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
            {t("evodash.section.activity_feed")}{selectedDistrict && <span style={{ color: "#a78bfa" }}> — {selectedDistrict} ({filteredActivity.length})</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflow: "auto" }}>
            {(filteredActivity.length > 0 ? filteredActivity : activity).slice(0, 30).map((a: any, i: number) => (
              <div key={i} style={{
                padding: "8px 12px", borderRadius: 6,
                background: "var(--bg-card)", border: "1px solid var(--border-subtle)",
                display: "flex", gap: 10, alignItems: "flex-start",
              }}>
                <div style={{ minWidth: 55, textAlign: "center" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#a78bfa", fontFamily: "var(--font-mono)" }}>#{a.agent_id}</div>
                  <div style={{ fontSize: 8, color: LEAN_COLORS[a.leaning] || "#9ca3af" }}>{a.leaning}</div>
                  {(a.district || a.gender || a.age) && (
                    <div style={{ fontSize: 7, color: "var(--text-faint)", marginTop: 2, lineHeight: 1.3 }}>
                      {a.district && <div>{a.district}</div>}
                      {(a.gender || a.age) && <div>{a.gender}{a.age ? ` ${a.age}歲` : ""}</div>}
                      {a.occupation && <div>{a.occupation}</div>}
                    </div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", lineHeight: 1.5 }}>
                    {a.diary || (en ? "(no diary)" : "（無日記）")}
                  </div>
                  {a.news_titles?.length > 0 && (
                    <div style={{ fontSize: 9, color: "var(--text-faint)", marginTop: 2 }}>
                      📰 {a.news_titles.slice(0, 2).join(" / ")}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0, fontSize: 10, fontFamily: "var(--font-mono)" }}>
                  <span title={`Local Satisfaction: ${a.local_satisfaction}/100\n${a.local_satisfaction > 60 ? "✅ Satisfied" : a.local_satisfaction > 40 ? "➖ Neutral" : "❌ Dissatisfied"} — Governor / Mayor / state government`} style={{ color: "#3b82f6", cursor: "help" }}>L:{a.local_satisfaction}</span>
                  <span title={`National Satisfaction: ${a.national_satisfaction}/100\n${a.national_satisfaction > 60 ? "✅ Satisfied" : a.national_satisfaction > 40 ? "➖ Neutral" : "❌ Dissatisfied"} — President / Congress / federal policy`} style={{ color: "#f97316", cursor: "help" }}>N:{a.national_satisfaction}</span>
                  <span title={`Anxiety: ${a.anxiety}/100\n${a.anxiety > 70 ? "🔴 Highly anxious" : a.anxiety > 50 ? "🟡 Moderate" : "🟢 Calm"} — economy, prices, jobs`} style={{ color: a.anxiety > 60 ? "#ef4444" : "#6b7280", cursor: "help" }}>A:{a.anxiety}</span>
                  <span title={`Relevance: ${a.relevance}\n${{ high: "🔴 High — news directly impacts this agent", medium: "🟡 Medium", low: "⚪ Low", none: "➖ No relevant news" }[a.relevance] || "unknown"}`} style={{
                    padding: "1px 4px", borderRadius: 3, fontSize: 8, cursor: "help",
                    background: (REL_COLORS[a.relevance] || "#374151") + "22",
                    color: REL_COLORS[a.relevance] || "#6b7280",
                  }}>
                    {a.relevance}
                  </span>
                </div>
              </div>
            ))}
            {activity.length === 0 && (
              <p style={{ textAlign: "center", color: "var(--text-faint)", fontSize: 12, padding: 16 }}>{en ? "No agent activity" : "尚無 Agent 活動"}</p>
            )}
          </div>
        </div>

        {/* ── Live Messages (during evolution) ── */}
        {messages.length > 0 && (
          <div style={{ padding: 12, borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
              {t("live.system_messages")}
            </div>
            <div style={{ maxHeight: 200, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
              {messages.slice().reverse().map((m: any, i: number) => (
                <div key={i} style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-cjk)", padding: "2px 0" }}>
                  <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginRight: 6 }}>
                    {m.ts ? new Date(m.ts * 1000).toLocaleTimeString() : ""}
                  </span>
                  {m.text}
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
