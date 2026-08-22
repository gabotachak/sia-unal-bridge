package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// testStore requires TEST_DATABASE_URL — docs/LAYOUT.md's chosen tradeoff
// over testcontainers-go: point it at `docker compose up -d db` and skip
// otherwise.
func testStore(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run store integration tests")
	}
	s, err := New(context.Background(), url)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

// resetProgram deletes any leftover row for this natural key (cascades to
// course_program/section/etc via FK) so re-running the suite is idempotent.
// Campus "9999" is a fake test-only campus — never collides with real data
// written by cmd/bridge's live integration test against the same dev DB.
func resetProgram(t *testing.T, s *Store, campusCode, facultyCode, code string) {
	t.Helper()
	_, err := s.pool.Exec(context.Background(),
		`DELETE FROM program WHERE campus_code = $1 AND faculty_code = $2 AND code = $3`,
		campusCode, facultyCode, code,
	)
	if err != nil {
		t.Fatalf("resetProgram: %v", err)
	}
}

func TestUpsertProgramAndCatalog(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetProgram(t, s, "9999", "2055", "2A74")

	p := catalog.Program{
		CampusCode: "9999", FacultyCode: "2055", Code: "2A74", LevelSlug: "pregrado",
		Name: "INGENIERÍA DE SISTEMAS Y COMPUTACIÓN", CampusName: "SEDE BOGOTÁ", FacultyName: "FACULTAD DE INGENIERÍA",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3,
	}
	p, err := s.UpsertProgram(ctx, p)
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}
	if p.ID == 0 {
		t.Fatal("expected non-zero ID")
	}
	if p.CatalogFetchedAt != nil {
		t.Fatal("catalog_fetched_at should be nil before any catalog upsert")
	}

	got, ok, err := s.Program(ctx, "9999", "2055", "2A74")
	if err != nil {
		t.Fatalf("Program: %v", err)
	}
	if !ok {
		t.Fatal("expected found")
	}
	if got.Name != p.Name {
		t.Errorf("got name %q", got.Name)
	}

	offerings := []catalog.CourseOffering{
		{Course: catalog.Course{CampusCode: "9999", Code: "2016696", Name: "Algoritmos", Credits: 3, Description: "desc"}, Typology: "FUND. OBLIGATORIA (B)"},
		{Course: catalog.Course{CampusCode: "9999", Code: "1000004-B", Name: "Cálculo diferencial", Credits: 4}, Typology: "FUND. OPTATIVA (O)"},
	}
	if err := s.UpsertCatalog(ctx, p, offerings); err != nil {
		t.Fatalf("UpsertCatalog: %v", err)
	}

	got, ok, err = s.Program(ctx, "9999", "2055", "2A74")
	if err != nil || !ok {
		t.Fatalf("Program after catalog: ok=%v err=%v", ok, err)
	}
	if got.CatalogFetchedAt == nil {
		t.Fatal("catalog_fetched_at should be set after UpsertCatalog")
	}

	courses, err := s.ProgramCourses(ctx, p.ID)
	if err != nil {
		t.Fatalf("ProgramCourses: %v", err)
	}
	if len(courses) != 2 {
		t.Fatalf("got %d courses, want 2", len(courses))
	}
}

