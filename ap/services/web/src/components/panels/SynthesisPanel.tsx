"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import SynthesisResultCharts from "@/components/SynthesisResultCharts";
import LoadingSpinner from "@/components/ui/LoadingSpinner";
import {
  getWorkspace,
  synthesizeInWorkspace,
  getSynthesisResult,
  uploadLeaningProfile,
  getLeaningProfile,
  deleteLeaningProfile,
  parseLeaningProfile,
  extractTextFromFile,
  getDefaultLeaningProfiles,
  applyDefaultLeaningProfile,
  generateWorkspacePersonas,
  getPersonaProgress,
  getWorkspacePersonas,
  type WorkspaceDetail,
} from "@/lib/api";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

interface SynthPerson {
  [key: string]: string | number;
}

export default function SynthesisPanel({ wsId }: { wsId: string }) {
  const router = useRouter();


  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [targetCount, setTargetCount] = useState(() => {
    if (typeof window === "undefined") return 50;
    const saved = sessionStorage.getItem(`synth_count_${wsId}`);
    return saved ? Number(saved) : 50;
  });
  const [persons, setPersons] = useState<SynthPerson[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const pageSize = 20;

  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string[]>>(() => {
    if (typeof window === "undefined") return {};
    const saved = sessionStorage.getItem(`synth_filters_${wsId}`);
    return saved ? JSON.parse(saved) : {};
  });
  const [showFilters, setShowFilters] = useState(false);

  const [selectedDims, setSelectedDims] = useState<string[]>([]);
  const [showSelectedDims, setShowSelectedDims] = useState(false);

  const [leaningProfile, setLeaningProfile] = useState<{ exists: boolean, data?: any } | null>(null);
  const [uploadingProfile, setUploadingProfile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Default Leaning Profiles
  const [defaultProfiles, setDefaultProfiles] = useState<Record<string, {id: string, name: string}[]>>({});
  const [selectedDefaultProfile, setSelectedDefaultProfile] = useState("");
  const [applyingDefault, setApplyingDefault] = useState(false);

  // Smart Upload states for Leaning Profile
  const [smartParseText, setSmartParseText] = useState("");
  const [parsingProfile, setParsingProfile] = useState(false);
  const [isFileSelected, setIsFileSelected] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState("");
  const [showLeaningChart, setShowLeaningChart] = useState(false);

  // ── Auto persona generation after synthesis ──
  const [autoPersona, setAutoPersona] = useState(true);
  const [personaRunning, setPersonaRunning] = useState(false);
  const [personaProgress, setPersonaProgress] = useState({ done: 0, total: 0 });
  const [personaDone, setPersonaDone] = useState(false);
  const [personaStrategy, setPersonaStrategy] = useState("template");
  const personaPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // States for previewing default leaning profiles
  const [expandedLeaningCategory, setExpandedLeaningCategory] = useState<string | null>(null);
  const [expandedLeaningPresetId, setExpandedLeaningPresetId] = useState<string | null>(null);
  const [leaningPresetDetails, setLeaningPresetDetails] = useState<Record<string, any>>({});
  const [loadingLeaningPreviewId, setLoadingLeaningPreviewId] = useState<string | null>(null);

  const computeLeaningChartData = (dataObj: any) => {
    if (!dataObj) return [];
    const districtData = dataObj.districts || dataObj;
    return Object.entries(districtData)
      .filter(([key]) => key !== "spectrum" && key !== "count" && key !== "districts")
      .map(([district, probs]: [string, any]) => ({
        name: district,
        "偏左派": (probs["偏左派"] || 0) * 100,
        "中立": (probs["中立"] || 0) * 100,
        "偏右派": (probs["偏右派"] || 0) * 100,
      })).sort((a, b) => b["偏左派"] - a["偏左派"]);
  };

  const toggleLeaningPresetPreview = async (presetId: string) => {
    if (expandedLeaningPresetId === presetId) {
      setExpandedLeaningPresetId(null);
      return;
    }
    setExpandedLeaningPresetId(presetId);
    if (!leaningPresetDetails[presetId]) {
      setLoadingLeaningPreviewId(presetId);
      try {
        const { getDefaultLeaningProfileDetail } = await import('@/lib/api');
        const data = await getDefaultLeaningProfileDetail(presetId);
        setLeaningPresetDetails(prev => ({ ...prev, [presetId]: data.districts || data }));
      } catch (e) {
        console.error(e);
      } finally {
        setLoadingLeaningPreviewId(null);
      }
    }
  };

  const leaningChartData = useMemo(() => {
    if (!leaningProfile?.exists || !leaningProfile.data) return [];
    return computeLeaningChartData(leaningProfile.data);
  }, [leaningProfile]);

  // Extract district list from leaning profile for constraining synthesis filters
  const leaningDistricts = useMemo(() => {
    if (!leaningProfile?.exists || !leaningProfile.data) return [];
    const districts = leaningProfile.data.districts || {};
    return Object.keys(districts);
  }, [leaningProfile]);

  const availableFilters = useMemo(() => {
    if (!workspace) return {};
    const rawFilters: Record<string, Set<string>> = {};
    
    const skipWords = new Set(["計", "總計", "合計", "小計", "total", "subtotal", "unknown"]);

    workspace.sources.forEach(src => {
      // 1. Extract from top-level dimensions (categories / bins)
      Object.entries(src.dimensions || {}).forEach(([dimName, dim]) => {
        if (!rawFilters[dimName]) rawFilters[dimName] = new Set();

        // Use type assertions since any from lib/api
        if ((dim as any).categories) {
          (dim as any).categories.forEach((c: any) => {
            const val = String(c.value).trim().toLowerCase();
            if (!skipWords.has(val)) rawFilters[dimName].add(c.value);
          });
        } else if ((dim as any).bins) {
          (dim as any).bins.forEach((b: any) => {
            const val = String(b.range).trim().toLowerCase();
            if (!skipWords.has(val)) rawFilters[dimName].add(b.range);
          });
        }
      });

      // 2. Extract from joint_table_dims (covers dims like age that may
      //    exist in joint tables but not in top-level dimensions)
      const jtDims = (src as any).joint_table_dims || {};
      Object.entries(jtDims).forEach(([dimName, values]) => {
        if (!rawFilters[dimName]) rawFilters[dimName] = new Set();
        (values as string[]).forEach(v => {
          const lower = v.trim().toLowerCase();
          if (!skipWords.has(lower)) rawFilters[dimName].add(v);
        });
      });
    });
    
    const result: Record<string, string[]> = {};
    Object.keys(rawFilters).forEach(key => {
      if (rawFilters[key].size === 0) return; // skip empty
      let arr = Array.from(rawFilters[key]);

      // When leaning profile is loaded, constrain district to intersection
      if (key === "district" && leaningDistricts.length > 0) {
        arr = arr.filter(v => leaningDistricts.includes(v));
        if (arr.length === 0) return; // skip if no intersection
      }

      // Sort numerically if values contain digits (e.g. age bins "5-9歲" → sort by leading number)
      const hasNumeric = arr.some(v => /\d/.test(v));
      if (hasNumeric) {
        arr.sort((a, b) => {
          const na = parseInt((a.match(/\d+/) || ['999999'])[0], 10);
          const nb = parseInt((b.match(/\d+/) || ['999999'])[0], 10);
          return na - nb;
        });
      } else {
        arr.sort();
      }
      result[key] = arr;
    });

    // Deduplicate age-like dimensions: if multiple dimensions map to "age", 
    // keep only the one with the most bins (highest granularity)
    const ageKeys = Object.keys(result).filter(k => /age|年齡/i.test(k) || result[k].some(v => /\d+.*歲/.test(v)));
    if (ageKeys.length > 1) {
      let maxLen = -1;
      let keepKey = "";
      ageKeys.forEach(k => {
        if (result[k].length > maxLen) {
          maxLen = result[k].length;
          keepKey = k;
        }
      });
      ageKeys.forEach(k => {
        if (k !== keepKey) {
          delete result[k];
        }
      });
    }

    return result;
  }, [workspace, leaningDistricts]);

  // Initialize filters based on available filters, but preserve user's previous unchecks
  useEffect(() => {
    setFilters(prev => {
      let changed = false;
      const next: Record<string, string[]> = {};
      
      // Detect age-like dimensions (contain bins with digits + 歲)
      const isAgeDim = (dimName: string, values: string[]) =>
        /age|年齡/i.test(dimName) || values.some(v => /\d+.*歲/.test(v));

      Object.entries(availableFilters).forEach(([dim, values]) => {
        if (!prev[dim]) {
          // New dimension (or initial load):
          if (isAgeDim(dim, values)) {
            // Default: only select age bins that could contain adults (upper bound >= 20 or no upper bound)
            next[dim] = values.filter(v => {
              const nums = (v.match(/\d+/g) || ['0']).map(n => parseInt(n, 10));
              let upper = 999;
              if (nums.length === 2) {
                upper = Math.max(nums[0], nums[1]);
              } else if (nums.length === 1) {
                if (v.includes("以下") || v.includes("-") || v.includes("~")) {
                  upper = nums[0];
                }
              }
              return upper >= 20;
            });
          } else {
            // Non-age: select all by default
            next[dim] = values;
          }
          changed = true;
        } else {
          // Existing dimension: keep selected values, but ensure they are still available
          const validValues = prev[dim].filter(v => values.includes(v));
          next[dim] = validValues;
          if (validValues.length !== prev[dim].length) changed = true;
        }
      });
      
      // If any old dimensions were removed from availableFilters
      if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
      
      return changed ? next : prev;
    });
  }, [availableFilters]);

  // Initialize selectedDims
  useEffect(() => {
    setSelectedDims(Object.keys(availableFilters));
  }, [availableFilters]);

  // Persist filters & targetCount to sessionStorage
  useEffect(() => {
    if (Object.keys(filters).length > 0) {
      sessionStorage.setItem(`synth_filters_${wsId}`, JSON.stringify(filters));
    }
  }, [filters, wsId]);

  useEffect(() => {
    sessionStorage.setItem(`synth_count_${wsId}`, String(targetCount));
  }, [targetCount, wsId]);



  const loadWorkspace = useCallback(async () => {
    try {
      const ws = await getWorkspace(wsId);
      setWorkspace(ws);
    } catch (err) {
      console.error("Failed to load workspace:", err);
    } finally {
      setLoading(false);
    }
  }, [wsId, router]);

  // Load workspace + saved synthesis results on mount
  useEffect(() => {
    loadWorkspace();
    // Try to load persona results first (has richer data including personality),
    // fall back to synthesis-only results
    getWorkspacePersonas(wsId)
      .then((res) => {
        const agents = res?.agents || (Array.isArray(res) ? res : []);
        if (agents.length > 0) { setPersons(agents); return; }
        // Fallback: synthesis-only data
        return getSynthesisResult(wsId).then((r) => { if (r?.persons) setPersons(r.persons); });
      })
      .catch(() => {
        getSynthesisResult(wsId)
          .then((res) => { if (res?.persons) setPersons(res.persons); })
          .catch(() => {});
      });
  }, [wsId, loadWorkspace]);

  const loadLeaningProfile = useCallback(async () => {
    try {
      const res = await getLeaningProfile();
      setLeaningProfile(res);
    } catch {
      setLeaningProfile(null);
    }
  }, []);

  useEffect(() => {
    loadLeaningProfile();
    
    // Load default profiles
    getDefaultLeaningProfiles()
      .then(res => {
        if (res?.categories) {
          setDefaultProfiles(res.categories);
        }
      })
      .catch(() => {});
  }, [loadLeaningProfile]);

  const handleProfileFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIsFileSelected(true);
      setSelectedFileName(file.name);
    } else {
      setIsFileSelected(false);
      setSelectedFileName("");
    }
  };

  const handleProfileUploadDirect = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setUploadingProfile(true);
    try {
      await uploadLeaningProfile(file);
      await loadLeaningProfile();
      // Reset
      setSmartParseText("");
      setIsFileSelected(false);
      setSelectedFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      alert(`上傳失敗: ${err.message || String(err)}`);
    } finally {
      setUploadingProfile(false);
    }
  };

  const handleProfileSmartParse = async () => {
    if (!smartParseText.trim() && !isFileSelected) return;
    setParsingProfile(true);
    try {
      let textToParse = smartParseText;
      let base64Image = undefined;

      const file = fileInputRef.current?.files?.[0];
      if (file) {
        if (file.type.startsWith("image/")) {
            const buf = await file.arrayBuffer();
            base64Image = Buffer.from(buf).toString("base64");
        } else {
            // Always use backend extraction to handle encodings (like Big5 for Taiwan gov CSVs)
            const extracted = await extractTextFromFile(file);
            textToParse = extracted.text || textToParse;
        }
      }

      const result = await parseLeaningProfile(textToParse, base64Image);
      
      // result is the JSON data. We wrap it in a File and upload it.
      const jsonStr = JSON.stringify(result, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const newFile = new File([blob], "smart_profile.json", { type: "application/json" });
      
      await uploadLeaningProfile(newFile);
      await loadLeaningProfile();
      
      // Reset
      setSmartParseText("");
      setIsFileSelected(false);
      setSelectedFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      alert(`AI 解析或上傳失敗: ${err.message || String(err)}`);
    } finally {
      setParsingProfile(false);
    }
  };

  const handleApplyDefaultProfile = async (profileId?: string) => {
    const targetProfile = profileId || selectedDefaultProfile;
    if (!targetProfile) return;
    setApplyingDefault(true);
    if (profileId) setSelectedDefaultProfile(profileId);
    try {
      await applyDefaultLeaningProfile(targetProfile);
      await loadLeaningProfile();
      setSelectedDefaultProfile("");
    } catch (err: any) {
      alert(`載入預設檔失敗: ${err.message || String(err)}`);
    } finally {
      setApplyingDefault(false);
    }
  };

  const handleProfileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    handleProfileFileChange(e);
  };

  const handleProfileDelete = async () => {
    if (!confirm("確定要刪除現有的政治光譜設定檔嗎？")) return;
    try {
      await deleteLeaningProfile();
      await loadLeaningProfile();
    } catch (err: any) {
      alert(`刪除失敗: ${err.message || String(err)}`);
    }
  };



  const handleSynthesize = async () => {
    console.log("[Synthesis] handleSynthesize called", { wsId, targetCount, filters, synthesizing });
    setSynthesizing(true);
    setError(null);
    setPersonaDone(false);
    setPersonaProgress({ done: 0, total: 0 });
    try {
      console.log("[Synthesis] Calling synthesizeInWorkspace...");
      const result = await synthesizeInWorkspace(wsId, targetCount, filters, selectedDims);
      console.log("[Synthesis] Result received:", result?.count, "persons");
      setPersons(result.persons || []);
      setPageIndex(0);
      setShowFilters(false);
      await loadWorkspace();
      setSynthesizing(false);

      // ── Auto-chain persona generation ──
      if (autoPersona && result?.persons?.length > 0) {
        setPersonaRunning(true);
        try {
          const personaRes = await generateWorkspacePersonas(wsId, personaStrategy, 10);
          if (personaRes?.status === "started" || personaRes?.status === "running") {
            setPersonaProgress({ done: personaRes.done || 0, total: personaRes.total || 0 });
            // Start polling
            if (personaPollRef.current) clearInterval(personaPollRef.current);
            personaPollRef.current = setInterval(async () => {
              try {
                const prog = await getPersonaProgress(wsId);
                setPersonaProgress({ done: prog.done || 0, total: prog.total || 0 });
                if (prog.status === "done" || prog.status === "completed") {
                  if (personaPollRef.current) clearInterval(personaPollRef.current);
                  setPersonaRunning(false);
                  setPersonaDone(true);
                  // Refresh personas
                  try { const pRes = await getWorkspacePersonas(wsId); setPersons(pRes || []); } catch { }
                } else if (prog.status === "failed" || prog.status === "error") {
                  if (personaPollRef.current) clearInterval(personaPollRef.current);
                  setPersonaRunning(false);
                  setError(`市民人設生成失敗: ${prog.error || "未知錯誤"}`);
                }
              } catch { }
            }, 2000);
          } else if (personaRes?.agents) {
            // Template strategy returns immediately
            setPersonas(personaRes.agents);
            setPersonaRunning(false);
            setPersonaDone(true);
          }
        } catch (e: any) {
          setPersonaRunning(false);
          setError(`市民人設生成失敗: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      console.error("[Synthesis] Error:", e);
      setError(`合成失敗: ${e?.message || e}`);
      setSynthesizing(false);
    }
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (personaPollRef.current) clearInterval(personaPollRef.current); };
  }, []);



  if (loading) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (!workspace) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "auto" }}>

        <div style={{ padding: "16px clamp(16px, 2vw, 32px)", maxWidth: "100%", display: "flex", flexDirection: "column", gap: 20 }}>

{/* ── Synthesis Control ── */}
          {workspace.sources.length > 0 ? (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <label className="label">人口合成</label>

              {/* Leaning Profile Status Banner */}
              {leaningProfile && leaningProfile.exists ? (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 12px", borderRadius: 8,
                  background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)",
                  fontSize: 12, fontFamily: "var(--font-cjk)", color: "var(--green)",
                }}>
                  <span>✅</span>
                  <span>政治光譜已啟用（{leaningDistricts.length} 個行政區）— 行政區過濾器已自動限制為光譜涵蓋範圍</span>
                </div>
              ) : leaningProfile && !leaningProfile.exists ? (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 12px", borderRadius: 8,
                  background: "rgba(251,146,60,0.08)", border: "1px solid rgba(251,146,60,0.2)",
                  fontSize: 12, fontFamily: "var(--font-cjk)", color: "rgb(251,146,60)",
                }}>
                  <span>⚠️</span>
                  <span>尚未載入政治光譜。建議先至下方「政治光譜設定」區塊載入選舉數據，以限制行政區範圍。</span>
                </div>
              ) : null}

              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <label style={{ fontFamily: "var(--font-cjk)", fontSize: 12, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
                  目標人數
                </label>
                <input
                  type="number"
                  className="input-field"
                  value={targetCount}
                  onChange={(e) => setTargetCount(parseInt(e.target.value) || 50)}
                  style={{ maxWidth: 120 }}
                />
                <button
                  className="btn-primary"
                  style={{ padding: "10px 20px", fontSize: 13, whiteSpace: "nowrap", opacity: (synthesizing || personaRunning) ? 0.6 : 1 }}
                  onClick={handleSynthesize}
                  disabled={synthesizing || personaRunning}
                >
                  {synthesizing ? "合成中..." : personaRunning ? "生成人設中..." : autoPersona ? "合成人口 + 生成人設" : "開始合成"}
                </button>
              </div>

              {/* Auto-persona option + progress */}
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, fontFamily: "var(--font-cjk)", color: "var(--text-secondary)" }}>
                  <input type="checkbox" checked={autoPersona} onChange={e => setAutoPersona(e.target.checked)} />
                  合成後自動生成市民人設
                </label>
                {autoPersona && (
                  <select value={personaStrategy} onChange={e => setPersonaStrategy(e.target.value)}
                    style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.3)", color: "#fff", fontSize: 11, fontFamily: "var(--font-cjk)" }}>
                    <option value="template">快速模板</option>
                    <option value="llm">LLM 深度生成</option>
                  </select>
                )}
                {personaRunning && personaProgress.total > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 200 }}>
                    <div style={{ flex: 1, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                      <div style={{ width: `${Math.round((personaProgress.done / personaProgress.total) * 100)}%`, height: "100%", background: "#8b5cf6", borderRadius: 3, transition: "width 0.3s" }} />
                    </div>
                    <span style={{ fontSize: 11, color: "#8b5cf6", fontWeight: 600, whiteSpace: "nowrap" }}>
                      🎭 {personaProgress.done}/{personaProgress.total}
                    </span>
                  </div>
                )}
                {personaDone && (
                  <span style={{ fontSize: 12, color: "#22c55e", fontFamily: "var(--font-cjk)" }}>✅ 市民人設已生成</span>
                )}
              </div>

              {/* Selected Dimensions UI */}
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <label style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}>
                      ✅ 選擇要合成的特徵維度 (Select Features)
                    </label>
                    <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      被取消勾選的特徵將不會出現在合成的人口資料中
                    </span>
                  </div>
                  <button 
                    onClick={() => setShowSelectedDims(!showSelectedDims)}
                    style={{
                      background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                      color: "var(--text-secondary)", fontSize: 11, padding: "4px 8px", borderRadius: 4,
                      cursor: "pointer", display: "flex", alignItems: "center", gap: 4
                    }}
                  >
                    {showSelectedDims ? '縮合 ▲' : '展開 ▼'}
                  </button>
                </div>
                {showSelectedDims && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px", background: "rgba(0,0,0,0.1)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.05)" }}>
                    {Object.keys(availableFilters).map(dim => {
                      const isSelected = selectedDims.includes(dim);
                      return (
                        <label key={dim} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", padding: "6px 10px", background: isSelected ? "rgba(124,58,237,0.15)" : "transparent", border: isSelected ? "1px solid rgba(124,58,237,0.3)" : "1px solid var(--border-input)", borderRadius: 6, transition: "all 0.2s" }}>
                          <input 
                            type="checkbox" 
                            checked={isSelected}
                            onChange={(e) => {
                              if (e.target.checked) setSelectedDims(prev => [...prev, dim]);
                              else setSelectedDims(prev => prev.filter(x => x !== dim));
                            }}
                            style={{ accentColor: "var(--accent)" }}
                          />
                          <span style={{ color: isSelected ? "var(--accent-light)" : "var(--text-secondary)", fontWeight: isSelected ? 600 : 400 }}>{dim}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Filters UI */}
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <label style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}>
                      特徵條件過濾 (Filters)
                    </label>
                    <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      未勾選代表不限制 (Auto)
                    </span>
                  </div>
                  <button 
                    onClick={() => setShowFilters(!showFilters)}
                    style={{
                      background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                      color: "var(--text-secondary)", fontSize: 11, padding: "4px 8px", borderRadius: 4,
                      cursor: "pointer", display: "flex", alignItems: "center", gap: 4
                    }}
                  >
                    {showFilters ? '縮合 ▲' : '展開 ▼'}
                  </button>
                </div>
                {showFilters && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                    {Object.entries(availableFilters).map(([dim, values]) => {
                      if (values.length === 0) return null; // Skip dimensions without values
                      return (
                        <div key={dim} style={{ display: "flex", flexDirection: "column", gap: 6, width: 220 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <label style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>{dim}</label>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                                {filters[dim]?.length === values.length ? "全選" : `${filters[dim]?.length || 0} / ${values.length}`}
                              </span>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 6 }}>
                              <button
                                  style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-input)", background: "transparent", color: "var(--text-muted)", cursor: "pointer"}}
                                  onClick={() => setFilters(prev => ({...prev, [dim]: [...values]}))}
                              >全選</button>
                              <button
                                  style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-input)", background: "transparent", color: "var(--text-muted)", cursor: "pointer"}}
                                  onClick={() => setFilters(prev => ({...prev, [dim]: []}))}
                              >全不選</button>
                          </div>
                          <div style={{ 
                            display: "flex", flexDirection: "column", gap: 4, 
                            maxHeight: 140, overflowY: "auto", 
                            border: "1px solid var(--border-input)", borderRadius: 6,
                            padding: "6px 8px", backgroundColor: "rgba(0,0,0,0.2)"
                          }}>
                            {values.map(v => {
                              const isSelected = filters[dim]?.includes(v);
                              return (
                                <label key={v} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                                  <input 
                                    type="checkbox" 
                                    checked={isSelected || false}
                                    onChange={(e) => {
                                      const current = filters[dim] || [];
                                      if (e.target.checked) {
                                        setFilters(prev => ({ ...prev, [dim]: [...current, v] }));
                                      } else {
                                        setFilters(prev => ({ ...prev, [dim]: current.filter(x => x !== v) }));
                                      }
                                    }}
                                    style={{ accentColor: "var(--accent)" }}
                                  />
                                  <span style={{ color: isSelected ? "var(--text-primary)" : "var(--text-secondary)" }}>{v}</span>
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {error && (
                <p style={{ fontFamily: "var(--font-cjk)", fontSize: 12, color: "var(--pink)" }}>{error}</p>
              )}
            </div>
          ) : (
            <div className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "40px 20px" }}>
              <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--orange)" strokeWidth="1.2">
                <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <h3 style={{ fontFamily: "var(--font-cjk)", fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>尚未建立人口骨架</h3>
              <p style={{ fontFamily: "var(--font-cjk)", fontSize: 13, color: "var(--text-secondary)", textAlign: "center", maxWidth: 400 }}>
                開始合成前，您必須先提供基礎統計數據。請前往「基礎人口資料」分頁，匯入或上傳戶政人口統計資料包。
              </p>
              <button 
                onClick={() => router.push(`/workspaces/${wsId}`)}
                className="btn-primary" 
                style={{ marginTop: 8, padding: "8px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
              >
                <span>⬅️</span> 前往基礎人口資料
              </button>
            </div>
          )}

              {/* Leaning Profile Upload */}
              <div className="card" style={{ padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <h3 style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                      政治光譜設定 (Leaning Profile)
                    </h3>
                    <p style={{ marginTop: 4, fontSize: 11, color: "var(--text-secondary)", maxWidth: "80%" }}>
                      提供各行政區的政黨得票數據。您可以上傳 CSV/JSON，或直接貼上含各區得票數的純文字、新聞稿、甚至圖片，系統將使用 AI 智慧解析為真實政治傾向分佈比例。
                    </p>
                  </div>
                  {leaningProfile?.exists && (
                    <button
                      className="btn-danger"
                      style={{ padding: "6px 14px", fontSize: 12 }}
                      onClick={handleProfileDelete}
                    >
                      清空目前設定檔
                    </button>
                  )}
                </div>

                {!leaningProfile?.exists && (
                  <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
                    
                    {/* Left: Upload and Paste */}
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                      <textarea
                        placeholder="請貼上各區得票數據的文字或新聞稿..."
                        value={smartParseText}
                        onChange={(e) => setSmartParseText(e.target.value)}
                        style={{ 
                          flex: 1, height: 100, padding: 12, borderRadius: 8, fontSize: 13,
                          backgroundColor: "rgba(0,0,0,0.2)", color: "var(--text-primary)",
                          border: "1px solid var(--border-input)", resize: "none"
                        }}
                      />
                      
                      {Object.keys(defaultProfiles).length > 0 && (
                        <div style={{ marginTop: 24 }}>
                          <h4 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 12 }}>⚡ 快速匯入預設光譜資料包</h4>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                            {Object.entries(defaultProfiles).map(([category, profiles]) => (
                               <div key={category} className="card" style={{ padding: 0, overflow: "hidden", border: "1px solid rgba(255,255,255,0.08)" }}>
                                 <div 
                                    onClick={() => setExpandedLeaningCategory(expandedLeaningCategory === category ? null : category)}
                                    style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.02)" }}>
                                    <div style={{ fontSize: 13, fontWeight: 600 }}>{category} <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 400 }}>({profiles.length} 筆)</span></div>
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ transform: expandedLeaningCategory === category ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}><path d="M4 6l4 4 4-4" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                 </div>
                                 {expandedLeaningCategory === category && (
                                    <div style={{ padding: "8px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", gap: 4 }}>
                                      {profiles.map(preset => (
                                         <div key={preset.id} style={{ display: "flex", flexDirection: "column", borderRadius: 8, background: expandedLeaningPresetId === preset.id ? "rgba(139,92,246,0.06)" : "transparent", border: expandedLeaningPresetId === preset.id ? "1px solid var(--accent-light)" : "1px solid transparent", transition: "all 0.2s" }}>
                                            <div onClick={() => toggleLeaningPresetPreview(preset.id)} style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
                                               <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ transform: expandedLeaningPresetId === preset.id ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.2s" }}><path d="M6 12l4-4-4-4" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                               <div style={{ flex: 1, fontSize: 12, color: "var(--text-primary)" }}>{preset.name}</div>
                                               <button onClick={(e) => { e.stopPropagation(); handleApplyDefaultProfile(preset.id); }} disabled={applyingDefault} style={{ padding: "4px 10px", borderRadius: 6, background: "var(--accent-bg)", color: "var(--accent-light)", fontSize: 11, border: "none", cursor: applyingDefault ? "not-allowed" : "pointer" }}>{applyingDefault && selectedDefaultProfile === preset.id ? "⏳ 匯入中..." : "📥 匯入"}</button>
                                            </div>
                                            {expandedLeaningPresetId === preset.id && (
                                              <div style={{ padding: "0 12px 12px 12px" }}>
                                                {loadingLeaningPreviewId === preset.id ? (
                                                  <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>⏳ 讀取光譜資料中...</div>
                                                ) : leaningPresetDetails[preset.id] ? (
                                                  <div style={{ height: (Object.keys(leaningPresetDetails[preset.id]).length * 40) + 60, minHeight: 150, maxHeight: 400, marginTop: 8, padding: 12, border: "1px solid rgba(255,255,255,0.05)", borderRadius: 8, backgroundColor: "rgba(0,0,0,0.2)" }}>
                                                    <ResponsiveContainer width="100%" height="100%">
                                                      <BarChart data={computeLeaningChartData(leaningPresetDetails[preset.id])} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                                                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
                                                        <XAxis type="number" domain={[0, 100]} stroke="var(--text-muted)" tickFormatter={(val) => `${val}%`} />
                                                        <YAxis dataKey="name" type="category" width={80} stroke="var(--text-muted)" tick={{ fontSize: 11, fill: "var(--text-secondary)" }} />
                                                        <Tooltip formatter={(value: any) => `${Number(value).toFixed(1)}%`} contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151" }} itemStyle={{ fontSize: 12 }} labelStyle={{ color: "var(--text-primary)", fontWeight: 600, marginBottom: 8 }} />
                                                        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10, color: "rgba(255,255,255,0.7)" }} />
                                                        <Bar dataKey="偏左派" stackId="a" fill="#22c55e" />
                                                        <Bar dataKey="中立" stackId="a" fill="#9ca3af" />
                                                        <Bar dataKey="偏右派" stackId="a" fill="#3b82f6" />
                                                      </BarChart>
                                                    </ResponsiveContainer>
                                                  </div>
                                                ) : <div style={{ padding: 10, textAlign: "center", color: "var(--orange)" }}>無法載入圖表</div>}
                                              </div>
                                            )}
                                         </div>
                                      ))}
                                    </div>
                                 )}
                               </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    
                    {/* Right: Actions */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 200 }}>
                      <input
                        type="file"
                        ref={fileInputRef}
                        style={{ display: "none" }}
                        accept=".csv,.json,.pdf,.txt,.docx,.xlsx,.xls,.png,.jpg,.jpeg"
                        onChange={handleProfileUpload}
                      />
                      <button
                        style={{ 
                          padding: "8px 12px", borderRadius: 6, fontSize: 12,
                          backgroundColor: "rgba(255,255,255,0.05)", border: "1px dashed rgba(255,255,255,0.2)",
                          color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 
                        }}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                        </svg>
                        {isFileSelected ? (selectedFileName.length > 15 ? selectedFileName.slice(0,15)+"..." : selectedFileName) : "選擇檔案附加..."}
                      </button>

                      {isFileSelected && (
                        <button
                          className="btn-primary"
                          style={{ padding: "8px", fontSize: 12, backgroundColor: "var(--accent-muted)" }}
                          onClick={handleProfileUploadDirect}
                          disabled={uploadingProfile || parsingProfile}
                        >
                          {uploadingProfile ? "上傳中..." : "上傳原始檔 (CSV/JSON)"}
                        </button>
                      )}

                      <button
                        className="btn-primary"
                        style={{ padding: "8px", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                        onClick={handleProfileSmartParse}
                        disabled={parsingProfile || uploadingProfile || (!smartParseText.trim() && !isFileSelected)}
                      >
                        {parsingProfile ? (
                          <>
                            <LoadingSpinner />
                            解析中...
                          </>
                        ) : "🤖 智慧解析並套用"}
                      </button>
                    </div>
                  </div>
                )}

                {leaningProfile?.exists && leaningProfile.data && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ 
                      marginTop: 12, padding: "8px 12px", borderRadius: 8,
                      backgroundColor: "rgba(46, 204, 113, 0.1)",
                      border: "1px solid rgba(46, 204, 113, 0.3)",
                      display: "flex", alignItems: "center", justifyContent: "space-between"
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ color: "var(--green)"}}>
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                        <div>
                          <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 500 }}>設定檔已啟用</div>
                          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                            涵蓋 {Object.keys(leaningProfile.data?.districts || leaningProfile.data || {}).length} 個行政區。Persona 將繼承這些地區的政治光譜分佈。
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => setShowLeaningChart(!showLeaningChart)}
                        style={{
                          background: "none", border: "none", color: "var(--text-secondary)", fontSize: 12,
                          cursor: "pointer", display: "flex", alignItems: "center", gap: 4, textDecoration: "underline"
                        }}
                      >
                        {showLeaningChart ? "隱藏圖表" : "📊 檢視光譜分佈預覽"}
                      </button>
                    </div>

                    {showLeaningChart && leaningChartData.length > 0 && (
                      <div style={{ height: (Object.keys(leaningProfile.data).length * 40) + 60, minHeight: 250, maxHeight: 600, marginTop: 8, padding: 16, border: "1px solid var(--border-input)", borderRadius: 8, backgroundColor: "rgba(255,255,255,0.02)" }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={leaningChartData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" horizontal={false} />
                            <XAxis type="number" domain={[0, 100]} stroke="var(--text-muted)" tickFormatter={(val) => `${val}%`} />
                            <YAxis dataKey="name" type="category" width={80} stroke="var(--text-muted)" tick={{ fontSize: 12, fill: "var(--text-secondary)" }} />
                            <Tooltip 
                              formatter={(value: any) => `${Number(value).toFixed(1)}%`}
                              contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151" }}
                              itemStyle={{ fontSize: 13 }}
                              labelStyle={{ color: "var(--text-primary)", fontWeight: 600, marginBottom: 8 }}
                            />
                            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 10, color: "rgba(255,255,255,0.7)" }} />
                            <Bar dataKey="偏左派" stackId="a" fill="#22c55e" />
                            <Bar dataKey="中立" stackId="a" fill="#9ca3af" />
                            <Bar dataKey="偏右派" stackId="a" fill="#3b82f6" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                )}
              </div>

          {/* ── Results ── */}
          {persons.length > 0 && (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  padding: "2px 8px", borderRadius: 4,
                  backgroundColor: "var(--green-bg)", color: "var(--green)",
                  fontFamily: "var(--font-cjk)", fontSize: 11, fontWeight: 600,
                }}>
                  已合成 {persons.length} 人
                </span>
                <span style={{ fontFamily: "var(--font-cjk)", fontSize: 10, color: "var(--text-faint)" }}>
                  結果已自動儲存
                </span>
              </div>

              <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid var(--border-input)" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-cjk)", fontSize: 12 }}>
                  <thead>
                    <tr style={{ backgroundColor: "rgba(255,255,255,0.03)" }}>
                      <th style={{ padding: "8px 12px", textAlign: "left", color: "var(--text-muted)", fontWeight: 500, borderBottom: "1px solid var(--border-input)" }}>#</th>
                      {persons[0] && Object.keys(persons[0]).map((key) => (
                        <th
                          key={key}
                          style={{
                            padding: "8px 12px", textAlign: "left",
                            color: "var(--text-muted)", fontWeight: 500,
                            borderBottom: "1px solid var(--border-input)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {key}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {persons.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize).map((p, i) => (
                      <tr key={pageIndex * pageSize + i} style={{ borderBottom: "1px solid var(--border-input)" }}>
                        <td style={{ padding: "6px 12px", color: "var(--text-muted)" }}>{pageIndex * pageSize + i + 1}</td>
                        {Object.values(p).map((val, j) => (
                          <td key={j} style={{ padding: "6px 12px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                            {String(val)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {persons.length > pageSize && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                  <p style={{ fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-muted)" }}>
                    顯示第 {pageIndex * pageSize + 1} 至 {Math.min((pageIndex + 1) * pageSize, persons.length)} 筆，共 {persons.length} 筆
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      disabled={pageIndex === 0}
                      onClick={() => setPageIndex(p => p - 1)}
                      style={{
                        padding: "4px 12px", borderRadius: 4, border: "1px solid var(--border-input)",
                        backgroundColor: "transparent", color: pageIndex === 0 ? "var(--text-faint)" : "var(--text-secondary)",
                        cursor: pageIndex === 0 ? "not-allowed" : "pointer", fontSize: 12
                      }}
                    >
                      上一頁
                    </button>
                    <button
                      disabled={(pageIndex + 1) * pageSize >= persons.length}
                      onClick={() => setPageIndex(p => p + 1)}
                      style={{
                        padding: "4px 12px", borderRadius: 4, border: "1px solid var(--border-input)",
                        backgroundColor: "transparent", color: (pageIndex + 1) * pageSize >= persons.length ? "var(--text-faint)" : "var(--text-secondary)",
                        cursor: (pageIndex + 1) * pageSize >= persons.length ? "not-allowed" : "pointer", fontSize: 12
                      }}
                    >
                      下一頁
                    </button>
                  </div>
                </div>
              )}

              {/* Graphical Verification */}
              <div style={{ marginTop: 24, paddingTop: 24, borderTop: "1px solid var(--border-input)" }}>
                <h3 style={{ fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16 }}>
                  人口特徵分佈驗證
                </h3>
                <SynthesisResultCharts persons={persons} wsId={wsId} />
              </div>
            </div>
          )}

      </div>
    </div>
  );
}
