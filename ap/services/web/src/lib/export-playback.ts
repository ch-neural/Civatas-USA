/**
 * Generate a self-contained HTML file that plays back evolution data
 * with animated charts. Uses Chart.js from CDN.
 *
 * Covers:
 *  - Summary stat cards (agents, days, candidates, final leaning breakdown)
 *  - Candidate standings table (latest support / awareness / sentiment)
 *  - Animated line charts: Satisfaction/Anxiety, Political Leaning %,
 *    Candidate Support %, Candidate Sentiment, Candidate Awareness
 *  - Static breakdown bars: candidate support by political leaning, by gender,
 *    by district (top-N)
 *  - Demographics distribution (race, gender, age, income) from dashboard
 *  - Full history chart across all batches
 *  - Play / Pause / Replay controls with speed slider
 */

export function generatePlaybackHTML(data: {
  dashboard: any;
  history: any[];
  jobs: any[];
  templateName?: string;
  locale?: string;
}): string {
  const { dashboard, history, templateName, locale } = data;
  const en = locale !== "zh-TW";

  const dailyTrends = dashboard?.daily_trends ?? [];
  const leaningTrends = dashboard?.leaning_trends ?? [];
  const candidateTrends = dashboard?.candidate_trends ?? [];
  const breakdown = dashboard?.candidate_breakdown ?? {};
  const districtStats = dashboard?.district_stats ?? {};
  const liveMessages = dashboard?.live_messages ?? [];
  const recentActivity = dashboard?.recent_activity ?? [];
  // Prefer tracked names; fall back to breakdown.overall keys
  let candidateNames: string[] = dashboard?.tracked_candidate_names ?? [];
  if (!candidateNames.length && breakdown?.overall) {
    candidateNames = Object.keys(breakdown.overall).filter((k: string) => k !== "Undecided");
  }
  const agentCount = dashboard?.agent_count ?? 0;
  const demoStats = dashboard?.demo_stats ?? {};
  const totalDays = dailyTrends.length;

  const title = en ? "Civatas Evolution Playback" : "Civatas 演化回放";
  const subtitle = templateName || (en ? "Election Simulation" : "選舉模擬");

  // Build per-candidate latest/first values for the standings table
  const latestTrend = candidateTrends[candidateTrends.length - 1] ?? {};
  const firstTrend = candidateTrends[0] ?? {};
  const overallPcts = breakdown?.overall ?? {};
  const standings = candidateNames.map((cn: string, i: number) => {
    const support = (latestTrend[`${cn}_support`] ?? overallPcts[cn] ?? 0) as number;
    const supportFirst = (firstTrend[`${cn}_support`] ?? support) as number;
    const awareness = (latestTrend[`${cn}_awareness`] ?? 0) as number;
    const sentiment = (latestTrend[`${cn}_sentiment`] ?? 0) as number;
    const CAND_COLORS = ["#8b5cf6", "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#ec4899"];
    return {
      name: cn,
      support,
      supportDelta: support - supportFirst,
      awareness,
      sentiment,
      color: CAND_COLORS[i % CAND_COLORS.length],
    };
  }).sort((a, b) => b.support - a.support);
  const undecidedPct = (latestTrend["Undecided_support"] ?? overallPcts["Undecided"] ?? null) as number | null;

  // Flattened breakdown groups (respect insertion/grouped order for leaning)
  const LEAN_ORDER = ["Solid Dem", "Lean Dem", "Tossup", "Lean Rep", "Solid Rep"];
  const orderedLeanKeys = LEAN_ORDER.filter((k) => breakdown.by_leaning?.[k]);

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
  h1 { color: #e94560; font-size: 28px; margin-bottom: 4px; }
  h2 { color: #fff; font-size: 16px; margin: 20px 0 10px; display: flex; align-items: center; gap: 8px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 20px; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 14px; text-align: center; }
  .stat-card .value { font-size: 24px; font-weight: 700; color: #fff; }
  .stat-card .label { font-size: 11px; color: #888; margin-top: 4px; }
  .section { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .section.accent { background: rgba(139,92,246,0.06); border-color: rgba(139,92,246,0.25); }
  .section h2 { margin-top: 0; color: #a78bfa; }
  canvas { max-height: 260px; width: 100% !important; }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px 14px; }
  .btn { padding: 8px 18px; border-radius: 8px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: 0.2s; }
  .btn-primary { background: #e94560; color: #fff; }
  .btn-primary:hover { background: #d63851; }
  .progress-bar { flex: 1; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: #e94560; border-radius: 3px; transition: width 0.3s; }
  .day-label { color: #e94560; font-size: 13px; font-weight: 600; min-width: 80px; }
  .footer { text-align: center; color: #555; font-size: 11px; margin-top: 30px; padding: 16px; border-top: 1px solid rgba(255,255,255,0.06); }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .three-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
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
  @media (max-width: 700px) { .two-col, .three-col { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="container">
  <h1>${title}</h1>
  <div class="subtitle">${subtitle} &middot; ${agentCount} ${en ? "agents" : "位代理人"} &middot; ${totalDays} ${en ? "days" : "天"} &middot; ${candidateNames.length} ${en ? "candidates" : "候選人"}</div>

  <!-- Summary stats -->
  <div class="stats-row">
    <div class="stat-card">
      <div class="value">${agentCount}</div>
      <div class="label">${en ? "Agents" : "代理人"}</div>
    </div>
    <div class="stat-card">
      <div class="value">${totalDays}</div>
      <div class="label">${en ? "Days Evolved" : "演化天數"}</div>
    </div>
    <div class="stat-card">
      <div class="value">${dailyTrends.length > 0 ? (dailyTrends[dailyTrends.length - 1].local_satisfaction?.toFixed(1) ?? "—") : "—"}</div>
      <div class="label">${en ? "Final Local Sat" : "最終地方滿意度"}</div>
    </div>
    <div class="stat-card">
      <div class="value">${dailyTrends.length > 0 ? (dailyTrends[dailyTrends.length - 1].anxiety?.toFixed(1) ?? "—") : "—"}</div>
      <div class="label">${en ? "Final Anxiety" : "最終焦慮度"}</div>
    </div>
    <div class="stat-card">
      <div class="value">${standings[0]?.name ?? "—"}</div>
      <div class="label">${en ? "Leading Candidate" : "領先候選人"}</div>
    </div>
    <div class="stat-card">
      <div class="value">${standings[0] ? standings[0].support.toFixed(1) + "%" : "—"}</div>
      <div class="label">${en ? "Top Support" : "領先支持率"}</div>
    </div>
  </div>

  <!-- Playback controls -->
  <div class="controls">
    <button class="btn btn-primary" id="playBtn" onclick="togglePlay()">&#9654; ${en ? "Play" : "播放"}</button>
    <div class="day-label" id="dayLabel">${en ? "Day" : "第"} 0${en ? "" : " 天"}</div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
    <input type="range" id="speedSlider" min="100" max="2000" value="500" style="width:80px" title="${en ? "Speed" : "速度"}">
  </div>

  ${standings.length > 0 ? `
  <!-- Candidate Standings (static snapshot) -->
  <div class="section accent">
    <h2>🏆 ${en ? "Final Candidate Standings" : "最終候選人戰況"}</h2>
    <table class="standings">
      <thead>
        <tr>
          <th style="width:40px">#</th>
          <th>${en ? "Candidate" : "候選人"}</th>
          <th class="num-right">${en ? "Support" : "支持率"}</th>
          <th class="num-right">${en ? "Δ vs Day 1" : "相較 Day 1"}</th>
          <th class="num-right">${en ? "Awareness" : "認知度"}</th>
          <th class="num-right">${en ? "Sentiment" : "好感度"}</th>
        </tr>
      </thead>
      <tbody>
        ${standings.map((s, i) => {
          const arrow = s.supportDelta > 0.5 ? "▲" : s.supportDelta < -0.5 ? "▼" : "—";
          const deltaCls = s.supportDelta > 0.5 ? "delta-up" : s.supportDelta < -0.5 ? "delta-down" : "";
          const sentCls = s.sentiment > 0.1 ? "delta-up" : s.sentiment < -0.1 ? "delta-down" : "";
          return `<tr>
            <td>#${i + 1}</td>
            <td><span class="dot" style="background:${s.color}"></span>${s.name}</td>
            <td class="num-right">${s.support.toFixed(1)}%</td>
            <td class="num-right ${deltaCls}">${arrow} ${Math.abs(s.supportDelta).toFixed(1)}</td>
            <td class="num-right">${(s.awareness * 100).toFixed(0)}%</td>
            <td class="num-right ${sentCls}">${s.sentiment >= 0 ? "+" : ""}${s.sentiment.toFixed(2)}</td>
          </tr>`;
        }).join("")}
        ${undecidedPct !== null ? `<tr>
          <td>—</td>
          <td style="font-style:italic;color:#888">${en ? "Undecided" : "未決定"}</td>
          <td class="num-right">${Number(undecidedPct).toFixed(1)}%</td>
          <td colspan="3"></td>
        </tr>` : ""}
      </tbody>
    </table>
  </div>` : ""}

  <!-- Animated time-series charts -->
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

  ${candidateNames.length > 0 && candidateTrends.length > 0 ? `
  <div class="two-col">
    <div class="section">
      <h2>📈 ${en ? "Candidate Support Trend" : "候選人支持率趨勢"}</h2>
      <canvas id="candSupportChart"></canvas>
    </div>
    <div class="section">
      <h2>❤️ ${en ? "Candidate Sentiment Trend" : "候選人好感度趨勢"}</h2>
      <canvas id="candSentimentChart"></canvas>
    </div>
  </div>
  <div class="section">
    <h2>🧑‍💼 ${en ? "Candidate Awareness Trend" : "候選人認知度趨勢"}</h2>
    <canvas id="candAwarenessChart"></canvas>
  </div>` : ""}

  <!-- Breakdown bars (static, end-state) -->
  ${candidateNames.length > 0 && (breakdown.by_leaning || breakdown.by_gender || breakdown.by_district) ? `
  <div class="section">
    <h2>📊 ${en ? "Candidate Support Breakdown" : "候選人支持率交叉分析"}</h2>
    <div class="three-col">
      ${breakdown.by_leaning ? `<div><h3 style="font-size:12px;color:#a78bfa;margin-bottom:6px">${en ? "By Political Leaning" : "依政治傾向"}</h3><canvas id="breakLeaningChart"></canvas></div>` : ""}
      ${breakdown.by_gender ? `<div><h3 style="font-size:12px;color:#a78bfa;margin-bottom:6px">${en ? "By Gender" : "依性別"}</h3><canvas id="breakGenderChart"></canvas></div>` : ""}
      ${breakdown.by_district ? `<div><h3 style="font-size:12px;color:#a78bfa;margin-bottom:6px">${en ? "By District (Top 15)" : "依州 (前 15)"}</h3><canvas id="breakDistrictChart"></canvas></div>` : ""}
    </div>
  </div>` : ""}

  <!-- District satisfaction -->
  ${Object.keys(districtStats).length > 1 ? `
  <div class="section">
    <h2>🗺️ ${en ? "Per-District Satisfaction (latest)" : "各行政區滿意度（最新日）"}</h2>
    <canvas id="districtChart"></canvas>
  </div>` : ""}

  <!-- Demographics bars -->
  ${Object.keys(demoStats).length > 0 ? `
  <div class="section">
    <h2>👥 ${en ? "Population Demographics" : "人口結構"}</h2>
    <div class="demo-grid" id="demoGrid"></div>
  </div>` : ""}

  <!-- Activity feed -->
  ${(liveMessages.length > 0 || recentActivity.length > 0) ? `
  <div class="section">
    <h2>💬 ${en ? "Agent Activity (recent)" : "Agent 動態（近期）"}</h2>
    <div id="activityFeed" style="max-height:280px;overflow-y:auto;font-size:11px;line-height:1.7;color:#bbb;background:rgba(0,0,0,0.25);border-radius:6px;padding:10px 14px"></div>
  </div>` : ""}

  <!-- History -->
  <div class="section">
    <h2>📜 ${en ? "History (all batches)" : "演化歷程（全部批次）"}</h2>
    <canvas id="historyChart"></canvas>
  </div>

  <div class="footer">
    ${en ? "Generated by" : "由"} <strong>Civatas USA</strong> ${en ? "Social Simulation Agent Platform" : "社會模擬代理人平台"} &middot; ${new Date().toLocaleDateString(en ? "en-US" : "zh-TW")}
  </div>
</div>

<script>
const DATA = {
  dailyTrends: ${JSON.stringify(dailyTrends)},
  leaningTrends: ${JSON.stringify(leaningTrends)},
  candidateTrends: ${JSON.stringify(candidateTrends)},
  candidateNames: ${JSON.stringify(candidateNames)},
  breakdown: ${JSON.stringify(breakdown)},
  orderedLeanKeys: ${JSON.stringify(orderedLeanKeys)},
  history: ${JSON.stringify(history)},
  demoStats: ${JSON.stringify(demoStats)},
  districtStats: ${JSON.stringify(districtStats)},
  liveMessages: ${JSON.stringify(liveMessages)},
  recentActivity: ${JSON.stringify(recentActivity)},
  totalDays: ${totalDays},
};

const EN = ${en};
const CAND_COLORS = ["#8b5cf6", "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#ec4899"];
let playing = false;
let currentDay = 0;
let timer = null;

Chart.defaults.color = '#888';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.font.size = 10;

// ─── Animated time-series charts ───────────────────────────────────
const satAnxChart = new Chart(document.getElementById('satAnxChart').getContext('2d'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      { label: EN ? 'Local Sat' : '地方滿意', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
      { label: EN ? 'National Sat' : '全國滿意', data: [], borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
      { label: EN ? 'Anxiety' : '焦慮度', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3, pointRadius: 0 },
    ]
  },
  options: { responsive: true, scales: { y: { min: 0, max: 100 } }, animation: { duration: 250 } }
});

const leanChart = new Chart(document.getElementById('leaningChart').getContext('2d'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      { label: EN ? 'Dem-leaning' : '偏藍', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.15)', fill: true, tension: 0.3, pointRadius: 0 },
      { label: EN ? 'Tossup' : '搖擺', data: [], borderColor: '#94a3b8', backgroundColor: 'rgba(148,163,184,0.15)', fill: true, tension: 0.3, pointRadius: 0 },
      { label: EN ? 'Rep-leaning' : '偏紅', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.15)', fill: true, tension: 0.3, pointRadius: 0 },
    ]
  },
  options: { responsive: true, scales: { y: { min: 0, max: 100 } }, animation: { duration: 250 } }
});

let candSupportChart = null, candSentimentChart = null, candAwarenessChart = null;
if (DATA.candidateNames.length && DATA.candidateTrends.length) {
  const mkDs = (suffix, baseLabel) => DATA.candidateNames.map((n, i) => ({
    label: n + ' ' + baseLabel,
    data: [], borderColor: CAND_COLORS[i % CAND_COLORS.length],
    backgroundColor: CAND_COLORS[i % CAND_COLORS.length] + '22',
    tension: 0.3, pointRadius: 0,
  }));
  candSupportChart = new Chart(document.getElementById('candSupportChart').getContext('2d'), {
    type: 'line', data: { labels: [], datasets: mkDs('_support', EN ? 'support' : '支持率') },
    options: { responsive: true, scales: { y: { ticks: { callback: v => v.toFixed(0)+'%' } } }, animation: { duration: 250 } },
  });
  candSentimentChart = new Chart(document.getElementById('candSentimentChart').getContext('2d'), {
    type: 'line', data: { labels: [], datasets: mkDs('_sentiment', EN ? 'sentiment' : '好感度') },
    options: { responsive: true, scales: { y: { min: -1, max: 1 } }, animation: { duration: 250 } },
  });
  candAwarenessChart = new Chart(document.getElementById('candAwarenessChart').getContext('2d'), {
    type: 'line', data: { labels: [], datasets: mkDs('_awareness', EN ? 'awareness' : '認知度') },
    options: { responsive: true, scales: { y: { ticks: { callback: v => (v*100).toFixed(0)+'%' } } }, animation: { duration: 250 } },
  });
}

// ─── Static breakdown bars (end-state) ─────────────────────────────
function buildStacked(canvasId, acc, labelOrder) {
  if (!document.getElementById(canvasId)) return;
  const groups = (labelOrder && labelOrder.length ? labelOrder : Object.keys(acc || {})).filter(g => acc?.[g] && g !== '_count');
  if (!groups.length) return;
  const rows = groups.map(g => {
    const r = { name: g };
    DATA.candidateNames.forEach(cn => r[cn] = acc[g]?.[cn] ?? 0);
    return r;
  });
  new Chart(document.getElementById(canvasId).getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.name),
      datasets: DATA.candidateNames.map((cn, i) => ({
        label: cn,
        data: rows.map(r => r[cn]),
        backgroundColor: CAND_COLORS[i % CAND_COLORS.length],
        stack: 's',
      })),
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      scales: {
        x: { stacked: true, ticks: { callback: v => v + '%' }, suggestedMax: 100 },
        y: { stacked: true }
      },
      plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.x.toFixed(1) + '%' } } },
    }
  });
}
buildStacked('breakLeaningChart', DATA.breakdown.by_leaning, DATA.orderedLeanKeys);
buildStacked('breakGenderChart', DATA.breakdown.by_gender, null);
// For district, take top 15 by sum of votes
if (document.getElementById('breakDistrictChart') && DATA.breakdown.by_district) {
  const entries = Object.entries(DATA.breakdown.by_district)
    .filter(([k]) => k !== '_count')
    .map(([k, v]) => [k, DATA.candidateNames.reduce((s, cn) => s + (v?.[cn] ?? 0), 0), v])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  const topAcc = {};
  entries.forEach(([k, , v]) => topAcc[k] = v);
  buildStacked('breakDistrictChart', topAcc, entries.map(e => e[0]));
}

// ─── Demographics (static bars) ────────────────────────────────────
const demoGrid = document.getElementById('demoGrid');
if (demoGrid) {
  const DEMO_LABELS = { gender: EN?'Gender':'性別', race: EN?'Race':'族裔', education: EN?'Education':'教育', age_group: EN?'Age':'年齡', occupation: EN?'Occupation':'職業', income: EN?'Income':'收入', household_income: EN?'Income':'收入', party_lean: EN?'Leaning':'政治傾向' };
  Object.entries(DATA.demoStats).forEach(([dim, counts]) => {
    if (!counts || typeof counts !== 'object') return;
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!entries.length) return;
    const max = Math.max(...entries.map(e => e[1]));
    const total = entries.reduce((s, e) => s + e[1], 0);
    const html = '<h3>' + (DEMO_LABELS[dim] || dim) + '</h3>' + entries.map(([name, cnt]) => {
      const pct = total > 0 ? (cnt / total * 100).toFixed(0) : '0';
      const w = max > 0 ? (cnt / max * 100) : 0;
      return '<div class="demo-row"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + name + '">' + name + '</span><div class="demo-bar-bg"><div class="demo-bar" style="width:' + w + '%"></div></div><span style="text-align:right;color:#666">' + pct + '%</span></div>';
    }).join('');
    const card = document.createElement('div');
    card.className = 'demo-card';
    card.innerHTML = html;
    demoGrid.appendChild(card);
  });
}

// ─── District satisfaction (static) ────────────────────────────────
if (document.getElementById('districtChart') && Object.keys(DATA.districtStats).length > 0) {
  const rows = Object.entries(DATA.districtStats)
    .map(([name, s]) => ({ name, local: s.avg_local_satisfaction ?? 0, national: s.avg_national_satisfaction ?? 0, anxiety: s.avg_anxiety ?? 0 }))
    .sort((a, b) => b.local - a.local)
    .slice(0, 30);
  new Chart(document.getElementById('districtChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.name),
      datasets: [
        { label: EN ? 'Local Sat' : '地方滿意', data: rows.map(r => r.local), backgroundColor: '#3b82f6' },
        { label: EN ? 'National Sat' : '全國滿意', data: rows.map(r => r.national), backgroundColor: '#f97316' },
        { label: EN ? 'Anxiety' : '焦慮度', data: rows.map(r => r.anxiety), backgroundColor: '#ef4444' },
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      scales: { x: { min: 0, max: 100 } },
    }
  });
  document.getElementById('districtChart').parentElement.style.setProperty('--h', Math.max(140, rows.length * 22) + 'px');
  document.getElementById('districtChart').style.maxHeight = Math.max(140, rows.length * 22) + 'px';
}

// ─── Activity feed ─────────────────────────────────────────────────
const feed = document.getElementById('activityFeed');
if (feed) {
  const all = [];
  DATA.liveMessages.forEach(m => {
    const txt = typeof m === 'string' ? m : (m.text || m.message || JSON.stringify(m));
    const ts = typeof m === 'object' ? (m.timestamp || m.ts || '') : '';
    all.push({ kind: 'live', text: txt, ts });
  });
  DATA.recentActivity.slice(0, 30).forEach(a => {
    const txt = typeof a === 'string' ? a : (a.content || a.message || a.diary_entry || JSON.stringify(a));
    const who = typeof a === 'object' ? (a.agent_name || a.agent_id || '') : '';
    all.push({ kind: 'activity', text: (who ? '[' + who + '] ' : '') + txt, ts: (typeof a==='object'?a.day:'') });
  });
  feed.innerHTML = all.slice(-60).map(e => {
    const badge = e.kind === 'live' ? '<span style="color:#a78bfa">◆</span>' : '<span style="color:#22c55e">▸</span>';
    const tsLabel = e.ts ? '<span style="color:#555;margin-right:6px">' + e.ts + '</span>' : '';
    return '<div style="padding:2px 0">' + badge + ' ' + tsLabel + String(e.text).slice(0, 400) + '</div>';
  }).join('') || '<div style="color:#555">(no activity)</div>';
  feed.scrollTop = feed.scrollHeight;
}

// ─── History (static) ──────────────────────────────────────────────
new Chart(document.getElementById('historyChart').getContext('2d'), {
  type: 'line',
  data: {
    labels: DATA.history.map(h => (EN ? 'D' : 'D') + h.global_day),
    datasets: [
      { label: EN ? 'Satisfaction' : '滿意度', data: DATA.history.map(h => h.avg_satisfaction), borderColor: '#22c55e', tension: 0.3, pointRadius: 2 },
      { label: EN ? 'Anxiety' : '焦慮度', data: DATA.history.map(h => h.avg_anxiety), borderColor: '#ef4444', tension: 0.3, pointRadius: 2 },
    ]
  },
  options: { responsive: true, scales: { y: { min: 0, max: 100 } } }
});

// ─── Playback engine ───────────────────────────────────────────────
function resetAnimated() {
  currentDay = 0;
  [satAnxChart, leanChart, candSupportChart, candSentimentChart, candAwarenessChart].forEach(c => {
    if (!c) return;
    c.data.labels = [];
    c.data.datasets.forEach(ds => ds.data = []);
    c.update('none');
  });
}

function stepDay(day) {
  const d = DATA.dailyTrends[day];
  if (!d) return;
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

  const ct = DATA.candidateTrends[day];
  if (ct) {
    [candSupportChart, candSentimentChart, candAwarenessChart].forEach((c, idx) => {
      if (!c) return;
      c.data.labels.push(label);
      DATA.candidateNames.forEach((n, i) => {
        const key = n + (idx === 0 ? '_support' : idx === 1 ? '_sentiment' : '_awareness');
        c.data.datasets[i].data.push(ct[key] ?? 0);
      });
      c.update('none');
    });
  }

  document.getElementById('dayLabel').textContent = label;
  document.getElementById('progressFill').style.width = ((day + 1) / DATA.totalDays * 100) + '%';
}

function togglePlay() {
  if (playing) {
    clearInterval(timer);
    playing = false;
    document.getElementById('playBtn').innerHTML = '&#9654; ' + (EN ? 'Play' : '播放');
    return;
  }
  if (currentDay >= DATA.totalDays) resetAnimated();
  playing = true;
  document.getElementById('playBtn').innerHTML = '&#9646;&#9646; ' + (EN ? 'Pause' : '暫停');
  const tick = () => {
    if (currentDay >= DATA.totalDays) {
      clearInterval(timer);
      playing = false;
      document.getElementById('playBtn').innerHTML = '&#8634; ' + (EN ? 'Replay' : '重播');
      return;
    }
    stepDay(currentDay);
    currentDay++;
  };
  timer = setInterval(tick, parseInt(document.getElementById('speedSlider').value));
}

document.getElementById('speedSlider').addEventListener('input', () => {
  if (playing) {
    clearInterval(timer);
    timer = setInterval(() => {
      if (currentDay >= DATA.totalDays) { clearInterval(timer); playing = false; return; }
      stepDay(currentDay);
      currentDay++;
    }, parseInt(document.getElementById('speedSlider').value));
  }
});
<\/script>
</body>
</html>`;
}
