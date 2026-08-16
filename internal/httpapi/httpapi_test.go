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

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
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
	reference map[string]time.Time
	campuses  map[string][]catalog.Campus
	levels    []catalog.Level
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

func (f *fakeStore) Programs(_ context.Context, campusCode, facultyCode string) ([]catalog.Program, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []catalog.Program
	for _, p := range f.programs {
		if (campusCode == "" || p.CampusCode == campusCode) && (facultyCode == "" || p.FacultyCode == facultyCode) {
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

func (f *fakeStore) UpsertDetail(_ context.Context, programID int64, offering catalog.CourseOffering) error {
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

// TestCourseDetail_MissThenHit is paso 7's acceptance bar (docs/PLAN.md):
// curl /v1/campuses/{campus}/programs/{program}/courses/{code} returns API.md's example
// shape, with X-Cache: miss the first time and hit the second.
func TestCourseDetail_MissThenHit(t *testing.T) {
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := catalog.NewService(store, sia, "2026-2")
	program, err := store.UpsertProgram(context.Background(), catalog.Program{
		CampusCode: "1101", FacultyCode: "2055", Code: "2A74", Level: 0,
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3,
	})
	if err != nil {
		t.Fatal(err)
	}

	router := NewRouter(svc)
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
	router := NewRouter(svc)

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
	router := NewRouter(svc)

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
	router := NewRouter(svc)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/campuses/1101/programs/2A74/courses/2016696?max_age=-5", nil)
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400 for negative max_age", w.Code)
	}
}
