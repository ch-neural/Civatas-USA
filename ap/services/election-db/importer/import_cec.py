#!/usr/bin/env python3
"""CLI tool to import CEC election data files into PostgreSQL.

Usage:
    # Import a single file
    python import_cec.py /path/to/file.xls

    # Import all files in a directory (recursive)
    python import_cec.py /path/to/samples-vote/

    # Override auto-detected metadata
    python import_cec.py /path/to/file.xls --year 2022 --scope 臺中市 --type mayor

    # Dry run (parse only, don't write to DB)
    python import_cec.py /path/to/samples-vote/ --dry-run

    # Custom DB connection
    python import_cec.py /path/to/file.xls --db-host localhost --db-port 5432

Environment variables:
    ELECTION_DB_HOST  (default: localhost)
    ELECTION_DB_PORT  (default: 5432)
    ELECTION_DB_NAME  (default: elections)
    ELECTION_DB_USER  (default: civatas)
    ELECTION_DB_PASS  (default: civatas2026)
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

from parsers import (
    ElectionMeta,
    ParsedRow,
    parse_file,
    extract_meta_from_filename,
    _normalize_party,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger(__name__)

# Supported file extensions
SUPPORTED_EXTS = {".xls", ".xlsx", ".csv", ".txt", ".tsv"}

# Skip patterns in filenames
SKIP_PATTERNS = [
    "編碼簿", "codebook", ".sav", ".rtf", ".DS_Store",
    "合併檔", "釋出", "README", "說明",
]


def get_db_connection(args) -> psycopg2.extensions.connection:
    host = args.db_host or os.environ.get("ELECTION_DB_HOST", "localhost")
    port = args.db_port or int(os.environ.get("ELECTION_DB_PORT", "5432"))
    dbname = args.db_name or os.environ.get("ELECTION_DB_NAME", "elections")
    user = args.db_user or os.environ.get("ELECTION_DB_USER", "civatas")
    password = args.db_pass or os.environ.get("ELECTION_DB_PASS", "civatas2026")

    conn = psycopg2.connect(host=host, port=port, dbname=dbname, user=user, password=password)
    conn.autocommit = False
    return conn


def find_files(path: str) -> list[str]:
    """Recursively find all importable files."""
    p = Path(path)
    if p.is_file():
        if p.suffix.lower() in SUPPORTED_EXTS:
            return [str(p)]
        return []

    files = []
    for fp in sorted(p.rglob("*")):
        if not fp.is_file():
            continue
        if fp.suffix.lower() not in SUPPORTED_EXTS:
            continue
        if any(skip in fp.name for skip in SKIP_PATTERNS):
            continue
        # Skip individual voter datasets (very large, different schema)
        if "合併檔" in str(fp) or "釋出" in str(fp):
            continue
        files.append(str(fp))

    return files


def upsert_election(cur, meta: ElectionMeta) -> int:
    """Insert or find existing election, return election_id."""
    # Check if exists
    cur.execute(
        "SELECT id FROM elections WHERE election_type = %s AND ad_year = %s AND scope = %s",
        (meta.election_type, meta.ad_year, meta.scope),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    level = "central" if meta.election_type in ("president", "legislator_regional", "legislator_party", "referendum") else "local"
    cur.execute(
        """INSERT INTO elections (name, election_type, election_level, election_year, roc_year, ad_year, scope, source_file)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
           RETURNING id""",
        (meta.name, meta.election_type, level, meta.roc_year, meta.roc_year, meta.ad_year, meta.scope, meta.source_file),
    )
    return cur.fetchone()[0]


def upsert_party(cur, party_name: str) -> int | None:
    """Insert or find party, return party_id."""
    if not party_name or party_name == "無黨籍及未經政黨推薦":
        # Look up the existing "無黨籍" party
        cur.execute("SELECT id FROM parties WHERE name = %s", (party_name,))
        row = cur.fetchone()
        if row:
            return row[0]
        return None

    cur.execute("SELECT id FROM parties WHERE name = %s", (party_name,))
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        "INSERT INTO parties (name, spectrum) VALUES (%s, 'other') RETURNING id",
        (party_name,),
    )
    return cur.fetchone()[0]


def upsert_candidate(cur, election_id: int, name: str, number: int, party_name: str) -> int:
    """Insert or find candidate, return candidate_id."""
    cur.execute(
        "SELECT id FROM candidates WHERE election_id = %s AND name = %s",
        (election_id, name),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    party_id = upsert_party(cur, party_name)
    cur.execute(
        """INSERT INTO candidates (election_id, name, number, party_id, party_name)
           VALUES (%s, %s, %s, %s, %s) RETURNING id""",
        (election_id, name, number, party_id, party_name),
    )
    return cur.fetchone()[0]


def upsert_region(cur, county: str, district: str | None) -> int:
    """Insert or find region (district level), return region_id."""
    district = district or None

    cur.execute(
        """SELECT id FROM regions
           WHERE county = %s
             AND district IS NOT DISTINCT FROM %s""",
        (county, district),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        """INSERT INTO regions (county, district)
           VALUES (%s, %s) RETURNING id""",
        (county, district),
    )
    return cur.fetchone()[0]


def import_rows(cur, election_id: int, rows: list[ParsedRow], meta: ElectionMeta):
    """Import parsed rows into vote_results and election_stats."""
    if not rows:
        return

    # Cache lookups
    candidate_cache: dict[str, int] = {}
    region_cache: dict[tuple, int] = {}
    vote_count = 0
    stat_count = 0

    for row in rows:
        # Resolve candidate
        cand_key = row.candidate_name
        if cand_key not in candidate_cache:
            candidate_cache[cand_key] = upsert_candidate(
                cur, election_id, row.candidate_name, row.candidate_number, row.party
            )
        cand_id = candidate_cache[cand_key]

        # Resolve region (district level — village/polling_station already aggregated out)
        reg_key = (row.county, row.district)
        if reg_key not in region_cache:
            region_cache[reg_key] = upsert_region(cur, *reg_key)
        region_id = region_cache[reg_key]

        # Insert vote result
        cur.execute(
            """INSERT INTO vote_results (election_id, candidate_id, region_id, vote_count)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (election_id, candidate_id, region_id)
               DO UPDATE SET vote_count = EXCLUDED.vote_count""",
            (election_id, cand_id, region_id, row.vote_count),
        )
        vote_count += 1

        # Insert election stats (only on first candidate per region)
        if row.valid_votes > 0 or row.votes_cast > 0 or row.eligible_voters > 0:
            cur.execute(
                """INSERT INTO election_stats (election_id, region_id,
                       eligible_voters, ballots_issued, votes_cast,
                       valid_votes, invalid_votes, unreturned, remaining, turnout)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (election_id, region_id)
                   DO UPDATE SET
                       eligible_voters = EXCLUDED.eligible_voters,
                       ballots_issued = EXCLUDED.ballots_issued,
                       votes_cast = EXCLUDED.votes_cast,
                       valid_votes = EXCLUDED.valid_votes,
                       invalid_votes = EXCLUDED.invalid_votes,
                       unreturned = EXCLUDED.unreturned,
                       remaining = EXCLUDED.remaining,
                       turnout = EXCLUDED.turnout""",
                (election_id, region_id,
                 row.eligible_voters or None, row.ballots_issued or None,
                 row.votes_cast or None, row.valid_votes or None,
                 row.invalid_votes or None, row.unreturned or None,
                 row.remaining or None, row.turnout),
            )
            stat_count += 1

    logger.info(f"  Inserted: {vote_count} vote records, {stat_count} stat records")


def compute_vote_shares(cur, election_id: int):
    """Update vote_share for all vote_results of an election."""
    cur.execute("""
        UPDATE vote_results vr
        SET vote_share = ROUND(
            vr.vote_count::NUMERIC /
            NULLIF(es.valid_votes, 0) * 100,
        2)
        FROM election_stats es
        WHERE vr.election_id = %s
          AND es.election_id = vr.election_id
          AND es.region_id = vr.region_id
          AND es.valid_votes > 0
    """, (election_id,))
    logger.info(f"  Updated vote_share for election {election_id}")


def import_file(conn, filepath: str, args) -> bool:
    """Import a single file. Returns True if successful."""
    logger.info(f"Importing: {filepath}")

    # Build meta overrides
    meta = extract_meta_from_filename(filepath)
    if args.year:
        meta.ad_year = args.year
        meta.roc_year = args.year - 1911
    if args.scope:
        meta.scope = args.scope
    if args.type:
        meta.election_type = args.type

    try:
        meta, rows = parse_file(filepath, meta)
    except Exception as e:
        logger.error(f"  PARSE ERROR: {e}")
        return False

    if not rows:
        logger.warning(f"  SKIP: No data rows parsed from {filepath}")
        return False

    if not meta.ad_year:
        logger.warning(f"  SKIP: Cannot determine election year for {filepath}")
        return False

    if args.dry_run:
        # Print summary
        candidates = set((r.candidate_name, r.party) for r in rows)
        districts = set(r.district for r in rows if r.district)
        logger.info(f"  [DRY RUN] {meta.name}")
        logger.info(f"  Year: {meta.ad_year}, Type: {meta.election_type}, Scope: {meta.scope}")
        logger.info(f"  Candidates: {len(candidates)}, Districts: {len(districts)}, Rows: {len(rows)}")
        for name, party in sorted(candidates):
            total = sum(r.vote_count for r in rows if r.candidate_name == name)
            logger.info(f"    {name} ({party}): {total:,} votes")
        return True

    cur = conn.cursor()
    try:
        election_id = upsert_election(cur, meta)
        import_rows(cur, election_id, rows, meta)
        compute_vote_shares(cur, election_id)
        conn.commit()
        logger.info(f"  OK: election_id={election_id}")
        return True
    except Exception as e:
        conn.rollback()
        logger.error(f"  DB ERROR: {e}")
        return False
    finally:
        cur.close()


def main():
    parser = argparse.ArgumentParser(
        description="Import CEC election data into PostgreSQL",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("path", help="File or directory to import")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, don't write to DB")
    parser.add_argument("--year", type=int, help="Override election year (AD)")
    parser.add_argument("--scope", type=str, help="Override scope (e.g. 臺中市)")
    parser.add_argument("--type", type=str,
                        choices=["president", "legislator_regional", "legislator_party",
                                 "mayor", "county_head", "township_head", "council",
                                 "township_rep", "village_chief", "referendum"],
                        help="Override election type")
    parser.add_argument("--db-host", type=str, default="")
    parser.add_argument("--db-port", type=int, default=0)
    parser.add_argument("--db-name", type=str, default="")
    parser.add_argument("--db-user", type=str, default="")
    parser.add_argument("--db-pass", type=str, default="")

    args = parser.parse_args()

    files = find_files(args.path)
    if not files:
        logger.error(f"No importable files found at: {args.path}")
        sys.exit(1)

    logger.info(f"Found {len(files)} file(s) to import")

    conn = None
    if not args.dry_run:
        try:
            conn = get_db_connection(args)
            logger.info("Connected to database")
        except Exception as e:
            logger.error(f"DB connection failed: {e}")
            sys.exit(1)

    success = 0
    failed = 0
    skipped = 0

    for fp in files:
        try:
            result = import_file(conn, fp, args)
            if result:
                success += 1
            else:
                skipped += 1
        except Exception as e:
            logger.error(f"  FATAL: {e}")
            failed += 1

    logger.info(f"\n{'='*50}")
    logger.info(f"Import complete: {success} OK / {skipped} skipped / {failed} failed")
    logger.info(f"Total files: {len(files)}")

    if conn:
        conn.close()


if __name__ == "__main__":
    main()
