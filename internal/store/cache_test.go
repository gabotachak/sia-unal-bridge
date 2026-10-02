package store

import (
	"context"
	"testing"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// countingStore counts the reads Cached must absorb. The embedded nil
// interface panics on anything else, which is the point: Cached must not
// call it.
type countingStore struct {
	catalog.Store
	programs, fetched int
	stamp             time.Time
}

func (s *countingStore) Programs(context.Context, string, string, string) ([]catalog.Program, error) {
	s.programs++
	stamp := s.stamp
	return []catalog.Program{{ID: 1, Code: "2A74", CatalogFetchedAt: &stamp}}, nil
}

func (s *countingStore) ReferenceFetchedAt(context.Context, string) (*time.Time, error) {
	s.fetched++
	return &s.stamp, nil
}

func (s *countingStore) UpsertCatalog(context.Context, catalog.Program, []catalog.CourseOffering) error {
	s.stamp = s.stamp.Add(time.Hour)
	return nil
}

func TestCachedServesRepeatsFromMemoryAndInvalidatesOnWrite(t *testing.T) {
	ctx := context.Background()
	inner := &countingStore{stamp: time.Now()}
	c := NewCached(inner)

	for range 3 {
		if _, err := c.Programs(ctx, "1101", "", "pregrado"); err != nil {
			t.Fatal(err)
		}
		if _, err := c.ReferenceFetchedAt(ctx, "levels"); err != nil {
			t.Fatal(err)
		}
	}
	if inner.programs != 1 || inner.fetched != 1 {
		t.Fatalf("want 1 load each, got programs=%d fetched=%d", inner.programs, inner.fetched)
	}

	// A different key is a different entry.
	if _, err := c.Programs(ctx, "3068", "", "pregrado"); err != nil {
		t.Fatal(err)
	}
	if inner.programs != 2 {
		t.Fatalf("want a load for another campus, got %d", inner.programs)
	}

	// UpsertCatalog moves catalog_fetched_at, which the cached rows carry.
	before, _ := c.Programs(ctx, "1101", "", "pregrado")
	if err := c.UpsertCatalog(ctx, catalog.Program{ID: 1}, nil); err != nil {
		t.Fatal(err)
	}
	after, _ := c.Programs(ctx, "1101", "", "pregrado")
	if !after[0].CatalogFetchedAt.After(*before[0].CatalogFetchedAt) {
		t.Fatal("UpsertCatalog did not invalidate: stale catalog_fetched_at served")
	}
}
