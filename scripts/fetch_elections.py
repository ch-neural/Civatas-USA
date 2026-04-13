"""Fetch MIT Election Data and Science Lab (MEDSL) county-level presidential returns.

Source: https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/VOQCHQ
File:   countypres_2000-2024.tab  (single file covering all cycles 2000-2024)
License: CC0 1.0 Universal (Public Domain)

We download the full file (covers all years), then extract the 2020 and 2024 cycles
into clean CSVs:
  data/elections/raw/countypres_2000-2024.tab     (~9.8 MB, kept for re-runs)
  data/elections/president_2020_county.csv
  data/elections/president_2024_county.csv

MEDSL columns:
  year, state, state_po, county_name, county_fips,
  office, candidate, party, candidatevotes, totalvotes, version, mode
"""
from __future__ import annotations

import csv
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ELEC = ROOT / "data" / "elections"
RAW = ELEC / "raw"

# Dataverse "access" endpoint streams the original file (not the tabular .tab projection).
FILE_ID = 13573089
URL = f"https://dataverse.harvard.edu/api/access/datafile/{FILE_ID}?format=original"
RAW_NAME = "countypres_2000-2024.tab"


def download() -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    dest = RAW / RAW_NAME
    if dest.exists() and dest.stat().st_size > 5_000_000:
        print(f"  cached: {dest.relative_to(ROOT)} ({dest.stat().st_size:,} bytes)")
        return dest
    print(f"  GET {URL}")
    req = urllib.request.Request(URL, headers={"User-Agent": "civatas-usa-fetch/0.1"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        dest.write_bytes(resp.read())
    print(f"      -> {dest.relative_to(ROOT)} ({dest.stat().st_size:,} bytes)")
    return dest


def extract_year(src: Path, year: int, out: Path) -> int:
    # MEDSL .tab is actually comma-separated with quoted fields.
    with src.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = [r for r in reader if str(r.get("year")) == str(year)]
    if not rows:
        raise RuntimeError(f"no rows for year {year}")
    fieldnames = list(rows[0].keys())
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    return len(rows)


def summarize(out: Path, year: int) -> None:
    with out.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        parties = {}
        fips = set()
        states = set()
        for r in reader:
            p = (r.get("party") or "").upper()
            parties[p] = parties.get(p, 0) + 1
            if r.get("county_fips"):
                fips.add(r["county_fips"])
            if r.get("state_po"):
                states.add(r["state_po"])
    print(f"    {year}: {len(fips)} unique FIPS, {len(states)} states, parties={sorted(parties.items(), key=lambda x:-x[1])[:6]}")


def main() -> int:
    ELEC.mkdir(parents=True, exist_ok=True)

    print("[1/2] Downloading MEDSL combined file …")
    src = download()

    print("[2/2] Extracting 2016 + 2020 + 2024 …")
    for year in (2016, 2020, 2024):
        out = ELEC / f"president_{year}_county.csv"
        n = extract_year(src, year, out)
        print(f"  {out.relative_to(ROOT)}  ({n} rows)")
        summarize(out, year)

    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
