"use client";

import { useEffect } from "react";
import { useThemeStore, useThemeEffect } from "@/store/theme-store";
import { Moon, Sun, Monitor } from "lucide-react";

const THEMES = [
  { key: "dark" as const, label: "深色", icon: <Moon size={16} /> },
  { key: "light" as const, label: "淺色", icon: <Sun size={16} /> },
  { key: "system" as const, label: "跟隨系統", icon: <Monitor size={16} /> },
];

const FONT_SIZES = [
  { key: "small" as const, label: "小", desc: "12px" },
  { key: "medium" as const, label: "中", desc: "14px" },
  { key: "large" as const, label: "大", desc: "16px" },
];

export default function AppearancePanel() {
  const { theme, fontSize, setTheme, setFontSize } = useThemeStore();

  // Apply theme effect
  useThemeEffect();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Theme */}
      <div>
        <div
          style={{
            fontFamily: "var(--font-cjk)",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
            marginBottom: 10,
          }}
        >
          主題
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {THEMES.map((t) => (
            <button
              key={t.key}
              onClick={() => setTheme(t.key)}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                padding: "12px 8px",
                borderRadius: "var(--radius-lg)",
                border: `1px solid ${theme === t.key ? "var(--accent-border)" : "var(--border-subtle)"}`,
                background: theme === t.key ? "var(--accent-bg)" : "transparent",
                color: theme === t.key ? "var(--accent-light)" : "var(--text-muted)",
                cursor: "pointer",
                transition: "all 0.15s",
                fontFamily: "var(--font-cjk)",
              }}
            >
              {t.icon}
              <span style={{ fontSize: 11, fontWeight: 500 }}>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Font size */}
      <div>
        <div
          style={{
            fontFamily: "var(--font-cjk)",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
            marginBottom: 10,
          }}
        >
          字型大小
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {FONT_SIZES.map((f) => (
            <button
              key={f.key}
              onClick={() => setFontSize(f.key)}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                padding: "10px 8px",
                borderRadius: "var(--radius-lg)",
                border: `1px solid ${fontSize === f.key ? "var(--accent-border)" : "var(--border-subtle)"}`,
                background: fontSize === f.key ? "var(--accent-bg)" : "transparent",
                color: fontSize === f.key ? "var(--accent-light)" : "var(--text-muted)",
                cursor: "pointer",
                transition: "all 0.15s",
                fontFamily: "var(--font-cjk)",
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600 }}>{f.label}</span>
              <span style={{ fontSize: 10, opacity: 0.6 }}>{f.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
