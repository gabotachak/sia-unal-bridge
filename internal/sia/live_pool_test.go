package sia

import (
	"context"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// TestLive_PoolConcurrency8DistinctPrograms is paso 5's acceptance bar
// (docs/PLAN.md): 8 concurrent requests for 8 DIFFERENT programs must each
// get their own catalog. The historical failure mode (GOTCHAS §28) is not
// an error — it's a 200 OK with the WRONG program's course list, silently.
// Skipped unless SIA_LIVE=1.
func TestLive_PoolConcurrency8DistinctPrograms(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	pool, err := NewPool(ctx, "https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf", 4)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	src := NewSource(pool)

	const n = 8
	results := make([][]catalog.CourseOffering, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: i}
			offs, err := src.FetchCatalog(ctx, key)
			results[i] = offs
			errs[i] = err
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("program %d: %v", i, err)
		}
		if len(results[i]) == 0 {
			t.Fatalf("program %d: empty catalog", i)
		}
	}

	fingerprint := func(offs []catalog.CourseOffering) string {
		codes := make([]string, len(offs))
		for i, o := range offs {
			codes[i] = o.Course.Code
		}
		sort.Strings(codes)
		return strings.Join(codes, ",")
	}

	seen := map[string][]int{}
	for i, offs := range results {
		fp := fingerprint(offs)
		seen[fp] = append(seen[fp], i)
	}
	if len(seen) < n {
		for fp, idxs := range seen {
			if len(idxs) > 1 {
				t.Errorf("programs %v returned IDENTICAL catalogs (%d courses) — pool cross-talk, GOTCHAS §28", idxs, len(results[idxs[0]]))
				_ = fp
			}
		}
	}
	t.Logf("%d distinct programs, %d distinct catalogs", n, len(seen))
}
