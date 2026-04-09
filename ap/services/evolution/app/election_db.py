"""Election Database client for the Evolution service.

Provides query functions to read historical election data from PostgreSQL
for parameter calibration and analysis.
"""
from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from functools import lru_cache

logger = logging.getLogger(__name__)

# US-only — every public function delegates to election_db_us, which reads
# from a SQLite snapshot of MEDSL 2020+2024 (Stage 1.9 cleanup removed the
# legacy TW Postgres path).
try:
    from . import election_db_us as _us_db
except ImportError:
    import election_db_us as _us_db  # type: ignore


def _get_dsn() -> str:
    host = os.environ.get("ELECTION_DB_HOST", "election-db")
    port = os.environ.get("ELECTION_DB_PORT", "5432")
    db = os.environ.get("ELECTION_DB_NAME", "elections")
    user = os.environ.get("ELECTION_DB_USER", "civatas")
    pw = os.environ.get("ELECTION_DB_PASS", "civatas2026")
    return f"host={host} port={port} dbname={db} user={user} password={pw}"


@contextmanager
def _db():
    """Get a database connection (context manager)."""
    import psycopg2
    conn = psycopg2.connect(_get_dsn())
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
    """List available elections with optional filters."""
    if _us_db is not None:
        return _us_db.list_elections(election_type, scope, min_year, max_year)
    with _db() as conn:
        cur = conn.cursor()
        sql = "SELECT id, name, election_type, ad_year, scope, election_date FROM elections WHERE 1=1"
        params: list = []
        if election_type:
            sql += " AND election_type = %s"
            params.append(election_type)
        if scope:
            sql += " AND scope = %s"
            params.append(scope)
        if min_year:
            sql += " AND ad_year >= %s"
            params.append(min_year)
        if max_year:
            sql += " AND ad_year <= %s"
            params.append(max_year)
        sql += " ORDER BY ad_year DESC, scope"
        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


# ── Vote results queries ────────────────────────────────────

def get_county_results(
    election_id: int | None = None,
    election_type: str | None = None,
    ad_year: int | None = None,
    county: str | None = None,
) -> list[dict]:
    """Get county-level vote results.

    Can query by election_id directly, or by type+year+county.
    Returns: [{candidate_name, party_name, party_spectrum, county, total_votes, vote_share_pct}]
    """
    if _us_db is not None:
        return _us_db.get_county_results(election_id, election_type, ad_year, county)
    with _db() as conn:
        cur = conn.cursor()

        if election_id:
            sql = """
                SELECT c.name AS candidate_name, p.name AS party_name, p.spectrum,
                       r.county,
                       SUM(vr.vote_count) AS total_votes,
                       ROUND(SUM(vr.vote_count)::NUMERIC /
                             NULLIF(SUM(SUM(vr.vote_count)) OVER (PARTITION BY r.county), 0) * 100, 2) AS vote_share_pct
                FROM vote_results vr
                JOIN candidates c ON c.id = vr.candidate_id
                LEFT JOIN parties p ON p.id = c.party_id
                JOIN regions r ON r.id = vr.region_id
                WHERE vr.election_id = %s
            """
            params: list = [election_id]
            if county:
                sql += " AND r.county = %s"
                params.append(county)
            sql += " GROUP BY c.name, p.name, p.spectrum, r.county ORDER BY r.county, total_votes DESC"
        else:
            sql = """
                SELECT c.name AS candidate_name, p.name AS party_name, p.spectrum,
                       r.county,
                       SUM(vr.vote_count) AS total_votes,
                       ROUND(SUM(vr.vote_count)::NUMERIC /
                             NULLIF(SUM(SUM(vr.vote_count)) OVER (PARTITION BY r.county), 0) * 100, 2) AS vote_share_pct
                FROM vote_results vr
                JOIN elections e ON e.id = vr.election_id
                JOIN candidates c ON c.id = vr.candidate_id
                LEFT JOIN parties p ON p.id = c.party_id
                JOIN regions r ON r.id = vr.region_id
                WHERE 1=1
            """
            params = []
            if election_type:
                sql += " AND e.election_type = %s"
                params.append(election_type)
            if ad_year:
                sql += " AND e.ad_year = %s"
                params.append(ad_year)
            if county:
                sql += " AND r.county = %s"
                params.append(county)
            sql += " GROUP BY c.name, p.name, p.spectrum, r.county ORDER BY r.county, total_votes DESC"

        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_district_results(
    election_id: int | None = None,
    election_type: str | None = None,
    ad_year: int | None = None,
    county: str | None = None,
) -> list[dict]:
    """Get district-level (鄉鎮市區) vote results.

    Returns: [{candidate_name, party_name, county, district, total_votes, vote_share_pct, turnout}]
    """
    if _us_db is not None:
        return _us_db.get_district_results(election_id, election_type, ad_year, county)
    with _db() as conn:
        cur = conn.cursor()
        sql = """
            SELECT c.name AS candidate_name, p.name AS party_name, p.spectrum AS party_spectrum,
                   r.county, r.district,
                   SUM(vr.vote_count) AS total_votes,
                   vr.vote_share,
                   es.turnout
            FROM vote_results vr
            JOIN elections e ON e.id = vr.election_id
            JOIN candidates c ON c.id = vr.candidate_id
            LEFT JOIN parties p ON p.id = c.party_id
            JOIN regions r ON r.id = vr.region_id
            LEFT JOIN election_stats es ON es.election_id = e.id AND es.region_id = r.id
            WHERE r.district IS NOT NULL
        """
        params: list = []
        if election_id:
            sql += " AND e.id = %s"
            params.append(election_id)
        if election_type:
            sql += " AND e.election_type = %s"
            params.append(election_type)
        if ad_year:
            sql += " AND e.ad_year = %s"
            params.append(ad_year)
        if county:
            sql += " AND r.county = %s"
            params.append(county)
        sql += " GROUP BY c.name, p.name, p.spectrum, r.county, r.district, vr.vote_share, es.turnout"
        sql += " ORDER BY r.county, r.district, total_votes DESC"

        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


