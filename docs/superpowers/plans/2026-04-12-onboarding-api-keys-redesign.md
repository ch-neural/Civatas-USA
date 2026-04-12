# Onboarding API Keys Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure onboarding wizard Step 1 and Settings Panel API Keys tab to separate LLM provider credentials from role assignment, using a 3-section accordion with progressive disclosure.

**Architecture:** Extract shared vendor presets and provider↔vendor conversion logic into a shared module. Rewrite OnboardingWizard Step 1 as an accordion with 3 sections (Providers → Roles → Serper). Restructure SettingsPanel API Keys tab to use the same provider→role model with additional advanced controls.

**Tech Stack:** React (Next.js), TypeScript, Tailwind CSS (OnboardingWizard), CSS-in-JS inline styles (SettingsPanel)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `ap/services/web/src/lib/vendor-presets.ts` | Create | Shared VENDOR_PRESETS, SYSTEM_MODEL_DEFAULTS, Provider/RoleAssignment types, conversion functions (providers+roles → VendorEntry[], VendorEntry[] → providers+roles) |
| `ap/services/web/src/components/onboarding/OnboardingWizard.tsx` | Modify | Rewrite Step 1 with accordion UI |
| `ap/services/web/src/components/panels/SettingsPanel.tsx` | Modify | Restructure API Keys tab |

---

### Task 1: Create shared vendor presets and conversion module

**Files:**
- Create: `ap/services/web/src/lib/vendor-presets.ts`

- [ ] **Step 1: Create vendor-presets.ts with types, presets, and conversion functions**

```typescript
// ap/services/web/src/lib/vendor-presets.ts

/* ─── Vendor presets ─── */
export const VENDOR_PRESETS: Record<string, {
  label: string;
  defaultModel: string;
  systemModel: string;
  keyUrl: string;
}> = {
  openai:   { label: "OpenAI",   defaultModel: "gpt-4o-mini",      systemModel: "o4-mini",          keyUrl: "https://platform.openai.com/api-keys" },
  gemini:   { label: "Gemini",   defaultModel: "gemini-2.5-flash", systemModel: "gemini-2.5-flash", keyUrl: "https://aistudio.google.com/apikey" },
  xai:      { label: "xAI",      defaultModel: "grok-3-mini",      systemModel: "grok-3-mini",      keyUrl: "https://console.x.ai/" },
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-chat",    systemModel: "deepseek-chat",    keyUrl: "https://platform.deepseek.com/api_keys" },
  moonshot: { label: "Moonshot", defaultModel: "kimi-k2.5",         systemModel: "kimi-k2.5",        keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  ollama:   { label: "Ollama",   defaultModel: "llama3",           systemModel: "llama3",           keyUrl: "" },
};

/* ─── Types ─── */
export interface Provider {
  id: string;
  vendor_type: string;
  display_name: string;
  api_key: string;
  base_url: string;
}

export interface RoleAssignment {
  provider_id: string;
  model: string;
}

export interface VendorEntry {
  id: string;
  display_name: string;
  vendor_type: string;
  api_key: string;
  api_key_hint?: string;
  model: string;
  base_url: string;
  temperature?: number | null;
}

/* ─── Conversion: providers + roles → backend VendorEntry[] + settings fields ─── */
export function buildSettingsPayload(
  providers: Provider[],
  systemLlm: RoleAssignment,
  agentLlms: RoleAssignment[],
  serperKey: string,
) {
  const vendorEntries: VendorEntry[] = [];

  // Agent LLM entries
  for (const agent of agentLlms) {
    const prov = providers.find((p) => p.id === agent.provider_id);
    if (!prov) continue;
    vendorEntries.push({
      id: prov.id,
      display_name: prov.display_name,
      vendor_type: prov.vendor_type,
      api_key: prov.api_key,
      model: agent.model,
      base_url: prov.base_url,
    });
  }

  // System LLM entry
  const sysProv = providers.find((p) => p.id === systemLlm.provider_id);
  if (sysProv) {
    // Check if same provider is already in agent list with same credentials
    const existingAgent = vendorEntries.find(
      (v) => v.vendor_type === sysProv.vendor_type && v.api_key === sysProv.api_key && v.base_url === sysProv.base_url,
    );
    if (!existingAgent || systemLlm.model !== existingAgent.model) {
      vendorEntries.push({
        id: "system-llm",
        display_name: `System (${VENDOR_PRESETS[sysProv.vendor_type]?.label ?? sysProv.vendor_type})`,
        vendor_type: sysProv.vendor_type,
        api_key: sysProv.api_key,
        model: systemLlm.model,
        base_url: sysProv.base_url,
      });
    }
  }

  const activeVendors = agentLlms
    .map((a) => a.provider_id)
    .filter((id) => providers.some((p) => p.id === id));

  // Determine system_vendor_id
  let systemVendorId = "system-llm";
  if (sysProv) {
    const existingAgent = vendorEntries.find(
      (v) => v.id !== "system-llm" && v.vendor_type === sysProv.vendor_type && v.api_key === sysProv.api_key && v.base_url === sysProv.base_url && v.model === systemLlm.model,
    );
    if (existingAgent) {
      systemVendorId = existingAgent.id;
      // Remove the system-llm entry since it duplicates an agent entry
      const sysIdx = vendorEntries.findIndex((v) => v.id === "system-llm");
      if (sysIdx >= 0) vendorEntries.splice(sysIdx, 1);
    }
  }

  return {
    llm_mode: "multi" as const,
    llm_vendors: vendorEntries,
    active_vendors: activeVendors,
    vendor_ratio: agentLlms.map(() => "1").join(":"),
    system_vendor_id: systemVendorId,
    serper_api_key: serperKey,
  };
}

/* ─── Conversion: backend settings → providers + roles ─── */
export function parseSettingsToProvidersAndRoles(settings: {
  llm_vendors: VendorEntry[];
  active_vendors: string[];
  system_vendor_id: string;
}) {
  const { llm_vendors, active_vendors, system_vendor_id } = settings;

  // Deduplicate vendors by (vendor_type, api_key, base_url) to get providers
  const providerMap = new Map<string, Provider>();
  for (const v of llm_vendors) {
    const dedupeKey = `${v.vendor_type}|${v.api_key}|${v.base_url}`;
    // Use the non-system entry's id if available, otherwise use whatever we have
    if (!providerMap.has(dedupeKey) || v.id !== "system-llm") {
      providerMap.set(dedupeKey, {
        id: v.id === "system-llm" ? `${v.vendor_type}-sys-${Date.now()}` : v.id,
        vendor_type: v.vendor_type,
        display_name: v.id === "system-llm"
          ? (VENDOR_PRESETS[v.vendor_type]?.label ?? v.vendor_type)
          : v.display_name,
        api_key: v.api_key,
        base_url: v.base_url,
      });
    }
  }
  const providers = Array.from(providerMap.values());

  // Build agent LLM assignments from active_vendors
  const agentLlms: RoleAssignment[] = [];
  for (const activeId of active_vendors) {
    const vendor = llm_vendors.find((v) => v.id === activeId);
    if (vendor) {
      const prov = providers.find(
        (p) => p.vendor_type === vendor.vendor_type && p.api_key === vendor.api_key && p.base_url === vendor.base_url,
      );
      if (prov) {
        agentLlms.push({ provider_id: prov.id, model: vendor.model });
      }
    }
  }

  // Build system LLM assignment
  let systemLlm: RoleAssignment = {
    provider_id: providers[0]?.id ?? "",
    model: VENDOR_PRESETS[providers[0]?.vendor_type]?.systemModel ?? "gpt-4o-mini",
  };
  if (system_vendor_id) {
    const sysVendor = llm_vendors.find((v) => v.id === system_vendor_id);
    if (sysVendor) {
      const prov = providers.find(
        (p) => p.vendor_type === sysVendor.vendor_type && p.api_key === sysVendor.api_key && p.base_url === sysVendor.base_url,
      );
      if (prov) {
        systemLlm = { provider_id: prov.id, model: sysVendor.model };
      }
    }
  }

  return { providers, systemLlm, agentLlms };
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Volumes/AI02/Civatas-USA/ap/services/web && npx tsc --noEmit src/lib/vendor-presets.ts 2>&1 | head -20`

