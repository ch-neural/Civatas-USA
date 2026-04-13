"""Compute Cook Partisan Voting Index (PVI) per county from 2020+2024 results.

PVI methodology (Cook Political Report):
  share_D(county, year) = Dem / (Dem + Rep)        [two-party share]
  share_D(nation, year) = sum(Dem) / sum(Dem + Rep)
  delta(county, year)   = share_D(county) - share_D(nation)
  PVI(county)           = mean(delta over last two cycles)

We output PVI as a signed float (e.g. +0.082 = D+8, -0.150 = R+15) plus a
human-readable label. The continuous value is what predictor.py should consume;
the label is for UI display.

Output: data/elections/leaning_profile_us.json
{
  "schema_version": 1,
  "methodology": "Cook PVI from MEDSL 2020+2024 two-party share",
  "national": {
    "2020": {"dem_share": 0.523, "dem_votes": ..., "rep_votes": ...},
    "2024": {...}
  },
  "counties": {
    "42003": {                          # FIPS
      "state": "PA",
      "name": "Allegheny",
      "pvi": 0.0823,
      "pvi_label": "D+8",
      "cycles": {
        "2020": {"dem": 429065, "rep": 271128, "total": 715973, "dem_share": 0.6128, "delta": 0.0898},
        "2024": {...}
      }
    },
    ...
  }
}
"""
from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ELEC = ROOT / "data" / "elections"
DEFAULT_YEARS = (2020, 2024)


def load_year(year: int) -> dict[str, dict]:
    """Return {fips: {dem, rep, total, state, name}} for a given cycle.

    MEDSL inconsistency: some state-years have only TOTAL rows, others have only
    per-mode rows (no TOTAL), and some have both. Strategy per (fips, party):
      - if any row has mode == "TOTAL", trust the maximum TOTAL value
      - else sum across all per-mode rows
    """
    path = ELEC / f"president_{year}_county.csv"
    # Per-fips raw accumulator
    raw: dict[str, dict] = {}
    with path.open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            fips = (r.get("county_fips") or "").strip()
            if not fips or fips.lower() == "na":
                continue
            fips = fips.zfill(5)
            party = (r.get("party") or "").upper()
            try:
                votes = int(r.get("candidatevotes") or 0)
                total = int(r.get("totalvotes") or 0)
            except ValueError:
                continue
            mode = (r.get("mode") or "").upper()
            entry = raw.setdefault(
                fips,
                {
                    "state": r.get("state_po") or "",
                    "name": (r.get("county_name") or "").title(),
                    "has_total": False,
                    "total_dem": 0,
                    "total_rep": 0,
                    "modes_dem": 0,
                    "modes_rep": 0,
                    "total_votes": 0,
                },
            )
            entry["state"] = entry["state"] or (r.get("state_po") or "")
            if total > entry["total_votes"]:
                entry["total_votes"] = total
            if mode == "TOTAL":
                entry["has_total"] = True
                if party == "DEMOCRAT":
                    entry["total_dem"] = max(entry["total_dem"], votes)
                elif party == "REPUBLICAN":
                    entry["total_rep"] = max(entry["total_rep"], votes)
            else:
                if party == "DEMOCRAT":
                    entry["modes_dem"] += votes
                elif party == "REPUBLICAN":
                    entry["modes_rep"] += votes

    out: dict[str, dict] = {}
    for fips, e in raw.items():
        if e["has_total"] and (e["total_dem"] + e["total_rep"]) > 0:
            d, r = e["total_dem"], e["total_rep"]
        else:
            d, r = e["modes_dem"], e["modes_rep"]
        out[fips] = {
            "dem": d,
            "rep": r,
            "total": e["total_votes"],
            "state": e["state"],
            "name": e["name"],
        }
    return out


def compute(years: tuple[int, int] = DEFAULT_YEARS, output_suffix: str = "") -> int:
    """Compute PVI for a given year pair. Output to leaning_profile_us{suffix}.json."""
    YEARS = years
    cycles: dict[int, dict[str, dict]] = {}
    for y in YEARS:
        cycles[y] = load_year(y)
        print(f"  {y}: loaded {len(cycles[y])} counties")

    # National two-party share per cycle.
    national = {}
    for y, data in cycles.items():
        d = sum(c["dem"] for c in data.values())
        r = sum(c["rep"] for c in data.values())
        share = d / (d + r) if (d + r) else 0.0
        national[y] = {"dem_votes": d, "rep_votes": r, "dem_share": round(share, 6)}
        print(f"  {y} national D share: {share:.4f} (D={d:,}  R={r:,})")

    # Per-county PVI (require both cycles).
    all_fips = set(cycles[YEARS[0]].keys()) | set(cycles[YEARS[1]].keys())
    counties_out = {}
    skipped = 0
    for fips in sorted(all_fips):
        per_cycle = {}
        deltas = []
        meta_state = ""
        meta_name = ""
        ok = True
        for y in YEARS:
            entry = cycles[y].get(fips)
            if not entry:
                ok = False
                break
            d, r = entry["dem"], entry["rep"]
            if (d + r) == 0:
                ok = False
                break
            share = d / (d + r)
            delta = share - national[y]["dem_share"]
            per_cycle[str(y)] = {
                "dem": d,
                "rep": r,
                "total": entry["total"],
                "dem_share": round(share, 6),
                "delta": round(delta, 6),
            }
            deltas.append(delta)
            meta_state = entry["state"] or meta_state
            meta_name = entry["name"] or meta_name
        if not ok:
            skipped += 1
            continue
        pvi = sum(deltas) / len(deltas)
        n = round(pvi * 100)
        if n > 0:
            label = f"D+{n}"
        elif n < 0:
            label = f"R+{abs(n)}"
        else:
            label = "EVEN"
        counties_out[fips] = {
            "state": meta_state,
            "name": meta_name,
            "pvi": round(pvi, 6),
            "pvi_label": label,
            "cycles": per_cycle,
        }

    out = {
        "schema_version": 1,
        "methodology": f"Cook PVI = mean over {YEARS[0]},{YEARS[1]} of (county Dem two-party share − national Dem two-party share). Source: MEDSL countypres_2000-2024.",
        "source": "https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/VOQCHQ",
        "license": "CC0-1.0",
        "national": {str(k): v for k, v in national.items()},
        "counties": counties_out,
    }
    dest = ELEC / f"leaning_profile_us{output_suffix}.json"
    dest.write_text(json.dumps(out, indent=2))

    # Distribution check.
    pvis = [c["pvi"] for c in counties_out.values()]
    pvis_sorted = sorted(pvis)
    median = pvis_sorted[len(pvis_sorted) // 2]
    extremes_d = sum(1 for p in pvis if p > 0.20)
    extremes_r = sum(1 for p in pvis if p < -0.20)
    print(f"  wrote {len(counties_out)} counties (skipped {skipped} due to missing cycle)")
    print(f"  PVI range: min={min(pvis):.3f}  median={median:.3f}  max={max(pvis):.3f}")
    print(f"  Strong D (>D+20): {extremes_d}    Strong R (>R+20): {extremes_r}")
    print(f"  -> {dest.relative_to(ROOT)}")
    return 0


def main() -> int:
    """CLI entry: compute default (2020+2024) PVI."""
    return compute(DEFAULT_YEARS)


if __name__ == "__main__":
    sys.exit(main())
