package catalog

import (
	"context"
	"errors"
	"testing"
)

// Paso 5's acceptance bar (docs/FASE-2.md): a listing that hits the SIA's
// 1000-row cap is a TRUNCATION, and it must abort instead of being written.
// A crawler is a machine for multiplying a parsing bug by 135 000, so this
// check lives in the Service — the job and the API take the same path.
func TestCatalogSanity_TruncatedListingIsNotPersisted(t *testing.T) {
	ctx := context.Background()
	store := newFakeStore()
	sia := &fakeSIA{catalogRows: listingCap}
	svc := NewService(store, sia, "2026-2")

	program, err := store.UpsertProgram(ctx, testProgram(0))
	if err != nil {
		t.Fatal(err)
	}

	if _, _, err := svc.Catalog(ctx, program, DefaultFreshness); !errors.Is(err, ErrTruncated) {
		t.Fatalf("got err %v, want ErrTruncated", err)
	}

	courses, err := store.ProgramCourses(ctx, program.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(courses) != 0 {
		t.Errorf("%d courses were persisted from a truncated listing", len(courses))
	}
	if stored, _, _ := store.Program(ctx, program.CampusCode, program.FacultyCode, program.Code); stored.CatalogFetchedAt != nil {
		t.Error("a truncated catalog must not be stamped fresh")
	}
}

// The other half of paso 5: 0 rows where the cache holds courses. That is
// what the bootstrap's foreign table (GOTCHAS §22) and a dirty soc4 both look
// like — plausible, and wrong. A program that never had a catalog is
// untouched by this check, because 0 courses is a legitimate answer there.
func TestCatalogSanity_SuspectEmptyCatalog(t *testing.T) {
	ctx := context.Background()
	store := newFakeStore()
	sia := &fakeSIA{}
	svc := NewService(store, sia, "2026-2")

	program, err := store.UpsertProgram(ctx, testProgram(0))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Catalog(ctx, program, DefaultFreshness); err != nil {
		t.Fatalf("first sweep: %v", err)
	}
	program, _, err = store.Program(ctx, program.CampusCode, program.FacultyCode, program.Code)
	if err != nil {
		t.Fatal(err)
	}

	// maxAge 0 forces the fetch; this time the SIA answers with nothing.
	sia.catalogEmpty = true
	if _, _, err := svc.Catalog(ctx, program, 0); !errors.Is(err, ErrSuspectRun) {
		t.Fatalf("got err %v, want ErrSuspectRun", err)
	}
	courses, err := store.ProgramCourses(ctx, program.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(courses) != 1 {
		t.Errorf("the cached catalog was overwritten: %d courses left", len(courses))
	}

	// A fresh program with no cache legitimately gets an empty catalog.
	other := testProgram(0)
	other.Code = "9Z99"
	empty, err := store.UpsertProgram(ctx, other)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Catalog(ctx, empty, DefaultFreshness); err != nil {
		t.Errorf("an empty catalog for an uncached program must be allowed, got %v", err)
	}
}

// TestCatalogSanity_ShrunkCatalog is A1/C3's other guard rail
// (docs/PLAN-SIACHANGES.md, shrinkFloor): a catalog that shrinks below half
// its cached size looks like a truncated listing or a dirty soc4, never a
// real semester-to-semester drop. 98→90 (above the floor) is accepted;
// 98→5 (below it) is rejected the same way as the all-the-way-to-0 case.
func TestCatalogSanity_ShrunkCatalog(t *testing.T) {
	ctx := context.Background()
	store := newFakeStore()
	sia := &fakeSIA{catalogRows: 98}
	svc := NewService(store, sia, "2026-2")

	program, err := store.UpsertProgram(ctx, testProgram(0))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Catalog(ctx, program, DefaultFreshness); err != nil {
		t.Fatalf("first sweep: %v", err)
	}
	program, _, err = store.Program(ctx, program.CampusCode, program.FacultyCode, program.Code)
	if err != nil {
		t.Fatal(err)
	}

	// 98 -> 5 is well below shrinkFloor: reject, and the cache stays at 98.
	sia.catalogRows = 5
	if _, _, err := svc.Catalog(ctx, program, 0); !errors.Is(err, ErrSuspectRun) {
		t.Fatalf("got err %v, want ErrSuspectRun for a 98->5 shrink", err)
	}
	courses, err := store.ProgramCourses(ctx, program.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(courses) != 98 {
		t.Errorf("a suspect shrink must not touch the cache: got %d courses, want 98", len(courses))
	}

	// 98 -> 90 is above shrinkFloor: a real, if unlikely, drop — accepted.
	// (fakeStore is not a full reconciliation simulation — docs at the top
	// of service_test.go — so this only checks the guard's decision, not
	// persisted row counts; the real UPDATE ... disabled_at path is covered
	// against Postgres in internal/store's TestReconcile_CourseProgram.)
	sia.catalogRows = 90
	if _, _, err := svc.Catalog(ctx, program, 0); err != nil {
		t.Fatalf("98->90 shrink should be accepted, got %v", err)
	}
}
