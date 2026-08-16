package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// ReferenceFetchedAt reports when the cascade behind `scope` last ran. nil
// means never — the reference cache is cold and the 30 d TTL of docs/API.md
// "Frescura" has nothing to measure against.
func (s *Store) ReferenceFetchedAt(ctx context.Context, scope string) (*time.Time, error) {
	var t time.Time
	err := s.pool.QueryRow(ctx, `SELECT fetched_at FROM reference_fetch WHERE scope = $1`, scope).Scan(&t)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("store: ReferenceFetchedAt: %w", err)
	}
	return &t, nil
}

// UpsertPrograms persists a whole cascade pass — every faculty and every
// program under one (campus, level) — and stamps scope, in one transaction.
// Atomicity matters: a stamp written over a partial program set makes the
// cache look fresh while being incomplete, the silent failure this project
// exists to avoid.
//
// catalog_fetched_at is deliberately untouched (UpsertCatalog owns it, same
// as UpsertProgram): knowing a program EXISTS says nothing about whether its
// course list is cached.
func (s *Store) UpsertPrograms(ctx context.Context, scope string, programs []catalog.Program) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		for _, p := range programs {
			if _, err := tx.Exec(ctx, `
				INSERT INTO program (campus_code, faculty_code, code, level_slug, name, campus_name, faculty_name, level_idx, campus_idx, faculty_idx, program_idx)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
				ON CONFLICT (campus_code, faculty_code, code, level_slug) DO UPDATE SET
					level_idx = EXCLUDED.level_idx,
					name = EXCLUDED.name,
					campus_name = EXCLUDED.campus_name,
					faculty_name = EXCLUDED.faculty_name,
					campus_idx = EXCLUDED.campus_idx,
					faculty_idx = EXCLUDED.faculty_idx,
					program_idx = EXCLUDED.program_idx`,
				p.CampusCode, p.FacultyCode, p.Code, p.LevelSlug, p.Name, p.CampusName, p.FacultyName,
				p.LevelIdx, p.CampusIdx, p.FacultyIdx, p.ProgramIdx,
			); err != nil {
				return fmt.Errorf("store: UpsertPrograms: program %s: %w", p.Code, err)
			}
		}
		return stampReference(ctx, tx, scope)
	})
}

// UpsertCampuses persists the soc9 dropdown for one level and stamps scope,
// same contract as UpsertPrograms.
func (s *Store) UpsertCampuses(ctx context.Context, scope string, campuses []catalog.Campus) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		for _, c := range campuses {
			if _, err := tx.Exec(ctx, `
				INSERT INTO campus (level_slug, code, name, campus_idx)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (level_slug, code) DO UPDATE SET
					name = EXCLUDED.name,
					campus_idx = EXCLUDED.campus_idx`,
				c.LevelSlug, c.Code, c.Name, c.Index,
			); err != nil {
				return fmt.Errorf("store: UpsertCampuses: campus %s: %w", c.Code, err)
			}
		}
		return stampReference(ctx, tx, scope)
	})
}

// UpsertLevels persists the soc1 dropdown and stamps scope. The conflict
// target is `name`, NOT `slug`: a reshuffled soc1 must move level_idx, never
// reassign the public ID. A label the table has never seen is a genuinely
// new level and gets inserted with the slug the caller derived.
func (s *Store) UpsertLevels(ctx context.Context, scope string, levels []catalog.Level) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		for _, l := range levels {
			if _, err := tx.Exec(ctx, `
				INSERT INTO level (slug, name, level_idx)
				VALUES ($1, $2, $3)
				ON CONFLICT (name) DO UPDATE SET level_idx = EXCLUDED.level_idx`,
				l.Slug, l.Name, l.Index,
			); err != nil {
				return fmt.Errorf("store: UpsertLevels: level %q: %w", l.Name, err)
			}
		}
		return stampReference(ctx, tx, scope)
	})
}

// Levels lists the cached niveles, ordered by soc1 position — the SIA's own
// order is the meaningful one here (pregrado first), and unlike the campus
// list there are too few for alphabetical to help.
func (s *Store) Levels(ctx context.Context) ([]catalog.Level, error) {
	rows, err := s.pool.Query(ctx, `SELECT slug, name, level_idx FROM level ORDER BY level_idx`)
	if err != nil {
		return nil, fmt.Errorf("store: Levels: %w", err)
	}
	defer rows.Close()

	var out []catalog.Level
	for rows.Next() {
		var l catalog.Level
		if err := rows.Scan(&l.Slug, &l.Name, &l.Index); err != nil {
			return nil, fmt.Errorf("store: Levels: scan: %w", err)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func stampReference(ctx context.Context, tx pgx.Tx, scope string) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO reference_fetch (scope, fetched_at) VALUES ($1, now())
		ON CONFLICT (scope) DO UPDATE SET fetched_at = now()`,
		scope,
	); err != nil {
		return fmt.Errorf("store: stampReference %q: %w", scope, err)
	}
	return nil
}

// Campuses lists the cached sedes of a level, ordered by name so the API's
// output doesn't depend on soc9's volatile positions.
func (s *Store) Campuses(ctx context.Context, levelSlug string) ([]catalog.Campus, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT level_slug, code, name, campus_idx FROM campus WHERE level_slug = $1 ORDER BY name`, levelSlug)
	if err != nil {
		return nil, fmt.Errorf("store: Campuses: %w", err)
	}
	defer rows.Close()

	var out []catalog.Campus
	for rows.Next() {
		var c catalog.Campus
		if err := rows.Scan(&c.LevelSlug, &c.Code, &c.Name, &c.Index); err != nil {
			return nil, fmt.Errorf("store: Campuses: scan: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
