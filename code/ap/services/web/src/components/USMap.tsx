"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";

/**
 * USMap — SVG choropleth map of US states / counties.
 *
 * Drop-in counterpart to ap/services/web/src/components/TaiwanMap.tsx for
 * US workspaces. Same prop shape, but values are keyed by FIPS code instead
 * of human names (because county names like "Adams County" exist in many
 * states):
 *
 *   data: Record<FIPS, number>
 *
 * - mode === "states":   FIPS = 2-digit state FIPS (e.g. "42" for PA)
 * - mode === "counties": FIPS = 5-digit county FIPS (e.g. "42003" for Allegheny)
 *
 * Drill-down: pass `selectedState` (2-digit FIPS) and the component will only
 * render that state's counties from us-counties.geojson, scaled to fill the
 * canvas.
 *
 * Projection: Albers USA composite (continental US in Albers equal-area conic,
 * with Alaska and Hawaii inset projections). Implemented inline so no
 * d3-geo dependency is required.
 *
 * Loaded GeoJSON files (must be in /public/):
 *   /us-states.geojson
 *   /us-counties.geojson
 */

type FIPS = string;

interface USMapProps {
  data?: Record<FIPS, number>;
  mode?: "states" | "counties";
  selectedState?: FIPS;                          // 2-digit FIPS — drill into this state's counties
  selectedFeature?: FIPS;                        // highlight a single feature (state or county)
  colorScale?: [string, string];
  divergingColorScale?: [string, string, string]; // for PVI-style data
  onFeatureClick?: (fips: FIPS, name: string) => void;
  onFeatureHover?: (fips: FIPS | null) => void;
  width?: number;
  height?: number;
  title?: string;
  valueLabel?: string;
  showLegend?: boolean;
  /**
   * If true, the value scale is centered at zero (use with divergingColorScale).
   * Suitable for PVI-style data where negative = R-leaning, positive = D-leaning.
   */
  diverging?: boolean;
}

// Allowed state FIPS — 50 states + DC. Filters out PR, GU, AS, MP, VI from the
// us-atlas geojson which Civatas-USA does not cover.
const ALLOWED_STATE_FIPS = new Set<string>([
  "01","02","04","05","06","08","09","10","11","12","13","15","16","17","18",
  "19","20","21","22","23","24","25","26","27","28","29","30","31","32","33",
  "34","35","36","37","38","39","40","41","42","44","45","46","47","48","49",
  "50","51","53","54","55","56",
]);

// ── Albers USA composite projection ──────────────────────────────────────
//
// Continental US (lower 48 + DC):  Albers equal-area conic, phi1=29.5°,
//                                  phi2=45.5°, lat0=37.5°, lon0=-96°.
// Alaska (state 02):               Albers conic centered on AK, then scaled
//                                  to 0.35× and translated to lower-left.
// Hawaii (state 15):               simplified Albers, scaled and translated
//                                  to the right of the Alaska inset.

const D2R = Math.PI / 180;

interface ProjectionParams {
  phi1: number;
  phi2: number;
  lat0: number;
  lon0: number;
  // Linear post-projection transform applied to (x, y) in the
  // unit-sphere coordinate system before mapping to pixel space.
  scale: number;
  shiftX: number;
  shiftY: number;
}

const CONUS: ProjectionParams = {
  phi1: 29.5 * D2R,
  phi2: 45.5 * D2R,
  lat0: 37.5 * D2R,
  lon0: -96 * D2R,
  scale: 1.0,
  shiftX: 0,
  shiftY: 0,
};

const ALASKA: ProjectionParams = {
  phi1: 55 * D2R,
  phi2: 65 * D2R,
  lat0: 50 * D2R,
  lon0: -154 * D2R,
  scale: 0.35,
  shiftX: -0.45,
  shiftY: 0.32,
};

const HAWAII: ProjectionParams = {
  phi1: 8 * D2R,
  phi2: 18 * D2R,
  lat0: 20 * D2R,
  lon0: -157 * D2R,
  scale: 1.0,
  shiftX: -0.18,
  shiftY: 0.32,
};

