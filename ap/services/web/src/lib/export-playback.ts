/**
 * Generate a self-contained HTML file that plays back evolution data
 * with animated charts. Uses Chart.js from CDN.
 */

export function generatePlaybackHTML(data: {
  dashboard: any;
  history: any[];
  jobs: any[];
  templateName?: string;
  locale?: string;
}): string {
  const { dashboard, history, jobs, templateName, locale } = data;
  const en = locale !== "zh-TW";

  const dailyTrends = dashboard?.daily_trends ?? [];
  const leaningTrends = dashboard?.leaning_trends ?? [];
  const candidateTrends = dashboard?.candidate_trends ?? [];
  const candidateNames = dashboard?.tracked_candidate_names ?? [];
  const agentCount = dashboard?.agent_count ?? 0;
  const demoStats = dashboard?.demo_stats ?? {};
  const totalDays = dailyTrends.length;

  const title = en ? "Civatas Evolution Playback" : "Civatas 演化回放";
  const subtitle = templateName || (en ? "Election Simulation" : "選舉模擬");

  return `<!DOCTYPE html>
<html lang="${en ? "en" : "zh-TW"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ${subtitle}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a1a; color: #e0e0e0; }
  .container { max-width: 1000px; margin: 0 auto; padding: 24px; }
  h1 { color: #e94560; font-size: 28px; margin-bottom: 4px; }
  h2 { color: #fff; font-size: 18px; margin: 24px 0 12px; }
  .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
  .stats-row { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat-card { flex: 1; min-width: 120px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 16px; text-align: center; }
  .stat-card .value { font-size: 28px; font-weight: 700; color: #fff; }
  .stat-card .label { font-size: 11px; color: #888; margin-top: 4px; }
  .chart-container { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  canvas { max-height: 300px; }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 24px; }
  .btn { padding: 8px 20px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; transition: 0.2s; }
  .btn-primary { background: #e94560; color: #fff; }
  .btn-primary:hover { background: #d63851; }
  .btn-secondary { background: rgba(255,255,255,0.06); color: #aaa; border: 1px solid rgba(255,255,255,0.1); }
  .progress-bar { flex: 1; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: #e94560; border-radius: 3px; transition: width 0.3s; }
  .day-label { color: #e94560; font-size: 13px; font-weight: 600; min-width: 80px; }
  .footer { text-align: center; color: #555; font-size: 11px; margin-top: 40px; padding: 20px; border-top: 1px solid rgba(255,255,255,0.06); }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 600px) { .two-col { grid-template-columns: 1fr; } .stats-row { flex-direction: column; } }
</style>
</head>
<body>
<div class="container">
  <h1>${title}</h1>
  <div class="subtitle">${subtitle} &middot; ${agentCount} ${en ? "agents" : "位代理人"} &middot; ${totalDays} ${en ? "days" : "天"}</div>

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
      <div class="value">${dailyTrends.length > 0 ? dailyTrends[dailyTrends.length - 1].anxiety?.toFixed(1) : "—"}</div>
      <div class="label">${en ? "Final Anxiety" : "最終焦慮度"}</div>
    </div>
    <div class="stat-card">
      <div class="value">${candidateNames.length || "—"}</div>
      <div class="label">${en ? "Candidates" : "候選人"}</div>
    </div>
  </div>

  <!-- Playback controls -->
  <div class="controls">
    <button class="btn btn-primary" id="playBtn" onclick="togglePlay()">&#9654; ${en ? "Play" : "播放"}</button>
    <div class="day-label" id="dayLabel">${en ? "Day" : "第"} 0${en ? "" : " 天"}</div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
    <input type="range" id="speedSlider" min="100" max="2000" value="500" style="width:80px" title="${en ? "Speed" : "速度"}">
  </div>

  <!-- Charts -->
  <div class="two-col">
    <div class="chart-container">
      <h2>${en ? "Satisfaction & Anxiety" : "滿意度與焦慮度"}</h2>
      <canvas id="satAnxChart"></canvas>
    </div>
    <div class="chart-container">
      <h2>${en ? "Political Leaning Trend" : "政治傾向趨勢"}</h2>
      <canvas id="leaningChart"></canvas>
    </div>
  </div>

  ${candidateNames.length > 0 ? `
  <div class="chart-container">
    <h2>${en ? "Candidate Awareness" : "候選人認知度"}</h2>
    <canvas id="candidateChart"></canvas>
  </div>` : ""}

  <div class="chart-container">
    <h2>${en ? "History (all batches)" : "演化歷程（全部批次）"}</h2>
    <canvas id="historyChart"></canvas>
  </div>

  <div class="footer">
    ${en ? "Generated by" : "由"} <strong>Civatas</strong> ${en ? "Social Simulation Agent Platform" : "社會模擬代理人平台"} &middot; ${new Date().toLocaleDateString(en ? "en-US" : "zh-TW")}
  </div>
</div>

<script>
const DATA = {
  dailyTrends: ${JSON.stringify(dailyTrends)},
  leaningTrends: ${JSON.stringify(leaningTrends)},
  candidateTrends: ${JSON.stringify(candidateTrends)},
  candidateNames: ${JSON.stringify(candidateNames)},
  history: ${JSON.stringify(history)},
  totalDays: ${totalDays},
};

const EN = ${en};
let playing = false;
let currentDay = 0;
let timer = null;

// Chart defaults
Chart.defaults.color = '#888';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

// Satisfaction & Anxiety chart
const satAnxCtx = document.getElementById('satAnxChart').getContext('2d');
const satAnxChart = new Chart(satAnxCtx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      { label: EN ? 'Local Satisfaction' : '地方滿意度', data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.3 },
      { label: EN ? 'National Satisfaction' : '全國滿意度', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3 },
      { label: EN ? 'Anxiety' : '焦慮度', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3 },
    ]
  },
  options: { scales: { y: { min: 0, max: 100 } }, animation: { duration: 300 } }
});

// Leaning chart
const leanCtx = document.getElementById('leaningChart').getContext('2d');
const leanChart = new Chart(leanCtx, {
  type: 'bar',
  data: {
    labels: [],
    datasets: [
      { label: EN ? 'Dem-leaning' : '民主黨傾向', data: [], backgroundColor: '#3b82f6' },
      { label: EN ? 'Tossup' : '搖擺', data: [], backgroundColor: '#94a3b8' },
      { label: EN ? 'Rep-leaning' : '共和黨傾向', data: [], backgroundColor: '#ef4444' },
    ]
  },
  options: { scales: { y: { min: 0, max: 100 }, x: { stacked: false } }, animation: { duration: 300 } }
});

// Candidate chart (if exists)
let candChart = null;
${candidateNames.length > 0 ? `
const candCtx = document.getElementById('candidateChart').getContext('2d');
const candColors = ['#3b82f6', '#ef4444', '#a855f7', '#f59e0b', '#22c55e', '#f472b6'];
candChart = new Chart(candCtx, {
  type: 'line',
  data: {
    labels: [],
    datasets: DATA.candidateNames.map((name, i) => ({
      label: name,
      data: [],
      borderColor: candColors[i % candColors.length],
      tension: 0.3,
    }))
  },
  options: { scales: { y: { min: 0, max: 1 } }, animation: { duration: 300 } }
});` : ""}

// History chart
const histCtx = document.getElementById('historyChart').getContext('2d');
const histChart = new Chart(histCtx, {
  type: 'line',
  data: {
    labels: DATA.history.map(h => EN ? 'D' + h.global_day : '第' + h.global_day + '天'),
    datasets: [
      { label: EN ? 'Satisfaction' : '滿意度', data: DATA.history.map(h => h.avg_satisfaction), borderColor: '#22c55e', tension: 0.3 },
      { label: EN ? 'Anxiety' : '焦慮度', data: DATA.history.map(h => h.avg_anxiety), borderColor: '#ef4444', tension: 0.3 },
    ]
  },
  options: { scales: { y: { min: 0, max: 100 } } }
});

function updateCharts(day) {
  const d = DATA.dailyTrends[day];
  if (!d) return;

  // Sat/Anx
  satAnxChart.data.labels.push(EN ? 'Day ' + (day+1) : '第'+(day+1)+'天');
  satAnxChart.data.datasets[0].data.push(d.local_satisfaction);
  satAnxChart.data.datasets[1].data.push(d.national_satisfaction);
  satAnxChart.data.datasets[2].data.push(d.anxiety);
  satAnxChart.update();

  // Leaning
  const l = DATA.leaningTrends[day];
  if (l) {
    leanChart.data.labels.push(EN ? 'Day '+(day+1) : '第'+(day+1)+'天');
    leanChart.data.datasets[0].data.push(l.left);
    leanChart.data.datasets[1].data.push(l.center);
    leanChart.data.datasets[2].data.push(l.right);
    leanChart.update();
  }

  // Candidates
  if (candChart && DATA.candidateTrends[day]) {
    const ct = DATA.candidateTrends[day];
    candChart.data.labels.push(EN ? 'Day '+(day+1) : '第'+(day+1)+'天');
    DATA.candidateNames.forEach((name, i) => {
      const key = name.replace(/\\s+/g, '_') + '_awareness';
      candChart.data.datasets[i].data.push(ct[key] ?? 0);
    });
    candChart.update();
  }

  document.getElementById('dayLabel').textContent = EN ? 'Day ' + (day+1) : '第 ' + (day+1) + ' 天';
  document.getElementById('progressFill').style.width = ((day+1)/DATA.totalDays*100) + '%';
}

function togglePlay() {
  if (playing) {
    clearInterval(timer);
    playing = false;
    document.getElementById('playBtn').innerHTML = '&#9654; ' + (EN ? 'Play' : '播放');
  } else {
    if (currentDay >= DATA.totalDays) {
      // Reset
      currentDay = 0;
      satAnxChart.data.labels = [];
      satAnxChart.data.datasets.forEach(ds => ds.data = []);
      leanChart.data.labels = [];
      leanChart.data.datasets.forEach(ds => ds.data = []);
      if (candChart) { candChart.data.labels = []; candChart.data.datasets.forEach(ds => ds.data = []); }
    }
    playing = true;
    document.getElementById('playBtn').innerHTML = '&#9646;&#9646; ' + (EN ? 'Pause' : '暫停');
    const speed = parseInt(document.getElementById('speedSlider').value);
    timer = setInterval(() => {
      if (currentDay >= DATA.totalDays) {
        clearInterval(timer);
        playing = false;
        document.getElementById('playBtn').innerHTML = '&#9654; ' + (EN ? 'Replay' : '重播');
        return;
      }
      updateCharts(currentDay);
      currentDay++;
    }, speed);
  }
}

document.getElementById('speedSlider').addEventListener('input', () => {
  if (playing) {
    clearInterval(timer);
    const speed = parseInt(document.getElementById('speedSlider').value);
    timer = setInterval(() => {
      if (currentDay >= DATA.totalDays) { clearInterval(timer); playing = false; return; }
      updateCharts(currentDay);
      currentDay++;
    }, speed);
  }
});
<\/script>
</body>
</html>`;
}
