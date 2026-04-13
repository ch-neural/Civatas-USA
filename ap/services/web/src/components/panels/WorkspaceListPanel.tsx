"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { listWorkspaces, deleteWorkspace, type WorkspaceMeta } from "@/lib/api";
import { useShellStore } from "@/store/shell-store";
import { useTr } from "@/lib/i18n";

// Stage 1.8: Purpose config holds STYLE only (icon + colors). Labels are
// resolved at render time from the i18n dictionary so the workspace cards
// follow the user's UI locale toggle.
const PURPOSE_CONFIG: Record<string, { icon: string; color: string; bg: string; border: string; labelKey: string }> = {
  election:     { icon: "🗳️", color: "#3b82f6", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.5)", labelKey: "wslist.purpose.election" },
  consumer:     { icon: "🪙", color: "#10b981", bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.5)", labelKey: "wslist.purpose.consumer" },
  birth_policy: { icon: "👶", color: "#f59e0b", bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.5)", labelKey: "wslist.purpose.birth_policy" },
  kmt_primary:  { icon: "🏹", color: "#8b5cf6", bg: "rgba(139,92,246,0.08)", border: "rgba(139,92,246,0.5)", labelKey: "wslist.purpose.kmt_primary" },
};

export default function WorkspaceListPanel() {
  const router = useRouter();
  const t = useTr();
  const setShowCreateDialog = useShellStore((s) => s.setShowCreateDialog);
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
  const [loading, setLoading] = useState(true);
  // Stage 1.8: handleCreate / inline create form was removed — workspace
  // creation goes through CreateWorkspaceDialog which has the template picker.

  const loadWorkspaces = () => {
    setLoading(true);
    listWorkspaces()
      .then((res) => setWorkspaces(res.workspaces || []))
      .catch(() => {
        setWorkspaces([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadWorkspaces();
  }, []);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(t("wslist.delete_confirm"))) return;
    await deleteWorkspace(id);
    loadWorkspaces();
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  const getPurposeTag = (purpose?: string) => {
    const cfg = PURPOSE_CONFIG[purpose || "election"] || PURPOSE_CONFIG.election;
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "2px 8px", borderRadius: 6,
        background: cfg.bg, color: cfg.color,
        fontSize: 11, fontWeight: 600, fontFamily: "var(--font-cjk)",
        whiteSpace: "nowrap", flexShrink: 0,
      }}>
        {cfg.icon} {t(cfg.labelKey as any)}
      </span>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "auto" }}>
        <div style={{ padding: "16px clamp(16px, 2vw, 32px)", maxWidth: 1200, margin: "0 auto", width: "100%" }}>

          {/* Existing Projects Section */}
          <div style={{ maxWidth: 900, margin: "0 auto", marginBottom: 48 }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <h1 style={{ fontSize: 32, fontWeight: 800, margin: "0 0 12px 0", fontFamily: "var(--font-cjk)", background: "linear-gradient(90deg, #fff, #a1a1aa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                {t("wslist.title")}
              </h1>
              <p style={{ fontSize: 15, color: "rgba(255,255,255,0.5)", maxWidth: 600, margin: "0 auto", lineHeight: 1.6, fontFamily: "var(--font-cjk)" }}>
                {t("wslist.subtitle")}
              </p>
            </div>

            {loading ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: 32 }}>
                <div style={{
                  width: 20, height: 20, border: "2px solid var(--border-subtle)",
                  borderTopColor: "var(--accent-light)", borderRadius: "50%",
                  animation: "spin 0.8s linear infinite"
                }} />
                <span style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-tertiary)" }}>{t("wslist.loading")}</span>
              </div>
            ) : workspaces.length === 0 ? (
              <div className="card" style={{ textAlign: "center", padding: 40, marginBottom: 8 }}>
                <p style={{ fontFamily: "var(--font-cjk)", fontSize: 14, color: "var(--text-muted)", marginBottom: 8 }}>
                  {t("wslist.empty.title")}
                </p>
                <p style={{ fontFamily: "var(--font-cjk)", fontSize: 12, color: "var(--text-faint)" }}>
                  {t("wslist.empty.hint")}
                </p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
                {[...workspaces].sort((a, b) => b.updated_at - a.updated_at).map((ws) => {
                  const cfg = PURPOSE_CONFIG[(ws as any).purpose] || PURPOSE_CONFIG.election;
                  return (
                    <div
                      key={ws.id}
                      onClick={() => router.push(`/workspaces/${ws.id}`)}
                      style={{
                        background: "rgba(255,255,255,0.02)",
                        border: "1px solid rgba(255,255,255,0.08)",
                        borderRadius: 16, padding: 24, cursor: "pointer",
                        transition: "all 0.2s", position: "relative", overflow: "hidden",
                        display: "flex", flexDirection: "column", gap: 12,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = cfg.border;
                        e.currentTarget.style.background = cfg.bg;
                        e.currentTarget.style.transform = "translateY(-2px)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
                        e.currentTarget.style.background = "rgba(255,255,255,0.02)";
                        e.currentTarget.style.transform = "none";
                      }}
                    >
                      <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 3, background: cfg.color, opacity: 0.6 }} />
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{
                          width: 40, height: 40, borderRadius: 10,
                          background: `linear-gradient(135deg, ${cfg.color}, ${cfg.color}aa)`,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          flexShrink: 0, fontSize: 18,
                        }}>
                          {cfg.icon}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{
                            fontFamily: "var(--font-cjk)", fontSize: 15, fontWeight: 700,
                            color: "var(--text-primary)", display: "block",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}>
                            {ws.name}
                          </span>
                          {getPurposeTag((ws as any).purpose)}
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
                        <span style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-muted)" }}>
                          {t("wslist.source_count", { n: ws.source_count || 0 })}
                        </span>
                        {ws.has_synthesis && (
                          <span style={{
                            padding: "1px 6px", borderRadius: 4,
                            backgroundColor: "var(--green-bg)", color: "var(--green)",
                            fontFamily: "var(--font-cjk)", fontSize: 10, fontWeight: 500,
                          }}>
                            {t("wslist.synthesized")}
                          </span>
                        )}
                        <span style={{ fontFamily: "var(--font-sans)", fontSize: 10, color: "var(--text-faint)", marginLeft: "auto" }}>
                          {formatDate(ws.updated_at)}
                        </span>
                      </div>

                      {/* Delete button */}
                      <button
                        onClick={(e) => handleDelete(ws.id, e)}
                        style={{
                          position: "absolute", top: 12, right: 12,
                          background: "none", border: "none", cursor: "pointer",
                          color: "var(--text-faint)", padding: 4, borderRadius: 6,
                          transition: "color 0.2s", opacity: 0.5,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--pink)"; e.currentTarget.style.opacity = "1"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; e.currentTarget.style.opacity = "0.5"; }}
                        title={t("wslist.delete_tooltip")}
                      >
                        <svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M3 5h12M7 5V3h4v2M5 5v10h8V5" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Divider */}
          <div style={{ maxWidth: 900, margin: "0 auto 32px auto", borderTop: "1px solid rgba(255,255,255,0.06)" }} />

          {/* Create New Project Section — Stage 1.8: opens the central
              CreateWorkspaceDialog (which has the template picker) instead
              of doing an inline create that bypasses template selection. */}
          <div style={{ maxWidth: 900, margin: "0 auto" }}>
            <h2 style={{ fontFamily: "var(--font-cjk)", fontSize: 18, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
              {t("wslist.create.title")}
            </h2>
            <p style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>
              {t("wslist.create.desc")}
            </p>

            <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
              <button
                className="btn-primary"
                style={{ padding: "12px 32px", fontSize: 14, whiteSpace: "nowrap" }}
                onClick={() => setShowCreateDialog(true)}
              >
                {t("wslist.create.btn")}
              </button>
            </div>
          </div>
        </div>
    </div>
  );
}
