-- +goose Up
-- Levels were a hardcoded 3-value slice in the HTTP layer. They are the
-- soc1 dropdown, so they cache like every other reference list — and if the
-- UNAL ever adds a fourth, it shows up without a redeploy.
--
-- The catch soc1 has and soc9/soc2/soc3 don't: its labels carry NO
-- institutional code ('Pregrado', not '1101 SEDE BOGOTÁ'). The only stable
-- public identity available is the slug docs/API.md already publishes, so
-- the slug is the primary key and is assigned ONCE — never rewritten from a
-- re-render, because a public ID that moves is exactly the failure GOTCHAS
-- §26 warns about for the positional indices.
CREATE TABLE level (
    slug      text PRIMARY KEY,          -- public id: 'pregrado'
    name      text NOT NULL,             -- SIA label: 'Pregrado'

    -- soc1 position. VOLATILE, same rule as every other *_idx column.
    level_idx smallint NOT NULL,

    -- Discovery matches on the label, not the position: a reshuffled soc1
    -- must move level_idx, never reassign a slug.
    UNIQUE (name)
);

-- The three published slugs (docs/API.md "Identificadores"), seeded so the
-- contract survives first contact with the live dropdown. level_idx is
-- refreshed from the SIA on the first read; these values are only the
-- bootstrap.
INSERT INTO level (slug, name, level_idx) VALUES
    ('pregrado',  'Pregrado',              0),
    ('doctorado', 'Doctorado',             1),
    ('posgrado',  'Postgrados y másteres', 2);

-- +goose Down
DROP TABLE level;
