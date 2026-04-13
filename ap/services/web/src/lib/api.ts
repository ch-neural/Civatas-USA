// Default to same-origin so /api/* is proxied by Next.js rewrites
// (see next.config.js). Set NEXT_PUBLIC_API_URL only if you need to point
// the browser at a different host.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? window.location.origin
    : "http://localhost:8000");

function buildHeaders(custom?: Record<string, string>, isFormData?: boolean) {
  const h: Record<string, string> = { ...custom };
  if (!isFormData) h["Content-Type"] = "application/json";
  return h;
}

export async function apiFetch(path: string, options?: RequestInit) {
  const isFormData = typeof FormData !== "undefined" && options?.body instanceof FormData;
  const headers = buildHeaders(options?.headers as Record<string, string> | undefined, isFormData);

  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.append("_t", Date.now().toString());

  const res = await fetch(url.toString(), {
    ...options,
    headers,
    cache: "no-store",
  });

  if (!res.ok) {
    let errMsg = `API error: ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) errMsg = body.error;
      else if (body.detail) errMsg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* ignore */ }
    throw new Error(errMsg);
  }
  return res.json();
}

export async function apiUpload(path: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    let msg = `上傳失敗 (${res.status})`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
      else if (body.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* ignore parse error */ }
    throw new Error(msg);
  }
  return res.json();
}

/* ===== Simulation API ===== */

export interface SimulationRequest {
  agent_file: string;
  platform?: string;
  llm_model?: string;
  steps?: number;
  concurrency?: number;
  interview_prompts?: string[];
  interview_sample_ratio?: number;
}

export interface SimulationJob {
  job_id: string;
  status: string;
  agent_file: string;
  platform: string;
  llm_model: string;
  steps: number;
  interview_prompts: string[];
  db_path: string;
  current_step: number;
  total_steps: number;
  agent_count: number;
  interview_count: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
}

export interface InterviewResponse {
  user_id: number;
  prompt: string;
  response: string;
  timestamp: number;
}

export interface AnalyticsResult {
  total_interviews: number;
  interviews: InterviewResponse[];
  summary: Record<string, unknown>;
}

export async function runSimulation(req: SimulationRequest) {
  return apiFetch("/api/pipeline/simulate", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function getSimulationStatus(jobId: string): Promise<SimulationJob> {
  return apiFetch(`/api/pipeline/simulation-status/${jobId}`);
}

export async function getSimulationJobs(): Promise<{ jobs: SimulationJob[] }> {
  return apiFetch("/api/pipeline/simulation-jobs");
}

export async function analyzeResults(dbPath: string): Promise<AnalyticsResult> {
  return apiFetch("/api/pipeline/analyze", {
    method: "POST",
    body: JSON.stringify({ db_path: dbPath }),
  });
}

/* ===== Pipeline API (for agent generation) ===== */

export async function parseTemplate(file: File) {
  return apiUpload("/api/pipeline/upload", file);
}

export async function synthesizePersons(config: Record<string, unknown>) {
  return apiFetch("/api/pipeline/synthesize", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export async function generatePersonas(persons: Record<string, unknown>[]) {
  return apiFetch("/api/pipeline/persona", {
    method: "POST",
    body: JSON.stringify({
      persons,
      strategy: "template",
      locale: "zh-TW",
    }),
  });
}

export async function exportAgents(
  agents: Record<string, unknown>[],
  format = "twitter_csv"
) {
  return apiFetch("/api/pipeline/export", {
    method: "POST",
    body: JSON.stringify({ agents, edges: [], format }),
  });
}

/* ===== Workspace API ===== */

export interface WorkspaceMeta {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  source_count?: number;
  has_synthesis?: boolean;
}

export interface WorkspaceDetail extends WorkspaceMeta {
  sources: {
    id: string;
    filename: string;
    name: string;
    dimension_count: number;
    dimensions: Record<string, any>;
    district_profiles?: Record<string, any>;
  }[];
}

export async function listWorkspaces(): Promise<{ workspaces: WorkspaceMeta[] }> {
  return apiFetch("/api/workspaces");
}

export async function createWorkspace(name: string, purpose: string = "election"): Promise<WorkspaceMeta> {
  return apiFetch("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name, purpose }),
  });
}

export async function getWorkspace(wsId: string): Promise<WorkspaceDetail> {
  return apiFetch(`/api/workspaces/${wsId}`);
}

export async function deleteWorkspace(wsId: string) {
  return apiFetch(`/api/workspaces/${wsId}`, { method: "DELETE" });
}

export async function uploadToWorkspace(wsId: string, file: File) {
  return apiUpload(`/api/workspaces/${wsId}/upload`, file);
}

export async function getPresetSources(): Promise<{ categories: { category: string; presets: { id: string; name: string; filename: string }[] }[] }> {
  return apiFetch("/api/workspaces/preset-sources");
}

export async function getPresetSourceDetail(presetId: string) {
  return apiFetch(`/api/workspaces/preset-sources/${presetId}`);
}

export async function uploadPresetSource(wsId: string, presetId: string) {
  return apiFetch(`/api/workspaces/${wsId}/upload-preset?preset_id=${presetId}`, {
    method: "POST",
  });
}

export async function synthesizeInWorkspace(wsId: string, targetCount: number, filters: Record<string, string[]> = {}, selectedDims?: string[], ageMin?: number, ageMax?: number) {
  return apiFetch(`/api/workspaces/${wsId}/synthesize`, {
    method: "POST",
    body: JSON.stringify({
      target_count: targetCount, filters, selected_dimensions: selectedDims,
      ...(ageMin != null && { age_min: ageMin }),
      ...(ageMax != null && { age_max: ageMax }),
    }),
  });
}

export async function getSynthesisResult(wsId: string) {
  return apiFetch(`/api/workspaces/${wsId}/synthesis-result`);
}

export async function deleteWorkspaceSource(wsId: string, sourceId: string) {
  return apiFetch(`/api/workspaces/${wsId}/sources/${sourceId}`, { method: "DELETE" });
}

export async function generateWorkspacePersonas(wsId: string, strategy: string, concurrency: number = 5) {
  return apiFetch(`/api/workspaces/${wsId}/persona`, {
    method: "POST",
    body: JSON.stringify({ strategy, concurrency }),
  });
}

export async function getWorkspacePersonas(wsId: string) {
  return apiFetch(`/api/workspaces/${wsId}/persona-result`);
}

export async function getPersonaProgress(wsId: string) {
  return apiFetch(`/api/workspaces/${wsId}/persona-progress`);
}

export async function cancelPersonaGeneration(wsId: string) {
  return apiFetch(`/api/workspaces/${wsId}/persona-cancel`, { method: "POST" });
}

/* ===== Persona Snapshots ===== */

export async function savePersonaSnapshot(wsId: string, name: string, description: string = "") {
  return apiFetch(`/api/workspaces/${wsId}/persona-snapshots`, {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
}

export async function listPersonaSnapshots(wsId: string) {
  return apiFetch(`/api/workspaces/${wsId}/persona-snapshots`);
}

export async function loadPersonaSnapshot(wsId: string, snapshotId: string) {
  return apiFetch(`/api/workspaces/${wsId}/persona-snapshots/${snapshotId}/load`, {
    method: "POST",
  });
}

export async function deletePersonaSnapshot(wsId: string, snapshotId: string) {
  return apiFetch(`/api/workspaces/${wsId}/persona-snapshots/${snapshotId}`, {
    method: "DELETE",
  });
}

/* ===== LLM Vendor Config API ===== */

export async function getWorkspaceLLMConfig(wsId: string) {
  return apiFetch(`/api/workspaces/${wsId}/llm-config`);
}

export async function updateWorkspaceLLMConfig(wsId: string, vendors: string[], ratio: string) {
  return apiFetch(`/api/workspaces/${wsId}/llm-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vendors, ratio }),
  });
}

