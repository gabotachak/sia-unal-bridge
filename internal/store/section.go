package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// CourseProgramFetchedAt answers "have I already asked THIS program about
// this course?" — the layer that governs section_program visibility,
// distinct from the section rows themselves which are valid for every
// program (DATA-MODEL.md decision 6).
func (s *Store) CourseProgramFetchedAt(ctx context.Context, programID int64, code string) (*time.Time, bool, error) {
	var t *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT detail_fetched_at FROM course_program WHERE program_id = $1 AND code = $2`,
		programID, code,
	).Scan(&t)
	if err == pgx.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("store: CourseProgramFetchedAt: %w", err)
	}
	return t, true, nil
}

// CourseProgramTypology reads the typology of one course from one
// program's viewpoint — relative to the plan, not the course
// (DATA-MODEL.md decision 1).
func (s *Store) CourseProgramTypology(ctx context.Context, programID int64, code string) (string, bool, error) {
	var typology string
	err := s.pool.QueryRow(ctx, `
		SELECT coalesce(typology, '') FROM course_program WHERE program_id = $1 AND code = $2`,
		programID, code,
	).Scan(&typology)
	if err == pgx.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("store: CourseProgramTypology: %w", err)
	}
	return typology, true, nil
}

// UpsertDetail writes one course's groups from one program's viewpoint:
// section rows (global — valid for every program), section_program
// (visibility — valid only for programID), class_session (replaced
// wholesale per section, schedules don't get incremental diffs), and a
// seat_snapshot per section with seats (append-only, DATA-MODEL.md
// decision 4). Also stamps course_program.detail_fetched_at for programID.
//
// term is an explicit parameter, not read off offering.Course.Sections:
// that slice is empty exactly when the reconciliation below matters most
// (GOTCHAS §18), and there is no section left to read a term from.
func (s *Store) UpsertDetail(ctx context.Context, programID int64, term string, offering catalog.CourseOffering) error {
	c := offering.Course
	return s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO course (campus_code, code, name, credits, description, fetched_at)
			VALUES ($1, $2, $3, $4, $5, now())
			ON CONFLICT (campus_code, code) DO UPDATE SET
				name = EXCLUDED.name, credits = EXCLUDED.credits,
				description = EXCLUDED.description, fetched_at = now()`,
			c.CampusCode, c.Code, c.Name, c.Credits, c.Description,
		); err != nil {
			return fmt.Errorf("course: %w", err)
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO course_program (program_id, campus_code, code, typology, detail_fetched_at)
			VALUES ($1, $2, $3, $4, now())
			ON CONFLICT (program_id, code) DO UPDATE SET
				typology = EXCLUDED.typology, detail_fetched_at = now()`,
			programID, c.CampusCode, c.Code, offering.Typology,
		); err != nil {
			return fmt.Errorf("course_program: %w", err)
		}

		for _, sec := range c.Sections {
			var sectionID int64
			err := tx.QueryRow(ctx, `
				INSERT INTO section (campus_code, code, term, key, number, site, site_campus,
				                      label, instructor, shift, duration, start_date, end_date, fetched_at, raw)
				VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''),
				        NULLIF($11, ''), $12, $13, now(), NULL)
				ON CONFLICT (campus_code, code, term, key) DO UPDATE SET
					number = EXCLUDED.number, site = EXCLUDED.site, site_campus = EXCLUDED.site_campus,
					label = EXCLUDED.label, instructor = EXCLUDED.instructor, shift = EXCLUDED.shift,
					duration = EXCLUDED.duration, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
					fetched_at = now()
				RETURNING id`,
				sec.CampusCode, sec.Code, sec.Term, sec.Key, sec.Number, sec.Site, sec.SiteCampus,
				sec.Label, sec.Instructor, sec.Shift, sec.Duration, sec.StartDate, sec.EndDate,
			).Scan(&sectionID)
			if err != nil {
				return fmt.Errorf("section %s: %w", sec.Key, err)
			}

			if _, err := tx.Exec(ctx, `
				INSERT INTO section_program (section_id, program_id) VALUES ($1, $2)
				ON CONFLICT (section_id, program_id) DO UPDATE SET disabled_at = NULL`,
				sectionID, programID,
			); err != nil {
				return fmt.Errorf("section_program %s: %w", sec.Key, err)
			}

			if _, err := tx.Exec(ctx, `DELETE FROM class_session WHERE section_id = $1`, sectionID); err != nil {
				return fmt.Errorf("class_session delete %s: %w", sec.Key, err)
			}
			for _, cs := range sec.Schedule {
				weekday := isoWeekday(cs.Weekday)
				if _, err := tx.Exec(ctx, `
					INSERT INTO class_session (section_id, weekday, start_time, end_time, room, building)
					VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''))`,
					sectionID, weekday, cs.StartTime, cs.EndTime, cs.Room, cs.Building,
				); err != nil {
					return fmt.Errorf("class_session insert %s: %w", sec.Key, err)
				}
			}

			if sec.Seats != nil {
				// Dedupe: a snapshot only when the NUMBER changed. The
				// measurement itself is always recorded, on
				// section.seats_checked_at — sin esa columna, no insertar
				// haría que el dato pareciera viejo y el read-through lo
				// volviera a pedir (docs/FASE-2.md "Cupos").
				if _, err := tx.Exec(ctx, `
					INSERT INTO seat_snapshot (section_id, available_seats, measured_at)
					SELECT $1, $2, $3
					WHERE NOT EXISTS (
						SELECT 1 FROM current_seats cs
						WHERE cs.section_id = $1 AND cs.available_seats = $2
					)
					ON CONFLICT (section_id, measured_at) DO NOTHING`,
					sectionID, sec.Seats.Available, sec.Seats.MeasuredAt,
				); err != nil {
					return fmt.Errorf("seat_snapshot %s: %w", sec.Key, err)
				}
				if _, err := tx.Exec(ctx,
					`UPDATE section SET seats_checked_at = $2 WHERE id = $1`,
					sectionID, sec.Seats.MeasuredAt,
				); err != nil {
					return fmt.Errorf("seats_checked_at %s: %w", sec.Key, err)
				}
			}
		}

		// La respuesta del detalle describe con autoridad UNA cosa: qué
		// grupos ve ESTE plan. No dice nada sobre los grupos de los demás
		// planes —Sistemas ve 25 donde Industrial ve 23 (DATA-MODEL.md
		// §2)— así que se apaga la visibilidad, nunca el grupo. Un grupo
		// cancelado de verdad se apaga solo: deja de aparecer en el detalle
		// de todos los planes que lo veían.
		//
		// c.Sections vacío es un caso válido (§18) y llega acá con keys
		// vacío, que apaga toda la visibilidad de este plan sobre este
		// curso. Es lo correcto: el plan dejó de ver grupos. Y es seguro
		// apagarlo porque A1 garantiza que un 0 que llega hasta acá es un 0
		// de verdad y no un parseo roto.
		keys := make([]string, len(c.Sections))
		for i, sec := range c.Sections {
			keys[i] = sec.Key
		}
		if _, err := tx.Exec(ctx, `
			UPDATE section_program sp SET disabled_at = now()
			WHERE sp.program_id = $1 AND sp.disabled_at IS NULL
			  AND EXISTS (
			      SELECT 1 FROM section sec
			      WHERE sec.id = sp.section_id
			        AND sec.campus_code = $2 AND sec.code = $3 AND sec.term = $4
			        AND sec.key != ALL($5)
			  )`,
			programID, c.CampusCode, c.Code, term, keys,
		); err != nil {
			return fmt.Errorf("store: UpsertDetail: reconcile section_program: %w", err)
		}
		return nil
	})
}

// isoWeekday converts Go's time.Weekday (Sunday=0..Saturday=6) to the
// schema's 1=Mon..7=Sun (DATA-MODEL.md's SQL comment). The struct itself
// stores time.Weekday natively — this conversion is the store's job alone.
func isoWeekday(wd time.Weekday) int {
	if wd == time.Sunday {
		return 7
	}
	return int(wd)
}

// Sections lists a course's groups visible from programID, each with its
// schedule and current seats.
func (s *Store) Sections(ctx context.Context, campusCode, code string, programID int64) ([]catalog.Section, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT sec.id, sec.campus_code, sec.code, sec.term, sec.key, sec.number,
		       coalesce(sec.site, ''), coalesce(sec.site_campus, ''), coalesce(sec.label, ''),
		       coalesce(sec.instructor, ''), coalesce(sec.shift, ''), coalesce(sec.duration, ''),
		       sec.start_date, sec.end_date, sec.fetched_at
		FROM section sec
		JOIN section_program sp ON sp.section_id = sec.id
		WHERE sec.campus_code = $1 AND sec.code = $2 AND sp.program_id = $3
		  AND sp.disabled_at IS NULL
		ORDER BY sec.number, sec.key`,
		campusCode, code, programID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: Sections: %w", err)
	}
	defer rows.Close()

	var out []catalog.Section
	var ids []int64
	for rows.Next() {
		var sec catalog.Section
		var id int64
		if err := rows.Scan(&id, &sec.CampusCode, &sec.Code, &sec.Term, &sec.Key, &sec.Number,
			&sec.Site, &sec.SiteCampus, &sec.Label, &sec.Instructor, &sec.Shift, &sec.Duration,
			&sec.StartDate, &sec.EndDate, &sec.FetchedAt); err != nil {
			return nil, fmt.Errorf("store: Sections: scan: %w", err)
		}
		sec.ID = id
		out = append(out, sec)
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}

	// Batched, not classSessions/CurrentSeats per section: that was 1+2N
	// round-trips for N sections (measured 75 for a 37-section course,
	// ~55-115ms). These two queries evaluate the same per-section LATERAL
	// server-side in one round-trip each.
	schedules, err := s.classSessionsBatch(ctx, ids)
	if err != nil {
		return nil, err
	}
	seats, err := s.currentSeatsBatch(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Schedule = schedules[out[i].ID]
		if seat, ok := seats[out[i].ID]; ok {
			out[i].Seats = &seat
		}
	}
	return out, nil
}

