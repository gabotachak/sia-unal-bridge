package store

import (
	"context"
	"fmt"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// CoursesNeedingDetail lists the program's courses whose GLOBAL detail is
// missing or stale. Global means: the newest of (a) any section row of that
// course, whichever plan wrote it, and (b) any plan's detail_fetched_at.
//
// (b) is not redundant. A course with zero groups is valid (GOTCHAS §18) and
// leaves no section row at all, so without it every 0-group course in the
// university would be refetched on every sweep, forever.
//
// This is the filter behind "el barrido global cuesta 3 h y no 38": a course
// another plan already pulled today is skipped here, because section rows —
// profesor, horario, cupos — are valid for every plan.
func (s *Store) CoursesNeedingDetail(ctx context.Context, programID int64, maxAge time.Duration) ([]catalog.CourseRef, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT cp.code, c.name, coalesce(cp.typology, ''), g.t IS NOT NULL AS had_sections
		FROM course_program cp
		JOIN course c ON c.campus_code = cp.campus_code AND c.code = cp.code
		LEFT JOIN LATERAL (
			SELECT max(sec.fetched_at) AS t FROM section sec
			WHERE sec.campus_code = cp.campus_code AND sec.code = cp.code
		) g ON true
		LEFT JOIN LATERAL (
			SELECT max(cp2.detail_fetched_at) AS t FROM course_program cp2
			WHERE cp2.campus_code = cp.campus_code AND cp2.code = cp.code
		) d ON true
		WHERE cp.program_id = $1 AND cp.disabled_at IS NULL
		  AND coalesce(greatest(g.t, d.t), 'epoch'::timestamptz) < now() - ($2::double precision * interval '1 second')
		ORDER BY c.name`,
		programID, maxAge.Seconds(),
	)
	if err != nil {
		return nil, fmt.Errorf("store: CoursesNeedingDetail: %w", err)
	}
	defer rows.Close()

	var out []catalog.CourseRef
	for rows.Next() {
		ref := catalog.CourseRef{ProgramID: programID}
		if err := rows.Scan(&ref.Code, &ref.Name, &ref.Typology, &ref.HadSections); err != nil {
			return nil, fmt.Errorf("store: CoursesNeedingDetail: scan: %w", err)
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// CoursesNeedingVisibility is the per-plan variant of the query above: it
// asks about THIS program's own detail_fetched_at, so a course another plan
// pulled today still counts as pending here. That is not redundancy —
// section_program visibility is the one thing a fetch from another plan
// cannot teach us (DATA-MODEL.md decision 6).
func (s *Store) CoursesNeedingVisibility(ctx context.Context, programID int64, maxAge time.Duration) ([]catalog.CourseRef, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT cp.code, c.name, coalesce(cp.typology, ''),
		       EXISTS (SELECT 1 FROM section sec
		               WHERE sec.campus_code = cp.campus_code AND sec.code = cp.code) AS had_sections
		FROM course_program cp
		JOIN course c ON c.campus_code = cp.campus_code AND c.code = cp.code
		WHERE cp.program_id = $1 AND cp.disabled_at IS NULL
		  AND coalesce(cp.detail_fetched_at, 'epoch'::timestamptz)
		      < now() - ($2::double precision * interval '1 second')
		ORDER BY c.name`,
		programID, maxAge.Seconds(),
	)
	if err != nil {
		return nil, fmt.Errorf("store: CoursesNeedingVisibility: %w", err)
	}
	defer rows.Close()

	var out []catalog.CourseRef
	for rows.Next() {
		ref := catalog.CourseRef{ProgramID: programID}
		if err := rows.Scan(&ref.Code, &ref.Name, &ref.Typology, &ref.HadSections); err != nil {
			return nil, fmt.Errorf("store: CoursesNeedingVisibility: scan: %w", err)
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// SeatsHotSet returns the campus's most-requested courses with a plan that
// can actually see them. The plan chosen is the one that pulled the course's
// detail most recently: it is known to have visibility, which a plan that
// merely lists the course in its catalog is not (DATA-MODEL.md decision 6).
func (s *Store) SeatsHotSet(ctx context.Context, campusCode string, limit int) ([]catalog.CourseRef, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT program_id, code, name, typology FROM (
			SELECT DISTINCT ON (d.code)
			       cp.program_id, d.code, c.name, coalesce(cp.typology, '') AS typology,
			       d.hits, d.last_requested_at
			FROM course_demand d
			JOIN course c ON c.campus_code = d.campus_code AND c.code = d.code
			JOIN course_program cp ON cp.campus_code = d.campus_code AND cp.code = d.code
			                      AND cp.disabled_at IS NULL
			WHERE d.campus_code = $1
			ORDER BY d.code, cp.detail_fetched_at DESC NULLS LAST, cp.program_id
		) t
		ORDER BY hits DESC, last_requested_at DESC
		LIMIT $2`,
		campusCode, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: SeatsHotSet: %w", err)
	}
	defer rows.Close()

	var out []catalog.CourseRef
	for rows.Next() {
		var ref catalog.CourseRef
		if err := rows.Scan(&ref.ProgramID, &ref.Code, &ref.Name, &ref.Typology); err != nil {
			return nil, fmt.Errorf("store: SeatsHotSet: scan: %w", err)
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// RecordDemand is the counter the hot set is built from. Only httpapi calls
// it: "las que tienen detail_fetched_at" works today only because a client
// is the sole writer, and stops working the moment the global sweep stamps
// every course (docs/FASE-2.md).
func (s *Store) RecordDemand(ctx context.Context, campusCode, code string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO course_demand (campus_code, code, hits, last_requested_at)
		VALUES ($1, $2, 1, now())
		ON CONFLICT (campus_code, code) DO UPDATE SET
			hits = course_demand.hits + 1, last_requested_at = now()`,
		campusCode, code,
	)
	if err != nil {
		return fmt.Errorf("store: RecordDemand: %w", err)
	}
	return nil
}

func (s *Store) StartRun(ctx context.Context, mode, scope string) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO refresh_run (mode, scope) VALUES ($1, $2) RETURNING id`,
		mode, scope,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("store: StartRun: %w", err)
	}
	return id, nil
}

func (s *Store) FinishRun(ctx context.Context, run catalog.RefreshRun) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE refresh_run SET finished_at = now(), programs_ok = $2, programs_failed = $3,
			programs_skipped = $4, courses_ok = $5, posts = $6, bytes = $7, ended_reason = $8
		WHERE id = $1`,
		run.ID, run.ProgramsOK, run.ProgramsFailed, run.ProgramsSkipped, run.CoursesOK,
		run.Posts, run.Bytes, run.EndedReason,
	)
	if err != nil {
		return fmt.Errorf("store: FinishRun: %w", err)
	}
	return nil
}

