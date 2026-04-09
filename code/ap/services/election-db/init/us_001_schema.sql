-- ============================================================
-- US Election Database — Schema
-- Mirrors the structure of ap/services/election-db/init/001_schema.sql
-- but adapted for US elections + ACS demographics.
--
-- Source data:
--   - MEDSL countypres_2000-2024 (Harvard Dataverse, CC0)
--   - US Census ACS 2024 5-year (public domain)
--   - Cook PVI computed locally from MEDSL
--
-- Apply alongside (not in place of) the TW schema. Tables are namespaced
-- with "us_" so the same Postgres database can host both Taiwan and US data.
-- ============================================================

-- ── Enum types ──

CREATE TYPE us_election_office AS ENUM (
    'president',                -- US President
    'us_senator',               -- US Senate
    'us_representative',        -- US House
    'governor',                 -- State governor
    'lt_governor',              -- Lieutenant governor
    'state_senator',            -- State senate
    'state_representative',     -- State house / assembly
    'attorney_general',
    'secretary_of_state',
    'treasurer',
    'mayor',
    'county_executive',
    'city_council',
    'school_board',
    'ballot_measure'            -- Statewide propositions / referenda
);

CREATE TYPE us_election_level AS ENUM (
    'federal',                  -- President, US Senate, US House
    'state',                    -- Governor, state legislature, statewide officers
    'local'                     -- County / city / school board
);


-- ── 1. us_states: 50 states + DC ──

CREATE TABLE us_states (
    fips            CHAR(2) PRIMARY KEY,                    -- e.g. '42' for PA
    state_po        CHAR(2) NOT NULL UNIQUE,                -- e.g. 'PA'
    name            TEXT NOT NULL UNIQUE                    -- e.g. 'Pennsylvania'
);


-- ── 2. us_counties: 3,143+ counties / parishes / planning regions ──
-- Granularity is "county equivalent" — includes Connecticut planning regions
-- (FIPS 09110..09190) and the post-2019 Alaska borough split (02063, 02066).

CREATE TABLE us_counties (
    fips            CHAR(5) PRIMARY KEY,                    -- e.g. '42003' for Allegheny County, PA
    state_fips      CHAR(2) NOT NULL REFERENCES us_states(fips),
    name            TEXT NOT NULL,                          -- e.g. 'Allegheny County'
    short_name      TEXT,                                   -- 'Allegheny'
    UNIQUE (state_fips, name)
);

CREATE INDEX idx_us_counties_state ON us_counties (state_fips);


-- ── 3. us_parties: political parties ──

CREATE TABLE us_parties (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,                   -- 'Democratic'
    short_name      TEXT,                                   -- 'D'
    color           TEXT,                                   -- hex e.g. '#1375B7'
    spectrum        TEXT                                    -- 'lean_dem' | 'tossup' | 'lean_rep'
);

-- Default rows (matches us_leaning.PARTY_LEANING)
INSERT INTO us_parties (name, short_name, color, spectrum) VALUES
    ('Democratic',          'D',  '#1375B7', 'lean_dem'),
    ('Republican',          'R',  '#D72827', 'lean_rep'),
    ('Libertarian',         'L',  '#FED105', 'lean_rep'),
    ('Green',               'G',  '#17AA5C', 'lean_dem'),
    ('Constitution',        'C',  '#A04030', 'lean_rep'),
    ('Independent',         'I',  '#888888', 'tossup'),
    ('Working Families',    'WF', '#1A9E4F', 'lean_dem'),
    ('Other',               'O',  '#666666', 'tossup')
ON CONFLICT (name) DO NOTHING;


-- ── 4. us_elections: election events ──

CREATE TABLE us_elections (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,                          -- e.g. '2024 US Presidential Election'
    office          us_election_office NOT NULL,
    level           us_election_level NOT NULL DEFAULT 'federal',
    cycle_year      SMALLINT NOT NULL,                      -- e.g. 2024
    election_date   DATE,                                   -- e.g. 2024-11-05
    scope_state_fips CHAR(2) REFERENCES us_states(fips),    -- NULL for nationwide (president, US Senate aggregate)
    source_file     TEXT,                                   -- e.g. 'medsl/countypres_2000-2024.tab'
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (office, cycle_year, scope_state_fips)
);

CREATE INDEX idx_us_elections_office_year ON us_elections (office, cycle_year);
CREATE INDEX idx_us_elections_state ON us_elections (scope_state_fips);


-- ── 5. us_candidates ──

