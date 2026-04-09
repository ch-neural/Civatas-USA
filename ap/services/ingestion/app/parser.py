"""Parse uploaded files into ProjectConfig.

Supports:
- Civatas template JSON  (dict with 'dimensions' key)
- Government JSON Array  (list of dicts with 地區/數值 keys)
- Government JSON Table  (list of dicts with 編號/項目 keys)
- Government CSV / TSV   (auto-detect Chinese column headers)
"""
from __future__ import annotations

import io
import json
import os
import re
from collections import defaultdict

import pandas as pd

from shared.schemas import (
    CategoryItem,
    Dimension,
    DimensionType,
    DistrictProfile,
    JointTable,
    ProjectConfig,
    RangeBin,
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse_upload(filename: str, content: bytes) -> ProjectConfig:
    """Detect file type and delegate to the appropriate parser."""
    ext = filename.rsplit(".", 1)[-1].lower()
    base = os.path.splitext(filename)[0]

    if ext == "json":
        return _parse_json(content, base)
    if ext in ("csv", "tsv", "txt"):
        return _parse_csv(content, base)
    if ext in ("xlsx", "xls", "ods"):
        return _parse_excel(content, base, ext)
    raise ValueError(f"Unsupported file format: {ext}")


# ---------------------------------------------------------------------------
# JSON parsers
# ---------------------------------------------------------------------------

def _parse_json(content: bytes, name_hint: str = "Imported") -> ProjectConfig:
    data = json.loads(content)

    # Case 1: Civatas template format
    if isinstance(data, dict) and "dimensions" in data:
        return ProjectConfig(**data)

    # Case 2: Government JSON array
    if isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict):
        return _parse_gov_json(data, name_hint)

    raise ValueError(
        "JSON 格式不被辨識：需要 Civatas 模板 (含 dimensions) "
        "或政府統計資料陣列。"
    )


def _parse_gov_json(rows: list[dict], name_hint: str) -> ProjectConfig:
    """Auto-detect government open data JSON arrays and build dimensions.

    After format-specific parsing, a universal post-processor enriches the
    result with per-district profiles whenever district data is detected.
    """
    keys = set(rows[0].keys())
    config = None

    # Pattern A: rows with 地區 + 數值 (population-style)
    # Only match if 地區 has multiple unique values (actual multi-district data)
    if "地區" in keys and "數值" in keys:
        district_vals = set(str(r.get("地區", "")) for r in rows if r.get("地區"))
        if len(district_vals) >= 2:
            config = _parse_gov_population_json(rows, name_hint)

    # Pattern B: rows with 編號 + 項目 (table-style)
    if config is None and "編號" in keys and "項目" in keys:
        config = _parse_gov_table_json(rows, name_hint)

    # Pattern C: demographics API (區別 + 性別 + age columns)
    if config is None and "區別" in keys and "性別" in keys:
        config = _parse_demographics_json(rows, name_hint)

    # Fallback: smart column classification
    if config is None:
        config = _parse_generic_json(rows, name_hint)

    # --- Universal post-processing: auto-detect & build district profiles ---
    return _enrich_district_profiles(config, rows)


# ---------------------------------------------------------------------------
# Universal district profile enrichment
# ---------------------------------------------------------------------------

# Known district column names (ordered by priority)
_DISTRICT_KEYS = ["區別", "地區"]

def _detect_district_column(rows: list[dict]) -> str | None:
    """Auto-detect which column represents district/location."""
    keys = list(rows[0].keys())

    # 1) Check known column names first
    for dk in _DISTRICT_KEYS:
        if dk in keys:
            return dk

    # 2) Heuristic: any column whose values often end with 區/鄉/鎮/市
    for k in keys:
        vals = [str(r.get(k, "")) for r in rows[:50] if r.get(k)]
        if not vals:
            continue
        district_like = sum(1 for v in vals if re.search(r"[區鄉鎮市]$", v))
        if district_like / len(vals) > 0.5:
            return k

    return None


def _extract_district_name(raw: str) -> str:
    """Normalize district name: '臺中市中區' → '中區'."""
    m = re.match(r".*?[市縣](.+)", raw)
    return m.group(1) if m else raw


def _enrich_district_profiles(
    config: ProjectConfig, rows: list[dict]
) -> ProjectConfig:
    """Universal post-processor: auto-detect district column and build
    per-district profiles with nested dimensions.

    Works regardless of JSON format by:
    1. Finding the district column (區別, 地區, or auto-detected)
    2. For each district, filtering rows and re-computing non-district dimensions
    3. Storing results in config.district_profiles
    """
    if config.district_profiles:
        return config  # already populated (e.g. by Civatas template)

    dist_col = _detect_district_column(rows)
    if not dist_col:
        return config  # no district column found

    # Collect unique district names
    raw_districts = sorted(set(
        str(r.get(dist_col, "")) for r in rows if r.get(dist_col)
    ))
    if len(raw_districts) < 2:
        return config  # only one district = no point in per-district profiles

    # Detect data format to choose re-parse strategy
    keys = set(rows[0].keys())

    # Strategy A: pivoted format (地區/項目/欄位名稱/數值)
    # For this format, sub-dimensions (gender, indigenous) are encoded in
    # the rows themselves, not necessarily in config.dimensions.
    if "地區" in keys and "數值" in keys:
        profiles = _build_profiles_pivoted(rows, raw_districts, dist_col, config)
        if profiles:
            config = config.model_copy(update={"district_profiles": profiles})
        return config

    # For other formats, check if there are non-district dimensions to nest
    non_district_dims = {
        k for k in config.dimensions if k != "district"
    }
    if not non_district_dims:
        return config  # only district dimension, nothing to nest

    # Strategy B: wide format (區別/性別 + numeric columns)
    if "區別" in keys and "性別" in keys:
        profiles = _build_profiles_wide(rows, raw_districts, dist_col, config)
    else:
        # Strategy C: generic — re-parse per district
        profiles = _build_profiles_generic(rows, raw_districts, dist_col, config)

    if profiles:
        config = config.model_copy(update={"district_profiles": profiles})

    return config


def _build_profiles_pivoted(
    rows: list[dict], districts: list[str], dist_col: str,
    config: ProjectConfig,
) -> dict[str, DistrictProfile]:
    """Build per-district profiles from pivoted format (地區/項目/欄位名稱/數值)."""
    profiles: dict[str, DistrictProfile] = {}

    for raw_dist in districts:
        dist_name = _extract_district_name(raw_dist)
        d_rows = [r for r in rows if str(r.get(dist_col, "")) == raw_dist]
        if not d_rows:
            continue

        dims: dict[str, Dimension] = {}
        pop = 0

        # Gender
        gender_totals: dict[str, float] = defaultdict(float)
        for r in d_rows:
            field = r.get("欄位名稱", "")
            val = _parse_number(str(r.get("數值", 0))) or 0
            if field in ("男", "女"):
                gender_totals[field] += val
                pop += int(val)
        if gender_totals:
            dims["gender"] = _build_categorical(gender_totals)

        # Indigenous (or any sub-category from 項目)
        sub_categories: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        for r in d_rows:
            field = r.get("欄位名稱", "")
            item = r.get("項目", "")
            val = _parse_number(str(r.get("數值", 0))) or 0
            parts = field.split("_")
            if len(parts) == 2 and val > 0:
                sub_cat = parts[1]  # "男_平地原住民" → "平地原住民"
                # Group by sub-category type from 項目
                if "原住民" in item:
                    sub_categories["indigenous"][sub_cat] += val

        for dim_name, totals in sub_categories.items():
            if totals:
                dims[dim_name] = _build_categorical(dict(totals))

        if dims:
            profiles[dist_name] = DistrictProfile(
                name=dist_name, population=pop, dimensions=dims,
            )

    return profiles


def _build_profiles_wide(
    rows: list[dict], districts: list[str], dist_col: str,
    config: ProjectConfig,
) -> dict[str, DistrictProfile]:
    """Build per-district profiles from wide format (區別/性別 + columns)."""
    sample = rows[0]
    skip_keys = {"區別", "里別", "性別", "年齡", "行政區代碼"}
    num_cols = [
        k for k, v in sample.items()
        if k not in skip_keys and _parse_number(str(v)) is not None
    ]
    age_cols = [k for k in num_cols if "歲" in k and "數量" in k]
    edu_cols = [k for k in num_cols if "數量" in k and "歲" not in k]
    value_cols = age_cols if age_cols else (edu_cols if edu_cols else num_cols)
    has_age_col = "年齡" in sample
    has_age_in_names = bool(age_cols)
    has_edu = bool(edu_cols)

    total_rows = [r for r in rows if r.get("性別") == "計"]
    gendered_rows = [r for r in rows if r.get("性別") in ("男", "女")]
    if not total_rows:
        total_rows = rows

    profiles: dict[str, DistrictProfile] = {}
    for dist in districts:
        d_total = [r for r in total_rows if r.get(dist_col) == dist]
        d_gendered = [r for r in gendered_rows if r.get(dist_col) == dist]
        if not d_total:
            continue

        d_dims = _compute_dimensions(
            d_total, d_gendered, value_cols, age_cols, edu_cols,
            has_age_col, has_age_in_names, has_edu,
        )
        d_dims.pop("district", None)

        pop = 0
        for r in d_total:
            for col in value_cols:
                v = _parse_number(str(r.get(col, 0)))
                if v:
                    pop += int(v)

        if d_dims:
            profiles[dist] = DistrictProfile(
                name=dist, population=pop, dimensions=d_dims,
            )

    return profiles