# ── Ground truth builder for calibration ────────────────────

def build_ground_truth(
    election_type: str,
    ad_year: int,
    county: str,
) -> dict:
    """Build a ground_truth dict suitable for the calibration system.

    Returns: {"候選人名(政黨)": vote_share_pct, ...}
    Also includes "__by_district__" for per-district ground truth.
    """
    if _us_db is not None:
        return _us_db.build_ground_truth(election_type, ad_year, county)
    # County-level totals
    county_results = get_county_results(
        election_type=election_type, ad_year=ad_year, county=county,
    )

    ground_truth: dict = {}
    for r in county_results:
        if r["county"] == county:
            party = r["party_name"] or "無黨籍"
            key = f"{r['candidate_name']}({party})"
            ground_truth[key] = float(r["vote_share_pct"]) if r["vote_share_pct"] else 0.0

    # District-level breakdown
    district_results = get_district_results(
        election_type=election_type, ad_year=ad_year, county=county,
    )

    by_district: dict[str, dict[str, float]] = {}
    for r in district_results:
        dist = r["district"]
        if dist not in by_district:
            by_district[dist] = {}
        party = r["party_name"] or "無黨籍"
        key = f"{r['candidate_name']}({party})"
        by_district[dist][key] = float(r["vote_share"]) if r["vote_share"] else 0.0

    if by_district:
        ground_truth["__by_district__"] = by_district

    return ground_truth


# ── Historical trend for a county ───────────────────────────

