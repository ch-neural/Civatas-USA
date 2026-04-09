-- ============================================================
-- Taiwan Election Database — Schema
-- Stores CEC (中央選舉委員會) historical election data
-- for parameter calibration and analysis.
-- ============================================================

-- ── Enum types ──

CREATE TYPE election_type AS ENUM (
    'president',           -- 總統副總統
    'legislator_regional', -- 區域立法委員
    'legislator_party',    -- 不分區立法委員（政黨票）
    'mayor',               -- 直轄市長
    'county_head',         -- 縣市長
    'township_head',       -- 鄉鎮市長
    'council',             -- 縣市議員
    'township_rep',        -- 鄉鎮市民代表
    'village_chief',       -- 村里長
    'referendum'           -- 公民投票
);

CREATE TYPE election_level AS ENUM (
    'central',   -- 中央層級（總統、立委、公投）
    'local'      -- 地方層級（縣市長、議員等）
);


-- ── 1. elections: 選舉場次 ──

CREATE TABLE elections (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,                          -- e.g. '111年臺中市市長選舉'
    election_type   election_type NOT NULL,
    election_level  election_level NOT NULL DEFAULT 'local',
    election_year   SMALLINT NOT NULL,                      -- 民國年 e.g. 111
    election_date   DATE,                                   -- 投票日 e.g. 2022-11-26
    roc_year        SMALLINT,                               -- 民國年（冗餘，方便查詢）
    ad_year         SMALLINT NOT NULL,                      -- 西元年 e.g. 2022
    scope           TEXT,                                   -- 選舉範圍 e.g. '臺中市', '全國'
    source_file     TEXT,                                   -- 來源檔案名稱
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (election_type, ad_year, scope)
);

CREATE INDEX idx_elections_type_year ON elections (election_type, ad_year);
CREATE INDEX idx_elections_scope ON elections (scope);


-- ── 2. regions: 標準化行政區 ──
-- 層級：county → district → village → polling_station
-- 不同選舉年份的行政區可能不同（合併/改制），用 code 對應

-- Granularity: district level (鄉鎮市區) — no village/polling_station detail.
-- e.g. (臺中市, 西屯區), (臺南市, 安平區), (臺北市, 信義區)

CREATE TABLE regions (
    id              SERIAL PRIMARY KEY,
    code            TEXT,                                   -- 中選會行政區代碼 e.g. '66000' (臺中市)
    county          TEXT NOT NULL,                          -- 縣市 e.g. '臺中市'
    district        TEXT,                                   -- 區/鄉鎮市 e.g. '西屯區'

    UNIQUE (county, district)
);

CREATE INDEX idx_regions_county ON regions (county);
CREATE INDEX idx_regions_county_district ON regions (county, district);


-- ── 3. parties: 政黨 ──

CREATE TABLE parties (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,                   -- e.g. '中國國民黨'
    short_name      TEXT,                                   -- e.g. '國民黨'
    color           TEXT,                                   -- 代表色 hex e.g. '#0000FF'
    spectrum        TEXT                                    -- 光譜分類: 'blue','green','white','other'
);

-- 預設資料
INSERT INTO parties (name, short_name, color, spectrum) VALUES
    ('中國國民黨',     '國民黨',    '#000095', 'blue'),
    ('民主進步黨',     '民進黨',    '#1B9431', 'green'),
    ('台灣民眾黨',     '民眾黨',    '#28C8C8', 'white'),
    ('親民黨',         '親民黨',    '#FF6310', 'blue'),
    ('時代力量',       '時力',      '#FBBE01', 'green'),
    ('台灣基進',       '基進',      '#A73F24', 'green'),
    ('新黨',           '新黨',      '#FFFF00', 'blue'),
    ('台灣團結聯盟',   '台聯',      '#C69E6A', 'green'),
    ('綠黨',           '綠黨',      '#73BF00', 'green'),
    ('無黨團結聯盟',   '無盟',      '#C0C0C0', 'other'),
    ('無黨籍及未經政黨推薦', '無黨籍', '#808080', 'other')
ON CONFLICT (name) DO NOTHING;


-- ── 4. candidates: 候選人 ──

