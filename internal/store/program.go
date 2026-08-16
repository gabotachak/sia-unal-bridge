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
		INSERT INTO program (campus_code, faculty_code, code, level, name, campus_name, faculty_name, campus_idx, faculty_idx, program_idx)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (campus_code, faculty_code, code) DO UPDATE SET
			level = EXCLUDED.level,
			name = EXCLUDED.name,
			campus_name = EXCLUDED.campus_name,
			faculty_name = EXCLUDED.faculty_name,
			campus_idx = EXCLUDED.campus_idx,
			faculty_idx = EXCLUDED.faculty_idx,
			program_idx = EXCLUDED.program_idx
		RETURNING id, catalog_fetched_at`,
		p.CampusCode, p.FacultyCode, p.Code, p.Level, p.Name, p.CampusName, p.FacultyName,
		p.CampusIdx, p.FacultyIdx, p.ProgramIdx,
	)
	if err := row.Scan(&p.ID, &p.CatalogFetchedAt); err != nil {
		return catalog.Program{}, fmt.Errorf("store: UpsertProgram: %w", err)
	}
	return p, nil
}

func (s *Store) Program(ctx context.Context, campusCode, facultyCode, code string) (catalog.Program, bool, error) {
	var p catalog.Program
	err := s.pool.QueryRow(ctx, `
		SELECT id, campus_code, faculty_code, code, level, name, campus_name, faculty_name,
		       campus_idx, faculty_idx, program_idx, catalog_fetched_at
		FROM program WHERE campus_code = $1 AND faculty_code = $2 AND code = $3`,
		campusCode, facultyCode, code,
	).Scan(&p.ID, &p.CampusCode, &p.FacultyCode, &p.Code, &p.Level, &p.Name, &p.CampusName, &p.FacultyName,
		&p.CampusIdx, &p.FacultyIdx, &p.ProgramIdx, &p.CatalogFetchedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return catalog.Program{}, false, nil
	}
	if err != nil {
		return catalog.Program{}, false, fmt.Errorf("store: Program: %w", err)
	}
	return p, true, nil
}

// Programs lists cached programs under a campus, optionally narrowed to one
// faculty. facultyCode == "" means all faculties in the campus.
func (s *Store) Programs(ctx context.Context, campusCode, facultyCode string) ([]catalog.Program, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, campus_code, faculty_code, code, level, name, campus_name, faculty_name,
		       campus_idx, faculty_idx, program_idx, catalog_fetched_at
		FROM program
		WHERE campus_code = $1 AND ($2 = '' OR faculty_code = $2)
		ORDER BY name`,
		campusCode, facultyCode,
	)
	if err != nil {
		return nil, fmt.Errorf("store: Programs: %w", err)
	}
	defer rows.Close()

	var out []catalog.Program
	for rows.Next() {
		var p catalog.Program
		if err := rows.Scan(&p.ID, &p.CampusCode, &p.FacultyCode, &p.Code, &p.Level, &p.Name, &p.CampusName, &p.FacultyName,
			&p.CampusIdx, &p.FacultyIdx, &p.ProgramIdx, &p.CatalogFetchedAt); err != nil {
			return nil, fmt.Errorf("store: Programs: scan: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ProgramsOfferingCourse resolves which programs list code in their
// course_program, for the ambiguous /courses/{code} shortcut (docs/API.md).
func (s *Store) ProgramsOfferingCourse(ctx context.Context, code string) ([]catalog.Program, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.campus_code, p.faculty_code, p.code, p.level, p.name, p.campus_name, p.faculty_name,
		       p.campus_idx, p.faculty_idx, p.program_idx, p.catalog_fetched_at
		FROM program p
		JOIN course_program cp ON cp.program_id = p.id
		WHERE cp.code = $1
		ORDER BY p.name`,
		code,
	)
	if err != nil {
		return nil, fmt.Errorf("store: ProgramsOfferingCourse: %w", err)
	}
	defer rows.Close()

	var out []catalog.Program
	for rows.Next() {
		var p catalog.Program
		if err := rows.Scan(&p.ID, &p.CampusCode, &p.FacultyCode, &p.Code, &p.Level, &p.Name, &p.CampusName, &p.FacultyName,
			&p.CampusIdx, &p.FacultyIdx, &p.ProgramIdx, &p.CatalogFetchedAt); err != nil {
			return nil, fmt.Errorf("store: ProgramsOfferingCourse: scan: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