CREATE TABLE us_candidates (
    id              SERIAL PRIMARY KEY,
    election_id     INTEGER NOT NULL REFERENCES us_elections(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,                          -- 'Joe Biden'
    party_id        INTEGER REFERENCES us_parties(id),
    party_name_raw  TEXT,                                   -- raw label as in source data
    is_incumbent    BOOLEAN DEFAULT FALSE,
    is_elected      BOOLEAN DEFAULT FALSE,
    running_mate    TEXT,                                   -- VP candidate (president only)
    constituency    TEXT,                                   -- e.g. 'PA-12' for US House districts
    notes           TEXT,

    UNIQUE (election_id, name)
);

CREATE INDEX idx_us_candidates_election ON us_candidates (election_id);
CREATE INDEX idx_us_candidates_party ON us_candidates (party_id);


-- ── 6. us_vote_results: per-candidate per-county vote counts (core table) ──

CREATE TABLE us_vote_results (
    id              BIGSERIAL PRIMARY KEY,
    election_id     INTEGER NOT NULL REFERENCES us_elections(id) ON DELETE CASCADE,
    candidate_id    INTEGER NOT NULL REFERENCES us_candidates(id) ON DELETE CASCADE,
    county_fips     CHAR(5) NOT NULL REFERENCES us_counties(fips),
    vote_count      INTEGER NOT NULL DEFAULT 0,
    vote_share      NUMERIC(6,4),                           -- precomputed county share (0.0..1.0)

    UNIQUE (election_id, candidate_id, county_fips)
);

CREATE INDEX idx_us_votes_election ON us_vote_results (election_id);
CREATE INDEX idx_us_votes_county ON us_vote_results (county_fips);
CREATE INDEX idx_us_votes_candidate ON us_vote_results (candidate_id);
CREATE INDEX idx_us_votes_election_county ON us_vote_results (election_id, county_fips);


-- ── 7. us_election_stats: per-county turnout summary ──

CREATE TABLE us_election_stats (
    id              BIGSERIAL PRIMARY KEY,
    election_id     INTEGER NOT NULL REFERENCES us_elections(id) ON DELETE CASCADE,
    county_fips     CHAR(5) NOT NULL REFERENCES us_counties(fips),
    total_votes     INTEGER,                                -- sum of all valid candidate votes (MEDSL totalvotes)
    turnout_pct     NUMERIC(5,2),                           -- if eligible_voters known
    eligible_voters INTEGER,                                -- ACS-derived voting age population (optional)

    UNIQUE (election_id, county_fips)
);

CREATE INDEX idx_us_stats_election ON us_election_stats (election_id);


-- ── 8. us_pvi: Cook PVI per county per cycle ──
-- One row per (county, reference_cycle). reference_cycle is the most-recent
-- cycle in the averaging window (e.g. 2024 for the 2020+2024 average).

CREATE TABLE us_pvi (
    county_fips         CHAR(5) NOT NULL REFERENCES us_counties(fips),
    reference_cycle     SMALLINT NOT NULL,                  -- e.g. 2024
    window_cycles       SMALLINT[] NOT NULL,                -- e.g. ARRAY[2020, 2024]
    pvi                 NUMERIC(7,4) NOT NULL,              -- continuous PVI, e.g. -0.0823
    pvi_label           TEXT NOT NULL,                      -- e.g. 'R+8'
    bucket              TEXT NOT NULL,                      -- 'Solid Dem' / 'Lean Dem' / 'Tossup' / 'Lean Rep' / 'Solid Rep'
    methodology         TEXT,                               -- 'cook_pvi_two_party_share'

    PRIMARY KEY (county_fips, reference_cycle)
);

CREATE INDEX idx_us_pvi_bucket ON us_pvi (bucket);


-- ── 9. us_census_datasets / us_census_data: ACS demographics ──

CREATE TABLE us_census_datasets (
    id              SERIAL PRIMARY KEY,
    table_id        TEXT NOT NULL,                          -- ACS table id e.g. 'B01001'
    title           TEXT,                                   -- 'Sex by Age'
    release         TEXT NOT NULL,                          -- 'acs2024_5yr'
    source          TEXT DEFAULT 'US Census Bureau',
    source_url      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (table_id, release)
);

CREATE TABLE us_census_data (
    id              BIGSERIAL PRIMARY KEY,
    dataset_id      INTEGER NOT NULL REFERENCES us_census_datasets(id) ON DELETE CASCADE,
    geo_level       TEXT NOT NULL,                          -- 'state' | 'county'
    state_fips      CHAR(2) REFERENCES us_states(fips),
    county_fips     CHAR(5) REFERENCES us_counties(fips),
    metric_name     TEXT NOT NULL,                          -- e.g. 'population_total', 'age_25_34'
    metric_value    NUMERIC,
    gender          TEXT,
    age_group       TEXT,

    UNIQUE (dataset_id, geo_level, state_fips, county_fips, metric_name, gender, age_group)
);

CREATE INDEX idx_us_census_data_dataset ON us_census_data (dataset_id);
CREATE INDEX idx_us_census_data_county ON us_census_data (county_fips);
CREATE INDEX idx_us_census_data_state ON us_census_data (state_fips);


-- ── Convenience views ─────────────────────────────────────────────────


-- View 1: county-level results with party + state names joined in.
CREATE VIEW v_us_county_results AS
SELECT
    e.id            AS election_id,
    e.name          AS election_name,
    e.office,
    e.cycle_year,
    s.state_po,
    s.name          AS state_name,
    c.fips          AS county_fips,
    c.name          AS county_name,
    cand.name       AS candidate_name,
    p.name          AS party_name,
    p.short_name    AS party_short,
    p.spectrum      AS party_spectrum,
    vr.vote_count,
    vr.vote_share,
    es.total_votes  AS county_total_votes,
    es.turnout_pct
FROM us_vote_results vr
JOIN us_elections e   ON e.id = vr.election_id
JOIN us_candidates cand ON cand.id = vr.candidate_id
LEFT JOIN us_parties p   ON p.id = cand.party_id
JOIN us_counties c    ON c.fips = vr.county_fips
JOIN us_states s      ON s.fips = c.state_fips
LEFT JOIN us_election_stats es
    ON es.election_id = vr.election_id AND es.county_fips = vr.county_fips;


-- View 2: state-level aggregation (sum across counties).
CREATE VIEW v_us_state_results AS
SELECT
    e.id            AS election_id,
    e.name          AS election_name,
    e.office,
    e.cycle_year,
    s.state_po,
    s.name          AS state_name,
    cand.name       AS candidate_name,
    p.name          AS party_name,
    p.spectrum      AS party_spectrum,
    SUM(vr.vote_count)              AS total_votes,
    ROUND(
        SUM(vr.vote_count)::NUMERIC /
        NULLIF(SUM(SUM(vr.vote_count)) OVER (PARTITION BY e.id, s.fips), 0),
        6
    )                               AS state_share
FROM us_vote_results vr
JOIN us_elections e   ON e.id = vr.election_id
JOIN us_candidates cand ON cand.id = vr.candidate_id
LEFT JOIN us_parties p   ON p.id = cand.party_id
JOIN us_counties c    ON c.fips = vr.county_fips
JOIN us_states s      ON s.fips = c.state_fips
GROUP BY e.id, e.name, e.office, e.cycle_year,
         s.fips, s.state_po, s.name,
         cand.name, p.name, p.spectrum;


-- View 3: per-county Democratic two-party share for the latest cycle.
-- Used by the calibrator to anchor predictor PVI math.
CREATE VIEW v_us_county_two_party_share AS
SELECT
    e.cycle_year,
    c.fips                                          AS county_fips,
    c.state_fips,
    SUM(CASE WHEN p.name = 'Democratic' THEN vr.vote_count ELSE 0 END) AS dem_votes,
    SUM(CASE WHEN p.name = 'Republican' THEN vr.vote_count ELSE 0 END) AS rep_votes,
    CASE
        WHEN SUM(CASE WHEN p.name IN ('Democratic','Republican') THEN vr.vote_count ELSE 0 END) > 0
        THEN ROUND(
            SUM(CASE WHEN p.name = 'Democratic' THEN vr.vote_count ELSE 0 END)::NUMERIC /
            SUM(CASE WHEN p.name IN ('Democratic','Republican') THEN vr.vote_count ELSE 0 END),
            6
        )
        ELSE NULL
    END                                             AS dem_two_party_share
FROM us_vote_results vr
JOIN us_elections e   ON e.id = vr.election_id
JOIN us_candidates cand ON cand.id = vr.candidate_id
LEFT JOIN us_parties p   ON p.id = cand.party_id
JOIN us_counties c    ON c.fips = vr.county_fips
WHERE e.office = 'president'
GROUP BY e.cycle_year, c.fips, c.state_fips;


-- View 4: PVI joined with county/state names, for UI consumption.
CREATE VIEW v_us_pvi_summary AS
SELECT
    pvi.county_fips,
    c.name          AS county_name,
    s.state_po,
    s.name          AS state_name,
    pvi.reference_cycle,
    pvi.window_cycles,
    pvi.pvi,
    pvi.pvi_label,
    pvi.bucket
FROM us_pvi pvi
JOIN us_counties c ON c.fips = pvi.county_fips
JOIN us_states s   ON s.fips = c.state_fips;