CREATE TABLE candidates (
    id              SERIAL PRIMARY KEY,
    election_id     INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,                          -- 候選人姓名
    number          SMALLINT,                               -- 號次
    party_id        INTEGER REFERENCES parties(id),
    party_name      TEXT,                                   -- 原始政黨名稱（含括弧格式）
    gender          CHAR(1),                                -- M/F
    birth_year      SMALLINT,                               -- 出生年
    is_incumbent    BOOLEAN DEFAULT FALSE,                  -- 是否現任
    is_elected      BOOLEAN DEFAULT FALSE,                  -- 是否當選
    running_mate    TEXT,                                   -- 副手（總統選舉用）
    constituency    TEXT,                                   -- 選區（立委區域用）e.g. '臺中市第2選區'
    notes           TEXT,

    UNIQUE (election_id, name)
);

CREATE INDEX idx_candidates_election ON candidates (election_id);
CREATE INDEX idx_candidates_party ON candidates (party_id);


-- ── 5. vote_results: 得票統計（核心表）──
-- 每筆 = 一個候選人在一個行政區的得票

CREATE TABLE vote_results (
    id              BIGSERIAL PRIMARY KEY,
    election_id     INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    candidate_id    INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    region_id       INTEGER NOT NULL REFERENCES regions(id),
    vote_count      INTEGER NOT NULL DEFAULT 0,             -- 得票數
    vote_share      NUMERIC(6,2),                           -- 得票率 (%)

    UNIQUE (election_id, candidate_id, region_id)
);

CREATE INDEX idx_votes_election ON vote_results (election_id);
CREATE INDEX idx_votes_region ON vote_results (region_id);
CREATE INDEX idx_votes_candidate ON vote_results (candidate_id);
CREATE INDEX idx_votes_election_region ON vote_results (election_id, region_id);


-- ── 6. election_stats: 投票概況統計 ──
-- 每筆 = 一個選舉在一個行政區的投票概況

CREATE TABLE election_stats (
    id              BIGSERIAL PRIMARY KEY,
    election_id     INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    region_id       INTEGER NOT NULL REFERENCES regions(id),
    eligible_voters INTEGER,                                -- 選舉人數
    ballots_issued  INTEGER,                                -- 發出票數
    votes_cast      INTEGER,                                -- 投票數
    valid_votes     INTEGER,                                -- 有效票數
    invalid_votes   INTEGER,                                -- 無效票數
    unreturned      INTEGER,                                -- 已領未投票數
    remaining       INTEGER,                                -- 用餘票數
    turnout         NUMERIC(5,2),                           -- 投票率 (%)

    UNIQUE (election_id, region_id)
);

CREATE INDEX idx_stats_election ON election_stats (election_id);
CREATE INDEX idx_stats_region ON election_stats (region_id);


-- ── 7. referendum_results: 公投結果 ──

CREATE TABLE referendum_results (
    id              BIGSERIAL PRIMARY KEY,
    election_id     INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    region_id       INTEGER NOT NULL REFERENCES regions(id),
    case_number     SMALLINT NOT NULL,                      -- 公投案號 e.g. 17
    case_title      TEXT,                                   -- 案名
    agree_count     INTEGER DEFAULT 0,                      -- 同意票
    disagree_count  INTEGER DEFAULT 0,                      -- 不同意票
    valid_votes     INTEGER DEFAULT 0,
    invalid_votes   INTEGER DEFAULT 0,
    turnout         NUMERIC(5,2),

    UNIQUE (election_id, region_id, case_number)
);

CREATE INDEX idx_ref_election ON referendum_results (election_id);


-- ── 8. census_datasets: 普查資料集 ──

CREATE TABLE census_datasets (
    id              SERIAL PRIMARY KEY,
    table_number    TEXT NOT NULL,                          -- 表號 e.g. '臺中市_性比例'
    title           TEXT,                                   -- 表標題
    roc_year        SMALLINT,                               -- 民國年
    ad_year         SMALLINT,                               -- 西元年
    source          TEXT,                                   -- 來源 e.g. '行政院主計總處'
    category        TEXT,                                   -- 類別 e.g. '綜合報告'
    source_url      TEXT,                                   -- 來源網址
    source_file     TEXT,                                   -- 來源檔案
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (table_number, ad_year, category)
);

