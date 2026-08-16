package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
	"github.com/gabotachak/sia-unal-bridge/internal/sia"
	"github.com/gabotachak/sia-unal-bridge/internal/store"
)

// TestIntegration_ResolveCatalogDetail wires the real adapters together —
// the only place the hexagon allows it — and proves fase 1's end-to-end
// promise (docs/PLAN.md "Definición de fase 1 hecha" #1/#2): resolve a
// Bogotá program by its public code, read-through its catalog, read-through
// one course's detail with seats. Requires both SIA_LIVE=1 and
// TEST_DATABASE_URL; skipped otherwise.
func TestIntegration_ResolveCatalogDetail(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("set TEST_DATABASE_URL to run against Postgres")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	st, err := store.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer st.Close()

	pool, err := sia.NewPool(ctx, "https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf", 2)
	if err != nil {
		t.Fatalf("sia.NewPool: %v", err)
	}
	src := sia.NewSource(pool)

	svc := catalog.NewService(st, src, "2026-2")

	program, err := svc.ResolveProgram(ctx, catalog.ProgramRef{Campus: "1101", Code: "2A74"}) // Ingeniería de Sistemas y Computación
	if err != nil {
		t.Fatalf("ResolveProgram: %v", err)
	}
	if program.ID == 0 {
		t.Fatal("expected a persisted program with non-zero ID")
	}
	if program.FacultyCode != "2055" {
		t.Errorf("got faculty code %q, want 2055 (Ingeniería)", program.FacultyCode)
	}
	t.Logf("resolved program: %+v", program)

	offerings, _, err := svc.Catalog(ctx, program, catalog.DefaultFreshness)
	if err != nil {
		t.Fatalf("Catalog: %v", err)
	}
	if len(offerings) < 90 {
		t.Errorf("got %d offerings, expected at least ~98 (regular alone is ~98)", len(offerings))
	}
	t.Logf("catalog: %d offerings", len(offerings))

	var target string
	for _, o := range offerings {
		if o.Course.Code == "1000004-B" {
			target = o.Course.Code
			break
		}
	}
	if target == "" {
		target = offerings[0].Course.Code
	}

	course, _, err := svc.CourseDetail(ctx, program, target, catalog.DefaultFreshness)
	if err != nil {
		t.Fatalf("CourseDetail(%s): %v", target, err)
	}
	t.Logf("course %s: %d sections", target, len(course.Course.Sections))
	if len(course.Course.Sections) > 0 {
		s := course.Course.Sections[0]
		if s.Seats == nil {
			t.Error("expected the first section to carry a seat snapshot")
		} else {
			t.Logf("section %s: %d seats, measured %s", s.Key, s.Seats.Available, s.Seats.MeasuredAt)
		}
	}

	// Warm read-through: same course, same program, must now be a cache hit
	// (no assertion on SIA call count here — that's service_test.go's job
	// with fakes; this just confirms the warm path doesn't error).
	if _, _, err := svc.CourseDetail(ctx, program, target, catalog.DefaultFreshness); err != nil {
		t.Fatalf("warm CourseDetail(%s): %v", target, err)
	}
}
