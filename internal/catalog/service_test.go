package catalog

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeStore is an in-memory catalog.Store for testing service.go without
// Postgres. Not a full simulation — just enough for what Service calls.
type fakeStore struct {
	mu         sync.Mutex
	programs   map[int64]Program
	nextID     int64
	courses    map[string]Course        // "campus|code"
	courseProg map[string]courseProgRow // "programID|code"
	sections   map[string][]Section     // "campus|code|programID"
}

type courseProgRow struct {
	Typology  string
	FetchedAt *time.Time
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		programs:   map[int64]Program{},
		courses:    map[string]Course{},
		courseProg: map[string]courseProgRow{},
		sections:   map[string][]Section{},
	}
}

func courseKey(campus, code string) string { return campus + "|" + code }
func cpKey(programID int64, code string) string {
	return fmt.Sprintf("%d|%s", programID, code)
}

func (f *fakeStore) UpsertProgram(_ context.Context, p Program) (Program, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, existing := range f.programs {
		if existing.CampusCode == p.CampusCode && existing.FacultyCode == p.FacultyCode && existing.Code == p.Code {
			p.ID = existing.ID
			p.CatalogFetchedAt = existing.CatalogFetchedAt
			f.programs[p.ID] = p
			return p, nil
		}
	}
	f.nextID++
	p.ID = f.nextID
	f.programs[p.ID] = p
	return p, nil
}

func (f *fakeStore) Program(_ context.Context, campusCode, facultyCode, code string) (Program, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.programs {
		if p.CampusCode == campusCode && p.FacultyCode == facultyCode && p.Code == code {
			return p, true, nil
		}
	}
	return Program{}, false, nil
}

func (f *fakeStore) Programs(_ context.Context, campusCode, facultyCode string) ([]Program, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Program
	for _, p := range f.programs {
		if p.CampusCode == campusCode && (facultyCode == "" || p.FacultyCode == facultyCode) {
			out = append(out, p)
		}
	}
	return out, nil
}

func (f *fakeStore) UpsertCatalog(_ context.Context, program Program, offerings []CourseOffering) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, o := range offerings {
		f.courses[courseKey(o.Course.CampusCode, o.Course.Code)] = o.Course
		f.courseProg[cpKey(program.ID, o.Course.Code)] = courseProgRow{Typology: o.Typology}
	}
	now := time.Now()
	p := f.programs[program.ID]
	p.CatalogFetchedAt = &now
	f.programs[program.ID] = p
	return nil
}

func (f *fakeStore) ProgramCourses(_ context.Context, programID int64) ([]CourseOffering, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []CourseOffering
	for _, c := range f.courses {
		if row, ok := f.courseProg[cpKey(programID, c.Code)]; ok {
			out = append(out, CourseOffering{Course: c, Typology: row.Typology})
		}
	}
	return out, nil
}

func (f *fakeStore) Course(_ context.Context, campusCode, code string) (Course, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.courses[courseKey(campusCode, code)]
	return c, ok, nil
}

func (f *fakeStore) CourseProgramFetchedAt(_ context.Context, programID int64, code string) (*time.Time, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.courseProg[cpKey(programID, code)]
	if !ok {
		return nil, false, nil
	}
	return row.FetchedAt, true, nil
}

func (f *fakeStore) UpsertDetail(_ context.Context, programID int64, offering CourseOffering) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := offering.Course
	f.courses[courseKey(c.CampusCode, c.Code)] = Course{
		CampusCode: c.CampusCode, Code: c.Code, Name: c.Name, Credits: c.Credits, Description: c.Description, FetchedAt: c.FetchedAt,
	}
	now := time.Now()
	f.courseProg[cpKey(programID, c.Code)] = courseProgRow{Typology: offering.Typology, FetchedAt: &now}
	f.sections[secKey(c.CampusCode, c.Code, programID)] = c.Sections
	return nil
}

func secKey(campus, code string, programID int64) string {
	return fmt.Sprintf("%s|%d", courseKey(campus, code), programID)
}

func (f *fakeStore) Sections(_ context.Context, campusCode, code string, programID int64) ([]Section, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sections[secKey(campusCode, code, programID)], nil
}

func (f *fakeStore) CourseProgramTypology(_ context.Context, programID int64, code string) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.courseProg[cpKey(programID, code)]
	return row.Typology, ok, nil
}

func (f *fakeStore) CurrentSeats(context.Context, int64) (SeatSnapshot, bool, error) {
	return SeatSnapshot{}, false, nil
}
func (f *fakeStore) ProgramsOfferingCourse(context.Context, string) ([]Program, error) {
	return nil, nil
}
func (f *fakeStore) SearchCourses(context.Context, string) ([]Course, error) { return nil, nil }
func (f *fakeStore) CachedProgramCount(context.Context) (int, int, error)    { return 0, 0, nil }

// fakeSIA counts calls per key so tests can assert singleflight dedup.
type fakeSIA struct {
	delay         time.Duration
	detailCalls   atomic.Int64
	catalogCalls  atomic.Int64
	electiveCalls atomic.Int64
}

func (f *fakeSIA) FetchProgramDirectory(context.Context, int, int) ([]DropdownOption, map[int][]DropdownOption, error) {
	return nil, nil, nil
}