CREATE INDEX idx_census_ds_table ON census_datasets (table_number);
CREATE INDEX idx_census_ds_year ON census_datasets (ad_year);


-- ── 9. census_data: 普查數據 ──

CREATE TABLE census_data (
    id              BIGSERIAL PRIMARY KEY,
    dataset_id      INTEGER NOT NULL REFERENCES census_datasets(id) ON DELETE CASCADE,
    county          TEXT,                                   -- 縣市
    district        TEXT,                                   -- 鄉鎮市區
    metric_name     TEXT NOT NULL,                          -- 指標名稱
    metric_value    NUMERIC,                                -- 指標值
    gender          TEXT,                                   -- 性別（可為 NULL）
    age_group       TEXT,                                   -- 年齡組（可為 NULL）

    UNIQUE (dataset_id, county, district, metric_name, gender, age_group)
);

CREATE INDEX idx_census_data_dataset ON census_data (dataset_id);
CREATE INDEX idx_census_data_county ON census_data (county);
CREATE INDEX idx_census_data_district ON census_data (county, district);


-- ── 便利 View：鄉鎮市區層級得票率 ──

CREATE VIEW v_district_results AS
SELECT
    e.id AS election_id,
    e.name AS election_name,
    e.election_type,
    e.ad_year,
    e.scope,
    r.county,
    r.district,
    c.name AS candidate_name,
    c.number AS candidate_number,
    p.name AS party_name,
    p.short_name AS party_short,
    p.spectrum AS party_spectrum,
    SUM(vr.vote_count) AS total_votes,
    es_agg.total_valid,
    CASE WHEN es_agg.total_valid > 0
         THEN ROUND(SUM(vr.vote_count)::NUMERIC / es_agg.total_valid * 100, 2)
         ELSE 0 END AS vote_share_pct,
    es_agg.total_eligible,
    es_agg.total_turnout_pct
FROM vote_results vr
JOIN elections e ON e.id = vr.election_id
JOIN candidates c ON c.id = vr.candidate_id
LEFT JOIN parties p ON p.id = c.party_id
JOIN regions r ON r.id = vr.region_id
LEFT JOIN LATERAL (
    SELECT
        SUM(es.valid_votes) AS total_valid,
        SUM(es.eligible_voters) AS total_eligible,
        CASE WHEN SUM(es.eligible_voters) > 0
             THEN ROUND(SUM(es.votes_cast)::NUMERIC / SUM(es.eligible_voters) * 100, 2)
             ELSE 0 END AS total_turnout_pct
    FROM election_stats es
    JOIN regions r2 ON r2.id = es.region_id
    WHERE es.election_id = e.id
      AND r2.county = r.county
      AND r2.district = r.district
) es_agg ON TRUE
WHERE r.district IS NOT NULL
GROUP BY e.id, e.name, e.election_type, e.ad_year, e.scope,
         r.county, r.district,
         c.name, c.number, p.name, p.short_name, p.spectrum,
         es_agg.total_valid, es_agg.total_eligible, es_agg.total_turnout_pct;


-- ── 便利 View：縣市層級得票率 ──

CREATE VIEW v_county_results AS
SELECT
    e.id AS election_id,
    e.name AS election_name,
    e.election_type,
    e.ad_year,
    r.county,
    c.name AS candidate_name,
    p.name AS party_name,
    p.spectrum AS party_spectrum,
    SUM(vr.vote_count) AS total_votes,
    ROUND(
        SUM(vr.vote_count)::NUMERIC /
        NULLIF(SUM(SUM(vr.vote_count)) OVER (PARTITION BY e.id, r.county), 0) * 100,
    2) AS vote_share_pct
FROM vote_results vr
JOIN elections e ON e.id = vr.election_id
JOIN candidates c ON c.id = vr.candidate_id
LEFT JOIN parties p ON p.id = c.party_id
JOIN regions r ON r.id = vr.region_id
GROUP BY e.id, e.name, e.election_type, e.ad_year,
         r.county, c.name, p.name, p.spectrum;
