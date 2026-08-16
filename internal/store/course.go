package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// UpsertCatalog writes a program's full catalog in one transaction and
// stamps catalog_fetched_at — callers MUST pass the combined regular +
// electives set, never just one half. A partial catalog marked "fresh" is
// exactly the silent failure this project exists to avoid (docs/GOTCHAS.md
// §21, docs/ARCH.md "El catálogo de un plan son dos consultas").
func (s *Store) UpsertCatalog(ctx context.Context, program catalog.Program, offerings []catalog.CourseOffering) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		for _, o := range offerings {
			c := o.Course
			if _, err := tx.Exec(ctx, `
				INSERT INTO course (campus_code, code, name, credits, description, fetched_at)
				VALUES ($1, $2, $3, $4, $5, now())
				ON CONFLICT (campus_code, code) DO UPDATE SET
					name = EXCLUDED.name,
					credits = EXCLUDED.credits,
					description = EXCLUDED.description,
					fetched_at = now()`,
				c.CampusCode, c.Code, c.Name, c.Credits, c.Description,
			); err != nil {
				return fmt.Errorf("store: UpsertCatalog: course %s: %w", c.Code, err)
			}

			if _, err := tx.Exec(ctx, `
				INSERT INTO course_program (program_id, campus_code, code, typology)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (program_id, code) DO UPDATE SET typology = EXCLUDED.typology`,
				program.ID, c.CampusCode, c.Code, o.Typology,
			); err != nil {
				return fmt.Errorf("store: UpsertCatalog: course_program %s: %w", c.Code, err)
			}
		}

		if _, err := tx.Exec(ctx, `UPDATE program SET catalog_fetched_at = now() WHERE id = $1`, program.ID); err != nil {
			return fmt.Errorf("store: UpsertCatalog: stamp catalog_fetched_at: %w", err)
		}
		return nil
	})
}

// ProgramCourses lists a program's cached catalog (both halves, whatever
// UpsertCatalog last wrote), con los cupos YA GUARDADOS de cada asignatura.
//
// El agregado de cupos sale de la misma consulta con un LEFT JOIN sobre
// current_seats, filtrado por section_program: son los grupos que ESTE plan
// ve, no todos los de la asignatura (DATA-MODEL.md decisión 6). Sumar los 25
// grupos cuando el plan solo habilita 23 sería el fallo silencioso de siempre.
//
// Nunca dispara una consulta al SIA: una asignatura cuyo detalle nunca se
// pidió sale con Seats nil, y esa ausencia es la respuesta honesta.
func (s *Store) ProgramCourses(ctx context.Context, programID int64) ([]catalog.CourseOffering, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.campus_code, c.code, c.name, c.credits, c.description, c.fetched_at, cp.typology,
		       seats.total, seats.oldest, seats.n
		FROM course_program cp
		JOIN course c ON c.campus_code = cp.campus_code AND c.code = cp.code
		LEFT JOIN LATERAL (
			SELECT sum(cs.available_seats) AS total,
			       min(cs.measured_at)     AS oldest,
			       count(*)                AS n
			FROM section sec
			JOIN section_program sp ON sp.section_id = sec.id AND sp.program_id = cp.program_id
			JOIN current_seats cs ON cs.section_id = sec.id
			WHERE sec.campus_code = cp.campus_code AND sec.code = cp.code
		) seats ON true
		WHERE cp.program_id = $1
		ORDER BY c.name`,
		programID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: ProgramCourses: %w", err)
	}
	defer rows.Close()

	var out []catalog.CourseOffering
	for rows.Next() {
		var o catalog.CourseOffering
		var total, n *int
		var oldest *time.Time
		if err := rows.Scan(&o.Course.CampusCode, &o.Course.Code, &o.Course.Name, &o.Course.Credits,
			&o.Course.Description, &o.Course.FetchedAt, &o.Typology, &total, &oldest, &n); err != nil {
			return nil, fmt.Errorf("store: ProgramCourses: scan: %w", err)
		}
		if total != nil && oldest != nil && n != nil && *n > 0 {
			o.Seats = &catalog.CourseSeats{Available: *total, MeasuredAt: *oldest, Sections: *n}
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (s *Store) Course(ctx context.Context, campusCode, code string) (catalog.Course, bool, error) {
	var c catalog.Course
	err := s.pool.QueryRow(ctx, `
		SELECT campus_code, code, name, credits, description, fetched_at
		FROM course WHERE campus_code = $1 AND code = $2`,
		campusCode, code,
	).Scan(&c.CampusCode, &c.Code, &c.Name, &c.Credits, &c.Description, &c.FetchedAt)
	if err == pgx.ErrNoRows {
		return catalog.Course{}, false, nil
	}
	if err != nil {
		return catalog.Course{}, false, fmt.Errorf("store: Course: %w", err)
	}
	return c, true, nil
}

// SearchCourses serves /v1/campuses/{campus}/courses?q= from the Store only
// — it never triggers a SIA fetch (docs/API.md "Por qué la búsqueda global
// no dispara al SIA"). An empty campusCode searches every cached campus.
func (s *Store) SearchCourses(ctx context.Context, campusCode, q string) ([]catalog.Course, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT campus_code, code, name, credits, description, fetched_at
		FROM course
		WHERE name ILIKE '%' || $2 || '%' AND ($1 = '' OR campus_code = $1)
		ORDER BY name LIMIT 100`,
		campusCode, q,
	)
	if err != nil {
		return nil, fmt.Errorf("store: SearchCourses: %w", err)
	}
	defer rows.Close()

	var out []catalog.Course
	for rows.Next() {
		var c catalog.Course
		if err := rows.Scan(&c.CampusCode, &c.Code, &c.Name, &c.Credits, &c.Description, &c.FetchedAt); err != nil {
			return nil, fmt.Errorf("store: SearchCourses: scan: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ProgramCoverage reports two DIFFERENT caches, not a progress bar over the
// whole university:
//
//   - known:       programs the directory cascade has discovered at all
//   - withCatalog: of those, the ones whose course list is actually cached
//
// Neither is the UNAL's census (1380 program entries): `known` only grows as
// campuses get warmed. That is why the field is not called "total" — a
// caller reading 2/287 must not conclude that 287 is everything there is.
//
// An empty campusCode counts every campus, which is what /v1/status reports.
func (s *Store) ProgramCoverage(ctx context.Context, campusCode string) (known, withCatalog int, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE catalog_fetched_at IS NOT NULL)
		FROM program WHERE ($1 = '' OR campus_code = $1)`,
		campusCode,
	).Scan(&known, &withCatalog)
	if err != nil {
		return 0, 0, fmt.Errorf("store: ProgramCoverage: %w", err)
	}
	return known, withCatalog, nil
}
