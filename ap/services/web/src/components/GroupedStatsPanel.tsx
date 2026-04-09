"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { getAllAgentStats } from "@/lib/api";

/* ── Colour maps ──────────────────────────────────────────────── */

const LEANING_COLORS: Record<string, string> = {
  "Solid Dem": "#1e40af", "Lean Dem": "#3b82f6", "Tossup": "#94a3b8",
  "Lean Rep": "#ef4444", "Solid Rep": "#991b1b", "Unknown": "#6b7280",
};

const VENDOR_COLORS: Record<string, string> = {
  openai: "#10a37f", gemini: "#4285f4", template: "#fbbf24", "Unknown": "#6b7280",
};

const CAND_FALLBACK = ["#8b5cf6", "#ec4899", "#f59e0b", "#94a3b8"];

/* Per-party color palettes: each same-party candidate gets a distinct shade */
const PARTY_PALETTES: Record<string, string[]> = {
  D: ["#3b82f6", "#60a5fa", "#1d4ed8", "#93c5fd", "#1e3a8a"],   // Dem blue variants
  R: ["#ef4444", "#f87171", "#b91c1c", "#fca5a5", "#7f1d1d"],   // Rep red variants
  I: ["#a855f7", "#c084fc", "#7e22ce", "#d8b4fe", "#581c87"],   // Independent purple
};

function detectPartyId(name: string, description: string): string | null {
  const text = `${name} ${description}`.toLowerCase();
  if (text.toLowerCase().includes("republican") || text.includes("(R)")) return "R";
  if (text.toLowerCase().includes("democrat") || text.includes("(D)")) return "D";
  if (text.toLowerCase().includes("independent") || text.includes("(I)")) return "I";
  
  
  
  return null;
}

/** Auto-detect Taiwan political party color from candidate name + description */
function detectPartyColor(name: string, description: string): string {
  const pid = detectPartyId(name, description);
  return pid ? PARTY_PALETTES[pid][0] : "";
}

/** Get candidate colors array from poll options — same-party candidates get distinct shades */
function getCandidateColors(pollOptions: { name: string; description: string }[]): string[] {
  const partyUsageCount: Record<string, number> = {};
  let fallbackIdx = 0;
  return pollOptions.map(opt => {
    const pid = detectPartyId(opt.name, opt.description);
    if (pid) {
      const idx = partyUsageCount[pid] || 0;
      partyUsageCount[pid] = idx + 1;
      const palette = PARTY_PALETTES[pid];
      return palette[idx % palette.length];
    }
    return CAND_FALLBACK[fallbackIdx++ % CAND_FALLBACK.length];
  });
}

/* ── Leaning-based candidate tendency model ──────────────────── */

/** Estimate support share per candidate per group using political leaning + satisfaction.
 *  For a 2-person race: higher satisfaction + 統 leaning → candidate A (typically KMT);
 *  lower satisfaction + 本土 leaning → candidate B (typically DPP). */
