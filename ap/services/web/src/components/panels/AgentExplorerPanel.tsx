"use client";

import { useState, useEffect, useCallback } from "react";
import { getWorkspacePersonas, getAgentDiary, getEvolutionDashboard, apiFetch } from "@/lib/api";
import { useTr, useLocalizePersonaValue } from "@/lib/i18n";
import { StepGate } from "@/components/shared/StepGate";
import { useWorkflowStatus } from "@/hooks/use-workflow-status";
import { useShellStore } from "@/store/shell-store";
import { useLocaleStore } from "@/store/locale-store";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

const LEAN_COLORS: Record<string, string> = {
  // US Cook PVI 5-tier
  "Solid Dem": "#1e40af", "Lean Dem": "#3b82f6", "Tossup": "#94a3b8", "Lean Rep": "#f87171", "Solid Rep": "#dc2626",
  // US (Civatas-USA Stage 1.5+)
  "Solid Dem": "#1e40af", "Lean Dem": "#3b82f6",
  "Tossup": "#94a3b8",
  "Lean Rep": "#ef4444", "Solid Rep": "#991b1b",
};
const CHART_COLORS = ["#a78bfa", "#f59e0b", "#22c55e", "#ef4444", "#3b82f6", "#ec4899"];
const ttStyle = { background: "#1e1e2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11 };

export default function AgentExplorerPanel({ wsId, recordingId = "" }: { wsId: string; recordingId?: string }) {
  const t = useTr();
  const en = useLocaleStore((s) => s.locale) === "en";
  const tp = useLocalizePersonaValue();
  const _wsId = useShellStore((s) => s.activeWorkspaceId);
  const workflowStatus = useWorkflowStatus(_wsId);
  const [agents, setAgents] = useState<any[]>([]);
  const [districts, setDistricts] = useState<Record<string, any>>({});
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [diaries, setDiaries] = useState<Record<number, any[]>>({});
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [agentStates, setAgentStates] = useState<Record<string, any>>({});

  useEffect(() => {
    Promise.all([
      getWorkspacePersonas(wsId).catch(() => ({ agents: [] })),
      getEvolutionDashboard().catch(() => null),
      apiFetch("/api/pipeline/evolution/agents/all-stats").catch(() => ({ agents: {} })),
    ]).then(([p, dash, stats]) => {
      const list = p?.agents || (Array.isArray(p) ? p : []);
      setAgents(list);
      if (dash?.district_stats) setDistricts(dash.district_stats);
      if (stats?.agents) setAgentStates(stats.agents);
      setLoading(false);
    });
  }, [wsId]);

  const loadDiary = useCallback(async (id: number) => {
    if (diaries[id]?.length) return;  // only skip if we have actual entries
    try {
      const d = await getAgentDiary(id, recordingId || undefined);
      setDiaries(prev => ({ ...prev, [id]: d.entries || [] }));
    } catch { }
  }, [diaries, recordingId]);

  const toggleAgent = (id: number) => {
    if (selectedIds.includes(id)) {
      setSelectedIds(prev => prev.filter(x => x !== id));
    } else if (selectedIds.length < 6) {
      setSelectedIds(prev => [...prev, id]);
      loadDiary(id);
    }
  };

  const filteredAgents = selectedDistrict
    ? agents.filter(a => a.district === selectedDistrict)
    : agents;

  // Build chart data
  const chartData: any[] = [];
  if (selectedIds.length > 0) {
    const allDays = new Set<number>();
    for (const id of selectedIds) for (const e of (diaries[id] || [])) allDays.add(e.day);
    for (const day of [...allDays].sort((a, b) => a - b)) {
      const row: any = { day: `D${day}`, _dayNum: day };
      for (const id of selectedIds) {
        const e = (diaries[id] || []).find((x: any) => x.day === day);
        if (e) { row[`sat_${id}`] = e.local_satisfaction; row[`nat_${id}`] = e.national_satisfaction; row[`anx_${id}`] = e.anxiety; }
      }
      chartData.push(row);
    }
  }

  // District color based on satisfaction
  const satColor = (sat: number) => {
    if (sat >= 60) return { bg: "rgba(34,197,94,0.15)", border: "rgba(34,197,94,0.35)", text: "#22c55e" };
    if (sat >= 45) return { bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.3)", text: "#3b82f6" };
    return { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.3)", text: "#ef4444" };
  };

  if (workflowStatus.evolution === "locked") {
    return (
      <StepGate
        requiredStep={1}
        requiredStepName={en ? "Persona Generation" : "人設生成"}
        requiredStepNameEn="Persona"
        description={en ? "Generate Personas in Step 1 before exploring agents." : "請先在第 1 步生成 Persona，才能進行演化。"}
        descriptionEn="Generate personas in Step 1 before running evolution."
        targetRoute={_wsId ? `/workspaces/${_wsId}/population-setup` : "/workspaces"}
      />
    );
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-faint)" }}>{en ? "Loading..." : "載入中..."}</div>;

  const districtList = Object.entries(districts).sort((a, b) => (b[1] as any).count - (a[1] as any).count);

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", height: "100%" }}>

      {/* ══════ Left Sidebar: District Cards + Agent Dropdown ══════ */}
      <div style={{
        width: 260, flexShrink: 0, borderRight: "1px solid rgba(255,255,255,0.06)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        {/* District cards */}
        <div style={{ padding: "12px 10px 8px", fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)" }}>
          {t("agentexp.counties")}
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "0 10px 8px" }}>
          {/* All districts button */}
          <button onClick={() => setSelectedDistrict(null)}
            style={{
              width: "100%", padding: "8px 10px", borderRadius: 6, marginBottom: 4, cursor: "pointer",
              border: !selectedDistrict ? "1.5px solid var(--accent-border)" : "1px solid rgba(255,255,255,0.06)",
              background: !selectedDistrict ? "var(--accent-bg)" : "transparent",
              color: !selectedDistrict ? "var(--accent-light)" : "var(--text-muted)",
              fontSize: 11, fontWeight: 600, fontFamily: "var(--font-cjk)", textAlign: "left",
            }}>
            {t("agentexp.all_districts", { count: agents.length })}
          </button>

          {districtList.map(([name, stats]: [string, any]) => {
            const avgSat = ((stats.avg_local_satisfaction || 50) + (stats.avg_national_satisfaction || 50)) / 2;
            const c = satColor(avgSat);
            const isSelected = selectedDistrict === name;
            const leanings = stats.leanings || {};
            return (
              <button key={name} onClick={() => setSelectedDistrict(isSelected ? null : name)}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 6, marginBottom: 3, cursor: "pointer",
                  border: isSelected ? "1.5px solid #a78bfa" : `1px solid ${c.border}`,
                  background: isSelected ? "rgba(124,58,237,0.12)" : c.bg,
                  textAlign: "left", display: "flex", flexDirection: "column", gap: 2,
                }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: isSelected ? "#c4b5fd" : c.text, fontFamily: "var(--font-cjk)" }}>
                    {name}
                  </span>
                  <span style={{ fontSize: 10, color: isSelected ? "#c4b5fd" : "rgba(255,255,255,0.4)", fontFamily: "var(--font-mono)" }}>
                    {t("common.people_count", { n: stats.count })}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, fontSize: 9, fontFamily: "var(--font-mono)" }}>
                  <span style={{ color: "#3b82f6" }}>L:{stats.avg_local_satisfaction}</span>
                  <span style={{ color: "#f97316" }}>N:{stats.avg_national_satisfaction}</span>
                  <span style={{ color: stats.avg_anxiety > 65 ? "#ef4444" : "#6b7280" }}>A:{stats.avg_anxiety}</span>
                </div>
                <div style={{ display: "flex", gap: 4, fontSize: 8 }}>
                  {Object.entries(leanings).map(([l, n]) => (
                    <span key={l} style={{ color: LEAN_COLORS[l] || "#9ca3af" }}>{l}:{String(n)}</span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>

        {/* Agent dropdown */}
        <div style={{ padding: "8px 10px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4, fontFamily: "var(--font-cjk)" }}>
            {t("agentexp.compare_label")}
          </div>
          <select
            value=""
            onChange={e => { const id = parseInt(e.target.value); if (!isNaN(id)) toggleAgent(id); }}
            style={{
              width: "100%", padding: "6px 8px", borderRadius: 6, fontSize: 11,
              border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)",
              color: "#fff", fontFamily: "var(--font-cjk)",
            }}>
            <option value="">{t("agentexp.select_agent")}</option>
            {filteredAgents.map((a: any) => {
              const id = a.person_id ?? a.id;
              const marker = selectedIds.includes(id) ? "✓ " : "";
              return (
                <option key={id} value={id}>
                  {marker}#{id} {a.name} — {a.age}{t("agentexp.age_suffix")} {a.gender} {a.district} ({a.political_leaning})
                </option>
              );
            })}
          </select>

          {/* Selected tags */}
          {selectedIds.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 6 }}>
              {selectedIds.map((id, i) => {
                const a = agents.find((x: any) => (x.person_id ?? x.id) === id);
                return (
                  <button key={id} onClick={() => toggleAgent(id)}
                    style={{
                      padding: "2px 8px", borderRadius: 4, fontSize: 10, cursor: "pointer",
                      border: `1px solid ${CHART_COLORS[i]}44`,
                      background: `${CHART_COLORS[i]}15`, color: CHART_COLORS[i],
                      fontFamily: "var(--font-cjk)",
                    }}>
                    #{id} {a?.name?.slice(0, 4)} ✕
                  </button>
                );
              })}
              <button onClick={() => setSelectedIds([])}
                style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, cursor: "pointer", border: "1px solid rgba(239,68,68,0.2)", background: "transparent", color: "#ef4444" }}>
                {t("agentexp.clear")}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ══════ Right: Charts + Diary ══════ */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
        {selectedIds.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--text-faint)", padding: "60px 20px", fontFamily: "var(--font-cjk)" }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🔍</div>
            <div style={{ fontSize: 14 }}>{t("agentexp.empty.line1")}</div>
            <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-muted)" }}>{t("agentexp.empty.line2")}</div>
          </div>
        ) : (
          <>
            {/* Agent profile cards */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {selectedIds.map((id, i) => {
                const a = agents.find((x: any) => (x.person_id ?? x.id) === id);
                if (!a) return null;
                const entries = diaries[id] || [];
                const latest = entries[entries.length - 1];
                const color = CHART_COLORS[i];
                return (
                  <div key={id} style={{ flex: "1 1 180px", padding: 10, borderRadius: 8, border: `1.5px solid ${color}44`, background: `${color}08` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color }}>{a.name}</span>
                      <span style={{ fontSize: 9, color: LEAN_COLORS[a.political_leaning] || "#9ca3af", fontWeight: 600 }}>{tp(a.political_leaning)}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-faint)", lineHeight: 1.5, fontFamily: "var(--font-cjk)" }}>
                      {a.age}{t("agentexp.age_suffix")} {a.gender} | {a.district} | {a.occupation}<br/>
                      {t("agentexp.media_label")}: {(a.media_habit || "").split(",").slice(0, 2).join(", ")}
                    </div>
                    {latest && (
                      <div style={{ display: "flex", gap: 8, marginTop: 4, fontSize: 10, fontFamily: "var(--font-mono)" }}>
                        <span style={{ color: "#3b82f6" }}>L:{latest.local_satisfaction}</span>
                        <span style={{ color: "#f97316" }}>N:{latest.national_satisfaction}</span>
                        <span style={{ color: latest.anxiety > 70 ? "#ef4444" : "#6b7280" }}>A:{latest.anxiety}</span>
                      </div>
                    )}
                    {/* Memory summary + candidate sentiment */}
                    {(() => {
                      const st = agentStates[String(id)] || agentStates[id] || {};
                      const mem = st.memory_summary || [];
                      const cSent = st.candidate_sentiment || {};
                      const cAware = st.candidate_awareness || {};
                      const hasCandData = Object.keys(cSent).length > 0 || Object.keys(cAware).length > 0;
                      return (
                        <>
                          {hasCandData && (
                            <div style={{ marginTop: 4, fontSize: 9, color: "var(--text-faint)", fontFamily: "var(--font-cjk)" }}>
                              {Object.entries(cAware).map(([cn, v]: [string, any]) => {
                                const sent = (cSent[cn] || 0) as number;
                                const sentColor = sent > 0.05 ? "#22c55e" : sent < -0.05 ? "#ef4444" : "#6b7280";
                                return (
                                  <span key={cn} style={{ marginRight: 6 }}>
                                    {cn}: <span style={{ color: "#a78bfa" }}>{Math.round((v as number) * 100)}%</span>
                                    <span style={{ color: sentColor, marginLeft: 2 }}>{sent > 0 ? "+" : ""}{(sent as number).toFixed(2)}</span>
                                  </span>
                                );
                              })}
                            </div>
                          )}
                          {mem.length > 0 && (
                            <div style={{ marginTop: 4, padding: "4px 6px", borderRadius: 4, background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.1)" }}>
                              <div style={{ fontSize: 9, color: "#fbbf24", fontWeight: 600, marginBottom: 2 }}>{t("agentexp.long_memory", { count: mem.length })}</div>
                              {mem.slice(-3).map((m: string, mi: number) => (
                                <div key={mi} style={{ fontSize: 9, color: "var(--text-faint)", lineHeight: 1.4, fontFamily: "var(--font-cjk)" }}>
                                  {m}
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                );
              })}
            </div>

            {/* Charts */}
            {chartData.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                {[
                  { title: t("agentexp.chart.local_sat"), prefix: "sat", color: "#3b82f6" },
                  { title: t("agentexp.chart.national_sat"), prefix: "nat", color: "#f97316" },
                  { title: t("agentexp.chart.anxiety"), prefix: "anx", color: "#ef4444" },
                ].map(({ title, prefix, color: titleColor }) => (
                  <div key={prefix} style={{
                    padding: 10, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
                    gridColumn: prefix === "anx" ? "1 / -1" : undefined,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: titleColor, marginBottom: 6, fontFamily: "var(--font-cjk)" }}>{title}</div>
                    <ResponsiveContainer width="100%" height={prefix === "anx" ? 160 : 150}>
                      <LineChart data={chartData} onClick={(e: any) => {
                        if (e?.activePayload?.[0]) setSelectedDay(e.activePayload[0].payload._dayNum);
                      }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="day" tick={{ fontSize: 9, fill: "#9ca3af" }} />
                        <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#9ca3af" }} width={30} />
                        <Tooltip contentStyle={ttStyle} />
                        {selectedIds.map((id, i) => (
                          <Line key={id} type="monotone" dataKey={`${prefix}_${id}`}
                            name={`#${id}`} stroke={CHART_COLORS[i]} strokeWidth={2} dot={{ r: 2 }}
                            strokeDasharray={prefix === "anx" ? "4 4" : undefined} />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ))}
              </div>
            )}

            {/* Day selector */}
            {chartData.length > 0 && (
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 12 }}>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", lineHeight: "24px", marginRight: 4 }}>{t("agentexp.diary_label")}</span>
                {chartData.map(d => {
                  const dn = d._dayNum;
                  return (
                    <button key={dn} onClick={() => setSelectedDay(selectedDay === dn ? null : dn)}
                      style={{
                        padding: "3px 8px", borderRadius: 4, fontSize: 10, cursor: "pointer",
                        border: selectedDay === dn ? "1px solid #a78bfa" : "1px solid rgba(255,255,255,0.06)",
                        background: selectedDay === dn ? "rgba(167,139,250,0.15)" : "transparent",
                        color: selectedDay === dn ? "#a78bfa" : "var(--text-faint)", fontFamily: "var(--font-mono)",
                      }}>
                      D{dn}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Diary entries */}
            {selectedDay !== null && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {selectedIds.map((id, i) => {
                  const entry = (diaries[id] || []).find((e: any) => e.day === selectedDay);
                  const a = agents.find((x: any) => (x.person_id ?? x.id) === id);
                  const color = CHART_COLORS[i];
                  if (!entry) return (
                    <div key={id} style={{ padding: 10, borderRadius: 6, border: `1px solid ${color}22`, opacity: 0.5 }}>
                      <span style={{ color, fontSize: 11 }}>#{id} {a?.name}</span>
                      <span style={{ color: "var(--text-faint)", fontSize: 11, marginLeft: 8 }}>D{selectedDay} {en ? "no data" : "無資料"}</span>
                    </div>
                  );
                  return (
                    <div key={id} style={{ padding: 12, borderRadius: 8, border: `1px solid ${color}33`, background: `${color}06` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ color, fontSize: 12, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>#{id} {a?.name}</span>
                          <span style={{ fontSize: 9, color: LEAN_COLORS[entry.political_leaning] || "#9ca3af", fontWeight: 600 }}>{entry.political_leaning}</span>
                        </div>
                        <div style={{ display: "flex", gap: 6, fontSize: 10, fontFamily: "var(--font-mono)" }}>
                          <span style={{ color: "#3b82f6" }}>L:{entry.local_satisfaction}</span>
                          <span style={{ color: "#f97316" }}>N:{entry.national_satisfaction}</span>
                          <span style={{ color: entry.anxiety > 70 ? "#ef4444" : "#6b7280" }}>A:{entry.anxiety}</span>
                        </div>
                      </div>
                      <div style={{ fontSize: 13, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", lineHeight: 1.8, marginBottom: 6 }}>
                        {entry.diary_text || (en ? "(no diary)" : "（無日記）")}
                      </div>
                      {entry.life_event && (
                        <div style={{ fontSize: 11, color: "#f59e0b", marginBottom: 3, fontFamily: "var(--font-cjk)" }}>
                          ⚡ {entry.life_event.name}: {entry.life_event.description}
                        </div>
                      )}
                      {entry.fed_titles?.length > 0 && (
                        <div style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-cjk)" }}>
                          📰 {entry.fed_titles.slice(0, 3).map((t: string) => t.slice(0, 30)).join(" / ")}
                        </div>
                      )}
                      {entry.political_attitudes && (
                        <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}>
                          <span>經濟:{entry.political_attitudes.economic_stance}</span>
                          <span>社會:{entry.political_attitudes.social_values}</span>
                          <span>兩岸:{entry.political_attitudes.cross_strait}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