/* ===== LLM Vendors (Evolution) ===== */

export async function getLlmVendors(): Promise<{ vendors: { name: string; available: boolean; model: string; api_key_hint: string }[] }> {
  return apiFetch("/api/pipeline/evolution/llm-vendors");
}

/* ===== Evolution API ===== */

export async function getEvolutionSources() {
  return apiFetch("/api/pipeline/evolution/sources");
}

export async function addEvolutionSource(source: {
  name: string;
  url: string;
  tag?: string;
  selector_title?: string;
  selector_summary?: string;
  max_items?: number;
}) {
  return apiFetch("/api/pipeline/evolution/sources", {
    method: "POST",
    body: JSON.stringify(source),
  });
}

export async function deleteEvolutionSource(sourceId: string) {
  return apiFetch(`/api/pipeline/evolution/sources/${sourceId}`, {
    method: "DELETE",
  });
}

export async function updateEvolutionSource(sourceId: string, updates: { max_items?: number; tag?: string }) {
  return apiFetch(`/api/pipeline/evolution/sources/${sourceId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function triggerCrawl() {
  return apiFetch("/api/pipeline/evolution/crawl", { method: "POST" });
}

export async function getNewsPool() {
  return apiFetch("/api/pipeline/evolution/news-pool");
}

export async function injectNewsArticle(title: string, summary: string, sourceTag?: string) {
  return apiFetch("/api/pipeline/evolution/news-pool/inject", {
    method: "POST",
    body: JSON.stringify({ title, summary, source_tag: sourceTag || "Manual" }),
  });
}

export async function getDietRules() {
  return apiFetch("/api/pipeline/evolution/diet-rules");
}

export async function updateDietRules(rules: Record<string, unknown>) {
  return apiFetch("/api/pipeline/evolution/diet-rules", {
    method: "PUT",
    body: JSON.stringify(rules),
  });
}

export async function previewFeed(agent: Record<string, unknown>) {
  return apiFetch("/api/pipeline/evolution/preview-feed", {
    method: "POST",
    body: JSON.stringify({ agent }),
  });
}

export async function startEvolution(agents: Record<string, unknown>[], days: number, concurrency: number = 5, candidateNames?: string[]) {
  const body: Record<string, unknown> = { agents, days, concurrency };
  if (candidateNames?.length) body.candidate_names = candidateNames;
  return apiFetch("/api/pipeline/evolution/evolve", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getEvolutionStatus(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/evolve/status/${jobId}`);
}

