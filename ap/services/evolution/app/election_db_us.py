"""US election DB shim — same public surface as election_db.py but reads
from the SQLite ``us_election.db`` populated by Civatas-USA Stage 2.

Used unconditionally by election_db.py (Stage 1.9 cleanup removed TW dual path).

Data source:
  /app/shared/us_data/us_election.db   (bind-mounted from ap/shared/us_data/)
  Schema: see code/ap/services/election-db/init/us_001_schema.sql
  Loaded by: Civatas-USA/scripts/load_election_db.py

Tables used:
  us_states          (51 rows)
  us_counties        (3192 rows incl. 9 CT legacy)
  us_parties         (8 rows: Democratic / Republican / Independent / ...)
  us_elections       (2 rows: 2020 + 2024 presidential)
  us_candidates      (12 rows across both cycles)
  us_vote_results    (25,133 rows)
  us_election_stats  (6,307 rows)
  us_pvi             (3,152 rows: Cook PVI per county)

Election scope semantics:
  - For nationwide totals, use scope="United States"
  - For state-level totals, use scope="<state full name>" e.g. "Pennsylvania"
  - For county-level totals, use scope="<county name>" e.g. "Allegheny County"

The TW code's election_type values are reused / extended:
  "president"           → US presidential election
"""
from __future__ import annotations

import logging
import os
import sqlite3
from contextlib import contextmanager

logger = logging.getLogger(__name__)

# DB path inside the container; can be overridden by env var.
US_DB_PATH = os.environ.get(
    "CIVATAS_USA_ELECTION_DB",
    "/app/shared/us_data/us_election.db",
)


@contextmanager
def _db():
    conn = sqlite3.connect(US_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


# ── Election listing ────────────────────────────────────────


def list_elections(
    election_type: str | None = None,
    scope: str | None = None,
    min_year: int | None = None,
    max_year: int | None = None,
) -> list[dict]:
    """List available US elections.

    Returns one logical election entry per (cycle_year, scope) pair where
    scope is the state name. Each cycle is also listed nationwide.

    Output rows have the same key set as the TW version:
        id, name, election_type, ad_year, scope, election_date
    """
    out: list[dict] = []
    with _db() as conn:
        # Cycle years available
        cur = conn.execute("""
            SELECT DISTINCT cycle_year FROM us_elections
            WHERE office = 'president'
            ORDER BY cycle_year DESC
        """)
        years = [row["cycle_year"] for row in cur.fetchall()]

        # State list (50 + DC)
        cur = conn.execute("SELECT fips, state_po, name FROM us_states ORDER BY name")
        states = cur.fetchall()

    # Build the listing: for each cycle, a nationwide entry + per-state entries.
    fake_id = 0
    for year in years:
        if min_year and year < min_year:
            continue
        if max_year and year > max_year:
            continue
        if election_type and election_type != "president":
            continue
        # Nationwide
        fake_id += 1
        if not scope or scope in ("United States", "USA", "All"):
            out.append({
                "id": fake_id,
                "name": f"{year} US Presidential Election (nationwide)",
                "election_type": "president",
                "ad_year": year,
                "scope": "United States",
                "election_date": f"{year}-11-{'03' if year == 2020 else '05'}",
            })
        # Per-state
        for s in states:
            state_name = s["name"]
            if scope and scope != state_name:
                continue
            fake_id += 1
            out.append({
                "id": fake_id,
                "name": f"{year} US Presidential Election ({state_name})",
                "election_type": "president",
                "ad_year": year,
                "scope": state_name,
                "election_date": f"{year}-11-{'03' if year == 2020 else '05'}",
            })
    return out


# ── Vote results queries ────────────────────────────────────


def _resolve_county_filter(conn, scope: str | None) -> tuple[str, list]:
    """Build a SQL filter that picks counties matching ``scope``.

    ``scope`` may be:
      - "United States" / "USA" / None  → all counties (no filter)
      - state name e.g. "Pennsylvania"  → all counties in that state
      - county name e.g. "Allegheny County" → that one county
    """
    if not scope or scope in ("United States", "USA", "All"):
        return "", []
    # State?
    cur = conn.execute("SELECT fips FROM us_states WHERE name = ?", (scope,))
    row = cur.fetchone()
    if row:
        return " AND co.state_fips = ?", [row["fips"]]
    # County (with or without "County" suffix)?
    cur = conn.execute("SELECT fips FROM us_counties WHERE name = ? OR short_name = ?", (scope, scope))
    row = cur.fetchone()
    if row:
        return " AND co.fips = ?", [row["fips"]]
    return " AND 1=0", []


def get_county_results(
    election_id: int | None = None,
    election_type: str | None = None,
    ad_year: int | None = None,
    county: str | None = None,
) -> list[dict]:
    """Get aggregated vote results.

    Returns rows with the same shape as the TW version:
        candidate_name, party_name, spectrum, county, total_votes, vote_share_pct

    For US, ``county`` may be a state name (returns state-aggregated rows
    with ``county`` set to the state name), or an actual county name.
    """
    with _db() as conn:
        scope_filter, scope_params = _resolve_county_filter(conn, county)
        params: list = []
        sql = """
            SELECT
                ca.name        AS candidate_name,
                p.name         AS party_name,
                p.spectrum     AS spectrum,
                ? AS county,
                SUM(vr.vote_count) AS total_votes
            FROM us_vote_results vr
            JOIN us_elections e   ON e.id = vr.election_id
            JOIN us_candidates ca ON ca.id = vr.candidate_id
            LEFT JOIN us_parties p ON p.id = ca.party_id
            JOIN us_counties co   ON co.fips = vr.county_fips
            WHERE e.office = 'president'
        """
        params.append(county or "United States")

        if ad_year:
            sql += " AND e.cycle_year = ?"
            params.append(ad_year)
        sql += scope_filter
        params.extend(scope_params)

        sql += " GROUP BY ca.name, p.name, p.spectrum ORDER BY total_votes DESC"
        cur = conn.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]

        # Compute vote_share_pct (% of total)
        total = sum(r["total_votes"] or 0 for r in rows) or 1
        for r in rows:
            r["vote_share_pct"] = round((r["total_votes"] or 0) * 100.0 / total, 2)
            r["total_votes"] = int(r["total_votes"] or 0)
        return rows


