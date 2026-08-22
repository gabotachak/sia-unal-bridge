package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// resetCampus wipes a test-only sede: courses cascade to course_program,
// section, section_program, class_session and seat_snapshot, so this is the
// whole subtree. Without it a second run of the suite sees the sections the
// first one wrote and skips the very work under test — the tests would be
// asserting on their own leftovers.
func resetCampus(t *testing.T, s *Store, campusCode string) {
	t.Helper()
	ctx := context.Background()
	for _, sql := range []string{
		`DELETE FROM course WHERE campus_code = $1`,
		`DELETE FROM program WHERE campus_code = $1`,
		`DELETE FROM course_demand WHERE campus_code = $1`,
	} {
		if _, err := s.pool.Exec(ctx, sql, campusCode); err != nil {
			t.Fatalf("resetCampus %q: %v", sql, err)
		}
	}
}

func seatSnapshotCount(t *testing.T, s *Store, sectionID int64) int {
	t.Helper()
	var n int
	if err := s.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM seat_snapshot WHERE section_id = $1`, sectionID).Scan(&n); err != nil {
		t.Fatalf("count snapshots: %v", err)
	}
	return n
}

// TestSeatsDedupe is paso 6's acceptance bar (docs/FASE-2.md): two sweeps
// with no real change write 0 new snapshot rows, seats_checked_at moves
// anyway, and the age the API publishes stays the age of the MEASUREMENT —
// otherwise the dedupe would make the data look stale and the read-through
// would re-fetch exactly what the job just measured.
func TestSeatsDedupe(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetCampus(t, s, "9994")

	p, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9994", FacultyCode: "2055", Code: "2D01", LevelSlug: "pregrado", Name: "DEDUPE",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 9,
	})
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}

	measure := func(available int, at time.Time) {
		t.Helper()
		course := catalog.Course{CampusCode: "9994", Code: "2016696", Name: "Algoritmos",
			Sections: []catalog.Section{{
				CampusCode: "9994", Code: "2016696", Term: "2026-2", Key: "1", Number: 1,
				Seats: &catalog.SeatSnapshot{Available: available, MeasuredAt: at},
			}},
		}
		if err := s.UpsertDetail(ctx, p.ID, "2026-2", catalog.CourseOffering{Course: course}); err != nil {
			t.Fatalf("UpsertDetail: %v", err)
		}
	}

	first := time.Now().Add(-30 * time.Minute).Truncate(time.Second)
	measure(32, first)
	sections, err := s.Sections(ctx, "9994", "2016696", p.ID)
	if err != nil || len(sections) != 1 {
		t.Fatalf("Sections: %d %v", len(sections), err)
	}
	sectionID := sections[0].ID
	if n := seatSnapshotCount(t, s, sectionID); n != 1 {
		t.Fatalf("after first measurement got %d snapshots, want 1", n)
	}

	// Same number, measured again: no new history row, new measurement time.
	second := time.Now().Truncate(time.Second)
	measure(32, second)
	if n := seatSnapshotCount(t, s, sectionID); n != 1 {
		t.Errorf("unchanged seats wrote %d snapshots, want 1", n)
	}
	sections, err = s.Sections(ctx, "9994", "2016696", p.ID)
	if err != nil {
		t.Fatalf("Sections: %v", err)
	}
	seats := sections[0].Seats
	if seats == nil {
		t.Fatal("expected seats")
	}
	if !seats.MeasuredAt.Equal(second) {
		t.Errorf("measured_at = %v, want the latest MEASUREMENT %v", seats.MeasuredAt, second)
	}
	if seats.ChangedAt == nil || !seats.ChangedAt.Equal(first) {
		t.Errorf("changed_at = %v, want the first measurement %v", seats.ChangedAt, first)
	}

	// A real change does insert, and changed_at follows it.
	third := time.Now().Add(time.Second).Truncate(time.Second)
	measure(28, third)
	if n := seatSnapshotCount(t, s, sectionID); n != 2 {
		t.Errorf("changed seats wrote %d snapshots, want 2", n)
	}
	sections, _ = s.Sections(ctx, "9994", "2016696", p.ID)
	if got := sections[0].Seats; got.Available != 28 || got.ChangedAt == nil || !got.ChangedAt.Equal(third) {
		t.Errorf("after change: %+v", got)
	}
}

// TestCoursesNeedingDetail_GlobalFreshnessIsShared is the arithmetic behind
// "3 h y no 38": a course another plan already fetched counts as done,
// because its section rows are valid for every plan.
func TestCoursesNeedingDetail_GlobalFreshnessIsShared(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetCampus(t, s, "9995")

	mk := func(code string, idx int) catalog.Program {
		p, err := s.UpsertProgram(ctx, catalog.Program{
			CampusCode: "9995", FacultyCode: "2055", Code: code, LevelSlug: "pregrado", Name: code,
			CampusIdx: 2, FacultyIdx: 8, ProgramIdx: idx,
		})
		if err != nil {
			t.Fatalf("UpsertProgram: %v", err)
		}
		return p
	}
	a, b := mk("2D02", 10), mk("2D03", 11)

	offerings := []catalog.CourseOffering{
		{Course: catalog.Course{CampusCode: "9995", Code: "SHARED-1", Name: "Compartida"}, Typology: "FUND. OBLIGATORIA (B)"},
		{Course: catalog.Course{CampusCode: "9995", Code: "ONLY-A", Name: "Solo A"}, Typology: "LIBRE ELECCIÓN (L)"},
	}
	if err := s.UpsertCatalog(ctx, a, offerings); err != nil {
		t.Fatalf("UpsertCatalog a: %v", err)
	}
	if err := s.UpsertCatalog(ctx, b, offerings[:1]); err != nil {
		t.Fatalf("UpsertCatalog b: %v", err)
	}

	pending, err := s.CoursesNeedingDetail(ctx, a.ID, 24*time.Hour)
	if err != nil {
		t.Fatalf("CoursesNeedingDetail: %v", err)
	}
	if len(pending) != 2 {
		t.Fatalf("cold cache: got %d pending, want 2", len(pending))
	}
	if pending[0].Name == "" {
		t.Error("the name must ride along: it is what it11 filters on")
	}

	// Program B fetches the shared course. A must now consider it done.
	course := catalog.Course{CampusCode: "9995", Code: "SHARED-1", Name: "Compartida",
		Sections: []catalog.Section{{CampusCode: "9995", Code: "SHARED-1", Term: "2026-2", Key: "1", Number: 1}}}
	if err := s.UpsertDetail(ctx, b.ID, "2026-2", catalog.CourseOffering{Course: course}); err != nil {
		t.Fatalf("UpsertDetail b: %v", err)
	}

	pending, err = s.CoursesNeedingDetail(ctx, a.ID, 24*time.Hour)
	if err != nil {
		t.Fatalf("CoursesNeedingDetail: %v", err)
	}
	if len(pending) != 1 || pending[0].Code != "ONLY-A" {
		t.Fatalf("got %+v, want only ONLY-A pending", pending)
	}
	if pending[0].Typology != "LIBRE ELECCIÓN (L)" {
		t.Errorf("typology must ride along: findRow needs it to search electives first, got %q", pending[0].Typology)
	}

	// Per-plan scope must NOT share: visibility is the one thing another
	// plan's fetch cannot teach us.
	perPlan, err := s.CoursesNeedingVisibility(ctx, a.ID, 24*time.Hour)
	if err != nil {
		t.Fatalf("CoursesNeedingVisibility: %v", err)
	}
	if len(perPlan) != 2 {
		t.Fatalf("per-plan: got %d pending, want 2", len(perPlan))
	}
	for _, ref := range perPlan {
		if ref.Code == "ONLY-A" && ref.Typology != "LIBRE ELECCIÓN (L)" {
			t.Errorf("CoursesNeedingVisibility: typology must ride along, got %q for %s", ref.Typology, ref.Code)
		}
	}
}

func TestDemandFeedsHotSet(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetCampus(t, s, "9996")

	p, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9996", FacultyCode: "2055", Code: "2D04", LevelSlug: "pregrado", Name: "HOT",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 12,
	})
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}
	if err := s.UpsertCatalog(ctx, p, []catalog.CourseOffering{
		{Course: catalog.Course{CampusCode: "9996", Code: "POPULAR", Name: "Popular"}, Typology: "ELECTIVA DE PREGRADO (E)"},
		{Course: catalog.Course{CampusCode: "9996", Code: "QUIET", Name: "Quieta"}},
	}); err != nil {
		t.Fatalf("UpsertCatalog: %v", err)
	}

	for i := 0; i < 3; i++ {
		if err := s.RecordDemand(ctx, "9996", "POPULAR"); err != nil {
			t.Fatalf("RecordDemand: %v", err)
		}
	}
	if err := s.RecordDemand(ctx, "9996", "QUIET"); err != nil {
		t.Fatalf("RecordDemand: %v", err)
	}

	hot, err := s.SeatsHotSet(ctx, "9996", 10)
	if err != nil {
		t.Fatalf("SeatsHotSet: %v", err)
	}
	if len(hot) != 2 {
		t.Fatalf("got %d in the hot set, want 2", len(hot))
	}
	if hot[0].Code != "POPULAR" {
		t.Errorf("hot set order = %v, want the most requested first", hot)
	}
	if hot[0].ProgramID != p.ID {
		t.Errorf("hot set must name a plan that sees the course, got program %d", hot[0].ProgramID)
	}
	if hot[0].Typology != "ELECTIVA DE PREGRADO (E)" {
		t.Errorf("SeatsHotSet: typology must ride along, got %q", hot[0].Typology)
	}

	// The limit is the budget, honoured.
	if hot, err = s.SeatsHotSet(ctx, "9996", 1); err != nil || len(hot) != 1 {
		t.Fatalf("limit ignored: %d %v", len(hot), err)
	}
}

// mkSeatedCourse writes one course, visible from programID, with a single
// section whose seats were last checked checkedAgo in the past. It exists
// only to give SeatsByDebt something to compute a debt over.
//
// term is the SIA term key for the section (e.g. "2026-2"). Tests that call
// SeatsByDebt must pass an ISOLATED synthetic term (e.g. "tst-debt-hot") so
// the query only sees rows belonging to that test — the test database is
// shared, and other tests leave real sections under "2026-2".
func mkSeatedCourse(t *testing.T, s *Store, programID int64, campusCode, code, term string, checkedAgo time.Duration) {
	t.Helper()
	ctx := context.Background()
	checkedAt := time.Now().Add(-checkedAgo)
	err := s.UpsertDetail(ctx, programID, term, catalog.CourseOffering{
		Course: catalog.Course{
			CampusCode: campusCode, Code: code, Name: code,
			Sections: []catalog.Section{{
				CampusCode: campusCode, Code: code, Term: term, Key: "1", Number: 1,
				Seats: &catalog.SeatSnapshot{Available: 10, MeasuredAt: checkedAt},
			}},
		},
	})
	if err != nil {
		t.Fatalf("mkSeatedCourse %s: %v", code, err)
	}
}

// TestSeatsByDebt_HotBeatsCold is decisión 3's whole point: debt is one
// comparable number across tiers, so a hot course outranks a cold one even
// when the cold one has waited far longer in absolute terms.
func TestSeatsByDebt_HotBeatsCold(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetCampus(t, s, "9997")
	const term = "tst-debt-hot" // isolated: SeatsByDebt is global by campus_code

	p, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9997", FacultyCode: "2055", Code: "2D05", LevelSlug: "pregrado", Name: "DEBT",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 13,
	})
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}

	// HOT: requested in the last hour, target 5m, checked 20m ago -> debt 4.0.
	mkSeatedCourse(t, s, p.ID, "9997", "HOT", term, 20*time.Minute)
	if err := s.RecordDemand(ctx, "9997", "HOT"); err != nil {
		t.Fatalf("RecordDemand: %v", err)
	}
	// COLD: no demand, target 6h, checked 7h ago -> debt ~1.17.
	mkSeatedCourse(t, s, p.ID, "9997", "COLD", term, 7*time.Hour)

	refs, err := s.SeatsByDebt(ctx, term, 5*time.Minute, 30*time.Minute, 6*time.Hour, 10)
	if err != nil {
		t.Fatalf("SeatsByDebt: %v", err)
	}
	if len(refs) != 2 {
		t.Fatalf("got %d courses, want 2: %+v", len(refs), refs)
	}
	if refs[0].Code != "HOT" {
		t.Errorf("debt order = %v, want HOT (higher debt) first", refs)
	}
}

// TestSeatsByDebt_SkipsFresh is the other half: a course inside its tier's
// target has nothing to do and must not show up at all.
func TestSeatsByDebt_SkipsFresh(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetCampus(t, s, "9998")
	const term = "tst-debt-fresh"

	p, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9998", FacultyCode: "2055", Code: "2D06", LevelSlug: "pregrado", Name: "FRESH",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 14,
	})
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}
	// Checked 1m ago against a 5m hot target: debt 0.2, well under 1.
	mkSeatedCourse(t, s, p.ID, "9998", "FRESH", term, time.Minute)
	if err := s.RecordDemand(ctx, "9998", "FRESH"); err != nil {
		t.Fatalf("RecordDemand: %v", err)
	}

	refs, err := s.SeatsByDebt(ctx, term, 5*time.Minute, 30*time.Minute, 6*time.Hour, 10)
	if err != nil {
		t.Fatalf("SeatsByDebt: %v", err)
	}
	if len(refs) != 0 {
		t.Fatalf("got %+v, want nothing: it is inside its target", refs)
	}
}

// TestSeatsByDebt_StablePlan is decisión 6: the plan a course is measured
// from must not change between calls, or UpsertDetail's per-plan
// section_program reconciliation flaps real groups on and off.
func TestSeatsByDebt_StablePlan(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetCampus(t, s, "9999")
	const term = "tst-debt-stable"

	mk := func(idx int) catalog.Program {
		p, err := s.UpsertProgram(ctx, catalog.Program{
			CampusCode: "9999", FacultyCode: "2055", Code: fmt.Sprintf("2D%02d", idx), LevelSlug: "pregrado", Name: "STABLE",
			CampusIdx: 2, FacultyIdx: 8, ProgramIdx: idx,
		})
		if err != nil {
			t.Fatalf("UpsertProgram: %v", err)
		}
		return p
	}
	a, b := mk(20), mk(21)
	lower := a.ID
	if b.ID < lower {
		lower = b.ID
	}

	mkSeatedCourse(t, s, a.ID, "9999", "SHARED", term, 7*time.Hour)
	mkSeatedCourse(t, s, b.ID, "9999", "SHARED", term, 7*time.Hour)

	first, err := s.SeatsByDebt(ctx, term, 5*time.Minute, 30*time.Minute, 6*time.Hour, 10)
	if err != nil {
		t.Fatalf("SeatsByDebt (1st): %v", err)
	}
	second, err := s.SeatsByDebt(ctx, term, 5*time.Minute, 30*time.Minute, 6*time.Hour, 10)
	if err != nil {
		t.Fatalf("SeatsByDebt (2nd): %v", err)
	}
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("got %d/%d rows, want 1/1: %+v %+v", len(first), len(second), first, second)
	}
	if first[0].ProgramID != second[0].ProgramID {
		t.Fatalf("plan changed between calls: %d then %d", first[0].ProgramID, second[0].ProgramID)
	}
	if first[0].ProgramID != lower {
		t.Errorf("plan = %d, want the lowest program_id %d", first[0].ProgramID, lower)
	}
}

// TestSeatsByDebt_SkipsDisabled is the same guard every other scheduler
// query in this file already respects: a course_program the reconciliation
// turned off must not feed a fetch.
func TestSeatsByDebt_SkipsDisabled(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetCampus(t, s, "9990")
	const term = "tst-debt-disabled"

	p, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9990", FacultyCode: "2055", Code: "2D07", LevelSlug: "pregrado", Name: "OFF",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 15,
	})
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}
	mkSeatedCourse(t, s, p.ID, "9990", "GONE", term, 7*time.Hour)

	if _, err := s.pool.Exec(ctx,
		`UPDATE course_program SET disabled_at = now() WHERE program_id = $1 AND code = $2`,
		p.ID, "GONE"); err != nil {
		t.Fatalf("disable course_program: %v", err)
	}

	refs, err := s.SeatsByDebt(ctx, term, 5*time.Minute, 30*time.Minute, 6*time.Hour, 10)
	if err != nil {
		t.Fatalf("SeatsByDebt: %v", err)
	}
	if len(refs) != 0 {
		t.Fatalf("got %+v, want nothing: the only plan that can see it is disabled", refs)
	}
}

func TestRunBookkeepingAndLock(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	id, err := s.StartRun(ctx, "test-mode", "global")
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	finished := time.Now()
	err = s.FinishRun(ctx, catalog.RefreshRun{
		ID: id, ProgramsOK: 7, ProgramsFailed: 1, ProgramsSkipped: 2, CoursesOK: 98,
		Posts: 201, Bytes: 31 << 20, FinishedAt: &finished, EndedReason: "done",
	})
	if err != nil {
		t.Fatalf("FinishRun: %v", err)
	}

	runs, err := s.LastRuns(ctx)
	if err != nil {
		t.Fatalf("LastRuns: %v", err)
	}
	var got *catalog.RefreshRun
	for i := range runs {
		if runs[i].Mode == "test-mode" {
			got = &runs[i]
		}
	}
	if got == nil {
		t.Fatal("LastRuns did not report the run")
	}
	if got.ProgramsOK != 7 || got.CoursesOK != 98 || got.EndedReason != "done" || got.FinishedAt == nil {
		t.Errorf("run round trip: %+v", got)
	}

	// The lock is what keeps two overlapping sweeps of one mode from
	// stacking. Taken twice from the SAME store it must refuse the second
	// caller: pg_try_advisory_lock is session-scoped and TryLock holds its
	// own connection, so this really is two different sessions.
	release, ok, err := s.TryLock(ctx, "refresh:test-mode")
	if err != nil || !ok {
		t.Fatalf("first TryLock: ok=%v err=%v", ok, err)
	}
	if _, ok, err := s.TryLock(ctx, "refresh:test-mode"); err != nil || ok {
		t.Errorf("second TryLock: ok=%v err=%v, want refused", ok, err)
	}
	release()
	release2, ok, err := s.TryLock(ctx, "refresh:test-mode")
	if err != nil || !ok {
		t.Fatalf("TryLock after release: ok=%v err=%v", ok, err)
	}
	release2()
}