func (s *Store) classSessionsBatch(ctx context.Context, sectionIDs []int64) (map[int64][]catalog.ClassSession, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT section_id, weekday, start_time, end_time, coalesce(room, ''), coalesce(building, '')
		FROM class_session WHERE section_id = ANY($1) ORDER BY section_id, weekday, start_time`,
		sectionIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("store: classSessionsBatch: %w", err)
	}
	defer rows.Close()

	out := make(map[int64][]catalog.ClassSession)
	for rows.Next() {
		var sectionID int64
		var cs catalog.ClassSession
		var weekday int
		var start, end time.Time
		if err := rows.Scan(&sectionID, &weekday, &start, &end, &cs.Room, &cs.Building); err != nil {
			return nil, fmt.Errorf("store: classSessionsBatch: scan: %w", err)
		}
		cs.Weekday = fromISOWeekday(weekday)
		cs.StartTime = start.Format("15:04")
		cs.EndTime = end.Format("15:04")
		out[sectionID] = append(out[sectionID], cs)
	}
	return out, rows.Err()
}

// currentSeatsBatch mirrors ProgramCourses' fix: a LATERAL ... LIMIT 1 per
// section, in one query, instead of joining current_seats (a DISTINCT ON
// over all of seat_snapshot) which the planner can rescan broadly under a
// multi-row join.
func (s *Store) currentSeatsBatch(ctx context.Context, sectionIDs []int64) (map[int64]catalog.SeatSnapshot, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT sec.id, latest.available_seats, coalesce(sec.seats_checked_at, latest.measured_at), latest.measured_at
		FROM section sec
		JOIN LATERAL (
			SELECT available_seats, measured_at
			FROM seat_snapshot ss
			WHERE ss.section_id = sec.id
			ORDER BY ss.measured_at DESC
			LIMIT 1
		) latest ON true
		WHERE sec.id = ANY($1)`,
		sectionIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("store: currentSeatsBatch: %w", err)
	}
	defer rows.Close()

	out := make(map[int64]catalog.SeatSnapshot)
	for rows.Next() {
		var id int64
		var snap catalog.SeatSnapshot
		if err := rows.Scan(&id, &snap.Available, &snap.MeasuredAt, &snap.ChangedAt); err != nil {
			return nil, fmt.Errorf("store: currentSeatsBatch: scan: %w", err)
		}
		out[id] = snap
	}
	return out, rows.Err()
}