def get_district_results(
    election_id: int | None = None,
    election_type: str | None = None,
    ad_year: int | None = None,
    county: str | None = None,
) -> list[dict]:
    """Per-county breakdown (in TW the district = sub-county; in US the
    'district' for alignment purposes IS the county itself, since we don't
    drill below county level).

    Output rows match the TW shape with ``district`` = county name.
    """
    with _db() as conn:
        scope_filter, scope_params = _resolve_county_filter(conn, county)
        sql = """
            SELECT
                co.name        AS district,
                ca.name        AS candidate_name,
                p.name         AS party_name,
                p.spectrum     AS spectrum,
                vr.vote_count  AS vote_count,
                co.fips        AS county_fips
            FROM us_vote_results vr
            JOIN us_elections e   ON e.id = vr.election_id
            JOIN us_candidates ca ON ca.id = vr.candidate_id
            LEFT JOIN us_parties p ON p.id = ca.party_id
            JOIN us_counties co   ON co.fips = vr.county_fips
            WHERE e.office = 'president'
        """
        params: list = []
        if ad_year:
            sql += " AND e.cycle_year = ?"
            params.append(ad_year)
        sql += scope_filter
        params.extend(scope_params)
        sql += " ORDER BY co.name, vr.vote_count DESC"
        cur = conn.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]

        # Compute vote_share within each county
        per_county_total: dict[str, int] = {}
        for r in rows:
            per_county_total[r["district"]] = per_county_total.get(r["district"], 0) + (r["vote_count"] or 0)
        for r in rows:
            t = per_county_total.get(r["district"]) or 1
            r["vote_share"] = round((r["vote_count"] or 0) * 100.0 / t, 2)
            r["county"] = r["district"]
        return rows


def build_ground_truth(election_type: str, ad_year: int, county: str) -> dict:
    """Build a ground_truth dict suitable for the calibration system.

    Same shape as TW version:
        {"Candidate Name(Party)": vote_share_pct, ..., "__by_district__": {...}}
    """
    rows = get_county_results(
        election_type=election_type, ad_year=ad_year, county=county,
    )
    ground_truth: dict = {}
    for r in rows:
        party = r["party_name"] or "Independent"
        key = f"{r['candidate_name']}({party})"
        ground_truth[key] = float(r["vote_share_pct"]) if r["vote_share_pct"] else 0.0

    # Per-county breakdown when ``county`` is a state (for alignment to drill
    # into county-level ground truth during calibration).
    district_rows = get_district_results(
        election_type=election_type, ad_year=ad_year, county=county,
    )
    by_district: dict[str, dict[str, float]] = {}
    for r in district_rows:
        d = r["district"]
        if d not in by_district:
            by_district[d] = {}
        party = r["party_name"] or "Independent"
        key = f"{r['candidate_name']}({party})"
        by_district[d][key] = float(r["vote_share"]) if r["vote_share"] else 0.0
    if by_district:
        ground_truth["__by_district__"] = by_district
    return ground_truth