function albersForState(stateFips: string): ProjectionParams {
  if (stateFips === "02") return ALASKA;
  if (stateFips === "15") return HAWAII;
  return CONUS;
}

/**
 * Albers conic equal-area projection. Returns unit-sphere (x, y) — caller is
 * responsible for the linear scale + translate to pixel space.
 */
function albersConic(lonDeg: number, latDeg: number, p: ProjectionParams): [number, number] {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const n = (Math.sin(p.phi1) + Math.sin(p.phi2)) / 2;
  const C = Math.cos(p.phi1) * Math.cos(p.phi1) + 2 * n * Math.sin(p.phi1);
  const rho0 = Math.sqrt(C - 2 * n * Math.sin(p.lat0)) / n;
  const rho = Math.sqrt(C - 2 * n * Math.sin(lat)) / n;
  const theta = n * (lon - p.lon0);
  let x = rho * Math.sin(theta);
  let y = rho0 - rho * Math.cos(theta);
  // Apply per-region post-projection transform (for AK / HI insets)
  x = x * p.scale + p.shiftX;
  y = y * p.scale + p.shiftY;
  return [x, y];
}

// Continental-US bounding box in unit-sphere coordinates (computed once for
// CONUS so we know how to scale into the canvas). Roughly:
//   x ∈ [-0.45, +0.45], y ∈ [-0.30, +0.30]   (with AK/HI insets in lower-left)
const UNIT_BOUNDS = {
  minX: -0.55,
  maxX: 0.55,
  minY: -0.32,
  maxY: 0.42,
};

function unitToPixel(x: number, y: number, w: number, h: number): [number, number] {
  const padX = w * 0.04;
  const padY = h * 0.04;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;
  const tx = (x - UNIT_BOUNDS.minX) / (UNIT_BOUNDS.maxX - UNIT_BOUNDS.minX);
  // Flip Y: in Albers unit space y > 0 = north, but in screen pixels y grows
  // downward, so we map (maxY - y) to keep north at the top.
  const ty = (UNIT_BOUNDS.maxY - y) / (UNIT_BOUNDS.maxY - UNIT_BOUNDS.minY);
  return [padX + tx * plotW, padY + ty * plotH];
}

// State-zoom mode: instead of CONUS bounds, fit a single state's geometry to
// the canvas using a plain equirectangular projection (good enough for one
// state at high zoom).
function fitProjectionForState(features: any[], w: number, h: number) {
  let minLon = +Infinity, maxLon = -Infinity, minLat = +Infinity, maxLat = -Infinity;
  const walk = (coords: any) => {
    if (typeof coords[0] === "number") {
      const [lon, lat] = coords;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    } else {
      for (const c of coords) walk(c);
    }
  };
  for (const f of features) walk(f.geometry.coordinates);
  const padX = w * 0.05;
  const padY = h * 0.05;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;
  const lonRange = maxLon - minLon || 1;
  const latRange = maxLat - minLat || 1;
  // Use Albers for the state too, but scaled to fit the bbox
  const midLat = (minLat + maxLat) / 2;
  const aspectCorrect = Math.cos(midLat * D2R);
  const scale = Math.min(plotW / (lonRange * aspectCorrect), plotH / latRange);
  return (lon: number, lat: number): [number, number] => {
    const x = padX + ((lon - minLon) * aspectCorrect) * scale;
    const y = padY + (maxLat - lat) * scale;
    return [x, y];
  };
}

// ── Geometry → SVG path string ───────────────────────────────────────────

