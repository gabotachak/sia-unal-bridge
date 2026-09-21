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
// Catalog() siempre llama con `combined` (regular + electivas) en una sola
// pasada (service.go) — nunca partir esa llamada en dos: la reconciliación
// de abajo apagaría las regulares en la mitad que no trae electivas, y
// viceversa.
func (s *Store) UpsertCatalog(ctx context.Context, program catalog.Program, offerings []catalog.CourseOffering) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		// Queued and sent as ONE batch: two statements per course, one round
		// trip each, was ~1400 round trips for a Medellín plan (694 courses).
		batch := &pgx.Batch{}
		for _, o := range offerings {
			c := o.Course
			batch.Queue(`
				INSERT INTO course (campus_code, code, name, credits, description, fetched_at)
				VALUES ($1, $2, $3, $4, $5, now())
				ON CONFLICT (campus_code, code) DO UPDATE SET
					name = EXCLUDED.name,
					credits = EXCLUDED.credits,
					description = EXCLUDED.description,
					fetched_at = now()`,
				c.CampusCode, c.Code, c.Name, c.Credits, c.Description,
			)
			batch.Queue(`
				INSERT INTO course_program (program_id, campus_code, code, typology)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (program_id, code) DO UPDATE SET typology = EXCLUDED.typology, disabled_at = NULL`,
				program.ID, c.CampusCode, c.Code, o.Typology,
			)
		}
		if batch.Len() > 0 {
			if err := tx.SendBatch(ctx, batch).Close(); err != nil {
				return fmt.Errorf("store: UpsertCatalog: upsert courses: %w", err)
			}
		}

		// len(offerings) == 0 no llega hasta acá cuando había catálogo
		// previo: suspectShrunkCatalog lo rechaza antes (catalog package).
		// La guarda queda igual porque este upsert es público y no todos sus
		// caminos pasan por el Service.
		if len(offerings) > 0 {
			codes := make([]string, len(offerings))
			for i, o := range offerings {
				codes[i] = o.Course.Code
			}
			if _, err := tx.Exec(ctx, `
				UPDATE course_program SET disabled_at = now()
				WHERE program_id = $1 AND code != ALL($2) AND disabled_at IS NULL`,
				program.ID, codes,
			); err != nil {
				return fmt.Errorf("store: UpsertCatalog: reconcile: %w", err)
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
//
// El orden lleva COLLATE explícito: la base corre en postgres:alpine, cuyo
// locale por defecto ordena por bytes, y ahí "Álgebra Lineal" cae DESPUÉS de
// "Zoología" — medido en producción, era la 265 de 267 del plan 2879. El
// cliente pinta el listado tal cual llega, "ya alfabético".
func (s *Store) ProgramCourses(ctx context.Context, programID int64) ([]catalog.CourseOffering, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.campus_code, c.code, c.name, c.credits, c.description, c.fetched_at, cp.typology,
		       cp.detail_fetched_at,
		       seats.total, seats.oldest, seats.n
		FROM course_program cp
		JOIN course c ON c.campus_code = cp.campus_code AND c.code = cp.code
		LEFT JOIN LATERAL (
			SELECT sum(latest.available_seats)                             AS total,
			       min(coalesce(sec.seats_checked_at, latest.measured_at)) AS oldest,
			       count(*)                                                AS n
			FROM section sec
			JOIN section_program sp ON sp.section_id = sec.id AND sp.program_id = cp.program_id
			                       AND sp.disabled_at IS NULL
			JOIN LATERAL (
				SELECT available_seats, measured_at
				FROM seat_snapshot ss
				WHERE ss.section_id = sec.id
				ORDER BY ss.measured_at DESC
				LIMIT 1
			) latest ON true
			WHERE sec.campus_code = cp.campus_code AND sec.code = cp.code
		) seats ON true
		WHERE cp.program_id = $1 AND cp.disabled_at IS NULL
		ORDER BY c.name COLLATE "es-x-icu"`,
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
			&o.Course.Description, &o.Course.FetchedAt, &o.Typology, &o.DetailFetchedAt,
			&total, &oldest, &n); err != nil {
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
		FROM course
		WHERE campus_code = $1 AND code = $2
		  AND EXISTS (SELECT 1 FROM course_program cp
		              WHERE cp.campus_code = course.campus_code AND cp.code = course.code
		                AND cp.disabled_at IS NULL)`,
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
		  AND EXISTS (SELECT 1 FROM course_program cp
		              WHERE cp.campus_code = course.campus_code AND cp.code = course.code
		                AND cp.disabled_at IS NULL)
		ORDER BY name COLLATE "es-x-icu" LIMIT 100`,
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
		FROM program WHERE ($1 = '' OR campus_code = $1) AND disabled_at IS NULL`,
		campusCode,
	).Scan(&known, &withCatalog)
	if err != nil {
		return 0, 0, fmt.Errorf("store: ProgramCoverage: %w", err)
	}
	return known, withCatalog, nil
}
