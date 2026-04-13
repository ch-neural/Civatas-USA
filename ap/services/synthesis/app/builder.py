"""Population builder: joint-table sampling with marginal fallback."""
from __future__ import annotations

import random
import re
from collections import defaultdict

import numpy as np

from shared.schemas import Dimension, DimensionType, Person, ProjectConfig

# ── Chinese → English field name mapping ──────────────────────────────
# Only map dimensions that are CLEARLY personal attributes.
# Civatas-USA Stage 1.5+: added US dimension aliases
# (county / state / employment_status / household_tenure / media_habit / party_lean).
_DIM_TO_FIELD: dict[str, str] = {
    "gender": "gender", "性別": "gender",
    "district": "district", "行政區": "district", "地區": "district", "區域": "district",
    "county": "district",  # US: county is the equivalent of TW district
    "state": "district",   # fallback if a multi-state template uses state granularity
    "age": "age", "年齡": "age", "年齡層": "age",
    "education": "education", "教育程度": "education", "教育程度別": "education",
    "occupation": "occupation", "職業": "occupation", "職業別": "occupation",
    "經濟戶長職業別": "occupation",
    "employment_status": "occupation",   # US: ACS B23025 → occupation field
    "household_type": "household_type", "家庭型態": "household_type",
    "household_tenure": "household_type",  # US: ACS B25003 → household_type field
    "marital_status": "marital_status", "婚姻狀態": "marital_status",
    "race": "race",                         # US: ACS B02001
    "hispanic_or_latino": "hispanic_or_latino",  # US: ACS B03003
    "household_income": "household_income", # US: ACS B19001
    "party_lean": "party_lean",            # US: PA template's PVI 5-tier dim
    "media_habit": "media_habit",
}

_PERSON_FIELDS = {
    "person_id", "age", "gender", "district",
    "race", "hispanic_or_latino", "household_income",
    "education", "occupation", "income_band", "household_type",
    "marital_status", "party_lean", "issue_1", "issue_2",
    "media_habit", "mbti", "vote_probability", "custom_fields",
}

# ── Generic semantic classifier ───────────────────────────────────────
# Dimensions whose NAME contains these keywords are statistical categories,
# not personal attributes. They describe what the data measures, not who.
_STAT_NAME_KEYWORDS = {
    "項目", "類別", "分類", "指標", "統計", "金額",
    "計畫", "面積", "概況", "彙整",
}

# If >30% of a dimension's VALUES contain these terms, it's statistical.
_STAT_VALUE_KEYWORDS = {
    "收入", "支出", "所得", "報酬", "總額", "淨額",
    "移轉", "利息", "紅利", "租金", "稅", "保險",
    "儲蓄", "消費", "財產", "營業", "盈餘",
}

# Known personal attribute field names — always included.
_KNOWN_PERSONAL = {"gender", "age", "district", "education", "occupation",
                   "race", "hispanic_or_latino", "household_income",
                   "income_band", "household_type", "marital_status"}


def _is_personal_attribute(dim_name: str, dim: Dimension) -> bool:
    """Determine if a dimension represents a personal attribute.

    Returns False for statistical categories/indicators that shouldn't
    be assigned up to individual persons.

    Generic heuristics:
    1. Known mapped field names → always personal
    2. Dimension name contains statistical keywords → not personal
    3. >30% of values contain financial/statistical terms → not personal
    """
    # Check if it maps to a known personal field
    field = _resolve_field_name(dim_name)
    if field in _KNOWN_PERSONAL:
        return True

    # Check dimension name for statistical keywords
    base = dim_name.rsplit("_", 1)[-1] if "_" in dim_name else dim_name
    for kw in _STAT_NAME_KEYWORDS:
        if kw in base:
            return False

    # Check dimension values for statistical terms
    values: list[str] = []
    if dim.categories:
        values = [c.value for c in dim.categories]
    elif dim.bins:
        values = [b.range for b in dim.bins]

    if values:
        stat_count = sum(
            1 for v in values
            if any(kw in v for kw in _STAT_VALUE_KEYWORDS)
        )
        if stat_count / len(values) > 0.3:
            return False

    return True