func fromISOWeekday(iso int) time.Weekday {
	if iso == 7 {
		return time.Sunday
	}
	return time.Weekday(iso)
}

// ProgramSchedules returns, for every course visible from programID, the
// class schedule of each of its groups, keyed by course code.
//
// It is the bulk answer to the question the catalog list cannot answer on
// its own: CourseOffering carries aggregate seats but no schedule, so a
// client that wants to know which courses clash with a schedule it already
// has would otherwise need one detail request per course — measured at 200
// requests for a single Bogotá plan. This is one round-trip.
//
// Reads only what is already stored, exactly like CourseOffering.Seats: it
// never reaches the SIA. Courses whose detail nobody ever pulled simply do
// not appear in the map, which is what lets a caller tell "no groups" from
// "not known yet".
func (s *Store) ProgramSchedules(ctx context.Context, programID int64) (map[string][]catalog.SectionSchedule, error) {
	// Se arranca de course_program y no de section, y todo lo demás cuelga
	// por LEFT JOIN, para que una asignatura MEDIDA Y SIN GRUPOS salga igual
	// —con la lista vacía— en vez de desaparecer. Ausente y vacío significan
	// cosas distintas (docs/API.md, la tabla de detail_fetched_at/seats): sin
	// esa diferencia, un cliente no puede separar "no tiene grupos" de "nadie
	// preguntó todavía", y termina avisando sobre asignaturas de las que no
	// sabe nada.
	rows, err := s.pool.Query(ctx, `
		SELECT cp.code, sec.id, sec.key, cs.weekday, cs.start_time, cs.end_time
		FROM course_program cp
		LEFT JOIN section sec
		       ON sec.campus_code = cp.campus_code AND sec.code = cp.code
		      AND EXISTS (
		          SELECT 1 FROM section_program sp
		          WHERE sp.section_id = sec.id AND sp.program_id = cp.program_id
		            AND sp.disabled_at IS NULL
		      )
		LEFT JOIN class_session cs ON cs.section_id = sec.id
		WHERE cp.program_id = $1 AND cp.detail_fetched_at IS NOT NULL
		  AND cp.disabled_at IS NULL
		ORDER BY cp.code, sec.number, sec.key, sec.id, cs.weekday, cs.start_time`,
		programID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: ProgramSchedules: %w", err)
	}
	defer rows.Close()

	// Se agrupa por sec.id, no por sec.key: la clave natural del grupo es
	// (code, term, key), así que dos periodos del mismo grupo comparten key
	// y agrupar por ella los fundiría en uno con los horarios de ambos
	// mezclados. El id no miente nunca.
	out := make(map[string][]catalog.SectionSchedule)
	var curID int64
	for rows.Next() {
		var id *int64
		var code string
		var key *string
		var weekday *int
		var start, end *time.Time
		if err := rows.Scan(&code, &id, &key, &weekday, &start, &end); err != nil {
			return nil, fmt.Errorf("store: ProgramSchedules: scan: %w", err)
		}
		// La asignatura entra en el mapa por el solo hecho de tener el
		// detalle pedido, tenga grupos o no.
		if _, seen := out[code]; !seen {
			out[code] = []catalog.SectionSchedule{}
		}
		if id == nil || key == nil {
			continue // asignatura sin grupos visibles: la lista se queda vacía
		}
		if *id != curID {
			curID = *id
			// Schedule arranca vacío y no nil: un slice nil sale como `null`
			// en JSON, y un cliente que haga `schedule.some(...)` sobre el
			// grupo que no informa horario revienta. Vacío es además lo que
			// significa de verdad — el grupo existe, no tiene sesiones.
			out[code] = append(out[code], catalog.SectionSchedule{
				Key:      *key,
				Schedule: []catalog.ClassSession{},
			})
		}
		// NULL en las tres = el LEFT JOIN no encontró horario. El grupo
		// existe igual, y tiene que salir: si desapareciera, un cliente
		// concluiría "todos los grupos chocan" sobre un conjunto más chico
		// que el real.
		if weekday != nil && start != nil && end != nil {
			list := out[code]
			cur := &list[len(list)-1]
			cur.Schedule = append(cur.Schedule, catalog.ClassSession{
				Weekday:   fromISOWeekday(*weekday),
				StartTime: start.Format("15:04"),
				EndTime:   end.Format("15:04"),
			})
		}
	}
	return out, rows.Err()
}