def _build_profiles_generic(
    rows: list[dict], districts: list[str], dist_col: str,
    config: ProjectConfig,
) -> dict[str, DistrictProfile]:
    """Build per-district profiles using generic re-parsing."""
    profiles: dict[str, DistrictProfile] = {}

    for raw_dist in districts:
        dist_name = _extract_district_name(raw_dist) if dist_col == "地區" else raw_dist
        d_rows = [r for r in rows if str(r.get(dist_col, "")) == raw_dist]
        if not d_rows:
            continue

        dims: dict[str, Dimension] = {}
        for key in d_rows[0]:
            if key == dist_col:
                continue
            vals = [str(r.get(key, "")) for r in d_rows if r.get(key)]
            unique = set(vals)
            if 2 <= len(unique) <= 50:
                counts: dict[str, float] = defaultdict(float)
                for v in vals:
                    counts[v] += 1
                dims[key] = _build_categorical(dict(counts))

        if dims:
            profiles[dist_name] = DistrictProfile(
                name=dist_name, population=len(d_rows), dimensions=dims,
            )

    return profiles


def _parse_gov_population_json(rows: list[dict], name_hint: str) -> ProjectConfig:
    """Parse government population data with 地區/項目/欄位名稱/數值.

    Cross-tabulated data (e.g. district × gender × indigenous) is parsed
    hierarchically: only 'district' is kept at the top level; gender and
    indigenous breakdowns are built per-district by the post-processor
    ``_build_profiles_pivoted``.
    """

    # Separate population counts from sub-data (like 原住民)
    # Focus on the main population entries
    pop_field = "各區現住人口數-區域人口數"
    main_rows = [r for r in rows if pop_field in r.get("項目", "")]
    if not main_rows:
        main_rows = rows  # fallback to all rows

    # Build district dimension (top-level only)
    district_totals: dict[str, float] = defaultdict(float)

    for row in main_rows:
        district = _clean_district(row.get("地區", ""))
        value = _parse_number(row.get("數值", "0"))

        if district:
            district_totals[district] += value

    dimensions: dict[str, Dimension] = {}

    # District dimension — the only top-level dimension for cross-tabulated data
    if district_totals:
        dimensions["district"] = _build_categorical(district_totals)

    # NOTE: gender and indigenous are NOT added at top level.
    # They are per-district breakdowns and will be built by
    # _build_profiles_pivoted in the _enrich_district_profiles step.

    # Extract region from first row
    region = ""
    if rows:
        r = rows[0].get("地區", "")
        # "臺中市中區" → "臺中市"
        m = re.match(r"(.*?[市縣])", r)
        if m:
            region = m.group(1)

    return ProjectConfig(
        name=_clean_name(name_hint) or "政府統計資料",
        region=region,
        locale="zh-TW",
        dimensions=dimensions,
    )


def _parse_gov_table_json(rows: list[dict], name_hint: str) -> ProjectConfig:
    """Parse government JSON table with 編號/項目/numeric columns."""
    # Skip summary rows (like 總計)
    data_rows = [
        r for r in rows
        if "總計" not in str(r.get("項目", ""))
    ]

    if not data_rows:
        data_rows = rows

    # Find numeric columns
    sample = data_rows[0]
    numeric_cols = []
    for key, val in sample.items():
        if key in ("編號", "項目"):
            continue
        if _parse_number(str(val)) is not None:
            numeric_cols.append(key)

    dimensions: dict[str, Dimension] = {}

    # Build a categorical dimension from 項目 if we have a numeric column
    if "項目" in sample and numeric_cols:
        # Use the first population-like column
        pop_col = None
        for col in numeric_cols:
            if "人口" in col and "現況" in col:
                pop_col = col
                break
        if not pop_col:
            pop_col = numeric_cols[0]

        area_totals: dict[str, float] = {}
        for row in data_rows:
            area = str(row.get("項目", "")).strip()
            val = _parse_number(str(row.get(pop_col, "0")))
            if val and val > 0:
                area_totals[area] = val

        if area_totals:
            dimensions["area"] = _build_categorical(area_totals)

    return ProjectConfig(
        name=_clean_name(name_hint) or "政府統計資料",
        region="臺中市",
        locale="zh-TW",
        dimensions=dimensions,
    )


def _parse_demographics_json(rows: list[dict], name_hint: str) -> ProjectConfig:
    """Parse government data with 區別 + 性別 columns.

    Computes city-wide dimensions. Per-district profiles are added by the
    universal _enrich_district_profiles post-processor.
    """
    sample = rows[0]
    skip_keys = {"區別", "里別", "性別", "年齡", "行政區代碼"}
    num_cols = [
        k for k, v in sample.items()
        if k not in skip_keys and _parse_number(str(v)) is not None
    ]

    age_cols = [k for k in num_cols if "歲" in k and "數量" in k]
    edu_cols = [k for k in num_cols if "數量" in k and "歲" not in k]
    value_cols = age_cols if age_cols else (edu_cols if edu_cols else num_cols)

    has_age_col = "年齡" in sample
    has_age_in_names = bool(age_cols)
    has_edu = bool(edu_cols)

    total_rows = [r for r in rows if r.get("性別") == "計"]
    gendered_rows = [r for r in rows if r.get("性別") in ("男", "女")]
    if not total_rows:
        total_rows = rows

    dimensions = _compute_dimensions(
        total_rows, gendered_rows, value_cols, age_cols, edu_cols,
        has_age_col, has_age_in_names, has_edu,
    )

    # --- Build joint table from wide-format data ---
    joint_tables: list[JointTable] = []
    # Use gendered rows to avoid double-counting (skip 性別 == "計")
    use_rows = gendered_rows if gendered_rows else total_rows

    if has_edu and (has_age_col or has_age_in_names):
        # Pivot education columns into a long-format joint table
        jt_rows = []
        jt_weights = []
        for r in use_rows:
            district = str(r.get("區別", "")).strip()
            gender_raw = str(r.get("性別", "")).strip()
            gender = "男性" if gender_raw == "男" else "女性" if gender_raw == "女" else gender_raw
            age = str(r.get("年齡", "")).strip() if has_age_col else ""

            if not district or not gender:
                continue

            for col in edu_cols:
                val = _parse_number(str(r.get(col, 0)))
                if val and val > 0:
                    # Strip 畢業/肄業/數量 from column name → education label
                    edu_label = re.sub(r"(畢業|肄業|合計)?數量$", "", col)
                    row_dict = {
                        "district": district,
                        "gender": gender,
                        "education": edu_label,
                    }
                    if age:
                        row_dict["age"] = age
                    jt_rows.append(row_dict)
                    jt_weights.append(val)

        if len(jt_rows) >= 10:
            dim_names = ["district", "gender", "education"]
            if has_age_col:
                dim_names.append("age")
            joint_tables.append(JointTable(
                source=name_hint,
                dim_names=dim_names,
                rows=jt_rows,
                weights=jt_weights,
            ))
    elif has_age_in_names:
        # Age columns in names (like 人口結構), pivot age→long
        jt_rows = []
        jt_weights = []
        for r in use_rows:
            district = str(r.get("區別", "")).strip()
            gender_raw = str(r.get("性別", "")).strip()
            gender = "男性" if gender_raw == "男" else "女性" if gender_raw == "女" else gender_raw

            if not district or not gender:
                continue

            for col in age_cols:
                val = _parse_number(str(r.get(col, 0)))
                if val and val > 0:
                    # Extract age range from column name: "0-4歲合計數量" → "0-4歲"
                    age_label = re.sub(r"(合計)?數量$", "", col)
                    jt_rows.append({
                        "district": district,
                        "gender": gender,
                        "age": age_label,
                    })
                    jt_weights.append(val)

        if len(jt_rows) >= 10:
            joint_tables.append(JointTable(
                source=name_hint,
                dim_names=["district", "gender", "age"],
                rows=jt_rows,
                weights=jt_weights,
            ))

    return ProjectConfig(
        name=_clean_name(name_hint) or "政府統計資料",
        region="臺中市",
        locale="zh-TW",
        dimensions=dimensions,
        joint_tables=joint_tables,
    )


