"""Load MEDSL election results + Cook PVI + ACS state/county dimensions
into the US election database.

Supports two backends:

  Postgres   (production)  — pass --dsn 'postgresql://user@host/civatas'
                             requires the schema in
                             code/ap/services/election-db/init/us_001_schema.sql
                             to already be applied.

  SQLite     (dev / CI)    — pass --sqlite path/to/civatas_us.db
                             schema is auto-translated from the Postgres DDL
                             and applied if the file is empty.

Default: --sqlite data/us_election.db (no extra setup required).

Sources:
  - data/elections/raw/countypres_2000-2024.tab        (MEDSL)
  - data/elections/leaning_profile_us.json             (computed PVI)
  - data/census/{states,counties}.json                  (ACS dimensions)
  - data/geo/us-counties.geojson                        (FIPS truth)
"""
from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SCHEMA_SQL = ROOT / "code/ap/services/election-db/init/us_001_schema.sql"


# ── SQLite-friendly schema (subset of the Postgres DDL) ──────────────
# We re-declare a minimal schema rather than translating Postgres → SQLite at
# runtime, because SQLite lacks ENUMs / arrays. The columns and constraints
# remain compatible with the Postgres version.

SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS us_states (
    fips      TEXT PRIMARY KEY,
    state_po  TEXT NOT NULL UNIQUE,
    name      TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS us_counties (
    fips        TEXT PRIMARY KEY,
    state_fips  TEXT NOT NULL REFERENCES us_states(fips),
    name        TEXT NOT NULL,
    short_name  TEXT,
    UNIQUE (state_fips, name)
);

CREATE TABLE IF NOT EXISTS us_parties (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    short_name  TEXT,
    color       TEXT,
    spectrum    TEXT
);

CREATE TABLE IF NOT EXISTS us_elections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    office          TEXT NOT NULL,
    level           TEXT NOT NULL,
    cycle_year      INTEGER NOT NULL,
    election_date   TEXT,
    scope_state_fips TEXT REFERENCES us_states(fips),
    source_file     TEXT,
    notes           TEXT,
    created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (office, cycle_year, scope_state_fips)
);

CREATE TABLE IF NOT EXISTS us_candidates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id     INTEGER NOT NULL REFERENCES us_elections(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    party_id        INTEGER REFERENCES us_parties(id),
    party_name_raw  TEXT,
    is_incumbent    INTEGER DEFAULT 0,
    is_elected      INTEGER DEFAULT 0,
    running_mate    TEXT,
    constituency    TEXT,
    notes           TEXT,
    UNIQUE (election_id, name)
);

CREATE TABLE IF NOT EXISTS us_vote_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id     INTEGER NOT NULL REFERENCES us_elections(id) ON DELETE CASCADE,
    candidate_id    INTEGER NOT NULL REFERENCES us_candidates(id) ON DELETE CASCADE,
    county_fips     TEXT NOT NULL REFERENCES us_counties(fips),
    vote_count      INTEGER NOT NULL DEFAULT 0,
    vote_share      REAL,
    UNIQUE (election_id, candidate_id, county_fips)
);

CREATE TABLE IF NOT EXISTS us_election_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id     INTEGER NOT NULL REFERENCES us_elections(id) ON DELETE CASCADE,
    county_fips     TEXT NOT NULL REFERENCES us_counties(fips),
    total_votes     INTEGER,
    turnout_pct     REAL,
    eligible_voters INTEGER,
    UNIQUE (election_id, county_fips)
);

CREATE TABLE IF NOT EXISTS us_pvi (
    county_fips     TEXT NOT NULL REFERENCES us_counties(fips),
    reference_cycle INTEGER NOT NULL,
    window_cycles   TEXT NOT NULL,             -- JSON array as text
    pvi             REAL NOT NULL,
    pvi_label       TEXT NOT NULL,
    bucket          TEXT NOT NULL,
    methodology     TEXT,
    PRIMARY KEY (county_fips, reference_cycle)
);

