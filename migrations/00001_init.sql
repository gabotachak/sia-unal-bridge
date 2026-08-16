-- +goose Up
-- ─── catalog: cheap, near-immutable ──────────────────────────────
CREATE TABLE course (
    campus_code text NOT NULL,             -- '1101'; qualifier, see DATA-MODEL.md decision 7
    code        text NOT NULL,             -- '2016696', '1000003-B'
    name        text NOT NULL,
    credits     int,
    description text,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campus_code, code)
);

CREATE TABLE program (                     -- a degree program (UNAL "carrera")
    id           bigserial PRIMARY KEY,

    campus_code  text NOT NULL,            -- '1101'
    faculty_code text NOT NULL,            -- '2055'
    code         text NOT NULL,            -- '2A74'
    level        smallint NOT NULL,        -- soc1; fixed 3-value enum, no code
    name         text,                     -- 'INGENIERÍA DE SISTEMAS Y COMPUTACIÓN'
    campus_name  text,                     -- 'SEDE BOGOTÁ'
    faculty_name text,                     -- 'FACULTAD DE INGENIERÍA'

    -- navigation coordinate: positional dropdown indices. VOLATILE.
    -- Never an identity, never in a URL. Revalidated against the label
    -- before use.
    campus_idx   smallint NOT NULL,        -- soc9
    faculty_idx  smallint NOT NULL,        -- soc2
    program_idx  smallint NOT NULL,        -- soc3

    catalog_fetched_at timestamptz,        -- drives the catalog cache TTL

    -- NOT UNIQUE (code): 136 of 852 codes repeat across campuses (PEAMA).
    -- See GOTCHAS.md §26.
    UNIQUE (campus_code, faculty_code, code)
);

CREATE TABLE course_program (              -- M:N; typology lives HERE
    program_id  bigint REFERENCES program(id) ON DELETE CASCADE,
    campus_code text NOT NULL,             -- redundant with program_id, needed by the FK
    code        text NOT NULL,
    typology    text,                      -- 'FUND. OBLIGATORIA (B)'
    detail_fetched_at timestamptz,         -- drives the VISIBILITY cache TTL
    PRIMARY KEY (program_id, code),
    FOREIGN KEY (campus_code, code)
        REFERENCES course (campus_code, code) ON DELETE CASCADE
);

-- ─── detail: expensive, one request per course ───────────────────
CREATE TABLE section (                     -- UNAL "grupo"
    id          bigserial PRIMARY KEY,
    campus_code text NOT NULL,
    code        text NOT NULL,
    term        text NOT NULL,             -- '2026-2'

    -- The token in parentheses of the group header, verbatim: '1', '10',
    -- 'AMAZ-07', 'TUMA-01'. Natural key inside a course, not `number`.
    -- See DATA-MODEL.md decision 8.
    key         text NOT NULL,
    number      int,                       -- from 'Grupo 1'; NOT unique alone
    site        text,                      -- 'AMAZ', 'TUMA', NULL if regular
    site_campus text,                      -- group's own 'Facultad: SEDE TUMACO'

    label       text,                      -- 'Grupo 1'
    instructor  text,
    shift       text,                      -- 'DIURNO'
    duration    text,                      -- 'Semestral'
    start_date  date,
    end_date    date,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    raw         jsonb,
    UNIQUE (campus_code, code, term, key),
    FOREIGN KEY (campus_code, code)
        REFERENCES course (campus_code, code) ON DELETE CASCADE
);

CREATE TABLE section_program (             -- which programs may enroll it
    section_id bigint REFERENCES section(id) ON DELETE CASCADE,
    program_id bigint REFERENCES program(id) ON DELETE CASCADE,
    PRIMARY KEY (section_id, program_id)
);

CREATE TABLE class_session (               -- one weekly meeting of a section
    id         bigserial PRIMARY KEY,
    section_id bigint REFERENCES section(id) ON DELETE CASCADE,
    weekday    smallint NOT NULL,          -- 1=Mon .. 7=Sun
    start_time time NOT NULL,
    end_time   time NOT NULL,
    room       text,                       -- 'SALA DE INFORMATICA 453-203'
    building   text                        -- '453 - Guillermina Uribe Bone'
);

-- ─── seats: volatile, keep history ───────────────────────────────
CREATE TABLE seat_snapshot (
    section_id      bigint REFERENCES section(id) ON DELETE CASCADE,
    available_seats int NOT NULL,
    measured_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (section_id, measured_at)
);

CREATE INDEX ON seat_snapshot (section_id, measured_at DESC);

CREATE VIEW current_seats AS
SELECT DISTINCT ON (section_id) section_id, available_seats, measured_at
FROM seat_snapshot ORDER BY section_id, measured_at DESC;

-- +goose Down
DROP VIEW current_seats;
DROP TABLE seat_snapshot;
DROP TABLE class_session;
DROP TABLE section_program;
DROP TABLE section;
DROP TABLE course_program;
DROP TABLE program;
DROP TABLE course;