def _compute_dimensions(
    total_rows: list[dict],
    gendered_rows: list[dict],
    value_cols: list[str],
    age_cols: list[str],
    edu_cols: list[str],
    has_age_col: bool,
    has_age_in_names: bool,
    has_edu: bool,
) -> dict[str, Dimension]:
    """Compute gender/age/education/district dimensions from a set of rows."""
    dimensions: dict[str, Dimension] = {}

    # District
    district_totals: dict[str, float] = defaultdict(float)
    for r in total_rows:
        district = r.get("區別", "")
        if district:
            for col in value_cols:
                val = _parse_number(str(r.get(col, 0)))
                if val:
                    district_totals[district] += val
    if district_totals:
        dimensions["district"] = _build_categorical(dict(district_totals))

    # Gender
    gender_totals: dict[str, float] = defaultdict(float)
    for r in gendered_rows:
        gender = r.get("性別", "")
        if gender:
            for col in value_cols:
                val = _parse_number(str(r.get(col, 0)))
                if val:
                    gender_totals[gender] += val
    gender_mapped = {}
    for k, v in gender_totals.items():
        label = "男性" if k == "男" else "女性" if k == "女" else k
        gender_mapped[label] = v
    if gender_mapped:
        dimensions["gender"] = _build_categorical(gender_mapped)

    # Age (from column or from column names)
    if has_age_col:
        age_totals: dict[str, float] = defaultdict(float)
        for r in total_rows:
            age_label = r.get("年齡", "")
            if age_label:
                for col in value_cols:
                    val = _parse_number(str(r.get(col, 0)))
                    if val:
                        age_totals[age_label] += val
        if age_totals:
            total = sum(age_totals.values()) or 1
            bins = [
                RangeBin(range=label, weight=round(v / total, 6))
                for label, v in sorted(
                    age_totals.items(), key=lambda x: _extract_age_start(x[0])
                )
            ]
            dimensions["age"] = Dimension(type=DimensionType.RANGE, bins=bins)
    elif has_age_in_names:
        age_bin_map = _group_age_columns(age_cols)
        age_totals_col: dict[str, float] = defaultdict(float)
        for r in total_rows:
            for bin_label, cols in age_bin_map.items():
                for col in cols:
                    val = r.get(col, 0)
                    if isinstance(val, (int, float)):
                        age_totals_col[bin_label] += val
        if age_totals_col:
            total = sum(age_totals_col.values()) or 1
            bins = [
                RangeBin(range=label, weight=round(v / total, 6))
                for label, v in sorted(
                    age_totals_col.items(), key=lambda x: _extract_age_start(x[0])
                )
            ]
            dimensions["age"] = Dimension(type=DimensionType.RANGE, bins=bins)

    # Education
    if has_edu:
        edu_totals: dict[str, float] = defaultdict(float)
        for r in total_rows:
            for col in edu_cols:
                val = _parse_number(str(r.get(col, 0)))
                if val:
                    label = col.replace("數量", "").strip()
                    edu_totals[label] += val
        edu_merged: dict[str, float] = defaultdict(float)
        for label, val in edu_totals.items():
            base = label.replace("畢業", "").replace("肄業", "").strip()
            edu_merged[base] += val
        if edu_merged:
            dimensions["education"] = _build_categorical(dict(edu_merged))

    return dimensions


def _extract_age_start(col_name: str) -> int:
    """Extract starting age number from column name like '0-4歲合計數量' or '100歲以上'."""
    m = re.match(r"(\d+)", col_name)
    return int(m.group(1)) if m else 999


def _group_age_columns(age_cols: list[str]) -> dict[str, list[str]]:
    """Group fine-grained age columns into broader bins for readability."""
    bins: dict[str, list[str]] = {}
    for col in age_cols:
        start = _extract_age_start(col)
        if start < 20:
            label = "0-19歲"
        elif start < 30:
            label = "20-29歲"
        elif start < 40:
            label = "30-39歲"
        elif start < 50:
            label = "40-49歲"
        elif start < 60:
            label = "50-59歲"
        elif start < 70:
            label = "60-69歲"
        else:
            label = "70歲以上"
        bins.setdefault(label, []).append(col)
    return bins


def _filter_hierarchical_items(items: dict[str, float]) -> dict[str, float]:
    """Filter out parent/child duplicates in hierarchical accounting data.

    Detects patterns like:
      一、所得收入總計     ← parent total (filtered)
        1.受僱人員報酬     ← mid-level (KEPT)
          (1)本業薪資     ← sub-item (filtered)
      所得總額           ← summary duplicate (filtered)
    """
    # Detect hierarchical numbering patterns
    cn_parent = re.compile(r"^[一二三四五六七八九十]+、")   # 一、二、三...
    num_mid = re.compile(r"^\d{1,2}\.")                    # 1. 2. 10.
    paren_sub = re.compile(r"^\(\d+\)")                     # (1) (2) (3)

    parents = {k for k in items if cn_parent.match(k)}
    mids = {k for k in items if num_mid.match(k)}
    subs = {k for k in items if paren_sub.match(k)}

    # Only filter if we detect a clear hierarchy (≥3 items match patterns)
    if len(parents) + len(mids) + len(subs) < 3:
        return items

    # Build set of values from parent totals to detect standalone duplicates
    parent_values = {round(items[k], 2) for k in parents}

    # When mid-level items exist, standalone items larger than the largest
    # mid-level item are likely summary/derived values (所得總額, 可支配所得, etc.)
    max_mid_val = max((items[k] for k in mids), default=0) if mids else 0

    filtered: dict[str, float] = {}
    for label, val in items.items():
        # Skip parent totals (一、二、三...)
        if label in parents:
            continue
        # Skip sub-items ((1), (2)...)
        if label in subs:
            continue
        # For standalone (non-numbered) items:
        if label not in mids:
            # Skip if value matches a parent total's value (exact duplicate)
            if round(val, 2) in parent_values:
                continue
            # Skip if value > max mid-level value (likely a grand total/summary)
            if mids and val > max_mid_val:
                continue
        filtered[label] = val

    return filtered if filtered else items


def _infer_composite_dim_names(
    name_hint: str,
    left_labels: set[str],
    right_labels: set[str],
    col_name: str,
) -> tuple[str, str]:
    """Infer descriptive dimension names for composite A_B columns.

    Strategy:
    1. Check name_hint for 按XX[別]分 pattern → use for left dimension
    2. Check value content for known patterns (occupation, financial, geographic)
    3. Fall back to col_name_1 / col_name_2
    """
    left_name = col_name + "_1"
    right_name = col_name + "_2"

    # Strategy 1: Extract from dataset name (e.g., "按職業別分" → "職業別")
    m = re.search(r"按([^按]+?[別類]?)分", name_hint)
    if m:
        extracted = m.group(1)
        # Check which side this name refers to (usually the left/grouping side)
        left_name = extracted

    # Strategy 2: Infer from value content patterns
    def _classify_values(labels: set[str]) -> str | None:
        """Try to classify a set of labels into a known category."""
        joined = "".join(labels)
        # Occupation patterns: values ending in 人員, 人, 工
        occ_count = sum(1 for v in labels if re.search(r"(人員|工人|工)$", v))
        if occ_count / len(labels) > 0.3:
            return "職業別"
        # Financial patterns
        fin_kw = sum(1 for v in labels if re.search(r"(收入|支出|所得|報酬|薪資|消費|儲蓄)", v))
        if fin_kw / len(labels) > 0.3:
            return "收支項目"
        # Geographic patterns
        geo_count = sum(1 for v in labels if re.search(r"(區|鄉|鎮|市|里)$", v))
        if geo_count / len(labels) > 0.3:
            return "地區"
        # Age patterns
        age_count = sum(1 for v in labels if re.search(r"歲", v))
        if age_count / len(labels) > 0.3:
            return "年齡"
        # Gender
        if labels <= {"男", "女", "男性", "女性"}:
            return "性別"
        return None

    left_inferred = _classify_values(left_labels)
    right_inferred = _classify_values(right_labels)

    # Apply inferred names (prefer strategy 1 for left if available)
    if left_inferred and left_name == col_name + "_1":
        left_name = left_inferred
    if right_inferred:
        right_name = right_inferred

    # Avoid duplicate names
    if left_name == right_name:
        right_name = right_name + "_明細"

    return left_name, right_name


