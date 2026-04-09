#!/usr/bin/env python3
"""Download and import census data from 行政院主計總處 into PostgreSQL.

Reads an XML manifest (e.g. mp07017a109.xml), downloads ODS files,
parses them, and inserts into census_datasets + census_data tables.

Usage:
    python import_census.py /path/to/mp07017a109.xml
    python import_census.py /path/to/mp07017a109.xml --dry-run
    python import_census.py /path/to/mp07017a109.xml --category 綜合報告
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import psycopg2
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger(__name__)

DOWNLOAD_DIR = "/tmp/census_downloads"

# ── Known county names for matching ──
COUNTIES = {
    "臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市",
    "基隆市", "新竹市", "嘉義市",
    "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義縣",
    "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣",
}

# Region groupings to skip (not individual counties)
SKIP_REGIONS = {"總計", "臺灣地區", "臺灣省", "北部地區", "中部地區", "南部地區",
                "東部地區", "金馬地區", "福建省", "臺灣省合計"}


def get_db():
    host = os.environ.get("ELECTION_DB_HOST", "localhost")
    port = os.environ.get("ELECTION_DB_PORT", "5432")
    db = os.environ.get("ELECTION_DB_NAME", "elections")
    user = os.environ.get("ELECTION_DB_USER", "civatas")
    pw = os.environ.get("ELECTION_DB_PASS", "civatas2026")
    conn = psycopg2.connect(host=host, port=port, dbname=db, user=user, password=pw)
    conn.autocommit = False
    return conn


def download_file(url: str, dest: str) -> bool:
    """Download a file if not already cached."""
    if os.path.exists(dest) and os.path.getsize(dest) > 100:
        return True
    try:
        import urllib.request
        urllib.request.urlretrieve(url, dest)
        return True
    except Exception as e:
        logger.error(f"Download failed: {url} → {e}")
        return False


def _clean_text(s) -> str:
    """Clean cell text: strip whitespace, fullwidth spaces."""
    if pd.isna(s):
        return ""
    return str(s).strip().replace("\u3000", "").strip()


def _clean_number(s) -> float | None:
    """Parse a number from cell, handling commas and special chars."""
    if pd.isna(s):
        return None
    txt = str(s).strip().replace(",", "").replace(" ", "").replace("…", "").replace("-", "").replace("－", "")
    if not txt or txt == "0":
        return 0.0
    try:
        return float(txt)
    except (ValueError, TypeError):
        return None


def _extract_county(text: str) -> str | None:
    """Extract county name from a cell value."""
    text = _clean_text(text)
    for county in COUNTIES:
        if county in text:
            return county
    return None


def parse_ods_generic(filepath: str, table_title: str) -> list[dict]:
    """Parse a census ODS file into a list of data points.

    Strategy: Read all sheets, find rows that contain county names,
    extract column headers from earlier rows, and build metric entries.
    """
    results: list[dict] = []

    try:
        # Try reading with pandas
        xls = pd.ExcelFile(filepath, engine="odf")
    except Exception as e:
        logger.warning(f"Cannot open {filepath}: {e}")
        return []

    for sheet_name in xls.sheet_names:
        try:
            df = pd.read_excel(xls, sheet_name=sheet_name, header=None)
        except Exception:
            continue

        if df.empty or df.shape[0] < 5:
            continue

        # ── Find header row(s) and data rows ──
        # Strategy: scan for rows containing county names
        county_rows: list[tuple[int, str, int]] = []  # (row_idx, county, county_col)
        for idx in range(df.shape[0]):
            for col in range(min(4, df.shape[1])):
                cell = _clean_text(df.iloc[idx, col]) if col < df.shape[1] else ""
                county = _extract_county(cell)
                if county and county not in SKIP_REGIONS:
                    # Check this row has numeric data AFTER the county column
                    has_numbers = False
                    for c2 in range(col + 1, min(df.shape[1], 30)):
                        v = _clean_number(df.iloc[idx, c2])
                        if v is not None and v > 0:
                            has_numbers = True
                            break
                    if has_numbers:
                        county_rows.append((idx, county, col))
                    break

        if not county_rows:
            continue

        # ── Find column headers ──
        # Look at the rows ABOVE the first data row for header text
        first_data_row = county_rows[0][0]
        col_headers: list[str] = []

        # Scan upward from first data row to find header labels
        for scan_row in range(max(0, first_data_row - 10), first_data_row):
            row_vals = [_clean_text(df.iloc[scan_row, c]) for c in range(min(df.shape[1], 30))]
            # A header row has multiple non-empty text cells
            non_empty = [v for v in row_vals if v and not v.replace(" ", "").isascii()]
            if len(non_empty) >= 2:
                # Use this row's Chinese text as headers
                candidate = [_clean_text(df.iloc[scan_row, c]) for c in range(df.shape[1])]
                if len(candidate) > len(col_headers):
                    col_headers = candidate

        if not col_headers:
            # Fallback: use generic column names
            col_headers = [f"col_{i}" for i in range(df.shape[1])]

        # ── Extract data ──
        for row_idx, county, county_col in county_rows:
            data_start_col = county_col + 1
            for col_idx in range(data_start_col, min(df.shape[1], len(col_headers))):
                header = col_headers[col_idx] if col_idx < len(col_headers) else f"col_{col_idx}"
                if not header or header.startswith("col_"):
                    continue
                # Skip English headers
                if header.replace(" ", "").isascii():
                    continue

                value = _clean_number(df.iloc[row_idx, col_idx])
                if value is None:
                    continue

                results.append({
                    "county": county,
                    "district": None,
                    "metric_name": header,
                    "metric_value": value,
                })

    return results


def import_one_file(conn, dataset_id: int, data_points: list[dict]) -> int:
    """Insert data points into census_data table."""
    cur = conn.cursor()
    count = 0
    for dp in data_points:
        try:
            cur.execute("""
                INSERT INTO census_data (dataset_id, county, district, metric_name, metric_value)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (dataset_id, county, district, metric_name, gender, age_group)
                DO UPDATE SET metric_value = EXCLUDED.metric_value
            """, (dataset_id, dp["county"], dp.get("district"), dp["metric_name"], dp["metric_value"]))
            count += 1
        except Exception as e:
            logger.debug(f"Insert error: {e}")
            conn.rollback()
    conn.commit()
    return count


def main():
    parser = argparse.ArgumentParser(description="Import census data from XML manifest")
    parser.add_argument("xml_path", help="Path to XML manifest file")
    parser.add_argument("--dry-run", action="store_true", help="Download and parse only, don't import")
    parser.add_argument("--category", type=str, default="綜合報告", help="Filter by category (default: 綜合報告)")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of files to process (0=all)")
    args = parser.parse_args()

    # Parse XML manifest
    tree = ET.parse(args.xml_path)
    root = tree.getroot()
    items = root.findall("人口及住宅普查")
    logger.info(f"Found {len(items)} items in manifest")

    # Filter by category
    filtered = [it for it in items if args.category in (it.findtext("備註") or "")]
    logger.info(f"Filtered to {len(filtered)} items matching '{args.category}'")

    if args.limit > 0:
        filtered = filtered[:args.limit]

    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    conn = None
    if not args.dry_run:
        conn = get_db()
        logger.info("Connected to database")

    success = 0
    failed = 0
    total_records = 0

    for i, item in enumerate(filtered):
        title = item.findtext("資料項目", "").strip()
        url = item.findtext("連結", "").strip()
        roc_year = int(item.findtext("民國年", "0"))
        ad_year = int(item.findtext("西元年", "0"))
        category = item.findtext("備註", "").strip()

        if not url:
            continue

        # Extract table number
        table_match = re.search(r"表\s*[０-９0-9]+", title.replace("１", "1").replace("２", "2").replace("３", "3").replace("４", "4").replace("５", "5").replace("６", "6").replace("７", "7").replace("８", "8").replace("９", "9").replace("０", "0"))
        table_num = table_match.group(0).replace(" ", "") if table_match else f"unknown_{i}"
        # Normalize fullwidth digits
        for fw, hw in zip("０１２３４５６７８９", "0123456789"):
            table_num = table_num.replace(fw, hw)

        fname = os.path.basename(url)
        dest = os.path.join(DOWNLOAD_DIR, fname)

        logger.info(f"[{i+1}/{len(filtered)}] {title}")

        # Download
        if not download_file(url, dest):
            failed += 1
            continue

        # Parse
        try:
            data_points = parse_ods_generic(dest, title)
        except Exception as e:
            logger.error(f"  Parse error: {e}")
            failed += 1
            continue

        if not data_points:
            logger.warning(f"  No data extracted")
            failed += 1
            continue

        counties_found = set(dp["county"] for dp in data_points)
        logger.info(f"  Parsed: {len(data_points)} records, {len(counties_found)} counties")

        if args.dry_run:
            # Show sample
            for dp in data_points[:3]:
                logger.info(f"    {dp['county']}: {dp['metric_name']} = {dp['metric_value']}")
            success += 1
            total_records += len(data_points)
            continue

        # Import to DB
        cur = conn.cursor()
        try:
            # Upsert dataset
            cur.execute("""
                INSERT INTO census_datasets (table_number, title, roc_year, ad_year, source, category, source_url, source_file)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (table_number, ad_year, category)
                DO UPDATE SET title = EXCLUDED.title, source_url = EXCLUDED.source_url
                RETURNING id
            """, (table_num, title, roc_year, ad_year, "行政院主計總處", category, url, fname))
            dataset_id = cur.fetchone()[0]
            conn.commit()

            count = import_one_file(conn, dataset_id, data_points)
            logger.info(f"  Imported: {count} records → dataset_id={dataset_id}")
            success += 1
            total_records += count
        except Exception as e:
            logger.error(f"  DB error: {e}")
            conn.rollback()
            failed += 1

    logger.info(f"\n{'='*50}")
    logger.info(f"Complete: {success} OK / {failed} failed / {total_records} total records")

    if conn:
        conn.close()


if __name__ == "__main__":
    main()
