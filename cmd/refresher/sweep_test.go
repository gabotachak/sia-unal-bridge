package main

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
	"github.com/gabotachak/sia-unal-bridge/internal/refresher"
	"github.com/gabotachak/sia-unal-bridge/internal/store"
)

// These tests wire the real Store to a fake SIA: the interesting behaviour of
// a sweep — what it skips, what it re-fetches, when it gives up — lives in
// the SQL that answers "what is still stale", so faking the database would
// test the fake. Same tradeoff as internal/store's tests: TEST_DATABASE_URL
// or skip (docs/LAYOUT.md).
//
// Test campus codes are 999x, never a real sede, so a run against the dev
// database cannot disturb cached real data.
func testService(t *testing.T, sia catalog.SIASource) (*catalog.Service, *store.Store) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run refresher sweep tests")
	}
	st, err := store.New(context.Background(), url)
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(st.Close)
	return catalog.NewService(st, sia, "2026-2"), st
}

// exec runs a cleanup statement over its own connection: Store exposes
// queries, not raw SQL, and it should stay that way — the fixture's needs are
// not a reason to widen a production type.
func exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("pgx.Connect: %v", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}

// fakeSIA answers like a well-behaved SIA and counts what it was asked for.
// courses is the catalog every program gets; failCatalog makes every catalog
// fetch fail, which is how the circuit breaker gets exercised.
type fakeSIA struct {
	mu                sync.Mutex
	courses           []string
	catalogFetches    int
	detailFetches     int
	failCatalog       bool
	sectionsPerDetail int
}

func (f *fakeSIA) FetchLevels(context.Context) ([]catalog.LabelOption, error) {
	return []catalog.LabelOption{{Index: 0, Label: "Pregrado"}}, nil
}

func (f *fakeSIA) FetchCampuses(context.Context, int) ([]catalog.DropdownOption, error) {
	return []catalog.DropdownOption{{Index: 2, Code: "1101", Name: "SEDE BOGOTÁ"}}, nil
}

func (f *fakeSIA) FetchProgramDirectory(context.Context, int, int) ([]catalog.DropdownOption, map[int][]catalog.DropdownOption, error) {
	return nil, nil, nil
}

func (f *fakeSIA) FetchCatalog(_ context.Context, key catalog.ProgramKey) ([]catalog.CourseOffering, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.catalogFetches++
	if f.failCatalog {
		return nil, catalog.ErrSIANoop
	}
	out := make([]catalog.CourseOffering, 0, len(f.courses))
	for _, code := range f.courses {
		out = append(out, catalog.CourseOffering{
			Course:   catalog.Course{CampusCode: key.CampusCode, Code: code, Name: "Asignatura " + code},
			Typology: "FUND. OBLIGATORIA (B)",
		})
	}
	return out, nil
}

func (f *fakeSIA) FetchElectives(context.Context, catalog.ProgramKey) ([]catalog.CourseOffering, error) {
	return nil, nil
}

func (f *fakeSIA) FetchDetail(_ context.Context, key catalog.ProgramKey, ref catalog.CourseRef, term string) (catalog.CourseOffering, error) {
	code := ref.Code
	f.mu.Lock()
	f.detailFetches++
	n := f.sectionsPerDetail
	f.mu.Unlock()
	if n == 0 {
		n = 1
	}
	sections := make([]catalog.Section, n)
	for i := range sections {
		sections[i] = catalog.Section{
			CampusCode: key.CampusCode, Code: code, Term: term,
			Key: fmt.Sprint(i + 1), Number: i + 1,
			Seats: &catalog.SeatSnapshot{Available: 30, MeasuredAt: time.Now()},
		}
	}
	return catalog.CourseOffering{
		Course:   catalog.Course{CampusCode: key.CampusCode, Code: code, Name: "Asignatura " + code, Sections: sections},
		Typology: "FUND. OBLIGATORIA (B)",
	}, nil
}

func (f *fakeSIA) FetchDetails(ctx context.Context, key catalog.ProgramKey, refs []catalog.CourseRef, term string,
	yield func(catalog.CourseOffering, error) error) error {
	for _, ref := range refs {
		o, err := f.FetchDetail(ctx, key, ref, term)
		if yerr := yield(o, err); yerr != nil {
			return yerr
		}
	}
	return nil
}

func (f *fakeSIA) counts() (catalogs, details int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.catalogFetches, f.detailFetches
}