def _strip_common_prefix(items: dict[str, float]) -> dict[str, float]:
    """Strip common prefix from all category labels.

    E.g., all labels start with 'XXX按職業別分-' → strip to just the suffix.
    Also removes trailing unit markers like '(單位:元)'.
    """
    if len(items) < 2:
        return items

    labels = list(items.keys())
    # Find longest common prefix
    prefix = os.path.commonprefix(labels)

    # Only strip if prefix is substantial (>4 chars) and ends at a separator
    if len(prefix) > 4:
        # Extend to include the separator (-, _, 、, :, etc.)
        sep_chars = "-_、：:—"
        while prefix and prefix[-1] not in sep_chars:
            prefix = prefix[:-1]

    if len(prefix) <= 4:
        return items

    # Strip prefix and clean up trailing unit markers
    unit_pattern = re.compile(r"\(單位[:：][^)]+\)$")
    cleaned: dict[str, float] = {}
    for label, val in items.items():
        new_label = label[len(prefix):]
        new_label = unit_pattern.sub("", new_label).strip()
        if new_label:
            cleaned[new_label] = val
        else:
            cleaned[label] = val  # fallback: keep original if stripping empties it

    return cleaned


def _parse_generic_json(rows: list[dict], name_hint: str) -> ProjectConfig:
    """Smart fallback: classify columns and build meaningful dimensions.

    Column classification:
    1. Meta/ID columns → filtered (編號, 代碼, 機關, constant-value columns)
    2. Sparse placeholder columns → filtered (>50% values are "-", "_", "…")
    3. Year/period columns → detected by name or value pattern, filter to latest
    4. Numeric columns → used as weights for categorical dimensions
    5. Time-series columns → detected by year pattern in name, latest year used
    6. Categorical columns → become dimensions, weighted by best numeric column
    """
    if not rows:
        return ProjectConfig(
            name=_clean_name(name_hint) or "Imported",
            locale="zh-TW",
            dimensions={},
        )

    sample = rows[0]
    all_keys = list(sample.keys())

    # --- Step 0: Detect and filter by year/period column ---
    # Look for columns whose NAME suggests a year/period (e.g., 統計期_年, 年度, 年份)
    year_col_name_pattern = re.compile(r"(統計期|年度|年份|期別|期間|[_]年$)")
    year_col: str | None = None
    for key in all_keys:
        if year_col_name_pattern.search(key):
            # Verify it contains numeric year-like values
            vals = [str(r.get(key, "")).strip() for r in rows if r.get(key)]
            numeric_vals = [v for v in vals if v.isdigit()]
            if len(numeric_vals) > len(vals) * 0.5:
                year_col = key
                break

    # If year column found, filter rows to latest year
    if year_col:
        year_vals = []
        for r in rows:
            v = str(r.get(year_col, "")).strip()
            if v.isdigit():
                year_vals.append(int(v))
        if year_vals:
            max_year = max(year_vals)
            rows = [r for r in rows if str(r.get(year_col, "")).strip() == str(max_year)]

    # --- Step 1: Classify columns ---
    meta_patterns = re.compile(r"(代碼|機關|資料[年月日]|備註|成長率|比率|比例|百分比)")
    id_patterns = re.compile(r"^(編號|序號|No|ID)$", re.IGNORECASE)
    year_value_pattern = re.compile(r"(\d{2,4})\s*年")
    placeholder_chars = {"-", "_", "…", "－", "―", "—", ""}

    meta_cols: set[str] = set()
    id_cols: set[str] = set()
    numeric_cols: list[str] = []
    timeseries_cols: list[tuple[str, int]] = []  # (col_name, year)
    categorical_cols: list[str] = []

    for key in all_keys:
        # Skip the year column itself
        if key == year_col:
            meta_cols.add(key)
            continue

        all_vals = [str(r.get(key, "")).strip() for r in rows]
        non_empty = [v for v in all_vals if v]
        unique = set(non_empty)

        # Skip empty or single-value columns (constants)
        if len(unique) <= 1:
            meta_cols.add(key)
            continue

        # Check for ID patterns
        if id_patterns.search(key):
            id_cols.add(key)
            continue

        # Check for metadata patterns
        if meta_patterns.search(key):
            meta_cols.add(key)
            continue

        # --- Sparse placeholder filter ---
        # If >50% of values are placeholders ("-", "_", etc.), skip
        placeholder_count = sum(1 for v in all_vals if v.strip() in placeholder_chars)
        if placeholder_count / len(all_vals) > 0.5:
            meta_cols.add(key)
            continue

        # Check if numeric (>40% of non-placeholder values parse as numbers)
        real_vals = [v for v in non_empty if v.strip() not in placeholder_chars]
        num_count = sum(1 for v in real_vals if _parse_number(v) is not None)
        is_numeric = num_count / len(real_vals) > 0.4 if real_vals else False

        # Check for time-series year pattern in column name
        year_match = year_value_pattern.search(key)

        if is_numeric and year_match:
            year = int(year_match.group(1))
            if year < 200:
                year += 1911
            timeseries_cols.append((key, year))
        elif is_numeric:
            numeric_cols.append(key)
        elif 2 <= len(unique) <= 100:
            categorical_cols.append(key)

    # --- Step 1b: Detect composite columns (A_B pattern) ---
    # Columns with >100 unique values might be composite (e.g., 職業_收支項目)
    composite_cols: list[tuple[str, str]] = []  # (col_name, separator)
    for key in all_keys:
        if key in meta_cols or key in id_cols or key == year_col:
            continue
        if key in [c for c in categorical_cols] or key in numeric_cols:
            continue
        if key in [c[0] for c in timeseries_cols]:
            continue

        all_vals = [str(r.get(key, "")).strip() for r in rows]
        non_empty = [v for v in all_vals if v]
        unique = set(non_empty)

        if len(unique) <= 100:
            continue

        # Check if values follow A_B pattern with underscore separator
        underscore_count = sum(1 for v in non_empty if "_" in v)
        if underscore_count / len(non_empty) > 0.7:
            # Verify both sides have reasonable cardinality
            left_parts = set()
            right_parts = set()
            for v in non_empty:
                if "_" in v:
                    left, right = v.split("_", 1)
                    left_parts.add(left)
                    right_parts.add(right)
            if 2 <= len(left_parts) <= 100 and 2 <= len(right_parts) <= 100:
                composite_cols.append((key, "_"))

    # --- Step 2: Determine weight column ---
    weight_col: str | None = None

    if timeseries_cols:
        timeseries_cols.sort(key=lambda x: x[1], reverse=True)
        weight_col = timeseries_cols[0][0]
    elif numeric_cols:
        # Prefer columns with meaningful value names
        for col in numeric_cols:
            if any(kw in col for kw in ("人口", "人數", "數", "合計", "金額", "元", "所得")):
                weight_col = col
                break
        if not weight_col:
            weight_col = numeric_cols[0]

    # --- Step 3: Build dimensions from categorical columns ---
    dimensions: dict[str, Dimension] = {}
    skip_vals = {"合計", "總計", "兩性", "-", "_", ""}

    for col in categorical_cols:
        vals = [str(r.get(col, "")).strip() for r in rows if r.get(col)]
        unique = set(vals) - skip_vals

        if not (2 <= len(unique) <= 100):
            continue

        if weight_col:
            totals: dict[str, float] = defaultdict(float)
            for r in rows:
                label = str(r.get(col, "")).strip()
                if not label or label in skip_vals:
                    continue
                val = _parse_number(str(r.get(weight_col, "0")))
                if val is not None and val > 0:
                    totals[label] += val
            if totals:
                # Clean up labels and filter hierarchical duplicates
                totals = _strip_common_prefix(totals)
                totals = _filter_hierarchical_items(totals)
                dim_key = _col_to_dim_key(col)
                dimensions[dim_key] = _build_categorical(dict(totals))
        else:
            counts: dict[str, float] = defaultdict(float)
            for v in vals:
                if v not in skip_vals:
                    counts[v] += 1
            if counts:
                counts = _strip_common_prefix(counts)
                counts = _filter_hierarchical_items(counts)
                dim_key = _col_to_dim_key(col)
                dimensions[dim_key] = _build_categorical(dict(counts))

    # --- Step 3b: Build dimensions from composite columns ---
    for comp_col, sep in composite_cols:
        if not weight_col:
            continue

        left_totals: dict[str, float] = defaultdict(float)
        right_totals: dict[str, float] = defaultdict(float)

        for r in rows:
            field = str(r.get(comp_col, "")).strip()
            if not field or sep not in field:
                continue
            left, right = field.split(sep, 1)
            left = left.strip()
            right = right.strip()
            if not left or not right or left in skip_vals or right in skip_vals:
                continue

            val = _parse_number(str(r.get(weight_col, "0")))
            if val is not None and val > 0:
                left_totals[left] += val
                right_totals[right] += val

        # Infer descriptive names for the two sub-dimensions
        left_name, right_name = _infer_composite_dim_names(
            name_hint, set(left_totals.keys()), set(right_totals.keys()), comp_col
        )

        # Add both sub-dimensions if they have meaningful categories
        if 2 <= len(left_totals) <= 100:
            cleaned = _strip_common_prefix(dict(left_totals))
            cleaned = _filter_hierarchical_items(cleaned)
            dimensions[left_name] = _build_categorical(cleaned)

        if 2 <= len(right_totals) <= 100:
            cleaned = _strip_common_prefix(dict(right_totals))
            cleaned = _filter_hierarchical_items(cleaned)
            dimensions[right_name] = _build_categorical(cleaned)

    # --- Step 4: Build joint table for correlated sampling ---
    joint_tables: list[JointTable] = []
    if len(categorical_cols) >= 2 and weight_col:
        jt = _build_joint_table(
            rows, categorical_cols, weight_col, dimensions, name_hint
        )
        if jt:
            joint_tables.append(jt)

    return ProjectConfig(
        name=_clean_name(name_hint) or "Imported",
        locale="zh-TW",
        dimensions=dimensions,
        joint_tables=joint_tables,
    )


