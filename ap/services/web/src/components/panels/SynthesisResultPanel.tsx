"use client";

import { useState, useEffect, useMemo } from "react";
import USMap from "@/components/USMap";
import { useTr, useTrWithLocale, useLocalizePersonaValueWithLocale, type StringKey, type Locale } from "@/lib/i18n";
import { useActiveTemplate } from "@/hooks/use-active-template";
import { getWorkspacePersonas } from "@/lib/api";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

const COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#f97316", "#ec4899", "#14b8a6", "#a855f7"];
const LEAN_COLORS: Record<string, string> = { "Solid Dem": "#1e40af", "Lean Dem": "#3b82f6", "Tossup": "#94a3b8", "Lean Rep": "#f87171", "Solid Rep": "#dc2626" };
const tooltipStyle = { background: "#1e1e2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11 };

// Stage 1.8: personality dimension labels resolved via i18n keys (template-locale aware)
const PERSONALITY_DIM_KEYS: { key: string; labelKey: StringKey }[] = [
  { key: "expressiveness",      labelKey: "synthesis.chart.express" },
  { key: "emotional_stability", labelKey: "synthesis.chart.stable" },
  { key: "sociability",         labelKey: "synthesis.chart.social" },
  { key: "openness",            labelKey: "synthesis.chart.openness" },
];

function computeStats(list: any[]) {
  const ageGroups: Record<string, number> = { "0-24": 0, "25-34": 0, "35-44": 0, "45-54": 0, "55-64": 0, "65+": 0 };
  const genderCount: Record<string, number> = {};
  const eduCount: Record<string, number> = {};
  const leanCount: Record<string, number> = {};
  const occCount: Record<string, number> = {};
  const maritalCount: Record<string, number> = {};
  const personalityStats: Record<string, Record<string, number>> = {};
  let hasPersonality = false;

  for (const p of list) {
    const age = parseInt(p.age) || 0;
    if (age < 25) ageGroups["0-24"]++; else if (age < 35) ageGroups["25-34"]++;
    else if (age < 45) ageGroups["35-44"]++; else if (age < 55) ageGroups["45-54"]++;
    else if (age < 65) ageGroups["55-64"]++; else ageGroups["65+"]++;
    genderCount[p.gender || "Unknown"] = (genderCount[p.gender || "Unknown"] || 0) + 1;
    eduCount[p.education || "Unknown"] = (eduCount[p.education || "Unknown"] || 0) + 1;
    leanCount[p.political_leaning || p.leaning || "Not set"] = (leanCount[p.political_leaning || p.leaning || "Not set"] || 0) + 1;
    occCount[p.occupation || "Unknown"] = (occCount[p.occupation || "Unknown"] || 0) + 1;
    const mar = p.marital_status || ""; if (mar) maritalCount[mar] = (maritalCount[mar] || 0) + 1;
    if (p.personality && typeof p.personality === "object") {
      hasPersonality = true;
      for (const { key } of PERSONALITY_DIM_KEYS) {
        const val = p.personality[key] || "Unknown";
        if (!personalityStats[key]) personalityStats[key] = {};
        personalityStats[key][val] = (personalityStats[key][val] || 0) + 1;
      }
    }
  }
  return { ageGroups, genderCount, eduCount, leanCount, occCount, maritalCount, personalityStats, hasPersonality };
}

export default function SynthesisResultPanel({ wsId }: { wsId: string }) {
  const [personas, setPersonas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<"overview" | "table">("overview");
  const t = useTr();

  // The application is US-only; simulation result text always renders in
  // English regardless of the user's UI locale toggle.
  const { template: activeTemplate } = useActiveTemplate(wsId);
  const overrideLocale: Locale = "en";
  const tmpl = useTrWithLocale(overrideLocale);
  const localizeValue = useLocalizePersonaValueWithLocale(overrideLocale);

  useEffect(() => {
    (async () => {
      try {
        const res = await getWorkspacePersonas(wsId);
        const list = Array.isArray(res) ? res : (res?.agents || res?.persons || []);
        setPersonas(list);
      } catch { }
      setLoading(false);
    })();
  }, [wsId]);

  const districtCount = useMemo(() => {
    const dc: Record<string, number> = {};
    for (const p of personas) dc[p.district || "Unknown"] = (dc[p.district || "Unknown"] || 0) + 1;
    return dc;
  }, [personas]);

  const filtered = useMemo(() =>
    selectedDistrict ? personas.filter(p => p.district === selectedDistrict) : personas,
  [personas, selectedDistrict]);

  const stats = useMemo(() => computeStats(filtered), [filtered]);
  const toBar = (obj: Record<string, number>) => Object.entries(obj).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  const toPie = (obj: Record<string, number>) => Object.entries(obj).map(([name, value]) => ({ name, value })).filter(d => d.value > 0);

  if (loading) return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.3)" }}>Loading...</div>;
  if (!personas.length) return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 32 }}>📭</span>
      <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>No synthetic population yet. Generate in Population Setup first.</span>
    </div>
  );

  const miniChart = (title: string, content: React.ReactNode) => (
    <div style={{ flex: "1 1 48%", padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.6)", marginBottom: 4, fontFamily: "var(--font-cjk)" }}>{title}</div>
      {content}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "auto" }}>
      <div style={{ padding: "12px clamp(12px, 2vw, 24px)", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
          <div>
            <h2 style={{ color: "#fff", fontSize: 18, fontWeight: 700, margin: 0, fontFamily: "var(--font-cjk)" }}>
              🧬 {t("synthesis.title")}
            </h2>
            <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 11, margin: "2px 0 0", fontFamily: "var(--font-cjk)" }}>
              {selectedDistrict
                ? <>{selectedDistrict} — {filtered.length} / {personas.length} <button onClick={() => setSelectedDistrict(null)} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", fontSize: 11 }}>{t("synthesis.show_all")}</button></>
                : t("synthesis.tagline", { count: personas.length })}
            </p>
          </div>
          <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid rgba(255,255,255,0.08)" }}>
            {(["overview", "table"] as const).map(tab => (
              <button key={tab} onClick={() => setViewTab(tab)}
                style={{ padding: "4px 12px", border: "none", cursor: "pointer", fontSize: 11,
                  background: viewTab === tab ? "#3b82f6" : "rgba(255,255,255,0.03)",
                  color: viewTab === tab ? "#fff" : "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)" }}>
                {tab === "overview" ? t("synthesis.tab_chart") : t("synthesis.tab_list")}
              </button>
            ))}
          </div>
        </div>

        {viewTab === "overview" && (
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>

            {/* Left column: Mini map + District grid */}
            <div style={{ width: 240, flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {(() => {
                // Map highlight follows the active template's scope.
                const isStateScope = activeTemplate?.election?.scope === "state" && !!activeTemplate?.fips;
                const stateFips = isStateScope ? (activeTemplate.fips as string) : "";
                const mapTitle = isStateScope ? (activeTemplate.region || stateFips) : "United States";
                return (
                  <USMap
                    mode="states"
                    selectedFeature={isStateScope ? stateFips : ""}
                    data={{}}
                    colorScale={["#1e293b", "#f59e0b"]}
                    width={240}
                    height={160}
                    title={mapTitle}
                    showLegend={false}
                  />
                );
              })()}

              <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-cjk)" }}>
                📍 {selectedDistrict ? t("synthesis.click_to_clear", { name: selectedDistrict }) : t("synthesis.click_to_filter")}
              </div>
              {/* District grid: equal size, color depth by count */}
              {(() => {
                const sorted = toBar(districtCount);
                const maxVal = Math.max(...sorted.map(d => d.value), 1);
                // Grid columns: auto-fit based on count
                const cols = sorted.length <= 9 ? 3 : sorted.length <= 16 ? 4 : 5;
                return (
                  // Civatas-USA Stage 1.7+: cap height + scroll so 50+ counties
                  // (PA = 67) don't push the grid past the chart column.
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 3, maxHeight: 380, overflowY: "auto" }}>
                    {sorted.map(d => {
                      const isSelected = selectedDistrict === d.name;
                      const ratio = d.value / maxVal;
                      // Color: from dark (few) to bright blue (many)
                      const r = Math.round(30 + ratio * 29);
                      const g = Math.round(41 + ratio * 89);
                      const b = Math.round(59 + ratio * 187);
                      const bgColor = isSelected ? "rgba(139,92,246,0.35)" : `rgb(${r},${g},${b})`;
                      return (
                        <button key={d.name}
                          onClick={() => setSelectedDistrict(prev => prev === d.name ? null : d.name)}
                          style={{
                            aspectRatio: "1", borderRadius: 6, cursor: "pointer",
                            border: isSelected ? "2px solid #a78bfa" : "1px solid rgba(255,255,255,0.08)",
                            background: bgColor,
                            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                            gap: 1, transition: "all 0.15s", padding: 2,
                          }}>
                          <span style={{ fontSize: 9, fontWeight: 700, color: isSelected ? "#c4b5fd" : "#fff", fontFamily: "var(--font-cjk)", lineHeight: 1.1, textAlign: "center" }}>
                            {d.name.replace("區","").replace("鄉","").replace("鎮","").replace("市","")}
                          </span>
                          <span style={{ fontSize: 8, color: isSelected ? "#c4b5fd" : "rgba(255,255,255,0.5)" }}>
                            {d.value}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Right column: Stats + charts */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>

              {/* Summary row */}
              <div style={{ display: "flex", gap: 6 }}>
                {[
                  { label: t("synthesis.stat_total"), value: filtered.length, color: "#3b82f6" },
                  { label: t("synthesis.stat_male"), value: (stats.genderCount["男"] || 0) + (stats.genderCount["Male"] || 0) + (stats.genderCount["male"] || 0), color: "#60a5fa" },
                  { label: t("synthesis.stat_female"), value: (stats.genderCount["女"] || 0) + (stats.genderCount["Female"] || 0) + (stats.genderCount["female"] || 0), color: "#f472b6" },
                  { label: t("synthesis.stat_counties"), value: selectedDistrict ? 1 : Object.keys(districtCount).length, color: "#22c55e" },
                ].map((s, i) => (
                  <div key={i} style={{ flex: 1, padding: "8px", borderRadius: 8, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)", textAlign: "center" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.value}</div>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", fontFamily: "var(--font-cjk)" }}>{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Charts 2x2 grid */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {miniChart(t("synthesis.chart.age"),
                  <ResponsiveContainer width="100%" height={130}>
                    <BarChart data={toBar(stats.ageGroups)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                      <XAxis dataKey="name" tick={{ fontSize: 8, fill: "rgba(255,255,255,0.4)" }} />
                      <YAxis tick={{ fontSize: 8, fill: "rgba(255,255,255,0.3)" }} width={20} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Bar dataKey="value" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
                {miniChart(t("synthesis.chart.leaning"),
                  <ResponsiveContainer width="100%" height={130}>
                    <PieChart>
                      <Pie data={toPie(stats.leanCount)} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={48}
                        label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={false}>
                        {toPie(stats.leanCount).map((d, i) => <Cell key={i} fill={LEAN_COLORS[d.name] || COLORS[i%COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
                {miniChart(t("synthesis.chart.education"),
                  <ResponsiveContainer width="100%" height={130}>
                    <BarChart data={toBar(stats.eduCount)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                      <XAxis dataKey="name" tick={{ fontSize: 7, fill: "rgba(255,255,255,0.4)" }} />
                      <YAxis tick={{ fontSize: 8, fill: "rgba(255,255,255,0.3)" }} width={20} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Bar dataKey="value" fill="#22c55e" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
                {miniChart(t("synthesis.chart.occupation"),
                  <ResponsiveContainer width="100%" height={130}>
                    <BarChart data={toBar(stats.occCount).slice(0, 6)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                      <XAxis dataKey="name" tick={{ fontSize: 6, fill: "rgba(255,255,255,0.4)" }} angle={-15} textAnchor="end" height={30} />
                      <YAxis tick={{ fontSize: 8, fill: "rgba(255,255,255,0.3)" }} width={20} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Bar dataKey="value" fill="#f59e0b" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* Marital status (if available) */}
              {Object.keys(stats.maritalCount).length > 0 && miniChart(t("synthesis.chart.marital"),
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {toBar(stats.maritalCount).map((d, i) => (
                    <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[i % COLORS.length] }} />
                      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>{d.name}: {d.value}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Personality traits (if available) — 2-column grid */}
              {stats.hasPersonality && (() => {
                const dims = PERSONALITY_DIM_KEYS.filter(({ key }) => {
                  const d = stats.personalityStats[key];
                  return d && Object.keys(d).length > 0;
                });
                if (dims.length === 0) return null;
                return (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", width: "100%" }}>
                    {dims.map(({ key, labelKey }) => {
                      const entries = Object.entries(stats.personalityStats[key]).sort((a, b) => b[1] - a[1]);
                      const max = Math.max(...entries.map(e => e[1]), 1);
                      return (
                        <div key={key} style={{ flex: "1 1 48%", minWidth: 200, padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa", marginBottom: 4, fontFamily: "var(--font-cjk)" }}>{tmpl(labelKey)}</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            {entries.map(([val, count]) => (
                              <div key={val} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ minWidth: 80, fontSize: 9, fontFamily: "var(--font-cjk)", color: "rgba(255,255,255,0.5)", textAlign: "right" }}>{localizeValue(val)}</span>
                                <div style={{ flex: 1, height: 8, borderRadius: 3, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                                  <div style={{ height: "100%", borderRadius: 3, width: `${(count / max) * 100}%`, background: "#a78bfa", opacity: 0.7 }} />
                                </div>
                                <span style={{ minWidth: 30, fontSize: 9, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.3)", textAlign: "right" }}>{count}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Table view */}
        {viewTab === "table" && (
          <div style={{ borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", overflow: "auto", maxHeight: "calc(100vh - 120px)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  {["#", "State", "Age", "Gender", "Edu", "Occ", "Marital", "Lean", "Expr", "Stab", "Social", "Open"].map(h => (
                    <th key={h} style={{ padding: "6px 8px", textAlign: "left", color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)", fontWeight: 600, position: "sticky", top: 0, background: "#141422" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 300).map((p: any, i: number) => (
                  <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.02)", cursor: "pointer" }}
                    onClick={() => setSelectedDistrict(prev => prev === p.district ? null : p.district)}>
                    <td style={{ padding: "4px 8px", color: "rgba(255,255,255,0.25)" }}>{p.person_id || i+1}</td>
                    <td style={{ padding: "4px 8px", color: "#a78bfa", fontFamily: "var(--font-cjk)" }}>{p.district || "-"}</td>
                    <td style={{ padding: "4px 8px", color: "#fff" }}>{p.age || "-"}</td>
                    <td style={{ padding: "4px 8px", color: p.gender === "女" ? "#f472b6" : "#60a5fa" }}>{p.gender || "-"}</td>
                    <td style={{ padding: "4px 8px", color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-cjk)" }}>{p.education || "-"}</td>
                    <td style={{ padding: "4px 8px", color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-cjk)" }}>{p.occupation || "-"}</td>
                    <td style={{ padding: "4px 8px", color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)" }}>{p.marital_status || "-"}</td>
                    <td style={{ padding: "4px 8px", fontFamily: "var(--font-cjk)",
                      color: (p.political_leaning||"").includes("左") ? "#22c55e" : (p.political_leaning||"").includes("右") ? "#60a5fa" : "#94a3b8" }}>
                      {p.political_leaning || p.leaning || "-"}
                    </td>
                    <td style={{ padding: "4px 8px", color: "#a78bfa", fontSize: 9, fontFamily: "var(--font-cjk)" }}>{p.personality?.expressiveness || "-"}</td>
                    <td style={{ padding: "4px 8px", color: "#a78bfa", fontSize: 9, fontFamily: "var(--font-cjk)" }}>{p.personality?.emotional_stability || "-"}</td>
                    <td style={{ padding: "4px 8px", color: "#a78bfa", fontSize: 9, fontFamily: "var(--font-cjk)" }}>{p.personality?.sociability || "-"}</td>
                    <td style={{ padding: "4px 8px", color: "#a78bfa", fontSize: 9, fontFamily: "var(--font-cjk)" }}>{p.personality?.openness || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 300 && <div style={{ padding: "6px", textAlign: "center", color: "rgba(255,255,255,0.25)", fontSize: 9 }}>Showing first 300 of {filtered.length}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
