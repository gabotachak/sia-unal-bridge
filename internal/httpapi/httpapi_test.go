package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// High enough that the per-IP rate limiter never fires within a single test:
// these tests exercise caching/cooldown behavior, not throughput limiting.
const (
	testRateRPS   = 1e6
	testRateBurst = 1e6
)

// Minimal in-memory fakes — same shape as internal/catalog/service_test.go's,
// duplicated because Go test doubles in _test.go files aren't exported
// across packages. Only what these handler tests exercise.
type fakeStore struct {
	mu         sync.Mutex
	programs   map[int64]catalog.Program
	nextID     int64
	courses    map[string]catalog.Course
	courseProg map[string]struct {
		Typology  string
		FetchedAt *time.Time
	}
	sections  map[string][]catalog.Section
	schedules map[string][]catalog.SectionSchedule
	reference map[string]time.Time
	campuses  map[string][]catalog.Campus
	levels    []catalog.Level
	demand    map[string]int // campus/code → veces que un CLIENTE lo pidió
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		programs: map[int64]catalog.Program{},
		courses:  map[string]catalog.Course{},
		courseProg: map[string]struct {
			Typology  string
			FetchedAt *time.Time
		}{},
		sections:  map[string][]catalog.Section{},
		reference: map[string]time.Time{},
		campuses:  map[string][]catalog.Campus{},
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

func (f *fakeStore) UpsertPrograms(ctx context.Context, scope string, programs []catalog.Program) error {
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

func (f *fakeStore) UpsertCampuses(_ context.Context, scope string, campuses []catalog.Campus) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range campuses {
		f.campuses[c.LevelSlug] = append(f.campuses[c.LevelSlug], c)
	}
	f.reference[scope] = time.Now()
	return nil
}

func (f *fakeStore) Campuses(_ context.Context, levelSlug string) ([]catalog.Campus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.campuses[levelSlug], nil
}

func (f *fakeStore) UpsertLevels(_ context.Context, scope string, levels []catalog.Level) error {
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

func (f *fakeStore) Levels(context.Context) ([]catalog.Level, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.levels, nil
}

func ck(campus, code string) string    { return campus + "|" + code }
func cpk(id int64, code string) string { return fmt.Sprintf("%d|%s", id, code) }

func (f *fakeStore) UpsertProgram(_ context.Context, p catalog.Program) (catalog.Program, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, e := range f.programs {
		if e.CampusCode == p.CampusCode && e.FacultyCode == p.FacultyCode && e.Code == p.Code {
			p.ID = e.ID
			p.CatalogFetchedAt = e.CatalogFetchedAt
			f.programs[p.ID] = p
			return p, nil
		}
	}
	f.nextID++
	p.ID = f.nextID
	f.programs[p.ID] = p
	return p, nil
}

func (f *fakeStore) Program(_ context.Context, campusCode, facultyCode, code string) (catalog.Program, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.programs {
		if p.CampusCode == campusCode && p.FacultyCode == facultyCode && p.Code == code {
			return p, true, nil
		}
	}
	return catalog.Program{}, false, nil
}

func (f *fakeStore) Programs(_ context.Context, campusCode, facultyCode, levelSlug string) ([]catalog.Program, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []catalog.Program
	for _, p := range f.programs {
		if (campusCode == "" || p.CampusCode == campusCode) &&
			(facultyCode == "" || p.FacultyCode == facultyCode) &&
			(levelSlug == "" || p.LevelSlug == levelSlug) {
			out = append(out, p)
		}
	}
	return out, nil
}

func (f *fakeStore) UpsertCatalog(_ context.Context, program catalog.Program, offerings []catalog.CourseOffering) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, o := range offerings {
		f.courses[ck(o.Course.CampusCode, o.Course.Code)] = o.Course
		row := f.courseProg[cpk(program.ID, o.Course.Code)]
		row.Typology = o.Typology
		f.courseProg[cpk(program.ID, o.Course.Code)] = row
	}
	now := time.Now()
	p := f.programs[program.ID]
	p.CatalogFetchedAt = &now
	f.programs[program.ID] = p
	return nil
}

func (f *fakeStore) ProgramSchedules(_ context.Context, _ int64) (map[string][]catalog.SectionSchedule, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.schedules, nil
}

func (f *fakeStore) ProgramCourses(_ context.Context, programID int64) ([]catalog.CourseOffering, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []catalog.CourseOffering
	for _, c := range f.courses {
		if row, ok := f.courseProg[cpk(programID, c.Code)]; ok {
			out = append(out, catalog.CourseOffering{Course: c, Typology: row.Typology})
		}
	}
	return out, nil
}

func (f *fakeStore) Course(_ context.Context, campusCode, code string) (catalog.Course, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.courses[ck(campusCode, code)]
	return c, ok, nil
}

func (f *fakeStore) CourseProgramFetchedAt(_ context.Context, programID int64, code string) (*time.Time, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.courseProg[cpk(programID, code)]
	if !ok {
		return nil, false, nil
	}
	return row.FetchedAt, true, nil
}

func (f *fakeStore) CourseProgramTypology(_ context.Context, programID int64, code string) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.courseProg[cpk(programID, code)]
	return row.Typology, ok, nil
}