# ---------------------------------------------------------------------------
# Joint table builder
# ---------------------------------------------------------------------------

def _build_joint_table(
    rows: list[dict],
    categorical_cols: list[str],
    weight_col: str,
    dimensions: dict[str, "Dimension"],
    name_hint: str,
) -> JointTable | None:
    """Build a JointTable preserving cross-tabulation from raw data.

    Only creates a joint table when there are ≥2 categorical dimensions
    with meaningful data. Uses the same dim_key mapping as the dimension
    builder so the builder can match joint table dim names to Person fields.
    """
    skip_vals = {"合計", "總計", "兩性", "計", "-", "_", ""}

    # Map column names → dimension keys (must match what's in `dimensions`)
    col_to_key: dict[str, str] = {}
    for col in categorical_cols:
        key = _col_to_dim_key(col)
        if key in dimensions:
            col_to_key[col] = key
        # Also check if the column name itself (cleaned) is a key
        elif col in dimensions:
            col_to_key[col] = col

    if len(col_to_key) < 2:
        return None

    dim_names = list(col_to_key.values())

    # Aggregate rows: (val_tuple) → total weight
    aggregated: dict[tuple[str, ...], float] = defaultdict(float)

    for r in rows:
        vals = []
        skip = False
        for col, key in col_to_key.items():
            v = str(r.get(col, "")).strip()
            if not v or v in skip_vals:
                skip = True
                break
            vals.append(v)
        if skip:
            continue

        w = _parse_number(str(r.get(weight_col, "0")))
        if w is not None and w > 0:
            aggregated[tuple(vals)] += w

    if len(aggregated) < 10:
        return None

    # Build rows and weights
    jt_rows = []
    jt_weights = []
    for val_tuple, weight in aggregated.items():
        jt_rows.append(dict(zip(dim_names, val_tuple)))
        jt_weights.append(weight)

    return JointTable(
        source=name_hint,
        dim_names=dim_names,
        rows=jt_rows,
        weights=jt_weights,
    )


# ---------------------------------------------------------------------------
# CSV parser
# ---------------------------------------------------------------------------

def _parse_csv(content: bytes, name_hint: str = "Imported") -> ProjectConfig:
    """Auto-detect CSV format and build dimensions."""
    # Try multiple encodings: UTF-8 (with BOM) → Big5 → latin-1
    for encoding in ("utf-8-sig", "utf-8", "cp950", "big5", "latin-1"):
        try:
            df = pd.read_csv(io.BytesIO(content), encoding=encoding, sep=None, engine="python")
            break
        except (UnicodeDecodeError, UnicodeError, pd.errors.ParserError):
            continue
    else:
        raise ValueError("無法辨識 CSV 編碼格式（已嘗試 UTF-8、Big5、Latin-1）")

    # Legacy: check for specific columns
    if {"dimension", "value", "weight"}.issubset(set(df.columns)):
        return _df_to_config_legacy(df)

    return _parse_gov_csv(df, name_hint)


