package catalog

import (
	"context"
	"time"
)

type backgroundKey struct{}

// WithBackground marks work nobody is waiting on — a client sweeping a whole
// catalog to refresh its seats column, as opposed to a person opening one
// course. SIASource uses it to keep such work from taking every connection.
func WithBackground(ctx context.Context) context.Context {
	return context.WithValue(ctx, backgroundKey{}, true)
}

func IsBackground(ctx context.Context) bool {
	b, _ := ctx.Value(backgroundKey{}).(bool)
	return b
}

// SIAHealth is what /v1/status says about the path to the SIA. It exists
// because /v1/healthz answered "ok" through a whole weekend in which 85% of
// the SIA-bound requests failed (2026-09-20): the process was healthy, its
// connections were not, and nothing reported the difference.
type SIAHealth struct {
	PoolSize      int        `json:"pool_size"`
	Ready         int        `json:"ready"`
	FetchesOK     int64      `json:"fetches_ok"`
	FetchesFailed int64      `json:"fetches_failed"`
	Noops         int64      `json:"noops"`
	Posts         int64      `json:"posts"` // traffic this process sent the SIA's way
	Bytes         int64      `json:"bytes"` // and what came back, bootstraps included
	LastOK        *time.Time `json:"last_ok,omitempty"`
}

// SIAHealth reports the source's health when the source can tell; ok is
// false for one that cannot (the test fakes).
func (s *Service) SIAHealth() (SIAHealth, bool) {
	r, ok := s.sia.(interface{ Health() SIAHealth })
	if !ok {
		return SIAHealth{}, false
	}
	return r.Health(), true
}