// resetCampus wipes a test-only sede before a sweep: course rows cascade to
// course_program, section, section_program and seat_snapshot. Deleting only the
// programs is not enough — the section rows a previous run wrote would make
// every course look globally fresh, and the sweep under test would correctly
// fetch nothing.
func resetCampus(t *testing.T, campus string) {
	t.Helper()
	exec(t, `DELETE FROM course WHERE campus_code = $1`, campus)
	exec(t, `DELETE FROM program WHERE campus_code = $1`, campus)
	exec(t, `DELETE FROM course_demand WHERE campus_code = $1`, campus)
}

func seedProgram(t *testing.T, st *store.Store, campus, code string, idx int) catalog.Program {
	t.Helper()
	ctx := context.Background()
	p, err := st.UpsertProgram(ctx, catalog.Program{
		CampusCode: campus, FacultyCode: "2055", Code: code, LevelSlug: "pregrado", Name: "PLAN " + code,
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: idx,
	})
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}
	return p
}

func opts(mode, campus string) refresher.Options {
	return refresher.Options{
		Mode: mode, Campus: campus, Workers: 2,
		MaxDuration: time.Minute,
		// The rate limiter is off: it is a ticker, and here it would only
		// make the test slow.
		RatePostsPerSec: 0,
	}
}

// A second consecutive sweep must make ZERO fetches: the freshness marks are
// the checkpoint, so re-running is both how you resume and how you do
// nothing (docs/FASE-2.md "El checkpoint ya existe").
func TestCatalogSweep_SecondRunIsFree(t *testing.T) {
	sia := &fakeSIA{courses: []string{"A-1", "A-2", "A-3"}}
	svc, st := testService(t, sia)
	ctx := context.Background()
	resetCampus(t, "9990")
	seedProgram(t, st, "9990", "2C01", 1)
	seedProgram(t, st, "9990", "2C02", 2)

	rep, err := refresher.Run(ctx, svc, opts(refresher.ModeCatalog, "9990"), nil)
	if err != nil {
		t.Fatalf("first sweep: %v", err)
	}
	if rep.ProgramsOK != 2 || rep.ProgramsFailed != 0 {
		t.Fatalf("first sweep: %+v", rep)
	}
	if rep.CoursesOK != 6 {
		t.Errorf("first sweep saw %d courses, want 6", rep.CoursesOK)
	}
	if rep.EndedReason != refresher.ReasonDone || rep.Unvisited() != 0 {
		t.Errorf("first sweep ended %q with %d unvisited", rep.EndedReason, rep.Unvisited())
	}
	// programas = ok + saltados + fallidos, sin residuo.
	if rep.ProgramsTotal != rep.ProgramsOK+rep.ProgramsSkipped+rep.ProgramsFailed {
		t.Errorf("report does not add up: %+v", rep)
	}
	catalogs, _ := sia.counts()
	if catalogs != 2 {
		t.Errorf("%d catalog fetches, want 1 per program", catalogs)
	}

	rep, err = refresher.Run(ctx, svc, opts(refresher.ModeCatalog, "9990"), nil)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if rep.ProgramsSkipped != 2 || rep.ProgramsOK != 0 {
		t.Errorf("second sweep: %+v, want everything skipped", rep)
	}
	if after, _ := sia.counts(); after != catalogs {
		t.Errorf("second sweep made %d extra fetches, want 0", after-catalogs)
	}
}