If tsc is not available standalone, just check that the dev server doesn't break:
Run: `cd /Volumes/AI02/Civatas-USA/ap && docker compose exec web sh -c "cd /app && npx tsc --noEmit" 2>&1 | head -30`

- [ ] **Step 3: Commit**

```bash
git add ap/services/web/src/lib/vendor-presets.ts
git commit -m "feat: extract shared vendor presets and provider↔settings conversion module"
```

---

### Task 2: Rewrite OnboardingWizard Step 1 with accordion UI

**Files:**
- Modify: `ap/services/web/src/components/onboarding/OnboardingWizard.tsx`

This is the main task. Replace the entire Step 1 section (lines 46-548) with the new accordion-based UI. Steps 2-4 remain unchanged.

- [ ] **Step 1: Replace imports and vendor presets with shared module**

In `OnboardingWizard.tsx`, replace the local `VENDOR_PRESETS` and `VendorConfig` with imports from the shared module.

Remove lines 11-27 (the local `VENDOR_PRESETS` constant and `VendorConfig` interface).

Add import at the top:

```typescript
import {
  VENDOR_PRESETS,
  type Provider,
  type RoleAssignment,
  buildSettingsPayload,
} from "@/lib/vendor-presets";
```

- [ ] **Step 2: Replace Step 1 state variables**

Replace the old state variables (lines 47-56) with the new provider/role model:

```typescript
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
```

- [ ] **Step 3: Replace provider CRUD functions**

Replace `addVendor`, `updateVendor`, `removeVendor` with provider-based versions:

```typescript
const addProvider = () => {
  const usedTypes = providers.map((p) => p.vendor_type);
  const availableType = Object.keys(VENDOR_PRESETS).find((t) => !usedTypes.includes(t)) || "openai";
  const preset = VENDOR_PRESETS[availableType];
  const newId = `${availableType}-${Date.now()}`;
  setProviders([
    ...providers,
    { id: newId, vendor_type: availableType, display_name: preset.label, api_key: "", base_url: "" },
  ]);
  // Auto-add to agent LLMs
  setAgentLlms((prev) => [...prev, { provider_id: newId, model: preset.defaultModel }]);
};

const updateProvider = (idx: number, updates: Partial<Provider>) => {
  setProviders((prev) => prev.map((p, i) => {
    if (i !== idx) return p;
    const updated = { ...p, ...updates };
    if (updates.vendor_type && updates.vendor_type !== p.vendor_type) {
      const preset = VENDOR_PRESETS[updates.vendor_type];
      updated.display_name = preset.label;
      updated.id = `${updates.vendor_type}-${Date.now()}`;
      // Update role assignments that referenced old provider
      const oldId = p.id;
      setSystemLlm((s) => s.provider_id === oldId ? { provider_id: updated.id, model: preset.systemModel } : s);
      setAgentLlms((al) => al.map((a) => a.provider_id === oldId ? { provider_id: updated.id, model: preset.defaultModel } : a));
    }
    return updated;
  }));
};

const removeProvider = (idx: number) => {
  if (providers.length <= 1) return;
  const removedId = providers[idx].id;
  setProviders((prev) => prev.filter((_, i) => i !== idx));
  setAgentLlms((prev) => prev.filter((a) => a.provider_id !== removedId));
  setSystemLlm((prev) => prev.provider_id === removedId
    ? { provider_id: providers[idx === 0 ? 1 : 0].id, model: VENDOR_PRESETS[providers[idx === 0 ? 1 : 0].vendor_type]?.systemModel ?? "gpt-4o-mini" }
    : prev
  );
};
```

- [ ] **Step 4: Replace test functions**

Replace `testVendor` and `testSystemLlm` with a provider-based test:

