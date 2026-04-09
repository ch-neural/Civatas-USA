"""Download US state + county boundaries from us-atlas (TopoJSON) and convert to GeoJSON.

Source: https://github.com/topojson/us-atlas (Public Domain, CC0)
- counties-10m.json: ~600KB, all 3143 counties at 1:10M resolution
- states-10m.json: ~100KB, 50 states + DC + Puerto Rico

Output:
  data/geo/us-counties.geojson
  data/geo/us-states.geojson
  data/geo/raw/counties-10m.topo.json    (raw TopoJSON, kept for re-conversion)
  data/geo/raw/states-10m.topo.json
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEO = ROOT / "data" / "geo"
RAW = GEO / "raw"

SOURCES = {
    "counties-10m.topo.json": "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json",
    "states-10m.topo.json": "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json",
}


def download(url: str, dest: Path) -> None:
    print(f"  GET {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "civatas-usa-fetch/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())
    print(f"      -> {dest.relative_to(ROOT)} ({dest.stat().st_size:,} bytes)")


def topo_to_geo(topo: dict, object_name: str) -> dict:
    """Minimal TopoJSON → GeoJSON converter (us-atlas uses standard TopoJSON 1.0).

    Implements only what us-atlas needs: Polygon and MultiPolygon, with quantized arcs.
    """
    transform = topo.get("transform")
    arcs_raw = topo["arcs"]

    # Decode arcs (delta-decode if quantized)
    if transform:
        scale = transform["scale"]
        translate = transform["translate"]
        arcs = []
        for arc in arcs_raw:
            x = y = 0
            decoded = []
            for dx, dy in arc:
                x += dx
                y += dy
                decoded.append([x * scale[0] + translate[0], y * scale[1] + translate[1]])
            arcs.append(decoded)
    else:
        arcs = arcs_raw

    def arc_coords(idx: int) -> list:
        if idx < 0:
            return list(reversed(arcs[~idx]))
        return list(arcs[idx])

    def stitch(arc_indices: list) -> list:
        ring: list = []
        for i, idx in enumerate(arc_indices):
            seg = arc_coords(idx)
            if i == 0:
                ring.extend(seg)
            else:
                ring.extend(seg[1:])
        return ring

    def geom(g: dict) -> dict:
        t = g["type"]
        if t == "Polygon":
            return {"type": "Polygon", "coordinates": [stitch(r) for r in g["arcs"]]}
        if t == "MultiPolygon":
            return {
                "type": "MultiPolygon",
                "coordinates": [[stitch(r) for r in poly] for poly in g["arcs"]],
            }
        raise ValueError(f"unsupported geometry type: {t}")

    obj = topo["objects"][object_name]
    features = []
    for g in obj["geometries"]:
        features.append(
            {
                "type": "Feature",
                "id": g.get("id"),
                "properties": g.get("properties", {}),
                "geometry": geom(g),
            }
        )
    return {"type": "FeatureCollection", "features": features}


def main() -> int:
    GEO.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)

    print("[1/2] Downloading raw TopoJSON …")
    for name, url in SOURCES.items():
        download(url, RAW / name)

    print("[2/2] Converting to GeoJSON …")
    counties_topo = json.loads((RAW / "counties-10m.topo.json").read_text())
    states_topo = json.loads((RAW / "states-10m.topo.json").read_text())

    counties_geo = topo_to_geo(counties_topo, "counties")
    states_geo = topo_to_geo(states_topo, "states")

    (GEO / "us-counties.geojson").write_text(json.dumps(counties_geo))
    (GEO / "us-states.geojson").write_text(json.dumps(states_geo))

    n_counties = len(counties_geo["features"])
    n_states = len(states_geo["features"])
    print(f"  counties: {n_counties} features")
    print(f"  states:   {n_states} features")

    if n_counties < 3100 or n_counties > 3300:
        print(f"  WARNING: expected ~3143 counties, got {n_counties}", file=sys.stderr)
    if n_states < 50:
        print(f"  WARNING: expected >=50 states, got {n_states}", file=sys.stderr)

    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