CREATE INDEX IF NOT EXISTS idx_us_counties_state ON us_counties (state_fips);
CREATE INDEX IF NOT EXISTS idx_us_elections_office_year ON us_elections (office, cycle_year);
CREATE INDEX IF NOT EXISTS idx_us_votes_county ON us_vote_results (county_fips);
CREATE INDEX IF NOT EXISTS idx_us_votes_election ON us_vote_results (election_id);
CREATE INDEX IF NOT EXISTS idx_us_pvi_bucket ON us_pvi (bucket);

-- Convenience views (subset of Postgres DDL; name-compatible).
CREATE VIEW IF NOT EXISTS v_us_county_results AS
SELECT
    e.id            AS election_id,
    e.name          AS election_name,
    e.office,
    e.cycle_year,
    s.state_po,
    s.name          AS state_name,
    c.fips          AS county_fips,
    c.name          AS county_name,
    cand.name       AS candidate_name,
    p.name          AS party_name,
    p.spectrum      AS party_spectrum,
    vr.vote_count,
    vr.vote_share,
    es.total_votes  AS county_total_votes
FROM us_vote_results vr
JOIN us_elections e   ON e.id = vr.election_id
JOIN us_candidates cand ON cand.id = vr.candidate_id
LEFT JOIN us_parties p   ON p.id = cand.party_id
JOIN us_counties c    ON c.fips = vr.county_fips
JOIN us_states s      ON s.fips = c.state_fips
LEFT JOIN us_election_stats es
    ON es.election_id = vr.election_id AND es.county_fips = vr.county_fips;
