"use client";

import { useMemo } from "react";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
  PieChart, Pie,
} from "recharts";
import { useTr } from "@/lib/i18n";

const TT: React.CSSProperties = { background: "#1e1e2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11, fontFamily: "var(--font-cjk)" };
const LEAN_COLORS: Record<string, string> = { "偏左派": "#22c55e", "中立": "#94a3b8", "偏右派": "#3b82f6" };
const CAND_COLORS = ["#8b5cf6", "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#ec4899", "#14b8a6"];
const M = { local: "#3b82f6", national: "#f97316", anxiety: "#ef4444" };

/* ═══════════════════════════════════════════════════════════════════ */
/*  Evolution Dashboard                                               */
/* ═══════════════════════════════════════════════════════════════════ */
export function EvolutionDashboard({ steps, currentStep }: { steps: any[]; currentStep: number }) {
  const visible = steps.slice(0, currentStep + 1);
  const step = visible[visible.length - 1] || {};
  const agg = step.aggregate || {};

  const trend = useMemo(() => visible.map((s, i) => ({
    day: s.day || i + 1,
    local: s.aggregate?.avg_local_satisfaction ?? 50,
    national: s.aggregate?.avg_national_satisfaction ?? 50,
    anxiety: s.aggregate?.avg_anxiety ?? 50,
  })), [visible]);

  // Leaning population trend
  const leanPop = useMemo(() => visible.map((s) => {
    const row: any = { day: s.day };
    const total = Object.values(s.leanings || {}).reduce((sum: number, v: any) => sum + (v.count || 0), 0) || 1;
    for (const [k, v] of Object.entries(s.leanings || {}) as any) row[k] = Math.round((v.count / total) * 100);
    return row;
  }), [visible]);

  // District ranking by local sat change
  const distRank = useMemo(() => {
    if (visible.length < 2) return [];
    const first = visible[0]?.districts || {};
    const last = step.districts || {};
    return Object.keys(last).map((name) => ({
      name,
      current: Math.round(last[name]?.avg_local_satisfaction || 50),
      delta: Math.round((last[name]?.avg_local_satisfaction || 50) - (first[name]?.avg_local_satisfaction || 50)),
      count: last[name]?.count || 0,
    })).sort((a, b) => a.current - b.current).slice(0, 10);
  }, [visible, step]);

  // Leaning satisfaction comparison
  const leanBars = useMemo(() => {
    const l = step.leanings || {};
    return Object.entries(l).map(([name, d]: any) => ({
      name, local: d.avg_local_satisfaction, national: d.avg_national_satisfaction, anxiety: d.avg_anxiety, count: d.count,
    }));
  }, [step]);

  // Agent relevance distribution
  const relDist = useMemo(() => {
    const agents = step.agents || [];
    const map: Record<string, number> = { high: 0, medium: 0, low: 0, none: 0 };
    for (const a of agents) map[a.news_relevance || "none"] = (map[a.news_relevance || "none"] || 0) + 1;
    return Object.entries(map).filter(([, v]) => v > 0).map(([name, value]) => ({ name: { high: "高影響", medium: "中影響", low: "低影響", none: "無影響" }[name] || name, value }));
  }, [step]);

  const first = steps[0]?.aggregate || {};
  const dLocal = Math.round((agg.avg_local_satisfaction || 50) - (first.avg_local_satisfaction || 50));
  const dNat = Math.round((agg.avg_national_satisfaction || 50) - (first.avg_national_satisfaction || 50));
  const dAnx = Math.round((agg.avg_anxiety || 50) - (first.avg_anxiety || 50));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 800, color: "#fff", margin: 0 }}>演化分析儀表板</h2>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Day {step.day || 0} / {steps.length}</span>
      </div>

      {/* KPI row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <Kpi label="地方滿意度" value={agg.avg_local_satisfaction} delta={dLocal} color={M.local} />
        <Kpi label="中央滿意度" value={agg.avg_national_satisfaction} delta={dNat} color={M.national} />
        <Kpi label="焦慮度" value={agg.avg_anxiety} delta={dAnx} color={M.anxiety} invertDelta />
        <Kpi label="Agent 數" value={agg.entries_count} color="#a78bfa" isCount />
      </div>

      {/* Main trend */}
      {trend.length >= 2 && (
        <Card title="滿意度與焦慮度趨勢">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trend} margin={{ top: 5, right: 15, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#6b7280" }} />
              <Tooltip contentStyle={TT} />
              <Legend wrapperStyle={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }} />
              <Line type="monotone" dataKey="local" name="地方滿意" stroke={M.local} strokeWidth={2} dot={trend.length <= 15} />
              <Line type="monotone" dataKey="national" name="中央滿意" stroke={M.national} strokeWidth={2} dot={trend.length <= 15} />
              <Line type="monotone" dataKey="anxiety" name="焦慮度" stroke={M.anxiety} strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Row: Leaning bars + leaning population */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {leanBars.length > 0 && (
          <Card title="各傾向心理狀態" style={{ flex: "1 1 380px" }}>
            <ResponsiveContainer width="100%" height={Math.max(100, leanBars.length * 36 + 30)}>
              <BarChart data={leanBars} layout="vertical" margin={{ left: 45, right: 15 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 9, fill: "#6b7280" }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#d1d5db" }} width={40} />
                <Tooltip contentStyle={TT} />
                <Bar dataKey="local" name="地方" fill={M.local} barSize={8} radius={[0, 3, 3, 0]} />
                <Bar dataKey="national" name="中央" fill={M.national} barSize={8} radius={[0, 3, 3, 0]} />
                <Bar dataKey="anxiety" name="焦慮" fill={M.anxiety} barSize={6} radius={[0, 3, 3, 0]} opacity={0.5} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}
        {leanPop.length >= 2 && (
          <Card title="傾向人口比例變化" style={{ flex: "1 1 350px" }}>
            <ResponsiveContainer width="100%" height={150}>
              <AreaChart data={leanPop} margin={{ top: 5, right: 15, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} />
                <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} unit="%" />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }} />
                {Object.keys(step.leanings || {}).map((k) => (
                  <Area key={k} type="monotone" dataKey={k} stackId="1" stroke={LEAN_COLORS[k] || "#94a3b8"} fill={LEAN_COLORS[k] || "#94a3b8"} fillOpacity={0.5} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        )}
      </div>

      {/* Row: District ranking + News relevance */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {(distRank.length > 0 || visible.length < 2) && (
          <Card title="行政區滿意度排名（低→高）" style={{ flex: "1 1 400px" }}>
            {distRank.length === 0 ? (
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", textAlign: "center", padding: 16 }}>需要至少 2 日資料以比較變化</div>
            ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {distRank.map((d) => (
                <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 50, fontSize: 10, color: "#d1d5db", fontWeight: 600, textAlign: "right" }}>{d.name}</span>
                  <div style={{ flex: 1, height: 14, borderRadius: 4, background: "rgba(255,255,255,0.04)", overflow: "hidden", position: "relative" }}>
                    <div style={{ height: "100%", borderRadius: 4, background: d.current >= 50 ? M.local : M.anxiety, opacity: 0.7, width: `${d.current}%`, transition: "width 0.5s" }} />
                    <span style={{ position: "absolute", right: 6, top: 0, fontSize: 9, lineHeight: "14px", color: "#fff" }}>{d.current}</span>
                  </div>
                  <span style={{ width: 40, fontSize: 9, color: d.delta >= 0 ? "#4ade80" : "#f87171", textAlign: "right" }}>
                    {d.delta > 0 ? "+" : ""}{d.delta}
                  </span>
                </div>
              ))}
            </div>
            )}
          </Card>
        )}
        {relDist.length > 0 && (
          <Card title="今日新聞影響分佈" style={{ flex: "1 1 250px" }}>
            <ResponsiveContainer width="100%" height={140}>
              <PieChart>
                <Pie data={relDist} cx="50%" cy="50%" outerRadius={55} dataKey="value"
                  label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} style={{ fontSize: 10 }}>
                  {relDist.map((_, i) => <Cell key={i} fill={["#ef4444", "#f59e0b", "#6b7280", "#374151"][i]} />)}
                </Pie>
                <Tooltip contentStyle={TT} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        )}
      </div>

      {/* ═════ NEW: Candidate awareness/sentiment + 即時新聞 + 訊息流 ═════ */}
      <CandidateAwarenessGrid candAwarenessSummary={(step as any).candidate_awareness_summary || {}} />
      <CycleContextBanner cycleInfo={(step as any).cycle_info || {}}
        compressionInfo={(step as any).compression_info || {}}
        keywordLayers={(step as any).keyword_layers || {}}
        newsPoolSize={(step as any).news_pool_size}
      />
      <NewsHeadlinesFeed news={(step as any).news || []} />
      <LiveMessagesStream liveMessages={(step as any).live_messages || []} />
      <AgentDiarySpotlight agents={(step as any).agents || []} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Prediction Dashboard                                              */
/* ═══════════════════════════════════════════════════════════════════ */
export function PredictionDashboard({ steps, currentStep }: { steps: any[]; currentStep: number }) {
  const visible = steps.slice(0, currentStep + 1);
  const step = visible[visible.length - 1] || {};
  const dr = step.day_record || {};
  const agg = step.aggregate || {};

  // Candidate trend over days
  const candTrend = useMemo(() => {
    return visible.map((s) => {
      const ce = s.day_record?.candidate_estimate || {};
      return { day: s.day, ...ce };
    });
  }, [visible]);

  const candidates = useMemo(() => {
    const names = new Set<string>();
    for (const s of steps) {
      for (const k of Object.keys(s.day_record?.candidate_estimate || {})) {
        if (k !== "不表態") names.add(k);
      }
    }
    return Array.from(names);
  }, [steps]);

  // Group estimates (latest)
  const groupEst = dr.group_estimates || {};
  const groupNames = Object.keys(groupEst);

  // By-leaning breakdown
  const byLeaning = dr.by_leaning || {};
  const leanBars = Object.entries(byLeaning).map(([name, d]: any) => ({
    name, avg_sat: d.avg_sat, avg_anx: d.avg_anx, count: d.count,
  }));

  // Satisfaction trend
  const satTrend = useMemo(() => visible.map((s, i) => ({
    day: s.day || i + 1,
    local: s.aggregate?.avg_local_satisfaction ?? 50,
    national: s.aggregate?.avg_national_satisfaction ?? 50,
    anxiety: s.aggregate?.avg_anxiety ?? 50,
  })), [visible]);

  // Sat distribution
  const satDist = dr.sat_distribution || {};
  const satDistData = Object.entries(satDist).map(([name, count]) => ({ name, count }));

  // Current estimate
  const currentEst = dr.candidate_estimate || {};
  const sortedCands = Object.entries(currentEst)
    .filter(([k]) => k !== "不表態")
    .sort(([, a]: any, [, b]: any) => b - a);
  const undecided = currentEst["不表態"] || 0;

  const first = steps[0]?.day_record?.candidate_estimate || {};

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 800, color: "#fff", margin: 0 }}>選情分析儀表板</h2>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Day {step.day || 0} / {steps.length}</span>
      </div>

      {/* Candidate KPIs */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {sortedCands.map(([name, pct]: any, i) => {
          const firstPct = first[name] || pct;
          const delta = Math.round((pct - firstPct) * 10) / 10;
          return <Kpi key={name} label={name} value={pct} delta={delta} color={CAND_COLORS[i % CAND_COLORS.length]} suffix="%" />;
        })}
        <Kpi label="不表態" value={undecided} color="#6b7280" suffix="%" />
      </div>

      {/* Main: candidate trend */}
      {candTrend.length >= 2 && (
        <Card title="候選人支持率趨勢">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={candTrend} margin={{ top: 5, right: 15, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} />
              <YAxis domain={[0, 60]} tick={{ fontSize: 10, fill: "#6b7280" }} unit="%" />
              <Tooltip contentStyle={TT} formatter={(v: any) => `${v}%`} />
              <Legend wrapperStyle={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }} />
              {candidates.map((name, i) => (
                <Line key={name} type="monotone" dataKey={name} stroke={CAND_COLORS[i % CAND_COLORS.length]} strokeWidth={2.5} dot={candTrend.length <= 15} />
              ))}
              <Line type="monotone" dataKey="不表態" stroke="#6b7280" strokeWidth={1} strokeDasharray="4 4" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Row: Group estimates + satisfaction trend */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {/* Group breakdowns */}
        {groupNames.length > 0 && (
          <Card title="各組別得票率" style={{ flex: "1 1 420px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {groupNames.map((gn) => {
                const est = groupEst[gn] || {};
                const entries = Object.entries(est).filter(([k]) => k !== "不表態").sort(([, a]: any, [, b]: any) => b - a);
                const gUndecided = est["不表態"] || 0;
                return (
                  <div key={gn}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.6)", marginBottom: 6 }}>{gn}</div>
                    {entries.map(([name, pct]: any, i) => (
                      <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                        <span style={{ width: 55, fontSize: 10, color: "#d1d5db", textAlign: "right" }}>{name}</span>
                        <div style={{ flex: 1, height: 16, borderRadius: 4, background: "rgba(255,255,255,0.04)", overflow: "hidden", position: "relative" }}>
                          <div style={{ height: "100%", borderRadius: 4, background: CAND_COLORS[i % CAND_COLORS.length], width: `${Math.min(100, pct * 1.5)}%`, transition: "width 0.5s", opacity: 0.8 }} />
                          <span style={{ position: "absolute", left: 8, top: 0, fontSize: 10, lineHeight: "16px", color: "#fff", fontWeight: 700 }}>{pct}%</span>
                        </div>
                      </div>
                    ))}
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>不表態 {gUndecided}%</div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Satisfaction trend */}
        {satTrend.length >= 2 && (
          <Card title="滿意度與焦慮度趨勢" style={{ flex: "1 1 380px" }}>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={satTrend} margin={{ top: 5, right: 15, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#6b7280" }} />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }} />
                <Line type="monotone" dataKey="local" name="地方滿意" stroke={M.local} strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="national" name="中央滿意" stroke={M.national} strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="anxiety" name="焦慮度" stroke={M.anxiety} strokeWidth={1} strokeDasharray="4 4" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        )}
      </div>

      {/* Row: By-leaning + Sat distribution */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {leanBars.length > 0 && (
          <Card title="各傾向選民狀態" style={{ flex: "1 1 350px" }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {leanBars.map((lb) => (
                <div key={lb.name} style={{ flex: "1 1 100px", background: "rgba(255,255,255,0.02)", borderRadius: 8, padding: 10, textAlign: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: LEAN_COLORS[lb.name] || "#94a3b8" }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#e5e7eb" }}>{lb.name}</span>
                    <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>{lb.count}人</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
                    <div><div style={{ fontSize: 14, fontWeight: 700, color: M.local }}>{Math.round(lb.avg_sat)}</div><div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)" }}>滿意</div></div>
                    <div><div style={{ fontSize: 14, fontWeight: 700, color: M.anxiety }}>{Math.round(lb.avg_anx)}</div><div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)" }}>焦慮</div></div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
        {satDistData.length > 0 && (
          <Card title="滿意度分佈" style={{ flex: "1 1 250px" }}>
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={satDistData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#6b7280" }} />
                <YAxis tick={{ fontSize: 9, fill: "#6b7280" }} />
                <Tooltip contentStyle={TT} />
                <Bar dataKey="count" name="人數" barSize={20} radius={[4, 4, 0, 0]}>
                  {satDistData.map((_, i) => <Cell key={i} fill={["#ef4444", "#f59e0b", "#94a3b8", "#3b82f6", "#22c55e"][i]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}
      </div>

      {/* ═════ NEW: 候選人詳細資訊區（候選人卡片 + 各傾向偏好 + 各區偏好 + 新聞影響）═════ */}
      <CandidateCardsRow
        sortedCands={sortedCands as [string, number][]}
        first={first}
        candAwarenessSummary={(step as any).candidate_awareness_summary || {}}
      />
      <GroupLeaningBreakdown groupLeaningCandidate={dr.group_leaning_candidate || {}} />
      <GroupDistrictBreakdown groupDistrictCandidate={dr.group_district_candidate || {}} />
      <CandidateNewsImpact candidateNewsImpact={dr.candidate_news_impact || {}} />

      {/* ═════ NEW: 即時新聞與訊息流（增加臨場感）═════ */}
      <NewsHeadlinesFeed news={(step as any).news || []} />
      <LiveMessagesStream liveMessages={(step as any).live_messages || []} />
      <AgentDiarySpotlight agents={(step as any).agents || []} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Shared                                                            */
/* ═══════════════════════════════════════════════════════════════════ */
function Card({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 14, ...style }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Kpi({ label, value, delta, color, isCount, invertDelta, suffix }: {
  label: string; value: number; color: string; delta?: number; isCount?: boolean; invertDelta?: boolean; suffix?: string;
}) {
  const d = delta ?? 0;
  const dColor = invertDelta ? (d > 0 ? "#ef4444" : "#22c55e") : (d > 0 ? "#22c55e" : d < 0 ? "#ef4444" : "rgba(255,255,255,0.3)");
  return (
    <div style={{ flex: "1 1 130px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: "10px 14px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{typeof value === "number" ? (suffix ? value.toFixed(1) : Math.round(value)) : value}</span>
        {suffix && <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>{suffix}</span>}
        {d !== 0 && <span style={{ fontSize: 11, fontWeight: 600, color: dColor, marginLeft: 4 }}>{d > 0 ? "↑" : "↓"}{Math.abs(d)}</span>}
      </div>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginTop: 2 }}>{label}</div>
      {!isCount && !suffix && <div style={{ width: "100%", height: 3, borderRadius: 2, background: "rgba(255,255,255,0.05)", marginTop: 5 }}><div style={{ height: "100%", borderRadius: 2, background: color, width: `${Math.min(100, value || 0)}%`, transition: "width 0.5s" }} /></div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Helper labels for awareness / sentiment                           */
/* ═══════════════════════════════════════════════════════════════════ */
function awLabel(v: number): { label: string; color: string } {
  if (v >= 0.85) return { label: "非常熟悉", color: "#22c55e" };
  if (v >= 0.70) return { label: "相當熟悉", color: "#4ade80" };
  if (v >= 0.50) return { label: "有一定認識", color: "#a78bfa" };
  if (v >= 0.30) return { label: "略有印象", color: "#94a3b8" };
  if (v >= 0.15) return { label: "只聽過名字", color: "#6b7280" };
  return { label: "完全沒聽過", color: "#4b5563" };
}
function senLabel(s: number): { label: string; color: string; emoji: string } {
  if (s >= 0.5) return { label: "非常正面", color: "#22c55e", emoji: "😍" };
  if (s >= 0.2) return { label: "略偏正面", color: "#4ade80", emoji: "🙂" };
  if (s >= 0.05) return { label: "微正面", color: "#86efac", emoji: "🙂" };
  if (s > -0.05) return { label: "中性", color: "#94a3b8", emoji: "😐" };
  if (s > -0.2) return { label: "微負面", color: "#fca5a5", emoji: "🙁" };
  if (s > -0.5) return { label: "略偏負面", color: "#f87171", emoji: "😟" };
  return { label: "非常負面", color: "#ef4444", emoji: "😡" };
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Candidate Cards Row — for prediction playback                     */
/* ═══════════════════════════════════════════════════════════════════ */
function CandidateCardsRow({ sortedCands, first, candAwarenessSummary }: {
  sortedCands: [string, number][];
  first: any;
  candAwarenessSummary: Record<string, any>;
}) {
  if (sortedCands.length === 0) return null;
  return (
    <Card title="🎯 候選人即時看板">
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {sortedCands.map(([name, pct]: [string, number], i) => {
          const color = CAND_COLORS[i % CAND_COLORS.length];
          const firstPct = first[name] || pct;
          const delta = Math.round((pct - firstPct) * 10) / 10;
          // Match short name to awareness summary (handle "民眾黨-張啓楷" → "張啓楷")
          const cleanName = name.replace(/^.+?-/, "").trim();
          const aware = candAwarenessSummary[cleanName] || candAwarenessSummary[name] || {};
          const overall = aware["__all__"] || {};
          return (
            <div key={name} style={{
              flex: "1 1 240px",
              padding: 14, borderRadius: 12,
              background: `linear-gradient(135deg, ${color}10, transparent)`,
              border: `1px solid ${color}30`,
            }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ color, fontSize: 14, fontWeight: 800 }}>{i === 0 && "👑 "}{name}</span>
                <span style={{ color, fontSize: 24, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>{typeof pct === "number" ? pct.toFixed(1) : pct}<span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>%</span></span>
              </div>
              {delta !== 0 && (
                <div style={{ fontSize: 10, color: delta > 0 ? "#22c55e" : "#ef4444", marginBottom: 6 }}>
                  vs Day 1: {delta > 0 ? "▲ +" : "▼ "}{Math.abs(delta).toFixed(1)}%
                </div>
              )}
              {overall.avg_awareness !== undefined && (
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>📚 認識度</span>
                    <span style={{ color: awLabel(overall.avg_awareness).color, fontWeight: 700 }}>
                      {awLabel(overall.avg_awareness).label} ({(overall.avg_awareness * 100).toFixed(0)}%)
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{senLabel(overall.avg_sentiment).emoji} 印象</span>
                    <span style={{ color: senLabel(overall.avg_sentiment).color, fontWeight: 700 }}>
                      {senLabel(overall.avg_sentiment).label} ({overall.avg_sentiment >= 0 ? "+" : ""}{overall.avg_sentiment.toFixed(2)})
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Group × Leaning candidate breakdown                               */
/* ═══════════════════════════════════════════════════════════════════ */
function GroupLeaningBreakdown({ groupLeaningCandidate }: {
  groupLeaningCandidate: Record<string, Record<string, Record<string, number>>>;
}) {
  const groups = Object.keys(groupLeaningCandidate || {});
  if (groups.length === 0) return null;
  return (
    <Card title="🏛️ 各組別 × 政治傾向 候選人偏好">
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 10 }}>
        每位選民依政治傾向分組，看每位候選人在各群中的支持率。可揭露「KMT 基本盤是否真的投 KMT 候選人」「綠營策略投票」等動態。
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {groups.map((gn) => {
          const leaningData = groupLeaningCandidate[gn] || {};
          const leanings = Object.keys(leaningData);
          if (leanings.length === 0) return null;
          // Get all candidates in this group
          const candSet = new Set<string>();
          leanings.forEach(l => Object.keys(leaningData[l] || {}).forEach(c => candSet.add(c)));
          const cands = Array.from(candSet);
          return (
            <div key={gn}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.7)", marginBottom: 6 }}>{gn}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {leanings.map((lean) => {
                  const cd = leaningData[lean] || {};
                  return (
                    <div key={lean} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 60, fontSize: 10, color: LEAN_COLORS[lean] || "#94a3b8", fontWeight: 700, textAlign: "right" }}>{lean}</span>
                      <div style={{ flex: 1, display: "flex", height: 18, borderRadius: 4, overflow: "hidden", background: "rgba(255,255,255,0.04)" }}>
                        {cands.map((cn, ci) => {
                          const v = cd[cn] || 0;
                          if (v === 0) return null;
                          return (
                            <div key={cn} style={{
                              width: `${v}%`,
                              background: CAND_COLORS[ci % CAND_COLORS.length],
                              opacity: 0.85,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 9, color: "#fff", fontWeight: 700,
                              transition: "width 0.5s",
                            }}>{v >= 12 ? `${v.toFixed(0)}%` : ""}</div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Legend */}
              <div style={{ display: "flex", gap: 8, marginTop: 4, fontSize: 9, color: "rgba(255,255,255,0.4)" }}>
                {cands.map((cn, ci) => (
                  <div key={cn} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: CAND_COLORS[ci % CAND_COLORS.length] }} />
                    {cn}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Group × District candidate breakdown                              */
/* ═══════════════════════════════════════════════════════════════════ */
function GroupDistrictBreakdown({ groupDistrictCandidate }: {
  groupDistrictCandidate: Record<string, Record<string, Record<string, number>>>;
}) {
  const groups = Object.keys(groupDistrictCandidate || {});
  if (groups.length === 0) return null;
  return (
    <Card title="🏘️ 各組別 × 行政區 候選人偏好">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {groups.map((gn) => {
          const districtData = groupDistrictCandidate[gn] || {};
          const districts = Object.keys(districtData);
          if (districts.length === 0) return null;
          const candSet = new Set<string>();
          districts.forEach(d => Object.keys(districtData[d] || {}).forEach(c => candSet.add(c)));
          const cands = Array.from(candSet);
          return (
            <div key={gn}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.7)", marginBottom: 6 }}>{gn}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {districts.map((dist) => {
                  const cd = districtData[dist] || {};
                  return (
                    <div key={dist} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 50, fontSize: 10, color: "#d1d5db", fontWeight: 600, textAlign: "right" }}>{dist}</span>
                      <div style={{ flex: 1, display: "flex", height: 16, borderRadius: 4, overflow: "hidden", background: "rgba(255,255,255,0.04)" }}>
                        {cands.map((cn, ci) => {
                          const v = cd[cn] || 0;
                          if (v === 0) return null;
                          return (
                            <div key={cn} style={{
                              width: `${v}%`,
                              background: CAND_COLORS[ci % CAND_COLORS.length],
                              opacity: 0.8,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 9, color: "#fff", fontWeight: 700,
                              transition: "width 0.5s",
                            }}>{v >= 12 ? `${v.toFixed(0)}%` : ""}</div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Per-candidate news impact                                         */
/* ═══════════════════════════════════════════════════════════════════ */
function CandidateNewsImpact({ candidateNewsImpact }: {
  candidateNewsImpact: Record<string, { title: string; sentiment: number; agents_exposed: number }[]>;
}) {
  const cands = Object.keys(candidateNewsImpact || {});
  if (cands.length === 0) return null;
  return (
    <Card title="📰 候選人新聞影響力（哪些新聞影響了哪些 agent）">
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {cands.map((cn) => {
          const articles = (candidateNewsImpact[cn] || []).slice(0, 6);
          if (articles.length === 0) return null;
          return (
            <div key={cn} style={{ flex: "1 1 280px", padding: 10, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa", marginBottom: 6 }}>👤 {cn}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {articles.map((art, i) => {
                  const sl = senLabel(art.sentiment);
                  return (
                    <div key={i} style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", lineHeight: 1.4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 1 }}>
                        <span style={{ color: sl.color, fontSize: 11, fontWeight: 700, width: 38, textAlign: "center", padding: "1px 4px", borderRadius: 3, background: `${sl.color}15` }}>
                          {art.sentiment >= 0 ? "+" : ""}{art.sentiment.toFixed(1)}
                        </span>
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)" }}>{art.agents_exposed} 人讀</span>
                      </div>
                      <div style={{ paddingLeft: 44, color: "rgba(255,255,255,0.7)" }}>{art.title}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Candidate awareness/sentiment grid (evolution)                    */
/* ═══════════════════════════════════════════════════════════════════ */
function CandidateAwarenessGrid({ candAwarenessSummary }: { candAwarenessSummary: Record<string, any> }) {
  const cands = Object.keys(candAwarenessSummary || {});
  if (cands.length === 0) return null;
  return (
    <Card title="🎯 候選人認知與好感度（按政治傾向）">
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 10 }}>
        ⚠️ <strong>「認識度」≠「好感度」</strong>：認識度高不代表受喜愛。觀察兩個訊號的組合可揭露真實競爭力。
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {cands.map((cn) => {
          const overall = candAwarenessSummary[cn]?.["__all__"] || {};
          const leanings = Object.keys(candAwarenessSummary[cn] || {}).filter(l => l !== "__all__");
          const aw = overall.avg_awareness ?? 0;
          const se = overall.avg_sentiment ?? 0;
          return (
            <div key={cn} style={{ padding: 10, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#fff" }}>{cn}</span>
                <span style={{ fontSize: 10, color: awLabel(aw).color, fontWeight: 700 }}>📚 {awLabel(aw).label} ({(aw * 100).toFixed(0)}%)</span>
                <span style={{ fontSize: 10, color: senLabel(se).color, fontWeight: 700 }}>{senLabel(se).emoji} {senLabel(se).label} ({se >= 0 ? "+" : ""}{se.toFixed(2)})</span>
              </div>
              {leanings.length > 0 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {leanings.map((lean) => {
                    const d = candAwarenessSummary[cn][lean] || {};
                    return (
                      <div key={lean} style={{
                        flex: "1 1 130px",
                        padding: "6px 10px", borderRadius: 6,
                        background: `${LEAN_COLORS[lean] || "#94a3b8"}10`,
                        border: `1px solid ${LEAN_COLORS[lean] || "#94a3b8"}30`,
                      }}>
                        <div style={{ fontSize: 9, color: LEAN_COLORS[lean] || "#94a3b8", fontWeight: 700, marginBottom: 3 }}>{lean} ({d.count}人)</div>
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", display: "flex", justifyContent: "space-between" }}>
                          <span>認 {(d.avg_awareness * 100).toFixed(0)}%</span>
                          <span>印 {d.avg_sentiment >= 0 ? "+" : ""}{d.avg_sentiment.toFixed(2)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Cycle context banner                                              */
/* ═══════════════════════════════════════════════════════════════════ */
function CycleContextBanner({ cycleInfo, compressionInfo, keywordLayers, newsPoolSize }: {
  cycleInfo: any; compressionInfo: any; keywordLayers: any; newsPoolSize?: number;
}) {
  const hasInfo = Object.keys(cycleInfo || {}).length > 0 || Object.keys(compressionInfo || {}).length > 0 || newsPoolSize !== undefined;
  if (!hasInfo) return null;
  const ratio = compressionInfo.compression_ratio;
  return (
    <Card title="⏱️ 演化背景">
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
        {ratio !== undefined && (
          <div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)" }}>時間壓縮</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: ratio > 15 ? "#f59e0b" : ratio > 1.05 ? "#22c55e" : "rgba(255,255,255,0.4)" }}>{ratio.toFixed(1)}×</div>
          </div>
        )}
        {compressionInfo.news_range_start && (
          <div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)" }}>真實新聞範圍</div>
            <div style={{ fontSize: 11, color: "#fff" }}>{compressionInfo.news_range_start} ~ {compressionInfo.news_range_end}</div>
          </div>
        )}
        {newsPoolSize !== undefined && newsPoolSize > 0 && (
          <div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)" }}>新聞池</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#a78bfa" }}>{newsPoolSize} 篇</div>
          </div>
        )}
        {Object.keys(keywordLayers || {}).length > 0 && (
          <div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)" }}>關鍵字層</div>
            <div style={{ fontSize: 10, color: "#fff" }}>
              L1:{(keywordLayers.L1_local || 0) + (keywordLayers.L1_national || 0)} +
              L2:{(keywordLayers.L2_local || 0) + (keywordLayers.L2_national || 0)} +
              L3:{(keywordLayers.L3_local || 0) + (keywordLayers.L3_national || 0)} +
              LLM:{(keywordLayers.LLM_local || 0) + (keywordLayers.LLM_national || 0)}
            </div>
          </div>
        )}
        {cycleInfo.county && (
          <div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)" }}>縣市</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{cycleInfo.county}</div>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  News headlines feed                                               */
/* ═══════════════════════════════════════════════════════════════════ */
function NewsHeadlinesFeed({ news }: { news: any[] }) {
  if (!news || news.length === 0) return null;
  const channelColor: Record<string, string> = { "地方": "#3b82f6", "國內": "#f97316", "社群": "#22c55e" };
  const leaningColor: Record<string, string> = { "偏左派": "#22c55e", "偏右派": "#3b82f6", "中立": "#94a3b8", "center": "#94a3b8" };
  return (
    <Card title={`📰 今日新聞頭條（${news.length} 則）`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflow: "auto" }}>
        {news.slice(0, 30).map((art, i) => {
          const impact = art.impact_score || 0;
          const impactColor = impact >= 7 ? "#ef4444" : impact >= 4 ? "#f59e0b" : "#6b7280";
          return (
            <div key={i} style={{
              padding: "6px 10px", borderRadius: 6,
              background: "rgba(255,255,255,0.02)",
              borderLeft: `3px solid ${leaningColor[art.leaning] || "#94a3b8"}`,
              fontSize: 11, color: "rgba(255,255,255,0.75)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }}>
                {impact > 0 && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: impactColor, padding: "1px 5px", borderRadius: 3, background: `${impactColor}15`, fontFamily: "var(--font-mono)" }}>{impact}</span>
                )}
                {art.channel && (
                  <span style={{ fontSize: 9, color: channelColor[art.channel] || "#94a3b8", padding: "1px 5px", borderRadius: 3, background: `${channelColor[art.channel] || "#94a3b8"}15` }}>{art.channel}</span>
                )}
                {art.date && (
                  <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", fontFamily: "var(--font-mono)" }}>{(art.date || "").slice(5, 10)}</span>
                )}
                {art.source_tag && (
                  <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)" }}>{art.source_tag}</span>
                )}
              </div>
              <div style={{ lineHeight: 1.4 }}>{art.title}</div>
              {art.candidate_sentiment && Object.keys(art.candidate_sentiment).length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
                  {Object.entries(art.candidate_sentiment as Record<string, number>).map(([cn, s]) => {
                    if (s === 0) return null;
                    const sl = senLabel(s);
                    return (
                      <span key={cn} style={{ fontSize: 9, color: sl.color, padding: "1px 4px", borderRadius: 3, background: `${sl.color}10`, fontFamily: "var(--font-mono)" }}>
                        {cn}{s >= 0 ? "+" : ""}{s.toFixed(1)}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Live messages stream                                              */
/* ═══════════════════════════════════════════════════════════════════ */
function LiveMessagesStream({ liveMessages }: { liveMessages: any[] }) {
  const t = useTr();
  if (!liveMessages || liveMessages.length === 0) return null;
  // Filter agent-level messages, keep system events.
  // Match both Chinese (legacy backend) and English (US backend) markers.
  const filtered = liveMessages.filter((m) => {
    const text = typeof m === "string" ? m : (m?.text || "");
    return !["正在閱讀", "寫下日記", "進度：", "Reading", "wrote diary", "Progress:"].some(k => text.includes(k));
  });
  if (filtered.length === 0) return null;
  return (
    <Card title={t("live.system_messages")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflow: "auto" }}>
        {filtered.map((m, i) => {
          const text = typeof m === "string" ? m : (m?.text || "");
          const ts = typeof m === "object" && m?.ts ? new Date(m.ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
          // Color by emoji prefix
          let color = "rgba(255,255,255,0.6)";
          if (text.includes("⚠")) color = "#fcd34d";
          else if (text.includes("⏱") || text.includes("🔄")) color = "#a78bfa";
          else if (text.includes("📌") || text.includes("📊")) color = "#3b82f6";
          else if (text.includes("✅")) color = "#22c55e";
          else if (text.includes("📅") || text.includes("📖")) color = "#06b6d4";
          else if (text.includes("🔍")) color = "#a78bfa";
          return (
            <div key={i} style={{ fontSize: 10, color, lineHeight: 1.5, fontFamily: "var(--font-cjk)" }}>
              {ts && <span style={{ color: "rgba(255,255,255,0.3)", marginRight: 6, fontFamily: "var(--font-mono)" }}>[{ts}]</span>}
              {text}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  Agent diary spotlight — show 3 random agents' diaries today       */
/* ═══════════════════════════════════════════════════════════════════ */
function AgentDiarySpotlight({ agents }: { agents: any[] }) {
  if (!agents || agents.length === 0) return null;
  // Pick 3 high-relevance + diverse-leaning agents
  const high = agents.filter((a) => a.news_relevance === "high").slice(0, 5);
  const sample = high.length >= 3 ? high.slice(0, 3) : agents.slice(0, 3);
  if (sample.length === 0) return null;
  return (
    <Card title="📝 今日 Agent 日記精選">
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {sample.map((a, i) => {
          const lean = a.political_leaning || "中立";
          const leanColor = LEAN_COLORS[lean] || "#94a3b8";
          return (
            <div key={i} style={{
              flex: "1 1 280px",
              padding: 12, borderRadius: 10,
              background: "rgba(255,255,255,0.02)",
              border: `1px solid ${leanColor}30`,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, fontSize: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: leanColor, fontWeight: 700 }}>👤 #{a.agent_id}</span>
                  <span style={{ color: "rgba(255,255,255,0.5)" }}>{a.age}歲 {a.gender}</span>
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>{a.district}</span>
                </div>
                <div style={{ display: "flex", gap: 4, fontSize: 9 }}>
                  <span style={{ color: M.local }}>地{a.local_satisfaction}</span>
                  <span style={{ color: M.national }}>中{a.national_satisfaction}</span>
                  <span style={{ color: M.anxiety }}>焦{a.anxiety}</span>
                </div>
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", lineHeight: 1.5, maxHeight: 110, overflow: "hidden", position: "relative" }}>
                {(a.diary_text || "").slice(0, 220) || "（沒有日記）"}
                {(a.diary_text || "").length > 220 && "..."}
              </div>
              {a.fed_titles && a.fed_titles.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 9, color: "rgba(255,255,255,0.35)" }}>
                  📰 看到的新聞：{a.fed_titles.slice(0, 2).map((t: string) => t.slice(0, 22)).join("、")}
                </div>
              )}
              {a.life_event && (
                <div style={{ marginTop: 4, fontSize: 9, color: "#fbbf24" }}>
                  ⚡ 人生事件：{typeof a.life_event === "string" ? a.life_event : a.life_event?.name || ""}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