func (f *fakeSIA) FetchCatalog(context.Context, ProgramKey) ([]CourseOffering, error) {
	f.catalogCalls.Add(1)
	time.Sleep(f.delay)
	return []CourseOffering{{Course: Course{CampusCode: "1101", Code: "2016696", Name: "Algoritmos", Credits: 3}}}, nil
}

func (f *fakeSIA) FetchElectives(context.Context, ProgramKey) ([]CourseOffering, error) {
	f.electiveCalls.Add(1)
	time.Sleep(f.delay)
	return nil, nil
}

func (f *fakeSIA) FetchDetail(_ context.Context, _ ProgramKey, code, term string) (CourseOffering, error) {
	f.detailCalls.Add(1)
	time.Sleep(f.delay)
	return CourseOffering{
		Course: Course{
			CampusCode: "1101", Code: code, Name: "Cálculo diferencial", Credits: 4,
			Sections: []Section{{CampusCode: "1101", Code: code, Term: term, Key: "1", Number: 1}},
		},
	}, nil
}

func testProgram(id int64) Program {
	return Program{ID: id, CampusCode: "1101", FacultyCode: "2055", Code: "2A74", Level: 0, CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3}
}

// TestCourseDetail_SingleflightCollapsesConcurrentColdFetches is paso 6's
// acceptance bar (docs/PLAN.md): two simultaneous cold requests for the
// SAME (program, code) make exactly ONE SIA call.
func TestCourseDetail_SingleflightCollapsesConcurrentColdFetches(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{delay: 30 * time.Millisecond}
	svc := NewService(store, sia, "2026-2")
	program, err := store.UpsertProgram(context.Background(), testProgram(0))
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	results := make([]CourseOffering, 2)
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, _, err := svc.CourseDetail(context.Background(), program, "1000004-B", DefaultFreshness)
			results[i] = c
			errs[i] = err
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if got := sia.detailCalls.Load(); got != 1 {
		t.Fatalf("got %d SIA detail calls for 2 concurrent identical requests, want 1", got)
	}
	if results[0].Course.Code != "1000004-B" || results[1].Course.Code != "1000004-B" {
		t.Errorf("results: %+v", results)
	}
}

// TestCourseDetail_DifferentProgramTriggersSeparateFetch is the other half
// of the same acceptance bar: a DIFFERENT program's cold request for the
// same code fires its OWN SIA call — visibility is per-program
// (DATA-MODEL.md decision 6).
func TestCourseDetail_DifferentProgramTriggersSeparateFetch(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{delay: 5 * time.Millisecond}
	svc := NewService(store, sia, "2026-2")

	p1, _ := store.UpsertProgram(context.Background(), testProgram(0))
	p2spec := testProgram(0)
	p2spec.Code = "2879" // the OTHER "Ingeniería de Sistemas y Computación"
	p2, _ := store.UpsertProgram(context.Background(), p2spec)

	if _, _, err := svc.CourseDetail(context.Background(), p1, "1000004-B", DefaultFreshness); err != nil {
		t.Fatalf("program 1: %v", err)
	}
	if _, _, err := svc.CourseDetail(context.Background(), p2, "1000004-B", DefaultFreshness); err != nil {
		t.Fatalf("program 2: %v", err)
	}
	if got := sia.detailCalls.Load(); got != 2 {
		t.Fatalf("got %d SIA calls across 2 different programs, want 2", got)
	}
}

// TestCourseDetail_WarmCacheServesFromStoreNoSIACall confirms a fresh
// course_program.detail_fetched_at short-circuits the SIA entirely.
func TestCourseDetail_WarmCacheServesFromStoreNoSIACall(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	program, _ := store.UpsertProgram(context.Background(), testProgram(0))

	if _, _, err := svc.CourseDetail(context.Background(), program, "1000004-B", DefaultFreshness); err != nil {
		t.Fatal(err)
	}
	if got := sia.detailCalls.Load(); got != 1 {
		t.Fatalf("first call: got %d SIA calls, want 1", got)
	}

	if _, _, err := svc.CourseDetail(context.Background(), program, "1000004-B", DefaultFreshness); err != nil {
		t.Fatal(err)
	}
	if got := sia.detailCalls.Load(); got != 1 {
		t.Fatalf("second call (should be a cache hit): got %d SIA calls total, want still 1", got)
	}
}

// TestCatalog_FetchesBothHalvesBeforeStamping is the "dos consultas, no una"
// invariant: a catalog miss must call BOTH FetchCatalog and FetchElectives.
func TestCatalog_FetchesBothHalvesBeforeStamping(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	program, _ := store.UpsertProgram(context.Background(), testProgram(0))

	if _, _, err := svc.Catalog(context.Background(), program, DefaultFreshness); err != nil {
		t.Fatal(err)
	}
	if got := sia.catalogCalls.Load(); got != 1 {
		t.Errorf("got %d regular catalog calls, want 1", got)
	}
	if got := sia.electiveCalls.Load(); got != 1 {
		t.Errorf("got %d electives calls, want 1 — the catalog of a plan is TWO queries", got)
	}
}
