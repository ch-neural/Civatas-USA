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
      setSaveMsg("✓ 已儲存");
      setTimeout(() => setSaveMsg(""), 3000);
      // Reload to get fresh data (masked keys etc.)
      await loadSettings();
    } catch (e: any) {
      setSaveMsg(`✗ ${e.message || "儲存失敗"}`);
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

  const testSettingsProvider = async (providerId: string) => {
    const provider = editProviders.find(p => p.id === providerId);
    if (!provider) return;
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
          <span style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-tertiary)" }}>載入設定中...</span>
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
              {saving ? "儲存中..." : "💾 儲存設定"}
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
          {activeTab === "llm" && (
            <>
              {/* ── (a) LLM Providers ── */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div className="label" style={{ fontSize: 13 }}>
                  {locale === "en" ? "LLM Providers" : "LLM 供應商"} ({editProviders.length})
                </div>
                <button
                  onClick={addSettingsProvider}
                  style={{
                    background: "rgba(108,92,231,0.15)", border: "1px solid rgba(108,92,231,0.3)",
                    color: "var(--accent-light)", borderRadius: 8, padding: "6px 14px",
                    fontSize: 12, fontWeight: 600, fontFamily: "var(--font-cjk)", cursor: "pointer",
                    transition: "opacity 0.2s",
                  }}
                >
                  ＋ {locale === "en" ? "Add Provider" : "新增供應商"}
                </button>
              </div>

              {editProviders.length === 0 ? (
                <div className="card" style={{ textAlign: "center", padding: 40, marginBottom: 24 }}>
                  <p style={{ fontFamily: "var(--font-cjk)", fontSize: 14, color: "var(--text-muted)", marginBottom: 8 }}>
                    {locale === "en" ? "No providers configured" : "尚未設定任何供應商"}
                  </p>
                  <p style={{ fontFamily: "var(--font-cjk)", fontSize: 12, color: "var(--text-faint)" }}>
                    {locale === "en" ? "Click \"+ Add Provider\" to get started" : "點擊上方「新增供應商」開始設定"}
                  </p>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
                  {editProviders.map(p => {
                    const preset = VENDOR_PRESETS[p.vendor_type];
                    const testResult = providerTestResults[p.id];
                    return (
                      <div
                        key={p.id}
                        className="card"
                        style={{ display: "flex", alignItems: "center", gap: 14 }}
                      >
                        {/* Provider info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{
                              fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600,
                              color: "var(--text-primary)",
                            }}>{p.display_name}</span>
                            <span style={{
                              padding: "1px 6px", borderRadius: 4, fontSize: 10,
                              background: "rgba(255,255,255,0.06)", color: "var(--text-muted)",
                              fontFamily: "var(--font-sans)",
                            }}>{preset?.label || p.vendor_type}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-sans)" }}>
                            <span>🔑 {p.api_key ? (p.api_key.startsWith("***") ? p.api_key : `***${p.api_key.slice(-4)}`) : "(未設定)"}</span>
                            {p.base_url && <span>🌐 {p.base_url.replace(/^https?:\/\//, "").slice(0, 30)}</span>}
                          </div>
                        </div>

                        {/* Actions */}
                        <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                          {/* Test button */}
                          <button
                            onClick={() => testSettingsProvider(p.id)}
                            disabled={testResult === "testing"}
                            style={{
                              background: testResult === "ok" ? "rgba(0,200,83,0.1)" : testResult === "fail" ? "rgba(233,69,96,0.1)" : "rgba(255,255,255,0.06)",
                              border: `1px solid ${testResult === "ok" ? "rgba(0,200,83,0.3)" : testResult === "fail" ? "rgba(233,69,96,0.3)" : "var(--border-subtle)"}`,
                              borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer",
                              color: testResult === "ok" ? "var(--green)" : testResult === "fail" ? "var(--pink)" : "var(--text-muted)",
                              fontFamily: "var(--font-cjk)", fontWeight: 600, transition: "all 0.2s",
                              opacity: testResult === "testing" ? 0.6 : 1,
                            }}
                          >
                            {testResult === "testing" ? "..." : testResult === "ok" ? "✓ OK" : testResult === "fail" ? "✗ Fail" : "Test"}
                          </button>
                          {/* Edit */}
                          <button
                            onClick={() => {
                              const agentAssignment = editAgentLlms.find(a => a.provider_id === p.id);
                              setEditingVendor({
                                id: p.id,
                                display_name: p.display_name,
                                vendor_type: p.vendor_type,
                                api_key: p.api_key,
                                model: agentAssignment?.model || VENDOR_PRESETS[p.vendor_type]?.defaultModel || "",
                                base_url: p.base_url,
                                temperature: null,
                              });
                            }}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}
                            title={locale === "en" ? "Edit" : "編輯"}
                          >
                            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
                            </svg>
                          </button>
                          {/* Delete */}
                          <button
                            onClick={() => removeSettingsProvider(p.id)}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", padding: 4, transition: "color 0.2s" }}
                            onMouseEnter={e => (e.currentTarget.style.color = "var(--pink)")}
                            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-faint)")}
                            title={locale === "en" ? "Delete" : "刪除"}
                          >
                            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M3 5h10M6 5V3h4v2M5 5v8h6V5" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── (b) System LLM ── */}
              <div style={{ marginBottom: 24, padding: 16, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div className="label" style={{ fontSize: 13, marginBottom: 4 }}>
                  🧠 {locale === "en" ? "System LLM" : "系統 LLM"}
                </div>
                <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)", marginBottom: 8, lineHeight: 1.5 }}>
                  {locale === "en"
                    ? "Used for smart keywords, summary analysis, and other system-level tasks. Defaults to first provider if not set."
                    : "用於智慧關鍵字、摘要分析等系統級任務。若未指定，預設使用第一組供應商。"}
                </p>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <select
                    value={editSystemLlm.provider_id}
                    onChange={(e) => {
                      const pid = e.target.value;
                      const prov = editProviders.find(p => p.id === pid);
                      const preset = prov ? VENDOR_PRESETS[prov.vendor_type] : null;
                      setEditSystemLlm({ provider_id: pid, model: preset?.systemModel || editSystemLlm.model || "" });
                    }}
                    style={{
                      flex: 1, maxWidth: 300, padding: "8px 12px", borderRadius: 6,
                      border: "1px solid var(--border-input)", background: "var(--bg-input)",
                      color: "var(--text-primary)", fontSize: 12, fontFamily: "var(--font-cjk)",
                    }}
                  >
                    <option value="">{locale === "en" ? "(Auto: use first provider)" : "（自動：使用第一組供應商）"}</option>
                    {editProviders.map(p => (
                      <option key={p.id} value={p.id}>{p.display_name}</option>
                    ))}
                  </select>
                  <input
                    className="input-field"
                    value={editSystemLlm.model}
                    onChange={(e) => setEditSystemLlm({ ...editSystemLlm, model: e.target.value })}
                    placeholder={locale === "en" ? "Model name" : "模型名稱"}
                    style={{ flex: 1, maxWidth: 250, fontSize: 12 }}
                  />
                </div>
              </div>

              {/* ── (c) Agent LLM ── */}
              <div style={{ marginBottom: 24, padding: 16, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div className="label" style={{ fontSize: 13, marginBottom: 4 }}>
                  🤖 {locale === "en" ? "Agent LLM" : "Agent LLM"}
                </div>
                <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)", marginBottom: 12, lineHeight: 1.5 }}>
                  {locale === "en"
                    ? "Select which providers to use for agent persona generation. Check providers and assign models."
                    : "選擇哪些供應商用於 Agent 人格生成。勾選供應商並指定模型。"}
                </p>

                {/* Checkbox list of providers with model input */}
                {editProviders.length === 0 ? (
                  <p style={{ fontFamily: "var(--font-cjk)", fontSize: 12, color: "var(--text-faint)", fontStyle: "italic" }}>
                    {locale === "en" ? "Add a provider first." : "請先新增供應商。"}
                  </p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                    {editProviders.map(p => {
                      const assignment = editAgentLlms.find(a => a.provider_id === p.id);
                      const isChecked = !!assignment;
                      const preset = VENDOR_PRESETS[p.vendor_type];
                      return (
                        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              if (isChecked) {
                                setEditAgentLlms(prev => prev.filter(a => a.provider_id !== p.id));
                              } else {
                                setEditAgentLlms(prev => [...prev, { provider_id: p.id, model: preset?.defaultModel || "gpt-4o-mini" }]);
                              }
                            }}
                            style={{ accentColor: "var(--accent)", width: 16, height: 16, cursor: "pointer" }}
                          />
                          <span style={{ fontFamily: "var(--font-cjk)", fontSize: 12, color: "var(--text-primary)", minWidth: 100 }}>
                            {p.display_name}
                          </span>
                          <input
                            className="input-field"
                            value={assignment?.model || ""}
                            onChange={(e) => {
                              if (!isChecked) return;
                              setEditAgentLlms(prev => prev.map(a => a.provider_id === p.id ? { ...a, model: e.target.value } : a));
                            }}
                            placeholder={preset?.defaultModel || "model"}
                            disabled={!isChecked}
                            style={{ flex: 1, maxWidth: 250, fontSize: 12, opacity: isChecked ? 1 : 0.4 }}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Mode selector (only shown when >1 agent LLM) */}
                {editAgentLlms.length > 1 && (
                  <>
                    <div className="label" style={{ marginBottom: 8, fontSize: 12 }}>
                      {locale === "en" ? "LLM Mode" : "LLM 使用模式"}
                    </div>
                    <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                      {[
                        { key: "multi", label: locale === "en" ? "Multi LLM" : "多組 LLM 共用", desc: locale === "en" ? "Distribute tasks across multiple LLMs by ratio" : "多個 LLM 同時運作，依比例分配任務", icon: "🔀" },
                        { key: "primary_fallback", label: locale === "en" ? "Primary + Fallback" : "主要＋備援", desc: locale === "en" ? "Use primary LLM, switch to fallback on failure" : "指定主要 LLM，失敗時自動切換備援", icon: "🛡️" },
                      ].map(opt => (
                        <div
                          key={opt.key}
                          onClick={() => setEditLlmMode(opt.key)}
                          style={{
                            flex: 1, padding: "12px 16px", borderRadius: 10, cursor: "pointer",
                            background: editLlmMode === opt.key ? "var(--accent-bg)" : "var(--bg-card)",
                            border: `1px solid ${editLlmMode === opt.key ? "var(--accent-border)" : "var(--border-subtle)"}`,
                            transition: "all 0.2s",
                          }}
                        >
                          <div style={{ fontSize: 18, marginBottom: 6 }}>{opt.icon}</div>
                          <div style={{
                            fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600,
                            color: editLlmMode === opt.key ? "var(--accent-light)" : "var(--text-primary)",
                            marginBottom: 2,
                          }}>{opt.label}</div>
                          <div style={{
                            fontFamily: "var(--font-cjk)", fontSize: 10,
                            color: "var(--text-muted)", lineHeight: 1.4,
                          }}>{opt.desc}</div>
                        </div>
                      ))}
                    </div>

                    {/* Ratio input (multi mode) */}
                    {editLlmMode === "multi" && (
                      <div style={{ marginBottom: 12 }}>
                        <div className="label" style={{ marginBottom: 6, fontSize: 11 }}>
                          {locale === "en" ? "Distribution ratio (colon-separated, e.g. 1:1:1)" : "分配比例（以冒號分隔，如 1:1:1）"}
                        </div>
                        <input
                          className="input-field"
                          value={editVendorRatio}
                          onChange={e => setEditVendorRatio(e.target.value)}
                          placeholder="1:1:1"
                          style={{ maxWidth: 200, fontSize: 12 }}
                        />
                      </div>
                    )}

                    {/* Primary/Fallback dropdowns */}
                    {editLlmMode === "primary_fallback" && (
                      <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div className="label" style={{ marginBottom: 6, fontSize: 11 }}>
                            {locale === "en" ? "Primary" : "主要 LLM"}
                          </div>
                          <select
                            className="input-field"
                            value={editPrimaryId}
                            onChange={e => setEditPrimaryId(e.target.value)}
                            style={{ color: "var(--text-secondary)", fontSize: 12 }}
                          >
                            <option value="">{locale === "en" ? "— Select —" : "— 選擇 —"}</option>
                            {editAgentLlms.map(a => {
                              const prov = editProviders.find(p => p.id === a.provider_id);
                              return prov ? <option key={a.provider_id} value={a.provider_id}>{prov.display_name} ({a.model})</option> : null;
                            })}
                          </select>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div className="label" style={{ marginBottom: 6, fontSize: 11 }}>
                            {locale === "en" ? "Fallback" : "備援 LLM"}
                          </div>
                          <select
                            className="input-field"
                            value={editFallbackId}
                            onChange={e => setEditFallbackId(e.target.value)}
                            style={{ color: "var(--text-secondary)", fontSize: 12 }}
                          >
                            <option value="">{locale === "en" ? "— Select —" : "— 選擇 —"}</option>
                            {editAgentLlms.filter(a => a.provider_id !== editPrimaryId).map(a => {
                              const prov = editProviders.find(p => p.id === a.provider_id);
                              return prov ? <option key={a.provider_id} value={a.provider_id}>{prov.display_name} ({a.model})</option> : null;
                            })}
                          </select>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* ── (d) Search API ── */}
              <div style={{ marginBottom: 24, padding: 16, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-cjk)" }}>
                    🔍 Serper (Google Search)
                  </span>
                  <a href="https://serper.dev" target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 10, color: "var(--accent-light)", textDecoration: "none" }}>
                    serper.dev →
                  </a>
                </div>
                <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)", marginBottom: 8, lineHeight: 1.5 }}>
                  {locale === "en"
                    ? "Used for news search (Google News API). Free plan: 2,500 searches/month."
                    : "用於搜尋新聞（Google News API）。免費方案每月 2,500 次搜尋。"}
                </p>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="password"
                    className="input-field"
                    style={{ flex: 1, fontSize: 12 }}
                    placeholder={locale === "en" ? "Enter Serper API Key" : "輸入 Serper API Key"}
                    value={editSerperKey}
                    onChange={(e) => setEditSerperKey(e.target.value)}
                  />
                  <span style={{ fontSize: 10, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                    {editSerperKey ? "✓ 已設定" : "✗ 未設定"}
                  </span>
                </div>
              </div>

              {/* ── (e) Onboarding reset ── */}
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", marginTop: 8, paddingTop: 16 }}>
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