```typescript
const testProvider = async (providerId: string) => {
  const p = providers.find((pr) => pr.id === providerId);
  if (!p || !p.api_key.trim()) {
    setTestResults((prev) => ({ ...prev, [providerId]: "fail" }));
    return;
  }
  setTestResults((prev) => ({ ...prev, [providerId]: "testing" }));
  try {
    const res = await apiFetch("/api/settings/test-vendor", {
      method: "POST",
      body: JSON.stringify({
        vendor_type: p.vendor_type,
        api_key: p.api_key,
        model: VENDOR_PRESETS[p.vendor_type]?.defaultModel ?? "gpt-4o-mini",
        base_url: p.base_url,
      }),
    });
    setTestResults((prev) => ({ ...prev, [providerId]: res.status === "ok" ? "ok" : "fail" }));
  } catch {
    setTestResults((prev) => ({ ...prev, [providerId]: "fail" }));
  }
};

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
```

- [ ] **Step 5: Replace saveKeys function**

```typescript
const saveKeys = async (advance = true) => {
  const validProviders = providers.filter((p) => p.api_key.trim());
  if (validProviders.length === 0) {
    setKeyError(en ? "At least one LLM provider with an API key is required" : "至少需要一個已填入 API Key 的 LLM 供應商");
    return false;
  }
  if (!serperKey.trim()) {
    setKeyError(en ? "Serper API key is required for news search" : "Serper API Key 為必填（用於新聞搜尋）");
    return false;
  }
  // Ensure system LLM references a valid provider
  if (!validProviders.some((p) => p.id === systemLlm.provider_id)) {
    setKeyError(en ? "System LLM must use a provider with a valid API key" : "系統 LLM 必須使用已設定 API Key 的供應商");
    return false;
  }
  // Ensure at least one agent LLM references a valid provider
  const validAgents = agentLlms.filter((a) => validProviders.some((p) => p.id === a.provider_id));
  if (validAgents.length === 0) {
    setKeyError(en ? "At least one Agent LLM must be selected" : "至少需要選擇一個 Agent LLM");
    return false;
  }
  setKeyError("");
  try {
    const payload = buildSettingsPayload(validProviders, systemLlm, validAgents, serperKey);
    await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
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
```

- [ ] **Step 6: Add accordion completion checks and section header helper**

Add these computed values and helper above the return statement:

```typescript
// Accordion section completion checks
const section1Complete = providers.some((p) => p.api_key.trim());
const section2Complete = section1Complete
  && systemLlm.provider_id !== ""
  && systemLlm.model.trim() !== ""
  && agentLlms.some((a) => providers.some((p) => p.id === a.provider_id));
const section3Complete = serperKey.trim() !== "";
const allComplete = section1Complete && section2Complete && section3Complete;

// Auto-advance: when a section completes, expand next
const handleSection1Change = () => {
  if (section1Complete && expandedSection === 1) setExpandedSection(2);
};

// Section header component
const SectionHeader = ({ num, title, subtitle, complete, locked, summary, onClick }: {
  num: number; title: string; subtitle: string; complete: boolean;
  locked: boolean; summary?: string; onClick?: () => void;
}) => (
  <div
    className={`flex items-center justify-between px-5 py-4 rounded-t-xl cursor-pointer transition-colors ${
      locked ? "opacity-50 cursor-not-allowed" : "hover:bg-[#1e2d50]"
    } bg-[#1a2744]`}
    onClick={locked ? undefined : onClick}
  >
    <div className="flex items-center gap-3">
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
        complete ? "bg-green-500 text-white" : locked ? "bg-[#2a3554] text-neutral-600" : "bg-[#e94560] text-white"
      }`}>
        {complete ? "✓" : num}
      </div>
      <div>
        <div className={`font-semibold text-[15px] ${locked ? "text-neutral-600" : "text-white"}`}>{title}</div>
        <div className={`text-xs ${locked ? "text-neutral-700" : "text-neutral-500"}`}>{subtitle}</div>
      </div>
    </div>
    <div className="text-xs text-neutral-500">
      {locked ? (en ? "🔒 Complete previous step" : "🔒 請先完成上一步") : complete ? <span className="text-green-400">{summary}</span> : expandedSection === num ? "▼" : "▶"}
    </div>
  </div>
);
```

- [ ] **Step 7: Replace Step 1 JSX with accordion layout**

Replace the entire `{step === 1 && (...)}` block with the new accordion UI:

