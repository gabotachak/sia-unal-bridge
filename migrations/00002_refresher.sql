-- +goose Up
-- ─── cupos: separar "cuándo se midió" de "cuándo cambió" ──────────
-- seat_snapshot es append-only y los cupos casi nunca cambian: 0 cambios en
-- 347 grupos a lo largo de 35 min (medido). Un barrido cada 15 min escribiría
-- ~288 000 filas al día para almacenar una recta.
--
-- No basta con "insertar solo si cambió": measured_at es lo que la API usa
-- para decidir frescura y publicar age_seconds, así que sin insertar el dato
-- PARECE viejo y el read-through vuelve a pedirlo — el job causando
-- exactamente los POSTs que existe para evitar.
--
--   section.seats_checked_at     → se actualiza en CADA medición (frescura)
--   max(seat_snapshot.measured_at) → solo cuando el número cambió (historial)
ALTER TABLE section ADD COLUMN seats_checked_at timestamptz;

-- Las filas ya escritas se midieron cuando se insertó su último snapshot.
UPDATE section SET seats_checked_at = cs.measured_at
FROM current_seats cs WHERE cs.section_id = section.id;

-- ─── demanda: qué piden los CLIENTES, no el job ───────────────────
-- El hot set del barrido de cupos sale de acá. El proxy fácil ("las que
-- tienen detail_fetched_at") funciona hoy solo porque en fase 1 el único
-- escritor es un cliente, y deja de funcionar en cuanto el barrido global
-- marque todas. Por eso la demanda se cuenta aparte, y solo httpapi escribe.
CREATE TABLE course_demand (
    campus_code       text NOT NULL,
    code              text NOT NULL,
    hits              bigint NOT NULL DEFAULT 0,
    last_requested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campus_code, code)
);

CREATE INDEX ON course_demand (campus_code, hits DESC, last_requested_at DESC);

-- ─── observabilidad de corridas ───────────────────────────────────
-- La ÚNICA tabla nueva de correctitud cero: el checkpoint del job son los
-- marcadores de frescura, no un cursor. Esto solo existe para que un fallo a
-- las 3 de la mañana en el programa 412 de 1380 sea encontrable.
CREATE TABLE refresh_run (
    id               bigserial PRIMARY KEY,
    mode             text NOT NULL,          -- reference · catalog · detail · seats
    scope            text NOT NULL DEFAULT '', -- global · plan · hot
    started_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz,
    programs_ok      int NOT NULL DEFAULT 0,
    programs_failed  int NOT NULL DEFAULT 0,
    programs_skipped int NOT NULL DEFAULT 0,
    courses_ok       int NOT NULL DEFAULT 0,
    posts            bigint NOT NULL DEFAULT 0,
    bytes            bigint NOT NULL DEFAULT 0,
    ended_reason     text                    -- done · deadline · signal · circuit_breaker · error
);

CREATE INDEX ON refresh_run (mode, started_at DESC);

-- +goose Down
DROP TABLE refresh_run;
DROP TABLE course_demand;
ALTER TABLE section DROP COLUMN seats_checked_at;