export async function getEvolutionHistory() {
  return apiFetch("/api/pipeline/evolution/evolve/history");
}

export async function getEvolutionJobs() {
  return apiFetch("/api/pipeline/evolution/evolve/jobs");
}

export async function getEvolutionLatest() {
  return apiFetch("/api/pipeline/evolution/evolve/latest");
}

export async function stopEvolution(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/evolve/stop/${jobId}`, { method: "POST" });
}

export async function resetEvolution() {
  return apiFetch("/api/pipeline/evolution/evolve/reset", { method: "POST" });
}

export async function getAgentDiary(agentId: number, recordingId?: string) {
  const q = recordingId ? `?recording_id=${recordingId}` : "";
  return apiFetch(`/api/pipeline/evolution/agents/${agentId}/diary${q}`);
}

export async function getAgentStats(agentId: number) {
  return apiFetch(`/api/pipeline/evolution/agents/${agentId}/stats`);
}

export async function getAllAgentStats() {
  return apiFetch("/api/pipeline/evolution/agents/all-stats");
}

export async function searchAgentMemory(agentId: number, query: string, nResults?: number) {
  return apiFetch("/api/pipeline/evolution/memory/search", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, query, n_results: nResults || 5 }),
  });
}



// ── Stat modules ────────────────────────────────────────────────────

export async function listStatModules() {
  return apiFetch("/api/pipeline/evolution/stat-modules");
}

export async function toggleStatModule(moduleId: string, enabled: boolean) {
  return apiFetch(`/api/pipeline/evolution/stat-modules/${moduleId}/toggle?enabled=${enabled}`, {
    method: "PUT",
  });
}

export async function getStatModule(moduleId: string) {
  return apiFetch(`/api/pipeline/evolution/stat-modules/${moduleId}`);
}

export async function uploadStatModule(files: File[], name: string, description: string, saveAsModule: boolean = true) {
  const form = new FormData();
  for (const f of files) {
    form.append("files", f);
  }
  form.append("name", name);
  form.append("description", description);
  form.append("save_as_module", String(saveAsModule));
  const res = await fetch(`${API_BASE}/api/pipeline/evolution/stat-modules/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    let msg = `上傳失敗 (${res.status})`;
    try { const b = await res.json(); if (b.detail) msg = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail); } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function updateStatModule(moduleId: string, name?: string, description?: string) {
  return apiFetch(`/api/pipeline/evolution/stat-modules/${moduleId}`, {
    method: "PUT",
    body: JSON.stringify({ name, description }),
  });
}

export async function deleteStatModule(moduleId: string) {
  return apiFetch(`/api/pipeline/evolution/stat-modules/${moduleId}`, { method: "DELETE" });
}

/* ===== Snapshots (Calibration → Prediction) ===== */

export async function saveSnapshot(name: string, description?: string, calibrationPackId?: string) {
  return apiFetch("/api/pipeline/evolution/snapshots/save", {
    method: "POST",
    body: JSON.stringify({ name, description: description || "", calibration_pack_id: calibrationPackId }),
  });
}

export async function restoreSnapshot(snapshotId: string) {
  return apiFetch("/api/pipeline/evolution/snapshots/restore", {
    method: "POST",
    body: JSON.stringify({ snapshot_id: snapshotId }),
  });
}

export async function listSnapshots() {
  return apiFetch("/api/pipeline/evolution/snapshots");
}

export async function getSnapshot(snapshotId: string) {
  return apiFetch(`/api/pipeline/evolution/snapshots/${snapshotId}`);
}

export async function getSnapshotAgentIds(snapshotId: string): Promise<{ agent_ids: string[], count: number }> {
  return apiFetch(`/api/pipeline/evolution/snapshots/${snapshotId}/agent-ids`);
}

export async function deleteSnapshot(snapshotId: string) {
  return apiFetch(`/api/pipeline/evolution/snapshots/${snapshotId}`, { method: "DELETE" });
}

