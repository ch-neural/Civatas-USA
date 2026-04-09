"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import USMap from "@/components/USMap";
import { useTr } from "@/lib/i18n";
import {
  apiFetch,
  listCensusCounties,
  applyCensusToWorkspace,
  applyTemplateToWorkspace,
  listElectionDb,
  applyElectionLeaningProfile,
  synthesizeInWorkspace,
  generateWorkspacePersonas,
  getPersonaProgress,
  getWorkspacePersonas,
  saveUiSettings,
  getUiSettings,
  listTemplates,
} from "@/lib/api";
import { setActiveTemplateId, getActiveTemplateId } from "@/hooks/use-active-template";
import type { TemplateMeta } from "@/lib/api";
import { useLocaleStore } from "@/store/locale-store";
import { GuideBanner } from "@/components/shared/GuideBanner";

const DIM_OPTIONS = [
  { key: "age", label: "Age", icon: "📊", desc: "Age distribution" },
  { key: "gender", label: "Gender", icon: "👫", desc: "Male / female ratio" },
  { key: "education", label: "Education", icon: "🎓", desc: "Less than HS through bachelor+" },
  { key: "marital_status", label: "Marital status", icon: "💍", desc: "Single / married / divorced" },
  { key: "occupation", label: "Occupation", icon: "💼", desc: "Industry distribution" },
];

const LEAN_TYPE_LABELS: Record<string, string> = {
  president: "Presidential", mayor: "Mayoral", county_head: "Gubernatorial",
};

