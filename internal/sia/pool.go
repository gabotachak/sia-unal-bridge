package sia

import (
	"context"
	"fmt"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// DefaultPoolSize is fase 1's chosen size: the SIA takes 8 concurrent
// sessions without throttling; 4 is a courtesy limit, not a server
// constraint. See docs/ARCH.md "Concurrencia".
const DefaultPoolSize = 4

// keepaliveInterval must stay ≤3min: the real idle timeout measured is
// ~4.2min, not the 5min the JS timer advertises. GOTCHAS §7.
const keepaliveInterval = 3 * time.Minute

// Pool is a fixed set of live SIAConn, handed out one at a time. The
// channel IS the mutex: a connection is only in the channel while idle, so
// holding it across an entire logical operation (Acquire ... release)
// implements GOTCHAS §28's rule — mutex per connection around the whole
// operation, never a single POST — for free.
type Pool struct {
	baseURL string
	conns   chan *SIAConn
	size    int
}

// NewPool bootstraps size connections SEQUENTIALLY — never fan them out in
// parallel. The bootstrap alone can hit 4.5MB; size of them at once is the
// mistake docs/ARCH.md calls out ("Bootstraps en fan-out").
func NewPool(ctx context.Context, baseURL string, size int) (*Pool, error) {
	if size <= 0 {
		size = DefaultPoolSize
	}
	p := &Pool{baseURL: baseURL, conns: make(chan *SIAConn, size), size: size}
	for i := 0; i < size; i++ {
		c, err := NewConn(baseURL)
		if err != nil {
			return nil, fmt.Errorf("sia: pool: new conn %d: %w", i, err)
		}
		if _, err := c.Bootstrap(ctx); err != nil {
			return nil, fmt.Errorf("sia: pool: bootstrap conn %d: %w", i, err)
		}
		p.conns <- c
	}
	return p, nil
}

// Acquire blocks until a connection is free or ctx is done. The release
// func MUST be called exactly once, after the caller's entire logical
// operation finishes (cascade+cb1, or detail+Volver) — releasing early and
// letting a second goroutine interleave POSTs on the same conn reproduces
// GOTCHAS §28's cross-talk bug.
func (p *Pool) Acquire(ctx context.Context) (*SIAConn, func(), error) {
	select {
	case c := <-p.conns:
		return c, func() { p.conns <- c }, nil
	case <-ctx.Done():
		return nil, nil, catalog.ErrBusy
	}
}

// Keepalive pings idle connections every keepaliveInterval until ctx is
// done. Busy connections (checked out via Acquire) are untouched — they're
// not in the channel, so pingIdle simply never sees them, which is exactly
// what GOTCHAS §28 requires (no POST from a second goroutine on a
// checked-out conn).
func (p *Pool) Keepalive(ctx context.Context) {
	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.pingIdle(ctx)
		}
	}
}

func (p *Pool) pingIdle(ctx context.Context) {
	idle := make([]*SIAConn, 0, p.size)
drain:
	for {
		select {
		case c := <-p.conns:
			idle = append(idle, c)
		default:
			break drain
		}
	}
	for _, c := range idle {
		if time.Since(c.LastUsed) >= keepaliveInterval {
			if err := c.Ping(ctx); err != nil {
				// Best-effort reconnect. If this also fails, the conn goes
				// back stale; the next real request's noop will surface it
				// and the caller (paso 6 read-through) retries with a fresh
				// bootstrap. Never shrink the pool over a transient error.
				_, _ = c.Bootstrap(ctx)
			}
		}
		p.conns <- c
	}
}
