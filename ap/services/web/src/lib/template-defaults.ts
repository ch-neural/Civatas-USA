/**
 * Helpers for reading defaults from the workspace's active template.
 *
 * Each function takes the (possibly-null) active template and returns either
 * the template-provided default or a generic English fallback. The application
 * is US-only — the original Taiwan seed defaults were removed in the Stage 1.9
 * cleanup. Templates declare their own defaults in `data/templates/*.json`
 * under the `election` block.
 *
 * Usage from a panel:
 *
 *   const { template } = useActiveTemplate(wsId);
 *   const macro = getDefaultMacroContext(template, locale);
 *   const params = getDefaultCalibParams(template);
 *   const partyColor = makePartyColorResolver(template);
 */

// ── Generic US fallback defaults (used when no template is active) ──

const US_DEFAULT_MACRO_EN =
  "[US Political & Economic Context]\n" +
  "The federal government is headed by the sitting President; control of " +
  "Congress is split between the two major parties. Voters typically " +
  "attribute national-scope issues (inflation, energy prices, foreign " +
  "policy) to the federal ruling party, and state/local-scope issues " +
  "(public safety, schools, transit, county services) to the Governor and " +
  "local government.";

const US_DEFAULT_LOCAL_KW =
  "Pennsylvania governor budget\n" +
  "Pennsylvania state legislature bill\n" +
  "Pennsylvania transit infrastructure\n" +
  "Pennsylvania jobs unemployment economy\n" +
  "Pennsylvania schools education funding\n" +
  "Pennsylvania crime police safety\n" +
  "Pennsylvania healthcare hospital\n" +
  "Pennsylvania election candidate poll";

const US_DEFAULT_NATIONAL_KW =
  "United States President White House Cabinet\n" +
  "United States Congress Senate House bill\n" +
  "United States economy inflation Federal Reserve\n" +
  "United States jobs report wages labor\n" +
  "United States election Democrats Republicans poll\n" +
  "United States foreign policy China Ukraine\n" +
  "United States immigration border\n" +
  "United States healthcare Medicare student loans";

const US_DEFAULT_ELECTION_TYPE = "Presidential Election";

const US_DEFAULT_SANDBOX_QUERY = "US presidential election polling economy";

const US_DEFAULT_CALIB_PARAMS = {
  news_impact: 2.0,
  delta_cap_mult: 1.5,
  decay_rate_mult: 0.5,
  forget_rate: 0.15,
  recognition_penalty: 0.15,
  base_undecided: 0.10,
  max_undecided: 0.45,
  party_align_bonus: 15,
  incumbency_bonus: 12,
};

// ── Helpers ──

export type ActiveTemplate = any | null;

/** Default macro context — template-aware. */
export function getDefaultMacroContext(template: ActiveTemplate, locale: string = "en"): string {
  const fromTemplate = template?.election?.default_macro_context;
  if (fromTemplate) {
    return fromTemplate[locale] || fromTemplate["en"] || US_DEFAULT_MACRO_EN;
  }
  return US_DEFAULT_MACRO_EN;
}

/** Default local search keywords. */
export function getDefaultLocalKeywords(template: ActiveTemplate): string {
  return template?.election?.default_search_keywords?.local || US_DEFAULT_LOCAL_KW;
}

/** Default national search keywords. */
export function getDefaultNationalKeywords(template: ActiveTemplate): string {
  return template?.election?.default_search_keywords?.national || US_DEFAULT_NATIONAL_KW;
}

/** Default sandbox auto-fetch query (single-line, fewer keywords). */
export function getDefaultSandboxQuery(_template: ActiveTemplate): string {
  return US_DEFAULT_SANDBOX_QUERY;
}

/** Default election type label (used in CalibrationPanel state default). */
export function getDefaultElectionType(template: ActiveTemplate): string {
  const t = template?.election?.type;
  if (!t) return US_DEFAULT_ELECTION_TYPE;
  if (t === "presidential") return "Presidential Election";
  if (t === "senate") return "Senate Election";
  if (t === "gubernatorial") return "Gubernatorial Election";
  if (t === "house") return "House Election";
  if (t === "mayoral") return "Mayoral Election";
  return t;
}

