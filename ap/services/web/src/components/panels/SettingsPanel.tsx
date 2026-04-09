"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import AppearancePanel from "@/components/shell/AppearancePanel";
import { useLocaleStore } from "@/store/locale-store";

/* ─── Types ─── */
interface VendorEntry {
  id: string;
  display_name: string;
  vendor_type: string;
  api_key: string;
  api_key_hint?: string;
  model: string;
  base_url: string;
  temperature: number | null;
}

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
  const [showKeyMap, setShowKeyMap] = useState<Record<string, boolean>>({});

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

  /* ─── Save ─── */
  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setSaveMsg("");
    try {
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
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

  /* ─── Vendor CRUD ─── */
  const addVendor = () => {
    if (!settings) return;
    const vt = vendorTypes[0] || { value: "openai", label: "OpenAI", default_base_url: "", default_model: "gpt-4o-mini" };
    const count = settings.llm_vendors.filter(v => v.vendor_type === vt.value).length;
    const newId = count === 0 ? vt.value : `${vt.value}${count + 1}`;
    const entry: VendorEntry = {
      id: newId,
      display_name: count === 0 ? vt.label : `${vt.label} #${count + 1}`,
      vendor_type: vt.value,
      api_key: "",
      model: vt.default_model,
      base_url: vt.default_base_url,
      temperature: null,
    };
    setEditingVendor(entry);
  };

  const saveVendor = (vendor: VendorEntry) => {
    if (!settings) return;
    const idx = settings.llm_vendors.findIndex(v => v.id === vendor.id);
    const newVendors = [...settings.llm_vendors];
    if (idx >= 0) {
      newVendors[idx] = vendor;
    } else {
      newVendors.push(vendor);
      // Auto-add to active list
      if (!settings.active_vendors.includes(vendor.id)) {
        setSettings({ ...settings, llm_vendors: newVendors, active_vendors: [...settings.active_vendors, vendor.id] });
        setEditingVendor(null);
        return;
      }
    }
    setSettings({ ...settings, llm_vendors: newVendors });
    setEditingVendor(null);
  };

  const removeVendor = (id: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      llm_vendors: settings.llm_vendors.filter(v => v.id !== id),
      active_vendors: settings.active_vendors.filter(v => v !== id),
      primary_vendor_id: settings.primary_vendor_id === id ? "" : settings.primary_vendor_id,
      fallback_vendor_id: settings.fallback_vendor_id === id ? "" : settings.fallback_vendor_id,
    });
  };

  const toggleActive = (id: string) => {
    if (!settings) return;
    const isActive = settings.active_vendors.includes(id);
    const newActive = isActive
      ? settings.active_vendors.filter(v => v !== id)
      : [...settings.active_vendors, id];
    setSettings({ ...settings, active_vendors: newActive });
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
              {/* ── System LLM selector ── */}
              <div style={{ marginBottom: 24, padding: 16, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div className="label" style={{ fontSize: 13, marginBottom: 4 }}>🧠 系統 LLM</div>
                <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)", marginBottom: 8, lineHeight: 1.5 }}>
                  用於智慧關鍵字、摘要分析等系統級任務。若未指定，預設使用第一組 OpenAI。
                </p>
                <select
                  value={(settings as any).system_vendor_id || ""}
                  onChange={(e) => setSettings({ ...settings, system_vendor_id: e.target.value } as any)}
                  style={{
                    width: "100%", maxWidth: 400, padding: "8px 12px", borderRadius: 6,
                    border: "1px solid var(--border-input)", background: "var(--bg-input)",
                    color: "var(--text-primary)", fontSize: 12, fontFamily: "var(--font-cjk)",
                  }}
                >
                  <option value="">（自動：使用 .env 預設）</option>
                  {settings.llm_vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.display_name} — {v.model}
                    </option>
                  ))}
                </select>
              </div>

              {/* Mode Selector */}
              <div style={{ marginBottom: 32 }}>
                <div className="label" style={{ marginBottom: 8, fontSize: 12 }}>LLM 使用模式</div>
                <div style={{ display: "flex", gap: 12 }}>
                  {[
                    { key: "multi", label: "多組 LLM 共用", desc: "多個 LLM 同時運作，依比例分配任務", icon: "🔀" },
                    { key: "primary_fallback", label: "主要＋備援", desc: "指定主要 LLM，失敗時自動切換備援", icon: "🛡️" },
                  ].map(opt => (
                    <div
                      key={opt.key}
                      onClick={() => setSettings({ ...settings, llm_mode: opt.key })}
                      style={{
                        flex: 1, padding: "16px 20px", borderRadius: 12, cursor: "pointer",
                        background: settings.llm_mode === opt.key ? "var(--accent-bg)" : "var(--bg-card)",
                        border: `1px solid ${settings.llm_mode === opt.key ? "var(--accent-border)" : "var(--border-subtle)"}`,
                        transition: "all 0.2s",
                      }}
                    >
                      <div style={{ fontSize: 20, marginBottom: 8 }}>{opt.icon}</div>
                      <div style={{
                        fontFamily: "var(--font-cjk)", fontSize: 14, fontWeight: 600,
                        color: settings.llm_mode === opt.key ? "var(--accent-light)" : "var(--text-primary)",
                        marginBottom: 4,
                      }}>{opt.label}</div>
                      <div style={{
                        fontFamily: "var(--font-cjk)", fontSize: 11,
                        color: "var(--text-muted)", lineHeight: 1.5,
                      }}>{opt.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Primary/Fallback selector (only in that mode) */}
              {settings.llm_mode === "primary_fallback" && settings.llm_vendors.length > 0 && (
                <div className="card" style={{ marginBottom: 24, display: "flex", gap: 24 }}>
                  <div style={{ flex: 1 }}>
                    <div className="label" style={{ marginBottom: 6 }}>主要 LLM</div>
                    <select
                      className="input-field"
                      value={settings.primary_vendor_id}
                      onChange={e => setSettings({ ...settings, primary_vendor_id: e.target.value })}
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <option value="">— 選擇 —</option>
                      {settings.llm_vendors.map(v => (
                        <option key={v.id} value={v.id}>{v.display_name} ({v.model})</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="label" style={{ marginBottom: 6 }}>備援 LLM</div>
                    <select
                      className="input-field"
                      value={settings.fallback_vendor_id}
                      onChange={e => setSettings({ ...settings, fallback_vendor_id: e.target.value })}
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <option value="">— 選擇 —</option>
                      {settings.llm_vendors.filter(v => v.id !== settings.primary_vendor_id).map(v => (
                        <option key={v.id} value={v.id}>{v.display_name} ({v.model})</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* Ratio (multi mode only) */}
              {settings.llm_mode === "multi" && (
                <div style={{ marginBottom: 24 }}>
                  <div className="label" style={{ marginBottom: 6 }}>分配比例（以冒號分隔，如 1:1:1）</div>
                  <input
                    className="input-field"
                    value={settings.vendor_ratio}
                    onChange={e => setSettings({ ...settings, vendor_ratio: e.target.value })}
                    placeholder="1:1:1"
                    style={{ maxWidth: 300 }}
                  />
                </div>
              )}


              {/* Vendor List */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div className="label" style={{ fontSize: 12 }}>已設定的 LLM ({settings.llm_vendors.length})</div>
                <button
                  onClick={addVendor}
                  style={{
                    background: "rgba(108,92,231,0.15)", border: "1px solid rgba(108,92,231,0.3)",
                    color: "var(--accent-light)", borderRadius: 8, padding: "6px 14px",
                    fontSize: 12, fontWeight: 600, fontFamily: "var(--font-cjk)", cursor: "pointer",
                    transition: "opacity 0.2s",
                  }}
                >
                  ＋ 新增 LLM
                </button>
              </div>

              {settings.llm_vendors.length === 0 ? (
                <div className="card" style={{ textAlign: "center", padding: 40 }}>
                  <p style={{ fontFamily: "var(--font-cjk)", fontSize: 14, color: "var(--text-muted)", marginBottom: 8 }}>尚未設定任何 LLM</p>
                  <p style={{ fontFamily: "var(--font-cjk)", fontSize: 12, color: "var(--text-faint)" }}>點擊上方「新增 LLM」開始設定</p>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {settings.llm_vendors.map(v => {
                    const isActive = settings.active_vendors.includes(v.id);
                    const isPrimary = settings.primary_vendor_id === v.id;
                    const isFallback = settings.fallback_vendor_id === v.id;
                    const vtInfo = vendorTypes.find(vt => vt.value === v.vendor_type);

                    return (
                      <div
                        key={v.id}
                        className="card"
                        style={{
                          display: "flex", alignItems: "center", gap: 14,
                          borderColor: isPrimary ? "var(--accent-border)" : isFallback ? "rgba(253,203,110,0.3)" : undefined,
                          background: isPrimary ? "rgba(108,92,231,0.06)" : isFallback ? "rgba(253,203,110,0.04)" : undefined,
                        }}
                      >
                        {/* Active toggle (multi mode only) */}
                        {settings.llm_mode === "multi" && (
                          <div
                            onClick={() => toggleActive(v.id)}
                            style={{
                              width: 36, height: 20, borderRadius: 10, cursor: "pointer",
                              background: isActive ? "var(--accent)" : "rgba(255,255,255,0.1)",
                              position: "relative", transition: "background 0.2s", flexShrink: 0,
                            }}
                          >
                            <div style={{
                              width: 16, height: 16, borderRadius: "50%", background: "#fff",
                              position: "absolute", top: 2,
                              left: isActive ? 18 : 2,
                              transition: "left 0.2s",
                            }} />
                          </div>
                        )}

                        {/* Vendor info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{
                              fontFamily: "var(--font-cjk)", fontSize: 13, fontWeight: 600,
                              color: "var(--text-primary)",
                            }}>{v.display_name}</span>
                            <span style={{
                              padding: "1px 6px", borderRadius: 4, fontSize: 10,
                              background: "rgba(255,255,255,0.06)", color: "var(--text-muted)",
                              fontFamily: "var(--font-sans)",
                            }}>{vtInfo?.label || v.vendor_type}</span>
                            {isPrimary && <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, background: "var(--accent-bg)", color: "var(--accent-light)", fontWeight: 600 }}>主要</span>}
                            {isFallback && <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, background: "var(--yellow-bg)", color: "var(--yellow)", fontWeight: 600 }}>備援</span>}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-sans)" }}>
                            <span>📦 {v.model}</span>
                            <span>🔑 {v.api_key_hint || (v.api_key ? `***${v.api_key.slice(-4)}` : "(未設定)")}</span>
                            {v.base_url && <span>🌐 {v.base_url.replace(/^https?:\/\//, "").slice(0, 30)}</span>}
                          </div>
                        </div>

                        {/* Actions */}
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                          <button
                            onClick={() => setEditingVendor({ ...v })}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}
                            title="編輯"
                          >
                            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => removeVendor(v.id)}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", padding: 4, transition: "color 0.2s" }}
                            onMouseEnter={e => (e.currentTarget.style.color = "var(--pink)")}
                            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-faint)")}
                            title="刪除"
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

              {/* Serper */}
              <div style={{ marginTop: 32, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 24 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <div className="label" style={{ fontSize: 12 }}>Search API</div>
                </div>
                <div style={{ padding: 16, borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-cjk)" }}>🔍 Serper (Google Search)</span>
                    <a href="https://serper.dev" target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 10, color: "var(--accent-light)", textDecoration: "none" }}>
                      serper.dev →
                    </a>
                  </div>
                  <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-faint)", marginBottom: 8, lineHeight: 1.5 }}>
                    用於搜尋新聞（Google News API）。免費方案每月 2,500 次搜尋。
                  </p>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type="password"
                      className="input-field"
                      style={{ flex: 1, fontSize: 12 }}
                      placeholder="輸入 Serper API Key"
                      value={(settings as any).serper_api_key || ""}
                      onChange={(e) => setSettings({ ...settings, serper_api_key: e.target.value } as any)}
                    />
                    <span style={{ fontSize: 10, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                      {(settings as any).serper_api_key ? "✓ 已設定" : "✗ 未設定"}
                    </span>
                  </div>
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

          {activeTab === "appearance" && (
            <AppearancePanel />
          )}
        </div>

      {/* ─── Edit Modal ─── */}
      {editingVendor && (
        <VendorEditModal
          vendor={editingVendor}
          vendorTypes={vendorTypes}
          existingIds={settings.llm_vendors.map(v => v.id)}
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
