"use client";

import { useState } from "react";
import styles from "./DimensionChart.module.css";

// Color palette for bars — cycles through a soft gradient palette
const BAR_COLORS = [
  "rgba(108,92,231,0.7)",   // purple
  "rgba(0,184,148,0.7)",    // green
  "rgba(253,121,168,0.7)",  // pink
  "rgba(253,203,110,0.7)",  // yellow
  "rgba(116,185,255,0.7)",  // blue
  "rgba(162,155,254,0.6)",  // lavender
  "rgba(85,239,196,0.6)",   // mint
  "rgba(255,159,67,0.7)",   // orange
];

const DIM_ICONS: Record<string, { bg: string; label: string }> = {
  gender:     { bg: "linear-gradient(135deg,#FD79A8,#E84393)", label: "G" },
  district:   { bg: "linear-gradient(135deg,#6C5CE7,#A29BFE)", label: "D" },
  education:  { bg: "linear-gradient(135deg,#00B894,#55EFC4)", label: "E" },
  occupation: { bg: "linear-gradient(135deg,#FDCB6E,#F39C12)", label: "O" },
  age:        { bg: "linear-gradient(135deg,#74B9FF,#0984E3)", label: "A" },
  area:       { bg: "linear-gradient(135deg,#6C5CE7,#A29BFE)", label: "R" },
  indigenous: { bg: "linear-gradient(135deg,#00B894,#55EFC4)", label: "I" },
  party_lean: { bg: "linear-gradient(135deg,#FD79A8,#E84393)", label: "P" },
  city_code:  { bg: "linear-gradient(135deg,#FDCB6E,#F39C12)", label: "C" },
  media_habit:{ bg: "linear-gradient(135deg,#74B9FF,#0984E3)", label: "M" },
  candidate:  { bg: "linear-gradient(135deg,#E17055,#D63031)", label: "V" },
  turnout:    { bg: "linear-gradient(135deg,#636E72,#2D3436)", label: "T" },
  ethnicity:  { bg: "linear-gradient(135deg,#00CEC9,#00B894)", label: "E" },
};

const DIM_LABELS: Record<string, string> = {
  gender: "性別",
  district: "行政區",
  education: "教育程度",
  occupation: "職業",
  age: "年齡",
  area: "都市計畫區",
  indigenous: "原住民",
  party_lean: "政黨傾向",
  city_code: "縣市代碼",
  media_habit: "媒體習慣",
  candidate: "候選人得票",
  turnout: "投票率",
  ethnicity: "族群",
};

interface CategoryItem {
  value: string;
  weight: number;
}

interface RangeBin {
  range: string;
  weight: number;
}

interface Dimension {
  type: string;
  categories?: CategoryItem[] | null;
  bins?: RangeBin[] | null;
}

interface DistrictProfile {
  name: string;
  population: number;
  dimensions: Record<string, Dimension>;
}

interface DimensionChartProps {
  dimensions: Record<string, Dimension>;
  districtProfiles?: Record<string, DistrictProfile>;
  projectName?: string;
  showAgentMapping?: boolean;
  maxBarsPerDim?: number;
}

