"use client";

export default function LoadingSpinner({
  size = 20,
  label,
}: {
  size?: number;
  label?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: "40px 0" }}>
      <div
        style={{
          width: size,
          height: size,
          border: "2px solid rgba(255,255,255,0.1)",
          borderTopColor: "var(--accent)",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }}
      />
      {label && (
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-cjk)" }}>
          {label}
        </span>
      )}
    </div>
  );
}