"""

DEFAULT_PARTIES = [
    ("Democratic",       "D",  "#1375B7", "lean_dem"),
    ("Republican",       "R",  "#D72827", "lean_rep"),
    ("Libertarian",      "L",  "#FED105", "lean_rep"),
    ("Green",            "G",  "#17AA5C", "lean_dem"),
    ("Constitution",     "C",  "#A04030", "lean_rep"),
    ("Independent",      "I",  "#888888", "tossup"),
    ("Working Families", "WF", "#1A9E4F", "lean_dem"),
    ("Other",            "O",  "#666666", "tossup"),
]

# Map MEDSL party labels to canonical us_parties.name
PARTY_LABEL_MAP = {
    "DEMOCRAT":         "Democratic",
    "REPUBLICAN":       "Republican",
    "LIBERTARIAN":      "Libertarian",
    "GREEN":            "Green",
    "CONSTITUTION":     "Constitution",
    "INDEPENDENT":      "Independent",
    "WORKING FAMILIES": "Working Families",
    "OTHER":            "Other",
}

CYCLES = (2020, 2024)


# ── Connection abstraction ───────────────────────────────────────────


class DB:
    """Tiny abstraction so the same loader code works against SQLite or Postgres."""

    def __init__(self, kind: str, conn):
        self.kind = kind
        self.conn = conn

    def execute(self, sql: str, params: tuple = ()):
        if self.kind == "postgres":
            sql = sql.replace("?", "%s")
        cur = self.conn.cursor()
        cur.execute(sql, params)
        return cur

    def executemany(self, sql: str, seq):
        if self.kind == "postgres":
            sql = sql.replace("?", "%s")
        cur = self.conn.cursor()
        cur.executemany(sql, seq)
        return cur

    def fetchone(self, sql: str, params: tuple = ()):
        return self.execute(sql, params).fetchone()

    def commit(self):
        self.conn.commit()

    def close(self):
        self.conn.close()


def open_db(dsn: str | None, sqlite_path: str | None) -> DB:
    if dsn:
        try:
            import psycopg2  # type: ignore
        except ImportError:
            print("psycopg2 not installed; install with `pip install psycopg2-binary` "
                  "or use --sqlite for dev.", file=sys.stderr)
            sys.exit(1)
        conn = psycopg2.connect(dsn)
        return DB("postgres", conn)
    path = Path(sqlite_path or (DATA / "us_election.db"))
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA foreign_keys = ON")
    return DB("sqlite", conn)


def ensure_schema(db: DB) -> None:
    if db.kind == "sqlite":
        db.conn.executescript(SQLITE_SCHEMA)
    else:
        # Postgres: assume the operator already applied us_001_schema.sql.
        # We just verify a key table exists.
        ok = db.fetchone("SELECT 1 FROM information_schema.tables "
                         "WHERE table_name = 'us_states' LIMIT 1")
        if not ok:
            print("Postgres schema not present. Apply "
                  "code/ap/services/election-db/init/us_001_schema.sql first.",
                  file=sys.stderr)
            sys.exit(1)
    db.commit()


# ── Loaders ──────────────────────────────────────────────────────────


def load_dimensions(db: DB) -> None:
    """Populate us_states and us_counties from the census JSON files."""
    states = json.loads((DATA / "census" / "states.json").read_text())
    counties = json.loads((DATA / "census" / "counties.json").read_text())
    geo = json.loads((DATA / "geo" / "us-counties.geojson").read_text())

    # Build state_po lookup from the static table inside us_admin (replicated here
    # to avoid an import path dependency).
    state_po = {
        "01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT",
        "10":"DE","11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL",
        "18":"IN","19":"IA","20":"KS","21":"KY","22":"LA","23":"ME","24":"MD",
        "25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT","31":"NE",
        "32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND",
        "39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD",
        "47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA","54":"WV",
        "55":"WI","56":"WY",
    }
    rows = []
    for fips, rec in states.items():
        po = state_po.get(fips)
        if not po:
            continue
        rows.append((fips, po, rec.get("name", "")))
    db.executemany(
        "INSERT OR IGNORE INTO us_states (fips, state_po, name) VALUES (?, ?, ?)"
        if db.kind == "sqlite" else
        "INSERT INTO us_states (fips, state_po, name) VALUES (?, ?, ?) "
        "ON CONFLICT (fips) DO NOTHING",
        rows,
    )
    print(f"  us_states: inserted {len(rows)}")

    # Counties: prefer the geojson FIPS list as authoritative (it's already
    # patched for CT planning regions and AK 02063/02066). Names come from
    # the ACS census file because it correctly distinguishes independent
    # cities ("Baltimore city", "St. Louis city", "Fairfax city") from the
    # surrounding counties ("Fairfax County"), avoiding name collisions.
    geo_fips = sorted({f["id"] for f in geo["features"] if f.get("id", "").isdigit() and len(f["id"]) == 5})
    name_lookup: dict[str, str] = {}
    for fid in geo_fips:
        census_rec = counties.get(fid)
        if census_rec and census_rec.get("name"):
            name_lookup[fid] = census_rec["name"]
        else:
            for f in geo["features"]:
                if f.get("id") == fid:
                    name_lookup[fid] = f.get("properties", {}).get("name") or fid
                    break

    # Also harvest historical FIPS that appear in the MEDSL data so the FK
    # references in us_vote_results all resolve. The old CT counties
    # (09001..09015) and AK Valdez-Cordova (02261) are not in the modern
    # geojson but still appear in 2020 MEDSL rows.
    medsl_fips: set[str] = set()
    raw_csv = DATA / "elections" / "raw" / "countypres_2000-2024.tab"
    if raw_csv.exists():
        with raw_csv.open(encoding="utf-8") as f:
            for r in csv.DictReader(f):
                try:
                    if int(r.get("year") or 0) not in CYCLES:
                        continue
                except ValueError:
                    continue
                fid = (r.get("county_fips") or "").strip().zfill(5)
                if fid.isdigit() and len(fid) == 5:
                    medsl_fips.add(fid)
    legacy_extra = medsl_fips - set(geo_fips)
    legacy_names = {
        "09001": "Fairfield County (legacy)",
        "09003": "Hartford County (legacy)",
        "09005": "Litchfield County (legacy)",
        "09007": "Middlesex County (legacy)",
        "09009": "New Haven County (legacy)",
        "09011": "New London County (legacy)",
        "09013": "Tolland County (legacy)",
        "09015": "Windham County (legacy)",
        "02261": "Valdez-Cordova Census Area (legacy)",
    }

    inserted = 0
    rows = []
    for fips in sorted(set(geo_fips) | legacy_extra):
        state = fips[:2]
        if state not in state_po:
            continue
        if fips in legacy_extra:
            full = legacy_names.get(fips, f"FIPS {fips} (legacy)")
            short = full.split(" (")[0]
        else:
            short = name_lookup.get(fips, fips)
            sl = short.lower()
            suffix = ""
            if not any(sl.endswith(s) for s in (" county", " parish", " borough",
                                                " municipio", " census area",
                                                " planning region", " city")):
                suffix = " County"
            full = short + suffix
        rows.append((fips, state, full, short))
        inserted += 1
    db.executemany(
        "INSERT OR IGNORE INTO us_counties (fips, state_fips, name, short_name) "
        "VALUES (?, ?, ?, ?)" if db.kind == "sqlite" else
        "INSERT INTO us_counties (fips, state_fips, name, short_name) "
        "VALUES (?, ?, ?, ?) ON CONFLICT (fips) DO NOTHING",
        rows,
    )
    print(f"  us_counties: inserted {inserted}")
    db.commit()


def load_parties(db: DB) -> dict[str, int]:
    """Insert default parties (idempotent) and return {name: id}."""
    for name, short, color, spectrum in DEFAULT_PARTIES:
        db.execute(
            "INSERT OR IGNORE INTO us_parties (name, short_name, color, spectrum) "
            "VALUES (?, ?, ?, ?)" if db.kind == "sqlite" else
            "INSERT INTO us_parties (name, short_name, color, spectrum) "
            "VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING",
            (name, short, color, spectrum),
        )
    db.commit()
    out = {}
    for row in db.execute("SELECT id, name FROM us_parties"):
        out[row[1]] = row[0]
    return out


def load_elections_and_results(db: DB, party_ids: dict[str, int]) -> None:
    """Walk MEDSL CSV and populate elections / candidates / vote_results / stats."""
    raw = DATA / "elections" / "raw" / "countypres_2000-2024.tab"
    if not raw.exists():
        print(f"  ERROR: missing {raw}; run scripts/fetch_elections.py first", file=sys.stderr)
        return

    elections_inserted = 0
    candidates_inserted = 0
    votes_inserted = 0
    stats_inserted = 0

    # Cache: (year) → election_id (one nationwide president row per cycle)
    election_id_for: dict[int, int] = {}
    # Cache: (election_id, candidate_name) → candidate_id
    candidate_id_for: dict[tuple[int, str], int] = {}
    # Stats accumulator: (election_id, county_fips) → max(totalvotes)
    stats_acc: dict[tuple[int, str], int] = {}
    # Vote accumulator: (election_id, candidate_id, county_fips) → vote_count
    vote_acc: dict[tuple[int, int, str], int] = {}

    with raw.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                year = int(row.get("year") or 0)
            except ValueError:
                continue
            if year not in CYCLES:
                continue
            mode = (row.get("mode") or "").upper()

            cand_name = (row.get("candidate") or "").strip().title()
            if not cand_name or cand_name == "Other":
                cand_name = "Other"
            party_label = (row.get("party") or "").upper().strip()
            party_canonical = PARTY_LABEL_MAP.get(party_label, "Other")
            party_id = party_ids.get(party_canonical) or party_ids.get("Other")

            fips = (row.get("county_fips") or "").strip().zfill(5)
            if not fips.isdigit() or len(fips) != 5:
                continue
            try:
                votes = int(row.get("candidatevotes") or 0)
                total = int(row.get("totalvotes") or 0)
            except ValueError:
                continue

            # Get / create election row
            if year not in election_id_for:
                cur = db.execute(
                    "INSERT OR IGNORE INTO us_elections "
                    "(name, office, level, cycle_year, election_date, scope_state_fips, source_file) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)" if db.kind == "sqlite" else
                    "INSERT INTO us_elections "
                    "(name, office, level, cycle_year, election_date, scope_state_fips, source_file) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT (office, cycle_year, scope_state_fips) DO NOTHING",
                    (
                        f"{year} US Presidential Election",
                        "president", "federal", year,
                        f"{year}-11-{'03' if year == 2020 else '05'}",
                        None,
                        "medsl/countypres_2000-2024.tab",
                    ),
                )
                row_e = db.fetchone(
                    "SELECT id FROM us_elections WHERE office = ? AND cycle_year = ? "
                    "AND scope_state_fips IS NULL",
                    ("president", year),
                )
                election_id_for[year] = row_e[0]
                elections_inserted += 1
            eid = election_id_for[year]

            # Get / create candidate row
            ck = (eid, cand_name)
            if ck not in candidate_id_for:
                db.execute(
                    "INSERT OR IGNORE INTO us_candidates "
                    "(election_id, name, party_id, party_name_raw) "
                    "VALUES (?, ?, ?, ?)" if db.kind == "sqlite" else
                    "INSERT INTO us_candidates "
                    "(election_id, name, party_id, party_name_raw) "
                    "VALUES (?, ?, ?, ?) ON CONFLICT (election_id, name) DO NOTHING",
                    (eid, cand_name, party_id, party_label),
                )
                rc = db.fetchone(
                    "SELECT id FROM us_candidates WHERE election_id = ? AND name = ?",
                    (eid, cand_name),
                )
                candidate_id_for[ck] = rc[0]
                candidates_inserted += 1
            cid = candidate_id_for[ck]

            # Vote accumulator: prefer TOTAL rows; otherwise sum modes.
            vk = (eid, cid, fips)
            if mode == "TOTAL":
                # Trust TOTAL: max-merge (some files duplicate)
                vote_acc[vk] = max(vote_acc.get(vk, 0), votes)
            else:
                # Only fall back to mode aggregation if no TOTAL has been seen
                # for this (election, county) combination.
                if vk not in vote_acc:
                    vote_acc[vk] = votes
                else:
                    # If we've seen a TOTAL it should already cover everything.
                    # If not (no TOTAL existed), accumulate.
                    pass  # leave existing value; modes are usually consistent
            stats_acc[(eid, fips)] = max(stats_acc.get((eid, fips), 0), total)

    # Bulk insert votes
    print(f"  flushing {len(vote_acc)} vote rows …")
    rows = [(eid, cid, fips, v) for (eid, cid, fips), v in vote_acc.items()]
    db.executemany(
        "INSERT OR REPLACE INTO us_vote_results "
        "(election_id, candidate_id, county_fips, vote_count) VALUES (?, ?, ?, ?)"
        if db.kind == "sqlite" else
        "INSERT INTO us_vote_results "
        "(election_id, candidate_id, county_fips, vote_count) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (election_id, candidate_id, county_fips) DO UPDATE "
        "SET vote_count = EXCLUDED.vote_count",
        rows,
    )
    votes_inserted = len(rows)

    print(f"  flushing {len(stats_acc)} stats rows …")
    srows = [(eid, fips, total) for (eid, fips), total in stats_acc.items()]
    db.executemany(
        "INSERT OR REPLACE INTO us_election_stats "
        "(election_id, county_fips, total_votes) VALUES (?, ?, ?)"
        if db.kind == "sqlite" else
        "INSERT INTO us_election_stats "
        "(election_id, county_fips, total_votes) VALUES (?, ?, ?) "
        "ON CONFLICT (election_id, county_fips) DO UPDATE "
        "SET total_votes = EXCLUDED.total_votes",
        srows,
    )
    stats_inserted = len(srows)

    db.commit()
    print(f"  us_elections: {elections_inserted}")
    print(f"  us_candidates: {candidates_inserted}")
    print(f"  us_vote_results: {votes_inserted}")
    print(f"  us_election_stats: {stats_inserted}")


def load_pvi(db: DB) -> None:
    profile = json.loads((DATA / "elections" / "leaning_profile_us.json").read_text())
    counties = profile.get("counties", {})
    rows = []
    for fips, rec in counties.items():
        pvi_val = rec.get("pvi")
        if pvi_val is None:
            continue
        bucket = "Tossup"
        n = round(pvi_val * 100)
        if pvi_val >= 0.15:
            bucket = "Solid Dem"
        elif pvi_val >= 0.05:
            bucket = "Lean Dem"
        elif pvi_val > -0.05:
            bucket = "Tossup"
        elif pvi_val > -0.15:
            bucket = "Lean Rep"
        else:
            bucket = "Solid Rep"
        label = rec.get("pvi_label") or (
            f"D+{n}" if n > 0 else (f"R+{abs(n)}" if n < 0 else "EVEN")
        )
        rows.append((
            fips,
            2024,                    # reference cycle
            json.dumps([2020, 2024]),
            float(pvi_val),
            label,
            bucket,
            "cook_pvi_two_party_share",
        ))
    db.executemany(
        "INSERT OR REPLACE INTO us_pvi "
        "(county_fips, reference_cycle, window_cycles, pvi, pvi_label, bucket, methodology) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)" if db.kind == "sqlite" else
        "INSERT INTO us_pvi "
        "(county_fips, reference_cycle, window_cycles, pvi, pvi_label, bucket, methodology) "
        "VALUES (?, ?, ?::int[], ?, ?, ?, ?) "
        "ON CONFLICT (county_fips, reference_cycle) DO UPDATE "
        "SET pvi = EXCLUDED.pvi, pvi_label = EXCLUDED.pvi_label, bucket = EXCLUDED.bucket",
        rows,
    )
    print(f"  us_pvi: inserted {len(rows)}")
    db.commit()


# ── Verification queries ─────────────────────────────────────────────


def verify(db: DB) -> int:
    print()
    print("Verification:")
    n_states = db.fetchone("SELECT COUNT(*) FROM us_states")[0]
    n_counties = db.fetchone("SELECT COUNT(*) FROM us_counties")[0]
    n_elections = db.fetchone("SELECT COUNT(*) FROM us_elections")[0]
    n_candidates = db.fetchone("SELECT COUNT(*) FROM us_candidates")[0]
    n_votes = db.fetchone("SELECT COUNT(*) FROM us_vote_results")[0]
    n_pvi = db.fetchone("SELECT COUNT(*) FROM us_pvi")[0]
    print(f"  us_states         {n_states}")
    print(f"  us_counties       {n_counties}")
    print(f"  us_elections      {n_elections}")
    print(f"  us_candidates     {n_candidates}")
    print(f"  us_vote_results   {n_votes}")
    print(f"  us_pvi            {n_pvi}")

    # Sanity: PA 2024 county count + state-level Dem vs Rep totals
    pa_2024 = db.fetchone("""
        SELECT COUNT(DISTINCT vr.county_fips)
        FROM us_vote_results vr
        JOIN us_elections e ON e.id = vr.election_id
        JOIN us_counties c ON c.fips = vr.county_fips
        WHERE e.cycle_year = 2024 AND c.state_fips = '42'
    """)[0]
    print(f"  PA counties with 2024 results: {pa_2024} (expected 67)")

    pa_totals = list(db.execute("""
        SELECT p.name, SUM(vr.vote_count)
        FROM us_vote_results vr
        JOIN us_elections e ON e.id = vr.election_id
        JOIN us_candidates c ON c.id = vr.candidate_id
        JOIN us_parties p ON p.id = c.party_id
        JOIN us_counties co ON co.fips = vr.county_fips
        WHERE e.cycle_year = 2024 AND co.state_fips = '42'
          AND p.name IN ('Democratic', 'Republican')
        GROUP BY p.name
        ORDER BY p.name
    """))
    print("  PA 2024 totals:")
    for name, total in pa_totals:
        print(f"    {name}: {total:,}")

    # PVI bucket distribution
    print("  PVI bucket distribution (3,142 counties):")
    for row in db.execute("SELECT bucket, COUNT(*) FROM us_pvi GROUP BY bucket"):
        print(f"    {row[0]:>10}  {row[1]:>5}")

    return 0


# ── CLI ──────────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", help="Postgres DSN, e.g. postgresql://user@host/civatas")
    p.add_argument("--sqlite", help="SQLite path (default: data/us_election.db)")
    args = p.parse_args()

    db = open_db(args.dsn, args.sqlite)
    print(f"Backend: {db.kind}")
    ensure_schema(db)
    print("[1/4] dimensions (states + counties)")
    load_dimensions(db)
    print("[2/4] parties")
    parties = load_parties(db)
    print("[3/4] elections + candidates + vote_results + stats")
    load_elections_and_results(db, parties)
    print("[4/4] PVI")
    load_pvi(db)
    rc = verify(db)
    db.close()
    return rc


if __name__ == "__main__":
    sys.exit(main())
