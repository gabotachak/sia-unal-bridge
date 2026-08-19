-- +goose NO TRANSACTION
-- +goose Up
-- CONCURRENTLY no corre dentro de una transacción — de ahí NO TRANSACTION.
-- SearchCourses (internal/store/course.go) hace `name ILIKE '%...%'` — el
-- wildcard inicial descarta cualquier índice btree. Medido: 41ms, Seq Scan
-- completo sobre las 28 246 filas de course, por cada búsqueda, sin pasar por
-- SIA (docs/API.md "la búsqueda global no dispara al SIA" — 100% expuesto a
-- carga de estudiantes). Con GIN trigram: 0.56ms, Bitmap Index Scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS course_name_trgm_idx
    ON course USING gin (name gin_trgm_ops);

-- +goose Down
DROP INDEX IF EXISTS course_name_trgm_idx;
DROP EXTENSION IF EXISTS pg_trgm;
