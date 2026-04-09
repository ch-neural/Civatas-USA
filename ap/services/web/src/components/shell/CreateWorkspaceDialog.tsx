"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useShellStore } from "@/store/shell-store";
import { createWorkspace, listWorkspaces, applyTemplateToWorkspace, listTemplates, type TemplateMeta } from "@/lib/api";
import { setActiveTemplateId } from "@/hooks/use-active-template";
import { useLocaleStore } from "@/store/locale-store";
import { useTr } from "@/lib/i18n";

// Stage 1.8 (Phase A.5): the legacy "purpose" cards (election / consumer /
// birth_policy / kmt_primary) had no behavioral effect on US workflows —
// only `kmt_primary` did anything (TW-specific primary simulation mode).
// We hardcode the workspace purpose to "election" and let the user focus on
// the one thing that matters: picking the right election template.

export default function CreateWorkspaceDialog() {
  const { showCreateDialog, setShowCreateDialog, cacheWorkspaceName } = useShellStore();
  const router = useRouter();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const t = useTr();

  // Hardcoded — see comment above the import block for why
  const selectedPurpose = "election";
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stage 1.8: template picker — local lazy fetch (only when dialog opens).
  // Avoids any module-level side effects from `useTemplateList`. Errors are
  // caught and don't prevent the dialog from rendering.
  const [templateList, setTemplateList] = useState<TemplateMeta[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState<boolean>(false);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");

  // Lazy fetch on first dialog open
  useEffect(() => {
    if (!showCreateDialog) return;
    if (templateList.length > 0) return; // already loaded
    let cancelled = false;
    setTemplatesLoading(true);
    listTemplates()
      .then((res) => {
        if (cancelled) return;
        const list = res.templates || [];
        setTemplateList(list);
        // Auto-pick first US national template if user hasn't picked one
        if (!selectedTemplate) {
          const firstUSNational = list.find(
            (t) => t.country === "US" && t.election?.scope === "national" && t.election?.is_generic
          ) || list.find((t) => t.country === "US");
          if (firstUSNational) setSelectedTemplate(firstUSNational.id);
        }
      })
      .catch((e) => {
        console.warn("Failed to load templates:", e);
        // Still allow dialog to function — user can create workspace without template
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => { cancelled = true; };
  }, [showCreateDialog]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Group US templates so the dropdown is structured: National first, then By State
  const groupedTemplates = useMemo(() => {
    const usTemplates = templateList.filter((t) => t.country === "US");
    const groups: Record<string, TemplateMeta[]> = {
      national: [],
      state: [],
      other: [],
    };
    for (const t of usTemplates) {
      const scope = t.election?.scope;
      if (scope === "national") groups.national.push(t);
      else if (scope === "state") groups.state.push(t);
      else groups.other.push(t);
    }
    groups.national.sort((a, b) => {
      const aGen = a.election?.is_generic ? 0 : 1;
      const bGen = b.election?.is_generic ? 0 : 1;
      if (aGen !== bGen) return aGen - bGen;
      return (b.election?.cycle || 0) - (a.election?.cycle || 0);
    });
    groups.state.sort((a, b) => (a.region_code || "").localeCompare(b.region_code || ""));
    return groups;
  }, [templateList]);

  const selectedTemplateMeta = useMemo(
    () => templateList.find((t) => t.id === selectedTemplate) || null,
    [templateList, selectedTemplate],
  );

  // Focus input when opened
  useEffect(() => {
    if (showCreateDialog) {
      setName("");
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [showCreateDialog]);

  // Escape to close
  useEffect(() => {
    if (!showCreateDialog) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowCreateDialog(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [showCreateDialog, setShowCreateDialog]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const finalName = name.trim() || t("createws.default_name");
      const ws = await createWorkspace(finalName, selectedPurpose);
      cacheWorkspaceName(ws.id, finalName);

      // Stage 1.8: apply selected template to the new workspace immediately
      // and persist as the active template. Downstream panels (Population
      // Setup, Calibration, Prediction, Historical Evolution) will pick up
      // the template defaults via useActiveTemplate(wsId).
      if (selectedTemplate) {
        try {
          await applyTemplateToWorkspace(ws.id, selectedTemplate);
          setActiveTemplateId(ws.id, selectedTemplate);
          // Auto-switch UI locale if the template is US
          if (selectedTemplateMeta?.country === "US" || selectedTemplateMeta?.locale === "en-US") {
            setLocale("en");
          }
        } catch (e: any) {
          console.warn("Failed to apply template on workspace creation:", e);
          // Don't block workspace creation if template apply fails
        }
      }

      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setShowCreateDialog(false);
      router.push(`/workspaces/${ws.id}`);
    } catch (err: any) {
      setError(err?.message || t("createws.error_generic"));
    } finally {
      setCreating(false);
    }
  };

  if (!showCreateDialog) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      onClick={() => setShowCreateDialog(false)}
    >
      <div className="absolute inset-0 bg-black/50" />

      <div
        className="relative w-[480px] bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="font-cjk text-[15px] font-bold text-text-primary">{t("createws.title")}</h2>
          <button
            onClick={() => setShowCreateDialog(false)}
            className="text-text-faint hover:text-text-secondary transition-colors text-[18px] leading-none"
          >
            ×
          </button>
        </div>

        {/* Stage 1.8: Template selector — the only thing that actually
            matters when creating a workspace. The legacy "purpose" cards
            were removed because they had no behavioral effect. */}
        <div className="px-5 pt-4 pb-3">
          <div className="text-[11px] font-cjk text-text-muted mb-2">{t("createws.template_label")}</div>
          {templatesLoading ? (
            <div className="text-[11px] text-text-faint">{t("createws.templates_loading")}</div>
          ) : (
            <select
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(e.target.value)}
              disabled={creating}
              style={{
                width: "100%", padding: "8px 12px", borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 12,
                outline: "none", fontFamily: "var(--font-cjk)",
              }}
            >
              {groupedTemplates.national.length > 0 && (
                <optgroup label="🇺🇸 National Presidential — all 51 states">
                  {groupedTemplates.national.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}{tpl.election?.cycle ? ` · ${tpl.election.cycle}` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {groupedTemplates.state.length > 0 && (
                <optgroup label="🗺 By State — one state only">
                  {groupedTemplates.state.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.region_code} · {tpl.region}{tpl.metadata?.state_pvi_label ? ` (${tpl.metadata.state_pvi_label})` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          {selectedTemplateMeta && (
            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginTop: 4, lineHeight: 1.5 }}>
              {selectedTemplateMeta.region}
              {selectedTemplateMeta.metadata?.state_pvi_label && ` · Cook PVI ${selectedTemplateMeta.metadata.state_pvi_label}`}
              {selectedTemplateMeta.metadata?.national_pvi_label && ` · Cook PVI ${selectedTemplateMeta.metadata.national_pvi_label}`}
              {selectedTemplateMeta.metadata?.county_count && ` · ${selectedTemplateMeta.metadata.county_count} counties`}
              {selectedTemplateMeta.election?.candidate_count != null && ` · ${selectedTemplateMeta.election.candidate_count} candidates`}
            </div>
          )}
        </div>

        {/* Name input + create */}
        <div className="px-5 pb-5">
          <div className="text-[11px] font-cjk text-text-muted mb-2">{t("createws.name_label")}</div>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              className="input-field flex-1"
              placeholder={t("createws.name_placeholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creating) handleCreate();
              }}
              disabled={creating}
            />
            <button
              onClick={handleCreate}
              disabled={creating}
              className="btn-primary"
              style={{ padding: "10px 20px", fontSize: 13, whiteSpace: "nowrap" }}
            >
              {creating ? t("createws.btn_creating") : t("createws.btn_create")}
            </button>
          </div>
          {error && (
            <div className="mt-2 text-[11px] font-cjk text-pink">{error}</div>
          )}
        </div>
      </div>
    </div>
  );
}