def _row_matches_filters(row: dict[str, str], filters: dict[str, list[str]]) -> bool:
    if not filters:
        return True
        
    for f_dim, allowed in filters.items():
        if not allowed:
            continue
        
        # Resolve the filter dimension name to canonical field name
        f_field = _resolve_field_name(f_dim)
        
        # Try to find the matching value in the row:
        # 1. Direct key match
        # 2. Canonical field name match (e.g. "年齡" filter matches "年齡層" row key because both → "age")
        val = None
        if f_dim in row:
            val = str(row[f_dim]).strip()
        else:
            for rk, rv in row.items():
                if _resolve_field_name(rk) == f_field:
                    val = str(rv).strip()
                    break
        
        if not val:
            continue
            
        # Check if the value matches any of the allowed filter values
        matched_any = False
        for a in allowed:
            # Exact match
            if a == val:
                matched_any = True
                break
            # Range containment heuristic
            if a in val:
                if re.fullmatch(r'\d+', a) and re.fullmatch(r'\d+', val):
                    pass # already checked exact equality
                else:
                    matched_any = True
                    break
        
        if not matched_any:
            return False
            
    return True


# ── Public API ────────────────────────────────────────────────────────

def build_population(config: ProjectConfig) -> list[Person]:
    """Build N persons (Person model)."""
    rows = build_population_flat(config)
    persons = []
    
    selected_set = set(config.selected_dimensions) if getattr(config, "selected_dimensions", None) is not None else None
    
    for row in rows:
        # Extract custom fields, fill defaults
        person_data = {"person_id": row.get("person_id", 0)}
        custom = {}
        for k, v in row.items():
            if k == "person_id":
                continue
            if selected_set is not None and k not in selected_set:
                continue
                
            field = _resolve_field_name(k)
            if field in _PERSON_FIELDS:
                person_data[field] = v
            else:
                custom[k] = str(v)
        if custom:
            person_data["custom_fields"] = custom
        _fill_defaults(person_data)
        persons.append(Person(**person_data))
    return persons