func TestUpsertDetailAndSectionsRoundTrip(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetProgram(t, s, "9999", "2055", "2A75")

	p, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9999", FacultyCode: "2055", Code: "2A75", LevelSlug: "pregrado", Name: "SISTEMAS",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3,
	})
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}

	now := time.Now().Truncate(time.Second)
	course := catalog.Course{
		CampusCode: "9999", Code: "1000004-B", Name: "Cálculo diferencial", Credits: 4,
		Sections: []catalog.Section{
			{
				CampusCode: "9999", Code: "1000004-B", Term: "2026-2", Key: "10", Number: 10, Label: "Grupo 10",
				Instructor: "No informado", Shift: "DIURNO", Duration: "Semestral",
				Schedule: []catalog.ClassSession{
					{Weekday: time.Wednesday, StartTime: "16:00", EndTime: "18:00", Room: "SALÓN 401", Building: "401 - Julio Garavito"},
				},
				Seats: &catalog.SeatSnapshot{Available: 53, MeasuredAt: now},
			},
			{
				CampusCode: "9999", Code: "1000004-B", Term: "2026-2", Key: "TUMA-01", Number: 1, Site: "TUMA", SiteCampus: "SEDE TUMACO",
				Label: "Grupo 1", Seats: &catalog.SeatSnapshot{Available: 0, MeasuredAt: now},
			},
		},
	}
	if err := s.UpsertDetail(ctx, p.ID, "2026-2", catalog.CourseOffering{Course: course, Typology: "FUND. OPTATIVA (O)"}); err != nil {
		t.Fatalf("UpsertDetail: %v", err)
	}

	sections, err := s.Sections(ctx, "9999", "1000004-B", p.ID)
	if err != nil {
		t.Fatalf("Sections: %v", err)
	}
	if len(sections) != 2 {
		t.Fatalf("got %d sections, want 2", len(sections))
	}

	var g10, tuma *catalog.Section
	for i := range sections {
		switch sections[i].Key {
		case "10":
			g10 = &sections[i]
		case "TUMA-01":
			tuma = &sections[i]
		}
	}
	if g10 == nil || tuma == nil {
		t.Fatalf("expected keys '10' and 'TUMA-01', got %+v", sections)
	}

	if g10.Seats == nil || g10.Seats.Available != 53 {
		t.Errorf("g10 seats: %+v", g10.Seats)
	}
	if len(g10.Schedule) != 1 {
		t.Fatalf("g10 schedule: got %d sessions", len(g10.Schedule))
	}
	cs := g10.Schedule[0]
	if cs.Weekday != time.Wednesday || cs.StartTime != "16:00" || cs.EndTime != "18:00" {
		t.Errorf("g10 schedule wrong: %+v", cs)
	}

	if tuma.Site != "TUMA" || tuma.SiteCampus != "SEDE TUMACO" {
		t.Errorf("tuma site fields: %+v", tuma)
	}
	if tuma.Seats == nil || tuma.Seats.Available != 0 {
		t.Errorf("tuma seats: %+v", tuma.Seats)
	}

	fetchedAt, ok, err := s.CourseProgramFetchedAt(ctx, p.ID, "1000004-B")
	if err != nil {
		t.Fatalf("CourseProgramFetchedAt: %v", err)
	}
	if !ok || fetchedAt == nil {
		t.Fatal("expected detail_fetched_at to be set")
	}
}

func TestUpsertDetail_SeatSnapshotIsAppendOnly(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetProgram(t, s, "9999", "2055", "2879")

	p, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9999", FacultyCode: "2055", Code: "2879", LevelSlug: "pregrado", Name: "SISTEMAS 2",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 4,
	})
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}

	section := catalog.Section{CampusCode: "9999", Code: "2016696", Term: "2026-2", Key: "1", Number: 1, Label: "Grupo 1"}
	section.Seats = &catalog.SeatSnapshot{Available: 30, MeasuredAt: time.Now().Add(-time.Hour)}
	course := catalog.Course{CampusCode: "9999", Code: "2016696", Name: "Algoritmos", Sections: []catalog.Section{section}}
	if err := s.UpsertDetail(ctx, p.ID, "2026-2", catalog.CourseOffering{Course: course}); err != nil {
		t.Fatalf("UpsertDetail 1: %v", err)
	}

	section.Seats = &catalog.SeatSnapshot{Available: 28, MeasuredAt: time.Now()}
	course.Sections = []catalog.Section{section}
	if err := s.UpsertDetail(ctx, p.ID, "2026-2", catalog.CourseOffering{Course: course}); err != nil {
		t.Fatalf("UpsertDetail 2: %v", err)
	}

	sections, err := s.Sections(ctx, "9999", "2016696", p.ID)
	if err != nil {
		t.Fatalf("Sections: %v", err)
	}
	if len(sections) != 1 {
		t.Fatalf("got %d sections, want 1 (upsert, not duplicate)", len(sections))
	}
	if sections[0].Seats.Available != 28 {
		t.Errorf("got %d seats, want 28 (latest snapshot)", sections[0].Seats.Available)
	}
}