```tsx
{step === 1 && (
  <div>
    <h2 className="text-xl font-semibold text-white mb-1">
      {en ? "Configure API Keys" : "設定 API Key"}
    </h2>
    <p className="text-neutral-500 text-sm mb-6">
      {en ? "Set up your LLM providers, assign roles, and add your search API key." : "設定 LLM 供應商、指定用途，並新增搜尋 API Key。"}
    </p>

    {/* ── Section 1: LLM Providers ── */}
    <div className="border border-[#3b4c6b] rounded-xl mb-4 overflow-hidden">
      <SectionHeader
        num={1}
        title={en ? "LLM Providers" : "LLM 供應商"}
        subtitle={en ? "Add your LLM vendor API keys" : "新增 LLM 供應商的 API Key"}
        complete={section1Complete}
        locked={false}
        summary={`${providers.filter((p) => p.api_key.trim()).length} ${en ? "providers configured" : "個供應商已設定"}`}
        onClick={() => setExpandedSection(1)}
      />
      {expandedSection === 1 && (
        <div className="p-5 border-t border-[#2a3554]">
          {providers.map((p, idx) => (
            <div key={p.id} className="bg-[#1a2744] rounded-lg p-4 mb-3">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex-shrink-0">
                  <div className="text-[11px] text-neutral-500 mb-1">{en ? "VENDOR" : "供應商"}</div>
                  <select
                    className="bg-[#0f1729] text-neutral-300 text-sm rounded px-3 py-2 border border-[#3b4c6b] outline-none"
                    value={p.vendor_type}
                    onChange={(e) => updateProvider(idx, { vendor_type: e.target.value })}
                  >
                    {Object.entries(VENDOR_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>{preset.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <div className="text-[11px] text-neutral-500 mb-1">API KEY</div>
                  <div className="flex gap-2">
                    <input
                      className="flex-1 bg-[#0f1729] text-neutral-300 text-sm rounded px-3 py-2 border border-[#3b4c6b] outline-none font-mono"
                      type="password"
                      placeholder="sk-..."
                      value={p.api_key}
                      onChange={(e) => {
                        updateProvider(idx, { api_key: e.target.value });
                        // Auto-advance when first key is entered
                        if (e.target.value.trim() && !section1Complete) {
                          setTimeout(() => handleSection1Change(), 100);
                        }
                      }}
                    />
                    <button
                      className="text-xs bg-[#2a3554] text-neutral-400 hover:text-white px-4 py-2 rounded transition-colors whitespace-nowrap"
                      onClick={() => testProvider(p.id)}
                    >
                      {testResults[p.id] === "testing" ? "..." : testResults[p.id] === "ok" ? "✓ OK" : testResults[p.id] === "fail" ? "✕ Fail" : en ? "Test" : "測試"}
                    </button>
                  </div>
                </div>
                {providers.length > 1 && (
                  <button className="text-neutral-600 hover:text-red-400 text-sm mt-5" onClick={() => removeProvider(idx)}>✕</button>
                )}
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <div className="text-[11px] text-neutral-500 mb-1">BASE URL <span className="text-neutral-700">{en ? "(optional)" : "（選填）"}</span></div>
                  <input
                    className="w-full bg-[#0f1729] text-neutral-300 text-sm rounded px-3 py-2 border border-[#3b4c6b] outline-none"
                    placeholder={en ? "Leave blank for default" : "留空使用預設"}
                    value={p.base_url}
                    onChange={(e) => updateProvider(idx, { base_url: e.target.value })}
                  />
                </div>
              </div>
              {VENDOR_PRESETS[p.vendor_type]?.keyUrl && (
                <a href={VENDOR_PRESETS[p.vendor_type].keyUrl} target="_blank" rel="noopener" className="text-[10px] text-blue-400 hover:underline mt-2 inline-block">
                  {en ? `Get ${VENDOR_PRESETS[p.vendor_type].label} API Key →` : `申請 ${VENDOR_PRESETS[p.vendor_type].label} API Key →`}
                </a>
              )}
            </div>
          ))}
          <button
            className="w-full text-center py-2 text-sm text-blue-400 border border-dashed border-[#3b4c6b] rounded-lg hover:border-blue-400 transition-colors"
            onClick={addProvider}
          >
            + {en ? "Add another provider" : "新增供應商"}
          </button>
        </div>
      )}
    </div>

    {/* ── Section 2: Assign LLM Roles ── */}
    <div className={`border rounded-xl mb-4 overflow-hidden ${section1Complete ? "border-[#3b4c6b]" : "border-[#2a3554]"}`}>
      <SectionHeader
        num={2}
        title={en ? "Assign LLM Roles" : "指定 LLM 用途"}
        subtitle={en ? "Set System LLM and Agent LLM" : "設定系統 LLM 與代理人 LLM"}
        complete={section2Complete}
        locked={!section1Complete}
        summary={`System: ${VENDOR_PRESETS[providers.find((p) => p.id === systemLlm.provider_id)?.vendor_type ?? ""]?.label ?? "?"} ${systemLlm.model} · Agent: ${agentLlms.length} ${en ? "models" : "個模型"}`}
        onClick={() => section1Complete && setExpandedSection(2)}
      />
      {expandedSection === 2 && section1Complete && (
        <div className="p-5 border-t border-[#2a3554]">
          {/* System LLM */}
          <div className="mb-5">
            <div className="font-semibold text-sm text-white mb-1">{en ? "System LLM" : "系統 LLM"}</div>
            <div className="text-neutral-500 text-xs mb-3">
              {en
                ? "Used for news analysis, data parsing, and other system tasks. A capable thinking model is recommended."
                : "用於新聞分析、資料解析等系統任務。建議使用較強的推理模型。"}
            </div>
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-40">
                <div className="text-[11px] text-neutral-500 mb-1">{en ? "PROVIDER" : "供應商"}</div>
                <select
                  className="w-full bg-[#0f1729] text-neutral-300 text-sm rounded px-3 py-2 border border-[#3b4c6b] outline-none"
                  value={systemLlm.provider_id}
                  onChange={(e) => {
                    const prov = providers.find((p) => p.id === e.target.value);
                    setSystemLlm({
                      provider_id: e.target.value,
                      model: VENDOR_PRESETS[prov?.vendor_type ?? ""]?.systemModel ?? "gpt-4o-mini",
                    });
                  }}
                >
                  {providers.filter((p) => p.api_key.trim()).map((p) => (
                    <option key={p.id} value={p.id}>{p.display_name}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <div className="text-[11px] text-neutral-500 mb-1">MODEL</div>
                <input
                  className="w-full bg-[#0f1729] text-neutral-300 text-sm rounded px-3 py-2 border border-[#3b4c6b] outline-none"
                  value={systemLlm.model}
                  onChange={(e) => setSystemLlm({ ...systemLlm, model: e.target.value })}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-[#2a3554] mb-5" />

          {/* Agent LLM */}
          <div>
            <div className="font-semibold text-sm text-white mb-1">{en ? "Agent LLM" : "代理人 LLM"}</div>
            <div className="text-neutral-500 text-xs mb-3">
              {en
                ? "Used for persona generation and agent simulation. Select one or more providers."
                : "用於人設生成與代理人模擬。可選擇一個或多個供應商。"}
            </div>
            <div className="flex flex-col gap-2">
              {providers.filter((p) => p.api_key.trim()).map((p) => {
                const assignment = agentLlms.find((a) => a.provider_id === p.id);
                const isChecked = !!assignment;
                return (
                  <div
                    key={p.id}
                    className={`flex items-center gap-3 rounded-lg p-3 transition-colors ${
                      isChecked ? "bg-[#1a2744] border border-blue-500" : "bg-[#1a2744] border border-[#2a3554] opacity-70"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded flex items-center justify-center cursor-pointer flex-shrink-0 ${
                        isChecked ? "bg-blue-500 text-white text-sm" : "border-2 border-[#3b4c6b]"
                      }`}
                      onClick={() => {
                        if (isChecked) {
                          // Don't allow unchecking last one
                          if (agentLlms.length <= 1) return;
                          setAgentLlms((prev) => prev.filter((a) => a.provider_id !== p.id));
                        } else {
                          setAgentLlms((prev) => [...prev, { provider_id: p.id, model: VENDOR_PRESETS[p.vendor_type]?.defaultModel ?? "gpt-4o-mini" }]);
                        }
                      }}
                    >
                      {isChecked && "✓"}
                    </div>
                    <div className="flex-1 font-medium text-sm text-neutral-300">{p.display_name}</div>
                    <div className="w-44">
                      <div className="text-[11px] text-neutral-500 mb-1">MODEL</div>
                      <input
                        className="w-full bg-[#0f1729] text-neutral-300 text-sm rounded px-2 py-1.5 border border-[#3b4c6b] outline-none"
                        value={assignment?.model ?? VENDOR_PRESETS[p.vendor_type]?.defaultModel ?? ""}
                        disabled={!isChecked}
                        onChange={(e) => {
                          setAgentLlms((prev) => prev.map((a) => a.provider_id === p.id ? { ...a, model: e.target.value } : a));
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>

    {/* ── Section 3: Search API ── */}
    <div className={`border rounded-xl mb-6 overflow-hidden ${section2Complete ? "border-[#3b4c6b]" : "border-[#2a3554]"}`}>
      <SectionHeader
        num={3}
        title={en ? "Search API" : "搜尋 API"}
        subtitle={en ? "Serper API key for news search" : "用於新聞搜尋的 Serper API Key"}
        complete={section3Complete}
        locked={!section2Complete}
        summary={en ? "Configured" : "已設定"}
        onClick={() => section2Complete && setExpandedSection(3)}
      />
      {expandedSection === 3 && section2Complete && (
        <div className="p-5 border-t border-[#2a3554]">
          <div className="flex items-center gap-2 mb-2">
            <input
              className="flex-1 bg-[#0f1729] text-neutral-300 text-sm rounded px-3 py-2 border border-[#3b4c6b] outline-none font-mono"
              type="password"
              placeholder="Serper API Key"
              value={serperKey}
              onChange={(e) => setSerperKey(e.target.value)}
            />
            <button
              className="text-xs bg-[#2a3554] text-neutral-400 hover:text-white px-4 py-2 rounded transition-colors whitespace-nowrap"
              onClick={testSerper}
            >
              {testResults.serper === "testing" ? "..." : testResults.serper === "ok" ? "✓ OK" : testResults.serper === "fail" ? "✕ Fail" : en ? "Test" : "測試"}
            </button>
          </div>
          <a href="https://serper.dev/api-key" target="_blank" rel="noopener" className="text-[10px] text-blue-400 hover:underline">
            {en ? "Get Serper API Key (Google Search) →" : "申請 Serper API Key（Google 搜尋）→"}
          </a>
        </div>
      )}
    </div>

    {keyError && <div className="text-red-400 text-sm mb-4">{keyError}</div>}

    <button
      className={`w-full py-2.5 rounded-lg font-medium transition-colors ${
        allComplete
          ? "bg-[#e94560] hover:bg-[#d63851] text-white"
          : "bg-[#4a3040] text-[#8b6070] cursor-not-allowed"
      }`}
      disabled={!allComplete}
      onClick={() => saveKeys()}
    >
      {en ? "Next: Create Project →" : "下一步：建立專案 →"}
    </button>
  </div>
)}
```

- [ ] **Step 8: Verify the wizard renders**

Start the dev server and open http://localhost:3100 in a browser. Verify:
1. Accordion Section 1 opens by default with one OpenAI provider card
2. Sections 2 and 3 are locked (grey, not clickable)
3. After entering an API key in Section 1, Section 2 auto-opens
4. Section 2 shows System LLM dropdown + Agent LLM checkboxes
5. After completing Section 2, Section 3 auto-opens
6. "Next: Create Project →" button is disabled until all 3 sections complete
7. Clicking a completed section header re-opens it for editing

Run: `cd /Volumes/AI02/Civatas-USA/ap && docker compose up --build web`

- [ ] **Step 9: Commit**

```bash
git add ap/services/web/src/components/onboarding/OnboardingWizard.tsx
git commit -m "feat: rewrite onboarding Step 1 with accordion UI separating providers from roles"
```

---

### Task 3: Restructure SettingsPanel API Keys tab

**Files:**
- Modify: `ap/services/web/src/components/panels/SettingsPanel.tsx`

- [ ] **Step 1: Add imports from shared module**

Add at the top of `SettingsPanel.tsx`:

```typescript
import {
  VENDOR_PRESETS,
  type Provider,
  type RoleAssignment,
  type VendorEntry,
  buildSettingsPayload,
  parseSettingsToProvidersAndRoles,
} from "@/lib/vendor-presets";
```

- [ ] **Step 2: Add provider/role state derived from settings**

Add new state variables and a loading effect after the existing state declarations. The Settings Panel works differently from onboarding — it loads existing settings and converts them to the provider/role model for editing, then converts back on save.

Add after the `loadSettings` useCallback (around line 68):

```typescript
// Provider / role state (derived from settings on load)
const [editProviders, setEditProviders] = useState<Provider[]>([]);
const [editSystemLlm, setEditSystemLlm] = useState<RoleAssignment>({ provider_id: "", model: "" });
const [editAgentLlms, setEditAgentLlms] = useState<RoleAssignment[]>([]);
const [editSerperKey, setEditSerperKey] = useState("");
const [editLlmMode, setEditLlmMode] = useState("multi");
const [editVendorRatio, setEditVendorRatio] = useState("1");
const [editPrimaryId, setEditPrimaryId] = useState("");
const [editFallbackId, setEditFallbackId] = useState("");
const [providerTestResults, setProviderTestResults] = useState<Record<string, "ok" | "fail" | "testing">>({});

// Sync settings → edit state when settings load
useEffect(() => {
  if (!settings) return;
  const { providers, systemLlm, agentLlms } = parseSettingsToProvidersAndRoles(settings as any);
  setEditProviders(providers);
  setEditSystemLlm(systemLlm);
  setEditAgentLlms(agentLlms.length > 0 ? agentLlms : providers.length > 0
    ? [{ provider_id: providers[0].id, model: VENDOR_PRESETS[providers[0].vendor_type]?.defaultModel ?? "gpt-4o-mini" }]
    : []);
  setEditSerperKey((settings as any).serper_api_key || "");
  setEditLlmMode(settings.llm_mode || "multi");
  setEditVendorRatio(settings.vendor_ratio || "1");
  setEditPrimaryId(settings.primary_vendor_id || "");
  setEditFallbackId(settings.fallback_vendor_id || "");
}, [settings]);
```

- [ ] **Step 3: Add provider CRUD and test functions for settings panel**

Add these functions after the edit state declarations:

```typescript
const addSettingsProvider = () => {
  const usedTypes = editProviders.map((p) => p.vendor_type);
  const availableType = Object.keys(VENDOR_PRESETS).find((t) => !usedTypes.includes(t)) || "openai";
  const preset = VENDOR_PRESETS[availableType];
  const newId = `${availableType}-${Date.now()}`;
  setEditProviders([
    ...editProviders,
    { id: newId, vendor_type: availableType, display_name: preset.label, api_key: "", base_url: "" },
  ]);
};

const removeSettingsProvider = (id: string) => {
  setEditProviders((prev) => prev.filter((p) => p.id !== id));
  setEditAgentLlms((prev) => prev.filter((a) => a.provider_id !== id));
  if (editSystemLlm.provider_id === id) {
    const remaining = editProviders.filter((p) => p.id !== id);
    if (remaining.length > 0) {
      setEditSystemLlm({ provider_id: remaining[0].id, model: VENDOR_PRESETS[remaining[0].vendor_type]?.systemModel ?? "" });
    }
  }
  if (editPrimaryId === id) setEditPrimaryId("");
  if (editFallbackId === id) setEditFallbackId("");
};

const testSettingsProvider = async (providerId: string) => {
  const p = editProviders.find((pr) => pr.id === providerId);
  if (!p || !p.api_key.trim()) {
    setProviderTestResults((prev) => ({ ...prev, [providerId]: "fail" }));
    return;
  }
  setProviderTestResults((prev) => ({ ...prev, [providerId]: "testing" }));
  try {
    const res = await apiFetch("/api/settings/test-vendor", {
      method: "POST",
      body: JSON.stringify({
        vendor_type: p.vendor_type,
        api_key: p.api_key,
        model: VENDOR_PRESETS[p.vendor_type]?.defaultModel ?? "gpt-4o-mini",
        base_url: p.base_url,
      }),
    });
    setProviderTestResults((prev) => ({ ...prev, [providerId]: res.status === "ok" ? "ok" : "fail" }));
  } catch {
    setProviderTestResults((prev) => ({ ...prev, [providerId]: "fail" }));
  }
};
```

- [ ] **Step 4: Replace handleSave to use buildSettingsPayload**

Replace the existing `handleSave` function:

```typescript
const handleSave = async () => {
  if (!settings) return;
  setSaving(true);
  setSaveMsg("");
  try {
    const payload = buildSettingsPayload(editProviders, editSystemLlm, editAgentLlms, editSerperKey);
    // Override with advanced settings
    const fullPayload = {
      ...payload,
      llm_mode: editLlmMode,
      vendor_ratio: editVendorRatio,
      primary_vendor_id: editPrimaryId,
      fallback_vendor_id: editFallbackId,
    };
    await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify(fullPayload) });
    setSaveMsg("✓ 已儲存");
    setTimeout(() => setSaveMsg(""), 3000);
    await loadSettings();
  } catch (e: any) {
    setSaveMsg(`✗ ${e.message || "儲存失敗"}`);
  } finally {
    setSaving(false);
  }
};
```

- [ ] **Step 5: Replace the API Keys tab JSX**

Replace the entire `{activeTab === "llm" && (...)}` block with the new provider→role layout. This is the full replacement:

```tsx
{activeTab === "llm" && (
  <>
    {/* ── LLM Providers ── */}
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div className="label" style={{ fontSize: 13 }}>LLM {locale === "en" ? "Providers" : "供應商"}</div>
        <button
          onClick={addSettingsProvider}
          style={{
            background: "rgba(108,92,231,0.15)", border: "1px solid rgba(108,92,231,0.3)",
            color: "var(--accent-light)", borderRadius: 8, padding: "6px 14px",
            fontSize: 12, fontWeight: 600, fontFamily: "var(--font-cjk)", cursor: "pointer",
          }}
        >
          ＋ {locale === "en" ? "Add Provider" : "新增供應商"}
        </button>
      </div>

      {editProviders.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <p style={{ fontFamily: "var(--font-cjk)", fontSize: 14, color: "var(--text-muted)" }}>
            {locale === "en" ? "No providers configured" : "尚未設定任何供應商"}
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {editProviders.map((p, idx) => (
            <div key={p.id} className="card" style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                    {p.display_name}
                  </span>
                  <span style={{
                    padding: "1px 6px", borderRadius: 4, fontSize: 10,
                    background: "rgba(255,255,255,0.06)", color: "var(--text-muted)",
                  }}>{VENDOR_PRESETS[p.vendor_type]?.label || p.vendor_type}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-sans)" }}>
                  🔑 {p.api_key ? `***${p.api_key.slice(-4)}` : (p as any).api_key_hint || "(未設定)"}
                  {p.base_url && <span style={{ marginLeft: 12 }}>🌐 {p.base_url.replace(/^https?:\/\//, "").slice(0, 30)}</span>}
                </div>
              </div>
              <button
                onClick={() => testSettingsProvider(p.id)}
                style={{
                  background: "rgba(255,255,255,0.06)", border: "1px solid var(--border-subtle)",
                  borderRadius: 6, padding: "4px 12px", fontSize: 11, cursor: "pointer",
                  color: providerTestResults[p.id] === "ok" ? "var(--green)" : providerTestResults[p.id] === "fail" ? "var(--pink)" : "var(--text-muted)",
                }}
              >
                {providerTestResults[p.id] === "testing" ? "..." : providerTestResults[p.id] === "ok" ? "✓ OK" : providerTestResults[p.id] === "fail" ? "✕ Fail" : "Test"}
              </button>
              <button
                onClick={() => setEditingVendor({
                  id: p.id, display_name: p.display_name, vendor_type: p.vendor_type,
                  api_key: p.api_key, model: "", base_url: p.base_url, temperature: null,
                })}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}
                title={locale === "en" ? "Edit" : "編輯"}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" /></svg>
              </button>
              <button
                onClick={() => removeSettingsProvider(p.id)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", padding: 4 }}
                title={locale === "en" ? "Delete" : "刪除"}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 5h10M6 5V3h4v2M5 5v8h6V5" /></svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>

    {/* ── System LLM ── */}
    <div style={{ marginBottom: 24, padding: 16, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <div className="label" style={{ fontSize: 13, marginBottom: 4 }}>🧠 {locale === "en" ? "System LLM" : "系統 LLM"}</div>
      <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)", marginBottom: 8, lineHeight: 1.5 }}>
        {locale === "en" ? "Used for news analysis, data parsing, and other system tasks." : "用於新聞分析、資料解析等系統級任務。"}
      </p>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: "0 0 200px" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{locale === "en" ? "PROVIDER" : "供應商"}</div>
          <select
            className="input-field"
            value={editSystemLlm.provider_id}
            onChange={(e) => {
              const prov = editProviders.find((p) => p.id === e.target.value);
              setEditSystemLlm({
                provider_id: e.target.value,
                model: VENDOR_PRESETS[prov?.vendor_type ?? ""]?.systemModel ?? "",
              });
            }}
            style={{ color: "var(--text-secondary)" }}
          >
            {editProviders.map((p) => (
              <option key={p.id} value={p.id}>{p.display_name}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>MODEL</div>
          <input
            className="input-field"
            value={editSystemLlm.model}
            onChange={(e) => setEditSystemLlm({ ...editSystemLlm, model: e.target.value })}
          />
        </div>
      </div>
    </div>

    {/* ── Agent LLM ── */}
    <div style={{ marginBottom: 24, padding: 16, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <div className="label" style={{ fontSize: 13, marginBottom: 4 }}>🤖 {locale === "en" ? "Agent LLM" : "代理人 LLM"}</div>
      <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)", marginBottom: 8, lineHeight: 1.5 }}>
        {locale === "en" ? "Used for persona generation and agent simulation. Select one or more providers." : "用於人設生成與代理人模擬。可選擇一個或多個供應商。"}
      </p>

      {/* Agent provider checkboxes */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
        {editProviders.map((p) => {
          const assignment = editAgentLlms.find((a) => a.provider_id === p.id);
          const isChecked = !!assignment;
          return (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderRadius: 8,
              background: isChecked ? "rgba(59,130,246,0.08)" : "transparent",
              border: `1px solid ${isChecked ? "rgba(59,130,246,0.4)" : "var(--border-subtle)"}`,
              opacity: isChecked ? 1 : 0.6,
            }}>
              <div
                onClick={() => {
                  if (isChecked) {
                    if (editAgentLlms.length <= 1) return;
                    setEditAgentLlms((prev) => prev.filter((a) => a.provider_id !== p.id));
                  } else {
                    setEditAgentLlms((prev) => [...prev, { provider_id: p.id, model: VENDOR_PRESETS[p.vendor_type]?.defaultModel ?? "" }]);
                  }
                }}
                style={{
                  width: 18, height: 18, borderRadius: 4, cursor: "pointer", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: isChecked ? "#3b82f6" : "transparent",
                  border: isChecked ? "none" : "2px solid var(--border-input)",
                  color: "white", fontSize: 12,
                }}
              >{isChecked && "✓"}</div>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: "var(--text-primary)", fontFamily: "var(--font-cjk)" }}>{p.display_name}</span>
              <div style={{ width: 180 }}>
                <input
                  className="input-field"
                  value={assignment?.model ?? VENDOR_PRESETS[p.vendor_type]?.defaultModel ?? ""}
                  disabled={!isChecked}
                  onChange={(e) => setEditAgentLlms((prev) => prev.map((a) => a.provider_id === p.id ? { ...a, model: e.target.value } : a))}
                  style={{ fontSize: 12, opacity: isChecked ? 1 : 0.4 }}
                  placeholder="Model"
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Mode selector */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>{locale === "en" ? "MODE" : "使用模式"}</div>
        <div style={{ display: "flex", gap: 8 }}>
          {[
            { key: "multi", label: locale === "en" ? "Multi (ratio-based)" : "多組共用（比例分配）" },
            { key: "primary_fallback", label: locale === "en" ? "Primary + Fallback" : "主要＋備援" },
          ].map((opt) => (
            <div
              key={opt.key}
              onClick={() => setEditLlmMode(opt.key)}
              style={{
                flex: 1, padding: "8px 12px", borderRadius: 8, cursor: "pointer", textAlign: "center",
                fontSize: 12, fontFamily: "var(--font-cjk)", fontWeight: 500,
                background: editLlmMode === opt.key ? "var(--accent-bg)" : "transparent",
                border: `1px solid ${editLlmMode === opt.key ? "var(--accent-border)" : "var(--border-subtle)"}`,
                color: editLlmMode === opt.key ? "var(--accent-light)" : "var(--text-muted)",
              }}
            >{opt.label}</div>
          ))}
        </div>
      </div>

      {/* Ratio (multi mode) */}
      {editLlmMode === "multi" && editAgentLlms.length > 1 && (
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
            {locale === "en" ? "Ratio (e.g. 1:1:2)" : "分配比例（如 1:1:2）"}
          </div>
          <input
            className="input-field"
            value={editVendorRatio}
            onChange={(e) => setEditVendorRatio(e.target.value)}
            placeholder="1:1"
            style={{ maxWidth: 200, fontSize: 12 }}
          />
        </div>
      )}

      {/* Primary/Fallback (primary_fallback mode) */}
      {editLlmMode === "primary_fallback" && editAgentLlms.length > 1 && (
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{locale === "en" ? "Primary" : "主要"}</div>
            <select
              className="input-field"
              value={editPrimaryId}
              onChange={(e) => setEditPrimaryId(e.target.value)}
              style={{ color: "var(--text-secondary)", fontSize: 12 }}
            >
              <option value="">{locale === "en" ? "— Select —" : "— 選擇 —"}</option>
              {editAgentLlms.map((a) => {
                const p = editProviders.find((pr) => pr.id === a.provider_id);
                return p ? <option key={p.id} value={p.id}>{p.display_name} ({a.model})</option> : null;
              })}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{locale === "en" ? "Fallback" : "備援"}</div>
            <select
              className="input-field"
              value={editFallbackId}
              onChange={(e) => setEditFallbackId(e.target.value)}
              style={{ color: "var(--text-secondary)", fontSize: 12 }}
            >
              <option value="">{locale === "en" ? "— Select —" : "— 選擇 —"}</option>
              {editAgentLlms.filter((a) => a.provider_id !== editPrimaryId).map((a) => {
                const p = editProviders.find((pr) => pr.id === a.provider_id);
                return p ? <option key={p.id} value={p.id}>{p.display_name} ({a.model})</option> : null;
              })}
            </select>
          </div>
        </div>
      )}
    </div>

    {/* ── Search API ── */}
    <div style={{ marginBottom: 24, padding: 16, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-cjk)" }}>🔍 Serper (Google Search)</span>
        <a href="https://serper.dev" target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: "var(--accent-light)", textDecoration: "none" }}>serper.dev →</a>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="password"
          className="input-field"
          style={{ flex: 1, fontSize: 12 }}
          placeholder={locale === "en" ? "Serper API Key" : "輸入 Serper API Key"}
          value={editSerperKey}
          onChange={(e) => setEditSerperKey(e.target.value)}
        />
        <span style={{ fontSize: 10, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
          {editSerperKey ? "✓" : "✗"} {editSerperKey ? (locale === "en" ? "Set" : "已設定") : (locale === "en" ? "Not set" : "未設定")}
        </span>
      </div>
    </div>

    {/* Onboarding reset */}
    <div className="border-t border-neutral-700 mt-6 pt-4">
      <button
        className="text-sm text-neutral-500 hover:text-[#e94560] transition-colors"
        onClick={async () => {
          await apiFetch("/api/settings", {
            method: "PUT",
            body: JSON.stringify({ onboarding_completed: false }),
          });
          window.location.reload();
        }}
      >
        {locale === "en" ? "Re-run Onboarding Wizard" : "重新執行設定精靈"}
      </button>
    </div>
  </>
)}
```

- [ ] **Step 6: Update VendorEditModal onSave to sync back to providers**

The existing `VendorEditModal` is used for editing provider details in the Settings Panel. Update the `saveVendor` callback to sync changes back to `editProviders`:

Replace the existing `saveVendor` function:

```typescript
const saveVendor = (vendor: VendorEntry) => {
  // Sync vendor edit back to editProviders
  setEditProviders((prev) => {
    const idx = prev.findIndex((p) => p.id === vendor.id);
    const updated: Provider = {
      id: vendor.id,
      vendor_type: vendor.vendor_type,
      display_name: vendor.display_name,
      api_key: vendor.api_key,
      base_url: vendor.base_url,
    };
    if (idx >= 0) {
      return prev.map((p, i) => i === idx ? updated : p);
    } else {
      return [...prev, updated];
    }
  });
  setEditingVendor(null);
};
```

- [ ] **Step 7: Remove old vendor CRUD functions that are no longer used**

Remove these functions that have been replaced:
- `addVendor` (old, line ~94) — replaced by `addSettingsProvider`
- `removeVendor` (old, line ~130) — replaced by `removeSettingsProvider`
- `toggleActive` (old, line ~141) — replaced by checkbox UI in Agent LLM section

- [ ] **Step 8: Verify the Settings Panel renders**

Open http://localhost:3100, navigate to Settings (gear icon). Verify:
1. **API Keys tab** shows: LLM Providers section → System LLM → Agent LLM → Search API
2. Provider list shows existing vendors with Test / Edit / Delete buttons
3. System LLM dropdown lists providers; selecting one auto-fills system model
4. Agent LLM checkboxes work; model input per provider
5. Mode selector (multi / primary+fallback) and ratio/primary/fallback controls work
6. Save persists correctly — reload page and settings are preserved

- [ ] **Step 9: Commit**

```bash
git add ap/services/web/src/components/panels/SettingsPanel.tsx
git commit -m "feat: restructure Settings Panel API Keys tab with provider→role layout"
```

---

### Task 4: End-to-end verification

- [ ] **Step 1: Reset onboarding and test full flow**

Reset onboarding flag and reload:

```bash
cd /Volumes/AI02/Civatas-USA/ap
docker compose exec api python -c "
from shared.global_settings import load_settings, save_settings
s = load_settings()
s['onboarding_completed'] = False
s['llm_vendors'] = []
s['active_vendors'] = []
s['system_vendor_id'] = ''
s['serper_api_key'] = ''
save_settings(s)
print('Reset done')
"
```

Then reload http://localhost:3100 and walk through:
1. Accordion Section 1: add an OpenAI provider with API key → Test → OK
2. Section 2 auto-opens: System LLM defaulted to OpenAI/o4-mini, Agent LLM checkbox checked for OpenAI/gpt-4o-mini
3. Section 3 auto-opens: enter Serper key → Test → OK
4. "Next: Create Project →" button enables → click → proceeds to Step 2
5. Complete Steps 2-4 normally
6. After onboarding, go to Settings → API Keys → verify provider/role layout matches what was configured

- [ ] **Step 2: Test multi-provider scenario**

In Settings Panel:
1. Add a second provider (e.g. Gemini) with API key
2. Check both in Agent LLM section
3. Set ratio to 1:1
4. Save → reload → verify both providers and assignments persist

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found during end-to-end verification"
```
