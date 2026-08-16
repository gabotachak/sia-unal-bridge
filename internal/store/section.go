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
func (s *Store) UpsertDetail(ctx context.Context, programID int64, offering catalog.CourseOffering) error {
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
				ON CONFLICT DO NOTHING`,
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
				if _, err := tx.Exec(ctx, `
					INSERT INTO seat_snapshot (section_id, available_seats, measured_at)
					VALUES ($1, $2, $3)
					ON CONFLICT (section_id, measured_at) DO NOTHING`,
					sectionID, sec.Seats.Available, sec.Seats.MeasuredAt,
				); err != nil {
					return fmt.Errorf("seat_snapshot %s: %w", sec.Key, err)
				}
			}
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

	for i := range out {
		schedule, err := s.classSessions(ctx, ids[i])
		if err != nil {
			return nil, err
		}
		out[i].Schedule = schedule
		if seats, ok, err := s.CurrentSeats(ctx, ids[i]); err != nil {
			return nil, err
		} else if ok {
			out[i].Seats = &seats
		}
	}
	return out, nil
}

func (s *Store) classSessions(ctx context.Context, sectionID int64) ([]catalog.ClassSession, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT weekday, start_time, end_time, coalesce(room, ''), coalesce(building, '')
		FROM class_session WHERE section_id = $1 ORDER BY weekday, start_time`,
		sectionID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: classSessions: %w", err)
	}
	defer rows.Close()

	var out []catalog.ClassSession
	for rows.Next() {
		var cs catalog.ClassSession
		var weekday int
		var start, end time.Time
		if err := rows.Scan(&weekday, &start, &end, &cs.Room, &cs.Building); err != nil {
			return nil, fmt.Errorf("store: classSessions: scan: %w", err)
		}
		cs.Weekday = fromISOWeekday(weekday)
		cs.StartTime = start.Format("15:04")
		cs.EndTime = end.Format("15:04")
		out = append(out, cs)
	}
	return out, rows.Err()
}

func fromISOWeekday(iso int) time.Weekday {
	if iso == 7 {
		return time.Sunday
	}
	return time.Weekday(iso)
}