export async function getSnapshotStats(snapshotId: string): Promise<{ total: number; candidates: Record<string, number>; avg_satisfaction: number; avg_anxiety: number }> {
  return apiFetch(`/api/pipeline/evolution/snapshots/${snapshotId}/stats`);
}

/* ===== Domain Plugins ===== */

export async function listPlugins() {
  return apiFetch("/api/pipeline/evolution/plugins");
}

export async function getPlugin(pluginId: string) {
  return apiFetch(`/api/pipeline/evolution/plugins/${pluginId}`);
}

/* ===== Calibration Packs ===== */

export async function createCalibrationPack(
  name: string,
  pluginId: string,
  groundTruth: Record<string, unknown>,
  enableKol: boolean = false,
  kolRatio: number = 0.05,
  kolReach: number = 0.40,
  candidateInfo: Record<string, string> = {},
  scoringParams: Record<string, unknown> = {},
  macroContext: string = "",
  electionDate: string = ""
) {
  return apiFetch("/api/pipeline/evolution/calibration/packs", {
    method: "POST",
    body: JSON.stringify({
      name,
      plugin_id: pluginId,
      ground_truth: groundTruth,
      enable_kol: enableKol,
      kol_ratio: kolRatio,
      kol_reach: kolReach,
      candidate_info: candidateInfo,
      scoring_params: scoringParams,
      macro_context: macroContext,
      election_date: electionDate,
    }),
  });
}

export async function listCalibrationPacks() {
  return apiFetch("/api/pipeline/evolution/calibration/packs");
}

export async function getCalibrationPack(packId: string) {
  return apiFetch(`/api/pipeline/evolution/calibration/packs/${packId}`);
}

export async function deleteCalibrationPack(packId: string) {
  return apiFetch(`/api/pipeline/evolution/calibration/packs/${packId}`, { method: "DELETE" });
}

export async function runCalibration(packId: string, agents: any[], concurrency = 5, targetDays = 0, enableKol = false, kolRatio = 0.05, kolReach = 0.40, samplingModality = "unweighted", enabledVendors?: string[]) {
  return apiFetch("/api/pipeline/evolution/calibration/run", {
    method: "POST",
    body: JSON.stringify({ pack_id: packId, agents, concurrency, target_days: targetDays, enable_kol: enableKol, kol_ratio: kolRatio, kol_reach: kolReach, sampling_modality: samplingModality, enabled_vendors: enabledVendors || null }),
  });
}

export async function getCalibrationJobStatus(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/calibration/jobs/${jobId}`);
}

export async function stopCalibrationJob(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/calibration/stop/${jobId}`, { method: "POST" });
}

export async function stopAndSaveCalibrationJob(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/calibration/stop-and-save/${jobId}`, { method: "POST" });
}

export async function pauseCalibrationJob(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/calibration/pause/${jobId}`, { method: "POST" });
}

export async function resumeCalibrationJob(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/calibration/resume/${jobId}`, { method: "POST" });
}

export async function runAutoCalibration(params: {
  pack_ids: string[];
  agents: any[];
  concurrency?: number;
  start_date?: string;
  end_date?: string;
  max_iterations?: number;
  convergence_threshold?: number;
  initial_scoring_params?: Record<string, any>;
  enable_kol?: boolean;
  kol_ratio?: number;
  kol_reach?: number;
  sampling_modality?: string;
  enabled_vendors?: string[];
  sim_time_scale?: number;
}) {
  return apiFetch("/api/pipeline/evolution/calibration/auto-calibrate", {
    method: "POST",
    body: JSON.stringify({
      pack_ids: params.pack_ids,
      agents: params.agents,
      concurrency: params.concurrency || 0,
      start_date: params.start_date || "2023-12-13",
      end_date: params.end_date || "2024-01-13",
      max_iterations: params.max_iterations || 5,
      convergence_threshold: params.convergence_threshold || 1.0,
      initial_scoring_params: params.initial_scoring_params || null,
      enable_kol: params.enable_kol || false,
      kol_ratio: params.kol_ratio || 0.05,
      kol_reach: params.kol_reach || 0.40,
      sampling_modality: params.sampling_modality || "unweighted",
      enabled_vendors: params.enabled_vendors || null,
      sim_time_scale: params.sim_time_scale || 30,
    }),
  });
}

export async function getAutoCalibrationStatus(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/calibration/auto-calibrate/${jobId}`);
}

