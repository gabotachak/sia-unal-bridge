package sia

import (
	"errors"
	"testing"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// The detail page prints its own code next to the name. Comparing it with the
// code we clicked is the only cheap way to catch the failure this domain
// specialises in: a response that is well formed, plausible, and about
// another course (GOTCHAS §28 cross-talk, §4 stale _afrRK).
func TestCheckDetailCode(t *testing.T) {
	d, err := ParseDetail(fixture(t, "detalle_2do_de_sesion_region2_2026-08-15.xml"), "1101", "2016696", "2026-2")
	if err != nil {
		t.Fatal(err)
	}
	if d.HeaderCode != "2016696" {
		t.Fatalf("HeaderCode = %q, want 2016696", d.HeaderCode)
	}
	if err := checkDetailCode(d, "2016696"); err != nil {
		t.Errorf("matching code rejected: %v", err)
	}
	if err := checkDetailCode(d, "1000004-B"); !errors.Is(err, catalog.ErrSuspectRun) {
		t.Errorf("a foreign detail returned %v, want ErrSuspectRun", err)
	}
	// A header that did not parse must not fail the fetch: the groups are
	// still there, and a cosmetic change to the page is not a data error.
	if err := checkDetailCode(Detail{}, "2016696"); err != nil {
		t.Errorf("unparsed header rejected: %v", err)
	}
}