/** Default calibration params (template values merged with US defaults). */
export function getDefaultCalibParams(template: ActiveTemplate): typeof US_DEFAULT_CALIB_PARAMS {
  const overrides = template?.election?.default_calibration_params;
  if (!overrides) return { ...US_DEFAULT_CALIB_PARAMS };
  return { ...US_DEFAULT_CALIB_PARAMS, ...overrides };
}

/**
 * Default Vote Weighting (sampling_modality) per template.
 * Real-world turnout in US elections consistently favors older voters,
 * so "mixed_73" (Likely Voter) matches actual outcomes best for forecasting.
 *
 *  - presidential / senate / gubernatorial / house / mayoral → "mixed_73"
 *  - If template explicitly sets `election.default_sampling_modality`, use it.
 *  - Fallback → "mixed_73" (best for any US general election).
 *  - If no election block → "unweighted" (raw popular vote).
 */
export function getDefaultSamplingModality(template: ActiveTemplate): "unweighted" | "mixed_73" | "landline_only" {
  const override = (template as any)?.election?.default_sampling_modality;
  if (override === "unweighted" || override === "mixed_73" || override === "landline_only") {
    return override;
  }
  const electionType = template?.election?.type;
  if (!electionType) return "unweighted";
  if (["presidential", "senate", "gubernatorial", "house", "mayoral"].includes(electionType)) {
    return "mixed_73";
  }
  return "mixed_73";
}

/** Default KOL settings. */
export function getDefaultKolSettings(template: ActiveTemplate): { enabled: boolean; ratio: number; reach: number } {
  return template?.election?.default_kol || { enabled: false, ratio: 0.05, reach: 0.40 };
}

/** Default poll groups (used in PredictionPanel scenario tab). */
export function getDefaultPollGroups(template: ActiveTemplate): Array<{ id: string; name: string; weight: number }> {
  return template?.election?.default_poll_groups || [
    { id: "default", name: "Likely Voters", weight: 100 },
  ];
}

/** Default party base scores (keyed by party id, e.g. "D"/"R"/"I"). */
export function getDefaultPartyBaseScores(template: ActiveTemplate): Record<string, number> {
  return template?.election?.party_base_scores || {};
}

/**
 * Stage 1.8.2: candidates declared inside the template's election block.
 * Returns the raw candidate objects (id, name, party, party_label,
 * is_incumbent, color, description). Empty array if the template has none.
 */
export type TemplateCandidate = {
  id: string;
  name: string;
  party?: string;
  party_label?: string;
  is_incumbent?: boolean;
  color?: string;
  description?: string;
};
export function getDefaultCandidates(template: ActiveTemplate): TemplateCandidate[] {
  const cands = template?.election?.candidates;
  if (!Array.isArray(cands)) return [];
  return cands as TemplateCandidate[];
}

/**
 * Per-candidate base scores resolved from the template. Maps each candidate's
 * name to the party_base_score for their party id (D/R/I/...). Returns {}
 * when the template has no candidates or no party_base_scores.
 */
export function getDefaultCandidateBaseScores(template: ActiveTemplate): Record<string, number> {
  const cands = getDefaultCandidates(template);
  const partyScores = getDefaultPartyBaseScores(template);
  const out: Record<string, number> = {};
  for (const c of cands) {
    if (!c.name) continue;
    const score = c.party && partyScores[c.party] != null ? partyScores[c.party] : undefined;
    if (score != null) out[c.name] = score;
  }
  return out;
}

/**
 * Default prediction question — used when the user hasn't typed one and a
 * template is active. Falls back to a generic election prompt.
 */
export function getDefaultPredictionQuestion(template: ActiveTemplate): string {
  if (!template?.election) return "";
  const e = template.election;
  // Cycle-specific (e.g. 2024 Presidential)
  if (e.cycle && e.type === "presidential") {
    return `${e.cycle} US Presidential Election`;
  }
  if (e.type === "presidential") return "US Presidential Election";
  if (e.type === "senate") return "US Senate Election";
  if (e.type === "gubernatorial") return "Gubernatorial Election";
  if (e.type === "house") return "US House Election";
  if (e.type === "mayoral") return "Mayoral Election";
  return "";
}