def get_historical_trend(
    county: str,
    election_type: str = "mayor",
    min_year: int = 2010,
) -> list[dict]:
    """Get vote share trends across multiple elections for a county.

    Returns: [{ad_year, candidate_name, party_name, party_spectrum, vote_share_pct}]
    Useful for calibrating time-stable parameters like incumbency_bonus.
    """
    if _us_db is not None:
        return _us_db.get_historical_trend(county, election_type, min_year)
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT e.ad_year, c.name AS candidate_name,
                   p.name AS party_name, p.spectrum AS party_spectrum,
                   c.is_incumbent,
                   ROUND(SUM(vr.vote_count)::NUMERIC /
                         NULLIF(SUM(SUM(vr.vote_count)) OVER (PARTITION BY e.id), 0) * 100, 2) AS vote_share_pct
            FROM vote_results vr
            JOIN elections e ON e.id = vr.election_id
            JOIN candidates c ON c.id = vr.candidate_id
            LEFT JOIN parties p ON p.id = c.party_id
            JOIN regions r ON r.id = vr.region_id
            WHERE e.election_type = %s
              AND e.ad_year >= %s
              AND r.county = %s
            GROUP BY e.id, e.ad_year, c.name, p.name, p.spectrum, c.is_incumbent
            ORDER BY e.ad_year, vote_share_pct DESC
        """, (election_type, min_year, county))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


# ── Party spectrum summary ──────────────────────────────────

def get_spectrum_summary(
    county: str,
    election_type: str = "president",
    ad_year: int | None = None,
) -> dict:
    """Get blue/green/white vote share summary for a county.

    Returns: {"blue": pct, "green": pct, "white": pct, "other": pct}
    If ad_year is None, returns the most recent election.
    """
    if _us_db is not None:
        return _us_db.get_spectrum_summary(county, election_type, ad_year)
    with _db() as conn:
        cur = conn.cursor()
        year_clause = "AND e.ad_year = %s" if ad_year else ""
        limit = "" if ad_year else "LIMIT 1"

        # First get the election
        sql = f"""
            SELECT e.id, e.ad_year FROM elections e
            WHERE e.election_type = %s AND e.scope = %s {year_clause}
            ORDER BY e.ad_year DESC {limit}
        """
        params: list = [election_type, county]
        if ad_year:
            params.append(ad_year)
        cur.execute(sql, params)
        row = cur.fetchone()
        if not row:
            # Try scope='全國' for national elections
            params[1] = "全國"
            cur.execute(sql, params)
            row = cur.fetchone()
        if not row:
            return {"blue": 0, "green": 0, "white": 0, "other": 0}

        eid = row[0]

        cur.execute("""
            SELECT p.spectrum, SUM(vr.vote_count) AS total
            FROM vote_results vr
            JOIN candidates c ON c.id = vr.candidate_id
            LEFT JOIN parties p ON p.id = c.party_id
            JOIN regions r ON r.id = vr.region_id
            WHERE vr.election_id = %s AND r.county = %s
            GROUP BY p.spectrum
        """, (eid, county))

        totals: dict[str, int] = {}
        for spectrum, total in cur.fetchall():
            s = spectrum or "other"
            totals[s] = totals.get(s, 0) + total

        grand_total = sum(totals.values()) or 1
        return {
            "blue": round(totals.get("blue", 0) / grand_total * 100, 1),
            "green": round(totals.get("green", 0) / grand_total * 100, 1),
            "white": round(totals.get("white", 0) / grand_total * 100, 1),
            "other": round(totals.get("other", 0) / grand_total * 100, 1),
            "election_year": row[1],
        }


# ── Build ProjectConfig from census data ────────────────────

# Mapping: census table_number suffix → dimension config
_AGE_BINS = [
    ("未滿15歲_人", "0-14"),
    ("年齡_24歲_人", "15-24"),
    ("年齡_34歲_人", "25-34"),
    ("年齡_44歲_人", "35-44"),
    ("年齡_54歲_人", "45-54"),
    ("年齡_64歲_人", "55-64"),
    ("年齡_65歲以上_人", "65+"),
]

_EDUCATION_CATS = [
    ("國小及以下_人", "國小及以下"),
    ("國中_初中_人", "國中"),
    ("高級中等_人", "高中職"),
    ("大專及以上_人", "大專及以上"),
]

_MARRIAGE_CATS = [
    ("未婚_人", "未婚"),
    ("有配偶或同居伴侶_人", "已婚"),
    ("離婚或分居_人", "離婚"),
    ("喪偶_人", "喪偶"),
]


def build_project_config(
    county: str,
    districts: list[str] | None = None,
    ad_year: int = 2020,
    include_dims: list[str] | None = None,
) -> dict:
    """Build a ProjectConfig dict from census DB data.

    This produces the same format as the ingestion parser, so it can be
    saved into a workspace's sources/ directory and fed to the synthesis service.

    Args:
        county: e.g. "臺中市"
        districts: list of districts to include (None = all)
        ad_year: census year (default 2020)
        include_dims: which dimensions to include (None = all available)
            options: "age", "gender", "education", "marital_status", "occupation"
    """
    if include_dims is None:
        include_dims = ["age", "gender", "education", "marital_status", "occupation"]

    with _db() as conn:
        cur = conn.cursor()

        # Find all census datasets for this county
        # Table numbers are like "臺中市_年齡", "臺中市_性比例", etc.
        table_prefix = f"{county}_"

        # ── Get all districts with population ──
        cur.execute("""
            SELECT cd.district, cd.metric_value
            FROM census_data cd
            JOIN census_datasets ds ON ds.id = cd.dataset_id
            WHERE ds.table_number = %s AND ds.ad_year = %s
              AND cd.metric_name = '常住人口數_總計_人'
              AND cd.district IS NOT NULL AND cd.district != %s
              AND cd.gender IS NULL
            ORDER BY cd.metric_value DESC
        """, (f"{county}_性比例", ad_year, county))

        all_districts_pop: dict[str, float] = {}
        for row in cur.fetchall():
            all_districts_pop[row[0]] = float(row[1])

        if not all_districts_pop:
            return {}

        # Filter districts if specified
        if districts:
            all_districts_pop = {d: p for d, p in all_districts_pop.items() if d in districts}

        total_pop = sum(all_districts_pop.values())
        if total_pop == 0:
            return {}

        district_names = sorted(all_districts_pop.keys())

        # ── Build dimensions (county-level aggregated) ──
        dimensions: dict = {}

        # District dimension
        dimensions["district"] = {
            "type": "categorical",
            "categories": [
                {"value": d, "weight": round(all_districts_pop[d] / total_pop, 6)}
                for d in district_names
            ],
        }

        # Gender
        if "gender" in include_dims:
            cur.execute("""
                SELECT SUM(CASE WHEN cd.metric_name = '常住人口數_男_人' THEN cd.metric_value ELSE 0 END) AS male,
                       SUM(CASE WHEN cd.metric_name = '常住人口數_女_人' THEN cd.metric_value ELSE 0 END) AS female
                FROM census_data cd
                JOIN census_datasets ds ON ds.id = cd.dataset_id
                WHERE ds.table_number = %s AND ds.ad_year = %s
                  AND cd.district IN %s AND cd.gender IS NULL
            """, (f"{county}_性比例", ad_year, tuple(district_names)))
            row = cur.fetchone()
            if row and row[0] and row[1]:
                gt = float(row[0]) + float(row[1])
                if gt > 0:
                    dimensions["gender"] = {
                        "type": "categorical",
                        "categories": [
                            {"value": "男", "weight": round(float(row[0]) / gt, 4)},
                            {"value": "女", "weight": round(float(row[1]) / gt, 4)},
                        ],
                    }

        # Age
        if "age" in include_dims:
            age_totals: dict[str, float] = {}
            for metric, label in _AGE_BINS:
                cur.execute("""
                    SELECT SUM(cd.metric_value)
                    FROM census_data cd
                    JOIN census_datasets ds ON ds.id = cd.dataset_id
                    WHERE ds.table_number = %s AND ds.ad_year = %s
                      AND cd.metric_name = %s
                      AND cd.district IN %s AND cd.gender IS NULL
                """, (f"{county}_年齡", ad_year, metric, tuple(district_names)))
                val = cur.fetchone()
                if val and val[0]:
                    age_totals[label] = float(val[0])

            age_grand = sum(age_totals.values())
            if age_grand > 0:
                dimensions["age"] = {
                    "type": "range",
                    "bins": [
                        {"range": label, "weight": round(age_totals.get(label, 0) / age_grand, 4)}
                        for _, label in _AGE_BINS
                        if age_totals.get(label, 0) > 0
                    ],
                }

        # Education
        if "education" in include_dims:
            edu_totals: dict[str, float] = {}
            for metric, label in _EDUCATION_CATS:
                cur.execute("""
                    SELECT SUM(cd.metric_value)
                    FROM census_data cd
                    JOIN census_datasets ds ON ds.id = cd.dataset_id
                    WHERE ds.table_number = %s AND ds.ad_year = %s
                      AND cd.metric_name = %s
                      AND cd.district IN %s AND cd.gender IS NULL
                """, (f"{county}_教育", ad_year, metric, tuple(district_names)))
                val = cur.fetchone()
                if val and val[0]:
                    edu_totals[label] = float(val[0])

            edu_grand = sum(edu_totals.values())
            if edu_grand > 0:
                dimensions["education"] = {
                    "type": "categorical",
                    "categories": [
                        {"value": label, "weight": round(edu_totals.get(label, 0) / edu_grand, 4)}
                        for _, label in _EDUCATION_CATS
                        if edu_totals.get(label, 0) > 0
                    ],
                }

        # Marital status
        if "marital_status" in include_dims:
            mar_totals: dict[str, float] = {}
            for metric, label in _MARRIAGE_CATS:
                cur.execute("""
                    SELECT SUM(cd.metric_value)
                    FROM census_data cd
                    JOIN census_datasets ds ON ds.id = cd.dataset_id
                    WHERE ds.table_number = %s AND ds.ad_year = %s
                      AND cd.metric_name = %s
                      AND cd.district IN %s AND cd.gender IS NULL
                """, (f"{county}_婚姻", ad_year, metric, tuple(district_names)))
                val = cur.fetchone()
                if val and val[0]:
                    mar_totals[label] = float(val[0])

            mar_grand = sum(mar_totals.values())
            if mar_grand > 0:
                dimensions["marital_status"] = {
                    "type": "categorical",
                    "categories": [
                        {"value": label, "weight": round(mar_totals.get(label, 0) / mar_grand, 4)}
                        for _, label in _MARRIAGE_CATS
                        if mar_totals.get(label, 0) > 0
                    ],
                }

        # Occupation (simplified from work status)
        if "occupation" in include_dims:
            occ_metrics = [
                ("有工作_農林漁牧業_人", "農林漁牧"),
                ("有工作_工業_製造業_人", "製造業"),
                ("有工作_工業_營建工程業_人", "營建業"),
                ("有工作_服務業_批發及零售業_人", "批發零售"),
                ("有工作_服務業_住宿及餐飲業_人", "住宿餐飲"),
                ("有工作_服務業_教育業_人", "教育"),
                ("有工作_服務業_醫療保健及社會工作服務業_人", "醫療"),
                ("有工作_服務業_公共行政及國防_強制性社會安全_人", "公務員"),
                ("有工作_服務業_金融及保險業_人", "金融保險"),
                ("有工作_服務業_運輸及倉儲業_人", "運輸倉儲"),
                ("有工作_服務業_其他服務業_人", "其他服務業"),
                ("無工作_人", "無工作"),
            ]
            occ_totals: dict[str, float] = {}
            for metric, label in occ_metrics:
                cur.execute("""
                    SELECT SUM(cd.metric_value)
                    FROM census_data cd
                    JOIN census_datasets ds ON ds.id = cd.dataset_id
                    WHERE ds.table_number = %s AND ds.ad_year = %s
                      AND cd.metric_name = %s
                      AND cd.district IN %s AND cd.gender IS NULL
                """, (f"{county}_工作", ad_year, metric, tuple(district_names)))
                val = cur.fetchone()
                if val and val[0]:
                    occ_totals[label] = float(val[0])

            occ_grand = sum(occ_totals.values())
            if occ_grand > 0:
                dimensions["occupation"] = {
                    "type": "categorical",
                    "categories": [
                        {"value": label, "weight": round(occ_totals.get(label, 0) / occ_grand, 4)}
                        for _, label in occ_metrics
                        if occ_totals.get(label, 0) > 0
                    ],
                }

        # ── Build district_profiles (per-district dimensions) ──
        district_profiles: dict = {}
        for dist in district_names:
            dp: dict = {"name": dist, "population": int(all_districts_pop[dist]), "dimensions": {}}

            # Per-district age
            if "age" in dimensions:
                d_age: dict[str, float] = {}
                for metric, label in _AGE_BINS:
                    cur.execute("""
                        SELECT cd.metric_value FROM census_data cd
                        JOIN census_datasets ds ON ds.id = cd.dataset_id
                        WHERE ds.table_number = %s AND ds.ad_year = %s
                          AND cd.metric_name = %s AND cd.district = %s AND cd.gender IS NULL
                    """, (f"{county}_年齡", ad_year, metric, dist))
                    val = cur.fetchone()
                    if val and val[0]: d_age[label] = float(val[0])
                d_total = sum(d_age.values())
                if d_total > 0:
                    dp["dimensions"]["age"] = {
                        "type": "range",
                        "bins": [{"range": l, "weight": round(d_age.get(l, 0) / d_total, 4)} for _, l in _AGE_BINS if d_age.get(l, 0) > 0],
                    }

            # Per-district education
            if "education" in dimensions:
                d_edu: dict[str, float] = {}
                for metric, label in _EDUCATION_CATS:
                    cur.execute("""
                        SELECT cd.metric_value FROM census_data cd
                        JOIN census_datasets ds ON ds.id = cd.dataset_id
                        WHERE ds.table_number = %s AND ds.ad_year = %s
                          AND cd.metric_name = %s AND cd.district = %s AND cd.gender IS NULL
                    """, (f"{county}_教育", ad_year, metric, dist))
                    val = cur.fetchone()
                    if val and val[0]: d_edu[label] = float(val[0])
                d_total = sum(d_edu.values())
                if d_total > 0:
                    dp["dimensions"]["education"] = {
                        "type": "categorical",
                        "categories": [{"value": l, "weight": round(d_edu.get(l, 0) / d_total, 4)} for _, l in _EDUCATION_CATS if d_edu.get(l, 0) > 0],
                    }

            district_profiles[dist] = dp

        return {
            "name": f"{ad_year}年{county}人口普查",
            "region": county,
            "locale": "zh-TW",
            "dimensions": dimensions,
            "district_profiles": district_profiles,
            "joint_tables": [],
            "cross_correlations": [],
        }


def list_census_counties(ad_year: int = 2020) -> list[dict]:
    """List counties that have census data, with district count and population."""
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT cd.county,
                   COUNT(DISTINCT cd.district) FILTER (WHERE cd.district IS NOT NULL AND cd.district != cd.county) AS district_count,
                   COUNT(DISTINCT ds.table_number) AS dataset_count
            FROM census_data cd
            JOIN census_datasets ds ON ds.id = cd.dataset_id
            WHERE ds.ad_year = %s
            GROUP BY cd.county
            ORDER BY cd.county
        """, (ad_year,))
        return [{"county": r[0], "districts": r[1], "datasets": r[2]} for r in cur.fetchall()]


