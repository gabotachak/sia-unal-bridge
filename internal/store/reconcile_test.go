package store

import (
	"context"
	"testing"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// TestReconcile_Levels: a level absent from the pass gets disabled_at set
// and disappears from Levels(); reappearing in a later pass reactivates it.
// Uses a throwaway name so it never touches the three seeded levels
// (pregrado/doctorado/posgrado).
func TestReconcile_Levels(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	t.Cleanup(func() {
		s.pool.Exec(ctx, `DELETE FROM level WHERE name = $1`, "TEST-LEVEL-9999")
	})

	scope := "test-levels-9999"
	l := catalog.Level{Slug: "test-level-9999", Name: "TEST-LEVEL-9999", Index: 99}
	if err := s.UpsertLevels(ctx, scope, []catalog.Level{l}); err != nil {
		t.Fatalf("UpsertLevels insert: %v", err)
	}
	if !levelPresent(t, s, l.Name) {
		t.Fatal("level should be present right after insert")
	}

	// Guard: empty list must not disable anything (dropdown failure, not a
	// real "SIA closed every level").
	if err := s.UpsertLevels(ctx, scope, nil); err != nil {
		t.Fatalf("UpsertLevels empty: %v", err)
	}
	if !levelPresent(t, s, l.Name) {
		t.Fatal("empty-list upsert must not disable anything")
	}

	// A pass that no longer mentions the level disables it.
	other := catalog.Level{Slug: "other-level", Name: "OTHER LEVEL", Index: 0}
	if err := s.UpsertLevels(ctx, scope, []catalog.Level{other}); err != nil {
		t.Fatalf("UpsertLevels reconcile: %v", err)
	}
	t.Cleanup(func() { s.pool.Exec(ctx, `DELETE FROM level WHERE name = $1`, other.Name) })
	if levelPresent(t, s, l.Name) {
		t.Fatal("level absent from the pass should be disabled and filtered out of Levels()")
	}

	// Reappearing reactivates it (ON CONFLICT DO UPDATE SET disabled_at = NULL).
	if err := s.UpsertLevels(ctx, scope, []catalog.Level{l, other}); err != nil {
		t.Fatalf("UpsertLevels reactivate: %v", err)
	}
	if !levelPresent(t, s, l.Name) {
		t.Fatal("level should be reactivated once it reappears in a pass")
	}
}

func levelPresent(t *testing.T, s *Store, name string) bool {
	t.Helper()
	levels, err := s.Levels(context.Background())
	if err != nil {
		t.Fatalf("Levels: %v", err)
	}
	for _, l := range levels {
		if l.Name == name {
			return true
		}
	}
	return false
}

// TestReconcile_Campuses mirrors TestReconcile_Levels for UpsertCampuses,
// scoped to a throwaway level so it never touches real sedes.
func TestReconcile_Campuses(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	levelSlug := "test-campus-level-9999"
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO level (slug, name, level_idx) VALUES ($1, $2, 98)
		ON CONFLICT (name) DO NOTHING`, levelSlug, "TEST-CAMPUS-LEVEL-9999"); err != nil {
		t.Fatalf("seed level: %v", err)
	}
	t.Cleanup(func() { s.pool.Exec(ctx, `DELETE FROM level WHERE slug = $1`, levelSlug) })

	scope := "test-campuses-9999"
	a := catalog.Campus{LevelSlug: levelSlug, Code: "TA", Name: "SEDE A", Index: 0}
	b := catalog.Campus{LevelSlug: levelSlug, Code: "TB", Name: "SEDE B", Index: 1}
	if err := s.UpsertCampuses(ctx, scope, []catalog.Campus{a, b}); err != nil {
		t.Fatalf("UpsertCampuses insert: %v", err)
	}
	if !campusPresent(t, s, levelSlug, "TA") || !campusPresent(t, s, levelSlug, "TB") {
		t.Fatal("both campuses should be present after insert")
	}

	if err := s.UpsertCampuses(ctx, scope, nil); err != nil {
		t.Fatalf("UpsertCampuses empty: %v", err)
	}
	if !campusPresent(t, s, levelSlug, "TA") {
		t.Fatal("empty-list upsert must not disable anything")
	}

	if err := s.UpsertCampuses(ctx, scope, []catalog.Campus{b}); err != nil {
		t.Fatalf("UpsertCampuses reconcile: %v", err)
	}
	if campusPresent(t, s, levelSlug, "TA") {
		t.Fatal("campus TA should be disabled and filtered out of Campuses()")
	}
	if !campusPresent(t, s, levelSlug, "TB") {
		t.Fatal("campus TB should stay active")
	}

	if err := s.UpsertCampuses(ctx, scope, []catalog.Campus{a, b}); err != nil {
		t.Fatalf("UpsertCampuses reactivate: %v", err)
	}
	if !campusPresent(t, s, levelSlug, "TA") {
		t.Fatal("campus TA should be reactivated once it reappears")
	}
}

func campusPresent(t *testing.T, s *Store, levelSlug, code string) bool {
	t.Helper()
	campuses, err := s.Campuses(context.Background(), levelSlug)
	if err != nil {
		t.Fatalf("Campuses: %v", err)
	}
	for _, c := range campuses {
		if c.Code == code {
			return true
		}
	}
	return false
}

// TestReconcile_Programs: UpsertPrograms disables a program missing from a
// (campus, level) pass and reactivates it if it reappears. Also checks the
// empty-list guard.
func TestReconcile_Programs(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetProgram(t, s, "9998", "F1", "P1")
	resetProgram(t, s, "9998", "F1", "P2")
	t.Cleanup(func() {
		resetProgram(t, s, "9998", "F1", "P1")
		resetProgram(t, s, "9998", "F1", "P2")
	})

	scope := "test-programs-9998"
	p1 := catalog.Program{CampusCode: "9998", FacultyCode: "F1", Code: "P1", LevelSlug: "pregrado", Name: "Uno"}
	p2 := catalog.Program{CampusCode: "9998", FacultyCode: "F1", Code: "P2", LevelSlug: "pregrado", Name: "Dos"}
	if err := s.UpsertPrograms(ctx, scope, []catalog.Program{p1, p2}); err != nil {
		t.Fatalf("UpsertPrograms insert: %v", err)
	}
	if _, ok, _ := s.Program(ctx, "9998", "F1", "P1"); !ok {
		t.Fatal("P1 should be present after insert")
	}

	if err := s.UpsertPrograms(ctx, scope, nil); err != nil {
		t.Fatalf("UpsertPrograms empty: %v", err)
	}
	if _, ok, _ := s.Program(ctx, "9998", "F1", "P1"); !ok {
		t.Fatal("empty-list upsert must not disable P1")
	}

	if err := s.UpsertPrograms(ctx, scope, []catalog.Program{p2}); err != nil {
		t.Fatalf("UpsertPrograms reconcile: %v", err)
	}
	if _, ok, _ := s.Program(ctx, "9998", "F1", "P1"); ok {
		t.Fatal("P1 missing from the pass should be disabled and filtered out of Program()")
	}
	if _, ok, _ := s.Program(ctx, "9998", "F1", "P2"); !ok {
		t.Fatal("P2 should stay active")
	}

	if err := s.UpsertPrograms(ctx, scope, []catalog.Program{p1, p2}); err != nil {
		t.Fatalf("UpsertPrograms reactivate: %v", err)
	}
	if _, ok, _ := s.Program(ctx, "9998", "F1", "P1"); !ok {
		t.Fatal("P1 should be reactivated once it reappears")
	}
}

// TestReconcile_CourseProgram: UpsertCatalog disables a course_program row
// missing from a program's catalog pass, and Course()/SearchCourses() stop
// returning the course once NO active program references it, per the EXISTS
// filter (C4).
func TestReconcile_CourseProgram(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetProgram(t, s, "9997", "F1", "PC")
	t.Cleanup(func() { resetProgram(t, s, "9997", "F1", "PC") })

	p, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9997", FacultyCode: "F1", Code: "PC", LevelSlug: "pregrado", Name: "Reconcile",
	})
	if err != nil {
		t.Fatalf("UpsertProgram: %v", err)
	}

	c1 := catalog.CourseOffering{Course: catalog.Course{CampusCode: "9997", Code: "C1", Name: "Curso Uno", Credits: 3}}
	c2 := catalog.CourseOffering{Course: catalog.Course{CampusCode: "9997", Code: "C2", Name: "Curso Dos", Credits: 3}}
	if err := s.UpsertCatalog(ctx, p, []catalog.CourseOffering{c1, c2}); err != nil {
		t.Fatalf("UpsertCatalog insert: %v", err)
	}
	if _, ok, _ := s.Course(ctx, "9997", "C1"); !ok {
		t.Fatal("C1 should be visible after insert")
	}

	// Reconcile with only C2: C1 drops out.
	if err := s.UpsertCatalog(ctx, p, []catalog.CourseOffering{c2}); err != nil {
		t.Fatalf("UpsertCatalog reconcile: %v", err)
	}
	if _, ok, _ := s.Course(ctx, "9997", "C1"); ok {
		t.Fatal("C1 should have disappeared once no active course_program references it")
	}
	courses, err := s.ProgramCourses(ctx, p.ID)
	if err != nil {
		t.Fatalf("ProgramCourses: %v", err)
	}
	if len(courses) != 1 || courses[0].Course.Code != "C2" {
		t.Fatalf("ProgramCourses after reconcile: got %+v, want only C2", courses)
	}

	// Reappearing reactivates it.
	if err := s.UpsertCatalog(ctx, p, []catalog.CourseOffering{c1, c2}); err != nil {
		t.Fatalf("UpsertCatalog reactivate: %v", err)
	}
	if _, ok, _ := s.Course(ctx, "9997", "C1"); !ok {
		t.Fatal("C1 should be reactivated once it reappears in the catalog")
	}
}

// TestReconcile_SectionProgram_DoesNotLeakAcrossPrograms is the regression
// this whole plan exists to prevent (docs/PLAN-SIACHANGES.md Parte E.6):
// two programs seeing the SAME course with a DIFFERENT number of groups
// (DATA-MODEL.md §2, 25 vs 23). Refreshing the small plan's detail must
// disable ONLY its own section_program rows, never the big plan's.
func TestReconcile_SectionProgram_DoesNotLeakAcrossPrograms(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	resetProgram(t, s, "9996", "F1", "BIG")
	resetProgram(t, s, "9996", "F1", "SMALL")
	t.Cleanup(func() {
		resetProgram(t, s, "9996", "F1", "BIG")
		resetProgram(t, s, "9996", "F1", "SMALL")
	})

	big, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9996", FacultyCode: "F1", Code: "BIG", LevelSlug: "pregrado", Name: "Plan Grande",
	})
	if err != nil {
		t.Fatalf("UpsertProgram big: %v", err)
	}
	small, err := s.UpsertProgram(ctx, catalog.Program{
		CampusCode: "9996", FacultyCode: "F1", Code: "SMALL", LevelSlug: "pregrado", Name: "Plan Chico",
	})
	if err != nil {
		t.Fatalf("UpsertProgram small: %v", err)
	}

	course := func(keys ...string) catalog.CourseOffering {
		secs := make([]catalog.Section, len(keys))
		for i, k := range keys {
			secs[i] = catalog.Section{CampusCode: "9996", Code: "SHARED", Term: "2026-2", Key: k, Number: i + 1}
		}
		return catalog.CourseOffering{Course: catalog.Course{
			CampusCode: "9996", Code: "SHARED", Name: "Compartida", Sections: secs,
		}}
	}

	// Big sees 3 groups, small sees only 2 of them.
	if err := s.UpsertDetail(ctx, big.ID, "2026-2", course("1", "2", "3")); err != nil {
		t.Fatalf("UpsertDetail big: %v", err)
	}
	if err := s.UpsertDetail(ctx, small.ID, "2026-2", course("1", "2")); err != nil {
		t.Fatalf("UpsertDetail small: %v", err)
	}

	bigSections, err := s.Sections(ctx, "9996", "SHARED", big.ID)
	if err != nil {
		t.Fatalf("Sections big: %v", err)
	}
	if len(bigSections) != 3 {
		t.Fatalf("big plan: got %d sections, want 3", len(bigSections))
	}

	// Re-fetch small's detail and this time it only sees group "1" — group
	// "2" got cancelled for small's plan (still exists, just not visible to
	// small anymore).
	if err := s.UpsertDetail(ctx, small.ID, "2026-2", course("1")); err != nil {
		t.Fatalf("UpsertDetail small reconcile: %v", err)
	}

	bigSections, err = s.Sections(ctx, "9996", "SHARED", big.ID)
	if err != nil {
		t.Fatalf("Sections big after small's reconcile: %v", err)
	}
	if len(bigSections) != 3 {
		t.Fatalf("refreshing the small plan must not touch the big plan's visibility: got %d sections, want 3", len(bigSections))
	}

	smallSections, err := s.Sections(ctx, "9996", "SHARED", small.ID)
	if err != nil {
		t.Fatalf("Sections small: %v", err)
	}
	if len(smallSections) != 1 {
		t.Fatalf("small plan: got %d sections, want 1", len(smallSections))
	}
}