func (f *fakeStore) UpsertDetail(_ context.Context, programID int64, _ string, offering catalog.CourseOffering) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := offering.Course
	f.courses[ck(c.CampusCode, c.Code)] = catalog.Course{
		CampusCode: c.CampusCode, Code: c.Code, Name: c.Name, Credits: c.Credits, Description: c.Description, FetchedAt: c.FetchedAt,
	}
	now := time.Now()
	row := f.courseProg[cpk(programID, c.Code)]
	row.Typology, row.FetchedAt = offering.Typology, &now
	f.courseProg[cpk(programID, c.Code)] = row
	f.sections[fmt.Sprintf("%s|%d", ck(c.CampusCode, c.Code), programID)] = c.Sections
	return nil
}

func (f *fakeStore) Sections(_ context.Context, campusCode, code string, programID int64) ([]catalog.Section, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sections[fmt.Sprintf("%s|%d", ck(campusCode, code), programID)], nil
}

func (f *fakeStore) CurrentSeats(context.Context, int64) (catalog.SeatSnapshot, bool, error) {
	return catalog.SeatSnapshot{}, false, nil
}
func (f *fakeStore) ProgramsOfferingCourse(_ context.Context, campusCode, code string) ([]catalog.Program, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []catalog.Program
	for _, p := range f.programs {
		if _, ok := f.courseProg[cpk(p.ID, code)]; ok {
			out = append(out, p)
		}
	}
	return out, nil
}
func (f *fakeStore) SearchCourses(context.Context, string, string) ([]catalog.Course, error) {
	return nil, nil
}
func (f *fakeStore) ProgramCoverage(context.Context, string) (int, int, error) {
	return 0, 0, nil
}

// Fase 2's port additions. demand records what recordDemand counted, so a
// test can assert the API feeds the hot set.
func (f *fakeStore) CoursesNeedingDetail(context.Context, int64, time.Duration) ([]catalog.CourseRef, error) {
	return nil, nil
}
func (f *fakeStore) CoursesNeedingVisibility(context.Context, int64, time.Duration) ([]catalog.CourseRef, error) {
	return nil, nil
}
func (f *fakeStore) SeatsHotSet(context.Context, string, int) ([]catalog.CourseRef, error) {
	return nil, nil
}
func (f *fakeStore) RecordDemand(_ context.Context, campusCode, code string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.demand == nil {
		f.demand = map[string]int{}
	}
	f.demand[campusCode+"/"+code]++
	return nil
}
func (f *fakeStore) StartRun(context.Context, string, string) (int64, error) { return 1, nil }
func (f *fakeStore) FinishRun(context.Context, catalog.RefreshRun) error     { return nil }
func (f *fakeStore) LastRuns(context.Context) ([]catalog.RefreshRun, error) {
	return []catalog.RefreshRun{{ID: 1, Mode: "catalog", Scope: "", EndedReason: "done"}}, nil
}
func (f *fakeStore) TryLock(context.Context, string) (func(), bool, error) {
	return func() {}, true, nil
}

type fakeSIA struct {
	detailCalls int
}

func (f *fakeSIA) FetchLevels(context.Context) ([]catalog.LabelOption, error) {
	return []catalog.LabelOption{
		{Index: 0, Label: "Pregrado"},
		{Index: 1, Label: "Doctorado"},
		{Index: 2, Label: "Postgrados y másteres"},
	}, nil
}