// Paso 4's third acceptance criterion, in the small: the section rows are
// global, so the second program only pays for the courses the first one did
// not already cover.
func TestDetailSweep_GlobalFreshnessSharesWork(t *testing.T) {
	sia := &fakeSIA{courses: []string{"S-1", "S-2", "S-3", "S-4"}}
	svc, st := testService(t, sia)
	ctx := context.Background()
	resetCampus(t, "9991")
	seedProgram(t, st, "9991", "2D10", 1)
	seedProgram(t, st, "9991", "2D11", 2)

	if _, err := refresher.Run(ctx, svc, opts(refresher.ModeCatalog, "9991"), nil); err != nil {
		t.Fatalf("catalog sweep: %v", err)
	}

	// One worker so the two plans are walked in order: with both in flight
	// they would each enumerate the same 4 pending courses before either
	// wrote anything, and pay twice. That is waste, not incorrectness — the
	// upserts are idempotent — but it would make this assertion a race.
	global := opts(refresher.ModeDetail, "9991")
	global.Scope = refresher.ScopeGlobal
	global.Workers = 1
	if _, err := refresher.Run(ctx, svc, global, nil); err != nil {
		t.Fatalf("detail sweep: %v", err)
	}
	_, details := sia.counts()
	if details != 4 {
		t.Fatalf("%d detail fetches for 4 courses shared by 2 plans, want 4", details)
	}

	// Running it again fetches nothing: everything is globally fresh.
	if _, err := refresher.Run(ctx, svc, global, nil); err != nil {
		t.Fatalf("second detail sweep: %v", err)
	}
	if _, again := sia.counts(); again != details {
		t.Errorf("second detail sweep made %d extra fetches, want 0", again-details)
	}

	// Per-plan scope is a different question — visibility — and must NOT be
	// satisfied by another plan's fetch. Program B never asked, so it pays.
	perPlan := opts(refresher.ModeDetail, "9991")
	perPlan.Scope = refresher.ScopePlan
	perPlan.Workers = 1
	if _, err := refresher.Run(ctx, svc, perPlan, nil); err != nil {
		t.Fatalf("per-plan sweep: %v", err)
	}
	if _, after := sia.counts(); after != details+4 {
		t.Errorf("per-plan sweep fetched %d, want the 4 courses of the plan that never asked", after-details)
	}
}

// The circuit breaker: five programs failing in a row aborts the sweep with a
// non-zero exit, instead of walking 1380 programs to write nothing.
func TestSweep_CircuitBreakerAborts(t *testing.T) {
	sia := &fakeSIA{courses: []string{"X-1"}, failCatalog: true}
	svc, st := testService(t, sia)
	ctx := context.Background()
	resetCampus(t, "9992")
	for i := 1; i <= 12; i++ {
		seedProgram(t, st, "9992", fmt.Sprintf("2E%02d", i), i)
	}

	o := opts(refresher.ModeCatalog, "9992")
	o.Workers = 1 // deterministic: failures land in order
	rep, err := refresher.Run(ctx, svc, o, nil)
	if err == nil {
		t.Fatal("a tripped circuit breaker must return an error so the process exits non-zero")
	}
	if rep.EndedReason != refresher.ReasonCircuitBreaker {
		t.Errorf("ended_reason = %q, want %q", rep.EndedReason, refresher.ReasonCircuitBreaker)
	}
	if rep.ProgramsFailed > 6 {
		t.Errorf("%d programs attempted after tripping; it should stop at 5", rep.ProgramsFailed)
	}
	if rep.Unvisited() == 0 {
		t.Error("an aborted sweep must leave programs unvisited")
	}
}

// The seats sweep works off real client demand, never off "everything the job
// already touched".
func TestSeatsSweep_UsesDemandHotSet(t *testing.T) {
	sia := &fakeSIA{courses: []string{"H-1", "H-2", "H-3"}, sectionsPerDetail: 2}
	svc, st := testService(t, sia)
	ctx := context.Background()
	resetCampus(t, "9993")
	seedProgram(t, st, "9993", "2F01", 1)

	if _, err := refresher.Run(ctx, svc, opts(refresher.ModeCatalog, "9993"), nil); err != nil {
		t.Fatalf("catalog sweep: %v", err)
	}

	// No demand recorded: nothing to warm, and that is not a failure.
	seats := opts(refresher.ModeSeats, "9993")
	rep, err := refresher.Run(ctx, svc, seats, nil)
	if err != nil {
		t.Fatalf("seats sweep with no demand: %v", err)
	}
	if _, details := sia.counts(); details != 0 {
		t.Errorf("an empty hot set fetched %d details, want 0", details)
	}
	if rep.ProgramsTotal != 0 {
		t.Errorf("empty hot set should enqueue nothing, got %+v", rep)
	}

	// One course asked for by a client is one course warmed.
	if err := svc.RecordDemand(ctx, "9993", "H-2"); err != nil {
		t.Fatalf("RecordDemand: %v", err)
	}
	if _, err := refresher.Run(ctx, svc, seats, nil); err != nil {
		t.Fatalf("seats sweep: %v", err)
	}
	if _, details := sia.counts(); details != 1 {
		t.Errorf("%d details fetched, want exactly the one course with demand", details)
	}
}
