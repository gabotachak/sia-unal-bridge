package catalog

import (
	"context"
	"errors"
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
	reference  map[string]time.Time     // scope -> fetched_at
	campuses   map[string][]Campus      // level slug
	levels     []Level
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
		reference:  map[string]time.Time{},
		campuses:   map[string][]Campus{},
	}
}

func (f *fakeStore) ReferenceFetchedAt(_ context.Context, scope string) (*time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.reference[scope]
	if !ok {
		return nil, nil
	}
	return &t, nil
}

func (f *fakeStore) UpsertPrograms(ctx context.Context, scope string, programs []Program) error {
	for _, p := range programs {
		if _, err := f.UpsertProgram(ctx, p); err != nil {
			return err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reference[scope] = time.Now()
	return nil
}

func (f *fakeStore) UpsertCampuses(_ context.Context, scope string, campuses []Campus) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range campuses {
		f.campuses[c.LevelSlug] = append(f.campuses[c.LevelSlug], c)
	}
	f.reference[scope] = time.Now()
	return nil
}

func (f *fakeStore) Campuses(_ context.Context, levelSlug string) ([]Campus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.campuses[levelSlug], nil
}

// UpsertLevels mirrors the real store's conflict target: match on Name, and
// never rewrite an existing slug.
func (f *fakeStore) UpsertLevels(_ context.Context, scope string, levels []Level) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, l := range levels {
		var matched bool
		for i, existing := range f.levels {
			if existing.Name == l.Name {
				f.levels[i].Index = l.Index
				matched = true
				break
			}
		}
		if !matched {
			f.levels = append(f.levels, l)
		}
	}
	f.reference[scope] = time.Now()
	return nil
}

