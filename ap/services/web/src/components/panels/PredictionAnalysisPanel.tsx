"use client";

import { useState, useEffect } from "react";
import { listPredictions, getPrediction, analyzePrediction, listSnapshots, getUiSettings, saveUiSettings } from "@/lib/api";
import { useTr } from "@/lib/i18n";
import { useLocaleStore } from "@/store/locale-store";
import { StepGate } from "@/components/shared/StepGate";
import { useWorkflowStatus } from "@/hooks/use-workflow-status";
import { useShellStore } from "@/store/shell-store";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Legend, Cell, PieChart, Pie,
} from "recharts";

const tooltipStyle = { background: "#1e1e2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11 };

/** Simple Markdown → HTML renderer (no external deps) */
function renderMarkdown(text: string): string {
  return text
    .replace(/^### (.+)$/gm, '<h4 style="color:#c4b5fd;font-size:14px;font-weight:700;margin:16px 0 6px">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 style="color:#a78bfa;font-size:15px;font-weight:700;margin:20px 0 8px">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 style="color:#fff;font-size:17px;font-weight:700;margin:20px 0 10px">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#fff">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:12px 0"/>')
    .replace(/^[-•] (.+)$/gm, '<div style="padding-left:12px;text-indent:-8px">• $1</div>')
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');
}

const CAND_COLORS = ["#8b5cf6", "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#ec4899", "#06b6d4", "#94a3b8"];
const PARTY_COLORS: Record<string, string> = {
  "Republican": "#ef4444", "Democrat": "#3b82f6", "Independent": "#a855f7",
  "R": "#ef4444", "D": "#3b82f6", "I": "#a855f7",
};

function candColor(name: string, idx: number): string {
  for (const [party, color] of Object.entries(PARTY_COLORS)) {
    if (name.includes(party)) return color;
  }
  return CAND_COLORS[idx % CAND_COLORS.length];
}

export default function PredictionAnalysisPanel({ wsId }: { wsId: string }) {
  const t = useTr();
  const { locale } = useLocaleStore();
  const _wsId = useShellStore((s) => s.activeWorkspaceId);
  const workflowStatus = useWorkflowStatus(_wsId);
  const [predictions, setPredictions] = useState<any[]>([]);
  const [selectedPredId, setSelectedPredId] = useState<string>("");
  const [predData, setPredData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [analysisText, setAnalysisText] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string>("");

  useEffect(() => {
    Promise.all([listPredictions(), listSnapshots()]).then(([predRes, snapRes]) => {
      const wsSnapIds = new Set((snapRes.snapshots || []).filter((s: any) => s.workspace_id === wsId).map((s: any) => s.snapshot_id));
      const list = (predRes.predictions || [])
        .filter((p: any) => (p.status === "completed" || p.has_results) && wsSnapIds.has(p.snapshot_id));
      setPredictions(list);
      if (list.length > 0) setSelectedPredId(list[0].prediction_id);
      else setSelectedPredId("");
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [wsId]);

  useEffect(() => {
    if (!selectedPredId) { setPredData(null); return; }
    setAnalysisText("");
    getPrediction(selectedPredId).then(data => {
      setPredData(data);
      const results = data?.results?.scenario_results?.[0];
      if (results?.poll_group_results) {
        const firstGroup = Object.keys(results.poll_group_results)[0];
        if (firstGroup) setSelectedGroup(firstGroup);
      }
    }).catch(() => setPredData(null));
    // Restore saved analysis for this prediction
    getUiSettings(wsId, "prediction-analysis").then((cfg: any) => {
      const saved = cfg?.analyses?.[selectedPredId];
      if (saved) setAnalysisText(saved);
    }).catch(() => {});
  }, [selectedPredId, wsId]);

  const handleAnalyze = async () => {
    if (!predData?.results?.scenario_results) return;
    setAnalysisLoading(true);
    setAnalysisText("");
    try {
      const sr = predData.results.scenario_results[0];
      const ds = sr?.daily_summary || [];
      const pg: any[] = predData.poll_groups || [];
      let summary = "";
      summary += `[Basic Info]\n`;
      summary += `Prediction question: ${predData.question}\n`;
      summary += `Sim days: ${ds.length}, voters: ${sr.agent_count}\n`;
      summary += `Final avg satisfaction: ${sr.final_avg_satisfaction}, Final avg anxiety: ${sr.final_avg_anxiety}\n`;
      if (pg.length > 1 && sr.poll_group_results) {
        summary += `\n[Weighted Overall Scores]\n`;
        summary += `Calculation: ${pg.map((g: any) => `${g.name}×${g.weight}%`).join(" + ")}\n`;
        const wt: Record<string, number> = {};
        let tw = 0;
        for (const g of pg) {
          const gd = sr.poll_group_results[g.name] || {};
          tw += g.weight;
          for (const [cn, pct] of Object.entries(gd)) {
            if (cn === "__weighted_combined__") continue;
            wt[cn] = (wt[cn] || 0) + (pct as number) * g.weight;
          }
        }
        if (tw > 0) Object.keys(wt).forEach(k => { wt[k] = Math.round(wt[k] / tw * 10) / 10; });
        Object.entries(wt).filter(([k]) => k !== "Undecided" && k !== "不表態").sort(([,a], [,b]) => b - a).forEach(([cn, pct]) => { summary += `  ${cn}: ${pct}%\n`; });
      }
      if (sr.poll_group_results) {
        summary += `\n[Group Results]\n`;
        for (const g of pg) {
          const gd = sr.poll_group_results[g.name] || {};
          summary += `\n${g.name} — weight ${g.weight}%:\n`;
          Object.entries(gd).sort(([, a]: any, [, b]: any) => b - a).forEach(([cn, p]: [string, any]) => { summary += `  ${cn}: ${p}%\n`; });
        }
      }
      if (sr.contrast_comparison) {
        const cc = sr.contrast_comparison;
        summary += `\n[Head-to-Head Results]\n`;
        summary += `Common opponent: ${cc.common_opponent}\n`;
        for (const g of cc.groups || []) {
          summary += `  ${g.challenger} vs ${g.opponent}: ${g.challenger_pct}% vs ${g.opponent_pct}% (margin ${g.margin > 0 ? "+" : ""}${g.margin}%)\n`;
        }
        summary += `Recommended: ${cc.recommended} (margin ${cc.recommended_margin}%)\n`;
      }
      if (ds.length >= 2) {
        summary += `\n【情緒變化】\n`;
        const d1 = ds[0], dN = ds[ds.length - 1];
        summary += `  滿意度: Day1=${d1.avg_satisfaction} → Day${dN.day}=${dN.avg_satisfaction}\n`;
        summary += `  焦慮度: Day1=${d1.avg_anxiety} → Day${dN.day}=${dN.avg_anxiety}\n`;
      }
      if (sr.leaning_distribution) {
        summary += `\n【選民政治傾向】\n`;
        summary += Object.entries(sr.leaning_distribution).map(([k, v]) => `  ${k}: ${v}%`).join("\n") + "\n";
      }
      const res = await analyzePrediction(summary, predData.question || t("predanalysis.fallback_question"));
      const text = res.analysis || t("predanalysis.no_analysis");
      setAnalysisText(text);
      // Persist to UI settings
      try {
        const existing = await getUiSettings(wsId, "prediction-analysis").catch(() => ({})) as any;
        const analyses = existing?.analyses || {};
        analyses[selectedPredId] = text;
        await saveUiSettings(wsId, "prediction-analysis", { analyses });
      } catch { }
    } catch (e: any) {
      setAnalysisText(t("predanalysis.analyze_failed", { msg: e.message || String(e) }));
    } finally {
      setAnalysisLoading(false);
    }
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

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-faint)" }}>{t("predanalysis.loading")}</div>;

  if (predictions.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <span style={{ fontSize: 32 }}>📈</span>
        <p style={{ color: "var(--text-faint)", fontFamily: "var(--font-cjk)", fontSize: 13 }}>
          {t("predanalysis.empty")}
        </p>
      </div>
    );
  }

  const scenario = predData?.results?.scenario_results?.[0];
  const dailySummary: any[] = scenario?.daily_summary || [];
  const pollGroupResults: Record<string, Record<string, number>> = scenario?.poll_group_results || {};
  const llmPollGroupResults: Record<string, Record<string, number>> = scenario?.llm_poll_group_results || {};
  const hasLlmResults = Object.keys(llmPollGroupResults).length > 0;
  const groupNames = Object.keys(pollGroupResults).filter(g => g !== "__weighted_combined__");
  const contrastComparison = scenario?.contrast_comparison;
  const votePrediction: Record<string, number> = scenario?.vote_prediction || {};
  const leaningDist: Record<string, number> = scenario?.leaning_distribution || {};

  const pollGroups: any[] = predData?.poll_groups || [];
  const weightedTotal: Record<string, number> = {};
  let totalWeight = 0;
  for (const gn of groupNames) {
    const gData = pollGroupResults[gn] || {};
    const gConfig = pollGroups.find((g: any) => g.name === gn);
    const weight = gConfig?.weight || 100;
    totalWeight += weight;
    for (const [cand, pct] of Object.entries(gData)) {
      if (cand === "__weighted_combined__") continue;
      weightedTotal[cand] = (weightedTotal[cand] || 0) + (pct as number) * weight;
    }
  }
  if (totalWeight > 0) {
    for (const k of Object.keys(weightedTotal)) {
      weightedTotal[k] = Math.round(weightedTotal[k] / totalWeight * 10) / 10;
    }
  }
  const weightedCandidates = Object.entries(weightedTotal)
    .filter(([k]) => k !== "Undecided" && k !== "不表態")
    .sort(([, a], [, b]) => b - a);
  const weightedUndecided = (weightedTotal["Undecided"] ?? weightedTotal["不表態"]) || 0;

  const currentGroupData = pollGroupResults[selectedGroup] || {};
  const currentLlmData = llmPollGroupResults[selectedGroup] || {};
  const candidates = Object.keys(currentGroupData).filter(c => c !== "Undecided" && c !== "不表態" && c !== "__weighted_combined__");

  const trendData = dailySummary.map((d: any) => {
    const row: any = { day: d.day };
    const ge = d.group_estimates?.[selectedGroup] || {};
    for (const c of candidates) { row[c] = ge[c] ?? 0; }
    row["Undecided"] = (ge["Undecided"] ?? ge["不表態"]) || 0;
    row.avg_satisfaction = d.avg_satisfaction;
    row.avg_anxiety = d.avg_anxiety;
    return row;
  });

  const comparisonBarData = candidates.map(c => ({
    name: c,
    Weighted: currentGroupData[c] || 0,
    ...(hasLlmResults ? { "LLM Vote": currentLlmData[c] || 0 } : {}),
  }));
  comparisonBarData.push({
    name: "Undecided",
    Weighted: (currentGroupData["Undecided"] ?? currentGroupData["不表態"]) || 0,
    ...(hasLlmResults ? { "LLM Vote": (currentLlmData["Undecided"] ?? currentLlmData["不表態"]) || 0 } : {}),
  });

  // Determine overall winner from vote_prediction or weighted total
  // Prefer LLM voting results (more realistic) over heuristic for the hero tally.
  // Merge all LLM poll group results into a single tally (weighted by group weight).
  const llmMerged: Record<string, number> = {};
  if (hasLlmResults) {
    let tw = 0;
    for (const gn of Object.keys(llmPollGroupResults)) {
      const gConfig = pollGroups.find((g: any) => g.name === gn);
      const w = gConfig?.weight || 100;
      tw += w;
      for (const [c, p] of Object.entries(llmPollGroupResults[gn])) {
        llmMerged[c] = (llmMerged[c] || 0) + (p as number) * w;
      }
    }
    if (tw > 0) for (const k of Object.keys(llmMerged)) llmMerged[k] = Math.round(llmMerged[k] / tw * 10) / 10;
  }
  const primaryResults = hasLlmResults ? llmMerged : votePrediction;
  const primaryLabel = hasLlmResults ? "LLM Voting" : "Weighted Poll";
  const vpEntries = Object.entries(primaryResults).filter(([k]) => k !== "Undecided" && k !== "Undecided" && k !== "不表態").sort(([,a], [,b]) => b - a);
  const vpUndecided = primaryResults["Undecided"] ?? primaryResults["不表態"] ?? 0;
  const overallWinner = vpEntries[0];
  const overallRunnerUp = vpEntries[1];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "auto" }}>
      <div style={{ padding: "12px clamp(12px, 2vw, 24px)", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h2 style={{ color: "#fff", fontSize: 18, fontWeight: 700, margin: 0, fontFamily: "var(--font-cjk)" }}>
            {t("predanalysis.title")}
          </h2>
          <select
            value={selectedPredId}
            onChange={e => setSelectedPredId(e.target.value)}
            style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 12, fontFamily: "var(--font-cjk)" }}
          >
            {predictions.map((p: any) => (
              <option key={p.prediction_id} value={p.prediction_id}>
                {p.question || p.prediction_id} — {new Date((p.created_at || 0) * 1000).toLocaleDateString(locale === "en" ? "en-US" : "zh-TW")}
              </option>
            ))}
          </select>
        </div>

        {!scenario ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--text-faint)", fontFamily: "var(--font-cjk)" }}>
            {predData ? t("predanalysis.not_done") : t("predanalysis.loading")}
          </div>
        ) : (
          <>
            {/* ═══════ HERO: Election Night Result Card ═══════ */}
            {overallWinner && (
              <div style={{
                padding: "24px 28px", borderRadius: 14,
                background: "linear-gradient(135deg, rgba(139,92,246,0.12), rgba(59,130,246,0.08), rgba(34,197,94,0.05))",
                border: "1px solid rgba(139,92,246,0.25)",
                position: "relative", overflow: "hidden",
              }}>
                {/* Decorative glow */}
                <div style={{ position: "absolute", top: -40, right: -40, width: 120, height: 120, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.15), transparent 70%)" }} />

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <span style={{ fontSize: 22 }}>🗳️</span>
                  <span style={{ fontSize: 17, fontWeight: 800, color: "#fff", fontFamily: "var(--font-cjk)" }}>{t("predanalysis.hero.title")}</span>
                  <span style={{ padding: "2px 8px", borderRadius: 6, background: hasLlmResults ? "rgba(167,139,250,0.15)" : "rgba(251,191,36,0.15)", border: `1px solid ${hasLlmResults ? "rgba(167,139,250,0.3)" : "rgba(251,191,36,0.3)"}`, color: hasLlmResults ? "#a78bfa" : "#fbbf24", fontSize: 10, fontWeight: 700 }}>
                    {primaryLabel}
                  </span>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)" }}>
                    {t("predanalysis.hero.meta", { voters: scenario.agent_count, days: dailySummary.length })}
                  </span>
                </div>

                {/* Main vote tally */}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                  {vpEntries.map(([name, pct], i) => {
                    const isWinner = i === 0;
                    const color = candColor(name, i);
                    return (
                      <div key={name} style={{
                        flex: "1 1 160px", padding: "16px 20px", borderRadius: 10, textAlign: "center",
                        background: isWinner ? `linear-gradient(135deg, ${color}18, ${color}08)` : "rgba(255,255,255,0.02)",
                        border: isWinner ? `2px solid ${color}50` : "1px solid rgba(255,255,255,0.06)",
                        position: "relative",
                      }}>
                        {isWinner && (
                          <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", fontSize: 20 }}>
                            👑
                          </div>
                        )}
                        <div style={{ fontSize: 12, color: isWinner ? color : "rgba(255,255,255,0.5)", fontFamily: "var(--font-cjk)", marginBottom: 6, fontWeight: 700 }}>
                          {name}
                        </div>
                        <div style={{ fontSize: 36, fontWeight: 900, color: isWinner ? color : "#fff", fontFamily: "var(--font-mono)", lineHeight: 1 }}>
                          {pct}%
                        </div>
                        {isWinner && overallRunnerUp && (
                          <div style={{ fontSize: 10, color: "#22c55e", marginTop: 6, fontWeight: 600, fontFamily: "var(--font-cjk)" }}>
                            {t("predanalysis.hero.lead_pp", { pp: (pct - overallRunnerUp[1]).toFixed(1) })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {vpUndecided > 0 && (
                    <div style={{
                      flex: "0 1 100px", padding: "16px 20px", borderRadius: 10, textAlign: "center",
                      background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)",
                    }}>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: "var(--font-cjk)", marginBottom: 6 }}>{t("predanalysis.undecided")}</div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: "rgba(255,255,255,0.3)", fontFamily: "var(--font-mono)" }}>
                        {vpUndecided}%
                      </div>
                    </div>
                  )}
                </div>

                {/* Progress bar visualization */}
                <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", gap: 2 }}>
                  {vpEntries.map(([name, pct], i) => (
                    <div key={name} style={{ flex: pct, background: candColor(name, i), borderRadius: 4, transition: "flex 0.5s" }} />
                  ))}
                  {vpUndecided > 0 && (
                    <div style={{ flex: vpUndecided, background: "rgba(255,255,255,0.1)", borderRadius: 4 }} />
                  )}
                </div>
              </div>
            )}

            {/* ═══════ CONTRAST COMPARISON (if available) ═══════ */}
            {contrastComparison && contrastComparison.groups?.length > 0 && (
              <div style={{
                padding: "20px 24px", borderRadius: 12,
                background: "linear-gradient(135deg, rgba(245,158,11,0.06), rgba(239,68,68,0.04))",
                border: "1px solid rgba(245,158,11,0.2)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                  <span style={{ fontSize: 18 }}>⚔️</span>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "#fff", fontFamily: "var(--font-cjk)" }}>{t("predanalysis.contrast.title")}</span>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)" }}>
                    {t("predanalysis.contrast.common_opp", { name: contrastComparison.common_opponent })}
                  </span>
                </div>

                {/* Contrast groups */}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                  {contrastComparison.groups.map((g: any, i: number) => {
                    const isRecommended = g.challenger === contrastComparison.recommended;
                    const challengerColor = candColor(g.challenger, i);
                    const opponentColor = candColor(g.opponent, i + 3);
                    return (
                      <div key={i} style={{
                        flex: "1 1 250px", padding: "14px 18px", borderRadius: 10,
                        background: isRecommended ? "rgba(34,197,94,0.06)" : "rgba(255,255,255,0.02)",
                        border: isRecommended ? "1.5px solid rgba(34,197,94,0.3)" : "1px solid rgba(255,255,255,0.06)",
                      }}>
                        {isRecommended && (
                          <div style={{ fontSize: 9, color: "#22c55e", fontWeight: 700, fontFamily: "var(--font-cjk)", marginBottom: 6, letterSpacing: 1 }}>
                            {t("predanalysis.contrast.recommended")}
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                          {g.group}
                        </div>

                        {/* VS Layout */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
                          <div style={{ textAlign: "center", flex: 1 }}>
                            <div style={{ fontSize: 11, color: challengerColor, fontWeight: 700, fontFamily: "var(--font-cjk)", marginBottom: 4 }}>
                              {g.challenger}
                            </div>
                            <div style={{ fontSize: 28, fontWeight: 900, color: challengerColor, fontFamily: "var(--font-mono)" }}>
                              {g.challenger_pct}%
                            </div>
                          </div>
                          <div style={{ fontSize: 14, color: "rgba(255,255,255,0.2)", fontWeight: 900, padding: "0 4px" }}>VS</div>
                          <div style={{ textAlign: "center", flex: 1 }}>
                            <div style={{ fontSize: 11, color: opponentColor, fontWeight: 700, fontFamily: "var(--font-cjk)", marginBottom: 4 }}>
                              {g.opponent}
                            </div>
                            <div style={{ fontSize: 28, fontWeight: 900, color: opponentColor, fontFamily: "var(--font-mono)" }}>
                              {g.opponent_pct}%
                            </div>
                          </div>
                        </div>

                        {/* Margin bar */}
                        <div style={{ marginTop: 8, textAlign: "center" }}>
                          <div style={{ fontSize: 10, color: g.margin > 0 ? "#22c55e" : "#ef4444", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
                            {t("predanalysis.contrast.margin", { sign: g.margin > 0 ? "+" : "", pct: g.margin })}
                          </div>
                          <div style={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden", gap: 1, marginTop: 4 }}>
                            <div style={{ flex: g.challenger_pct, background: challengerColor, borderRadius: 2 }} />
                            <div style={{ flex: g.opponent_pct, background: opponentColor, borderRadius: 2 }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Recommendation */}
                {contrastComparison.recommended && (
                  <div style={{
                    padding: "12px 18px", borderRadius: 8,
                    background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)",
                    display: "flex", alignItems: "center", gap: 10,
                  }}>
                    <span style={{ fontSize: 20 }}>🏆</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "#22c55e", fontFamily: "var(--font-cjk)" }}>
                        {t("predanalysis.contrast.sys_rec", { name: contrastComparison.recommended })}
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-cjk)", marginTop: 2 }}>
                        {t("predanalysis.contrast.rec_explain", {
                          opponent: contrastComparison.common_opponent,
                          sign: contrastComparison.recommended_margin > 0 ? "+" : "",
                          margin: contrastComparison.recommended_margin,
                          other: contrastComparison.groups?.find((g: any) => g.challenger !== contrastComparison.recommended)?.challenger || t("predanalysis.contrast.opponent_fallback"),
                          pp: Math.abs((contrastComparison.groups?.find((g: any) => g.challenger !== contrastComparison.recommended)?.margin || 0) - contrastComparison.recommended_margin).toFixed(1),
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ═══════ LLM Vote vs Heuristic ═══════ */}
            {hasLlmResults && (
              <div style={{
                padding: "16px 20px", borderRadius: 10,
                background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 15 }}>🤖</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)" }}>
                    {t("predanalysis.llm_vs_heur")}
                  </span>
                </div>

                {/* Per-group LLM results */}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {groupNames.map((gn) => {
                    const llmData = llmPollGroupResults[gn] || {};
                    const heuData = pollGroupResults[gn] || {};
                    const llmEntries = Object.entries(llmData).filter(([k]) => k !== "Undecided" && k !== "不表態").sort(([,a], [,b]) => b - a);

                    return (
                      <div key={gn} style={{ flex: "1 1 250px", padding: "12px 16px", borderRadius: 8, background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.04)" }}>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>{gn}</div>
                        {llmEntries.map(([cn, llmPct], ci) => {
                          const heuPct = heuData[cn] || 0;
                          const color = candColor(cn, ci);
                          return (
                            <div key={cn} style={{ marginBottom: 8 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
                                <span style={{ fontSize: 11, color, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{cn}</span>
                                <div style={{ display: "flex", gap: 8, fontSize: 11, fontFamily: "var(--font-mono)" }}>
                                  <span style={{ color: "#22c55e" }}>{t("predanalysis.llm_pct", { pct: llmPct })}</span>
                                  <span style={{ color: "#8b5cf6" }}>{t("predanalysis.heur_pct", { pct: heuPct })}</span>
                                </div>
                              </div>
                              {/* Dual bar */}
                              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
                                  <div style={{ height: "100%", width: `${llmPct}%`, background: "#22c55e", borderRadius: 3, transition: "width 0.5s" }} />
                                </div>
                                <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.03)", overflow: "hidden" }}>
                                  <div style={{ height: "100%", width: `${heuPct}%`, background: "#8b5cf6", borderRadius: 2, transition: "width 0.5s" }} />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ═══════ Overview Cards ═══════ */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                { label: t("predanalysis.stat.sim_days"),       value: dailySummary.length, color: "#94a3b8", isRate: false },
                { label: t("predanalysis.stat.voters"),         value: scenario.agent_count, color: "#a78bfa", isRate: false },
                { label: t("predanalysis.stat.avg_sat"),        value: scenario.final_avg_satisfaction, color: "#3b82f6", isRate: false },
                { label: t("predanalysis.stat.avg_anx"),        value: scenario.final_avg_anxiety, color: scenario.final_avg_anxiety > 60 ? "#ef4444" : "#22c55e", isRate: false },
                { label: t("predanalysis.stat.undecided_rate"), value: weightedUndecided || (Object.values(pollGroupResults)[0] as any)?.["不表態"] || "—", color: "#f59e0b", isRate: true },
              ].map((s, i) => (
                <div key={i} style={{
                  flex: "1 1 100px", padding: "8px 12px", borderRadius: 8,
                  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", textAlign: "center",
                }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: s.color, fontFamily: "var(--font-mono)" }}>
                    {typeof s.value === "number" ? (s.value % 1 === 0 ? s.value : s.value.toFixed(1)) : s.value}
                    {typeof s.value === "number" && s.isRate ? "%" : ""}
                  </div>
                  <div style={{ fontSize: 9, color: "var(--text-faint)", fontFamily: "var(--font-cjk)" }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* ═══════ Leaning Distribution Pie ═══════ */}
            {Object.keys(leaningDist).length > 0 && (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 200px", padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                    {t("predanalysis.lean_dist")}
                  </div>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
                    {Object.entries(leaningDist).map(([lean, pct]) => {
                      const LEAN_MAP: Record<string, { color: string; label: string }> = {
                        "偏綠": { color: "#22c55e", label: "偏綠" },
                        "偏藍": { color: "#3b82f6", label: "偏藍" },
                        "偏白": { color: "#06b6d4", label: "偏白" },
                      };
                      const info = LEAN_MAP[lean] || { color: "#94a3b8", label: lean };
                      return (
                        <div key={lean} style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 24, fontWeight: 800, color: info.color, fontFamily: "var(--font-mono)" }}>
                            {pct}%
                          </div>
                          <div style={{ fontSize: 10, color: info.color, fontFamily: "var(--font-cjk)", fontWeight: 600 }}>
                            {info.label}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Leaning bar */}
                  <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", gap: 1, marginTop: 8 }}>
                    {Object.entries(leaningDist).map(([lean, pct]) => {
                      const colors: Record<string, string> = { "偏綠": "#22c55e", "偏藍": "#3b82f6", "偏白": "#06b6d4" };
                      return <div key={lean} style={{ flex: pct as number, background: colors[lean] || "#94a3b8", borderRadius: 3 }} />;
                    })}
                  </div>
                </div>

                {/* Per-group results quick view */}
                {groupNames.length > 1 && (
                  <div style={{ flex: "2 1 350px", padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                      {t("predanalysis.group_results")}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {pollGroups.filter((g: any) => groupNames.includes(g.name)).map((g: any) => {
                        const gData = pollGroupResults[g.name] || {};
                        const sorted = Object.entries(gData).filter(([k]) => k !== "Undecided" && k !== "不表態" && k !== "__weighted_combined__").sort(([,a]: any, [,b]: any) => b - a);
                        return (
                          <div key={g.name} style={{ flex: "1 1 160px", padding: "10px 14px", borderRadius: 8, background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.04)" }}>
                            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)", marginBottom: 6 }}>
                              {g.name} ({g.weight}%)
                            </div>
                            {sorted.map(([cn, pct]: [string, any], ci) => (
                              <div key={cn} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                                <span style={{ fontSize: 11, color: candColor(cn, ci), fontFamily: "var(--font-cjk)", fontWeight: 600 }}>{cn}</span>
                                <span style={{ fontSize: 13, fontWeight: 800, color: "#fff", fontFamily: "var(--font-mono)" }}>{pct}%</span>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ═══════ Group Selector ═══════ */}
            {groupNames.length > 1 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {groupNames.map(g => (
                  <button key={g} onClick={() => setSelectedGroup(g)}
                    style={{
                      padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
                      fontFamily: "var(--font-cjk)",
                      border: selectedGroup === g ? "1px solid #a78bfa" : "1px solid rgba(255,255,255,0.1)",
                      background: selectedGroup === g ? "rgba(167,139,250,0.15)" : "transparent",
                      color: selectedGroup === g ? "#a78bfa" : "var(--text-faint)",
                    }}>
                    {g}
                  </button>
                ))}
              </div>
            )}

            {/* ═══════ Trend Charts ═══════ */}
            {trendData.length > 1 && (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: "2 1 400px", padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                    {t("predanalysis.chart.vote_trend")}
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={(d) => `D${d}`} />
                      <YAxis domain={[0, "auto"]} tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={(v) => `${v}%`} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => `${v}%`} />
                      {candidates.map((c, i) => (
                        <Line key={c} type="monotone" dataKey={c} stroke={candColor(c, i)} strokeWidth={2} dot={{ r: 3 }} name={c} />
                      ))}
                      <Line type="monotone" dataKey="不表態" stroke="#374151" strokeWidth={1} dot={false} strokeDasharray="4 4" name={t("predanalysis.undecided")} />
                      <Legend wrapperStyle={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div style={{ flex: "1 1 250px", padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                    {t("predanalysis.chart.mood_trend")}
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={(d) => `D${d}`} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#6b7280" }} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Line type="monotone" dataKey="avg_satisfaction" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} name={t("predanalysis.line.satisfaction")} />
                      <Line type="monotone" dataKey="avg_anxiety" stroke="#ef4444" strokeWidth={1.5} dot={{ r: 3 }} strokeDasharray="4 4" name={t("predanalysis.line.anxiety")} />
                      <Legend wrapperStyle={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* ═══════ By-Leaning Breakdown ═══════ */}
            {dailySummary.length > 0 && (() => {
              const lastDay = dailySummary[dailySummary.length - 1];
              const byLeaning = lastDay?.group_leaning_candidate?.[selectedGroup];
              if (!byLeaning) return null;
              const leanings = Object.keys(byLeaning);
              const barData = leanings.map(l => {
                const row: any = { leaning: l };
                for (const c of candidates) { row[c] = byLeaning[l]?.[c] ?? 0; }
                return row;
              });
              return (
                <div style={{ padding: 12, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                    {t("predanalysis.by_lean")}
                  </div>
                  <ResponsiveContainer width="100%" height={Math.max(100, leanings.length * 40)}>
                    <BarChart data={barData} layout="vertical" margin={{ left: 50 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 9, fill: "#6b7280" }} tickFormatter={(v) => `${v}%`} />
                      <YAxis dataKey="leaning" type="category" tick={{ fontSize: 10, fill: "#9ca3af", fontFamily: "var(--font-cjk)" }} width={50} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => `${v}%`} />
                      {candidates.map((c, i) => (
                        <Bar key={c} dataKey={c} fill={candColor(c, i)} barSize={10} radius={[0, 3, 3, 0]} name={c} />
                      ))}
                      <Legend wrapperStyle={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              );
            })()}

            {/* ═══════ AI Analysis ═══════ */}
            <div style={{ padding: 12, borderRadius: 8, background: "linear-gradient(135deg, rgba(139,92,246,0.05), rgba(59,130,246,0.05))", border: "1px solid rgba(139,92,246,0.15)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#a78bfa", fontFamily: "var(--font-cjk)" }}>{t("predanalysis.ai.title")}</div>
                <button onClick={handleAnalyze} disabled={analysisLoading}
                  style={{
                    padding: "5px 14px", borderRadius: 6,
                    border: "1px solid rgba(139,92,246,0.3)",
                    background: analysisLoading ? "rgba(139,92,246,0.2)" : "rgba(139,92,246,0.1)",
                    color: "#a78bfa", fontSize: 12, fontWeight: 600,
                    cursor: analysisLoading ? "wait" : "pointer", fontFamily: "var(--font-cjk)",
                  }}>
                  {analysisLoading ? t("predanalysis.ai.analyzing") : t("predanalysis.ai.btn_generate")}
                </button>
              </div>
              {analysisText ? (
                <div
                  style={{ color: "rgba(255,255,255,0.75)", fontSize: 13, lineHeight: 1.8, fontFamily: "var(--font-cjk)" }}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(analysisText) }}
                />
              ) : (
                <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, fontFamily: "var(--font-cjk)" }}>
                  {t("predanalysis.ai.placeholder")}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
