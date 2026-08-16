package sia

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// TestLive_98DetailsInOneSession hits the real SIA server. It is the
// explicit acceptance bar for paso 4 (docs/PLAN.md): a full program's worth
// of details fetched back-to-back in one session must never hit a noop, and
// DetailRegion must grow with every detail (GOTCHAS §20). Skipped unless
// SIA_LIVE=1 — never run on a normal `go test ./...` or in CI.
func TestLive_98DetailsInOneSession(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	c, err := NewConn("https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Bootstrap(ctx); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}

	sistemas := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 3}
	list, err := c.FetchCatalog(ctx, sistemas)
	if err != nil {
		t.Fatalf("FetchCatalog: %v", err)
	}
	rows, err := ParseList(list)
	if err != nil {
		t.Fatalf("ParseList: %v", err)
	}
	t.Logf("fetched %d rows", len(rows))

	// Codes are stable identity; _afrRK is not (GOTCHAS §4) — it renumbers
	// on every Volver. Track codes, re-resolve the row key from the most
	// recent listing on each iteration. PROTOCOL.md §7's loop: click,
	// Volver, re-parse — no extra cb1 needed, Volver's own body IS the
	// fresh listing.
	codes := make([]string, len(rows))
	for i, r := range rows {
		codes[i] = r.Code
	}
	currentRows := rows

	lastRegion := 0
	for i, code := range codes {
		var rk string
		for _, r := range currentRows {
			if r.Code == code {
				rk = r.RowKey
				break
			}
		}
		if rk == "" {
			t.Fatalf("detail %d/%d: code %s not found in the current listing", i+1, len(codes), code)
		}

		body, region, err := c.FetchDetail(ctx, rk)
		if err != nil {
			t.Fatalf("detail %d/%d (%s): %v", i+1, len(codes), code, err)
		}
		if region <= lastRegion {
			t.Fatalf("detail %d: DetailRegion did not grow: got %d, last was %d", i+1, region, lastRegion)
		}
		lastRegion = region
		if _, err := ParseDetailText(body); err != nil {
			t.Fatalf("detail %d (%s): ParseDetailText: %v", i+1, code, err)
		}

		volverBody, err := c.Volver(ctx)
		if err != nil {
			t.Fatalf("Volver after detail %d: %v", i+1, err)
		}
		currentRows, err = ParseList(volverBody)
		if err != nil {
			t.Fatalf("ParseList(Volver) after detail %d: %v", i+1, err)
		}
	}
	t.Logf("completed %d details in one session, final DetailRegion=%d", len(codes), lastRegion)
}