def build_population_flat(config: ProjectConfig) -> list[dict]:
    """Build N persons as flat dicts — only populated fields, no nulls.

    Sampling strategy:
    1. Sort joint tables by number of dimensions (most first)
    2. Primary table: weighted sample N rows → fills multiple dims at once
    3. Secondary tables: condition on shared dims, then sample
    4. Remaining dims: independent marginal sampling
    """
    n = config.target_count
    joint_tables = config.joint_tables or []
    
    print(f"DEBUG: Starting build_population_flat with target_count={n}")
    print(f"DEBUG: filters keys={list(config.filters.keys()) if config.filters else 'None'}")
    if config.filters:
        for fk, fv in config.filters.items():
            print(f"DEBUG: filter[{fk!r}] = {fv[:5]}... (total {len(fv)} values)" if len(fv) > 5 else f"DEBUG: filter[{fk!r}] = {fv}")

    # --- Apply Filters to Joint Tables ---
    filtered_jts = []
    _skip_keywords = {"計", "總計", "合計", "小計", "total", "subtotal", "unknown"}
    for jt in joint_tables:
        if not jt.rows or not jt.weights:
            continue
        
        zero_count = 0
        nonzero_count = 0
        new_weights = []
        for row, w in zip(jt.rows, jt.weights):
            # Skip rows representing totals
            if any(str(v).strip().lower() in _skip_keywords for v in row.values()):
                new_weights.append(0.0)
                zero_count += 1
                continue
                
            if config.filters and not _row_matches_filters(row, config.filters):
                new_weights.append(0.0)
                zero_count += 1
            else:
                new_weights.append(w)
                nonzero_count += 1
                
        print(f"DEBUG: JT {jt.dim_names}: kept={nonzero_count}, filtered={zero_count}")
        if sum(new_weights) > 0:
            jt.weights = new_weights
            filtered_jts.append(jt)
        else:
            print(f"DEBUG: Joint table {jt.dim_names} dropped because sum(new_weights) == 0")

    # --- Phase 1: Joint table sampling ---
    # Sort by dimension count (most dimensions first)
    sorted_jts = sorted(filtered_jts, key=lambda jt: len(jt.dim_names), reverse=True)

    # Track which dimensions are already sampled for each person
    sampled: list[dict[str, str]] = [{} for _ in range(n)]

    for jt in sorted_jts:
        if not jt.rows or not jt.weights:
            continue

        # Which dims does this JT cover?
        jt_dims = set(jt.dim_names)
        # Which are already sampled? (from a previous, larger JT)
        already_sampled_dims = set(sampled[0].keys()) if sampled[0] else set()
        shared_dims = jt_dims & already_sampled_dims
        new_dims = jt_dims - already_sampled_dims

        if not new_dims:
            continue  # This JT adds nothing new

        if not shared_dims:
            # No shared dimensions → sample independently from this JT
            weights = np.array(jt.weights, dtype=float)
            weights /= weights.sum()
            indices = np.random.choice(len(jt.rows), size=n, p=weights)
            for i in range(n):
                row = jt.rows[indices[i]]
                for dim in new_dims:
                    if dim in row:
                        sampled[i][dim] = row[dim]
        else:
            # Shared dimensions exist → conditional sampling
            # Group JT rows by shared-dim values
            groups: dict[tuple, list[int]] = defaultdict(list)
            for idx, row in enumerate(jt.rows):
                key = tuple(row.get(d, "") for d in sorted(shared_dims))
                groups[key].append(idx)

            for i in range(n):
                # Get the already-sampled values for shared dims
                key = tuple(sampled[i].get(d, "") for d in sorted(shared_dims))
                matching = groups.get(key, [])

                if matching:
                    # Conditional sample from matching rows
                    sub_weights = np.array([jt.weights[j] for j in matching], dtype=float)
                    sub_weights /= sub_weights.sum()
                    chosen = matching[np.random.choice(len(matching), p=sub_weights)]
                    row = jt.rows[chosen]
                    for dim in new_dims:
                        if dim in row:
                            sampled[i][dim] = row[dim]
                else:
                    # No match → fall back to unconditional sample
                    weights = np.array(jt.weights, dtype=float)
                    weights /= weights.sum()
                    chosen = np.random.choice(len(jt.rows), p=weights)
                    row = jt.rows[chosen]
                    for dim in new_dims:
                        if dim in row:
                            sampled[i][dim] = row[dim]

    # --- Phase 2: Marginal sampling for remaining dimensions ---
    all_sampled_dims = set()
    for s in sampled:
        all_sampled_dims.update(s.keys())

    # Pre-compute the effective allowed age range from ALL age-related filters (numeric intersection)
    # This is used to constrain coarse 'age' marginal bins using range overlap rather than string matching
    eff_age_min, eff_age_max = None, None
    if config.filters:
        for fk, fv in config.filters.items():
            if _resolve_field_name(fk) == "age" and fv:
                for label in fv:
                    nums = re.findall(r"\d+", label)
                    if not nums:
                        continue
                    if len(nums) == 2:
                        lo, hi = int(nums[0]), int(nums[1])
                    elif "\u4ee5\u4e0a" in label or "+" in label:
                        lo, hi = int(nums[0]), 120
                    elif "\u4ee5\u4e0b" in label:
                        lo, hi = 0, int(nums[0])
                    else:
                        lo = hi = int(nums[0])
                    eff_age_min = lo if eff_age_min is None else min(eff_age_min, lo)
                    eff_age_max = hi if eff_age_max is None else max(eff_age_max, hi)
    print(f"DEBUG Phase2: effective age range from all filters = [{eff_age_min}, {eff_age_max}]")

    for dim_name, dim in config.dimensions.items():
        if dim_name in all_sampled_dims:
            continue  # Already sampled from a joint table
        if not _is_personal_attribute(dim_name, dim):
            continue  # Skip statistical categories (not personal traits)
        try:
            values, weights = _extract_values_weights(dim)
            if not values:
                continue

            is_age_dim = _resolve_field_name(dim_name) == "age"
                
            # Apply filters — check both direct name and canonical field name
            filter_allowed = None
            if config.filters:
                if dim_name in config.filters:
                    filter_allowed = config.filters[dim_name]
                else:
                    # Try canonical field name match
                    dim_field = _resolve_field_name(dim_name)
                    for fk, fv in config.filters.items():
                        if _resolve_field_name(fk) == dim_field:
                            filter_allowed = fv
                            break
            
            if is_age_dim and eff_age_min is not None:
                # For age dimensions, use numeric range OVERLAP with the effective age range
                # rather than exact string matching. This correctly handles coarse bins like
                # '18-64歲' vs fine-grained filter values like '20～24', '25～29'.
                new_pairs = []
                for v, w in zip(values, weights):
                    v_nums = re.findall(r"\d+", str(v))
                    if len(v_nums) == 2:
                        blo, bhi = int(v_nums[0]), int(v_nums[1])
                    elif v_nums and ("\u4ee5\u4e0a" in str(v) or "+" in str(v)):
                        blo, bhi = int(v_nums[0]), 120
                    elif v_nums and "\u4ee5\u4e0b" in str(v):
                        blo, bhi = 0, int(v_nums[0])
                    elif v_nums:
                        blo = bhi = int(v_nums[0])
                    else:
                        continue
                    # Keep this bin only if it overlaps with [eff_age_min, eff_age_max]
                    if bhi >= eff_age_min and blo <= eff_age_max:
                        # Clip the weight proportionally to the overlap
                        overlap = min(bhi, eff_age_max) - max(blo, eff_age_min) + 1
                        span = bhi - blo + 1
                        new_pairs.append((v, w * overlap / span))
                if new_pairs:
                    values = [p[0] for p in new_pairs]
                    weights = [p[1] for p in new_pairs]
                else:
                    continue
            elif filter_allowed is not None:
                if not filter_allowed:
                    # All values unchecked → exclude this dimension entirely
                    continue
                allowed = set(filter_allowed)
                filtered_pairs = [(v, w) for v, w in zip(values, weights) if v in allowed]
                if not filtered_pairs:
                    continue
                values = [p[0] for p in filtered_pairs]
                weights = [p[1] for p in filtered_pairs]

            weights_arr = _normalize(weights)
            draws = list(np.random.choice(values, size=n, p=weights_arr))
            for i in range(n):
                sampled[i][dim_name] = draws[i]
        except Exception:
            continue

    # --- Phase 3: Build output rows ---
    age_filter_groups = []
    if config.filters:
        # Check all filter keys that resolve to "age" field
        for fk, fv in config.filters.items():
            if _resolve_field_name(fk) == "age" and fv:
                age_filter_groups.append(fv)
    
    # Compute the absolute minimum age from filter labels for hard enforcement
    age_min_from_filter = None
    if age_filter_groups:
        mins_per_group = []
        for grp in age_filter_groups:
            grp_min = None
            for label in grp:
                nums = re.findall(r"\d+", label)
                if nums:
                    lo = int(nums[0])
                    if grp_min is None or lo < grp_min:
                        grp_min = lo
            if grp_min is not None:
                mins_per_group.append(grp_min)
        if mins_per_group:
            age_min_from_filter = max(mins_per_group) # intersection must be >= the highest minimum
        print(f"DEBUG: age_filter_groups count={len(age_filter_groups)}, age_min_from_filter={age_min_from_filter}")
    
    under20_debug_count = 0
    
    persons: list[dict] = []
    for i in range(n):
        row: dict[str, object] = {"person_id": i}
        custom: dict[str, str] = {}

        for dim_name, raw in sampled[i].items():
            field_name = _resolve_field_name(dim_name)

            if field_name == "age":
                resolved_age = _resolve_range(str(raw), config.filters)
                row["age"] = resolved_age
                # Debug: track where under-20 ages come from
                if age_min_from_filter and resolved_age < age_min_from_filter and under20_debug_count < 5:
                    print(f"DEBUG: Person {i}: raw age label='{raw}' → resolved={resolved_age} (below min {age_min_from_filter})")
                    under20_debug_count += 1
            elif field_name == "vote_probability":
                try:
                    row["vote_probability"] = float(raw)
                except ValueError:
                    row["vote_probability"] = 0.5
            elif field_name in _PERSON_FIELDS:
                row[field_name] = raw
            else:
                custom[dim_name] = raw

        # Flatten: no nulls, custom fields inline
        _fill_defaults(row, config.filters)
        row["county"] = config.region or ""  # Inject county for census lookup
        _enforce_logical_consistency(row)
        
        # --- Post-validation: enforce age filter constraint ---
        if age_filter_groups and isinstance(row.get("age"), (int, float)):
            age_val = int(row["age"])
            valid = all(_age_in_allowed_labels(age_val, grp) for grp in age_filter_groups)
            if not valid:
                new_age = _random_age(age_filter_groups)
                if under20_debug_count < 10:
                    print(f"DEBUG: Post-validation person {i}: age {age_val} not in intersected labels, rewriting to {new_age}")
                row["age"] = new_age
        
        # Hard enforcement: if we have a computed minimum age, force it
        if age_min_from_filter is not None and isinstance(row.get("age"), (int, float)):
            if int(row["age"]) < age_min_from_filter:
                row["age"] = _random_age(age_filter_groups)
        
        flat = {k: v for k, v in row.items() if v is not None}
        flat.update(custom)
        persons.append(flat)

    return persons


