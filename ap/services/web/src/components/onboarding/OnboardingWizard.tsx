// ap/services/web/src/components/onboarding/OnboardingWizard.tsx
"use client";
import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useLocaleStore } from "@/store/locale-store";
import { useLocalizePersonaValue } from "@/lib/i18n";
import { useShellStore } from "@/store/shell-store";
import { useQueryClient } from "@tanstack/react-query";

import {
  VENDOR_PRESETS,
  type Provider,
  type RoleAssignment,
  buildSettingsPayload,
  parseSettingsToProvidersAndRoles,
} from "@/lib/vendor-presets";

/* ─── Section header for accordion ─── */
function SectionHeader({
  num,
  title,
  subtitle,
  complete,
  locked,
  summary,
  expanded,
  en,
  onClick,
}: {
  num: 1 | 2 | 3;
  title: string;
  subtitle: string;
  complete: boolean;
  locked: boolean;
  summary?: string;
  expanded: boolean;
  en: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`w-full flex items-center gap-3 p-3 rounded-t-lg transition-colors ${
        locked ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-[#16213e]/60"
      } ${expanded ? "" : "rounded-b-lg"}`}
      onClick={() => { if (!locked) onClick(); }}
      disabled={locked}
    >
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
          complete
            ? "bg-green-500 text-white"
            : expanded
            ? "bg-[#e94560] text-white"
            : "bg-neutral-700 text-neutral-400"
        }`}
      >
        {complete ? "✓" : num}
      </div>
      <div className="flex-1 text-left">
        <div className="text-sm font-medium text-neutral-200">{title}</div>
        <div className="text-[11px] text-neutral-500">{subtitle}</div>
      </div>
      <div className="text-xs text-neutral-500 shrink-0">
        {locked ? (
          <span className="text-neutral-600">{en ? "Complete above first" : "請先完成上方步驟"}</span>
        ) : complete && !expanded && summary ? (
          <span className="text-green-400">{summary}</span>
        ) : (
          <span>{expanded ? "▼" : "▶"}</span>
        )}
      </div>
    </button>
  );
}

interface TemplateInfo {
  id: string;
  name: string;
  region?: string;
  region_code?: string;
  country?: string;
  scope?: string;
  cycle?: string;
  candidate_count?: number;
  is_generic?: boolean;
  metadata?: {
    source?: { demographics?: string; elections?: string; leaning?: string };
    national_pvi?: number;
    national_pvi_label?: string;
    state_pvi?: number;
    state_pvi_label?: string;
    county_count?: number;
    counties_with_lean?: number;
    state_count?: number;
    population_total?: number;
  };
}

export function OnboardingWizard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const en = useLocaleStore((s) => s.locale) === "en";
  const localize = useLocalizePersonaValue();
  const [step, setStep] = useState(1);

  // Step 1: Providers
  const [providers, setProviders] = useState<Provider[]>([
    { id: "openai-1", vendor_type: "openai", display_name: "OpenAI", api_key: "", base_url: "" },
  ]);
  // Step 1: Role assignments
  const [systemLlm, setSystemLlm] = useState<RoleAssignment>({ provider_id: "openai-1", model: "o4-mini" });
  const [agentLlms, setAgentLlms] = useState<RoleAssignment[]>([{ provider_id: "openai-1", model: "gpt-4o-mini" }]);
  const [serperKey, setSerperKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [testResults, setTestResults] = useState<Record<string, "ok" | "fail" | "testing">>({});

  // Step 2: Project
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [projectName, setProjectName] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [createdWsId, setCreatedWsId] = useState("");

  // Step 3: Persona
  const [targetCount, setTargetCount] = useState(100);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [personaDone, setPersonaDone] = useState(false);
  const [personas, setPersonas] = useState<any[]>([]);
  const [showStats, setShowStats] = useState(false);
  const [showDataSources, setShowDataSources] = useState(false);
  const [hoveredPersona, setHoveredPersona] = useState<any | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Step 1 completion checks
  const hasProviderWithKey = providers.some((p) => p.api_key.trim() !== "");
  const rolesComplete =
    hasProviderWithKey &&
    !!systemLlm.provider_id &&
    !!systemLlm.model &&
    agentLlms.length >= 1 &&
    agentLlms.every((a) => !!a.provider_id && !!a.model);
  const serperComplete = serperKey.trim() !== "";
  const allComplete = rolesComplete && serperComplete;

  const providersWithKey = providers.filter((p) => p.api_key.trim() !== "");

  // Load existing settings on mount
  useEffect(() => {
    (async () => {
      try {
        const settings = await apiFetch("/api/settings");
        if (settings?.llm_vendors?.length) {
          const parsed = parseSettingsToProvidersAndRoles(settings);
          if (parsed.providers.length > 0) setProviders(parsed.providers);
          if (parsed.systemLlm.provider_id) setSystemLlm(parsed.systemLlm);
          if (parsed.agentLlms.length > 0) setAgentLlms(parsed.agentLlms);
        }
        if (settings?.serper_api_key) setSerperKey(settings.serper_api_key);
      } catch { /* first run — no settings yet */ }
      setInitialLoading(false);
    })();
  }, []);

  // Add provider
  const addProvider = () => {
    const usedTypes = providers.map((p) => p.vendor_type);
    const availableType = Object.keys(VENDOR_PRESETS).find((t) => !usedTypes.includes(t)) || "openai";
    const preset = VENDOR_PRESETS[availableType];
    const newId = `${availableType}-${Date.now()}`;
    setProviders((prev) => [
      ...prev,
      {
        id: newId,
        vendor_type: availableType,
        display_name: preset.label,
        api_key: "",
        base_url: "",
      },
    ]);
    // Auto-add to agentLlms
    setAgentLlms((prev) => [...prev, { provider_id: newId, model: preset.defaultModel }]);
  };

  const updateProvider = (idx: number, updates: Partial<Provider>) => {
    setProviders((prev) => {
      const updated = prev.map((p, i) => {
        if (i !== idx) return p;
        const next = { ...p, ...updates };
        if (updates.vendor_type && updates.vendor_type !== p.vendor_type) {
          const preset = VENDOR_PRESETS[updates.vendor_type];
          const newId = `${updates.vendor_type}-${Date.now()}`;
          next.display_name = preset.label;
          next.id = newId;
          // Cascade id change to role assignments
          const oldId = p.id;
          setSystemLlm((s) =>
            s.provider_id === oldId
              ? { provider_id: newId, model: preset.systemModel }
              : s,
          );
          setAgentLlms((al) =>
            al.map((a) =>
              a.provider_id === oldId
                ? { provider_id: newId, model: preset.defaultModel }
                : a,
            ),
          );
        }
        return next;
      });
      return updated;
    });
  };

  const removeProvider = (idx: number) => {
    if (providers.length <= 1) return;
    const removedId = providers[idx].id;
    // Compute remaining before any state updates to avoid stale closures
    const remaining = providers.filter((_, i) => i !== idx);
    const fallbackProv = remaining[0];
    const fallbackPreset = VENDOR_PRESETS[fallbackProv?.vendor_type ?? ""];

    setProviders(remaining);
    setAgentLlms((prev) => {
      const filtered = prev.filter((a) => a.provider_id !== removedId);
      // If all agents were removed, fall back to first remaining provider
      return filtered.length > 0
        ? filtered
        : fallbackProv
        ? [{ provider_id: fallbackProv.id, model: fallbackPreset?.defaultModel ?? "" }]
        : prev;
    });
    setSystemLlm((prev) => {
      if (prev.provider_id === removedId && fallbackProv) {
        return { provider_id: fallbackProv.id, model: fallbackPreset?.systemModel ?? "" };
      }
      return prev;
    });
  };

  // Test provider API key
  const testProvider = async (providerId: string) => {
    const p = providers.find((pr) => pr.id === providerId);
    if (!p || !p.api_key.trim()) {
      setTestResults((prev) => ({ ...prev, [providerId]: "fail" }));
      return;
    }
    setTestResults((prev) => ({ ...prev, [providerId]: "testing" }));
    try {
      // Use the agent model for testing this provider
      const agentAssignment = agentLlms.find((a) => a.provider_id === providerId);
      const model = agentAssignment?.model || VENDOR_PRESETS[p.vendor_type]?.defaultModel || "";
      const res = await apiFetch("/api/settings/test-vendor", {
        method: "POST",
        body: JSON.stringify({
          vendor_type: p.vendor_type,
          api_key: p.api_key,
          model,
          base_url: p.base_url,
        }),
      });
      setTestResults((prev) => ({ ...prev, [providerId]: res.status === "ok" ? "ok" : "fail" }));
    } catch {
      setTestResults((prev) => ({ ...prev, [providerId]: "fail" }));
    }
  };

  // Test Serper key
  const testSerper = async () => {
    if (!serperKey.trim()) {
      setTestResults((prev) => ({ ...prev, serper: "fail" }));
      return;
    }
    setTestResults((prev) => ({ ...prev, serper: "testing" }));
    try {
      const res = await apiFetch("/api/settings/test-serper", {
        method: "POST",
        body: JSON.stringify({ api_key: serperKey }),
      });
      setTestResults((prev) => ({ ...prev, serper: res.status === "ok" ? "ok" : "fail" }));
    } catch {
      setTestResults((prev) => ({ ...prev, serper: "fail" }));
    }
  };

  // Save API keys
  const saveKeys = async (advance = true) => {
    if (!hasProviderWithKey) {
      setKeyError(en ? "At least one LLM API key is required" : "至少需要一組 LLM API Key");
      return false;
    }
    if (!rolesComplete) {
      setKeyError(en ? "Please assign system and agent LLM roles" : "請指定系統與 Agent LLM 角色");
      return false;
    }
    if (!serperKey.trim()) {
      setKeyError(en ? "Serper API key is required for news search" : "Serper API Key 為必填（用於新聞搜尋）");
      return false;
    }
    setKeyError("");
    setSaving(true);
    try {
      const payload = buildSettingsPayload(providers, systemLlm, agentLlms, serperKey);
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (advance) {
        await loadTemplates();
        setStep(2);
      }
      setSaving(false);
      return true;
    } catch (e: any) {
      setSaving(false);
      setKeyError(e.message || "Failed to save");
      return false;
    }
  };

  // Load templates
  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const raw = await apiFetch("/api/templates");
      const arr: any[] = Array.isArray(raw) ? raw : raw.templates ?? [];
      const data: TemplateInfo[] = arr
        .filter((t: any) => t.election) // only templates with election info
        .map((t: any) => ({
          id: t.id,
          name: t.name,
          region: t.region,
          region_code: t.region_code,
          country: t.country,
          scope: t.election?.scope ?? t.scope,
          cycle: t.election?.cycle ?? t.cycle,
          candidate_count: t.election?.candidate_count ?? t.candidate_count,
          is_generic: t.election?.is_generic,
          metadata: t.metadata,
        }));
      setTemplates(data);
      if (data.length > 0) setSelectedTemplate(data[0].id);
    } catch { /* ignore */ }
    setLoadingTemplates(false);
  };

  // Create project
  const createProject = async () => {
    if (!projectName.trim()) return;
    if (!selectedTemplate) return;
    try {
      const ws = await apiFetch("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: projectName, purpose: "election" }),
      });
      const wsId = ws.id;
      setCreatedWsId(wsId);

      // Apply template
      await apiFetch(`/api/workspaces/${wsId}/apply-template?name=${encodeURIComponent(selectedTemplate)}`, {
        method: "POST",
      });

      // Cache workspace
      useShellStore.getState().setActiveWorkspace(wsId, projectName);

      setStep(3);
    } catch (e: any) {
      setKeyError(e.message || "Failed to create project");
    }
  };

  // Generate personas
  const generatePersonas = useCallback(async () => {
    if (!createdWsId) return;
    setGenerating(true);
    setProgress({ done: 0, total: targetCount });

    try {
      // Synthesize first
      await apiFetch(`/api/workspaces/${createdWsId}/synthesize`, {
        method: "POST",
        body: JSON.stringify({ target_count: targetCount }),
      });

      // Generate personas
      await apiFetch(`/api/workspaces/${createdWsId}/persona`, {
        method: "POST",
        body: JSON.stringify({ strategy: "template", concurrency: 5 }),
      });

      // Poll progress + fetch persona data
      const poll = async () => {
        try {
          const p = await apiFetch(`/api/workspaces/${createdWsId}/persona-progress`);
          const done = p.done ?? 0;
          const total = p.total ?? targetCount;
          setProgress({ done, total });
          // Fetch generated personas so far
          try {
            const result = await apiFetch(`/api/workspaces/${createdWsId}/persona-result`);
            const agents = result?.agents ?? (Array.isArray(result) ? result : []);
            if (agents.length > 0) setPersonas(agents);
          } catch { /* not ready yet */ }
          if (done >= total || p.status === "done" || p.status === "completed") {
            setPersonaDone(true);
            setGenerating(false);
            return;
          }
        } catch { /* continue polling */ }
        if (!personaDone) setTimeout(poll, 2000);
      };
      setTimeout(poll, 2000);
    } catch (e: any) {
      setKeyError(e.message || "Failed to generate");
      setGenerating(false);
    }
  }, [createdWsId, targetCount, personaDone]);

  // Finish onboarding
  const finishOnboarding = async () => {
    await apiFetch("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ onboarding_completed: true }),
    });
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    router.push(`/workspaces/${createdWsId}/evolution-quickstart`);
  };

  // Group templates
  const nationalTemplates = templates.filter((t) => t.scope === "national");
  const stateTemplates = templates.filter((t) => t.scope === "state");

  return (
    <div className="fixed inset-0 bg-[#0a0a1a] z-50 flex flex-col items-center justify-center overflow-y-auto">
      <div className="w-full max-w-2xl px-6 py-12">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#e94560] tracking-wider">CIVATAS</h1>
          <p className="text-neutral-500 text-sm mt-1">
            {en ? "Social Simulation Agent Platform" : "社會模擬代理人平台"}
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-0 mb-10">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                  s <= step
                    ? "bg-[#e94560] text-white"
                    : "bg-neutral-800 text-neutral-500"
                }`}
              >
                {s < step ? "✓" : s}
              </div>
              {s < 4 && (
                <div
                  className={`w-16 h-0.5 ${
                    s < step ? "bg-[#e94560]" : "bg-neutral-800"
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: API Keys — Card-based layout */}
        {step === 1 && initialLoading && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-8 h-8 border-2 border-[#e94560] border-t-transparent rounded-full animate-spin mb-4" />
            <div className="text-neutral-500 text-sm">{en ? "Loading settings..." : "載入設定中..."}</div>
          </div>
        )}
        {step === 1 && !initialLoading && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              {en ? "Configure API Keys" : "設定 API Key"}
            </h2>
            <p className="text-neutral-500 text-sm mb-6">
              {en
                ? "Add LLM providers, assign roles, and enter your Serper key."
                : "新增 LLM 供應商、指定角色，並輸入 Serper Key。"}
            </p>

            {/* ═══ LLM Providers ═══ */}
            <div className="mb-5">
              <div className="text-neutral-400 text-xs font-medium uppercase tracking-wider mb-2">
                {en ? "LLM Providers" : "LLM 供應商"}
              </div>
              <div className="space-y-3">
                {providers.map((p, idx) => (
                  <div
                    key={p.id}
                    className="bg-[#0f1729] rounded-lg p-4 border border-[#2a3554]"
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <select
                        className="bg-[#0f3460] text-neutral-300 text-sm rounded px-2 py-1.5 border-none outline-none"
                        value={p.vendor_type}
                        onChange={(e) => updateProvider(idx, { vendor_type: e.target.value })}
                      >
                        {Object.entries(VENDOR_PRESETS).map(([key, preset]) => (
                          <option key={key} value={key}>{preset.label}</option>
                        ))}
                      </select>
                      <div className="flex-1" />
                      {providers.length > 1 && (
                        <button
                          className="text-neutral-600 hover:text-red-400 text-sm"
                          onClick={() => removeProvider(idx)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        className="flex-1 bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none font-mono"
                        type="password"
                        placeholder="API Key"
                        value={p.api_key}
                        onChange={(e) => updateProvider(idx, { api_key: e.target.value })}
                      />
                      <button
                        className="text-xs bg-[#0f3460] text-neutral-400 hover:text-white px-3 py-1.5 rounded transition-colors"
                        onClick={() => testProvider(p.id)}
                      >
                        {testResults[p.id] === "testing"
                          ? "..."
                          : testResults[p.id] === "ok"
                          ? "✓ OK"
                          : testResults[p.id] === "fail"
                          ? "✕ Fail"
                          : en ? "Test" : "測試"}
                      </button>
                    </div>
                    <input
                      className="w-full bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none mb-1"
                      placeholder={en ? "Base URL (optional)" : "Base URL（選填）"}
                      value={p.base_url}
                      onChange={(e) => updateProvider(idx, { base_url: e.target.value })}
                    />
                    {VENDOR_PRESETS[p.vendor_type]?.keyUrl && (
                      <a
                        href={VENDOR_PRESETS[p.vendor_type].keyUrl}
                        target="_blank"
                        rel="noopener"
                        className="text-[10px] text-blue-400 hover:underline mt-1 inline-block"
                      >
                        {en
                          ? `Get ${VENDOR_PRESETS[p.vendor_type].label} API Key →`
                          : `申請 ${VENDOR_PRESETS[p.vendor_type].label} API Key →`}
                      </a>
                    )}
                  </div>
                ))}
                <button
                  className="text-sm text-green-400 hover:text-green-300"
                  onClick={addProvider}
                >
                  + {en ? "Add another provider" : "新增供應商"}
                </button>
              </div>
            </div>

            {/* ═══ Role Cards (visible once at least one provider has a key) ═══ */}
            {hasProviderWithKey && (
              <div className="mb-5">
                <div className="text-neutral-400 text-xs font-medium uppercase tracking-wider mb-2">
                  {en ? "Assign LLM Roles" : "指定 LLM 角色"}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
                  {/* ── Left column: System LLM ── */}
                  <div className="bg-[#0f1729] rounded-lg border border-[#2a3554] p-4 flex flex-col">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-2 h-2 rounded-full bg-cyan-400 shrink-0" />
                      <span className="text-sm font-medium text-neutral-200">
                        {en ? "System LLM" : "系統 LLM"}
                      </span>
                    </div>
                    <div className="text-neutral-500 text-[10px] mb-3">
                      {en
                        ? "News analysis, data parsing, election OCR"
                        : "新聞分析、資料解析、選舉 OCR"}
                    </div>
                    <select
                      className="bg-[#0f3460] text-neutral-300 text-sm rounded px-2 py-1.5 border-none outline-none mb-2"
                      value={systemLlm.provider_id}
                      onChange={(e) => {
                        const pid = e.target.value;
                        const prov = providers.find((pp) => pp.id === pid);
                        const preset = prov ? VENDOR_PRESETS[prov.vendor_type] : null;
                        setSystemLlm({ provider_id: pid, model: preset?.systemModel ?? systemLlm.model });
                      }}
                    >
                      {providersWithKey.map((p) => (
                        <option key={p.id} value={p.id}>{p.display_name}</option>
                      ))}
                    </select>
                    <input
                      className="bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none"
                      placeholder="Model"
                      value={systemLlm.model}
                      onChange={(e) => setSystemLlm((prev) => ({ ...prev, model: e.target.value }))}
                    />
                  </div>

                  {/* ── Right column: Agent LLM cards + Add button ── */}
                  <div className="flex flex-col gap-3">
                    {agentLlms.map((agent, aIdx) => (
                      <div
                        key={`${agent.provider_id}-${aIdx}`}
                        className="bg-[#0f1729] rounded-lg border border-[#2a3554] p-4 flex flex-col"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <div className="w-2 h-2 rounded-full bg-[#e94560] shrink-0" />
                          <span className="text-sm font-medium text-neutral-200">
                            Agent LLM {agentLlms.length > 1 ? `#${aIdx + 1}` : ""}
                          </span>
                          <div className="flex-1" />
                          {agentLlms.length > 1 && (
                            <button
                              className="text-neutral-600 hover:text-red-400 text-xs"
                              onClick={() => setAgentLlms((prev) => prev.filter((_, i) => i !== aIdx))}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        <div className="text-neutral-500 text-[10px] mb-3">
                          {en
                            ? "Persona generation, opinion evolution"
                            : "人格生成、觀點演化"}
                        </div>
                        <select
                          className="bg-[#0f3460] text-neutral-300 text-sm rounded px-2 py-1.5 border-none outline-none mb-2"
                          value={agent.provider_id}
                          onChange={(e) => {
                            const pid = e.target.value;
                            const p = providers.find((pp) => pp.id === pid);
                            const preset = p ? VENDOR_PRESETS[p.vendor_type] : null;
                            setAgentLlms((prev) =>
                              prev.map((a, i) =>
                                i === aIdx
                                  ? { provider_id: pid, model: preset?.defaultModel ?? a.model }
                                  : a,
                              ),
                            );
                          }}
                        >
                          {providersWithKey.map((p) => (
                            <option key={p.id} value={p.id}>{p.display_name}</option>
                          ))}
                        </select>
                        <input
                          className="bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none"
                          placeholder="Model"
                          value={agent.model}
                          onChange={(e) => {
                            const model = e.target.value;
                            setAgentLlms((prev) =>
                              prev.map((a, i) => (i === aIdx ? { ...a, model } : a)),
                            );
                          }}
                        />
                      </div>
                    ))}

                    {/* Add Agent LLM (dashed card) */}
                    <button
                      className="rounded-lg border border-dashed border-[#2a3554] hover:border-[#3b4c6b] p-4 flex items-center justify-center gap-2 text-neutral-500 hover:text-neutral-300 transition-colors"
                      onClick={() => {
                        const firstWithKey = providersWithKey[0];
                        if (!firstWithKey) return;
                        const preset = VENDOR_PRESETS[firstWithKey.vendor_type];
                        setAgentLlms((prev) => [
                          ...prev,
                          { provider_id: firstWithKey.id, model: preset?.defaultModel ?? "" },
                        ]);
                      }}
                    >
                      <span className="text-lg">+</span>
                      <span className="text-sm">{en ? "Add Agent LLM" : "新增 Agent LLM"}</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ═══ Search API (Serper) ═══ */}
            {hasProviderWithKey && (
              <div className="mb-2">
                <div className="text-neutral-400 text-xs font-medium uppercase tracking-wider mb-2">
                  {en ? "Search API" : "搜尋 API"}
                </div>
                <div className="bg-[#0f1729] rounded-lg p-4 border border-[#2a3554]">
                  <div className="text-neutral-400 text-xs mb-2">
                    Serper API Key <span className="text-[#e94560]">*</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none font-mono"
                      type="password"
                      placeholder="Serper API Key"
                      value={serperKey}
                      onChange={(e) => setSerperKey(e.target.value)}
                    />
                    <button
                      className="text-xs bg-[#0f3460] text-neutral-400 hover:text-white px-3 py-1.5 rounded transition-colors"
                      onClick={testSerper}
                    >
                      {testResults.serper === "testing"
                        ? "..."
                        : testResults.serper === "ok"
                        ? "✓ OK"
                        : testResults.serper === "fail"
                        ? "✕ Fail"
                        : en ? "Test" : "測試"}
                    </button>
                  </div>
                  <a
                    href="https://serper.dev/api-key"
                    target="_blank"
                    rel="noopener"
                    className="text-[10px] text-blue-400 hover:underline mt-2 inline-block"
                  >
                    {en ? "Get Serper API Key (Google Search) →" : "申請 Serper API Key（Google 搜尋）→"}
                  </a>
                </div>
              </div>
            )}

            {keyError && (
              <div className="text-red-400 text-sm mt-4 mb-2">{keyError}</div>
            )}

            <button
              className={`w-full mt-6 py-2.5 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${
                allComplete && !saving
                  ? "bg-[#e94560] hover:bg-[#d63851] text-white"
                  : "bg-neutral-700 text-neutral-500 cursor-not-allowed"
              }`}
              disabled={!allComplete || saving}
              onClick={() => saveKeys()}
            >
              {saving && <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
              {saving
                ? (en ? "Saving..." : "儲存中...")
                : (en ? "Next: Create Project →" : "下一步：建立專案 →")}
            </button>
          </div>
        )}

        {/* Step 2: Create Project */}
        {step === 2 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              {en ? "Create Your First Project" : "建立第一個專案"}
            </h2>
            <p className="text-neutral-500 text-sm mb-6">
              {en
                ? "Name your project and select an election template."
                : "為專案命名並選擇選舉模板。"}
            </p>

            <div className="bg-[#16213e] rounded-lg p-4 mb-4 border border-[#0f3460]">
              <div className="text-neutral-400 text-xs mb-2">
                {en ? "Project Name" : "專案名稱"}
              </div>
              <input
                className="w-full bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-2 border-none outline-none"
                placeholder={en ? "e.g. 2024 Presidential Election" : "例：2024 總統大選"}
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between mb-2">
              <div className="text-neutral-400 text-xs">
                {en ? "Select Template" : "選擇模板"}
              </div>
              <button
                className="text-[10px] text-blue-400 hover:text-blue-300 hover:underline transition-colors flex items-center gap-1"
                onClick={() => setShowDataSources(true)}
              >
                <span className="inline-block w-3 h-3 rounded-full border border-blue-400 text-blue-400 text-[8px] leading-3 text-center shrink-0">i</span>
                {en ? "Data Sources" : "資料來源"}
              </button>
            </div>

            {loadingTemplates ? (
              <div className="text-neutral-500 text-sm py-8 text-center">Loading...</div>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-1.5 mb-6">
                {nationalTemplates.length > 0 && (
                  <>
                    <div className="text-neutral-600 text-[10px] uppercase tracking-wider py-1">
                      {en ? "National" : "全國"}
                    </div>
                    {nationalTemplates.map((t) => (
                      <button
                        key={t.id}
                        className={`w-full text-left rounded-lg p-3 transition-colors ${
                          selectedTemplate === t.id
                            ? "bg-[#e94560]/15 border border-[#e94560]"
                            : "bg-[#16213e] border border-[#0f3460] hover:border-neutral-600"
                        }`}
                        onClick={() => setSelectedTemplate(t.id)}
                      >
                        <div className={`text-sm font-medium ${selectedTemplate === t.id ? "text-[#e94560]" : "text-neutral-300"}`}>
                          {t.name}
                        </div>
                        <div className="text-neutral-500 text-[11px] mt-0.5">
                          {t.cycle && `${t.cycle} · `}{t.candidate_count ? `${t.candidate_count} candidates` : ""}
                        </div>
                      </button>
                    ))}
                  </>
                )}
                {stateTemplates.length > 0 && (
                  <>
                    <div className="text-neutral-600 text-[10px] uppercase tracking-wider py-1 mt-3">
                      {en ? "By State" : "各州"}
                    </div>
                    {stateTemplates.map((t) => (
                      <button
                        key={t.id}
                        className={`w-full text-left rounded-lg p-3 transition-colors ${
                          selectedTemplate === t.id
                            ? "bg-[#e94560]/15 border border-[#e94560]"
                            : "bg-[#16213e] border border-[#0f3460] hover:border-neutral-600"
                        }`}
                        onClick={() => setSelectedTemplate(t.id)}
                      >
                        <div className={`text-sm font-medium ${selectedTemplate === t.id ? "text-[#e94560]" : "text-neutral-300"}`}>
                          {t.name}
                        </div>
                        <div className="text-neutral-500 text-[11px] mt-0.5">
                          {t.region_code ?? t.region ?? ""}
                        </div>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}

            <button
              className="w-full bg-[#e94560] hover:bg-[#d63851] text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-40"
              disabled={!projectName.trim() || !selectedTemplate}
              onClick={createProject}
            >
              {en ? "Next: Generate Personas →" : "下一步：生成 Persona →"}
            </button>

            {/* ── Data Sources Modal (dynamic per selected template) ── */}
            {showDataSources && (() => {
              const sel = templates.find((t) => t.id === selectedTemplate);
              const m = sel?.metadata;
              const src = m?.source;
              const isState = sel?.scope === "state";
              const pviLabel = isState ? m?.state_pvi_label : m?.national_pvi_label;
              const pop = m?.population_total;
              const fmtPop = pop ? pop.toLocaleString() : "—";
              const countyCount = m?.county_count ?? (isState ? "—" : "3,142");
              const stateCount = m?.state_count ?? (isState ? 1 : 51);
              const cwl = m?.counties_with_lean;

              return (
              <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-6" onClick={() => setShowDataSources(false)}>
                <div
                  className="bg-[#0f1729] border border-[#2a3554] rounded-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto p-6 shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-lg font-semibold text-white">
                      {en ? "Data Sources" : "資料來源"}
                    </h3>
                    <button className="text-neutral-500 hover:text-white text-lg" onClick={() => setShowDataSources(false)}>✕</button>
                  </div>
                  {sel && (
                    <div className="text-neutral-500 text-xs mb-5">
                      {sel.name}
                      {sel.region && sel.scope === "state" ? ` · ${sel.region}` : ""}
                    </div>
                  )}

                  {/* Summary stats row */}
                  {m && (
                    <div className="grid grid-cols-3 gap-3 mb-5">
                      <div className="bg-[#16213e] rounded-lg p-3 border border-[#0f3460] text-center">
                        <div className="text-lg font-bold text-white">{fmtPop}</div>
                        <div className="text-neutral-500 text-[10px] mt-0.5">{en ? "Population" : "人口"}</div>
                      </div>
                      <div className="bg-[#16213e] rounded-lg p-3 border border-[#0f3460] text-center">
                        <div className="text-lg font-bold text-white">{countyCount}</div>
                        <div className="text-neutral-500 text-[10px] mt-0.5">{en ? "Counties" : "縣"}</div>
                      </div>
                      <div className="bg-[#16213e] rounded-lg p-3 border border-[#0f3460] text-center">
                        <div className={`text-lg font-bold ${pviLabel?.startsWith("D") ? "text-blue-400" : pviLabel?.startsWith("R") ? "text-red-400" : "text-purple-400"}`}>
                          {pviLabel ?? "—"}
                        </div>
                        <div className="text-neutral-500 text-[10px] mt-0.5">{isState ? (en ? "State PVI" : "州 PVI") : (en ? "National PVI" : "全國 PVI")}</div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-4 text-sm">
                    {/* ACS Census */}
                    <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                      <div className="flex items-start gap-3 mb-2">
                        <div className="w-2 h-2 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                        <div>
                          <div className="text-neutral-200 font-medium">
                            {en ? "U.S. Census Bureau — ACS" : "美國人口調查局 — ACS"}
                          </div>
                          <div className="text-neutral-500 text-[11px] mt-0.5">
                            {src?.demographics ?? "ACS 2024 5-year (via censusreporter.org)"}
                          </div>
                        </div>
                      </div>
                      <div className="text-neutral-400 text-xs leading-relaxed ml-5">
                        <p className="mb-1.5">
                          {isState
                            ? (en
                              ? `Covering ${sel?.region ?? "state"}: ${countyCount} counties, population ${fmtPop}.`
                              : `涵蓋${sel?.region ?? "州"}：${countyCount} 個縣，人口 ${fmtPop}。`)
                            : (en
                              ? `Covering ${stateCount} states + ${countyCount} counties, population ${fmtPop}.`
                              : `涵蓋 ${stateCount} 州 + ${countyCount} 個縣，人口 ${fmtPop}。`)}
                        </p>
                        <div className="text-neutral-500">
                          <span className="text-neutral-400">{en ? "Dimensions: " : "維度："}</span>
                          {en
                            ? "Gender, Age (7 brackets), Race (7 categories, B02001), Hispanic/Latino (B03003), Education (4 levels), Household Income (7 brackets, B19001), Household Type (B11001), Employment (5 categories), Housing tenure, Media habit"
                            : "性別、年齡（7 區間）、種族（7 類，B02001）、西語裔（B03003）、教育（4 級）、家庭收入（7 區間，B19001）、家庭類型（B11001）、就業（5 類）、住房、媒體習慣"}
                        </div>
                        <div className="text-neutral-500 mt-1">
                          <span className="text-neutral-400">{en ? "Tables: " : "表格："}</span>
                          B01001, B15003, B19001, B23025, B25003
                        </div>
                      </div>
                    </div>

                    {/* MEDSL Elections */}
                    <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                      <div className="flex items-start gap-3 mb-2">
                        <div className="w-2 h-2 rounded-full bg-red-400 mt-1.5 shrink-0" />
                        <div>
                          <div className="text-neutral-200 font-medium">
                            {en ? "MIT Election Data — MEDSL" : "MIT 選舉資料 — MEDSL"}
                          </div>
                          <div className="text-neutral-500 text-[11px] mt-0.5">
                            {src?.elections ?? "MEDSL countypres_2000-2024 (Harvard Dataverse)"} · CC0 1.0
                          </div>
                        </div>
                      </div>
                      <div className="text-neutral-400 text-xs leading-relaxed ml-5">
                        {en
                          ? `County-level presidential results for ${isState ? sel?.region : "all states"} (2020 + 2024). Used to compute partisan lean.`
                          : `${isState ? sel?.region : "全國"}縣級總統選舉結果（2020 + 2024），用於計算黨派傾向。`}
                      </div>
                    </div>

                    {/* Cook PVI */}
                    <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                      <div className="flex items-start gap-3 mb-2">
                        <div className="w-2 h-2 rounded-full bg-purple-400 mt-1.5 shrink-0" />
                        <div>
                          <div className="text-neutral-200 font-medium">
                            {en ? "Cook Partisan Voting Index (PVI)" : "Cook 黨派投票指數 (PVI)"}
                          </div>
                          <div className="text-neutral-500 text-[11px] mt-0.5">
                            {src?.leaning ?? "Cook PVI computed from 2020+2024 two-party share"}
                          </div>
                        </div>
                      </div>
                      <div className="text-neutral-400 text-xs leading-relaxed ml-5">
                        <p className="mb-1.5">
                          {isState
                            ? (en
                              ? `${sel?.region}: ${countyCount} counties, overall ${pviLabel ?? "—"}.`
                              : `${sel?.region}：${countyCount} 個縣，整體 ${pviLabel ?? "—"}。`)
                            : (en
                              ? `${cwl ?? countyCount} counties with computed PVI. National baseline: ${pviLabel ?? "R+0"}.`
                              : `${cwl ?? countyCount} 個縣有計算 PVI，全國基線：${pviLabel ?? "R+0"}。`)}
                        </p>
                        <div className="text-neutral-500">
                          <span className="text-neutral-400">{en ? "Formula: " : "公式："}</span>
                          {en
                            ? "mean(county Dem 2-party% − national Dem%) across 2020 & 2024"
                            : "2020/2024（縣民主黨兩黨得票率 − 全國民主黨得票率）平均值"}
                        </div>
                        <div className="text-neutral-500 mt-1">
                          <span className="text-neutral-400">{en ? "5 buckets: " : "5 分類："}</span>
                          Solid D · Lean D · Tossup · Lean R · Solid R
                        </div>
                      </div>
                    </div>

                    {/* Geography */}
                    <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                      <div className="flex items-start gap-3 mb-2">
                        <div className="w-2 h-2 rounded-full bg-green-400 mt-1.5 shrink-0" />
                        <div>
                          <div className="text-neutral-200 font-medium">
                            {en ? "Geographic Boundaries" : "地理邊界"}
                          </div>
                          <div className="text-neutral-500 text-[11px] mt-0.5">
                            us-atlas v3 · jsdelivr CDN · TopoJSON → GeoJSON
                          </div>
                        </div>
                      </div>
                      <div className="text-neutral-400 text-xs leading-relaxed ml-5">
                        {isState
                          ? (en
                            ? `${countyCount} county boundaries for ${sel?.region}. Linked via 5-digit FIPS codes.`
                            : `${sel?.region} ${countyCount} 個縣邊界，以 5 碼 FIPS 關聯。`)
                          : (en
                            ? "3,233 county + 56 state features (including territories). Linked via 5-digit FIPS codes."
                            : "3,233 個縣 + 56 個州特徵（含領地），以 5 碼 FIPS 關聯。")}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              );
            })()}
          </div>
        )}

        {/* Step 3: Generate Personas */}
        {step === 3 && (() => {
          /* ── Persona color helpers ── */
          const leanColor = (lean: string) => {
            if (lean?.includes("Solid") && lean?.includes("Dem")) return "#2563eb";
            if (lean?.includes("Lean") && lean?.includes("Dem")) return "#60a5fa";
            if (lean?.includes("Tossup") || lean?.includes("Swing")) return "#a855f7";
            if (lean?.includes("Lean") && lean?.includes("Rep")) return "#f87171";
            if (lean?.includes("Solid") && lean?.includes("Rep")) return "#dc2626";
            return "#6b7280";
          };

          /* ── Stats computation ── */
          const computeStats = () => {
            const count = (arr: any[], key: string) => {
              const m: Record<string, number> = {};
              arr.forEach((a) => { const v = a[key] ?? "Unknown"; m[v] = (m[v] ?? 0) + 1; });
              return Object.entries(m).sort((a, b) => b[1] - a[1]);
            };
            return {
              gender: count(personas, "gender"),
              race: count(personas, "race"),
              hispanic: count(personas, "hispanic_or_latino"),
              income: count(personas, "household_income"),
              householdType: count(personas, "household_type"),
              state: count(personas, "district"),
              education: count(personas, "education"),
              political: count(personas, "political_leaning"),
              media: count(personas, "media_habit"),
              age: (() => {
                const buckets: Record<string, number> = { "18-24": 0, "25-34": 0, "35-44": 0, "45-54": 0, "55-64": 0, "65+": 0 };
                personas.forEach((a) => {
                  const age = a.age ?? 0;
                  if (age < 25) buckets["18-24"]++;
                  else if (age < 35) buckets["25-34"]++;
                  else if (age < 45) buckets["35-44"]++;
                  else if (age < 55) buckets["45-54"]++;
                  else if (age < 65) buckets["55-64"]++;
                  else buckets["65+"]++;
                });
                return Object.entries(buckets);
              })(),
            };
          };

          return (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              {en ? "Generate Personas" : "生成 Persona"}
            </h2>
            <p className="text-neutral-500 text-sm mb-6">
              {en
                ? "Create synthetic agents based on your template's demographic data."
                : "根據模板的人口統計資料，建立合成代理人。"}
            </p>

            <div className="bg-[#16213e] rounded-lg p-4 mb-4 border border-[#0f3460]">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-neutral-400">{en ? "Target count" : "目標數量"}</span>
                <input
                  className="w-20 bg-[#0f3460] text-[#e94560] text-sm text-right rounded px-2 py-0.5 border-none outline-none font-medium"
                  type="number"
                  min={10}
                  max={1000}
                  value={targetCount}
                  onChange={(e) => setTargetCount(Number(e.target.value) || 100)}
                  disabled={generating || personaDone}
                />
              </div>
            </div>

            {/* ── Animated persona blocks grid ── */}
            {(generating || personaDone) && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-neutral-500 text-xs">
                    {progress ? `${progress.done}/${progress.total}` : "0/0"}{" "}
                    {en ? "personas" : "persona"}
                    {generating && " ..."}
                  </span>
                  {personas.length > 0 && (
                    <button
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                      onClick={() => setShowStats(true)}
                    >
                      {en ? "View Statistics" : "查看統計"}
                    </button>
                  )}
                </div>
                {/* Blocks grid */}
                <div className="bg-[#0f1729] rounded-lg border border-[#2a3554] p-3">
                  <div className="flex flex-wrap gap-1">
                    {personas.map((p, i) => (
                      <div
                        key={p.person_id ?? i}
                        className={`w-5 h-5 rounded-sm cursor-pointer transition-all duration-150 ${
                          hoveredPersona?.person_id === p.person_id
                            ? "scale-[1.8] ring-1 ring-white/50 z-10"
                            : "hover:scale-150 hover:z-10"
                        }`}
                        style={{
                          backgroundColor: leanColor(p.political_leaning),
                          animation: `fadeInScale 0.3s ease-out ${Math.min(i * 0.02, 2)}s both`,
                        }}
                        onMouseEnter={() => setHoveredPersona(p)}
                        onMouseLeave={() => setHoveredPersona(null)}
                      />
                    ))}
                    {/* Placeholder blocks with loading animation */}
                    {generating && Array.from({ length: Math.max(0, targetCount - personas.length) }).map((_, i) => (
                      <div
                        key={`ph-${i}`}
                        className="w-5 h-5 rounded-sm"
                        style={{
                          backgroundColor: `rgba(100,116,139,${i < 5 ? 0.5 : 0.2})`,
                          animation: i < 5 ? `pulse 1.2s ease-in-out ${i * 0.15}s infinite` : undefined,
                        }}
                      />
                    ))}
                  </div>
                  {/* Loading indicator when generating but no personas yet */}
                  {generating && personas.length === 0 && (
                    <div className="flex items-center justify-center gap-2 py-4">
                      <div className="w-4 h-4 border-2 border-[#e94560] border-t-transparent rounded-full animate-spin" />
                      <span className="text-neutral-500 text-xs">{en ? "Synthesizing population..." : "合成人口中..."}</span>
                    </div>
                  )}
                </div>

                {/* ── Persona detail panel (fixed at bottom of viewport) ── */}
                {hoveredPersona && (() => {
                  const p = hoveredPersona;
                  return (
                    <div className="fixed bottom-0 left-0 right-0 z-[55] pointer-events-none">
                      <div className="max-w-3xl mx-auto px-4 pb-4 pointer-events-auto">
                        <div className="bg-[#0f1729]/95 backdrop-blur-sm rounded-xl border border-[#3b4c6b] p-4 shadow-2xl">
                          {/* Header */}
                          <div className="flex items-center gap-3 mb-3">
                            <div
                              className="w-8 h-8 rounded-md shrink-0"
                              style={{ backgroundColor: leanColor(p.political_leaning) }}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-neutral-200 font-semibold text-sm">
                                {p.name ?? `Persona #${p.person_id}`}
                              </div>
                              <div className="text-neutral-500 text-[11px] truncate">
                                {p.description || p.user_char || ""}
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-4 gap-4">
                            {/* Demographics */}
                            <div>
                              <div className="text-neutral-500 text-[10px] uppercase tracking-wider mb-1.5">{en ? "Demographics" : "人口特徵"}</div>
                              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                                <span className="text-neutral-500">{en ? "Age" : "年齡"}</span>
                                <span className="text-neutral-300">{p.age}</span>
                                <span className="text-neutral-500">{en ? "Gender" : "性別"}</span>
                                <span className="text-neutral-300">{localize(p.gender)}</span>
                                <span className="text-neutral-500">{en ? "State" : "州"}</span>
                                <span className="text-neutral-300">{p.district}</span>
                                {p.race && <>
                                  <span className="text-neutral-500">{en ? "Race" : "種族"}</span>
                                  <span className="text-neutral-300 truncate">{localize(p.race)}</span>
                                </>}
                                {p.hispanic_or_latino && <>
                                  <span className="text-neutral-500">{en ? "Ethnicity" : "族裔"}</span>
                                  <span className="text-neutral-300 truncate">{localize(p.hispanic_or_latino)}</span>
                                </>}
                                <span className="text-neutral-500">{en ? "Edu" : "教育"}</span>
                                <span className="text-neutral-300 truncate">{localize(p.education)}</span>
                                <span className="text-neutral-500">{en ? "Work" : "就業"}</span>
                                <span className="text-neutral-300 truncate">{localize(p.occupation)}</span>
                                {(p.household_income || p.income_band) && <>
                                  <span className="text-neutral-500">{en ? "Income" : "收入"}</span>
                                  <span className="text-neutral-300 truncate">{localize(p.household_income || p.income_band)}</span>
                                </>}
                                {p.household_type && <>
                                  <span className="text-neutral-500">{en ? "Household" : "家庭"}</span>
                                  <span className="text-neutral-300 truncate">{localize(p.household_type)}</span>
                                </>}
                              </div>
                            </div>

                            {/* Political */}
                            <div>
                              <div className="text-neutral-500 text-[10px] uppercase tracking-wider mb-1.5">{en ? "Political" : "政治"}</div>
                              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                                <span className="text-neutral-500">{en ? "Lean" : "傾向"}</span>
                                <span className="font-medium" style={{ color: leanColor(p.political_leaning) }}>{p.political_leaning}</span>
                                <span className="text-neutral-500">{en ? "Media" : "媒體"}</span>
                                <span className="text-neutral-300 truncate">{localize(p.media_habit)}</span>
                                {p.llm_vendor && <>
                                  <span className="text-neutral-500">LLM</span>
                                  <span className="text-neutral-300 truncate">{p.llm_vendor}</span>
                                </>}
                              </div>
                            </div>

                            {/* Personality */}
                            {p.personality && (
                              <div>
                                <div className="text-neutral-500 text-[10px] uppercase tracking-wider mb-1.5">{en ? "Personality" : "個性"}</div>
                                <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                                  {p.personality.expressiveness && <>
                                    <span className="text-neutral-500">{en ? "Expr" : "表達"}</span>
                                    <span className="text-neutral-300">{localize(p.personality.expressiveness)}</span>
                                  </>}
                                  {p.personality.emotional_stability && <>
                                    <span className="text-neutral-500">{en ? "Stab" : "穩定"}</span>
                                    <span className="text-neutral-300">{localize(p.personality.emotional_stability)}</span>
                                  </>}
                                  {p.personality.sociability && <>
                                    <span className="text-neutral-500">{en ? "Social" : "社交"}</span>
                                    <span className="text-neutral-300">{localize(p.personality.sociability)}</span>
                                  </>}
                                  {p.personality.openness && <>
                                    <span className="text-neutral-500">{en ? "Open" : "開放"}</span>
                                    <span className="text-neutral-300">{localize(p.personality.openness)}</span>
                                  </>}
                                </div>
                              </div>
                            )}

                            {/* Individuality */}
                            {p.individuality && (
                              <div>
                                <div className="text-neutral-500 text-[10px] uppercase tracking-wider mb-1.5">{en ? "Individuality" : "個體化"}</div>
                                <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                                  {p.individuality.cognitive_bias && <>
                                    <span className="text-neutral-500">{en ? "Bias" : "偏誤"}</span>
                                    <span className="text-neutral-300">{localize(p.individuality.cognitive_bias)}</span>
                                  </>}
                                  {p.individuality.noise_scale != null && <>
                                    <span className="text-neutral-500">{en ? "Noise" : "雜訊"}</span>
                                    <span className="text-neutral-300">{p.individuality.noise_scale.toFixed(2)}</span>
                                  </>}
                                  {p.individuality.temperature_offset != null && <>
                                    <span className="text-neutral-500">{en ? "Temp" : "溫度"}</span>
                                    <span className="text-neutral-300">{p.individuality.temperature_offset > 0 ? "+" : ""}{p.individuality.temperature_offset.toFixed(2)}</span>
                                  </>}
                                  {p.individuality.memory_inertia != null && <>
                                    <span className="text-neutral-500">{en ? "Inertia" : "慣性"}</span>
                                    <span className="text-neutral-300">{p.individuality.memory_inertia.toFixed(2)}</span>
                                  </>}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {keyError && (
              <div className="text-red-400 text-sm mb-4">{keyError}</div>
            )}

            {!personaDone ? (
              <button
                className="w-full bg-green-600 hover:bg-green-700 text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-40"
                disabled={generating}
                onClick={generatePersonas}
              >
                {generating
                  ? (en ? "Generating..." : "生成中...")
                  : (en ? "Generate Personas" : "生成 Persona")}
              </button>
            ) : (
              <div className="flex gap-3">
                <button
                  className="flex-1 bg-[#16213e] hover:bg-[#1a2744] text-neutral-300 py-2.5 rounded-lg font-medium transition-colors border border-[#2a3554]"
                  onClick={() => setShowStats(true)}
                >
                  {en ? "View Statistics" : "查看統計"}
                </button>
                <button
                  className="flex-1 bg-[#e94560] hover:bg-[#d63851] text-white py-2.5 rounded-lg font-medium transition-colors"
                  onClick={() => setStep(4)}
                >
                  {en ? "Next →" : "下一步 →"}
                </button>
              </div>
            )}

            {/* ── Statistics Modal ── */}
            {showStats && personas.length > 0 && (() => {
              const stats = computeStats();
              const BarChart = ({ title, data, color }: { title: string; data: [string, number][]; color: string }) => {
                const max = Math.max(...data.map(([, v]) => v), 1);
                return (
                  <div className="mb-5">
                    <div className="text-neutral-300 text-xs font-medium mb-2">{title}</div>
                    <div className="space-y-1">
                      {data.slice(0, 10).map(([label, count]) => (
                        <div key={label} className="flex items-center gap-2 text-[10px]">
                          <span className="text-neutral-400 w-28 text-right truncate shrink-0">{label}</span>
                          <div className="flex-1 bg-neutral-800 rounded-full h-3 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${(count / max) * 100}%`, backgroundColor: color }}
                            />
                          </div>
                          <span className="text-neutral-500 w-8 shrink-0">{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              };
              return (
                <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-6" onClick={() => setShowStats(false)}>
                  <div
                    className="bg-[#0f1729] border border-[#2a3554] rounded-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto p-6 shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between mb-5">
                      <h3 className="text-lg font-semibold text-white">
                        {en ? "Persona Statistics" : "Persona 統計"}
                        <span className="text-neutral-500 text-sm font-normal ml-2">({personas.length})</span>
                      </h3>
                      <button className="text-neutral-500 hover:text-white text-lg" onClick={() => setShowStats(false)}>✕</button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
                      <BarChart title={en ? "Political Leaning" : "政治傾向"} data={stats.political} color="#e94560" />
                      <BarChart title={en ? "Age Distribution" : "年齡分佈"} data={stats.age} color="#60a5fa" />
                      <BarChart title={en ? "Gender" : "性別"} data={stats.gender} color="#a78bfa" />
                      <BarChart title={en ? "Race" : "種族"} data={stats.race} color="#f59e0b" />
                      <BarChart title={en ? "Hispanic/Latino" : "西語裔"} data={stats.hispanic} color="#14b8a6" />
                      <BarChart title={en ? "State" : "州別"} data={stats.state} color="#34d399" />
                      <BarChart title={en ? "Education" : "教育程度"} data={stats.education} color="#fbbf24" />
                      <BarChart title={en ? "Household Income" : "家庭收入"} data={stats.income} color="#22d3ee" />
                      <BarChart title={en ? "Household Type" : "家庭類型"} data={stats.householdType} color="#c084fc" />
                      <BarChart title={en ? "Media Habit" : "媒體習慣"} data={stats.media} color="#f472b6" />
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Keyframe styles */}
            <style jsx>{`
              @keyframes fadeInScale {
                from { opacity: 0; transform: scale(0); }
                to { opacity: 1; transform: scale(1); }
              }
            `}</style>
          </div>
          );
        })()}

        {/* Step 4: Ready */}
        {step === 4 && (
          <div className="text-center">
            <div className="text-5xl mb-4">🎉</div>
            <h2 className="text-xl font-semibold text-white mb-2">
              {en ? "You're All Set!" : "設定完成！"}
            </h2>
            <p className="text-neutral-500 text-sm mb-8">
              {en
                ? "Your project is ready. Here's what to do next:"
                : "專案已準備就緒，以下是接下來的步驟："}
            </p>

            <div className="space-y-3 text-left max-w-md mx-auto mb-8">
              <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                <div className="text-green-400 text-sm font-medium">
                  ✓ {progress?.done ?? targetCount} {en ? "Personas Generated" : "Persona 已生成"}
                </div>
              </div>
              <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                <div className="text-neutral-200 text-sm">
                  {en ? "Next:" : "下一步："}{" "}
                  <strong className="text-[#e94560]">{en ? "Evolution" : "演化"}</strong>
                </div>
                <div className="text-neutral-500 text-xs mt-1">
                  {en
                    ? "Feed news to your agents and let them form opinions over simulated days."
                    : "餵入新聞讓代理人在模擬時間中形成觀點。"}
                </div>
              </div>
              <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                <div className="text-neutral-200 text-sm">
                  {en ? "Then:" : "然後："}{" "}
                  <strong className="text-neutral-400">{en ? "Prediction" : "預測"}</strong>
                </div>
                <div className="text-neutral-500 text-xs mt-1">
                  {en
                    ? "Run poll predictions and analyze election outcomes."
                    : "執行民調預測並分析選舉結果。"}
                </div>
              </div>
            </div>

            <button
              className="bg-[#e94560] hover:bg-[#d63851] text-white px-8 py-2.5 rounded-lg font-medium transition-colors"
              onClick={finishOnboarding}
            >
              {en ? "Enter Workspace →" : "進入工作區 →"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