# ── Build leaning profile from election results ────────────

# Maps DB party spectrum → leaning_profile.py spectrum labels
_SPECTRUM_TO_LEANING = {
    "green": "偏左派",
    "blue": "偏右派",
    "white": "中立",
    "other": "中立",
}


def build_leaning_profile(
    election_type: str,
    ad_year: int,
    county: str,
) -> dict:
    """Build a per-district leaning profile from election vote data.

    Returns the same format as leaning_profile.py's save_profile():
    {
        "description": "...",
        "spectrum": ["偏左派", "中立", "偏右派"],
        "count": 29,
        "districts": {
            "西屯區": {"偏左派": 0.37, "中立": 0.30, "偏右派": 0.33},
            ...
        }
    }
    """
    if _us_db is not None:
        return _us_db.build_leaning_profile(election_type, ad_year, county)
    with _db() as conn:
        cur = conn.cursor()

        # Find matching election(s)
        cur.execute("""
            SELECT e.id FROM elections e
            WHERE e.election_type = %s AND e.ad_year = %s
              AND (e.scope = %s OR e.scope = '全國')
            ORDER BY CASE WHEN e.scope = %s THEN 0 ELSE 1 END
        """, (election_type, ad_year, county, county))

        election_ids = [row[0] for row in cur.fetchall()]
        if not election_ids:
            return {}

        # Query per-district vote totals grouped by party spectrum
        cur.execute("""
            SELECT r.district, p.spectrum, SUM(vr.vote_count) AS total
            FROM vote_results vr
            JOIN candidates c ON c.id = vr.candidate_id
            LEFT JOIN parties p ON p.id = c.party_id
            JOIN regions r ON r.id = vr.region_id
            WHERE vr.election_id = ANY(%s)
              AND r.county = %s
              AND r.district IS NOT NULL
            GROUP BY r.district, p.spectrum
            ORDER BY r.district
        """, (election_ids, county))

        # Aggregate into district → {spectrum: count}
        district_totals: dict[str, dict[str, int]] = {}
        for district, spectrum, total in cur.fetchall():
            if district not in district_totals:
                district_totals[district] = {}
            leaning = _SPECTRUM_TO_LEANING.get(spectrum or "other", "中立")
            district_totals[district][leaning] = district_totals[district].get(leaning, 0) + total

        # Normalize to probabilities
        districts: dict[str, dict[str, float]] = {}
        spectrum_labels = ["偏左派", "中立", "偏右派"]

        for district, counts in district_totals.items():
            grand = sum(counts.values()) or 1
            dist_profile: dict[str, float] = {}
            for s in spectrum_labels:
                dist_profile[s] = round(counts.get(s, 0) / grand, 4)
            districts[district] = dist_profile

        return {
            "description": f"{ad_year}年{county}{election_type}選舉得票分布",
            "data_sources": [f"{ad_year} {county} {election_type}"],
            "spectrum": spectrum_labels,
            "count": len(districts),
            "districts": districts,
        }


