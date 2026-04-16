"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import {
  startEvolution,
  getEvolutionStatus,
  triggerCrawl,
  getNewsPool,
  injectNewsArticle,
  getWorkspacePersonas,
  saveUiSettings,
  getUiSettings,
  saveSnapshot,
} from "@/lib/api";
import { useActiveTemplate } from "@/hooks/use-active-template";
import { useLocaleStore } from "@/store/locale-store";
import { useShellStore } from "@/store/shell-store";

/* ── helpers ── */

function electionDate(cycle: number | null | undefined): string {
  // US presidential election: first Tuesday after first Monday in November
  if (!cycle) return "";
  const nov1 = new Date(cycle, 10, 1); // Nov 1
  const dayOfWeek = nov1.getDay(); // 0=Sun
  const firstMonday = dayOfWeek <= 1 ? 1 + (1 - dayOfWeek) : 1 + (8 - dayOfWeek);
  const elDay = firstMonday + 1; // Tuesday after first Monday
  return `${cycle}-11-${String(elDay).padStart(2, "0")}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function fmtDate(d: string, en: boolean): string {
  if (!d) return "—";
  const dt = new Date(d);
  return en
    ? dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : dt.toLocaleDateString("zh-TW", { month: "long", day: "numeric", year: "numeric" });
}

/* ── default advanced parameters ── */

const DEFAULT_ADV_PARAMS = {
  // Political leaning shifts
  enable_dynamic_leaning: true,
  shift_sat_threshold_low: 20,
  shift_anx_threshold_high: 80,
  shift_consecutive_days_req: 5,
  // News impact & echo chamber
  news_impact: 2.0,
  serendipity_rate: 0.05,
  articles_per_agent: 3,
  forget_rate: 0.15,
  // Emotional response
  delta_cap_mult: 1.5,
  satisfaction_decay: 0.02,
  anxiety_decay: 0.05,
  // Undecided & party effects
  base_undecided: 0.10,
  max_undecided: 0.45,
  party_align_bonus: 15,
  incumbency_bonus: 12,
  // Life events & individuality
  individuality_multiplier: 1.0,
  neutral_ratio: 0.0,
  // News category mix (must sum to 100)
  news_mix_candidate: 25,
  news_mix_national: 35,
  news_mix_local: 30,
  news_mix_international: 10,
};

type AdvParams = typeof DEFAULT_ADV_PARAMS;

/* ── component ── */

export default function EvolutionQuickStartPanel({ wsId }: { wsId: string }) {
  const router = useRouter();
  const en = useLocaleStore((s) => s.locale) === "en";
  const { template, loading: tplLoading } = useActiveTemplate(wsId);

  // Election data from template
  const election = (template as any)?.election;
  const candidates = election?.candidates ?? [];
  const cycle = election?.cycle;
  const isGeneric = election?.is_generic ?? !cycle;
  const searchKeywords = election?.default_search_keywords ?? {};
  const evolutionParams = election?.default_evolution_params ?? {};
  const evolutionWindow = election?.default_evolution_window ?? {};

  // Refs that always hold the latest election/candidates/advParams — so
  // runOneRound doesn't read a stale closure snapshot if the user clicks
  // Start before the template finishes loading.
  const electionRef = useRef<any>(election);
  const candidatesRef = useRef<any[]>(candidates);
  useEffect(() => { electionRef.current = election; }, [election]);

  // Custom candidates: null = use template. When set, each entry is a
  // {name, party} object. Legacy string[] format is upgraded on load.
  type CustomCand = { name: string; party: string };
  const [customCandidates, setCustomCandidates] = useState<CustomCand[] | null>(null);
  const [candidateInput, setCandidateInput] = useState("");
  const [candidateParty, setCandidateParty] = useState<string>("I");
  const customCandidatesLoadedRef = useRef(false);

  // Party code → internal "alignment class" used by backend scoring.
  // Backend only distinguishes D/R/I for partisan ±8; L/G and any minor
  // party fall into the "I" bucket (no partisan bonus) but keep their
  // own display code/colour for the UI and diary.
  const _inferParty = (name: string): string => {
    const n = (name || "").toLowerCase();
    if (n.includes("democrat") || n.includes(" dem")) return "D";
    if (n.includes("republican") || n.includes(" rep") || n.includes("gop")) return "R";
    if (n.includes("libertarian")) return "L";
    if (n.includes("green party")) return "G";
    return "I";
  };

  useEffect(() => {
    if (!wsId || customCandidatesLoadedRef.current) return;
    customCandidatesLoadedRef.current = true;
    getUiSettings(wsId, "custom-candidates").then((s: any) => {
      if (!Array.isArray(s?.candidates)) return;
      const upgraded: CustomCand[] = s.candidates.map((c: any) => {
        if (typeof c === "string") return { name: c, party: _inferParty(c) };
        return { name: String(c?.name || ""), party: c?.party || _inferParty(c?.name || "") };
      }).filter((c: CustomCand) => c.name);
      setCustomCandidates(upgraded);
    }).catch(() => {});
  }, [wsId]);

  // Effective candidates: custom list overrides template candidates.
  // L/G get their own display code but are treated as "I" in scoring
  // logic downstream (see _alignmentClass in runOneRound).
  const effectiveCandidates: any[] = customCandidates !== null
    ? customCandidates.map((c) => ({ id: c.name, name: c.name, party: c.party, party_label: c.name }))
    : candidates;

  // Keep ref in sync with effective list
  useEffect(() => { candidatesRef.current = effectiveCandidates; }, [effectiveCandidates]);

  // Compute dates — dynamic "last 6 months → today" when election day is still future
  const elDate = cycle ? electionDate(cycle) : "";
  const _today = new Date().toISOString().slice(0, 10);
  const _elFuture = elDate && elDate > _today;
  const defaultStart = evolutionWindow.start_date || (_elFuture ? addDays(_today, -180) : (elDate ? addDays(elDate, -180) : addDays(_today, -180)));
  const defaultEnd = evolutionWindow.end_date || (_elFuture ? _today : (elDate ? addDays(elDate, -1) : addDays(_today, -1)));

  // Settings
  const [simDays, setSimDays] = useState(evolutionParams.sim_days ?? 30);
  const [crawlInterval, setCrawlInterval] = useState(evolutionParams.search_interval ?? 3);
  const [concurrency, setConcurrency] = useState(evolutionParams.concurrency ?? 5);
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);

  // Advanced parameters
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advParams, setAdvParams] = useState<AdvParams>({ ...DEFAULT_ADV_PARAMS });
  // Track the template-provided calibration defaults so we can show "modified" dot
  const [templateCalib, setTemplateCalib] = useState<AdvParams>({ ...DEFAULT_ADV_PARAMS });

  // Merge template calibration_params into AdvParams shape
  const calibToAdv = useCallback((cp: Record<string, unknown>): AdvParams => {
    const merged = { ...DEFAULT_ADV_PARAMS };
    for (const k of Object.keys(DEFAULT_ADV_PARAMS) as (keyof AdvParams)[]) {
      if (cp[k] != null) (merged as any)[k] = cp[k];
    }
    return merged;
  }, []);

  // Update when template loads — sets evolution params, dates, calibration defaults,
  // then applies saved user overrides (simDays, crawlInterval, concurrency) on top.
  // advParams always come from template calibration to avoid stale overrides.
  useEffect(() => {
    if (!template) return;
    const ep = (template as any)?.election?.default_evolution_params;
    const ew = (template as any)?.election?.default_evolution_window;
    const tplSimDays = ep?.sim_days;
    const tplInterval = ep?.search_interval;
    const tplConcurrency = ep?.concurrency;
    if (tplSimDays) setSimDays(tplSimDays);
    if (tplInterval) setCrawlInterval(tplInterval);
    if (tplConcurrency) setConcurrency(tplConcurrency);
    const c = (template as any)?.election?.cycle;
    const ed = c ? electionDate(c) : "";
    // Today (dynamic, from local PC) as the latest news date — Serper can't
    // return future articles.
    const today = new Date().toISOString().slice(0, 10);
    const electionIsFuture = ed && ed > today;
    // Prefer explicit template window. If election day is still in the future
    // (e.g. 2028 cycle run in 2026), fall back to dynamic "last 6 months"
    // ending today, so Serper has real news to crawl.
    const defaultStart = electionIsFuture
      ? addDays(today, -180)
      : (ed ? addDays(ed, -180) : addDays(today, -180));
    const defaultEnd = electionIsFuture
      ? today
      : (ed ? addDays(ed, -1) : addDays(today, -1));
    setStartDate(ew?.start_date || defaultStart);
    setEndDate(ew?.end_date || defaultEnd);

    // Load template calibration params as advanced parameter defaults
    const cp = (template as any)?.election?.default_calibration_params;
    if (cp) {
      const tplAdv = calibToAdv(cp);
      setTemplateCalib(tplAdv);
      setAdvParams(tplAdv);
    }

    // Apply saved user overrides AFTER template defaults (saved values take priority)
    getUiSettings(wsId, "evolution-quickstart").then((s: any) => {
      if (s?.simDays) setSimDays(s.simDays);
      if (s?.crawlInterval) setCrawlInterval(s.crawlInterval);
      if (s?.concurrency) setConcurrency(s.concurrency);
    }).catch(() => {}).finally(() => {
      settingsReadyRef.current = true; // allow persist effect to fire from now on
    });
  }, [template, calibToAdv, wsId]);

  // Gate: only persist AFTER template + saved settings have been fully loaded
  const settingsReadyRef = useRef(false);

  // Persist settings when changed — but only after initial load completes
  useEffect(() => {
    if (!settingsReadyRef.current) return; // skip mount-time defaults
    saveUiSettings(wsId, "evolution-quickstart", { simDays, crawlInterval, concurrency, advParams }).catch(() => {});
  }, [wsId, simDays, crawlInterval, concurrency, advParams]);

  // Personas
  const [personaCount, setPersonaCount] = useState(0);
  const [personas, setPersonas] = useState<any[]>([]);
  useEffect(() => {
    if (!wsId) return;
    getWorkspacePersonas(wsId).then((r: any) => {
      const agents = r?.agents ?? (Array.isArray(r) ? r : []);
      setPersonas(agents);
      setPersonaCount(agents.length);
    }).catch(() => {});
  }, [wsId]);

  // Evolution state
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [currentRound, setCurrentRound] = useState(0);
  const [totalRounds, setTotalRounds] = useState(0);
  const [phase, setPhase] = useState<"idle" | "crawling" | "evolving" | "paused" | "done" | "error">("idle");
  const [phaseLabel, setPhaseLabel] = useState("");
  const [currentSimDate, setCurrentSimDate] = useState("");
  const [newsCount, setNewsCount] = useState(0);
  const [error, setError] = useState("");
  const abortRef = useRef(false);
  const pauseRef = useRef(false);
  const activeJobIdRef = useRef<string | null>(null);

  // Persist evolution progress so it survives page close
  const saveProgress = useCallback((state: Record<string, any>) => {
    saveUiSettings(wsId, "evolution-progress", state).catch(() => {});
  }, [wsId]);

  const clearProgress = useCallback(() => {
    saveUiSettings(wsId, "evolution-progress", { status: "idle" }).catch(() => {});
  }, [wsId]);

  const saveCandidates = useCallback((cands: CustomCand[]) => {
    setCustomCandidates(cands);
    saveUiSettings(wsId, "custom-candidates", { candidates: cands }).catch(() => {});
  }, [wsId]);

  // Restore evolution state on mount — detect if a job is still running
  useEffect(() => {
    (async () => {
      try {
        const saved = await getUiSettings(wsId, "evolution-progress");
        if (!saved || saved.status === "idle" || saved.status === "done") return;

        // There was an active evolution plan
        const { status, currentRound: cr, totalRounds: tr, newsCount: nc, activeJobId, simDate } = saved;
        // Recover from "stuck paused at final round" — all rounds already
        // completed but the done-transition save never fired (e.g. page was
        // closed mid-completion, or user paused exactly as the last round
        // wrapped up). Promote to "done" so Prediction unlocks.
        if (status === "paused" && cr && tr && cr >= tr) {
          setCurrentRound(cr); setTotalRounds(tr); setNewsCount(nc || 0);
          setPhase("done");
          setPhaseLabel(en ? "Evolution complete!" : "演化完成！");
          saveUiSettings(wsId, "evolution-progress", { ...saved, status: "done", activeJobId: null }).catch(() => {});
          return;
        }
        if (status === "paused") {
          setCurrentRound(cr || 0);
          setTotalRounds(tr || 0);
          setNewsCount(nc || 0);
          setCurrentSimDate(simDate || "");
          setPaused(true);
          setPhase("paused");
          setPhaseLabel(en ? "Paused — click Resume to continue" : "已暫停 — 點擊繼續");
          return;
        }

        if (status === "evolving" && activeJobId) {
          // Check if the backend job is still running
          try {
            const jobStatus = await getEvolutionStatus(activeJobId);
            if (jobStatus.status === "running" || jobStatus.status === "pending") {
              // Job still running — poll it until done, then resume from next round
              setRunning(true);
              setCurrentRound(cr || 0);
              setTotalRounds(tr || 0);
              setNewsCount(nc || 0);
              setCurrentSimDate(simDate || "");
              setPhase("evolving");
              setPhaseLabel(en ? `Evolving agents (round ${cr}/${tr})...` : `演化中（第 ${cr}/${tr} 輪）...`);
              activeJobIdRef.current = activeJobId;
              // Poll this job in background, then resume from next round
              (async () => {
                let jobDone = false;
                while (!jobDone && !abortRef.current) {
                  await new Promise((r) => setTimeout(r, 2000));
                  if (pauseRef.current) {
                    setPaused(true); setPhase("paused"); setRunning(false);
                    setPhaseLabel(en ? `Paused after round ${cr}/${tr}` : `第 ${cr}/${tr} 輪後暫停`);
                    return;
                  }
                  try {
                    const st = await getEvolutionStatus(activeJobId);
                    if (st.status === "done" || st.status === "completed") jobDone = true;
                    else if (st.status === "stopped" || st.status === "failed" || st.status === "error") { setPhase("error"); setError(st.error || "Job stopped unexpectedly"); setRunning(false); return; }
                  } catch { /* keep polling */ }
                }
                if (abortRef.current) { setRunning(false); return; }
                // Current round done — continue from next round, or mark done if final round
                setRunning(false);
                if ((cr || 0) >= (tr || 0)) {
                  // Final round just finished while we were polling — mark complete
                  setCurrentRound(tr || 0);
                  setTotalRounds(tr || 0);
                  setPhase("done");
                  setPhaseLabel(en ? "Evolution complete!" : "演化完成！");
                  saveProgress({ ...saved, status: "done", activeJobId: null });
                } else {
                  handleStart((cr || 0) + 1, nc || 0);
                }
              })();
              return;
            } else if (jobStatus.status === "done" || jobStatus.status === "completed") {
              // Job finished while page was closed. If this was the FINAL
              // round, mark the whole evolution done (unlocks Prediction)
              // rather than prompting the user to click Resume for nothing.
              if (cr && tr && cr >= tr) {
                setCurrentRound(cr); setTotalRounds(tr); setNewsCount(nc || 0);
                setPhase("done");
                setPhaseLabel(en ? "Evolution complete!" : "演化完成！");
                saveUiSettings(wsId, "evolution-progress", { ...saved, status: "done", activeJobId: null }).catch(() => {});
                return;
              }
              setCurrentRound(cr || 0);
              setTotalRounds(tr || 0);
              setNewsCount(nc || 0);
              setPaused(true);
              setPhase("paused");
              setPhaseLabel(en ? `Round ${cr}/${tr} completed while away — click Resume to continue` : `第 ${cr}/${tr} 輪已在背景完成 — 點擊繼續`);
              saveProgress({ ...saved, status: "paused", activeJobId: null });
            } else {
              // Job stopped / failed / error — clear stale progress
              clearProgress();
            }
          } catch {
            // Job not found — reset
            clearProgress();
          }
        }
      } catch { /* no saved progress */ }
    })();
  }, [wsId]);

  // Known source sites by leaning (for targeted search)
  const sourceBuckets: Record<string, { name: string; site: string }[]> = {
    "Solid Dem": [
      { name: "MSNBC", site: "msnbc.com" },
      { name: "HuffPost", site: "huffpost.com" },
    ],
    "Lean Dem": [
      { name: "CNN", site: "cnn.com" },
      { name: "The New York Times", site: "nytimes.com" },
      { name: "NPR", site: "npr.org" },
      { name: "The Washington Post", site: "washingtonpost.com" },
      { name: "NBC News", site: "nbcnews.com" },
      { name: "ABC News", site: "abcnews.go.com" },
      { name: "CBS News", site: "cbsnews.com" },
      { name: "PBS NewsHour", site: "pbs.org" },
    ],
    "Tossup": [
      { name: "Reuters", site: "reuters.com" },
      { name: "Associated Press", site: "apnews.com" },
      { name: "The Hill", site: "thehill.com" },
      { name: "USA Today", site: "usatoday.com" },
      { name: "Axios", site: "axios.com" },
    ],
    "Lean Rep": [
      { name: "Fox News", site: "foxnews.com" },
      { name: "The Wall Street Journal", site: "wsj.com" },
      { name: "New York Post", site: "nypost.com" },
      { name: "The Washington Times", site: "washingtontimes.com" },
    ],
    "Solid Rep": [
      { name: "Breitbart", site: "breitbart.com" },
      { name: "The Daily Wire", site: "dailywire.com" },
    ],
  };

  // Build search queries distributed by news category mix
  const buildQueries = useCallback(() => {
    const candidateNameList = candidates.map((c: any) => c.name as string).filter(Boolean);
    const nationalKws = (searchKeywords.national || "US election economy voters congress federal policy").split("\n").filter(Boolean);
    const localKws = (searchKeywords.local || "swing state governor local election county school").split("\n").filter(Boolean);
    const natPick = () => nationalKws[Math.floor(Math.random() * nationalKws.length)] || "";
    const locPick = () => localKws[Math.floor(Math.random() * localKws.length)] || "";
    // Round-robin index so each candidate gets searched in turn across queries
    let _candRRIdx = Math.floor(Math.random() * Math.max(candidateNameList.length, 1));
    const pickCandidateName = () => {
      if (!candidateNameList.length) return "";
      const name = candidateNameList[_candRRIdx % candidateNameList.length];
      _candRRIdx++;
      return name;
    };

    // Category-specific query templates — avoid candidate names in non-candidate queries
    const localStates = ["Pennsylvania", "Michigan", "Wisconsin", "Georgia", "Arizona", "Nevada", "Virginia", "New Jersey", "Ohio", "North Carolina", "Florida", "Texas", "Minnesota", "Colorado"];
    const randomState = () => localStates[Math.floor(Math.random() * localStates.length)];
    const nationalTopics = [
      "inflation cost of living groceries", "jobs unemployment layoffs hiring",
      "healthcare Medicare Medicaid drug prices", "immigration ICE border enforcement",
      "gun violence shooting legislation", "infrastructure roads bridges spending",
      "student loan debt college tuition", "Social Security retirement benefits",
      "housing market mortgage rates", "consumer confidence economy wages",
      "federal budget deficit spending", "SNAP food stamps benefits",
      "gas prices energy costs", "minimum wage workers rights",
    ];
    const randomNatTopic = () => nationalTopics[Math.floor(Math.random() * nationalTopics.length)];
    const localTopics = [
      "governor signs bill", "state budget education funding",
      "local police crime report", "city council zoning housing",
      "school district teachers", "state highway road construction",
      "county property tax assessment", "community health clinic",
      "mayor city development plan", "state court ruling law",
    ];
    const randomLocTopic = () => localTopics[Math.floor(Math.random() * localTopics.length)];
    const intlTopics = [
      "NATO Europe alliance defense", "China trade tariff sanctions",
      "Middle East Israel diplomacy", "Ukraine Russia war conflict",
      "G7 summit world leaders", "global recession economy forecast",
      "climate change COP summit", "UN General Assembly resolution",
      "India economy trade partnership", "UK Europe Brexit policy",
    ];
    const randomIntlTopic = () => intlTopics[Math.floor(Math.random() * intlTopics.length)];
    const categoryQueries = {
      candidate: () => {
        const n = pickCandidateName();
        if (!n) return `US presidential candidate 2028 poll`;
        // Use quoted full name to prevent last-name collisions (e.g. "Shapiro"
        // matching Ben Shapiro instead of Josh Shapiro). Rotate suffix pools so
        // each query yields different coverage angles.
        const suffixes = [
          "news",
          "2028 presidential",
          "policy statement",
          "poll voters",
          "speech interview",
        ];
        const suffix = suffixes[_candRRIdx % suffixes.length];
        return `"${n}" ${suffix}`;
      },
      national: () => randomNatTopic(),
      local: () => `"${randomState()}" ${randomLocTopic()}`,
      international: () => randomIntlTopic(),
    };

    // Determine how many queries per category.
    // Candidate queries: at least 1 per candidate so every candidate gets searched
    // each round. Other categories fill the remainder up to totalQueries.
    const minCandidateQueries = Math.max(candidateNameList.length, 1);
    const total = advParams.news_mix_candidate + advParams.news_mix_national + advParams.news_mix_local + advParams.news_mix_international || 100;
    const nonCandidateQueries = 6; // fixed budget for national/local/intl
    const totalQueries = minCandidateQueries + nonCandidateQueries;
    const counts = {
      candidate: minCandidateQueries,
      national: Math.round((advParams.news_mix_national / (advParams.news_mix_national + advParams.news_mix_local + advParams.news_mix_international || 1)) * nonCandidateQueries) || 0,
      local: Math.round((advParams.news_mix_local / (advParams.news_mix_national + advParams.news_mix_local + advParams.news_mix_international || 1)) * nonCandidateQueries) || 0,
      international: Math.round((advParams.news_mix_international / (advParams.news_mix_national + advParams.news_mix_local + advParams.news_mix_international || 1)) * nonCandidateQueries) || 0,
    };
    // Ensure totals add up (rounding artifacts)
    while (counts.candidate + counts.national + counts.local + counts.international < totalQueries) {
      counts.national++;
    }

    // Source selection: ensure balanced political leaning coverage
    // "Must-have" sources — always searched every round for balanced coverage
    const mustHaveSources = [
      { name: "CNN", site: "cnn.com", leaning: "Lean Dem" },
      { name: "Fox News", site: "foxnews.com", leaning: "Lean Rep" },
      { name: "Reuters", site: "reuters.com", leaning: "Tossup" },
    ];
    // Rotating pool — one from each remaining bucket per round
    const rotatingPools: { name: string; site: string; leaning: string }[][] = [
      // Lean Dem extras (excluding CNN which is must-have)
      [
        { name: "The New York Times", site: "nytimes.com", leaning: "Lean Dem" },
        { name: "NPR", site: "npr.org", leaning: "Lean Dem" },
        { name: "The Washington Post", site: "washingtonpost.com", leaning: "Lean Dem" },
        { name: "ABC News", site: "abcnews.go.com", leaning: "Lean Dem" },
      ],
      // Tossup extras (excluding Reuters which is must-have)
      [
        { name: "Associated Press", site: "apnews.com", leaning: "Tossup" },
        { name: "The Hill", site: "thehill.com", leaning: "Tossup" },
        { name: "USA Today", site: "usatoday.com", leaning: "Tossup" },
        { name: "PBS", site: "pbs.org", leaning: "Tossup" },
      ],
      // Lean Rep extras (excluding Fox which is must-have)
      [
        { name: "The Wall Street Journal", site: "wsj.com", leaning: "Lean Rep" },
        { name: "New York Post", site: "nypost.com", leaning: "Lean Rep" },
        { name: "The Washington Times", site: "washingtontimes.com", leaning: "Lean Rep" },
      ],
      // Solid Dem
      [
        { name: "HuffPost", site: "huffpost.com", leaning: "Solid Dem" },
      ],
      // Solid Rep
      [
        { name: "Breitbart", site: "breitbart.com", leaning: "Solid Rep" },
        { name: "The Daily Wire", site: "dailywire.com", leaning: "Solid Rep" },
      ],
    ];
    const pickRandom = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
    // Build rotating sources for this round (1 from each pool)
    const rotatingSources = rotatingPools.map((pool) => pickRandom(pool));

    // Combine: must-haves + rotating = ~8 sources per round, balanced
    const roundSources = [...mustHaveSources, ...rotatingSources];

    const queries: { query: string; sourceName: string; leaning: string }[] = [];
    // Distribute category queries across the balanced source list
    let srcIdx = 0;
    for (const [category, count] of Object.entries(counts)) {
      for (let i = 0; i < count; i++) {
        const src = roundSources[srcIdx % roundSources.length];
        srcIdx++;
        const q = categoryQueries[category as keyof typeof categoryQueries]();
        queries.push({ query: `site:${src.site} ${q}`, sourceName: src.name, leaning: src.leaning });
      }
    }
    return queries;
  }, [candidates, searchKeywords, advParams.news_mix_candidate, advParams.news_mix_national, advParams.news_mix_local, advParams.news_mix_international]);

  // Run a single round: crawl news + evolve
  const runOneRound = useCallback(async (roundNum: number, rounds: number, windowDays: number, daysPerRound: number, cumNewsCount: number): Promise<{ newsCount: number; jobId: string | null }> => {
    const roundStart = addDays(startDate, (roundNum - 1) * daysPerRound);
    const roundEnd = addDays(startDate, Math.min(roundNum * daysPerRound, windowDays));
    setCurrentSimDate(roundStart);

    // Phase 1: Crawl news
    setPhase("crawling");
    setPhaseLabel(en ? `Fetching news for ${fmtDate(roundStart, en)}...` : `抓取 ${fmtDate(roundStart, false)} 的新聞...`);
    let roundNewsCount = 0;
    try {
      const queries = buildQueries();
      for (const { query, sourceName } of queries) {
        if (abortRef.current || pauseRef.current) break;
        try {
          const searchRes = await apiFetch("/api/pipeline/serper-news-raw", {
            method: "POST",
            body: JSON.stringify({ query, start_date: roundStart, end_date: roundEnd, max_results: 3 }),
          });
          for (const art of (searchRes?.results ?? [])) {
            await injectNewsArticle(art.title || art.snippet || "", art.snippet || art.title || "", sourceName, wsId);
            roundNewsCount++;
          }
        } catch (e: any) { console.warn(`Crawl ${sourceName} failed:`, e); }
      }
    } catch (e: any) { console.warn("Crawl round failed:", e); }
    const newTotal = cumNewsCount + roundNewsCount;
    setNewsCount(newTotal);

    if (abortRef.current || pauseRef.current) {
      // Save paused state so page-reload recovery can show the Resume button
      if (pauseRef.current && !abortRef.current) {
        saveProgress({ status: "paused", currentRound: roundNum, totalRounds: rounds, newsCount: newTotal, activeJobId: null, simDate: roundStart, startDate, endDate, simDays, crawlInterval, concurrency });
      }
      return { newsCount: newTotal, jobId: null };
    }

    // Phase 2: Evolve
    setPhase("evolving");
    setPhaseLabel(en ? `Evolving agents (round ${roundNum}/${rounds})...` : `演化中（第 ${roundNum}/${rounds} 輪）...`);
    // Read latest template data via refs (avoids stale-closure when user
    // clicks Start before template finished loading).
    const _cands = candidatesRef.current || [];
    const _elec = electionRef.current || {};
    const candidateNames = _cands.map((c: any) => c.name).filter(Boolean);
    const candDescs: Record<string, string> = {};
    for (const c of _cands) {
      if (c.name && c.description) candDescs[c.name] = c.description;
    }
    const partyDetection = _elec?.party_detection ?? undefined;
    // Fetch all configured agent vendors (non-system) so newly-added vendors are included
    let enabledVendors: string[] | undefined;
    try {
      const settingsRes = await apiFetch("/api/settings");
      const allVendors: any[] = settingsRes?.llm_vendors || [];
      const agentVendorIds = allVendors
        .filter((v: any) => v.role !== "system" && v.id)
        .map((v: any) => v.id as string);
      if (agentVendorIds.length) enabledVendors = agentVendorIds;
    } catch { /* ignore — backend will auto-derive from agents */ }
    const res = await startEvolution(personas, crawlInterval, concurrency, candidateNames, advParams as Record<string, unknown>, candDescs, partyDetection, wsId, enabledVendors);
    const jobId = res?.job_id || null;
    activeJobIdRef.current = jobId;

    // Save progress so it survives page close
    saveProgress({ status: "evolving", currentRound: roundNum, totalRounds: rounds, newsCount: newTotal, activeJobId: jobId, simDate: roundStart, startDate, endDate, simDays, crawlInterval, concurrency });

    if (jobId) {
      let done = false;
      while (!done && !abortRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (pauseRef.current) {
          saveProgress({ status: "paused", currentRound: roundNum, totalRounds: rounds, newsCount: newTotal, activeJobId: jobId, simDate: roundStart, startDate, endDate, simDays, crawlInterval, concurrency });
          return { newsCount: newTotal, jobId };
        }
        try {
          const st = await getEvolutionStatus(jobId);
          if (st.status === "done" || st.status === "completed") done = true;
          else if (st.status === "stopped") throw new Error("Evolution job was stopped unexpectedly");
          else if (st.status === "failed" || st.status === "error") throw new Error(st.error || "Evolution failed");
        } catch (e: any) { if (e.message?.includes("stopped") || e.message?.includes("failed")) throw e; }
      }
    }
    return { newsCount: newTotal, jobId };
  }, [personas, crawlInterval, concurrency, startDate, endDate, simDays, buildQueries, en, saveProgress]);

  // Main evolution loop
  const handleStart = useCallback(async (resumeFromRound = 0, resumeNewsCount = 0) => {
    if (running) return;
    // Skip persona check on resume — personas existed when the run started.
    // On fresh start (resumeFromRound === 0), enforce the check.
    if (resumeFromRound === 0 && !personas.length) {
      setError(en ? "No personas found. Generate personas first." : "找不到 Persona，請先生成。");
      return;
    }
    if (tplLoading) {
      setError(en ? "Template is still loading — please wait a moment." : "模板尚未載入完成，請稍候再試。");
      return;
    }
    if (!template) {
      setError(en ? "No active template. Go to Population Setup to select one." : "尚未選定模板，請至 Population Setup 挑選模板。");
      return;
    }
    setRunning(true);
    setPaused(false);
    setError("");
    abortRef.current = false;
    pauseRef.current = false;

    const rounds = Math.ceil(simDays / crawlInterval);  // effective simDays snap handled in derived section
    setTotalRounds(rounds);
    const windowDays = daysBetween(startDate, endDate);
    const daysPerRound = Math.max(1, Math.floor(windowDays / rounds));

    // Show "starting" state immediately so the UI is responsive before async ops
    setPhase("crawling");
    setPhaseLabel(en ? "Preparing..." : "準備中...");

    // Fresh start: stop ALL running backend jobs, then reset all state
    // Resume: skip reset — continue from where we left off
    if (resumeFromRound === 0) {
      // Stop all running/pending jobs to avoid race conditions
      try {
        const jobsRes = await apiFetch("/api/pipeline/evolution/evolve/jobs");
        const runningJobs = (jobsRes?.jobs || []).filter((j: any) => j.status === "running" || j.status === "pending");
        for (const rj of runningJobs) {
          try { await apiFetch(`/api/pipeline/evolution/evolve/stop/${rj.job_id}`, { method: "POST" }); } catch {}
        }
        if (runningJobs.length > 0) {
          // Wait for jobs to fully stop and flush any pending state writes
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch {}
      activeJobIdRef.current = null;
      // Now reset — all jobs stopped, safe to clear states
      try { await apiFetch(`/api/pipeline/evolution/evolve/reset?workspace_id=${encodeURIComponent(wsId)}`, { method: "POST" }); } catch {}
      try { await apiFetch(`/api/pipeline/evolution/news-pool/clear?workspace_id=${encodeURIComponent(wsId)}`, { method: "POST" }); } catch {}
      // Write reset timestamp so Dashboard discards stale AI analysis cache on next mount
      try {
        sessionStorage.setItem(`evo_reset_${wsId}`, String(Date.now()));
        sessionStorage.removeItem(`evo_analysis_${wsId}`);
      } catch {}
    }

    let nc = resumeNewsCount;
    const startRound = resumeFromRound > 0 ? resumeFromRound : 1;

    for (let r = startRound; r <= rounds; r++) {
      if (abortRef.current) break;
      setCurrentRound(r);
      try {
        const result = await runOneRound(r, rounds, windowDays, daysPerRound, nc);
        nc = result.newsCount;
        if (pauseRef.current) {
          setPhase("paused");
          setPhaseLabel(en ? `Paused after round ${r}/${rounds}` : `第 ${r}/${rounds} 輪後暫停`);
          setRunning(false);
          return;
        }
      } catch (e: any) {
        setError(e.message || "Evolution failed");
        setPhase("error");
        setRunning(false);
        saveProgress({ status: "error", currentRound: r, totalRounds: rounds, newsCount: nc });
        return;
      }
    }

    if (!abortRef.current) {
      setPhase("done");
      setPhaseLabel(en ? "Evolution complete!" : "演化完成！");
      // Mark evolution as fully done (not idle) so sidebar shows ✓
      saveUiSettings(wsId, "evolution-progress", { status: "done" }).catch(() => {});
      // Auto-create a snapshot so Prediction can run without an extra click.
      // Only on a clean full-completion path (no abort / no error earlier in loop).
      try {
        const tplName = (template as any)?.name || (en ? "Evolution" : "演化結果");
        const snapName = `${tplName} — ${en ? "auto" : "自動"} ${new Date().toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
        const _effDays = Math.ceil(simDays / crawlInterval) * crawlInterval;
        const snapDesc = en
          ? `Auto-created on evolution completion. ${_effDays} simulated days, ${personas.length} agents.`
          : `演化完成時自動建立。模擬 ${_effDays} 天、${personas.length} 位 agents。`;
        // Embed template's election ground truth so predictor can redistribute
        // leanings without requiring a separate calibration pack.
        const baseAlign = (template as any)?.election?.default_alignment || null;
        const partyDet = (template as any)?.election?.party_detection || null;
        const alignTarget = baseAlign
          ? { ...baseAlign, ...(partyDet ? { party_detection: partyDet } : {}) }
          : (partyDet ? { party_detection: partyDet } : null);
        await saveSnapshot(snapName, snapDesc, undefined, wsId, alignTarget);
      } catch (e) {
        console.warn("auto-snapshot failed:", e);
      }
    }
    setRunning(false);
  }, [running, personas, simDays, crawlInterval, concurrency, startDate, endDate, runOneRound, en, clearProgress, tplLoading, template, isGeneric, wsId]);

  // Pause — finish current evolve job, then stop
  const handlePause = () => {
    pauseRef.current = true;
    setPaused(true);
    setPhaseLabel(en ? "Pausing after current round..." : "當前輪次完成後暫停...");
  };

  // Resume from paused state
  const handleResume = () => {
    setPaused(false);
    pauseRef.current = false;
    handleStart(currentRound + 1, newsCount);
  };

  // Stop — abort immediately and reset UI state
  const handleStop = async () => {
    abortRef.current = true;
    pauseRef.current = false;
    setPaused(false);
    setRunning(false);
    setPhase("idle");
    setCurrentRound(0);
    setTotalRounds(0);
    setNewsCount(0);
    setCurrentSimDate("");
    setPhaseLabel("");
    clearProgress();
    // Stop the backend job if one is active
    if (activeJobIdRef.current) {
      try { await apiFetch(`/api/pipeline/evolution/evolve/stop/${activeJobIdRef.current}`, { method: "POST" }); } catch {}
      activeJobIdRef.current = null;
    }
  };

  // Derived
  // simDays must be a multiple of crawlInterval — each round covers exactly
  // crawlInterval days, so a non-multiple would silently round up at the
  // `Math.ceil(simDays / crawlInterval)` step and give the user more days
  // than they typed. We snap here and surface the adjustment in the UI.
  const effectiveSimDays = Math.ceil(simDays / crawlInterval) * crawlInterval;
  const simDaysAdjusted = effectiveSimDays !== simDays;
  const rounds = effectiveSimDays / crawlInterval;
  const windowSpan = daysBetween(startDate, endDate);
  const progressPct = totalRounds > 0 ? Math.round((currentRound / totalRounds) * 100) : 0;

  const candidateColors: Record<string, string> = {
    D: "#3b82f6",  // Democrat — blue
    R: "#ef4444",  // Republican — red
    I: "#a855f7",  // Independent — purple
    L: "#f59e0b",  // Libertarian — gold
    G: "#22c55e",  // Green — green
  };

  if (tplLoading) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 32, height: 32, border: "3px solid rgba(233,69,96,0.3)", borderTopColor: "#e94560", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
        <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
      <div style={{ padding: "24px clamp(16px, 3vw, 40px)", maxWidth: Math.max(800, 200 + (effectiveCandidates.length || 2) * 160), width: "100%" }}>

        {/* Header */}
        <h2 style={{ color: "var(--text-primary)", fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
          {en ? "⚡ Evolution Quick Start" : "⚡ 快速演化"}
        </h2>
        <p style={{ color: "var(--text-tertiary)", fontSize: 13, margin: "0 0 24px" }}>
          {en
            ? "Run the full evolution pipeline with one click — news crawling and agent opinion evolution are automated."
            : "一鍵啟動完整演化流程 — 新聞抓取和 Agent 觀點演化全自動執行。"}
        </p>

        {/* ── Election Info Card ── */}
        <div style={{
          background: "var(--bg-card)", border: "1px solid var(--border-subtle)",
          borderRadius: 12, padding: 20, marginBottom: 20,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 1 }}>
              {en ? "Election" : "選舉"}
            </div>
            {template && (
              <span style={{ fontSize: 11, color: "var(--text-muted)", padding: "2px 8px", borderRadius: 4, background: "var(--bg-card)" }}>
                {(template as any)?.name || ""}
              </span>
            )}
          </div>

          {/* Candidates — editable */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 1 }}>
                {en ? "Candidates" : "候選人"}
              </span>
              {customCandidates !== null && candidates.length > 0 && (
                <button
                  onClick={() => { setCustomCandidates(null); saveUiSettings(wsId, "custom-candidates", { candidates: null }).catch(() => {}); }}
                  style={{ fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}
                >
                  {en ? "Reset to template" : "還原為模板預設"}
                </button>
              )}
            </div>

            {/* Tag list */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10, minHeight: 34 }}>
              {effectiveCandidates.map((c: any) => (
                <div key={c.name} style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "5px 10px", borderRadius: 20,
                  background: `${candidateColors[c.party] || "#6b7280"}15`,
                  border: `1px solid ${candidateColors[c.party] || "#6b7280"}40`,
                }}>
                  <span style={{ color: candidateColors[c.party] || "#6b7280", fontSize: 10, fontWeight: 700 }}>{c.party}</span>
                  <span style={{ color: "var(--text-primary)", fontSize: 13 }}>{c.name}</span>
                  {!running && (
                    <button
                      onClick={() => {
                        const base: CustomCand[] = customCandidates !== null
                          ? customCandidates
                          : candidates.map((x: any) => ({ name: x.name, party: x.party || "I" }));
                        saveCandidates(base.filter((cc) => cc.name !== c.name));
                      }}
                      style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0, marginLeft: 2 }}
                    >×</button>
                  )}
                </div>
              ))}
              {effectiveCandidates.length === 0 && (
                <span style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic", alignSelf: "center" }}>
                  {en ? "No candidates — awareness tracking disabled" : "無候選人 — 不追蹤知名度"}
                </span>
              )}
            </div>

            {/* Add input */}
            {!running && (() => {
              const addCandidate = () => {
                const name = candidateInput.trim();
                if (!name) return;
                const base: CustomCand[] = customCandidates !== null
                  ? customCandidates
                  : candidates.map((x: any) => ({ name: x.name, party: x.party || "I" }));
                if (base.some((cc) => cc.name === name)) return;
                saveCandidates([...base, { name, party: candidateParty }]);
                setCandidateInput("");
                setCandidateParty("I");
              };
              return (
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={candidateParty}
                  onChange={(e) => setCandidateParty(e.target.value)}
                  title={en ? "Party (D=Democrat, R=Republican, I=Independent, L=Libertarian, G=Green)"
                            : "政黨 (D=民主黨, R=共和黨, I=無黨籍, L=自由意志黨, G=綠黨)"}
                  style={{
                    padding: "6px 10px", borderRadius: 6,
                    border: `1px solid ${candidateColors[candidateParty] || "#6b7280"}60`,
                    background: "var(--bg-input)",
                    color: candidateColors[candidateParty] || "var(--text-primary)",
                    fontWeight: 700, fontSize: 13, outline: "none", cursor: "pointer",
                  }}
                >
                  <option value="D">D · Dem</option>
                  <option value="R">R · GOP</option>
                  <option value="I">I · Ind</option>
                  <option value="L">L · Lib</option>
                  <option value="G">G · Green</option>
                </select>
                <input
                  value={candidateInput}
                  onChange={(e) => setCandidateInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); addCandidate(); }
                  }}
                  placeholder={en ? "Add candidate…" : "新增候選人…"}
                  style={{
                    flex: 1, padding: "6px 10px", borderRadius: 6,
                    border: "1px solid var(--border-input)", background: "var(--bg-input)",
                    color: "var(--text-primary)", fontSize: 13, outline: "none",
                  }}
                />
                <button
                  onClick={addCandidate}
                  style={{
                    padding: "6px 14px", borderRadius: 6,
                    border: "1px solid var(--border-subtle)", background: "var(--bg-card)",
                    color: "var(--text-secondary)", cursor: "pointer", fontSize: 13,
                  }}
                >
                  {en ? "+ Add" : "+ 新增"}
                </button>
              </div>
              );
            })()}
          </div>

          {/* Date range */}
          <div style={{ display: "flex", gap: 24, fontSize: 13 }}>
            <div>
              <span style={{ color: "var(--text-muted)" }}>{en ? "Window: " : "期間："}</span>
              <span style={{ color: "var(--text-primary)" }}>{fmtDate(startDate, en)} → {fmtDate(endDate, en)}</span>
            </div>
            {elDate && (
              <div>
                <span style={{ color: "var(--text-muted)" }}>{en ? "Election Day: " : "選舉日："}</span>
                <span style={{ color: "#e94560" }}>{fmtDate(elDate, en)}</span>
              </div>
            )}
            <div>
              <span style={{ color: "var(--text-muted)" }}>Personas: </span>
              <span style={{ color: "#86efac" }}>{personaCount}</span>
            </div>
          </div>
        </div>

        {/* ── Settings Card ── */}
        <div style={{
          background: "var(--bg-card)", border: "1px solid var(--border-subtle)",
          borderRadius: 12, padding: 20, marginBottom: 20,
        }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
            {en ? "Settings" : "設定"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            <label style={{ color: "var(--text-secondary)", fontSize: 12 }}>
              {en ? "Simulation days" : "模擬天數"}
              <input type="number" min={1} max={365} value={simDays}
                onChange={(e) => setSimDays(Number(e.target.value) || 30)}
                disabled={running}
                style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border-input)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 14 }}
              />
              {simDaysAdjusted && (
                <div style={{ marginTop: 6, fontSize: 10, color: "#f59e0b", lineHeight: 1.5 }}>
                  {en
                    ? `Adjusted: ${simDays} → ${effectiveSimDays} days (must be a multiple of the ${crawlInterval}-day crawl interval; ${rounds} rounds × ${crawlInterval} days).`
                    : `已自動調整：${simDays} → ${effectiveSimDays} 天（需為抓取間隔 ${crawlInterval} 天的倍數；${rounds} 輪 × ${crawlInterval} 天）。`}
                </div>
              )}
            </label>
            <label style={{ color: "var(--text-secondary)", fontSize: 12 }}>
              {en ? "News crawl interval" : "新聞抓取間隔"}
              <select value={crawlInterval}
                onChange={(e) => setCrawlInterval(Number(e.target.value))}
                disabled={running}
                style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border-input)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 14 }}
              >
                {[1, 2, 3, 5, 7, 10].map((d) => (
                  <option key={d} value={d}>{d} {en ? "days" : "天"}</option>
                ))}
              </select>
            </label>
            <label style={{ color: "var(--text-secondary)", fontSize: 12 }}>
              {en ? "Concurrency" : "並行數"}
              <select value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                disabled={running}
                style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border-input)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 14 }}
              >
                {[1, 3, 5, 8, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-muted)" }}>
            {en
              ? `${rounds} rounds × ${crawlInterval} days = ${effectiveSimDays} simulated days, covering ${windowSpan} days of real time`
              : `${rounds} 輪 × ${crawlInterval} 天 = ${effectiveSimDays} 模擬天數，涵蓋 ${windowSpan} 天的真實時間`}
          </div>
        </div>

        {/* ── Start / Progress ── */}
        {/* ── Start button (idle) ── */}
        {phase === "idle" && (
          <button
            onClick={() => handleStart()}
            disabled={running || !personaCount}
            style={{
              width: "100%", padding: "14px 24px", borderRadius: 12, border: "none",
              background: personaCount ? "linear-gradient(135deg, #e94560, #c62368)" : "rgba(100,100,100,0.3)",
              color: "var(--text-primary)", fontSize: 16, fontWeight: 700, cursor: personaCount ? "pointer" : "not-allowed",
              transition: "opacity 0.2s",
            }}
          >
            {en ? "🚀 Start Evolution" : "🚀 開始演化"}
          </button>
        )}

        {/* ── Paused state ── */}
        {phase === "paused" && (
          <div style={{
            background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.2)",
            borderRadius: 12, padding: 20,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#fbbf24", marginBottom: 12 }}>
              ⏸ {phaseLabel}
            </div>
            <div style={{ display: "flex", gap: 24, fontSize: 12, color: "var(--text-tertiary)", marginBottom: 16 }}>
              <span>{en ? "Round" : "輪次"}: <strong style={{ color: "var(--text-primary)" }}>{currentRound}/{totalRounds}</strong></span>
              <span>{en ? "News crawled" : "已抓新聞"}: <strong style={{ color: "var(--text-primary)" }}>{newsCount}</strong></span>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={handleResume} style={{
                flex: 1, padding: "10px 20px", borderRadius: 8, border: "none",
                background: "linear-gradient(135deg, #e94560, #c62368)", color: "var(--text-primary)",
                fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>
                {en ? "▶ Resume" : "▶ 繼續"}
              </button>
              <button onClick={async () => { await handleStop(); handleStart(); }} style={{
                padding: "10px 20px", borderRadius: 8, fontSize: 14,
                background: "rgba(59,130,246,0.1)", color: "#60a5fa",
                border: "1px solid rgba(59,130,246,0.2)", cursor: "pointer",
              }}>
                {en ? "🔄 Restart" : "🔄 重新開始"}
              </button>
              <button onClick={handleStop} style={{
                padding: "10px 20px", borderRadius: 8, fontSize: 14,
                background: "rgba(255,107,107,0.1)", color: "#ff6b6b",
                border: "1px solid rgba(255,107,107,0.2)", cursor: "pointer",
              }}>
                {en ? "⏹ Stop" : "⏹ 停止"}
              </button>
            </div>
          </div>
        )}

        {/* ── Running state (crawling / evolving) ── */}
        {(phase === "crawling" || phase === "evolving") && (
          <div style={{
            background: "var(--bg-card)", border: "1px solid var(--border-subtle)",
            borderRadius: 12, padding: 20,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
                {paused && phase === "evolving" && (
                  <span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid #60a5fa", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                )}
                {phaseLabel}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handlePause}
                  disabled={paused}
                  style={{
                    padding: "6px 16px", borderRadius: 8, fontSize: 12,
                    background: "rgba(59,130,246,0.15)", color: "#60a5fa",
                    border: "1px solid rgba(59,130,246,0.3)", cursor: paused ? "not-allowed" : "pointer",
                    opacity: paused ? 0.6 : 1,
                    display: "flex", alignItems: "center", gap: 4,
                  }}
                >
                  {paused && phase === "evolving" && (
                    <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid #60a5fa", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                  )}
                  {paused ? (en ? "Pausing..." : "暫停中...") : (en ? "⏸ Pause" : "⏸ 暫停")}
                </button>
                <button
                  onClick={handleStop}
                  style={{
                    padding: "6px 16px", borderRadius: 8, fontSize: 12,
                    background: "rgba(255,107,107,0.1)", color: "#ff6b6b",
                    border: "1px solid rgba(255,107,107,0.2)", cursor: "pointer",
                  }}
                >
                  {en ? "⏹ Stop" : "⏹ 停止"}
                </button>
              </div>
            </div>

            {paused && phase === "evolving" && (
              <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.25)", color: "#93c5fd", fontSize: 12, marginBottom: 12, display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-cjk)" }}>
                <span style={{ fontSize: 16 }}>⏳</span>
                <span>
                  {en
                    ? `Pause requested. Evolution will complete the current round (${currentRound}/${totalRounds}) first, then save state. Safe to close the tab after "Paused after round ${currentRound}" appears.`
                    : `已請求暫停。演化會先完成當前第 ${currentRound}/${totalRounds} 輪，儲存狀態後才真正停下。看到「第 ${currentRound} 輪後暫停」後即可關閉分頁。`}
                </span>
              </div>
            )}

            {/* Progress bar */}
            <div style={{ background: "var(--bg-input)", borderRadius: 6, height: 8, marginBottom: 12, overflow: "hidden" }}>
              <div style={{
                height: "100%", borderRadius: 6,
                background: phase === "crawling" ? "#60a5fa" : "#e94560",
                width: `${progressPct}%`,
                transition: "width 0.5s ease",
              }} />
            </div>

            {/* Stats row */}
            <div style={{ display: "flex", gap: 24, fontSize: 12, color: "var(--text-tertiary)" }}>
              <span>{en ? "Round" : "輪次"}: <strong style={{ color: "var(--text-primary)" }}>{currentRound}/{totalRounds}</strong></span>
              <span>{en ? "Sim date" : "模擬日期"}: <strong style={{ color: "var(--text-primary)" }}>{currentSimDate}</strong></span>
              <span>{en ? "News crawled" : "已抓新聞"}: <strong style={{ color: "var(--text-primary)" }}>{newsCount}</strong></span>
              <span>
                {phase === "crawling" && <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid #60a5fa", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 1s linear infinite", verticalAlign: "middle", marginRight: 4 }} />}
                {phase === "evolving" && <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid #e94560", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 1s linear infinite", verticalAlign: "middle", marginRight: 4 }} />}
                {phase === "crawling" ? (en ? "Fetching" : "抓取中") : (en ? "Evolving" : "演化中")}
              </span>
            </div>
          </div>
        )}

        {phase === "done" && (
          <div style={{
            background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)",
            borderRadius: 12, padding: 20, textAlign: "center",
          }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🎉</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#86efac", marginBottom: 4 }}>
              {en ? "Evolution Complete!" : "演化完成！"}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 16 }}>
              {en
                ? `${rounds} rounds completed · ${newsCount} articles crawled · ${personaCount} agents evolved`
                : `${rounds} 輪完成 · ${newsCount} 篇新聞 · ${personaCount} 位 Agent 已演化`}
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => router.push(`/workspaces/${wsId}/evolution-dashboard`)}
                style={{
                  padding: "10px 24px", borderRadius: 8, border: "none",
                  background: "#3b82f6", color: "var(--text-primary)", fontSize: 14, fontWeight: 600, cursor: "pointer",
                }}
              >
                {en ? "📊 View Dashboard" : "📊 查看儀表板"}
              </button>
              <button
                onClick={async () => {
                  try {
                    const exportData = await apiFetch("/api/pipeline/evolution/export-playback");
                    const { generatePlaybackHTML } = await import("@/lib/export-playback");
                    const html = generatePlaybackHTML({
                      ...exportData,
                      templateName: (template as any)?.name || "",
                      locale: en ? "en" : "zh-TW",
                    });
                    const blob = new Blob([html], { type: "text/html" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `civatas-evolution-playback-${new Date().toISOString().slice(0, 10)}.html`;
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (e: any) {
                    console.error("Export failed:", e);
                  }
                }}
                style={{
                  padding: "10px 24px", borderRadius: 8,
                  background: "rgba(168,85,247,0.15)", color: "#a855f7",
                  fontSize: 14, fontWeight: 600, cursor: "pointer",
                  border: "1px solid rgba(168,85,247,0.3)",
                }}
              >
                {en ? "📥 Download Playback" : "📥 下載回放頁面"}
              </button>
              <button
                onClick={() => { setPhase("idle"); setCurrentRound(0); setNewsCount(0); }}
                style={{
                  padding: "10px 24px", borderRadius: 8,
                  background: "var(--bg-input)", color: "var(--text-secondary)",
                  border: "1px solid var(--border-input)", fontSize: 14, cursor: "pointer",
                }}
              >
                {en ? "🔄 Run Again" : "🔄 再次執行"}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div style={{
            background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
            borderRadius: 12, padding: 16, color: "#fca5a5", fontSize: 13,
          }}>
            ⚠ {error}
            <button
              onClick={() => { setPhase("idle"); setError(""); }}
              style={{
                marginLeft: 12, padding: "4px 12px", borderRadius: 6,
                background: "var(--bg-input)", color: "var(--text-tertiary)",
                border: "1px solid var(--border-input)", fontSize: 12, cursor: "pointer",
              }}
            >
              {en ? "Dismiss" : "關閉"}
            </button>
          </div>
        )}

        {/* ── Advanced Parameters ── */}
        <div style={{ marginTop: 20 }}>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{
              width: "100%", background: "none", border: "none", color: "var(--text-muted)",
              fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center",
              justifyContent: "center", gap: 6, padding: "8px 0",
            }}
          >
            <span style={{ transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.2s", display: "inline-block" }}>▶</span>
            {en ? "Advanced Parameters" : "進階參數"}
          </button>

          {showAdvanced && (
            <div style={{
              background: "var(--bg-card)", border: "1px solid var(--border-subtle)",
              borderRadius: 12, padding: 20, marginTop: 8,
            }}>
              {/* ── Section 1: Political Leaning Shifts ── */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 14 }}>🔄</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                    {en ? "Political Leaning Shifts" : "政治傾向轉變"}
                  </span>
                </div>
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 12px", lineHeight: 1.5 }}>
                  {en
                    ? "Control when agents shift their political leaning based on satisfaction and anxiety thresholds."
                    : "控制 Agent 在滿意度和焦慮度達到閾值時如何改變政治傾向。"}
                </p>

                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={advParams.enable_dynamic_leaning}
                      onChange={(e) => setAdvParams({ ...advParams, enable_dynamic_leaning: e.target.checked })}
                      disabled={running}
                    />
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {en ? "Enable dynamic leaning shifts" : "啟用動態傾向轉變"}
                    </span>
                  </label>
                </div>

                {advParams.enable_dynamic_leaning && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    <AdvSlider label={en ? "Low satisfaction threshold" : "低滿意度閾值"}
                      hint={en ? "Below this → partisan shifts to neutral" : "低於此值 → 偏向轉中立"}
                      value={advParams.shift_sat_threshold_low} min={5} max={45} step={1}
                      onChange={(v) => setAdvParams({ ...advParams, shift_sat_threshold_low: v })}
                      disabled={running} />
                    <AdvSlider label={en ? "High anxiety threshold" : "高焦慮度閾值"}
                      hint={en ? "Above this + low satisfaction → shift to neutral" : "高於此值 + 低滿意度 → 轉中立"}
                      value={advParams.shift_anx_threshold_high} min={55} max={95} step={1}
                      onChange={(v) => setAdvParams({ ...advParams, shift_anx_threshold_high: v })}
                      disabled={running} />
                    <AdvSlider label={en ? "Consecutive days required" : "連續天數需求"}
                      hint={en ? "Days at threshold before shift triggers" : "達到閾值需連續幾天才會觸發"}
                      value={advParams.shift_consecutive_days_req} min={1} max={14} step={1}
                      onChange={(v) => setAdvParams({ ...advParams, shift_consecutive_days_req: v })}
                      disabled={running} />
                  </div>
                )}

                {advParams.enable_dynamic_leaning && (
                  <div style={{
                    marginTop: 12, padding: "10px 14px", borderRadius: 8,
                    background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.12)",
                    fontSize: 11, color: "rgba(255,255,255,0.45)", lineHeight: 1.6,
                  }}>
                    <div style={{ fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
                      {en ? "Shift rules:" : "轉變規則："}
                    </div>
                    {en ? (
                      <>
                        <div>• Conservative/Republican-leaning → Neutral: local satisfaction ≤ {advParams.shift_sat_threshold_low} for {advParams.shift_consecutive_days_req} days</div>
                        <div>• Liberal/Democrat-leaning → Neutral: national satisfaction ≤ {advParams.shift_sat_threshold_low} for {advParams.shift_consecutive_days_req} days</div>
                        <div>• Either partisan → Neutral: anxiety ≥ {advParams.shift_anx_threshold_high} + satisfaction &lt; 50</div>
                        <div>• Neutral → Right-leaning: local satisfaction ≥ {100 - advParams.shift_sat_threshold_low} + national &lt; 50</div>
                        <div>• Neutral → Left-leaning: national satisfaction ≥ {100 - advParams.shift_sat_threshold_low} + local &lt; 50</div>
                      </>
                    ) : (
                      <>
                        <div>• 保守/偏右 → 中立：在地滿意度 ≤ {advParams.shift_sat_threshold_low}，連續 {advParams.shift_consecutive_days_req} 天</div>
                        <div>• 自由/偏左 → 中立：全國滿意度 ≤ {advParams.shift_sat_threshold_low}，連續 {advParams.shift_consecutive_days_req} 天</div>
                        <div>• 任一偏向 → 中立：焦慮度 ≥ {advParams.shift_anx_threshold_high} + 滿意度 &lt; 50</div>
                        <div>• 中立 → 偏右：在地滿意度 ≥ {100 - advParams.shift_sat_threshold_low} + 全國 &lt; 50</div>
                        <div>• 中立 → 偏左：全國滿意度 ≥ {100 - advParams.shift_sat_threshold_low} + 在地 &lt; 50</div>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", margin: "0 0 20px" }} />

              {/* ── Section 2: News Impact & Echo Chamber ── */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 14 }}>📰</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                    {en ? "News Impact & Echo Chamber" : "新聞影響 & 同溫層"}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <AdvSlider label={en ? "News impact multiplier" : "新聞影響倍率"}
                    hint={en ? "How strongly news affects satisfaction/anxiety" : "新聞對滿意度/焦慮度的影響強度"}
                    value={advParams.news_impact} min={0.5} max={5.0} step={0.1} decimals={1}
                    onChange={(v) => setAdvParams({ ...advParams, news_impact: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "Serendipity rate" : "跨同溫層機率"}
                    hint={en ? "Chance of seeing opposing viewpoint articles" : "Agent 看到對立觀點文章的機率"}
                    value={advParams.serendipity_rate} min={0} max={0.5} step={0.01} decimals={2} pct
                    onChange={(v) => setAdvParams({ ...advParams, serendipity_rate: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "Articles per agent per day" : "每位 Agent 每日文章數"}
                    hint={en ? "Max news articles shown to each agent daily" : "每天給每位 Agent 看的最大新聞數"}
                    value={advParams.articles_per_agent} min={1} max={10} step={1}
                    onChange={(v) => setAdvParams({ ...advParams, articles_per_agent: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "Memory forget rate" : "記憶遺忘率"}
                    hint={en ? "How fast agents forget old news" : "Agent 遺忘舊新聞的速度"}
                    value={advParams.forget_rate} min={0.01} max={0.5} step={0.01} decimals={2}
                    onChange={(v) => setAdvParams({ ...advParams, forget_rate: v })}
                    disabled={running} />
                </div>
              </div>

              <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", margin: "0 0 20px" }} />

              {/* ── Section 3: Emotional Response ── */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 14 }}>💭</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                    {en ? "Emotional Response" : "情緒反應"}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <AdvSlider label={en ? "Max daily change" : "每日最大變化"}
                    hint={en ? "Multiplier on max daily satisfaction/anxiety change" : "每日滿意度/焦慮度最大變化倍率"}
                    value={advParams.delta_cap_mult} min={0.5} max={3.0} step={0.1} decimals={1}
                    onChange={(v) => setAdvParams({ ...advParams, delta_cap_mult: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "Satisfaction decay" : "滿意度衰減率"}
                    hint={en ? "Daily pull toward neutral (50)" : "每天向中性值 (50) 回歸的速度"}
                    value={advParams.satisfaction_decay} min={0} max={0.1} step={0.005} decimals={3}
                    onChange={(v) => setAdvParams({ ...advParams, satisfaction_decay: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "Anxiety decay" : "焦慮度衰減率"}
                    hint={en ? "Daily pull toward neutral (50)" : "每天向中性值 (50) 回歸的速度"}
                    value={advParams.anxiety_decay} min={0} max={0.15} step={0.005} decimals={3}
                    onChange={(v) => setAdvParams({ ...advParams, anxiety_decay: v })}
                    disabled={running} />
                </div>
              </div>

              <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", margin: "0 0 20px" }} />

              {/* ── Section 4: Undecided & Party Effects ── */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 14 }}>🗳️</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                    {en ? "Undecided Voters & Party Effects" : "未決定選民 & 政黨效應"}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <AdvSlider label={en ? "Base undecided ratio" : "基礎未決定比例"}
                    hint={en ? "Starting proportion of undecided agents" : "未決定 Agent 的起始比例"}
                    value={advParams.base_undecided} min={0} max={0.3} step={0.01} decimals={2} pct
                    onChange={(v) => setAdvParams({ ...advParams, base_undecided: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "Max undecided ratio" : "最大未決定比例"}
                    hint={en ? "Ceiling for undecided voters" : "未決定選民的上限"}
                    value={advParams.max_undecided} min={0.1} max={0.7} step={0.01} decimals={2} pct
                    onChange={(v) => setAdvParams({ ...advParams, max_undecided: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "Party alignment bonus" : "政黨一致加分"}
                    hint={en ? "Score bonus for same-party candidate" : "候選人與 Agent 同黨時的加分"}
                    value={advParams.party_align_bonus} min={0} max={30} step={1}
                    onChange={(v) => setAdvParams({ ...advParams, party_align_bonus: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "Incumbency bonus" : "現任者加分"}
                    hint={en ? "Score bonus for incumbent candidates" : "現任候選人的加分"}
                    value={advParams.incumbency_bonus} min={0} max={25} step={1}
                    onChange={(v) => setAdvParams({ ...advParams, incumbency_bonus: v })}
                    disabled={running} />
                </div>
              </div>

              <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", margin: "0 0 20px" }} />

              {/* ── Section 5: Life Events ── */}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 14 }}>🎲</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                    {en ? "Life Events" : "生活事件"}
                  </span>
                </div>
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 12px", lineHeight: 1.5 }}>
                  {en
                    ? "Random life events (layoffs, promotions, medical bills, etc.) that directly impact agent satisfaction and anxiety."
                    : "隨機生活事件（裁員、升職、醫療帳單等）直接影響 Agent 的滿意度和焦慮度。"}
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <AdvSlider label={en ? "Individuality multiplier" : "個體差異倍率"}
                    hint={en ? "Global scale for per-agent personality effects" : "Agent 個人特質效果的全域倍率"}
                    value={advParams.individuality_multiplier} min={0} max={3.0} step={0.1} decimals={1}
                    onChange={(v) => setAdvParams({ ...advParams, individuality_multiplier: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "Neutral reassign ratio" : "中立重新分配比例"}
                    hint={en ? "Fraction of partisans reassigned to neutral at start" : "開始時將部分黨派 Agent 重新分配為中立"}
                    value={advParams.neutral_ratio} min={0} max={0.4} step={0.01} decimals={2} pct
                    onChange={(v) => setAdvParams({ ...advParams, neutral_ratio: v })}
                    disabled={running} />
                </div>
              </div>

              <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", margin: "0 0 20px" }} />

              {/* ── Section 6: News Category Mix ── */}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 14 }}>📰</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                    {en ? "News Category Mix" : "新聞類別比例"}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto" }}>
                    {en ? `Total: ${advParams.news_mix_candidate + advParams.news_mix_national + advParams.news_mix_local + advParams.news_mix_international}%` : `合計: ${advParams.news_mix_candidate + advParams.news_mix_national + advParams.news_mix_local + advParams.news_mix_international}%`}
                    {(advParams.news_mix_candidate + advParams.news_mix_national + advParams.news_mix_local + advParams.news_mix_international) !== 100 && (
                      <span style={{ color: "#ef4444", marginLeft: 4 }}>({en ? "should be 100%" : "應為 100%"})</span>
                    )}
                  </span>
                </div>
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 12px", lineHeight: 1.5 }}>
                  {en
                    ? "Control the proportion of each news category in the crawled news mix."
                    : "控制抓取新聞中各類別的比例。"}
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <AdvSlider label={en ? "Candidate news" : "候選人新聞"}
                    hint={en ? "News about specific candidates and campaigns" : "特定候選人和選戰新聞"}
                    value={advParams.news_mix_candidate} min={0} max={60} step={5}
                    onChange={(v) => setAdvParams({ ...advParams, news_mix_candidate: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "National / Election" : "全國/選舉"}
                    hint={en ? "Federal policy, Congress, Supreme Court, economy" : "聯邦政策、國會、最高法院、經濟"}
                    value={advParams.news_mix_national} min={0} max={60} step={5}
                    onChange={(v) => setAdvParams({ ...advParams, news_mix_national: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "Local news" : "地方新聞"}
                    hint={en ? "State/county governance, local elections, community" : "州/郡治理、地方選舉、社區"}
                    value={advParams.news_mix_local} min={0} max={60} step={5}
                    onChange={(v) => setAdvParams({ ...advParams, news_mix_local: v })}
                    disabled={running} />
                  <AdvSlider label={en ? "International" : "國際"}
                    hint={en ? "Foreign affairs, trade, global events" : "外交、貿易、全球事件"}
                    value={advParams.news_mix_international} min={0} max={60} step={5}
                    onChange={(v) => setAdvParams({ ...advParams, news_mix_international: v })}
                    disabled={running} />
                </div>
              </div>

              {/* ── Reset to defaults ── */}
              <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    onClick={() => setAdvParams({ ...templateCalib })}
                    disabled={running}
                    style={{
                      background: "none", border: "1px solid var(--border-subtle)",
                      color: "var(--text-muted)", fontSize: 11, padding: "4px 12px",
                      borderRadius: 6, cursor: "pointer",
                    }}
                  >
                    {en ? "Reset to template defaults" : "恢復模板預設值"}
                  </button>
                  {JSON.stringify(advParams) !== JSON.stringify(templateCalib) && (
                    <span style={{ fontSize: 10, color: "#fbbf24" }}>
                      {en ? "● Modified" : "● 已修改"}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => router.push(`/workspaces/${wsId}/evolution`)}
                  style={{
                    background: "none", border: "none", color: "var(--text-muted)",
                    fontSize: 11, cursor: "pointer", textDecoration: "underline",
                  }}
                >
                  {en ? "News Sources & Memory Explorer →" : "新聞來源 & 記憶探索 →"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ── Slider sub-component ── */

function AdvSlider({ label, hint, value, min, max, step, onChange, disabled, decimals = 0, pct = false }: {
  label: string; hint: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; disabled?: boolean; decimals?: number; pct?: boolean;
}) {
  const display = pct ? `${(value * 100).toFixed(0)}%` : value.toFixed(decimals);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{label}</span>
        <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        style={{ width: "100%", accentColor: "#e94560" }}
      />
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>{hint}</div>
    </div>
  );
}