# ── Leaning profile builder ─────────────────────────────────


def build_leaning_profile(election_type: str, ad_year: int, county: str) -> dict:
    """Build a per-county leaning profile from US election data.

    Returns the same format as the TW build_leaning_profile() but using the
    5-tier Cook spectrum (Solid Dem / Lean Dem / Tossup / Lean Rep / Solid Rep).
    The "districts" mapping is keyed by county name; each county gets a
    probability distribution across the 5 tiers based on its Cook PVI bucket.

    Persona generation uses this to weight political_leaning sampling.
    """
    spectrum_labels = ["Solid Dem", "Lean Dem", "Tossup", "Lean Rep", "Solid Rep"]

    with _db() as conn:
        scope_filter, scope_params = _resolve_county_filter(conn, county)
        # Pull PVI per county within scope
        sql = """
            SELECT co.name, co.fips, pvi.pvi, pvi.bucket
            FROM us_pvi pvi
            JOIN us_counties co ON co.fips = pvi.county_fips
            WHERE 1=1
        """
        params: list = []
        sql += scope_filter
        params.extend(scope_params)
        sql += " ORDER BY co.name"
        cur = conn.execute(sql, params)
        county_rows = cur.fetchall()

    if not county_rows:
        return {}

    districts: dict[str, dict[str, float]] = {}
    for row in county_rows:
        cname = row["name"]
        bucket = row["bucket"] or "Tossup"
        # Convert the discrete bucket into a soft probability distribution
        # so persona sampling has spread (not just deterministic). Mass on
        # the bucket itself, with some leakage to neighbors.
        idx = spectrum_labels.index(bucket) if bucket in spectrum_labels else 2
        weights = [0.0] * 5
        weights[idx] = 0.65
        if idx > 0:
            weights[idx - 1] = 0.20
        if idx < 4:
            weights[idx + 1] = 0.10
        # Distribute remainder to ends so all 5 tiers have non-zero mass
        leftover = 1.0 - sum(weights)
        weights[0] += leftover / 2
        weights[4] += leftover / 2
        districts[cname] = {
            spectrum_labels[i]: round(weights[i], 4) for i in range(5)
        }

    return {
        "description": f"{ad_year} {county} US Presidential Election leaning profile (Cook PVI 5-tier)",
        "data_sources": [f"MEDSL countypres {ad_year} via us_election.db"],
        "spectrum": spectrum_labels,
        "count": len(districts),
        "districts": districts,
    }


# ── Historical trend ────────────────────────────────────────


def get_historical_trend(
    county: str,
    election_type: str = "president",
    min_year: int = 2010,
) -> list[dict]:
    """Get vote share trends across multiple US presidential cycles for a scope.

    Returns rows matching the TW shape:
        ad_year, candidate_name, party_name, party_spectrum, vote_share_pct
    """
    out: list[dict] = []
    with _db() as conn:
        scope_filter, scope_params = _resolve_county_filter(conn, county)
        sql = """
            SELECT
                e.cycle_year   AS ad_year,
                ca.name        AS candidate_name,
                p.name         AS party_name,
                p.spectrum     AS party_spectrum,
                SUM(vr.vote_count) AS total_votes
            FROM us_vote_results vr
            JOIN us_elections e   ON e.id = vr.election_id
            JOIN us_candidates ca ON ca.id = vr.candidate_id
            LEFT JOIN us_parties p ON p.id = ca.party_id
            JOIN us_counties co   ON co.fips = vr.county_fips
            WHERE e.office = 'president' AND e.cycle_year >= ?
        """
        params: list = [min_year]
        sql += scope_filter
        params.extend(scope_params)
        sql += " GROUP BY e.cycle_year, ca.name, p.name, p.spectrum ORDER BY e.cycle_year, total_votes DESC"
        cur = conn.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]

    # Compute pct per year
    per_year_total: dict[int, int] = {}
    for r in rows:
        per_year_total[r["ad_year"]] = per_year_total.get(r["ad_year"], 0) + (r["total_votes"] or 0)
    for r in rows:
        t = per_year_total.get(r["ad_year"]) or 1
        r["vote_share_pct"] = round((r["total_votes"] or 0) * 100.0 / t, 2)
        r["is_incumbent"] = False
        out.append(r)
    return out


