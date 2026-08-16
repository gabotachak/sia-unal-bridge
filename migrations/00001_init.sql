-- +goose Up
-- ─── reference: los dropdowns del SIA, TTL de 30 d ────────────────
-- Nivel, sede, facultad y plan son datos que el SIA posee, no constantes
-- nuestras. Se cachean con el mismo marcador y la misma regla que todo lo
-- demás: ir al SIA solo si falta o está viejo (docs/API.md "Frescura").
--
-- Regla que atraviesa todo el esquema: **el índice de un dropdown nunca es
-- identidad**. Es una posición, el SIA la puede renumerar, y una identidad
-- pública que se mueve rompe las URLs de los clientes (GOTCHAS §26). Los
-- `*_idx` son coordenadas de navegación; las PK son códigos y slugs.
CREATE TABLE reference_fetch (             -- marcador de TTL, uno por lista
    scope      text PRIMARY KEY,           -- 'levels', 'campuses:pregrado', 'programs:1101:pregrado'
    fetched_at timestamptz NOT NULL DEFAULT now()
);

-- soc1. El único dropdown cuyas etiquetas NO traen código institucional
-- ('Pregrado', no '1101 SEDE BOGOTÁ'), así que la regla de "primer token =
-- código" no aplica: daría code='Postgrados', name='y másteres'. La única
-- identidad estable disponible es el slug que docs/API.md ya publica.
CREATE TABLE level (
    slug      text PRIMARY KEY,            -- id público: 'pregrado'. Se asigna UNA vez
    name      text NOT NULL,               -- etiqueta del SIA: 'Pregrado'
    level_idx smallint NOT NULL,           -- posición soc1. VOLÁTIL

    -- El descubrimiento casa por etiqueta: un soc1 reordenado mueve
    -- level_idx, jamás reasigna un slug.
    UNIQUE (name)
);

-- Los tres slugs publicados (docs/API.md "Identificadores"), sembrados para
-- que el contrato sobreviva al primer contacto con el dropdown vivo.
-- level_idx se refresca desde el SIA en la primera lectura.
INSERT INTO level (slug, name, level_idx) VALUES
    ('pregrado',  'Pregrado',              0),
    ('doctorado', 'Doctorado',             1),
    ('posgrado',  'Postgrados y másteres', 2);

-- soc9. Va por slug de nivel, no por índice: esto es media PK, o sea
-- identidad.
CREATE TABLE campus (
    level_slug text NOT NULL REFERENCES level(slug) ON DELETE CASCADE,
    code       text NOT NULL,              -- '1101'
    name       text NOT NULL,              -- 'SEDE BOGOTÁ'
    campus_idx smallint NOT NULL,          -- posición soc9. VOLÁTIL
    PRIMARY KEY (level_slug, code)
);

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

    -- Identidad, no posición: el directorio se cachea por (sede, nivel) y hay
    -- que poder LEERLO por nivel. Con el índice de soc1 en su lugar, un
    -- reordenamiento del dropdown mezclaría pregrado con doctorado.
    level_slug   text NOT NULL REFERENCES level(slug) ON DELETE CASCADE,
    name         text,                     -- 'INGENIERÍA DE SISTEMAS Y COMPUTACIÓN'
    campus_name  text,                     -- 'SEDE BOGOTÁ'
    faculty_name text,                     -- 'FACULTAD DE INGENIERÍA'

    -- navigation coordinate: positional dropdown indices. VOLATILE.
    -- Never an identity, never in a URL. Revalidated against the label
    -- before use.
    level_idx    smallint NOT NULL,        -- soc1
    campus_idx   smallint NOT NULL,        -- soc9
    faculty_idx  smallint NOT NULL,        -- soc2
    program_idx  smallint NOT NULL,        -- soc3

    catalog_fetched_at timestamptz,        -- drives the catalog cache TTL

    -- NOT UNIQUE (code): 136 of 852 codes repeat across campuses (PEAMA).
    -- See GOTCHAS.md §26. Ese es el motivo de que /v1/programs/{code} sin
    -- ?campus= pueda devolver 300.
    UNIQUE (campus_code, faculty_code, code, level_slug)
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
DROP TABLE campus;
DROP TABLE level;
DROP TABLE reference_fetch;