export async function stopAutoCalibrationJob(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/calibration/auto-calibrate/${jobId}/stop`, { method: "POST" });
}

/* ===== Predictions ===== */

export interface PredictionRecord {
  prediction_id: string;
  question: string;
  snapshot_id: string;
  scenarios: any[];
  scenario_count?: number;
  sim_days: number;
  concurrency: number;
  status: string;
  has_results?: boolean;
  results?: any;
  created_at: number;
}

export async function createPrediction(question: string, snapshotId: string, scenarios: any[], simDays = 30, concurrency = 5, enableKol = false, kolRatio = 0.05, kolReach = 0.40, samplingModality = "unweighted", pollOptions: { name: string, description: string }[] = [], maxChoices = 1, pollGroups: { name: string, candidates: { name: string, description: string }[] }[] = [], scoringParams?: Record<string, any>, macroContext?: string, enabledVendors?: string[], useCalibResultLeaning = true, searchInterval = 0, localKeywords = "", nationalKeywords = "", county = "", startDate = "", endDate = "", predictionMode = "election", enableNewsSearch = true) {
  return apiFetch("/api/pipeline/evolution/predictions", {
    method: "POST",
    body: JSON.stringify({ question, snapshot_id: snapshotId, scenarios, sim_days: simDays, concurrency, enable_kol: enableKol, kol_ratio: kolRatio, kol_reach: kolReach, sampling_modality: samplingModality, poll_options: pollOptions, max_choices: maxChoices, poll_groups: pollGroups, scoring_params: scoringParams, macro_context: macroContext, enabled_vendors: enabledVendors || null, use_calibration_result_leaning: useCalibResultLeaning, search_interval: searchInterval, local_keywords: localKeywords, national_keywords: nationalKeywords, county, start_date: startDate, end_date: endDate, prediction_mode: predictionMode, enable_news_search: enableNewsSearch }),
  });
}

export async function listPredictions(wsId?: string): Promise<{ predictions: PredictionRecord[] }> {
  const url = wsId ? `/api/pipeline/evolution/predictions?ws_id=${wsId}` : "/api/pipeline/evolution/predictions";
  return apiFetch(url);
}

export async function getPrediction(predId: string) {
  return apiFetch(`/api/pipeline/evolution/predictions/${predId}`);
}

export async function deletePrediction(predId: string) {
  return apiFetch(`/api/pipeline/evolution/predictions/${predId}`, { method: "DELETE" });
}

export async function runPrediction(predictionId: string, agents: any[], trackedIds?: string[], recordingId?: string, workspaceId?: string) {
  return apiFetch("/api/pipeline/evolution/predictions/run", {
    method: "POST",
    body: JSON.stringify({ prediction_id: predictionId, agents, tracked_ids: trackedIds, recording_id: recordingId || "", workspace_id: workspaceId || "" }),
  });
}

export async function getPredictionJobStatus(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/predictions/jobs/${jobId}`);
}

export async function analyzePrediction(resultsSummary: string, question: string) {
  return apiFetch("/api/pipeline/evolution/predictions/analyze", {
    method: "POST",
    body: JSON.stringify({ results_summary: resultsSummary, question }),
  });
}

export async function runSatisfactionSurvey(snapshotId: string, personName: string, personRole: string, personParty: string = "") {
  return apiFetch("/api/pipeline/evolution/satisfaction-survey", {
    method: "POST",
    body: JSON.stringify({ snapshot_id: snapshotId, person_name: personName, person_role: personRole, person_party: personParty }),
  });
}

export async function stopPredictionJob(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/predictions/stop/${jobId}`, { method: "POST" });
}

export async function pausePredictionJob(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/predictions/pause/${jobId}`, { method: "POST" });
}

export async function resumePredictionJob(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/predictions/resume/${jobId}`, { method: "POST" });
}

export async function listPredCheckpoints() {
  return apiFetch("/api/pipeline/evolution/predictions/checkpoints");
}

export async function resumePredCheckpoint(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/predictions/resume-checkpoint/${jobId}`, { method: "POST" });
}

/* ===== Rolling Prediction (Primary Election) ===== */

export async function initRollingPrediction(predictionId: string, agents: any[], trackedIds?: string[], useCalibResultLeaning = true) {
  return apiFetch(`/api/pipeline/evolution/predictions/${predictionId}/rolling/init`, {
    method: "POST",
    body: JSON.stringify({ prediction_id: predictionId, agents, tracked_ids: trackedIds, use_calibration_result_leaning: useCalibResultLeaning }),
  });
}

export async function advanceRollingDay(predictionId: string, dailyNews: string, agents: any[]) {
  return apiFetch(`/api/pipeline/evolution/predictions/${predictionId}/rolling/advance`, {
    method: "POST",
    body: JSON.stringify({ prediction_id: predictionId, daily_news: dailyNews, agents }),
  });
}

export async function getRollingHistory(predictionId: string) {
  return apiFetch(`/api/pipeline/evolution/predictions/${predictionId}/rolling/history`);
}