/** Stage 1.8: Default Evolution-panel params (sim_days, search_interval, etc.) */
export interface EvolutionParams {
  sim_days: number;
  search_interval: number;
  use_dynamic_search: boolean;
  neutral_ratio: number;
  delta_cap_mult: number;
  individuality_mult: number;
  concurrency: number;
}
const TW_DEFAULT_EVOLUTION_PARAMS: EvolutionParams = {
  sim_days: 60,
  search_interval: 3,
  use_dynamic_search: true,
  neutral_ratio: 0.15,
  delta_cap_mult: 1.5,
  individuality_mult: 1.0,
  concurrency: 5,
};
export function getDefaultEvolutionParams(template: ActiveTemplate): EvolutionParams {
  const overrides = template?.election?.default_evolution_params;
  if (!overrides) return { ...TW_DEFAULT_EVOLUTION_PARAMS };
  return { ...TW_DEFAULT_EVOLUTION_PARAMS, ...overrides };
}

/** Stage 1.8: Default evolution time window (cycle templates only). Returns
 *  null if the template doesn't specify one — caller should use its own fallback. */
export function getDefaultEvolutionWindow(template: ActiveTemplate): { start_date: string; end_date: string } | null {
  const win = template?.election?.default_evolution_window;
  if (!win || !win.start_date || !win.end_date) return null;
  return { start_date: win.start_date, end_date: win.end_date };
}

/** Stage 1.8: Default alignment-target settings. */
export function getDefaultAlignment(template: ActiveTemplate): { mode: "none" | "election" | "satisfaction" } {
  const m = template?.election?.default_alignment?.mode;
  if (m === "election" || m === "satisfaction" || m === "none") return { mode: m };
  return { mode: "none" };
}

// ── Party color resolver ──

// US default party detection patterns — used as fallback when no template
// is active or the active template has no election block.
const US_PARTY_DETECTION: Record<string, string[]> = {
  D: ["democrat", "democratic", "(d)", "(d-", "—d ", "- d", "harris", "biden", "obama", "clinton"],
  R: ["republican", "(r)", "(r-", "—r ", "- r", "trump", "vance", "desantis", "haley"],
  I: ["independent", "(i)", "(i-", "no party"],
};
const US_PARTY_PALETTE: Record<string, string[]> = {
  D: ["#3b82f6", "#3b82f6"],   // blue
  R: ["#ef4444", "#ef4444"],   // red
  I: ["#a855f7", "#a855f7"],   // purple
};

/**
 * Build a `partyColor(name: string) => string` function that uses the
 * template's party_palette + party_detection rules first, falling back to
 * generic US D/R/I detection.
 */
export function makePartyColorResolver(template: ActiveTemplate): (s: string) => string {
  const detection = (template?.election?.party_detection as Record<string, string[]> | undefined) || US_PARTY_DETECTION;
  const palette   = (template?.election?.party_palette   as Record<string, string[]> | undefined) || US_PARTY_PALETTE;

  return function partyColor(s: string): string {
    if (!s) return "#888";
    const text = s.toLowerCase();
    for (const [partyId, patterns] of Object.entries(detection)) {
      for (const pat of patterns) {
        if (text.includes(pat.toLowerCase())) {
          const colors = palette[partyId];
          if (colors && colors.length > 0) return colors[1] || colors[0];
        }
      }
    }
    return "#94a3b8"; // neutral slate
  };
}

/**
 * Build a `partyId(name, desc) => "D" | "R" | "I" | null` function for
 * PredictionPanel's PARTY_PALETTES lookups. Uses the template detection
 * first; falls back to generic US D/R/I patterns.
 */
export function makePartyIdResolver(template: ActiveTemplate): (name: string, description?: string) => string | null {
  const detection = (template?.election?.party_detection as Record<string, string[]> | undefined) || US_PARTY_DETECTION;

  return function detectPartyId(name: string, description: string = ""): string | null {
    const text = `${name} ${description}`.toLowerCase();
    for (const [partyId, patterns] of Object.entries(detection)) {
      for (const pat of patterns) {
        if (text.includes(pat.toLowerCase())) return partyId;
      }
    }
    return null;
  };
}
