package sia

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

const liveBaseURL = "https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf"

// TestLive_NameFilterShrinksTheListingAndDoesNotStick is paso 3's acceptance
// bar (docs/FASE-2.md), the step that pays for fase 2:
//
//  1. the it11 filter cuts the cb1 from ~241 KB to ~15–27 KB, and the row it
//     is looking for is still there;
//  2. a FULL catalog fetched right after a filtered one still returns every
//     row — the trap of the GOTCHAS §33 family, and the reason clearing it11
//     is part of the logical operation and not of the caller's good manners.
//
// Skipped unless SIA_LIVE=1.
func TestLive_NameFilterShrinksTheListingAndDoesNotStick(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	c, err := NewConn(liveBaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}

	sistemas := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 3, CampusCode: "1101"}
	full, err := c.FetchCatalog(ctx, sistemas)
	if err != nil {
		t.Fatalf("FetchCatalog: %v", err)
	}
	fullRows, err := ParseList(full)
	if err != nil {
		t.Fatalf("ParseList: %v", err)
	}
	if len(fullRows) < 50 {
		t.Fatalf("got %d rows in the regular listing, want ~98", len(fullRows))
	}
	target := fullRows[len(fullRows)/2] // anything but the first row
	t.Logf("unfiltered: %d rows, %d bytes", len(fullRows), len(full))

	c.form.Nombre = target.Name
	filtered, err := c.FetchCatalog(ctx, sistemas)
	c.form.Nombre = ""
	if err != nil {
		t.Fatalf("filtered FetchCatalog: %v", err)
	}
	filteredRows, err := ParseList(filtered)
	if err != nil {
		t.Fatalf("ParseList filtered: %v", err)
	}
	if _, ok := rowWithCode(filteredRows, target.Code); !ok {
		t.Fatalf("filter %q returned %d rows, none with code %s", target.Name, len(filteredRows), target.Code)
	}
	if len(filtered) >= len(full) {
		t.Errorf("filtered response is %d bytes, unfiltered %d — the filter bought nothing", len(filtered), len(full))
	}
	t.Logf("filtered by %q: %d rows, %d bytes (%.1f× smaller)",
		target.Name, len(filteredRows), len(filtered), float64(len(full))/float64(len(filtered)))

	// The trap: does it11 stay put on the server?
	again, err := c.FetchCatalog(ctx, sistemas)
	if err != nil {
		t.Fatalf("FetchCatalog after a filtered one: %v", err)
	}
	againRows, err := ParseList(again)
	if err != nil {
		t.Fatalf("ParseList after filter: %v", err)
	}
	if len(againRows) != len(fullRows) {
		t.Fatalf("after a filtered search the full listing returned %d rows, want %d — it11 stayed put",
			len(againRows), len(fullRows))
	}
	t.Logf("after clearing the filter: %d rows, %d bytes", len(againRows), len(again))
}