# ── Field name resolution ─────────────────────────────────────────────

def _resolve_field_name(dim_name: str) -> str:
    """Map a dimension name to a Person model field name."""
    if dim_name in _DIM_TO_FIELD:
        return _DIM_TO_FIELD[dim_name]
    if "_" in dim_name:
        suffix = dim_name.rsplit("_", 1)[-1]
        if suffix in _DIM_TO_FIELD:
            return _DIM_TO_FIELD[suffix]
        if suffix in _PERSON_FIELDS:
            return suffix
    for key, field in _DIM_TO_FIELD.items():
        if len(key) >= 2 and key in dim_name:
            return field
    return dim_name


# ── Helpers ───────────────────────────────────────────────────────────

def _extract_values_weights(dim: Dimension) -> tuple[list[str], list[float]]:
    _skip = {"計", "總計", "合計", "小計", "total", "subtotal", "unknown"}
    
    if dim.type == DimensionType.CATEGORICAL and dim.categories:
        vals, wts = [], []
        for c in dim.categories:
            if str(c.value).strip().lower() not in _skip:
                vals.append(c.value)
                wts.append(c.weight)
        return vals, wts
        
    if dim.type == DimensionType.RANGE and dim.bins:
        vals, wts = [], []
        for b in dim.bins:
            if str(b.range).strip().lower() not in _skip:
                vals.append(b.range)
                wts.append(b.weight)
        return vals, wts
        
    return [], []


