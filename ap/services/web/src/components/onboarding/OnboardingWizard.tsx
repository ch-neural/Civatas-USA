// ap/services/web/src/components/onboarding/OnboardingWizard.tsx
"use client";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useLocaleStore } from "@/store/locale-store";
import { useShellStore } from "@/store/shell-store";
import { useQueryClient } from "@tanstack/react-query";

// Vendor type presets
const VENDOR_PRESETS: Record<string, { label: string; defaultModel: string; keyUrl: string }> = {
  openai:   { label: "OpenAI",   defaultModel: "gpt-4o",           keyUrl: "https://platform.openai.com/api-keys" },
  gemini:   { label: "Gemini",   defaultModel: "gemini-2.5-flash", keyUrl: "https://aistudio.google.com/apikey" },
  xai:      { label: "xAI",      defaultModel: "grok-3-mini",      keyUrl: "https://console.x.ai/" },
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-chat",    keyUrl: "https://platform.deepseek.com/api_keys" },
  moonshot: { label: "Moonshot", defaultModel: "moonshot-v1-auto",  keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  ollama:   { label: "Ollama",   defaultModel: "llama3",           keyUrl: "" },
};

interface VendorConfig {
  id: string;
  vendor_type: string;
  display_name: string;
  api_key: string;
  model: string;
  base_url: string;
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
}

export function OnboardingWizard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const en = useLocaleStore((s) => s.locale) === "en";
  const [step, setStep] = useState(1);

  // Step 1: API Keys
  const [vendors, setVendors] = useState<VendorConfig[]>([
    { id: "openai-1", vendor_type: "openai", display_name: "OpenAI", api_key: "", model: "gpt-4o", base_url: "" },
  ]);
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

  // Add vendor
  const addVendor = () => {
    const usedTypes = vendors.map((v) => v.vendor_type);
    const availableType = Object.keys(VENDOR_PRESETS).find((t) => !usedTypes.includes(t)) || "openai";
    const preset = VENDOR_PRESETS[availableType];
    setVendors([
      ...vendors,
      {
        id: `${availableType}-${Date.now()}`,
        vendor_type: availableType,
        display_name: preset.label,
        api_key: "",
        model: preset.defaultModel,
        base_url: "",
      },
    ]);
  };

  const updateVendor = (idx: number, updates: Partial<VendorConfig>) => {
    setVendors((prev) => prev.map((v, i) => {
      if (i !== idx) return v;
      const updated = { ...v, ...updates };
      // Auto-fill defaults when vendor_type changes
      if (updates.vendor_type && updates.vendor_type !== v.vendor_type) {
        const preset = VENDOR_PRESETS[updates.vendor_type];
        updated.display_name = preset.label;
        updated.model = preset.defaultModel;
        updated.id = `${updates.vendor_type}-${Date.now()}`;
      }
      return updated;
    }));
  };

  const removeVendor = (idx: number) => {
    if (vendors.length <= 1) return;
    setVendors((prev) => prev.filter((_, i) => i !== idx));
  };

  // Test connection
  const testVendor = async (idx: number) => {
    const v = vendors[idx];
    setTestResults((prev) => ({ ...prev, [v.id]: "testing" }));
    try {
      // Save settings first, then check health
      await saveKeys(false);
      await apiFetch("/health");
      setTestResults((prev) => ({ ...prev, [v.id]: "ok" }));
    } catch {
      setTestResults((prev) => ({ ...prev, [v.id]: "fail" }));
    }
  };

  // Save API keys
  const saveKeys = async (advance = true) => {
    const validVendors = vendors.filter((v) => v.api_key.trim());
    if (validVendors.length === 0) {
      setKeyError(en ? "At least one LLM API key is required" : "至少需要一組 LLM API Key");
      return false;
    }
    if (!serperKey.trim()) {
      setKeyError(en ? "Serper API key is required for news search" : "Serper API Key 為必填（用於新聞搜尋）");
      return false;
    }
    setKeyError("");
    try {
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          llm_mode: "multi",
          llm_vendors: validVendors.map((v) => ({
            id: v.id,
            display_name: v.display_name,
            vendor_type: v.vendor_type,
            api_key: v.api_key,
            model: v.model,
            base_url: v.base_url,
          })),
          active_vendors: validVendors.map((v) => v.id),
          vendor_ratio: validVendors.map(() => "1").join(":"),
          serper_api_key: serperKey,
        }),
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
      const data = await apiFetch("/api/templates");
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

        {/* Step 1: API Keys */}
        {step === 1 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-1">
              {en ? "Configure API Keys" : "設定 API Key"}
            </h2>
            <p className="text-neutral-500 text-sm mb-6">
              {en
                ? "Add at least one LLM provider and your Serper key for news search."
                : "新增至少一個 LLM 供應商，以及用於新聞搜尋的 Serper Key。"}
            </p>

            {/* Vendor cards */}
            {vendors.map((v, idx) => (
              <div
                key={v.id}
                className="bg-[#16213e] rounded-lg p-4 mb-3 border border-[#0f3460]"
              >
                <div className="flex items-center gap-3 mb-3">
                  <select
                    className="bg-[#0f3460] text-neutral-300 text-sm rounded px-2 py-1.5 border-none outline-none"
                    value={v.vendor_type}
                    onChange={(e) => updateVendor(idx, { vendor_type: e.target.value })}
                  >
                    {Object.entries(VENDOR_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>{preset.label}</option>
                    ))}
                  </select>
                  <input
                    className="flex-1 bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none"
                    placeholder="Model"
                    value={v.model}
                    onChange={(e) => updateVendor(idx, { model: e.target.value })}
                  />
                  {vendors.length > 1 && (
                    <button
                      className="text-neutral-600 hover:text-red-400 text-sm"
                      onClick={() => removeVendor(idx)}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none font-mono"
                    type="password"
                    placeholder="API Key"
                    value={v.api_key}
                    onChange={(e) => updateVendor(idx, { api_key: e.target.value })}
                  />
                  <button
                    className="text-xs bg-[#0f3460] text-neutral-400 hover:text-white px-3 py-1.5 rounded transition-colors"
                    onClick={() => testVendor(idx)}
                  >
                    {testResults[v.id] === "testing"
                      ? "..."
                      : testResults[v.id] === "ok"
                      ? "✓ OK"
                      : testResults[v.id] === "fail"
                      ? "✕ Fail"
                      : en ? "Test" : "測試"}
                  </button>
                </div>
                {VENDOR_PRESETS[v.vendor_type]?.keyUrl && (
                  <a
                    href={VENDOR_PRESETS[v.vendor_type].keyUrl}
                    target="_blank"
                    rel="noopener"
                    className="text-[10px] text-blue-400 hover:underline mt-2 inline-block"
                  >
                    {en ? `Get ${VENDOR_PRESETS[v.vendor_type].label} API Key →` : `申請 ${VENDOR_PRESETS[v.vendor_type].label} API Key →`}
                  </a>
                )}
              </div>
            ))}

            <button
              className="text-sm text-green-400 hover:text-green-300 mb-6"
              onClick={addVendor}
            >
              + {en ? "Add another vendor" : "新增供應商"}
            </button>

            {/* Serper key */}
            <div className="bg-[#16213e] rounded-lg p-4 mb-4 border border-[#0f3460]">
              <div className="text-neutral-400 text-xs mb-2">
                Serper API Key <span className="text-[#e94560]">*</span>
              </div>
              <input
                className="w-full bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none font-mono"
                type="password"
                placeholder="Serper API Key"
                value={serperKey}
                onChange={(e) => setSerperKey(e.target.value)}
              />
              <a
                href="https://serper.dev/api-key"
                target="_blank"
                rel="noopener"
                className="text-[10px] text-blue-400 hover:underline mt-2 inline-block"
              >
                {en ? "Get Serper API Key (Google Search) →" : "申請 Serper API Key（Google 搜尋）→"}
              </a>
            </div>

            {keyError && (
              <div className="text-red-400 text-sm mb-4">{keyError}</div>
            )}

            <button
              className="w-full bg-[#e94560] hover:bg-[#d63851] text-white py-2.5 rounded-lg font-medium transition-colors"
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
