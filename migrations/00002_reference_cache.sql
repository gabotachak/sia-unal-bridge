-- +goose Up
-- The reference cache had no TTL marker: `program` rows said WHICH programs
-- were known, nothing said WHEN the faculty→program cascade last ran, so
-- every faculty/program read walked it live — ~15 POSTs — instead of
-- honouring the 30 d default in docs/API.md "Frescura". The sedes were worse
-- still: a hardcoded slice in the HTTP layer, so a rename or a new campus
-- (SEDE DE LA PAZ is recent) needed a redeploy.
--
-- One marker table for the whole reference cache, keyed by scope, rather
-- than one bespoke table per list.
CREATE TABLE reference_fetch (
    scope      text PRIMARY KEY,          -- 'campuses:0', 'programs:1101:0'
    fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Sedes come off the soc9 dropdown like every other reference list, so they
-- cache like every other reference list.
CREATE TABLE campus (
    level      smallint NOT NULL,         -- soc1; soc9 is nominally per level
    code       text NOT NULL,             -- '1101'
    name       text NOT NULL,             -- 'SEDE BOGOTÁ'

    -- soc9 position. VOLATILE, same rule as program's *_idx columns: a
    -- navigation coordinate, never an identity and never in a URL.
    campus_idx smallint NOT NULL,
    PRIMARY KEY (level, code)
);

-- +goose Down
DROP TABLE campus;
DROP TABLE reference_fetch;
