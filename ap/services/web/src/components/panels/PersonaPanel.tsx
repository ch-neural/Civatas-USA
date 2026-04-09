"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  apiFetch,
  getWorkspacePersonas,
  savePersonaSnapshot,
  listPersonaSnapshots,
  loadPersonaSnapshot,
  deletePersonaSnapshot,
  getLeaningProfile,
} from "@/lib/api";
import { useTr, useLocalizePersonaValue } from "@/lib/i18n";
import { GuideBanner } from "@/components/shared/GuideBanner";

/* ── colour maps ── */
const vendorColors: Record<string, string> = {
  openai: "#10a37f", gemini: "#4285f4", xai: "#f43f5e",
  deepseek: "#6366f1", template: "#fbbf24", "未知": "#6b7280", "unknown": "#6b7280",
};
const leaningColors: Record<string, string> = {
  // TW
  "偏左派": "#22c55e", "中立": "#9ca3af", "偏右派": "#3b82f6", "未知": "#6b7280",
  // US (Civatas-USA Stage 1.5+)
  "Solid Dem": "#1e40af", "Lean Dem": "#3b82f6",
  "Tossup": "#94a3b8",
  "Lean Rep": "#ef4444", "Solid Rep": "#991b1b",
  "unknown": "#6b7280",
};
const personalityColors: Record<string, string> = {
  "高度表達": "#a78bfa", "中等表達": "#7c3aed", "沉默寡言": "#4c1d95",
  "穩定冷靜": "#34d399", "一般穩定": "#059669", "敏感衝動": "#991b1b",
  "外向社交": "#60a5fa", "適度社交": "#2563eb", "內向獨處": "#1e3a5f",
  "開放多元": "#fbbf24", "中等開放": "#d97706", "固守觀點": "#92400e",
};

/* ── helpers ── */
function ageBucket(age: number) {
  if (age < 20) return "0-19";
  if (age < 30) return "20-29";
  if (age < 40) return "30-39";
  if (age < 50) return "40-49";
  if (age < 60) return "50-59";
  if (age < 70) return "60-69";
  return "70+";
}

function summarizePersonas(personas: any[]) {
  const total = personas.length;
  const vendor: Record<string, number> = {};
  const gender: Record<string, number> = {};
  const leaning: Record<string, number> = {};
  const district: Record<string, number> = {};
  const age: Record<string, number> = {};
  const personality: Record<string, Record<string, number>> = {
    expressiveness: {}, emotional_stability: {}, sociability: {}, openness: {},
  };
  let hasPersonality = false;

  personas.forEach((p) => {
    const v = p.llm_vendor || "未知";
    vendor[v] = (vendor[v] || 0) + 1;
    const g = p.gender || "未知";
    gender[g] = (gender[g] || 0) + 1;
    const l = p.political_leaning || "未知";
    leaning[l] = (leaning[l] || 0) + 1;
    const d = p.district || "未知";
    district[d] = (district[d] || 0) + 1;
    const a = parseInt(p.age) || 0;
    const b = ageBucket(a);
    age[b] = (age[b] || 0) + 1;
    if (p.personality) {
      hasPersonality = true;
      for (const dim of Object.keys(personality)) {
        const val = p.personality[dim] || "未知";
        personality[dim][val] = (personality[dim][val] || 0) + 1;
      }
    }
  });

  const sort = (m: Record<string, number>) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]) as [string, number][];
  const sortAsc = (m: Record<string, number>) =>
    Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])) as [string, number][];

  return {
    total,
    vendor: sort(vendor),
    gender: sort(gender),
    leaning: sort(leaning),
    district: sort(district),
    age: sortAsc(age),
    personality,
    hasPersonality,
  };
}