function estimateCandidateShares(items: any[], candidateNames: string[]) {
  if (!candidateNames || candidateNames.length === 0) return {};
  const n = candidateNames.length;
  // Accumulate per-candidate support scores
  const scores: number[] = new Array(n).fill(0);
  let total = 0;

  // Simple string hasher for pseudo-random variance in the heuristic
  const hashString = (s: string) => s.split('').reduce((h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 0);

  for (const a of items) {
    const sat = a.satisfaction ?? 50;
    const anx = a.anxiety ?? 50;
    const leaning = (a.political_leaning || "").toLowerCase();

    // Base: first candidate gets sat-scaled score, second gets (100-sat)-scaled
    if (n === 2) {
      // For 2-candidate race: blue-leaning → first candidate (higher sat = more support)
      // green-leaning → second candidate (lower sat = more support for alternative)
      let leanBias = 0.5; // neutral
      if (leaning.includes("Rep")) leanBias = 0.7;
      else if (leaning.includes("Dem")) leanBias = 0.3;
      
      

      // Satisfaction influence: high sat → support first candidate more
      const satFactor = sat / 100;
      const anxFactor = anx / 100;

      // Inject deterministic candidate-name variance into the heuristic bias (-0.05 to +0.05)
      const candHash = Math.abs(hashString(candidateNames[0]));
      const variance = ((candHash % 100) / 100) * 0.1 - 0.05;

      // Combined: lean toward first candidate with sat, lean away with anxiety
      const supportFirst = Math.max(0, Math.min(1, leanBias * 0.5 + satFactor * 0.3 + (1 - anxFactor) * 0.2 + variance));
      scores[0] += supportFirst;
      scores[1] += (1 - supportFirst);
      total += 1;
    } else {
      // For N > 2 candidates: distribute based on leaning position
      for (let ci = 0; ci < n; ci++) {
        const candHash = Math.abs(hashString(candidateNames[ci]));
        const variance = ((candHash % 100) / 100) * 0.2;
        scores[ci] += (1 / n) + variance;
      }
      total += 1;
    }
  }

  if (total === 0) return {};
  const result: Record<string, number> = {};
  for (let ci = 0; ci < n; ci++) {
    result[candidateNames[ci]] = Math.round((scores[ci] / total) * 1000) / 10;
  }
  return result;
}

/* ── Group wrapper (collapsible) ─────────────────────────────── */

function CollapsibleGroup({ title, defaultOpen = false, children }: { title: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderRadius: 10, backgroundColor: "rgba(0,0,0,0.15)", border: "1px solid rgba(139,92,246,0.2)", marginBottom: 16, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", padding: "14px 18px", border: "none", background: open ? "rgba(139,92,246,0.1)" : "transparent",
          cursor: "pointer", fontFamily: "var(--font-cjk)", fontSize: 15, fontWeight: 700,
          color: "#c4b5fd", textAlign: "left", transition: "background 0.2s"
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 12, color: "#8b5cf6", transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
      </button>
      {open && (
        <div style={{ padding: "16px" }}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ── DualBarPanel sub-component (collapsible) ────────────────── */

function DualBarPanel({ title, groups, colorMap, defaultOpen = false, satLabel = "Satisfaction", anxLabel = "Anxiety" }: {
  title: string;
  groups: [string, { items: any[]; avgSat: number; avgAnx: number }][];
  colorMap?: Record<string, string>;
  defaultOpen?: boolean;
  satLabel?: string;
  anxLabel?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderRadius: 8, backgroundColor: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", marginBottom: 10, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", padding: "10px 16px", border: "none", background: "transparent",
          cursor: "pointer", fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600,
          color: "var(--text-secondary)", textAlign: "left",
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 10, color: "var(--text-faint)", transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 14px" }}>
          <div style={{ display: "flex", gap: 4, fontSize: 10, marginBottom: 10, color: "var(--text-faint)" }}>
            <span style={{ color: "#4ade80" }}>■ {satLabel}</span>
            <span style={{ color: "#f87171", marginLeft: 10 }}>■ {anxLabel}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {groups.map(([label, data]) => (
              <div key={label}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{
                    minWidth: 110, fontFamily: "var(--font-cjk)", fontSize: 12,
                    fontWeight: 600, textAlign: "right",
                    color: colorMap?.[label] || "var(--text-secondary)",
                  }}>
                    {label} ({data.items.length})
                  </span>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ height: 12, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.04)", overflow: "hidden" }}>
                      <div style={{
                        height: "100%", borderRadius: 3,
                        width: `${data.avgSat}%`,
                        backgroundColor: "#4ade80", opacity: 0.7,
                        transition: "width 0.4s ease",
                      }} />
                    </div>
                    <div style={{ height: 12, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.04)", overflow: "hidden" }}>
                      <div style={{
                        height: "100%", borderRadius: 3,
                        width: `${data.avgAnx}%`,
                        backgroundColor: "#f87171", opacity: 0.7,
                        transition: "width 0.4s ease",
                      }} />
                    </div>
                  </div>
                  <div style={{ minWidth: 80, fontFamily: "var(--font-mono)", fontSize: 10, textAlign: "right" }}>
                    <div style={{ color: "#4ade80" }}>{data.avgSat.toFixed(1)}</div>
                    <div style={{ color: "#f87171" }}>{data.avgAnx.toFixed(1)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── CandidateBarPanel — shows estimated candidate support per group ── */

function CandidateBarPanel({ title, groups, candidateNames, candidateColors, colorMap, defaultOpen = false, overrideShares, filterByOverride = false }: {
  title: string;
  groups: [string, { items: any[]; avgSat: number; avgAnx: number }][];
  candidateNames: string[];
  candidateColors: string[];
  colorMap?: Record<string, string>;
  defaultOpen?: boolean;
  /** Optional: backend-supplied shares per group label, e.g. { "Lean Rep": { "Trump": 60, "Harris": 40 } } */
  overrideShares?: Record<string, Record<string, number>>;
  /** When true, only show groups that have data in overrideShares (hides fallback rows) */
  filterByOverride?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderRadius: 8, backgroundColor: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", marginBottom: 10, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", padding: "10px 16px", border: "none", background: "transparent",
          cursor: "pointer", fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600,
          color: "var(--text-secondary)", textAlign: "left",
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 10, color: "var(--text-faint)", transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 14px" }}>
          {/* Legend */}
          <div style={{ display: "flex", gap: 12, fontSize: 10, marginBottom: 10, color: "var(--text-faint)" }}>
            {candidateNames.map((name, ci) => (
              <span key={name} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: candidateColors[ci] || "#8b5cf6", display: "inline-block" }} />
                <span style={{ color: candidateColors[ci] || "#8b5cf6", fontFamily: "var(--font-cjk)", fontWeight: 600 }}>{name}</span>
              </span>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(filterByOverride && overrideShares
              ? groups.filter(([label]) => overrideShares[label])
              : groups
            ).map(([label, data]) => {
              // Use backend override if available, else heuristic
              const isOverrideHit = overrideShares && overrideShares[label] !== undefined;
              const shares = overrideShares?.[label] || estimateCandidateShares(data.items, candidateNames);
              const shareEntries = candidateNames.map(cn => ({ name: cn, pct: shares[cn] || 0 }));
              const maxPct = Math.max(...shareEntries.map(s => s.pct), 1);
              const leader = shareEntries.reduce((a, b) => a.pct > b.pct ? a : b);

              return (
                <div key={label}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <span style={{
                      minWidth: 110, fontFamily: "var(--font-cjk)", fontSize: 12,
                      fontWeight: 600, textAlign: "right",
                      color: isOverrideHit ? "#ec4899" : (colorMap?.[label] || "var(--text-secondary)"),
                    }}>
                      {label} ({data.items.length}) {isOverrideHit ? "★" : ""}
                    </span>
                    {/* Stacked horizontal bar */}
                    <div style={{ flex: 1, display: "flex", height: 22, borderRadius: 4, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.04)" }}>
                      {shareEntries.map((s, ci) => (
                        <div key={s.name} style={{
                          width: `${s.pct}%`,
                          height: "100%",
                          backgroundColor: candidateColors[ci] || "#8b5cf6",
                          opacity: s.name === leader.name ? 0.9 : 0.5,
                          transition: "width 0.4s ease",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 9, fontWeight: 700, color: "#fff",
                          whiteSpace: "nowrap", overflow: "hidden",
                        }}>
                          {s.pct >= 15 && `${s.pct.toFixed(0)}%`}
                        </div>
                      ))}
                    </div>
                    {/* Numeric labels */}
                    <div style={{ minWidth: 100, fontFamily: "var(--font-mono)", fontSize: 10, textAlign: "right", display: "flex", flexDirection: "column" }}>
                      {shareEntries.map((s, ci) => (
                        <div key={s.name} style={{ color: candidateColors[ci] || "#8b5cf6", fontWeight: s.name === leader.name ? 800 : 400 }}>
                          {s.name === leader.name ? "👑 " : ""}{s.pct.toFixed(1)}%
                        </div>
                      ))}
                    </div>
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

/* ── DemographicPiePanel — shows political leaning OR candidate support pies ── */

function DemographicPiePanel({ title, agents, colorMap, defaultOpen = false, isPrimary = false, candidateNames = [], candidateColors = [], overrideDistrictShares, overrideOverallShares }: {
  title: string;
  agents: any[];
  colorMap: Record<string, string>;
  defaultOpen?: boolean;
  /** When true, show candidate support distribution instead of political leaning */
  isPrimary?: boolean;
  candidateNames?: string[];
  candidateColors?: string[];
  /** Live backend district estimates: { district: { candidateName: pct } } */
  overrideDistrictShares?: Record<string, Record<string, number>>;
  /** Live backend overall estimates: { candidateName: pct } */
  overrideOverallShares?: Record<string, number>;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Overall counts
  const overallCounts: Record<string, number> = {};
  const shiftedAgents: any[] = []; // Track who shifted

  agents.forEach(a => {
    // Normalise string for colorMap
    let l = (a.political_leaning || "Unknown").trim();
    if (l !== "Unknown") {
       // if we can't find exact, fall back
       if (!colorMap[l]) {
          // just try to find partial match
          if (l.includes("Rep")) { /* keep as-is */ }
          else if (l.includes("Dem")) { /* keep as-is */ }
          else if (l.includes("Tossup") || l.includes("Indep")) { /* keep as-is */ }
       }
    }
    overallCounts[l] = (overallCounts[l] || 0) + 1;

    // Use backend-supplied shift logs if available
    if (a.leaning_shift_logs && a.leaning_shift_logs.length > 0) {
      a.leaning_shift_logs.forEach((log: any) => {
        shiftedAgents.push({
          name: a.name,
          day: log.day,
          from: log.from,
          to: log.to,
          news: log.news,
          reasoning: log.reasoning,
        });
      });
    }
  });

  // Sort shifts chronologically by day
  shiftedAgents.sort((a, b) => a.day - b.day);

  const overallData = Object.entries(overallCounts)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // --- Primary mode: compute candidate support data ---
  const candColorMap: Record<string, string> = {};
  if (isPrimary && candidateNames.length >= 2) {
    candidateNames.forEach((cn, ci) => { candColorMap[cn] = candidateColors[ci] || CAND_FALLBACK[ci % CAND_FALLBACK.length]; });
  }
  // Use live override if available, else heuristic
  const overallCandSharesRaw = overrideOverallShares && Object.keys(overrideOverallShares).length > 0
    ? overrideOverallShares
    : (isPrimary && candidateNames.length >= 2 ? estimateCandidateShares(agents, candidateNames) : {});
  const overallCandData = Object.entries(overallCandSharesRaw)
    .filter(([name]) => name !== "Undecided" && name !== "不表態")
    .map(([name, pct]) => ({ name, value: Math.round((pct as number) * agents.length / 100) || 1 }))
    .sort((a, b) => b.value - a.value);

  // District counts (by political leaning — used in non-primary mode)
  const districtMap: Record<string, Record<string, number>> = {};
  // District agents list (for primary mode candidate estimation)
  const districtAgents: Record<string, any[]> = {};
  agents.forEach(a => {
    const d = a.district || "Unknown";
    let l = (a.political_leaning || "Unknown").trim();
    if (l !== "Unknown" && !colorMap[l]) {
       if (l.includes("Rep")) { /* keep as-is */ }
       else if (l.includes("Dem")) { /* keep as-is */ }
       else if (l.includes("Tossup") || l.includes("Indep")) { /* keep as-is */ }
    }
    if (!districtMap[d]) districtMap[d] = {};
    districtMap[d][l] = (districtMap[d][l] || 0) + 1;
    // Also collect agents per district for candidate estimation
    if (!districtAgents[d]) districtAgents[d] = [];
    districtAgents[d].push(a);
  });
  const districts = Object.keys(districtMap).sort();

  return (
    <div style={{ borderRadius: 8, backgroundColor: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", marginBottom: 10, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", padding: "10px 16px", border: "none", background: "transparent",
          cursor: "pointer", fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600,
          color: "var(--text-secondary)", textAlign: "left",
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 10, color: "var(--text-faint)", transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 14px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
            {/* Overall Pie */}
            <div style={{ flex: "1 1 300px", minWidth: 260, display: "flex", flexDirection: "column", alignItems: "center", background: "rgba(0,0,0,0.2)", padding: 16, borderRadius: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", marginBottom: 8, fontFamily: "var(--font-cjk)" }}>
                {isPrimary && candidateNames.length >= 2
                  ? `🗳️ Overall candidate support (${agents.length} agents)`
                  : `🌍 Overall political leaning (${agents.length} agents)`}
              </div>
              {/* Legend for primary mode */}
              {isPrimary && candidateNames.length >= 2 && (
                <div style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 11, fontFamily: "var(--font-cjk)" }}>
                  {candidateNames.map((cn, ci) => (
                    <span key={cn} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: candidateColors[ci] || CAND_FALLBACK[ci], display: "inline-block" }} />
                      <span style={{ color: candidateColors[ci] || CAND_FALLBACK[ci], fontWeight: 600 }}>{cn}</span>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ width: "100%", height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    {isPrimary && candidateNames.length >= 2 ? (
                      <Pie data={overallCandData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={65} innerRadius={0} isAnimationActive={false}
                        label={({ name, percent, midAngle, outerRadius: or2, cx: cx2, cy: cy2 }: any) => {
                          const RADIAN = Math.PI / 180;
                          const radius = or2 + 20;
                          const x = cx2 + radius * Math.cos(-midAngle * RADIAN);
                          const y = cy2 + radius * Math.sin(-midAngle * RADIAN);
                          return <text x={x} y={y} fill="rgba(255,255,255,0.9)" fontSize={12} fontWeight={700} fontFamily="var(--font-cjk)" textAnchor={x > cx2 ? "start" : "end"} dominantBaseline="central">{`${name} ${(percent * 100).toFixed(1)}%`}</text>;
                        }}
                        labelLine={{ stroke: "rgba(255,255,255,0.3)", strokeWidth: 1 }}>
                        {overallCandData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={candColorMap[entry.name] || CAND_FALLBACK[index % CAND_FALLBACK.length]} stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
                        ))}
                      </Pie>
                    ) : (
                      <Pie data={overallData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={65} innerRadius={0} isAnimationActive={false}
                        label={({ name, percent, midAngle, outerRadius: or2, cx: cx2, cy: cy2 }: any) => {
                          const RADIAN = Math.PI / 180;
                          const radius = or2 + 20;
                          const x = cx2 + radius * Math.cos(-midAngle * RADIAN);
                          const y = cy2 + radius * Math.sin(-midAngle * RADIAN);
                          return <text x={x} y={y} fill="rgba(255,255,255,0.9)" fontSize={12} fontWeight={700} fontFamily="var(--font-cjk)" textAnchor={x > cx2 ? "start" : "end"} dominantBaseline="central">{`${name} ${(percent * 100).toFixed(1)}%`}</text>;
                        }}
                        labelLine={{ stroke: "rgba(255,255,255,0.3)", strokeWidth: 1 }}>
                        {overallData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={colorMap[entry.name] || "var(--text-secondary)"} stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
                        ))}
                      </Pie>
                    )}
                    <Tooltip contentStyle={{ backgroundColor: "rgba(0,0,0,0.8)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12, color: "#fff" }} itemStyle={{ color: "#fff" }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* District Pies Grid */}
            <div style={{ flex: "2 1 400px", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", fontFamily: "var(--font-cjk)", paddingLeft: 4 }}>
                {isPrimary && candidateNames.length >= 2
                  ? "📍 Candidate support by state/district"
                  : "📍 Political leaning by state/district"}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 12 }}>
                {districts.map(dist => {
                  const dTotal = (districtAgents[dist] || []).length;
                  // Primary mode: candidate shares per district
                  if (isPrimary && candidateNames.length >= 2) {
                    // Use live override if available, else heuristic
                    const dSharesRaw = overrideDistrictShares?.[dist] || estimateCandidateShares(districtAgents[dist] || [], candidateNames);
                    const dCandData = Object.entries(dSharesRaw)
                      .filter(([name]) => name !== "Undecided" && name !== "不表態")
                      .map(([name, pct]) => ({ name, value: Math.round((pct as number) * dTotal / 100) || 1 }))
                      .sort((a, b) => b.value - a.value);
                    return (
                      <div key={dist} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 8, padding: "8px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4, fontFamily: "var(--font-cjk)", fontWeight: 600 }}>{dist} ({dTotal})</div>
                        <div style={{ width: "100%", height: 100 }}>
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie data={dCandData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={38} isAnimationActive={false}>
                                {dCandData.map((entry, index) => (
                                  <Cell key={`cell-${index}`} fill={candColorMap[entry.name] || CAND_FALLBACK[index % CAND_FALLBACK.length]} stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
                                ))}
                              </Pie>
                              <Tooltip contentStyle={{ backgroundColor: "rgba(0,0,0,0.8)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11, padding: "4px 8px" }} itemStyle={{ color: "#fff", padding: 0 }} />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    );
                  }
                  // Non-primary: political leaning pie
                  const dDataRaw = districtMap[dist];
                  const dData = Object.entries(dDataRaw).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
                  return (
                    <div key={dist} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 8, padding: "8px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4, fontFamily: "var(--font-cjk)", fontWeight: 600 }}>{dist} ({dTotal})</div>
                      <div style={{ width: "100%", height: 100 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie data={dData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={38} isAnimationActive={false}>
                              {dData.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={colorMap[entry.name] || "var(--text-secondary)"} stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
                              ))}
                            </Pie>
                            <Tooltip contentStyle={{ backgroundColor: "rgba(0,0,0,0.8)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11, padding: "4px 8px" }} itemStyle={{ color: "#fff", padding: 0 }} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Shifted Agents Log */}
          {shiftedAgents.length > 0 && (
            <div style={{ marginTop: 16, padding: "12px 16px", background: "rgba(245, 158, 11, 0.05)", border: "1px solid rgba(245, 158, 11, 0.2)", borderRadius: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#f59e0b", marginBottom: 8, fontFamily: "var(--font-cjk)", display: "flex", alignItems: "center", gap: 6 }}>
                <span>⚠️</span> Political leaning shifts ({shiftedAgents.length} agents)
              </div>
              <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 8 }}>
                {shiftedAgents.map((sa, i) => (
                  <div key={i} style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", padding: "8px 10px", background: "rgba(0,0,0,0.2)", borderRadius: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ background: "rgba(255,255,255,0.1)", padding: "2px 6px", borderRadius: 4, fontSize: 10, color: "var(--text-faint)", fontWeight: 600 }}>第 {sa.day} 天</span>
                      <span style={{ color: "#fff", fontWeight: 600, fontSize: 12 }}>{sa.name}</span>
                      <span style={{ color: "var(--text-faint)" }}>：</span>
                      <span style={{ color: colorMap[sa.from] || "#94a3b8", fontWeight: 600 }}>{sa.from}</span>
                      <span style={{ color: "var(--text-faint)" }}>➡️</span>
                      <span style={{ color: colorMap[sa.to] || "#94a3b8", fontWeight: 600 }}>{sa.to}</span>
                    </div>
                    {sa.news && (
                      <div style={{ color: "var(--text-secondary)", marginBottom: 2, background: "rgba(59, 130, 246, 0.1)", borderLeft: "2px solid #3b82f6", padding: "2px 6px", borderRadius: "0 4px 4px 0" }}>
                        <span style={{ color: "var(--text-faint)", marginRight: 4 }}>🗞️ News:</span>{sa.news}
                      </div>
                    )}
                    {sa.reasoning && (
                      <div style={{ color: "var(--text-faint)", fontStyle: "italic", paddingLeft: 6, opacity: 0.8 }}>
                        「{sa.reasoning}」
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main exported component ─────────────────────────────────── */

interface GroupedStatsPanelProps {
  personas: any[];
  btnStyle?: React.CSSProperties;
  autoRefresh?: boolean;
  refreshInterval?: number;
  /** Poll options with name + description for party color detection */
  pollOptions?: { name: string; description: string }[];
  /** Multiple poll groups for multi-matchup mode */
  pollGroups?: { id: string; name: string; groupType?: "comparison" | "head2head"; agentFilter?: { leanings: string[] }; candidates: { id: string; name: string; description: string }[] }[];
  /** Backend group estimates: { groupName: { candidateName: pct } } */
  jobGroupEstimates?: Record<string, Record<string, number>>;
  /** Backend group leaning candidate: { groupName: { leaning: { candidateName: pct } } } */
  jobGroupLeanCand?: Record<string, Record<string, Record<string, number>>>;
  /** Backend district candidate per group: { groupName: { district: { candidateName: pct } } } */
  jobDistrictEstimates?: Record<string, Record<string, Record<string, number>>>;
  /** Backend gender candidate per group: { groupName: { gender: { candidateName: pct } } } */
  jobGenderEstimates?: Record<string, Record<string, Record<string, number>>>;
  /** Backend vendor candidate per group: { groupName: { vendor: { candidateName: pct } } } */
  jobVendorEstimates?: Record<string, Record<string, Record<string, number>>>;
}

export default function GroupedStatsPanel({ personas, btnStyle, autoRefresh = false, refreshInterval = 5000, pollOptions, pollGroups, jobGroupEstimates, jobGroupLeanCand, jobDistrictEstimates, jobGenderEstimates, jobVendorEstimates }: GroupedStatsPanelProps) {
  const hasMultiGroups = pollGroups && pollGroups.length > 1 && pollGroups.some(g => g.candidates.some(c => c.name));
  const isCandidateMode = hasMultiGroups || (pollOptions && pollOptions.length > 0);
  // Primary mode: detect if any group is head2head (same-party primary)
  const isPrimaryMode = hasMultiGroups && pollGroups!.some(g => g.groupType === "head2head");
  // For primary pie: use the head2head group's candidates
  const primaryGroup = isPrimaryMode ? pollGroups!.find(g => g.groupType === "head2head") : null;
  const primaryCandNames = primaryGroup ? primaryGroup.candidates.filter(c => c.name).map(c => c.name) : [];
  const primaryCandColors = primaryGroup ? getCandidateColors(primaryGroup.candidates.filter(c => c.name)) : [];
  // For multi-group: build per-group candidate data
  const groupCandidates = hasMultiGroups ? pollGroups!.map(g => ({
    name: g.name,
    candidateNames: g.candidates.filter(c => c.name).map(c => c.name),
    candidateColors: getCandidateColors(g.candidates.filter(c => c.name)),
  })) : [];
  // Fallback single-group
  const candidateNames = hasMultiGroups ? groupCandidates[0].candidateNames : (pollOptions ? pollOptions.map(o => o.name) : []);
  const candidateColors = hasMultiGroups ? groupCandidates[0].candidateColors : (pollOptions ? getCandidateColors(pollOptions) : []);
  const [groupedStats, setGroupedStats] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const defaultBtn: React.CSSProperties = {
    padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
    fontFamily: "var(--font-cjk)", border: "1px solid rgba(255,255,255,0.12)",
    background: "transparent", color: "rgba(255,255,255,0.6)", cursor: "pointer",
  };

  const handleLoad = useCallback(async () => {
    if (personas.length === 0) return;
    setStatsLoading(true);
    try {
      const res = await getAllAgentStats();
      const agentStates = res.agents || {};
      const merged = personas.map((p: any) => {
        const state = agentStates[String(p.person_id)] || {};
        const traits = p.traits || [];
        return {
          ...p,
          age: p.age || traits[0] || "Unknown",
          gender: p.gender || traits[1] || "Unknown",
          district: p.district || traits[2] || "Unknown",
          political_leaning: p.political_leaning || traits[5] || "Unknown",
          llm_vendor: state.actual_vendor || p.llm_vendor || "Unknown",
          satisfaction: state.satisfaction ?? 50,
          anxiety: state.anxiety ?? 50,
          days_evolved: state.days_evolved ?? 0,
          leaning_shift_logs: state.leaning_shift_logs || [],
        };
      });
      setGroupedStats(merged);
      setLastUpdated(new Date());
    } catch (e) { console.error(e); }
    setStatsLoading(false);
  }, [personas]);

  useEffect(() => {
    if (autoRefresh && personas.length > 0) {
      handleLoad();
      intervalRef.current = setInterval(handleLoad, refreshInterval);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, handleLoad, refreshInterval, personas.length]);

  const groupAndAvg = (field: string) => {
    const groups: Record<string, { items: any[]; avgSat: number; avgAnx: number }> = {};
    groupedStats.forEach((a: any) => {
      const key = a[field] || "Unknown";
      if (!groups[key]) groups[key] = { items: [], avgSat: 0, avgAnx: 0 };
      groups[key].items.push(a);
    });
    Object.keys(groups).forEach(k => {
      const g = groups[k];
      g.avgSat = g.items.reduce((s: number, a: any) => s + (a.satisfaction || 50), 0) / g.items.length;
      g.avgAnx = g.items.reduce((s: number, a: any) => s + (a.anxiety || 50), 0) / g.items.length;
    });
    return Object.entries(groups).sort((a, b) => b[1].items.length - a[1].items.length);
  };

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <h4 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", margin: 0 }}>
          {isCandidateMode
            ? hasMultiGroups
              ? `🗳️ Estimated support by group — ${groupCandidates.map(g => g.name).join(" / ")}`
              : `🗳️ Estimated support by group — ${candidateNames.join(" vs ")}`
            : "📊 各群組滿意度 / 焦慮度分析"}
        </h4>
        <button
          onClick={handleLoad}
          disabled={statsLoading}
          style={{ ...(btnStyle || defaultBtn) }}
        >
          {statsLoading ? "Loading..." : (groupedStats ? "🔄 Reload" : "📊 Load stats")}
        </button>
        {autoRefresh && (
          <span style={{ fontSize: 10, color: "#4ade80", display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--font-cjk)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: "#4ade80", display: "inline-block", animation: "pulse 1.5s ease-in-out infinite" }} />
            Auto-updating
          </span>
        )}
        {lastUpdated && (
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", fontFamily: "var(--font-mono)" }}>
            {lastUpdated.toLocaleTimeString("zh-TW")}
          </span>
        )}
      </div>
      {isCandidateMode && (
        <div style={{ marginBottom: 10, padding: "6px 12px", borderRadius: 6, background: "rgba(139,92,246,0.06)", border: "1px solid rgba(139,92,246,0.12)", fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)", lineHeight: 1.5 }}>
          Based on each group's voter satisfaction, anxiety, and political leaning, estimates candidate support across demographics. Final voting will be determined by AI agent-by-agent after simulation completes.
        </div>
      )}

      {groupedStats && isCandidateMode && hasMultiGroups && (
        <>
          {groupCandidates.map((gc, gi) => (
            <CollapsibleGroup key={gc.name} title={`🎯 ${gc.name} 預測分析`} defaultOpen={gi === 0}>
              <DemographicPiePanel
                title="🗳️ Voter demographics & candidate support"
                agents={groupedStats}
                colorMap={LEANING_COLORS}
                defaultOpen={true}
                isPrimary={true}
                candidateNames={gc.candidateNames}
                candidateColors={gc.candidateColors}
                overrideOverallShares={jobGroupEstimates?.[gc.name]}
                overrideDistrictShares={jobDistrictEstimates?.[gc.name]}
              />
              <CandidateBarPanel
                title="🏛️ 各政治傾向"
                groups={groupAndAvg("political_leaning")}
                candidateNames={gc.candidateNames}
                candidateColors={gc.candidateColors}
                colorMap={LEANING_COLORS}
                defaultOpen={true}
                overrideShares={jobGroupLeanCand?.[gc.name]}
                filterByOverride={!!(pollGroups?.[gi]?.agentFilter?.leanings?.length)}
              />
              <CandidateBarPanel
                title="📍 各行政區"
                groups={groupAndAvg("district")}
                candidateNames={gc.candidateNames}
                candidateColors={gc.candidateColors}
                defaultOpen={false}
                overrideShares={jobDistrictEstimates?.[gc.name]}
                filterByOverride={!!(pollGroups?.[gi]?.agentFilter?.leanings?.length)}
              />
              <CandidateBarPanel
                title="🚻 性別"
                groups={groupAndAvg("gender")}
                candidateNames={gc.candidateNames}
                candidateColors={gc.candidateColors}
                defaultOpen={false}
                overrideShares={jobGenderEstimates?.[gc.name]}
              />
              <CandidateBarPanel
                title="🤖 各 LLM Vendor"
                groups={groupAndAvg("llm_vendor")}
                candidateNames={gc.candidateNames}
                candidateColors={gc.candidateColors}
                defaultOpen={false}
                overrideShares={jobVendorEstimates?.[gc.name]}
              />
            </CollapsibleGroup>
          ))}
        </>
      )}

      {groupedStats && isCandidateMode && !hasMultiGroups && (
        <>
          <DemographicPiePanel
            title="🗳️ Voter demographics & candidate support"
            agents={groupedStats}
            colorMap={LEANING_COLORS}
            defaultOpen={true}
            isPrimary={true}
            candidateNames={candidateNames}
            candidateColors={candidateColors}
            overrideDistrictShares={jobDistrictEstimates ? Object.values(jobDistrictEstimates)[0] : undefined}
            overrideOverallShares={jobGroupEstimates
              ? Object.values(jobGroupEstimates).length > 0
                ? Object.values(jobGroupEstimates).reduce((acc: Record<string, number>, gEst) => {
                    Object.entries(gEst).forEach(([cn, pct]) => { acc[cn] = (acc[cn] || 0) + (pct as number); });
                    return acc;
                  }, {})
                : undefined
              : undefined}
          />
          <CandidateBarPanel
            title="🏛️ Estimated support by political leaning"
            groups={groupAndAvg("political_leaning")}
            candidateNames={candidateNames}
            candidateColors={candidateColors}
            colorMap={LEANING_COLORS}
            defaultOpen
            overrideShares={jobGroupLeanCand
              ? (() => {
                  const entries = Object.values(jobGroupLeanCand) as Record<string, Record<string, number>>[];
                  return entries.reduce((best, cur) => Object.keys(cur).length > Object.keys(best).length ? cur : best, entries[0]);
                })()
              : undefined}
          />
          <CandidateBarPanel
            title="📍 Estimated support by state/district"
            groups={groupAndAvg("district")}
            candidateNames={candidateNames}
            candidateColors={candidateColors}
            overrideShares={jobDistrictEstimates ? Object.values(jobDistrictEstimates)[0] : undefined}
          />
          <CandidateBarPanel
            title="🚻 Estimated support by gender"
            groups={groupAndAvg("gender")}
            candidateNames={candidateNames}
            candidateColors={candidateColors}
            overrideShares={jobGenderEstimates ? Object.values(jobGenderEstimates)[0] : undefined}
          />
          <CandidateBarPanel
            title="🤖 Estimated support by LLM vendor"
            groups={groupAndAvg("llm_vendor")}
            candidateNames={candidateNames}
            candidateColors={candidateColors}
            overrideShares={jobVendorEstimates ? Object.values(jobVendorEstimates)[0] : undefined}
          />
        </>
      )}

      {groupedStats && !isCandidateMode && (
        <>
          <DemographicPiePanel
            title="🥧 選民結構與政治傾向地圖"
            agents={groupedStats}
            colorMap={LEANING_COLORS}
            defaultOpen={true}
            isPrimary={false}
          />
          <DualBarPanel
            title="🏛️ 各政治傾向 — 滿意度 / 焦慮度"
            groups={groupAndAvg("political_leaning")}
            colorMap={LEANING_COLORS}
            defaultOpen
          />
          <DualBarPanel
            title="🤖 各 LLM Vendor — 滿意度 / 焦慮度"
            groups={groupAndAvg("llm_vendor")}
            colorMap={VENDOR_COLORS}
          />
          <DualBarPanel
            title="📍 各行政區 — 滿意度 / 焦慮度"
            groups={groupAndAvg("district")}
          />
          <DualBarPanel
            title="🚻 性別 — 滿意度 / 焦慮度"
            groups={groupAndAvg("gender")}
          />
        </>
      )}
    </div>
  );
}
