"use client";

import { useState, useEffect } from "react";
import { listRecordings, getPlaybackSteps } from "@/lib/api";
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
  const _wsId = useShellStore((s) => s.activeWorkspaceId);
  const workflowStatus = useWorkflowStatus(_wsId);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<any[]>([]);
  const [selectedRecId, setSelectedRecId] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const res = await listRecordings();
        const predRecs = (res.recordings || [])
          .filter((r: any) => r.type === "prediction" && r.status === "completed")
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

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-faint)" }}>{t("predevodash.loading")}</div>;
  if (!data || !data.daily_trends?.length) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <span style={{ fontSize: 32 }}>📊</span>
        <p style={{ color: "var(--text-faint)", fontFamily: "var(--font-cjk)", fontSize: 13 }}>
          {t("predevodash.empty")}
        </p>
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
                  {Object.keys(LEAN_COLORS).map(l => (
                    <Bar key={l} dataKey={l} stackId="lean" fill={LEAN_COLORS[l]} />
                  ))}
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
  const district_daily_trends: Record<string, any[]> = {};
  const district_leaning_trends: Record<string, any[]> = {};
  let latestDistrictStats: Record<string, any> = {};
  const allMessages: string[] = [];

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

    // Collect messages
    for (const m of (step.live_messages || [])) {
      const text = typeof m === "string" ? m : m.text || "";
      if (text) allMessages.push(text);
    }
  }

  const lastStep = steps[steps.length - 1];
  const totalAgents = lastStep?.aggregate?.entries_count || lastStep?.agents?.length || 0;

  return {
    status: "completed",
    daily_trends,
    leaning_trends,
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
