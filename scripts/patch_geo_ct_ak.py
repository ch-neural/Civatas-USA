"""Patch us-counties.geojson with current Connecticut planning regions and the
post-2019 Alaska borough split, both of which the us-atlas v3 dataset still
draws using obsolete codes.

Source:
  https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip
  Census 2024 cartographic boundary file, 1:500k resolution, ~11.6 MB.
  Public domain.

Patch summary:
  - Remove 8 old CT counties (FIPS 09001..09015)
  - Insert 9 CT planning regions (FIPS 09110..09190)
  - Remove old AK Valdez-Cordova Census Area (FIPS 02261)
  - Insert AK Chugach Census Area (02063) and Copper River Census Area (02066)

The patched file is written to data/geo/us-counties.geojson (overwriting).
A backup of the pre-patch file is kept at data/geo/us-counties.pre-patch.geojson.

Re-run idempotency: if the geojson already contains the new FIPS, the script
exits with no changes.
"""
from __future__ import annotations

import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import shapefile  # pyshp

ROOT = Path(__file__).resolve().parent.parent
GEO = ROOT / "data" / "geo"
RAW = GEO / "raw"

CB_URL = "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip"
CB_ZIP = RAW / "cb_2024_us_county_500k.zip"

# Codes to inject (new) and to remove (old)
CT_NEW = {"09110", "09120", "09130", "09140", "09150", "09160", "09170", "09180", "09190"}
CT_OLD = {f"09{c:03d}" for c in (1, 3, 5, 7, 9, 11, 13, 15)}
AK_NEW = {"02063", "02066"}
AK_OLD = {"02261"}

WANTED = CT_NEW | AK_NEW
REMOVE = CT_OLD | AK_OLD


def download_cb() -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    if CB_ZIP.exists() and CB_ZIP.stat().st_size > 5_000_000:
        print(f"  cached: {CB_ZIP.relative_to(ROOT)} ({CB_ZIP.stat().st_size:,} bytes)")
        return CB_ZIP
    print(f"  GET {CB_URL}")
    req = urllib.request.Request(CB_URL, headers={"User-Agent": "civatas-usa-fetch/0.1"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        CB_ZIP.write_bytes(resp.read())
    print(f"      -> {CB_ZIP.relative_to(ROOT)} ({CB_ZIP.stat().st_size:,} bytes)")
    return CB_ZIP


def shape_to_geometry(shape) -> dict:
    """Convert a pyshp Shape (Polygon / MultiPolygon variants) to GeoJSON geometry."""
    pts = shape.points
    parts = list(shape.parts) + [len(pts)]
    rings = []
    for i in range(len(parts) - 1):
        ring = [[float(x), float(y)] for x, y in pts[parts[i]:parts[i + 1]]]
        rings.append(ring)
    if not rings:
        return {"type": "Polygon", "coordinates": []}
    # If all rings belong to one polygon (exterior + holes), it's a Polygon.
    # If multiple exterior rings, it's a MultiPolygon. Heuristic: ring orientation.
    # For simplicity (and matching us-atlas conventions for these specific FIPS),
    # group consecutive rings into separate polygons.
    if len(rings) == 1:
        return {"type": "Polygon", "coordinates": rings}
    return {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}


def extract_features(zip_path: Path, wanted_geoids: set[str]) -> dict[str, dict]:
    """Read the .shp + .dbf from inside the zip and pull out the features whose
    GEOID matches one of ``wanted_geoids``."""
    with zipfile.ZipFile(zip_path) as zf:
        # Find the .shp / .dbf / .shx member names
        members = zf.namelist()
        shp_name = next((m for m in members if m.endswith(".shp")), None)
        dbf_name = next((m for m in members if m.endswith(".dbf")), None)
        shx_name = next((m for m in members if m.endswith(".shx")), None)
        if not (shp_name and dbf_name and shx_name):
            raise RuntimeError(f"missing shp/dbf/shx in {zip_path}")
        with zf.open(shp_name) as shp_f, zf.open(dbf_name) as dbf_f, zf.open(shx_name) as shx_f:
            shp_buf = io.BytesIO(shp_f.read())
            dbf_buf = io.BytesIO(dbf_f.read())
            shx_buf = io.BytesIO(shx_f.read())
            reader = shapefile.Reader(shp=shp_buf, dbf=dbf_buf, shx=shx_buf)
            field_names = [f[0] for f in reader.fields[1:]]  # skip deletion flag
            geoid_idx = field_names.index("GEOID")
            name_idx = field_names.index("NAME")
            namelsad_idx = field_names.index("NAMELSAD") if "NAMELSAD" in field_names else name_idx
            features: dict[str, dict] = {}
            for record, shape in zip(reader.records(), reader.shapes()):
                geoid = str(record[geoid_idx])
                if geoid not in wanted_geoids:
                    continue
                name = str(record[name_idx])
                full_name = str(record[namelsad_idx])
                features[geoid] = {
                    "type": "Feature",
                    "id": geoid,
                    "properties": {
                        "name": name,
                        "name_full": full_name,
                    },
                    "geometry": shape_to_geometry(shape),
                }
            return features


def patch_geojson(features_to_add: dict[str, dict]) -> dict:
    geo_path = GEO / "us-counties.geojson"
    backup = GEO / "us-counties.pre-patch.geojson"

    data = json.loads(geo_path.read_text())
    existing_ids = {f.get("id") for f in data["features"]}

    already_present = WANTED & existing_ids
    if already_present == WANTED and not (REMOVE & existing_ids):
        print(f"  geojson already patched ({len(already_present)} new FIPS present, all old removed). Skipping.")
        return data

    if not backup.exists():
        backup.write_text(geo_path.read_text())
        print(f"  backup -> {backup.relative_to(ROOT)}")

    # Remove obsolete features
    before = len(data["features"])
    data["features"] = [f for f in data["features"] if f.get("id") not in REMOVE]
    removed = before - len(data["features"])
    print(f"  removed {removed} obsolete features (CT old + AK 02261)")

    # Add new features (skip duplicates)
    existing_after_remove = {f.get("id") for f in data["features"]}
    added = 0
    for fips, feat in features_to_add.items():
        if fips in existing_after_remove:
            continue
        data["features"].append(feat)
        added += 1
    print(f"  added {added} new features (CT planning regions + AK 02063 / 02066)")

    geo_path.write_text(json.dumps(data))
    print(f"  -> {geo_path.relative_to(ROOT)}  total features: {len(data['features'])}")
    return data


def main() -> int:
    print("[1/3] Downloading Census 2024 cartographic boundary file …")
    cb = download_cb()

    print("[2/3] Extracting wanted features …")
    feats = extract_features(cb, WANTED)
    print(f"  found {len(feats)}/{len(WANTED)} wanted features")
    missing = WANTED - set(feats.keys())
    if missing:
        print(f"  WARNING: missing FIPS not found in cb_2024: {sorted(missing)}", file=sys.stderr)

    print("[3/3] Patching us-counties.geojson …")
    patch_geojson(feats)

    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