def _parse_gov_csv(df: pd.DataFrame, name_hint: str) -> ProjectConfig:
    """Parse government CSV with Chinese headers."""
    dimensions: dict[str, Dimension] = {}

    # Auto-detect year column and use latest year
    # Strict matching: only columns that are specifically year identifiers
    # Avoid matching columns that just contain 年 (e.g. 折合年人口增加率, 0_6歲人口數)
    _year_col_pattern = re.compile(r"^(年度|年份|年別|調查年|資料年|期別|統計期|year)$|^年$", re.IGNORECASE)
    year_col = None
    for col in df.columns:
        if _year_col_pattern.search(col):
            year_col = col
            break

    if year_col is not None:
        try:
            df[year_col] = pd.to_numeric(df[year_col], errors="coerce")
            max_year = df[year_col].max()
            df = df[df[year_col] == max_year]
        except Exception:
            pass

    # --- Column filters ---
    # Columns to skip entirely (IDs, codes, weights, derived variables)
    _skip_col_patterns = re.compile(
        r"(^(id|new|newid|ID|No|編號|序號)$"               # ID columns
        r"|^(cityid|townid|villid|pollid|egroup|cegroup)"  # code columns
        r"|^(wec|wen|wfc|wfn|filter)"                      # weight columns
        r"|^(sexage|age\d|age_|male_|sex_)"                 # derived age/sex grouping
        r"|^(yyyymmdd|YEAR|MONTH|DATE|yy_|mm_|dd_)$"       # date components
        r"|^(NEIGHB|neighb|area\d|ALL\d|NOTE|note)$"        # survey indicators
        r"|^[A-Z]?VOTE$|^v\d"                               # vote indicator columns
        r"|代碼|機關|成長率|比率|百分比|備註)",
        re.IGNORECASE
    )

    # Identify categorical columns (< 50 unique values) vs numeric columns
    cat_cols = []
    num_cols = []
    for col in df.columns:
        if col == year_col:
            continue
        # Skip known non-dimension columns
        if _skip_col_patterns.search(col):
            continue
        # Try to detect numeric column
        # Check if majority of values are numeric
        try:
            # Clean commas to support formatting like "1,434"
            cleaned_col = df[col].astype(str).str.replace(',', '', regex=False)
            numeric = pd.to_numeric(cleaned_col, errors="coerce")
            if numeric.notna().mean() > 0.5:
                num_cols.append(col)
            else:
                unique_count = df[col].nunique()
                if 2 <= unique_count <= 50:
                    cat_cols.append(col)
        except Exception:
            unique_count = df[col].nunique()
            if 2 <= unique_count <= 50:
                cat_cols.append(col)

    # Filter out binary 0/1 indicator columns and survey coded variables
    clean_cat_cols = []
    for col in cat_cols:
        unique_vals = set(df[col].dropna().unique())
        # Skip columns where all values are just 0/1 or numeric codes (with optional blanks)
        str_vals = {str(v).strip() for v in unique_vals} - {"", " "}
        if str_vals <= {"0", "1", "0.0", "1.0"}:
            continue  # binary indicator
        # Skip short coded column names (survey variable codes like f18, g18a, v7, h18b)
        if re.match(r"^[a-zA-Z]\d", col) and len(col) <= 5:
            continue
        clean_cat_cols.append(col)
    cat_cols = clean_cat_cols

    # If we have categorical + numeric columns, build weighted dimensions
    # Find the main numeric column (the one that looks like population/count)
    # Priority: 人口數 > 人口 > 人數 > 數 (to avoid matching 區數 before 人口數)
    main_num = None
    for priority_kw in ["人口數", "人口", "人數"]:
        for col in num_cols:
            if priority_kw in col:
                main_num = col
                break
        if main_num:
            break
    if not main_num:
        for col in num_cols:
            if col.endswith("數") and col not in ("區數", "里數"):
                main_num = col
                break
    if not main_num and num_cols:
        main_num = num_cols[0]

    district_profiles: dict[str, DistrictProfile] = {}

    # Build a dimension for each categorical column
    for col in cat_cols:
        # Filter rows where this column is not NaN and exclude "合計" / "兩性" / "全市" type summaries
        filtered = df[
            df[col].notna()
            & (~df[col].isin(["合計", "總計", "兩性", "全市", "全區", "全部"]))
            & (~df[col].astype(str).str.contains("合計|總計"))
        ]

        if main_num and main_num in filtered.columns:
            # Use numeric values as weights
            counts: dict[str, float] = defaultdict(float)
            for _, row in filtered.iterrows():
                val = str(row[col]).strip()
                num = _parse_number(str(row.get(main_num, 0)))
                if val and num is not None:
                    counts[val] += num
            if counts:
                dim_key = _col_to_dim_key(col)
                dimensions[dim_key] = _build_categorical(dict(counts))
        else:
            # Count occurrences
            value_counts = filtered[col].value_counts().to_dict()
            if value_counts:
                dim_key = _col_to_dim_key(col)
                dimensions[dim_key] = _build_categorical(
                    {str(k): float(v) for k, v in value_counts.items()}
                )

    # --- Wide-format age column pivot ---
    # Detect columns named N歲, N歲_xxx (e.g. 0歲, 1歲, ..., 100歲以上)
    age_num_cols = [c for c in num_cols if re.match(r"^\d+歲", c)]
    # Also match columns like "0歲_合計" — use only _合計 variants if they exist
    age_total_cols = [c for c in age_num_cols if c.endswith("_合計")]
    if age_total_cols:
        age_cols_to_use = age_total_cols
    else:
        # Exclude sub-columns like 0歲_平地 if 0歲 exists
        base_age_cols = [c for c in age_num_cols if "_" not in c]
        age_cols_to_use = base_age_cols if base_age_cols else age_num_cols

    if len(age_cols_to_use) >= 5:
        # Filter out total rows (全市 etc.)
        df_filtered = df
        for col in cat_cols:
            df_filtered = df_filtered[
                df_filtered[col].notna()
                & (~df_filtered[col].isin(["合計", "總計", "兩性", "全市", "全區", "全部"]))
            ]
        # Also filter 性別 == '計' rows if 性別 column exists (use totals, not M/F)
        if "性別" in df_filtered.columns:
            total_gender = df_filtered[df_filtered["性別"] == "計"]
            if len(total_gender) > 0:
                df_filtered = total_gender

        # Group single-year columns into uniform 10-year age bins
        age_bin_totals: dict[str, float] = defaultdict(float)
        for col_name in age_cols_to_use:
            age_start = _extract_age_start(col_name)
            if "以上" in col_name or age_start >= 70:
                label = "70歲以上"
            elif age_start < 10:
                label = "0-9歲"
            elif age_start < 20:
                label = "10-19歲"
            elif age_start < 30:
                label = "20-29歲"
            elif age_start < 40:
                label = "30-39歲"
            elif age_start < 50:
                label = "40-49歲"
            elif age_start < 60:
                label = "50-59歲"
            elif age_start < 70:
                label = "60-69歲"
            else:
                label = "70歲以上"

            col_sum = pd.to_numeric(df_filtered[col_name].astype(str).str.replace(",", ""), errors="coerce").sum()
            age_bin_totals[label] += col_sum

        if age_bin_totals and sum(age_bin_totals.values()) > 0:
            total = sum(age_bin_totals.values())
            bins = [
                RangeBin(range=label, weight=round(v / total, 6))
                for label, v in sorted(
                    age_bin_totals.items(), key=lambda x: _extract_age_start(x[0])
                )
            ]
            dimensions["age"] = Dimension(type=DimensionType.RANGE, bins=bins)

        # --- Ethnic sub-dimension from N歲_平地 / N歲_山地 / N歲_平埔 columns ---
        ethnic_suffixes = {"平地": "平地原住民", "山地": "山地原住民", "平埔": "平埔族群"}
        ethnic_totals: dict[str, float] = {}
        for suffix, label in ethnic_suffixes.items():
            suffix_cols = [c for c in age_num_cols if c.endswith(f"_{suffix}")]
            if suffix_cols:
                s = 0.0
                for sc in suffix_cols:
                    s += pd.to_numeric(df_filtered[sc].astype(str).str.replace(",", ""), errors="coerce").sum()
                if s > 0:
                    ethnic_totals[label] = s
        if len(ethnic_totals) >= 1:
            total_pop = 0
            for ac in age_cols_to_use:
                total_pop += pd.to_numeric(df_filtered[ac].astype(str).str.replace(",", ""), errors="coerce").sum()
            indigenous_sum = sum(ethnic_totals.values())
            if total_pop > indigenous_sum:
                ethnic_totals["一般/非原住民"] = total_pop - indigenous_sum
            if len(ethnic_totals) >= 2:
                dimensions["ethnicity"] = _build_categorical(ethnic_totals)

        # Also extract gender dimension if 性別 has M/F values
        if "性別" in df.columns:
            gender_vals = set(df["性別"].dropna().unique()) - {"計"}
            if gender_vals:
                gender_totals: dict[str, float] = {}
                for g in gender_vals:
                    g_rows = df[(df["性別"] == g)]
                    if cat_cols:
                        g_rows = g_rows[~g_rows[cat_cols[0]].isin(["合計", "總計", "全市", "全區", "全部"])]
                    g_sum = 0
                    for ac in age_cols_to_use:
                        g_sum += pd.to_numeric(g_rows[ac].astype(str).str.replace(",", ""), errors="coerce").sum()
                    label = "男性" if g == "男" else "女性" if g == "女" else g
                    if g_sum > 0:
                        gender_totals[label] = g_sum
                if gender_totals:
                    dimensions["gender"] = _build_categorical(gender_totals)

        # --- Per-district profiles ---
        # Build district_profiles with per-district age dimensions
        district_col = None
        for c in cat_cols:
            if "區域" in c or "地區" in c or "行政區" in c:
                district_col = c
                break
        if not district_col and cat_cols:
            district_col = cat_cols[0]

        if district_col:
            for _, row in df_filtered.iterrows():
                dist_name = str(row[district_col]).strip()
                if dist_name in ("合計", "總計", "全市", "全區", "全部", ""):
                    continue

                # Build per-district age distribution
                dist_age_bins: dict[str, float] = defaultdict(float)
                for col_name in age_cols_to_use:
                    age_start = _extract_age_start(col_name)
                    if "以上" in col_name or age_start >= 70:
                        label = "70歲以上"
                    elif age_start < 10:
                        label = "0-9歲"
                    elif age_start < 20:
                        label = "10-19歲"
                    elif age_start < 30:
                        label = "20-29歲"
                    elif age_start < 40:
                        label = "30-39歲"
                    elif age_start < 50:
                        label = "40-49歲"
                    elif age_start < 60:
                        label = "50-59歲"
                    elif age_start < 70:
                        label = "60-69歲"
                    else:
                        label = "70歲以上"
                    val = _parse_number(str(row.get(col_name, 0))) or 0
                    dist_age_bins[label] += val

                dist_total = sum(dist_age_bins.values())
                if dist_total > 0:
                    dist_dims: dict[str, Dimension] = {}
                    bins = [
                        RangeBin(range=lbl, weight=round(v / dist_total, 6))
                        for lbl, v in sorted(
                            dist_age_bins.items(), key=lambda x: _extract_age_start(x[0])
                        )
                    ]
                    dist_dims["age"] = Dimension(type=DimensionType.RANGE, bins=bins)

                    # Per-district ethnicity if available
                    if ethnic_totals:
                        dist_ethnic: dict[str, float] = {}
                        for suffix, label in ethnic_suffixes.items():
                            suffix_cols = [c for c in age_num_cols if c.endswith(f"_{suffix}")]
                            if suffix_cols:
                                s = sum(_parse_number(str(row.get(sc, 0))) or 0 for sc in suffix_cols)
                                if s > 0:
                                    dist_ethnic[label] = s
                        if len(dist_ethnic) >= 1 and dist_total > 0:
                            indigenous_sum = sum(dist_ethnic.values())
                            if dist_total > indigenous_sum:
                                dist_ethnic["一般/非原住民"] = dist_total - indigenous_sum
                            if len(dist_ethnic) >= 2:
                                dist_dims["ethnicity"] = _build_categorical(dist_ethnic)

                    district_profiles[dist_name] = DistrictProfile(
                        name=dist_name,
                        population=int(dist_total),
                        dimensions=dist_dims,
                    )

    # --- Education level columns (教育程度) ---
    # Detect columns like 博士_畢業, 碩士_肄業, 大學_畢業, 國中_畢業, etc.
    _edu_consolidation = {
        "博士": "博士", "碩士": "碩士", "大學": "大學",
        "專科": "專科", "專科二": "專科", "專科五": "專科",
        "普通教育": "高中", "高中": "高中",
        "職業教育": "高職", "高職": "高職",
        "國中": "國中", "初職": "國中",
        "國小": "國小", "自修": "自修", "不識字": "不識字",
    }
    edu_cols: list[str] = []
    edu_col_mapping: dict[str, str] = {}  # col_name -> consolidated level
    for col in num_cols:
        for prefix, level in _edu_consolidation.items():
            if col.startswith(prefix) or col == prefix:
                edu_cols.append(col)
                edu_col_mapping[col] = level
                break

    if len(edu_cols) >= 4:
        # Filter to 性別==計 (totals) and exclude 合計/總計 rows
        df_edu = df.copy()
        if "性別" in df_edu.columns:
            df_edu = df_edu[df_edu["性別"] == "計"]
        for col in cat_cols:
            df_edu = df_edu[
                df_edu[col].notna()
                & (~df_edu[col].astype(str).str.contains("合計|總計|全市|全區|全部"))
            ]

        # Build consolidated education totals
        edu_totals: dict[str, float] = defaultdict(float)
        for col_name in edu_cols:
            level = edu_col_mapping[col_name]
            s = pd.to_numeric(df_edu[col_name].astype(str).str.replace(",", ""), errors="coerce").sum()
            if s > 0:
                edu_totals[level] += s

        if edu_totals:
            # Order education levels from high to low
            _edu_order = ["博士", "碩士", "大學", "專科", "高中", "高職", "國中", "國小", "自修", "不識字"]
            ordered = {k: edu_totals[k] for k in _edu_order if k in edu_totals}
            dimensions["education"] = _build_categorical(ordered)

        # Gender dimension from 性別 column (男/女, excluding 計)
        if "gender" not in dimensions and "性別" in df.columns:
            df_gender = df.copy()
            for col in cat_cols:
                if col == "性別":
                    continue
                df_gender = df_gender[
                    df_gender[col].notna()
                    & (~df_gender[col].astype(str).str.contains("合計|總計|全市|全區|全部"))
                ]
            gender_totals_edu: dict[str, float] = {}
            for g in ["男", "女"]:
                g_rows = df_gender[df_gender["性別"] == g]
                g_sum = sum(
                    pd.to_numeric(g_rows[ec].astype(str).str.replace(",", ""), errors="coerce").sum()
                    for ec in edu_cols
                )
                if g_sum > 0:
                    label = "男性" if g == "男" else "女性"
                    gender_totals_edu[label] = g_sum
            if gender_totals_edu:
                dimensions["gender"] = _build_categorical(gender_totals_edu)

        # Per-district education profiles
        district_col = None
        for c in cat_cols:
            if "區域" in c or "地區" in c or "行政區" in c:
                district_col = c
                break
        if not district_col and cat_cols:
            district_col = cat_cols[0]

        if district_col and not district_profiles:
            for dist_name in df_edu[district_col].unique():
                dist_name_s = str(dist_name).strip()
                if dist_name_s in ("合計", "總計", "全市", "全區", "全部", ""):
                    continue
                dist_rows = df_edu[df_edu[district_col] == dist_name]
                dist_dims: dict[str, Dimension] = {}

                # District education
                dist_edu: dict[str, float] = defaultdict(float)
                for col_name in edu_cols:
                    level = edu_col_mapping[col_name]
                    s = pd.to_numeric(dist_rows[col_name].astype(str).str.replace(",", ""), errors="coerce").sum()
                    if s > 0:
                        dist_edu[level] += s
                if dist_edu:
                    ordered_dist = {k: dist_edu[k] for k in _edu_order if k in dist_edu}
                    dist_dims["education"] = _build_categorical(ordered_dist)

                dist_pop = int(sum(dist_edu.values()))
                if dist_pop > 0:
                    district_profiles[dist_name_s] = DistrictProfile(
                        name=dist_name_s,
                        population=dist_pop,
                        dimensions=dist_dims,
                    )

    # --- Structured column extraction (for files like 人口數統計表) ---
    # This handles named columns like 人口數_男, 原住民人口數_平地, 65歲以上人口數
    # Only when wide-format age columns were NOT found
    col_set = set(df.columns)
    if len(age_cols_to_use) < 5:
        # Determine the district column and filter
        district_col = None
        for c in cat_cols:
            if "區域" in c or "地區" in c or "行政區" in c:
                district_col = c
                break
        if not district_col and cat_cols:
            district_col = cat_cols[0]

        # Filter out total rows
        df_struct = df
        if district_col:
            df_struct = df_struct[
                df_struct[district_col].notna()
                & (~df_struct[district_col].isin(["合計", "總計", "兩性", "全市", "全區", "全部"]))
            ]

        # --- Gender from 人口數_男 / 人口數_女 ---
        if "人口數_男" in col_set and "人口數_女" in col_set:
            male_sum = pd.to_numeric(df_struct["人口數_男"].astype(str).str.replace(",", ""), errors="coerce").sum()
            female_sum = pd.to_numeric(df_struct["人口數_女"].astype(str).str.replace(",", ""), errors="coerce").sum()
            if male_sum > 0 and female_sum > 0:
                dimensions["gender"] = _build_categorical({"男性": male_sum, "女性": female_sum})

        # --- Indigenous ethnicity from 原住民人口數_平地 / _山地 / _平埔 ---
        struct_ethnic_map = {"原住民人口數_平地": "平地原住民", "原住民人口數_山地": "山地原住民", "原住民人口數_平埔": "平埔族群"}
        struct_ethnic_totals: dict[str, float] = {}
        for col_name, label in struct_ethnic_map.items():
            if col_name in col_set:
                s = pd.to_numeric(df_struct[col_name].astype(str).str.replace(",", ""), errors="coerce").sum()
                if s > 0:
                    struct_ethnic_totals[label] = s
        if len(struct_ethnic_totals) >= 1 and "人口數_總計" in col_set:
            total_pop = pd.to_numeric(df_struct["人口數_總計"].astype(str).str.replace(",", ""), errors="coerce").sum()
            indigenous_sum = sum(struct_ethnic_totals.values())
            if total_pop > indigenous_sum:
                struct_ethnic_totals["一般/非原住民"] = total_pop - indigenous_sum
            if len(struct_ethnic_totals) >= 2:
                dimensions["ethnicity"] = _build_categorical(struct_ethnic_totals)

        # --- Age groups from threshold columns ---
        # Derive: 0-17歲 = 總計 - 18歲以上; 18-64歲 = 18歲以上 - 65歲以上; 65歲以上
        if "人口數_總計" in col_set and "18歲以上人口數" in col_set and "65歲以上人口數" in col_set:
            total_pop = pd.to_numeric(df_struct["人口數_總計"].astype(str).str.replace(",", ""), errors="coerce").sum()
            above_18 = pd.to_numeric(df_struct["18歲以上人口數"].astype(str).str.replace(",", ""), errors="coerce").sum()
            above_65 = pd.to_numeric(df_struct["65歲以上人口數"].astype(str).str.replace(",", ""), errors="coerce").sum()
            age_0_17 = total_pop - above_18
            age_18_64 = above_18 - above_65
            age_65_plus = above_65
            if total_pop > 0 and age_0_17 >= 0 and age_18_64 >= 0:
                bins = [
                    RangeBin(range="0-17歲", weight=round(age_0_17 / total_pop, 6)),
                    RangeBin(range="18-64歲", weight=round(age_18_64 / total_pop, 6)),
                    RangeBin(range="65歲以上", weight=round(age_65_plus / total_pop, 6)),
                ]
                dimensions["age"] = Dimension(type=DimensionType.RANGE, bins=bins)

        # --- Per-district profiles for structured data ---
        if district_col and not district_profiles:
            for _, row in df_struct.iterrows():
                dist_name = str(row[district_col]).strip()
                if dist_name in ("合計", "總計", "全市", "全區", "全部", ""):
                    continue

                dist_dims: dict[str, Dimension] = {}
                dist_pop = int(_parse_number(str(row.get("人口數_總計", 0))) or 0)

                # Per-district gender
                m = _parse_number(str(row.get("人口數_男", 0))) or 0
                f = _parse_number(str(row.get("人口數_女", 0))) or 0
                if m > 0 and f > 0:
                    dist_dims["gender"] = _build_categorical({"男性": m, "女性": f})

                # Per-district age
                a18 = _parse_number(str(row.get("18歲以上人口數", 0))) or 0
                a65 = _parse_number(str(row.get("65歲以上人口數", 0))) or 0
                if dist_pop > 0 and a18 > 0:
                    d_0_17 = dist_pop - a18
                    d_18_64 = a18 - a65
                    dist_dims["age"] = Dimension(
                        type=DimensionType.RANGE,
                        bins=[
                            RangeBin(range="0-17歲", weight=round(d_0_17 / dist_pop, 6)),
                            RangeBin(range="18-64歲", weight=round(d_18_64 / dist_pop, 6)),
                            RangeBin(range="65歲以上", weight=round(a65 / dist_pop, 6)),
                        ],
                    )

                # Per-district indigenous
                dist_ethnic: dict[str, float] = {}
                for col_name, label in struct_ethnic_map.items():
                    v = _parse_number(str(row.get(col_name, 0))) or 0
                    if v > 0:
                        dist_ethnic[label] = v
                if len(dist_ethnic) >= 1 and dist_pop > 0:
                    indigenous_sum = sum(dist_ethnic.values())
                    if dist_pop > indigenous_sum:
                        dist_ethnic["一般/非原住民"] = dist_pop - indigenous_sum
                    if len(dist_ethnic) >= 2:
                        dist_dims["ethnicity"] = _build_categorical(dist_ethnic)

                if dist_pop > 0:
                    district_profiles[dist_name] = DistrictProfile(
                        name=dist_name,
                        population=dist_pop,
                        dimensions=dist_dims,
                    )

    # --- Election data: pivot candidate vote columns into a dimension ---
    # Detect: multiple numeric columns whose names contain （ (party name pattern)
    # or a 投票率 column exists alongside candidate vote columns.
    # Exclude education-level columns (contain _畢業, _肄業, 教育).
    _candidate_cols = [
        c for c in num_cols
        if ("（" in c or "(" in c)
        and not re.search(r"_畢業|_肄業|教育", c)
    ]
    # If we found party-named candidate columns, also include independent
    # candidates: other numeric columns in the same file that aren't 投票率
    # or known non-candidate columns (district counts, rates, etc.)
    if _candidate_cols:
        _non_candidate = re.compile(
            r"投票率|投票數|選舉人數|_畢業|_肄業|教育|人口|戶數|里數|區數|鄰數"
        )
        for c in num_cols:
            if c not in _candidate_cols and not _non_candidate.search(c):
                if "（" not in c and "(" not in c:
                    _candidate_cols.append(c)

    if len(_candidate_cols) >= 2:
        # Build candidate dimension from city-wide totals
        district_col_e = None
        for c in cat_cols:
            if "區域" in c or "地區" in c or "行政區" in c:
                district_col_e = c
                break
        if not district_col_e and cat_cols:
            district_col_e = cat_cols[0]

        df_elec = df
        if district_col_e:
            df_elec = df_elec[
                df_elec[district_col_e].notna()
                & (~df_elec[district_col_e].astype(str).str.contains("合計|總計"))
            ]

        candidate_totals: dict[str, float] = {}
        for col in _candidate_cols:
            s = pd.to_numeric(
                df_elec[col].astype(str).str.replace(",", ""), errors="coerce"
            ).sum()
            if s > 0:
                candidate_totals[col] = s

        if candidate_totals:
            dimensions["candidate"] = _build_categorical(candidate_totals)

            # Rebuild district dimension using total votes (not just first num col)
            if district_col_e:
                dist_vote_totals: dict[str, float] = defaultdict(float)
                for _, row in df_elec.iterrows():
                    dname = str(row[district_col_e]).strip()
                    if dname in ("合計", "總計", "全市", "全區", "全部", ""):
                        continue
                    row_total = sum(
                        _parse_number(str(row.get(c, 0))) or 0
                        for c in _candidate_cols
                    )
                    dist_vote_totals[dname] += row_total
                if dist_vote_totals:
                    dim_key = _col_to_dim_key(district_col_e)
                    dimensions[dim_key] = _build_categorical(dict(dist_vote_totals))

            # Per-district candidate vote profiles
            if district_col_e and not district_profiles:
                for _, row in df_elec.iterrows():
                    dname = str(row[district_col_e]).strip()
                    if dname in ("合計", "總計", "全市", "全區", "全部", ""):
                        continue
                    dist_votes: dict[str, float] = {}
                    for c in _candidate_cols:
                        v = _parse_number(str(row.get(c, 0))) or 0
                        if v > 0:
                            dist_votes[c] = v
                    dist_total = sum(dist_votes.values())
                    if dist_total > 0 and dname not in district_profiles:
                        district_profiles[dname] = DistrictProfile(
                            name=dname,
                            population=int(dist_total),
                            dimensions={
                                "candidate": _build_categorical(dist_votes),
                            },
                        )

        # Add 投票率 as a dimension if available
        if "投票率" in col_set:
            df_rate = df_elec if district_col_e else df
            rate_vals = pd.to_numeric(
                df_rate["投票率"].astype(str).str.replace(",", ""), errors="coerce"
            ).dropna()
            if len(rate_vals) > 0:
                avg_rate = rate_vals.mean()
                dimensions["turnout"] = Dimension(
                    type=DimensionType.CATEGORICAL,
                    categories=[
                        CategoryItem(value="投票", weight=round(avg_rate / 100, 4)),
                        CategoryItem(value="未投票", weight=round(1 - avg_rate / 100, 4)),
                    ],
                )

    # --- Fix education district weighting ---
    # When education columns dominate, rebuild district dimension with total
    # education population (sum of all edu cols) instead of a single column.
    if len(edu_cols) >= 4 and "district" in dimensions:
        district_col_fix = None
        for c in cat_cols:
            if "區域" in c or "地區" in c or "行政區" in c:
                district_col_fix = c
                break
        if not district_col_fix and cat_cols:
            district_col_fix = cat_cols[0]

        if district_col_fix:
            df_fix = df.copy()
            if "性別" in df_fix.columns:
                total_rows = df_fix[df_fix["性別"] == "計"]
                if len(total_rows) > 0:
                    df_fix = total_rows
            df_fix = df_fix[
                df_fix[district_col_fix].notna()
                & (~df_fix[district_col_fix].astype(str).str.contains("合計|總計|全市|全區|全部"))
            ]
            # Sum ALL education columns per district for true population weight
            dist_edu_pop: dict[str, float] = defaultdict(float)
            for _, row in df_fix.iterrows():
                dname = str(row[district_col_fix]).strip()
                row_sum = sum(
                    pd.to_numeric(
                        str(row.get(ec, 0)).replace(",", ""), errors="coerce"
                    ) or 0
                    for ec in edu_cols
                )
                dist_edu_pop[dname] += row_sum
            if dist_edu_pop:
                dimensions["district"] = _build_categorical(dict(dist_edu_pop))

    return ProjectConfig(
        name=_clean_name(name_hint) or "CSV 統計資料",
        region="臺中市",
        locale="zh-TW",
        dimensions=dimensions,
        district_profiles=district_profiles,
    )