def _normalize(weights: list[float]) -> list[float]:
    total = sum(weights)
    if total == 0:
        return [1.0 / len(weights)] * len(weights)
    return [w / total for w in weights]


def _age_in_allowed_labels(age: int, labels: list[str]) -> bool:
    """Check if a concrete age falls within any of the allowed label ranges."""
    for label in labels:
        nums = re.findall(r"\d+", label)
        if len(nums) == 2:
            lo, hi = int(nums[0]), int(nums[1])
            if lo <= age <= hi:
                return True
        elif len(nums) == 1:
            n = int(nums[0])
            if "以上" in label or "+" in label:
                if age >= n:
                    return True
            elif "以下" in label:
                if age <= n:
                    return True
            else:
                if age == n:
                    return True
    return False


def _resolve_range(label: str, filters: dict = None) -> int:
    """Convert a range label like '18-24', '65+', '70歲以上' to a concrete int."""
    if "以上" in label or "+" in label:
        nums = re.findall(r"\d+", label)
        if nums:
            base = int(nums[0])
            return random.randint(base, base + 20)
    cleaned = re.sub(r"[歲岁]", "", label)
    match = re.match(r"(\d+)\s*[-–—～~]\s*(\d+)", cleaned)
    if match:
        return random.randint(int(match.group(1)), int(match.group(2)))
    try:
        return int(cleaned)
    except ValueError:
        age_filter_groups = []
        if filters:
            for fk, fv in filters.items():
                if _resolve_field_name(fk) == "age" and fv:
                    age_filter_groups.append(fv)
        return _random_age(age_filter_groups or None)


_AGE_RANGES = [(0, 17), (18, 24), (25, 34), (35, 44), (45, 54), (55, 64), (65, 80)]
_AGE_WEIGHTS = [0.15, 0.09, 0.16, 0.18, 0.18, 0.14, 0.10]


