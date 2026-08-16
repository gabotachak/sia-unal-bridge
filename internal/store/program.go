package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// UpsertProgram writes the navigation coordinate and labels for a program,
// keyed by (campus_code, faculty_code, code) — NOT code alone (136 of 852
// codes repeat across campuses, GOTCHAS §26). catalog_fetched_at is left
// untouched here; UpsertCatalog owns it.
func (s *Store) UpsertProgram(ctx context.Context, p catalog.Program) (catalog.Program, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO program (campus_code, faculty_code, code, level_slug, name, campus_name, faculty_name, level_idx, campus_idx, faculty_idx, program_idx)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (campus_code, faculty_code, code, level_slug) DO UPDATE SET
			level_idx = EXCLUDED.level_idx,
			name = EXCLUDED.name,
			campus_name = EXCLUDED.campus_name,
			faculty_name = EXCLUDED.faculty_name,
			campus_idx = EXCLUDED.campus_idx,
			faculty_idx = EXCLUDED.faculty_idx,
			program_idx = EXCLUDED.program_idx
		RETURNING id, catalog_fetched_at`,
		p.CampusCode, p.FacultyCode, p.Code, p.LevelSlug, p.Name, p.CampusName, p.FacultyName,
		p.LevelIdx, p.CampusIdx, p.FacultyIdx, p.ProgramIdx,
	)
	if err := row.Scan(&p.ID, &p.CatalogFetchedAt); err != nil {
		return catalog.Program{}, fmt.Errorf("store: UpsertProgram: %w", err)
	}
	return p, nil
}

func (s *Store) Program(ctx context.Context, campusCode, facultyCode, code string) (catalog.Program, bool, error) {
	var p catalog.Program
	err := s.pool.QueryRow(ctx, `
		SELECT id, campus_code, faculty_code, code, level_slug, name, campus_name, faculty_name,
		       level_idx, campus_idx, faculty_idx, program_idx, catalog_fetched_at
		FROM program WHERE campus_code = $1 AND faculty_code = $2 AND code = $3`,
		campusCode, facultyCode, code,
	).Scan(&p.ID, &p.CampusCode, &p.FacultyCode, &p.Code, &p.LevelSlug, &p.Name, &p.CampusName, &p.FacultyName,
		&p.LevelIdx, &p.CampusIdx, &p.FacultyIdx, &p.ProgramIdx, &p.CatalogFetchedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return catalog.Program{}, false, nil
	}
	if err != nil {
		return catalog.Program{}, false, fmt.Errorf("store: Program: %w", err)
	}
	return p, true, nil
}

// Programs lists cached programs, narrowed by level and opcionalmente por
// campus y facultad.
//
// El nivel NO es opcional en la práctica: el directorio se cachea por (sede,
// nivel) y sin filtrar, pedir doctorado devolvía también los planes de
// pregrado — 107 filas donde debían ser 42. Un ” significa todos, que es lo
// que usa la búsqueda sin calificar.
func (s *Store) Programs(ctx context.Context, campusCode, facultyCode, levelSlug string) ([]catalog.Program, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, campus_code, faculty_code, code, level_slug, name, campus_name, faculty_name,
		       level_idx, campus_idx, faculty_idx, program_idx, catalog_fetched_at
		FROM program
		WHERE ($1 = '' OR campus_code = $1)
		  AND ($2 = '' OR faculty_code = $2)
		  AND ($3 = '' OR level_slug = $3)
		ORDER BY campus_code, name`,
		campusCode, facultyCode, levelSlug,
	)
	if err != nil {
		return nil, fmt.Errorf("store: Programs: %w", err)
	}
	defer rows.Close()

	var out []catalog.Program
	for rows.Next() {
		var p catalog.Program
		if err := rows.Scan(&p.ID, &p.CampusCode, &p.FacultyCode, &p.Code, &p.LevelSlug, &p.Name, &p.CampusName, &p.FacultyName,
			&p.LevelIdx, &p.CampusIdx, &p.FacultyIdx, &p.ProgramIdx, &p.CatalogFetchedAt); err != nil {
			return nil, fmt.Errorf("store: Programs: scan: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ProgramsOfferingCourse resolves which programs of a campus list code in
// their course_program, for the /campuses/{campus}/courses/{code} shortcut
// (docs/API.md). An empty campusCode spans every cached campus.
func (s *Store) ProgramsOfferingCourse(ctx context.Context, campusCode, code string) ([]catalog.Program, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.campus_code, p.faculty_code, p.code, p.level_slug, p.name, p.campus_name, p.faculty_name,
		       p.level_idx, p.campus_idx, p.faculty_idx, p.program_idx, p.catalog_fetched_at
		FROM program p
		JOIN course_program cp ON cp.program_id = p.id
		WHERE cp.code = $2 AND ($1 = '' OR p.campus_code = $1)
		ORDER BY p.name`,
		campusCode, code,
	)
	if err != nil {
		return nil, fmt.Errorf("store: ProgramsOfferingCourse: %w", err)
	}
	defer rows.Close()

	var out []catalog.Program
	for rows.Next() {
		var p catalog.Program
		if err := rows.Scan(&p.ID, &p.CampusCode, &p.FacultyCode, &p.Code, &p.LevelSlug, &p.Name, &p.CampusName, &p.FacultyName,
			&p.LevelIdx, &p.CampusIdx, &p.FacultyIdx, &p.ProgramIdx, &p.CatalogFetchedAt); err != nil {
			return nil, fmt.Errorf("store: ProgramsOfferingCourse: scan: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
