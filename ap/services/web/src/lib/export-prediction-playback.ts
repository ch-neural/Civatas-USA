/**
 * Generate a self-contained HTML playback file for a completed prediction run.
 *
 * Covers:
 *  - Summary cards: agents, sim days, scenarios, leading candidate + share
 *  - Final standings table: rank, candidate, support %, Δ vs day 1, avg sentiment
 *  - Animated time-series: sat/anx, political leaning %, candidate support %,
 *    per-candidate sentiment
 *  - Static charts: final vote share bar, candidate support by leaning /
 *    by gender / by district (top 15)
 *  - Demographics distribution (race, gender, age, income)
 *  - Activity feed (last 60 messages)
 *  - Play / Pause / Replay controls with speed slider
 */

export function generatePredictionPlaybackHTML(data: {
  recording: any;                    // recording meta
  steps: any[];                      // raw playback steps from /recordings/:id/steps
  scenarioResults?: any[];           // final per-scenario results with vote share
  pollGroups?: any[];                // configured poll groups (candidates list)
  templateName?: string;
  locale?: string;
}): string {
  const { recording, steps, scenarioResults, pollGroups, templateName, locale } = data;
  const en = locale !== "zh-TW";

  // ── Derive per-day candidate support from raw steps' candidate_estimate ──
  const dailyTrends: any[] = [];
  const leaningTrends: any[] = [];
  const candidateTrends: any[] = [];
  const liveMessages: string[] = [];
  const demoCounts: Record<string, Record<string, number>> = {
    gender: {}, race: {}, education: {}, age_group: {}, household_income: {},
  };
  const LEAN = (l: string) => ({
    "Solid Dem": "left", "Lean Dem": "left",
    "Tossup": "center",
    "Lean Rep": "right", "Solid Rep": "right",
  } as Record<string, string>)[l] || "center";
  const ageBucket = (age: number) => {
    if (age < 25) return "18-24";
    if (age < 35) return "25-34";
    if (age < 45) return "35-44";
    if (age < 55) return "45-54";
    if (age < 65) return "55-64";
    return "65+";
  };
  // Extract candidate names from pollGroups OR from first candidate_estimate keys
  let candidateNames: string[] = [];
  if (pollGroups?.length) {
    const seen = new Set<string>();
    for (const g of pollGroups) {
      for (const c of (g.candidates || [])) {
        if (c?.name && !seen.has(c.name)) { seen.add(c.name); candidateNames.push(c.name); }
      }
    }
  }

  // Per-candidate awareness/sentiment trend (from step.candidate_awareness_summary)
  const candAwarenessTrends: any[] = [];
  const candSentimentTrends: any[] = [];

  for (const step of steps) {
    const day = step.day || 0;
    const agg = step.aggregate || {};
    const agents = step.agents || [];

    dailyTrends.push({
      day,
      local_satisfaction: Math.round((agg.avg_local_satisfaction ?? 0) * 10) / 10,
      national_satisfaction: Math.round((agg.avg_national_satisfaction ?? 0) * 10) / 10,
      anxiety: Math.round((agg.avg_anxiety ?? 0) * 10) / 10,
    });

    const leanRow: Record<string, number> = { day, left: 0, center: 0, right: 0 };
    for (const a of agents) leanRow[LEAN(a.political_leaning)] = (leanRow[LEAN(a.political_leaning)] || 0) + 1;
    const totalLean = (leanRow.left || 0) + (leanRow.center || 0) + (leanRow.right || 0) || 1;
    leanRow.left = Math.round((leanRow.left / totalLean) * 1000) / 10;
    leanRow.center = Math.round((leanRow.center / totalLean) * 1000) / 10;
    leanRow.right = Math.round((leanRow.right / totalLean) * 1000) / 10;
    leaningTrends.push(leanRow);

    // Per-day candidate awareness + sentiment (prediction step format)
    const cas = (step as any).candidate_awareness_summary || {};
    if (Object.keys(cas).length > 0) {
      const awRow: any = { day };
      const seRow: any = { day };
      for (const cn of Object.keys(cas)) {
        if (!candidateNames.includes(cn)) candidateNames.push(cn);
        const all = cas[cn]?.__all__ || {};
        awRow[`${cn}_awareness`] = Math.round((all.avg_awareness ?? 0) * 1000) / 1000;
        seRow[`${cn}_sentiment`] = Math.round((all.avg_sentiment ?? 0) * 1000) / 1000;
      }
      candAwarenessTrends.push(awRow);
      candSentimentTrends.push(seRow);
    }

    // Per-day candidate vote share (evolution-style if present)
    const cEst = (agg as any).candidate_estimate || (step as any).candidate_estimate || {};
    if (Object.keys(cEst).length) {
      for (const n of Object.keys(cEst)) if (n !== "Undecided" && !candidateNames.includes(n)) candidateNames.push(n);
      const row: any = { day };
      for (const cn of candidateNames) row[`${cn}_support`] = cEst[cn] ?? 0;
      if (cEst.Undecided !== undefined) row["Undecided_support"] = cEst.Undecided;
      candidateTrends.push(row);
    }

    for (const m of (step.live_messages || [])) {
      const text = typeof m === "string" ? m : (m?.text || "");
      if (text) liveMessages.push(text);
    }

    // Capture demographics from last step (latest snapshot)
    if (step === steps[steps.length - 1]) {
      for (const a of agents) {
        // Skip empty/unknown values so the demographic card only renders
        // when the recording step actually captured that dimension.
        const g = a.gender || ""; if (g) demoCounts.gender[g] = (demoCounts.gender[g] || 0) + 1;
        const r = a.race || a.race_ethnicity || ""; if (r) demoCounts.race[r] = (demoCounts.race[r] || 0) + 1;
        const e = a.education || ""; if (e) demoCounts.education[e] = (demoCounts.education[e] || 0) + 1;
        if (a.age) { const ag = ageBucket(Number(a.age)); demoCounts.age_group[ag] = (demoCounts.age_group[ag] || 0) + 1; }
        const inc = a.household_income || a.income_band || a.income || "";
        if (inc) demoCounts.household_income[inc] = (demoCounts.household_income[inc] || 0) + 1;
      }
    }
  }

  // ── Final standings: read from the scenario_result's poll_group_results
  //    (weighted/heuristic poll) which is the canonical election output.
  //    Falls back to llm_poll_group_results (pure LLM voting) or daily trends.
  const finalRes = scenarioResults && scenarioResults.length > 0 ? scenarioResults[scenarioResults.length - 1] : null;
  const finalVote: Record<string, number> = {};
  const llmVote: Record<string, number> = {};
  const readGroupResult = (gr: any): Record<string, number> => {
    if (!gr || typeof gr !== "object") return {};
    // Two accepted shapes:
    //   A) {"Likely Voters": {Harris: 41.6, Trump: 43.1, Undecided: 15.3}}
    //   B) {Harris: 41.6, Trump: 43.1, Undecided: 15.3}
    const firstKey = Object.keys(gr)[0];
    if (firstKey && typeof gr[firstKey] === "object" && !Array.isArray(gr[firstKey])) {
      return gr[firstKey];
    }
    return gr;
  };
  if (finalRes) {
    const weighted = readGroupResult(finalRes.poll_group_results);
    for (const [k, v] of Object.entries(weighted)) {
      const label = k === "不表態" ? "Undecided" : k;
      finalVote[label] = Number(v) || 0;
    }
    const llm = readGroupResult(finalRes.llm_poll_group_results);
    for (const [k, v] of Object.entries(llm)) {
      const label = k === "不表態" ? "Undecided" : k;
      llmVote[label] = Number(v) || 0;
    }
    // Also expose vote_prediction if nothing else worked (contains the aggregate)
    if (Object.keys(finalVote).length === 0 && finalRes.vote_prediction) {
      for (const [k, v] of Object.entries(finalRes.vote_prediction)) {
        const label = k === "不表態" ? "Undecided" : k;
        finalVote[label] = Number(v) || 0;
      }
    }
    // Add any new candidate names we haven't captured yet
    for (const k of Object.keys(finalVote)) if (k !== "Undecided" && !candidateNames.includes(k)) candidateNames.push(k);
  }
  if (Object.keys(finalVote).length === 0 && candidateTrends.length > 0) {
    const last = candidateTrends[candidateTrends.length - 1];
    for (const cn of candidateNames) if (last[`${cn}_support`] !== undefined) finalVote[cn] = last[`${cn}_support`];
    if (last["Undecided_support"] !== undefined) finalVote["Undecided"] = last["Undecided_support"];
  }
  const CAND_COLORS = ["#8b5cf6", "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#ec4899"];
  const first = candidateTrends[0] || {};
  const standings = candidateNames.map((cn, i) => {
    const support = finalVote[cn] ?? 0;
    const supportFirst = first[`${cn}_support`] ?? support;
    return {
      name: cn,
      support,
      delta: support - supportFirst,
      color: CAND_COLORS[i % CAND_COLORS.length],
    };
  }).sort((a, b) => b.support - a.support);

  const totalDays = dailyTrends.length;
  const totalAgents = steps.length > 0 ? (steps[steps.length - 1]?.aggregate?.entries_count || steps[steps.length - 1]?.agents?.length || 0) : 0;
  const numScenarios = (scenarioResults || []).length || 1;
  const title = en ? "Civatas Prediction Playback" : "Civatas 預測回放";
  const subtitle = recording?.title || templateName || (en ? "Election Prediction" : "選舉預測");

  return `<!DOCTYPE html>
<html lang="${en ? "en" : "zh-TW"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ${subtitle}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, "PingFang TC", sans-serif; background: #0a0a1a; color: #e0e0e0; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  h1 { color: #a855f7; font-size: 28px; margin-bottom: 4px; }
  h2 { color: #fff; font-size: 16px; margin: 20px 0 10px; display: flex; align-items: center; gap: 8px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 20px; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 14px; text-align: center; }
  .stat-card .value { font-size: 22px; font-weight: 700; color: #fff; }
  .stat-card .label { font-size: 11px; color: #888; margin-top: 4px; }
  .section { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .section.accent { background: rgba(168,85,247,0.06); border-color: rgba(168,85,247,0.25); }
  .section h2 { margin-top: 0; color: #a78bfa; }
  canvas { max-height: 260px; width: 100% !important; }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px 14px; }
  .btn { padding: 8px 18px; border-radius: 8px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-primary { background: #a855f7; color: #fff; }
  .btn-primary:hover { background: #9333ea; }
  .progress-bar { flex: 1; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: #a855f7; border-radius: 3px; transition: width 0.3s; }
  .day-label { color: #a855f7; font-size: 13px; font-weight: 600; min-width: 80px; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  table.standings { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.standings th { text-align: left; color: #888; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 11px; }
  table.standings td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.04); font-family: ui-monospace, monospace; }
  table.standings td:nth-child(1) { font-weight: 700; color: #fbbf24; }
  table.standings td:nth-child(2) { font-family: inherit; font-weight: 600; color: #fff; }
  table.standings td:nth-child(3) { color: #fff; font-weight: 700; }
  .num-right { text-align: right; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .delta-up { color: #22c55e; }
  .delta-down { color: #ef4444; }
  .demo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .demo-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 12px; }
  .demo-card h3 { font-size: 12px; color: #a78bfa; margin-bottom: 6px; }
  .demo-row { display: grid; grid-template-columns: 1fr 80px 40px; gap: 6px; align-items: center; padding: 3px 0; font-size: 11px; }
  .demo-bar { height: 5px; border-radius: 2px; background: rgba(167,139,250,0.65); }
  .demo-bar-bg { height: 5px; border-radius: 2px; background: rgba(255,255,255,0.05); overflow: hidden; }
  .footer { text-align: center; color: #555; font-size: 11px; margin-top: 30px; padding: 16px; border-top: 1px solid rgba(255,255,255,0.06); }
  @media (max-width: 700px) { .two-col { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="container">
  <h1>${title}</h1>
  <div class="subtitle">${subtitle} &middot; ${totalAgents} ${en ? "agents" : "位代理人"} &middot; ${totalDays} ${en ? "days" : "天"} &middot; ${numScenarios} ${en ? "scenarios" : "情境"}</div>

  <div class="stats-row">
    <div class="stat-card"><div class="value">${totalAgents}</div><div class="label">${en ? "Agents" : "代理人"}</div></div>
    <div class="stat-card"><div class="value">${totalDays}</div><div class="label">${en ? "Sim Days" : "模擬天數"}</div></div>
    <div class="stat-card"><div class="value">${candidateNames.length}</div><div class="label">${en ? "Candidates" : "候選人"}</div></div>
    <div class="stat-card"><div class="value">${standings[0]?.name ?? "—"}</div><div class="label">${en ? "Winner (predicted)" : "預測勝出"}</div></div>
    <div class="stat-card"><div class="value">${standings[0] ? standings[0].support.toFixed(1) + "%" : "—"}</div><div class="label">${en ? "Top Share" : "領先支持率"}</div></div>
    <div class="stat-card"><div class="value">${standings.length > 1 ? (standings[0].support - standings[1].support).toFixed(1) + "%" : "—"}</div><div class="label">${en ? "Margin" : "領先差距"}</div></div>
  </div>

  <div class="controls">
    <button class="btn btn-primary" id="playBtn" onclick="togglePlay()">&#9654; ${en ? "Play" : "播放"}</button>
    <div class="day-label" id="dayLabel">${en ? "Day" : "第"} 0${en ? "" : " 天"}</div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
    <input type="range" id="speedSlider" min="100" max="2000" value="500" style="width:80px" title="${en ? "Speed" : "速度"}">
  </div>

  ${standings.length > 0 ? `
  <div class="section accent">
    <h2>🏆 ${en ? "Final Predicted Standings" : "最終預測戰況"}</h2>
    <table class="standings">
      <thead>
        <tr>
          <th style="width:40px">#</th>
          <th>${en ? "Candidate" : "候選人"}</th>
          <th class="num-right">${en ? "Support" : "支持率"}</th>
          <th class="num-right">${en ? "Δ vs Day 1" : "相較 Day 1"}</th>
        </tr>
      </thead>
      <tbody>
        ${standings.map((s, i) => {
          const arrow = s.delta > 0.5 ? "▲" : s.delta < -0.5 ? "▼" : "—";
          const cls = s.delta > 0.5 ? "delta-up" : s.delta < -0.5 ? "delta-down" : "";
          return `<tr>
            <td>#${i + 1}</td>
            <td><span class="dot" style="background:${s.color}"></span>${s.name}</td>
            <td class="num-right">${s.support.toFixed(1)}%</td>
            <td class="num-right ${cls}">${arrow} ${Math.abs(s.delta).toFixed(1)}</td>
          </tr>`;
        }).join("")}
        ${finalVote["Undecided"] !== undefined ? `<tr>
          <td>—</td><td style="font-style:italic;color:#888">${en ? "Undecided" : "未決定"}</td>
          <td class="num-right">${finalVote["Undecided"].toFixed(1)}%</td><td></td>
        </tr>` : ""}
      </tbody>
    </table>
  </div>` : ""}

  <div class="two-col">
    <div class="section">
      <h2>🥧 ${en ? "Final Vote Share (Weighted)" : "最終得票分佈（加權民調）"}</h2>
      <canvas id="finalPieChart" style="max-height:300px"></canvas>
    </div>
    ${Object.keys(llmVote).length > 0 ? `<div class="section">
      <h2>🤖 ${en ? "LLM-Simulated Vote" : "LLM 模擬投票"}</h2>
      <canvas id="llmPieChart" style="max-height:300px"></canvas>
    </div>` : ""}
  </div>

  <div class="section">
    <h2>📊 ${en ? "Vote Method Comparison" : "兩種投票法對比"}</h2>
    <canvas id="voteCompareChart" style="max-height:220px"></canvas>
  </div>

  <div class="two-col">
    <div class="section">
      <h2>😀 ${en ? "Satisfaction & Anxiety" : "滿意度與焦慮度"}</h2>
      <canvas id="satAnxChart"></canvas>
    </div>
    <div class="section">
      <h2>🎚️ ${en ? "Political Leaning (%)" : "政治傾向 (%)"}</h2>
      <canvas id="leaningChart"></canvas>
    </div>
  </div>

  ${candidateNames.length > 0 && candAwarenessTrends.length > 0 ? `
  <div class="two-col">
    <div class="section">
      <h2>🧑‍💼 ${en ? "Candidate Awareness (per-day)" : "候選人認知度（逐日）"}</h2>
      <canvas id="candAwarenessChart"></canvas>
    </div>
    <div class="section">
      <h2>❤️ ${en ? "Candidate Sentiment (per-day)" : "候選人好感度（逐日）"}</h2>
      <canvas id="candSentimentChart"></canvas>
    </div>
  </div>` : ""}

  ${candidateNames.length > 0 && candidateTrends.length > 0 ? `
  <div class="section">
    <h2>📈 ${en ? "Candidate Support Trend (per-day)" : "候選人支持率趨勢（逐日）"}</h2>
    <canvas id="candSupportChart"></canvas>
  </div>` : ""}

  ${Object.values(demoCounts).some(m => Object.keys(m).length > 0) ? `
  <div class="section">
    <h2>👥 ${en ? "Voter Demographics" : "選民人口結構"}</h2>
    <div class="demo-grid" id="demoGrid"></div>
  </div>` : ""}

  ${liveMessages.length > 0 ? `
  <div class="section">
    <h2>💬 ${en ? "Agent Activity" : "Agent 動態"}</h2>
    <div id="activityFeed" style="max-height:260px;overflow-y:auto;font-size:11px;line-height:1.7;color:#bbb;background:rgba(0,0,0,0.25);border-radius:6px;padding:10px 14px"></div>
  </div>` : ""}

  <div class="footer">
    ${en ? "Generated by" : "由"} <strong>Civatas USA</strong> ${en ? "Social Simulation Agent Platform" : "社會模擬代理人平台"} &middot; ${new Date().toLocaleDateString(en ? "en-US" : "zh-TW")}
  </div>
</div>

<script>
const DATA = {
  dailyTrends: ${JSON.stringify(dailyTrends)},
  leaningTrends: ${JSON.stringify(leaningTrends)},
  candidateTrends: ${JSON.stringify(candidateTrends)},
  candAwarenessTrends: ${JSON.stringify(candAwarenessTrends)},
  candSentimentTrends: ${JSON.stringify(candSentimentTrends)},
  candidateNames: ${JSON.stringify(candidateNames)},
  finalVote: ${JSON.stringify(finalVote)},
  llmVote: ${JSON.stringify(llmVote)},
  liveMessages: ${JSON.stringify(liveMessages)},
  demoCounts: ${JSON.stringify(demoCounts)},
  totalDays: ${totalDays},
};
const EN = ${en};
const CAND_COLORS = ["#8b5cf6", "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#ec4899"];
let playing = false, currentDay = 0, timer = null;
Chart.defaults.color = '#888';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.font.size = 10;

const colorFor = n => {
  if (n === 'Undecided' || n === '不表態') return '#6b7280';
  const i = DATA.candidateNames.indexOf(n);
  return CAND_COLORS[(i >= 0 ? i : 0) % CAND_COLORS.length];
};
const mkPie = (id, voteObj) => {
  const el = document.getElementById(id);
  if (!el || !Object.keys(voteObj || {}).length) return;
  const labels = Object.keys(voteObj);
  new Chart(el.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: labels.map(k => voteObj[k]),
        backgroundColor: labels.map(colorFor),
        borderWidth: 2, borderColor: '#0a0a1a',
      }]
    },
    options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#ccc' } },
      tooltip: { callbacks: { label: ctx => ctx.label + ': ' + ctx.parsed.toFixed(1) + '%' } } } }
  });
};
mkPie('finalPieChart', DATA.finalVote);
mkPie('llmPieChart', DATA.llmVote);

// Side-by-side comparison chart: Weighted vs LLM per candidate
if (Object.keys(DATA.finalVote).length && document.getElementById('voteCompareChart')) {
  const names = Array.from(new Set([...Object.keys(DATA.finalVote), ...Object.keys(DATA.llmVote)]));
  new Chart(document.getElementById('voteCompareChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: names,
      datasets: [
        { label: EN ? 'Weighted poll (heuristic)' : '加權民調（啟發式）', data: names.map(n => DATA.finalVote[n] ?? 0), backgroundColor: '#a855f7' },
        ...(Object.keys(DATA.llmVote).length ? [{ label: EN ? 'LLM voting' : 'LLM 投票', data: names.map(n => DATA.llmVote[n] ?? 0), backgroundColor: '#22c55e' }] : []),
      ]
    },
    options: { responsive: true, scales: { y: { suggestedMin: 0, suggestedMax: 100, ticks: { callback: v => v + '%' } } },
      plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + (ctx.parsed.y || 0).toFixed(1) + '%' } } } }
  });
}

// Sat/Anx
const satAnxChart = new Chart(document.getElementById('satAnxChart').getContext('2d'), {
  type: 'line',
  data: { labels: [], datasets: [
    { label: EN ? 'Local Sat' : '地方滿意', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
    { label: EN ? 'National Sat' : '全國滿意', data: [], borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
    { label: EN ? 'Anxiety' : '焦慮度', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
  ]},
  options: { responsive: true, scales: { y: { min: 0, max: 100 } }, animation: { duration: 250 } }
});
// Stacked bar so Dem / Tossup / Rep are always visible even when values coincide.
const leanChart = new Chart(document.getElementById('leaningChart').getContext('2d'), {
  type: 'bar',
  data: { labels: [], datasets: [
    { label: EN ? 'Dem-leaning' : '偏藍', data: [], backgroundColor: '#3b82f6', stack: 'a' },
    { label: EN ? 'Tossup' : '搖擺', data: [], backgroundColor: '#94a3b8', stack: 'a' },
    { label: EN ? 'Rep-leaning' : '偏紅', data: [], backgroundColor: '#ef4444', stack: 'a' },
  ]},
  options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, min: 0, max: 100, ticks: { callback: v => v + '%' } } }, animation: { duration: 250 } }
});
const mkLine = (id, yMin, yMax, yFmt) => {
  const el = document.getElementById(id);
  if (!el) return null;
  const yScale = {};
  if (yMin !== null && yMin !== undefined) yScale.min = yMin;
  if (yMax !== null && yMax !== undefined) yScale.max = yMax;
  if (yFmt) yScale.ticks = { callback: yFmt };
  return new Chart(el.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: DATA.candidateNames.map((n, i) => ({
        label: n, data: [],
        borderColor: colorFor(n),
        backgroundColor: colorFor(n) + '22',
        tension: 0.3, pointRadius: 0,
      })),
    },
    options: { responsive: true, scales: { y: yScale }, animation: { duration: 250 } }
  });
};
let candSupportChart = null;
if (DATA.candidateNames.length && DATA.candidateTrends.length) candSupportChart = mkLine('candSupportChart', 0, 100, v => v + '%');
// Awareness: backend stores 0..1, display as 0..100%.
let candAwarenessChart = null;
if (DATA.candidateNames.length && DATA.candAwarenessTrends.length) candAwarenessChart = mkLine('candAwarenessChart', 0, 100, v => v + '%');
// Sentiment: backend stores ~ -1..1 but most runs are near 0. Auto-scale Y.
let candSentimentChart = null;
if (DATA.candidateNames.length && DATA.candSentimentTrends.length) candSentimentChart = mkLine('candSentimentChart', null, null, null);

// Demographics
const demoGrid = document.getElementById('demoGrid');
if (demoGrid) {
  const LABELS = { gender: EN?'Gender':'性別', race: EN?'Race':'族裔', education: EN?'Education':'教育', age_group: EN?'Age':'年齡', household_income: EN?'Income':'收入' };
  Object.entries(DATA.demoCounts).forEach(([dim, counts]) => {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!entries.length) return;
    const max = Math.max(...entries.map(e => e[1]));
    const total = entries.reduce((s, e) => s + e[1], 0);
    const html = '<h3>' + (LABELS[dim] || dim) + '</h3>' + entries.map(([name, cnt]) => {
      const pct = total > 0 ? (cnt / total * 100).toFixed(0) : '0';
      const w = max > 0 ? (cnt / max * 100) : 0;
      return '<div class="demo-row"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + name + '">' + name + '</span><div class="demo-bar-bg"><div class="demo-bar" style="width:' + w + '%"></div></div><span style="text-align:right;color:#666">' + pct + '%</span></div>';
    }).join('');
    const card = document.createElement('div'); card.className = 'demo-card'; card.innerHTML = html; demoGrid.appendChild(card);
  });
}

// Activity feed
const feed = document.getElementById('activityFeed');
if (feed) {
  feed.innerHTML = DATA.liveMessages.slice(-60).map(t =>
    '<div style="padding:2px 0"><span style="color:#a78bfa">◆</span> ' + String(t).slice(0, 400) + '</div>'
  ).join('');
}

// Playback engine
function reset() {
  currentDay = 0;
  [satAnxChart, leanChart, candSupportChart, candAwarenessChart, candSentimentChart].forEach(c => {
    if (!c) return;
    c.data.labels = []; c.data.datasets.forEach(ds => ds.data = []); c.update('none');
  });
}
function step(day) {
  const d = DATA.dailyTrends[day]; if (!d) return;
  const label = (EN ? 'Day ' : '第 ') + (day + 1) + (EN ? '' : ' 天');
  satAnxChart.data.labels.push(label);
  satAnxChart.data.datasets[0].data.push(d.local_satisfaction);
  satAnxChart.data.datasets[1].data.push(d.national_satisfaction);
  satAnxChart.data.datasets[2].data.push(d.anxiety);
  satAnxChart.update('none');
  const l = DATA.leaningTrends[day];
  if (l) {
    leanChart.data.labels.push(label);
    leanChart.data.datasets[0].data.push(l.left);
    leanChart.data.datasets[1].data.push(l.center);
    leanChart.data.datasets[2].data.push(l.right);
    leanChart.update('none');
  }
  if (candSupportChart && DATA.candidateTrends[day]) {
    const ct = DATA.candidateTrends[day];
    candSupportChart.data.labels.push(label);
    DATA.candidateNames.forEach((n, i) => candSupportChart.data.datasets[i].data.push(ct[n + '_support'] ?? 0));
    candSupportChart.update('none');
  }
  if (candAwarenessChart && DATA.candAwarenessTrends[day]) {
    const aw = DATA.candAwarenessTrends[day];
    candAwarenessChart.data.labels.push(label);
    DATA.candidateNames.forEach((n, i) => candAwarenessChart.data.datasets[i].data.push(Math.round(((aw[n + '_awareness'] ?? 0)) * 1000) / 10));
    candAwarenessChart.update('none');
  }
  if (candSentimentChart && DATA.candSentimentTrends[day]) {
    const se = DATA.candSentimentTrends[day];
    candSentimentChart.data.labels.push(label);
    DATA.candidateNames.forEach((n, i) => candSentimentChart.data.datasets[i].data.push(se[n + '_sentiment'] ?? 0));
    candSentimentChart.update('none');
  }
  document.getElementById('dayLabel').textContent = label;
  document.getElementById('progressFill').style.width = ((day + 1) / DATA.totalDays * 100) + '%';
}
function togglePlay() {
  if (playing) { clearInterval(timer); playing = false;
    document.getElementById('playBtn').innerHTML = '&#9654; ' + (EN ? 'Play' : '播放'); return; }
  if (currentDay >= DATA.totalDays) reset();
  playing = true;
  document.getElementById('playBtn').innerHTML = '&#9646;&#9646; ' + (EN ? 'Pause' : '暫停');
  timer = setInterval(() => {
    if (currentDay >= DATA.totalDays) { clearInterval(timer); playing = false;
      document.getElementById('playBtn').innerHTML = '&#8634; ' + (EN ? 'Replay' : '重播'); return; }
    step(currentDay); currentDay++;
  }, parseInt(document.getElementById('speedSlider').value));
}
document.getElementById('speedSlider').addEventListener('input', () => {
  if (playing) { clearInterval(timer);
    timer = setInterval(() => {
      if (currentDay >= DATA.totalDays) { clearInterval(timer); playing = false; return; }
      step(currentDay); currentDay++;
    }, parseInt(document.getElementById('speedSlider').value));
  }
});
<\/script>
</body>
</html>`;
}
