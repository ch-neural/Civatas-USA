"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class PanelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          flex: 1, gap: 12, padding: 32, color: "var(--text-muted)", fontFamily: "var(--font-cjk)",
        }}>
          <div style={{ fontSize: 24 }}>⚠️</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>面板發生錯誤</div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", maxWidth: 300, textAlign: "center" }}>
            {this.state.error?.message || "未知錯誤"}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: 8, padding: "6px 16px", borderRadius: 6,
              background: "var(--accent-bg)", border: "1px solid var(--accent-border)",
              color: "var(--accent-light)", fontSize: 12, cursor: "pointer",
            }}
          >
            重試
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