def _parse_excel(content: bytes, name_hint: str = "Imported", ext: str = "xlsx") -> ProjectConfig:
    engine = "odf" if ext == "ods" else None
    df = pd.read_excel(io.BytesIO(content), engine=engine)
    if {"dimension", "value", "weight"}.issubset(set(df.columns)):
        return _df_to_config_legacy(df)
    return _parse_gov_csv(df, name_hint)


def _df_to_config_legacy(df: pd.DataFrame) -> ProjectConfig:
    """Legacy format: CSV with dimension/value/weight columns."""
    dimensions: dict[str, Dimension] = {}
    for dim_name, group in df.groupby("dimension"):
        items = [
            CategoryItem(value=str(row["value"]), weight=float(row["weight"]))
            for _, row in group.iterrows()
        ]
        dimensions[str(dim_name)] = Dimension(
            type=DimensionType.CATEGORICAL, categories=items
        )
    return ProjectConfig(name="Imported", dimensions=dimensions)


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

def _build_categorical(counts: dict[str, float]) -> Dimension:
    """Convert raw counts to normalized weights and build a Dimension.

    Auto-filters:
    1. Items matching total keywords (合計, 總計, 小計)
    2. Items whose value ≈ sum of all others (aggregate/total rows)
    """
    # Filter known total keywords
    total_keywords = {"合計", "總計", "小計", "總數", "全部", "全市", "全區"}
    counts = {k: v for k, v in counts.items() if k not in total_keywords}

    if not counts:
        return Dimension(type=DimensionType.CATEGORICAL, categories=[])

    # Detect statistical total rows: item value ≈ sum of all others
    if len(counts) >= 3:
        sorted_items = sorted(counts.items(), key=lambda x: -x[1])
        top_label, top_val = sorted_items[0]
        rest_sum = sum(v for _, v in sorted_items[1:])
        # If top item ≈ sum of rest (within 5%), it's a total row
        if rest_sum > 0 and abs(top_val - rest_sum) / rest_sum < 0.05:
            counts = {k: v for k, v in counts.items() if k != top_label}

    total = sum(counts.values())
    if total == 0:
        total = 1
    items = [
        CategoryItem(value=k, weight=round(v / total, 6))
        for k, v in sorted(counts.items(), key=lambda x: -x[1])
    ]
    return Dimension(type=DimensionType.CATEGORICAL, categories=items)


