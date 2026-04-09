import { useMemo } from "react";
import { useTrWithLocale, useLocalizePersonaValueWithLocale, type StringKey, type Locale } from "@/lib/i18n";
import { useActiveTemplate } from "@/hooks/use-active-template";

interface SynthPerson {
  [key: string]: string | number;
}

interface Props {
  persons: SynthPerson[];
  wsId?: string;
}

// Map backend keys → i18n string keys (resolved per render via `t()`)
const TRAIT_LABEL_KEYS: Record<string, StringKey> = {
  "age":               "synthesis.chart.age",
  "gender":            "synthesis.chart.gender",
  "education":         "synthesis.chart.education",
  "marital_status":    "synthesis.chart.marital",
  "district":          "synthesis.chart.district",
  "occupation":        "synthesis.chart.occupation",
  "political_leaning": "synthesis.chart.leaning",
};

// Personality sub-dimensions (nested under person.personality)
const PERSONALITY_LABEL_KEYS: Record<string, StringKey> = {
  "expressiveness":      "synthesis.chart.express",
  "emotional_stability": "synthesis.chart.stable",
  "sociability":         "synthesis.chart.social",
  "openness":            "synthesis.chart.openness",
};

function binAge(age: number): string {
  if (age <= 6) return "0–6";
  if (age <= 13) return "7–13";
  if (age <= 17) return "14–17";
  if (age <= 19) return "18–19";
  if (age <= 29) return "20–29";
  if (age <= 39) return "30–39";
  if (age <= 49) return "40–49";
  if (age <= 59) return "50–59";
  if (age <= 69) return "60–69";
  return "70+";
}

export default function SynthesisResultCharts({ persons, wsId }: Props) {
  // Stage 1.8 fix: simulation result charts (chart headers + persona-data
  // values) should follow the active TEMPLATE's locale, not the user's UI
  // locale toggle. A US presidential synthesis should always show
  // "Highly expressive / Calm & stable" — even if the user has the UI in zh-TW.
  const { template: activeTemplate } = useActiveTemplate(wsId || "");
  const overrideLocale: Locale | null =
    activeTemplate?.locale === "en-US" || activeTemplate?.country === "US"
      ? "en"
      : null;
  const t = useTrWithLocale(overrideLocale);
  const localizeValue = useLocalizePersonaValueWithLocale(overrideLocale);

  const chartData = useMemo(() => {
    if (!persons || persons.length === 0) return [];

    const stats: Record<string, Record<string, number>> = {};

    persons.forEach(person => {
      // Standard flat fields
      Object.entries(TRAIT_LABEL_KEYS).forEach(([engineKey, labelKey]) => {
        let val = person[engineKey] !== undefined ? String(person[engineKey]) : undefined;

        if (engineKey === "age" && val) {
          const age = parseInt(val, 10);
          if (!isNaN(age)) val = binAge(age);
        }

        if (val) {
          const trait = t(labelKey);
          const displayVal = engineKey === "age" ? val : localizeValue(val);
          if (!stats[trait]) stats[trait] = {};
          stats[trait][displayVal] = (stats[trait][displayVal] || 0) + 1;
        }
      });

      // Personality sub-dimensions (nested object)
      const pers = person.personality as Record<string, string> | undefined;
      if (pers && typeof pers === "object") {
        Object.entries(PERSONALITY_LABEL_KEYS).forEach(([dimKey, labelKey]) => {
          const raw = pers[dimKey];
          if (raw) {
            const trait = t(labelKey);
            const displayVal = localizeValue(raw);
            if (!stats[trait]) stats[trait] = {};
            stats[trait][displayVal] = (stats[trait][displayVal] || 0) + 1;
          }
        });
      }
    });

    return Object.entries(stats).map(([trait, counts]) => {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const items = Object.entries(counts)
        .map(([label, count]) => ({
          label,
          count,
          percentage: (count / total) * 100,
        }))
        .sort((a, b) => b.count - a.count);

      return { trait, total, items };
    });
  }, [persons, t, localizeValue]);

  if (chartData.length === 0) {
    const traits = Object.values(TRAIT_LABEL_KEYS).map(k => t(k)).join(", ");
    return (
       <div style={{ color: "var(--text-faint)", fontFamily: "var(--font-cjk)", fontSize: 13, padding: 16 }}>
         {t("synthesis.chart.empty", { traits })}
       </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {chartData.map(({ trait, items }) => (
        <div key={trait} style={{
          display: "flex", flexDirection: "column", gap: 8,
          backgroundColor: "rgba(255,255,255,0.02)",
          border: "1px solid rgba(255,255,255,0.05)",
          padding: 16, borderRadius: 8
        }}>
          <h4 style={{
            fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600,
            color: "var(--text-secondary)", margin: 0,
            display: "flex", justifyContent: "space-between"
          }}>
            <span>{trait}</span>
          </h4>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            {items.map((item) => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{
                  fontFamily: "var(--font-cjk)", fontSize: 11, color: "var(--text-muted)",
                  width: 80, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  textAlign: "right"
                }}>
                  {item.label}
                </span>

                <div style={{ flex: 1, height: 8, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 4, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%", width: `${item.percentage}%`,
                      backgroundColor: "var(--accent-light)",
                      borderRadius: 4, transition: "width 0.5s ease"
                    }}
                  />
                </div>

                <span style={{
                  fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--text-secondary)",
                  width: 50, textAlign: "left"
                }}>
                  {item.percentage.toFixed(1)}% <span style={{ color: "var(--text-faint)", fontSize: 10 }}>({item.count})</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
