"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getWorkspace,
  getEvolutionSources,
  addEvolutionSource,
  deleteEvolutionSource,
  updateEvolutionSource,
  triggerCrawl,
  getNewsPool,
  injectNewsArticle,
  getDietRules,
  updateDietRules,
  startEvolution,
  stopEvolution,
  resetEvolution,
  getEvolutionStatus,
  getEvolutionHistory,
  getEvolutionLatest,
  getAgentDiary,
  getAgentStats,
  getWorkspacePersonas,
  searchAgentMemory,
  type WorkspaceDetail,
} from "@/lib/api";
import GroupedStatsPanel from "@/components/GroupedStatsPanel";
import { useTr } from "@/lib/i18n";
import { StepGate } from "@/components/shared/StepGate";
import { GuideBanner } from "@/components/shared/GuideBanner";
import { useWorkflowStatus } from "@/hooks/use-workflow-status";
import { useShellStore } from "@/store/shell-store";

// ── Sub-tab definitions ────────────────────────────────────────────

const SUB_TABS = [
  { key: "pool", icon: "🌍", label: "中央新聞池" },
  { key: "diet", icon: "🕸️", label: "同溫層配方" },
  { key: "runner", icon: "⏳", label: "演化引擎" },
  { key: "memory", icon: "🧠", label: "記憶探索" },
] as const;

type SubTabKey = typeof SUB_TABS[number]["key"];

