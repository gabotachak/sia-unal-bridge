package sia

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// TestLive_PoolRecoversFromDeadSession proves the self-healing path against
// the real server: a connection whose ViewState is garbage answers with the
// same no-op a dead session does, and the pool must repair it instead of
// serving sia_noop forever. Skipped unless SIA_LIVE=1.
func TestLive_PoolRecoversFromDeadSession(t *testing.T) {
	if os.Getenv("SIA_LIVE") != "1" {
		t.Skip("set SIA_LIVE=1 to run against the real SIA server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool, err := NewPool(ctx, "https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf", 1)
	if err != nil {
		t.Fatal(err)
	}
	src := NewSource(pool)

	// Bogotá / Ingeniería / Ingeniería de Sistemas y Computación (2A74).
	key := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 3, CampusCode: "1101"}

	conn, release, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	conn.viewState = "!dead" // what an expired session behaves like
	release()

	offerings, err := src.FetchCatalog(ctx, key)
	if err != nil {
		t.Fatalf("FetchCatalog after a dead session: %v", err)
	}
	if len(offerings) == 0 {
		t.Fatal("recovered fetch returned no offerings")
	}
	t.Logf("recovered: %d offerings", len(offerings))
}