/* ── MiniBar component ── */
function MiniBar({
  data, total, colorMap,
}: {
  data: [string, number][]; total: number; colorMap?: Record<string, string>;
}) {
  const tp = useLocalizePersonaValue();
  const max = Math.max(...data.map((d) => d[1]), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {data.map(([label, count]) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            minWidth: 70, fontSize: 10, fontFamily: "var(--font-cjk)", fontWeight: 600,
            textAlign: "right", color: colorMap?.[label] || "var(--text-secondary)",
          }}>
            {tp(label)}
          </span>
          <div style={{ flex: 1, height: 10, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.04)", overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 3, width: `${(count / max) * 100}%`,
              backgroundColor: colorMap?.[label] || "var(--accent)", opacity: 0.7,
              transition: "width 0.3s ease",
            }} />
          </div>
          <span style={{ minWidth: 44, fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-faint)", textAlign: "right" }}>
            {count} ({total > 0 ? ((count / total) * 100).toFixed(0) : 0}%)
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Stats Grid ── */
function StatsGrid({ personas }: { personas: any[] }) {
  const t = useTr();
  const tp = useLocalizePersonaValue();
  const s = summarizePersonas(personas);
  if (s.total === 0) return null;

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <StatBox title={t("persona.over.gender")} data={s.gender} total={s.total} />
      <StatBox title={t("persona.over.age")} data={s.age} total={s.total} />
      <StatBox title={t("persona.over.leaning")} data={s.leaning} total={s.total} colorMap={leaningColors} />
      <StatBox title={t("persona.over.district")} data={s.district.slice(0, 5)} total={s.total} />
      <StatBox title={t("persona.over.vendor")} data={s.vendor} total={s.total} colorMap={vendorColors} />
      {s.hasPersonality && (
        <div style={{
          flex: "1 1 200px", minWidth: 180, padding: 10, borderRadius: 6,
          backgroundColor: "rgba(139,92,246,0.04)", border: "1px solid rgba(139,92,246,0.10)",
        }}>
          <div style={{ fontSize: 10, fontFamily: "var(--font-cjk)", color: "#a78bfa", marginBottom: 6, fontWeight: 600 }}>
            {t("persona.over.traits")}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {[
              { dim: "expressiveness", label: t("persona.over.trait.express") },
              { dim: "emotional_stability", label: t("persona.over.trait.stable") },
              { dim: "sociability", label: t("persona.over.trait.social") },
              { dim: "openness", label: t("persona.over.trait.open") },
            ].map(({ dim, label }) => {
              const sorted = Object.entries(s.personality[dim]).sort((a, b) => b[1] - a[1]);
              return (
                <div key={dim} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ minWidth: 30, fontSize: 9, fontFamily: "var(--font-cjk)", color: "#a78bfa", fontWeight: 600 }}>{label}</span>
                  <div style={{ flex: 1, display: "flex", gap: 2 }}>
                    {sorted.map(([val, cnt]) => (
                      <div key={val} title={`${tp(val)}: ${cnt}`} style={{
                        flex: cnt, height: 8, borderRadius: 2,
                        backgroundColor: personalityColors[val] || "#7c3aed",
                        opacity: 0.7,
                      }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({ title, data, total, colorMap }: {
  title: string; data: [string, number][]; total: number; colorMap?: Record<string, string>;
}) {
  return (
    <div style={{
      flex: "1 1 200px", minWidth: 180, padding: 10, borderRadius: 6,
      backgroundColor: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)",
    }}>
      <div style={{ fontSize: 10, fontFamily: "var(--font-cjk)", color: "var(--text-faint)", marginBottom: 6, fontWeight: 600 }}>
        {title}
      </div>
      <MiniBar data={data} total={total} colorMap={colorMap} />
    </div>
  );
}

/* ── Persona Table ── */
function PersonaTable({ personas, wsId, onUpdate }: { personas: any[]; wsId: string; onUpdate?: () => void }) {
  const t = useTr();
  const tp = useLocalizePersonaValue();
  const [pageIndex, setPageIndex] = useState(0);
  const pageSize = 20;
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingIdv, setEditingIdv] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  return (
    <>
      <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid var(--border-input)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-cjk)", fontSize: 12 }}>
          <thead>
            <tr style={{ backgroundColor: "rgba(255,255,255,0.03)" }}>
              {["#", t("persona.col.id"), t("persona.col.llm"), t("persona.col.traits"), t("persona.col.personality"), t("persona.col.individuality"), t("persona.col.description")].map((h) => (
                <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "var(--text-muted)", fontWeight: 500, borderBottom: "1px solid var(--border-input)" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {personas.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize).map((p, i) => (
              <React.Fragment key={pageIndex * pageSize + i}>
              <tr style={{ borderBottom: "1px solid var(--border-input)" }}>
                <td style={{ padding: "6px 12px", color: "var(--text-muted)" }}>{pageIndex * pageSize + i + 1}</td>
                <td style={{ padding: "6px 12px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                  {p.id ?? p.agent_id ?? p.person_id ?? "-"}
                </td>
                <td style={{ padding: "6px 12px", whiteSpace: "nowrap" }}>
                  <span style={{
                    padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    backgroundColor: (vendorColors[p.llm_vendor] || "#6b7280") + "22",
                    color: vendorColors[p.llm_vendor] || "#6b7280",
                  }}>
                    {(p.llm_vendor || "—").toUpperCase()}
                  </span>
                </td>
                <td style={{ padding: "6px 12px", maxWidth: 200 }}
                  title={Array.isArray(p.traits) ? p.traits.join("、") : ""}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {Array.isArray(p.traits)
                      ? p.traits.slice(0, 6).map((trait: string, idx: number) => (
                          <span key={idx} style={{
                            padding: "1px 4px", backgroundColor: "rgba(255,255,255,0.05)",
                            border: "1px solid var(--border-input)", borderRadius: 3, fontSize: 9,
                            color: "var(--text-secondary)", whiteSpace: "nowrap",
                          }}>
                            {trait}
                          </span>
                        ))
                      : <span style={{ color: "var(--text-muted)" }}>-</span>}
                  </div>
                </td>
                <td style={{ padding: "6px 12px", maxWidth: 160 }}>
                  {p.personality ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {[
                        { key: "expressiveness", icon: "🗣" },
                        { key: "emotional_stability", icon: "💆" },
                        { key: "sociability", icon: "👥" },
                        { key: "openness", icon: "🧠" },
                      ].map((d) => (
                        <span key={d.key} style={{
                          padding: "1px 5px", borderRadius: 4, fontSize: 9,
                          backgroundColor: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.15)",
                          color: "#a78bfa", whiteSpace: "nowrap",
                        }}>
                          {d.icon} {tp(p.personality[d.key])}
                        </span>
                      ))}
                    </div>
                  ) : <span style={{ color: "var(--text-muted)", fontSize: 10 }}>—</span>}
                </td>
                <td style={{ padding: "6px 12px", minWidth: 180 }}>
                  {p.individuality ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{
                          padding: "1px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600,
                          backgroundColor: ({
                            "樂觀偏向": "rgba(34,197,94,0.15)", "悲觀偏向": "rgba(239,68,68,0.15)",
                            "理性分析": "rgba(56,189,248,0.15)", "從眾型": "rgba(251,191,36,0.15)",
                            "陰謀論傾向": "rgba(168,85,247,0.15)", "轉嫁怨氣": "rgba(249,115,22,0.15)",
                            "無感冷漠": "rgba(107,114,128,0.15)",
                          } as Record<string, string>)[p.individuality.cognitive_bias] || "rgba(255,255,255,0.05)",
                          color: ({
                            "樂觀偏向": "#22c55e", "悲觀偏向": "#ef4444",
                            "理性分析": "#38bdf8", "從眾型": "#fbbf24",
                            "陰謀論傾向": "#a855f7", "轉嫁怨氣": "#f97316",
                            "無感冷漠": "#6b7280",
                          } as Record<string, string>)[p.individuality.cognitive_bias] || "#9ca3af",
                        }}>
                          {tp(p.individuality.cognitive_bias) || "?"}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); setExpandedId(expandedId === (p.person_id ?? pageIndex * pageSize + i) ? null : (p.person_id ?? pageIndex * pageSize + i)); setEditingIdv({...p.individuality}); }}
                          style={{ padding: "1px 4px", borderRadius: 3, border: "1px solid rgba(192,132,252,0.2)", background: "transparent", color: "#c084fc", fontSize: 8, cursor: "pointer" }}
                        >
                          ✏️
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: 3, fontSize: 8, color: "rgba(255,255,255,0.3)", fontFamily: "var(--font-mono)" }}>
                        <span title={t("persona.metric.noise")}>N{p.individuality.noise_scale?.toFixed(1)}</span>
                        <span title={t("persona.metric.reaction")}>R{p.individuality.reaction_multiplier?.toFixed(1)}</span>
                        <span title={t("persona.metric.inertia")}>M{p.individuality.memory_inertia?.toFixed(2)}</span>
                        <span title={t("persona.editor.temp")}>T{p.individuality.temperature_offset >= 0 ? "+" : ""}{p.individuality.temperature_offset?.toFixed(2)}</span>
                      </div>
                    </div>
                  ) : <span style={{ color: "var(--text-muted)", fontSize: 9 }}>—</span>}
                </td>
                <td style={{ padding: "6px 12px", color: "var(--text-secondary)", maxWidth: 150, lineHeight: 1.4, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "help" }}
                  title={p.description || p.system_prompt || ""}>
                  {(p.description || p.system_prompt || p.prompt || "-").slice(0, 30)}...
                </td>
              </tr>
              {expandedId === (p.person_id ?? pageIndex * pageSize + i) && editingIdv && (
                <tr>
                  <td colSpan={7} style={{ padding: "8px 16px", background: "rgba(192,132,252,0.04)", borderBottom: "1px solid rgba(192,132,252,0.1)" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                      {/* Cognitive Bias selector */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)" }}>{t("persona.editor.cognitive_bias")}</span>
                        <select value={editingIdv.cognitive_bias || ""} onChange={e => setEditingIdv({...editingIdv, cognitive_bias: e.target.value})}
                          style={{ padding: "3px 6px", borderRadius: 4, border: "1px solid rgba(192,132,252,0.3)", background: "rgba(0,0,0,0.3)", color: "#c084fc", fontSize: 10, fontFamily: "var(--font-cjk)" }}>
                          {["樂觀偏向","悲觀偏向","理性分析","從眾型","陰謀論傾向","轉嫁怨氣","無感冷漠"].map(b => <option key={b} value={b}>{tp(b)}</option>)}
                        </select>
                      </div>
                      {/* Numeric sliders */}
                      {[
                        { key: "noise_scale", label: t("persona.metric.noise"), min: 0.2, max: 3, step: 0.1, color: "#c084fc" },
                        { key: "reaction_multiplier", label: t("persona.metric.reaction"), min: 0.4, max: 2, step: 0.1, color: "#38bdf8" },
                        { key: "memory_inertia", label: t("persona.metric.inertia"), min: 0, max: 0.5, step: 0.01, color: "#22c55e" },
                        { key: "temperature_offset", label: t("persona.editor.temp_offset"), min: -0.3, max: 0.3, step: 0.05, color: "#f59e0b" },
                        { key: "delta_cap", label: t("persona.editor.delta_cap"), min: 5, max: 30, step: 1, color: "#ef4444" },
                      ].map(s => (
                        <div key={s.key} style={{ display: "flex", flexDirection: "column", gap: 2, flex: "0 0 120px" }}>
                          <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)" }}>{s.label}</span>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <input type="range" min={s.min} max={s.max} step={s.step}
                              value={editingIdv[s.key] ?? 0}
                              onChange={e => setEditingIdv({...editingIdv, [s.key]: parseFloat(e.target.value)})}
                              style={{ width: 70, accentColor: s.color }} />
                            <span style={{ fontSize: 10, color: s.color, fontFamily: "var(--font-mono)", minWidth: 30 }}>
                              {typeof editingIdv[s.key] === "number" ? (s.step < 0.1 ? editingIdv[s.key].toFixed(2) : editingIdv[s.key].toFixed(1)) : "?"}
                            </span>
                          </div>
                        </div>
                      ))}
                      {/* Save button */}
                      <button
                        disabled={saving}
                        onClick={async () => {
                          setSaving(true);
                          try {
                            await apiFetch(`/api/workspaces/${wsId}/agents/${p.person_id}/individuality`, {
                              method: "PATCH",
                              body: JSON.stringify(editingIdv),
                            });
                            setExpandedId(null);
                            if (onUpdate) onUpdate();
                          } catch (e: any) { alert(t("persona.editor.save_failed", { msg: e.message || e })); }
                          finally { setSaving(false); }
                        }}
                        style={{ padding: "4px 12px", borderRadius: 5, border: "1px solid rgba(192,132,252,0.3)", background: "rgba(192,132,252,0.1)", color: "#c084fc", fontSize: 10, cursor: saving ? "wait" : "pointer", fontFamily: "var(--font-cjk)", fontWeight: 600, alignSelf: "flex-end" }}
                      >
                        {saving ? t("persona.editor.saving") : t("persona.editor.save")}
                      </button>
                      <button
                        onClick={() => setExpandedId(null)}
                        style={{ padding: "4px 8px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "rgba(255,255,255,0.4)", fontSize: 10, cursor: "pointer" }}
                      >
                        {t("persona.editor.cancel")}
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {personas.length > pageSize && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-muted)" }}>
            {t("persona.pagination", { from: pageIndex * pageSize + 1, to: Math.min((pageIndex + 1) * pageSize, personas.length), total: personas.length })}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={pageIndex === 0} onClick={() => setPageIndex((p) => p - 1)}
              style={{ padding: "4px 12px", borderRadius: 4, border: "1px solid var(--border-input)", backgroundColor: "transparent", color: pageIndex === 0 ? "var(--text-faint)" : "var(--text-secondary)", cursor: pageIndex === 0 ? "not-allowed" : "pointer", fontSize: 12 }}>
              {t("persona.prev")}
            </button>
            <button disabled={(pageIndex + 1) * pageSize >= personas.length} onClick={() => setPageIndex((p) => p + 1)}
              style={{ padding: "4px 12px", borderRadius: 4, border: "1px solid var(--border-input)", backgroundColor: "transparent", color: (pageIndex + 1) * pageSize >= personas.length ? "var(--text-faint)" : "var(--text-secondary)", cursor: (pageIndex + 1) * pageSize >= personas.length ? "not-allowed" : "pointer", fontSize: 12 }}>
              {t("persona.next")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════
   Main: PersonaPanel — Population Snapshot Manager
   ═══════════════════════════════════════════ */
export default function PersonaPanel({ wsId }: { wsId: string }) {
  const t = useTr();
  const tp = useLocalizePersonaValue();
  const [personas, setPersonas] = useState<any[]>([]);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [expandedSnap, setExpandedSnap] = useState<string | null>(null);
  const [expandedView, setExpandedView] = useState<Record<string, "stats" | "table">>({}); // per-snapshot view mode
  const [snapName, setSnapName] = useState("");
  const [snapDesc, setSnapDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingSnap, setLoadingSnap] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [leaningName, setLeaningName] = useState(() => t("persona.unset"));

  const refreshSnapshots = useCallback(() => {
    listPersonaSnapshots(wsId)
      .then((r: any) => {
        const list = (r?.snapshots || []).sort(
          (a: any, b: any) => (b.created_at || 0) - (a.created_at || 0),
        );
        setSnapshots(list);
        return list;
      })
      .catch(() => []);
  }, [wsId]);

  /* auto-generate snapshot name */
  const computeDefaults = useCallback(
    (currentPersonas: any[], snaps: any[]) => {
      const count = currentPersonas.length;
      const now = new Date();
      const ds = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      const todayCount = snaps.filter((s: any) => {
        if (!s.created_at) return false;
        const d = new Date(s.created_at * 1000);
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` === ds;
      }).length;
      const seq = String(todayCount + 1).padStart(2, "0");

      const strategies = new Set<string>();
      const vendorCounts: Record<string, number> = {};
      const genderCounts: Record<string, number> = {};
      const leaningCounts: Record<string, number> = {};
      const districts = new Set<string>();

      const unk = t("persona.unknown");
      currentPersonas.forEach((p) => {
        const v = p.llm_vendor || unk;
        vendorCounts[v] = (vendorCounts[v] || 0) + 1;
        genderCounts[p.gender || unk] = (genderCounts[p.gender || unk] || 0) + 1;
        leaningCounts[p.political_leaning || unk] = (leaningCounts[p.political_leaning || unk] || 0) + 1;
        if (p.district) districts.add(p.district);
        strategies.add(v === "template" ? "template" : "llm");
      });

      const strategyStr = Array.from(strategies).join("/").toUpperCase() || "UNKNOWN";
      const fmt = (m: Record<string, number>) =>
        Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" / ");

      return {
        name: `${leaningName}-${count}-${ds}-${seq}`,
        desc: `Strategy:${strategyStr} | Vendor:${fmt(vendorCounts)} | Gender:${fmt(genderCounts)} | Leaning:${fmt(leaningCounts)} | ${districts.size} counties`,
      };
    },
    [leaningName, t],
  );

  useEffect(() => {
    getWorkspacePersonas(wsId)
      .then((res) => {
        const agents = res?.agents || (Array.isArray(res) ? res : []);
        setPersonas(agents);
      })
      .catch(() => {});
    refreshSnapshots();
    getLeaningProfile()
      .then((r: any) => {
        if (r?.exists && r?.data) {
          const desc = r.data.description || "";
          const sources = r.data.data_sources || [];
          const src = r.data.source || r.data._source || "";
          if (desc) setLeaningName(desc);
          else if (sources.length > 0) setLeaningName(sources[0]);
          else if (src) setLeaningName(src.split("/").pop()?.replace(/\.(csv|json|xlsx?)$/i, "") || src);
          else setLeaningName(t("persona.snap.spectrum", { count: Object.keys(r.data.districts || r.data || {}).length }));
        }
      })
      .catch(() => {});
  }, [wsId, refreshSnapshots]);

  /* auto-fill name when personas or snapshots change */
  useEffect(() => {
    if (personas.length > 0) {
      const d = computeDefaults(personas, snapshots);
      setSnapName(d.name);
      setSnapDesc(d.desc);
    }
  }, [personas.length, snapshots.length, computeDefaults]);

  const handleSave = async () => {
    if (!snapName.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      await savePersonaSnapshot(wsId, snapName.trim(), snapDesc.trim());
      setMsg({ type: "ok", text: t("persona.snap.saved", { name: snapName.trim() }) });
      refreshSnapshots();
    } catch (e: any) {
      setMsg({ type: "err", text: e.message || t("persona.snap.save_failed") });
    }
    setSaving(false);
  };

  const handleLoad = async (s: any) => {
    if (!confirm(t("persona.snap.confirm_load", { name: s.name }))) return;
    setLoadingSnap(s.snapshot_id);
    setMsg(null);
    try {
      await loadPersonaSnapshot(wsId, s.snapshot_id);
      const res = await getWorkspacePersonas(wsId);
      if (res?.agents) setPersonas([...res.agents].reverse());
      setMsg({ type: "ok", text: t("persona.snap.loaded", { name: s.name, count: s.agent_count }) });
    } catch (e: any) {
      setMsg({ type: "err", text: e.message || t("persona.snap.load_failed") });
    }
    setLoadingSnap(null);
  };

  const handleDelete = async (s: any) => {
    if (!confirm(t("persona.snap.confirm_delete", { name: s.name }))) return;
    setMsg(null);
    try {
      await deletePersonaSnapshot(wsId, s.snapshot_id);
      setMsg({ type: "ok", text: t("persona.snap.deleted", { name: s.name }) });
      refreshSnapshots();
      if (expandedSnap === s.snapshot_id) setExpandedSnap(null);
    } catch (e: any) {
      setMsg({ type: "err", text: e.message || t("persona.snap.delete_failed") });
    }
  };

  /* ── snapshot detail: when expanded, load full persona list ── */
  const [snapPersonas, setSnapPersonas] = useState<Record<string, any[]>>({});
  const handleExpand = async (snapId: string) => {
    if (expandedSnap === snapId) {
      setExpandedSnap(null);
      return;
    }
    setExpandedSnap(snapId);
    // If we don't have personas for this snapshot, load it temporarily
    if (!snapPersonas[snapId]) {
      try {
        await loadPersonaSnapshot(wsId, snapId);
        const res = await getWorkspacePersonas(wsId);
        const agents = res?.agents || [];
        setSnapPersonas((prev) => ({ ...prev, [snapId]: agents }));
        // Restore current personas after peeking
        // (The "load" button is what permanently switches)
      } catch {
        // ignore
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "auto" }}>
      <GuideBanner
        guideKey="guide_persona"
        title="探索代理人"
        titleEn="Explore Agents"
        message="瀏覽已生成的代理人。每個代理人有人口特徵、人格特質和政治傾向。準備好後前往第 2 步：演化。"
        messageEn="Browse your generated agents. Each has demographics, personality traits, and political leaning. When ready, proceed to Step 2: Evolution."
      />
      <div style={{ padding: "clamp(16px, 2vw, 32px)", maxWidth: "100%" }}>

        {/* ── Header ── */}
        <h2 style={{ fontFamily: "var(--font-cjk)", fontSize: 20, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          🎭 {t("persona.title")}
        </h2>
        <p style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-muted)", marginBottom: 20, lineHeight: 1.6 }}>
          {t("persona.subtitle")}
        </p>

        {/* ── Save Current ── */}
        {personas.length > 0 && (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 700, color: "var(--text-secondary)", margin: 0 }}>
                {t("persona.save.title", { count: personas.length })}
              </h3>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 250px" }}>
                <label style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)" }}>{t("persona.save.name")}</label>
                <input className="input-field" value={snapName} onChange={(e) => setSnapName(e.target.value)}
                  style={{ fontSize: 12 }} placeholder={t("persona.snap.placeholder_name")} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 400px" }}>
                <label style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)" }}>{t("persona.save.note")}</label>
                <input className="input-field" value={snapDesc} onChange={(e) => setSnapDesc(e.target.value)}
                  style={{ fontSize: 12 }} placeholder={t("persona.snap.placeholder_note")} />
              </div>
              <button disabled={!snapName.trim() || saving} onClick={handleSave}
                style={{
                  padding: "8px 20px", borderRadius: 6, border: "none",
                  backgroundColor: !snapName.trim() || saving ? "rgba(124,58,237,0.3)" : "var(--accent-light)",
                  color: "#fff", fontSize: 12, fontFamily: "var(--font-cjk)", fontWeight: 600,
                  cursor: !snapName.trim() || saving ? "not-allowed" : "pointer", whiteSpace: "nowrap",
                }}>
                {saving ? t("persona.editor.saving") : t("persona.editor.save")}
              </button>
            </div>
          </div>
        )}

        {/* ── Message ── */}
        {msg && (
          <p style={{
            fontFamily: "var(--font-cjk)", fontSize: 12, marginBottom: 12,
            color: msg.type === "ok" ? "#4ade80" : "#ef4444",
          }}>
            {msg.text}
          </p>
        )}

        {/* ── Current Population: Batch Individuality Editor ── */}
        {personas.length > 0 && (() => {
          // Compute stats
          const biasGroups: Record<string, any[]> = {};
          const esGroups: Record<string, any[]> = {};
          personas.forEach(p => {
            const bias = p.individuality?.cognitive_bias || "未設定";
            const es = p.personality?.emotional_stability || "未設定";
            if (!biasGroups[bias]) biasGroups[bias] = [];
            biasGroups[bias].push(p);
            if (!esGroups[es]) esGroups[es] = [];
            esGroups[es].push(p);
          });
          const hasIdv = personas.some(p => p.individuality);

          const biasColors: Record<string, string> = {
            "樂觀偏向": "#22c55e", "悲觀偏向": "#ef4444", "理性分析": "#38bdf8",
            "從眾型": "#fbbf24", "陰謀論傾向": "#a855f7", "轉嫁怨氣": "#f97316", "無感冷漠": "#6b7280", "未設定": "#4b5563",
          };

          return (
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 700, color: "var(--text-secondary)", margin: 0 }}>
                  {t("persona.individuality.title", { count: personas.length })}
                </h3>
              </div>

              {!hasIdv ? (
                <div style={{ color: "var(--text-faint)", fontSize: 12, fontFamily: "var(--font-cjk)", padding: 20, textAlign: "center" }}>
                  {t("persona.individuality.empty")}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {/* Cognitive Bias Distribution */}
                  <div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-cjk)", marginBottom: 6 }}>{t("persona.individuality.bias_title")}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {Object.entries(biasGroups).sort((a, b) => b[1].length - a[1].length).map(([bias, agents]) => (
                        <div key={bias} style={{
                          padding: "6px 10px", borderRadius: 6,
                          background: (biasColors[bias] || "#6b7280") + "15",
                          border: `1px solid ${(biasColors[bias] || "#6b7280")}30`,
                          display: "flex", alignItems: "center", gap: 6,
                        }}>
                          <span style={{ color: biasColors[bias] || "#6b7280", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>
                            {tp(bias)}
                          </span>
                          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
                            {t("persona.percent_of", { count: agents.length, pct: Math.round(agents.length / personas.length * 100) })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Batch adjustment by emotional_stability */}
                  <div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-cjk)", marginBottom: 6 }}>{t("persona.individuality.type_title")}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {Object.entries(esGroups).sort((a, b) => b[1].length - a[1].length).map(([es, agents]) => {
                        const avgNoise = agents.reduce((s, a) => s + (a.individuality?.noise_scale || 1), 0) / agents.length;
                        const avgReact = agents.reduce((s, a) => s + (a.individuality?.reaction_multiplier || 1), 0) / agents.length;
                        const avgInertia = agents.reduce((s, a) => s + (a.individuality?.memory_inertia || 0.15), 0) / agents.length;
                        return (
                          <div key={es} style={{
                            padding: "6px 10px", borderRadius: 6, flex: "1 1 180px",
                            background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
                          }}>
                            <div style={{ color: "#c084fc", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-cjk)", marginBottom: 4 }}>
                              {tp(es)} — {t("persona.agents_count", { count: agents.length })}
                            </div>
                            <div style={{ display: "flex", gap: 8, fontSize: 9, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-mono)" }}>
                              <span>{t("persona.metric.noise")} {avgNoise.toFixed(1)}</span>
                              <span>{t("persona.metric.reaction")} {avgReact.toFixed(1)}</span>
                              <span>{t("persona.metric.inertia")} {avgInertia.toFixed(2)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Batch Actions */}
                  <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10 }}>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-cjk)", marginBottom: 4 }}>{t("persona.individuality.batch")}</div>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "var(--font-cjk)", marginBottom: 8, lineHeight: 1.6 }}>
                      {t("persona.individuality.batch_help")}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {[
                        { labelKey: "persona.batch.all_optimistic.label" as const,     tipKey: "persona.batch.all_optimistic.tip" as const,     filter: {}, set: { cognitive_bias: "樂觀偏向" }, color: "#22c55e" },
                        { labelKey: "persona.batch.all_rational.label" as const,       tipKey: "persona.batch.all_rational.tip" as const,       filter: {}, set: { cognitive_bias: "理性分析" }, color: "#38bdf8" },
                        { labelKey: "persona.batch.sensitive_pessimistic.label" as const, tipKey: "persona.batch.sensitive_pessimistic.tip" as const, filter: { emotional_stability: "敏感衝動" }, set: { cognitive_bias: "悲觀偏向" }, color: "#ef4444" },
                        { labelKey: "persona.batch.stable_rational.label" as const,    tipKey: "persona.batch.stable_rational.tip" as const,    filter: { emotional_stability: "穩定冷靜" }, set: { cognitive_bias: "理性分析" }, color: "#38bdf8" },
                        { labelKey: "persona.batch.noise_up.label" as const,           tipKey: "persona.batch.noise_up.tip" as const,           filter: {}, set: { _scale: { noise_scale: 1.5 } }, color: "#c084fc" },
                        { labelKey: "persona.batch.noise_down.label" as const,         tipKey: "persona.batch.noise_down.tip" as const,         filter: {}, set: { _scale: { noise_scale: 0.5 } }, color: "#c084fc" },
                        { labelKey: "persona.batch.reaction_up.label" as const,        tipKey: "persona.batch.reaction_up.tip" as const,        filter: {}, set: { _scale: { reaction_multiplier: 1.5 } }, color: "#38bdf8" },
                        { labelKey: "persona.batch.inertia_up.label" as const,         tipKey: "persona.batch.inertia_up.tip" as const,         filter: {}, set: { _scale: { memory_inertia: 1.5 } }, color: "#22c55e" },
                      ].map((action, i) => (
                        <button key={i}
                          onClick={async () => {
                            const scale = (action.set as any)._scale;
                            if (scale) {
                              // Scale mode: multiply current values
                              const updates: Record<string, any> = {};
                              personas.forEach(p => {
                                if (!p.individuality) return;
                                let match = true;
                                for (const [fk, fv] of Object.entries(action.filter)) {
                                  if ((p.personality || {})[fk] !== fv && p[fk] !== fv) { match = false; break; }
                                }
                                if (match) {
                                  const changes: Record<string, number> = {};
                                  for (const [k, mult] of Object.entries(scale)) {
                                    const current = p.individuality[k] || 1;
                                    changes[k] = Math.round(current * (mult as number) * 100) / 100;
                                  }
                                  updates[String(p.person_id)] = changes;
                                }
                              });
                              if (Object.keys(updates).length === 0) return;
                              try {
                                await apiFetch(`/api/workspaces/${wsId}/agents/batch-individuality`, {
                                  method: "PATCH", body: JSON.stringify({ updates }),
                                });
                                const res = await getWorkspacePersonas(wsId);
                                setPersonas(res?.agents || []);
                              } catch (e: any) { alert(t("persona.action.failed", { msg: e.message })); }
                            } else {
                              // Direct set mode
                              try {
                                await apiFetch(`/api/workspaces/${wsId}/agents/batch-individuality`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ filter: action.filter, set: action.set }),
                                });
                                const res = await getWorkspacePersonas(wsId);
                                setPersonas(res?.agents || []);
                              } catch (e: any) { alert(t("persona.action.failed", { msg: e.message })); }
                            }
                          }}
                          title={t(action.tipKey)}
                          style={{
                            padding: "4px 10px", borderRadius: 5,
                            border: `1px solid ${action.color}40`,
                            background: `${action.color}10`,
                            color: action.color, fontSize: 10, cursor: "pointer",
                            fontFamily: "var(--font-cjk)", fontWeight: 600,
                          }}
                        >
                          {t(action.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Detailed table (collapsible) */}
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: "pointer", fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)" }}>
                  {t("persona.individuality.expand_table")}
                </summary>
                <div style={{ marginTop: 8 }}>
                  <PersonaTable personas={personas} wsId={wsId} onUpdate={() => {
                    getWorkspacePersonas(wsId).then((res) => {
                      const agents = res?.agents || (Array.isArray(res) ? res : []);
                      setPersonas(agents);
                    });
                  }} />
                </div>
              </details>
            </div>
          );
        })()}

        {/* ── Snapshot List ── */}
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 700, color: "var(--text-secondary)", margin: 0 }}>
              📦 {t("persona.snapshots", { count: snapshots.length })}
            </h3>
            <button onClick={refreshSnapshots}
              style={{ padding: "4px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600, fontFamily: "var(--font-cjk)", border: "1px solid var(--border-input)", backgroundColor: "transparent", color: "var(--text-secondary)", cursor: "pointer" }}>
              {t("persona.refresh")}
            </button>
          </div>

          {snapshots.length === 0 ? (
            <p style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-faint)", textAlign: "center", padding: "24px 0" }}>
              {t("persona.snapshots_empty")}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {snapshots.map((s) => {
                const created = s.created_at ? new Date(s.created_at * 1000) : null;
                const vendorEntries = Object.entries(s.llm_vendors || {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
                const genderEntries = Object.entries(s.gender_dist || {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
                const leanEntries = Object.entries(s.leaning_dist || {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
                const isExpanded = expandedSnap === s.snapshot_id;
                const isLoading = loadingSnap === s.snapshot_id;
                const view = expandedView[s.snapshot_id] || "stats";

                return (
                  <div key={s.snapshot_id} style={{
                    borderRadius: 8,
                    backgroundColor: isExpanded ? "rgba(124,58,237,0.04)" : "rgba(255,255,255,0.02)",
                    border: isExpanded ? "1px solid rgba(124,58,237,0.15)" : "1px solid rgba(255,255,255,0.06)",
                    transition: "all 0.2s ease",
                  }}>
                    {/* ── Card Header (always visible) ── */}
                    <div style={{ padding: 14, cursor: "pointer" }}
                      onClick={() => handleExpand(s.snapshot_id)}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
                              {isExpanded ? "▼" : "▶"}
                            </span>
                            <span style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
                              {s.name}
                            </span>
                            <span style={{
                              padding: "1px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600,
                              fontFamily: "var(--font-mono)",
                              backgroundColor: "rgba(124,58,237,0.12)", color: "#a78bfa",
                            }}>
                              {t("persona.agents_count", { count: s.agent_count })}
                            </span>
                            <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}>
                              {s.strategy?.toUpperCase()}
                            </span>
                          </div>
                          {s.description && (
                            <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-muted)", margin: "0 0 4px 20px", lineHeight: 1.5 }}>
                              {s.description}
                            </p>
                          )}
                          {created && (
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-faint)", marginLeft: 20 }}>
                              {created.toLocaleString()}
                            </span>
                          )}
                        </div>

                        {/* Action buttons */}
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}
                          onClick={(e) => e.stopPropagation()}>
                          <button disabled={isLoading} onClick={() => handleLoad(s)}
                            style={{
                              padding: "5px 14px", borderRadius: 6, border: "none",
                              backgroundColor: isLoading ? "rgba(74,222,128,0.2)" : "rgba(74,222,128,0.15)",
                              color: "#4ade80", fontSize: 11, fontFamily: "var(--font-cjk)", fontWeight: 600,
                              cursor: isLoading ? "wait" : "pointer",
                            }}>
                            {isLoading ? t("persona.snap.loading") : t("persona.snap.load_btn")}
                          </button>
                          <button onClick={() => handleDelete(s)}
                            style={{
                              padding: "5px 10px", borderRadius: 6,
                              border: "1px solid rgba(239,68,68,0.3)",
                              backgroundColor: "transparent", color: "#ef4444",
                              fontSize: 11, fontFamily: "var(--font-cjk)", fontWeight: 600, cursor: "pointer",
                            }}>
                            🗑
                          </button>
                        </div>
                      </div>

                      {/* Mini badges row */}
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8, marginLeft: 20 }}>
                        {vendorEntries.map(([v, c]) => (
                          <span key={v} style={{
                            padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 600,
                            fontFamily: "var(--font-mono)",
                            backgroundColor: (vendorColors[v] || "#6b7280") + "22",
                            color: vendorColors[v] || "#6b7280",
                          }}>
                            {v.toUpperCase()} {c}
                          </span>
                        ))}
                        {genderEntries.map(([g, c]) => (
                          <span key={g} style={{
                            padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 600,
                            fontFamily: "var(--font-cjk)",
                            backgroundColor: "rgba(148,163,184,0.12)", color: "#94a3b8",
                          }}>
                            {tp(g)} {c}
                          </span>
                        ))}
                        {s.district_count > 0 && (
                          <span style={{
                            padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 600,
                            fontFamily: "var(--font-cjk)",
                            backgroundColor: "rgba(96,165,250,0.12)", color: "#60a5fa",
                          }}>
                            {t("persona.snap.districts_count", { count: s.district_count })}
                          </span>
                        )}
                      </div>

                      {/* Leaning mini-bar */}
                      {leanEntries.length > 0 && (
                        <div style={{ marginLeft: 20, marginTop: 6 }}>
                          <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden" }}>
                            {leanEntries.map(([label, count]) => (
                              <div key={label} title={`${tp(label)}: ${count}`}
                                style={{ flex: count, backgroundColor: leaningColors[label] || "#6b7280", opacity: 0.7 }} />
                            ))}
                          </div>
                          <div style={{ display: "flex", gap: 8, marginTop: 3 }}>
                            {leanEntries.map(([label, count]) => (
                              <span key={label} style={{ fontSize: 9, fontFamily: "var(--font-cjk)", color: leaningColors[label] || "#6b7280" }}>
                                {tp(label)} {count}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* ── Expanded Detail ── */}
                    {isExpanded && (
                      <div style={{ padding: "0 14px 14px 14px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                        {/* View toggle */}
                        <div style={{ display: "flex", gap: 4, marginTop: 12, marginBottom: 12 }}>
                          {(["stats", "table"] as const).map((mode) => (
                            <button key={mode}
                              onClick={() => setExpandedView((prev) => ({ ...prev, [s.snapshot_id]: mode }))}
                              style={{
                                padding: "4px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                                fontFamily: "var(--font-cjk)", border: "none", cursor: "pointer",
                                backgroundColor: view === mode ? "var(--accent)" : "rgba(255,255,255,0.04)",
                                color: view === mode ? "#fff" : "var(--text-muted)",
                              }}>
                              {mode === "stats" ? t("persona.snap.view_stats") : t("persona.snap.view_table")}
                            </button>
                          ))}
                        </div>

                        {snapPersonas[s.snapshot_id] ? (
                          view === "stats" ? (
                            <StatsGrid personas={snapPersonas[s.snapshot_id]} />
                          ) : (
                            <PersonaTable personas={snapPersonas[s.snapshot_id]} wsId={wsId} />
                          )
                        ) : (
                          <p style={{ fontFamily: "var(--font-cjk)", fontSize: 12, color: "var(--text-faint)", textAlign: "center", padding: 16 }}>
                            {t("persona.snap.loading")}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Current population preview (if no snapshots yet) ── */}
        {personas.length > 0 && snapshots.length === 0 && (
          <div className="card" style={{ marginTop: 20 }}>
            <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 12 }}>
              {t("persona.current_overview", { count: personas.length })}
            </h3>
            <StatsGrid personas={personas} />
          </div>
        )}

      </div>
    </div>
  );
}
