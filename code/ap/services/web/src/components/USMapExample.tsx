"use client";

import { useState, useEffect } from "react";
import USMap from "./USMap";

/**
 * USMapExample — minimal usage example for USMap.
 *
 * Demonstrates the three modes:
 *   1. State-level choropleth
 *   2. County-level choropleth (CONUS Albers)
 *   3. Drill into a single state's counties (state-fitted projection)
 *
 * Pulls PVI data from /api/us/pvi (which the application would expose
 * by querying us_pvi via the election DB) — for the example we use
 * a stub that returns the same shape from /us-pvi-sample.json.
 *
 * Drop this file into ap/services/web/src/components/ along with USMap.tsx
 * and add a route or panel that mounts <USMapExample />.
 */
export default function USMapExample() {
  const [pvi, setPvi] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<"states" | "counties">("counties");
  const [drilledState, setDrilledState] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Replace with the real API endpoint when wiring into Civatas-USA.
    fetch("/us-pvi-sample.json")
      .then((r) => r.json())
      .then(setPvi)
      .catch(() => setPvi({}));
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, color: "#fff" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => {
            setMode("states");
            setDrilledState(undefined);
          }}
          style={{
            padding: "6px 14px",
            background: mode === "states" && !drilledState ? "#3b82f6" : "#1f2937",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          States
        </button>
        <button
          onClick={() => {
            setMode("counties");
            setDrilledState(undefined);
          }}
          style={{
            padding: "6px 14px",
            background: mode === "counties" && !drilledState ? "#3b82f6" : "#1f2937",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Counties (Cook PVI)
        </button>
        {drilledState && (
          <button
            onClick={() => setDrilledState(undefined)}
            style={{
              padding: "6px 14px",
              background: "#fbbf24",
              color: "#000",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            ← Back to USA
          </button>
        )}
      </div>

      <USMap
        data={pvi}
        mode={mode}
        selectedState={drilledState}
        diverging
        valueLabel=""
        title={drilledState ? `State ${drilledState} counties` : "Cook PVI by county (2020+2024)"}
        width={720}
        height={440}
        onFeatureClick={(fips, name) => {
          // Click a state in mode="states" → drill into its counties.
          if (mode === "states" && fips.length === 2) {
            setDrilledState(fips);
            setMode("counties");
          } else {
            console.log("clicked", fips, name);
          }
        }}
      />
    </div>
  );
}