// LastRuns returns the newest run per mode — what /v1/status reports. A run
// still in flight (finished_at NULL) is included on purpose: "el barrido de
// detalle lleva 2 h corriendo" is the answer an operator is looking for.
func (s *Store) LastRuns(ctx context.Context) ([]catalog.RefreshRun, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (mode) id, mode, scope, started_at, finished_at,
		       programs_ok, programs_failed, programs_skipped, courses_ok,
		       posts, bytes, coalesce(ended_reason, '')
		FROM refresh_run ORDER BY mode, started_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("store: LastRuns: %w", err)
	}
	defer rows.Close()

	var out []catalog.RefreshRun
	for rows.Next() {
		var r catalog.RefreshRun
		if err := rows.Scan(&r.ID, &r.Mode, &r.Scope, &r.StartedAt, &r.FinishedAt,
			&r.ProgramsOK, &r.ProgramsFailed, &r.ProgramsSkipped, &r.CoursesOK,
			&r.Posts, &r.Bytes, &r.EndedReason); err != nil {
			return nil, fmt.Errorf("store: LastRuns: scan: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// TryLock is the "no encolar corridas" rule of docs/FASE-2.md: an advisory
// lock is session-scoped, so it needs a connection held for the whole run
// and released explicitly — not a pooled Exec that returns the connection
// (and drops the lock) the moment it finishes.
func (s *Store) TryLock(ctx context.Context, key string) (func(), bool, error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("store: TryLock: acquire: %w", err)
	}
	var ok bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1))`, key).Scan(&ok); err != nil {
		conn.Release()
		return nil, false, fmt.Errorf("store: TryLock: %w", err)
	}
	if !ok {
		conn.Release()
		return nil, false, nil
	}
	return func() {
		// Detached from ctx: the usual reason to unlock is that ctx was
		// cancelled (SIGTERM), and an already-dead context would skip the
		// unlock and leave the next run locked out until the connection
		// times out.
		uctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		// Error ignored on purpose: releasing the connection drops the lock
		// too, so there is nothing to recover from.
		_, _ = conn.Exec(uctx, `SELECT pg_advisory_unlock(hashtext($1))`, key)
		conn.Release()
	}, true, nil
}
