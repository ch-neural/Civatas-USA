"use client";

import { useState, useMemo } from "react";
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

const TT: React.CSSProperties = { background: "#1e1e2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11, fontFamily: "var(--font-cjk)" };
const PIE_COLORS = ["#8b5cf6", "#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#a3e635"];
const LEAN_COLORS: Record<string, string> = { "偏左派": "#22c55e", "偏綠": "#22c55e", "中立": "#94a3b8", "偏右派": "#3b82f6", "偏藍": "#3b82f6" };

type SubTab = "overview" | "analysis" | "glossary" | "tech" | "voting";

interface Props {
  recording: any;
  steps: any[];
}

export default function PlaybackGuide({ recording, steps }: Props) {
  const isPrediction = recording?.type === "prediction";
  const [subTab, setSubTab] = useState<SubTab>("overview");

  const firstStep = steps[0] || {};
  const lastStep = steps[steps.length - 1] || {};
  const allAgents = firstStep.agents || [];

  // Demographics
  const demo = useMemo(() => {
    const districtMap: Record<string, number> = {};
    const leanMap: Record<string, number> = {};
    const occMap: Record<string, number> = {};
    const genderMap: Record<string, number> = {};
    const ageGroups: Record<string, number> = { "20-29": 0, "30-39": 0, "40-49": 0, "50-59": 0, "60-69": 0, "70+": 0 };
    const eduMap: Record<string, number> = {};

    for (const a of allAgents) {
      districtMap[a.district || "未知"] = (districtMap[a.district || "未知"] || 0) + 1;
      leanMap[a.political_leaning || "中立"] = (leanMap[a.political_leaning || "中立"] || 0) + 1;
      if (a.occupation) occMap[a.occupation] = (occMap[a.occupation] || 0) + 1;
      if (a.gender) genderMap[a.gender] = (genderMap[a.gender] || 0) + 1;
      if (a.education) eduMap[a.education] = (eduMap[a.education] || 0) + 1;
      const age = parseInt(a.age);
      if (age >= 70) ageGroups["70+"]++;
      else if (age >= 60) ageGroups["60-69"]++;
      else if (age >= 50) ageGroups["50-59"]++;
      else if (age >= 40) ageGroups["40-49"]++;
      else if (age >= 30) ageGroups["30-39"]++;
      else if (age >= 20) ageGroups["20-29"]++;
    }
    return { districtMap, leanMap, occMap, genderMap, ageGroups, eduMap };
  }, [allAgents]);

  // Trend summary
  const trendSummary = useMemo(() => {
    return steps.map((s, i) => ({
      day: s.day || i + 1,
      local: s.aggregate?.avg_local_satisfaction ?? 50,
      national: s.aggregate?.avg_national_satisfaction ?? 50,
      anxiety: s.aggregate?.avg_anxiety ?? 50,
    }));
  }, [steps]);

  const TABS: { key: SubTab; label: string }[] = [
    { key: "overview", label: "模擬概況" },
    { key: "analysis", label: "過程解析" },
    ...(isPrediction ? [{ key: "voting" as SubTab, label: "投票預測方法" }] : []),
    { key: "glossary", label: "名詞解釋" },
    { key: "tech", label: "技術說明" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setSubTab(t.key)}
            style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: subTab === t.key ? 700 : 400, border: "none", cursor: "pointer", transition: "all 0.15s",
              background: subTab === t.key ? "rgba(108,92,231,0.2)" : "rgba(255,255,255,0.03)",
              color: subTab === t.key ? "#A29BFE" : "rgba(255,255,255,0.5)" }}>
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "overview" && <OverviewSub recording={recording} steps={steps} allAgents={allAgents} demo={demo} />}
      {subTab === "analysis" && <AnalysisSub steps={steps} trendSummary={trendSummary} firstStep={firstStep} lastStep={lastStep} demo={demo} />}
      {subTab === "voting" && <VotingSub steps={steps} />}
      {subTab === "glossary" && <GlossarySub />}
      {subTab === "tech" && <TechSub />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Sub-tab: 模擬概況                                                   */
/* ═══════════════════════════════════════════════════════════════════ */
function OverviewSub({ recording, steps, allAgents, demo }: { recording: any; steps: any[]; allAgents: any[]; demo: any }) {
  const districtData = Object.entries(demo.districtMap).sort(([, a]: any, [, b]: any) => b - a).map(([name, count]) => ({ name, count }));
  const leanData = Object.entries(demo.leanMap).map(([name, count]) => ({ name, value: count }));
  const occData = Object.entries(demo.occMap).sort(([, a]: any, [, b]: any) => b - a).slice(0, 10).map(([name, count]) => ({ name, count }));
  const ageData = Object.entries(demo.ageGroups).filter(([, v]) => (v as number) > 0).map(([name, count]) => ({ name, count }));
  const genderData = Object.entries(demo.genderMap).map(([name, count]) => ({ name, value: count }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Title */}
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: "#fff", margin: 0 }}>{recording.title}</h2>
        {recording.description && <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", margin: "6px 0 0" }}>{recording.description}</p>}
      </div>

      {/* Key params */}
      <Card title="模擬參數">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <ParamChip label="模擬天數" value={`${steps.length} 天`} />
          <ParamChip label="Agent 總數" value={`${allAgents.length} 人`} />
          <ParamChip label="涵蓋行政區" value={`${Object.keys(demo.districtMap).length} 區`} />
          <ParamChip label="類型" value={recording.type === "prediction" ? "民調預測" : "歷史演化"} />
          {recording.scenarios?.length > 0 && <ParamChip label="情境數" value={`${recording.scenarios.length} 個`} />}
        </div>
        <Prose>
          本次模擬包含 <B>{allAgents.length}</B> 位虛擬居民（Agents），分佈在 <B>{Object.keys(demo.districtMap).length}</B> 個行政區。
          系統透過 LLM（大型語言模型）為每位 Agent 生成每日的「生活日記」，模擬他們閱讀新聞、思考時事、
          與鄰居互動後的心理狀態變化，持續 <B>{steps.length}</B> 天。
        </Prose>
      </Card>

      {/* Demographics charts */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {/* District distribution */}
        <Card title="各區人口分佈" style={{ flex: "1 1 400px" }}>
          <ResponsiveContainer width="100%" height={Math.max(160, districtData.length * 20 + 30)}>
            <BarChart data={districtData} layout="vertical" margin={{ left: 55, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis type="number" tick={{ fontSize: 9, fill: "#6b7280" }} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#d1d5db" }} width={50} />
              <Tooltip contentStyle={TT} />
              <Bar dataKey="count" name="人數" fill="#8b5cf6" barSize={10} radius={[0, 4, 4, 0]}>
                {districtData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} opacity={0.8} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Leaning + Gender pie */}
        <div style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="政治傾向分佈">
            <ResponsiveContainer width="100%" height={140}>
              <PieChart>
                <Pie data={leanData} cx="50%" cy="50%" outerRadius={55} dataKey="value"
                  label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} style={{ fontSize: 10 }}>
                  {leanData.map((d, i) => <Cell key={i} fill={LEAN_COLORS[d.name] || PIE_COLORS[i]} />)}
                </Pie>
                <Tooltip contentStyle={TT} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
          <Card title="性別分佈">
            <ResponsiveContainer width="100%" height={120}>
              <PieChart>
                <Pie data={genderData} cx="50%" cy="50%" outerRadius={45} dataKey="value"
                  label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} style={{ fontSize: 10 }}>
                  {genderData.map((_, i) => <Cell key={i} fill={["#3b82f6", "#ec4899", "#94a3b8"][i]} />)}
                </Pie>
                <Tooltip contentStyle={TT} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </div>
      </div>

      {/* Age + Occupation */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <Card title="年齡分佈" style={{ flex: "1 1 300px" }}>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={ageData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#6b7280" }} />
              <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} />
              <Tooltip contentStyle={TT} />
              <Bar dataKey="count" name="人數" fill="#14b8a6" barSize={24} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="職業分佈 (Top 10)" style={{ flex: "1 1 350px" }}>
          <ResponsiveContainer width="100%" height={Math.max(120, occData.length * 22 + 20)}>
            <BarChart data={occData} layout="vertical" margin={{ left: 60, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis type="number" tick={{ fontSize: 9, fill: "#6b7280" }} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#d1d5db" }} width={55} />
              <Tooltip contentStyle={TT} />
              <Bar dataKey="count" name="人數" fill="#f59e0b" barSize={10} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Sub-tab: 過程解析                                                   */
/* ═══════════════════════════════════════════════════════════════════ */
function AnalysisSub({ steps, trendSummary, firstStep, lastStep, demo }: { steps: any[]; trendSummary: any[]; firstStep: any; lastStep: any; demo: any }) {
  const fa = firstStep.aggregate || {};
  const la = lastStep.aggregate || {};

  const delta = (field: string) => {
    const start = fa[field] ?? 50;
    const end = la[field] ?? 50;
    const d = Math.round(end - start);
    return { start: Math.round(start), end: Math.round(end), delta: d, arrow: d > 0 ? "↑" : d < 0 ? "↓" : "→", color: field === "avg_anxiety" ? (d > 0 ? "#ef4444" : "#22c55e") : (d > 0 ? "#22c55e" : "#ef4444") };
  };

  const localD = delta("avg_local_satisfaction");
  const nationalD = delta("avg_national_satisfaction");
  const anxietyD = delta("avg_anxiety");

  // Leaning shift
  const firstLean = firstStep.leanings || {};
  const lastLean = lastStep.leanings || {};

  // Most volatile districts
  const distVolatility = useMemo(() => {
    const map: Record<string, number[]> = {};
    for (const s of steps) {
      for (const [name, data] of Object.entries(s.districts || {}) as any) {
        if (!map[name]) map[name] = [];
        map[name].push(data.avg_local_satisfaction);
      }
    }
    return Object.entries(map)
      .map(([name, vals]) => ({ name, range: Math.round(Math.max(...vals) - Math.min(...vals)), latest: Math.round(vals[vals.length - 1]) }))
      .sort((a, b) => b.range - a.range)
      .slice(0, 5);
  }, [steps]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Overall trend */}
      <Card title="整體趨勢變化">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={trendSummary} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#6b7280" }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#6b7280" }} />
            <Tooltip contentStyle={TT} />
            <Legend wrapperStyle={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }} />
            <Line type="monotone" dataKey="local" name="地方滿意度" stroke="#3b82f6" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="national" name="中央滿意度" stroke="#f97316" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="anxiety" name="焦慮度" stroke="#ef4444" strokeWidth={2} strokeDasharray="4 4" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Key findings */}
      <Card title="關鍵發現">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
          <DeltaCard label="地方滿意度" start={localD.start} end={localD.end} delta={localD.delta} color={localD.color} />
          <DeltaCard label="中央滿意度" start={nationalD.start} end={nationalD.end} delta={nationalD.delta} color={nationalD.color} />
          <DeltaCard label="焦慮度" start={anxietyD.start} end={anxietyD.end} delta={anxietyD.delta} color={anxietyD.color} />
        </div>
        <Prose>
          在 {steps.length} 天的模擬過程中，Agents 的整體心理狀態出現了顯著變化：
          地方施政滿意度從 {localD.start} {localD.arrow}至 {localD.end}（{localD.delta > 0 ? "+" : ""}{localD.delta}），
          中央施政滿意度從 {nationalD.start} {nationalD.arrow}至 {nationalD.end}（{nationalD.delta > 0 ? "+" : ""}{nationalD.delta}），
          焦慮度從 {anxietyD.start} {anxietyD.arrow}至 {anxietyD.end}（{anxietyD.delta > 0 ? "+" : ""}{anxietyD.delta}）。
          {anxietyD.delta > 15 ? " 焦慮度大幅上升，顯示模擬期間的新聞事件對居民造成了相當的心理壓力。" : ""}
          {localD.delta < -10 ? " 地方施政滿意度明顯下降，可能與交通、空汙、建設等地方議題相關。" : ""}
        </Prose>
      </Card>

      {/* Leaning shift */}
      <Card title="政治傾向變遷">
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 12 }}>
          {Object.keys({ ...firstLean, ...lastLean }).map((k) => {
            const fc = (firstLean[k] as any)?.count || 0;
            const lc = (lastLean[k] as any)?.count || 0;
            const d = lc - fc;
            return (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: LEAN_COLORS[k] || "#94a3b8" }} />
                <span style={{ fontSize: 12, color: "#e5e7eb" }}>{k}</span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>{fc} → {lc}</span>
                {d !== 0 && <span style={{ fontSize: 10, fontWeight: 700, color: d > 0 ? "#22c55e" : "#ef4444" }}>{d > 0 ? "+" : ""}{d}</span>}
              </div>
            );
          })}
        </div>
        <Prose>
          部分 Agents 在模擬過程中改變了政治傾向。這反映了新聞事件和社群互動對個人立場的影響。
          在現實中，選民的立場通常相對穩定，但重大事件（如醜聞、危機）可能使部分選民重新評估自己的立場。
        </Prose>
      </Card>

      {/* Volatile districts */}
      {distVolatility.length > 0 && (
        <Card title="波動最大的行政區">
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {distVolatility.map((d) => (
              <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 55, fontSize: 11, color: "#e5e7eb", fontWeight: 600 }}>{d.name}</span>
                <div style={{ flex: 1, height: 8, borderRadius: 4, background: "rgba(255,255,255,0.05)", position: "relative", overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 4, background: `linear-gradient(90deg, #3b82f6, ${d.range > 20 ? "#ef4444" : "#f59e0b"})`, width: `${Math.min(100, d.range * 2)}%`, transition: "width 0.5s" }} />
                </div>
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", width: 60 }}>波幅 {d.range}</span>
                <span style={{ fontSize: 10, color: d.latest >= 50 ? "#4ade80" : "#f87171", width: 50 }}>現值 {d.latest}</span>
              </div>
            ))}
          </div>
          <Prose>
            波動幅度越大的行政區，代表該區居民對新聞事件的反應更為劇烈，是選戰中需要重點關注的「搖擺區」。
          </Prose>
        </Card>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Sub-tab: 名詞解釋                                                   */