// TestProgramSchedules is the bulk read behind ?include=schedules: one
// round-trip that answers "when does every group of every course meet",
// which the catalog list cannot answer on its own. The three cases it pins
// down are the ones a schedule-clash client gets wrong if the query drops
// them — a group with no informed schedule, a course with no groups at all,
// and a course nobody ever pulled the detail for.
func TestProgramSchedules(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetProgram(t, s, "9999", "2055", "2A76")

	p, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9999", FacultyCode: "2055", Code: "2A76", LevelSlug: "pregrado", Name: "SISTEMAS",
		CampusIdx: 2, FacultyIdx: 8, ProgramIdx: 3,
	})
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}

	// Turco I tal cual lo sirve producción: tres grupos, dos sesiones cada
	// uno. Más un grupo sin horario informado, que el SIA sí produce.
	turco := catalog.Course{
		CampusCode: "9999", Code: "2015725", Name: "Turco I", Credits: 3,
		Sections: []catalog.Section{
			{
				CampusCode: "9999", Code: "2015725", Term: "2026-2", Key: "1", Number: 1,
				Schedule: []catalog.ClassSession{
					{Weekday: time.Monday, StartTime: "14:00", EndTime: "16:00"},
					{Weekday: time.Wednesday, StartTime: "14:00", EndTime: "16:00"},
				},
			},
			{
				CampusCode: "9999", Code: "2015725", Term: "2026-2", Key: "2", Number: 2,
				Schedule: []catalog.ClassSession{
					{Weekday: time.Tuesday, StartTime: "14:00", EndTime: "16:00"},
					{Weekday: time.Thursday, StartTime: "14:00", EndTime: "16:00"},
				},
			},
			// Sin horario informado. Tiene que salir igual: si desapareciera,
			// un cliente concluiría "todos los grupos chocan" sobre dos de tres.
			{CampusCode: "9999", Code: "2015725", Term: "2026-2", Key: "3", Number: 3},
		},
	}
	if err := s.UpsertDetail(ctx, p.ID, "2026-2", catalog.CourseOffering{Course: turco, Typology: "LIBRE ELECCIÓN (L)"}); err != nil {
		t.Fatalf("UpsertDetail turco: %v", err)
	}

	// Medida y sin grupos: el cero es un dato.
	vacia := catalog.Course{CampusCode: "9999", Code: "2029512", Name: "Sin grupos", Credits: 3}
	if err := s.UpsertDetail(ctx, p.ID, "2026-2", catalog.CourseOffering{Course: vacia, Typology: "LIBRE ELECCIÓN (L)"}); err != nil {
		t.Fatalf("UpsertDetail vacia: %v", err)
	}

	got, err := s.ProgramSchedules(ctx, p.ID)
	if err != nil {
		t.Fatalf("ProgramSchedules: %v", err)
	}

	secs, ok := got["2015725"]
	if !ok {
		t.Fatalf("falta Turco I: %+v", got)
	}
	if len(secs) != 3 {
		t.Fatalf("Turco I: got %d grupos, want 3 (¿se cayó el que no informa horario?): %+v", len(secs), secs)
	}
	byKey := map[string][]catalog.ClassSession{}
	for _, sec := range secs {
		byKey[sec.Key] = sec.Schedule
	}
	if n := len(byKey["1"]); n != 2 {
		t.Errorf("grupo 1: got %d sesiones, want 2", n)
	}
	if cs := byKey["1"]; len(cs) == 2 {
		if cs[0].Weekday != time.Monday || cs[0].StartTime != "14:00" || cs[0].EndTime != "16:00" {
			t.Errorf("grupo 1 sesión 0: got %+v", cs[0])
		}
		if cs[1].Weekday != time.Wednesday {
			t.Errorf("grupo 1 sesión 1: got weekday %v, want miércoles", cs[1].Weekday)
		}
	}
	if _, ok := byKey["3"]; !ok {
		t.Errorf("falta el grupo sin horario informado: %+v", byKey)
	}
	if n := len(byKey["3"]); n != 0 {
		t.Errorf("grupo 3: got %d sesiones, want 0", n)
	}
	// Vacío, NO nil: un slice nil sale como `null` en JSON y revienta a
	// cualquier cliente que recorra el horario del grupo sin comprobar.
	if byKey["3"] == nil {
		t.Error("grupo sin horario: Schedule es nil, tiene que ser un slice vacío (JSON `[]`, no `null`)")
	}

	// Presente y vacío vs. ausente: es lo que separa "no tiene grupos" de
	// "nadie preguntó", y sin esa distinción el cliente marca materias de las
	// que no sabe nada.
	if secs, ok := got["2029512"]; !ok {
		t.Error("una asignatura medida sin grupos tiene que aparecer, con la lista vacía")
	} else if len(secs) != 0 {
		t.Errorf("got %d grupos, want 0", len(secs))
	}
	if _, ok := got["9999999"]; ok {
		t.Error("una asignatura que nadie pidió no puede aparecer")
	}
}