function ringToPath(
  ring: number[][],
  project: (lon: number, lat: number) => [number, number],
): string {
  if (!ring || ring.length === 0) return "";
  return ring
    .map((pt, i) => {
      const [x, y] = project(pt[0], pt[1]);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join("") + "Z";
}

function featureToPath(
  feature: any,
  project: (lon: number, lat: number) => [number, number],
): string {
  const geom = feature.geometry;
  if (geom.type === "Polygon") {
    return geom.coordinates.map((ring: number[][]) => ringToPath(ring, project)).join(" ");
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates
      .map((polygon: number[][][]) =>
        polygon.map((ring: number[][]) => ringToPath(ring, project)).join(" "),
      )
      .join(" ");
  }
  return "";
}

// ── Color interpolation ──────────────────────────────────────────────────

function parseHex(c: string): [number, number, number] {
  const hex = c.replace("#", "");
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function interpolateColor(c1: string, c2: string, t: number): string {
  const [r1, g1, b1] = parseHex(c1);
  const [r2, g2, b2] = parseHex(c2);
  return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
}

function divergingColor(
  c1: string,
  cMid: string,
  c2: string,
  t: number, // 0..1 with 0.5 = midpoint
): string {
  if (t < 0.5) {
    return interpolateColor(c1, cMid, t * 2);
  }
  return interpolateColor(cMid, c2, (t - 0.5) * 2);
}

// ── Component ────────────────────────────────────────────────────────────

export default function USMap({
  data = {},
  mode = "states",
  selectedState,
  selectedFeature,
  colorScale = ["#1e293b", "#3b82f6"],
  divergingColorScale = ["#dc2626", "#1f2937", "#2563eb"], // R-red ← gray → D-blue
  onFeatureClick,
  onFeatureHover,
  width = 640,
  height = 400,
  title,
  valueLabel = "",
  showLegend = true,
  diverging = false,
}: USMapProps) {
  const [statesGeo, setStatesGeo] = useState<any>(null);
  const [countiesGeo, setCountiesGeo] = useState<any>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; value: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Lazy-load both geo files. Counties only loads when requested (saves 3 MB).
  useEffect(() => {
    fetch("/us-states.geojson").then(r => r.json()).then(setStatesGeo).catch(() => {});
  }, []);
  useEffect(() => {
    if (mode === "counties" || selectedState) {
      fetch("/us-counties.geojson").then(r => r.json()).then(setCountiesGeo).catch(() => {});
    }
  }, [mode, selectedState]);

  // Pick the feature collection we're rendering this turn.
  const features = useMemo(() => {
    if (selectedState && countiesGeo) {
      // Drill mode: only counties of the selected state.
      return countiesGeo.features.filter(
        (f: any) => f.id && f.id.length === 5 && f.id.startsWith(selectedState),
      );
    }
    if (mode === "counties" && countiesGeo) {
      return countiesGeo.features.filter((f: any) => {
        const id = f.id || "";
        return id.length === 5 && ALLOWED_STATE_FIPS.has(id.slice(0, 2));
      });
    }
    if (statesGeo) {
      return statesGeo.features.filter(
        (f: any) => f.id && ALLOWED_STATE_FIPS.has(f.id),
      );
    }
    return [];
  }, [statesGeo, countiesGeo, mode, selectedState]);

  // Pick projection: state-fit if drilled in, else Albers USA composite.
  const project = useMemo(() => {
    if (selectedState && features.length > 0) {
      return fitProjectionForState(features, width, height);
    }
    // Albers USA composite — choose params per feature's first vertex.
    return (lon: number, lat: number, fips?: string): [number, number] => {
      const stateFips = (fips || "").slice(0, 2);
      const params = stateFips ? albersForState(stateFips) : CONUS;
      const [ux, uy] = albersConic(lon, lat, params);
      return unitToPixel(ux, uy, width, height);
    };
  }, [features, selectedState, width, height]);

  // Compute value range
  const { minVal, maxVal, absMax } = useMemo(() => {
    const vals = Object.values(data).filter((v): v is number => typeof v === "number" && !isNaN(v));
    if (vals.length === 0) return { minVal: 0, maxVal: 100, absMax: 1 };
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    return { minVal: minV, maxVal: maxV, absMax: Math.max(Math.abs(minV), Math.abs(maxV)) };
  }, [data]);

  const getColor = useCallback(
    (fips: string) => {
      const v = data[fips];
      if (v === undefined || v === null) return "rgba(255,255,255,0.05)";
      if (diverging) {
        const t = absMax > 0 ? (v / absMax + 1) / 2 : 0.5;
        return divergingColor(divergingColorScale[0], divergingColorScale[1], divergingColorScale[2], Math.max(0, Math.min(1, t)));
      }
      const range = maxVal - minVal || 1;
      const t = Math.max(0, Math.min(1, (v - minVal) / range));
      return interpolateColor(colorScale[0], colorScale[1], t);
    },
    [data, minVal, maxVal, absMax, colorScale, divergingColorScale, diverging],
  );

  const handleMouseMove = useCallback((e: React.MouseEvent, name: string, val: number) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top - 10, name, value: val });
  }, []);

  if (features.length === 0) {
    return (
      <div
        style={{
          width,
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(255,255,255,0.2)",
          fontSize: 11,
        }}
      >
        Loading map...
      </div>
    );
  }

  // Build paths once per render.
  // For drilled-state mode, project signature is (lon, lat) — wrap to ignore fips.
  const projectFn: (lon: number, lat: number, fips?: string) => [number, number] =
    typeof project === "function" && project.length === 2
      ? (lon, lat) => (project as any)(lon, lat)
      : (project as any);

  return (
    <div style={{ position: "relative", width, height }}>
      {title && (
        <div
          style={{
            position: "absolute",
            top: 4,
            left: 8,
            fontSize: 12,
            fontWeight: 700,
            color: "rgba(255,255,255,0.6)",
            zIndex: 2,
          }}
        >
          {title}
        </div>
      )}

      <svg ref={svgRef} width={width} height={height} style={{ overflow: "visible" }}>
        {features.map((feature: any) => {
          const fips = feature.id as string;
          const name = feature.properties?.name || fips;
          const val = data[fips];
          const isHovered = hovered === fips;
          const isSelected = selectedFeature === fips;
          // Path projection — pass fips so the Albers composite knows which inset.
          const pathFn = (lon: number, lat: number) => projectFn(lon, lat, fips);
          const path = featureToPath(feature, pathFn);

          return (
            <path
              key={fips}
              d={path}
              fill={getColor(fips)}
              stroke={isSelected ? "#fbbf24" : isHovered ? "#fff" : "rgba(255,255,255,0.18)"}
              strokeWidth={isSelected ? 2 : isHovered ? 1.2 : 0.4}
              style={{
                cursor: onFeatureClick ? "pointer" : "default",
                transition: "fill 0.3s, stroke 0.2s",
              }}
              onMouseEnter={() => {
                setHovered(fips);
                onFeatureHover?.(fips);
              }}
              onMouseMove={(e) => handleMouseMove(e, name, val ?? 0)}
              onMouseLeave={() => {
                setHovered(null);
                setTooltip(null);
                onFeatureHover?.(null);
              }}
              onClick={() => onFeatureClick?.(fips, name)}
            />
          );
        })}
      </svg>

      {tooltip && (
        <div
          style={{
            position: "absolute",
            left: tooltip.x + 12,
            top: tooltip.y - 8,
            padding: "4px 10px",
            borderRadius: 6,
            background: "rgba(0,0,0,0.85)",
            border: "1px solid rgba(255,255,255,0.15)",
            color: "#fff",
            fontSize: 12,
            pointerEvents: "none",
            zIndex: 10,
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ fontWeight: 700 }}>{tooltip.name}</span>
          {tooltip.value !== undefined && tooltip.value !== null && (
            <span style={{ marginLeft: 8, color: diverging ? divergingColorScale[2] : colorScale[1] }}>
              {typeof tooltip.value === "number" ? tooltip.value.toLocaleString() : tooltip.value}
              {valueLabel}
            </span>
          )}
        </div>
      )}

      {showLegend && Object.keys(data).length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 9,
            color: "rgba(255,255,255,0.5)",
          }}
        >
          <span>{(diverging ? -absMax : minVal).toLocaleString()}{valueLabel}</span>
          <div
            style={{
              width: 80,
              height: 8,
              borderRadius: 2,
              background: diverging
                ? `linear-gradient(to right, ${divergingColorScale[0]}, ${divergingColorScale[1]}, ${divergingColorScale[2]})`
                : `linear-gradient(to right, ${colorScale[0]}, ${colorScale[1]})`,
            }}
          />
          <span>{(diverging ? absMax : maxVal).toLocaleString()}{valueLabel}</span>
        </div>
      )}
    </div>
  );
}
