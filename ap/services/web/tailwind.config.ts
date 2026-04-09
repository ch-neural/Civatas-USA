import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        "bg-primary": "var(--bg-primary)",
        "bg-sidebar": "var(--bg-sidebar)",
        "bg-card": "var(--bg-card)",
        "bg-input": "var(--bg-input)",
        "border-subtle": "var(--border-subtle)",
        "border-input": "var(--border-input)",
        accent: "var(--accent)",
        "accent-light": "var(--accent-light)",
        "accent-bg": "var(--accent-bg)",
        "accent-border": "var(--accent-border)",
        green: "var(--green)",
        "green-bg": "var(--green-bg)",
        pink: "var(--pink)",
        "pink-bg": "var(--pink-bg)",
        yellow: "var(--yellow)",
        "yellow-bg": "var(--yellow-bg)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-tertiary": "var(--text-tertiary)",
        "text-muted": "var(--text-muted)",
        "text-faint": "var(--text-faint)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        display: ["var(--font-display)"],
        cjk: ["var(--font-cjk)"],
      },
    },
  },
  plugins: [],
};

export default config;
