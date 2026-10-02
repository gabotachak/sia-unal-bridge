-- +goose NO TRANSACTION
-- +goose Up
-- SearchCourses tiene que encontrar "Cálculo" con ?q=calculo: los estudiantes
-- escriben sin tildes y los nombres del SIA las llevan. unaccent() no es
-- IMMUTABLE (depende del diccionario configurado), así que no puede indexarse
-- directo; f_unaccent fija el diccionario y sí puede.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;
-- +goose StatementEnd

CREATE INDEX CONCURRENTLY IF NOT EXISTS course_name_unaccent_trgm_idx
    ON course USING gin (f_unaccent(name) gin_trgm_ops);

-- El índice anterior era sobre name crudo y la búsqueda ya no lo usa.
DROP INDEX CONCURRENTLY IF EXISTS course_name_trgm_idx;

-- +goose Down
CREATE INDEX CONCURRENTLY IF NOT EXISTS course_name_trgm_idx
    ON course USING gin (name gin_trgm_ops);
DROP INDEX CONCURRENTLY IF EXISTS course_name_unaccent_trgm_idx;
DROP FUNCTION IF EXISTS f_unaccent(text);
DROP EXTENSION IF EXISTS unaccent;
