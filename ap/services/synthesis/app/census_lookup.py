"""Census data lookup from election-db for population synthesis.

Queries the census_data table to get real demographic distributions
per county/district, used to assign occupations and other attributes
based on actual population statistics instead of hardcoded assumptions.
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache

logger = logging.getLogger(__name__)


def _get_dsn() -> str:
    host = os.environ.get("ELECTION_DB_HOST", "election-db")
    port = os.environ.get("ELECTION_DB_PORT", "5432")
    db = os.environ.get("ELECTION_DB_NAME", "elections")
    user = os.environ.get("ELECTION_DB_USER", "civatas")
    pw = os.environ.get("ELECTION_DB_PASS", "civatas2026")
    return f"host={host} port={port} dbname={db} user={user} password={pw}"


def _query(sql: str, params: tuple = ()) -> list[tuple]:
    """Execute a query and return rows. Converts Decimal to float."""
    try:
        import psycopg2
        from decimal import Decimal
        conn = psycopg2.connect(_get_dsn())
        try:
            cur = conn.cursor()
            cur.execute(sql, params)
            rows = cur.fetchall()
            # Convert Decimal to float for arithmetic compatibility
            return [(r[0], float(r[1]) if isinstance(r[1], Decimal) else r[1]) for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"[census] DB query failed: {e}")
        return []


@lru_cache(maxsize=64)
def get_occupation_distribution(county: str, district: str = "") -> dict[str, float]:
    """Get occupation distribution ratios from census for a county/district.

    Returns dict like:
        {"製造業": 0.27, "批發及零售業": 0.17, "住宿及餐飲業": 0.09, ...}

    Values are proportions (0-1) of the working population.
    If district is provided and found, uses district-level data.
    Falls back to county-level, then returns empty dict.
    """
    # Metric names in census_data that represent occupations
    OCC_METRICS = {
        "有工作_工業_製造業_人": "製造業",
        "有工作_工業_營建工程業_人": "營建業",
        "有工作_服務業_批發及零售業_人": "批發零售",
        "有工作_服務業_住宿及餐飲業_人": "住宿餐飲",
        "有工作_服務業_教育業_人": "教育",
        "有工作_服務業_醫療保健及社會工作服務業_人": "醫療",
        "有工作_服務業_公共行政及國防_強制性社會安全_人": "公務員",
        "有工作_服務業_金融及保險業_人": "金融保險",
        "有工作_服務業_運輸及倉儲業_人": "運輸倉儲",
        "有工作_服務業_其他服務業_人": "服務業",
        "有工作_農林漁牧業_人": "農林漁牧",
    }

    # Try district first, then county
    for target_district in ([district, ""] if district else [""]):
        if target_district:
            rows = _query(
                "SELECT metric_name, SUM(metric_value) FROM census_data "
                "WHERE county = %s AND district = %s AND metric_name = ANY(%s) "
                "GROUP BY metric_name",
                (county, target_district, list(OCC_METRICS.keys())),
            )
        else:
            rows = _query(
                "SELECT metric_name, SUM(metric_value) FROM census_data "
                "WHERE county = %s AND metric_name = ANY(%s) "
                "GROUP BY metric_name",
                (county, list(OCC_METRICS.keys())),
            )

        if rows:
            total = sum(v for _, v in rows)
            if total > 0:
                result = {}
                for metric, value in rows:
                    occ_name = OCC_METRICS.get(metric)
                    if occ_name:
                        result[occ_name] = round(value / total, 4)
                if result:
                    logger.info(f"[census] Occupation dist for {county}/{district or '全縣'}: {len(result)} categories, total={total:.0f}")
                    return result

    return {}


@lru_cache(maxsize=64)
def get_marital_distribution(county: str, district: str = "") -> dict[str, float]:
    """Get marital status distribution from census.

    Returns dict like:
        {"未婚": 0.35, "有配偶": 0.50, "離婚": 0.10, "喪偶": 0.05}
    """
    MARITAL_METRICS = {
        "未婚_人": "未婚",
        "有配偶或同居伴侶_人": "已婚",
        "離婚或分居_人": "離婚",
        "喪偶_人": "喪偶",
    }

    for target_district in ([district, ""] if district else [""]):
        if target_district:
            rows = _query(
                "SELECT metric_name, SUM(metric_value) FROM census_data "
                "WHERE county = %s AND district = %s AND metric_name = ANY(%s) "
                "GROUP BY metric_name",
                (county, target_district, list(MARITAL_METRICS.keys())),
            )
        else:
            rows = _query(
                "SELECT metric_name, SUM(metric_value) FROM census_data "
                "WHERE county = %s AND metric_name = ANY(%s) "
                "GROUP BY metric_name",
                (county, list(MARITAL_METRICS.keys())),
            )

        if rows:
            total = sum(v for _, v in rows)
            if total > 0:
                return {MARITAL_METRICS[m]: round(v / total, 4) for m, v in rows if m in MARITAL_METRICS}

    return {}


@lru_cache(maxsize=64)
def get_working_ratio(county: str, district: str = "") -> float:
    """Get the ratio of working population vs total (excluding under-15).

    Useful to know how many 無工作 people to expect.
    """
    for target_district in ([district, ""] if district else [""]):
        if target_district:
            rows = _query(
                "SELECT metric_name, SUM(metric_value) FROM census_data "
                "WHERE county = %s AND district = %s "
                "AND metric_name IN ('有工作_合計_人', '無工作_人') "
                "GROUP BY metric_name",
                (county, target_district),
            )
        else:
            rows = _query(
                "SELECT metric_name, SUM(metric_value) FROM census_data "
                "WHERE county = %s AND metric_name IN ('有工作_合計_人', '無工作_人') "
                "GROUP BY metric_name",
                (county,),
            )

        if rows:
            data = {m: v for m, v in rows}
            working = data.get("有工作_合計_人", 0)
            total = working + data.get("無工作_人", 0)
            if total > 0:
                return round(working / total, 4)

    return 0.0


@lru_cache(maxsize=64)
def get_nowork_breakdown(county: str, district: str = "") -> dict[str, float]:
    """Estimate the breakdown of 無工作 population from census age/education data.

    Uses census age distribution + education levels to estimate:
    - student_ratio: proportion of non-working who are students (15-24 with higher edu)
    - retiree_ratio: proportion who are 65+ (retired)
    - remaining: homemakers + unemployed + other

    Returns dict like:
        {"student": 0.23, "retiree": 0.28, "other": 0.49}
    """
    metrics_needed = [
        "年齡_24歲_人",        # 15-24 age group
        "年齡_65歲以上_人",    # 65+ age group (proxy for retirees)
        "無工作_人",           # total non-working
        "未滿15歲_人",         # under 15 (excluded)
    ]

    for target_district in ([district, ""] if district else [""]):
        if target_district:
            rows = _query(
                "SELECT metric_name, SUM(metric_value) FROM census_data "
                "WHERE county = %s AND district = %s AND metric_name = ANY(%s) "
                "GROUP BY metric_name",
                (county, target_district, metrics_needed),
            )
        else:
            rows = _query(
                "SELECT metric_name, SUM(metric_value) FROM census_data "
                "WHERE county = %s AND metric_name = ANY(%s) "
                "GROUP BY metric_name",
                (county, metrics_needed),
            )

        if rows:
            data = {m: v for m, v in rows}
            no_work = data.get("無工作_人", 0)
            if no_work <= 0:
                continue

            age_15_24 = data.get("年齡_24歲_人", 0)
            age_65_plus = data.get("年齡_65歲以上_人", 0)

            # Taiwan 15-24 labor participation ~35%, so ~65% are students
            est_students = age_15_24 * 0.65
            # 65+ are almost all retired (勞參率 ~9%)
            est_retirees = age_65_plus * 0.91

            student_ratio = min(est_students / no_work, 0.35)  # cap at 35%
            retiree_ratio = min(est_retirees / no_work, 0.40)  # cap at 40%
            other_ratio = max(0, 1.0 - student_ratio - retiree_ratio)

            result = {
                "student": round(student_ratio, 3),
                "retiree": round(retiree_ratio, 3),
                "other": round(other_ratio, 3),
            }
            logger.info(f"[census] No-work breakdown for {county}/{district or '全縣'}: {result}")
            return result

    return {"student": 0.15, "retiree": 0.25, "other": 0.60}
