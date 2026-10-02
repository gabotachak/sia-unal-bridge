package store

import (
	"context"
	"slices"
	"sync"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// referenceCacheTTL bounds how long another process's write (the Refresher)
// can go unseen. This process's own writes invalidate at once.
const referenceCacheTTL = time.Minute

// Cached wraps a catalog.Store and keeps the reference reads in memory:
// levels, campuses, program directories and their TTL markers. Every request
// under /campuses/{campus}/programs/{program} resolves its program through
// those, ~8 sequential queries for data that changes once a month.
//
// Everything else passes straight through: detail and seats are volatile and
// already one read per datum.
//
// In memory and not Redis on purpose: with one instance a Redis round trip
// costs the same as the Postgres one it would replace.
type Cached struct {
	catalog.Store

	mu      sync.Mutex
	entries map[string]cacheEntry
}

type cacheEntry struct {
	val     any
	expires time.Time
}

var _ catalog.Store = (*Cached)(nil)

func NewCached(s catalog.Store) *Cached {
	return &Cached{Store: s, entries: make(map[string]cacheEntry)}
}

// cached returns key's value, loading it with load on a miss or expiry.
// Errors are never cached. Two concurrent misses both load: harmless, the
// loads are idempotent reads.
func cached[T any](c *Cached, key string, load func() (T, error)) (T, error) {
	c.mu.Lock()
	e, ok := c.entries[key]
	c.mu.Unlock()
	if ok && time.Now().Before(e.expires) {
		return e.val.(T), nil
	}
	v, err := load()
	if err != nil {
		return v, err
	}
	c.mu.Lock()
	c.entries[key] = cacheEntry{val: v, expires: time.Now().Add(referenceCacheTTL)}
	c.mu.Unlock()
	return v, nil
}

// invalidate drops everything. Reference writes are rare (a directory miss, a
// catalog refresh) and the entries depend on each other, so per-key
// invalidation would buy nothing but a chance to miss one.
func (c *Cached) invalidate() {
	c.mu.Lock()
	clear(c.entries)
	c.mu.Unlock()
}

// The slices are cloned on the way out: they are shared between requests,
// and a caller appending to one must not write into another's.

func (c *Cached) Levels(ctx context.Context) ([]catalog.Level, error) {
	v, err := cached(c, "levels", func() ([]catalog.Level, error) { return c.Store.Levels(ctx) })
	return slices.Clone(v), err
}

func (c *Cached) Campuses(ctx context.Context, levelSlug string) ([]catalog.Campus, error) {
	v, err := cached(c, "campuses\x00"+levelSlug, func() ([]catalog.Campus, error) {
		return c.Store.Campuses(ctx, levelSlug)
	})
	return slices.Clone(v), err
}

// Programs is cached with catalog_fetched_at inside each row, which is why
// UpsertCatalog invalidates too: a stale stamp would make Service.Catalog
// refresh a catalog it just refreshed.
func (c *Cached) Programs(ctx context.Context, campusCode, facultyCode, levelSlug string) ([]catalog.Program, error) {
	v, err := cached(c, "programs\x00"+campusCode+"\x00"+facultyCode+"\x00"+levelSlug, func() ([]catalog.Program, error) {
		return c.Store.Programs(ctx, campusCode, facultyCode, levelSlug)
	})
	return slices.Clone(v), err
}

func (c *Cached) ReferenceFetchedAt(ctx context.Context, scope string) (*time.Time, error) {
	return cached(c, "fetched\x00"+scope, func() (*time.Time, error) { return c.Store.ReferenceFetchedAt(ctx, scope) })
}

func (c *Cached) UpsertLevels(ctx context.Context, scope string, levels []catalog.Level) error {
	defer c.invalidate()
	return c.Store.UpsertLevels(ctx, scope, levels)
}

func (c *Cached) UpsertCampuses(ctx context.Context, scope string, campuses []catalog.Campus) error {
	defer c.invalidate()
	return c.Store.UpsertCampuses(ctx, scope, campuses)
}

func (c *Cached) UpsertPrograms(ctx context.Context, scope string, programs []catalog.Program) error {
	defer c.invalidate()
	return c.Store.UpsertPrograms(ctx, scope, programs)
}

func (c *Cached) UpsertProgram(ctx context.Context, p catalog.Program) (catalog.Program, error) {
	defer c.invalidate()
	return c.Store.UpsertProgram(ctx, p)
}

func (c *Cached) UpsertCatalog(ctx context.Context, program catalog.Program, offerings []catalog.CourseOffering) error {
	defer c.invalidate()
	return c.Store.UpsertCatalog(ctx, program, offerings)
}
