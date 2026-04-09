-- ============================================================
-- 臺灣民眾臺灣人/中國人認同趨勢分佈
-- Source: 國立政治大學選舉研究中心 (NCCU Election Study Center)
-- 1992.06 ~ 2025.12
-- ============================================================

CREATE TABLE IF NOT EXISTS identity_trends (
    id          SERIAL PRIMARY KEY,
    survey_year SMALLINT NOT NULL UNIQUE,
    taiwanese   NUMERIC(4,1) NOT NULL,  -- 臺灣人認同 (%)
    both_tw_cn  NUMERIC(4,1) NOT NULL,  -- 都是（臺灣人也是中國人）(%)
    chinese     NUMERIC(4,1) NOT NULL,  -- 中國人認同 (%)
    no_response NUMERIC(4,1) NOT NULL,  -- 無反應 (%)
    source      TEXT DEFAULT '政治大學選舉研究中心',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identity_year ON identity_trends (survey_year);

INSERT INTO identity_trends (survey_year, taiwanese, both_tw_cn, chinese, no_response) VALUES
    (1992, 17.6, 46.4, 25.5, 10.5),
    (1993, 17.3, 49.3, 24.6,  8.9),
    (1994, 20.2, 44.6, 24.2, 11.0),
    (1995, 25.0, 44.6, 20.0, 10.4),
    (1996, 24.1, 48.3, 17.6, 10.0),
    (1997, 36.2, 43.3, 13.2,  7.3),
    (1998, 36.9, 39.6, 12.5, 11.0),
    (1999, 39.6, 42.5, 12.1,  5.8),
    (2000, 36.9, 44.1,  8.3, 10.7),
    (2001, 41.6, 42.5,  8.9,  7.0),
    (2002, 41.5, 39.6,  8.3, 10.6),
    (2003, 43.7, 44.3,  7.2,  4.8),
    (2004, 41.5, 44.1,  6.5,  7.9),
    (2005, 45.1, 43.5,  5.4,  6.0),
    (2006, 44.1, 44.7,  4.6,  6.6),
    (2007, 43.7, 44.5,  5.4,  6.4),
    (2008, 48.4, 43.1,  4.0,  4.5),
    (2009, 51.6, 40.8,  4.1,  3.5),
    (2010, 52.7, 39.8,  3.7,  3.8),
    (2011, 54.8, 38.5,  3.4,  3.3),
    (2012, 53.7, 39.8,  3.6,  2.9),
    (2013, 57.5, 33.6,  3.2,  5.7),
    (2014, 60.6, 32.5,  3.5,  3.4),
    (2015, 59.3, 33.6,  3.4,  3.7),
    (2016, 58.2, 33.9,  3.4,  4.5),
    (2017, 56.0, 37.0,  3.6,  3.4),
    (2018, 54.5, 38.2,  3.2,  4.1),
    (2019, 56.9, 37.0,  3.5,  2.6),
    (2020, 64.3, 29.9,  2.4,  3.4),
    (2021, 63.3, 30.4,  2.6,  3.7),
    (2022, 60.8, 32.9,  2.4,  3.9),
    (2023, 61.7, 30.3,  2.5,  5.5),
    (2024, 61.7, 31.6,  2.4,  4.3),
    (2025, 62.0, 31.7,  1.8,  4.5)
ON CONFLICT (survey_year) DO UPDATE SET
    taiwanese   = EXCLUDED.taiwanese,
    both_tw_cn  = EXCLUDED.both_tw_cn,
    chinese     = EXCLUDED.chinese,
    no_response = EXCLUDED.no_response;