export async function uploadLeaningProfile(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch("/api/pipeline/leaning-profile/upload", {
    method: "POST",
    body: formData,
  });
}

export async function parseLeaningProfile(text: string, imageBase64?: string) {
  return apiFetch("/api/pipeline/parse-leaning-profile", {
    method: "POST",
    body: JSON.stringify({ text, image_base64: imageBase64 || "" }),
  });
}

export async function getLeaningProfile() {
  return apiFetch("/api/pipeline/leaning-profile");
}

export async function deleteLeaningProfile() {
  return apiFetch("/api/pipeline/leaning-profile", { method: "DELETE" });
}

export async function getDefaultLeaningProfiles() {
  return apiFetch("/api/pipeline/leaning-profile/defaults");
}

export async function getDefaultLeaningProfileDetail(filename: string) {
  return apiFetch(`/api/pipeline/leaning-profile/defaults/${encodeURIComponent(filename)}`);
}

export async function applyDefaultLeaningProfile(filename: string) {
  return apiFetch(`/api/pipeline/leaning-profile/defaults/${encodeURIComponent(filename)}`, {
    method: "POST",
  });
}


export async function extractTextFromFile(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch("/api/pipeline/extract-text", {
    method: "POST",
    body: formData,
  });
}

export async function parseElectionData(text: string, imageBase64?: string) {
  return apiFetch("/api/pipeline/parse-election-data", {
    method: "POST",
    body: JSON.stringify({ text, image_base64: imageBase64 || "" }),
  });
}

export async function parseEventsData(text: string, imageBase64?: string, targetDays?: number) {
  return apiFetch("/api/pipeline/parse-events-data", {
    method: "POST",
    body: JSON.stringify({ text, image_base64: imageBase64 || "", target_days: targetDays }),
  });
}


/* ===== Tavily News Research ===== */

export async function tavilyResearch(query: string, startDate: string, endDate: string, maxResults: number = 30) {
  return apiFetch("/api/pipeline/tavily-research", {
    method: "POST",
    body: JSON.stringify({ query, start_date: startDate, end_date: endDate, max_results: maxResults }),
  });
}

export async function socialResearch(query: string, startDate: string, endDate: string, maxResults: number = 20) {
  return apiFetch("/api/pipeline/social-research", {
    method: "POST",
    body: JSON.stringify({ query, start_date: startDate, end_date: endDate, max_results: maxResults }),
  });
}

export async function suggestKeywords(county: string, startDate: string, endDate: string, candidates?: {name: string; party?: string}[]) {
  return apiFetch("/api/pipeline/suggest-keywords", {
    method: "POST",
    body: JSON.stringify({ county, start_date: startDate, end_date: endDate, candidates: candidates || [] }),
  });
}

export async function getUiSettings(wsId: string, panel: string) {
  return apiFetch(`/api/workspaces/${wsId}/ui-settings/${panel}`);
}