func (f *fakeSIA) FetchCampuses(context.Context, int) ([]catalog.DropdownOption, error) {
	return []catalog.DropdownOption{
		{Index: 1, Code: "1125", Name: "SEDE AMAZONIA"},
		{Index: 2, Code: "1101", Name: "SEDE BOGOTÁ"},
	}, nil
}

func (f *fakeSIA) FetchProgramDirectory(context.Context, int, int) ([]catalog.DropdownOption, map[int][]catalog.DropdownOption, error) {
	return []catalog.DropdownOption{{Index: 8, Code: "2055", Name: "FACULTAD DE INGENIERÍA"}},
		map[int][]catalog.DropdownOption{
			8: {{Index: 3, Code: "2A74", Name: "INGENIERÍA DE SISTEMAS Y COMPUTACIÓN"}},
		}, nil
}
func (f *fakeSIA) FetchCatalog(context.Context, catalog.ProgramKey) ([]catalog.CourseOffering, error) {
	return nil, nil
}
func (f *fakeSIA) FetchElectives(context.Context, catalog.ProgramKey) ([]catalog.CourseOffering, error) {
	return nil, nil
}
func (f *fakeSIA) FetchDetail(_ context.Context, _ catalog.ProgramKey, code, term string) (catalog.CourseOffering, error) {
	f.detailCalls++
	return catalog.CourseOffering{
		Course: catalog.Course{
			CampusCode: "1101", Code: code, Name: "Algoritmos", Credits: 3, Description: "...",
			Sections: []catalog.Section{{
				CampusCode: "1101", Code: code, Term: term, Key: "1", Number: 1, Label: "Grupo 1",
				Shift: "DIURNO", Duration: "Semestral",
				Schedule: []catalog.ClassSession{{Weekday: time.Wednesday, StartTime: "09:00", EndTime: "11:00", Room: "SALA 453-203", Building: "453 - Guillermina Uribe Bone"}},
				Seats:    &catalog.SeatSnapshot{Available: 32, MeasuredAt: time.Now()},
			}},
		},
		Typology: "FUND. OBLIGATORIA (B)",
	}, nil
}

func (f *fakeSIA) FetchDetails(ctx context.Context, key catalog.ProgramKey, refs []catalog.CourseRef, term string,
	yield func(catalog.CourseOffering, error) error) error {
	for _, ref := range refs {
		o, err := f.FetchDetail(ctx, key, ref.Code, term)
		if yerr := yield(o, err); yerr != nil {
			return yerr
		}
	}
	return nil
}

// TestCourseDetail_MissThenHit is paso 7's acceptance bar (docs/PLAN.md):
// curl /v1/campuses/{campus}/programs/{program}/courses/{code} returns API.md's example
// shape, with X-Cache: miss the first time and hit the second.
func TestCourseDetail_MissThenHit(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := catalog.NewService(store, sia, "2026-2")
	program, err := store.UpsertProgram(context.Background(), catalog.Program{
		CampusCode: "1101", FacultyCode: "2055", Code: "2A74", LevelSlug: "pregrado",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3,
	})
	if err != nil {
		t.Fatal(err)
	}

	router := NewRouter(svc, 0, testRateRPS, testRateBurst, 0, "test", "test") // cooldown 0: these tests are about caching, not throttling
	url := "/v1/campuses/1101/programs/2A74/courses/2016696"

	// ── miss ──
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, url, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("got status %d, body %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-Cache"); got != "miss" {
		t.Errorf("got X-Cache=%q, want miss", got)
	}
	if w.Header().Get("X-SIA-Fetch-Ms") == "" {
		t.Error("expected X-SIA-Fetch-Ms on a miss")
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("json: %v", err)
	}
	for _, field := range []string{"campus_code", "code", "name", "credits", "typology", "description", "fetched_at", "sections"} {
		if _, ok := body[field]; !ok {
			t.Errorf("missing field %q in response: %s", field, w.Body.String())
		}
	}
	if body["code"] != "2016696" {
		t.Errorf("got code %v, want 2016696", body["code"])
	}
	sections, _ := body["sections"].([]any)
	if len(sections) != 1 {
		t.Fatalf("got %d sections, want 1", len(sections))
	}
	section := sections[0].(map[string]any)
	seats, ok := section["seats"].(map[string]any)
	if !ok {
		t.Fatalf("expected seats object in section: %+v", section)
	}
	if _, ok := seats["age_seconds"]; !ok {
		t.Error("seats missing age_seconds — docs/API.md 'nunca se sirve un cupo sin decir de cuándo es'")
	}

	if sia.detailCalls != 1 {
		t.Fatalf("got %d SIA calls after first request, want 1", sia.detailCalls)
	}

	// ── hit ──
	program, _, _ = store.Program(context.Background(), "1101", "2055", "2A74")
	_ = program
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, url, nil)
	router.ServeHTTP(w2, req2)

	if w2.Code != http.StatusOK {
		t.Fatalf("got status %d, body %s", w2.Code, w2.Body.String())
	}
	if got := w2.Header().Get("X-Cache"); got != "hit" {
		t.Errorf("got X-Cache=%q, want hit", got)
	}
	if sia.detailCalls != 1 {
		t.Fatalf("got %d SIA calls after second (should be cached) request, want still 1", sia.detailCalls)
	}
}

