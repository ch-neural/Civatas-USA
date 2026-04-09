#!/usr/bin/env python3
"""Import county-level census XML files into PostgreSQL.

Reads XML files from source/<county>/ directories and inserts into
census_datasets + census_data tables, matching the format expected
by the evolution service's build_project_config().

Usage:
    python import_census_xml.py /path/to/source/
    python import_census_xml.py /path/to/source/ --dry-run
    python import_census_xml.py /path/to/source/台中市/
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import psycopg2

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger(__name__)

# County name mapping: simplified → traditional (used in XML tags)
COUNTY_NAMES = {
    "台北市": "臺北市", "台中市": "臺中市", "台南市": "臺南市", "台東縣": "臺東縣",
    "臺北市": "臺北市", "臺中市": "臺中市", "臺南市": "臺南市", "臺東縣": "臺東縣",
    "新北市": "新北市", "桃園市": "桃園市", "高雄市": "高雄市",
    "基隆市": "基隆市", "新竹市": "新竹市", "嘉義市": "嘉義市",
    "新竹縣": "新竹縣", "苗栗縣": "苗栗縣", "彰化縣": "彰化縣",
    "南投縣": "南投縣", "雲林縣": "雲林縣", "嘉義縣": "嘉義縣",
    "屏東縣": "屏東縣", "宜蘭縣": "宜蘭縣", "花蓮縣": "花蓮縣",
    "澎湖縣": "澎湖縣", "金門縣": "金門縣", "連江縣": "連江縣",
}

# XML file keyword → table_number suffix and dimension type
FILE_TYPE_MAP = {
    "性比例": "性比例",
    "年齡結構": "年齡",
    "教育程度": "教育",
    "婚姻狀況": "婚姻",
    "工作狀況": "工作",
    "住戶數": "住戶",
}

# Labels that indicate section headers (not district data)
SKIP_LABELS = {
    "總計", "按性別分", "男", "女", "按鄉鎮市區別分",
    "Grand Total", "Grand total", "By sex", "Male", "Female",
    "By township, city, district", "By township city district",
}

# English-only rows to skip
ENGLISH_RE = re.compile(r'^[A-Za-z\s,.\-()]+$')


def get_db():
    host = os.environ.get("ELECTION_DB_HOST", "localhost")
    port = os.environ.get("ELECTION_DB_PORT", "5432")
    db = os.environ.get("ELECTION_DB_NAME", "elections")
    user = os.environ.get("ELECTION_DB_USER", "civatas")
    pw = os.environ.get("ELECTION_DB_PASS", "civatas2026")
    conn = psycopg2.connect(host=host, port=port, dbname=db, user=user, password=pw)
    conn.autocommit = False
    return conn


def _clean_district(text: str) -> str | None:
    """Clean district name: strip spaces, fullwidth spaces."""
    if not text:
        return None
    text = text.strip().replace("\u3000", "").strip()
    if not text:
        return None
    # Skip English-only labels
    if ENGLISH_RE.match(text):
        return None
    # Skip known section headers
    base = text.split("_")[0]  # Handle "總計_Grand_total" format
    if base in SKIP_LABELS:
        return None
    return text


def _parse_value(text: str) -> float | None:
    """Parse numeric value from XML text."""
    if not text or not text.strip():
        return None
    text = text.strip().replace(",", "").replace(" ", "")
    try:
        return float(text)
    except ValueError:
        return None


def _extract_metric_name(tag: str) -> str | None:
    """Extract Chinese metric name from XML tag.

    Tags look like: 年齡_15_24歲_人_15-24_years_person
    We want: 年齡_24歲_人  (matching election_db.py query patterns)

    Also: 常住人口數_總計_人_Number_of_resident_population_Grand_total_person
    We want: 常住人口數_總計_人
    """
    # Skip non-metric fields (district label fields)
    if "鄉鎮市區" in tag or "Township" in tag.split("_")[0]:
        return None

    # Find where English starts (uppercase letter after underscore)
    parts = tag.split("_")
    chinese_parts = []
    for p in parts:
        # Stop at first purely English/ASCII-only part
        if re.match(r'^[A-Za-z]', p) and not re.search(r'[\u4e00-\u9fff]', p):
            break
        chinese_parts.append(p)

    result = "_".join(chinese_parts)
    if not result:
        return None

    # Trim trailing numeric suffixes after _人 or _歲
    # e.g. "年齡_15_24歲_人_15-24" → "年齡_15_24歲_人"
    m = re.match(r'(.+?_(?:人|歲))(?:_[\d\-+]+)*$', result)
    if m:
        result = m.group(1)

    # Normalize age range format to match election_db.py patterns:
    # "年齡_15_24歲_人" → "年齡_24歲_人"
    # "年齡_25_34歲_人" → "年齡_34歲_人"
    # "年齡_55_64歲_人" → "年齡_64歲_人"
    # This matches the _AGE_BINS patterns in election_db.py
    result = re.sub(r'年齡_\d+_(\d+歲_人)', r'年齡_\1', result)

    return result


def _detect_county_from_xml(root_tag: str) -> str | None:
    """Detect county name from the root element tag of the XML."""
    for cn in COUNTY_NAMES.values():
        if cn in root_tag:
            return cn
    return None


def _detect_file_type(filename: str) -> str | None:
    """Detect census type from filename."""
    for keyword, suffix in FILE_TYPE_MAP.items():
        if keyword in filename:
            return suffix
    return None


def _detect_roc_year(filename: str) -> int | None:
    """Extract ROC year from filename like '109年臺中市...'"""
    m = re.search(r'(\d{2,3})年', filename)
    if m:
        return int(m.group(1))
    return None


def _find_district_tag(elem) -> str | None:
    """Find the tag in an element that contains the district name."""
    for child in elem:
        tag = child.tag
        if any(kw in tag for kw in ["鄉鎮市區", "Township", "district"]):
            return tag
    return None


def _normalize_fullwidth(text: str) -> str:
    """Convert fullwidth digits and letters to ASCII equivalents in XML tags."""
    result = []
    for ch in text:
        cp = ord(ch)
        # Fullwidth digits ０-９ (U+FF10 - U+FF19) → 0-9
        if 0xFF10 <= cp <= 0xFF19:
            result.append(chr(cp - 0xFF10 + ord('0')))
        # Fullwidth uppercase A-Z (U+FF21 - U+FF3A)
        elif 0xFF21 <= cp <= 0xFF3A:
            result.append(chr(cp - 0xFF21 + ord('A')))
        # Fullwidth lowercase a-z (U+FF41 - U+FF5A)
        elif 0xFF41 <= cp <= 0xFF5A:
            result.append(chr(cp - 0xFF41 + ord('a')))
        else:
            result.append(ch)
    return "".join(result)


def parse_census_xml(xml_path: Path) -> dict:
    """Parse a county census XML file.

    Returns:
        {
            "county": "臺中市",
            "type_suffix": "性比例",
            "roc_year": 109,
            "ad_year": 2020,
            "title": "109年臺中市常住人口之性比例（不含移工）",
            "data_points": [
                {"district": "中區", "metric_name": "常住人口數_總計_人", "metric_value": 19170, "gender": None},
                ...
            ]
        }
    """
    # Read and normalize fullwidth characters in tag names
    raw = xml_path.read_text(encoding="utf-8")
    raw = _normalize_fullwidth(raw)
    root = ET.fromstring(raw)

    filename = xml_path.stem

    # Detect file type
    type_suffix = _detect_file_type(filename)
    if not type_suffix:
        logger.warning(f"Cannot detect type for: {filename}")
        return {}

    # Detect ROC year
    roc_year = _detect_roc_year(filename)
    ad_year = roc_year + 1911 if roc_year else None

    # Get the record elements (children of DataCollection)
    records = list(root)
    if not records:
        return {}

    # Detect county from the tag of first record
    first_tag = records[0].tag
    county = _detect_county_from_xml(first_tag)
    if not county:
        logger.warning(f"Cannot detect county from tag: {first_tag}")
        return {}

    # Find the district field tag
    district_tag = _find_district_tag(records[0])
    if not district_tag:
        logger.warning(f"Cannot find district tag in: {xml_path}")
        return {}

    data_points = []
    current_gender = None

    for elem in records:
        # Get district/label value
        label_elem = elem.find(district_tag)
        if label_elem is None:
            continue

        raw_label = (label_elem.text or "").strip().replace("\u3000", " ").strip()

        # Detect gender sections
        label_lower = raw_label.split("_")[0] if raw_label else ""
        if label_lower in ("男", "Male"):
            current_gender = "男"
            continue
        elif label_lower in ("女", "Female"):
            current_gender = "女"
            continue
        elif label_lower in ("總計", "Grand Total", "Grand total"):
            current_gender = None
        elif label_lower in ("按性別分", "By sex"):
            continue
        elif label_lower in ("按鄉鎮市區別分", "By township, city, district",
                             "By township city district"):
            current_gender = None
            continue

        # Clean district name
        district = _clean_district(raw_label)
        if district is None:
            continue

        # If it's the county name itself, store as county-level aggregate
        is_county_level = district == county or district.replace("臺", "台") == county.replace("臺", "台")

        # Extract all metric values from this element
        for child in elem:
            if child.tag == district_tag:
                continue
            # Skip English-only tags
            if re.match(r'^[A-Za-z_]+$', child.tag):
                continue

            metric_name = _extract_metric_name(child.tag)
            if not metric_name:
                continue

            value = _parse_value(child.text)
            if value is None:
                continue

            data_points.append({
                "county": county,
                "district": county if is_county_level else district,
                "metric_name": metric_name,
                "metric_value": value,
                "gender": current_gender,
            })

    return {
        "county": county,
        "type_suffix": type_suffix,
        "roc_year": roc_year,
        "ad_year": ad_year,
        "title": filename,
        "data_points": data_points,
    }


def import_county_dir(conn, county_dir: Path, dry_run: bool = False) -> int:
    """Import all XML files from a county directory."""
    xml_files = sorted(county_dir.glob("*.xml"))
    if not xml_files:
        logger.info(f"No XML files in {county_dir}")
        return 0

    total = 0
    for xml_path in xml_files:
        result = parse_census_xml(xml_path)
        if not result or not result.get("data_points"):
            logger.warning(f"  Skipped: {xml_path.name} (no data)")
            continue

        county = result["county"]
        table_number = f"{county}_{result['type_suffix']}"
        ad_year = result["ad_year"]

        logger.info(f"  {xml_path.name} → {table_number} ({len(result['data_points'])} rows)")

        if dry_run:
            total += len(result["data_points"])
            continue

        cur = conn.cursor()

        # Upsert dataset
        cur.execute("""
            INSERT INTO census_datasets (table_number, title, roc_year, ad_year, source, category, source_file)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (table_number, ad_year, category)
            DO UPDATE SET title = EXCLUDED.title
            RETURNING id
        """, (table_number, result["title"], result["roc_year"], ad_year,
              "行政院主計總處", "人口及住宅普查", xml_path.name))

        dataset_id = cur.fetchone()[0]

        # Insert data points
        count = 0
        for dp in result["data_points"]:
            try:
                cur.execute("""
                    INSERT INTO census_data (dataset_id, county, district, metric_name, metric_value, gender)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (dataset_id, county, district, metric_name, gender, age_group)
                    DO UPDATE SET metric_value = EXCLUDED.metric_value
                """, (dataset_id, dp["county"], dp["district"],
                      dp["metric_name"], dp["metric_value"], dp["gender"]))
                count += 1
            except Exception as e:
                logger.debug(f"    Skip row: {e}")

        conn.commit()
        total += count
        logger.info(f"    Inserted {count} rows")

    return total


def main():
    parser = argparse.ArgumentParser(description="Import county census XML into PostgreSQL")
    parser.add_argument("source_dir", help="Path to source/ directory (or a single county dir)")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, don't write to DB")
    args = parser.parse_args()

    source = Path(args.source_dir)
    if not source.exists():
        logger.error(f"Path not found: {source}")
        sys.exit(1)

    # Determine if this is a single county dir or the parent source/ dir
    county_dirs = []
    # Check for county subdirectories first
    for d in sorted(source.iterdir()):
        if d.is_dir() and d.name in COUNTY_NAMES and any(d.glob("*.xml")):
            county_dirs.append(d)
    if not county_dirs and any(source.glob("*.xml")):
        # This is a county directory itself
        county_dirs = [source]

    if not county_dirs:
        logger.error("No county directories with XML files found")
        sys.exit(1)

    conn = None if args.dry_run else get_db()

    grand_total = 0
    for county_dir in county_dirs:
        dir_name = county_dir.name
        canonical = COUNTY_NAMES.get(dir_name, dir_name)
        logger.info(f"=== {canonical} ({county_dir.name}) ===")
        count = import_county_dir(conn, county_dir, dry_run=args.dry_run)
        grand_total += count

    if conn:
        conn.close()

    logger.info(f"\nTotal: {grand_total} data points {'parsed' if args.dry_run else 'imported'}")


if __name__ == "__main__":
    main()