/* ═══════════════════════════════════════════════════════════════════ */
function GlossarySub() {
  const terms: { title: string; desc: string; factors: string; impact: string }[] = [
    {
      title: "地方滿意度 (Local Satisfaction)",
      desc: "衡量 Agent 對所在縣市首長施政的滿意程度，範圍 0-100。反映的是市長/縣長層級的施政表現，例如交通建設、空氣品質、社會住宅、治安等地方議題。",
      factors: "地方基礎建設進展、交通改善或惡化、空汙程度、社會住宅政策、地方補助措施、社區活動品質、地方首長相關新聞。",
      impact: "直接影響 Agent 對地方候選人的支持度。滿意度高的選民傾向支持現任政黨的候選人；低滿意度則傾向支持挑戰者。",
    },
    {
      title: "中央滿意度 (National Satisfaction)",
      desc: "衡量 Agent 對總統/行政院施政的滿意程度，範圍 0-100。反映的是中央層級的政策表現，例如兩岸關係、外交、經濟政策、國防等全國性議題。",
      factors: "兩岸關係緊張或緩和、國際外交事件、中央經濟政策（物價、電價、薪資）、國防安全議題、重大政治醜聞。",
      impact: "影響 Agent 對執政黨或在野黨的整體好感度。中央滿意度與地方滿意度是獨立的，一個選民可能對市長滿意但對中央不滿。",
    },
    {
      title: "焦慮度 (Anxiety)",
      desc: "衡量 Agent 的不安與壓力程度，範圍 0-100。反映的是經濟壓力、安全感、對未來的擔憂。高焦慮的選民更容易改變立場，也更容易被激烈言論影響。",
      factors: "物價上漲、失業或工作不穩定、房價壓力、健康問題、家庭變故（生活事件系統）、戰爭或衝突相關新聞、經濟危機報導。",
      impact: "焦慮度高的 Agent 投票行為更不穩定，更容易從支持現任轉為支持挑戰者。焦慮也會放大其他因素的影響力，形成「恐慌性投票」。",
    },
    {
      title: "新聞相關性 (News Relevance)",
      desc: "衡量當天新聞對 Agent 的影響程度，分為 high / medium / low / none。系統根據 Agent 的個人背景（年齡、職業、收入、政治傾向）自動判斷每則新聞對該 Agent 的相關性。",
      factors: "新聞主題與 Agent 職業/生活的關聯度、Agent 的政治傾向與新聞立場的契合度、Agent 的媒體使用習慣。",
      impact: "高相關性的新聞會讓 Agent 的滿意度和焦慮度產生更大變化；低相關性的新聞則幾乎不影響。這模擬了「資訊同溫層」效應。",
    },
    {
      title: "政治傾向 (Political Leaning)",
      desc: "Agent 的政治立場標籤，通常分為偏左派（綠營）、中立、偏右派（藍營）。這不是固定的——在模擬過程中，Agent 可能因新聞事件或社群互動而改變傾向。",
      factors: "長期：家庭背景、教育程度、居住地區。短期：重大政治事件、候選人表現、社群討論影響。",
      impact: "直接決定 Agent 的候選人偏好。偏左派傾向支持綠營候選人，偏右派傾向支持藍營，中立選民則是各方爭取的關鍵。",
    },
    {
      title: "生活事件 (Life Events)",
      desc: "系統隨機觸發的個人大事件，如加薪、失業、生病、結婚、退休等。這些事件對 Agent 的影響通常比新聞更大，模擬現實中「個人經歷勝過新聞報導」的心理現象。",
      factors: "完全隨機觸發，但發生機率根據 Agent 的年齡、職業、收入等人口統計特徵加權。例如，年輕人更容易觸發求職相關事件。",
      impact: "生活事件會直接且大幅度地改變滿意度和焦慮度。例如失業會導致焦慮劇增、對施政不滿；加薪則相反。日記中會詳細描述事件的影響。",
    },
    {
      title: "職業分類 (Occupation)",
      desc: "Agent 的職業來自人口普查資料。原始資料中「無工作」比例偏高（約 43%），因為涵蓋了退休、家管、學生等。系統會自動將「無工作」拆分為更精確的子類別，以提升模擬的真實性。",
      factors: "退休（65 歲以上）、學生（15-24 歲在學）、家管（25-64 歲女性，約 60%）、打工族（15-19 歲）、待業（其餘）。分類依據年齡、性別、教育程度自動判定。",
      impact: "不同職業對新聞的反應差異極大。退休者關心醫療健保和年金；家管關心物價和教育；待業者對就業市場和經濟政策敏感；學生對居住正義和未來發展焦慮。職業直接影響 Agent 對特定新聞的反應強度。",
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Prose>
        以下是本模擬系統中的核心概念解釋。理解這些指標有助於解讀演化過程中的數據變化，以及最終預測結果的意義。
      </Prose>
      {terms.map((t) => (
        <div key={t.title} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: "#A29BFE", margin: "0 0 8px" }}>{t.title}</h3>
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", lineHeight: 1.8, margin: "0 0 10px" }}>{t.desc}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
              <span style={{ color: "#f59e0b", fontWeight: 600 }}>影響因素：</span>{t.factors}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
              <span style={{ color: "#22c55e", fontWeight: 600 }}>對投票的影響：</span>{t.impact}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Sub-tab: 投票預測方法（僅預測模式）                                    */
/* ═══════════════════════════════════════════════════════════════════ */
const CANDIDATE_TRAITS: Record<string, { loc: number; nat: number; anx: number; charm: number; cross: number; note: string }> = {
  "楊瓊瓔": { loc: 0.55, nat: 0.05, anx: 0.10, charm: 0.20, cross: 0.05, note: "極度地方型，副市長+立委深耕基層" },
  "江啟臣": { loc: 0.10, nat: 0.70, anx: 0.30, charm: 0.80, cross: 0.75, note: "全國型，前黨主席+副院長，高跨黨吸引力" },
  "何欣純": { loc: 0.45, nat: 0.20, anx: 0.15, charm: 0.45, cross: 0.25, note: "區域型，四屆連任立委" },
  "蔡其昌": { loc: 0.20, nat: 0.50, anx: 0.20, charm: 0.45, cross: 0.35, note: "全國型，前副院長" },
  "盧秀燕": { loc: 0.50, nat: 0.30, anx: 0.30, charm: 0.65, cross: 0.30, note: "現任市長，施政評價高" },
  "林佳龍": { loc: 0.35, nat: 0.45, anx: 0.25, charm: 0.50, cross: 0.30, note: "前市長、交通部長" },
};

function VotingSub({ steps }: { steps: any[] }) {
  // Extract actual candidates from step data
  const actualCandidates = useMemo(() => {
    const names = new Set<string>();
    for (const s of steps) {
      const ce = s.day_record?.candidate_estimate || {};
      for (const k of Object.keys(ce)) {
        if (k !== "不表態") names.add(k);
      }
    }
    return Array.from(names);
  }, [steps]);

  // Filter traits table to only show actual candidates
  const traitsToShow = actualCandidates
    .map((name) => ({ name, ...(CANDIDATE_TRAITS[name] || { loc: 0.3, nat: 0.2, anx: 0.15, charm: 0.35, cross: 0.20, note: "" }) }))
    .filter((c) => c.name);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Prose>
        以下詳細說明本系統如何從每位 Agent 的心理狀態推算出候選人支持率。系統提供兩種預測路徑，可依需求選用。
      </Prose>

      <Section title="一、初選雙軌民調法（適用於黨內初選）">
        <Prose>
          模擬國民黨初選的實際規則，系統對每位虛擬市民進行兩道 LLM 電話民調：
        </Prose>
        <div style={{ background: "rgba(108,92,231,0.08)", borderRadius: 8, padding: 14, margin: "8px 0" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#A29BFE", marginBottom: 6 }}>題目一：政黨對比式（權重 85%）</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", fontStyle: "italic" }}>
            「如果國民黨提名 A 候選人，民進黨提名 B 候選人，你會支持誰？」
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>
            測試候選人在大選中的勝選能力。權重較高，因為初選的核心目的是推出最有勝算的人。
          </div>
        </div>
        <div style={{ background: "rgba(0,184,148,0.08)", borderRadius: 8, padding: 14, margin: "8px 0" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#00B894", marginBottom: 6 }}>題目二：黨內互比式（權重 15%）</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", fontStyle: "italic" }}>
            「在國民黨的 A 候選人和 C 候選人之間，你支持誰？」
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>
            測試黨內支持者的偏好。權重較低，但反映了黨內基礎的團結度。
          </div>
        </div>
        <div style={{ background: "rgba(245,158,11,0.08)", borderRadius: 8, padding: 14, margin: "8px 0" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#f59e0b", marginBottom: 6 }}>最終計算</div>
          <div style={{ fontSize: 13, color: "#e5e7eb", fontFamily: "monospace" }}>最終成績 = 對比式得票率 × 0.85 + 互比式得票率 × 0.15</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>
            例：候選人對比式 55%、互比式 60% → 最終 = 55%×0.85 + 60%×0.15 = 55.75%
          </div>
        </div>
      </Section>

      <Section title="二、每日啟發式評分法（適用於多情境預測）">
        <Prose>
          在「民調預測」模式中，系統每天根據所有 Agent 的心理狀態，為每位候選人計算一個支持度分數。計算分為 14 個步驟，最終產出支持率百分比。
        </Prose>

        <Step n={1} title="基礎分" desc="主要政黨候選人起始 50 分、小黨 30 分、無黨籍 5 分。這反映了台灣政治中政黨品牌的基本效應。" />
        <Step n={2} title="黨派對齊" desc="Agent 的政治傾向與候選人政黨匹配時加分（預設 +15）。但在同黨初選中，此加分歸零——因為都是同黨，黨籍無法區分候選人。" />
        <Step n={3} title="現任優勢" desc="現任市長/縣長 +12 分、立委 +2.4 分。反映現任者的知名度和資源優勢。" />
        <Step n={4} title="專業優勢" desc="每位候選人有地方型（loc）、全國型（nat）的專長分數。地方型候選人在地方議題突出時得分更高，全國型候選人在全國議題突出時得分更高。" />
        <Step n={5} title="滿意度映射" desc="Agent 對地方施政較滿意 → 有利地方型候選人；對中央施政不滿 → 有利全國型候選人。系統會根據候選人的 loc/nat 權重分配分數。" />
        <Step n={6} title="焦慮敏感度" desc="高焦慮（>55）的 Agent 偏好焦慮敏感度高的候選人。例如，以改革為號召的候選人在高焦慮環境中更有優勢。" />
        <Step n={7} title="知名度加分" desc="描述中包含「市長」「黨主席」「院長」等關鍵字可獲額外加分（上限 10 分）。" />
        <Step n={8} title="基層加分" desc="描述中包含「地方實力」「樁腳」「基層服務」等關鍵字可獲加分（上限 8 分）。" />
        <Step n={9} title="個人魅力" desc="以非線性公式計算：charm^1.3 × 8。魅力值來自民調資料（好感度、能力認同）。高魅力候選人獲得大幅加分，低魅力者幾乎無加分。" />
        <Step n={10} title="跨黨吸引力" desc="對中立選民：跨黨吸引力高的候選人大幅加分。對同黨選民：跨黨吸引力低的候選人會有「基盤鬆動懲罰」。這模擬了像江啟臣能吸引 18% 淺綠選民的現象。" />
        <Step n={11} title="施政差值加權" desc="根據候選人的地方/全國權重，將 Agent 的滿意度差值轉換為分數。國民黨候選人在地方滿意度高時得分，民進黨候選人在中央滿意度高時得分。" />
        <Step n={12} title="認知度懲罰" desc="知名度低的候選人會被打折：得分 × (0.3 + 0.7 × 認知度)。完全不認識的候選人只能拿到 30% 的分數。" />
        <Step n={13} title="在地加分" desc="Agent 所在行政區與候選人出身地相同時 +8 分，模擬「在地子弟」效應。" />
        <Step n={14} title="未決率計算" desc="分數接近的競爭 + 同黨初選 + 兩方都不滿意的選民，會提高「不表態」比例。最終支持率 = 正規化分數 × (1 - 未決率)。" />
      </Section>

      <Section title="三、候選人特質系統">
        <Prose>
          每位候選人在系統中有一組基於真實民調資料校準的特質分數：
        </Prose>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                {["候選人", "地方型 (loc)", "全國型 (nat)", "焦慮敏感 (anx)", "魅力 (charm)", "跨黨 (cross)"].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: "rgba(255,255,255,0.5)", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {traitsToShow.map((c) => (
                <tr key={c.name} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "8px 10px", color: "#e5e7eb", fontWeight: 600 }}>{c.name}</td>
                  <td style={{ padding: "8px 10px", color: "#3b82f6" }}>{c.loc}</td>
                  <td style={{ padding: "8px 10px", color: "#f97316" }}>{c.nat}</td>
                  <td style={{ padding: "8px 10px", color: "#ef4444" }}>{c.anx}</td>
                  <td style={{ padding: "8px 10px", color: "#a78bfa" }}>{c.charm}</td>
                  <td style={{ padding: "8px 10px", color: "#22c55e" }}>{c.cross}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Prose>
          <B>loc（地方型）</B>：對地方議題（交通、空汙、建設）的敏感度。數值越高，Agent 的地方滿意度對該候選人得分影響越大。<br />
          <B>nat（全國型）</B>：對全國議題（兩岸、經濟政策）的敏感度。數值越高，中央施政相關新聞對該候選人影響越大。<br />
          <B>charm（魅力）</B>：基於民調好感度和能力認同的綜合評分。以非線性公式 charm^1.3 × 8 計算加分。<br />
          <B>cross（跨黨）</B>：吸引對手陣營選民的能力。數值越高，在中立和淺對立選民中越有優勢。
        </Prose>
        {traitsToShow.some((c) => c.note) && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            {traitsToShow.filter((c) => c.note).map((c) => (
              <div key={c.name} style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
                <span style={{ color: "#e5e7eb", fontWeight: 600 }}>{c.name}</span>：{c.note}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="四、同黨初選 vs. 大選的差異">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                {["項目", "大選模式", "同黨初選模式"].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: "rgba(255,255,255,0.5)", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ["黨派對齊加分", "依傾向加 15 分", "歸零（同黨無法區分）"],
                ["跨黨懲罰", "異黨選民受懲罰", "不適用"],
                ["區分因素", "政黨 + 個人特質", "純看個人特質 + 滿意度映射"],
                ["未決率", "較低（黨派忠誠）", "較高（同黨難選擇）"],
                ["民調題目", "單一問題", "雙軌（對比 85% + 互比 15%）"],
              ].map(([item, general, primary], i) => (
                <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "8px 10px", color: "#e5e7eb", fontWeight: 600 }}>{item}</td>
                  <td style={{ padding: "8px 10px", color: "rgba(255,255,255,0.6)" }}>{general}</td>
                  <td style={{ padding: "8px 10px", color: "rgba(255,255,255,0.6)" }}>{primary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="五、情境與組別功能">
        <Prose>
          <B>情境 (Scenarios)</B>：每個情境代表一組「假設性新聞事件」。例如：
        </Prose>
        <ul style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 2, paddingLeft: 20 }}>
          <li>情境 A：「候選人 X 爆發弊案」— 注入負面新聞，觀察支持率變化</li>
          <li>情境 B：「政府宣布大型建設計畫」— 注入正面新聞，觀察滿意度變化</li>
          <li>情境 C：「兩岸衝突升溫」— 注入緊張局勢新聞，觀察焦慮度和投票轉向</li>
        </ul>
        <Prose>
          每個情境獨立執行：還原快照 → 注入情境新聞 → 演化 N 天 → 收集結果。最後比較各情境的差異，了解「哪種事件對選情影響最大」。
        </Prose>
        <Prose>
          <B>候選人組別 (Poll Groups)</B>：可設定多組候選人，每組獨立計算支持率。適用於：
        </Prose>
        <ul style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 2, paddingLeft: 20 }}>
          <li><B>黨內初選</B>：同組內全為國民黨候選人，系統自動啟用初選模式</li>
          <li><B>多席次選舉</B>：不同選區的候選人分成不同組</li>
          <li><B>加權組合</B>：可設定每組的權重，例如「電話民調 30% + 網路民調 30% + 黨員投票 40%」</li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 16 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: "#A29BFE", margin: "0 0 12px" }}>{title}</h3>
      {children}
    </div>
  );
}

function Step({ n, title, desc }: { n: number; title: string; desc: string }) {
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
      <div style={{ width: 24, height: 24, borderRadius: "50%", background: "rgba(108,92,231,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 10, fontWeight: 700, color: "#A29BFE" }}>{n}</div>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#e5e7eb" }}>{title}</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.7 }}>{desc}</div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Sub-tab: 技術說明                                                   */
/* ═══════════════════════════════════════════════════════════════════ */
function TechSub() {
  const sections: { title: string; content: React.ReactNode }[] = [
    {
      title: "Agent 人設與行為模型",
      content: <>
        <Prose>
          每位 Agent 擁有完整的人口統計屬性（年齡、性別、行政區、教育程度、職業、收入、婚姻狀態）以及性格特質（表達意願、情緒穩定度、社交傾向、資訊接受度）。這些屬性共同決定了 Agent 對新聞的反應方式和程度。
        </Prose>
        <Prose>
          <B>日記生成機制</B>：每天，系統將 Agent 的完整人設、當前心理狀態、個人化新聞 feed、生活事件、社群動態打包成一個精心設計的 prompt，送入 LLM（GPT-4o、DeepSeek、xAI 等）。LLM 以該 Agent 的第一人稱視角撰寫一篇私人日記，同時產出更新後的滿意度和焦慮度數值。
        </Prose>
        <Prose>
          <B>日記與數值一致性</B>：系統要求 LLM 確保日記內容能「解釋」數值的變化。例如，如果焦慮度上升，日記中必須能讀出焦慮的來源。這確保了模擬的可解釋性。
        </Prose>
        <Prose>
          <B>語氣差異化</B>：不同年齡層的 Agent 使用不同的語氣和用語。20 多歲用網路用語、50-60 歲偏正式並混合台語、65 歲以上用傳統口吻。媒體習慣也會影響語氣（PTT 使用者 vs LINE 群組使用者 vs 電視新聞觀眾）。
        </Prose>
      </>,
    },
    {
      title: "新聞池與個人化 Feed",
      content: <>
        <Prose>
          <B>新聞搜尋</B>：系統使用 Serper API（Google 搜尋引擎）根據設定的關鍵字（地方議題 + 全國議題）自動搜尋真實新聞。搜尋結果經過「影響力評分」篩選（由 LLM 評估每則新聞對該地區居民的社會影響力），只保留評分 ≥ 3 的新聞。
        </Prose>
        <Prose>
          <B>個人化分配</B>：每位 Agent 不會看到所有新聞，而是根據以下因素收到一份個人化的新聞 feed：
        </Prose>
        <ul style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 2, paddingLeft: 20 }}>
          <li><B>政治傾向權重</B>：偏左派 Agent 更容易看到綠營媒體的報導，偏右派則相反，模擬「資訊同溫層」</li>
          <li><B>行政區權重</B>：Agent 優先收到自己所在行政區的地方新聞</li>
          <li><B>時效性權重</B>：較新的新聞優先推送</li>
          <li><B>隨機性 (Serendipity)</B>：保留一定比例的隨機新聞，模擬「意外發現」的可能</li>
          <li><B>閱讀歷史</B>：已讀過的新聞會被降權，避免重複</li>
        </ul>
        <Prose>
          <B>動態週期搜尋</B>：在長期模擬中，系統每隔 N 天重新搜尋一次新聞，並由 AI 根據上一週期的演化結果自動調整搜尋關鍵字，確保新聞池持續反映最新的社會動態。
        </Prose>
      </>,
    },
    {
      title: "社群互動機制",
      content: <>
        <Prose>
          <B>鄰里社群動態</B>：高表達慾或高焦慮的 Agent 的日記會被節錄為「社群貼文」，在次日推送給同區域的其他 Agent。這模擬了 LINE 群組、社區聊天中的輿論傳播。
        </Prose>
        <Prose>
          <B>意見極化效應</B>：當 Agent 收到與自己立場相近的社群動態時，會強化原有觀點；收到立場不同的動態時，可能稍微動搖或更加堅定。這模擬了真實社會中的「迴聲室效應」。
        </Prose>
        <Prose>
          <B>KOL 機制</B>：在預測模式中，可開啟 KOL（意見領袖）機制，讓部分 Agent 的意見對更大範圍的 Agent 產生影響。
        </Prose>
      </>,
    },
    {
      title: "投票預測計算方法",
      content: <>
        <Prose>
          <B>啟發式評分法 (Heuristic Scoring)</B>：系統為每位 Agent 對每位候選人計算一個支持度分數，考量以下因素：
        </Prose>
        <ul style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 2, paddingLeft: 20 }}>
          <li><B>政黨基礎分</B>：主要政黨候選人有較高的起始分，無黨籍較低</li>
          <li><B>黨派對齊</B>：Agent 的政治傾向與候選人所屬政黨的匹配度</li>
          <li><B>滿意度映射</B>：地方滿意度高→有利現任陣營；焦慮度高→有利挑戰者</li>
          <li><B>候選人特質</B>：每位候選人有地方/全國知名度、個人魅力、跨黨吸引力等特質權重</li>
          <li><B>認知度懲罰</B>：Agent 不認識的候選人會被降分</li>
        </ul>
        <Prose>
          <B>情境對照</B>：在預測模式中，系統為每個「情境」（不同的假設新聞）分別執行獨立的模擬，最後比較各情境下的預測結果差異。這幫助理解「如果發生 X 事件，選情會如何變化」。
        </Prose>
        <Prose>
          <B>候選人組別</B>：在多席次或初選模擬中，可設定多個候選人組別，每組獨立計算支持率。例如，黨內初選的候選人屬於同一組，與另一黨的候選人分開計算。
        </Prose>
      </>,
    },
    {
      title: "系統架構",
      content: <>
        <Prose>
          Civatas 採用微服務架構，由多個獨立服務協同運作：
        </Prose>
        <ul style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 2, paddingLeft: 20 }}>
          <li><B>API Gateway</B>：統一入口，負責路由和認證</li>
          <li><B>Ingestion Service</B>：解析上傳的人口統計資料（CSV/JSON/Excel）</li>
          <li><B>Synthesis Service</B>：根據人口統計生成合成人口</li>
          <li><B>Persona Service</B>：使用 LLM 為每位 Agent 生成自然語言人設</li>
          <li><B>Evolution Service</B>：核心引擎——每日演化、新聞搜尋、校準、預測</li>
          <li><B>Simulation Service</B>：OASIS 社會互動模擬器</li>
          <li><B>Analytics Service</B>：結果分析和視覺化</li>
        </ul>
        <Prose>
          LLM 支援多供應商同時運作（OpenAI、Google Gemini、xAI Grok、DeepSeek、Moonshot、Ollama），系統自動負載均衡並具備故障自動切換的斷路器機制。
        </Prose>
      </>,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Prose>
        以下介紹 Civatas 社會模擬平台的核心技術原理。了解這些機制有助於評估模擬結果的可信度和適用範圍。
      </Prose>
      {sections.map((s) => (
        <div key={s.title} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: "#A29BFE", margin: "0 0 10px" }}>{s.title}</h3>
          {s.content}
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Shared                                                             */
/* ═══════════════════════════════════════════════════════════════════ */
function Card({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 14, ...style }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function ParamChip({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "6px 12px", borderRadius: 8, background: "rgba(108,92,231,0.1)", border: "1px solid rgba(108,92,231,0.2)" }}>
      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)" }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#A29BFE" }}>{value}</div>
    </div>
  );
}

function DeltaCard({ label, start, end, delta, color }: { label: string; start: number; end: number; delta: number; color: string }) {
  return (
    <div style={{ flex: "1 1 160px", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>{start}</span>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>→</span>
        <span style={{ fontSize: 18, fontWeight: 700, color }}>{end}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color }}>({delta > 0 ? "+" : ""}{delta})</span>
      </div>
    </div>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 1.9, margin: "0 0 6px" }}>{children}</p>;
}

function B({ children }: { children: React.ReactNode }) {
  return <strong style={{ color: "rgba(255,255,255,0.85)", fontWeight: 600 }}>{children}</strong>;
}