# ── Spectrum summary ────────────────────────────────────────


def get_spectrum_summary(
    county: str,
    election_type: str = "president",
    ad_year: int | None = None,
) -> dict:
    """Get a 5-tier spectrum summary for a state/county.

    Returns: {"Solid Dem": pct, "Lean Dem": pct, "Tossup": pct,
              "Lean Rep": pct, "Solid Rep": pct, "year": int}
    """
    with _db() as conn:
        # Use the most recent cycle if not specified
        if not ad_year:
            cur = conn.execute(
                "SELECT MAX(cycle_year) FROM us_elections WHERE office = 'president'"
            )
            row = cur.fetchone()
            ad_year = row[0] if row and row[0] else 2024

        scope_filter, scope_params = _resolve_county_filter(conn, county)
        # Aggregate party totals
        sql = """
            SELECT p.name AS party_name, SUM(vr.vote_count) AS total
            FROM us_vote_results vr
            JOIN us_elections e   ON e.id = vr.election_id
            JOIN us_candidates ca ON ca.id = vr.candidate_id
            LEFT JOIN us_parties p ON p.id = ca.party_id
            JOIN us_counties co   ON co.fips = vr.county_fips
            WHERE e.office = 'president' AND e.cycle_year = ?
        """
        params: list = [ad_year]
        sql += scope_filter
        params.extend(scope_params)
        sql += " GROUP BY p.name"
        cur = conn.execute(sql, params)
        rows = cur.fetchall()

    # The 5-tier spectrum is derived from PVI buckets, not raw vote share.
    # For a "summary" the user expects something readable. Easiest:
    # Dem total → Lean/Solid Dem mass; Rep total → Lean/Solid Rep mass.
    dem = sum(r["total"] for r in rows if r["party_name"] == "Democratic") or 0
    rep = sum(r["total"] for r in rows if r["party_name"] == "Republican") or 0
    other = sum(r["total"] for r in rows if r["party_name"] not in ("Democratic", "Republican")) or 0
    total = dem + rep + other or 1

    out = {
        "Solid Dem": 0.0,
        "Lean Dem": round(dem * 100.0 / total, 2),
        "Tossup":   round(other * 100.0 / total, 2),
        "Lean Rep": round(rep * 100.0 / total, 2),
        "Solid Rep": 0.0,
        "year": ad_year,
    }
    return out


# ── DB health check ─────────────────────────────────────────


def check_db() -> dict:
    """Check if the SQLite US election DB exists and return basic stats."""
    try:
        if not os.path.exists(US_DB_PATH):
            return {"healthy": False, "error": f"DB not found at {US_DB_PATH}"}
        with _db() as conn:
            n_states = conn.execute("SELECT COUNT(*) AS n FROM us_states").fetchone()["n"]
            n_counties = conn.execute("SELECT COUNT(*) AS n FROM us_counties").fetchone()["n"]
            n_elections = conn.execute("SELECT COUNT(*) AS n FROM us_elections").fetchone()["n"]
            n_candidates = conn.execute("SELECT COUNT(*) AS n FROM us_candidates").fetchone()["n"]
            n_votes = conn.execute("SELECT COUNT(*) AS n FROM us_vote_results").fetchone()["n"]
            n_pvi = conn.execute("SELECT COUNT(*) AS n FROM us_pvi").fetchone()["n"]
        return {
            "healthy": True,
            "country": "US",
            "backend": "sqlite",
            "path": US_DB_PATH,
            "stats": {
                "states": n_states,
                "counties": n_counties,
                "elections": n_elections,
                "candidates": n_candidates,
                "vote_results": n_votes,
                "pvi": n_pvi,
            },
        }
    except Exception as e:
        return {"healthy": False, "error": str(e)}


# ── Stance trends — TW NCCU equivalent doesn't exist for US ─


def get_stance_for_year(year: int) -> dict | None:
    """Return None — US has no equivalent of TW NCCU cross-strait stance survey.
    Provided only for API symmetry.
    """
    return None


def get_stance_trends() -> list[dict]:
    return []