def _random_age(allowed_groups: list[list[str]] = None) -> int:
    # If no filters, fallback to normal distribution
    if not allowed_groups:
        lo, hi = random.choices(_AGE_RANGES, weights=_AGE_WEIGHTS, k=1)[0]
        return random.randint(lo, hi)
        
    valid_ages = None
    for grp in allowed_groups:
        grp_candidates = set()
        for a in grp:
            nums = re.findall(r"\d+", a)
            if len(nums) == 2:
                grp_candidates.update(range(int(nums[0]), int(nums[1]) + 1))
            elif len(nums) == 1:
                if "以上" in a or "+" in a:
                    grp_candidates.update(range(int(nums[0]), 120))
                elif "以下" in a or "-" in a:
                    grp_candidates.update(range(0, int(nums[0]) + 1))
                else:
                    grp_candidates.add(int(nums[0]))
        if valid_ages is None:
            valid_ages = grp_candidates
        else:
            valid_ages &= grp_candidates
    
    if valid_ages:
        return random.choice(list(valid_ages))
        
    # Fallback if intersection is empty
    lo, hi = random.choices(_AGE_RANGES, weights=_AGE_WEIGHTS, k=1)[0]
    return random.randint(lo, hi)


def _fill_defaults(row: dict, filters: dict = None) -> None:
    # Find age filter from any key that resolves to "age"
    age_filter_groups = []
    if filters:
        for fk, fv in filters.items():
            if _resolve_field_name(fk) == "age" and fv:
                age_filter_groups.append(fv)
    
    row.setdefault("age", _random_age(age_filter_groups or None))
    row.setdefault("gender", "unknown")
    row.setdefault("district", "unknown")


def _enforce_logical_consistency(row: dict) -> None:
    """Post-processing to fix physically/logically impossible combinations."""
    # Fix district name format (remove stray spaces: "中 區" → "中區")
    if row.get("district"):
        row["district"] = row["district"].replace(" ", "")

    age = row.get("age", 30)
    if not isinstance(age, int):
        return

    # Education logic
    edu = row.get("education", "")
    if age < 6:
        row["education"] = "無"
    elif age < 12:
        row["education"] = "國小"
    elif age < 15:
        if edu not in ("無", "國小", "國中"):
            row["education"] = "國中"
    elif age < 18:
        if edu not in ("無", "國小", "國中", "普通教育高中", "職業教育高職"):
            row["education"] = "普通教育高中"

    # Occupation logic — uses census DB for real distributions
    # Census provides: per-district occupation counts + age groups + working ratios
    # This allows data-driven assignment instead of hardcoded assumptions.
    occ = row.get("occupation", "")
    import random as _rng
    gender = row.get("gender", "")
    county = row.get("county", "")
    district = row.get("district", "")

    def _assign_from_census():
        """Assign specific occupation from census industry distribution."""
        try:
            from .census_lookup import get_occupation_distribution
            dist = get_occupation_distribution(county, district)
        except Exception:
            dist = {}
        if dist:
            return _rng.choices(list(dist.keys()), weights=list(dist.values()), k=1)[0]
        # BLS-aligned English categories tracking US workforce composition.
        return _rng.choices(
            ["Healthcare", "Retail", "Manufacturing", "Education",
             "Professional Services", "Construction", "Transportation",
             "Hospitality", "Finance", "Public Sector"],
            weights=[16, 13, 12, 11, 10, 9, 8, 8, 7, 6], k=1
        )[0]

    if age < 18:
        row["occupation"] = "Student"
    elif occ in ("無工作", "無", "", "待業", "有工作", "Unemployed", "Not in labor force"):
        # Census "無工作" includes students, retirees, homemakers, unemployed.
        # "有工作" gets assigned a specific industry from census distribution.
        if occ in ("有工作",):
            row["occupation"] = _assign_from_census()
        else:
            # Infer sub-category based on age/gender using census ratios
            if age >= 65:
                row["occupation"] = "Retired"
            elif age <= 22:
                row["occupation"] = "Student"
            elif gender in ("Female", "female") and _rng.random() < 0.28:
                row["occupation"] = "Homemaker"
            else:
                # ~15% truly unemployed/not in labor force; rest get working occ
                if _rng.random() < 0.15:
                    row["occupation"] = "Unemployed"
                else:
                    row["occupation"] = _assign_from_census()