func TestCourseDetail_UnknownCourseIs404(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := catalog.NewService(store, sia, "2026-2")
	_, err := store.UpsertProgram(context.Background(), catalog.Program{
		CampusCode: "1101", FacultyCode: "2055", Code: "2A74", CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	router := NewRouter(svc, 0, testRateRPS, testRateBurst, 0, "test", "test") // cooldown 0: these tests are about caching, not throttling

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/campuses/1101/programs/ZZZZ/courses/2016696", nil)
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("got status %d, want 404 for unknown program", w.Code)
	}
	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["error"] != "unknown_program" {
		t.Errorf("got error=%q, want unknown_program", body["error"])
	}
}

func TestHealthz(t *testing.T) {
	store := newFakeStore()
	svc := catalog.NewService(store, &fakeSIA{}, "2026-2")
	router := NewRouter(svc, 0, testRateRPS, testRateBurst, 0, "test", "test") // cooldown 0: these tests are about caching, not throttling

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/healthz", nil)
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("got status %d", w.Code)
	}
}

func TestMaxAge_InvalidIsBadRequest(t *testing.T) {
	store := newFakeStore()
	svc := catalog.NewService(store, &fakeSIA{}, "2026-2")
	_, err := store.UpsertProgram(context.Background(), catalog.Program{
		CampusCode: "1101", FacultyCode: "2055", Code: "2A74", CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	router := NewRouter(svc, 0, testRateRPS, testRateBurst, 0, "test", "test") // cooldown 0: these tests are about caching, not throttling

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/campuses/1101/programs/2A74/courses/2016696?max_age=-5", nil)
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400 for negative max_age", w.Code)
	}
}

// cooldownFixture wires a router with a live throttle and a program already
// in the store, and hands back the SIA fake so tests can count real fetches.
func cooldownFixture(t *testing.T, cooldown int) (*gin.Engine, *fakeSIA, string) {
	t.Helper()
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := catalog.NewService(store, sia, "2026-2")
	if _, err := store.UpsertProgram(context.Background(), catalog.Program{
		CampusCode: "1101", FacultyCode: "2055", Code: "2A74", LevelSlug: "pregrado",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3,
	}); err != nil {
		t.Fatal(err)
	}
	return NewRouter(svc, cooldown, testRateRPS, testRateBurst, 0, "test", "test"), sia, "/v1/campuses/1101/programs/2A74/courses/2016696"
}

func do(router *gin.Engine, url string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, url, nil))
	return w
}

// A course nobody has ever fetched must not be throttled: that request is a
// first fetch, not a refresh. The bug this pins down answered 429 *after*
// fetching from the SIA, so the client paid the round trip and saw none of it.
func TestCooldown_ColdCacheIsNotThrottled(t *testing.T) {
	router, sia, url := cooldownFixture(t, 60)

	w := do(router, url+"?max_age=0")
	if w.Code != http.StatusOK {
		t.Fatalf("got status %d on a cold cache, want 200. body %s", w.Code, w.Body.String())
	}
	if sia.detailCalls != 1 {
		t.Errorf("got %d SIA detail calls, want exactly 1", sia.detailCalls)
	}
}