export default function EvolutionPanel({
  wsId,
  defaultTab,
}: {
  wsId: string;
  defaultTab?: SubTabKey;
}) {
  const t = useTr();
  const _wsId = useShellStore((s) => s.activeWorkspaceId);
  const workflowStatus = useWorkflowStatus(_wsId);

  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [activeTab, setActiveTab] = useState<SubTabKey>(defaultTab ?? "pool");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // ── Pool state ──
  const [sources, setSources] = useState<any[]>([]);
  const [pool, setPool] = useState<any[]>([]);
  const [poolCount, setPoolCount] = useState(0);
  const [crawling, setCrawling] = useState(false);
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceMaxItems, setNewSourceMaxItems] = useState(10);
  const [injectTitle, setInjectTitle] = useState("");
  const [injectSummary, setInjectSummary] = useState("");

  // ── Diet state ──
  const [dietRules, setDietRules] = useState<any>(null);

  // ── Runner state ──
  const [personas, setPersonas] = useState<any[]>([]);
  const [evolDays, setEvolDays] = useState(7);
  const [evolConcurrency, setEvolConcurrency] = useState(5);
  const [evolving, setEvolving] = useState(false);
  const [evolJob, setEvolJob] = useState<any>(null);
  const [evolHistory, setEvolHistory] = useState<any[]>([]);

  // ── Memory state ──
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [diary, setDiary] = useState<any[]>([]);
  const [agentStats, setAgentStats] = useState<any>(null);
  const [memSearchQuery, setMemSearchQuery] = useState("");
  const [memResults, setMemResults] = useState<any[]>([]);

  // Fetch workspace on mount
  useEffect(() => {
    getWorkspace(wsId).then(setWorkspace).catch(console.error);
  }, [wsId]);

  // On mount: auto-switch to runner tab if evolution is still running
  useEffect(() => {
    getEvolutionLatest().then(r => {
      if (r.job && (r.job.status === "running" || r.job.status === "pending")) {
        setActiveTab("runner");
        setEvolJob(r.job);
        setEvolving(true);
      }
    }).catch(console.error);
  }, []);

  // Fetch data when sub-tab changes
  useEffect(() => {
    if (activeTab === "pool") {
      getEvolutionSources().then(r => setSources(r.sources || [])).catch(console.error);
      getNewsPool().then(r => { setPool(r.articles || []); setPoolCount((r.articles || []).length); }).catch(console.error);
    }
    if (activeTab === "diet") {
      getDietRules().then(setDietRules).catch(console.error);
    }
    if (activeTab === "runner" || activeTab === "memory") {
      getWorkspacePersonas(wsId).then(r => setPersonas(r.agents || r.personas || [])).catch(console.error);
      getNewsPool().then(r => setPoolCount((r.articles || []).length)).catch(console.error);
    }
    if (activeTab === "runner") {
      // Always restore history and latest job on tab entry
      getEvolutionHistory().then(r => setEvolHistory(r.history || [])).catch(console.error);
      getEvolutionLatest().then(r => {
        if (r.job) {
          setEvolJob(r.job);
          if (r.job.status === "running") {
            setEvolving(true);
          }
        }
      }).catch(console.error);
    }
  }, [activeTab, wsId]);

  // Poll running evolution jobs — restarts whenever evolving/evolJob changes
  useEffect(() => {
    if (!evolving || !evolJob?.job_id) return;
    const pollInterval = setInterval(async () => {
      try {
        const status = await getEvolutionStatus(evolJob.job_id);
        setEvolJob(status);
        getEvolutionHistory().then(r => setEvolHistory(r.history || [])).catch(console.error);
        if (status.status === "completed" || status.status === "failed" || status.status === "stopped") {
          setEvolving(false);
          clearInterval(pollInterval);
        }
      } catch { /* ignore poll errors */ }
    }, 5000);
    return () => clearInterval(pollInterval);
  }, [evolving, evolJob?.job_id]);

  // ── Pool handlers ──
  const handleCrawl = async () => {
    setCrawling(true);
    setError("");
    try {
      const res = await triggerCrawl();
      setPool(res.articles || []);
      // Refresh pool
      const poolRes = await getNewsPool();
      setPool(poolRes.articles || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCrawling(false);
    }
  };

  const handleAddSource = async () => {
    if (!newSourceUrl) return;
    try {
      await addEvolutionSource({
        name: newSourceName || newSourceUrl,
        url: newSourceUrl,
        max_items: newSourceMaxItems,
      });
      setNewSourceUrl("");
      setNewSourceName("");
      setNewSourceMaxItems(10);
      const res = await getEvolutionSources();
      setSources(res.sources || []);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDeleteSource = async (sid: string) => {
    try {
      await deleteEvolutionSource(sid);
      const res = await getEvolutionSources();
      setSources(res.sources || []);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleInject = async () => {
    if (!injectTitle) return;
    try {
      await injectNewsArticle(injectTitle, injectSummary);
      setInjectTitle("");
      setInjectSummary("");
      const res = await getNewsPool();
      setPool(res.articles || []);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Evolution handlers ──
  const handleStartEvolution = async () => {
    if (!personas.length) { setError("請先在 Persona 生成 頁面產生 Persona"); return; }
    if (poolCount === 0) { setError("⚠️ 新聞池目前是空的！請先到『🌍 中央新聞池』爬取新聞或手動注入突發事件，否則 Agent 不會有任何資訊可以反應。"); return; }
    setEvolving(true);
    setError("");
    try {
      const res = await startEvolution(personas, evolDays, evolConcurrency);
      setEvolJob(res);
      // Polling is handled by the dedicated useEffect above
    } catch (e: any) {
      setError(e.message);
      setEvolving(false);
    }
  };

  // ── Memory handlers ──
  const handleSelectAgent = async (agentId: number) => {
    setSelectedAgentId(agentId);
    try {
      const d = await getAgentDiary(agentId);
      setDiary(d.entries || []);
      const s = await getAgentStats(agentId);
      setAgentStats(s);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleMemSearch = async () => {
    if (selectedAgentId === null || !memSearchQuery) return;
    try {
      const r = await searchAgentMemory(selectedAgentId, memSearchQuery);
      setMemResults(r.results || []);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Shared styles ──
  const cardStyle: React.CSSProperties = {
    backgroundColor: "rgba(255,255,255,0.02)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 10,
    padding: 20,
    marginBottom: 16,
  };
  const inputStyle: React.CSSProperties = {
    fontFamily: "var(--font-cjk)", fontSize: 13, padding: "8px 12px",
    backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 6, color: "var(--text-primary)", outline: "none", width: "100%",
  };
  const btnStyle: React.CSSProperties = {
    fontFamily: "var(--font-cjk)", fontSize: 13, padding: "8px 20px",
    backgroundColor: "var(--accent)", color: "#fff", border: "none", borderRadius: 6,
    cursor: "pointer", fontWeight: 600,
  };

  if (workflowStatus.evolution === "locked") {
    return (
      <StepGate
        requiredStep={1}
        requiredStepName="人設生成"
        requiredStepNameEn="Persona"
        description="請先在第 1 步生成 Persona，才能進行演化。"
        descriptionEn="Generate personas in Step 1 before running evolution."
        targetRoute={_wsId ? `/workspaces/${_wsId}/population-setup` : "/workspaces"}
      />
    );
  }

  if (!workspace) return <div style={{ flex: 1, padding: 48 }}>載入中...</div>;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
      <GuideBanner
        guideKey="guide_evolution"
        title="設定新聞來源"
        titleEn="Configure News Sources"
        message="新增 RSS 來源或手動注入新聞。代理人會在演化過程中閱讀這些新聞並形成觀點。"
        messageEn="Add RSS feeds or manually inject news articles. Agents will consume these during evolution to form opinions."
      />

        {/* Sub-tab bar */}
        <div style={{
          display: "flex", gap: 8, padding: "12px clamp(16px, 2vw, 32px)",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
        }}>
          {SUB_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: activeTab === tab.key ? 600 : 400,
                padding: "8px 16px", borderRadius: 20,
                backgroundColor: activeTab === tab.key ? "var(--accent)" : "rgba(255,255,255,0.04)",
                color: activeTab === tab.key ? "#fff" : "var(--text-muted)",
                border: "none", cursor: "pointer", transition: "all 0.2s",
              }}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {error && (
          <div style={{ margin: "0 32px", padding: "10px 16px", backgroundColor: "rgba(255,60,60,0.1)", borderRadius: 6, color: "#ff6b6b", fontSize: 13, fontFamily: "var(--font-cjk)" }}>
            {error}
          </div>
        )}

        <div style={{ padding: "16px clamp(16px, 2vw, 32px)", flex: 1, overflow: "auto" }}>

          {/* ──────── Sub-tab: 中央新聞池 ──────── */}
          {activeTab === "pool" && (
            <div>
              <h2 style={{ fontFamily: "var(--font-sans)", fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 20 }}>
                🌍 {t("evolution.tab.pool")}
              </h2>

              {/* Crawl button */}
              <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                <button onClick={handleCrawl} disabled={crawling} style={{ ...btnStyle, opacity: crawling ? 0.5 : 1 }}>
                  {crawling ? "🔄 爬取中..." : "🕷️ 立即爬取所有來源"}
                </button>
                <span style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-muted)", alignSelf: "center" }}>
                  新聞池目前共 {pool.length} 篇文章
                </span>
              </div>

              {/* Source list */}
              <div style={cardStyle}>
                <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                  已設定的來源 ({sources.length})
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {sources.map((s: any) => (
                    <div key={s.source_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", backgroundColor: "rgba(255,255,255,0.02)", borderRadius: 6 }}>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>{s.name}</span>
                        <span style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--text-faint)", marginLeft: 8 }}>[{s.tag}]</span>
                        <span style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}>{s.url}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <label style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)" }}>每次抓取:</label>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          defaultValue={s.max_items}
                          onBlur={async (e) => {
                            const val = Number(e.target.value);
                            if (val > 0 && val !== s.max_items) {
                              await updateEvolutionSource(s.source_id, { max_items: val });
                              const res = await getEvolutionSources();
                              setSources(res.sources || []);
                            }
                          }}
                          style={{ ...inputStyle, width: 50, textAlign: "center" as const, padding: "4px 6px", fontSize: 12 }}
                        />
                        <span style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)" }}>篇</span>
                        {!s.is_default && (
                          <button onClick={() => handleDeleteSource(s.source_id)} style={{ background: "none", border: "none", color: "#ff6b6b", cursor: "pointer", fontSize: 11 }}>✕ 移除</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Add source */}
                <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                  <input placeholder="名稱 (選填)" value={newSourceName} onChange={e => setNewSourceName(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                  <input placeholder="URL *" value={newSourceUrl} onChange={e => setNewSourceUrl(e.target.value)} style={{ ...inputStyle, flex: 2 }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <label style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)", whiteSpace: "nowrap" }}>每次:</label>
                    <input type="number" min={1} max={50} value={newSourceMaxItems} onChange={e => setNewSourceMaxItems(Number(e.target.value))} style={{ ...inputStyle, width: 50, textAlign: "center" as const, padding: "4px 6px", fontSize: 12 }} />
                    <span style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)" }}>篇</span>
                  </div>
                  <button onClick={handleAddSource} style={{ ...btnStyle, whiteSpace: "nowrap" }}>+ 新增來源</button>
                </div>
              </div>

              {/* Manual inject */}
              <div style={cardStyle}>
                <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                  🎮 上帝模式 — 手動注入突發事件
                </h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <input placeholder="事件標題 *" value={injectTitle} onChange={e => setInjectTitle(e.target.value)} style={{ ...inputStyle, flex: 2 }} />
                  <input placeholder="摘要 (選填)" value={injectSummary} onChange={e => setInjectSummary(e.target.value)} style={{ ...inputStyle, flex: 3 }} />
                  <button onClick={handleInject} style={{ ...btnStyle, whiteSpace: "nowrap" }}>⚡ 注入</button>
                </div>
              </div>

              {/* News pool preview */}
              {pool.length > 0 && (
                <div style={cardStyle}>
                  <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                    📰 今日新聞池 ({pool.length} 篇)
                  </h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 400, overflow: "auto" }}>
                    {pool.map((a: any, i: number) => (
                      <div key={a.article_id || i} style={{ display: "flex", gap: 12, padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                        <span style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--accent-light)", minWidth: 80 }}>[{a.source_tag}]</span>
                        <span style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-primary)" }}>{a.title}</span>
                        {a.summary && <span style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)" }}>— {a.summary}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ──────── Sub-tab: 同溫層配方 ──────── */}
          {activeTab === "diet" && (
            <div>
              <h2 style={{ fontFamily: "var(--font-sans)", fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 20 }}>
                🕸️ {t("evolution.tab.diet")}
              </h2>
              {dietRules && (() => {
                const sourceLeanings: Record<string, string> = dietRules.source_leanings || {
                  "自由時報": "偏左派", "三立新聞": "偏左派", "民視新聞": "偏左派",
                  "PTT八卦版": "偏左派", "PTT政黑版": "偏左派", "新頭殼": "偏左派",
                  "Yahoo新聞": "中立", "Dcard時事": "中立", "ETtoday": "中立", "PTT科技版": "中立",
                  "TVBS新聞": "偏右派", "聯合新聞網": "偏右派",
                  "中時電子報": "偏右派",
                };
                const leaningColor: Record<string, string> = {
                  "偏左派": "#22c55e", "中立": "#9ca3af", "偏右派": "#3b82f6",
                };
                const leaningEmoji: Record<string, string> = {
                  "偏左派": "🟢", "中立": "⚪", "偏右派": "🔵",
                };
                const leaningBadge = (src: string) => {
                  const l = sourceLeanings[src] || "中立";
                  return (
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 3,
                      padding: "2px 8px", borderRadius: 10, fontSize: 11,
                      backgroundColor: `${leaningColor[l] || "#94a3b8"}15`,
                      color: leaningColor[l] || "#94a3b8",
                      border: `1px solid ${leaningColor[l] || "#94a3b8"}30`,
                      fontFamily: "var(--font-cjk)", whiteSpace: "nowrap" as const,
                    }}>
                      {leaningEmoji[l]} {src}
                    </span>
                  );
                };

                // Group sources by leaning for the spectrum table
                const spectrum = ["偏左派", "中立", "偏右派"];
                const grouped: Record<string, string[]> = {};
                spectrum.forEach(l => grouped[l] = []);
                Object.entries(sourceLeanings).forEach(([src, l]) => {
                  if (grouped[l]) grouped[l].push(src);
                });

                return (
                  <>
                    {/* ── Media → Source mapping with leaning badges ── */}
                    <div style={cardStyle}>
                      <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                        📺 媒體習慣 → 新聞來源對應
                      </h3>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {Object.entries(dietRules.diet_map || {}).map(([habit, tags]: [string, any]) => (
                          <div key={habit} style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 14px", backgroundColor: "rgba(255,255,255,0.02)", borderRadius: 8, flexWrap: "wrap" }}>
                            <span style={{ fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600, color: "var(--accent-light)", minWidth: 130 }}>{habit}</span>
                            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>→</span>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {(tags as string[]).map((t: string) => (
                                <span key={t}>{leaningBadge(t)}</span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ── Source Political Spectrum Table ── */}
                    <div style={cardStyle}>
                      <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                        🏛️ 新聞來源政治光譜
                      </h3>
                      <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
                        Agent 的政治傾向（偏綠/偏藍）會影響他們更常看到哪些來源的新聞。相近立場的來源會獲得更高的推播優先權。
                      </p>
                      {/* Spectrum bar */}
                      <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", marginBottom: 16, height: 6 }}>
                        {spectrum.map(l => (
                          <div key={l} style={{ flex: 1, backgroundColor: leaningColor[l] }} />
                        ))}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
                        {spectrum.map(l => (
                          <div key={l} style={{
                            padding: "10px 8px", borderRadius: 8, textAlign: "center" as const,
                            backgroundColor: `${leaningColor[l]}08`,
                            border: `1px solid ${leaningColor[l]}20`,
                          }}>
                            <div style={{ fontSize: 14, marginBottom: 4 }}>{leaningEmoji[l]}</div>
                            <div style={{ fontFamily: "var(--font-cjk)", fontSize: 12, fontWeight: 600, color: leaningColor[l], marginBottom: 6 }}>{l}</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              {grouped[l].map(src => (
                                <span key={src} style={{ fontFamily: "var(--font-cjk)", fontSize: 10, color: "var(--text-muted)" }}>{src}</span>
                              ))}
                              {grouped[l].length === 0 && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>—</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ── Weight controls ── */}
                    <div style={cardStyle}>
                      <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
                        <div style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-secondary)" }}>
                          破圈機率 (Serendipity): <strong>{(dietRules.serendipity_rate * 100).toFixed(0)}%</strong>
                        </div>
                        <div style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-secondary)" }}>
                          每人每日推播: <strong>{dietRules.articles_per_agent} 篇</strong>
                        </div>
                      </div>

                      {/* ── 媒體立場影響力 slider ── */}
                      <div style={{ padding: "16px 20px", backgroundColor: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                          <span style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>
                            📺 媒體立場影響力
                          </span>
                          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                            <span style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "#60a5fa" }}>
                              管道匹配 {((1.0 - (dietRules.leaning_weight || 0)) * 100).toFixed(0)}%
                            </span>
                            <span style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "#fb923c" }}>
                              政治傾向 {((dietRules.leaning_weight || 0) * 100).toFixed(0)}%
                            </span>
                          </div>
                        </div>
                        <input
                          type="range" min={0} max={100} step={5}
                          value={(dietRules.leaning_weight || 0) * 100}
                          onChange={async (e: any) => {
                            const val = Number(e.target.value) / 100;
                            const updated = { ...dietRules, leaning_weight: val, channel_weight: 1.0 - val };
                            setDietRules(updated);
                            try { await updateDietRules(updated); } catch {}
                          }}
                          style={{ width: "100%", accentColor: "#fb923c", cursor: "pointer" }}
                        />
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                          <span style={{ fontFamily: "var(--font-cjk)", fontSize: 10, color: "#94a3b8" }}>關（不考慮媒體立場）</span>
                          <span style={{ fontFamily: "var(--font-cjk)", fontSize: 10, color: "#94a3b8" }}>強（藍綠立場影響大）</span>
                        </div>
                        <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
                          偏藍/偏綠的 Agent 會優先看到立場相近的新聞。例如：政治傾向為「偏綠」的 Agent 會更常看到自由時報、三立的內容。
                        </p>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* ──────── Sub-tab: 演化引擎 ──────── */}
          {activeTab === "runner" && (
            <div>
              <h2 style={{ fontFamily: "var(--font-sans)", fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 20 }}>
                ⏳ {t("evolution.tab.runner")}
              </h2>

              {/* Pool status warning */}
              {poolCount === 0 && (
                <div style={{ padding: "12px 16px", backgroundColor: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: 8, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 18 }}>⚠️</span>
                  <span style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "#fbbf24" }}>
                    新聞池目前是空的！請先到「🌍 中央新聞池」爬取新聞或手動注入突發事件，Agent 才有內容可以反應。
                  </span>
                  <button onClick={() => setActiveTab("pool")} style={{ ...btnStyle, backgroundColor: "rgba(251,191,36,0.3)", fontSize: 12, padding: "4px 12px" }}>前往新聞池 →</button>
                </div>
              )}
              {poolCount > 0 && (
                <div style={{ padding: "10px 16px", backgroundColor: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.15)", borderRadius: 8, marginBottom: 16 }}>
                  <span style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "#4ade80" }}>
                    ✅ 新聞池已準備就緒，共 {poolCount} 篇文章可供推播
                  </span>
                </div>
              )}

              <div style={cardStyle}>
                <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-secondary)" }}>
                    模擬天數:
                  </label>
                  <input type="number" min={1} max={90} value={evolDays} onChange={e => setEvolDays(Number(e.target.value))} style={{ ...inputStyle, width: 80 }} />
                  <label style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-secondary)" }}>
                    並行數:
                  </label>
                  <select value={evolConcurrency} onChange={e => setEvolConcurrency(Number(e.target.value))} style={{ ...inputStyle, width: 70, padding: "6px 8px" }}>
                    {[1, 3, 5, 8, 10].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <label style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-muted)" }}>
                    可用 Persona: {personas.length} 位
                  </label>
                  <label style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-muted)" }}>
                    新聞池: {poolCount} 篇
                  </label>
                  <button
                    onClick={handleStartEvolution}
                    disabled={evolving || !personas.length || poolCount === 0}
                    style={{ ...btnStyle, opacity: (evolving || poolCount === 0) ? 0.5 : 1 }}
                  >
                    {evolving ? "⏳ 演化中..." : "🚀 開始演化"}
                  </button>
                  {evolving && evolJob?.job_id && (
                    <button
                      onClick={async () => {
                        try {
                          await stopEvolution(evolJob.job_id);
                          setEvolving(false);
                        } catch {}
                      }}
                      style={{ ...btnStyle, backgroundColor: "rgba(251,191,36,0.15)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }}
                    >
                      ⏹️ 停止
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      if (!confirm("確定要重設？所有演化歷程（含圖表）將被清除。")) return;
                      try {
                        await resetEvolution();
                        setEvolJob(null);
                        setEvolHistory([]);
                        setEvolving(false);
                      } catch {}
                    }}
                    disabled={evolving}
                    style={{ ...btnStyle, backgroundColor: "rgba(255,107,107,0.1)", color: "#ff6b6b", border: "1px solid rgba(255,107,107,0.2)", opacity: evolving ? 0.4 : 1 }}
                  >
                    🗑️ 重設
                  </button>
                </div>
              </div>

              {/* Evolution job status */}
              {evolJob && (
                <div style={cardStyle}>
                  <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                    演化進度
                  </h3>
                  <div style={{ display: "flex", gap: 24, fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>
                    <span>狀態: <strong style={{ color: evolJob.status === "completed" ? "#4ade80" : evolJob.status === "failed" ? "#ff6b6b" : "var(--accent-light)" }}>{evolJob.status}</strong></span>
                    <span>進度: 第 {evolJob.current_day || 0} / {evolJob.total_days} 天</span>
                    <span>Agent 數: {evolJob.agent_count}</span>
                  </div>

                  {/* Progress bar */}
                  <div style={{ height: 6, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden", marginBottom: 16 }}>
                    <div style={{
                      height: "100%",
                      width: `${evolJob.total_days ? (evolJob.current_day / evolJob.total_days) * 100 : 0}%`,
                      backgroundColor: "var(--accent-light)",
                      borderRadius: 3,
                      transition: "width 0.5s ease",
                    }} />
                  </div>

                  {/* ── Live Activity Feed ── */}
                  {evolving && evolJob.live_messages && evolJob.live_messages.length > 0 && (
                    <div style={{
                      backgroundColor: "rgba(0,0,0,0.25)",
                      borderRadius: 8,
                      padding: "10px 14px",
                      marginBottom: 16,
                      maxHeight: 180,
                      overflowY: "auto",
                      border: "1px solid rgba(255,255,255,0.05)",
                    }}>
                      <div style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)", marginBottom: 6, letterSpacing: 1 }}>
                        ⚡ 即時動態
                      </div>
                      {evolJob.live_messages.map((msg: any, i: number) => (
                        <div
                          key={msg.ts || i}
                          style={{
                            fontFamily: "var(--font-cjk)",
                            fontSize: 12,
                            color: i === evolJob.live_messages.length - 1 ? "var(--text-secondary)" : "var(--text-muted)",
                            padding: "3px 0",
                            opacity: 0.4 + 0.6 * ((i + 1) / evolJob.live_messages.length),
                            borderBottom: i < evolJob.live_messages.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none",
                            transition: "opacity 0.3s ease",
                          }}
                        >
                          {msg.text}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ═══ Real-time Dashboard ═══ */}
                  {evolJob.daily_summary && evolJob.daily_summary.length > 0 && (() => {
                    const ds = evolJob.daily_summary;
                    const latest = ds[ds.length - 1];
                    const prev = ds.length > 1 ? ds[ds.length - 2] : null;
                    const satDelta = prev ? (latest.avg_satisfaction - prev.avg_satisfaction) : 0;
                    const anxDelta = prev ? (latest.avg_anxiety - prev.avg_anxiety) : 0;
                    const chartW = Math.max(ds.length * 50, 200);
                    return (
                    <div>
                      {/* ── Gauges row ── */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
                        {/* Satisfaction gauge */}
                        <div style={{ backgroundColor: "rgba(0,0,0,0.2)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                          <div style={{ fontFamily: "var(--font-cjk)", fontSize: 10, color: "var(--text-faint)", marginBottom: 4 }}>😊 滿意度</div>
                          <svg viewBox="0 0 100 60" style={{ width: 80, height: 48 }}>
                            <path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" strokeLinecap="round" />
                            <path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="#4ade80" strokeWidth="6" strokeLinecap="round"
                              strokeDasharray={`${latest.avg_satisfaction * 1.256} 999`}
                              style={{ transition: "stroke-dasharray 0.8s ease" }} />
                            <text x="50" y="48" textAnchor="middle" fill="#4ade80" style={{ fontSize: 14, fontWeight: 700 }}>{latest.avg_satisfaction.toFixed(1)}</text>
                          </svg>
                          <div style={{ fontSize: 11, color: satDelta >= 0 ? "#4ade80" : "#f87171", fontFamily: "var(--font-sans)" }}>
                            {satDelta >= 0 ? "▲" : "▼"} {Math.abs(satDelta).toFixed(1)}
                          </div>
                        </div>
                        {/* Anxiety gauge */}
                        <div style={{ backgroundColor: "rgba(0,0,0,0.2)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                          <div style={{ fontFamily: "var(--font-cjk)", fontSize: 10, color: "var(--text-faint)", marginBottom: 4 }}>😰 焦慮度</div>
                          <svg viewBox="0 0 100 60" style={{ width: 80, height: 48 }}>
                            <path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" strokeLinecap="round" />
                            <path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="#f87171" strokeWidth="6" strokeLinecap="round"
                              strokeDasharray={`${latest.avg_anxiety * 1.256} 999`}
                              style={{ transition: "stroke-dasharray 0.8s ease" }} />
                            <text x="50" y="48" textAnchor="middle" fill="#f87171" style={{ fontSize: 14, fontWeight: 700 }}>{latest.avg_anxiety.toFixed(1)}</text>
                          </svg>
                          <div style={{ fontSize: 11, color: anxDelta <= 0 ? "#4ade80" : "#f87171", fontFamily: "var(--font-sans)" }}>
                            {anxDelta >= 0 ? "▲" : "▼"} {Math.abs(anxDelta).toFixed(1)}
                          </div>
                        </div>
                        {/* Agent active count */}
                        <div style={{ backgroundColor: "rgba(0,0,0,0.2)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                          <div style={{ fontFamily: "var(--font-cjk)", fontSize: 10, color: "var(--text-faint)", marginBottom: 4 }}>🤖 反應 Agent</div>
                          <div style={{ fontFamily: "var(--font-sans)", fontSize: 28, fontWeight: 700, color: "#60a5fa", lineHeight: 1, marginTop: 8 }}>{latest.entries_count}</div>
                          <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-sans)", marginTop: 4 }}>/ {evolJob.agent_count} 位</div>
                        </div>
                        {/* Day counter */}
                        <div style={{ backgroundColor: "rgba(0,0,0,0.2)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                          <div style={{ fontFamily: "var(--font-cjk)", fontSize: 10, color: "var(--text-faint)", marginBottom: 4 }}>📅 演化天數</div>
                          <div style={{ fontFamily: "var(--font-sans)", fontSize: 28, fontWeight: 700, color: "var(--accent-light)", lineHeight: 1, marginTop: 8 }}>{evolJob.current_day}</div>
                          <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-sans)", marginTop: 4 }}>/ {evolJob.total_days} 天</div>
                        </div>
                      </div>

                      {/* ── Main trend chart with gradient fills ── */}
                      <h4 style={{ fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
                        📊 即時趨勢圖
                      </h4>
                      <div style={{ backgroundColor: "rgba(0,0,0,0.2)", borderRadius: 8, padding: 16, marginBottom: 16 }}>
                        <svg viewBox={`0 0 ${chartW} 140`} style={{ width: "100%", height: 180 }}>
                          <defs>
                            <linearGradient id="satFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#4ade80" stopOpacity="0.3" />
                              <stop offset="100%" stopColor="#4ade80" stopOpacity="0.02" />
                            </linearGradient>
                            <linearGradient id="anxFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#f87171" stopOpacity="0.2" />
                              <stop offset="100%" stopColor="#f87171" stopOpacity="0.02" />
                            </linearGradient>
                          </defs>
                          {/* Grid lines */}
                          <line x1="20" y1="10" x2={chartW} y2="10" stroke="rgba(255,255,255,0.04)" />
                          <line x1="20" y1="60" x2={chartW} y2="60" stroke="rgba(255,255,255,0.04)" />
                          <line x1="20" y1="110" x2={chartW} y2="110" stroke="rgba(255,255,255,0.04)" />
                          <text x="0" y="14" fill="var(--text-faint)" style={{ fontSize: 8 }}>100</text>
                          <text x="4" y="64" fill="var(--text-faint)" style={{ fontSize: 8 }}>50</text>
                          <text x="8" y="114" fill="var(--text-faint)" style={{ fontSize: 8 }}>0</text>

                          {/* Satisfaction area fill */}
                          <polygon
                            fill="url(#satFill)"
                            points={`${20 + 0 * 44},120 ${ds.map((d: any, i: number) => `${20 + i * 44},${110 - d.avg_satisfaction * 1.0}`).join(" ")} ${20 + (ds.length - 1) * 44},120`}
                          />
                          {/* Satisfaction line */}
                          <polyline fill="none" stroke="#4ade80" strokeWidth="2.5"
                            points={ds.map((d: any, i: number) => `${20 + i * 44},${110 - d.avg_satisfaction * 1.0}`).join(" ")}
                            style={{ transition: "all 0.5s ease" }}
                          />
                          {/* Satisfaction dots */}
                          {ds.map((d: any, i: number) => (
                            <g key={`sd-${i}`}>
                              <circle cx={20 + i * 44} cy={110 - d.avg_satisfaction * 1.0} r={4} fill="#4ade80" stroke="#1a1a2e" strokeWidth={2} />
                              <text x={20 + i * 44} y={110 - d.avg_satisfaction * 1.0 - 8} textAnchor="middle" fill="#4ade80" style={{ fontSize: 7 }}>{d.avg_satisfaction.toFixed(0)}</text>
                            </g>
                          ))}

                          {/* Anxiety area fill */}
                          <polygon
                            fill="url(#anxFill)"
                            points={`${20 + 0 * 44},120 ${ds.map((d: any, i: number) => `${20 + i * 44},${110 - d.avg_anxiety * 1.0}`).join(" ")} ${20 + (ds.length - 1) * 44},120`}
                          />
                          {/* Anxiety line */}
                          <polyline fill="none" stroke="#f87171" strokeWidth="2.5"
                            points={ds.map((d: any, i: number) => `${20 + i * 44},${110 - d.avg_anxiety * 1.0}`).join(" ")}
                            style={{ transition: "all 0.5s ease" }}
                          />
                          {/* Anxiety dots */}
                          {ds.map((d: any, i: number) => (
                            <g key={`ad-${i}`}>
                              <circle cx={20 + i * 44} cy={110 - d.avg_anxiety * 1.0} r={4} fill="#f87171" stroke="#1a1a2e" strokeWidth={2} />
                              <text x={20 + i * 44} y={110 - d.avg_anxiety * 1.0 + 14} textAnchor="middle" fill="#f87171" style={{ fontSize: 7 }}>{d.avg_anxiety.toFixed(0)}</text>
                            </g>
                          ))}

                          {/* X axis day labels */}
                          {ds.map((d: any, i: number) => (
                            <text key={`xl-${i}`} x={20 + i * 44} y={130} textAnchor="middle" fill="var(--text-faint)" style={{ fontSize: 8 }}>Day {d.day}</text>
                          ))}

                          {/* Legend */}
                          <circle cx={20} cy={4} r={3} fill="#4ade80" />
                          <text x={26} y={7} fill="#4ade80" style={{ fontSize: 8 }}>滿意度</text>
                          <circle cx={70} cy={4} r={3} fill="#f87171" />
                          <text x={76} y={7} fill="#f87171" style={{ fontSize: 8 }}>焦慮度</text>
                        </svg>
                      </div>

                      {/* ── Bar chart: daily response count ── */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                        <div>
                          <h4 style={{ fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
                            📊 每日反應 Agent 數
                          </h4>
                          <div style={{ backgroundColor: "rgba(0,0,0,0.2)", borderRadius: 8, padding: 12 }}>
                            <svg viewBox={`0 0 ${Math.max(ds.length * 40, 120)} 80`} style={{ width: "100%", height: 100 }}>
                              {ds.map((d: any, i: number) => {
                                const barH = (d.entries_count / Math.max(evolJob.agent_count, 1)) * 60;
                                return (
                                  <g key={`bar-${i}`}>
                                    <rect x={8 + i * 36} y={65 - barH} width={24} height={barH} rx={3}
                                      fill="rgba(96,165,250,0.6)" stroke="#60a5fa" strokeWidth={0.5}
                                      style={{ transition: "all 0.5s ease" }} />
                                    <text x={20 + i * 36} y={60 - barH} textAnchor="middle" fill="#60a5fa" style={{ fontSize: 8 }}>{d.entries_count}</text>
                                    <text x={20 + i * 36} y={76} textAnchor="middle" fill="var(--text-faint)" style={{ fontSize: 7 }}>D{d.day}</text>
                                  </g>
                                );
                              })}
                            </svg>
                          </div>
                        </div>

                        {/* ── Delta change chart ── */}
                        <div>
                          <h4 style={{ fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
                            📉 每日變化量 (Δ)
                          </h4>
                          <div style={{ backgroundColor: "rgba(0,0,0,0.2)", borderRadius: 8, padding: 12 }}>
                            <svg viewBox={`0 0 ${Math.max(ds.length * 40, 120)} 80`} style={{ width: "100%", height: 100 }}>
                              {/* Zero line */}
                              <line x1="0" y1="40" x2={ds.length * 40} y2="40" stroke="rgba(255,255,255,0.1)" />
                              {ds.map((d: any, i: number) => {
                                if (i === 0) return null;
                                const satD = d.avg_satisfaction - ds[i - 1].avg_satisfaction;
                                const anxD = d.avg_anxiety - ds[i - 1].avg_anxiety;
                                return (
                                  <g key={`delta-${i}`}>
                                    {/* Sat delta bar */}
                                    <rect x={4 + i * 36} y={satD >= 0 ? 40 - satD * 3 : 40} width={12} height={Math.abs(satD) * 3}
                                      rx={2} fill={satD >= 0 ? "rgba(74,222,128,0.6)" : "rgba(74,222,128,0.3)"}
                                      style={{ transition: "all 0.5s ease" }} />
                                    {/* Anx delta bar */}
                                    <rect x={18 + i * 36} y={anxD >= 0 ? 40 - anxD * 3 : 40} width={12} height={Math.abs(anxD) * 3}
                                      rx={2} fill={anxD >= 0 ? "rgba(248,113,113,0.6)" : "rgba(248,113,113,0.3)"}
                                      style={{ transition: "all 0.5s ease" }} />
                                    <text x={17 + i * 36} y={76} textAnchor="middle" fill="var(--text-faint)" style={{ fontSize: 7 }}>D{d.day}</text>
                                  </g>
                                );
                              })}
                            </svg>
                          </div>
                        </div>
                      </div>
                    </div>
                    );
                  })()}

                  {/* Cumulative history chart */}
                  {evolHistory.length > 0 && (
                    <div style={{ marginTop: 20 }}>
                      <h4 style={{ fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
                        📈 累計趨勢圖（含所有演化批次）
                      </h4>
                      <div style={{ backgroundColor: "rgba(0,0,0,0.2)", borderRadius: 8, padding: 16 }}>
                        <svg viewBox={`0 0 ${Math.max(evolHistory.length * 28 + 40, 200)} 130`} style={{ width: "100%", height: 180 }}>
                          {/* Y axis labels */}
                          <text x="0" y="12" fill="var(--text-faint)" style={{ fontSize: 9 }}>100</text>
                          <text x="0" y="62" fill="var(--text-faint)" style={{ fontSize: 9 }}>50</text>
                          <text x="0" y="112" fill="var(--text-faint)" style={{ fontSize: 9 }}>0</text>

                          {/* Injection point markers (orange dashed lines) */}
                          {evolHistory.map((d: any, i: number) => d.is_injection_point && (
                            <g key={`inj-${i}`}>
                              <line
                                x1={20 + i * 26} y1={10} x2={20 + i * 26} y2={115}
                                stroke="#fb923c" strokeWidth="1" strokeDasharray="4,3" opacity={0.7}
                              />
                              <text x={20 + i * 26 + 3} y={125} fill="#fb923c" style={{ fontSize: 7 }}>
                                📰{d.pool_article_count || ""}篇
                              </text>
                            </g>
                          ))}

                          {/* Satisfaction line (green) */}
                          <polyline
                            fill="none" stroke="#4ade80" strokeWidth="2"
                            points={evolHistory.map((d: any, i: number) =>
                              `${20 + i * 26},${110 - d.avg_satisfaction * 1.1}`
                            ).join(" ")}
                          />
                          {/* Anxiety line (red) */}
                          <polyline
                            fill="none" stroke="#f87171" strokeWidth="2"
                            points={evolHistory.map((d: any, i: number) =>
                              `${20 + i * 26},${110 - d.avg_anxiety * 1.1}`
                            ).join(" ")}
                          />

                          {/* X axis day labels */}
                          {evolHistory.map((d: any, i: number) => (
                            <text key={`x-${i}`} x={20 + i * 26} y={118} fill="var(--text-faint)" style={{ fontSize: 7 }} textAnchor="middle">
                              {d.global_day}
                            </text>
                          ))}

                          {/* Legend */}
                          <circle cx={20} cy={4} r={3} fill="#4ade80" />
                          <text x={26} y={7} fill="#4ade80" style={{ fontSize: 8 }}>滿意度</text>
                          <circle cx={70} cy={4} r={3} fill="#f87171" />
                          <text x={76} y={7} fill="#f87171" style={{ fontSize: 8 }}>焦慮度</text>
                          <line x1={110} y1={4} x2={125} y2={4} stroke="#fb923c" strokeWidth={1} strokeDasharray="4,3" />
                          <text x={128} y={7} fill="#fb923c" style={{ fontSize: 8 }}>新聞注入</text>
                        </svg>
                      </div>
                    </div>
                  )}

                  {/* Daily detail table */}
                  {evolJob.daily_summary && evolJob.daily_summary.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <h4 style={{ fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
                        📋 每日演化摘要
                      </h4>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-sans)", fontSize: 12 }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                            <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--text-muted)", fontWeight: 500 }}>天</th>
                            <th style={{ padding: "6px 8px", textAlign: "right", color: "#4ade80", fontWeight: 500 }}>平均滿意度</th>
                            <th style={{ padding: "6px 8px", textAlign: "right", color: "#f87171", fontWeight: 500 }}>平均焦慮度</th>
                            <th style={{ padding: "6px 8px", textAlign: "right", color: "var(--text-muted)", fontWeight: 500 }}>有反應的人數</th>
                          </tr>
                        </thead>
                        <tbody>
                          {evolJob.daily_summary.map((d: any) => (
                            <tr key={d.day} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                              <td style={{ padding: "5px 8px", color: "var(--accent-light)" }}>第 {d.day} 天</td>
                              <td style={{ padding: "5px 8px", textAlign: "right", color: "#4ade80" }}>{d.avg_satisfaction}</td>
                              <td style={{ padding: "5px 8px", textAlign: "right", color: "#f87171" }}>{d.avg_anxiety}</td>
                              <td style={{ padding: "5px 8px", textAlign: "right", color: d.entries_count === 0 ? "#ff6b6b" : "var(--text-muted)" }}>
                                {d.entries_count} / {evolJob.agent_count}
                                {d.entries_count === 0 && <span style={{ marginLeft: 6, fontSize: 11 }}>⚠️ 新聞池空</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* ── Grouped stats ── */}
                  {evolHistory.length > 0 && personas.length > 0 && (
                    <GroupedStatsPanel personas={personas} autoRefresh={!!evolJob} />
                  )}
                </div>
              )}
            </div>
          )}

          {/* ──────── Sub-tab: 記憶探索 ──────── */}
          {activeTab === "memory" && (
            <div>
              <h2 style={{ fontFamily: "var(--font-sans)", fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 20 }}>
                🧠 記憶探索 — Agent 日記與 RAG 搜尋
              </h2>

              {/* Agent selector */}
              <div style={cardStyle}>
                <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                  選擇 Agent（共 {personas.length} 位）
                </h3>
                {personas.length > 15 ? (
                  /* Dropdown for many agents */
                  <select
                    value={selectedAgentId ?? ""}
                    onChange={(e: any) => e.target.value && handleSelectAgent(Number(e.target.value))}
                    style={{
                      width: "100%", padding: "10px 14px", borderRadius: 8, fontSize: 13,
                      fontFamily: "var(--font-cjk)",
                      backgroundColor: "rgba(255,255,255,0.04)", color: "var(--text-primary)",
                      border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer",
                    }}
                  >
                    <option value="">— 請選擇 Agent —</option>
                    {personas.map((p: any) => (
                      <option key={p.person_id} value={p.person_id}>
                        #{p.person_id} {p.description?.slice(0, 30) || ""} {p.political_leaning ? `[${p.political_leaning}]` : ""} {p.media_habit ? `📱${p.media_habit}` : ""} {p.llm_vendor ? `🤖${p.llm_vendor.toUpperCase()}` : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  /* Button grid for fewer agents */
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {personas.map((p: any) => (
                      <button
                        key={p.person_id}
                        onClick={() => handleSelectAgent(p.person_id)}
                        style={{
                          padding: "6px 12px", borderRadius: 6, fontSize: 12,
                          fontFamily: "var(--font-cjk)",
                          backgroundColor: selectedAgentId === p.person_id ? "var(--accent)" : "rgba(255,255,255,0.04)",
                          color: selectedAgentId === p.person_id ? "#fff" : "var(--text-muted)",
                          border: "none", cursor: "pointer",
                          display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                        }}
                      >
                        <span>#{p.person_id} {p.description?.slice(0, 15) || ""}</span>
                        {p.media_habit && (
                          <span style={{ fontSize: 9, opacity: 0.6, color: "#fb923c" }}>📱 {p.media_habit}</span>
                        )}
                        {p.political_leaning && (
                          <span style={{ fontSize: 9, opacity: 0.7, color: p.political_leaning?.includes("本土") ? "#4ade80" : p.political_leaning?.includes("統") ? "#f87171" : "#94a3b8" }}>
                            🏛️ {p.political_leaning}
                          </span>
                        )}
                        {p.llm_vendor && (
                          <span style={{
                            fontSize: 9, fontWeight: 600, fontFamily: "var(--font-mono)",
                            color: p.llm_vendor === "gemini" ? "#4285f4" : "#10a37f",
                          }}>
                            🤖 {p.llm_vendor.toUpperCase()}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Agent stats */}
              {agentStats && (
                <div style={cardStyle}>
                  <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
                    當前狀態 — Agent #{selectedAgentId}
                  </h3>
                  <div style={{ display: "flex", gap: 24, fontFamily: "var(--font-sans)", fontSize: 13, flexWrap: "wrap" }}>
                    <span style={{ color: "#4ade80" }}>滿意度: <strong>{agentStats.satisfaction}</strong></span>
                    <span style={{ color: "#f87171" }}>焦慮度: <strong>{agentStats.anxiety}</strong></span>
                    <span style={{ color: "var(--text-muted)" }}>已演化: {agentStats.days_evolved} 天</span>
                  </div>
                  {(() => {
                    const ap = personas.find((pp: any) => String(pp.person_id) === String(selectedAgentId));
                    return ap ? (
                      <>
                        {ap.media_habit && (
                          <div style={{ marginTop: 8, fontSize: 12, color: "#fb923c", fontFamily: "var(--font-cjk)" }}>
                            📱 媒體管道: {ap.media_habit}
                          </div>
                        )}
                        {ap.political_leaning && (
                          <div style={{ marginTop: 4, fontSize: 12, fontFamily: "var(--font-cjk)", color: ap.political_leaning?.includes("本土") ? "#4ade80" : ap.political_leaning?.includes("統") ? "#f87171" : "#94a3b8" }}>
                            🏛️ 政治傾向: {ap.political_leaning}
                          </div>
                        )}
                        {ap.llm_vendor && (
                          <div style={{ marginTop: 4, fontSize: 12, fontFamily: "var(--font-cjk)", display: "flex", alignItems: "center", gap: 6 }}>
                            <span>🤖 LLM Vendor:</span>
                            <span style={{
                              padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                              fontFamily: "var(--font-mono)",
                              backgroundColor:
                                ap.llm_vendor === "template" ? "rgba(251,191,36,0.15)" :
                                ap.llm_vendor === "gemini" ? "rgba(66,133,244,0.15)" :
                                "rgba(16,163,127,0.15)",
                              color:
                                ap.llm_vendor === "template" ? "#fbbf24" :
                                ap.llm_vendor === "gemini" ? "#4285f4" :
                                "#10a37f",
                            }}>
                              {ap.llm_vendor === "template" ? "⚠️ TEMPLATE" : ap.llm_vendor.toUpperCase()}
                            </span>
                            {ap._fallback_vendor && (
                              <span style={{ fontSize: 10, color: "#fb923c", fontFamily: "var(--font-mono)" }}>
                                ({ap._original_vendor}→{ap._fallback_vendor})
                              </span>
                            )}
                          </div>
                        )}
                        {ap._llm_error && (
                          <div style={{ marginTop: 4, padding: "6px 10px", borderRadius: 6, backgroundColor: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.15)" }}>
                            <span style={{ fontSize: 11, color: "#ff6b6b", fontFamily: "var(--font-cjk)" }}>
                              ❌ 錯誤原因：{ap._llm_error}
                            </span>
                          </div>
                        )}
                      </>
                    ) : null;
                  })()}
                </div>
              )}

              {/* Diary timeline */}
              {diary.length > 0 && (
                <div style={cardStyle}>
                  <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                    📖 日記時間軸
                  </h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 300, overflow: "auto" }}>
                    {diary.map((e: any, i: number) => (
                      <div key={i} style={{ padding: "10px 14px", backgroundColor: "rgba(255,255,255,0.02)", borderRadius: 8, borderLeft: "3px solid var(--accent)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 600, color: "var(--accent-light)" }}>第 {e.day} 天</span>
                          <span style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--text-faint)" }}>
                            滿意: {e.satisfaction} | 焦慮: {e.anxiety}
                          </span>
                        </div>
                        <p style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-primary)", margin: 0, lineHeight: 1.6 }}>
                          {e.diary_text}
                        </p>
                        {e.fed_titles && (
                          <div style={{ marginTop: 6, fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)" }}>
                            看了: {e.fed_titles.join(" | ")}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* RAG Memory search */}
              <div style={cardStyle}>
                <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                  🔍 RAG 記憶搜尋
                </h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    placeholder="搜尋關鍵字 (例如: 電價 物價 房租)"
                    value={memSearchQuery}
                    onChange={e => setMemSearchQuery(e.target.value)}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button onClick={handleMemSearch} disabled={!selectedAgentId} style={btnStyle}>搜尋記憶</button>
                </div>
                {memResults.length > 0 && (
                  <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                    {memResults.map((r: any, i: number) => (
                      <div key={i} style={{ padding: "8px 12px", backgroundColor: "rgba(255,255,255,0.02)", borderRadius: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--accent-light)" }}>第 {r.day} 天 | 相關度: {r.relevance_score}</span>
                        </div>
                        <p style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-primary)", margin: 0 }}>{r.diary_text}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
    </div>
  );
}