export default function PopulationSetupPanel({ wsId }: { wsId: string }) {
  // ── UI Locale — user-toggleable, drives text labels only ──
  const t = useTr();

  // ── Data ──
  const [counties, setCounties] = useState<any[]>([]);
  const [selCounty, setSelCounty] = useState("");
  const [districtList, setDistrictList] = useState<string[]>([]);
  const [selDistricts, setSelDistricts] = useState<Set<string>>(new Set());
  const [selDims, setSelDims] = useState<Set<string>>(new Set(["age", "gender", "education", "marital_status", "occupation"]));
  const [loadingDistricts, setLoadingDistricts] = useState(false);

  // ── Political spectrum ──
  const [elections, setElections] = useState<any[]>([]);
  const [leanCounty, setLeanCounty] = useState("");          // independent spectrum county
  const [leanCounties, setLeanCounties] = useState<string[]>([]);
  const [leanType, setLeanType] = useState("president");
  const [leanYear, setLeanYear] = useState<number>(0);
  const [leanYears, setLeanYears] = useState<number[]>([]);

  // ── Survey Method ──
  const [surveyMethod, setSurveyMethod] = useState<"phone" | "mobile" | "online" | "street">("mobile");

  // Restore surveyMethod from workspace settings
  useEffect(() => {
    getUiSettings(wsId, "population-setup").then((s: any) => {
      if (s?.surveyMethod) setSurveyMethod(s.surveyMethod);
    }).catch(() => {});
  }, [wsId]);

  // Persist surveyMethod when changed
  useEffect(() => {
    saveUiSettings(wsId, "population-setup", { surveyMethod }).catch(() => {});
  }, [wsId, surveyMethod]);

  // ── Generation ──
  const [targetCount, setTargetCount] = useState(100);
  const [ageMin, setAgeMin] = useState(20);
  const [ageMax, setAgeMax] = useState(80);
  const [personaStrategy, setPersonaStrategy] = useState("template");
  const [generating, setGenerating] = useState(false);
  const [genPhase, setGenPhase] = useState("");
  const [genStep, setGenStep] = useState(0); // 0=idle, 1-4=phases
  const [personaProgress, setPersonaProgress] = useState({ done: 0, total: 0 });
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [resultCount, setResultCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Resume polling if generation was running when user left ──
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`popgen_${wsId}`);
      if (!saved) return;
      const state = JSON.parse(saved);
      if (state.generating && state.genStep === 4) {
        // Was in persona generation phase — resume polling
        setGenerating(true);
        setGenPhase("Generating personas (resuming)...");
        setGenStep(4);
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          try {
            const prog = await getPersonaProgress(wsId);
            setPersonaProgress({ done: prog.done || 0, total: prog.total || 0 });
            if (prog.status === "done" || prog.status === "completed") {
              if (pollRef.current) clearInterval(pollRef.current);
              setGenerating(false); setDone(true); setGenPhase(""); setGenStep(0);
              localStorage.removeItem(`popgen_${wsId}`);
            } else if (prog.status === "failed" || prog.status === "error") {
              if (pollRef.current) clearInterval(pollRef.current);
              setGenerating(false); setError(`Persona generation failed: ${prog.error || ""}`); setGenStep(0);
              localStorage.removeItem(`popgen_${wsId}`);
            }
          } catch { }
        }, 2000);
      } else {
        localStorage.removeItem(`popgen_${wsId}`);
      }
    } catch { }
  }, [wsId]);

  // ── Load on mount ──
  useEffect(() => {
    (async () => {
      try {
        const [censusRes, elecRes] = await Promise.all([listCensusCounties(), listElectionDb()]);
        setCounties(censusRes.counties || []);
        const elecs = elecRes.elections || [];
        setElections(elecs);
        setLeanCounties([...new Set(elecs.map((e: any) => e.scope).filter(Boolean))].sort() as string[]);
      } catch { }
    })();
  }, []);

  // ── Load districts when county changes ──
  useEffect(() => {
    if (!selCounty) { setDistrictList([]); setSelDistricts(new Set()); setDone(false); setLoadingDistricts(false); return; }
    setLoadingDistricts(true); setDone(false); setError("");
    (async () => {
      try {
        // Use apiFetch to ensure correct base URL and cache busting
        const config = await apiFetch("/api/pipeline/evolution/election-db/build-config", {
          method: "POST",
          body: JSON.stringify({ county: selCounty, ad_year: 2020, include_dims: ["gender"] }),
        });
        if (!config || !config.district_profiles) throw new Error("No districts returned");
        const dists = Object.keys(config.district_profiles || {}).sort();
        setDistrictList(dists);
        setSelDistricts(new Set(dists));
      } catch (e: any) {
        console.error("Failed to load districts:", e);
        setDistrictList([]);
        setSelDistricts(new Set());
        setError(`Failed to load districts: ${e?.message || e}`);
      } finally {
        setLoadingDistricts(false);
      }
    })();
  }, [selCounty]);

  // ── Default leanCounty to selCounty ──
  useEffect(() => {
    if (selCounty) setLeanCounty(selCounty);
  }, [selCounty]);

  // ── Leaning type options based on leanCounty ──
  const leanTypes = [...new Set(
    elections.filter(e => e.scope === leanCounty || e.scope === "United States").map((e: any) => e.election_type)
  )] as string[];

  useEffect(() => {
    if (leanTypes.length > 0 && !leanTypes.includes(leanType)) setLeanType(leanTypes[0]);
  }, [leanCounty, elections]);

  // ── Leaning year options ──
  useEffect(() => {
    if (!leanCounty) { setLeanYears([]); return; }
    const filtered = elections.filter(e => (e.scope === leanCounty || e.scope === "United States") && e.election_type === leanType);
    const yrs = [...new Set(filtered.map((e: any) => e.ad_year))].sort((a: any, b: any) => b - a);
    setLeanYears(yrs as number[]);
    if (yrs.length > 0 && !yrs.includes(leanYear)) setLeanYear(yrs[0] as number);
  }, [leanCounty, leanType, elections]);

  // ── Generate ──
  const handleGenerate = useCallback(async () => {
    if (!selCounty || selDistricts.size === 0) return;
    setGenerating(true); setError(""); setDone(false); setGenStep(1);
    setPersonaProgress({ done: 0, total: 0 }); setResultCount(0);

    try {
      // Step 1: Census data
      setGenPhase("Loading census data..."); setGenStep(1);
      const districts = districtList.length === selDistricts.size ? undefined : Array.from(selDistricts);
      await applyCensusToWorkspace(wsId, selCounty, districts, 2020, Array.from(selDims));

      // Step 2: Political spectrum
      if (leanYear > 0) {
        setGenPhase("Loading political spectrum..."); setGenStep(2);
        await applyElectionLeaningProfile(leanType, leanYear, leanCounty);
      }

      // Step 3: Synthesis
      setGenPhase(`Synthesizing ${targetCount} agents (ages ${ageMin}–${ageMax})...`); setGenStep(3);
      const synthResult = await synthesizeInWorkspace(wsId, targetCount, {}, undefined, ageMin, ageMax);
      if (!synthResult?.persons?.length) { setError("Synthesis failed"); setGenerating(false); return; }
      setResultCount(synthResult.persons.length);

      // Step 4: Persona
      setGenPhase("Generating personas..."); setGenStep(4);
      // Save state so we can resume if user leaves
      try { localStorage.setItem(`popgen_${wsId}`, JSON.stringify({ generating: true, genStep: 4 })); } catch { }
      const personaRes = await generateWorkspacePersonas(wsId, personaStrategy, 10);

      if (personaRes?.status === "started" || personaRes?.status === "running") {
        setPersonaProgress({ done: personaRes.done || 0, total: personaRes.total || 0 });
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          try {
            const prog = await getPersonaProgress(wsId);
            setPersonaProgress({ done: prog.done || 0, total: prog.total || 0 });
            if (prog.status === "done" || prog.status === "completed") {
              if (pollRef.current) clearInterval(pollRef.current);
              setGenerating(false); setDone(true); setGenPhase(""); setGenStep(0);
              try { localStorage.removeItem(`popgen_${wsId}`); } catch { }
            } else if (prog.status === "failed" || prog.status === "error") {
              if (pollRef.current) clearInterval(pollRef.current);
              setGenerating(false); setError(`Persona generation failed: ${prog.error || ""}`);
              try { localStorage.removeItem(`popgen_${wsId}`); } catch { }
            }
          } catch { }
        }, 2000);
      } else if (personaRes?.agents) {
        setResultCount(personaRes.agents.length);
        setGenerating(false); setDone(true); setGenPhase(""); setGenStep(0);
      }
    } catch (e: any) {
      setError(e.message || "Generation failed"); setGenerating(false); setGenStep(0);
    }
  }, [wsId, selCounty, selDistricts, selDims, districtList, targetCount, ageMin, ageMax, personaStrategy, leanYear, leanType, leanCounty]);

  // ── Civatas-USA Stage 1.5+: US generation flow ──
  // Stage 1.8: template is now user-selectable (Presidential national /
  // 2024 cycle / per-state). Selected ID is persisted to localStorage so
  // the Calibration / Prediction / Sandbox panels can read template-driven
  // defaults via useActiveTemplate(wsId).
  // Phase A.5 fix: local lazy fetch instead of shared module-level cache,
  // so a transient template-fetch error in one panel doesn't break others.
  const [templateList, setTemplateList] = useState<TemplateMeta[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    setTemplatesLoading(true);
    listTemplates()
      .then((res) => {
        if (cancelled) return;
        setTemplateList(res.templates || []);
      })
      .catch((e) => {
        console.warn("PopulationSetupPanel: failed to load templates:", e);
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => { cancelled = true; };
  }, []);
  const usTemplates = useMemo(
    () => templateList.filter((t) => t.country === "US"),
    [templateList],
  );
  const [usTemplate, setUsTemplate] = useState<string>(() => {
    return getActiveTemplateId(wsId) || "presidential_national_generic";
  });
  const [showTemplateSwitcher, setShowTemplateSwitcher] = useState(false);
  // Default to first available US template once list loads, if current pick
  // isn't in the list (e.g. fresh workspace before /api/templates resolves)
  useEffect(() => {
    if (usTemplates.length === 0) return;
    if (!usTemplates.find((t) => t.id === usTemplate)) {
      setUsTemplate(usTemplates[0].id);
    }
  }, [usTemplates, usTemplate]);

  // Group templates by election type → scope for the selector UI
  const groupedTemplates = useMemo(() => {
    const groups: Record<string, TemplateMeta[]> = {
      "national": [],
      "state": [],
      "other": [],
    };
    for (const t of usTemplates) {
      const scope = t.election?.scope;
      if (scope === "national") groups.national.push(t);
      else if (scope === "state") groups.state.push(t);
      else groups.other.push(t);
    }
    // Sort national: generic first, then by cycle desc
    groups.national.sort((a, b) => {
      const aGen = a.election?.is_generic ? 0 : 1;
      const bGen = b.election?.is_generic ? 0 : 1;
      if (aGen !== bGen) return aGen - bGen;
      return (b.election?.cycle || 0) - (a.election?.cycle || 0);
    });
    // Sort state by region_code
    groups.state.sort((a, b) => (a.region_code || "").localeCompare(b.region_code || ""));
    return groups;
  }, [usTemplates]);

  const selectedTemplateMeta = useMemo(
    () => usTemplates.find((t) => t.id === usTemplate) || null,
    [usTemplates, usTemplate],
  );

  const setLocale = useLocaleStore((s) => s.setLocale);
  const handleGenerateUS = useCallback(async () => {
    setGenerating(true); setError(""); setDone(false); setGenStep(1);
    setPersonaProgress({ done: 0, total: 0 }); setResultCount(0);
    try {
      // Step 1: load chosen template as workspace source
      setGenPhase(`Loading template: ${selectedTemplateMeta?.name || usTemplate}…`); setGenStep(1);
      await applyTemplateToWorkspace(wsId, usTemplate);
      // Stage 1.8: persist active template for downstream panels
      setActiveTemplateId(wsId, usTemplate);
      // Auto-switch UI locale to match the template's locale on first US run
      // (so users picking a US template don't have to manually toggle the
      // StatusBar 🌐 button — they can still toggle back to zh-TW after).
      if (selectedTemplateMeta?.locale === "en-US" || selectedTemplateMeta?.country === "US") {
        setLocale("en");
      }

      // Step 2: (skip US political spectrum apply — PVI is loaded from
      // shared/us_data at the evolution service level, not as a workspace
      // source. The template already includes party_lean weights.)
      setGenStep(2);

      // Step 3: synthesis
      setGenPhase(`Synthesizing ${targetCount} agents (age ${ageMin}-${ageMax})...`); setGenStep(3);
      const synthResult = await synthesizeInWorkspace(wsId, targetCount, {}, undefined, ageMin, ageMax);
      if (!synthResult?.persons?.length) { setError("Synthesis failed"); setGenerating(false); return; }
      setResultCount(synthResult.persons.length);

      // Step 4: persona
      setGenPhase("Generating personas..."); setGenStep(4);
      try { localStorage.setItem(`popgen_${wsId}`, JSON.stringify({ generating: true, genStep: 4 })); } catch { }
      const personaRes = await generateWorkspacePersonas(wsId, personaStrategy, 10);

      if (personaRes?.status === "started" || personaRes?.status === "running") {
        setPersonaProgress({ done: personaRes.done || 0, total: personaRes.total || 0 });
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          try {
            const prog = await getPersonaProgress(wsId);
            setPersonaProgress({ done: prog.done || 0, total: prog.total || 0 });
            if (prog.status === "done" || prog.status === "completed") {
              if (pollRef.current) clearInterval(pollRef.current);
              setGenerating(false); setDone(true); setGenPhase(""); setGenStep(0);
              try { localStorage.removeItem(`popgen_${wsId}`); } catch { }
            } else if (prog.status === "failed" || prog.status === "error") {
              if (pollRef.current) clearInterval(pollRef.current);
              setGenerating(false); setError(`Persona generation failed: ${prog.error || ""}`);
              try { localStorage.removeItem(`popgen_${wsId}`); } catch { }
            }
          } catch { }
        }, 2000);
      } else if (personaRes?.agents) {
        setResultCount(personaRes.agents.length);
        setGenerating(false); setDone(true); setGenPhase(""); setGenStep(0);
      }
    } catch (e: any) {
      setError(e.message || "Generation failed"); setGenerating(false); setGenStep(0);
    }
  }, [wsId, usTemplate, targetCount, ageMin, ageMax, personaStrategy]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Helpers ──
  const countyInfo = counties.find((c: any) => c.county === selCounty);
  const mapData = Object.fromEntries(counties.map((c: any) => [c.county, c.districts]));
  const selectedMapData = selCounty ? Object.fromEntries(Array.from(selDistricts).map(d => [d, 1])) : {};

  const stepLabels = ["Load Census", "Spectrum", "Synthesize", "Personas"];
  const stepLabelsUS = ["Load Template", "—", "Synthesize Agents", "Generate Personas"];

  return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "auto" }}>
        <GuideBanner
          guideKey="guide_population_setup"
          title="開始設定"
          titleEn="Getting Started"
          message="您的模板已預先設定好人口統計參數。檢視設定，調整後按「生成 Persona」建立代理人群體。"
          messageEn="Your template has pre-configured demographics. Review the settings, adjust if needed, then click Generate Personas to create your agent population."
        />
        <div style={{ padding: "16px clamp(16px, 2vw, 32px)", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Header */}
          <div>
            <h2 style={{ color: "#fff", fontSize: 20, fontWeight: 700, margin: 0 }}>
              👥 {t("popsetup.title")}
            </h2>
            <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 12, margin: "4px 0 0" }}>
              {t("popsetup.subtitle")}
            </p>
          </div>

          <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
            {/* Left: USA states map — highlights follow the selected template
                Stage 1.8: state scope → highlight that one state by FIPS;
                national scope → no single state highlighted (light tint on all). */}
            <div style={{ flexShrink: 0 }}>
              {(() => {
                const meta = selectedTemplateMeta;
                const isStateScope = meta?.election?.scope === "state" && !!meta?.region_code;
                const stateFips = isStateScope ? (meta?.fips || "") : "";
                // Stage 1.8: empty data for both scopes — USMap renders all
                // states with the default faint tint and tooltip shows just
                // the state name. State highlight comes purely from the
                // yellow stroke (selectedFeature prop).
                const mapData: Record<string, number> = {};
                const title = isStateScope
                  ? t("popsetup.map_title.state", { region: meta?.region || meta?.region_code || "" })
                  : t("popsetup.map_title.national");
                // Click handler — switch to whichever state template matches the clicked FIPS
                const handleStateClick = (fips: string) => {
                  if (generating) return;
                  const stateTpl = usTemplates.find(
                    (t) => t.election?.scope === "state" && t.fips === fips
                  );
                  if (stateTpl) {
                    setUsTemplate(stateTpl.id);
                  }
                };
                return (
                  <USMap
                    mode="states"
                    selectedFeature={isStateScope ? stateFips : ""}
                    data={mapData}
                    colorScale={["#1e293b", "#3b82f6"]}
                    title={title}
                    width={520}
                    height={340}
                    showLegend={false}
                    onFeatureClick={handleStateClick}
                  />
                );
              })()}
            </div>

            {/* Right: Configuration */}
            <div style={{ flex: "1 1 360px", display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Stage 1.8 (Phase A.5): Template is now picked at workspace
                  creation. Here we show a read-only summary + a "Change" link
                  that opens an inline dropdown for users who want to switch
                  template within the existing workspace (note: switching here
                  changes the template the next Generate uses; it does NOT
                  retroactively re-align personas already generated). */}
              <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>📦 {t("popsetup.template_label")}</div>
                  <button
                    onClick={() => setShowTemplateSwitcher((s) => !s)}
                    disabled={generating}
                    style={{
                      padding: "3px 10px", borderRadius: 6,
                      border: "1px solid rgba(255,255,255,0.12)",
                      background: showTemplateSwitcher ? "rgba(139,92,246,0.15)" : "rgba(0,0,0,0.2)",
                      color: showTemplateSwitcher ? "#a78bfa" : "rgba(255,255,255,0.5)",
                      fontSize: 10, fontWeight: 600, cursor: generating ? "not-allowed" : "pointer",
                      fontFamily: "var(--font-cjk)",
                    }}
                  >
                    {showTemplateSwitcher ? "✕ Cancel" : "↻ Change template"}
                  </button>
                </div>

                {/* Read-only display of currently active template */}
                {selectedTemplateMeta && (
                  <div style={{
                    padding: "10px 14px", borderRadius: 8,
                    background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.2)",
                  }}>
                    <div style={{ color: "#fff", fontSize: 13, fontWeight: 600 }}>
                      {selectedTemplateMeta.name}
                    </div>
                    <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, marginTop: 2 }}>
                      {selectedTemplateMeta.region}
                      {selectedTemplateMeta.metadata?.state_pvi_label && ` · Cook PVI ${selectedTemplateMeta.metadata.state_pvi_label}`}
                      {selectedTemplateMeta.metadata?.national_pvi_label && ` · Cook PVI ${selectedTemplateMeta.metadata.national_pvi_label}`}
                      {selectedTemplateMeta.metadata?.county_count && ` · ${selectedTemplateMeta.metadata.county_count} counties`}
                      {selectedTemplateMeta.metadata?.population_total && ` · ${(selectedTemplateMeta.metadata.population_total / 1e6).toFixed(1)}M pop.`}
                      {selectedTemplateMeta.election?.candidate_count != null && ` · ${selectedTemplateMeta.election.candidate_count} candidates`}
                    </div>
                  </div>
                )}

                {/* Switcher (collapsed by default) — only appears after user clicks "Change template" */}
                {showTemplateSwitcher && !templatesLoading && (
                  <select
                    value={usTemplate}
                    onChange={(e) => setUsTemplate(e.target.value)}
                    disabled={generating}
                    style={{
                      width: "100%", marginTop: 8, padding: "8px 12px", borderRadius: 8,
                      border: "1px solid rgba(255,255,255,0.15)",
                      background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 13,
                      outline: "none", fontFamily: "var(--font-cjk)",
                    }}
                  >
                    {groupedTemplates.national.length > 0 && (
                      <optgroup label={t("popsetup.template.optgroup.national")}>
                        {groupedTemplates.national.map((tpl) => (
                          <option key={tpl.id} value={tpl.id}>
                            {tpl.name}{tpl.election?.cycle ? ` · ${tpl.election.cycle}` : ""}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {groupedTemplates.state.length > 0 && (
                      <optgroup label={t("popsetup.template.optgroup.state")}>
                        {groupedTemplates.state.map((tpl) => (
                          <option key={tpl.id} value={tpl.id}>
                            {tpl.region_code} · {tpl.region}{tpl.metadata?.state_pvi_label ? ` (${tpl.metadata.state_pvi_label})` : ""}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                )}
              </div>

              {/* Target count + age range */}
              <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                <label style={{ flex: "1 1 130px", color: "rgba(255,255,255,0.7)", fontSize: 12 }}>
                  {t("popsetup.target_count")}
                  <input type="number" min={1} max={5000} value={targetCount} onChange={e => setTargetCount(Number(e.target.value) || 100)}
                    style={{ width: "100%", marginTop: 4, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 13 }} />
                </label>
                <label style={{ flex: "1 1 80px", color: "rgba(255,255,255,0.7)", fontSize: 12 }}>
                  {t("popsetup.age_min")}
                  <input type="number" min={0} max={120} value={ageMin} onChange={e => setAgeMin(Number(e.target.value) || 18)}
                    style={{ width: "100%", marginTop: 4, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 13 }} />
                </label>
                <label style={{ flex: "1 1 80px", color: "rgba(255,255,255,0.7)", fontSize: 12 }}>
                  {t("popsetup.age_max")}
                  <input type="number" min={0} max={120} value={ageMax} onChange={e => setAgeMax(Number(e.target.value) || 80)}
                    style={{ width: "100%", marginTop: 4, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 13 }} />
                </label>
                <label style={{ flex: "1 1 130px", color: "rgba(255,255,255,0.7)", fontSize: 12 }}>
                  {t("popsetup.persona_strategy")}
                  <select value={personaStrategy} onChange={e => setPersonaStrategy(e.target.value)}
                    style={{ width: "100%", marginTop: 4, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 13 }}>
                    <option value="template">{t("popsetup.strategy_template")}</option>
                    <option value="llm">{t("popsetup.strategy_llm")}</option>
                  </select>
                </label>
              </div>

              {/* Generate button — label follows the active template's region */}
              <button onClick={handleGenerateUS} disabled={generating}
                style={{
                  padding: "10px 20px", borderRadius: 8, border: "none", cursor: generating ? "not-allowed" : "pointer",
                  background: generating ? "rgba(59,130,246,0.3)" : "#3b82f6",
                  color: "#fff", fontSize: 14, fontWeight: 700,
                }}>
                {generating
                  ? `${genPhase}`
                  : selectedTemplateMeta?.election?.scope === "state"
                    ? t("popsetup.generate.state", { region: selectedTemplateMeta.region || selectedTemplateMeta.region_code || "" })
                    : t("popsetup.generate.national")}
              </button>

              {/* Step progress */}
              {generating && (
                <div style={{ display: "flex", gap: 8, fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                  {stepLabelsUS.map((label, i) => (
                    <div key={i} style={{ padding: "4px 10px", borderRadius: 4, background: genStep > i ? "rgba(34,197,94,0.15)" : genStep === i + 1 ? "rgba(59,130,246,0.25)" : "rgba(255,255,255,0.04)" }}>
                      {genStep > i ? "✓" : genStep === i + 1 ? "▶" : "○"} {label}
                    </div>
                  ))}
                </div>
              )}

              {/* Persona progress */}
              {generating && genStep === 4 && personaProgress.total > 0 && (
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
                  Personas: {personaProgress.done} / {personaProgress.total}
                  <div style={{ marginTop: 4, height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2 }}>
                    <div style={{ height: "100%", width: `${(personaProgress.done / personaProgress.total) * 100}%`, background: "#3b82f6", borderRadius: 2 }} />
                  </div>
                </div>
              )}

              {error && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 12 }}>
                  ⚠ {error}
                </div>
              )}
              {done && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", color: "#86efac", fontSize: 12 }}>
                  ✓ Generated {resultCount} agents. Move on to Evolution → Prediction.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
}