// The gate must cost nothing at the SIA: a throttled request may not fetch.
func TestCooldown_BlocksSecondForcedRefresh(t *testing.T) {
	router, sia, url := cooldownFixture(t, 60)

	if w := do(router, url+"?max_age=0"); w.Code != http.StatusOK {
		t.Fatalf("warm-up got status %d, want 200", w.Code)
	}
	w := do(router, url+"?max_age=0")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("got status %d on immediate re-refresh, want 429", w.Code)
	}
	if sia.detailCalls != 1 {
		t.Errorf("got %d SIA detail calls, want 1 — the throttled request must not fetch", sia.detailCalls)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Error("expected a Retry-After header on 429")
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "rate_limit" {
		t.Errorf("got error=%v, want rate_limit", body["error"])
	}
	if body["retry_after_seconds"] == nil {
		t.Error("expected retry_after_seconds in the body")
	}
}

// The bypass: gating only max_age==0 left ?max_age=1 as a free hole, since a
// cache is essentially never under a second old.
func TestCooldown_SubCooldownMaxAgeIsNotABypass(t *testing.T) {
	router, sia, url := cooldownFixture(t, 60)

	if w := do(router, url+"?max_age=0"); w.Code != http.StatusOK {
		t.Fatalf("warm-up got status %d, want 200", w.Code)
	}
	for _, maxAge := range []string{"1", "5", "59"} {
		w := do(router, url+"?max_age="+maxAge)
		if w.Code != http.StatusTooManyRequests {
			t.Errorf("max_age=%s got status %d, want 429 — under the cooldown is still a forced refresh", maxAge, w.Code)
		}
	}
	if sia.detailCalls != 1 {
		t.Errorf("got %d SIA detail calls, want 1", sia.detailCalls)
	}
}

// At or above the cooldown there is nothing to throttle: the read-through
// already serves those from cache, so they must pass through untouched.
func TestCooldown_MaxAgeAboveCooldownPasses(t *testing.T) {
	router, sia, url := cooldownFixture(t, 60)

	if w := do(router, url+"?max_age=0"); w.Code != http.StatusOK {
		t.Fatalf("warm-up got status %d, want 200", w.Code)
	}
	for _, maxAge := range []string{"60", "600"} {
		w := do(router, url+"?max_age="+maxAge)
		if w.Code != http.StatusOK {
			t.Errorf("max_age=%s got status %d, want 200", maxAge, w.Code)
		}
		if got := w.Header().Get("X-Cache"); got != "hit" {
			t.Errorf("max_age=%s got X-Cache=%q, want hit", maxAge, got)
		}
	}
	if sia.detailCalls != 1 {
		t.Errorf("got %d SIA detail calls, want 1", sia.detailCalls)
	}
}

// No ?max_age= at all is catalog.DefaultFreshness, not a forced refresh.
func TestCooldown_DefaultFreshnessIsNeverThrottled(t *testing.T) {
	router, _, url := cooldownFixture(t, 60)

	if w := do(router, url); w.Code != http.StatusOK {
		t.Fatalf("first plain GET got status %d, want 200", w.Code)
	}
	if w := do(router, url); w.Code != http.StatusOK {
		t.Fatalf("second plain GET got status %d, want 200", w.Code)
	}
}

// All four detail endpoints reduce to the same SIA POST, so one throttle has
// to cover them or it covers nothing.
func TestCooldown_AppliesToEverySharedFetchEndpoint(t *testing.T) {
	router, sia, url := cooldownFixture(t, 60)

	if w := do(router, url+"?max_age=0"); w.Code != http.StatusOK {
		t.Fatalf("warm-up got status %d, want 200", w.Code)
	}
	for _, suffix := range []string{"", "/sections", "/sections/1", "/sections/1/seats"} {
		w := do(router, url+suffix+"?max_age=0")
		if w.Code != http.StatusTooManyRequests {
			t.Errorf("%s%s got status %d, want 429", url, suffix, w.Code)
		}
	}
	if sia.detailCalls != 1 {
		t.Errorf("got %d SIA detail calls, want 1", sia.detailCalls)
	}
}

// Cooldown 0 is the documented off switch.
func TestCooldown_ZeroDisablesTheThrottle(t *testing.T) {
	router, sia, url := cooldownFixture(t, 0)

	for i := 0; i < 3; i++ {
		if w := do(router, url+"?max_age=0"); w.Code != http.StatusOK {
			t.Fatalf("request %d got status %d, want 200", i, w.Code)
		}
	}
	if sia.detailCalls != 3 {
		t.Errorf("got %d SIA detail calls, want 3 with the throttle off", sia.detailCalls)
	}
}