func (f *fakeStore) Levels(context.Context) ([]Level, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.levels, nil
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

func (f *fakeStore) Programs(_ context.Context, campusCode, facultyCode, levelSlug string) ([]Program, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Program
	for _, p := range f.programs {
		if (campusCode == "" || p.CampusCode == campusCode) &&
			(facultyCode == "" || p.FacultyCode == facultyCode) &&
			(levelSlug == "" || p.LevelSlug == levelSlug) {
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

func (f *fakeStore) ProgramSchedules(_ context.Context, _ int64) (map[string][]SectionSchedule, error) {
	return nil, nil
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

func (f *fakeStore) UpsertDetail(_ context.Context, programID int64, _ string, offering CourseOffering) error {
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
func (f *fakeStore) ProgramsOfferingCourse(context.Context, string, string) ([]Program, error) {
	return nil, nil
}
func (f *fakeStore) SearchCourses(context.Context, string, string) ([]Course, error) {
	return nil, nil
}
func (f *fakeStore) ProgramCoverage(context.Context, string) (int, int, error) {
	return 0, 0, nil
}

// Fase 2's port additions. Stubs: the sweeps themselves are covered in
// internal/refresher, these only keep fakeStore satisfying catalog.Store.
func (f *fakeStore) CoursesNeedingDetail(context.Context, int64, time.Duration) ([]CourseRef, error) {
	return nil, nil
}
func (f *fakeStore) CoursesNeedingVisibility(context.Context, int64, time.Duration) ([]CourseRef, error) {
	return nil, nil
}
func (f *fakeStore) SeatsHotSet(context.Context, string, int) ([]CourseRef, error) { return nil, nil }
func (f *fakeStore) RecordDemand(context.Context, string, string) error            { return nil }
func (f *fakeStore) StartRun(context.Context, string, string) (int64, error)       { return 1, nil }
func (f *fakeStore) FinishRun(context.Context, RefreshRun) error                   { return nil }
func (f *fakeStore) LastRuns(context.Context) ([]RefreshRun, error)                { return nil, nil }
func (f *fakeStore) TryLock(context.Context, string) (func(), bool, error) {
	return func() {}, true, nil
}

// fakeSIA counts calls per key so tests can assert singleflight dedup.
type fakeSIA struct {
	delay time.Duration

	// catalogRows overrides the regular listing's size — 1000 is the SIA's
	// truncation cap (GOTCHAS §14); catalogEmpty makes it come back with no
	// rows at all, which is what a dirty soc4 or a re-painted page looks like.
	catalogRows  int
	catalogEmpty bool

	detailCalls    atomic.Int64
	catalogCalls   atomic.Int64
	electiveCalls  atomic.Int64
	directoryCalls atomic.Int64
	campusCalls    atomic.Int64
	levelCalls     atomic.Int64
}

func (f *fakeSIA) FetchLevels(context.Context) ([]LabelOption, error) {
	f.levelCalls.Add(1)
	time.Sleep(f.delay)
	return []LabelOption{
		{Index: 0, Label: "Pregrado"},
		{Index: 1, Label: "Doctorado"},
		{Index: 2, Label: "Postgrados y másteres"},
	}, nil
}

func (f *fakeSIA) FetchCampuses(context.Context, int) ([]DropdownOption, error) {
	f.campusCalls.Add(1)
	time.Sleep(f.delay)
	return []DropdownOption{
		{Index: 1, Code: "1125", Name: "SEDE AMAZONIA"},
		{Index: 2, Code: "1101", Name: "SEDE BOGOTÁ"},
		{Index: 6, Code: "1102", Name: "SEDE MEDELLÍN"},
	}, nil
}

// FetchProgramDirectory returns two faculties with one program each — enough
// shape to assert that ONE cascade fills every faculty, not just the one
// asked for — and answers differently per campus, so nothing can pass by
// assuming Bogotá. 2A74 exists in BOTH sedes on purpose: that is the PEAMA
// collision of GOTCHAS §26 (136 of 852 codes repeat).
func (f *fakeSIA) FetchProgramDirectory(_ context.Context, _, campusIdx int) ([]DropdownOption, map[int][]DropdownOption, error) {
	f.directoryCalls.Add(1)
	time.Sleep(f.delay)

	switch campusIdx {
	case 2: // Bogotá
		return []DropdownOption{
				{Index: 8, Code: "2055", Name: "FACULTAD DE INGENIERÍA"},
				{Index: 3, Code: "2054", Name: "FACULTAD DE CIENCIAS"},
			}, map[int][]DropdownOption{
				8: {{Index: 3, Code: "2A74", Name: "INGENIERÍA DE SISTEMAS Y COMPUTACIÓN"}},
				3: {{Index: 1, Code: "2A11", Name: "MATEMÁTICAS"}},
			}, nil
	case 6: // Medellín
		return []DropdownOption{
				{Index: 4, Code: "3059", Name: "FACULTAD DE MINAS"},
			}, map[int][]DropdownOption{
				4: {
					{Index: 2, Code: "3534", Name: "INGENIERÍA DE SISTEMAS E INFORMÁTICA"},
					{Index: 5, Code: "2A74", Name: "INGENIERÍA DE SISTEMAS Y COMPUTACIÓN (PEAMA)"},
				},
			}, nil
	}
	return nil, nil, ErrNotFound
}

func (f *fakeSIA) FetchCatalog(context.Context, ProgramKey) ([]CourseOffering, error) {
	f.catalogCalls.Add(1)
	time.Sleep(f.delay)
	switch {
	case f.catalogEmpty:
		return nil, nil
	case f.catalogRows > 0:
		out := make([]CourseOffering, f.catalogRows)
		for i := range out {
			out[i] = CourseOffering{Course: Course{CampusCode: "1101", Code: fmt.Sprintf("C%04d", i), Name: "Relleno"}}
		}
		return out, nil
	}
	return []CourseOffering{{Course: Course{CampusCode: "1101", Code: "2016696", Name: "Algoritmos", Credits: 3}}}, nil
}

func (f *fakeSIA) FetchElectives(context.Context, ProgramKey) ([]CourseOffering, error) {
	f.electiveCalls.Add(1)
	time.Sleep(f.delay)
	return nil, nil
}

func (f *fakeSIA) FetchDetail(_ context.Context, _ ProgramKey, ref CourseRef, term string) (CourseOffering, error) {
	code := ref.Code
	f.detailCalls.Add(1)
	time.Sleep(f.delay)
	return CourseOffering{
		Course: Course{
			CampusCode: "1101", Code: code, Name: "Cálculo diferencial", Credits: 4,
			Sections: []Section{{
				CampusCode: "1101", Code: code, Term: term, Key: "1", Number: 1,
				Seats: &SeatSnapshot{Available: 32, MeasuredAt: time.Now()},
			}},
		},
	}, nil
}

// FetchDetails is the batch of paso 4: one connection, many courses,
// incremental yield. The fake reuses FetchDetail so the count of SIA calls
// stays comparable between the two paths.
func (f *fakeSIA) FetchDetails(ctx context.Context, key ProgramKey, refs []CourseRef, term string,
	yield func(CourseOffering, error) error) error {
	for _, ref := range refs {
		o, err := f.FetchDetail(ctx, key, ref, term)
		if yerr := yield(o, err); yerr != nil {
			return yerr
		}
	}
	return nil
}

func testProgram(id int64) Program {
	return Program{ID: id, CampusCode: "1101", FacultyCode: "2055", Code: "2A74", LevelSlug: "pregrado", CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3}
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

// TestReference_SecondReadServesFromCache pins the rule the .md files set
// and the code ignored: reference data (docs/API.md "Frescura": 30 d) goes
// to the SIA only when it is missing or stale, never on every read. The
// cascade costs ~15 POSTs, so "always live" made /faculties a ~20 s call.
func TestReference_SecondReadServesFromCache(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()

	first, err := svc.Faculties(ctx, "1101", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 {
		t.Fatalf("got %d faculties, want 2", len(first))
	}
	if got := sia.directoryCalls.Load(); got != 1 {
		t.Fatalf("cold read: got %d cascades, want 1", got)
	}

	second, err := svc.Faculties(ctx, "1101", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != len(first) {
		t.Fatalf("warm read returned %d faculties, want %d", len(second), len(first))
	}
	if got := sia.directoryCalls.Load(); got != 1 {
		t.Fatalf("warm read hit the SIA: got %d cascades total, want still 1", got)
	}
}

// TestReference_OneCascadeFillsEveryFaculty: the cascade pays for all 13
// faculties' program lists to produce any one of them, so a miss on ONE
// faculty must persist them all. Discarding twelve meant the next faculty
// re-ran the whole thing.
func TestReference_OneCascadeFillsEveryFaculty(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()

	if _, err := svc.ProgramsInFaculty(ctx, "1101", "2055", ""); err != nil {
		t.Fatal(err)
	}
	others, err := svc.ProgramsInFaculty(ctx, "1101", "2054", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(others) != 1 || others[0].Code != "2A11" {
		t.Fatalf("got %v, want the other faculty's program filled by the same cascade", others)
	}
	if got := sia.directoryCalls.Load(); got != 1 {
		t.Fatalf("second faculty re-ran the cascade: got %d, want 1", got)
	}
}

// TestResolveProgram_UnknownCodeIsNotAnEndlessCascade: a fresh directory is
// authoritative about which programs exist, so absence from it IS the 404.
// Before, every 404 paid ~15 POSTs — a typo in a loop hammered the SIA.
func TestResolveProgram_UnknownCodeIsNotAnEndlessCascade(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()

	if _, err := svc.ResolveProgram(ctx, ProgramRef{Campus: "1101", Code: "2A74"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := svc.ResolveProgram(ctx, ProgramRef{Campus: "1101", Code: "NOPE"}); err != ErrNotFound {
			t.Fatalf("unknown code: got %v, want ErrNotFound", err)
		}
	}
	if got := sia.directoryCalls.Load(); got != 1 {
		t.Fatalf("got %d cascades, want 1 — unknown codes must not refetch a fresh directory", got)
	}
}

// TestSectionSeats_StaleSeatsRefetchThoughDetailIsFresh is the seats rule of
// docs/API.md "Frescura": cupos are governed by seat_snapshot.measured_at at
// 5 min, NOT by detail_fetched_at's 24 h. Routing /seats through CourseDetail
// served day-old seats under a Cache-Control of max-age=300.
func TestSectionSeats_StaleSeatsRefetchThoughDetailIsFresh(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()
	program, _ := store.UpsertProgram(ctx, testProgram(0))

	// Detail fetched just now (fresh for 24 h), seats measured 10 min ago
	// (stale past the 5 min seats TTL).
	stale := time.Now().Add(-10 * time.Minute)
	if err := store.UpsertDetail(ctx, program.ID, "2026-2", CourseOffering{Course: Course{
		CampusCode: "1101", Code: "1000004-B",
		Sections: []Section{{CampusCode: "1101", Code: "1000004-B", Term: "2026-2", Key: "1",
			Seats: &SeatSnapshot{Available: 5, MeasuredAt: stale}}},
	}}); err != nil {
		t.Fatal(err)
	}

	// The detail itself is fresh — this must NOT hit the SIA.
	if _, res, err := svc.CourseDetail(ctx, program, "1000004-B", DefaultFreshness); err != nil {
		t.Fatal(err)
	} else if res.Cache != CacheHit {
		t.Fatalf("detail: got %s, want hit — detail_fetched_at is minutes old", res.Cache)
	}

	section, res, err := svc.SectionSeats(ctx, program, "1000004-B", "1", DefaultFreshness)
	if err != nil {
		t.Fatal(err)
	}
	if res.Cache != CacheMiss {
		t.Fatalf("seats: got %s, want miss — the snapshot is 10 min old", res.Cache)
	}
	if got := sia.detailCalls.Load(); got != 1 {
		t.Fatalf("got %d SIA calls, want 1", got)
	}
	if section.Seats == nil || !section.Seats.MeasuredAt.After(stale) {
		t.Fatalf("seats not refreshed: %+v", section.Seats)
	}

	// docs/ARCH.md "Cupos": the same POST brings the whole group, so the refresh
	// must have re-stamped the detail cache too, not just the snapshot.
	if _, ok, err := store.CourseProgramFetchedAt(ctx, program.ID, "1000004-B"); err != nil || !ok {
		t.Fatalf("seats refresh did not persist the whole course (ok=%v, err=%v)", ok, err)
	}
}

// TestSectionSeats_FreshSeatsServeFromStore: the other half of the same
// rule — inside the 5 min window, no POST.
func TestSectionSeats_FreshSeatsServeFromStore(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()
	program, _ := store.UpsertProgram(ctx, testProgram(0))

	if err := store.UpsertDetail(ctx, program.ID, "2026-2", CourseOffering{Course: Course{
		CampusCode: "1101", Code: "1000004-B",
		Sections: []Section{{CampusCode: "1101", Code: "1000004-B", Term: "2026-2", Key: "1",
			Seats: &SeatSnapshot{Available: 5, MeasuredAt: time.Now().Add(-30 * time.Second)}}},
	}}); err != nil {
		t.Fatal(err)
	}

	section, res, err := svc.SectionSeats(ctx, program, "1000004-B", "1", DefaultFreshness)
	if err != nil {
		t.Fatal(err)
	}
	if res.Cache != CacheHit {
		t.Fatalf("got %s, want hit — the snapshot is 30 s old", res.Cache)
	}
	if got := sia.detailCalls.Load(); got != 0 {
		t.Fatalf("got %d SIA calls, want 0", got)
	}
	if section.Seats == nil || section.Seats.Available != 5 {
		t.Fatalf("got %+v, want the cached snapshot", section.Seats)
	}
}

// TestSectionSeats_MaxAgeZeroForcesFetch: docs/API.md "?max_age=0 fuerza
// consulta al SIA".
func TestSectionSeats_MaxAgeZeroForcesFetch(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()
	program, _ := store.UpsertProgram(ctx, testProgram(0))

	if err := store.UpsertDetail(ctx, program.ID, "2026-2", CourseOffering{Course: Course{
		CampusCode: "1101", Code: "1000004-B",
		Sections: []Section{{CampusCode: "1101", Code: "1000004-B", Term: "2026-2", Key: "1",
			Seats: &SeatSnapshot{Available: 5, MeasuredAt: time.Now()}}},
	}}); err != nil {
		t.Fatal(err)
	}

	if _, res, err := svc.SectionSeats(ctx, program, "1000004-B", "1", 0); err != nil {
		t.Fatal(err)
	} else if res.Cache != CacheMiss {
		t.Fatalf("got %s, want miss — max_age=0 forces the fetch", res.Cache)
	}
	if got := sia.detailCalls.Load(); got != 1 {
		t.Fatalf("got %d SIA calls, want 1", got)
	}
}

// TestCampuses_SecondReadServesFromCache: the sedes were a hardcoded slice
// in the HTTP layer. Now they are a SIA dropdown cached at the reference
// TTL, so the second read must not touch the SIA either.
func TestCampuses_SecondReadServesFromCache(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()

	first, err := svc.Campuses(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 3 {
		t.Fatalf("got %d campuses, want 3", len(first))
	}
	if first[1].Code != "1101" || first[1].Name != "SEDE BOGOTÁ" {
		t.Fatalf("got %+v, want the code/name split off the soc9 label", first[1])
	}
	if got := sia.campusCalls.Load(); got != 1 {
		t.Fatalf("cold read: got %d SIA calls, want 1", got)
	}

	if _, err := svc.Campuses(ctx, ""); err != nil {
		t.Fatal(err)
	}
	if got := sia.campusCalls.Load(); got != 1 {
		t.Fatalf("warm read hit the SIA: got %d calls total, want still 1", got)
	}
}

// TestLevels_SlugSurvivesReshuffledSoc1 is the invariant that makes levels
// cacheable at all: soc1's position is volatile (GOTCHAS §26) and its labels
// carry no code, so the slug is the only public identity — and it must be
// assigned once, never rewritten from a re-render. A client that bookmarked
// /v1/levels/posgrado must not find it renamed because the SIA reordered a
// dropdown.
func TestLevels_SlugSurvivesReshuffledSoc1(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()

	// Seeded exactly as the migration does: published slugs, real labels.
	if err := store.UpsertLevels(ctx, "seed", []Level{
		{Slug: "pregrado", Name: "Pregrado", Index: 0},
		{Slug: "doctorado", Name: "Doctorado", Index: 1},
		{Slug: "posgrado", Name: "Postgrados y másteres", Index: 2},
	}); err != nil {
		t.Fatal(err)
	}
	delete(store.reference, "levels") // force a refresh from the SIA

	levels, err := svc.Levels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	bySlug := map[string]Level{}
	for _, l := range levels {
		bySlug[l.Slug] = l
	}
	if _, ok := bySlug["posgrado"]; !ok {
		t.Fatalf("published slug 'posgrado' was rewritten: got %+v", levels)
	}
	if got := bySlug["posgrado"].Name; got != "Postgrados y másteres" {
		t.Fatalf("got name %q, want the SIA label", got)
	}
	if len(levels) != 3 {
		t.Fatalf("got %d levels, want 3 — a derived slug duplicated a seeded one", len(levels))
	}
}

// TestLevels_SecondReadServesFromCache: same rule as every other reference
// list.
func TestLevels_SecondReadServesFromCache(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()

	if _, err := svc.Levels(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Levels(ctx); err != nil {
		t.Fatal(err)
	}
	if got := sia.levelCalls.Load(); got != 1 {
		t.Fatalf("got %d SIA calls, want 1", got)
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Pregrado":              "pregrado",
		"Doctorado":             "doctorado",
		"Postgrados y másteres": "postgrados-y-masteres",
		"Especialización":       "especializacion",
	}
	for label, want := range cases {
		if got := slugify(label); got != want {
			t.Errorf("slugify(%q) = %q, want %q", label, got, want)
		}
	}
}

// TestReference_NonBogotaCampusResolves is the anti-regression for the
// Bogotá pin: nothing in the code may special-case one sede. Medellín must
// walk the exact same path, with its own soc9 index read from the campus
// cache and never from a constant.
func TestReference_NonBogotaCampusResolves(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()

	faculties, err := svc.Faculties(ctx, "1102", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(faculties) != 1 || faculties[0].Code != "3059" {
		t.Fatalf("got %+v, want Medellín's FACULTAD DE MINAS", faculties)
	}

	p, err := svc.ResolveProgram(ctx, ProgramRef{Campus: "1102", Code: "3534"})
	if err != nil {
		t.Fatal(err)
	}
	if p.CampusCode != "1102" || p.CampusIdx != 6 {
		t.Fatalf("got campus %q idx %d, want 1102/6 off the campus cache", p.CampusCode, p.CampusIdx)
	}
	// The nav coordinate handed to the SIA must carry Medellín's index, not
	// a compiled-in 2.
	if k := p.key(); k.Campus != 6 || k.CampusCode != "1102" {
		t.Fatalf("got key %+v, want Campus=6 CampusCode=1102", k)
	}
}

// TestResolveProgram_CollisionAcrossCampusesIs300: 2A74 exists in Bogotá and
// in Medellín (PEAMA). Unqualified, that must be an AmbiguousError with both
// candidates — never a silent pick of one sede.
func TestResolveProgram_CollisionAcrossCampusesIs300(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()

	// Warm both directories.
	if _, err := svc.Faculties(ctx, "1101", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Faculties(ctx, "1102", ""); err != nil {
		t.Fatal(err)
	}

	_, err := svc.ResolveProgram(ctx, ProgramRef{Code: "2A74"})
	var aerr *AmbiguousError
	if !errors.As(err, &aerr) {
		t.Fatalf("got %v, want AmbiguousError", err)
	}
	if len(aerr.Candidates) != 2 {
		t.Fatalf("got %d candidates, want 2", len(aerr.Candidates))
	}
	seen := map[string]bool{}
	for _, c := range aerr.Candidates {
		seen[c.CampusCode] = true
	}
	if !seen["1101"] || !seen["1102"] {
		t.Fatalf("candidates %+v, want one per sede", aerr.Candidates)
	}

	// Qualified, it resolves cleanly to the sede asked for.
	p, err := svc.ResolveProgram(ctx, ProgramRef{Campus: "1102", Code: "2A74"})
	if err != nil {
		t.Fatal(err)
	}
	if p.CampusCode != "1102" {
		t.Fatalf("got %q, want 1102", p.CampusCode)
	}
}

// TestResolveProgram_UnqualifiedNeverFetches: with no campus there is no
// cascade to run — the lookup is cache-only. Otherwise an unqualified 404
// would mean "crawl every sede", the DoS-by-GET docs/API.md rules out.
func TestResolveProgram_UnqualifiedNeverFetches(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")

	if _, err := svc.ResolveProgram(context.Background(), ProgramRef{Code: "2A74"}); err != ErrNotFound {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
	if got := sia.directoryCalls.Load(); got != 0 {
		t.Fatalf("got %d cascades, want 0", got)
	}
}

// TestCampuses_UnknownIsNotFound: an unknown sede must be a 404, never a
// quiet fallback to a default campus.
func TestCampuses_UnknownIsNotFound(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")

	if _, err := svc.Faculties(context.Background(), "9999", ""); err != ErrNotFound {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}

// TestReference_DefaultLevelSharesOneScope: an omitted ?level= and an
// explicit ?level=pregrado are the same directory. Building the cache scope
// from the raw parameter split them in two, so the "default" caller paid the
// ~15-POST cascade a second time.
func TestReference_DefaultLevelSharesOneScope(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")
	ctx := context.Background()

	if _, err := svc.Faculties(ctx, "1101", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Faculties(ctx, "1101", DefaultLevelSlug); err != nil {
		t.Fatal(err)
	}
	if got := sia.directoryCalls.Load(); got != 1 {
		t.Fatalf("got %d cascades, want 1 — the two spellings of the default level must share a scope", got)
	}
	if _, ok := store.reference["programs:1101:"+DefaultLevelSlug]; !ok {
		t.Fatalf("scopes are %v, want one keyed by the resolved slug", store.reference)
	}
}