def _parse_number(s: str) -> float | None:
    """Parse a number string, handling commas and spaces."""
    if not s:
        return None
    cleaned = s.strip().replace(",", "").replace(" ", "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def _clean_district(name: str) -> str:
    """'臺中市中區' → '中區'"""
    # Remove city prefix
    m = re.match(r".*?[市縣](.*)", name)
    if m:
        return m.group(1)
    return name


def _clean_name(filename: str) -> str:
    """Extract a readable name from filename."""
    # Remove leading numbers and underscores: "0_臺中市勞動人口" → "臺中市勞動人口"
    name = re.sub(r"^\d+_", "", filename)
    # Remove file extension artifacts
    name = re.sub(r"\.(JSON|json|CSV|csv)$", "", name, flags=re.IGNORECASE)
    return name.strip()


def _col_to_dim_key(col: str) -> str:
    """Map Chinese column names to dimension keys."""
    mappings = {
        "性別": "gender",
        "教育程度別": "education",
        "教育程度": "education",
        "縣市別": "city_code",
        "地區": "district",
        "區域": "district",
        "區域別": "district",
        "行政區別": "district",
        "行政區": "district",
        "職業": "occupation",
        "年齡": "age",
        "年齡組": "age",
        "city": "city",
        "town": "town",
        "vill": "vill",
        "SEX": "gender",
    }
    return mappings.get(col, col)