// TestCatalog_IncludeSchedules covers the contract the web catalog's clash
// marking relies on: without ?include=schedules the list is unchanged, with
// it every course whose detail was pulled carries its groups' schedules, and
// the difference between "no groups" and "not known yet" survives the trip.
func TestCatalog_IncludeSchedules(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := catalog.NewService(store, sia, "2026-2")
	ctx := context.Background()

	program, err := store.UpsertProgram(ctx, catalog.Program{
		CampusCode: "1101", FacultyCode: "2055", Code: "2A74", LevelSlug: "pregrado",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	program.CatalogFetchedAt = &now
	store.programs[program.ID] = program
	for code, name := range map[string]string{
		"2015725": "Turco I",
		"2029512": "Sin grupos",
		"2016696": "Nadie preguntó",
	} {
		store.courses[ck("1101", code)] = catalog.Course{CampusCode: "1101", Code: code, Name: name, Credits: 3}
		store.courseProg[cpk(program.ID, code)] = struct {
			Typology  string
			FetchedAt *time.Time
		}{Typology: "LIBRE ELECCIÓN (L)"}
	}
	store.schedules = map[string][]catalog.SectionSchedule{
		"2015725": {
			{Key: "1", Schedule: []catalog.ClassSession{{Weekday: time.Monday, StartTime: "14:00", EndTime: "16:00"}}},
			{Key: "2", Schedule: nil}, // grupo sin horario informado
		},
		"2029512": {}, // se pidió el detalle y no tiene grupos
	}

	router := NewRouter(svc, 0, testRateRPS, testRateBurst, 0, "test", "test")
	base := "/v1/campuses/1101/programs/2A74/courses"

	get := func(url string) map[string]map[string]any {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, url, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("got status %d, body %s", w.Code, w.Body.String())
		}
		var body struct {
			Courses []map[string]any `json:"courses"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("json: %v", err)
		}
		out := map[string]map[string]any{}
		for _, c := range body.Courses {
			out[c["code"].(string)] = c
		}
		return out
	}

	// ── sin el parámetro: nada cambia ──
	for code, c := range get(base) {
		if _, ok := c["section_schedules"]; ok {
			t.Errorf("%s: section_schedules presente sin ?include=schedules", code)
		}
	}

	// ── con el parámetro ──
	withSched := get(base + "?include=schedules")

	turco, ok := withSched["2015725"]["section_schedules"].([]any)
	if !ok {
		t.Fatalf("Turco I sin section_schedules: %+v", withSched["2015725"])
	}
	if len(turco) != 2 {
		t.Fatalf("Turco I: got %d grupos, want 2", len(turco))
	}
	g1 := turco[0].(map[string]any)
	if g1["key"] != "1" {
		t.Errorf("got key %v, want 1", g1["key"])
	}
	sched, _ := g1["schedule"].([]any)
	if len(sched) != 1 {
		t.Fatalf("grupo 1: got %d sesiones, want 1", len(sched))
	}
	if s := sched[0].(map[string]any); s["start_time"] != "14:00" || s["end_time"] != "16:00" {
		t.Errorf("got %v", s)
	}

	// Un grupo sin horario informado tiene que seguir estando: si desapareciera,
	// un cliente concluiría "todos los grupos chocan" sobre un conjunto más
	// chico que el real.
	if g2 := turco[1].(map[string]any); g2["key"] != "2" {
		t.Errorf("falta el grupo sin horario informado: %+v", turco)
	}

	// Presente y vacío = se preguntó y no tiene grupos.
	sinGrupos, ok := withSched["2029512"]["section_schedules"]
	if !ok {
		t.Error("una asignatura medida sin grupos tiene que traer section_schedules vacío, no ausente")
	} else if arr, _ := sinGrupos.([]any); len(arr) != 0 {
		t.Errorf("got %v, want []", sinGrupos)
	}

	// Ausente = nadie preguntó todavía. Es lo que evita marcar "no te sirve
	// ningún grupo" sobre una asignatura de la que no se sabe nada.
	if _, ok := withSched["2016696"]["section_schedules"]; ok {
		t.Error("una asignatura sin detalle pedido no puede traer section_schedules")
	}
}
