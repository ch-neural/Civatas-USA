// ap/services/web/src/lib/vendor-presets.ts
// Shared vendor presets and conversion helpers between OnboardingWizard and SettingsPanel.
// Bridges the UI model (providers + role assignments) to the backend flat VendorEntry[] format.

/* ─── Vendor Presets ─── */

export const VENDOR_PRESETS: Record<
  string,
  { label: string; defaultModel: string; systemModel: string; keyUrl: string }
> = {
  openai:   { label: "OpenAI",   defaultModel: "gpt-4o-mini",      systemModel: "o4-mini",        keyUrl: "https://platform.openai.com/api-keys" },
  gemini:   { label: "Gemini",   defaultModel: "gemini-2.5-flash", systemModel: "gemini-2.5-flash", keyUrl: "https://aistudio.google.com/apikey" },
  xai:      { label: "xAI",      defaultModel: "grok-3-mini",      systemModel: "grok-3-mini",    keyUrl: "https://console.x.ai/" },
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-chat",    systemModel: "deepseek-chat",  keyUrl: "https://platform.deepseek.com/api_keys" },
  moonshot: { label: "Moonshot", defaultModel: "kimi-k2.5",        systemModel: "kimi-k2.5",      keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  ollama:   { label: "Ollama",   defaultModel: "llama3",           systemModel: "llama3",         keyUrl: "" },
};

/* ─── Types ─── */

/** A unique LLM provider (credentials). Multiple roles can share one provider. */
export interface Provider {
  id: string;
  vendor_type: string;
  display_name: string;
  api_key: string;
  base_url: string;
}

/** A role assignment mapping a provider to a specific model. */
export interface RoleAssignment {
  provider_id: string;
  model: string;
}

/** Backend-compatible vendor entry (flat format used by the settings API). */
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

/* ─── Build settings payload (UI model -> backend) ─── */

export interface SettingsPayload {
  llm_mode: string;
  llm_vendors: VendorEntry[];
  active_vendors: string[];
  vendor_ratio: string;
  system_vendor_id: string;
  serper_api_key: string;
}

/**
 * Convert the UI model (providers + role assignments) into the backend-compatible
 * settings payload.
 *
 * Each agent LLM becomes a VendorEntry using the provider's credentials + the
 * assigned model. The system LLM becomes a VendorEntry with id "system-llm"
 * unless it exactly matches an existing agent entry (same vendor_type, api_key,
 * base_url, model) — in that case we reuse the agent entry's id.
 */
export function buildSettingsPayload(
  providers: Provider[],
  systemLlm: RoleAssignment,
  agentLlms: RoleAssignment[],
  serperKey: string,
): SettingsPayload {
  const providerById = new Map(providers.map((p) => [p.id, p]));

  // Build agent vendor entries (use index suffix to avoid duplicate IDs
  // when multiple agentLlms reference the same provider with different models)
  const providerUsageCount = new Map<string, number>();
  const agentVendors: VendorEntry[] = agentLlms
    .map((a) => {
      const p = providerById.get(a.provider_id);
      if (!p) return null;
      const count = (providerUsageCount.get(p.id) ?? 0) + 1;
      providerUsageCount.set(p.id, count);
      return {
        id: count > 1 ? `${p.id}-${count}` : p.id,
        display_name: p.display_name,
        vendor_type: p.vendor_type,
        api_key: p.api_key,
        model: a.model,
        base_url: p.base_url,
      };
    })
    .filter((v): v is VendorEntry => v !== null);

  // Determine system vendor entry
  const sysProvider = providerById.get(systemLlm.provider_id);
  let systemVendorId = "";
  const allVendors: VendorEntry[] = [...agentVendors];

  if (sysProvider) {
    // Check if system LLM exactly matches an existing agent entry
    const match = agentVendors.find(
      (v) =>
        v.vendor_type === sysProvider.vendor_type &&
        v.api_key === sysProvider.api_key &&
        v.base_url === sysProvider.base_url &&
        v.model === systemLlm.model,
    );

    if (match) {
      systemVendorId = match.id;
    } else {
      systemVendorId = "system-llm";
      const preset = VENDOR_PRESETS[sysProvider.vendor_type];
      allVendors.push({
        id: systemVendorId,
        display_name: `System (${preset?.label ?? sysProvider.vendor_type})`,
        vendor_type: sysProvider.vendor_type,
        api_key: sysProvider.api_key,
        model: systemLlm.model,
        base_url: sysProvider.base_url,
      });
    }
  } else if (agentVendors.length > 0) {
    // Fallback: reuse first agent vendor as system
    systemVendorId = agentVendors[0].id;
  }

  return {
    llm_mode: "multi",
    llm_vendors: allVendors,
    active_vendors: agentVendors.map((v) => v.id),
    vendor_ratio: agentVendors.map(() => "1").join(":"),
    system_vendor_id: systemVendorId,
    serper_api_key: serperKey,
  };
}

/* ─── Parse settings (backend -> UI model) ─── */

export interface ParsedSettings {
  providers: Provider[];
  systemLlm: RoleAssignment;
  agentLlms: RoleAssignment[];
}

/**
 * Reverse conversion: take backend settings and reconstruct the UI model.
 *
 * Deduplicates vendors by (vendor_type, api_key, base_url) to get unique
 * providers. For deduplication, prefers non-"system-llm" IDs.
 */
export function parseSettingsToProvidersAndRoles(settings: {
  llm_vendors?: VendorEntry[];
  active_vendors?: string[];
  system_vendor_id?: string;
}): ParsedSettings {
  const vendors = settings.llm_vendors ?? [];
  const activeIds = new Set(settings.active_vendors ?? []);
  const systemId = settings.system_vendor_id ?? "";

  // Deduplicate vendors by (vendor_type, api_key, base_url)
  const dedupeKey = (v: VendorEntry) =>
    `${v.vendor_type}\0${v.api_key}\0${v.base_url}`;

  const seen = new Map<string, Provider>();
  // Map from vendor id -> provider id (after deduplication)
  const vendorToProvider = new Map<string, string>();

  // Process non-system-llm entries first so they win the dedup
  const sorted = [...vendors].sort((a, b) => {
    if (a.id === "system-llm") return 1;
    if (b.id === "system-llm") return -1;
    return 0;
  });

  for (const v of sorted) {
    const key = dedupeKey(v);
    if (seen.has(key)) {
      vendorToProvider.set(v.id, seen.get(key)!.id);
    } else {
      // For system-llm entries, strip the "System (...)" wrapper to get a
      // clean display_name so the UI doesn't show polluted labels on round-trip.
      const cleanName =
        v.id === "system-llm"
          ? (VENDOR_PRESETS[v.vendor_type]?.label ?? v.vendor_type)
          : v.display_name;
      const provider: Provider = {
        id: v.id === "system-llm" ? `${v.vendor_type}-sys-${Date.now()}` : v.id,
        vendor_type: v.vendor_type,
        display_name: cleanName,
        api_key: v.api_key,
        base_url: v.base_url,
      };
      seen.set(key, provider);
      vendorToProvider.set(v.id, v.id);
    }
  }

  const providers = Array.from(seen.values());

  // Build agent LLM assignments from active_vendors
  const agentLlms: RoleAssignment[] = [];
  for (const id of activeIds) {
    const vendor = vendors.find((v) => v.id === id);
    if (vendor) {
      agentLlms.push({
        provider_id: vendorToProvider.get(id) ?? id,
        model: vendor.model,
      });
    }
  }

  // Build system LLM assignment
  let systemLlm: RoleAssignment;
  const sysVendor = vendors.find((v) => v.id === systemId);
  if (sysVendor) {
    systemLlm = {
      provider_id: vendorToProvider.get(systemId) ?? systemId,
      model: sysVendor.model,
    };
  } else if (agentLlms.length > 0) {
    systemLlm = { ...agentLlms[0] };
  } else {
    // Empty fallback
    systemLlm = { provider_id: "", model: "" };
  }

  return { providers, systemLlm, agentLlms };
}