export async function saveUiSettings(wsId: string, panel: string, settings: Record<string, any>) {
  return apiFetch(`/api/workspaces/${wsId}/ui-settings/${panel}`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function getEvolutionDashboard(jobId?: string) {
  const q = jobId ? `?job_id=${jobId}` : "";
  return apiFetch(`/api/pipeline/evolution/dashboard${q}`);
}

export async function getNewsCenter(workspaceId?: string) {
  const params = workspaceId ? `?workspace_id=${workspaceId}` : "";
  return apiFetch(`/api/pipeline/evolution/news-center${params}`);
}

export async function getNewsCenterDetail(articleId: string) {
  return apiFetch(`/api/pipeline/evolution/news-center/${articleId}`);
}


/* ===== News Fetch Persistence ===== */

export async function saveNewsFetch(query: string, startDate: string, endDate: string, events: any[], socialEvents?: any[]) {
  return apiFetch("/api/pipeline/evolution/news-fetches", {
    method: "POST",
    body: JSON.stringify({ query, start_date: startDate, end_date: endDate, events, social_events: socialEvents || null }),
  });
}

export async function listNewsFetches() {
  return apiFetch("/api/pipeline/evolution/news-fetches");
}

export async function getNewsFetch(fetchId: string) {
  return apiFetch(`/api/pipeline/evolution/news-fetches/${fetchId}`);
}

export async function deleteNewsFetch(fetchId: string) {
  return apiFetch(`/api/pipeline/evolution/news-fetches/${fetchId}`, { method: "DELETE" });
}

/* ===== Auto Candidate Traits (Wikipedia + LLM) ===== */

export async function autoComputeCandidateTraits(
  candidates: { name: string; description: string; party?: string }[]
) {
  return apiFetch("/api/pipeline/evolution/auto-traits", {
    method: "POST",
    body: JSON.stringify({ candidates }),
  });
}

/* ===== Wikipedia Candidate Profile ===== */

export async function fetchCandidateProfile(name: string, party?: string) {
  return apiFetch("/api/pipeline/evolution/candidate-profile", {
    method: "POST",
    body: JSON.stringify({ name, party: party || "" }),
  });
}

/* ===== Election Database ===== */

export async function checkElectionDb() {
  return apiFetch("/api/pipeline/evolution/election-db/health");
}

export async function listElectionDb(params?: { election_type?: string; scope?: string; min_year?: number; max_year?: number }) {
  const qs = new URLSearchParams();
  if (params?.election_type) qs.set("election_type", params.election_type);
  if (params?.scope) qs.set("scope", params.scope);
  if (params?.min_year) qs.set("min_year", String(params.min_year));
  if (params?.max_year) qs.set("max_year", String(params.max_year));
  const q = qs.toString();
  return apiFetch(`/api/pipeline/evolution/election-db/elections${q ? "?" + q : ""}`);
}

export async function listElectionsByCounty(county: string): Promise<{ elections: any[] }> {
  return apiFetch(`/api/pipeline/evolution/election-db/elections-by-county?county=${encodeURIComponent(county)}`);
}

export async function getElectionGroundTruth(election_type: string, ad_year: number, county: string) {
  return apiFetch(`/api/pipeline/evolution/election-db/ground-truth?election_type=${election_type}&ad_year=${ad_year}&county=${encodeURIComponent(county)}`);
}

export async function getHistoricalTrend(county: string, election_type?: string, min_year?: number) {
  const qs = new URLSearchParams({ county });
  if (election_type) qs.set("election_type", election_type);
  if (min_year) qs.set("min_year", String(min_year));
  return apiFetch(`/api/pipeline/evolution/election-db/historical-trend?${qs}`);
}

export async function getSpectrumSummary(county: string, election_type?: string, ad_year?: number) {
  const qs = new URLSearchParams({ county });
  if (election_type) qs.set("election_type", election_type);
  if (ad_year) qs.set("ad_year", String(ad_year));
  return apiFetch(`/api/pipeline/evolution/election-db/spectrum?${qs}`);
}

export async function getIdentityTrends(year?: number) {
  const q = year ? `?year=${year}` : "";
  return apiFetch(`/api/pipeline/evolution/election-db/identity-trends${q}`);
}

export async function getStanceTrends(year?: number) {
  const q = year ? `?year=${year}` : "";
  return apiFetch(`/api/pipeline/evolution/election-db/stance-trends${q}`);
}

export async function listCensusCounties(ad_year?: number) {
  const q = ad_year ? `?ad_year=${ad_year}` : "";
  return apiFetch(`/api/pipeline/evolution/election-db/census-counties${q}`);
}

export async function applyCensusToWorkspace(wsId: string, county: string, districts?: string[], ad_year?: number, include_dims?: string[]) {
  return apiFetch(`/api/workspaces/${wsId}/apply-census`, {
    method: "POST",
    body: JSON.stringify({ county, districts: districts || null, ad_year: ad_year || 2020, include_dims: include_dims || null }),
  });
}

// Apply a built-in template (e.g. presidential_state_PA) to a workspace as
// its source. Reads the JSON from data/templates/ and seeds the workspace
// dimensions + election block.
export async function applyTemplateToWorkspace(wsId: string, name: string) {
  return apiFetch(`/api/workspaces/${wsId}/apply-template?name=${encodeURIComponent(name)}`, {
    method: "POST",
  });
}

// Enriched template metadata returned by GET /api/templates.
// Templates without an `election` block come back with election=null.
export interface TemplateMeta {
  id: string;
  name: string;
  name_zh?: string | null;
  region?: string | null;
  region_code?: string | null;
  fips?: string | null;          // 2-digit state FIPS
  country: string;
  locale: string;
  election: {
    type: string | null;
    scope: string | null;
    cycle: number | null;
    is_generic: boolean | null;
    candidate_count: number;
  } | null;
  metadata?: Record<string, any> | null;
}

export async function listTemplates(): Promise<{ templates: TemplateMeta[] }> {
  return apiFetch("/api/templates");
}

export async function getTemplate(templateId: string): Promise<any> {
  return apiFetch(`/api/templates/${encodeURIComponent(templateId)}`);
}

// Read runtime country / locale config (always {country: "US", locale: "en"}
// for the Civatas-USA build). Kept for forward compatibility with multi-locale
// support.
export async function getRuntime(): Promise<{ country: string; locale: string }> {
  return apiFetch("/api/runtime");
}

export async function applyElectionLeaningProfile(election_type: string, ad_year: number, county: string) {
  return apiFetch("/api/pipeline/evolution/election-db/apply-leaning-profile", {
    method: "POST",
    body: JSON.stringify({ election_type, ad_year, county }),
  });
}

/* ===== Historical Evolution ===== */

export async function runHistoricalEvolution(params: {
  agents: any[];
  events?: any[];
  sim_days: number;
  concurrency?: number;
  enabled_vendors?: string[];
  macro_context?: string;
  snapshot_name?: string;
  scoring_params?: Record<string, any>;
  search_interval?: number;
  local_keywords?: string;
  national_keywords?: string;
  county?: string;
  start_date?: string;
  end_date?: string;
  recording_id?: string;
  workspace_id?: string;
  tracked_candidates?: { name: string; party?: string; localVisibility?: number; nationalVisibility?: number; originDistricts?: string }[];
  alignment_target?: {
    mode: "election" | "satisfaction";
    election_type?: string;
    ad_year?: number;
    county?: string;
    items?: { name: string; role: string; party: string; satisfaction_pct: number; detailed?: Record<string, number> | null }[];
  } | null;
}) {
  return apiFetch("/api/pipeline/evolution/historical-run", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function getHistoricalRunStatus(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/historical-run/${jobId}`);
}

export async function stopHistoricalRun(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/historical-run/${jobId}/stop`, { method: "POST" });
}

export async function pauseHistoricalRun(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/historical-run/${jobId}/pause`, { method: "POST" });
}

export async function resumeHistoricalRun(jobId: string) {
  return apiFetch(`/api/pipeline/evolution/historical-run/${jobId}/resume`, { method: "POST" });
}

export interface HistoricalCheckpoint {
  job_id: string;
  saved_at: number;
  saved_after_day: number;
  saved_cycle_idx: number;
  total_days: number;
  agent_count: number;
  county: string;
  snapshot_name: string;
  workspace_id: string;
  current_pool_count: number;
  status: string;
}

export async function listHistoricalCheckpoints(): Promise<{ checkpoints: HistoricalCheckpoint[] }> {
  return apiFetch(`/api/pipeline/evolution/historical-run-checkpoints`);
}

export async function listHistoricalRuns(): Promise<{ jobs: any[] }> {
  return apiFetch(`/api/pipeline/evolution/historical-runs`);
}

/* ===== Fast Parameter Calibration ===== */

export async function runFastCalibration(params: {
  target_election: { election_type: string; ad_year: number; county: string };
  training_elections: { election_type: string; ad_year: number; county: string; weight: number }[];
  agents: any[];
  current_params: Record<string, any>;
  candidate_info?: { name: string; description: string }[];
  grid_resolution?: number;
  max_rounds?: number;
}) {
  return apiFetch("/api/pipeline/evolution/calibration/fast", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/* ===== Recording API ===== */

export interface Recording {
  recording_id: string;
  project_name: string;
  title: string;
  description: string;
  type: "evolution" | "prediction";
  is_public: boolean;
  status: "recording" | "completed" | "failed";
  total_steps: number;
  agent_count: number;
  created_at: number;
  completed_at: number | null;
  scenarios?: string[];
}

export async function createRecording(title: string, description: string, recType: string, sourceJobId?: string, projectName?: string) {
  return apiFetch("/api/pipeline/recordings", {
    method: "POST",
    body: JSON.stringify({ title, description, rec_type: recType, source_job_id: sourceJobId || "", project_name: projectName || "" }),
  });
}

export async function listRecordings(): Promise<{ recordings: Recording[] }> {
  return apiFetch("/api/pipeline/recordings");
}

export async function getRecording(recId: string): Promise<Recording> {
  return apiFetch(`/api/pipeline/recordings/${recId}`);
}

export async function updateRecording(recId: string, updates: Partial<Pick<Recording, "title" | "description" | "is_public">>) {
  return apiFetch(`/api/pipeline/recordings/${recId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

export async function deleteRecording(recId: string) {
  return apiFetch(`/api/pipeline/recordings/${recId}`, { method: "DELETE" });
}

/* ===== Public Playback API (no auth) ===== */

const PLAYBACK_BASE = API_BASE;

export async function listPublicRecordings(): Promise<{ recordings: Recording[] }> {
  const res = await fetch(`${PLAYBACK_BASE}/api/playback/list?_t=${Date.now()}`, { cache: "no-store" });
  return res.json();
}

export async function getPublicRecording(recId: string): Promise<Recording> {
  const res = await fetch(`${PLAYBACK_BASE}/api/playback/${recId}?_t=${Date.now()}`, { cache: "no-store" });
  return res.json();
}

export async function getPlaybackSteps(recId: string): Promise<{ steps: any[] }> {
  const res = await fetch(`${PLAYBACK_BASE}/api/playback/${recId}/steps?_t=${Date.now()}`, { cache: "no-store" });
  return res.json();
}
