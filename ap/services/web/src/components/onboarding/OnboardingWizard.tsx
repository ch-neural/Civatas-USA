// ap/services/web/src/components/onboarding/OnboardingWizard.tsx
"use client";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useLocaleStore } from "@/store/locale-store";
import { useShellStore } from "@/store/shell-store";
import { useQueryClient } from "@tanstack/react-query";

import {
  VENDOR_PRESETS,
  type Provider,
  type RoleAssignment,
  buildSettingsPayload,
} from "@/lib/vendor-presets";

interface TemplateInfo {
  id: string;
  name: string;
  region?: string;
  region_code?: string;
  country?: string;
  scope?: string;
  cycle?: string;
  candidate_count?: number;
}

export function OnboardingWizard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const en = useLocaleStore((s) => s.locale) === "en";
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
  // Accordion state
  const [expandedSection, setExpandedSection] = useState<1 | 2 | 3>(1);

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

  // Accordion section completion
  const section1Complete = providers.some((p) => p.api_key.trim() !== "");
  const section2Complete =
    section1Complete &&
    !!systemLlm.provider_id &&
    !!systemLlm.model &&
    agentLlms.length >= 1 &&
    agentLlms.every((a) => !!a.provider_id && !!a.model);
  const section3Complete = serperKey.trim() !== "";
  const allComplete = section1Complete && section2Complete && section3Complete;

  const providersWithKey = providers.filter((p) => p.api_key.trim() !== "");

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
        // Auto-advance to section 2 when first key is entered
        if (updates.api_key && updates.api_key.trim() && !prev.some((pp) => pp.api_key.trim())) {
          setTimeout(() => setExpandedSection(2), 300);
        }
        return next;
      });
      return updated;
    });
  };

  const removeProvider = (idx: number) => {
    if (providers.length <= 1) return;
    const removedId = providers[idx].id;
    setProviders((prev) => prev.filter((_, i) => i !== idx));
    setAgentLlms((prev) => {
      const filtered = prev.filter((a) => a.provider_id !== removedId);
      return filtered.length > 0 ? filtered : prev;
    });
    setSystemLlm((prev) => {
      if (prev.provider_id === removedId) {
        // Fall back to first remaining provider
        const remaining = providers.filter((_, i) => i !== idx);
        if (remaining.length > 0) {
          const preset = VENDOR_PRESETS[remaining[0].vendor_type];
          return { provider_id: remaining[0].id, model: preset?.systemModel ?? "" };
        }
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
    if (!section1Complete) {
      setKeyError(en ? "At least one LLM API key is required" : "至少需要一組 LLM API Key");
      return false;
    }
    if (!section2Complete) {
      setKeyError(en ? "Please assign system and agent LLM roles" : "請指定系統與 Agent LLM 角色");
      return false;
    }
    if (!serperKey.trim()) {
      setKeyError(en ? "Serper API key is required for news search" : "Serper API Key 為必填（用於新聞搜尋）");
      return false;
    }
    setKeyError("");
    try {
      const payload = buildSettingsPayload(providers, systemLlm, agentLlms, serperKey);
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (advance) {
        loadTemplates();
        setStep(2);
      }
      return true;
    } catch (e: any) {
      setKeyError(e.message || "Failed to save");
      return false;
    }
  };

  // Load templates
  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const raw = await apiFetch("/api/templates");
      const data: TemplateInfo[] = Array.isArray(raw) ? raw : raw.templates ?? [];
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
      await apiFetch(`/api/workspaces/${wsId}/apply-template`, {
        method: "POST",
        body: JSON.stringify({ template_id: selectedTemplate }),
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

      // Poll progress
      const poll = async () => {
        try {
          const p = await apiFetch(`/api/workspaces/${createdWsId}/persona-progress`);
          setProgress({ done: p.done ?? 0, total: p.total ?? targetCount });
          if (p.done >= p.total || p.status === "done" || p.status === "completed") {
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
    router.push(`/workspaces/${createdWsId}/population-setup`);
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

        {/* Step 1: API Keys — Accordion */}
        {step === 1 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              {en ? "Configure API Keys" : "設定 API Key"}
            </h2>
            <p className="text-neutral-500 text-sm mb-6">
              {en
                ? "Add at least one LLM provider, assign roles, and enter your Serper key."
                : "新增至少一個 LLM 供應商、指定角色，並輸入 Serper Key。"}
            </p>

            {/* --- Section Header helper --- */}
            {(() => {
              const SectionHeader = ({
                num,
                title,
                subtitle,
                complete,
                locked,
                summary,
                onClick,
              }: {
                num: 1 | 2 | 3;
                title: string;
                subtitle: string;
                complete: boolean;
                locked: boolean;
                summary?: string;
                onClick: () => void;
              }) => {
                const isExpanded = expandedSection === num;
                return (
                  <button
                    type="button"
                    className={`w-full flex items-center gap-3 p-3 rounded-t-lg transition-colors ${
                      locked ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-[#16213e]/60"
                    } ${isExpanded ? "" : "rounded-b-lg"}`}
                    onClick={() => { if (!locked) onClick(); }}
                    disabled={locked}
                  >
                    {/* Numbered circle */}
                    <div
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                        complete
                          ? "bg-green-500 text-white"
                          : isExpanded
                          ? "bg-[#e94560] text-white"
                          : "bg-neutral-700 text-neutral-400"
                      }`}
                    >
                      {complete ? "✓" : num}
                    </div>
                    {/* Title + subtitle */}
                    <div className="flex-1 text-left">
                      <div className="text-sm font-medium text-neutral-200">{title}</div>
                      <div className="text-[11px] text-neutral-500">{subtitle}</div>
                    </div>
                    {/* Right indicator */}
                    <div className="text-xs text-neutral-500 shrink-0">
                      {locked ? (
                        <span className="text-neutral-600">{en ? "Complete above first" : "請先完成上方步驟"}</span>
                      ) : complete && !isExpanded && summary ? (
                        <span className="text-green-400">{summary}</span>
                      ) : (
                        <span>{isExpanded ? "▼" : "▶"}</span>
                      )}
                    </div>
                  </button>
                );
              };

              return (
                <div className="space-y-3">
                  {/* ═══ Section 1: LLM Providers ═══ */}
                  <div className={`rounded-lg border ${expandedSection === 1 ? "border-[#3b4c6b]" : section1Complete ? "border-[#3b4c6b]" : "border-[#2a3554]"} bg-[#0f1729]`}>
                    <SectionHeader
                      num={1}
                      title={en ? "LLM Providers" : "LLM 供應商"}
                      subtitle={en ? "Add API keys for your LLM services" : "新增 LLM 服務的 API Key"}
                      complete={section1Complete}
                      locked={false}
                      summary={
                        section1Complete
                          ? `${providersWithKey.length} ${en ? "provider(s)" : "個供應商"}`
                          : undefined
                      }
                      onClick={() => setExpandedSection(1)}
                    />
                    {expandedSection === 1 && (
                      <div className="px-3 pb-4 space-y-3">
                        {providers.map((p, idx) => (
                          <div
                            key={p.id}
                            className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]"
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
                    )}
                  </div>

                  {/* ═══ Section 2: Assign LLM Roles ═══ */}
                  <div className={`rounded-lg border ${!section1Complete ? "border-[#2a3554]" : "border-[#3b4c6b]"} bg-[#0f1729]`}>
                    <SectionHeader
                      num={2}
                      title={en ? "Assign LLM Roles" : "指定 LLM 角色"}
                      subtitle={en ? "Choose which providers handle system vs agent tasks" : "選擇系統與 Agent 任務的供應商"}
                      complete={section2Complete}
                      locked={!section1Complete}
                      summary={
                        section2Complete
                          ? `${en ? "System" : "系統"}: ${systemLlm.model}, ${agentLlms.length} ${en ? "agent(s)" : "個 Agent"}`
                          : undefined
                      }
                      onClick={() => setExpandedSection(2)}
                    />
                    {expandedSection === 2 && section1Complete && (
                      <div className="px-3 pb-4 space-y-4">
                        {/* System LLM */}
                        <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                          <div className="text-neutral-400 text-xs mb-1">
                            {en ? "System LLM" : "系統 LLM"}{" "}
                            <span className="text-neutral-600">
                              {en ? "(news analysis, data parsing, etc.)" : "（新聞分析、資料解析等）"}
                            </span>
                          </div>
                          <div className="text-neutral-500 text-[10px] mb-3">
                            {en
                              ? "A capable thinking model is recommended."
                              : "建議使用較強的推理模型。"}
                          </div>
                          <div className="flex items-center gap-3">
                            <select
                              className="bg-[#0f3460] text-neutral-300 text-sm rounded px-2 py-1.5 border-none outline-none"
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
                              className="flex-1 bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none"
                              placeholder="Model"
                              value={systemLlm.model}
                              onChange={(e) => setSystemLlm((prev) => ({ ...prev, model: e.target.value }))}
                            />
                          </div>
                        </div>

                        {/* Divider */}
                        <div className="border-t border-[#2a3554]" />

                        {/* Agent LLMs */}
                        <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
                          <div className="text-neutral-400 text-xs mb-1">
                            {en ? "Agent LLM(s)" : "Agent LLM"}{" "}
                            <span className="text-neutral-600">
                              {en ? "(persona generation, opinion evolution)" : "（人格生成、觀點演化）"}
                            </span>
                          </div>
                          <div className="text-neutral-500 text-[10px] mb-3">
                            {en
                              ? "Select which providers to use for agent tasks. At least one is required."
                              : "選擇用於 Agent 任務的供應商，至少需要一個。"}
                          </div>
                          <div className="space-y-2">
                            {providersWithKey.map((p) => {
                              const isChecked = agentLlms.some((a) => a.provider_id === p.id);
                              const assignment = agentLlms.find((a) => a.provider_id === p.id);
                              const isLastChecked = isChecked && agentLlms.length === 1;
                              return (
                                <div key={p.id} className="flex items-center gap-3">
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    disabled={isLastChecked}
                                    className="accent-[#e94560]"
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        const preset = VENDOR_PRESETS[p.vendor_type];
                                        setAgentLlms((prev) => [
                                          ...prev,
                                          { provider_id: p.id, model: preset?.defaultModel ?? "" },
                                        ]);
                                      } else {
                                        setAgentLlms((prev) => prev.filter((a) => a.provider_id !== p.id));
                                      }
                                    }}
                                  />
                                  <span className="text-neutral-300 text-sm w-20 shrink-0">
                                    {p.display_name}
                                  </span>
                                  {isChecked && (
                                    <input
                                      className="flex-1 bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none"
                                      placeholder="Model"
                                      value={assignment?.model ?? ""}
                                      onChange={(e) => {
                                        const model = e.target.value;
                                        setAgentLlms((prev) =>
                                          prev.map((a) =>
                                            a.provider_id === p.id ? { ...a, model } : a,
                                          ),
                                        );
                                      }}
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ═══ Section 3: Search API ═══ */}
                  <div className={`rounded-lg border ${!section2Complete ? "border-[#2a3554]" : "border-[#3b4c6b]"} bg-[#0f1729]`}>
                    <SectionHeader
                      num={3}
                      title={en ? "Search API" : "搜尋 API"}
                      subtitle={en ? "Serper key for Google News search" : "用於 Google 新聞搜尋的 Serper Key"}
                      complete={section3Complete}
                      locked={!section2Complete}
                      summary={section3Complete ? (en ? "Key set" : "已設定") : undefined}
                      onClick={() => setExpandedSection(3)}
                    />
                    {expandedSection === 3 && section2Complete && (
                      <div className="px-3 pb-4">
                        <div className="bg-[#16213e] rounded-lg p-4 border border-[#0f3460]">
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
                  </div>
                </div>
              );
            })()}

            {keyError && (
              <div className="text-red-400 text-sm mt-4 mb-2">{keyError}</div>
            )}

            <button
              className={`w-full mt-6 py-2.5 rounded-lg font-medium transition-colors ${
                allComplete
                  ? "bg-[#e94560] hover:bg-[#d63851] text-white"
                  : "bg-neutral-700 text-neutral-500 cursor-not-allowed"
              }`}
              disabled={!allComplete}
              onClick={() => saveKeys()}
            >
              {en ? "Next: Create Project →" : "下一步：建立專案 →"}
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

            <div className="text-neutral-400 text-xs mb-2">
              {en ? "Select Template" : "選擇模板"}
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
          </div>
        )}

        {/* Step 3: Generate Personas */}
        {step === 3 && (
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

            {progress && (
              <div className="mb-4">
                <div className="bg-neutral-800 rounded-full h-2 overflow-hidden mb-1">
                  <div
                    className="bg-[#e94560] h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }}
                  />
                </div>
                <div className="text-neutral-500 text-xs">
                  {progress.done}/{progress.total} {en ? "personas generated" : "persona 已生成"}
                  {generating && " ..."}
                </div>
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
              <button
                className="w-full bg-[#e94560] hover:bg-[#d63851] text-white py-2.5 rounded-lg font-medium transition-colors"
                onClick={() => setStep(4)}
              >
                {en ? "Next →" : "下一步 →"}
              </button>
            )}
          </div>
        )}

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
