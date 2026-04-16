"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
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
import { useLocaleStore } from "@/store/locale-store";

// ── Sub-tab definitions ────────────────────────────────────────────

const SUB_TABS = [
  { key: "pool", icon: "🌍", label: "中央新聞池", labelEn: "Central News Pool" },
  { key: "diet", icon: "🕸️", label: "同溫層配方", labelEn: "Echo Chamber" },
  // runner tab removed — use Quick Start page instead
  { key: "memory", icon: "🧠", label: "記憶探索", labelEn: "Memory Explorer" },
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
  const router = useRouter();
  const en = useLocaleStore((s) => s.locale) === "en";
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
  const [evolDays, setEvolDays] = useState(30);
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

  // Runner tab removed — no auto-redirect needed, users access News Sources freely

  // Fetch data when sub-tab changes
  useEffect(() => {
    if (activeTab === "pool") {
      getEvolutionSources().then(r => setSources(r.sources || [])).catch(console.error);
      getNewsPool().then(r => { setPool(r.articles || []); setPoolCount((r.articles || []).length); }).catch(console.error);
    }
    if (activeTab === "diet") {
      getDietRules().then(setDietRules).catch(console.error);
    }
    if (activeTab === "memory") {
      getWorkspacePersonas(wsId).then(r => setPersonas(r.agents || r.personas || [])).catch(console.error);
      getNewsPool().then(r => setPoolCount((r.articles || []).length)).catch(console.error);
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
    if (!personas.length) { setError(en ? "Please generate Personas first in the Persona step." : "請先在 Persona 生成 頁面產生 Persona"); return; }
    if (poolCount === 0) { setError(en ? "⚠️ The news pool is empty! Go to '🌍 Central News Pool' to crawl news or manually inject events — agents need content to react to." : "⚠️ 新聞池目前是空的！請先到『🌍 中央新聞池』爬取新聞或手動注入突發事件，否則 Agent 不會有任何資訊可以反應。"); return; }
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
        requiredStepName={en ? "Persona Generation" : "人設生成"}
        requiredStepNameEn="Persona"
        description={en ? "Generate Personas in Step 1 before running evolution." : "請先在第 1 步生成 Persona，才能進行演化。"}
        descriptionEn="Generate personas in Step 1 before running evolution."
        targetRoute={_wsId ? `/workspaces/${_wsId}/population-setup` : "/workspaces"}
      />
    );
  }

  if (!workspace) return <div style={{ flex: 1, padding: 48 }}>{en ? "Loading..." : "載入中..."}</div>;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
      {/* Workflow navigation banner */}
      {workflowStatus.persona === "completed" && workflowStatus.evolution !== "completed" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "12px clamp(16px, 2vw, 32px)",
          background: "linear-gradient(90deg, rgba(34,197,94,0.08), rgba(59,130,246,0.08))",
          borderBottom: "1px solid rgba(34,197,94,0.15)",
        }}>
          <span style={{ fontSize: 20 }}>✅</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#86efac" }}>
              {en
                ? `${workflowStatus.personaCount} Personas ready — next: Evolution`
                : `${workflowStatus.personaCount} 位 Persona 已就緒 — 下一步：演化`}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
              {en
                ? "Use Quick Start for automated evolution, or configure advanced settings here."
                : "使用「快速演化」自動執行，或在此設定進階選項。"}
            </div>
          </div>
          <button
            onClick={() => router.push(`/workspaces/${wsId}/evolution-quickstart`)}
            style={{
              padding: "6px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: "rgba(59,130,246,0.2)", color: "#60a5fa",
              border: "1px solid rgba(59,130,246,0.3)", cursor: "pointer",
              whiteSpace: "nowrap" as const,
            }}
          >
            {en ? "Go to Quick Start →" : "前往快速演化 →"}
          </button>
        </div>
      )}
      <GuideBanner
        guideKey="guide_evolution"
        title={en ? "Configure News Sources" : "設定新聞來源"}
        titleEn="Configure News Sources"
        message={en ? "Add RSS feeds or manually inject news. Agents consume these during evolution to form opinions." : "新增 RSS 來源或手動注入新聞。代理人會在演化過程中閱讀這些新聞並形成觀點。"}
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
              {tab.icon} {en ? tab.labelEn : tab.label}
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

              {/* News pool status + manual crawl */}
              <div style={{ display: "flex", gap: 12, marginBottom: 20, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  {en ? `${pool.length} articles in news pool` : `新聞池目前共 ${pool.length} 篇文章`}
                </span>
                <span style={{ color: "rgba(255,255,255,0.15)" }}>|</span>
                <button onClick={handleCrawl} disabled={crawling} style={{
                  background: "none", border: "none", color: "rgba(255,255,255,0.35)",
                  fontSize: 12, cursor: crawling ? "not-allowed" : "pointer", textDecoration: "underline",
                  opacity: crawling ? 0.5 : 1,
                }}>
                  {crawling ? (en ? "Crawling..." : "爬取中...") : (en ? "Manual crawl" : "手動爬取")}
                </button>
              </div>

              {/* Source list */}
              <div style={cardStyle}>
                <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                  {en ? `Configured Sources (${sources.length})` : `已設定的來源 (${sources.length})`}
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
                        <label style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)" }}>{en ? "Per crawl:" : "每次抓取:"}</label>
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
                        <span style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)" }}>{en ? "articles" : "篇"}</span>
                        {!s.is_default && (
                          <button onClick={() => handleDeleteSource(s.source_id)} style={{ background: "none", border: "none", color: "#ff6b6b", cursor: "pointer", fontSize: 11 }}>{en ? "✕ Remove" : "✕ 移除"}</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Add source */}
                <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                  <input placeholder={en ? "Name (optional)" : "名稱 (選填)"} value={newSourceName} onChange={e => setNewSourceName(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                  <input placeholder="URL *" value={newSourceUrl} onChange={e => setNewSourceUrl(e.target.value)} style={{ ...inputStyle, flex: 2 }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <label style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)", whiteSpace: "nowrap" }}>{en ? "Per:" : "每次:"}</label>
                    <input type="number" min={1} max={50} value={newSourceMaxItems} onChange={e => setNewSourceMaxItems(Number(e.target.value))} style={{ ...inputStyle, width: 50, textAlign: "center" as const, padding: "4px 6px", fontSize: 12 }} />
                    <span style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)" }}>{en ? "articles" : "篇"}</span>
                  </div>
                  <button onClick={handleAddSource} style={{ ...btnStyle, whiteSpace: "nowrap" }}>{en ? "+ Add Source" : "+ 新增來源"}</button>
                </div>
              </div>

              {/* Manual inject */}
              <div style={cardStyle}>
                <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                  {en ? "🎮 God Mode — Manually Inject Breaking Events" : "🎮 上帝模式 — 手動注入突發事件"}
                </h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <input placeholder={en ? "Event title *" : "事件標題 *"} value={injectTitle} onChange={e => setInjectTitle(e.target.value)} style={{ ...inputStyle, flex: 2 }} />
                  <input placeholder={en ? "Summary (optional)" : "摘要 (選填)"} value={injectSummary} onChange={e => setInjectSummary(e.target.value)} style={{ ...inputStyle, flex: 3 }} />
                  <button onClick={handleInject} style={{ ...btnStyle, whiteSpace: "nowrap" }}>{en ? "⚡ Inject" : "⚡ 注入"}</button>
                </div>
              </div>

              {/* News pool preview */}
              {pool.length > 0 && (
                <div style={cardStyle}>
                  <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                    {en ? `📰 News Pool (${pool.length} articles)` : `📰 今日新聞池 (${pool.length} 篇)`}
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
                  "Reuters": "Tossup", "Associated Press": "Tossup", "The Hill": "Tossup",
                  "The New York Times": "Lean Dem", "CNN": "Lean Dem", "NPR": "Lean Dem", "The Washington Post": "Lean Dem",
                  "Fox News": "Lean Rep", "The Wall Street Journal": "Lean Rep", "New York Post": "Lean Rep",
                  "MSNBC": "Solid Dem", "Breitbart": "Solid Rep",
                };
                const leaningColor: Record<string, string> = {
                  "Solid Dem": "#2563eb", "Lean Dem": "#60a5fa", "Tossup": "#a855f7",
                  "Lean Rep": "#f87171", "Solid Rep": "#dc2626",
                };
                const leaningEmoji: Record<string, string> = {
                  "Solid Dem": "🔵", "Lean Dem": "🟦", "Tossup": "🟣",
                  "Lean Rep": "🟥", "Solid Rep": "🔴",
                };
                const leaningBadge = (src: string) => {
                  const l = sourceLeanings[src] || "Tossup";
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
                const spectrum = ["Solid Dem", "Lean Dem", "Tossup", "Lean Rep", "Solid Rep"];
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
                        {en ? "📺 Media Habit → News Source Mapping" : "📺 媒體習慣 → 新聞來源對應"}
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
                        {en ? "🏛️ News Source Political Spectrum" : "🏛️ 新聞來源政治光譜"}
                      </h3>
                      <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
                        {en ? "An agent's political leaning (Dem/Rep) influences which news sources they see more often. Sources with a similar lean get higher feed priority." : "Agent 的政治傾向會影響他們更常看到哪些來源的新聞。相近立場的來源會獲得更高的推播優先權。"}
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
                          {en ? "Serendipity rate" : "破圈機率"}: <strong>{(dietRules.serendipity_rate * 100).toFixed(0)}%</strong>
                        </div>
                        <div style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-secondary)" }}>
                          {en ? "Articles per agent/day" : "每人每日推播"}: <strong>{dietRules.articles_per_agent}</strong>
                        </div>
                      </div>

                      {/* ── 媒體立場影響力 slider ── */}
                      <div style={{ padding: "16px 20px", backgroundColor: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                          <span style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>
                            {en ? "📺 Media Bias Influence" : "📺 媒體立場影響力"}
                          </span>
                          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                            <span style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "#60a5fa" }}>
                              {en ? "Channel match" : "管道匹配"} {((1.0 - (dietRules.leaning_weight || 0)) * 100).toFixed(0)}%
                            </span>
                            <span style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "#fb923c" }}>
                              {en ? "Political lean" : "政治傾向"} {((dietRules.leaning_weight || 0) * 100).toFixed(0)}%
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
                          <span style={{ fontFamily: "var(--font-cjk)", fontSize: 10, color: "#94a3b8" }}>{en ? "Off (ignore media bias)" : "關（不考慮媒體立場）"}</span>
                          <span style={{ fontFamily: "var(--font-cjk)", fontSize: 10, color: "#94a3b8" }}>{en ? "Strong (bias matters)" : "強（立場影響大）"}</span>
                        </div>
                        <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
                          {en
                            ? "Agents with a Dem/Rep lean will see more news from sources with a similar bias. E.g. a 'Lean Dem' agent sees more CNN, NPR content."
                            : "偏左/偏右的 Agent 會優先看到立場相近的新聞。例如：傾向民主黨的 Agent 會更常看到 CNN、NPR 的內容。"}
                        </p>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* ──────── Sub-tab: 記憶探索 ──────── */}
          {activeTab === "memory" && (
            <div>
              <h2 style={{ fontFamily: "var(--font-sans)", fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 20 }}>
                {en ? "🧠 Memory Explorer — Agent Diaries & RAG Search" : "🧠 記憶探索 — Agent 日記與 RAG 搜尋"}
              </h2>

              {/* Agent selector */}
              <div style={cardStyle}>
                <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 12 }}>
                  {en ? `Select Agent (${personas.length} total)` : `選擇 Agent（共 ${personas.length} 位）`}
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
                    <option value="">{en ? "— Select an Agent —" : "— 請選擇 Agent —"}</option>
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
                          <span style={{ fontSize: 9, opacity: 0.7, color: p.political_leaning?.includes("Dem") ? "#3b82f6" : p.political_leaning?.includes("Rep") ? "#ef4444" : "#94a3b8" }}>
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
                    {en ? `Current State — Agent #${selectedAgentId}` : `當前狀態 — Agent #${selectedAgentId}`}
                  </h3>
                  <div style={{ display: "flex", gap: 24, fontFamily: "var(--font-sans)", fontSize: 13, flexWrap: "wrap" }}>
                    <span style={{ color: "#4ade80" }}>{en ? "Satisfaction: " : "滿意度: "}<strong>{agentStats.satisfaction}</strong></span>
                    <span style={{ color: "#f87171" }}>{en ? "Anxiety: " : "焦慮度: "}<strong>{agentStats.anxiety}</strong></span>
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
                          <div style={{ marginTop: 4, fontSize: 12, fontFamily: "var(--font-cjk)", color: ap.political_leaning?.includes("Dem") ? "#3b82f6" : ap.political_leaning?.includes("Rep") ? "#ef4444" : "#94a3b8" }}>
                            🏛️ {en ? "Leaning" : "政治傾向"}: {ap.political_leaning}
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
                  {en ? "🔍 RAG Memory Search" : "🔍 RAG 記憶搜尋"}
                </h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    placeholder={en ? "Search keywords (e.g. inflation economy housing)" : "搜尋關鍵字 (例如: 電價 物價 房租)"}
                    value={memSearchQuery}
                    onChange={e => setMemSearchQuery(e.target.value)}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button onClick={handleMemSearch} disabled={!selectedAgentId} style={btnStyle}>{en ? "Search Memory" : "搜尋記憶"}</button>
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