// TestLive_FetchDetails_LocalityWins is paso 4's acceptance bar: walking a
// program's courses over one connection costs fewer POSTs than the same
// courses fetched one at a time while another program shares the connection.
//
// The comparison is deliberately against INTERLEAVED singles, not against
// singles on a dedicated connection: fase 1's parkedAt already makes those
// cheap. What FetchDetails buys is locality — with W workers on a pool of W,
// per-course calls can land on a connection parked somewhere else and pay the
// full re-park (2 extra POSTs, ~10 s instead of ~1.3 s). Interleaving two
// programs on ONE connection reproduces that deterministically.
//
// Skipped unless SIA_LIVE=1.
func TestLive_FetchDetails_LocalityWins(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()

	sistemas := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 3, CampusCode: "1101"}
	industrial := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 8, CampusCode: "1101"}

	refsA := liveRefs(ctx, t, sistemas, 3)
	refsB := liveRefs(ctx, t, industrial, 3)

	// Batched: A's courses, then B's. One re-park per program.
	batchPool, err := NewPool(ctx, liveBaseURL, 1)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	batchBefore, _ := batchPool.Stats()
	batchSrc := NewSource(batchPool)
	for _, w := range []struct {
		key  catalog.ProgramKey
		refs []catalog.CourseRef
	}{{sistemas, refsA}, {industrial, refsB}} {
		got := 0
		err := batchSrc.FetchDetails(ctx, w.key, w.refs, "2026-2", func(o catalog.CourseOffering, ferr error) error {
			if ferr != nil {
				t.Errorf("batch detail %s: %v", o.Course.Code, ferr)
				return nil
			}
			got++
			return nil
		})
		if err != nil {
			t.Fatalf("FetchDetails: %v", err)
		}
		if got != len(w.refs) {
			t.Fatalf("batch yielded %d of %d courses", got, len(w.refs))
		}
	}
	batchPosts, _ := batchPool.Stats()
	batchPosts -= batchBefore

	// Interleaved singles: A, B, A, B, … on one connection. Every call
	// re-parks, which is what a shared pool does to per-course fetches.
	singlePool, err := NewPool(ctx, liveBaseURL, 1)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	singleBefore, _ := singlePool.Stats()
	singleSrc := NewSource(singlePool)
	for i := range refsA {
		for _, w := range []struct {
			key catalog.ProgramKey
			ref catalog.CourseRef
		}{{sistemas, refsA[i]}, {industrial, refsB[i]}} {
			o, err := singleSrc.FetchDetail(ctx, w.key, w.ref.Code, "2026-2")
			if err != nil {
				t.Fatalf("FetchDetail %s: %v", w.ref.Code, err)
			}
			if o.Course.Code != w.ref.Code {
				t.Fatalf("asked for %s, got %s", w.ref.Code, o.Course.Code)
			}
		}
	}
	singlePosts, _ := singlePool.Stats()
	singlePosts -= singleBefore

	t.Logf("%d courses over 2 programs: batched %d POSTs, interleaved singles %d POSTs",
		len(refsA)+len(refsB), batchPosts, singlePosts)
	if batchPosts >= singlePosts {
		t.Errorf("batched cost %d POSTs and interleaved singles %d — locality bought nothing",
			batchPosts, singlePosts)
	}
}

// TestLive_FetchDetails_TwoWorkersDoNotCrossTalk is the other half of paso 4:
// two programs swept at the same time over a pool of 2 must each get THEIR
// details. The failure mode is not an error — it is a 200 OK carrying the
// other worker's course (GOTCHAS §28) — so the detail page's own code is what
// asserts it, inside fetchDetail.
//
// Skipped unless SIA_LIVE=1.
func TestLive_FetchDetails_TwoWorkersDoNotCrossTalk(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()

	sistemas := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 3, CampusCode: "1101"}
	industrial := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 8, CampusCode: "1101"}
	refsA := liveRefs(ctx, t, sistemas, 3)
	refsB := liveRefs(ctx, t, industrial, 3)

	pool, err := NewPool(ctx, liveBaseURL, 2)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	src := NewSource(pool)

	var wg sync.WaitGroup
	for _, w := range []struct {
		name string
		key  catalog.ProgramKey
		refs []catalog.CourseRef
	}{{"sistemas", sistemas, refsA}, {"industrial", industrial, refsB}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			want := map[string]bool{}
			for _, r := range w.refs {
				want[r.Code] = true
			}
			err := src.FetchDetails(ctx, w.key, w.refs, "2026-2", func(o catalog.CourseOffering, ferr error) error {
				if ferr != nil {
					t.Errorf("%s: detail %s: %v", w.name, o.Course.Code, ferr)
					return nil
				}
				if !want[o.Course.Code] {
					t.Errorf("%s got a detail for %s, which it never asked for", w.name, o.Course.Code)
				}
				delete(want, o.Course.Code)
				return nil
			})
			if err != nil {
				t.Errorf("%s: FetchDetails: %v", w.name, err)
			}
			if len(want) != 0 {
				t.Errorf("%s never received %v", w.name, want)
			}
		}()
	}
	wg.Wait()
}

// liveRefs reads n real (code, name) pairs off a program's live listing.
func liveRefs(ctx context.Context, t *testing.T, key catalog.ProgramKey, n int) []catalog.CourseRef {
	t.Helper()
	c, err := NewConn(liveBaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	body, err := c.FetchCatalog(ctx, key)
	if err != nil {
		t.Fatalf("FetchCatalog: %v", err)
	}
	rows, err := ParseList(body)
	if err != nil {
		t.Fatalf("ParseList: %v", err)
	}
	rows = DedupeByCode(rows)
	if len(rows) < n {
		t.Fatalf("only %d rows in %v's listing", len(rows), key)
	}
	refs := make([]catalog.CourseRef, 0, n)
	for _, r := range rows[:n] {
		refs = append(refs, catalog.CourseRef{Code: r.Code, Name: r.Name})
	}
	return refs
}
