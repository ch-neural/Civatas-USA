-- ============================================================
-- 臺灣民眾統獨立場趨勢分佈
-- Source: 國立政治大學選舉研究中心 (NCCU Election Study Center)
-- 1994.12 ~ 2025.12
--
-- Categories:
--   asap_unification  — 儘快統一
--   lean_unification  — 偏向統一
--   status_quo_decide — 維持現狀再決定
--   status_quo_indef  — 永遠維持現狀
--   lean_independence — 偏向獨立
--   asap_independence — 儘快獨立
--   no_response       — 無反應
-- ============================================================

CREATE TABLE IF NOT EXISTS stance_trends (
    id                  SERIAL PRIMARY KEY,
    survey_year         SMALLINT NOT NULL UNIQUE,
    asap_unification    NUMERIC(4,1) NOT NULL,  -- 儘快統一 (%)
    lean_unification    NUMERIC(4,1) NOT NULL,  -- 偏向統一 (%)
    status_quo_decide   NUMERIC(4,1) NOT NULL,  -- 維持現狀再決定 (%)
    status_quo_indef    NUMERIC(4,1) NOT NULL,  -- 永遠維持現狀 (%)
    lean_independence   NUMERIC(4,1) NOT NULL,  -- 偏向獨立 (%)
    asap_independence   NUMERIC(4,1) NOT NULL,  -- 儘快獨立 (%)
    no_response         NUMERIC(4,1) NOT NULL,  -- 無反應 (%)
    source              TEXT DEFAULT '政治大學選舉研究中心',
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stance_year ON stance_trends (survey_year);

-- Data extracted from NCCU Election Study Center chart (1994~2025.12)
INSERT INTO stance_trends (survey_year, asap_unification, lean_unification, status_quo_decide, status_quo_indef, lean_independence, asap_independence, no_response) VALUES
    (1994,  4.4, 20.0, 38.7,  9.8, 11.1,  3.1,  12.9),
    (1995,  2.7, 19.2, 28.9, 13.0, 11.5,  3.9,  20.8),
    (1996,  3.3, 16.2, 30.9, 16.9, 11.5,  4.3,  16.9),
    (1997,  3.2, 18.7, 36.5, 14.9,  8.0,  3.5,  15.2),
    (1998,  2.9, 18.5, 34.8, 17.8, 12.4,  3.3,  10.3),
    (1999,  3.1, 19.2, 36.8, 18.0, 12.4,  3.5,   7.0),
    (2000,  2.6, 15.6, 34.2, 19.9, 15.2,  4.8,   7.7),
    (2001,  3.0, 16.2, 36.8, 19.9, 15.0,  4.5,   4.6),
    (2002,  2.5, 15.2, 34.2, 19.2, 16.2,  5.0,   7.7),
    (2003,  2.5, 14.2, 36.1, 19.9, 16.2,  4.2,   6.9),
    (2004,  2.0, 12.0, 35.8, 21.1, 15.2,  5.3,   8.6),
    (2005,  2.3, 12.4, 38.6, 19.3, 15.2,  5.0,   7.2),
    (2006,  2.1, 12.0, 34.2, 19.8, 15.2,  5.2,  11.5),
    (2007,  1.3, 10.3, 33.6, 21.1, 16.2,  6.0,  11.5),
    (2008,  1.3,  9.6, 34.5, 27.7, 16.2,  4.5,   6.2),
    (2009,  1.6, 12.0, 27.7, 25.2, 18.3,  6.0,   9.2),
    (2010,  1.2,  9.2, 34.2, 25.2, 17.6,  5.5,   7.1),
    (2011,  1.5,  8.2, 33.6, 26.5, 18.0,  5.0,   7.2),
    (2012,  1.5,  8.3, 28.3, 25.2, 18.3,  5.2,  13.2),
    (2013,  1.6,  7.2, 34.2, 25.3, 18.3,  5.6,   7.8),
    (2014,  1.3,  5.5, 27.7, 25.2, 21.0,  6.5,  12.8),
    (2015,  1.5,  6.0, 33.6, 25.2, 18.3,  5.8,   9.6),
    (2016,  1.5,  5.8, 33.0, 25.3, 20.5,  5.5,   8.4),
    (2017,  1.4,  6.0, 33.6, 23.5, 20.8,  6.3,   8.4),
    (2018,  1.5,  7.1, 33.4, 23.1, 18.3,  5.8,  10.8),
    (2019,  1.4,  6.0, 28.3, 23.6, 21.5,  6.5,  12.7),
    (2020,  1.1,  5.1, 28.7, 28.8, 25.5,  7.4,   3.4),
    (2021,  1.3,  6.0, 28.3, 27.5, 25.8,  6.0,   5.1),
    (2022,  1.2,  5.2, 28.5, 28.6, 25.2,  5.1,   6.2),
    (2023,  1.6,  6.0, 28.3, 33.0, 21.4,  4.6,   5.1),
    (2024,  1.6,  5.1, 33.2, 31.2, 24.4,  3.5,   1.0),
    (2025,  1.2,  5.1, 33.5, 28.5, 21.9,  6.1,   3.7)
ON CONFLICT (survey_year) DO UPDATE SET
    asap_unification    = EXCLUDED.asap_unification,
    lean_unification    = EXCLUDED.lean_unification,
    status_quo_decide   = EXCLUDED.status_quo_decide,
    status_quo_indef    = EXCLUDED.status_quo_indef,
    lean_independence   = EXCLUDED.lean_independence,
    asap_independence   = EXCLUDED.asap_independence,
    no_response         = EXCLUDED.no_response;
