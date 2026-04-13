"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import AppearancePanel from "@/components/shell/AppearancePanel";
import { useLocaleStore } from "@/store/locale-store";
import {
  VENDOR_PRESETS,
  type Provider,
  type RoleAssignment,
  type VendorEntry,
  buildSettingsPayload,
  parseSettingsToProvidersAndRoles,
} from "@/lib/vendor-presets";

/* ─── Types ─── */
interface VendorType {
  value: string;
  label: string;
  default_base_url: string;
  default_model: string;
}

interface Settings {
  llm_mode: string;
  llm_vendors: VendorEntry[];
  active_vendors: string[];
  vendor_ratio: string;
  primary_vendor_id: string;
  fallback_vendor_id: string;
  system_vendor_id: string;
  serper_api_key: string;
  onboarding_completed: boolean;
}

/* ─── Constants ─── */
const TABS = [
  { key: "llm", labelEn: "API Keys", labelZh: "API 金鑰", icon: "🔑" },
  { key: "appearance", labelEn: "Appearance", labelZh: "外觀", icon: "🎨" },
];

/* ─── Component ─── */
export default function SettingsPanel() {
  const locale = useLocaleStore((s) => s.locale);
  const [activeTab, setActiveTab] = useState("llm");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [vendorTypes, setVendorTypes] = useState<VendorType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [editingVendor, setEditingVendor] = useState<VendorEntry | null>(null);
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

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const [s, vt] = await Promise.all([
        apiFetch("/api/settings"),
        apiFetch("/api/settings/vendor-types"),
      ]);
      setSettings(s);
      setVendorTypes(vt.types || []);
    } catch (e) {
      console.error("Failed to load settings", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  // Sync settings → edit state when settings load
  useEffect(() => {
    if (!settings) return;
    const { providers, systemLlm, agentLlms } = parseSettingsToProvidersAndRoles(settings);
    setEditProviders(providers);
    setEditSystemLlm(systemLlm);
    setEditAgentLlms(agentLlms.length > 0 ? agentLlms : providers.length > 0
      ? [{ provider_id: providers[0].id, model: VENDOR_PRESETS[providers[0].vendor_type]?.defaultModel ?? "gpt-4o-mini" }]
      : []);
    setEditSerperKey(settings.serper_api_key || "");
    setEditLlmMode(settings.llm_mode || "multi");
    setEditVendorRatio(settings.vendor_ratio || "1");
    setEditPrimaryId(settings.primary_vendor_id || "");
    setEditFallbackId(settings.fallback_vendor_id || "");
  }, [settings]);

  /* ─── Save ─── */
  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setSaveMsg("");
    try {
      const payload = buildSettingsPayload(editProviders, editSystemLlm, editAgentLlms, editSerperKey);
      // Merge in advanced settings (llm_mode, vendor_ratio, primary/fallback)
      const merged = {
        ...payload,
        llm_mode: editLlmMode,
        vendor_ratio: editVendorRatio,
        primary_vendor_id: editPrimaryId,
        fallback_vendor_id: editFallbackId,
      };
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify(merged),
      });
      setSaveMsg(locale === "en" ? "✓ Saved" : "✓ 已儲存");
      setTimeout(() => setSaveMsg(""), 3000);
      // Reload to get fresh data (masked keys etc.)
      await loadSettings();
    } catch (e: any) {
      setSaveMsg(`✗ ${e.message || (locale === "en" ? "Save failed" : "儲存失敗")}`);
    } finally {
      setSaving(false);
    }
  };

  /* ─── Provider CRUD ─── */
  const addSettingsProvider = () => {
    const vt = vendorTypes[0] || { value: "openai", label: "OpenAI", default_base_url: "", default_model: "gpt-4o-mini" };
    const preset = VENDOR_PRESETS[vt.value];
    const count = editProviders.filter(p => p.vendor_type === vt.value).length;
    const newId = count === 0 ? vt.value : `${vt.value}${count + 1}`;
    const entry: VendorEntry = {
      id: newId,
      display_name: count === 0 ? (preset?.label || vt.label) : `${preset?.label || vt.label} #${count + 1}`,
      vendor_type: vt.value,
      api_key: "",
      model: preset?.defaultModel || vt.default_model,
      base_url: vt.default_base_url,
      temperature: null,
    };
    setEditingVendor(entry);
  };

  const removeSettingsProvider = (id: string) => {
    setEditProviders(prev => prev.filter(p => p.id !== id));
    // Clean up role references
    setEditAgentLlms(prev => prev.filter(a => a.provider_id !== id));
    if (editSystemLlm.provider_id === id) {
      setEditSystemLlm({ provider_id: "", model: "" });
    }
    if (editPrimaryId === id) setEditPrimaryId("");
    if (editFallbackId === id) setEditFallbackId("");
  };

  const testSerperKey = async () => {
    if (!editSerperKey.trim() || editSerperKey.startsWith("***")) {
      setProviderTestResults(prev => ({ ...prev, serper: "fail" }));
      return;
    }
    setProviderTestResults(prev => ({ ...prev, serper: "testing" }));
    try {
      const res = await apiFetch("/api/settings/test-serper", {
        method: "POST",
        body: JSON.stringify({ api_key: editSerperKey }),
      });
      setProviderTestResults(prev => ({ ...prev, serper: res.status === "ok" ? "ok" : "fail" }));
    } catch {
      setProviderTestResults(prev => ({ ...prev, serper: "fail" }));
    }
  };

  const testSettingsProvider = async (providerId: string) => {
    const provider = editProviders.find(p => p.id === providerId);
    if (!provider || !provider.api_key.trim() || provider.api_key.startsWith("***")) {
      setProviderTestResults(prev => ({ ...prev, [providerId]: "fail" }));
      return;
    }
    setProviderTestResults(prev => ({ ...prev, [providerId]: "testing" }));
    try {
      // Find the model assigned to this provider (prefer agent, then system, then preset default)
      const agentAssignment = editAgentLlms.find(a => a.provider_id === providerId);
      const sysAssignment = editSystemLlm.provider_id === providerId ? editSystemLlm : null;
      const model = agentAssignment?.model || sysAssignment?.model || VENDOR_PRESETS[provider.vendor_type]?.defaultModel || "gpt-4o-mini";
      await apiFetch("/api/settings/test-vendor", {
        method: "POST",
        body: JSON.stringify({
          vendor_type: provider.vendor_type,
          api_key: provider.api_key,
          model,
          base_url: provider.base_url,
        }),
      });
      setProviderTestResults(prev => ({ ...prev, [providerId]: "ok" }));
    } catch {
      setProviderTestResults(prev => ({ ...prev, [providerId]: "fail" }));
    }
  };

  const saveVendor = (vendor: VendorEntry) => {
    // Sync back to editProviders
    const asProvider: Provider = {
      id: vendor.id,
      vendor_type: vendor.vendor_type,
      display_name: vendor.display_name,
      api_key: vendor.api_key,
      base_url: vendor.base_url,
    };
    const idx = editProviders.findIndex(p => p.id === vendor.id);
    if (idx >= 0) {
      const updated = [...editProviders];
      updated[idx] = asProvider;
      setEditProviders(updated);
    } else {
      setEditProviders(prev => [...prev, asProvider]);
      // Auto-add as agent LLM
      const preset = VENDOR_PRESETS[vendor.vendor_type];
      setEditAgentLlms(prev => [...prev, { provider_id: vendor.id, model: vendor.model || preset?.defaultModel || "gpt-4o-mini" }]);
      // If no system LLM set, auto-assign
      if (!editSystemLlm.provider_id) {
        setEditSystemLlm({ provider_id: vendor.id, model: preset?.systemModel || vendor.model || "gpt-4o-mini" });
      }
    }
    setEditingVendor(null);
  };

  /* ─── Render ─── */
  if (loading || !settings) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 20, height: 20, border: "2px solid var(--border-subtle)",
            borderTopColor: "var(--accent-light)", borderRadius: "50%",
            animation: "spin 0.8s linear infinite"
          }} />
          <span style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-tertiary)" }}>{locale === "en" ? "Loading settings..." : "載入設定中..."}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "auto" }}>
        {/* Save bar */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          padding: "16px clamp(16px, 2vw, 32px)", borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {saveMsg && (
              <span style={{
                fontFamily: "var(--font-cjk)", fontSize: 12,
                color: saveMsg.startsWith("✓") ? "var(--green)" : "var(--pink)",
              }}>{saveMsg}</span>
            )}
            <button
              className="btn-primary"
              style={{ padding: "8px 20px", fontSize: 13, opacity: saving ? 0.6 : 1 }}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? (locale === "en" ? "Saving..." : "儲存中...") : (locale === "en" ? "💾 Save Settings" : "💾 儲存設定")}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{
          display: "flex", gap: 0, borderBottom: "1px solid rgba(255,255,255,0.06)",
          padding: "0 clamp(16px, 2vw, 32px)",
        }}>
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "12px 20px", fontSize: 13, fontWeight: 600,
                fontFamily: "var(--font-cjk)",
                color: activeTab === tab.key ? "var(--accent-light)" : "var(--text-muted)",
                borderBottom: activeTab === tab.key ? "2px solid var(--accent)" : "2px solid transparent",
                transition: "all 0.2s",
              }}
            >
              {tab.icon} {locale === "en" ? tab.labelEn : tab.labelZh}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div style={{ padding: "16px clamp(16px, 2vw, 32px)", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          {activeTab === "llm" && (() => {
            const en = locale === "en";
            const providersWithKey = editProviders.filter(p => p.api_key.trim() !== "");

            const updateSettingsProvider = (idx: number, updates: Partial<Provider>) => {
              setEditProviders(prev => {
                const updated = prev.map((p, i) => {
                  if (i !== idx) return p;
                  const next = { ...p, ...updates };
                  if (updates.vendor_type && updates.vendor_type !== p.vendor_type) {
                    const preset = VENDOR_PRESETS[updates.vendor_type];
                    const newId = `${updates.vendor_type}-${Date.now()}`;
                    next.display_name = preset?.label ?? updates.vendor_type;
                    next.id = newId;
                    const oldId = p.id;
                    setEditSystemLlm(s => s.provider_id === oldId ? { provider_id: newId, model: preset?.systemModel ?? s.model } : s);
                    setEditAgentLlms(al => al.map(a => a.provider_id === oldId ? { provider_id: newId, model: preset?.defaultModel ?? a.model } : a));
                  }
                  return next;
                });
                return updated;
              });
            };

            const addNewProvider = () => {
              const usedTypes = editProviders.map(p => p.vendor_type);
              const availableType = Object.keys(VENDOR_PRESETS).find(t => !usedTypes.includes(t)) || "openai";
              const preset = VENDOR_PRESETS[availableType];
              const newId = `${availableType}-${Date.now()}`;
              setEditProviders(prev => [...prev, { id: newId, vendor_type: availableType, display_name: preset?.label ?? availableType, api_key: "", base_url: "" }]);
              setEditAgentLlms(prev => [...prev, { provider_id: newId, model: preset?.defaultModel ?? "" }]);
            };

            return (
            <>
              {/* ═══ LLM Providers ═══ */}
              <div className="mb-5">
                <div className="text-neutral-400 text-xs font-medium uppercase tracking-wider mb-2">
                  {en ? "LLM Providers" : "LLM 供應商"}
                </div>
                <div className="space-y-3">
                  {editProviders.map((p, idx) => (
                    <div key={p.id} className="bg-[#0f1729] rounded-lg p-4 border border-[#2a3554]">
                      <div className="flex items-center gap-3 mb-3">
                        <select className="bg-[#0f3460] text-neutral-300 text-sm rounded px-2 py-1.5 border-none outline-none"
                          value={p.vendor_type} onChange={e => updateSettingsProvider(idx, { vendor_type: e.target.value })}>
                          {Object.entries(VENDOR_PRESETS).map(([key, preset]) => (
                            <option key={key} value={key}>{preset.label}</option>
                          ))}
                        </select>
                        <div className="flex-1" />
                        {editProviders.length > 1 && (
                          <button className="text-neutral-600 hover:text-red-400 text-sm" onClick={() => removeSettingsProvider(p.id)}>✕</button>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mb-2">
                        <input className="flex-1 bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none font-mono"
                          type="password" placeholder="API Key" value={p.api_key}
                          onChange={e => updateSettingsProvider(idx, { api_key: e.target.value })} />
                        <button className="text-xs bg-[#0f3460] text-neutral-400 hover:text-white px-3 py-1.5 rounded transition-colors"
                          onClick={() => testSettingsProvider(p.id)}>
                          {providerTestResults[p.id] === "testing" ? "..." : providerTestResults[p.id] === "ok" ? "✓ OK" : providerTestResults[p.id] === "fail" ? "✕ Fail" : "Test"}
                        </button>
                      </div>
                      <input className="w-full bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none mb-1"
                        placeholder={en ? "Base URL (optional)" : "Base URL（選填）"} value={p.base_url}
                        onChange={e => updateSettingsProvider(idx, { base_url: e.target.value })} />
                      {VENDOR_PRESETS[p.vendor_type]?.keyUrl && (
                        <a href={VENDOR_PRESETS[p.vendor_type].keyUrl} target="_blank" rel="noopener"
                          className="text-[10px] text-blue-400 hover:underline mt-1 inline-block">
                          {en ? `Get ${VENDOR_PRESETS[p.vendor_type].label} API Key →` : `申請 ${VENDOR_PRESETS[p.vendor_type].label} API Key →`}
                        </a>
                      )}
                    </div>
                  ))}
                  <button className="text-sm text-green-400 hover:text-green-300" onClick={addNewProvider}>
                    + {en ? "Add another provider" : "新增供應商"}
                  </button>
                </div>
              </div>

              {/* ═══ Role Cards ═══ */}
              {providersWithKey.length > 0 && (
                <div className="mb-5">
                  <div className="text-neutral-400 text-xs font-medium uppercase tracking-wider mb-2">
                    {en ? "Assign LLM Roles" : "指定 LLM 角色"}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
                    {/* System LLM Card */}
                    <div className="bg-[#0f1729] rounded-lg border border-[#2a3554] p-4 flex flex-col">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-2 h-2 rounded-full bg-cyan-400 shrink-0" />
                        <span className="text-sm font-medium text-neutral-200">{en ? "System LLM" : "系統 LLM"}</span>
                      </div>
                      <div className="text-neutral-500 text-[10px] mb-3">{en ? "News analysis, data parsing, election OCR" : "新聞分析、資料解析、選舉 OCR"}</div>
                      <select className="bg-[#0f3460] text-neutral-300 text-sm rounded px-2 py-1.5 border-none outline-none mb-2"
                        value={editSystemLlm.provider_id}
                        onChange={e => {
                          const pid = e.target.value;
                          const prov = editProviders.find(pp => pp.id === pid);
                          const preset = prov ? VENDOR_PRESETS[prov.vendor_type] : null;
                          setEditSystemLlm({ provider_id: pid, model: preset?.systemModel ?? editSystemLlm.model });
                        }}>
                        {providersWithKey.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                      </select>
                      <input className="bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none"
                        placeholder="Model" value={editSystemLlm.model}
                        onChange={e => setEditSystemLlm(prev => ({ ...prev, model: e.target.value }))} />
                    </div>

                    {/* Agent LLM Cards */}
                    <div className="flex flex-col gap-3">
                      {editAgentLlms.map((agent, aIdx) => (
                        <div key={`${agent.provider_id}-${aIdx}`} className="bg-[#0f1729] rounded-lg border border-[#2a3554] p-4 flex flex-col">
                          <div className="flex items-center gap-2 mb-1">
                            <div className="w-2 h-2 rounded-full bg-[#e94560] shrink-0" />
                            <span className="text-sm font-medium text-neutral-200">Agent LLM {editAgentLlms.length > 1 ? `#${aIdx + 1}` : ""}</span>
                            <div className="flex-1" />
                            {editAgentLlms.length > 1 && (
                              <button className="text-neutral-600 hover:text-red-400 text-xs"
                                onClick={() => setEditAgentLlms(prev => prev.filter((_, i) => i !== aIdx))}>✕</button>
                            )}
                          </div>
                          <div className="text-neutral-500 text-[10px] mb-3">{en ? "Persona generation, opinion evolution" : "人格生成、觀點演化"}</div>
                          <select className="bg-[#0f3460] text-neutral-300 text-sm rounded px-2 py-1.5 border-none outline-none mb-2"
                            value={agent.provider_id}
                            onChange={e => {
                              const pid = e.target.value;
                              const pp = editProviders.find(p => p.id === pid);
                              const preset = pp ? VENDOR_PRESETS[pp.vendor_type] : null;
                              setEditAgentLlms(prev => prev.map((a, i) => i === aIdx ? { provider_id: pid, model: preset?.defaultModel ?? a.model } : a));
                            }}>
                            {providersWithKey.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                          </select>
                          <input className="bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none"
                            placeholder="Model" value={agent.model}
                            onChange={e => { const model = e.target.value; setEditAgentLlms(prev => prev.map((a, i) => i === aIdx ? { ...a, model } : a)); }} />
                        </div>
                      ))}
                      <button className="rounded-lg border border-dashed border-[#2a3554] hover:border-[#3b4c6b] p-4 flex items-center justify-center gap-2 text-neutral-500 hover:text-neutral-300 transition-colors"
                        onClick={() => {
                          const first = providersWithKey[0];
                          if (!first) return;
                          const preset = VENDOR_PRESETS[first.vendor_type];
                          setEditAgentLlms(prev => [...prev, { provider_id: first.id, model: preset?.defaultModel ?? "" }]);
                        }}>
                        <span className="text-lg">+</span>
                        <span className="text-sm">{en ? "Add Agent LLM" : "新增 Agent LLM"}</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ═══ Serper API ═══ */}
              <div className="mb-5">
                <div className="text-neutral-400 text-xs font-medium uppercase tracking-wider mb-2">
                  {en ? "Search API" : "搜尋 API"}
                </div>
                <div className="bg-[#0f1729] rounded-lg p-4 border border-[#2a3554]">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-neutral-300 text-sm font-medium">Serper API Key</span>
                    <a href="https://serper.dev" target="_blank" rel="noopener" className="text-[10px] text-blue-400 hover:underline">serper.dev →</a>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="password" className="flex-1 bg-[#0f3460] text-neutral-300 text-sm rounded px-3 py-1.5 border-none outline-none font-mono"
                      placeholder="Serper API Key" value={editSerperKey} onChange={e => setEditSerperKey(e.target.value)} />
                    <button className="text-xs bg-[#0f3460] text-neutral-400 hover:text-white px-3 py-1.5 rounded transition-colors"
                      onClick={testSerperKey}>
                      {providerTestResults.serper === "testing" ? "..." : providerTestResults.serper === "ok" ? "✓ OK" : providerTestResults.serper === "fail" ? "✕ Fail" : "Test"}
                    </button>
                  </div>
                </div>
              </div>

              {/* ═══ Onboarding reset ═══ */}
              <div className="border-t border-[#2a3554] mt-4 pt-4">
                <button className="text-sm text-neutral-500 hover:text-[#e94560] transition-colors"
                  onClick={async () => {
                    await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ onboarding_completed: false }) });
                    window.location.reload();
                  }}>
                  {en ? "Re-run Onboarding Wizard" : "重新執行設定精靈"}
                </button>
              </div>
            </>
            );
          })()}

          {activeTab === "appearance" && (
            <AppearancePanel />
          )}
        </div>

      {/* ─── Edit Modal ─── */}
      {editingVendor && (
        <VendorEditModal
          vendor={editingVendor}
          vendorTypes={vendorTypes}
          existingIds={editProviders.map(p => p.id)}
          onSave={saveVendor}
          onCancel={() => setEditingVendor(null)}
        />
      )}
    </div>
  );
}

/* ─── Vendor Edit Modal ─── */
function VendorEditModal({
  vendor,
  vendorTypes,
  existingIds,
  onSave,
  onCancel,
}: {
  vendor: VendorEntry;
  vendorTypes: VendorType[];
  existingIds: string[];
  onSave: (v: VendorEntry) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<VendorEntry>({ ...vendor });
  const [showKey, setShowKey] = useState(false);
  const isNew = !existingIds.includes(vendor.id);

  const handleTypeChange = (newType: string) => {
    const vt = vendorTypes.find(t => t.value === newType);
    if (!vt) return;
    const count = existingIds.filter(id => id.startsWith(newType)).length;
    const newId = isNew ? (count === 0 ? newType : `${newType}${count + 1}`) : form.id;
    const newName = isNew ? (count === 0 ? vt.label : `${vt.label} #${count + 1}`) : form.display_name;
    setForm({
      ...form,
      id: newId,
      display_name: newName,
      vendor_type: newType,
      base_url: vt.default_base_url,
      model: vt.default_model,
    });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000,
    }} onClick={onCancel}>
      <div
        style={{
          background: "var(--bg-sidebar)", borderRadius: 16,
          border: "1px solid var(--border-subtle)",
          padding: 32, width: 480, maxHeight: "80vh", overflow: "auto",
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
        }}
        onClick={e => e.stopPropagation()}
      >
        <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
          {isNew ? "新增 LLM" : "編輯 LLM"}
        </h3>

        {/* Vendor Type */}
        <div style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 4 }}>提供商類型</div>
          <select
            className="input-field"
            value={form.vendor_type}
            onChange={e => handleTypeChange(e.target.value)}
            style={{ color: "var(--text-secondary)" }}
          >
            {vendorTypes.map(vt => (
              <option key={vt.value} value={vt.value}>{vt.label}</option>
            ))}
          </select>
        </div>

        {/* Display Name */}
        <div style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 4 }}>顯示名稱</div>
          <input
            className="input-field"
            value={form.display_name}
            onChange={e => setForm({ ...form, display_name: e.target.value })}
            placeholder="例如：OpenAI Main"
          />
        </div>

        {/* ID */}
        <div style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 4 }}>識別 ID</div>
          <input
            className="input-field"
            value={form.id}
            onChange={e => setForm({ ...form, id: e.target.value })}
            placeholder="例如：openai"
            disabled={!isNew}
            style={{ opacity: isNew ? 1 : 0.5 }}
          />
        </div>

        {/* API Key */}
        <div style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 4 }}>API Key</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input-field"
              type={showKey ? "text" : "password"}
              value={form.api_key}
              onChange={e => setForm({ ...form, api_key: e.target.value })}
              placeholder="sk-..."
              style={{ flex: 1 }}
            />
            <button
              onClick={() => setShowKey(!showKey)}
              style={{
                background: "rgba(255,255,255,0.06)", border: "1px solid var(--border-input)",
                borderRadius: 8, padding: "0 10px", cursor: "pointer",
                color: "var(--text-muted)", fontSize: 14,
              }}
            >
              {showKey ? "🙈" : "👁️"}
            </button>
          </div>
        </div>

        {/* Model */}
        <div style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 4 }}>模型名稱</div>
          <input
            className="input-field"
            value={form.model}
            onChange={e => setForm({ ...form, model: e.target.value })}
            placeholder="例如：gpt-4o-mini"
          />
        </div>

        {/* Base URL */}
        <div style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 4 }}>Base URL（留空使用預設）</div>
          <input
            className="input-field"
            value={form.base_url}
            onChange={e => setForm({ ...form, base_url: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>

        {/* Temperature */}
        <div style={{ marginBottom: 24 }}>
          <div className="label" style={{ marginBottom: 4 }}>Temperature（留空使用預設）</div>
          <input
            className="input-field"
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={form.temperature ?? ""}
            onChange={e => setForm({ ...form, temperature: e.target.value ? parseFloat(e.target.value) : null })}
            placeholder="0.8"
            style={{ maxWidth: 120 }}
          />
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              background: "rgba(255,255,255,0.06)", border: "1px solid var(--border-subtle)",
              borderRadius: 8, padding: "8px 18px", fontSize: 13, fontWeight: 600,
              fontFamily: "var(--font-cjk)", color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            取消
          </button>
          <button
            className="btn-primary"
            style={{ padding: "8px 18px", fontSize: 13 }}
            onClick={() => onSave(form)}
          >
            {isNew ? "新增" : "儲存"}
          </button>
        </div>
      </div>
    </div>
  );
}