export default function DimensionChart({
  dimensions,
  districtProfiles,
  projectName,
  showAgentMapping = true,
  maxBarsPerDim = 10,
}: DimensionChartProps) {
  const [selectedDistrict, setSelectedDistrict] = useState<string>("__all__");

  const districtKeys = districtProfiles ? Object.keys(districtProfiles) : [];
  const hasProfiles = districtKeys.length > 0;

  // When viewing "all city" and the only top-level dimension is 'district',
  // aggregate sub-dimensions from district profiles to show city-wide summary.
  const aggregatedDims = (() => {
    if (selectedDistrict !== "__all__" || !hasProfiles) return null;
    const topKeys = Object.keys(dimensions);
    // Only aggregate if district is the sole top-level dimension
    if (topKeys.length !== 1 || topKeys[0] !== "district") return null;

    // Collect all sub-dimension keys from profiles
    const subDimTotals: Record<string, Record<string, number>> = {};
    for (const profile of Object.values(districtProfiles!)) {
      for (const [dimKey, dim] of Object.entries(profile.dimensions)) {
        if (!subDimTotals[dimKey]) subDimTotals[dimKey] = {};
        const items = dim.categories || [];
        for (const item of items) {
          subDimTotals[dimKey][item.value] =
            (subDimTotals[dimKey][item.value] || 0) +
            item.weight * (profile.population || 1);
        }
      }
    }

    // Build aggregated dimensions from totals
    const result: Record<string, Dimension> = {};
    for (const [dimKey, totals] of Object.entries(subDimTotals)) {
      const total = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
      const cats: CategoryItem[] = Object.entries(totals)
        .map(([value, count]) => ({ value, weight: count / total }))
        .sort((a, b) => b.weight - a.weight);
      result[dimKey] = { type: "categorical", categories: cats };
    }
    return Object.keys(result).length > 0 ? result : null;
  })();

  // Determine which dimensions to display
  const activeDims = selectedDistrict !== "__all__" && districtProfiles?.[selectedDistrict]
    ? districtProfiles[selectedDistrict].dimensions
    : { ...dimensions, ...(aggregatedDims || {}) };

  const dimEntries = Object.entries(activeDims);

  return (
    <div className={styles.chartContainer}>
      {/* Project summary */}
      {projectName && (
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>統計模板：</span>
          <span className={styles.summaryValue}>{projectName}</span>
          <span className={styles.summaryLabel} style={{ marginLeft: "auto" }}>
            {dimEntries.length} 個維度
          </span>
        </div>
      )}

      {/* District selector */}
      {hasProfiles && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "8px 12px", borderRadius: 8,
          backgroundColor: "rgba(108,92,231,0.06)",
          border: "1px solid rgba(108,92,231,0.15)",
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1L1 5.5V13h4.5V9.5h3V13H13V5.5L7 1z" stroke="var(--accent-light)" strokeWidth="1.2" fill="none" />
          </svg>
          <span style={{ fontFamily: "var(--font-cjk)", fontSize: 12, color: "var(--text-secondary)" }}>
            區域：
          </span>
          <select
            value={selectedDistrict}
            onChange={(e) => setSelectedDistrict(e.target.value)}
            style={{
              flex: 1,
              padding: "4px 8px", borderRadius: 6,
              backgroundColor: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(108,92,231,0.2)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-cjk)", fontSize: 12,
              cursor: "pointer",
              outline: "none",
            }}
          >
            <option value="__all__">全市（總體分佈）</option>
            {districtKeys.map((d) => (
              <option key={d} value={d}>
                {d}
                {districtProfiles![d].population > 0
                  ? `（${districtProfiles![d].population.toLocaleString()} 人）`
                  : ""}
              </option>
            ))}
          </select>
          {selectedDistrict !== "__all__" && (
            <span style={{
              fontFamily: "var(--font-cjk)", fontSize: 10,
              color: "var(--accent-light)", padding: "2px 6px",
              borderRadius: 4, backgroundColor: "rgba(108,92,231,0.12)",
            }}>
              該區比例
            </span>
          )}
        </div>
      )}

      {/* Dimension bar charts */}
      {dimEntries.map(([key, dim]) => {
        const icon = DIM_ICONS[key] || { bg: "rgba(255,255,255,0.1)", label: key[0]?.toUpperCase() || "?" };
        const label = DIM_LABELS[key] || key;

        const items: { name: string; weight: number }[] = [];
        if (dim.categories) {
          dim.categories.forEach((c) => items.push({ name: c.value, weight: c.weight }));
        } else if (dim.bins) {
          dim.bins.forEach((b) => items.push({ name: b.range, weight: b.weight }));
        }

        items.sort((a, b) => b.weight - a.weight);

        const displayItems = items.slice(0, maxBarsPerDim);
        const hasMore = items.length > maxBarsPerDim;
        const maxWeight = displayItems[0]?.weight || 1;

        return (
          <div key={key}>
            <div className={styles.dimHeader}>
              <div className={styles.dimTitle}>
                <div className={styles.dimIcon} style={{ background: icon.bg }}>
                  {icon.label}
                </div>
                <span className={styles.dimName}>{label}</span>
              </div>
              <span className={styles.dimCount}>{items.length} 項</span>
            </div>

            {displayItems.map((item, i) => (
              <div key={item.name} className={styles.barRow}>
                <span className={styles.barLabel} title={item.name}>
                  {item.name}
                </span>
                <div className={styles.barTrack}>
                  <div
                    className={styles.barFill}
                    style={{
                      width: `${(item.weight / maxWeight) * 100}%`,
                      backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                    }}
                  />
                </div>
                <span className={styles.barPercent}>
                  {(item.weight * 100).toFixed(1)}%
                </span>
              </div>
            ))}

            {hasMore && (
              <div className={styles.barRow}>
                <span className={styles.barLabel} style={{ color: "var(--text-muted)" }}>
                  ... 其他 {items.length - maxBarsPerDim} 項
                </span>
                <div className={styles.barTrack} />
                <span className={styles.barPercent} />
              </div>
            )}
          </div>
        );
      })}

      {/* Agent mapping explanation */}
      {showAgentMapping && dimEntries.length > 0 && (
        <div className={styles.agentMappingSection}>
          <span className={styles.agentMappingTitle}>
            如何用於 Agent 人設
          </span>
          <span className={styles.agentMappingDesc}>
            {selectedDistrict !== "__all__"
              ? `系統將根據「${selectedDistrict}」的人口分佈抽樣產生 Agent 屬性。`
              : "系統根據上述權重分佈，以蒙地卡羅抽樣為每位 Agent 分配屬性。例如："}
          </span>
          {dimEntries.slice(0, 4).map(([key, dim]) => {
            const label = DIM_LABELS[key] || key;
            const items = dim.categories || [];
            const topItem = items[0];
            if (!topItem) return null;
            return (
              <div key={key} className={styles.agentAttrRow}>
                <div
                  className={styles.agentAttrIcon}
                  style={{ backgroundColor: BAR_COLORS[dimEntries.findIndex(([k]) => k === key) % BAR_COLORS.length] }}
                />
                <span className={styles.agentAttrText}>{label} →</span>
                <span className={styles.agentAttrValue}>
                  {topItem.value}（{(topItem.weight * 100).toFixed(1)}%）
                </span>
                <span className={styles.agentAttrText}>
                  最高比例，Agent 最可能被分配此值
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
