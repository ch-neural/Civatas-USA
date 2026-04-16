/**
 * Stage 1.8: hooks for the workspace's "active template".
 *
 * Civatas-USA template-driven defaults: panels (Calibration, Prediction,
 * Sandbox) read their seed values (party detection, macro context, search
 * keywords, calibration params) from whatever template the user picked
 * when generating the population.
 *
 * Where the active template ID lives:
 *   localStorage[`activeTemplate_${wsId}`] = "presidential_national_generic"
 *
 * `PopulationSetupPanel` writes this when the user clicks Generate, and
 * other panels read from it via `useActiveTemplate(wsId)`.
 *
 * Falls back to `null` if no template is active — panels that consume this
 * hook should keep their existing TW seed defaults as the fallback path so
 * the Taiwan workflow still works.
 */
import { useEffect, useState } from "react";
import { getTemplate, listTemplates, apiFetch, type TemplateMeta } from "@/lib/api";

export type ActiveTemplate = any | null;

const STORAGE_KEY = (wsId: string) => `activeTemplate_${wsId}`;

/** Persist the active template id for a workspace. */
export function setActiveTemplateId(wsId: string, templateId: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY(wsId), templateId);
    // Notify same-tab listeners (storage event only fires across tabs)
    window.dispatchEvent(new CustomEvent("civatas:active-template-changed", {
      detail: { wsId, templateId },
    }));
  } catch {}
}

export function getActiveTemplateId(wsId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY(wsId));
  } catch {
    return null;
  }
}

/**
 * Reactive: returns the current workspace's active template (full body).
 * Re-renders when the user picks a different template via PopulationSetupPanel.
 */
export function useActiveTemplate(wsId: string): {
  template: ActiveTemplate;
  templateId: string | null;
  loading: boolean;
} {
  // SSR-safe: always start with null/true so server and client agree on initial render.
  // The useEffect below reads localStorage on the client after hydration.
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [template, setTemplate] = useState<ActiveTemplate>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Initialize from localStorage on client (after hydration — avoids React error #310)
  useEffect(() => {
    const stored = getActiveTemplateId(wsId);
    if (stored) {
      setTemplateId(stored);
      // loading stays true until the template body fetch completes
    } else {
      // No entry in localStorage — let the fallback inference effect run
      // (it will set loading=false when done)
    }
  }, [wsId]);

  // Listen for active-template changes (same-tab CustomEvent + cross-tab storage)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => setTemplateId(getActiveTemplateId(wsId));
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY(wsId)) setTemplateId(e.newValue);
    };
    window.addEventListener("civatas:active-template-changed", onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("civatas:active-template-changed", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [wsId]);

  // If localStorage has no entry, fall back to inferring the template from
  // the workspace's sources (supports workspaces created before this fix).
  useEffect(() => {
    if (templateId || !wsId) { setLoading(false); return; }
    let cancelled = false;
    apiFetch(`/api/workspaces/${wsId}`)
      .then((ws: any) => {
        if (cancelled) return;
        const tplSource = (ws?.sources ?? []).find((s: any) =>
          typeof s.id === "string" && s.id.startsWith("template_")
        );
        if (tplSource) {
          const inferredId = tplSource.id.replace(/^template_/, "");
          setActiveTemplateId(wsId, inferredId);
          setTemplateId(inferredId);
          // loading stays true until template body fetch completes below
        } else {
          setLoading(false); // no template source found
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [wsId, templateId]);

  // Fetch the full template body whenever the id changes
  useEffect(() => {
    if (!templateId) {
      setTemplate(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getTemplate(templateId)
      .then((data) => {
        if (cancelled) return;
        if (data && !data.error) setTemplate(data);
        else setTemplate(null);
      })
      .catch(() => {
        if (cancelled) return;
        setTemplate(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [templateId]);

  return { template, templateId, loading };
}

/**
 * One-shot fetch of the template list (for the picker UI). Cached at
 * module-level so multiple components don't refetch every render.
 */
let _templateListCache: TemplateMeta[] | null = null;
let _templateListPromise: Promise<TemplateMeta[]> | null = null;

export function useTemplateList(): { list: TemplateMeta[]; loading: boolean; error: string | null } {
  const [list, setList] = useState<TemplateMeta[]>(_templateListCache || []);
  const [loading, setLoading] = useState<boolean>(_templateListCache === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (_templateListCache !== null) {
      setList(_templateListCache);
      setLoading(false);
      return;
    }
    if (!_templateListPromise) {
      _templateListPromise = listTemplates()
        .then((res) => {
          _templateListCache = res.templates || [];
          return _templateListCache;
        })
        .catch((e) => {
          _templateListPromise = null;
          throw e;
        });
    }
    let cancelled = false;
    _templateListPromise
      .then((data) => {
        if (cancelled) return;
        setList(data);
        setLoading(false);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.message || "failed to load templates");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { list, loading, error };
}

/** Clear the cached template list (call after refetch needed, e.g. after upload). */
export function invalidateTemplateList() {
  _templateListCache = null;
  _templateListPromise = null;
}
