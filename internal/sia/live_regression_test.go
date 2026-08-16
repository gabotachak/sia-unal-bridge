package sia

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// TestLive_FetchProgramDirectory_AfterGotoProgram reproduces the exact bug
// found manually via Bruno: a connection already parked on a program (via
// FetchCatalog/gotoProgram) is then reused for FetchProgramDirectory. Before
// the fix, reposting soc1/soc9 with their already-current values produced a
// silent sia_noop instead of the faculty list. Skipped unless SIA_LIVE=1.
func TestLive_FetchProgramDirectory_AfterGotoProgram(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	c, err := NewConn("https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}

	sistemas := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 3}
	if _, err := c.FetchCatalog(ctx, sistemas); err != nil {
		t.Fatalf("FetchCatalog (parks the conn on level=0 campus=2): %v", err)
	}

	// Same connection, same level+campus soc1/soc9 already holds. This is
	// exactly what broke before the navLevel/navCampus guard.
	faculties, programs, err := c.FetchProgramDirectory(ctx, 0, 2)
	if err != nil {
		t.Fatalf("FetchProgramDirectory on a reused connection: %v", err)
	}
	if len(faculties) < 10 {
		t.Fatalf("got %d faculties, want at least 10 (Bogotá has 13)", len(faculties))
	}
	if len(programs[8]) == 0 {
		t.Fatal("Ingeniería (faculty index 8) has no programs — directory walk is broken")
	}
	t.Logf("%d faculties, %d programs under Ingeniería", len(faculties), len(programs[8]))
}

// TestLive_FetchElectives_TwiceOnSameConn reproduces the electives-specific
// case: two consecutive requests for the SAME sede repost soc4/soc5/soc10/
// soc6 unchanged. A second FetchElectives on the same connection used to
// noop without the bounce guard.
func TestLive_FetchElectives_TwiceOnSameConn(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	c, err := NewConn("https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}

	sistemas := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 3}
	industrial := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 8}

	body1, err := c.FetchElectives(ctx, sistemas)
	if err != nil {
		t.Fatalf("first FetchElectives: %v", err)
	}
	rows1, err := ParseList(body1)
	if err != nil {
		t.Fatalf("ParseList 1: %v", err)
	}
	if len(rows1) < 100 {
		t.Fatalf("first call: got %d elective rows, want ~240", len(rows1))
	}

	// Second call, DIFFERENT program but SAME campus — soc10/soc6 target
	// the exact same values as the first call.
	body2, err := c.FetchElectives(ctx, industrial)
	if err != nil {
		t.Fatalf("second FetchElectives on the same connection: %v", err)
	}
	rows2, err := ParseList(body2)
	if err != nil {
		t.Fatalf("ParseList 2: %v", err)
	}
	if len(rows2) < 100 {
		t.Fatalf("second call: got %d elective rows, want ~240 — this is the bug reproducing", len(rows2))
	}
	t.Logf("call 1: %d rows, call 2: %d rows", len(rows1), len(rows2))
}

// TestLive_FetchCampuses confirms the soc9 dropdown really rides along the
// soc1 valueChange response, and that a connection already sitting on the
// level bounces instead of nooping (GOTCHAS §30). Skipped unless SIA_LIVE=1.
func TestLive_FetchCampuses(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	c, err := NewConn("https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}

	first, err := c.FetchCampuses(ctx, 0)
	if err != nil {
		t.Fatalf("FetchCampuses: %v", err)
	}
	if len(first) < 9 {
		t.Fatalf("got %d campuses, want at least 9", len(first))
	}
	var bogota bool
	for _, o := range first {
		if o.Code == "1101" {
			bogota = true
		}
	}
	if !bogota {
		t.Fatalf("no 1101 in %+v — the label split is wrong", first)
	}

	// Second call on the SAME connection, same level: must bounce, not noop.
	second, err := c.FetchCampuses(ctx, 0)
	if err != nil {
		t.Fatalf("FetchCampuses (already parked at level): %v", err)
	}
	if len(second) != len(first) {
		t.Fatalf("got %d campuses on reuse, want %d", len(second), len(first))
	}
	t.Logf("%d campuses, stable across reuse", len(second))
}

// TestLive_ElectivesWildcardIsPerCampus pins the bug that survived the
// Bogotá-only phase: soc6's "whole sede" wildcard sits at index 12 in
// Bogotá's 13-option list and at 10 in Medellín's 11-option list. The
// hardcoded 12 made every non-Bogotá electives fetch a silent no-op — and a
// no-op looks like an expired session, not like a wrong index (GOTCHAS §30).
// Skipped unless SIA_LIVE=1.
func TestLive_ElectivesWildcardIsPerCampus(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	cases := []struct {
		name string
		key  catalog.ProgramKey
	}{
		{"bogota", catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 3, CampusCode: "1101"}},
		{"medellin", catalog.ProgramKey{Level: 0, Campus: 6, Faculty: 9, Program: 0, CampusCode: "1102"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, err := NewConn("https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := c.Bootstrap(ctx); err != nil {
				t.Fatalf("Bootstrap: %v", err)
			}
			body, err := c.FetchElectives(ctx, tc.key)
			if err != nil {
				t.Fatalf("FetchElectives: %v", err)
			}
			rows, err := ParseList(body)
			if err != nil {
				t.Fatalf("ParseList: %v", err)
			}
			if len(rows) == 0 {
				t.Fatal("got 0 electives, want the whole sede's libre elección")
			}
			t.Logf("%s: %d electives rows", tc.name, len(rows))
		})
	}
}
