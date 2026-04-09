"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import GroupedStatsPanel from "@/components/GroupedStatsPanel";
import { useTr } from "@/lib/i18n";
import { StepGate } from "@/components/shared/StepGate";
import { GuideBanner } from "@/components/shared/GuideBanner";
import { useWorkflowStatus } from "@/hooks/use-workflow-status";
import { useShellStore } from "@/store/shell-store";
import { useActiveTemplate } from "@/hooks/use-active-template";
import {
  getDefaultMacroContext,
  getDefaultLocalKeywords,
  getDefaultNationalKeywords,
  getDefaultPollGroups,
  getDefaultCandidates,
  getDefaultCandidateBaseScores,
  getDefaultPredictionQuestion,
  getDefaultCalibParams,
  makePartyColorResolver,
  makePartyIdResolver,
} from "@/lib/template-defaults";

// Stage 1.8.2: heuristic — does this string look like a TW seed default?
// Used to decide whether to replace saved-but-stale macro context / keywords
// when a US template becomes active. Matches TW politicians, parties, and
// distinctively-Taiwanese policy phrases.
const TW_SEED_PATTERNS = /民進黨|國民黨|民眾黨|時代力量|台灣基進|賴清德|蔡英文|盧秀燕|柯文哲|蘇貞昌|蔡其昌|楊瓊瓔|江啟臣|何欣純|林佳龍|台中|台北|高雄|新北|桃園|兩岸|九合一|立法院|行政院/;
function looksLikeTwSeed(s: string | null | undefined): boolean {
  if (!s) return false;
  return TW_SEED_PATTERNS.test(s);
}
import {
  apiFetch,
  listSnapshots,
  listPlugins,
  createPrediction,
  runPrediction,
  getPredictionJobStatus,
  stopPredictionJob,
  pausePredictionJob,
  resumePredictionJob,
  getWorkspacePersonas,
  getWorkspace,
  listPredictions,
  getPrediction,
  deletePrediction,
  resetEvolution,
  tavilyResearch,
  socialResearch,
  fetchCandidateProfile,
  getLlmVendors,
  initRollingPrediction,
  advanceRollingDay,
  getRollingHistory,
  listPredCheckpoints,
  resumePredCheckpoint,
  getSnapshot,
  getSnapshotAgentIds,
  getLeaningProfile,
  analyzePrediction,
  runSatisfactionSurvey,
  autoComputeCandidateTraits,
  getUiSettings,
  saveUiSettings,
} from "@/lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

interface Scenario {
  id: string;
  name: string;
  news: string;
  status: "pending" | "running" | "done";
  results?: any;
}

/* ── Styles ──────────────────────────────────────────────────────── */

const card: React.CSSProperties = {
  background: "linear-gradient(135deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 14,
  padding: "20px 24px",
};

const btn = (primary?: boolean): React.CSSProperties => ({
  padding: "10px 22px",
  borderRadius: 10,
  border: primary ? "none" : "1px solid rgba(255,255,255,0.12)",
  background: primary ? "linear-gradient(135deg, #8b5cf6, #7c3aed)" : "transparent",
  color: primary ? "#fff" : "rgba(255,255,255,0.6)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "var(--font-cjk)",
});

const SCENARIO_COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6"];

const CAND_FALLBACK = ["#8b5cf6", "#ec4899", "#f59e0b", "#94a3b8"];

// US party color palettes — variants for stacking 2+ candidates from the
// same party (primary contests). Generic D/R/I; templates can override via
// election.party_palette.
const PARTY_PALETTES: Record<string, string[]> = {
  D: ["#3b82f6", "#60a5fa", "#1d4ed8", "#93c5fd", "#1e3a8a"],   // blue variants
  R: ["#ef4444", "#f87171", "#b91c1c", "#fca5a5", "#7f1d1d"],   // red variants
  I: ["#a855f7", "#c084fc", "#7e22ce", "#d8b4fe", "#581c87"],   // purple variants
};

// Generic US party detection. The active template's party_detection patterns
// (when present) take precedence — see makePartyIdResolver / makePartyColorResolver.
function detectPartyId(name: string, description: string): string | null {
  const text = `${name} ${description}`.toLowerCase();
  if (text.includes("democrat") || text.includes("(d)") || text.includes("(d-")) return "D";
  if (text.includes("republican") || text.includes("(r)") || text.includes("(r-")) return "R";
  if (text.includes("independent") || text.includes("(i)") || text.includes("(i-") || text.includes("no party")) return "I";
  return null;
}

function detectPartyColor(name: string, description: string): string {
  const pid = detectPartyId(name, description);
  return pid ? PARTY_PALETTES[pid][0] : "";
}

function getCandidateColors(opts: {name: string; description: string}[]): string[] {
  const partyUsageCount: Record<string, number> = {};
  let fi = 0;
  return opts.map(o => {
    const pid = detectPartyId(o.name, o.description);
    if (pid) {
      const idx = partyUsageCount[pid] || 0;
      partyUsageCount[pid] = idx + 1;
      const palette = PARTY_PALETTES[pid];
      return palette[idx % palette.length];
    }
    return CAND_FALLBACK[fi++ % CAND_FALLBACK.length];
  });
}

/* ── Main Component ─────────────────────────────────────────────── */

export default function PredictionPanel({ wsId }: { wsId: string }) {
  const t = useTr();
  const _wsId = useShellStore((s) => s.activeWorkspaceId);
  const workflowStatus = useWorkflowStatus(_wsId);

  // Stage 1.8: read the workspace's active template (US presidential, etc.)
  // and use it to seed defaults instead of TW-hardcoded values.
  const { template: activeTemplate } = useActiveTemplate(wsId);
  const partyColorFromTemplate = useMemo(
    () => makePartyColorResolver(activeTemplate),
    [activeTemplate],
  );
  // Stage 1.8.2: template-aware party-id resolver. Falls back to TW regex
  // when no template is active. Used by the impact-preview block to detect
  // major-party candidates without falling through to the "other" branch.
  const detectPartyIdTemplate = useMemo(
    () => makePartyIdResolver(activeTemplate),
    [activeTemplate],
  );

  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [selectedSnap, setSelectedSnap] = useState<string>("");
  const [question, setQuestion] = useState("");
  const [baseNews, setBaseNews] = useState("");
  const [predEventsData, setPredEventsData] = useState<{ day: number, news: any[] }[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([
    { id: "A", name: t("sandbox.scenario_default_a"), news: "", status: "pending" },
    { id: "B", name: t("sandbox.scenario_default_b"), news: "", status: "pending" },
  ]);

  const [simDays, setSimDays] = useState(30);
  // ── Dynamic news search (cycle mode, same as historical evolution) ──
  const [useDynamicSearch, setUseDynamicSearch] = useState(false);
  const [enableNewsSearch, setEnableNewsSearch] = useState(true);
  const [searchInterval, setSearchInterval] = useState(7);
  const [predLocalKeywords, setPredLocalKeywords] = useState("");
  const [predNationalKeywords, setPredNationalKeywords] = useState("");
  const [predCounty, setPredCounty] = useState("");
  const [predStartDate, setPredStartDate] = useState("");
  const [predEndDate, setPredEndDate] = useState("");
  const [enableKol, setEnableKol] = useState<boolean>(false);
  const [useCalibResultLeaning, setUseCalibResultLeaning] = useState<boolean>(true);
  const [kolRatio, setKolRatio] = useState<number>(0.05);
  const [kolReach, setKolReach] = useState<number>(0.40);
  const [newsImpact, setNewsImpact] = useState<number>(2.0);
  const [deltaCapMult, setDeltaCapMult] = useState<number>(1.5);
  const [baseUndecided, setBaseUndecided] = useState<number>(0.25);
  const [maxUndecided, setMaxUndecided] = useState<number>(0.45);
  // ── Candidate differentiation params ──
  const [profileMatchMult, setProfileMatchMult] = useState<number>(3.0);
  const [keywordBonusCap, setKeywordBonusCap] = useState<number>(10);
  const [anxietySensitivityMult, setAnxietySensitivityMult] = useState<number>(0.15);
  const [anxietyDecay, setAnxietyDecay] = useState<number>(0.05);
  const [satisfactionDecay, setSatisfactionDecay] = useState<number>(0.02);
  const [individualityMult, setIndividualityMult] = useState<number>(1.0);
  const [sentimentMult, setSentimentMult] = useState<number>(0.15);
  // ── Charm & cross-party appeal params ──
  const [charmMult, setCharmMult] = useState<number>(8.0);
  const [crossAppealMult, setCrossAppealMult] = useState<number>(0.6);
  // ── Undecided formula params ──
  const [closeRaceWeight, setCloseRaceWeight] = useState<number>(0.8);
  const [samePartyPenalty, setSamePartyPenalty] = useState<number>(0.06);
  const [noMatchPenalty, setNoMatchPenalty] = useState<number>(0.08);
  const [enableDynamicLeaning, setEnableDynamicLeaning] = useState<boolean>(true);
  const [shiftSatLow, setShiftSatLow] = useState<number>(20);
  const [shiftAnxHigh, setShiftAnxHigh] = useState<number>(80);
  const [shiftDaysReq, setShiftDaysReq] = useState<number>(5);
  const [samplingModality, setSamplingModality] = useState<string>("unweighted");
  const [availableVendors, setAvailableVendors] = useState<{name:string;available:boolean;model:string;api_key_hint:string}[]>([]);
  const [enabledVendors, setEnabledVendors] = useState<Set<string>>(new Set());
  const [pollOptions, setPollOptions] = useState<{id: string, name: string, description: string}[]>([]);
  const [pollGroups, setPollGroups] = useState<{id: string, name: string, weight: number, groupType?: "head2head" | "comparison", agentFilter?: {leanings: string[]}, candidates: {id: string, name: string, description: string, isIncumbent?: boolean, localVisibility?: number, nationalVisibility?: number, originDistricts?: string}[]}[]>([]);
  const [wikiLoadingKey, setWikiLoadingKey] = useState<string | null>(null);
  const [maxChoices, setMaxChoices] = useState<number>(1);
  const [combineMode, setCombineMode] = useState<"independent" | "weighted">("weighted");
  const [predictionMacroContext, setPredictionMacroContext] = useState("");
  const [macroContextGenerating, setMacroContextGenerating] = useState(false);
  // Stage 1.8: when active template loads, seed empty macro context + keyword
  // textareas with template defaults. Skip if user has already typed into them.
  // Stage 1.8.2: ALSO replace any stale TW seed values when a US template
  // becomes active — saved configs from a previous TW workspace would
  // otherwise be carried forward and shown to users who picked a US template.
  useEffect(() => {
    if (!activeTemplate) return;
    const isUs = activeTemplate?.country === "US";
    if (!predictionMacroContext.trim() || (isUs && looksLikeTwSeed(predictionMacroContext))) {
      const def = getDefaultMacroContext(activeTemplate, "en");
      if (def) setPredictionMacroContext(def);
    }
    if (!predLocalKeywords.trim() || (isUs && looksLikeTwSeed(predLocalKeywords))) {
      const local = getDefaultLocalKeywords(activeTemplate);
      if (local) setPredLocalKeywords(local);
    }
    if (!predNationalKeywords.trim() || (isUs && looksLikeTwSeed(predNationalKeywords))) {
      const national = getDefaultNationalKeywords(activeTemplate);
      if (national) setPredNationalKeywords(national);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplate]);

  // Heuristic scoring parameters
  const [scoringParamsOpen, setScoringParamsOpen] = useState(false);
  const [paramWorkspaceTab, setParamWorkspaceTab] = useState<"scoring" | "leaning" | "candidate" | "traits">("scoring");
  const [paramWorkspaceOpen, setParamWorkspaceOpen] = useState(true);
  const [partyBaseScores, setPartyBaseScores] = useState<Record<string, number>>({});
  const [spAlignBonus, setSpAlignBonus] = useState(15);
  const [spIncumbBonus, setSpIncumbBonus] = useState(12);
  const [spDivergenceMult, setSpDivergenceMult] = useState(0.5);
  const [candidateTraits, setCandidateTraits] = useState<Record<string, {loc: number, nat: number, anx: number, charm: number, cross: number}>>({});
  const [autoTraitsLoading, setAutoTraitsLoading] = useState(false);
  const [autoTraitsReasoning, setAutoTraitsReasoning] = useState<Record<string, Record<string, string>>>({});
  const [selectedGroupTab, setSelectedGroupTab] = useState(0);
  const [chartGroupTab, setChartGroupTab] = useState<string>("all"); // "all" or group name

  // Helper: get smart default base score for a party id (D/R/I).
  const getPartyDefault = (party: string): number => {
    const p = party.toLowerCase();
    if (p.includes("democrat") || p === "d" || p.includes("(d)")) return 50;
    if (p.includes("republican") || p === "r" || p.includes("(r)")) return 50;
    if (p.includes("independent") || p === "i" || p.includes("(i)")) return 25;
    return 30;
  };

  // Smart base score computation with breakdown.
  const computeSmartBaseScore = (cand: {name: string; description?: string; isIncumbent?: boolean; localVisibility?: number; nationalVisibility?: number; role?: string; party?: string}): {total: number; breakdown: {label: string; value: number; reason: string}[]} => {
    const desc = cand.description || cand.party || "";
    const breakdown: {label: string; value: number; reason: string}[] = [];

    // 1. Party base (15-40)
    const partyId = detectPartyIdTemplate(cand.name, desc) || detectPartyId(cand.name, desc);
    let partyBase = 30;
    let partyReason = "Unknown / minor party";
    if (partyId === "D" || partyId === "R") {
      partyBase = 35; partyReason = "Major party — strong base support";
    } else if (partyId === "I") {
      partyBase = 18; partyReason = "Independent — no party organization";
    }
    breakdown.push({ label: "Party base", value: partyBase, reason: partyReason });

    // 2. Role / position bonus (0-10)
    const role = (cand.role || "").toLowerCase();
    const descLower = desc.toLowerCase();
    let roleBonus = 0;
    let roleReason = "";
    if (role.includes("president") || descLower.includes("president")) { roleBonus = 10; roleReason = "Head of state, maximum visibility"; }
    else if (role.includes("governor") || descLower.includes("governor")) { roleBonus = 8; roleReason = "State chief executive"; }
    else if (role.includes("senator") || descLower.includes("senator")) { roleBonus = 7; roleReason = "US Senator, national profile"; }
    else if (role.includes("mayor") || descLower.includes("mayor")) { roleBonus = 6; roleReason = "Mayor, local executive"; }
    else if (role.includes("representative") || descLower.includes("congress") || descLower.includes("house of representatives")) { roleBonus = 5; roleReason = "US Representative"; }
    else if (role.includes("state legislature") || descLower.includes("state legislator")) { roleBonus = 3; roleReason = "State legislator"; }
    else if (descLower.includes("candidate")) { roleBonus = 2; roleReason = "Candidate seeking name recognition"; }
    if (roleBonus > 0) breakdown.push({ label: "Role bonus", value: roleBonus, reason: roleReason });

    // 3. Incumbent bonus (0-8)
    let incumbBonus = 0;
    const isIncumbent = !!cand.isIncumbent || /incumbent|sitting/i.test(desc);
    if (isIncumbent) {
      incumbBonus = 8;
      breakdown.push({ label: "Incumbency", value: incumbBonus, reason: "Sitting officeholder — administrative resources & record" });
    }

    // 4. Visibility bonus (-7..+7)
    const locVis = cand.localVisibility ?? 50;
    const natVis = cand.nationalVisibility ?? 50;
    const avgVis = (locVis + natVis) / 2;
    let visBonus = 0;
    if (avgVis !== 50) {
      visBonus = Math.round((avgVis - 50) / 50 * 7);
      if (visBonus !== 0) breakdown.push({ label: "Visibility adj", value: visBonus, reason: `Local ${locVis}% / national ${natVis}%, deviation from median` });
    }

    const total = Math.max(5, Math.min(70, partyBase + roleBonus + incumbBonus + visBonus));
    return { total, breakdown };
  };

  // Reset scoring params to template defaults (or generic US defaults if no template).
  // Called by "Reset to defaults" buttons.
  const resetToTemplateDefaults = () => {
    const cp = activeTemplate?.election?.default_calibration_params || {};
    setNewsImpact(cp.news_impact ?? 2.0);
    setDeltaCapMult(cp.delta_cap_mult ?? 1.5);
    setBaseUndecided(cp.base_undecided ?? 0.10);
    setMaxUndecided(cp.max_undecided ?? 0.45);
    setProfileMatchMult(cp.profile_match_mult ?? 3.0);
    setKeywordBonusCap(cp.stature_cap ?? 10);
    setAnxietySensitivityMult(cp.anxiety_sensitivity_mult ?? 0.15);
    setAnxietyDecay(0.05);
    setSatisfactionDecay(0.02);
    setSentimentMult(cp.sentiment_mult ?? 0.15);
    setIndividualityMult(1.0);
    setCharmMult(cp.charm_mult ?? 8.0);
    setCrossAppealMult(cp.cross_appeal_mult ?? 0.6);
    setCloseRaceWeight(0.8);
    setSamePartyPenalty(0.06);
    setNoMatchPenalty(0.08);
    setSpAlignBonus(cp.party_align_bonus ?? 15);
    setSpIncumbBonus(cp.incumbency_bonus ?? 12);
    setSpDivergenceMult(cp.party_divergence_mult ?? 0.5);
    // Also re-seed party base scores from template
    const seeded = getDefaultCandidateBaseScores(activeTemplate);
    if (Object.keys(seeded).length > 0) setPartyBaseScores(seeded);
    setCandidateTraits({});
  };

  // Auto-tune scoring params based on project context
  const autoTuneParams = async () => {
    // 1. Get survey method from workspace settings
    let surveyMethod = "mobile";
    try {
      const popSettings = await getUiSettings(wsId, "population-setup");
      if (popSettings?.surveyMethod) surveyMethod = popSettings.surveyMethod;
    } catch {}

    // 2. Detect poll structure
    const numGroups = pollGroups.length;
    const allCands = pollGroups.flatMap(g => g.candidates.filter(c => c.name));
    const uniqueNames = new Set(allCands.map(c => c.name));
    const nameFreq: Record<string, number> = {};
    allCands.forEach(c => { nameFreq[c.name] = (nameFreq[c.name] || 0) + 1; });
    const commonOpponent = Object.entries(nameFreq).find(([_, freq]) => freq >= 2)?.[0];
    const isContrastStyle = numGroups >= 2 && !!commonOpponent; // 對比式
    const maxCandsPerGroup = Math.max(...pollGroups.map(g => g.candidates.filter(c => c.name).length), 0);
    const isTwoWay = maxCandsPerGroup === 2; // 兩人對決

    // 3. Detect same-party matchup (US D/R primary)
    const allDescs = allCands.map(c => (c.name + " " + (c.description || "")).toLowerCase());
    const dCount = allDescs.filter(d => d.includes("democrat") || d.includes("(d)")).length;
    const rCount = allDescs.filter(d => d.includes("republican") || d.includes("(r)")).length;
    const isSameParty = (dCount >= 2 && rCount === 0) || (rCount >= 2 && dCount === 0);

    // 4. Detect if any candidate has strong cross-party traits
    const hasCrossPartyCandidate = Object.values(candidateTraits).some(
      (t: any) => (t.cross ?? 20) > 40
    );

    // 5. Apply survey-method-based adjustments
    let baseUndecidedVal = 0.10;
    let maxUndecidedVal = 0.45;
    if (surveyMethod === "phone") {
      baseUndecidedVal = 0.12; // 市話略高（年長者較客氣不直接回答）
      maxUndecidedVal = 0.40;
    } else if (surveyMethod === "mobile") {
      baseUndecidedVal = 0.10; // 手機較直接
      maxUndecidedVal = 0.45;
    } else if (surveyMethod === "online") {
      baseUndecidedVal = 0.08; // 網路最低（自主填答）
      maxUndecidedVal = 0.35;
    } else if (surveyMethod === "street") {
      baseUndecidedVal = 0.15; // 街頭較高（趕時間）
      maxUndecidedVal = 0.50;
    }

    // 6. Apply election-type adjustments
    if (isTwoWay || isContrastStyle) {
      // 兩人對決 / 對比式：不表態率較低（選擇簡單）
      baseUndecidedVal = Math.max(0.05, baseUndecidedVal - 0.03);
    }
    if (predictionMode === "satisfaction") {
      // 滿意度調查：不表態率較高（可以「不知道」）
      baseUndecidedVal = Math.min(0.20, baseUndecidedVal + 0.05);
    }

    // 7. Same-party & cross-party adjustments
    let samePartyVal = isSameParty ? 0.10 : 0.00; // 同黨對決才啟用
    let noMatchVal = isContrastStyle ? 0.05 : 0.08; // 對比式每組都有兩黨，較少無匹配
    let crossAppealVal = hasCrossPartyCandidate ? 0.80 : 0.60; // 有跨黨候選人→放大效果

    // 8. Set all params
    setNewsImpact(2.0);
    setDeltaCapMult(1.5);
    setBaseUndecided(baseUndecidedVal);
    setMaxUndecided(maxUndecidedVal);
    setProfileMatchMult(3.0);
    setKeywordBonusCap(10);
    setAnxietySensitivityMult(0.15);
    setAnxietyDecay(0.05);
    setSatisfactionDecay(0.02);
    setSentimentMult(0.15);
    setIndividualityMult(1.0);
    setCharmMult(8.0);
    setCrossAppealMult(crossAppealVal);
    setCloseRaceWeight(isTwoWay ? 0.5 : 0.8); // 兩人對決時膠著效果降低
    setSamePartyPenalty(samePartyVal);
    setNoMatchPenalty(noMatchVal);

    // 9. Build summary
    const tips: string[] = [];
    tips.push(`調查方式：${{phone:"市話",mobile:"手機",online:"網路",street:"街頭"}[surveyMethod] || surveyMethod}`);
    if (isContrastStyle) tips.push(`Head-to-head poll (common opponent: ${commonOpponent})`);
    if (isTwoWay) tips.push("兩人對決模式");
    if (isSameParty) tips.push("同黨初選 → 同黨懲罰 10%");
    if (hasCrossPartyCandidate) tips.push("Cross-party candidate detected → cross-party appeal boosted to 0.80");
    tips.push(`Base undecided rate: ${(baseUndecidedVal * 100).toFixed(0)}%`);

    alert(`🎯 Parameters auto-tuned for project context:\n\n${tips.join("\n")}`);
  };

  // State for showing auto-compute breakdown
  const [baseScoreBreakdown, setBaseScoreBreakdown] = useState<Record<string, {total: number; breakdown: {label: string; value: number; reason: string}[]}>>({});
  // Backward-compat: derive old comparisonWeight/head2headWeight from new per-group weights
  // Used by results display code that still references these
  const comparisonWeight = combineMode === "weighted" ? (pollGroups[0]?.weight || 50) : 50;
  const head2headWeight = combineMode === "weighted" ? (pollGroups.length > 1 ? pollGroups[pollGroups.length - 1]?.weight || 50 : 50) : 50;
  const [calibOpen, setCalibOpen] = useState(false);
  const [concurrency, setConcurrency] = useState(5);
  const [predAgentMode, setPredAgentMode] = useState<"full" | "sampled">("full");
  const [predSampleRate, setPredSampleRate] = useState(0.2);
  const [running, setRunning] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<any>(null);
  const [predResults, setPredResults] = useState<any>(null);
  const [analysisText, setAnalysisText] = useState<string>("");
  const [recordingId, setRecordingId] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [pastPredictions, setPastPredictions] = useState<any[]>([]);

  // ── Rolling prediction state (primary election mode) ──
  const [rollingMode, setRollingMode] = useState(false);
  const [rollingState, setRollingState] = useState<any>(null); // { current_day, daily_results, ... }
  const [rollingJobId, setRollingJobId] = useState<string | null>(null);
  const [rollingRunning, setRollingRunning] = useState(false);
  const [rollingDailyNews, setRollingDailyNews] = useState("");
  const [rollingPredId, setRollingPredId] = useState<string | null>(null);
  const [backgroundCutoff, setBackgroundCutoff] = useState("2026-03-24");
  const [wsPurpose, setWsPurpose] = useState<string>("");
  const [wsName, setWsName] = useState<string>("");
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const [savedCheckpoint, setSavedCheckpoint] = useState<any>(null);
  const [newsImpactTab, setNewsImpactTab] = useState<string>("");
  // ── Voting-method help popup ──
  const [helpModal, setHelpModal] = useState<"weighted" | "llm" | "contrast" | null>(null);
  // ── Survey mode (滿意度調查) ──
  const [predictionMode, setPredictionMode] = useState<"election" | "satisfaction">("election");
  const [surveyItems, setSurveyItems] = useState<{name: string; role: string; party: string}[]>([
    { name: "", role: "", party: "" },
  ]);
  const [surveyResults, setSurveyResults] = useState<any[]>([]);

  // Stage 1.8.2: when active template loads, seed an empty pollGroups list
  // with the template's declared candidates (e.g. Trump vs Harris for the
  // presidential_2024 template), seed partyBaseScores from the template's
  // party_base_scores map, and seed the prediction question. All three writes
  // use functional setState updates that no-op when the user has already
  // configured the panel, so restoreConfig (running in another effect) can
  // overwrite us with saved workspace state regardless of effect ordering.
  useEffect(() => {
    if (!activeTemplate) return;
    const cands = getDefaultCandidates(activeTemplate);
    if (cands.length === 0) return;

    // 1. pollGroups: seed when no valid candidates, OR fix stale CJK group names
    setPollGroups(prev => {
      const hasValidNames = prev.some(g => g.candidates?.some(c => c.name?.trim()));
      // If groups exist with valid candidates but have CJK names (stale TW data),
      // just rename them to the template default — don't recreate the whole group.
      if (hasValidNames) {
        const hasCjkGroupName = prev.some(g => /[\u4e00-\u9fff]/.test(g.name));
        if (hasCjkGroupName) {
          const newName = getDefaultPollGroups(activeTemplate)[0]?.name || "Likely Voters";
          return prev.map(g => /[\u4e00-\u9fff]/.test(g.name) ? { ...g, name: newName } : g);
        }
        return prev;
      }
      const gid = Date.now().toString();
      const groupName = getDefaultPollGroups(activeTemplate)[0]?.name || "Likely Voters";
      return [{
        id: gid,
        name: groupName,
        weight: 100,
        candidates: cands.map((c, i) => ({
          id: `${gid}_${i}`,
          name: c.name,
          description: c.description || "",
          isIncumbent: !!c.is_incumbent,
          localVisibility: 50,
          nationalVisibility: 50,
          originDistricts: "",
        })),
      }];
    });

    // 2. partyBaseScores: seed only when empty
    setPartyBaseScores(prev => {
      if (prev && Object.keys(prev).length > 0) return prev;
      const seeded = getDefaultCandidateBaseScores(activeTemplate);
      return Object.keys(seeded).length > 0 ? seeded : prev;
    });

    // 3. question: seed only when blank
    setQuestion(prev => {
      if (prev && prev.trim()) return prev;
      return getDefaultPredictionQuestion(activeTemplate) || prev;
    });

    // 4. predictionMode: election templates ALWAYS use election mode, even if
    //    the saved config says "satisfaction" (stale data from a TW workspace).
    if (activeTemplate.election?.type) {
      setPredictionMode("election");
    }

    // 5. ③ Advanced Params: seed from template's default_calibration_params.
    //    Only apply if the values are still at their generic useState defaults
    //    (meaning the user hasn't manually tuned them). We compare against the
    //    hardcoded useState defaults to detect "untouched".
    const cp = activeTemplate.election?.default_calibration_params;
    if (cp) {
      // Scoring params
      if (cp.news_impact != null)             setNewsImpact(prev => prev === 2.0 ? cp.news_impact : prev);
      if (cp.delta_cap_mult != null)          setDeltaCapMult(prev => prev === 1.5 ? cp.delta_cap_mult : prev);
      if (cp.base_undecided != null)          setBaseUndecided(prev => prev === 0.25 ? cp.base_undecided : prev);
      if (cp.max_undecided != null)           setMaxUndecided(prev => prev === 0.45 ? cp.max_undecided : prev);
      if (cp.profile_match_mult != null)      setProfileMatchMult(prev => prev === 3.0 ? cp.profile_match_mult : prev);
      if (cp.anxiety_sensitivity_mult != null) setAnxietySensitivityMult(prev => prev === 0.15 ? cp.anxiety_sensitivity_mult : prev);
      if (cp.charm_mult != null)              setCharmMult(prev => prev === 8.0 ? cp.charm_mult : prev);
      if (cp.cross_appeal_mult != null)       setCrossAppealMult(prev => prev === 0.6 ? cp.cross_appeal_mult : prev);
      if (cp.sentiment_mult != null)          setSentimentMult(prev => prev === 0.15 ? cp.sentiment_mult : prev);
      // Candidate base scores common params
      if (cp.party_align_bonus != null)       setSpAlignBonus(prev => prev === 15 ? cp.party_align_bonus : prev);
      if (cp.incumbency_bonus != null)        setSpIncumbBonus(prev => prev === 12 ? cp.incumbency_bonus : prev);
      if (cp.party_divergence_mult != null)   setSpDivergenceMult(prev => prev === 0.5 ? cp.party_divergence_mult : prev);
    }

    // 6. ① Basic Setup: seed dynamic search mode from template.
    //    NOTE: sim_days for PREDICTION is different from evolution — prediction
    //    only needs 1-5 days for an election forecast (the snapshot already
    //    contains the agents' evolved state). We do NOT import the evolution's
    //    60-day sim_days here.
    const ep = activeTemplate.election?.default_evolution_params;
    if (ep) {
      if (ep.use_dynamic_search != null) setUseDynamicSearch(prev => prev === false ? ep.use_dynamic_search : prev);
      if (ep.search_interval != null)    setSearchInterval(prev => prev === 7 ? ep.search_interval : prev);
      if (ep.concurrency != null)        setConcurrency(prev => prev === 5 ? ep.concurrency : prev);
    }
    // Prediction sim_days: short runs for election mode (measure current state),
    // moderate for satisfaction surveys (observe trend over time).
    const predType = activeTemplate.election?.type;
    if (predType === "presidential" || predType === "senate" || predType === "gubernatorial" || predType === "house") {
      setSimDays(prev => prev === 30 ? 3 : prev);  // 3 days for election prediction
    } else if (predType === "mayoral") {
      setSimDays(prev => prev === 30 ? 5 : prev);  // 5 days for local races
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplate]);

  // ── Helper functions for predEventsData ──
  const handleAddEventDay = () => setPredEventsData([...predEventsData, { day: predEventsData.length + 1, news: [] }]);
  const handleRemoveEventDay = (idx: number) => {
    const newData = [...predEventsData];
    newData.splice(idx, 1);
    newData.forEach((d, i) => d.day = i + 1);
    setPredEventsData(newData);
  };
  const handleAddEventNews = (dIdx: number) => {
    const newData = [...predEventsData];
    newData[dIdx].news.push({ title: "", summary: "", source_tag: "" });
    setPredEventsData(newData);
  };
  const handleRemoveEventNews = (dIdx: number, nIdx: number) => {
    const newData = [...predEventsData];
    newData[dIdx].news.splice(nIdx, 1);
    setPredEventsData(newData);
  };
  const handleEventNewsChange = (dIdx: number, nIdx: number, field: string, val: string) => {
    const newData = [...predEventsData];
    newData[dIdx].news[nIdx][field] = val;
    setPredEventsData(newData);
  };

  // Auto-compute candidate traits handler
  const handleAutoComputeTraits = async (allCandidates: {name: string; description: string}[]) => {
    if (autoTraitsLoading || allCandidates.length === 0) return;
    setAutoTraitsLoading(true);
    try {
      const payload = allCandidates.map(c => ({
        name: c.name,
        description: c.description || "",
        party: detectPartyId(c.name, c.description || "") || "",
      }));
      const res = await autoComputeCandidateTraits(payload);
      const results: any[] = res.results || [];
      const newTraits: Record<string, any> = {};
      const newReasoning: Record<string, Record<string, string>> = {};
      for (const r of results) {
        if (r.name && r.traits && !r.error) {
          newTraits[r.name] = r.traits;
          newReasoning[r.name] = r.reasoning || {};
        }
      }
      setCandidateTraits(prev => ({ ...prev, ...newTraits }));
      setAutoTraitsReasoning(prev => ({ ...prev, ...newReasoning }));
    } catch (e: any) {
      alert("Auto-compute failed: " + (e.message || e));
    } finally {
      setAutoTraitsLoading(false);
    }
  };

  // Auto-trigger trait computation when candidates change and no traits exist yet
  const prevAutoTraitsRef = useRef<string>("");
  useEffect(() => {
    const allCandidates: {name: string; description: string}[] = [];
    if (predictionMode === "satisfaction") {
      surveyItems.filter(s => s.name.trim()).forEach(s => {
        if (!allCandidates.find(x => x.name === s.name)) allCandidates.push({ name: s.name, description: s.party || "" });
      });
    } else {
      pollGroups.forEach(g => g.candidates?.forEach((c: any) => {
        if (!allCandidates.find(x => x.name === c.name)) allCandidates.push(c);
      }));
      if (allCandidates.length === 0 && pollOptions.length > 0) {
        pollOptions.forEach((o: any) => {
          if (!allCandidates.find(x => x.name === o.name)) allCandidates.push(o);
        });
      }
    }
    // Only auto-trigger if: (1) we have candidates, (2) candidate list changed, (3) new names lack traits
    const nameKey = allCandidates.map(c => c.name).sort().join(",");
    if (!nameKey || nameKey === prevAutoTraitsRef.current) return;
    const newNames = allCandidates.filter(c => !candidateTraits[c.name]);
    if (newNames.length === 0) { prevAutoTraitsRef.current = nameKey; return; }
    prevAutoTraitsRef.current = nameKey;
    handleAutoComputeTraits(allCandidates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predictionMode, surveyItems, pollGroups, pollOptions]);

  // Layout states
  const [activeTab, setActiveTab] = useState<"base" | "scenario" | "advanced">("base");
  // Candidate mode: check local state, workspace purpose, OR running job data
  const hasPollGroups = pollGroups.length > 0 && pollGroups.some(g => g.candidates.some(c => c.name));
  const jobHasCandidates = !!(jobStatus?.poll_groups?.length > 0 || (jobStatus?.poll_options || []).length > 0);
  const isCandidateMode = hasPollGroups || pollOptions.filter(o => o.name).length > 0 || wsPurpose === "kmt_primary" || jobHasCandidates;
  const candidateNameList = predictionMode === "satisfaction"
    ? surveyItems.filter(s => s.name.trim()).map(s => s.name)
    : hasPollGroups
      ? Array.from(new Set(pollGroups.flatMap(g => g.candidates.filter(c => c.name).map(c => c.name))))
      : jobHasCandidates && !hasPollGroups
        ? (jobStatus?.poll_groups || []).flatMap((g: any) => (g.candidates || []).map((c: any) => c.name)).filter(Boolean)
        : pollOptions.filter(o => o.name).map(o => o.name);

  // Auto-fetch state (section-level, fills all scenarios)
  const [autoFetchOpen, setAutoFetchOpen] = useState(false);
  const [enableAutoFetch, setEnableAutoFetch] = useState(true);
  const [fetchStartDate, setFetchStartDate] = useState("");
  const [fetchEndDate, setFetchEndDate] = useState("");
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{ step: number; total: number; label: string } | null>(null);
  const [perYearCount, setPerYearCount] = useState(10);
  const [predFetchSocial, setPredFetchSocial] = useState(false);
  const [predFetchQuery, setPredFetchQuery] = useState("");
  const [predFetchNationalQuery, setPredFetchNationalQuery] = useState(
    "台灣 物價;電價;房價;薪資;經濟\n" +
    "兩岸關係;台海;中國軍事;國防\n" +
    "國際 美中關係;全球經濟;AI產業;地緣政治\n" +
    "台灣 賴清德;國會改革;立法院;朝野\n" +
    "賴清德 政績;施政;社會安全網;長照;托育;補助;加薪\n" +
    "民進黨 執政 成果;政策;建設;預算;福利;補貼"
  );
  const [predFetchLocalRatio, setPredFetchLocalRatio] = useState(70);

  // Persona tracking state
  const [personaPanelOpen, setPersonaPanelOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>("");
  const [selectedScenarioIdx, setSelectedScenarioIdx] = useState(0);

  // Live pinned persona tracking
  const [pinnedPersonaIds, setPinnedPersonaIds] = useState<string[]>([]);
  const [pinCategory, setPinCategory] = useState<string>("all");
  const [wsPersonas, setWsPersonas] = useState<any[]>([]);
  const [rawPersonas, setRawPersonas] = useState<any[]>([]);
  const [snapAgentIds, setSnapAgentIds] = useState<Set<string>>(new Set());
  const [snapAlignmentInfo, setSnapAlignmentInfo] = useState<any>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Restore from server (primary) or localStorage (fallback) on mount
  useEffect(() => {
    const restoreConfig = async () => {
      // Try server first, then localStorage
      let cfg: any = null;
      try {
        const serverCfg = await getUiSettings(wsId, "prediction");
        if (serverCfg && typeof serverCfg === "object" && serverCfg.pollGroups) {
          cfg = serverCfg;
          // Also write to localStorage for fast access
          try { localStorage.setItem(`pred_config_${wsId}`, JSON.stringify(serverCfg)); } catch {}
        }
      } catch {}
      if (!cfg) {
        try {
          const saved = localStorage.getItem(`pred_config_${wsId}`);
          if (saved) cfg = JSON.parse(saved);
        } catch {}
      }
      if (cfg) {
      // Apply all config fields
      if (cfg.question) setQuestion(cfg.question);
      if (cfg.selectedSnap) setSelectedSnap(cfg.selectedSnap);
      if (cfg.baseNews) setBaseNews(cfg.baseNews);
      if (cfg.scenarios?.length) setScenarios(cfg.scenarios);
      if (cfg.simDays) setSimDays(cfg.simDays);
      if (cfg.enableKol !== undefined) setEnableKol(cfg.enableKol);
      if (cfg.useCalibResultLeaning !== undefined) setUseCalibResultLeaning(cfg.useCalibResultLeaning);
      if (cfg.kolRatio) setKolRatio(cfg.kolRatio);
      if (cfg.kolReach) setKolReach(cfg.kolReach);
      if (cfg.newsImpact !== undefined) setNewsImpact(cfg.newsImpact);
      if (cfg.deltaCapMult !== undefined) setDeltaCapMult(cfg.deltaCapMult);
      if (cfg.enableDynamicLeaning !== undefined) setEnableDynamicLeaning(cfg.enableDynamicLeaning);
      if (cfg.shiftSatLow !== undefined) setShiftSatLow(cfg.shiftSatLow);
      if (cfg.shiftAnxHigh !== undefined) setShiftAnxHigh(cfg.shiftAnxHigh);
      if (cfg.shiftDaysReq !== undefined) setShiftDaysReq(cfg.shiftDaysReq);
      if (cfg.baseUndecided !== undefined) setBaseUndecided(cfg.baseUndecided);
      if (cfg.maxUndecided !== undefined) setMaxUndecided(cfg.maxUndecided);
      if (cfg.samplingModality) setSamplingModality(cfg.samplingModality);
      if (cfg.pollOptions) setPollOptions(cfg.pollOptions);
      if (cfg.pollGroups) setPollGroups(cfg.pollGroups);
      if (cfg.maxChoices) setMaxChoices(cfg.maxChoices);
      if (cfg.concurrency) setConcurrency(cfg.concurrency);
      if (cfg.pinCategory) setPinCategory(cfg.pinCategory);
      if (cfg.pinnedPersonaIds) setPinnedPersonaIds(cfg.pinnedPersonaIds);
      // Restore macro context / keywords — but skip stale TW seed values.
      // If the saved value contains CJK from a pre-1.9 TW workspace, don't
      // load it; let the template-seeding effect replace it with the English
      // template default on the next render.
      if (cfg.predictionMacroContext && !looksLikeTwSeed(cfg.predictionMacroContext)) setPredictionMacroContext(cfg.predictionMacroContext);
      if (cfg.predFetchQuery && !looksLikeTwSeed(cfg.predFetchQuery)) setPredFetchQuery(cfg.predFetchQuery);
      if (cfg.predFetchNationalQuery && !looksLikeTwSeed(cfg.predFetchNationalQuery)) setPredFetchNationalQuery(cfg.predFetchNationalQuery);
      if (cfg.predFetchLocalRatio !== undefined) setPredFetchLocalRatio(cfg.predFetchLocalRatio);
      if (cfg.predAgentMode) setPredAgentMode(cfg.predAgentMode);
      if (cfg.predSampleRate !== undefined) setPredSampleRate(cfg.predSampleRate);
      if (cfg.partyBaseScores) setPartyBaseScores(cfg.partyBaseScores);
      if (cfg.spAlignBonus !== undefined) setSpAlignBonus(cfg.spAlignBonus);
      if (cfg.spIncumbBonus !== undefined) setSpIncumbBonus(cfg.spIncumbBonus);
      if (cfg.spDivergenceMult !== undefined) setSpDivergenceMult(cfg.spDivergenceMult);
      if (cfg.candidateTraits) setCandidateTraits(cfg.candidateTraits);
      if (cfg.profileMatchMult !== undefined) setProfileMatchMult(cfg.profileMatchMult);
      if (cfg.keywordBonusCap !== undefined) setKeywordBonusCap(cfg.keywordBonusCap);
      if (cfg.anxietySensitivityMult !== undefined) setAnxietySensitivityMult(cfg.anxietySensitivityMult);
      if (cfg.anxietyDecay !== undefined) setAnxietyDecay(cfg.anxietyDecay);
      if (cfg.satisfactionDecay !== undefined) setSatisfactionDecay(cfg.satisfactionDecay);
      if (cfg.individualityMult !== undefined) setIndividualityMult(cfg.individualityMult);
      if (cfg.sentimentMult !== undefined) setSentimentMult(cfg.sentimentMult);
      if (cfg.charmMult !== undefined) setCharmMult(cfg.charmMult);
      if (cfg.crossAppealMult !== undefined) setCrossAppealMult(cfg.crossAppealMult);
      if (cfg.closeRaceWeight !== undefined) setCloseRaceWeight(cfg.closeRaceWeight);
      if (cfg.samePartyPenalty !== undefined) setSamePartyPenalty(cfg.samePartyPenalty);
      if (cfg.noMatchPenalty !== undefined) setNoMatchPenalty(cfg.noMatchPenalty);
      if (cfg.combineMode) setCombineMode(cfg.combineMode);
      if (cfg.useDynamicSearch !== undefined) setUseDynamicSearch(cfg.useDynamicSearch);
      if (cfg.enableNewsSearch !== undefined) setEnableNewsSearch(cfg.enableNewsSearch);
      if (cfg.searchInterval) setSearchInterval(cfg.searchInterval);
      if (cfg.predLocalKeywords && !looksLikeTwSeed(cfg.predLocalKeywords)) setPredLocalKeywords(cfg.predLocalKeywords);
      if (cfg.predNationalKeywords && !looksLikeTwSeed(cfg.predNationalKeywords)) setPredNationalKeywords(cfg.predNationalKeywords);
      if (cfg.predCounty) setPredCounty(cfg.predCounty);
      if (cfg.predStartDate) setPredStartDate(cfg.predStartDate);
      if (cfg.predEndDate) setPredEndDate(cfg.predEndDate);
      // Migrate old pollGroups with groupType to new weight-based model
      if (cfg.pollGroups) {
        const migrated = cfg.pollGroups.map((g: any, i: number) => ({
          ...g,
          weight: g.weight ?? (g.groupType === "head2head" ? 15 : 85),
        }));
        setPollGroups(migrated);
      }

      // Restore prediction mode & survey items
      if (cfg.predictionMode) setPredictionMode(cfg.predictionMode);
      if (cfg.surveyItems?.length) setSurveyItems(cfg.surveyItems);

      // Restore running job status
      if (cfg.jobId) setJobId(cfg.jobId);
      if (cfg.running !== undefined) setRunning(cfg.running);

      // Restore predEventsData or migrate from existing baseNews
      if (cfg.predEventsData && cfg.predEventsData.length > 0) {
        setPredEventsData(cfg.predEventsData);
      } else if (cfg.baseNews) {
        // Auto-migrate legacy baseNews text into structured predEventsData
        const lines = cfg.baseNews.trim().split("\n");
        const items = lines.filter(Boolean).map((line: string) => {
          let title = line;
          let summary = "";
          const dateMatch = line.match(/^\[(.*?)\]\s*(.*)/);
          if (dateMatch) title = dateMatch[2];
          const spl = title.split(" — ");
          if (spl.length > 1) {
            title = spl[0];
            summary = spl.slice(1).join(" — ");
          }
          return { title: title.trim(), summary: summary.trim(), source_tag: "歷史" };
        });

        if (items.length > 0) {
          const n = items.length;
          const target = cfg.simDays || 30;
          const merged: { day: number, news: { title: string, summary: string, source_tag: string }[] }[] = [];
          if (n <= target) {
            for (let d = 0; d < target; d++) merged.push({ day: d + 1, news: [] });
            for (let i = 0; i < n; i++) {
              const dayIdx = Math.floor((i * target) / n);
              merged[dayIdx].news.push(items[i]);
            }
          } else {
            for (let d = 0; d < target; d++) {
              const start = Math.floor((d * n) / target);
              const end = Math.floor(((d + 1) * n) / target);
              const dayNews = items.slice(start, end);
              if (dayNews.length > 0) merged.push({ day: d + 1, news: dayNews });
            }
          }
          setPredEventsData(merged);
        }
      }
      } // end if (cfg)

      // ── Auto-import tracked candidates from historical evolution if pollGroups empty ──
      const restoredGroups = cfg?.pollGroups || [];
      const hasValidCandidates = restoredGroups.some((g: any) =>
        g.candidates?.some((c: any) => c.name?.trim())
      );
      if (!hasValidCandidates) {
        try {
          const evoSettings = await getUiSettings(wsId, "historical-evolution");
          const tc: { name: string; party: string; description: string; localVisibility?: number; nationalVisibility?: number; originDistricts?: string }[] = evoSettings?.trackedCandidates || [];
          const validTc = tc.filter(c => c.name?.trim());
          if (validTc.length > 0) {
            const gid = Date.now().toString();
            setPollGroups([{
              id: gid, name: getDefaultPollGroups(activeTemplate)[0]?.name || "Likely Voters", weight: 100,
              candidates: validTc.map((c, i) => ({
                id: `${gid}_${i}`,
                name: c.name,
                description: c.description || "",
                isIncumbent: false,
                localVisibility: c.localVisibility ?? 50,
                nationalVisibility: c.nationalVisibility ?? 50,
                originDistricts: c.originDistricts || "",
              })),
            }]);
          }
        } catch {}
      }
    };
    restoreConfig();

    // Auto-import shared params from historical evolution (if prediction hasn't been configured yet)
    try {
      const evoSaved = localStorage.getItem(`evo_params_${wsId}`);
      if (evoSaved) {
        const evo = JSON.parse(evoSaved);
        const predSaved = localStorage.getItem(`pred_config_${wsId}`);
        const hasPredConfig = predSaved && JSON.parse(predSaved)?.simDays;
        // Only auto-fill if prediction panel hasn't been independently configured
        // Always sync these shared evolution params
        if (evo.deltaCapMult !== undefined) setDeltaCapMult(evo.deltaCapMult);
        if (evo.macroContext && !hasPredConfig) setPredictionMacroContext(evo.macroContext);
        if (evo.simDays && !hasPredConfig) setSimDays(evo.simDays);
        if (evo.searchInterval && !hasPredConfig) setSearchInterval(evo.searchInterval);
        if (evo.localKeywords && !hasPredConfig) setPredLocalKeywords(evo.localKeywords);
        if (evo.nationalKeywords && !hasPredConfig) setPredNationalKeywords(evo.nationalKeywords);
        if (evo.county && !hasPredConfig) setPredCounty(evo.county);
        if (evo.startDate && !hasPredConfig) setPredStartDate(evo.startDate);
        if (evo.endDate && !hasPredConfig) setPredEndDate(evo.endDate);
        if (evo.searchInterval > 0 && !hasPredConfig) setUseDynamicSearch(true);
      }
    } catch {}

    // Fetch workspace purpose + auto-detect county from personas
    getWorkspace(wsId).then((ws: any) => {
      const purpose = ws?.purpose || "";
      setWsPurpose(purpose);
      setWsName(ws?.name || ws?.workspace_name || "");
    }).catch(() => {}).finally(() => {
      setIsLoaded(true);
    });
    getWorkspacePersonas(wsId).then((personas: any) => {
      const list = personas?.agents || (Array.isArray(personas) ? personas : []);
      if (list.length === 0) return;
      let county = list[0]?.county || "";
      if (!county) {
        const countyPattern = /(臺北市|新北市|桃園市|臺中市|台中市|臺南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|臺東縣|澎湖縣|金門縣|連江縣)/;
        for (const p of list.slice(0, 5)) {
          const m = JSON.stringify(p).match(countyPattern);
          if (m) { county = m[1]; break; }
        }
      }
      if (county) setPredCounty(county);  // Always sync county from workspace data
    }).catch(() => {});
  }, [wsId]);

  // Save changes to localStorage + server (debounced)
  const serverSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    try {
      if (!isLoaded || !wsId || typeof localStorage === "undefined") return;
      const cfg = {
        question, selectedSnap, baseNews, scenarios, simDays, predEventsData,
        enableKol, useCalibResultLeaning, kolRatio, kolReach, newsImpact, deltaCapMult, samplingModality, pollOptions, pollGroups, maxChoices, concurrency,
        enableDynamicLeaning, shiftSatLow, shiftAnxHigh, shiftDaysReq, baseUndecided, maxUndecided,
        profileMatchMult, keywordBonusCap, anxietySensitivityMult,
        anxietyDecay, satisfactionDecay, individualityMult, sentimentMult,
        charmMult, crossAppealMult,
        closeRaceWeight, samePartyPenalty, noMatchPenalty,
        pinCategory, pinnedPersonaIds, predictionMacroContext,
        predFetchQuery, predFetchNationalQuery, predFetchLocalRatio,
        predAgentMode, predSampleRate,
        partyBaseScores, spAlignBonus, spIncumbBonus, spDivergenceMult, candidateTraits,
        combineMode,
        useDynamicSearch, enableNewsSearch, searchInterval, predLocalKeywords, predNationalKeywords, predCounty, predStartDate, predEndDate,
        predictionMode, surveyItems,
        jobId, running
      };
      localStorage.setItem(`pred_config_${wsId}`, JSON.stringify(cfg));
      // Also save to server (debounced — wait 3s after last change)
      if (serverSaveTimer.current) clearTimeout(serverSaveTimer.current);
      serverSaveTimer.current = setTimeout(() => {
        saveUiSettings(wsId, "prediction", cfg).catch(() => {});
      }, 3000);
    } catch {}
  }, [wsId, question, selectedSnap, baseNews, scenarios, simDays, predEventsData, enableKol, useCalibResultLeaning, kolRatio, kolReach, newsImpact, deltaCapMult, enableDynamicLeaning, shiftSatLow, shiftAnxHigh, shiftDaysReq, baseUndecided, maxUndecided, profileMatchMult, keywordBonusCap, anxietySensitivityMult, anxietyDecay, satisfactionDecay, individualityMult, sentimentMult, charmMult, crossAppealMult, closeRaceWeight, samePartyPenalty, noMatchPenalty, samplingModality, pollOptions, pollGroups, maxChoices, concurrency, pinCategory, pinnedPersonaIds, predictionMacroContext, predFetchQuery, predFetchNationalQuery, predFetchLocalRatio, predAgentMode, predSampleRate, partyBaseScores, spAlignBonus, spIncumbBonus, spDivergenceMult, candidateTraits, combineMode, predictionMode, surveyItems, jobId, running]);

  const loadSnapshots = useCallback(async () => {
    try {
      const data = await listSnapshots();
      // Filter snapshots by this workspace
      const wsSnaps = (data.snapshots || []).filter((s: any) => s.workspace_id === wsId);
      setSnapshots(wsSnaps);
      if (wsSnaps.length > 0 && !selectedSnap) {
        setSelectedSnap(wsSnaps[0].snapshot_id);
      }
    } catch (e) { console.error(e); }
  }, [selectedSnap, wsId]);

  // Load snapshot agent IDs when selected snapshot changes
  useEffect(() => {
    if (!selectedSnap) { setSnapAgentIds(new Set()); return; }
    (async () => {
      try {
        const data = await getSnapshotAgentIds(selectedSnap);
        setSnapAgentIds(new Set((data.agent_ids || []).map(String)));
      } catch { setSnapAgentIds(new Set()); }
    })();
  }, [selectedSnap]);

  // Auto-populate from alignment target when selecting an aligned snapshot
  useEffect(() => {
    if (!selectedSnap) { setSnapAlignmentInfo(null); return; }
    (async () => {
      try {
        const snapMeta = await getSnapshot(selectedSnap);
        const at = snapMeta?.alignment_target;
        if (!at || !at.mode) { setSnapAlignmentInfo(null); return; }
        const cp = at.computed_params || {};
        setSnapAlignmentInfo(at);

        if (at.mode === "election") {
          setPredictionMode("election");
          if (cp.candidates?.length) {
            // Only auto-populate if current pollGroups have no valid candidate names
            setPollGroups(prev => {
              const hasValidNames = prev.some(g => g.candidates.some(c => c.name?.trim()));
              if (hasValidNames) return prev;
              const gid = Date.now().toString();
              return [{
                id: gid, name: getDefaultPollGroups(activeTemplate)[0]?.name || "Likely Voters", weight: 100,
                candidates: cp.candidates.map((c: any, i: number) => ({
                  id: `${gid}_${i}`,
                  name: typeof c === "string" ? c : (c.name || ""),
                  description: typeof c === "string" ? "" : (c.description || ""),
                  isIncumbent: typeof c === "string" ? false : (c.isIncumbent || false),
                })),
              }];
            });
          }
          if (cp.party_base_scores) setPartyBaseScores(cp.party_base_scores);
        } else if (at.mode === "satisfaction") {
          setPredictionMode("satisfaction");
          if (cp.survey_items?.length) {
            setSurveyItems(prev => {
              const hasValidNames = prev.some(s => s.name?.trim());
              if (hasValidNames) return prev;
              return cp.survey_items;
            });
          }
          if (cp.party_base_scores) setPartyBaseScores(cp.party_base_scores);
          setEnableAutoFetch(false);  // satisfaction snapshot = pure measurement, no news fetch
        }
      } catch (e) {
        console.warn("Failed to load alignment target from snapshot:", e);
        setSnapAlignmentInfo(null);
      }
    })();
  }, [selectedSnap]);

  // Auto-seed macro context from active template when snapshot is selected
  // and field is still empty. The template carries a locale-aware default
  // macro context (en + zh-TW); we pick the English version.
  useEffect(() => {
    if (!selectedSnap || predictionMacroContext.trim()) return;
    // Use the active template's macro context if available
    if (activeTemplate) {
      const tmplMacro = getDefaultMacroContext(activeTemplate, "en");
      if (tmplMacro) {
        setPredictionMacroContext(tmplMacro);
        return;
      }
    }
    // Fallback: generic US context (no template active)
    setPredictionMacroContext(
      "Federal: The sitting President leads the executive branch; Congress is narrowly divided between the two major parties.\n" +
      "Economy: Voters are focused on inflation, grocery/gas prices, housing costs, and interest rates. Job market is mixed.\n" +
      "State: The Governor and state legislature handle local governance, infrastructure, and education.\n" +
      "Blame: Voters tend to blame the President's party for national economic issues, and the Governor for state-level service failures."
    );
  }, [selectedSnap]); // Only trigger when snapshot changes

  // Active personas = only those in calibration/prediction snapshot
  const activePersonas = useMemo(() => {
    if (snapAgentIds.size === 0) return rawPersonas;
    return rawPersonas.filter((a: any) => snapAgentIds.has(String(a.person_id ?? a.id ?? a.agent_id ?? "")));
  }, [rawPersonas, snapAgentIds]);

  const loadPastPredictions = useCallback(async () => {
    try {
      const data = await listPredictions();
      const all = data.predictions || [];
      // Auto-clean stale pending/running predictions (can't be resumed without checkpoint)
      const stale = all.filter((p: any) => p.status === "pending" || p.status === "running");
      for (const p of stale) {
        try { await deletePrediction(p.prediction_id); } catch {}
      }
      // Filter by this workspace's snapshots
      const wsSnapIds = new Set(snapshots.map((s: any) => s.snapshot_id));
      const wsPreds = all.filter((p: any) => p.status !== "pending" && p.status !== "running" && wsSnapIds.has(p.snapshot_id));
      setPastPredictions(wsPreds);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => {
    loadSnapshots();
    loadPastPredictions();
    getLlmVendors().then(r => { setAvailableVendors(r.vendors || []); setEnabledVendors(new Set(r.vendors.filter((v: any) => v.available).map((v: any) => v.name))); }).catch(() => {});
    // Check for saved prediction checkpoints (from previous restart)
    listPredCheckpoints().then(r => {
      const cps = r.checkpoints || [];
      if (cps.length > 0) setSavedCheckpoint(cps[0]);
    }).catch(() => {});
    // Load workspace personas for pre-selection
    (async () => {
      try {
        const data = await getWorkspacePersonas(wsId);
        const agents = data.agents || data.personas || (Array.isArray(data) ? data : []);
        const list = agents.map((a: any) => {
          const traits = a.traits || [];
          // traits format: ['age', 'gender', 'district', 'education', 'media_habit', 'political_leaning']
          const age = traits[0] || "";
          const gender = traits[1] || "";
          const district = traits[2] || "";
          const leaning = a.political_leaning || "中立";
          const mediaHabit = a.media_habit || "";
          return {
            id: String(a.person_id || 0),
            name: a.name || `Agent ${a.person_id}`,
            category: age && gender ? `${age}歲${gender}` : leaning,
            political_leaning: leaning,
            age, gender, district, media_habit: mediaHabit,
            user_char: a.user_char || a.description || "",
          };
        });
        setWsPersonas(list);
        setRawPersonas(agents);
      } catch {}
    })();
  }, [loadSnapshots, loadPastPredictions, wsId]);

  // Poll job status
  useEffect(() => {
    if (!jobId || !running) return;
    let failCount = 0;
    let isMounted = true;

    const fetchStatus = async () => {
      try {
        const status = await getPredictionJobStatus(jobId);
        if (!isMounted) return;
        failCount = 0;
        setJobStatus(status);
        if (status.status === "completed" || status.status === "failed") {
          setRunning(false);
          if (pollRef.current) clearInterval(pollRef.current);
          if (status.scenario_results) {
            setPredResults(status.scenario_results);
          }
          loadPastPredictions();
          // Auto-run satisfaction survey if in satisfaction mode
          if (status.status === "completed" && predictionMode === "satisfaction") {
            const validItems = surveyItems.filter(s => s.name.trim() && s.role);
            if (validItems.length > 0 && selectedSnap) {
              Promise.all(validItems.map(s => runSatisfactionSurvey(selectedSnap, s.name, s.role, s.party)))
                .then(results => setSurveyResults(results))
                .catch(() => {});
            }
          }
        }
      } catch (e: any) {
        if (!isMounted) return;
        failCount++;
        console.error(e);
        // If job not found (404) or too many consecutive failures, stop polling
        if (failCount >= 3 || (e?.message && e.message.includes("404"))) {
          setRunning(false);
          if (pollRef.current) clearInterval(pollRef.current);
          setJobStatus({ status: "failed", error: "Prediction job lost (service may have restarted). Please re-run the prediction." });
        }
      }
    };

    // Immediate fetch
    fetchStatus();

    pollRef.current = setInterval(fetchStatus, 2000);
    return () => { 
      isMounted = false;
      if (pollRef.current) clearInterval(pollRef.current); 
    };
  }, [jobId, running, loadPastPredictions]);

  // Poll rolling job status (bridge evolution progress)
  const rollingPollRef = useRef<any>(null);
  useEffect(() => {
    if (!rollingJobId || !rollingRunning) return;
    let isMounted = true;

    const fetchRollingStatus = async () => {
      try {
        const status = await getPredictionJobStatus(rollingJobId);
        if (!isMounted) return;
        // Update bridge progress
        setRollingState((prev: any) => ({
          ...(prev || {}),
          bridge_day: status.bridge_day || 0,
          bridge_total: status.bridge_total || prev?.bridge_total || simDays,
          live_messages: status.live_messages || [],
          phase: status.status === "waiting_for_news" ? "rolling" : "bridge",
        }));
        // Bridge complete — fetch full history and transition
        if (status.status === "waiting_for_news" || status.status === "failed") {
          setRollingRunning(false);
          if (rollingPollRef.current) clearInterval(rollingPollRef.current);
          if (status.status === "waiting_for_news" && rollingPredId) {
            try {
              const history = await getRollingHistory(rollingPredId);
              setRollingState({
                current_day: history.current_day || 0,
                daily_results: history.daily_results || [],
                bridge_results: history.bridge_results || [],
                bridge_days: history.bridge_days || 0,
                background_count: history.background_count || 0,
                job_status: "waiting_for_news",
                phase: "rolling",
                live_messages: status.live_messages || [],
              });
            } catch { /* use status data as fallback */ }
          }
        }
      } catch {
        if (!isMounted) return;
      }
    };

    fetchRollingStatus();
    rollingPollRef.current = setInterval(fetchRollingStatus, 3000);
    return () => {
      isMounted = false;
      if (rollingPollRef.current) clearInterval(rollingPollRef.current);
    };
  }, [rollingJobId, rollingRunning, rollingPredId, simDays]);

  const addScenario = () => {
    const id = String.fromCharCode(65 + scenarios.length);
    setScenarios([...scenarios, { id, name: `Scenario ${id}`, news: "", status: "pending" }]);
  };

  const updateScenario = (id: string, field: keyof Scenario, value: string) => {
    setScenarios(scenarios.map(s => s.id === id ? { ...s, [field]: value } : s));
  };

  const removeScenario = (id: string) => {
    if (scenarios.length <= 2) return;
    setScenarios(scenarios.filter(s => s.id !== id));
  };

  const handleAutoFetch = async () => {
    if (!fetchStartDate || !fetchEndDate) {
      alert("Please select a date range");
      return;
    }
    const localQ = predFetchQuery.trim() || question || "台灣政治 選舉 民意";
    const nationalQ = predFetchNationalQuery.trim();
    setFetchLoading(true);
    setFetchProgress(null);
    try {
      const yearStart = new Date(fetchStartDate).getFullYear();
      const yearEnd = new Date(fetchEndDate).getFullYear();
      const numYears = Math.max(1, yearEnd - yearStart + 1);
      const totalMax = perYearCount * numYears;
      const localMax = Math.round(totalMax * predFetchLocalRatio / 100);
      const nationalMax = totalMax - localMax;
      const socialRatio = predFetchSocial ? 0.6 : 1.0;

      // Build step list for progress tracking
      const localKeywords = localQ.split("\n").map((s: string) => s.trim()).filter(Boolean);
      const nationalKeywords = nationalQ ? nationalQ.split("\n").map((s: string) => s.trim()).filter(Boolean) : [];
      const steps: { label: string; pool: string; query: string; max: number }[] = [];
      const localPerKw = Math.max(5, Math.ceil((localMax * socialRatio) / Math.max(1, localKeywords.length)));
      localKeywords.forEach(kw => steps.push({ label: `📍 Local: ${kw.slice(0, 25)}`, pool: "local", query: kw, max: localPerKw }));
      const nationalPerKw = Math.max(5, Math.ceil((nationalMax * socialRatio) / Math.max(1, nationalKeywords.length)));
      nationalKeywords.forEach(kw => steps.push({ label: `🌐 National: ${kw.slice(0, 25)}`, pool: "national", query: kw, max: nationalPerKw }));
      if (predFetchSocial) {
        steps.push({ label: "📱 Social media search", pool: "social", query: [localQ, nationalQ].filter(Boolean).join("\n"), max: Math.ceil(totalMax * 0.4) });
      }
      steps.push({ label: "✨ LLM filtering & summary", pool: "llm", query: "", max: 0 });

      const totalSteps = steps.length;
      let events: any[] = [];
      const seenKeys = new Set<string>();

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        setFetchProgress({ step: i + 1, total: totalSteps, label: step.label });

        let currentEvts: any[] = [];
        if (step.pool === "local" || step.pool === "national") {
          try {
            const data = await tavilyResearch(step.query, fetchStartDate, fetchEndDate, step.max);
            currentEvts = (data.events || []).map((e: any) => ({ ...e, source_type: e.source_type || "news", pool: step.pool }));
          } catch (e) { console.warn(`搜尋失敗 [${step.label}]:`, e); }
        } else if (step.pool === "social") {
          try {
            const socialData = await socialResearch(step.query, fetchStartDate, fetchEndDate, step.max);
            currentEvts = (socialData.events || []).map((e: any) => ({ ...e, source_type: "social", pool: "social" }));
          } catch (e) { console.warn("社群搜尋失敗:", e); }
        }

        // Global deduplication across all steps
        for (const ev of currentEvts) {
          const key = `${ev.date}_${(ev.title || "").slice(0, 15)}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            events.push(ev);
          }
        }
      }

      if (events.length === 0) {
        alert("No relevant news events found. Try adjusting the date range or search topics.");
        setFetchLoading(false);
        setFetchProgress(null);
        return;
      }

      // 3-way interleave (local, national, social) then sort by date within each pool
      const lPool = events.filter((e: any) => e.pool === "local").sort((a: any, b: any) => (a.date || "").localeCompare(b.date || ""));
      const nPool = events.filter((e: any) => e.pool === "national").sort((a: any, b: any) => (a.date || "").localeCompare(b.date || ""));
      const sPool = events.filter((e: any) => e.source_type === "social" || e.source_type === "社群").sort((a: any, b: any) => (a.date || "").localeCompare(b.date || ""));
      const pools = [lPool, nPool, sPool].filter(p => p.length > 0);
      const totalItems = pools.reduce((s, p) => s + p.length, 0);
      const indices = pools.map(() => 0);
      const interleaved: any[] = [];
      for (let i = 0; i < totalItems; i++) {
        let bestPool = -1, bestIdeal = Infinity;
        for (let p = 0; p < pools.length; p++) {
          if (indices[p] >= pools[p].length) continue;
          const ideal = (indices[p] * totalItems) / pools[p].length;
          if (ideal < bestIdeal) { bestIdeal = ideal; bestPool = p; }
        }
        if (bestPool >= 0) interleaved.push(pools[bestPool][indices[bestPool]++]);
      }

      const lCount = lPool.length, nCount = nPool.length, sCount = sPool.length;
      console.log(`📰 預測搜尋完成: 地方=${lCount} 全國=${nCount} 社群=${sCount} 共=${interleaved.length}`);

      // Distribute interleaved news evenly across simDays
      const n = interleaved.length;
      const target = simDays || 30;
      const merged: { day: number, news: { title: string, summary: string, source_tag: string }[] }[] = [];
      
      const mapNewsItem = (item: any) => ({
        title: item.title || "",
        summary: item.summary || "",
        source_tag: item.source_type || "社群"
      });

      if (n <= target) {
        for (let d = 0; d < target; d++) merged.push({ day: d + 1, news: [] });
        for (let i = 0; i < n; i++) {
          const dayIdx = Math.floor((i * target) / n);
          merged[dayIdx].news.push(mapNewsItem(interleaved[i]));
        }
      } else {
        for (let d = 0; d < target; d++) {
          const start = Math.floor((d * n) / target);
          const end = Math.floor(((d + 1) * n) / target);
          const dayNews = interleaved.slice(start, end).map(mapNewsItem);
          if (dayNews.length > 0) merged.push({ day: d + 1, news: dayNews });
        }
      }
      setPredEventsData(merged);

      // We still update baseNews for backward compatibility and passing to the prediction payload
      const newLines = merged.flatMap(d => d.news.map(nItem => `[2026-03-${String(24+d.day).padStart(2,'0')}] ${nItem.title} ${nItem.summary ? `— ${nItem.summary}`:''}`)).join("\n");
      const existing = baseNews.trim();
      setBaseNews(existing ? `${existing}\n${newLines}` : newLines);

      setAutoFetchOpen(false);
      alert(`✅ Fetched ${interleaved.length} news events, distributed across ${target} days (local ${lCount} + national ${nCount} + social ${sCount}).\nFilled into the common baseline.`);
      setActiveTab("scenario");
    } catch (e: any) {
      alert("Auto-fetch failed: " + (e.message || e));
    } finally {
      setFetchLoading(false);
      setFetchProgress(null);
    }
  };

  const handleRunPrediction = async () => {
    if (!selectedSnap) {
      alert("Please select a calibration snapshot first.");
      return;
    }
    if (predictionMode === "election" && pollGroups.length === 0) {
      alert(t("prediction.alert.no_groups"));
      return;
    }
    if (predictionMode === "satisfaction") {
      const validItems = surveyItems.filter(s => s.name.trim() && s.role);
      if (validItems.length === 0) {
        alert("Please add at least one survey subject (name and role required).");
        return;
      }
    }
    setRunning(true);
    setPredResults(null);
    setJobStatus(null);
    try {
      // 0. Auto-reset: clear old evolution state + delete old predictions
      try {
        await resetEvolution();
        const oldPreds = await listPredictions();
        for (const p of (oldPreds.predictions || [])) {
          await deletePrediction(p.prediction_id).catch(() => {});
        }
        setPastPredictions([]);
      } catch (e) { console.warn('Auto-reset warning:', e); }

      // 1. Load workspace personas
      const personasData = await getWorkspacePersonas(wsId);
      const allAgents = personasData.agents || personasData.personas || (Array.isArray(personasData) ? personasData : []);
      if (allAgents.length === 0) {
        alert("This workspace has no personas. Please generate a population first.");
        setRunning(false);
        return;
      }
      // Apply sampling if user chose calibration-matched mode
      let agents = allAgents;
      if (predAgentMode === "sampled" && selectedSnap) {
        try {
          const snapAgents = await getSnapshotAgentIds(selectedSnap);
          const snapIds = snapAgents.agent_ids || [];
          const calibIds = new Set(snapIds.map(String));
          console.log(`[預測] 快照 agent IDs (${calibIds.size} 個), 樣本:`, snapIds.slice(0, 5).map(String));
          console.log(`[預測] Persona IDs 樣本:`, allAgents.slice(0, 5).map((a: any) => ({
            person_id: a.person_id, id: a.id, agent_id: a.agent_id
          })));
          const filtered = allAgents.filter((a: any) => {
            const pid = String(a.person_id ?? a.id ?? a.agent_id ?? "");
            return calibIds.has(pid);
          });
          if (filtered.length > 0) {
            agents = filtered;
            console.log(`[預測] ✅ 成功匹配: ${allAgents.length} → ${filtered.length} 人`);
          } else {
            // Filtering failed — show visible error instead of silent fallback
            const sampleSnap = snapIds.slice(0, 3).map(String).join(", ");
            const samplePersona = allAgents.slice(0, 3).map((a: any) => String(a.person_id ?? a.id ?? "")).join(", ");
            console.error(`[預測] ❌ 0 匹配! 快照 IDs: [${sampleSnap}...], Persona IDs: [${samplePersona}...]`);
            alert(`⚠️ Snapshot agent IDs don't match current personas (snap: ${sampleSnap}…, persona: ${samplePersona}…).\nUsing all ${allAgents.length} agents for prediction.`);
          }
        } catch (e) {
          console.warn("[預測] 無法取得快照 agent ID，使用全量:", e);
          alert(`⚠️ Could not read snapshot agent IDs: ${e}\nUsing all ${allAgents.length} agents for prediction.`);
        }
      }
      // 2. Build single prediction scenario (dynamic search handles news during evolution)
      const mergedScenarios = [{
        id: "default",
        name: "預測",
        news: baseNews.trim() || "",
        events: predEventsData,
      }];
      // 3. Build effective poll groups: convert surveyItems → poll_groups in satisfaction mode
      let enrichedPollGroups: typeof pollGroups;
      if (predictionMode === "satisfaction") {
        // Map surveyItems to a single poll group with proper candidate structure
        const validSurvey = surveyItems.filter(s => s.name.trim());
        const surveyRoleToDesc: Record<string, string> = {
          "總統": "總統、國家元首、中央、全國知名度",
          "行政院長": "院長、行政首長、中央",
          "市長": "市長、現任、執政、市政、市府、地方",
          "縣長": "縣長、現任、執政、縣政、地方",
          "副市長": "副市長、市府、地方",
          "副縣長": "副縣長、縣府、地方",
          "部長": "部長、中央",
          "議長": "議長、議會",
          
          
          
        };
        enrichedPollGroups = [{
          id: "survey_group",
          name: "Satisfaction Survey",
          weight: 100,
          candidates: validSurvey.map((s, i) => ({
            id: `survey_${i}`,
            name: s.name,
            description: [s.party, s.role, surveyRoleToDesc[s.role] || ""].filter(Boolean).join("、"),
            isIncumbent: ["總統", "行政院長", "市長", "縣長"].includes(s.role),
          })),
        }];
      } else {
        // Election mode: enrich pollGroups with executive tags for incumbent candidates
        enrichedPollGroups = pollGroups.map(g => ({
          ...g,
          candidates: g.candidates.map(c => {
            if (!(c as any).isIncumbent) return c;
            let desc = c.description || "";
            if (!desc.includes("現任")) desc += "。市長、現任、執政、市政、市府";
            return { ...c, description: desc };
          }),
        }));
      }
      // 4. Fetch survey method from workspace settings
      let _surveyMethod = "mobile";
      try {
        const popSettings = await getUiSettings(wsId, "population-setup");
        if (popSettings?.surveyMethod) _surveyMethod = popSettings.surveyMethod;
      } catch {}

      // 5. Create prediction
      const scoringParams: Record<string, any> = {
        survey_method: _surveyMethod,
        party_base: { ...partyBaseScores },
        party_align_bonus: spAlignBonus,
        incumbency_bonus: spIncumbBonus,
        party_divergence_mult: spDivergenceMult,
        candidate_traits: Object.keys(candidateTraits).length > 0 ? Object.fromEntries(Object.entries(candidateTraits).map(([k, v]) => [k, {loc: v.loc / 100, nat: v.nat / 100, anx: v.anx / 100, charm: (v.charm ?? 35) / 100, cross: (v.cross ?? 20) / 100}])) : undefined,
        news_impact: newsImpact,
        delta_cap_mult: deltaCapMult,
        base_undecided: baseUndecided,
        max_undecided: maxUndecided,
        profile_match_mult: profileMatchMult,
        keyword_bonus_cap: keywordBonusCap,
        anxiety_sensitivity_mult: anxietySensitivityMult,
        anxiety_decay: anxietyDecay,
        satisfaction_decay: satisfactionDecay,
        sentiment_mult: sentimentMult,
        individuality_multiplier: individualityMult,
        charm_mult: charmMult,
        cross_appeal_mult: crossAppealMult,
        close_race_weight: closeRaceWeight,
        same_party_penalty: samePartyPenalty,
        no_match_penalty: noMatchPenalty,
        enable_dynamic_leaning: enableDynamicLeaning,
        shift_sat_threshold_low: shiftSatLow,
        shift_anx_threshold_high: shiftAnxHigh,
        shift_consecutive_days_req: shiftDaysReq,
        combine_mode: pollGroups.length > 1 ? "weighted" : "independent",
      };
      const autoQuestion = predictionMode === "satisfaction"
        ? "Satisfaction survey: " + surveyItems.filter(s => s.name.trim()).map(s => s.name).join(", ")
        : pollGroups.length > 0
          ? pollGroups.map(g => g.name).join(" / ")
          : "選情預測";
      const result = await createPrediction(autoQuestion, selectedSnap, mergedScenarios, simDays, concurrency, enableKol, kolRatio, kolReach, samplingModality, pollOptions, maxChoices, enrichedPollGroups, scoringParams, predictionMacroContext, undefined, useCalibResultLeaning, useDynamicSearch ? searchInterval : 0, predLocalKeywords, predNationalKeywords, predCounty, predStartDate, predEndDate, predictionMode, enableNewsSearch);
      // 3. Run prediction with user-selected tracked IDs
      const runResult = await runPrediction(result.prediction_id, agents, pinnedPersonaIds.length > 0 ? pinnedPersonaIds : undefined, recordingId, wsId);
      setJobId(runResult.job_id);
    } catch (e: any) {
      alert("Prediction start failed: " + (e.message || e));
      setRunning(false);
    }
  };

  const handleStopPrediction = async () => {
    if (!jobId) return;
    try {
      await stopPredictionJob(jobId);
      setRunning(false);
      setJobStatus((prev: any) => prev ? { ...prev, status: "cancelled", error: "Cancelled by user" } : null);
      if (pollRef.current) clearInterval(pollRef.current);
    } catch (e: any) {
      alert("Cancel failed: " + e.message);
    }
  };

  const handlePausePrediction = async () => {
    if (!jobId) return;
    try {
      await pausePredictionJob(jobId);
      setJobStatus((prev: any) => prev ? { ...prev, status: "paused", live_messages: [...(prev.live_messages || []), {text: "⏸️ Sending pause command..."}] } : null);
    } catch (e: any) {
      alert("Pause failed: " + e.message);
    }
  };

  const handleResumePrediction = async () => {
    if (!jobId) return;
    try {
      await resumePredictionJob(jobId);
      setJobStatus((prev: any) => prev ? { ...prev, status: "running", live_messages: [...(prev.live_messages || []), {text: "▶️ Sending resume command..."}] } : null);
    } catch (e: any) {
      alert("Resume failed: " + e.message);
    }
  };

  const handleResumeFromCheckpoint = async () => {
    if (!savedCheckpoint) return;
    try {
      const result = await resumePredCheckpoint(savedCheckpoint.job_id);
      setJobId(result.job_id);
      setRunning(true);
      setSavedCheckpoint(null);
      setJobStatus({ status: "pending", live_messages: [{ text: `🔄 從斷點繼續預測 (Day ${savedCheckpoint.current_day})...` }] });
    } catch (e: any) {
      alert("Resume failed: " + e.message);
    }
  };

  const handleLoadPastResult = async (predId: string) => {
    try {
      const pred = await getPrediction(predId);
      if (pred.results?.scenario_results) {
        setPredResults(pred.results.scenario_results);
        setQuestion(pred.question || "");
      }
    } catch (e) { console.error(e); }
  };

  /* ── Render ────────────────────────────────────────────────────── */

  const selectedSnapMeta = snapshots.find(s => s.snapshot_id === selectedSnap);

  const renderResultsDashboard = () => {
    if (!predResults || predResults.length === 0) return null;
    const SCENARIO_COLORS_DASH = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6"];
    return (
      <div style={card}>
        <h3 style={{ color: "#fff", fontSize: 16, fontWeight: 700, margin: 0, marginBottom: 12, fontFamily: "var(--font-cjk)" }}>{t("prediction.results.title")}</h3>
        {predResults.map((r: any, ri: number) => {
          const scColor = SCENARIO_COLORS_DASH[ri % SCENARIO_COLORS_DASH.length];
          const dailySummary: any[] = r.daily_summary || [];
          const lastDay = dailySummary[dailySummary.length - 1];
          const liveGE = lastDay?.group_estimates || {};
          const groupsData: [string, any][] = Object.keys(liveGE).length > 0 ? Object.entries(liveGE) : (r.poll_group_results ? Object.entries(r.poll_group_results) : (r.vote_prediction ? [["預測結果", r.vote_prediction]] : []));
          const _dc = (n: string) => { if (n.toLowerCase().includes("republican") || n.includes("(R)")) return "#ef4444"; if (n.toLowerCase().includes("democrat") || n.includes("蔡其昌") || n.includes("民進黨")) return "#22c55e"; if (n.includes("民眾黨") || n.includes("柯文哲")) return "#06b6d4"; if (n.includes("不表態")) return "#6b7280"; return ""; };
          const FB = ["#8b5cf6", "#ec4899", "#f59e0b", "#94a3b8"]; let fbi = 0;
          const gc = (l: string) => _dc(l) || FB[fbi++ % FB.length];
          return (
            <div key={r.scenario_id || ri} style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, padding: "8px 12px", borderRadius: 8, background: `${scColor}10`, borderLeft: `3px solid ${scColor}` }}>
                <span style={{ color: scColor, fontSize: 15, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{r.scenario_name}</span>
                <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>{r.agent_count}  virtual voters · {dailySummary.length}  days simulated</span>
                <span style={{ marginLeft: "auto", color: "#22c55e", fontSize: 11, fontWeight: 600 }}>Satisfaction {r.final_avg_satisfaction}</span>
                <span style={{ color: "#ef4444", fontSize: 11, fontWeight: 600 }}>Anxiety {r.final_avg_anxiety}</span>
              </div>
              {/* Label: distinguish heuristic from LLM results */}
              {r.llm_poll_group_results && Object.keys(r.llm_poll_group_results).length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, fontFamily: "var(--font-cjk)" }}>
                    📊 Weighted poll — heuristic scoring (updated daily)
                  </span>
                  <button
                    onClick={() => setHelpModal("weighted")}
                    style={{
                      width: 16, height: 16, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.2)",
                      background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.5)",
                      fontSize: 9, fontWeight: 700, cursor: "pointer", padding: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                    title="Click to learn how weighted polling is calculated"
                  >ⓘ</button>
                </div>
              )}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                {groupsData.map(([gn, cands], gi) => {
                  // Detect satisfaction mode: values are objects with {percentages, satisfied_total, ...}
                  const firstVal = Object.values(cands).find((v: any) => v && typeof v !== "number");
                  const isSatResult = firstVal && typeof firstVal === "object" && "satisfied_total" in (firstVal as any);

                  if (isSatResult) {
                    // ── Satisfaction mode: 5-level bars per person ──
                    const SAT_LEVELS = [
                      { key: "Very satisfied", color: "#3b82f6" },
                      { key: "Fairly satisfied", color: "#93c5fd" },
                      { key: "Somewhat dissatisfied", color: "#fca5a5" },
                      { key: "Very dissatisfied", color: "#ef4444" },
                      { key: "Undecided", color: "#6b7280" },
                    ];
                    return (
                      <div key={gi} style={{ flex: "1 1 400px", display: "flex", flexDirection: "column", gap: 14 }}>
                        {Object.entries(cands).filter(([k]) => k !== "Undecided" && k !== "不表態").map(([pName, data]: [string, any]) => {
                          const pcts = data.percentages || {};
                          const cColor = detectPartyColor(pName, "") || "#3b82f6";
                          return (
                            <div key={pName} style={{ padding: 14, borderRadius: 12, background: "rgba(255,255,255,0.02)", border: `1px solid ${cColor}25` }}>
                              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                                <span style={{ color: cColor, fontSize: 14, fontWeight: 800, fontFamily: "var(--font-cjk)" }}>{pName}</span>
                                <div style={{ display: "flex", gap: 8 }}>
                                  <span style={{ color: "#3b82f6", fontSize: 12, fontWeight: 700 }}>Satisfied {data.satisfied_total}%</span>
                                  <span style={{ color: "#ef4444", fontSize: 12, fontWeight: 700 }}>Dissatisfied {data.dissatisfied_total}%</span>
                                  <span style={{ color: "#6b7280", fontSize: 11 }}>Undecided {data.undecided_total}%</span>
                                </div>
                              </div>
                              {SAT_LEVELS.map(item => {
                                const pct = pcts[item.key] ?? 0;
                                return (
                                  <div key={item.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                                    <div style={{ width: 70, fontSize: 11, color: "rgba(255,255,255,0.6)", textAlign: "right", fontFamily: "var(--font-cjk)" }}>{item.key}</div>
                                    <div style={{ flex: 1, height: 18, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}>
                                      <div style={{ width: `${pct}%`, height: "100%", background: item.color, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                        {pct > 8 && <span style={{ color: "#fff", fontSize: 9, fontWeight: 700 }}>{pct}%</span>}
                                      </div>
                                    </div>
                                    <div style={{ width: 40, fontSize: 12, color: item.color, fontWeight: 700, textAlign: "right" }}>{pct}%</div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  }

                  // ── Election mode: vote share bars ──
                  const entries = Object.entries(cands).filter(([k]) => k !== "Undecided" && k !== "不表態").sort(([,a]: any, [,b]: any) => b - a);
                  const undecided = (cands as any)["Undecided"] ?? (cands as any)["不表態"] || 0;
                  const winner = entries[0]; const runnerUp = entries[1];
                  const gap = winner && runnerUp ? ((winner[1] as number) - (runnerUp[1] as number)).toFixed(1) : "0";
                  return (
                    <div key={gi} style={{ flex: "1 1 280px", padding: 14, borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: 700, marginBottom: 10, fontFamily: "var(--font-cjk)" }}>🗳️ {gn}</div>
                      {entries.map(([label, pct]: [string, any], ci) => {
                        const barColor = gc(label); const isWinner = ci === 0;
                        const barW = Math.max(3, (pct / Math.max(...entries.map(([,v]: any) => v), 1)) * 100);
                        return (
                          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                            <div style={{ color: barColor, fontSize: 12, width: 70, textAlign: "right", fontFamily: "var(--font-cjk)", fontWeight: isWinner ? 800 : 500 }}>{isWinner && "👑 "}{label}</div>
                            <div style={{ flex: 1, height: 20, background: "rgba(255,255,255,0.04)", borderRadius: 10, overflow: "hidden" }}>
                              <div style={{ width: `${barW}%`, height: "100%", background: `linear-gradient(90deg, ${barColor}80, ${barColor})`, borderRadius: 10, transition: "width 0.5s" }} />
                            </div>
                            <div style={{ color: barColor, fontSize: 15, fontWeight: 800, width: 55, textAlign: "right" }}>{pct}%</div>
                          </div>
                        );
                      })}
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                        <span>📏 Gap: <strong style={{ color: "#f59e0b" }}>{gap}%</strong></span>
                        <span>🤷 Undecided: {typeof undecided === 'number' ? undecided.toFixed(1) : undecided}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* LLM voting results per group (if available) */}
              {r.llm_poll_group_results && Object.keys(r.llm_poll_group_results).length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, fontFamily: "var(--font-cjk)" }}>
                      🗳️ LLM simulated voting results (final day — AI votes as each agent)
                    </span>
                    <button
                      onClick={() => setHelpModal("llm")}
                      style={{
                        width: 16, height: 16, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.2)",
                        background: "rgba(139,92,246,0.08)", color: "#a78bfa",
                        fontSize: 9, fontWeight: 700, cursor: "pointer", padding: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                      title="Click to learn how LLM simulated voting works"
                    >ⓘ</button>
                  </div>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {Object.entries(r.llm_poll_group_results).map(([gn, gr]: [string, any], gi: number) => {
                      const entries = Object.entries(gr).filter(([k]) => k !== "Undecided" && k !== "不表態").sort(([,a]: any, [,b]: any) => {
                        const va = typeof a === "number" ? a : 0;
                        const vb = typeof b === "number" ? b : 0;
                        return vb - va;
                      });
                      const undecided = gr["Undecided"] ?? gr["不表態"] || 0;
                      return (
                        <div key={gi} style={{ flex: "1 1 280px", padding: 12, borderRadius: 10, background: "rgba(139,92,246,0.04)", border: "1px solid rgba(139,92,246,0.15)" }}>
                          <div style={{ color: "#a78bfa", fontSize: 11, fontWeight: 700, marginBottom: 8, fontFamily: "var(--font-cjk)" }}>🗳️ {gn}</div>
                          {entries.map(([label, pct]: [string, any], ci: number) => {
                            const val = typeof pct === "number" ? pct : 0;
                            const maxVal = Math.max(...entries.map(([,v]: any) => typeof v === "number" ? v : 0), 1);
                            const barW = Math.max(3, (val / maxVal) * 100);
                            const isWinner = ci === 0;
                            return (
                              <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                <div style={{ color: isWinner ? "#a78bfa" : "rgba(255,255,255,0.5)", fontSize: 11, width: 80, textAlign: "right", fontFamily: "var(--font-cjk)", fontWeight: isWinner ? 800 : 400 }}>{isWinner && "👑 "}{label}</div>
                                <div style={{ flex: 1, height: 16, background: "rgba(255,255,255,0.04)", borderRadius: 8, overflow: "hidden" }}>
                                  <div style={{ width: `${barW}%`, height: "100%", background: isWinner ? "#a78bfa" : "rgba(139,92,246,0.4)", borderRadius: 8 }} />
                                </div>
                                <div style={{ color: isWinner ? "#a78bfa" : "rgba(255,255,255,0.5)", fontSize: 13, fontWeight: 700, width: 50, textAlign: "right" }}>{val}%</div>
                              </div>
                            );
                          })}
                          {typeof undecided === "number" && undecided > 0 && (
                            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", textAlign: "right", marginTop: 2 }}>Undecided: {undecided.toFixed ? undecided.toFixed(1) : undecided}%</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Contrast-style (對比式) comparison result */}
              {r.contrast_comparison && (() => {
                const cc = r.contrast_comparison;
                // ── Divergence detection: compare 加權民調 winner vs LLM contrast winner ──
                // Compute the per-group winner from poll_group_results (加權, including 不表態)
                // and check if it agrees with cc.recommended (LLM-based contrast).
                const weightedRecommended = (() => {
                  if (!r.poll_group_results || !cc.common_opponent) return null;
                  // For each group, find the challenger margin (challenger - common_opponent)
                  const margins: { challenger: string, margin: number }[] = [];
                  for (const [_gn, gr] of Object.entries(r.poll_group_results) as [string, any][]) {
                    const candNames = Object.keys(gr).filter(k => k !== "Undecided" && k !== "不表態" && k !== cc.common_opponent);
                    const challenger = candNames[0];
                    if (!challenger) continue;
                    const cPct = typeof gr[challenger] === "number" ? gr[challenger] : 0;
                    const oPct = typeof gr[cc.common_opponent] === "number" ? gr[cc.common_opponent] : 0;
                    margins.push({ challenger, margin: cPct - oPct });
                  }
                  margins.sort((a, b) => b.margin - a.margin);
                  return margins[0] || null;
                })();
                const llmRecommendedName = cc.recommended;
                const isDivergent = weightedRecommended && llmRecommendedName && weightedRecommended.challenger !== llmRecommendedName;
                // Also flag large numerical divergence (>10 points difference between methods)
                const llmTopMargin = cc.recommended_margin || 0;
                const weightedTopMargin = weightedRecommended?.margin || 0;
                const marginDiff = Math.abs(llmTopMargin - weightedTopMargin);
                const isMagnitudeDivergent = marginDiff > 10;

                return (
                  <div style={{ padding: 14, borderRadius: 12, background: "rgba(251,191,36,0.04)", border: "1px solid rgba(251,191,36,0.2)", marginBottom: 16 }}>
                    {/* ── Divergence warning banner ── */}
                    {(isDivergent || isMagnitudeDivergent) && (
                      <div style={{
                        marginBottom: 12, padding: "10px 14px", borderRadius: 8,
                        background: isDivergent ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
                        border: `1px solid ${isDivergent ? "rgba(239,68,68,0.3)" : "rgba(245,158,11,0.3)"}`,
                        display: "flex", alignItems: "flex-start", gap: 10,
                      }}>
                        <span style={{ fontSize: 18 }}>{isDivergent ? "⛔" : "⚠️"}</span>
                        <div style={{ flex: 1, fontFamily: "var(--font-cjk)", fontSize: 11, lineHeight: 1.6 }}>
                          <div style={{ color: isDivergent ? "#fca5a5" : "#fcd34d", fontWeight: 700, marginBottom: 4 }}>
                            Two methods {isDivergent ? "recommend different candidates" : "show a large discrepancy"} — interpret with caution
                          </div>
                          <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 10 }}>
                            <span>📊 Weighted poll:</span><strong style={{ color: "#3b82f6" }}>{weightedRecommended?.challenger}</strong>
                            <span>（margin {weightedRecommended && weightedRecommended.margin >= 0 ? "+" : ""}{weightedRecommended?.margin.toFixed(1)}）</span>
                            <span style={{ margin: "0 10px", color: "rgba(255,255,255,0.3)" }}>vs</span>
                            <span>🗳️ LLM vote:</span><strong style={{ color: "#a78bfa" }}>{llmRecommendedName}</strong>
                            <span>（margin {llmTopMargin >= 0 ? "+" : ""}{llmTopMargin}）</span>
                          </div>
                          <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginTop: 4 }}>
                            When the two methods disagree, consider both and the real-world polling context. Click ⓘ for detailed explanation.
                          </div>
                        </div>
                        <button
                          onClick={() => setHelpModal("contrast")}
                          style={{
                            width: 18, height: 18, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.25)",
                            background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)",
                            fontSize: 10, fontWeight: 700, cursor: "pointer", padding: 0,
                            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                          }}
                          title="Click to learn the difference between the two methods"
                        >ⓘ</button>
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 14 }}>⚖️</span>
                      <span style={{ color: "#fbbf24", fontSize: 14, fontWeight: 800, fontFamily: "var(--font-cjk)" }}>Head-to-head poll results (LLM simulated voting)</span>
                      <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 11 }}>Common opponent: {cc.common_opponent}</span>
                      <button
                        onClick={() => setHelpModal("contrast")}
                        style={{
                          width: 16, height: 16, borderRadius: "50%", border: "1px solid rgba(251,191,36,0.3)",
                          background: "rgba(251,191,36,0.08)", color: "#fbbf24",
                          fontSize: 9, fontWeight: 700, cursor: "pointer", padding: 0,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}
                        title="Click to learn about head-to-head polling methodology"
                      >ⓘ</button>
                    </div>
                    <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
                      {(cc.groups || []).map((g: any, gi: number) => {
                        const isWinner = g.challenger === cc.recommended;
                        const marginColor = g.margin > 0 ? "#22c55e" : g.margin < 0 ? "#ef4444" : "#6b7280";
                        return (
                          <div key={gi} style={{ flex: 1, padding: 12, borderRadius: 10, background: isWinner ? "rgba(34,197,94,0.06)" : "rgba(255,255,255,0.02)", border: isWinner ? "2px solid rgba(34,197,94,0.3)" : "1px solid rgba(255,255,255,0.06)" }}>
                            <div style={{ fontSize: 13, fontWeight: 800, color: isWinner ? "#22c55e" : "#fff", fontFamily: "var(--font-cjk)", marginBottom: 6 }}>
                              {isWinner && "👑 "}{g.challenger}
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>
                              <span>{g.challenger}: <strong style={{ color: "#3b82f6" }}>{g.challenger_pct}%</strong></span>
                              <span>{cc.common_opponent}: <strong style={{ color: "#a78bfa" }}>{g.opponent_pct}%</strong></span>
                            </div>
                            <div style={{ fontSize: 20, fontWeight: 900, color: marginColor, textAlign: "center", fontFamily: "var(--font-mono)" }}>
                              {g.margin > 0 ? "+" : ""}{g.margin}%
                            </div>
                            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", textAlign: "center" }}>
                              {g.margin > 0 ? `beats ${cc.common_opponent}` : g.margin < 0 ? `loses to ${cc.common_opponent}` : "tied"}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ textAlign: "center", color: "#fbbf24", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>
                      ✅ Recommended: {cc.recommended} (margin vs {cc.common_opponent} {cc.recommended_margin > 0 ? "+" : ""}{cc.recommended_margin}%）
                    </div>
                  </div>
                );
              })()}

              {dailySummary.length > 1 && (() => {
                const allG: Record<string, Record<string, number[]>> = {};
                dailySummary.forEach((d: any) => { const ge = d.group_estimates || {}; Object.entries(ge).forEach(([gn, c]: [string, any]) => { if (!allG[gn]) allG[gn] = {}; Object.entries(c).forEach(([cn, v]: [string, any]) => { if (cn === "不表態") return; if (!allG[gn][cn]) allG[gn][cn] = []; const num = typeof v === "number" ? v : (v?.satisfied_total ?? 0); allG[gn][cn].push(num); }); }); });
                const gNames = Object.keys(allG); if (gNames.length === 0) return null;
                const W = 600, H = 170, P = { t: 15, r: 60, b: 25, l: 40 }; const cW = W - P.l - P.r; const cH = H - P.t - P.b;
                return (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, fontWeight: 700, marginBottom: 6, fontFamily: "var(--font-cjk)" }}>📈 {predictionMode === "satisfaction" ? "Subject satisfaction trend" : "Candidate support trend by group"}</div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      {gNames.map((gn) => {
                        const cd = allG[gn]; const cns = Object.keys(cd); const mD = Math.max(...cns.map(c => cd[c].length)); fbi = 0;
                        return (
                          <div key={gn} style={{ flex: "1 1 280px" }}>
                            <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 10, marginBottom: 4, fontFamily: "var(--font-cjk)" }}>{gn}</div>
                            <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: "rgba(0,0,0,0.2)", borderRadius: 8 }}>
                              {[0, 25, 50, 75].map(v => (<g key={v}><line x1={P.l} y1={P.t + cH - (v / 75) * cH} x2={W - P.r} y2={P.t + cH - (v / 75) * cH} stroke="rgba(255,255,255,0.06)" /><text x={P.l - 4} y={P.t + cH - (v / 75) * cH + 3} fill="rgba(255,255,255,0.3)" fontSize="9" textAnchor="end">{v}%</text></g>))}
                              {cns.map((cn) => { const vals = cd[cn]; const col = gc(cn); const pts = vals.map((v: number, i: number) => `${P.l + (i / Math.max(1, mD - 1)) * cW},${P.t + cH - (Math.min(v, 75) / 75) * cH}`).join(" "); const lv = vals[vals.length - 1]; const lx = P.l + ((vals.length - 1) / Math.max(1, mD - 1)) * cW; const ly = P.t + cH - (Math.min(lv, 75) / 75) * cH; return (<g key={cn}><polyline points={pts} fill="none" stroke={col} strokeWidth="2" /><circle cx={lx} cy={ly} r="3" fill={col} /><text x={lx + 5} y={ly + 3} fill={col} fontSize="9" fontWeight="700">{cn} {typeof lv === "number" ? lv.toFixed(1) : lv}%</text></g>); })}
                              <text x={P.l} y={H - 5} fill="rgba(255,255,255,0.3)" fontSize="9">Day 1</text>
                              <text x={W - P.r} y={H - 5} fill="rgba(255,255,255,0.3)" fontSize="9" textAnchor="end">Day {mD}</text>
                            </svg>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
              {r.leaning_distribution && Object.keys(r.leaning_distribution).length > 0 && (
                <div style={{ padding: 10, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", marginBottom: 10 }}>
                  <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 10, marginBottom: 6, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🏛️ Political leaning distribution</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {Object.entries(r.leaning_distribution).map(([ln, pct]: [string, any]) => (<div key={ln} style={{ padding: "3px 8px", borderRadius: 6, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.15)", fontSize: 11, color: "rgba(255,255,255,0.6)" }}>{ln}: <strong style={{ color: "#a78bfa" }}>{pct}%</strong></div>))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div style={{ padding: 16, borderRadius: 12, background: "linear-gradient(135deg, rgba(139,92,246,0.05), rgba(59,130,246,0.05))", border: "1px solid rgba(139,92,246,0.15)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <h4 style={{ color: "#a78bfa", fontSize: 14, fontWeight: 700, margin: 0, fontFamily: "var(--font-cjk)" }}>🤖 AI deep analysis report</h4>
            <button onClick={async () => { setAnalysisLoading(true); setAnalysisText(""); try { const summary = (predResults || []).map((r: any) => { let t = `[${r.scenario_name}]\nSimulation days: ${(r.daily_summary || []).length} days, Voters: ${r.agent_count}\nFinal satisfaction: ${r.final_avg_satisfaction}, Anxiety: ${r.final_avg_anxiety}\n`; if (r.poll_group_results) { Object.entries(r.poll_group_results).forEach(([gn, c]: [string, any]) => { t += `\n${gn}:\n`; Object.entries(c).sort(([,a]: any,[,b]: any) => b - a).forEach(([cn, p]: [string, any]) => { t += `  ${cn}: ${p}%\n`; }); }); } const ds = r.daily_summary || []; if (ds.length > 0) { const fd = ds.slice(0, 3); const ld = ds.slice(-3); t += `\nTrend (first 3 → last 3 days):\n`; [...fd, ...ld].forEach((d: any) => { const ge = d.group_estimates || {}; const dp = Object.entries(ge).map(([gn, c]: [string, any]) => { const cs = Object.entries(c).filter(([k]) => k !== "Undecided" && k !== "不表態").map(([k,v]: any) => `${k}:${v}%`).join(" "); return `${gn}: ${cs}`; }).join(" / "); t += `  Day ${d.day}: ${dp}\n`; }); } if (r.leaning_distribution) { t += `\nPolitical leaning: ${Object.entries(r.leaning_distribution).map(([k,v]) => `${k}:${v}%`).join(", ")}\n`; } return t; }).join("\n---\n\n"); const res = await analyzePrediction(summary, question); setAnalysisText(res.analysis || "Unable to generate analysis"); } catch (e: any) { setAnalysisText(`Analysis failed: ${e.message || e}`); } finally { setAnalysisLoading(false); } }} disabled={analysisLoading} style={{ padding: "5px 14px", borderRadius: 6, border: "1px solid rgba(139,92,246,0.3)", background: analysisLoading ? "rgba(139,92,246,0.2)" : "rgba(139,92,246,0.1)", color: "#a78bfa", fontSize: 12, fontWeight: 600, cursor: analysisLoading ? "wait" : "pointer", fontFamily: "var(--font-cjk)" }}>{analysisLoading ? "⏳ Analyzing..." : "🔍 Generate deep analysis"}</button>
          </div>
          {analysisText ? (<div style={{ color: "rgba(255,255,255,0.8)", fontSize: 13, lineHeight: 1.8, whiteSpace: "pre-wrap", fontFamily: "var(--font-cjk)" }}>{analysisText}</div>) : (<div style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, fontFamily: "var(--font-cjk)" }}>Click "Generate deep analysis" — AI will interpret candidate support changes, cross-tabulations, and strategic recommendations from the simulation data.</div>)}
        </div>
      </div>
    );
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

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
      <GuideBanner
        guideKey="guide_prediction"
        title="設定預測情境"
        titleEn="Setup Prediction"
        message="定義民調問題、選擇候選人，並設定預測參數。系統會讓演化後的代理人模擬投票行為。"
        messageEn="Define a poll question, select candidates, and configure the prediction scenario. Evolved agents will simulate voting behavior."
      />
      <div style={{ flex: 1, padding: "16px clamp(16px, 2vw, 32px)", display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <h2 style={{ color: "#fff", fontSize: 20, fontWeight: 700, margin: 0, fontFamily: "var(--font-cjk)" }}>🔮 {t("prediction.title")}</h2>
            {selectedSnapMeta && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ padding: "4px 14px", borderRadius: 20, background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)", color: "#22c55e", fontSize: 12 }}>
                  {t("prediction.based_on", { name: selectedSnapMeta.name })}
                </div>
                {rawPersonas.length > 0 && selectedSnapMeta.agent_count > 0 && (
                  <div style={{ padding: "4px 10px", borderRadius: 20, background: selectedSnapMeta.agent_count < rawPersonas.length ? "rgba(245,158,11,0.1)" : "rgba(34,197,94,0.1)", border: `1px solid ${selectedSnapMeta.agent_count < rawPersonas.length ? "rgba(245,158,11,0.2)" : "rgba(34,197,94,0.2)"}`, color: selectedSnapMeta.agent_count < rawPersonas.length ? "#f59e0b" : "#22c55e", fontSize: 11, fontWeight: 600, fontFamily: "var(--font-cjk)" }}>
                    {t("prediction.calib_count", { used: selectedSnapMeta.agent_count, total: rawPersonas.length, pct: Math.round((selectedSnapMeta.agent_count / rawPersonas.length) * 100) })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Configuration Steps (Hidden while running or showing results) */}
          {(!running || !jobStatus) && !(jobStatus && (jobStatus.status === "completed" || jobStatus.status === "failed") && (jobStatus.current_daily_data?.length > 0 || jobStatus.scenario_results)) && (
            <>
              {/* === 調查類型切換 === */}
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <button onClick={() => setPredictionMode("election")}
                  style={{
                    flex: 1, padding: "10px 16px", borderRadius: 8, cursor: "pointer",
                    border: predictionMode === "election" ? "2px solid #a78bfa" : "1px solid rgba(255,255,255,0.08)",
                    background: predictionMode === "election" ? "rgba(167,139,250,0.12)" : "rgba(255,255,255,0.02)",
                    color: predictionMode === "election" ? "#a78bfa" : "rgba(255,255,255,0.5)",
                    fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)", transition: "all 0.15s",
                  }}>
                  {t("prediction.mode.election")}
                </button>
                <button onClick={() => setPredictionMode("satisfaction")}
                  style={{
                    flex: 1, padding: "10px 16px", borderRadius: 8, cursor: "pointer",
                    border: predictionMode === "satisfaction" ? "2px solid #3b82f6" : "1px solid rgba(255,255,255,0.08)",
                    background: predictionMode === "satisfaction" ? "rgba(59,130,246,0.12)" : "rgba(255,255,255,0.02)",
                    color: predictionMode === "satisfaction" ? "#3b82f6" : "rgba(255,255,255,0.5)",
                    fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)", transition: "all 0.15s",
                  }}>
                  {t("prediction.mode.satisfaction")}
                </button>
              </div>

              {/* === 頂部頁籤切換器 === */}
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <button
                  onClick={() => setActiveTab("base")}
                  style={{ flex: 1, padding: "14px", borderRadius: 10, border: activeTab === "base" ? "1px solid rgba(139,92,246,0.3)" : "1px solid rgba(255,255,255,0.05)", background: activeTab === "base" ? "rgba(139,92,246,0.15)" : "rgba(255,255,255,0.02)", color: activeTab === "base" ? "#fff" : "rgba(255,255,255,0.5)", fontSize: 15, fontWeight: activeTab === "base" ? 700 : 500, cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.2s" }}
                >{t("prediction.tab.base")}</button>
                <button
                  onClick={() => setActiveTab("scenario")}
                  style={{ flex: 1, padding: "14px", borderRadius: 10, border: activeTab === "scenario" ? "1px solid rgba(139,92,246,0.3)" : "1px solid rgba(255,255,255,0.05)", background: activeTab === "scenario" ? "rgba(139,92,246,0.15)" : "rgba(255,255,255,0.02)", color: activeTab === "scenario" ? "#fff" : "rgba(255,255,255,0.5)", fontSize: 15, fontWeight: activeTab === "scenario" ? 700 : 500, cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.2s" }}
                >{predictionMode === "election" ? t("prediction.tab.scenario.election") : t("prediction.tab.scenario.survey")}</button>
                <button
                  onClick={() => setActiveTab("advanced")}
                  style={{ flex: 1, padding: "14px", borderRadius: 10, border: activeTab === "advanced" ? "1px solid rgba(139,92,246,0.3)" : "1px solid rgba(255,255,255,0.05)", background: activeTab === "advanced" ? "rgba(139,92,246,0.15)" : "rgba(255,255,255,0.02)", color: activeTab === "advanced" ? "#fff" : "rgba(255,255,255,0.5)", fontSize: 15, fontWeight: activeTab === "advanced" ? 700 : 500, cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.2s" }}
                >{t("prediction.tab.advanced")}</button>
              </div>

              {/* === 區塊一：基礎設定 === */}
              <div style={{ display: activeTab === "base" ? "block" : "none" }}>
              <div style={card}>
                <h3 style={{ color: "#fff", fontSize: 16, fontWeight: 700, margin: 0, marginBottom: 16, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.title")}</h3>

                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: "block", color: "rgba(255,255,255,0.6)", fontSize: 13, marginBottom: 6, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.snap_label")}</label>
                  {snapshots.length === 0 ? (
                    <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 13, margin: 0 }}>
                      {t("prediction.s1.no_snap")}
                    </p>
                  ) : (
                    <select
                      value={selectedSnap}
                      onChange={(e) => setSelectedSnap(e.target.value)}
                      style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "#fff", fontSize: 13, outline: "none", width: 400 }}
                    >
                      {snapshots.map(s => {
                        const pct = rawPersonas.length > 0 ? Math.round((s.agent_count / rawPersonas.length) * 100) : 100;
                        const isPartial = pct < 100;
                        return (
                          <option key={s.snapshot_id} value={s.snapshot_id} style={{ background: "#1a1a2e", color: "#fff" }}>
                            {s.name} ({s.agent_count} agents{isPartial ? t("prediction.s1.snap.sample_pct", { pct }) : t("prediction.s1.snap.full")}, {new Date(s.created_at * 1000).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })})
                          </option>
                        );
                      })}
                    </select>
                  )}
                </div>

                {/* Dynamic news search toggle */}
                <div style={{ marginTop: 8, padding: 14, borderRadius: 10, border: `1px solid ${useDynamicSearch ? "rgba(168,85,247,0.4)" : "rgba(255,255,255,0.08)"}`, background: useDynamicSearch ? "rgba(168,85,247,0.06)" : "rgba(255,255,255,0.02)" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: useDynamicSearch ? 12 : 0 }}>
                    <input type="checkbox" checked={useDynamicSearch} onChange={e => setUseDynamicSearch(e.target.checked)} style={{ accentColor: "#a855f7" }} />
                    <span style={{ color: useDynamicSearch ? "#c084fc" : "rgba(255,255,255,0.6)", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>
                      {t("prediction.s1.dyn.title")}
                    </span>
                    <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "var(--font-cjk)" }}>
                      {useDynamicSearch ? t("prediction.s1.dyn.on_desc", { days: searchInterval }) : t("prediction.s1.dyn.off_desc")}
                    </span>
                  </label>
                  {useDynamicSearch && (
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 10, paddingLeft: 22 }}>
                      <input type="checkbox" checked={enableNewsSearch} onChange={e => setEnableNewsSearch(e.target.checked)} style={{ accentColor: enableNewsSearch ? "#22c55e" : "#94a3b8" }} />
                      <span style={{ color: enableNewsSearch ? "#86efac" : "rgba(255,255,255,0.5)", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-cjk)" }}>
                        {enableNewsSearch ? t("prediction.s1.news.enabled") : t("prediction.s1.news.disabled")}
                      </span>
                      <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "var(--font-cjk)" }}>
                        {enableNewsSearch ? t("prediction.s1.news.enabled_desc") : t("prediction.s1.news.disabled_desc")}
                      </span>
                    </label>
                  )}
                  {useDynamicSearch && enableNewsSearch && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                        <div>
                          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 3, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.search_interval")}</div>
                          <input type="number" min={1} max={30} value={searchInterval} onChange={e => setSearchInterval(Math.max(1, Number(e.target.value)))}
                            style={{ width: 60, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(168,85,247,0.2)", background: "rgba(0,0,0,0.3)", color: "#a855f7", fontSize: 12, textAlign: "center" }} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 3, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.county")}</div>
                          <input type="text" value={predCounty} onChange={e => setPredCounty(e.target.value)} placeholder={t("prediction.s1.county_placeholder")}
                            style={{ width: 90, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 12, fontFamily: "var(--font-cjk)" }} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 3, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.start_date")}</div>
                          <input type="date" value={predStartDate} onChange={e => setPredStartDate(e.target.value)}
                            style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 11 }} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 3, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.end_date")}</div>
                          <input type="date" value={predEndDate} onChange={e => setPredEndDate(e.target.value)}
                            style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 11 }} />
                        </div>
                        {/* ── Time compression display ── */}
                        {(() => {
                          if (!predStartDate || !predEndDate) return null;
                          const days = Math.ceil((new Date(predEndDate).getTime() - new Date(predStartDate).getTime()) / 86400000);
                          if (days <= 0 || simDays <= 0) return null;
                          const ratio = days / simDays;
                          const realPerSim = Math.round(ratio);
                          const label = ratio > 1.05 ? t("prediction.s1.compression.compressed", { ratio: ratio.toFixed(1) })
                            : ratio < 0.95 ? t("prediction.s1.compression.expanded", { ratio: (1/ratio).toFixed(1) })
                            : t("prediction.s1.compression.aligned");
                          const color = ratio > 30 ? "#ef4444"
                            : ratio > 15 ? "#f59e0b"
                            : ratio > 1.05 ? "#22c55e"
                            : ratio < 0.95 ? "#f59e0b"
                            : "rgba(255,255,255,0.4)";
                          return (
                            <div style={{
                              display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6,
                              background: `${color}15`, border: `1px solid ${color}40`,
                              fontSize: 11, fontFamily: "var(--font-cjk)", color, fontWeight: 600,
                              alignSelf: "flex-end",
                            }}>
                              <span>{label}</span>
                              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontWeight: 400 }}>
                                {t("prediction.s1.compression.detail", { realDays: days, simDays, ratio: realPerSim })}
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                      {(() => {
                        if (!predStartDate || !predEndDate) return null;
                        const days = Math.ceil((new Date(predEndDate).getTime() - new Date(predStartDate).getTime()) / 86400000);
                        if (days <= 0 || simDays <= 0) return null;
                        const ratio = days / simDays;
                        if (ratio > 30) {
                          return (
                            <div style={{ fontSize: 10, color: "#ef4444", padding: "4px 8px", borderRadius: 4, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", fontFamily: "var(--font-cjk)", lineHeight: 1.5, marginBottom: 6 }}>
                              {t("prediction.s1.compression.warn")}
                            </div>
                          );
                        }
                        return null;
                      })()}
                      <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", marginBottom: 6 }}>
                        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, lineHeight: 1.6, fontFamily: "var(--font-cjk)" }}>
                          <strong style={{ color: "rgba(255,255,255,0.6)" }}>{t("prediction.s1.fixed_kw.title")}</strong>{t("prediction.s1.fixed_kw.desc")}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 10 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 10, color: "#3b82f6", fontWeight: 700, marginBottom: 3, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.local_kw.label")}</div>
                          <textarea value={predLocalKeywords} onChange={e => setPredLocalKeywords(e.target.value)}
                            placeholder={t("prediction.s1.local_kw.placeholder", { county: predCounty || t("prediction.s1.county") })} rows={3}
                            style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(59,130,246,0.2)", background: "rgba(59,130,246,0.05)", color: "#fff", fontSize: 11, outline: "none", fontFamily: "var(--font-cjk)", resize: "vertical", lineHeight: "1.5" }} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 10, color: "#f59e0b", fontWeight: 700, marginBottom: 3, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.national_kw.label")}</div>
                          <textarea value={predNationalKeywords} onChange={e => setPredNationalKeywords(e.target.value)}
                            placeholder={t("prediction.s1.national_kw.placeholder")} rows={3}
                            style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(245,158,11,0.2)", background: "rgba(245,158,11,0.05)", color: "#fff", fontSize: 11, outline: "none", fontFamily: "var(--font-cjk)", resize: "vertical", lineHeight: "1.5" }} />
                        </div>
                      </div>
                      <div style={{ color: "rgba(255,255,255,0.25)", fontSize: 9, marginTop: 4, fontFamily: "var(--font-cjk)", lineHeight: 1.6 }}>
                        {t("prediction.s1.dyn.tip")}
                      </div>
                    </div>
                  )}
                </div>

                {/* Auto-fetch panel - Only show when NOT using dynamic search */}
                {!useDynamicSearch && (
                <div style={{ marginTop: 8, padding: 14, borderRadius: 10, border: `1px dashed ${enableAutoFetch ? "rgba(139,92,246,0.3)" : "rgba(255,255,255,0.06)"}`, background: enableAutoFetch ? "rgba(139,92,246,0.02)" : "rgba(0,0,0,0.1)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                      <input type="checkbox" checked={enableAutoFetch} onChange={e => { setEnableAutoFetch(e.target.checked); if (!e.target.checked) setAutoFetchOpen(false); }}
                        style={{ width: 14, height: 14, accentColor: "#8b5cf6" }} />
                      <span style={{ color: enableAutoFetch ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.35)", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.autofetch.title")}</span>
                    </label>
                    {enableAutoFetch && (
                      <button onClick={() => setAutoFetchOpen(!autoFetchOpen)} disabled={running} style={{ padding: "5px 14px", borderRadius: 6, border: "1px solid rgba(139,92,246,0.3)", background: "rgba(139,92,246,0.08)", color: "#8b5cf6", fontSize: 12, cursor: "pointer", fontWeight: 600, fontFamily: "var(--font-cjk)" }}>
                        {autoFetchOpen ? t("prediction.s1.autofetch.collapse") : t("prediction.s1.autofetch.expand")}
                      </button>
                    )}
                  </div>
                  <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 11, marginTop: 4, fontFamily: "var(--font-cjk)" }}>
                    {enableAutoFetch
                      ? t("prediction.s1.autofetch.desc_on")
                      : t("prediction.s1.autofetch.desc_off")}
                  </div>
                   {enableAutoFetch && autoFetchOpen && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                      <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.autofetch.tip_lines")}</div>
                      {/* ── Local Keywords ── */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: "#3b82f6", fontSize: 12, fontWeight: 700 }}>{t("prediction.s1.autofetch.local_label")}</span>
                        <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>{t("prediction.s1.autofetch.local_hint")}</span>
                      </div>
                      <textarea
                        value={predFetchQuery}
                        onChange={e => setPredFetchQuery(e.target.value)}
                        placeholder={t("prediction.s1.autofetch.local_placeholder", { county: predCounty || t("prediction.s1.county") })}
                        rows={4}
                        style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(59,130,246,0.2)", background: "rgba(59,130,246,0.05)", color: "#fff", fontSize: 12, outline: "none", fontFamily: "var(--font-cjk)", resize: "vertical", lineHeight: "1.5" }}
                      />
                      {/* ── National Keywords ── */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                        <span style={{ color: "#f59e0b", fontSize: 12, fontWeight: 700 }}>{t("prediction.s1.autofetch.national_label")}</span>
                        <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>{t("prediction.s1.autofetch.national_hint")}</span>
                      </div>
                      <textarea
                        value={predFetchNationalQuery}
                        onChange={e => setPredFetchNationalQuery(e.target.value)}
                        placeholder={t("prediction.s1.autofetch.national_placeholder")}
                        rows={4}
                        style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(245,158,11,0.2)", background: "rgba(245,158,11,0.05)", color: "#fff", fontSize: 12, outline: "none", fontFamily: "var(--font-cjk)", resize: "vertical", lineHeight: "1.5" }}
                      />
                      {/* ── Ratio Slider ── */}
                      <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                          <span style={{ color: "#3b82f6", fontSize: 11, fontWeight: 700 }}>{t("prediction.s1.autofetch.local_pct", { pct: predFetchLocalRatio })}</span>
                          <input type="range" min={10} max={90} step={5} value={predFetchLocalRatio} onChange={e => setPredFetchLocalRatio(parseInt(e.target.value))} style={{ flex: 1, maxWidth: 200, accentColor: "#8b5cf6" }} />
                          <span style={{ color: "#f59e0b", fontSize: 11, fontWeight: 700 }}>{t("prediction.s1.autofetch.national_pct", { pct: 100 - predFetchLocalRatio })}</span>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input type="date" value={fetchStartDate} onChange={e => setFetchStartDate(e.target.value)} style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 12 }} />
                        <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 12 }}>{t("prediction.s1.autofetch.date_to")}</span>
                        <input type="date" value={fetchEndDate} onChange={e => setFetchEndDate(e.target.value)} style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 12 }} />
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, fontFamily: "var(--font-cjk)", whiteSpace: "nowrap" }}>{t("prediction.s1.autofetch.per_year")}</span>
                        <input type="number" min={5} max={30} value={perYearCount} onChange={e => setPerYearCount(Math.max(1, Number(e.target.value)))} style={{ width: 60, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 12, textAlign: "center" as const }} />
                        <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 11, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.autofetch.per_year_unit")}</span>
                        {fetchStartDate && fetchEndDate && (
                          <span style={{ color: "rgba(139,92,246,0.7)", fontSize: 11, fontFamily: "var(--font-cjk)" }}>
                            {t("prediction.s1.autofetch.estimate", {
                              n: perYearCount * Math.max(1, new Date(fetchEndDate).getFullYear() - new Date(fetchStartDate).getFullYear() + 1),
                              social: predFetchSocial ? t("prediction.s1.autofetch.with_social") : "",
                            })}
                          </span>
                        )}
                      </div>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                        <input type="checkbox" checked={predFetchSocial} onChange={e => setPredFetchSocial(e.target.checked)} style={{ accentColor: "#8b5cf6" }} />
                        <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, fontFamily: "var(--font-cjk)" }}>{t("prediction.s1.autofetch.also_social")}</span>
                      </label>
                      <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, lineHeight: "1.5", padding: "4px 0" }}>
                        {t("prediction.s1.autofetch.split_tip")}
                      </div>
                      <button
                        onClick={handleAutoFetch}
                        disabled={fetchLoading || (!question.trim() && !predFetchQuery.trim())}
                        style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: fetchLoading ? "rgba(139,92,246,0.3)" : "linear-gradient(135deg, #8b5cf6, #7c3aed)", color: "#fff", fontSize: 13, fontWeight: 600, cursor: fetchLoading ? "wait" : "pointer", fontFamily: "var(--font-cjk)" }}
                      >{fetchLoading ? t("prediction.s1.autofetch.searching") : t("prediction.s1.autofetch.search_btn")}</button>
                      {/* Progress bar */}
                      {fetchProgress && (
                        <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                            <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 11, fontFamily: "var(--font-cjk)" }}>{fetchProgress.label}</span>
                            <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>{fetchProgress.step}/{fetchProgress.total}</span>
                          </div>
                          <div style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                            <div style={{ height: "100%", borderRadius: 2, background: "linear-gradient(90deg, #8b5cf6, #7c3aed)", width: `${Math.round((fetchProgress.step / fetchProgress.total) * 100)}%`, transition: "width 0.3s" }} />
                          </div>
                        </div>
                      )}
                      {!question.trim() && !predFetchQuery.trim() && <div style={{ color: "#f59e0b", fontSize: 11 }}>{t("prediction.s1.autofetch.no_question")}</div>}
                    </div>
                  )}
                </div>
              )}
              </div>

              </div>

              {/* === 區塊二：預測分組 / 調查對象 === */}
              <div style={{ display: activeTab === "scenario" ? "block" : "none" }}>

              {/* Satisfaction survey items (when in satisfaction mode) */}
              {predictionMode === "satisfaction" && (
                <div style={card}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <h3 style={{ color: "#3b82f6", fontSize: 16, fontWeight: 700, margin: 0, fontFamily: "var(--font-cjk)" }}>{t("prediction.s2.survey.title")}</h3>
                    <button onClick={() => setSurveyItems([...surveyItems, { name: "", role: "", party: "" }])}
                      style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(59,130,246,0.4)", background: "rgba(59,130,246,0.1)", color: "#3b82f6", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-cjk)", fontWeight: 600 }}>
                      {t("prediction.s2.survey.add")}
                    </button>
                  </div>
                  <div style={{ padding: "8px 12px", marginBottom: 14, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, margin: 0, lineHeight: 1.7, fontFamily: "var(--font-cjk)" }}>
                      {t("prediction.s2.survey.desc")}
                    </p>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {surveyItems.map((item, idx) => (
                      <div key={idx} style={{ padding: 12, background: "rgba(59,130,246,0.03)", borderRadius: 8, border: "1px solid rgba(59,130,246,0.1)" }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ color: "#3b82f6", fontSize: 12, fontWeight: 700, width: 24, fontFamily: "var(--font-mono)" }}>{idx + 1}</span>
                          <input value={item.name} onChange={e => { const arr = [...surveyItems]; arr[idx] = { ...arr[idx], name: e.target.value }; setSurveyItems(arr); }}
                            placeholder={t("prediction.s2.survey.name_placeholder")}
                            style={{ flex: "1 1 120px", padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(59,130,246,0.2)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 12, fontFamily: "var(--font-cjk)" }} />
                          <select value={item.role} onChange={e => { const arr = [...surveyItems]; arr[idx] = { ...arr[idx], role: e.target.value }; setSurveyItems(arr); }}
                            style={{ flex: "0 0 160px", padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(59,130,246,0.2)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 11, fontFamily: "var(--font-cjk)" }}>
                            <option value="">{t("prediction.s2.survey.role_placeholder")}</option>
                            <optgroup label="Federal — Sitting">
                              <option value="President">{t("prediction.s2.survey.role.president")}</option>
                              <option value="Vice President">{t("prediction.s2.survey.role.vice_president")}</option>
                              <option value="US Senator">{t("prediction.s2.survey.role.us_senator")}</option>
                              <option value="US Representative">{t("prediction.s2.survey.role.us_representative")}</option>
                              <option value="Cabinet Secretary">{t("prediction.s2.survey.role.cabinet_secretary")}</option>
                              <option value="Attorney General">{t("prediction.s2.survey.role.attorney_general")}</option>
                              <option value="House Speaker">{t("prediction.s2.survey.role.house_speaker")}</option>
                            </optgroup>
                            <optgroup label="State / Local — Sitting">
                              <option value="Governor">{t("prediction.s2.survey.role.governor")}</option>
                              <option value="Lieutenant Governor">{t("prediction.s2.survey.role.lt_governor")}</option>
                              <option value="State Senator">{t("prediction.s2.survey.role.state_senator")}</option>
                              <option value="State Representative">{t("prediction.s2.survey.role.state_representative")}</option>
                              <option value="Mayor">{t("prediction.s2.survey.role.mayor")}</option>
                            </optgroup>
                            <optgroup label="Candidates">
                              <option value="Presidential Candidate">{t("prediction.s2.survey.role.presidential_candidate")}</option>
                              <option value="Senate Candidate">{t("prediction.s2.survey.role.senate_candidate")}</option>
                              <option value="House Candidate">{t("prediction.s2.survey.role.house_candidate")}</option>
                              <option value="Gubernatorial Candidate">{t("prediction.s2.survey.role.gubernatorial_candidate")}</option>
                              <option value="Mayoral Candidate">{t("prediction.s2.survey.role.mayoral_candidate")}</option>
                            </optgroup>
                          </select>
                          <input value={item.party} onChange={e => { const arr = [...surveyItems]; arr[idx] = { ...arr[idx], party: e.target.value }; setSurveyItems(arr); }}
                            placeholder={t("prediction.s2.survey.party_placeholder")}
                            style={{ flex: "0 0 80px", padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(59,130,246,0.2)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 11, fontFamily: "var(--font-cjk)" }} />
                          <button onClick={() => setSurveyItems(surveyItems.filter((_, i) => i !== idx))}
                            disabled={surveyItems.length <= 1}
                            style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid rgba(239,68,68,0.2)", background: "transparent", color: surveyItems.length <= 1 ? "rgba(255,255,255,0.1)" : "#ef4444", fontSize: 12, cursor: surveyItems.length <= 1 ? "not-allowed" : "pointer" }}>×</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Election poll groups (when in election mode) */}
              {predictionMode === "election" && (
              <div style={card}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <h3 style={{ color: "#fff", fontSize: 16, fontWeight: 700, margin: 0, fontFamily: "var(--font-cjk)" }}>{t("prediction.s2.title")}</h3>
                  <button
                    onClick={() => {
                      const gid = Date.now().toString();
                      const defaultWeight = pollGroups.length === 0 ? 100 : Math.round(100 / (pollGroups.length + 1));
                      setPollGroups(prev => [...prev, { id: gid, name: t("prediction.s2.election.default_group_name", { n: prev.length + 1 }), weight: defaultWeight, candidates: [
                        { id: `${gid}_1`, name: "", description: "" },
                        { id: `${gid}_2`, name: "", description: "" },
                      ]}]);
                    }}
                    disabled={running}
                    style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(56,189,248,0.4)", background: "rgba(56,189,248,0.1)", color: "#38bdf8", fontSize: 12, cursor: running ? "not-allowed" : "pointer", fontFamily: "var(--font-cjk)", fontWeight: 600 }}
                  >
                    {t("prediction.s2.election.add_group")}
                  </button>
                </div>

                <div style={{ padding: "10px 14px", marginBottom: 14, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, margin: 0, lineHeight: 1.7, fontFamily: "var(--font-cjk)" }}>
                    {t("prediction.s2.election.desc")}
                  </p>
                </div>

              {/* Weight summary */}
              {pollGroups.length > 1 && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, padding: "8px 12px", background: "rgba(251,191,36,0.05)", borderRadius: 8, border: "1px solid rgba(251,191,36,0.15)", flexWrap: "wrap" }}>
                  <span style={{ color: "#fbbf24", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-cjk)", whiteSpace: "nowrap" }}>{t("prediction.s2.election.weight_summary")}</span>
                  <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, fontFamily: "var(--font-cjk)" }}>
                    {t("prediction.s2.election.weight_formula", { formula: pollGroups.map((g, i) => `${g.name || t("prediction.s2.election.group_short", { n: i + 1 })}×${g.weight}%`).join(" + ") })}
                  </span>
                  {(() => { const total = pollGroups.reduce((s, g) => s + (g.weight || 0), 0); return total !== 100 ? (
                    <span style={{ color: "#ef4444", fontSize: 10, fontWeight: 700 }}>{t("prediction.s2.election.weight_warn", { total })}</span>
                  ) : null; })()}
                </div>
              )}

              {pollGroups.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: "block", color: "rgba(255,255,255,0.6)", fontSize: 12, marginBottom: 4, fontFamily: "var(--font-cjk)" }}>
                    {t("prediction.s2.election.max_choices")}
                  </label>
                  <input
                    type="number" min={1} max={5}
                    value={maxChoices}
                    onChange={(e) => setMaxChoices(Number(e.target.value))}
                    disabled={running}
                    style={{ width: 60, padding: "4px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 12, outline: "none" }}
                  />
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {pollGroups.map((group, gi) => (
                  <div key={group.id} style={{ padding: 14, background: "rgba(255,255,255,0.02)", borderRadius: 10, border: "1px solid rgba(139,92,246,0.15)" }}>
                    {/* Group header */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 16 }}>📋</span>
                      <input
                        placeholder={t("prediction.s2.election.group_name_placeholder")}
                        value={group.name}
                        onChange={(e) => {
                          const newGroups = [...pollGroups];
                          newGroups[gi] = { ...newGroups[gi], name: e.target.value };
                          setPollGroups(newGroups);
                        }}
                        disabled={running}
                        style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(139,92,246,0.3)", background: "rgba(139,92,246,0.05)", color: "#a78bfa", fontSize: 13, fontWeight: 700, outline: "none", fontFamily: "var(--font-cjk)" }}
                      />
                      {/* Group weight */}
                      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                        <span style={{ color: "#fbbf24", fontSize: 10, fontFamily: "var(--font-cjk)" }}>{t("prediction.s2.election.weight")}</span>
                        <input type="number" min={1} max={100} value={group.weight}
                          onChange={(e) => { const g = [...pollGroups]; g[gi] = { ...g[gi], weight: Math.max(1, Number(e.target.value) || 1) }; setPollGroups(g); }}
                          disabled={running}
                          style={{ width: 44, padding: "3px 4px", borderRadius: 4, border: "1px solid rgba(251,191,36,0.3)", background: "rgba(0,0,0,0.3)", color: "#fbbf24", fontSize: 12, textAlign: "center", outline: "none" }} />
                        <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>%</span>
                      </div>
                      {/* Agent filter dropdown */}
                      <select
                        value={JSON.stringify(group.agentFilter?.leanings || [])}
                        onChange={(e) => {
                          const leanings: string[] = JSON.parse(e.target.value);
                          const newGroups = [...pollGroups];
                          newGroups[gi] = { ...newGroups[gi], agentFilter: leanings.length > 0 ? { leanings } : undefined };
                          setPollGroups(newGroups);
                        }}
                        disabled={running}
                        style={{ padding: "3px 6px", borderRadius: 5, border: "1px solid rgba(56,189,248,0.3)", background: "rgba(0,0,0,0.3)", color: "#38bdf8", fontSize: 10, outline: "none", fontFamily: "var(--font-cjk)", cursor: running ? "not-allowed" : "pointer" }}
                      >
                        <option value="[]">{t("prediction.s2.election.filter.all")}</option>
                        <option value={JSON.stringify(["偏右派", "偏藍"])}>{t("prediction.s2.election.filter.right")}</option>
                        <option value={JSON.stringify(["偏左派", "偏綠"])}>{t("prediction.s2.election.filter.left")}</option>
                        <option value={JSON.stringify(["中立", "偏白"])}>{t("prediction.s2.election.filter.center")}</option>
                      </select>
                      <button
                        onClick={() => {
                          const cid = Date.now().toString();
                          const newGroups = [...pollGroups];
                          newGroups[gi] = { ...newGroups[gi], candidates: [...newGroups[gi].candidates, { id: cid, name: "", description: "", isIncumbent: false, localVisibility: 50, nationalVisibility: 50, originDistricts: "" }] };
                          setPollGroups(newGroups);
                        }}
                        disabled={running}
                        style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.5)", fontSize: 10, cursor: "pointer", fontFamily: "var(--font-cjk)" }}
                      >
                        {t("prediction.s2.election.add_candidate")}
                      </button>
                      <button
                        onClick={() => setPollGroups(pollGroups.filter(g => g.id !== group.id))}
                        disabled={running}
                        style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.05)", color: "#ef4444", fontSize: 12, cursor: "pointer" }}
                      >
                        ×
                      </button>
                    </div>

                    {/* Candidates within this group */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {group.candidates.map((cand, ci) => (
                        <div key={cand.id} style={{ padding: 10, background: "rgba(255,255,255,0.02)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.05)" }}>
                          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                            <input
                              placeholder={t("prediction.s2.election.candidate_name_placeholder")}
                              value={cand.name}
                              onChange={(e) => {
                                const newGroups = [...pollGroups];
                                newGroups[gi] = { ...newGroups[gi], candidates: [...newGroups[gi].candidates] };
                                newGroups[gi].candidates[ci] = { ...newGroups[gi].candidates[ci], name: e.target.value };
                                setPollGroups(newGroups);
                              }}
                              disabled={running}
                              style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "#fff", fontSize: 12, outline: "none", fontFamily: "var(--font-cjk)", fontWeight: "bold" }}
                            />
                            <button
                              onClick={() => {
                                const newGroups = [...pollGroups];
                                newGroups[gi] = { ...newGroups[gi], candidates: newGroups[gi].candidates.filter(c => c.id !== cand.id) };
                                setPollGroups(newGroups);
                              }}
                              disabled={running}
                              style={{ padding: "0 8px", background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)", borderRadius: 5, color: "#ef4444", cursor: "pointer", fontSize: 14 }}
                            >×</button>
                            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11, color: (cand as any).isIncumbent ? "#fbbf24" : "rgba(255,255,255,0.3)" }}>
                              <input
                                type="checkbox"
                                checked={(cand as any).isIncumbent || false}
                                onChange={(e) => {
                                  const newGroups = [...pollGroups];
                                  newGroups[gi] = { ...newGroups[gi], candidates: [...newGroups[gi].candidates] };
                                  (newGroups[gi].candidates[ci] as any) = { ...newGroups[gi].candidates[ci], isIncumbent: e.target.checked };
                                  setPollGroups(newGroups);
                                }}
                                disabled={running}
                                style={{ accentColor: "#fbbf24" }}
                              />
                              {t("prediction.s2.election.incumbent")}
                            </label>
                          </div>
                          <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
                          <textarea
                            placeholder={t("prediction.s2.election.candidate_desc_placeholder")}
                            value={cand.description}
                            onChange={(e) => {
                              const newGroups = [...pollGroups];
                              newGroups[gi] = { ...newGroups[gi], candidates: [...newGroups[gi].candidates] };
                              newGroups[gi].candidates[ci] = { ...newGroups[gi].candidates[ci], description: e.target.value };
                              setPollGroups(newGroups);
                            }}
                            disabled={running}
                            style={{ width: "100%", flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.06)", background: "rgba(0,0,0,0.15)", color: "rgba(255,255,255,0.6)", fontSize: 11, outline: "none", resize: "vertical", minHeight: 50, fontFamily: "var(--font-cjk)", lineHeight: 1.5 }}
                          />
                          <button
                            onClick={async () => {
                              const candName = cand.name?.trim();
                              if (!candName) { alert(t("prediction.s2.election.alert.no_name")); return; }
                              const key = `auto_${gi}_${ci}`;
                              setWikiLoadingKey(key);
                              try {
                                // Step 1: Fetch Wiki profile (description + origin districts)
                                const wikiResult = await fetchCandidateProfile(candName);
                                const newDesc = wikiResult.description || cand.description || "";
                                const originDistricts = wikiResult.origin_districts || (cand as any).originDistricts || "";

                                // Step 2: Calculate visibility using Wiki pageviews + keyword analysis
                                const visData = await apiFetch("/api/pipeline/candidate-visibility", {
                                  method: "POST",
                                  body: JSON.stringify({ name: candName, county: predCounty || "", description: newDesc }),
                                });

                                // Step 3: Update all fields at once
                                const newGroups = [...pollGroups];
                                newGroups[gi] = { ...newGroups[gi], candidates: [...newGroups[gi].candidates] };
                                newGroups[gi].candidates[ci] = {
                                  ...newGroups[gi].candidates[ci],
                                  description: newDesc,
                                  originDistricts: originDistricts,
                                  localVisibility: visData.local_visibility ?? (cand as any).localVisibility ?? 50,
                                  nationalVisibility: visData.national_visibility ?? (cand as any).nationalVisibility ?? 50,
                                };
                                setPollGroups(newGroups);
                              } catch (e: any) {
                                alert(t("prediction.s2.election.alert.auto_failed") + (e.message || e));
                              } finally {
                                setWikiLoadingKey(null);
                              }
                            }}
                            disabled={running || wikiLoadingKey !== null}
                            title={t("prediction.s2.election.auto_tooltip")}
                            style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(124,58,237,0.4)", background: wikiLoadingKey === `auto_${gi}_${ci}` ? "rgba(124,58,237,0.2)" : "rgba(124,58,237,0.08)", color: "#a78bfa", fontSize: 11, cursor: wikiLoadingKey !== null ? "wait" : "pointer", whiteSpace: "nowrap", flexShrink: 0, fontFamily: "var(--font-cjk)", fontWeight: 600 }}
                          >{wikiLoadingKey === `auto_${gi}_${ci}` ? t("prediction.s2.election.auto_btn_loading") : t("prediction.s2.election.auto_btn")}</button>
                          </div>
                          {/* Visibility & Origin Districts */}
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "1 1 180px" }}>
                              <span style={{ color: "#f59e0b", fontSize: 10, whiteSpace: "nowrap" }}>{t("prediction.s2.election.local_vis")}</span>
                              <input type="range" min={0} max={100} step={5}
                                value={(cand as any).localVisibility ?? 50}
                                onChange={(e) => {
                                  const newGroups = [...pollGroups];
                                  newGroups[gi] = { ...newGroups[gi], candidates: [...newGroups[gi].candidates] };
                                  (newGroups[gi].candidates[ci] as any) = { ...newGroups[gi].candidates[ci], localVisibility: Number(e.target.value) };
                                  setPollGroups(newGroups);
                                }}
                                disabled={running}
                                style={{ flex: 1, accentColor: "#f59e0b", height: 14 }} />
                              <span style={{ color: "#f59e0b", fontSize: 10, minWidth: 24, textAlign: "right" }}>{(cand as any).localVisibility ?? 50}</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "1 1 180px" }}>
                              <span style={{ color: "#38bdf8", fontSize: 10, whiteSpace: "nowrap" }}>{t("prediction.s2.election.national_vis")}</span>
                              <input type="range" min={0} max={100} step={5}
                                value={(cand as any).nationalVisibility ?? 50}
                                onChange={(e) => {
                                  const newGroups = [...pollGroups];
                                  newGroups[gi] = { ...newGroups[gi], candidates: [...newGroups[gi].candidates] };
                                  (newGroups[gi].candidates[ci] as any) = { ...newGroups[gi].candidates[ci], nationalVisibility: Number(e.target.value) };
                                  setPollGroups(newGroups);
                                }}
                                disabled={running}
                                style={{ flex: 1, accentColor: "#38bdf8", height: 14 }} />
                              <span style={{ color: "#38bdf8", fontSize: 10, minWidth: 24, textAlign: "right" }}>{(cand as any).nationalVisibility ?? 50}</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "1 1 220px" }}>
                              <span style={{ color: "#a78bfa", fontSize: 10, whiteSpace: "nowrap" }}>{t("prediction.s2.election.origin_districts")}</span>
                              <input
                                placeholder={t("prediction.s2.election.origin_districts_placeholder")}
                                value={(cand as any).originDistricts ?? ""}
                                onChange={(e) => {
                                  const newGroups = [...pollGroups];
                                  newGroups[gi] = { ...newGroups[gi], candidates: [...newGroups[gi].candidates] };
                                  (newGroups[gi].candidates[ci] as any) = { ...newGroups[gi].candidates[ci], originDistricts: e.target.value };
                                  setPollGroups(newGroups);
                                }}
                                disabled={running}
                                style={{ flex: 1, padding: "3px 6px", borderRadius: 4, border: "1px solid rgba(167,139,250,0.2)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.6)", fontSize: 10, outline: "none", fontFamily: "var(--font-cjk)" }}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          </div>

          {/* === 區塊三：進階模擬參數 === */}
          <div style={{ display: activeTab === "advanced" ? "block" : "none" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={card}>
              <h3 style={{ color: "#fff", fontSize: 16, fontWeight: 700, margin: 0, marginBottom: 12, fontFamily: "var(--font-cjk)" }}>{t("prediction.s3.title")}</h3>
              <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, margin: "0 0 16px 0", fontFamily: "var(--font-cjk)" }}>{t("prediction.s3.subtitle")}</p>

              {/* Alignment Target Info Banner */}
              {snapAlignmentInfo && (
                <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(251,191,36,0.04)", border: "1px solid rgba(251,191,36,0.15)", marginBottom: 12 }}>
                  <div style={{ color: "#fbbf24", fontSize: 12, fontWeight: 700, marginBottom: 6, fontFamily: "var(--font-cjk)", display: "flex", alignItems: "center", gap: 6 }}>
                    {t("prediction.s3.alignment.title")}
                  </div>
                  <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, lineHeight: 1.7, fontFamily: "var(--font-cjk)" }}>
                    {snapAlignmentInfo.mode === "election"
                      ? t("prediction.s3.alignment.election")
                      : t("prediction.s3.alignment.satisfaction", { items: (snapAlignmentInfo.items || []).map((it: any) => `${it.name} ${it.satisfaction_pct}%`).join("、") })}
                  </div>
                  <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, marginTop: 4, fontFamily: "var(--font-cjk)" }}>
                    {snapAlignmentInfo.mode === "satisfaction"
                      ? t("prediction.s3.alignment.tip_sat")
                      : t("prediction.s3.alignment.tip_elec")}
                  </div>
                </div>
              )}

              {/* Calibration Source Info Banner */}
              <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(34,197,94,0.04)", border: "1px solid rgba(34,197,94,0.15)", marginBottom: 16 }}>
                <div style={{ color: "#22c55e", fontSize: 12, fontWeight: 700, marginBottom: 6, fontFamily: "var(--font-cjk)", display: "flex", alignItems: "center", gap: 6 }}>
                  {t("prediction.s3.calib.title")}
                </div>
                <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, lineHeight: 1.6, fontFamily: "var(--font-cjk)" }}>
                  ✅ <span style={{ color: "#4ade80" }}>{t("prediction.s3.calib.imported")}</span>{t("prediction.s3.calib.imported_desc")}<code style={{ color: "#a78bfa", fontSize: 10 }}>persona_delta</code>{t("prediction.s3.calib.imported_fields")}<code style={{ color: "#a78bfa", fontSize: 10 }}>reaction_scale</code>{t("prediction.s3.calib.imported_fields2")}<code style={{ color: "#a78bfa", fontSize: 10 }}>decay_rate</code>{t("prediction.s3.calib.imported_fields3")}<br />
                  ⚙️ <span style={{ color: "#f59e0b" }}>{t("prediction.s3.calib.global")}</span>{t("prediction.s3.calib.global_desc")}
                </div>
              </div>
              
              <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 16 }}>
                <div style={{ flex: "1 1 300px" }}>
                  {/* Macro Political & Economic Context */}
                  <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <label style={{ color: "rgba(255,255,255,0.8)", fontSize: 13, fontWeight: "bold", display: "flex", alignItems: "center", gap: 8 }}>
                        {t("prediction.s3.macro.label")}
                      </label>
                      <button
                        disabled={running || macroContextGenerating}
                        onClick={async () => {
                          setMacroContextGenerating(true);
                          try {
                            // Gather context
                            const county = predCounty || "";
                            const startDate = predStartDate || "";
                            const endDate = predEndDate || "";
                            const candNames = pollGroups.flatMap(g => g.candidates.filter(c => c.name).map(c => `${c.name}(${c.description?.split("、")[0] || ""})`));
                            const satItems = surveyItems.filter(s => s.name.trim()).map(s => `${s.name}(${s.role}/${s.party})`);
                            const targets = predictionMode === "satisfaction" ? satItems : candNames;

                            // Use suggestKeywords' LLM endpoint to generate macro context
                            const res = await apiFetch("/api/pipeline/generate-macro-context", {
                              method: "POST",
                              body: JSON.stringify({
                                county,
                                start_date: startDate,
                                end_date: endDate,
                                candidates: targets,
                                prediction_mode: predictionMode,
                              }),
                            });
                            if (res.macro_context) {
                              setPredictionMacroContext(res.macro_context);
                            }
                          } catch (e: any) {
                            alert(t("prediction.s3.macro.alert_failed") + (e.message || e));
                          } finally {
                            setMacroContextGenerating(false);
                          }
                        }}
                        style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid rgba(139,92,246,0.3)", background: "rgba(139,92,246,0.08)", color: "#a78bfa", fontSize: 11, cursor: macroContextGenerating ? "wait" : "pointer", fontFamily: "var(--font-cjk)" }}
                      >{macroContextGenerating ? t("prediction.s3.macro.btn_generating") : t("prediction.s3.macro.btn_ai")}</button>
                    </div>
                    <textarea
                      value={predictionMacroContext}
                      onChange={(e: any) => setPredictionMacroContext(e.target.value)}
                      placeholder={t("prediction.s3.macro.placeholder")}
                      disabled={running}
                      style={{
                        width: "100%", padding: "10px 14px", borderRadius: 8,
                        border: "1px solid rgba(255,255,255,0.2)", background: "rgba(0,0,0,0.4)",
                        color: "#fff", fontSize: 13, resize: "vertical", minHeight: 80,
                        fontFamily: "var(--font-cjk)", outline: "none", transition: "all 0.2s"
                      }}
                    />
                    <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>{t("prediction.s3.macro.hint")}</span>
                  </div>

                  <div style={{ display: "flex", gap: 20 }}>
                <div>
                  <label style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, display: "block", marginBottom: 4 }}>{t("prediction.s3.sim_days")}</label>
                  <input type="number" min={1} max={90} value={simDays} onChange={(e) => setSimDays(Number(e.target.value))} disabled={running} style={{ width: 80, padding: "6px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "#fff", fontSize: 13, outline: "none" }} />
                </div>
                <div>
                  <label style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, display: "block", marginBottom: 4 }}>{t("prediction.s3.concurrency")}</label>
                  <input type="number" min={1} max={20} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} disabled={running} style={{ width: 80, padding: "6px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "#fff", fontSize: 13, outline: "none" }} />
                </div>
              </div>

              <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "rgba(255,255,255,0.9)", fontSize: 13, fontWeight: "bold", fontFamily: "var(--font-cjk)" }}>
                  <input type="checkbox" checked={useCalibResultLeaning} onChange={(e: any) => setUseCalibResultLeaning(e.target.checked)} style={{ accentColor: "#22c55e" }} />
                  {t("prediction.s3.reset_leaning.title")}
                </label>
                <div style={{ paddingLeft: 24, marginTop: 6, color: "rgba(255,255,255,0.5)", fontSize: 11, lineHeight: 1.6, fontFamily: "var(--font-cjk)" }}>
                  {useCalibResultLeaning ? (
                    <div>
                      <div style={{ color: "rgba(34,197,94,0.8)", marginBottom: 4 }}>
                        <strong>{t("prediction.s3.reset_leaning.enabled")}</strong>{t("prediction.s3.reset_leaning.enabled_desc")}
                      </div>
                      <div style={{ color: "rgba(255,255,255,0.4)", marginBottom: 6 }}>
                        {t("prediction.s3.reset_leaning.enabled_note")}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ color: "rgba(245,158,11,0.8)", marginBottom: 4 }}>
                        <strong>{t("prediction.s3.reset_leaning.disabled")}</strong>{t("prediction.s3.reset_leaning.disabled_desc")}
                      </div>
                      <div style={{ color: "rgba(255,255,255,0.4)", marginBottom: 6 }}>
                        {t("prediction.s3.reset_leaning.disabled_note")}
                      </div>
                    </div>
                  )}
                  {/* Candidate-specific impact */}
                  {pollGroups.length > 0 && (() => {
                    const allCands = Array.from(new Map(pollGroups.flatMap(g => g.candidates.filter(c => c.name && c.name !== "__by_district__").map(c => [c.name, c]))).values());
                    if (allCands.length === 0) return null;
                    return (
                      <div style={{ marginTop: 4, padding: "8px 10px", borderRadius: 8, background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.06)" }}>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 6, fontWeight: 600 }}>{t("prediction.s3.reset_leaning.impact_title")}</div>
                        {allCands.map((c: any) => {
                          const isIncumbent = c.isIncumbent;
                          const desc = c.description || "";
                          // Stage 1.8.2: prefer template party detection (US D/R/I); fall back to TW regex.
                          const _pid = activeTemplate ? detectPartyIdTemplate(c.name, desc) : null;
                          let isRuling: boolean, isOpposition: boolean;
                          if (_pid !== null) {
                            // Template-driven major-party detection. Incumbent → ruling;
                            // any other major-party candidate → opposition; "I"/independent → other.
                            isRuling = !!isIncumbent;
                            isOpposition = !isIncumbent && _pid !== "I";
                          } else {
                            isOpposition = false /* TW regex removed — US uses detectPartyIdTemplate */;
                            isRuling = !!isIncumbent;
                          }
                          let impactIcon: string, impactText: string, impactColor: string;
                          if (useCalibResultLeaning) {
                            if (isRuling) { impactIcon = "📈"; impactText = t("prediction.s3.reset_leaning.impact.on.ruling"); impactColor = "rgba(34,197,94,0.7)"; }
                            else if (isOpposition) { impactIcon = "📉"; impactText = t("prediction.s3.reset_leaning.impact.on.opposition"); impactColor = "rgba(239,68,68,0.7)"; }
                            else { impactIcon = "➡️"; impactText = t("prediction.s3.reset_leaning.impact.on.other"); impactColor = "rgba(255,255,255,0.5)"; }
                          } else {
                            if (isRuling) { impactIcon = "📉"; impactText = t("prediction.s3.reset_leaning.impact.off.ruling"); impactColor = "rgba(245,158,11,0.7)"; }
                            else if (isOpposition) { impactIcon = "📈"; impactText = t("prediction.s3.reset_leaning.impact.off.opposition"); impactColor = "rgba(34,197,94,0.7)"; }
                            else { impactIcon = "➡️"; impactText = t("prediction.s3.reset_leaning.impact.off.other"); impactColor = "rgba(255,255,255,0.5)"; }
                          }
                          return (
                            <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, fontSize: 11 }}>
                              <span>{impactIcon}</span>
                              <span style={{ color: "rgba(255,255,255,0.8)", fontWeight: 600, minWidth: 60 }}>{c.name}</span>
                              <span style={{ color: impactColor }}>{impactText}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* 🎛️ Parameter Workspace */}
              <div style={{ marginTop: 12, padding: "14px 16px", borderRadius: 10, border: "1px solid rgba(59,130,246,0.25)", background: "linear-gradient(135deg, rgba(59,130,246,0.06), rgba(139,92,246,0.04))", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <label style={{ color: "rgba(255,255,255,0.9)", fontSize: 14, fontWeight: "bold", fontFamily: "var(--font-cjk)", letterSpacing: 1 }}>
                    {t("prediction.s3.workspace.title")}
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 10 }}>{t("prediction.s3.workspace.subtitle")}</span>
                    <button onClick={() => setParamWorkspaceOpen(!paramWorkspaceOpen)} style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.1)", color: "#60a5fa", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.15s" }}>
                      {paramWorkspaceOpen ? t("prediction.s3.workspace.collapse") : t("prediction.s3.workspace.expand")}
                    </button>
                  </div>
                </div>

                {paramWorkspaceOpen && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {/* Tab bar */}
                    <div style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 6 }}>
                      {([
                        { key: "scoring" as const, label: predictionMode === "satisfaction" ? t("prediction.s3.workspace.tab.scoring_sat") : t("prediction.s3.workspace.tab.scoring_elec"), color: "#f59e0b" },
                        { key: "leaning" as const, label: predictionMode === "satisfaction" ? t("prediction.s3.workspace.tab.leaning_sat") : t("prediction.s3.workspace.tab.leaning_elec"), color: "#fbbf24" },
                        { key: "candidate" as const, label: predictionMode === "satisfaction" ? t("prediction.s3.workspace.tab.candidate_sat") : t("prediction.s3.workspace.tab.candidate_elec"), color: "#22c55e" },
                        { key: "traits" as const, label: predictionMode === "satisfaction" ? t("prediction.s3.workspace.tab.traits_sat") : t("prediction.s3.workspace.tab.traits_elec"), color: "#f472b6" },
                      ]).map(tab => (
                        <button
                          key={tab.key}
                          onClick={() => setParamWorkspaceTab(tab.key)}
                          style={{
                            padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                            border: paramWorkspaceTab === tab.key ? `2px solid ${tab.color}` : "1px solid rgba(255,255,255,0.08)",
                            background: paramWorkspaceTab === tab.key ? `${tab.color}18` : "rgba(0,0,0,0.15)",
                            color: paramWorkspaceTab === tab.key ? tab.color : "rgba(255,255,255,0.45)",
                            cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.15s",
                          }}
                        >{tab.label}</button>
                      ))}
                    </div>

                    {/* Tab: Scoring Parameters */}
                    {paramWorkspaceTab === "scoring" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

                        {/* ── Candidate Impact Preview (election mode only) ── */}
                        {predictionMode !== "satisfaction" && (() => {
                          const allCands: {name: string, description: string, isIncumbent?: boolean}[] = [];
                          pollGroups.forEach(g => g.candidates?.forEach((c: any) => {
                            if (c.name && c.name !== "__by_district__" && !allCands.find(x => x.name === c.name)) allCands.push(c);
                          }));
                          if (allCands.length === 0) pollOptions.forEach((o: any) => {
                            if (o.name && o.name !== "__by_district__" && !allCands.find(x => x.name === o.name)) allCands.push(o);
                          });
                          if (allCands.length === 0) return null;

                          const getCColor = (c: any) => {
                            const d = (c.description || c.name || "").toLowerCase();
                            if (d.includes("republican") || d.includes("(r)")) return "#ef4444";
                            if (d.includes("democrat") || d.includes("(d)")) return "#3b82f6";
                            if (d.includes("independent") || d.includes("(i)")) return "#a855f7";
                            return "#a78bfa";
                          };

                          const getParty = (c: any): "ruling" | "opposition" | "other" => {
                            if (c.isIncumbent) return "ruling";
                            const pid = detectPartyIdTemplate(c.name, c.description || "");
                            if (pid && pid !== "I") return "opposition";
                            return "other";
                          };

                          const getBaseScore = (c: any) => partyBaseScores[c.name] ?? 30;
                          const sortedByBase = [...allCands].sort((a, b) => getBaseScore(b) - getBaseScore(a));
                          const highestBase = sortedByBase[0]?.name;
                          const lowestBase = sortedByBase[sortedByBase.length - 1]?.name;

                          return (
                            <div style={{ padding: "10px 12px", borderRadius: 10, background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.06)", marginBottom: 4 }}>
                              <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, fontWeight: 700, marginBottom: 8, fontFamily: "var(--font-cjk)" }}>
                                {t("prediction.s3.workspace.impact_preview_title")}
                              </div>
                              <div style={{ display: "flex", gap: 8 }}>
                                {allCands.map(c => {
                                  const col = getCColor(c);
                                  const isInc = (c as any).isIncumbent;
                                  const party = getParty(c);
                                  const baseScore = getBaseScore(c);
                                  const isHighBase = c.name === highestBase;
                                  const isLowBase = c.name === lowestBase;
                                  const signals: {icon: string, effect: "up" | "down" | "neutral", reason: string}[] = [];

                                  if (newsImpact >= 3.0) {
                                    if (party === "ruling" || isInc) signals.push({ icon: "📰", effect: "down", reason: "Strong news effect — voters more likely to question incumbents" });
                                    else if (party === "opposition") signals.push({ icon: "📰", effect: "up", reason: "Strong news effect — helps challengers amplify attack lines" });
                                    else signals.push({ icon: "📰", effect: "up", reason: "Strong news effect — raises visibility for newcomers" });
                                  } else if (newsImpact <= 1.5) {
                                    if (party === "ruling" || isInc) signals.push({ icon: "📰", effect: "up", reason: "Weak news effect — incumbents less vulnerable to negative coverage" });
                                    else if (party === "opposition") signals.push({ icon: "📰", effect: "down", reason: "Weak news effect — challengers struggle to gain traction on issues" });
                                    else signals.push({ icon: "📰", effect: "down", reason: "Weak news effect — newcomers struggle to build name recognition" });
                                  }
                                  if (deltaCapMult >= 2.0) {
                                    if (isHighBase) signals.push({ icon: "🔥", effect: "down", reason: "High volatility — frontrunner vulnerable to swings" });
                                    else if (isLowBase) signals.push({ icon: "🔥", effect: "up", reason: "High volatility — trailing candidate has upset potential" });
                                    else signals.push({ icon: "🔥", effect: "neutral", reason: "High volatility — outcome depends on news cycle" });
                                  } else if (deltaCapMult <= 1.0) {
                                    if (isHighBase) signals.push({ icon: "🔥", effect: "up", reason: "Stable sentiment — favors maintaining current lead" });
                                    else if (isLowBase) signals.push({ icon: "🔥", effect: "down", reason: "Stable sentiment — difficult for trailing candidate to close gap" });
                                    else signals.push({ icon: "🔥", effect: "neutral", reason: "Stable sentiment — current standings likely to hold" });
                                  }
                                  if (baseUndecided >= 0.20) {
                                    if (isHighBase) signals.push({ icon: "🤷", effect: "down", reason: "High undecided — frontrunner's vote share gets diluted" });
                                    else if (isLowBase) signals.push({ icon: "🤷", effect: "neutral", reason: "High undecided — all candidates equally affected" });
                                    else signals.push({ icon: "🤷", effect: "up", reason: "High undecided — opportunity to court swing voters" });
                                  } else if (baseUndecided <= 0.03) {
                                    if (isHighBase) signals.push({ icon: "🤷", effect: "up", reason: "Low undecided — consolidates existing support base" });
                                    else signals.push({ icon: "🤷", effect: "down", reason: "Low undecided — current dynamic hard to change" });
                                  }
                                  if (deltaCapMult >= 1.5 && newsImpact >= 2.5) {
                                    if (isHighBase) signals.push({ icon: "🔗", effect: "down", reason: "High volatility + strong news = race can swing dramatically" });
                                    else if (isLowBase) signals.push({ icon: "🔗", effect: "up", reason: "High volatility + strong news = upset probability increases" });
                                  }
                                  signals.push({
                                    icon: "📊", effect: isHighBase ? "up" : isLowBase ? "down" : "neutral",
                                    reason: `Base score ${baseScore} (${isHighBase ? "highest" : isLowBase ? "lowest" : "middle"} among candidates)`
                                  });

                                  const ups = signals.filter(s => s.effect === "up").length;
                                  const downs = signals.filter(s => s.effect === "down").length;
                                  const netEffect = ups - downs;
                                  const netLabel = netEffect > 2 ? "↑↑ Strongly favorable" : netEffect > 0 ? "↑ Slightly favorable" : netEffect < -2 ? "↓↓ Strongly unfavorable" : netEffect < 0 ? "↓ Slightly unfavorable" : "→ Neutral";
                                  const netColor = netEffect > 0 ? "#22c55e" : netEffect < 0 ? "#ef4444" : "rgba(255,255,255,0.4)";
                                  const partyLabel = party === "ruling" ? "Incumbent" : party === "opposition" ? "Challenger" : "Other";

                                  return (
                                    <div key={c.name} style={{ flex: 1, padding: "8px 10px", borderRadius: 8, background: `${col}08`, border: `1px solid ${col}20`, display: "flex", flexDirection: "column", gap: 4 }}>
                                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                        <span style={{ color: col, fontSize: 12, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{c.name}</span>
                                        <div style={{ display: "flex", gap: 4 }}>
                                          {isInc && <span style={{ color: "#fbbf24", fontSize: 9, background: "rgba(251,191,36,0.1)", padding: "1px 5px", borderRadius: 4 }}>👑 Inc.</span>}
                                          <span style={{ color: col, fontSize: 9, background: `${col}15`, padding: "1px 5px", borderRadius: 4, opacity: 0.7 }}>{partyLabel}</span>
                                        </div>
                                      </div>
                                      <div style={{ color: netColor, fontSize: 14, fontWeight: 900, fontFamily: "var(--font-cjk)" }}>{netLabel}</div>
                                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                        {signals.map((s, i) => (
                                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                            <span style={{ fontSize: 9, width: 14, textAlign: "center" }}>{s.icon}</span>
                                            <span style={{ fontSize: 10, color: s.effect === "up" ? "#22c55e" : s.effect === "down" ? "#ef4444" : "rgba(255,255,255,0.3)", fontWeight: 700 }}>
                                              {s.effect === "up" ? "▲" : s.effect === "down" ? "▼" : "•"}
                                            </span>
                                            <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 9, fontFamily: "var(--font-cjk)", lineHeight: 1.3 }}>{s.reason}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              <div style={{ color: "rgba(255,255,255,0.2)", fontSize: 9, marginTop: 6, textAlign: "center", fontFamily: "var(--font-cjk)" }}>
                                {t("prediction.s3.workspace.impact_footnote")}
                              </div>
                            </div>
                          );
                        })()}

                        {/* ── Satisfaction mode: concise parameter overview ── */}
                        {predictionMode === "satisfaction" && (
                          <div style={{ padding: "10px 12px", borderRadius: 10, background: "linear-gradient(135deg, rgba(59,130,246,0.06), rgba(139,92,246,0.04))", border: "1px solid rgba(59,130,246,0.15)" }}>
                            <div style={{ color: "#93c5fd", fontSize: 11, fontWeight: 700, marginBottom: 6, fontFamily: "var(--font-cjk)" }}>
                              {t("prediction.s3.workspace.scoring_model_title")}
                            </div>
                            <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 10, lineHeight: 1.7, fontFamily: "var(--font-cjk)" }}>
                              Each agent scores subjects using:<br/>
                              <code style={{ color: "#a78bfa", fontSize: 9 }}>Score = Base + Party alignment + Incumbency bonus + Policy sentiment + Likability + Personal trait match</code><br/>
                              "Policy sentiment" is driven by news events; the parameters below control how strongly agents react and how quickly sentiment decays.<br/>
                              Final scores map to 5 levels: Very satisfied / Fairly satisfied / Somewhat dissatisfied / Very dissatisfied / Undecided.
                            </div>
                          </div>
                        )}

                        {/* ═══ Shared params: news & sentiment dynamics ═══ */}
                        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, fontWeight: 700, fontFamily: "var(--font-cjk)", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 4 }}>
                          {predictionMode === "satisfaction" ? "📰 Public opinion & sentiment dynamics" : "📰 News impact & sentiment"}
                        </div>

                        <div title={predictionMode === "satisfaction"
                          ? "[News impact multiplier] Default: 2.0\nAmplifies how strongly news events affect agent satisfaction/anxiety.\n↑ Higher = voters react more strongly to news, larger satisfaction swings\n↓ Lower = voters are less responsive, satisfaction stays flat\nSuggested: 1.0 (quiet period) ~ 3.0 (intense news cycle)"
                          : "[News impact multiplier] Default: 2.0\nAmplifies news impact on voter approval/anxiety.\n↑ Higher = voters react more intensely, larger swings in support\n↓ Lower = voters are less reactive, support stays stable\nSuggested: 1.0 (conservative) ~ 3.0 (sensitive)"}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{ color: "#f59e0b", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>📰 News impact</span>
                            <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>news_impact</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <input type="range" min={0.5} max={5.0} step={0.1} value={newsImpact} onChange={(e) => setNewsImpact(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#f59e0b" }} />
                            <span style={{ color: "#f59e0b", fontSize: 16, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{newsImpact.toFixed(1)}</span>
                          </div>
                          <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                            {predictionMode === "satisfaction"
                              ? "Amplification of news impact on citizen reactions. 1.0=mild, 2.0=normal, 3.0~5.0=major controversy/scandal"
                              : "1.0=baseline, 2.0=recommended starting point, 3.0~5.0=intense news cycle"}
                          </div>
                        </div>

                        <div title={predictionMode === "satisfaction"
                          ? "[Daily change cap] Default: 1.5\nLimits the maximum daily swing in satisfaction/anxiety.\n↑ Higher = a single bombshell headline can cause dramatic shifts\n↓ Lower = satisfaction stays smoother, no single-day crashes"
                          : "[Daily change cap] Default: 1.0\nLimits max daily mood swing per agent.\n↑ Higher = allows more dramatic single-day sentiment shifts\n↓ Lower = suppresses extreme reactions, smoother trajectories"}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{ color: "#ef4444", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🔥 Sentiment cap</span>
                            <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>delta_cap_mult</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <input type="range" min={0.5} max={3.0} step={0.1} value={deltaCapMult} onChange={(e) => setDeltaCapMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#ef4444" }} />
                            <span style={{ color: "#ef4444", fontSize: 16, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{deltaCapMult.toFixed(1)}x</span>
                          </div>
                          <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                            {predictionMode === "satisfaction"
                              ? "Max daily satisfaction swing. 1.0x=conservative, 1.5x=normal, 2.0x=dramatic (e.g. major scandal)"
                              : "1.0x=original cap, 1.5x=+50%, 2.0x=doubled"}
                          </div>
                        </div>

                        {/* Decay rates — shared */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }} title={predictionMode === "satisfaction"
                          ? "[Anxiety decay rate] Default: 0.05\nFraction of anxiety that fades each day toward baseline (50).\n0=anxiety accumulates forever\n0.05=mild decay, ~14 days to halve\n0.15=fast decay, ~5 days to halve"
                          : "[Anxiety decay rate] Default: 0.05\nDaily regression of anxiety toward baseline (50)."}>
                            <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>anxiety_decay</span>
                            <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 9, flex: "0 0 80px" }}>Anxiety decay</span>
                            <input type="range" min={0} max={0.20} step={0.01} value={anxietyDecay} onChange={(e) => setAnxietyDecay(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#f59e0b" }} />
                            <span style={{ color: "#f59e0b", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{anxietyDecay.toFixed(2)}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }} title={predictionMode === "satisfaction"
                          ? "[Satisfaction decay rate] Default: 0.03\nDaily regression of satisfaction toward neutral (50).\nSimulates how voter feelings about governance fade over time.\n0=permanent memory, 0.03=mild, 0.10=fast fading"
                          : "[Satisfaction decay rate] Default: 0.03\nDaily regression of satisfaction toward baseline (50)."}>
                            <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>satisfaction_decay</span>
                            <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 9, flex: "0 0 80px" }}>Satisfaction decay</span>
                            <input type="range" min={0} max={0.20} step={0.01} value={satisfactionDecay} onChange={(e) => setSatisfactionDecay(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#22c55e" }} />
                            <span style={{ color: "#22c55e", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{satisfactionDecay.toFixed(2)}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }} title={predictionMode === "satisfaction"
                          ? "[News sentiment multiplier] Default: 0.15\nHow much positive/negative news differentially affects satisfaction.\nPositive governance news → satisfaction up; negative scandal → satisfaction down.\n0=no positive/negative distinction, 0.50=sentiment-dominated"
                          : "[News sentiment multiplier] Default: 0.15\nHow much news sentiment (positive/negative) adjusts candidate scores."}>
                            <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>sentiment_mult</span>
                            <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 9, flex: "0 0 80px" }}>Sentiment multiplier</span>
                            <input type="range" min={0} max={0.50} step={0.01} value={sentimentMult} onChange={(e) => setSentimentMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#a78bfa" }} />
                            <span style={{ color: "#a78bfa", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{sentimentMult.toFixed(2)}</span>
                        </div>

                        {/* ═══ Satisfaction mode: undecided & governance perception ═══ */}
                        {predictionMode === "satisfaction" && (<>
                          <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, fontWeight: 700, fontFamily: "var(--font-cjk)", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 4, marginTop: 8 }}>
                            🤷 Undecided rate controls
                          </div>
                          <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 9, lineHeight: 1.5, fontFamily: "var(--font-cjk)" }}>
                            Polls always have some respondents who decline to state a preference. This section controls the baseline and ceiling for the undecided rate.
                          </div>
                          <div title={"[Base undecided rate] Default: 0.10\nMinimum fraction of respondents who won't state a preference, regardless of candidates.\n0%=everyone responds, 10%=typical poll level, 20%=low-engagement electorate"}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span style={{ color: "#64748b", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🤷 Base undecided</span>
                              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>base_undecided</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <input type="range" min={0.0} max={0.30} step={0.01} value={baseUndecided} onChange={(e) => setBaseUndecided(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#64748b" }} />
                              <span style={{ color: "#64748b", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{(baseUndecided * 100).toFixed(0)}%</span>
                            </div>
                            <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                              0%=full turnout, 10%=typical poll, 20%=politically disengaged area
                            </div>
                          </div>
                          <div title={"[Undecided ceiling] Default: 0.45\nMaximum undecided rate.\nPrevents undecided from growing so large the poll loses meaning."}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span style={{ color: "#94a3b8", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🤷 Undecided cap</span>
                              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>max_undecided</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <input type="range" min={0.10} max={0.80} step={0.05} value={maxUndecided} onChange={(e) => setMaxUndecided(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#94a3b8" }} />
                              <span style={{ color: "#94a3b8", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{(maxUndecided * 100).toFixed(0)}%</span>
                            </div>
                            <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                              45%=normal cap, 60%=highly disengaged, 80%=extremely low response rate
                            </div>
                          </div>

                          <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, fontWeight: 700, fontFamily: "var(--font-cjk)", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 4, marginTop: 8 }}>
                            🏠 Governance perception & personality traits
                          </div>
                          <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 9, lineHeight: 1.5, fontFamily: "var(--font-cjk)" }}>
                            Controls how agent personality traits (state/federal preference, anxiety sensitivity, likability) influence satisfaction scores for each subject.
                          </div>
                          <div title={"[State/Federal match] Default: 3.0\nLocal officeholders (Governor/Mayor) are more affected when voters are dissatisfied with state/local governance.\nFederal figures (President) reflect national-issue satisfaction.\n0=no distinction, 3.0=normal, 5.0=strong differentiation"}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span style={{ color: "#f472b6", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🏠 State/Federal match</span>
                              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>profile_match_mult</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <input type="range" min={0} max={5.0} step={0.1} value={profileMatchMult} onChange={(e) => setProfileMatchMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#f472b6" }} />
                              <span style={{ color: "#f472b6", fontSize: 16, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{profileMatchMult.toFixed(1)}x</span>
                            </div>
                            <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                              Governors/Mayors affected more by state satisfaction; President by federal satisfaction. 0=no difference, 3.0=normal
                            </div>
                          </div>
                          <div style={{ marginTop: 8 }} title={"[Anxiety sensitivity] Default: 0.15\nHigh-anxiety voters are more likely to express dissatisfaction.\n0=anxiety has no effect, 0.15=moderate, 0.50=anxiety-dominated"}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span style={{ color: "#ef4444", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>😰 Anxiety sensitivity</span>
                              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>anxiety_sensitivity_mult</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <input type="range" min={0} max={0.5} step={0.01} value={anxietySensitivityMult} onChange={(e) => setAnxietySensitivityMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#ef4444" }} />
                              <span style={{ color: "#ef4444", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{anxietySensitivityMult.toFixed(2)}</span>
                            </div>
                            <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                              High-anxiety voters lean toward negative ratings. 0=no effect, 0.15=moderate, 0.50=anxiety-dominated
                            </div>
                          </div>
                          <div style={{ marginTop: 8 }} title={"[Likability bonus] Default: 8.0\nPersonal warmth/approachability bonus for the subject.\nHigh likability → maintains approval even during policy controversies.\n0=ignore personal charm, 8=moderate, 15=charisma decides everything"}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span style={{ color: "#fb923c", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🌟 Likability bonus</span>
                              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>charm_mult</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <input type="range" min={0} max={15} step={0.5} value={charmMult} onChange={(e) => setCharmMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#fb923c" }} />
                              <span style={{ color: "#fb923c", fontSize: 16, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{charmMult.toFixed(1)}</span>
                            </div>
                            <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                              Weight for personal warmth/charm. High-likability subjects maintain baseline approval even during controversy. 0=ignore, 8.0=default
                            </div>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}
                            title={"[🎭 Individuality multiplier] Default: 1.0\nScales how differently each agent reacts (cognitive bias, volatility, etc.).\n0=all agents react identically, 1.0=normal variation, 2.0=extreme variation"}>
                              <span style={{ color: "#c084fc", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-cjk)", whiteSpace: "nowrap" }}>🎭 Individuality</span>
                              <input type="range" min={0} max={2} step={0.1} value={individualityMult} onChange={(e) => setIndividualityMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#c084fc" }} />
                              <span style={{ color: "#c084fc", fontSize: 16, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{individualityMult.toFixed(1)}x</span>
                          </div>
                          <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 9, marginTop: 3, fontFamily: "var(--font-cjk)" }}>
                            Per-agent individuality params set during persona generation; this multiplier scales them all. 1.0=standard, 0=uniform
                          </div>

                          <div style={{ display: "flex", gap: 8, alignSelf: "flex-end", marginTop: 8 }}>
                            <button onClick={autoTuneParams}
                              style={{ padding: "4px 14px", borderRadius: 6, border: "1px solid rgba(251,191,36,0.3)", background: "rgba(251,191,36,0.08)", color: "#fbbf24", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.15s" }}
                            >{t("prediction.s3.workspace.btn.auto_tune")}</button>
                            <button
                              onClick={resetToTemplateDefaults}
                              style={{ padding: "4px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.25)", color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.15s" }}
                            >{t("prediction.s3.workspace.btn.reset")}</button>
                          </div>
                        </>)}

                        {/* ═══ Election mode params ═══ */}
                        {predictionMode !== "satisfaction" && (<>
                          {/* Base Undecided */}
                          <div title={"[Base undecided rate] Default: 0.25\nMinimum probability a voter stays undecided.\nEven when candidates are clearly differentiated, some voters won't commit.\n0.10=low, 0.25=moderate, 0.40=high"}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span style={{ color: "#64748b", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🤷 Base undecided</span>
                              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>base_undecided</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <input type="range" min={0.0} max={0.30} step={0.01} value={baseUndecided} onChange={(e) => setBaseUndecided(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#64748b" }} />
                              <span style={{ color: "#64748b", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{(baseUndecided * 100).toFixed(0)}%</span>
                            </div>
                            <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                              Minimum undecided probability for all agents. 0%=everyone decides, 10%=default, 20%=high indecision
                            </div>
                          </div>

                          {/* Max Undecided */}
                          <div title={"[Undecided ceiling] Default: 0.45\nAbsolute cap on undecided rate.\nPrevents undecided from growing so large the prediction loses meaning.\n0.30=conservative, 0.45=default, 0.60=lenient"}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span style={{ color: "#94a3b8", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🤷 Undecided cap</span>
                              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>max_undecided</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <input type="range" min={0.10} max={0.80} step={0.05} value={maxUndecided} onChange={(e) => setMaxUndecided(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#94a3b8" }} />
                              <span style={{ color: "#94a3b8", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{(maxUndecided * 100).toFixed(0)}%</span>
                            </div>
                            <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                              Maximum undecided rate. 45%=default, 60%=highly disengaged, 80%=extremely low turnout
                            </div>
                          </div>

                          {/* ── Candidate Differentiation Section ── */}
                          <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: 8, paddingTop: 12 }}>
                            <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, fontWeight: 700, marginBottom: 10, fontFamily: "var(--font-cjk)" }}>
                              🎯 Candidate differentiation
                            </div>

                            {/* Profile Match Multiplier */}
                            <div title={"[State/Federal profile match] Default: 3.0\nAmplifies the effect of state-vs-federal candidate positioning on voter satisfaction.\n↑ Higher = state-level candidates benefit more from local dissatisfaction\n↓ Lower = candidate positioning matters less"}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                <span style={{ color: "#f472b6", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🏠 State/Federal profile</span>
                                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>profile_match_mult</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <input type="range" min={0} max={5.0} step={0.1} value={profileMatchMult} onChange={(e) => setProfileMatchMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#f472b6" }} />
                                <span style={{ color: "#f472b6", fontSize: 16, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{profileMatchMult.toFixed(1)}x</span>
                              </div>
                              <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                                State-level vs federal candidate profile match strength. 0=off, 3.0=default, 5.0=strong differentiation
                              </div>
                            </div>

                            {/* Keyword Bonus Cap */}
                            <div style={{ marginTop: 8 }} title={"[Keyword bonus cap] Default: 10\nMax bonus from political experience and grassroots keywords in candidate descriptions.\nExperience keywords: Governor, Senator, Party Chair, etc.\nGrassroots keywords: community organizer, district office, local reputation, etc.\n↑ Higher = senior politicians gain larger advantages"}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                <span style={{ color: "#fbbf24", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🏷️ Keyword bonus cap</span>
                                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>keyword_bonus_cap</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <input type="range" min={0} max={20} step={1} value={keywordBonusCap} onChange={(e) => setKeywordBonusCap(parseInt(e.target.value))} style={{ flex: 1, accentColor: "#fbbf24" }} />
                                <span style={{ color: "#fbbf24", fontSize: 16, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{keywordBonusCap}</span>
                              </div>
                              <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                                Max bonus from political stature and grassroots keywords. 0=ignore, 10=default, 20=keywords decide everything
                              </div>
                            </div>

                            {/* Anxiety Sensitivity */}
                            <div style={{ marginTop: 8 }} title={"[Anxiety sensitivity] Default: 0.15\nHow much high-anxiety voters prefer crisis-management candidates.\n↑ More anxious voters lean toward candidates with high anxiety-handling traits.\n0=anxiety doesn't affect voting, 0.50=anxiety dominates"}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                <span style={{ color: "#ef4444", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>😰 Anxiety sensitivity</span>
                                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>anxiety_sensitivity_mult</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <input type="range" min={0} max={0.5} step={0.01} value={anxietySensitivityMult} onChange={(e) => setAnxietySensitivityMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#ef4444" }} />
                                <span style={{ color: "#ef4444", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{anxietySensitivityMult.toFixed(2)}</span>
                              </div>
                              <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                                How much anxious voters prefer crisis-handling candidates. 0=off, 0.15=default, 0.50=anxiety-dominated
                              </div>
                            </div>

                            {/* ── Individuality multiplier ── */}
                            <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", marginTop: 12, paddingTop: 10 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}
                                title={"[🎭 Individuality multiplier] Default: 1.0\nScales per-agent variation (volatility, reaction strength, memory inertia, etc.).\nThese were computed from each persona's personality traits during generation.\nThis multiplier scales them all uniformly.\n0=everyone reacts identically, 1.0=original variation, 2.0=extreme variation"}>
                                <span style={{ color: "#c084fc", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-cjk)", whiteSpace: "nowrap" }}>🎭 Individuality</span>
                                <input type="range" min={0} max={2} step={0.1} value={individualityMult} onChange={(e) => setIndividualityMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#c084fc" }} />
                                <span style={{ color: "#c084fc", fontSize: 16, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{individualityMult.toFixed(1)}x</span>
                              </div>
                              <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 9, marginTop: 3, fontFamily: "var(--font-cjk)" }}>
                                Per-agent individuality (cognitive bias, volatility, reaction strength) set during persona generation; this multiplier scales them all.
                              </div>
                            </div>

                            {/* Charm Multiplier */}
                            <div style={{ marginTop: 8 }} title={"[Likability/warmth bonus] Default: 8.0\nWeight for candidate personal charm (warmth, approachability).\nIndependent of party — reflects personal appeal.\n0=ignore charm, 8=moderate, 15=charisma decides everything"}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                <span style={{ color: "#fb923c", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🌟 Likability/warmth</span>
                                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>charm_mult</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <input type="range" min={0} max={15} step={0.5} value={charmMult} onChange={(e) => setCharmMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#fb923c" }} />
                                <span style={{ color: "#fb923c", fontSize: 16, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{charmMult.toFixed(1)}</span>
                              </div>
                              <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                                Candidate personal charm (warmth, approachability, likability) scoring weight. Independent of party — reflects personal appeal.<br/>0=ignore, 8.0=default, 15=charisma decides everything
                              </div>
                            </div>

                            {/* Cross-Party Appeal Multiplier */}
                            <div style={{ marginTop: 8 }} title={"[Cross-party appeal] Default: 0.6\nCandidate's ability to attract voters from the opposing party.\nHigh cross-party candidates can win over swing and soft-partisan voters.\n0=no cross-party effect, 0.6=moderate, 1.0=strong cross-party pull"}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                <span style={{ color: "#a3e635", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🤝 Cross-party appeal</span>
                                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>cross_appeal_mult</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <input type="range" min={0} max={1.0} step={0.05} value={crossAppealMult} onChange={(e) => setCrossAppealMult(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#a3e635" }} />
                                <span style={{ color: "#a3e635", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{crossAppealMult.toFixed(2)}</span>
                              </div>
                              <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                                How much a high cross-party candidate reduces voting resistance from opposition voters (e.g. a moderate Republican attracting swing Dems).<br/>0=off (fixed 25% resistance), 0.6=default, 1.0=fully eliminates resistance
                              </div>
                            </div>
                          </div>

                          {/* ── Undecided Formula Section ── */}
                          <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: 8, paddingTop: 12 }}>
                            <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, fontWeight: 700, marginBottom: 10, fontFamily: "var(--font-cjk)" }}>
                              🤷 Advanced undecided factors
                            </div>

                            {/* Close Race Weight */}
                            <div title={"[Close-race weight] Default: 0.8\nWhen candidate scores are close, undecided rate increases.\nThe tighter the race, the more voters hesitate.\n0=closeness doesn't matter, 0.8=moderate effect"}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                <span style={{ color: "#06b6d4", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>⚖️ Close-race hesitation</span>
                                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>close_race_weight</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <input type="range" min={0} max={2.0} step={0.1} value={closeRaceWeight} onChange={(e) => setCloseRaceWeight(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#06b6d4" }} />
                                <span style={{ color: "#06b6d4", fontSize: 16, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{closeRaceWeight.toFixed(1)}</span>
                              </div>
                              <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                                When scores are close, undecided rate goes up. 0=off, 0.8=default, 2.0=strong effect
                              </div>
                            </div>

                            {/* Same Party Penalty */}
                            <div style={{ marginTop: 8 }} title={"[Same-party primary penalty] Default: 0.06\nIn a same-party primary, voters have a harder time deciding.\nIncreases undecided rate when candidates share a party.\n0=no extra undecided, 0.06=moderate, 0.15=high"}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                <span style={{ color: "#8b5cf6", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🏛️ Same-party penalty</span>
                                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>same_party_penalty</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <input type="range" min={0} max={0.20} step={0.01} value={samePartyPenalty} onChange={(e) => setSamePartyPenalty(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#8b5cf6" }} />
                                <span style={{ color: "#8b5cf6", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{(samePartyPenalty * 100).toFixed(0)}%</span>
                              </div>
                              <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                                Extra undecided when two same-party candidates face off. 0%=off, 6%=default, 20%=high confusion
                              </div>
                            </div>

                            {/* No Match Penalty */}
                            <div style={{ marginTop: 8 }} title={"[No-party-match penalty] Default: 0.08\nWhen a voter's party lean doesn't match any candidate, undecided rate rises.\nExample: independent voter facing a D-vs-R race.\n0=no effect, 0.08=moderate, 0.20=strong undecided"}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                <span style={{ color: "#d946ef", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>🚫 No-party-match penalty</span>
                                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>no_match_penalty</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <input type="range" min={0} max={0.25} step={0.01} value={noMatchPenalty} onChange={(e) => setNoMatchPenalty(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#d946ef" }} />
                                <span style={{ color: "#d946ef", fontSize: 16, fontWeight: 700, minWidth: 50, textAlign: "right" }}>{(noMatchPenalty * 100).toFixed(0)}%</span>
                              </div>
                              <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, marginTop: 2 }}>
                                Extra undecided when voter lean doesn't match any candidate's party. 0%=off, 8%=default, 25%=strong rejection
                              </div>
                            </div>
                          </div>

                          <div style={{ display: "flex", gap: 8, alignSelf: "flex-end" }}>
                            <button onClick={autoTuneParams}
                              style={{ padding: "4px 14px", borderRadius: 6, border: "1px solid rgba(251,191,36,0.3)", background: "rgba(251,191,36,0.08)", color: "#fbbf24", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.15s" }}
                            >{t("prediction.s3.workspace.btn.auto_tune")}</button>
                            <button
                              onClick={resetToTemplateDefaults}
                              style={{ padding: "4px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.25)", color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.15s" }}
                            >{t("prediction.s3.workspace.btn.reset")}</button>
                          </div>
                        </>)}
                      </div>
                    )}

                    {/* Tab: Dynamic Leaning Shift */}
                    {paramWorkspaceTab === "leaning" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "rgba(255,255,255,0.8)", fontSize: 13, fontWeight: "bold", fontFamily: "var(--font-cjk)" }} title={"[Dynamic leaning shift]\nWhen enabled, agents experiencing prolonged high anxiety / low satisfaction may shift their political leaning.\nExample: Lean Rep → Tossup (simulating voter disillusionment with their party)"}>
                          <input type="checkbox" checked={enableDynamicLeaning} onChange={(e) => setEnableDynamicLeaning(e.target.checked)} style={{ width: 16, height: 16, accentColor: "#fbbf24" }} />
                          {t("prediction.s3.workspace.dynamic_lean.label")}
                        </label>
                        <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5 }}>
                          {t("prediction.s3.workspace.dynamic_lean.desc")}
                        </div>
                        {enableDynamicLeaning && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }} title={"[Leaning shift threshold (satisfaction)] Default: 25\nWhen satisfaction drops below this value, shift countdown begins"}>
                              <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, width: 120, textAlign: "right", fontFamily: "var(--font-cjk)" }}>{t("prediction.s3.workspace.dynamic_lean.sat_threshold")}</span>
                              <input type="range" min={5} max={50} step={1} value={shiftSatLow} onChange={(e) => setShiftSatLow(parseInt(e.target.value))} style={{ flex: 1, accentColor: "#22c55e" }} />
                              <span style={{ color: "#22c55e", fontSize: 14, fontWeight: 700, minWidth: 30, textAlign: "right" }}>{shiftSatLow}</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }} title={"[Leaning shift threshold (anxiety)] Default: 75\nWhen anxiety rises above this value, shift countdown begins"}>
                              <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, width: 120, textAlign: "right", fontFamily: "var(--font-cjk)" }}>{t("prediction.s3.workspace.dynamic_lean.anx_threshold")}</span>
                              <input type="range" min={50} max={95} step={1} value={shiftAnxHigh} onChange={(e) => setShiftAnxHigh(parseInt(e.target.value))} style={{ flex: 1, accentColor: "#ef4444" }} />
                              <span style={{ color: "#ef4444", fontSize: 14, fontWeight: 700, minWidth: 30, textAlign: "right" }}>{shiftAnxHigh}</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }} title={"[Consecutive days required] Default: 3\nHow many consecutive days thresholds must be met to trigger a leaning shift"}>
                              <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, width: 120, textAlign: "right", fontFamily: "var(--font-cjk)" }}>{t("prediction.s3.workspace.dynamic_lean.days_required")}</span>
                              <input type="number" min={1} max={14} value={shiftDaysReq} onChange={(e) => setShiftDaysReq(parseInt(e.target.value) || 3)} style={{ width: 60, padding: "4px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 13, textAlign: "center" as any, outline: "none" }} />
                              <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>{t("prediction.s3.workspace.dynamic_lean.days_unit")}</span>
                            </div>
                            <div style={{ color: "rgba(255,255,255,0.25)", fontSize: 10, lineHeight: 1.5, fontFamily: "var(--font-cjk)" }}>
                              {t("prediction.s3.workspace.dynamic_lean.summary", { days: shiftDaysReq, sat: shiftSatLow, anx: shiftAnxHigh })}
                            </div>
                          </div>
                        )}
                        <button
                          onClick={() => { setEnableDynamicLeaning(true); setShiftSatLow(25); setShiftAnxHigh(75); setShiftDaysReq(3); }}
                          style={{ alignSelf: "flex-end", padding: "4px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.25)", color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.15s" }}
                        >{t("prediction.s3.workspace.btn.reset")}</button>
                      </div>
                    )}

                    {/* Tab: Candidate Base Scores */}
                    {paramWorkspaceTab === "candidate" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5 }}>
                          {predictionMode === "satisfaction" ? t("prediction.s3.workspace.candidate.subtitle_sat") : t("prediction.s3.workspace.candidate.subtitle_elec")}
                        </div>

                        {/* Calculation principle box */}
                        <div style={{ padding: "12px 14px", borderRadius: 10, background: "linear-gradient(135deg, rgba(34,197,94,0.08), rgba(16,185,129,0.04))", border: "1px solid rgba(34,197,94,0.18)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                            <span style={{ fontSize: 13 }}>🧮</span>
                            <span style={{ color: "#4ade80", fontSize: 12, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{t("prediction.s3.workspace.candidate.calc_title")}</span>
                            <span style={{ color: "rgba(255,255,255,0.25)", fontSize: 10, marginLeft: 4 }}>{t("prediction.s3.workspace.candidate.calc_subtitle")}</span>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                            {[
                              { key: t("prediction.s3.workspace.candidate.item.party_base"), color: "#22c55e", icon: "🏛️", range: "18–35",
                                desc: t("prediction.s3.workspace.candidate.item.party_base_desc") },
                              { key: t("prediction.s3.workspace.candidate.item.role_bonus"), color: "#3b82f6", icon: "👤", range: "0–10",
                                desc: t("prediction.s3.workspace.candidate.item.role_bonus_desc") },
                              { key: t("prediction.s3.workspace.candidate.item.incumb_bonus"), color: "#f59e0b", icon: "⭐", range: "0 / 8",
                                desc: t("prediction.s3.workspace.candidate.item.incumb_bonus_desc") },
                              { key: t("prediction.s3.workspace.candidate.item.vis_adj"), color: "#a78bfa", icon: "📡", range: "-7–+7",
                                desc: t("prediction.s3.workspace.candidate.item.vis_adj_desc") },
                            ].map(item => (
                              <div key={item.key} style={{ padding: "7px 8px", borderRadius: 7, background: "rgba(0,0,0,0.25)", border: `1px solid ${item.color}25` }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                                  <span style={{ fontSize: 11 }}>{item.icon}</span>
                                  <span style={{ color: item.color, fontSize: 10, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{item.key}</span>
                                </div>
                                <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 9, lineHeight: 1.5, fontFamily: "var(--font-cjk)" }}>{item.desc}</div>
                                <div style={{ color: item.color, fontSize: 9, fontWeight: 600, marginTop: 3, fontFamily: "var(--font-mono)" }}>{t("prediction.s3.workspace.candidate.range", { range: item.range })}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 9, marginTop: 8, lineHeight: 1.5, fontFamily: "var(--font-cjk)" }}>
                            {t("prediction.s3.workspace.candidate.calc_footnote")}
                          </div>
                        </div>

                        {/* Dynamic per-candidate/party sliders from poll groups or survey items */}
                        {(() => {
                          const allCandidates: {name: string; description: string; isIncumbent?: boolean; localVisibility?: number; nationalVisibility?: number; role?: string; party?: string}[] = [];
                          if (predictionMode === "satisfaction") {
                            surveyItems.filter(s => s.name.trim()).forEach(s => {
                              if (!allCandidates.find(x => x.name === s.name)) allCandidates.push({ name: s.name, description: s.party || "", role: s.role, party: s.party });
                            });
                          } else {
                            pollGroups.forEach(g => g.candidates?.forEach((c: any) => {
                              if (!allCandidates.find(x => x.name === c.name)) allCandidates.push(c);
                            }));
                            if (allCandidates.length === 0 && pollOptions.length > 0) {
                              pollOptions.forEach((o: any) => {
                                if (!allCandidates.find(x => x.name === o.name)) allCandidates.push(o);
                              });
                            }
                          }
                          if (allCandidates.length === 0) return <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, fontFamily: "var(--font-cjk)" }}>{predictionMode === "satisfaction" ? t("prediction.s3.workspace.candidate.empty_sat") : t("prediction.s3.workspace.candidate.empty_elec")}</div>;

                          return (<>
                            {/* Auto-compute button */}
                            <button
                              onClick={() => {
                                const newScores: Record<string, number> = {};
                                const newBreakdown: Record<string, {total: number; breakdown: {label: string; value: number; reason: string}[]}> = {};
                                allCandidates.forEach(c => {
                                  const result = computeSmartBaseScore(c);
                                  newScores[c.name] = result.total;
                                  newBreakdown[c.name] = result;
                                });
                                setPartyBaseScores(prev => ({ ...prev, ...newScores }));
                                setBaseScoreBreakdown(newBreakdown);
                              }}
                              style={{ alignSelf: "flex-start", padding: "6px 16px", borderRadius: 6, border: "1px solid rgba(34,197,94,0.4)", background: "rgba(34,197,94,0.1)", color: "#4ade80", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-cjk)", fontWeight: 600, transition: "all 0.15s" }}
                            >{t("prediction.s3.workspace.btn.auto_compute_base")}</button>

                            {/* Per-candidate sliders + optional breakdown */}
                            {allCandidates.map(c => {
                              const key = c.name;
                              const val = partyBaseScores[key] ?? getPartyDefault(c.description || c.name);
                              const cColor = detectPartyColor(c.name, c.description || "") || "#a78bfa";
                              const bd = baseScoreBreakdown[key];
                              return (
                                <div key={key}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <div style={{ width: 140, fontSize: 12, color: cColor, fontWeight: 600, textAlign: "right", fontFamily: "var(--font-cjk)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{key}</div>
                                    <input type="range" min={5} max={70} value={val} onChange={(e: any) => setPartyBaseScores((prev: any) => ({ ...prev, [key]: parseInt(e.target.value) }))} style={{ flex: 1, accentColor: cColor }} />
                                    <div style={{ width: 30, fontSize: 13, color: "#fff", fontWeight: 700, textAlign: "center" }}>{val}</div>
                                  </div>
                                  {/* Breakdown detail */}
                                  {bd && (
                                    <div style={{ marginLeft: 148, marginTop: 2, marginBottom: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                                      {bd.breakdown.map((b, i) => (
                                        <span key={i} title={b.reason} style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", fontSize: 9, color: b.value >= 0 ? "rgba(74,222,128,0.7)" : "rgba(239,68,68,0.7)", fontFamily: "var(--font-cjk)", cursor: "help" }}>
                                          {b.label} {b.value >= 0 ? "+" : ""}{b.value}
                                        </span>
                                      ))}
                                      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "var(--font-mono)" }}>= {bd.total}</span>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </>);
                        })()}
                        {/* Common parameters */}
                        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", marginTop: 4, paddingTop: 8 }}>
                          <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, marginBottom: 6 }}>{t("prediction.s3.workspace.common_params")}</div>
                          {[
                            { label: "Party alignment", value: spAlignBonus, set: setSpAlignBonus, min: 0, max: 30, color: "#22c55e", title: "[Party alignment bonus] Default: 15\nExtra points when a voter's party lean matches the candidate's party.\n↑ Higher = Dems-vote-Dem / Reps-vote-Rep effect is stronger\n↓ Lower = party ID matters less for vote choice\n0 = no party effect at all" },
                            { label: "Incumbency bonus", value: spIncumbBonus, set: setSpIncumbBonus, min: 0, max: 25, color: "#f59e0b", title: "[Incumbency bonus] Default: 12\nExtra points for the incumbent (or incumbent-party) candidate.\nReflects advantages of administrative resources, name recognition, and governance record.\n0 = no incumbency edge, 12 = moderate, 25 = massive advantage" },
                          ].map(p => (
                            <div key={p.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }} title={p.title}>
                              <div style={{ width: 140, fontSize: 12, color: p.color, fontWeight: 600, textAlign: "right", fontFamily: "var(--font-cjk)" }}>{p.label}</div>
                              <input type="range" min={p.min} max={p.max} value={p.value} onChange={(e: any) => p.set(parseInt(e.target.value))} style={{ flex: 1, accentColor: p.color }} />
                              <div style={{ width: 30, fontSize: 13, color: "#fff", fontWeight: 700, textAlign: "center" }}>{p.value}</div>
                            </div>
                          ))}
                          {/* Party divergence slider */}
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }} title={"[Party directional divergence] Default: 0.5\nHow much satisfaction/anxiety changes differ by party alignment.\n↑ Higher = same-party candidates trend together, opposing party suppressed\n↓ Lower = candidates driven more by personal traits than party\n0 = no party-driven divergence"}>
                            <div style={{ width: 140, fontSize: 12, color: "#f472b6", fontWeight: 600, textAlign: "right", fontFamily: "var(--font-cjk)" }}>Party divergence</div>
                            <input type="range" min={0} max={10} value={Math.round(spDivergenceMult * 10)} onChange={(e: any) => setSpDivergenceMult(parseInt(e.target.value) / 10)} style={{ flex: 1, accentColor: "#f472b6" }} />
                            <div style={{ width: 30, fontSize: 13, color: "#fff", fontWeight: 700, textAlign: "center" }}>{spDivergenceMult.toFixed(1)}</div>
                          </div>
                          <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 9, marginLeft: 148, marginBottom: 8, lineHeight: 1.5, fontFamily: "var(--font-cjk)" }}>
                            ↑ Higher = same-party candidates stabilize, opposing party suppressed; ↓ Lower = personal traits matter more (0=no party effect)
                          </div>
                        </div>
                        <button
                          onClick={() => { const cp = activeTemplate?.election?.default_calibration_params || {}; const seeded = getDefaultCandidateBaseScores(activeTemplate); setPartyBaseScores(Object.keys(seeded).length > 0 ? seeded : {}); setSpAlignBonus(cp.party_align_bonus ?? 15); setSpIncumbBonus(cp.incumbency_bonus ?? 12); setSpDivergenceMult(cp.party_divergence_mult ?? 0.5); setCandidateTraits({}); }}
                          style={{ alignSelf: "flex-end", padding: "4px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.25)", color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.15s" }}
                        >{t("prediction.s3.workspace.btn.reset")}</button>
                      </div>
                    )}

                    {/* Tab: Candidate Traits */}
                    {paramWorkspaceTab === "traits" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

                        {/* ── Calculation logic explainer ── */}
                        <div style={{ padding: "12px 14px", borderRadius: 10, background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.05))", border: "1px solid rgba(99,102,241,0.2)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                            <span style={{ fontSize: 13 }}>🧠</span>
                            <span style={{ color: "#a5b4fc", fontSize: 12, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{t("prediction.s3.workspace.traits.calc_title")}</span>
                            <span style={{ color: "rgba(255,255,255,0.25)", fontSize: 10, marginLeft: 4 }}>{t("prediction.s3.workspace.traits.calc_subtitle")}</span>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
                            {[
                              { key: t("prediction.s3.workspace.traits.dim.local"), color: "#f472b6", icon: "🏙️", desc: t("prediction.s3.workspace.traits.dim.local_desc") },
                              { key: t("prediction.s3.workspace.traits.dim.national"), color: "#38bdf8", icon: "🌐", desc: t("prediction.s3.workspace.traits.dim.national_desc") },
                              { key: t("prediction.s3.workspace.traits.dim.anxiety"), color: "#ef4444", icon: "⚠️", desc: t("prediction.s3.workspace.traits.dim.anxiety_desc") },
                              { key: t("prediction.s3.workspace.traits.dim.charm"), color: "#fb923c", icon: "✨", desc: t("prediction.s3.workspace.traits.dim.charm_desc") },
                              { key: t("prediction.s3.workspace.traits.dim.cross"), color: "#a3e635", icon: "🤝", desc: t("prediction.s3.workspace.traits.dim.cross_desc") },
                            ].map(item => (
                              <div key={item.key} style={{ padding: "7px 8px", borderRadius: 7, background: "rgba(0,0,0,0.25)", border: `1px solid ${item.color}25` }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                                  <span style={{ fontSize: 11 }}>{item.icon}</span>
                                  <span style={{ color: item.color, fontSize: 11, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{item.key}</span>
                                </div>
                                <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 9.5, lineHeight: 1.5, fontFamily: "var(--font-cjk)" }}>{item.desc}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.15)" }}>
                            <div style={{ color: "rgba(165,180,252,0.8)", fontSize: 9.5, lineHeight: 1.6, fontFamily: "var(--font-cjk)" }}>
                              {t("prediction.s3.workspace.traits.flow", { model: process.env.NEXT_PUBLIC_LLM_MODEL || "GPT-4o-mini" })}
                            </div>
                          </div>
                        </div>

                        <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 1.5, fontFamily: "var(--font-cjk)" }}>
                          {t("prediction.s3.workspace.traits.dim_intro", { kind: predictionMode === "satisfaction" ? t("prediction.s3.workspace.traits.kind_sat") : t("prediction.s3.workspace.traits.kind_elec") })}
                        </div>

                        {(() => {
                          const DEFAULTS: Record<string, {loc: number, nat: number, anx: number, charm: number, cross: number}> = {
                            // TW politician defaults removed (Stage 1.9)
                          };
                          const allCandidates: {name: string, description: string}[] = [];
                          if (predictionMode === "satisfaction") {
                            surveyItems.filter(s => s.name.trim()).forEach(s => {
                              if (!allCandidates.find(x => x.name === s.name)) allCandidates.push({ name: s.name, description: s.party || "" });
                            });
                          } else {
                            pollGroups.forEach(g => g.candidates?.forEach((c: any) => {
                              if (!allCandidates.find(x => x.name === c.name)) allCandidates.push(c);
                            }));
                            if (allCandidates.length === 0 && pollOptions.length > 0) {
                              pollOptions.forEach((o: any) => {
                                if (!allCandidates.find(x => x.name === o.name)) allCandidates.push(o);
                              });
                            }
                          }
                          if (allCandidates.length === 0) return (
                            <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, fontFamily: "var(--font-cjk)" }}>
                              {predictionMode === "satisfaction" ? t("prediction.s3.workspace.traits.empty_sat") : t("prediction.s3.workspace.traits.empty_elec")}
                            </div>
                          );
                          const getDefault = (name: string) => {
                            for (const [k, v] of Object.entries(DEFAULTS)) { if (name.includes(k)) return v; }
                            return {loc: 30, nat: 20, anx: 15, charm: 35, cross: 20};
                          };
                          const dims = [
                            { key: "loc" as const, label: t("prediction.s3.workspace.traits.dim.local"), color: "#f472b6" },
                            { key: "nat" as const, label: t("prediction.s3.workspace.traits.dim.national"), color: "#38bdf8" },
                            { key: "anx" as const, label: t("prediction.s3.workspace.traits.dim.anxiety"), color: "#ef4444" },
                            { key: "charm" as const, label: t("prediction.s3.workspace.traits.dim.charm"), color: "#fb923c" },
                            { key: "cross" as const, label: t("prediction.s3.workspace.traits.dim.cross"), color: "#a3e635" },
                          ];
                          return (
                            <>
                              {/* loading overlay per candidate */}
                              {autoTraitsLoading && (
                                <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.25)", display: "flex", alignItems: "center", gap: 10 }}>
                                  <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(165,180,252,0.3)", borderTopColor: "#a5b4fc", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                                  <span style={{ color: "#a5b4fc", fontSize: 12, fontFamily: "var(--font-cjk)" }}>
                                    {t("prediction.s3.workspace.traits.querying", { n: allCandidates.length, kind: predictionMode === "satisfaction" ? t("prediction.s3.workspace.traits.kind_sat") : t("prediction.s3.workspace.traits.kind_elec") })}
                                  </span>
                                </div>
                              )}
                              {allCandidates.map(cand => {
                                const cColor = detectPartyColor(cand.name, cand.description || "") || "#a78bfa";
                                const def = getDefault(cand.name);
                                const cur = candidateTraits[cand.name] || def;
                                const reasoning = autoTraitsReasoning[cand.name] || {};
                                const hasReasoning = Object.values(reasoning).some(v => v);
                                return (
                                  <div key={cand.name} style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
                                      <div style={{ fontSize: 12, color: cColor, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{cand.name}</div>
                                      {hasReasoning && (
                                        <span style={{ fontSize: 9, color: "rgba(165,180,252,0.7)", background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 4, padding: "1px 5px", fontFamily: "var(--font-cjk)" }}>{t("prediction.s3.workspace.traits.ai_tag")}</span>
                                      )}
                                    </div>
                                    {dims.map(d => {
                                      const reason = reasoning[d.key];
                                      return (
                                        <div key={d.key} style={{ marginBottom: reason ? 6 : 3 }}>
                                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                            <div style={{ width: 36, fontSize: 10, color: d.color, fontWeight: 600, textAlign: "right", fontFamily: "var(--font-cjk)", flexShrink: 0 }}>{d.label}</div>
                                            <input type="range" min={0} max={80} value={cur[d.key]} onChange={(e: any) => {
                                              const v = parseInt(e.target.value);
                                              setCandidateTraits(prev => ({
                                                ...prev,
                                                [cand.name]: { ...(prev[cand.name] || def), [d.key]: v }
                                              }));
                                            }} style={{ flex: 1, accentColor: d.color, height: 4 }} />
                                            <div style={{ width: 24, fontSize: 11, color: "#fff", fontWeight: 700, textAlign: "center", flexShrink: 0 }}>{cur[d.key]}</div>
                                          </div>
                                          {reason && (
                                            <div style={{ marginLeft: 42, fontSize: 9, color: `${d.color}99`, fontFamily: "var(--font-cjk)", lineHeight: 1.4, marginTop: 1 }}>
                                              💬 {reason}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })}
                              {/* Bottom action buttons */}
                              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 2 }}>
                                <button
                                  onClick={() => { setCandidateTraits({}); setAutoTraitsReasoning({}); }}
                                  disabled={autoTraitsLoading}
                                  style={{ padding: "5px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.25)", color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: autoTraitsLoading ? "not-allowed" : "pointer", fontFamily: "var(--font-cjk)", transition: "all 0.15s" }}
                                >{t("prediction.s3.workspace.btn.reset_traits")}</button>
                                <button
                                  onClick={() => handleAutoComputeTraits(allCandidates)}
                                  disabled={autoTraitsLoading || allCandidates.length === 0}
                                  style={{
                                    padding: "5px 16px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                                    border: "none",
                                    background: autoTraitsLoading ? "rgba(99,102,241,0.3)" : "linear-gradient(135deg, #6366f1, #8b5cf6)",
                                    color: autoTraitsLoading ? "rgba(255,255,255,0.4)" : "#fff",
                                    cursor: autoTraitsLoading || allCandidates.length === 0 ? "not-allowed" : "pointer",
                                    fontFamily: "var(--font-cjk)", transition: "all 0.15s",
                                    boxShadow: autoTraitsLoading ? "none" : "0 2px 10px rgba(99,102,241,0.35)",
                                  }}
                                >
                                  {autoTraitsLoading ? t("prediction.s3.workspace.btn.auto_compute_loading") : t("prediction.s3.workspace.btn.auto_compute")}
                                </button>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </div>


                  </div>

                  {/* Persona tracking removed — simplified UI */}
                  <div style={{ flex: "1 1 300px", display: "none" }}>
                    <h3 style={{ color: "#fff", fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 8, fontFamily: "var(--font-cjk)" }}>👤 追蹤 Persona（選填）</h3>
              <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginBottom: 6, fontFamily: "var(--font-cjk)" }}>Select personas to track in detail — shows live updates during the run</div>
              {wsPersonas.length > 0 ? (
                <>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                    <select value={pinCategory} onChange={e => setPinCategory(e.target.value)} style={{ padding: "2px 6px", borderRadius: 5, border: "1px solid rgba(139,92,246,0.3)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 10 }}>
                      <option value="all">All</option>
                      {Array.from(new Set(wsPersonas.map(p => p.political_leaning))).sort().map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                    <select
                      value=""
                      onChange={e => {
                        const pid = e.target.value;
                        if (pid === "__random__") {
                          const avail = (pinCategory === "all" ? wsPersonas : wsPersonas.filter(p => p.political_leaning === pinCategory)).filter(p => !pinnedPersonaIds.includes(p.id));
                          if (avail.length > 0) { const pick = avail[Math.floor(Math.random() * avail.length)]; setPinnedPersonaIds(prev => [...prev, pick.id]); }
                        } else if (pid && !pinnedPersonaIds.includes(pid)) {
                          setPinnedPersonaIds(prev => [...prev, pid]);
                        }
                      }}
                      disabled={running}
                      style={{ padding: "2px 6px", borderRadius: 5, border: "1px solid rgba(139,92,246,0.3)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 10, maxWidth: 180 }}
                    >
                      <option value="">+ 新增</option>
                      <option value="__random__">🎲 隨機</option>
                      {(pinCategory === "all" ? wsPersonas : wsPersonas.filter(p => p.political_leaning === pinCategory)).filter(p => !pinnedPersonaIds.includes(p.id)).map(p => (
                        <option key={p.id} value={p.id}>{p.name} ({p.political_leaning})</option>
                      ))}
                    </select>
                  </div>
                  {pinnedPersonaIds.length > 0 ? (
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {pinnedPersonaIds.map(pid => {
                        const p = wsPersonas.find(x => x.id === pid);
                        return (
                          <span key={pid} style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.25)", color: "#a78bfa", fontSize: 10, display: "flex", alignItems: "center", gap: 3 }}>
                            {p?.name || pid}
                            <button onClick={() => setPinnedPersonaIds(prev => prev.filter(x => x !== pid))} disabled={running} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: 10, padding: 0, lineHeight: 1 }}>×</button>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ color: "rgba(255,255,255,0.2)", fontSize: 10, fontStyle: "italic", fontFamily: "var(--font-cjk)" }}>None selected — can add after the run starts</div>
                  )}
                </>
              ) : (
                <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "var(--font-cjk)" }}>Loading...</div>
              )}
                  </div>
                </div>
            </div>

            {/* Structural Events Editor - hidden (replaced by dynamic search) */}
            <div style={{ ...card, display: "none" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <h3 style={{ color: "#fff", fontSize: 16, fontWeight: 700, margin: 0, fontFamily: "var(--font-cjk)" }}>📆 模擬期間事件分配 (預覽/編輯)</h3>
                  <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, marginTop: 4, fontFamily: "var(--font-cjk)" }}>若由 AI 抓取新聞，會自動按days數平均分配於此。您可以手動微調每days會發生的事件。</div>
                </div>
                <button onClick={handleAddEventDay} disabled={running} style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.08)", color: "#3b82f6", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-cjk)" }}>＋ 新增days數</button>
              </div>

              {/* Redistribution control */}
              <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(59,130,246,0.15)", background: "rgba(59,130,246,0.04)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "bold" }}>🔄 重新分配所有新聞至</span>
                <input type="number" min={1} max={90} value={simDays} onChange={(e) => setSimDays(Number(e.target.value))} disabled={running} style={{ width: 60, padding: "4px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 13, textAlign: "center", outline: "none" }} />
                <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "bold" }}>days</span>
                <button
                  onClick={() => {
                    const target = simDays || 30;
                    let allNews = predEventsData.flatMap(d => d.news);
                    
                    if (allNews.length === 0 && baseNews.trim()) {
                      const lines = baseNews.trim().split("\n");
                      allNews = lines.filter(Boolean).map((line: string) => {
                        let title = line;
                        let summary = "";
                        const dateMatch = line.match(/^\[(.*?)\]\s*(.*)/);
                        if (dateMatch) title = dateMatch[2];
                        const spl = title.split(" — ");
                        if (spl.length > 1) {
                          title = spl[0];
                          summary = spl.slice(1).join(" — ");
                        }
                        return { title: title.trim(), summary: summary.trim(), source_tag: "歷史" };
                      });
                    }

                    const n = allNews.length;
                    if (n === 0) return;

                    const merged: typeof predEventsData = [];
                    if (n <= target) {
                      for (let d = 0; d < target; d++) merged.push({ day: d + 1, news: [] });
                      for (let i = 0; i < n; i++) {
                        const dayIdx = Math.floor((i * target) / n);
                        merged[dayIdx].news.push(allNews[i]);
                      }
                    } else {
                      for (let d = 0; d < target; d++) {
                        const start = Math.floor((d * n) / target);
                        const end = Math.floor(((d + 1) * n) / target);
                        const dayNews = allNews.slice(start, end);
                        if (dayNews.length > 0) merged.push({ day: d + 1, news: dayNews });
                      }
                    }
                    setPredEventsData(merged);
                    // Update baseNews to reflect changes
                    const newLines = merged.flatMap(d => d.news.map(nItem => `[2026-03-${String(24+d.day).padStart(2,'0')}] ${nItem.title} ${nItem.summary ? `— ${nItem.summary}`:''}`)).join("\n");
                    setBaseNews(newLines);
                  }}
                  disabled={(predEventsData.length === 0 && !baseNews.trim()) || running}
                  style={{ padding: "5px 14px", borderRadius: 6, border: "none", background: (predEventsData.length > 0 || baseNews.trim()) ? "linear-gradient(135deg, #3b82f6, #2563eb)" : "rgba(255,255,255,0.08)", color: (predEventsData.length > 0 || baseNews.trim()) ? "#fff" : "rgba(255,255,255,0.3)", fontSize: 12, fontWeight: 600, cursor: (predEventsData.length > 0 || baseNews.trim()) ? "pointer" : "not-allowed", fontFamily: "var(--font-cjk)" }}
                >Redistribute</button>
              </div>

              {/* Per-day events list */}
              {predEventsData.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {predEventsData.map((dayData, dIdx) => (
                    <div key={dIdx} style={{ padding: "12px", background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <div style={{ color: "#3b82f6", fontSize: 14, fontWeight: "bold" }}>Day {dayData.day}</div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button onClick={() => handleAddEventNews(dIdx)} disabled={running} style={{ padding: "3px 10px", background: "rgba(255,255,255,0.05)", border: "none", borderRadius: 4, color: "rgba(255,255,255,0.8)", fontSize: 11, cursor: "pointer" }}>＋ 新增事件</button>
                          <button onClick={() => handleRemoveEventDay(dIdx)} disabled={running} style={{ padding: "3px 10px", background: "rgba(239,68,68,0.1)", border: "none", borderRadius: 4, color: "#ef4444", fontSize: 11, cursor: "pointer" }}>刪除days數</button>
                        </div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {dayData.news.map((n, nIdx) => (
                          <div key={nIdx} style={{ display: "flex", alignItems: "flex-start", gap: 8, paddingLeft: 10, borderLeft: "2px solid rgba(59,130,246,0.3)" }}>
                            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                              <div style={{ display: "flex", gap: 8 }}>
                                <input value={n.title} onChange={(e) => handleEventNewsChange(dIdx, nIdx, "title", e.target.value)} disabled={running} placeholder="新聞標題..." style={{ flex: 3, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "#fff", fontSize: 12, outline: "none" }} />
                                <input value={n.source_tag} onChange={(e) => handleEventNewsChange(dIdx, nIdx, "source_tag", e.target.value)} disabled={running} placeholder="新聞來源 (如 TVBS)" style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "#fff", fontSize: 12, outline: "none" }} />
                              </div>
                              <textarea value={n.summary} onChange={(e) => handleEventNewsChange(dIdx, nIdx, "summary", e.target.value)} disabled={running} placeholder="詳細內容 (可留空)..." rows={1} style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.7)", fontSize: 11, outline: "none", resize: "vertical" }} />
                            </div>
                            <button onClick={() => handleRemoveEventNews(dIdx, nIdx)} disabled={running} style={{ padding: "6px 8px", borderRadius: 6, border: "none", background: "rgba(239,68,68,0.1)", color: "#ef4444", fontSize: 12, cursor: "pointer", marginTop: 2 }}>✕</button>
                          </div>
                        ))}
                        {dayData.news.length === 0 && <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, paddingLeft: 10, fontStyle: "italic" }}>此days尚無事件，將作為安靜日</div>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ textAlign: "center", color: "rgba(255,255,255,0.3)", fontSize: 12, padding: "20px 0" }}>目前沒有結構化的新聞事件，您可以在「① 基礎事實」自動抓取，或手動新增。</div>
              )}
            </div>

          </div>
          </div>

          {/* Detect primary mode from poll groups having head2head type */}
          {(() => {
            const isPrimary = pollGroups.some(g => g.groupType === "head2head");
            if (isPrimary && !rollingMode) {
              // Auto-detect, don't set in render — use effect
            }
            return null;
          })()}

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 12, flexWrap: "wrap" }}>
              {pollGroups.some(g => g.groupType === "head2head") && (
                <button
                  onClick={async () => {
                    if (rollingRunning) return;
                    if (!selectedSnap) { alert(t("prediction.s3.start.alert_no_snap")); return; }
                    setRollingMode(true);
                    setRollingRunning(true);
                    try {
                      const agents = wsPersonas;
                      // Build scoring params
                      const scoringParams: Record<string, any> = {
                        party_base: { ...partyBaseScores },
                        party_align_bonus: spAlignBonus,
                        incumbency_bonus: spIncumbBonus,
        party_divergence_mult: spDivergenceMult,
        candidate_traits: Object.keys(candidateTraits).length > 0 ? Object.fromEntries(Object.entries(candidateTraits).map(([k, v]) => [k, {loc: v.loc / 100, nat: v.nat / 100, anx: v.anx / 100, charm: (v.charm ?? 35) / 100, cross: (v.cross ?? 20) / 100}])) : undefined,
                        news_impact: newsImpact,
                        delta_cap_mult: deltaCapMult,
        base_undecided: baseUndecided,
        max_undecided: maxUndecided,
        profile_match_mult: profileMatchMult,
        keyword_bonus_cap: keywordBonusCap,
        anxiety_sensitivity_mult: anxietySensitivityMult,
        anxiety_decay: anxietyDecay,
        satisfaction_decay: satisfactionDecay,
        sentiment_mult: sentimentMult,
        individuality_multiplier: individualityMult,
        charm_mult: charmMult,
        cross_appeal_mult: crossAppealMult,
        close_race_weight: closeRaceWeight,
        same_party_penalty: samePartyPenalty,
        no_match_penalty: noMatchPenalty,
                      };
                      // Enrich poll groups
                      const enrichedPollGroups = pollGroups.map(g => ({
                        ...g,
                        candidates: g.candidates.map(c => {
                          if (!(c as any).isIncumbent) return c;
                          let desc = c.description || "";
                          if (!desc.includes("現任")) desc += "。市長、現任、執政、市政、市府";
                          return { ...c, description: desc };
                        }),
                      }));
                      // Merge scenarios
                      const mergedScenarios = scenarios.map(s => ({
                        ...s,
                        news: baseNews ? baseNews + "\n" + s.news : s.news,
                      }));
                      // Create prediction with rolling_state metadata
                      const pred = await createPrediction(
                        question, selectedSnap, mergedScenarios, simDays, concurrency,
                        enableKol, kolRatio, kolReach, samplingModality, pollOptions,
                        maxChoices, enrichedPollGroups, scoringParams, predictionMacroContext, undefined
                      );
                      setRollingPredId(pred.prediction_id);
                      // Initialize rolling (returns immediately, runs bridge in background)
                      const result = await initRollingPrediction(pred.prediction_id, agents);
                      setRollingJobId(result.job_id);
                      setRollingState({
                        current_day: -1,
                        daily_results: [],
                        bridge_day: 0,
                        bridge_total: result.bridge_total || simDays,
                        job_status: "running",
                        phase: "bridge",
                        live_messages: [],
                      });
                    } catch (e: any) {
                      alert(t("prediction.s3.start.alert_rolling_failed") + (e.message || e));
                      setRollingRunning(false);
                    }
                  }}
                  disabled={rollingRunning || !selectedSnap || running}
                  style={{ ...btn(true), background: "linear-gradient(135deg, #f59e0b, #d97706)", padding: "16px 36px", fontSize: 16, opacity: rollingRunning || !selectedSnap ? 0.5 : 1, boxShadow: "0 4px 20px rgba(245,158,11,0.4)", borderRadius: 12 }}
                >
                  {rollingRunning
                    ? (rollingState?.phase === "bridge"
                      ? t("prediction.s3.start.rolling_bridging", { day: rollingState?.bridge_day || 0, total: rollingState?.bridge_total || simDays })
                      : t("prediction.s3.start.rolling_initializing"))
                    : t("prediction.s3.start.rolling_btn")}
                </button>
              )}
              <button
                onClick={handleRunPrediction}
                disabled={running || !selectedSnap}
                style={{ ...btn(true), background: "linear-gradient(135deg, #8b5cf6, #7c3aed)", padding: "16px 48px", fontSize: 18, opacity: running || !selectedSnap ? 0.5 : 1, boxShadow: "0 4px 20px rgba(139,92,246,0.5)", borderRadius: 12 }}
              >
                {running ? t("prediction.start.running") : predictionMode === "satisfaction" ? t("prediction.start.survey") : t("prediction.start.election")}
              </button>
            </div>

            {/* ── Saved Checkpoint Resume Banner ── */}
            {savedCheckpoint && !running && (
              <div style={{ marginTop: 16, padding: 16, borderRadius: 12, border: "1px solid rgba(245,158,11,0.4)", background: "linear-gradient(135deg, rgba(245,158,11,0.08), rgba(217,119,6,0.04))", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                <div style={{ fontFamily: "var(--font-cjk)" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#f59e0b", marginBottom: 4 }}>{t("prediction.s3.checkpoint.title")}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                    {t("prediction.s3.checkpoint.progress", { day: savedCheckpoint.current_day, total: savedCheckpoint.sim_days, agents: savedCheckpoint.agent_count })}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={handleResumeFromCheckpoint} style={{ ...btn(true), background: "linear-gradient(135deg, #f59e0b, #d97706)", padding: "10px 24px", fontSize: 14, borderRadius: 8, fontFamily: "var(--font-cjk)", fontWeight: 700 }}>
                    {t("prediction.s3.checkpoint.resume_btn")}
                  </button>
                  <button onClick={() => setSavedCheckpoint(null)} style={{ ...btn(false), padding: "10px 16px", fontSize: 12, borderRadius: 8, fontFamily: "var(--font-cjk)" }}>
                    ✕ 忽略
                  </button>
                </div>
              </div>
            )}

          {/* ── Rolling Daily Tracker Panel ── */}
          {rollingMode && rollingState && (
            <div style={{ marginTop: 24, padding: 20, borderRadius: 14, border: "1px solid rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.04)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#f59e0b", fontFamily: "var(--font-cjk)" }}>
                  {rollingState.phase === "bridge" ? "🔗 橋接演化進行中" : "📅 初選每日滾動追蹤"}
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  {rollingState.phase !== "bridge" && (
                    <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, fontFamily: "var(--font-cjk)" }}>
                      已追蹤 {(rollingState.current_day || 0) + 1} days
                    </span>
                  )}
                  <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11 }}>│</span>
                  <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, fontFamily: "var(--font-cjk)" }}>
                    背景新聞截止: {backgroundCutoff}
                  </span>
                </div>
              </div>

              {/* Bridge progress bar */}
              {rollingState.phase === "bridge" && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 13, color: "#f59e0b", fontFamily: "var(--font-cjk)" }}>
                      橋接演化: Day {rollingState.bridge_day || 0} / {rollingState.bridge_total || simDays}
                    </span>
                    <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>
                      {Math.round(((rollingState.bridge_day || 0) / (rollingState.bridge_total || simDays || 1)) * 100)}%
                    </span>
                  </div>
                  <div style={{ width: "100%", height: 8, borderRadius: 4, background: "rgba(255,255,255,0.1)" }}>
                    <div style={{
                      width: `${Math.round(((rollingState.bridge_day || 0) / (rollingState.bridge_total || simDays || 1)) * 100)}%`,
                      height: "100%",
                      borderRadius: 4,
                      background: "linear-gradient(90deg, #f59e0b, #ef4444)",
                      transition: "width 0.5s ease",
                    }} />
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 4, fontFamily: "var(--font-cjk)" }}>
                    Distributing {rollingState.background_count || "N"} background articles across {rollingState.bridge_total || simDays} days for agents to absorb
                  </div>
                </div>
              )}

              {/* Day history cards */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                {(rollingState.daily_results || []).map((dr: any, idx: number) => {
                  const est = dr.candidate_estimate || {};
                  const prevEst = idx > 0 ? (rollingState.daily_results[idx - 1]?.candidate_estimate || {}) : null;
                  return (
                    <div key={idx} style={{ padding: 14, borderRadius: 10, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <div style={{ fontWeight: 700, color: idx === 0 ? "#8b5cf6" : "#3b82f6", fontSize: 14, fontFamily: "var(--font-cjk)" }}>
                          {idx === 0 ? "Day 0（基線）" : `Day ${dr.day}`}
                        </div>
                        <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>
                          {dr.entries_count} agents | sat {dr.avg_satisfaction} | anx {dr.avg_anxiety}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                        {Object.entries(est).filter(([k]) => k !== "Undecided" && k !== "不表態").map(([name, pct]: [string, any]) => {
                          const prevPct = prevEst ? (prevEst[name] || 0) : null;
                          const diff = prevPct !== null ? (pct - prevPct).toFixed(1) : null;
                          const diffColor = diff && parseFloat(diff) > 0 ? "#22c55e" : diff && parseFloat(diff) < 0 ? "#ef4444" : "rgba(255,255,255,0.3)";
                          return (
                            <div key={name} style={{ padding: "8px 14px", borderRadius: 8, background: "rgba(255,255,255,0.06)", minWidth: 120 }}>
                              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontFamily: "var(--font-cjk)", marginBottom: 2 }}>{name}</div>
                              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                                <span style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>{typeof pct === 'number' ? pct.toFixed(1) : pct}%</span>
                                {diff && (
                                  <span style={{ fontSize: 12, fontWeight: 600, color: diffColor }}>
                                    {parseFloat(diff) > 0 ? "↑" : parseFloat(diff) < 0 ? "↓" : ""}{diff}
                                  </span>
                                )}
                              </div>
                              {/* Score bar */}
                              <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.1)", marginTop: 4, overflow: "hidden" }}>
                                <div style={{ height: "100%", width: `${Math.min(100, typeof pct === 'number' ? pct : 0)}%`, background: "linear-gradient(90deg, #8b5cf6, #3b82f6)", borderRadius: 2, transition: "width 0.5s" }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Daily news injection */}
              <div style={{ padding: 14, borderRadius: 10, border: "1px dashed rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.03)" }}>
                <div style={{ fontWeight: 700, color: "#3b82f6", fontSize: 13, marginBottom: 8, fontFamily: "var(--font-cjk)" }}>
                  📝 Day {(rollingState.current_day || 0) + 1} — 注入今日新聞
                </div>
                <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, marginBottom: 8, fontFamily: "var(--font-cjk)" }}>
                  貼入昨日發生的真實新聞事件（每行一則），系統將以此推進模擬一days。格式可加日期前綴 [YYYY-MM-DD]。
                </div>
                <textarea
                  value={rollingDailyNews}
                  onChange={e => setRollingDailyNews(e.target.value)}
                  placeholder={"例如：\n[2026-03-25] 楊瓊瓔公布經濟政策白皮書\n[2026-03-25] 江啟臣造勢現場動員五千人\n[2026-03-25] 民調顯示兩人差距在誤差範圍內"}
                  rows={5}
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(59,130,246,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 12, outline: "none", fontFamily: "var(--font-cjk)", resize: "vertical", lineHeight: "1.6" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
                  <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, fontFamily: "var(--font-cjk)" }}>
                    {rollingDailyNews.trim().split("\n").filter(Boolean).length} 則新聞待注入
                  </span>
                  <button
                    onClick={async () => {
                      if (!rollingPredId || !rollingDailyNews.trim()) return;
                      setRollingRunning(true);
                      try {
                        const result = await advanceRollingDay(rollingPredId, rollingDailyNews, wsPersonas);
                        // Update rolling state with new results
                        setRollingState((prev: any) => ({
                          ...prev,
                          current_day: (prev?.current_day || 0) + 1,
                          daily_results: [...(prev?.daily_results || []), ...(result.daily_results?.slice(-1) || [])],
                          job_status: result.status,
                          live_messages: result.live_messages || [],
                        }));
                        setRollingDailyNews("");
                      } catch (e: any) {
                        alert("推進失敗: " + (e.message || e));
                      } finally {
                        setRollingRunning(false);
                      }
                    }}
                    disabled={rollingRunning || !rollingDailyNews.trim()}
                    style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: rollingRunning ? "rgba(59,130,246,0.3)" : "linear-gradient(135deg, #3b82f6, #2563eb)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: rollingRunning ? "wait" : "pointer", fontFamily: "var(--font-cjk)", boxShadow: "0 2px 12px rgba(59,130,246,0.3)" }}
                  >
                    {rollingRunning ? "模擬中..." : "▶️ 推進一days"}
                  </button>
                </div>
              </div>

              {/* Live messages */}
              {rollingState.live_messages && rollingState.live_messages.length > 0 && (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "rgba(0,0,0,0.3)", maxHeight: 120, overflowY: "auto" }}>
                  {rollingState.live_messages.map((m: any, i: number) => (
                    <div key={i} style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono, monospace)", lineHeight: "1.6" }}>{m.text}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          </>
          )}

          {/* ── Contrast Comparison Summary (prominent, at top) ── */}
          {predResults?.length > 0 && predResults[0]?.contrast_comparison && (() => {
            const cc = predResults[0].contrast_comparison;
            return (
              <div style={{ padding: 16, borderRadius: 12, background: "rgba(251,191,36,0.06)", border: "2px solid rgba(251,191,36,0.3)", marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 18 }}>⚖️</span>
                  <span style={{ color: "#fbbf24", fontSize: 16, fontWeight: 800, fontFamily: "var(--font-cjk)" }}>Contrast式民調結果（LLM 投票）</span>
                </div>
                <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, marginBottom: 12, fontFamily: "var(--font-cjk)" }}>
                  以下為 LLM 模擬真人投票的結果。每組為兩人對決，比較誰對共同對手「{cc.common_opponent}」的勝率更高。
                </div>
                <div style={{ display: "flex", gap: 14, marginBottom: 14 }}>
                  {(cc.groups || []).map((g: any, gi: number) => {
                    const isWinner = g.challenger === cc.recommended;
                    const marginColor = g.margin > 0 ? "#22c55e" : g.margin < 0 ? "#ef4444" : "#6b7280";
                    return (
                      <div key={gi} style={{ flex: 1, padding: 14, borderRadius: 10, background: isWinner ? "rgba(34,197,94,0.08)" : "rgba(255,255,255,0.02)", border: isWinner ? "2px solid rgba(34,197,94,0.4)" : "1px solid rgba(255,255,255,0.08)" }}>
                        <div style={{ fontSize: 14, fontWeight: 800, color: isWinner ? "#22c55e" : "#fff", fontFamily: "var(--font-cjk)", marginBottom: 8 }}>
                          {isWinner && "👑 "}{g.challenger}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                          <span style={{ color: "#3b82f6" }}>{g.challenger}: <strong>{g.challenger_pct}%</strong></span>
                          <span style={{ color: "#a78bfa" }}>{cc.common_opponent}: <strong>{g.opponent_pct}%</strong></span>
                        </div>
                        <div style={{ fontSize: 28, fontWeight: 900, color: marginColor, textAlign: "center", fontFamily: "var(--font-mono)" }}>
                          {g.margin > 0 ? "+" : ""}{g.margin}%
                        </div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", textAlign: "center", fontFamily: "var(--font-cjk)" }}>
                          {g.margin > 0 ? `贏 ${cc.common_opponent} ${g.margin}%` : g.margin < 0 ? `輸 ${cc.common_opponent} ${Math.abs(g.margin)}%` : "平手"}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ textAlign: "center", padding: "10px 0", borderTop: "1px solid rgba(251,191,36,0.15)" }}>
                  <span style={{ color: "#fbbf24", fontSize: 15, fontWeight: 800, fontFamily: "var(--font-cjk)" }}>
                    ✅ 建議推薦：{cc.recommended}
                  </span>
                  <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, marginLeft: 8 }}>
                    （對 {cc.common_opponent} 差距 {cc.recommended_margin > 0 ? "+" : ""}{cc.recommended_margin}%，優勢最大）
                  </span>
                </div>
              </div>
            );
          })()}

          {/* ── Results Dashboard (detailed breakdown) ── */}
          {renderResultsDashboard()}

          {/* ── Satisfaction Survey Results ── */}
          {predictionMode === "satisfaction" && surveyResults.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 16 }}>
              <h3 style={{ color: "#3b82f6", fontSize: 16, fontWeight: 700, margin: 0, fontFamily: "var(--font-cjk)" }}>{t("prediction.survey_results.title")}</h3>
              {surveyResults.map((sr: any, ri: number) => (
                <div key={ri} style={card}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", fontFamily: "var(--font-cjk)", marginBottom: 10 }}>
                    {sr.person_name}（{sr.person_role}）{sr.person_party ? `— ${sr.person_party}` : ""} — {sr.total} 人受訪
                  </div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 100px", padding: "8px 14px", borderRadius: 8, background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.2)", textAlign: "center" }}>
                      <div style={{ fontSize: 24, fontWeight: 800, color: "#3b82f6", fontFamily: "var(--font-mono)" }}>{sr.satisfied_total}%</div>
                      <div style={{ fontSize: 10, color: "#3b82f6", fontFamily: "var(--font-cjk)" }}>滿意合計</div>
                    </div>
                    <div style={{ flex: "1 1 100px", padding: "8px 14px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", textAlign: "center" }}>
                      <div style={{ fontSize: 24, fontWeight: 800, color: "#ef4444", fontFamily: "var(--font-mono)" }}>{sr.dissatisfied_total}%</div>
                      <div style={{ fontSize: 10, color: "#ef4444", fontFamily: "var(--font-cjk)" }}>不滿意合計</div>
                    </div>
                    <div style={{ flex: "1 1 100px", padding: "8px 14px", borderRadius: 8, background: "rgba(107,114,128,0.1)", border: "1px solid rgba(107,114,128,0.2)", textAlign: "center" }}>
                      <div style={{ fontSize: 24, fontWeight: 800, color: "#6b7280", fontFamily: "var(--font-mono)" }}>{sr.undecided_total}%</div>
                      <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "var(--font-cjk)" }}>未表態</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {[
                      { key: "Very satisfied", color: "#3b82f6" },
                      { key: "Fairly satisfied", color: "#93c5fd" },
                      { key: "Somewhat dissatisfied", color: "#fca5a5" },
                      { key: "Very dissatisfied", color: "#ef4444" },
                      { key: "Undecided", color: "#6b7280" },
                    ].map(item => {
                      const pct = sr.percentages?.[item.key] || 0;
                      return (
                        <div key={item.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 75, fontSize: 11, color: "rgba(255,255,255,0.6)", textAlign: "right", fontFamily: "var(--font-cjk)", flexShrink: 0 }}>{item.key}</div>
                          <div style={{ flex: 1, height: 22, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}>
                            <div style={{ width: `${pct}%`, height: "100%", background: item.color, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              {pct > 8 && <span style={{ color: "#fff", fontSize: 9, fontWeight: 700 }}>{pct}%</span>}
                            </div>
                          </div>
                          <div style={{ width: 40, fontSize: 11, color: item.color, fontWeight: 700, fontFamily: "var(--font-mono)", textAlign: "right" }}>{pct}%</div>
                        </div>
                      );
                    })}
                  </div>
                  {sr.by_leaning && Object.keys(sr.by_leaning).length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-cjk)", marginBottom: 4 }}>By political leaning</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {Object.entries(sr.by_leaning).map(([lean, data]: [string, any]) => (
                          <div key={lean} style={{ flex: "1 1 140px", padding: "5px 8px", borderRadius: 5, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", fontSize: 10, fontFamily: "var(--font-cjk)" }}>
                            <span style={{ color: lean.includes("右") ? "#3b82f6" : lean.includes("左") ? "#22c55e" : "#9ca3af", fontWeight: 700 }}>{lean}</span>
                            <span style={{ color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-mono)" }}> 滿{((data["非常滿意_pct"]||0)+(data["還算滿意_pct"]||0)).toFixed(0)}% 不滿{((data["不太滿意_pct"]||0)+(data["非常不滿意_pct"]||0)).toFixed(0)}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Two-column layout: Live Progress (left) + Agent Tabs (right) ── */}
          {(running || (jobStatus && (jobStatus.status === "completed" || jobStatus.status === "failed"))) && jobStatus && (
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: "1.2 1 0%", minWidth: 0 }}>
          {/* Live status */}
          {(running || (jobStatus && (jobStatus.status === "completed" || jobStatus.status === "failed"))) && jobStatus && (() => {
            const ds = jobStatus.current_daily_data || [];
            const totalScenarios = jobStatus.total_scenarios || 1;
            const currentScenario = jobStatus.current_scenario || 0;
            const pct = (() => {
              const simDays = jobStatus.sim_days || 30;
              const completedScenarios = Math.max(0, currentScenario - 1);
              const currentDay = ds.length > 0 ? ds[ds.length - 1].day : 0;
              const totalWork = totalScenarios * simDays;
              return totalWork > 0 ? Math.min(99, Math.round(((completedScenarios * simDays + currentDay) / totalWork) * 100)) : 0;
            })();
            const lastDay = ds.length > 0 ? ds[ds.length - 1] : null;
            const scenarioName = jobStatus.current_scenario_name || `Scenario ${currentScenario}`;
            // Derive flat candidate list from poll_groups (first group) or poll_options
            const jobPollGroups = jobStatus.poll_groups || [];
            const jobCandOpts: {name: string, description: string}[] = jobPollGroups.length > 0
              ? (jobPollGroups[0].candidates || [])
              : (jobStatus.poll_options || []);

            // SVG chart (full-width responsive)
            const chartW = 900, chartH = 260;
            const pad = { top: 20, right: 20, bottom: 30, left: 40 };
            const h = chartH - pad.top - pad.bottom;
            const maxDay = ds.length > 0 ? Math.max(...ds.map((d: any) => d.day)) : 1;
            const xScale = (day: number) => pad.left + ((day - 1) / Math.max(1, maxDay - 1)) * (chartW - pad.left - pad.right);
            const yScale = (val: number) => pad.top + h - ((val / 100) * h);

            const satLine = ds.length > 0 ? ds.map((d: any, i: number) => `${i === 0 ? 'M' : 'L'}${xScale(d.day).toFixed(1)},${yScale(d.avg_satisfaction).toFixed(1)}`).join(' ') : '';
            const anxLine = ds.length > 0 ? ds.map((d: any, i: number) => `${i === 0 ? 'M' : 'L'}${xScale(d.day).toFixed(1)},${yScale(d.avg_anxiety).toFixed(1)}`).join(' ') : '';

            return (
              <div style={card}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <h3 style={{ color: jobStatus.status === "completed" ? "#22c55e" : jobStatus.status === "failed" ? "#ef4444" : "#f59e0b", fontSize: 14, fontWeight: 600, margin: 0 }}>
                      {jobStatus.status === "completed" ? "✅ Prediction complete" : jobStatus.status === "failed" ? "❌ Prediction failed" : jobStatus.status === "paused" ? "⏸️ Prediction paused" : "⏳ Running"}
                    </h3>
                    {running && jobStatus.status === "paused" && (
                      <button 
                        onClick={handleResumePrediction}
                        style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22c55e", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
                      >▶️ Resume</button>
                    )}
                    {running && jobStatus.status !== "paused" && jobStatus.status !== "completed" && jobStatus.status !== "failed" && (
                      <button 
                        onClick={handlePausePrediction}
                        style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
                      >⏸️ Pause</button>
                    )}
                    {running && (
                      <button 
                        onClick={handleStopPrediction}
                        style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
                      >🛑 Stop</button>
                    )}
                    {!running && (jobStatus.status === "completed" || jobStatus.status === "failed") && (
                      <button 
                        onClick={() => { setJobStatus(null); setJobId(null); }}
                        style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(139,92,246,0.15)", border: "1px solid rgba(139,92,246,0.3)", color: "#a78bfa", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
                      >↩️ Back to setup</button>
                    )}
                  </div>
                  <span style={{ padding: "2px 10px", borderRadius: 10, fontSize: 10, fontWeight: 600, background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}>
                    📡 {scenarioName}
                  </span>
                </div>

                {/* Progress bar */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 11 }}>Scenario {currentScenario}/{totalScenarios}{lastDay ? ` — Day ${lastDay.day}` : ""}</span>
                    <span style={{ color: "#f59e0b", fontSize: 11, fontWeight: 700 }}>{pct}%</span>
                  </div>
                  <div style={{ height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg, #f59e0b, #eab308)", borderRadius: 3, transition: "width 0.5s ease" }} />
                  </div>
                  {/* Agent-level progress */}
                  {jobStatus.agents_total > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                        <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>👤 Agent progress</span>
                        <span style={{ color: "#22c55e", fontSize: 10, fontWeight: 700 }}>
                          {jobStatus.agents_processed || 0}/{jobStatus.agents_total}
                          {jobStatus.agents_total > 0 ? ` (${Math.round((jobStatus.agents_processed || 0) / jobStatus.agents_total * 100)}%)` : ""}
                        </span>
                      </div>
                      <div style={{ height: 4, background: "rgba(255,255,255,0.04)", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{ width: `${jobStatus.agents_total > 0 ? Math.round((jobStatus.agents_processed || 0) / jobStatus.agents_total * 100) : 0}%`, height: "100%", background: "linear-gradient(90deg, #22c55e, #16a34a)", borderRadius: 2, transition: "width 0.3s ease" }} />
                      </div>
                    </div>
                  )}
                  {/* ETA estimate */}
                  {(() => {
                    const timestamps = ds.map((d: any) => d.completed_at).filter(Boolean);
                    if (timestamps.length >= 2) {
                      const totalElapsed = timestamps[timestamps.length - 1] - timestamps[0];
                      const avgPerDay = totalElapsed / (timestamps.length - 1);
                      const totalDays = simDays * totalScenarios;
                      const completedDays = ds.length + (currentScenario - 1) * simDays;
                      const remainDays = Math.max(0, totalDays - completedDays);
                      if (remainDays > 0) {
                        const etaSec = Math.round(avgPerDay * remainDays);
                        const mm = Math.floor(etaSec / 60);
                        const ss = etaSec % 60;
                        const etaStr = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
                        return <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginTop: 4, fontFamily: "var(--font-cjk)" }}>⏱️ Est. remaining: {etaStr} (~{Math.round(avgPerDay)} 秒）</div>;
                      }
                    }
                    return null;
                  })()}
                </div>

                {/* Candidate poll banner (when poll_groups or poll_options set) */}
                {jobCandOpts.length > 0 && (
                  <div style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 8, background: (jobStatus?.prediction_mode === "satisfaction" || predictionMode === "satisfaction") ? "rgba(59,130,246,0.08)" : "rgba(139,92,246,0.08)", border: (jobStatus?.prediction_mode === "satisfaction" || predictionMode === "satisfaction") ? "1px solid rgba(59,130,246,0.2)" : "1px solid rgba(139,92,246,0.2)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14 }}>{(jobStatus?.prediction_mode === "satisfaction" || predictionMode === "satisfaction") ? "📊" : "🗳️"}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: (jobStatus?.prediction_mode === "satisfaction" || predictionMode === "satisfaction") ? "#93c5fd" : "#a78bfa", fontSize: 11, fontWeight: 600, fontFamily: "var(--font-cjk)" }}>
                        {(jobStatus?.prediction_mode === "satisfaction" || predictionMode === "satisfaction")
                          ? `Satisfaction survey: ${jobCandOpts.map((o: any) => o.name).join(", ")}`
                          : jobPollGroups.length > 0
                            ? `Multi-group poll: ${jobPollGroups.map((g: any) => g.name).join(" / ")}`
                            : `Candidate poll: ${jobCandOpts.map((o: any) => o.name).join(" vs ")}`
                        }
                      </div>
                      <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, fontFamily: "var(--font-cjk)" }}>
                        {(jobStatus?.prediction_mode === "satisfaction" || predictionMode === "satisfaction")
                          ? "Simulating citizen sentiment changes... each day independently computes 5-level satisfaction distribution per subject"
                          : "Simulating voter sentiment changes... candidate voting will execute automatically after all sim days complete"}
                      </div>
                    </div>
                  </div>
                )}

                {/* Current metrics */}
                {lastDay && (() => {
                  const groupEstimates = lastDay.group_estimates || {};
                  const hasGroups = jobPollGroups.length > 0 && Object.keys(groupEstimates).length > 0;

                  // ══════════════════════════════════════════════════
                  // Satisfaction Mode: independent 5-level per person
                  // ══════════════════════════════════════════════════
                  const _isSatMode = jobStatus?.prediction_mode === "satisfaction" || predictionMode === "satisfaction";
                  if (_isSatMode && hasGroups) {
                    // In satisfaction mode, groupEstimates has structure:
                    // { groupName: { personName: { percentages, satisfied_total, dissatisfied_total, undecided_total, total } } }
                    const SAT_LEVELS = [
                      { key: "Very satisfied", color: "#3b82f6" },
                      { key: "Fairly satisfied", color: "#93c5fd" },
                      { key: "Somewhat dissatisfied", color: "#fca5a5" },
                      { key: "Very dissatisfied", color: "#ef4444" },
                      { key: "Undecided", color: "#6b7280" },
                    ];
                    return (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 10 }}>
                          <span style={{ fontSize: 14, fontWeight: 800, color: "#3b82f6", fontFamily: "var(--font-cjk)" }}>📊 滿意度調查即時數據</span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                          {Object.entries(groupEstimates).map(([gName, persons]: [string, any]) => {
                            if (!persons || typeof persons !== "object") return null;
                            return Object.entries(persons).map(([pName, data]: [string, any]) => {
                              if (!data || typeof data !== "object") return null;
                              const pcts = data.percentages || data;
                              const satTotal = data.satisfied_total ?? (typeof pcts["Very satisfied"] === "number" ? pcts["Very satisfied"] + (pcts["Fairly satisfied"] || 0) : null);
                              const dissTotal = data.dissatisfied_total ?? (typeof pcts["Somewhat dissatisfied"] === "number" ? pcts["Somewhat dissatisfied"] + (pcts["Very dissatisfied"] || 0) : null);
                              const undTotal = data.undecided_total ?? pcts["Undecided"];
                              // If data is flat number (election fallback), skip
                              if (typeof data === "number") return null;
                              const cColor = detectPartyColor(pName, "") || "#3b82f6";
                              return (
                                <div key={pName} style={{ padding: "12px 16px", borderRadius: 12, background: "rgba(255,255,255,0.02)", border: `1px solid ${cColor}25` }}>
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                                    <span style={{ color: cColor, fontSize: 15, fontWeight: 800, fontFamily: "var(--font-cjk)" }}>{pName}</span>
                                    <div style={{ display: "flex", gap: 8 }}>
                                      {satTotal != null && <span style={{ color: "#3b82f6", fontSize: 12, fontWeight: 700 }}>滿意 {satTotal}%</span>}
                                      {dissTotal != null && <span style={{ color: "#ef4444", fontSize: 12, fontWeight: 700 }}>不滿 {dissTotal}%</span>}
                                      {undTotal != null && <span style={{ color: "#6b7280", fontSize: 12 }}>未表態 {undTotal}%</span>}
                                    </div>
                                  </div>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                    {SAT_LEVELS.map(item => {
                                      const pct = pcts[item.key] ?? 0;
                                      return (
                                        <div key={item.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                          <div style={{ width: 70, fontSize: 11, color: "rgba(255,255,255,0.6)", textAlign: "right", fontFamily: "var(--font-cjk)", flexShrink: 0 }}>{item.key}</div>
                                          <div style={{ flex: 1, height: 20, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}>
                                            <div style={{ width: `${pct}%`, height: "100%", background: item.color, borderRadius: 4, transition: "width 0.5s", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                              {pct > 8 && <span style={{ color: "#fff", fontSize: 9, fontWeight: 700 }}>{pct}%</span>}
                                            </div>
                                          </div>
                                          <div style={{ width: 40, fontSize: 12, color: item.color, fontWeight: 700, fontFamily: "var(--font-mono)", textAlign: "right" }}>{pct}%</div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            });
                          })}
                        </div>
                      </div>
                    );
                  }

                  if (isCandidateMode && hasGroups) {
                    // ── Multi-Group Candidate Mode: show all groups side by side ──
                    // Collect all unique KMT candidate names for weighted scoring
                    const allCandNames = new Set<string>();
                    jobPollGroups.forEach((g: any) => (g.candidates || []).forEach((c: any) => { if (c.name) allCandNames.add(c.name); }));
                    const compGroups = jobPollGroups.filter((g: any) => g.groupType === "comparison" || !g.groupType);
                    const h2hGroups = jobPollGroups.filter((g: any) => g.groupType === "head2head");
                    const hasWeightedCalc = compGroups.length > 0 && h2hGroups.length > 0;

                    // Compute weighted final scores per unique candidate
                    let weightedScores: Record<string, number> = {};
                    if (hasWeightedCalc) {
                      // Comparison: for each candidate, take their best score across comparison groups
                      const compScores: Record<string, number> = {};
                      compGroups.forEach((g: any) => {
                        const gName = g.name || "";
                        const gEst = groupEstimates[gName] || {};
                        Object.entries(gEst).forEach(([cname, pct]) => {
                          if (cname === "Undecided" || cname === "不表態") return;
                          if (compScores[cname] === undefined || (pct as number) > compScores[cname]) {
                            compScores[cname] = pct as number;
                          }
                        });
                      });
                      // Head2head: direct scores
                      const h2hScores: Record<string, number> = {};
                      h2hGroups.forEach((g: any) => {
                        const gName = g.name || "";
                        const gEst = groupEstimates[gName] || {};
                        Object.entries(gEst).forEach(([cname, pct]) => {
                          if (cname === "Undecided" || cname === "不表態") return;
                          h2hScores[cname] = (h2hScores[cname] || 0) + (pct as number);
                        });
                      });
                      // Normalize h2h if multiple groups
                      if (h2hGroups.length > 1) {
                        Object.keys(h2hScores).forEach(k => { h2hScores[k] /= h2hGroups.length; });
                      }
                      // Merge
                      const cw = comparisonWeight / 100;
                      const hw = head2headWeight / 100;
                      allCandNames.forEach(cname => {
                        const cs = compScores[cname] ?? 0;
                        const hs = h2hScores[cname] ?? 0;
                        weightedScores[cname] = cs * cw + hs * hw;
                      });
                    }
                    const sortedWeighted = Object.entries(weightedScores).sort((a, b) => b[1] - a[1]);
                    // Collect per-candidate breakdown data for the calculation panel
                    const compScoresForDisplay: Record<string, number> = {};
                    compGroups.forEach((g: any) => {
                      const gName = g.name || "";
                      const gEst = groupEstimates[gName] || {};
                      Object.entries(gEst).forEach(([cname, pct]) => {
                        if (cname === "Undecided" || cname === "不表態") return;
                        if (compScoresForDisplay[cname] === undefined || (pct as number) > compScoresForDisplay[cname]) {
                          compScoresForDisplay[cname] = pct as number;
                        }
                      });
                    });
                    const h2hScoresForDisplay: Record<string, number> = {};
                    h2hGroups.forEach((g: any) => {
                      const gName = g.name || "";
                      const gEst = groupEstimates[gName] || {};
                      Object.entries(gEst).forEach(([cname, pct]) => {
                        if (cname === "Undecided" || cname === "不表態") return;
                        h2hScoresForDisplay[cname] = (h2hScoresForDisplay[cname] || 0) + (pct as number);
                      });
                    });
                    if (h2hGroups.length > 1) {
                      Object.keys(h2hScoresForDisplay).forEach(k => { h2hScoresForDisplay[k] /= h2hGroups.length; });
                    }

                    return (
                      <div style={{ marginBottom: 10 }}>
                        {/* ── Section Title ── */}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 10 }}>
                          <span style={{ fontSize: 14, fontWeight: 800, color: "#fbbf24", fontFamily: "var(--font-cjk)" }}>🏛️ Primary poll live data</span>
                          <span style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)", color: "#fbbf24", fontSize: 10, fontWeight: 700 }}>Contrast {comparisonWeight}% + H2H {head2headWeight}%</span>
                        </div>

                        {/* ── Group Cards with Weight Labels ── */}
                        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                          {jobPollGroups.map((group: any, gi: number) => {
                            const gName = group.name || `Group ${gi+1}`;
                            const gCands = group.candidates || [];
                            const gColors = getCandidateColors(gCands);
                            const gEst = groupEstimates[gName] || {};
                            const gType = group.groupType || "comparison";
                            const typeBadgeColor = gType === "head2head" ? "#a78bfa" : "#38bdf8";
                            const typeLabel = gType === "head2head" ? "H2H" : "Contrast";
                            const weightPct = gType === "head2head" ? head2headWeight : comparisonWeight;
                            const hasData = Object.keys(gEst).length > 0;
                            return (
                              <div key={gName} style={{ flex: 1, background: "rgba(0,0,0,0.25)", borderRadius: 12, padding: "10px 10px 8px", border: `1px solid ${typeBadgeColor}30`, position: "relative" as any }}>
                                {/* Weight badge */}
                                <div style={{ position: "absolute" as any, top: -8, right: 8, padding: "1px 8px", borderRadius: 8, background: gType === "head2head" ? "rgba(167,139,250,0.2)" : "rgba(56,189,248,0.2)", border: `1px solid ${typeBadgeColor}40`, color: typeBadgeColor, fontSize: 10, fontWeight: 800 }}>
                                  {weightPct}%
                                </div>
                                {/* Header */}
                                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, marginBottom: 6 }}>
                                  <span style={{ color: "#fff", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{gName}</span>
                                  <span style={{ padding: "1px 6px", borderRadius: 4, background: `${typeBadgeColor}15`, color: typeBadgeColor, fontSize: 9, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{typeLabel}</span>
                                  <span style={{ fontSize: 8, color: hasData ? "#22c55e" : "#f59e0b" }}>{hasData ? "🟢" : "⏳"}</span>
                                </div>
                                {/* Candidate scores */}
                                <div style={{ display: "flex", gap: 6 }}>
                                  {gCands.filter((c: any) => c.name).map((c: any, ci: number) => {
                                    const pct = gEst[c.name] ?? 0;
                                    const col = gColors[ci] || "#8b5cf6";
                                    const numericEntries = Object.entries(gEst).filter(([k]) => k !== "Undecided" && k !== "不表態");
                                    const isLeading = numericEntries.length > 0 && numericEntries.every(([k, v]) => k === c.name || (v as number) <= pct);
                                    return (
                                      <div key={c.name} style={{ flex: 1, background: `${col}08`, border: `1.5px solid ${col}${isLeading ? '60' : '20'}`, borderRadius: 8, padding: "6px 4px", textAlign: "center", transition: "all 0.3s" }}>
                                        <div style={{ color: col, fontSize: 9, fontWeight: 700, fontFamily: "var(--font-cjk)", marginBottom: 2, opacity: 0.8 }}>{c.name}</div>
                                        <div style={{ color: col, fontSize: 20, fontWeight: 900, lineHeight: 1 }}>{pct}<span style={{ fontSize: 11 }}>%</span></div>
                                        {isLeading && <div style={{ color: col, fontSize: 7, fontWeight: 700, marginTop: 2 }}>▲ Leading</div>}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* ── Weighted Calculation Breakdown ── */}
                        {hasWeightedCalc && sortedWeighted.length > 0 && (
                          <div style={{ background: "linear-gradient(135deg, rgba(251,191,36,0.04) 0%, rgba(139,92,246,0.04) 100%)", border: "1px solid rgba(251,191,36,0.15)", borderRadius: 12, padding: "14px 16px", marginBottom: 10 }}>
                            {/* Title */}
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ fontSize: 13 }}>📊</span>
                                <span style={{ color: "#fbbf24", fontSize: 13, fontWeight: 800, fontFamily: "var(--font-cjk)" }}>Weighted calculation detail</span>
                              </div>
                              <div style={{ display: "flex", gap: 8 }}>
                                <span style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(56,189,248,0.1)", color: "#38bdf8", fontSize: 9, fontWeight: 700 }}>Contrast ×{comparisonWeight}%</span>
                                <span style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(167,139,250,0.1)", color: "#a78bfa", fontSize: 9, fontWeight: 700 }}>H2H比 ×{head2headWeight}%</span>
                              </div>
                            </div>

                            {/* Per-candidate breakdown */}
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {sortedWeighted.filter(([cname]) => {
                                // Only show same-party candidates (use head2head group = KMT primary)
                                const h2hGroup = pollGroups.find((g: any) => g.groupType === "head2head");
                                if (h2hGroup) {
                                  return h2hGroup.candidates?.some((c: any) => c.name === cname);
                                }
                                return true;
                              }).map(([cname, score], ri) => {
                                const cs = compScoresForDisplay[cname] ?? 0;
                                const hs = h2hScoresForDisplay[cname] ?? 0;
                                const cw = comparisonWeight / 100;
                                const hw = head2headWeight / 100;
                                const isWinner = ri === 0;
                                const barMax = Math.max(...sortedWeighted.map(([, s]) => s), 1);
                                const barPct = (score / barMax) * 100;
                                return (
                                  <div key={cname} style={{ background: isWinner ? "rgba(251,191,36,0.06)" : "rgba(0,0,0,0.15)", borderRadius: 10, padding: "10px 12px", border: `1.5px solid ${isWinner ? "rgba(251,191,36,0.3)" : "rgba(255,255,255,0.04)"}` }}>
                                    {/* Candidate name + rank */}
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                        <span style={{ fontSize: 14 }}>{ri === 0 ? "🥇" : ri === 1 ? "🥈" : "🥉"}</span>
                                        <span style={{ color: isWinner ? "#fbbf24" : "#fff", fontSize: 14, fontWeight: 800, fontFamily: "var(--font-cjk)" }}>{cname}</span>
                                      </div>
                                      <span style={{ color: isWinner ? "#fbbf24" : "rgba(255,255,255,0.7)", fontSize: 22, fontWeight: 900 }}>{score.toFixed(1)}<span style={{ fontSize: 11, fontWeight: 600, opacity: 0.6 }}> 分</span></span>
                                    </div>
                                    {/* Score bar */}
                                    <div style={{ height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden", marginBottom: 6 }}>
                                      <div style={{ height: "100%", width: `${barPct}%`, background: isWinner ? "linear-gradient(90deg, #fbbf24 0%, #f59e0b 100%)" : "linear-gradient(90deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0.1) 100%)", borderRadius: 3, transition: "width 0.5s ease" }} />
                                    </div>
                                    {/* Formula */}
                                    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                                      <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "var(--font-cjk)" }}>Calc:</span>
                                      <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(56,189,248,0.1)", color: "#38bdf8", fontSize: 10, fontWeight: 600 }}>{cs.toFixed(1)}%</span>
                                      <span style={{ color: "rgba(255,255,255,0.25)", fontSize: 10 }}>× {cw}</span>
                                      <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 10 }}>+</span>
                                      <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(167,139,250,0.1)", color: "#a78bfa", fontSize: 10, fontWeight: 600 }}>{hs.toFixed(1)}%</span>
                                      <span style={{ color: "rgba(255,255,255,0.25)", fontSize: 10 }}>× {hw}</span>
                                      <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 10 }}>=</span>
                                      <span style={{ color: isWinner ? "#fbbf24" : "rgba(255,255,255,0.5)", fontSize: 11, fontWeight: 800 }}>{score.toFixed(1)}</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            {/* Methodology explanation */}
                            <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
                              <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, lineHeight: 1.6, fontFamily: "var(--font-cjk)" }}>
                                📋 <span style={{ fontWeight: 700 }}>Calculation method</span>:<br />
                                • <span style={{ color: "#38bdf8" }}>"Contrast" {comparisonWeight}%</span>: each candidate is compared against other-party candidates, best vote share used<br />
                                • <span style={{ color: "#a78bfa" }}>"H2H" {head2headWeight}%</span>: same-party head-to-head matchup, uses direct support rate<br />
                                • <span style={{ color: "#fbbf24" }}>Final score</span> = Contrast vote share × {(comparisonWeight/100).toFixed(2)} + H2H vote share × {(head2headWeight/100).toFixed(2)}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Small sat/anx secondary info */}
                        <div style={{ display: "flex", gap: 16, opacity: 0.4, fontSize: 10 }}>
                          <span style={{ color: "#22c55e" }}>Satisfaction {lastDay.avg_satisfaction}</span>
                          <span style={{ color: "#ef4444" }}>Anxiety {lastDay.avg_anxiety}</span>
                        </div>

                        {/* ── LLM Voting Results (shown after voting completes) ── */}
                        {(() => {
                          const sr = jobStatus?.scenario_results || predResults || [];
                          const llmResults = sr[0]?.llm_poll_group_results;
                          if (!llmResults || Object.keys(llmResults).length === 0) return null;
                          return (
                            <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 12, background: "linear-gradient(135deg, rgba(167,139,250,0.06) 0%, rgba(139,92,246,0.04) 100%)", border: "1px solid rgba(167,139,250,0.2)" }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 10 }}>
                                <span style={{ fontSize: 14, fontWeight: 800, color: "#a78bfa", fontFamily: "var(--font-cjk)" }}>🗳️ LLM Voting Results</span>
                                <span style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.2)", color: "#a78bfa", fontSize: 9, fontWeight: 700 }}>AI agent-by-agent</span>
                              </div>
                              {Object.entries(llmResults).map(([gn, gr]: [string, any]) => {
                                const entries = Object.entries(gr).filter(([k]) => k !== "Undecided" && k !== "不表態").sort(([,a]: any,[,b]: any) => b - a);
                                const gCands = jobPollGroups.find((g: any) => g.name === gn)?.candidates || [];
                                const gColors = getCandidateColors(gCands);
                                return (
                                  <div key={gn}>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontWeight: 700, marginBottom: 6, textAlign: "center" }}>{gn}</div>
                                    <div style={{ display: "flex", gap: 6 }}>
                                      {entries.map(([cname, pct]: [string, any], ci: number) => {
                                        const col = gColors[gCands.findIndex((c: any) => c.name === cname)] || (ci === 0 ? "#a78bfa" : "#f472b6");
                                        const isLeading = ci === 0;
                                        return (
                                          <div key={cname} style={{ flex: 1, background: `${col}08`, border: `1.5px solid ${col}${isLeading ? '60' : '20'}`, borderRadius: 8, padding: "6px 4px", textAlign: "center" }}>
                                            <div style={{ color: col, fontSize: 9, fontWeight: 700, marginBottom: 2, opacity: 0.8 }}>{cname}</div>
                                            <div style={{ color: col, fontSize: 20, fontWeight: 900, lineHeight: 1 }}>{typeof pct === "number" ? pct.toFixed(1) : pct}<span style={{ fontSize: 11 }}>%</span></div>
                                            {isLeading && <div style={{ color: col, fontSize: 7, fontWeight: 700, marginTop: 2 }}>▲ Winner</div>}
                                          </div>
                                        );
                                      })}
                                    </div>
                                    {gr["Undecided"] != null && (
                                      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", textAlign: "center", marginTop: 4 }}>Undecided: {(gr["Undecided"] as number).toFixed?.(1) || gr["Undecided"]}%</div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  }

                  if (isCandidateMode) {
                    // ── Single-Group Candidate Mode (fallback) ──
                    const candColors = getCandidateColors(jobCandOpts);
                    const candEst = lastDay.candidate_estimate || {};
                    const candNames = jobCandOpts.map((o: any) => o.name).filter(Boolean);
                    if (candNames.length > 0) {
                      return (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                            {candNames.map((name: string, ci: number) => {
                              const pct = candEst[name] ?? 50;
                              const col = candColors[ci] || "#8b5cf6";
                              return (
                                <div key={name} style={{ flex: 1, background: `${col}10`, border: `1px solid ${col}30`, borderRadius: 10, padding: "10px 14px", textAlign: "center" }}>
                                  <div style={{ color: col, fontSize: 11, fontWeight: 700, fontFamily: "var(--font-cjk)", marginBottom: 4 }}>{name}</div>
                                  <div style={{ color: col, fontSize: 24, fontWeight: 800 }}>{pct}%</div>
                                  <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 9 }}>Est. support</div>
                                </div>
                              );
                            })}
                          </div>
                          <div style={{ display: "flex", gap: 16, opacity: 0.5, fontSize: 10 }}>
                            <span style={{ color: "#22c55e" }}>Satisfaction {lastDay.avg_satisfaction}</span>
                            <span style={{ color: "#ef4444" }}>Anxiety {lastDay.avg_anxiety}</span>
                          </div>
                        </div>
                      );
                    }
                  }

                  // ── General Mode: original metrics ──
                  return (
                    <div style={{ display: "flex", gap: 20, marginBottom: 10 }}>
                      <div>
                        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>Satisfaction</div>
                        <div style={{ color: "#22c55e", fontSize: 18, fontWeight: 700 }}>{lastDay.avg_satisfaction}</div>
                      </div>
                      <div>
                        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>Anxiety</div>
                        <div style={{ color: "#ef4444", fontSize: 18, fontWeight: 700 }}>{lastDay.avg_anxiety}</div>
                      </div>
                      {lastDay.high_sat_count !== undefined && (
                        <>
                          <div>
                            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>High sat. (&gt;60)</div>
                            <div style={{ color: "#22c55e", fontSize: 18, fontWeight: 700 }}>{lastDay.high_sat_count}</div>
                          </div>
                          <div>
                            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>High anx. (&gt;60)</div>
                            <div style={{ color: "#ef4444", fontSize: 18, fontWeight: 700 }}>{lastDay.high_anx_count}</div>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* Per-leaning-group stats + distribution */}
                {lastDay?.by_leaning && Object.keys(lastDay.by_leaning).length > 0 && (() => {
                  const leaningOrder = ["Solid Rep", "Lean Rep", "Tossup", "Lean Dem", "Solid Dem"];
                  const sortedLeanings = Object.entries(lastDay.by_leaning).sort((a: any, b: any) => {
                    const idxA = leaningOrder.indexOf(a[0]);
                    const idxB = leaningOrder.indexOf(b[0]);
                    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                    if (idxA !== -1) return -1;
                    if (idxB !== -1) return 1;
                    return a[0].localeCompare(b[0]);
                  });

                  const groupLeanCand = lastDay.group_leaning_candidate || {};
                  const hasGroupLean = jobPollGroups.length > 0 && Object.keys(groupLeanCand).length > 0;
                  const _isSatMode2 = jobStatus?.prediction_mode === "satisfaction" || predictionMode === "satisfaction";

                  // ── Satisfaction mode: per-leaning satisfaction breakdown ──
                  if (_isSatMode2 && hasGroupLean) {
                    return (
                      <div style={{ marginBottom: 10 }}>
                        {jobPollGroups.map((group: any, gi: number) => {
                          const gName = group.name || `Group ${gi+1}`;
                          const gCands = (group.candidates || []).filter((c: any) => c.name);
                          const gLeanCand = groupLeanCand[gName] || {};
                          return (
                            <div key={gName} style={{ background: "rgba(0,0,0,0.15)", borderRadius: 8, padding: "8px 10px", border: "1px solid rgba(59,130,246,0.1)", marginBottom: gi < jobPollGroups.length - 1 ? 8 : 0 }}>
                              <div style={{ color: "#93c5fd", fontSize: 10, fontWeight: 700, fontFamily: "var(--font-cjk)", marginBottom: 6 }}>
                                By political leaning — satisfaction distribution
                              </div>
                              {gCands.map((c: any) => {
                                const personLean = gLeanCand[c.name] || {};
                                if (!personLean || Object.keys(personLean).length === 0) return null;
                                const cColor = detectPartyColor(c.name, c.description || "") || "#3b82f6";
                                return (
                                  <div key={c.name} style={{ marginBottom: 8 }}>
                                    <div style={{ color: cColor, fontSize: 11, fontWeight: 700, fontFamily: "var(--font-cjk)", marginBottom: 4 }}>{c.name}</div>
                                    {sortedLeanings.map(([leaning, stats]: [string, any]) => {
                                      const leanData = personLean[leaning];
                                      if (!leanData) return null;
                                      const leanColor = leaning.includes("Dem") ? "#3b82f6" : leaning.includes("藍") || leaning.includes("右") ? "#3b82f6" : "#f59e0b";
                                      const displayCount = leanData.total || stats?.total_count || stats?.count || 0;
                                      const satPct = (leanData["Very satisfied_pct"] ?? leanData["非常滿意_pct"] || 0) + (leanData["Fairly satisfied_pct"] ?? leanData["還算滿意_pct"] || 0);
                                      const disPct = (leanData["Somewhat dissatisfied_pct"] ?? leanData["不太滿意_pct"] || 0) + (leanData["Very dissatisfied_pct"] ?? leanData["非常不滿意_pct"] || 0);
                                      const undPct = leanData["Undecided_pct"] ?? leanData["未表態_pct"] || 0;
                                      return (
                                        <div key={leaning} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                          <div style={{ color: leanColor, fontSize: 9, width: 75, textAlign: "right", fontWeight: 600, fontFamily: "var(--font-cjk)" }}>{leaning} ({Math.round(displayCount)})</div>
                                          <div style={{ flex: 1, display: "flex", height: 12, borderRadius: 3, overflow: "hidden", background: "rgba(255,255,255,0.04)" }}>
                                            <div style={{ width: `${satPct}%`, height: "100%", background: "#3b82f6", transition: "width 0.5s" }} title={`Satisfied ${satPct.toFixed(0)}%`} />
                                            <div style={{ width: `${disPct}%`, height: "100%", background: "#ef4444", transition: "width 0.5s" }} title={`Dissatisfied ${disPct.toFixed(0)}%`} />
                                            <div style={{ width: `${undPct}%`, height: "100%", background: "#6b7280", transition: "width 0.5s" }} title={`Undecided ${undPct.toFixed(0)}%`} />
                                          </div>
                                          <div style={{ fontSize: 8, color: "rgba(255,255,255,0.5)", width: 80, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                                            <span style={{ color: "#93c5fd" }}>{satPct.toFixed(0)}%</span> / <span style={{ color: "#fca5a5" }}>{disPct.toFixed(0)}%</span>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })}
                              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 3 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: "#3b82f6" }} /><span style={{ fontSize: 8, color: "rgba(255,255,255,0.4)" }}>滿意</span></div>
                                <div style={{ display: "flex", alignItems: "center", gap: 3 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: "#ef4444" }} /><span style={{ fontSize: 8, color: "rgba(255,255,255,0.4)" }}>不滿</span></div>
                                <div style={{ display: "flex", alignItems: "center", gap: 3 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: "#6b7280" }} /><span style={{ fontSize: 8, color: "rgba(255,255,255,0.4)" }}>未表態</span></div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  }

                  if (isCandidateMode && hasGroupLean) {
                    // ── Multi-Group: leaning → candidate preference per group ──
                    return (
                      <div style={{ marginBottom: 10 }}>
                        {jobPollGroups.map((group: any, gi: number) => {
                          const gName = group.name || `Group ${gi+1}`;
                          const gCands = (group.candidates || []).filter((c: any) => c.name);
                          const gColors = getCandidateColors(gCands);
                          const gLeanCand = groupLeanCand[gName] || {};
                          return (
                            <div key={gName} style={{ background: "rgba(0,0,0,0.15)", borderRadius: 8, padding: "8px 10px", border: "1px solid rgba(255,255,255,0.04)", marginBottom: gi < jobPollGroups.length - 1 ? 8 : 0 }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                                <div style={{ color: "#a78bfa", fontSize: 10, fontWeight: 700, fontFamily: "var(--font-cjk)" }}>{gName} — by leaning</div>
                                <div style={{ display: "flex", gap: 8 }}>
                                  {gCands.map((c: any, ci: number) => (
                                    <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                      <div style={{ width: 8, height: 8, borderRadius: 2, background: gColors[ci] }} />
                                      <span style={{ color: gColors[ci], fontSize: 9, fontWeight: 600 }}>{c.name}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              {sortedLeanings.filter(([leaning]: [string, any]) =>
                                !group.agentFilter?.leanings?.length || gLeanCand[leaning]
                              ).map(([leaning, stats]: [string, any]) => {
                                const leanColor = leaning.includes("Dem") ? "#3b82f6" : leaning.includes("Rep") ? "#ef4444" : "#f59e0b";
                                const displayCount = stats.total_count !== undefined ? stats.total_count : stats.count;
                                const candPcts = gLeanCand[leaning] || {};
                                return (
                                  <div key={leaning} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                                    <div style={{ color: leanColor, fontSize: 10, width: 75, textAlign: "right", fontWeight: 600 }}>{leaning} ({Math.round(displayCount)})</div>
                                    <div style={{ flex: 1, display: "flex", height: 14, borderRadius: 4, overflow: "hidden", background: "rgba(255,255,255,0.04)" }}>
                                      {gCands.map((c: any, ci: number) => {
                                        const pct = candPcts[c.name] ?? (100 / gCands.length);
                                        return (
                                          <div key={c.name} style={{ width: `${pct}%`, height: "100%", background: gColors[ci], transition: "width 0.5s", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                            {pct > 15 && <span style={{ color: "#fff", fontSize: 8, fontWeight: 700 }}>{pct.toFixed(0)}%</span>}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  }

                  if (isCandidateMode) {
                    // ── Single-group fallback ──
                    const candColors = getCandidateColors(jobCandOpts);
                    const candNames = jobCandOpts.map((o: any) => o.name).filter(Boolean);
                    const leanCand = lastDay.by_leaning_candidate || {};
                    if (candNames.length > 0) {
                      return (
                        <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                          <div style={{ flex: 1, background: "rgba(0,0,0,0.15)", borderRadius: 8, padding: "8px 10px", border: "1px solid rgba(255,255,255,0.04)" }}>
                            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginBottom: 6, fontWeight: 600 }}>By political leaning — candidate preference</div>
                            <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
                              {candNames.map((name: string, ci: number) => (
                                <div key={name} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                  <div style={{ width: 8, height: 8, borderRadius: 2, background: candColors[ci] || "#8b5cf6" }} />
                                  <span style={{ color: candColors[ci] || "#8b5cf6", fontSize: 9, fontWeight: 600 }}>{name}</span>
                                </div>
                              ))}
                            </div>
                            {sortedLeanings.map(([leaning, stats]: [string, any]) => {
                              const leanColor = leaning.includes("Dem") ? "#3b82f6" : leaning.includes("Rep") ? "#ef4444" : "#f59e0b";
                              const displayCount = stats.total_count !== undefined ? stats.total_count : stats.count;
                              const candPcts = leanCand[leaning] || {};
                              return (
                                <div key={leaning} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                                  <div style={{ color: leanColor, fontSize: 10, width: 80, textAlign: "right", fontWeight: 600 }}>{leaning} ({displayCount})</div>
                                  <div style={{ flex: 1, display: "flex", height: 14, borderRadius: 4, overflow: "hidden", background: "rgba(255,255,255,0.04)" }}>
                                    {candNames.map((name: string, ci: number) => {
                                      const pct = candPcts[name] ?? (100 / candNames.length);
                                      return (
                                        <div key={name} style={{ width: `${pct}%`, height: "100%", background: candColors[ci] || "#8b5cf6", transition: "width 0.5s", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                          {pct > 15 && <span style={{ color: "#fff", fontSize: 8, fontWeight: 700 }}>{pct.toFixed(0)}%</span>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    }
                  }

                  // ── General Mode: original sat/anx leaning + distribution ──
                  return (
                    <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                      <div style={{ flex: 1, background: "rgba(0,0,0,0.15)", borderRadius: 8, padding: "8px 10px", border: "1px solid rgba(255,255,255,0.04)" }}>
                        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginBottom: 6, fontWeight: 600 }}>By political leaning — satisfaction / anxiety</div>
                        {sortedLeanings.map(([leaning, stats]: [string, any]) => {
                          const leanColor = leaning.includes("Dem") ? "#3b82f6" : leaning.includes("Rep") ? "#ef4444" : "#f59e0b";
                          const displayCount = stats.total_count !== undefined ? stats.total_count : stats.count;
                          let safeAvgSat = stats.avg_sat;
                          let safeAvgAnx = stats.avg_anx;
                          if (stats.count === 0 && ds.length > 1) {
                            const prevDay = ds[ds.length - 2];
                            if (prevDay && prevDay.by_leaning && prevDay.by_leaning[leaning]) {
                              safeAvgSat = prevDay.by_leaning[leaning].avg_sat;
                              safeAvgAnx = prevDay.by_leaning[leaning].avg_anx;
                            }
                          }
                          return (
                            <div key={leaning} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                              <div style={{ color: leanColor, fontSize: 10, width: 80, textAlign: "right", fontWeight: 600 }}>{leaning} ({displayCount})</div>
                              <div style={{ flex: 1, display: "flex", gap: 4, alignItems: "center" }}>
                                <div style={{ flex: 1, height: 10, background: "rgba(255,255,255,0.04)", borderRadius: 5, overflow: "hidden" }}>
                                  <div style={{ width: `${safeAvgSat}%`, height: "100%", background: "#22c55e", borderRadius: 5, transition: "width 0.5s" }} />
                                </div>
                                <span style={{ color: "#22c55e", fontSize: 9, width: 28, fontWeight: 600 }}>{safeAvgSat}</span>
                                <div style={{ flex: 1, height: 10, background: "rgba(255,255,255,0.04)", borderRadius: 5, overflow: "hidden" }}>
                                  <div style={{ width: `${safeAvgAnx}%`, height: "100%", background: "#ef4444", borderRadius: 5, transition: "width 0.5s" }} />
                                </div>
                                <span style={{ color: "#ef4444", fontSize: 9, width: 28, fontWeight: 600 }}>{safeAvgAnx}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {lastDay.candidate_estimate && Object.keys(lastDay.candidate_estimate).length > 0 ? (
                        <div style={{ width: 180, background: "rgba(0,0,0,0.15)", borderRadius: 8, padding: "8px 10px", border: "1px solid rgba(255,255,255,0.04)" }}>
                          <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginBottom: 6, fontWeight: 600 }}>Candidate support distribution</div>
                          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 55, overflowX: "auto" }}>
                            {(() => {
                              let safeEst = lastDay.candidate_estimate;
                              if (!safeEst && ds.length > 1) {
                                const prevDay = ds[ds.length - 2];
                                if (prevDay && prevDay.candidate_estimate) safeEst = prevDay.candidate_estimate;
                              }
                              if (!safeEst) return null;
                              
                              const getCandColor = (name: string) => {
                                if (name.toLowerCase().includes("republican") || name.includes("(R)")) return "#ef4444";
                                if (name.toLowerCase().includes("democrat") || name.includes("(D)")) return "#3b82f6";
                                if (name.toLowerCase().includes("independent") || name.includes("(I)")) return "#a855f7";
                                // minor parties handled by fallback
                                if (name === "Undecided" || name === "不表態") return "#888";
                                return "#f59e0b";
                              };

                              const candEntries = Object.entries(safeEst).filter(([c]) => c !== "Undecided" && c !== "不表態").sort((a: any, b: any) => b[1] - a[1]);
                              return candEntries.map(([name, pct]: [string, any]) => {
                                const barH = Math.max(3, (pct / 100) * 50);
                                const displayName = name.split("(")[0].substring(0, 3);
                                return (
                                  <div key={name} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 26 }}>
                                    <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 8 }}>{Math.round(pct)}%</span>
                                    <div style={{ width: "100%", height: barH, background: getCandColor(name), borderRadius: 3, transition: "height 0.5s" }} />
                                    <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", width: "100%", textAlign: "center" }} title={name}>{displayName}</span>
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        </div>
                      ) : lastDay.sat_distribution && (
                        <div style={{ width: 180, background: "rgba(0,0,0,0.15)", borderRadius: 8, padding: "8px 10px", border: "1px solid rgba(255,255,255,0.04)" }}>
                          <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginBottom: 6, fontWeight: 600 }}>Satisfaction distribution</div>
                          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 55 }}>
                            {(() => {
                              let safeDist = lastDay.sat_distribution;
                              const currentTotal = Object.values(safeDist).reduce((sum: any, val: any) => sum + val, 0);
                              if (currentTotal === 0 && ds.length > 1) {
                                const prevDay = ds[ds.length - 2];
                                if (prevDay && prevDay.sat_distribution) safeDist = prevDay.sat_distribution;
                              }
                              return Object.entries(safeDist).map(([bucket, count]: [string, any]) => {
                                const maxCount = Math.max(1, ...Object.values(safeDist) as number[]);
                                const barH = Math.max(3, (count / maxCount) * 50);
                                const colors: Record<string, string> = {"0-20": "#ef4444", "20-40": "#f59e0b", "40-60": "#eab308", "60-80": "#22c55e", "80-100": "#10b981"};
                                return (
                                  <div key={bucket} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                    <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 8 }}>{count}</span>
                                    <div style={{ width: "100%", height: barH, background: colors[bucket] || "#888", borderRadius: 3, transition: "height 0.5s" }} />
                                    <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 7 }}>{bucket}</span>
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Live SVG chart */}
                {ds.length > 1 && (() => {
                  const hasGroupData = jobPollGroups.length > 0 && ds.some((d: any) => d.group_estimates && Object.keys(d.group_estimates).length > 0);

                  if (isCandidateMode && hasGroupData) {
                    // ── Multi-Group trend chart with group tab switcher ──
                    const maxPct = 100;
                    const yS = (v: number) => pad.top + ((maxPct - v) / maxPct) * (chartH - pad.top - pad.bottom);
                    const dashPatterns = ["", "6,3", "3,3", "8,4"];
                    // Filter groups based on selected tab
                    const showAll = chartGroupTab === "all";
                    const visibleGroups = showAll
                      ? jobPollGroups
                      : jobPollGroups.filter((g: any, gi: number) => (g.name || `Group ${gi+1}`) === chartGroupTab);
                    let legendX = pad.left + 5;
                    return (
                      <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 10, padding: "12px 8px", border: "1px solid rgba(255,255,255,0.04)", marginBottom: 10 }}>
                        {/* Group tab switcher */}
                        {jobPollGroups.length > 1 && (
                          <div style={{ display: "flex", gap: 4, marginBottom: 8, padding: "0 4px", flexWrap: "wrap" }}>
                            <button
                              onClick={() => setChartGroupTab("all")}
                              style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "var(--font-cjk)", background: showAll ? "rgba(139,92,246,0.25)" : "rgba(255,255,255,0.04)", color: showAll ? "#a78bfa" : "rgba(255,255,255,0.35)", transition: "all 0.2s" }}
                            >All groups</button>
                            {jobPollGroups.map((g: any, gi: number) => {
                              const gName = g.name || `Group ${gi+1}`;
                              const isActive = chartGroupTab === gName;
                              return (
                                <button
                                  key={gName}
                                  onClick={() => setChartGroupTab(gName)}
                                  style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "var(--font-cjk)", background: isActive ? "rgba(139,92,246,0.25)" : "rgba(255,255,255,0.04)", color: isActive ? "#a78bfa" : "rgba(255,255,255,0.35)", transition: "all 0.2s" }}
                                >{gName}</button>
                              );
                            })}
                          </div>
                        )}
                        <svg viewBox={`0 0 ${chartW} ${chartH + 12}`} style={{ display: "block", width: "100%", height: "auto" }} preserveAspectRatio="xMidYMid meet">
                          {[0, 25, 50, 75, 100].map(v => (
                            <g key={v}>
                              <line x1={pad.left} y1={yS(v)} x2={chartW - pad.right} y2={yS(v)} stroke="rgba(255,255,255,0.06)" />
                              <text x={pad.left - 4} y={yS(v) + 3} fill="rgba(255,255,255,0.25)" fontSize={9} textAnchor="end">{v}%</text>
                            </g>
                          ))}
                          {ds.filter((_: any, i: number) => i === 0 || i === ds.length - 1 || (i + 1) % 5 === 0).map((d: any) => (
                            <text key={d.day} x={xScale(d.day)} y={chartH - 5} fill="rgba(255,255,255,0.25)" fontSize={9} textAnchor="middle">D{d.day}</text>
                          ))}
                          {visibleGroups.map((group: any, vgi: number) => {
                            const gi = jobPollGroups.indexOf(group);
                            const gName = group.name || `Group ${gi+1}`;
                            const gCands = (group.candidates || []).filter((c: any) => c.name);
                            const gColors = getCandidateColors(gCands);
                            const dash = showAll ? (dashPatterns[gi] || "") : "";
                            return gCands.map((c: any, ci: number) => {
                              const path = ds.map((d: any, i: number) => {
                                const gEst = (d.group_estimates || {})[gName] || {};
                                const val = gEst[c.name] ?? 50;
                                return `${i === 0 ? 'M' : 'L'}${xScale(d.day).toFixed(1)},${yS(val).toFixed(1)}`;
                              }).join(' ');
                              const lastD = ds[ds.length - 1];
                              const lastGEst = (lastD.group_estimates || {})[gName] || {};
                              const lastVal = lastGEst[c.name] ?? 50;
                              return (
                                <g key={`${gName}-${c.name}`}>
                                  <path d={path} fill="none" stroke={gColors[ci]} strokeWidth={showAll ? (gi === 0 ? 2 : 1.5) : 2.5} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} />
                                  <circle cx={xScale(lastD.day)} cy={yS(lastVal)} r={showAll ? (gi === 0 ? 4 : 3) : 5} fill={gColors[ci]} stroke={dash ? "#1a1a2e" : "none"} strokeWidth={dash ? 1 : 0} />
                                  {/* Show value label when viewing single group */}
                                  {!showAll && (
                                    <text x={xScale(lastD.day) + 8} y={yS(lastVal) + 4} fill={gColors[ci]} fontSize={11} fontWeight="bold">{lastVal.toFixed(1)}%</text>
                                  )}
                                </g>
                              );
                            });
                          })}
                          {/* Legend */}
                          {visibleGroups.map((group: any, vgi: number) => {
                            const gi = jobPollGroups.indexOf(group);
                            const gName = group.name || `Group ${gi+1}`;
                            const gCands = (group.candidates || []).filter((c: any) => c.name);
                            const gColors = getCandidateColors(gCands);
                            const dash = showAll ? (dashPatterns[gi] || "") : "";
                            return gCands.map((c: any, ci: number) => {
                              const label = showAll ? `${c.name}` : c.name;
                              const x0 = legendX;
                              legendX += label.length * 11 + 25;
                              return (
                                <g key={`leg-${gName}-${c.name}`}>
                                  <line x1={x0} y1={chartH + 6} x2={x0 + 12} y2={chartH + 6} stroke={gColors[ci]} strokeWidth={2} strokeDasharray={dash} />
                                  <text x={x0 + 16} y={chartH + 9} fill={gColors[ci]} fontSize={8}>{label}</text>
                                </g>
                              );
                            });
                          })}
                        </svg>
                      </div>
                    );
                  }

                  if (isCandidateMode) {
                    // ── Single-group fallback ──
                    const candColors = getCandidateColors(jobCandOpts);
                    const candNames = jobCandOpts.map((o: any) => o.name).filter(Boolean);
                    if (candNames.length > 0) {
                      const maxPct = 100;
                      const yS = (v: number) => pad.top + ((maxPct - v) / maxPct) * (chartH - pad.top - pad.bottom);
                      return (
                        <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 10, padding: "8px 4px", border: "1px solid rgba(255,255,255,0.04)", marginBottom: 10 }}>
                          <svg viewBox={`0 0 ${chartW} ${chartH}`} style={{ display: "block", width: "100%", height: "auto" }} preserveAspectRatio="xMidYMid meet">
                            {[0, 25, 50, 75, 100].map(v => (
                              <g key={v}>
                                <line x1={pad.left} y1={yS(v)} x2={chartW - pad.right} y2={yS(v)} stroke="rgba(255,255,255,0.06)" />
                                <text x={pad.left - 4} y={yS(v) + 3} fill="rgba(255,255,255,0.25)" fontSize={9} textAnchor="end">{v}%</text>
                              </g>
                            ))}
                            {ds.filter((_: any, i: number) => i === 0 || i === ds.length - 1 || (i + 1) % 5 === 0).map((d: any) => (
                              <text key={d.day} x={xScale(d.day)} y={chartH - 5} fill="rgba(255,255,255,0.25)" fontSize={9} textAnchor="middle">D{d.day}</text>
                            ))}
                            {candNames.map((cname: string, ci: number) => {
                              const path = ds.map((d: any, i: number) => {
                                const est = d.candidate_estimate || {};
                                const val = est[cname] ?? 50;
                                return `${i === 0 ? 'M' : 'L'}${xScale(d.day).toFixed(1)},${yS(val).toFixed(1)}`;
                              }).join(' ');
                              const lastD = ds[ds.length - 1];
                              const lastVal = (lastD.candidate_estimate || {})[cname] ?? 50;
                              return (
                                <g key={cname}>
                                  <path d={path} fill="none" stroke={candColors[ci]} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                                  <circle cx={xScale(lastD.day)} cy={yS(lastVal)} r={4} fill={candColors[ci]} />
                                </g>
                              );
                            })}
                            {candNames.map((cname: string, ci: number) => (
                              <g key={cname}>
                                <circle cx={pad.left + 5 + ci * 80} cy={8} r={3} fill={candColors[ci]} />
                                <text x={pad.left + 12 + ci * 80} y={11} fill={candColors[ci]} fontSize={9}>{cname}</text>
                              </g>
                            ))}
                          </svg>
                        </div>
                      );
                    }
                  }

                  // ── General Mode: original sat/anx chart ──
                  return (
                    <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 10, padding: "8px 4px", border: "1px solid rgba(255,255,255,0.04)", marginBottom: 10 }}>
                      <svg viewBox={`0 0 ${chartW} ${chartH}`} style={{ display: "block", width: "100%", height: "auto" }} preserveAspectRatio="xMidYMid meet">
                        {[0, 25, 50, 75, 100].map(v => (
                          <g key={v}>
                            <line x1={pad.left} y1={yScale(v)} x2={chartW - pad.right} y2={yScale(v)} stroke="rgba(255,255,255,0.06)" />
                            <text x={pad.left - 4} y={yScale(v) + 3} fill="rgba(255,255,255,0.25)" fontSize={9} textAnchor="end">{v}</text>
                          </g>
                        ))}
                        {ds.filter((_: any, i: number) => i === 0 || i === ds.length - 1 || (i + 1) % 5 === 0).map((d: any) => (
                          <text key={d.day} x={xScale(d.day)} y={chartH - 5} fill="rgba(255,255,255,0.25)" fontSize={9} textAnchor="middle">D{d.day}</text>
                        ))}
                        <path d={satLine} fill="none" stroke="#22c55e" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                        <path d={anxLine} fill="none" stroke="#ef4444" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                        {ds.length > 0 && (
                          <>
                            <circle cx={xScale(ds[ds.length-1].day)} cy={yScale(ds[ds.length-1].avg_satisfaction)} r={4} fill="#22c55e" />
                            <circle cx={xScale(ds[ds.length-1].day)} cy={yScale(ds[ds.length-1].avg_anxiety)} r={4} fill="#ef4444" />
                          </>
                        )}
                        <circle cx={pad.left + 5} cy={8} r={3} fill="#22c55e" />
                        <text x={pad.left + 12} y={11} fill="#22c55e" fontSize={9}>滿意度</text>
                        <circle cx={pad.left + 55} cy={8} r={3} fill="#ef4444" />
                        <text x={pad.left + 62} y={11} fill="#ef4444" fontSize={9}>焦慮度</text>
                      </svg>
                    </div>
                  );
                })()}

                {/* ── Live Persona Tracking ── */}
                {(() => {
                  const pList: any[] = jobStatus.persona_list || [];
                  if (pList.length === 0) return null;
                  const cats = Array.from(new Set(pList.map((p: any) => p.category))).sort();
                  const filteredForAdd = pinCategory === "all" ? pList : pList.filter((p: any) => p.category === pinCategory);

                  // Build timeline for each pinned persona from daily data
                  const buildTimeline = (pid: string) => {
                    const tl: {day: number, satisfaction: number, anxiety: number, diary?: string, fed_titles?: string[]}[] = [];
                    for (const dd of ds) {
                      const ad = (dd.agent_details || []).find((a: any) => a.id === pid);
                      if (ad) tl.push({ day: dd.day, satisfaction: ad.satisfaction, anxiety: ad.anxiety, diary: ad.diary, fed_titles: ad.fed_titles });
                    }
                    return tl;
                  };

                  // Mini sparkline renderer
                  const miniChart = (tl: any[], w = 220, ht = 36) => {
                    if (tl.length < 2) return null;
                    const maxD = Math.max(...tl.map(d => d.day));
                    const xs = (day: number) => (day / maxD) * w;
                    const ys = (v: number) => ht - (v / 100) * ht;
                    const sPath = tl.map((d, i) => `${i === 0 ? 'M' : 'L'}${xs(d.day).toFixed(1)},${ys(d.satisfaction).toFixed(1)}`).join(' ');
                    const aPath = tl.map((d, i) => `${i === 0 ? 'M' : 'L'}${xs(d.day).toFixed(1)},${ys(d.anxiety).toFixed(1)}`).join(' ');
                    return (
                      <svg width={w} height={ht} style={{ display: "block" }}>
                        <path d={sPath} fill="none" stroke="#22c55e" strokeWidth={1.5} />
                        <path d={aPath} fill="none" stroke="#ef4444" strokeWidth={1.5} />
                      </svg>
                    );
                  };

                  return (
                    <div style={{ marginTop: 10, padding: 10, borderRadius: 8, border: "1px solid rgba(139,92,246,0.15)", background: "rgba(139,92,246,0.04)" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <span style={{ color: "#a78bfa", fontSize: 12, fontWeight: 700 }}>👤 Persona live tracking</span>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {cats.length > 1 && (
                            <select value={pinCategory} onChange={e => setPinCategory(e.target.value)} style={{ padding: "2px 6px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 10 }}>
                              <option value="all">All</option>
                              {cats.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          )}
                          <select
                            value=""
                            onChange={e => {
                              const pid = e.target.value;
                              if (pid === "__random__") {
                                const available = filteredForAdd.filter((p: any) => !pinnedPersonaIds.includes(p.id));
                                if (available.length > 0) {
                                  const pick = available[Math.floor(Math.random() * available.length)];
                                  setPinnedPersonaIds(prev => [...prev, pick.id]);
                                }
                              } else if (pid && !pinnedPersonaIds.includes(pid)) {
                                setPinnedPersonaIds(prev => [...prev, pid]);
                              }
                            }}
                            style={{ padding: "2px 6px", borderRadius: 5, border: "1px solid rgba(139,92,246,0.3)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 10, maxWidth: 160 }}
                          >
                            <option value="">+ Add tracking</option>
                            <option value="__random__">🎲 隨機選一個</option>
                            {filteredForAdd.filter((p: any) => !pinnedPersonaIds.includes(p.id)).map((p: any) => (
                              <option key={p.id} value={p.id}>{p.name} ({p.political_leaning})</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {pinnedPersonaIds.length === 0 ? (
                        <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, textAlign: "center", padding: 8 }}>Select a persona above to add to live tracking</div>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {pinnedPersonaIds.map(pid => {
                            const persona = pList.find((p: any) => p.id === pid) || wsPersonas.find((p: any) => p.id === pid);
                            if (!persona) return null;
                            const tl = buildTimeline(pid);
                            const last = tl.length > 0 ? tl[tl.length - 1] : null;
                            return (
                              <div key={pid} style={{ flex: "0 0 auto", width: 280, padding: 10, borderRadius: 10, background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.08)" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                                  <span style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>{persona.name}</span>
                                  <button onClick={() => setPinnedPersonaIds(prev => prev.filter(x => x !== pid))} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: 12, padding: 0 }}>×</button>
                                </div>
                                {/* Background info tags */}
                                <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 4 }}>
                                  <span style={{ padding: "1px 5px", borderRadius: 6, fontSize: 8, background: "rgba(59,130,246,0.15)", color: "#60a5fa" }}>{persona.political_leaning}</span>
                                  {persona.age && <span style={{ padding: "1px 5px", borderRadius: 6, fontSize: 8, background: "rgba(139,92,246,0.12)", color: "#a78bfa" }}>{persona.age}歲</span>}
                                  {persona.gender && <span style={{ padding: "1px 5px", borderRadius: 6, fontSize: 8, background: "rgba(236,72,153,0.12)", color: "#f472b6" }}>{persona.gender}</span>}
                                  {persona.district && <span style={{ padding: "1px 5px", borderRadius: 6, fontSize: 8, background: "rgba(34,197,94,0.12)", color: "#4ade80" }}>{persona.district}</span>}
                                </div>
                                {persona.user_char && <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 8, marginBottom: 4, lineHeight: 1.3 }}>📋 {persona.user_char}</div>}
                                {persona.media_habit && <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 8, marginBottom: 4 }}>📺 {persona.media_habit}</div>}
                                {last && (
                                  <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                                    <span style={{ color: "#22c55e", fontSize: 11, fontWeight: 700 }}>滿{last.satisfaction}</span>
                                    <span style={{ color: "#ef4444", fontSize: 11, fontWeight: 700 }}>焦{last.anxiety}</span>
                                  </div>
                                )}
                                {/* News received */}
                                {last?.fed_titles && last.fed_titles.length > 0 && (
                                  <div style={{ marginBottom: 4, padding: "3px 6px", borderRadius: 5, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.1)" }}>
                                    {last.fed_titles.map((t: string, i: number) => (
                                      <div key={i} style={{ color: "rgba(255,255,255,0.5)", fontSize: 9 }}>📰 {t}</div>
                                    ))}
                                  </div>
                                )}
                                {/* Diary / mood */}
                                {last?.diary && (
                                  <div style={{ marginBottom: 4, padding: "3px 6px", borderRadius: 5, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.1)", maxHeight: 40, overflow: "auto" }}>
                                    <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 9, fontStyle: "italic" }}>💭 {last.diary}</div>
                                  </div>
                                )}
                                {miniChart(tl)}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Live messages */}
                <div style={{ maxHeight: 80, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                  {(jobStatus.live_messages || []).map((m: any, i: number) => (
                    <div key={i} style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>{m.text}</div>
                  ))}
                </div>
              </div>
            );
          })()}


          </div>
          {/* Right column: Agent Status */}
          <div style={{ flex: "1 1 0%", minWidth: 0, position: "sticky", top: 20, maxHeight: "calc(100vh - 40px)", overflowY: "auto" }}>
          {/* Grouped Stats Panel */}
          {activePersonas.length > 0 && (
            <div style={card}>
              <GroupedStatsPanel
                personas={activePersonas}
                autoRefresh={running}
                pollOptions={hasPollGroups ? pollGroups[0].candidates.filter(c => c.name) : pollOptions.filter(o => o.name)}
                pollGroups={hasPollGroups ? pollGroups : undefined}
                jobGroupEstimates={(() => {
                  const ds = jobStatus?.current_daily_data || jobStatus?.daily_data;
                  if (!ds || ds.length === 0) return undefined;
                  return ds[ds.length - 1].group_estimates;
                })()}
                jobGroupLeanCand={(() => {
                  const ds = jobStatus?.current_daily_data || jobStatus?.daily_data;
                  if (!ds || ds.length === 0) return undefined;
                  return ds[ds.length - 1].group_leaning_candidate;
                })()}
                jobDistrictEstimates={(() => {
                  const ds = jobStatus?.current_daily_data || jobStatus?.daily_data;
                  if (!ds || ds.length === 0) return undefined;
                  return ds[ds.length - 1].group_district_candidate;
                })()}
                jobGenderEstimates={(() => {
                  const ds = jobStatus?.current_daily_data || jobStatus?.daily_data;
                  if (!ds || ds.length === 0) return undefined;
                  return ds[ds.length - 1].group_gender_candidate;
                })()}
                jobVendorEstimates={(() => {
                  const ds = jobStatus?.current_daily_data || jobStatus?.daily_data;
                  if (!ds || ds.length === 0) return undefined;
                  return ds[ds.length - 1].group_vendor_candidate;
                })()}
              />
            </div>
          )}
          </div>
          </div>
          )}

          {/* Candidate News Impact Panel */}
          {running && jobStatus?.current_daily_data?.length > 0 && (() => {
            const lastDay = jobStatus.current_daily_data[jobStatus.current_daily_data.length - 1];
            const newsImpact = lastDay.candidate_news_impact || {};
            const candNames = Object.keys(newsImpact);
            if (candNames.length === 0) return null;

            // Determine active tab (default to first candidate)
            const activeTab = newsImpactTab && candNames.includes(newsImpactTab) ? newsImpactTab : candNames[0];
            const articles: { title: string; sentiment: number; agents_exposed: number }[] = (newsImpact[activeTab] || [])
              .slice()
              .sort((a: any, b: any) => Math.abs(b.sentiment) - Math.abs(a.sentiment));

            const totalArticles = articles.length;
            const avgSentiment = totalArticles > 0
              ? articles.reduce((sum: number, a: any) => sum + a.sentiment, 0) / totalArticles
              : 0;

            return (
              <div style={card}>
                <h3 style={{ color: "#fff", fontSize: 16, fontWeight: 700, margin: 0, marginBottom: 12, fontFamily: "var(--font-cjk)" }}>
                  📰 候選人新聞影響
                </h3>

                {/* Candidate tabs */}
                <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
                  {candNames.map((name) => (
                    <button
                      key={name}
                      onClick={() => setNewsImpactTab(name)}
                      style={{
                        padding: "5px 14px",
                        borderRadius: 20,
                        border: activeTab === name ? "none" : "1px solid rgba(255,255,255,0.15)",
                        background: activeTab === name ? "linear-gradient(135deg, #8b5cf6, #7c3aed)" : "rgba(255,255,255,0.05)",
                        color: activeTab === name ? "#fff" : "rgba(255,255,255,0.6)",
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: "pointer",
                        fontFamily: "var(--font-cjk)",
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>

                {/* Summary line */}
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginBottom: 10, fontFamily: "var(--font-cjk)" }}>
                  累計 {totalArticles} 則相關新聞，平均好感度{" "}
                  <span style={{ color: avgSentiment >= 0 ? "#22c55e" : "#ef4444", fontWeight: 600 }}>
                    {avgSentiment >= 0 ? "+" : ""}{avgSentiment.toFixed(2)}
                  </span>
                </div>

                {/* News list */}
                {articles.length === 0 ? (
                  <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 13, padding: "8px 0", fontFamily: "var(--font-cjk)" }}>
                    尚無相關新聞
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {articles.map((article, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          minHeight: 30,
                          padding: "4px 8px",
                          borderRadius: 6,
                          background: "rgba(255,255,255,0.03)",
                        }}
                      >
                        {/* Sentiment badge */}
                        <span style={{
                          display: "inline-block",
                          minWidth: 44,
                          textAlign: "center",
                          padding: "2px 7px",
                          borderRadius: 10,
                          fontSize: 12,
                          fontWeight: 700,
                          background: article.sentiment >= 0 ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                          color: article.sentiment >= 0 ? "#22c55e" : "#ef4444",
                          flexShrink: 0,
                        }}>
                          {article.sentiment >= 0 ? "+" : ""}{article.sentiment.toFixed(1)}
                        </span>

                        {/* Title */}
                        <span style={{
                          flex: 1,
                          fontSize: 13,
                          color: "rgba(255,255,255,0.8)",
                          fontFamily: "var(--font-cjk)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}>
                          {article.title}
                        </span>

                        {/* Agents exposed */}
                        <span style={{
                          fontSize: 11,
                          color: "rgba(255,255,255,0.3)",
                          flexShrink: 0,
                          fontFamily: "var(--font-cjk)",
                        }}>
                          {article.agents_exposed} 人閱讀
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Results Dashboard (placeholder when no results) */}
          {!(predResults && predResults.length > 0) && (
          <div style={card}>
            <h3 style={{ color: "#fff", fontSize: 16, fontWeight: 700, margin: 0, marginBottom: 12, fontFamily: "var(--font-cjk)" }}>{t("prediction.results.title")}</h3>
            <div style={{ padding: 24, background: "rgba(255,255,255,0.02)", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)", textAlign: "center" }}>
              <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 14, margin: 0, fontFamily: "var(--font-cjk)" }}>
                {t("prediction.results.empty")}
              </p>
            </div>
          </div>
          )}



          {/* Persona Dynamics Section */}
          {(() => {
            // Get persona data from job status or results
            const personaList: any[] = jobStatus?.persona_list || [];
            const scenarioResults: any[] = predResults || jobStatus?.scenario_results || [];
            const hasPersonaData = personaList.length > 0 && scenarioResults.length > 0;

            // Get unique categories
            const categories = Array.from(new Set(personaList.map((p: any) => p.category))).sort();

            // Filter personas by category
            const filteredPersonas = selectedCategory === "all"
              ? personaList
              : personaList.filter((p: any) => p.category === selectedCategory);

            // Get selected persona's timeline data
            const activeScenario = scenarioResults[selectedScenarioIdx];
            const timeline: any[] = activeScenario?.per_agent_timeline?.[selectedPersonaId] || [];
            const selectedPersona = personaList.find((p: any) => p.id === selectedPersonaId);

            // SVG chart renderer
            const renderChart = (data: any[], width = 500, height = 160) => {
              if (!data || data.length === 0) return <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, textAlign: "center", padding: 20 }}>尚無數據</div>;
              const pad = { top: 15, right: 15, bottom: 25, left: 35 };
              const w = width - pad.left - pad.right;
              const h = height - pad.top - pad.bottom;
              const maxDay = Math.max(...data.map(d => d.day));
              const xScale = (day: number) => pad.left + (day / maxDay) * w;
              const yScale = (val: number) => pad.top + h - ((val / 100) * h);

              const satLine = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(d.day).toFixed(1)},${yScale(d.satisfaction).toFixed(1)}`).join(' ');
              const anxLine = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(d.day).toFixed(1)},${yScale(d.anxiety).toFixed(1)}`).join(' ');

              return (
                <svg width={width} height={height} style={{ display: "block" }}>
                  {/* Grid lines */}
                  {[0, 25, 50, 75, 100].map(v => (
                    <g key={v}>
                      <line x1={pad.left} y1={yScale(v)} x2={width - pad.right} y2={yScale(v)} stroke="rgba(255,255,255,0.06)" />
                      <text x={pad.left - 4} y={yScale(v) + 3} fill="rgba(255,255,255,0.25)" fontSize={9} textAnchor="end">{v}</text>
                    </g>
                  ))}
                  {/* X axis labels */}
                  {data.filter((_, i) => i === 0 || i === data.length - 1 || (i + 1) % 5 === 0).map(d => (
                    <text key={d.day} x={xScale(d.day)} y={height - 5} fill="rgba(255,255,255,0.25)" fontSize={9} textAnchor="middle">D{d.day}</text>
                  ))}
                  {/* Satisfaction line (green) */}
                  <path d={satLine} fill="none" stroke="#22c55e" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  {/* Anxiety line (red) */}
                  <path d={anxLine} fill="none" stroke="#ef4444" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  {/* End dots */}
                  {data.length > 0 && (
                    <>
                      <circle cx={xScale(data[data.length-1].day)} cy={yScale(data[data.length-1].satisfaction)} r={3} fill="#22c55e" />
                      <circle cx={xScale(data[data.length-1].day)} cy={yScale(data[data.length-1].anxiety)} r={3} fill="#ef4444" />
                    </>
                  )}
                  {/* Legend */}
                  <circle cx={pad.left + 5} cy={8} r={3} fill="#22c55e" />
                  <text x={pad.left + 12} y={11} fill="#22c55e" fontSize={9}>{isCandidateMode ? "施政滿意度" : "滿意度"}</text>
                  <circle cx={pad.left + 65} cy={8} r={3} fill="#ef4444" />
                  <text x={pad.left + 72} y={11} fill="#ef4444" fontSize={9}>{isCandidateMode ? "社會焦慮度" : "焦慮度"}</text>
                </svg>
              );
            };
          })()}

          {/* Past predictions */}
          {pastPredictions.length > 0 && (
            <div style={card}>
              <h3 style={{ color: "#fff", fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 8, fontFamily: "var(--font-cjk)" }}>📚 歷史預測</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {pastPredictions.map(p => (
                  <div key={p.prediction_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.05)" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: "#fff", fontSize: 13 }}>{p.question}</div>
                      <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 11 }}>
                        {p.scenario_count} scenarios · {p.sim_days} days · {new Date(p.created_at * 1000).toLocaleString()}
                      </div>
                    </div>
                    <span style={{ padding: "2px 8px", borderRadius: 10, background: p.has_results ? "rgba(34,197,94,0.1)" : "rgba(245,158,11,0.1)", color: p.has_results ? "#22c55e" : "#f59e0b", fontSize: 10 }}>
                      {p.has_results ? "已完成" : p.status}
                    </span>
                    {p.has_results && (
                      <button onClick={() => handleLoadPastResult(p.prediction_id)} style={{ ...btn(), padding: "4px 10px", fontSize: 11 }}>查看</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* ─────────────────────────────────────────────────────────────
            Voting-method help modal — explains 加權民調 vs LLM 投票
            vs 對比式比較 邏輯，使用者點 ⓘ 開啟
          ───────────────────────────────────────────────────────────── */}
        {helpModal && (
          <div
            onClick={() => setHelpModal(null)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
              display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
              padding: 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: 720, maxHeight: "85vh", overflow: "auto",
                background: "#1a1a2e", borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.12)",
                padding: "24px 28px", color: "rgba(255,255,255,0.85)",
                fontFamily: "var(--font-cjk)", lineHeight: 1.7, fontSize: 13,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#fff" }}>
                  {helpModal === "weighted" && "📊 加權民調 — 啟發式評分"}
                  {helpModal === "llm" && "🗳️ LLM 模擬投票"}
                  {helpModal === "contrast" && "⚖️ 對比式民調與兩種計算方式"}
                </h2>
                <button onClick={() => setHelpModal(null)}
                  style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.5)", fontSize: 22, cursor: "pointer", padding: 0 }}
                >×</button>
              </div>

              {helpModal === "weighted" && (
                <div>
                  <p><strong style={{ color: "#3b82f6" }}>計算方式：</strong>At the end of each sim day, the system uses each agent's current state (candidate_awareness, candidate_sentiment, party leaning, satisfaction, anxiety) with a linear性公式直接計算每位候選人的支持度百分比。</p>

                  <p><strong style={{ color: "#3b82f6" }}>核心訊號（依權重）：</strong></p>
                  <ul style={{ paddingLeft: 20 }}>
                    <li><strong>政黨基本盤</strong>（最強）：偏綠 → 民進黨基本盤，偏藍 → 國民黨基本盤，偏白 → 民眾黨基本盤</li>
                    <li><strong>candidate_awareness × candidate_sentiment</strong>：認識度高 + 印象正面 → 加分</li>
                    <li><strong>關鍵字匹配</strong>：候選人簡介中的關鍵字 vs agent 關心議題</li>
                    <li><strong>同黨對決規則</strong>：當對手是同黨派時加入猶豫機制</li>
                    <li><strong>不表態機率</strong>：認識度過低或情緒模糊 → 部分機率歸入「不表態」</li>
                  </ul>

                  <p><strong style={{ color: "#3b82f6" }}>包含「不表態」</strong>：總和 = 候選人 A + 候選人 B + 不表態 = 100%</p>

                  <p><strong style={{ color: "#3b82f6" }}>優點：</strong></p>
                  <ul style={{ paddingLeft: 20 }}>
                    <li>Extremely fast (hundreds of agents per second), can update daily in real-time</li>
                    <li>包含「不表態」更接近真實民調的「未決定」族群</li>
                    <li>對偶然偏差較不敏感，數值穩定</li>
                  </ul>

                  <p><strong style={{ color: "#ef4444" }}>缺點：</strong></p>
                  <ul style={{ paddingLeft: 20 }}>
                    <li>線性公式無法捕捉「現任 vs 知名挑戰者」的非線性動態</li>
                    <li>偏向保守，差距通常較小</li>
                    <li>無法處理 agent 對「特定議題」的強烈意見</li>
                  </ul>

                  <p style={{ background: "rgba(59,130,246,0.08)", padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(59,130,246,0.2)" }}>
                    💡 <strong>適合場景</strong>：演化過程中即時觀察滿意度趨勢、看「政黨基本盤 + 議題偏好」如何分配。可視為「公式版民意指標」。
                  </p>
                </div>
              )}

              {helpModal === "llm" && (
                <div>
                  <p><strong style={{ color: "#a78bfa" }}>計算方式：</strong>所有演化days結束後，系統對每位 agent 額外發起一次 LLM 呼叫，丟一段「你正在接受民調，請從候選人 A、B 之中選一位」的 prompt，由 LLM 模擬該 agent 的決策。</p>

                  <p><strong style={{ color: "#a78bfa" }}>Prompt 包含的訊號：</strong></p>
                  <ul style={{ paddingLeft: 20 }}>
                    <li><strong>persona</strong>：年齡、性別、職業、區域、教育、生活敘事</li>
                    <li><strong>政治傾向</strong>（偏綠 / 偏藍 / 偏白 / 中立）</li>
                    <li><strong>長期記憶</strong>：30 days演化期間累積的 memory_summary</li>
                    <li><strong>整體心態</strong>：semantic 描述的滿意度、焦慮度</li>
                    <li><strong>最近 5 days日記</strong>：最近所讀新聞與情緒反應</li>
                    <li><strong>每位候選人</strong>的：認識程度（awareness）+ 整體印象（sentiment）+ 簡介（如認識度夠高才看到）</li>
                  </ul>

                  <p><strong style={{ color: "#a78bfa" }}>強制二選一</strong>：LLM 必須選其中一位或回答「不表態」。</p>

                  <p><strong style={{ color: "#a78bfa" }}>優點：</strong></p>
                  <ul style={{ paddingLeft: 20 }}>
                    <li>能捕捉非線性的決策邏輯（「我認得他但討厭他」「他是知名媒體人所以可以接受」）</li>
                    <li>Closer to real-world "forced choice" polling scenarios</li>
                    <li>對 sentiment 訊號敏感度高，能反映「現任無感」效應</li>
                    <li>Can simulate strategic voting behavior (e.g., a moderate Dem's preference in a D-vs-D primary)</li>
                  </ul>

                  <p><strong style={{ color: "#ef4444" }}>缺點：</strong></p>
                  <ul style={{ paddingLeft: 20 }}>
                    <li>計算成本高（每位 agent 一次 LLM 呼叫）</li>
                    <li>對 prompt 措辭與 LLM 模型敏感，可能放大微小 sentiment 差異</li>
                    <li>較難 debug —「為什麼 LLM 投這個」沒有顯式公式可追溯</li>
                    <li>容易受 LLM 偏見影響（例如某些模型對特定政黨有先驗）</li>
                  </ul>

                  <p style={{ background: "rgba(139,92,246,0.08)", padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(139,92,246,0.2)" }}>
                    💡 <strong>適合場景</strong>：Simulates real-world "head-to-head" and "forced choice" polling scenarios. The contrast comparison system uses this score.
                  </p>
                </div>
              )}

              {helpModal === "contrast" && (
                <div>
                  <p><strong style={{ color: "#fbbf24" }}>Contrast式民調是什麼？</strong></p>
                  <p>當你設定多個 poll group，每組有不同的「挑戰者」對上「共同對手」（例如藍白合：翁壽良 vs 王美惠、張啓楷 vs 王美惠），系統會：</p>
                  <ol style={{ paddingLeft: 20 }}>
                    <li>Detect common opponent (candidate appearing in ≥2 groups)</li>
                    <li>對每組計算 margin = 挑戰者得票 - 共同對手得票</li>
                    <li>取 margin 最大的挑戰者推薦為「最有勝算」</li>
                  </ol>

                  <p><strong style={{ color: "#fbbf24" }}>用哪種數字計算？</strong></p>
                  <p>系統用 <strong style={{ color: "#a78bfa" }}>LLM 投票結果</strong>（不是加權民調）來計算 margin。原因：</p>
                  <ul style={{ paddingLeft: 20 }}>
                    <li>Head-to-head polling by definition forces voters to choose between exactly two candidates</li>
                    <li>真實民調公司打電話也是請受訪者直接二選一</li>
                    <li>The LLM voting "forced binary choice" logic best matches this scenario</li>
                  </ul>

                  <p style={{ background: "rgba(245,158,11,0.08)", padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(245,158,11,0.25)", marginBottom: 12 }}>
                    ⚠️ <strong>當兩種測量方式給出不同推薦時：</strong>
                    <br/>
                    這代表 <strong>加權民調的「政黨基本盤主導」結論</strong> 和 <strong>LLM 投票的「強迫表態」結論</strong> 不一致。常見原因：
                    <ul style={{ paddingLeft: 20, marginTop: 6 }}>
                      <li>有候選人「認識度極高 + sentiment 微正」導致 LLM 大幅加權他的勝率</li>
                      <li>現任候選人在「面對知名挑戰者」時的「無感效應」被 LLM 放大</li>
                      <li>「不表態」族群在 LLM 投票中被擠壓出來改投陣營</li>
                    </ul>
                    <strong>建議解讀方式：</strong>
                    <ul style={{ paddingLeft: 20, marginTop: 6 }}>
                      <li>取兩者平均作為最可能區間</li>
                      <li>檢視「政治傾向別偏好」拆解，看哪個族群差異最大</li>
                      <li>對照真實民調歷史結果（若有），判斷哪種測量更貼近現實</li>
                      <li>不要完全信任單一數字 — 兩者都是有限近似</li>
                    </ul>
                  </p>

                  <p><strong style={{ color: "#fbbf24" }}>其他注意事項：</strong></p>
                  <ul style={{ paddingLeft: 20 }}>
                    <li>Contrast式邏輯只在「至少 2 組共享同一個對手」時觸發</li>
                    <li>如果只有 1 個 poll group，系統不會做對比式推薦</li>
                    <li>滿意度模式（非選舉模式）不用對比式邏輯</li>
                  </ul>
                </div>
              )}

              <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "flex-end" }}>
                <button onClick={() => setHelpModal(null)}
                  style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.05)", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-cjk)" }}
                >了解了</button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