# ── DB health check ─────────────────────────────────────────

def check_db() -> dict:
    """Check if the election DB is reachable and return stats."""
    if _us_db is not None:
        return _us_db.check_db()
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM elections")
            election_count = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM vote_results")
            vote_count = cur.fetchone()[0]
            cur.execute("SELECT COUNT(DISTINCT county) FROM regions")
            county_count = cur.fetchone()[0]
            return {
                "status": "ok",
                "elections": election_count,
                "vote_records": vote_count,
                "counties": county_count,
            }
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ── Identity trends (NCCU) ────────────────────────────────────

def get_identity_trends(year: int | None = None) -> list[dict]:
    """Get Taiwanese/Chinese identity trend data from NCCU Election Study Center.

    If year is given, returns only that year's data.
    Otherwise returns all years (1992-2025).
    """
    with _db() as conn:
        cur = conn.cursor()
        if year:
            cur.execute(
                "SELECT survey_year, taiwanese, both_tw_cn, chinese, no_response "
                "FROM identity_trends WHERE survey_year = %s",
                (year,),
            )
        else:
            cur.execute(
                "SELECT survey_year, taiwanese, both_tw_cn, chinese, no_response "
                "FROM identity_trends ORDER BY survey_year"
            )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_stance_trends(year: int | None = None) -> list[dict]:
    """Get unification-independence stance trend data from NCCU.

    If year is given, returns only that year's data.
    """
    if _us_db is not None:
        return _us_db.get_stance_trends()
    with _db() as conn:
        cur = conn.cursor()
        if year:
            cur.execute(
                "SELECT survey_year, asap_unification, lean_unification, "
                "status_quo_decide, status_quo_indef, lean_independence, "
                "asap_independence, no_response "
                "FROM stance_trends WHERE survey_year = %s",
                (year,),
            )
        else:
            cur.execute(
                "SELECT survey_year, asap_unification, lean_unification, "
                "status_quo_decide, status_quo_indef, lean_independence, "
                "asap_independence, no_response "
                "FROM stance_trends ORDER BY survey_year"
            )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_stance_for_year(year: int) -> dict | None:
    """Get stance data for a specific year. If exact year not found, use nearest."""
    if _us_db is not None:
        return None  # US has no NCCU equivalent
    rows = get_stance_trends(year)
    if rows:
        return rows[0]
    with _db() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT survey_year, asap_unification, lean_unification, "
            "status_quo_decide, status_quo_indef, lean_independence, "
            "asap_independence, no_response "
            "FROM stance_trends ORDER BY ABS(survey_year - %s) LIMIT 1",
            (year,),
        )
        cols = [d[0] for d in cur.description]
        row = cur.fetchone()
        return dict(zip(cols, row)) if row else None


def get_identity_for_year(year: int) -> dict | None:
    """Get identity data for a specific year. If exact year not found, use nearest."""
    rows = get_identity_trends(year)
    if rows:
        return rows[0]
    # Fallback: find nearest year
    with _db() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT survey_year, taiwanese, both_tw_cn, chinese, no_response "
            "FROM identity_trends ORDER BY ABS(survey_year - %s) LIMIT 1",
            (year,),
        )
        cols = [d[0] for d in cur.description]
        row = cur.fetchone()
        return dict(zip(cols, row)) if row else None
