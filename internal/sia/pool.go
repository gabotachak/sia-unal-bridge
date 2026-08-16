package sia

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// DefaultPoolSize is fase 1's chosen size: the SIA takes 8 concurrent
// sessions without throttling; 4 is a courtesy limit, not a server
// constraint. See docs/ARCH.md "Concurrencia".
const DefaultPoolSize = 4

// keepaliveTick / keepaliveIdle: the session dies after ~4.2min idle, not
// the 5min the JS timer advertises (GOTCHAS §7). A single 3min timer is NOT
// enough: a connection released one second after a tick is 2min59s old at
// the next one, gets skipped, and is dead long before the tick after that.
// So the loop runs often (keepaliveTick) and pings anything older than
// keepaliveIdle, leaving ≥2min of slack against the 4.2min deadline.
const (
	keepaliveTick = 45 * time.Second
	keepaliveIdle = 2 * time.Minute
)

// rebootstrapTimeout bounds the self-healing bootstrap done outside the
// caller's context: the caller may already have gone away (cancelled
// request), and the connection must still be repaired or the pool leaks a
// permanently dead session — the failure mode that returned sia_noop to
// every request until the process was restarted.
const rebootstrapTimeout = 45 * time.Second

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
	ticker := time.NewTicker(keepaliveTick)
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
		if time.Since(c.LastUsed) >= keepaliveIdle {
			if err := c.Ping(ctx); err != nil {
				// Best-effort reconnect. Ping already reports a noop as an
				// error, so a dead session lands here instead of being
				// mistaken for a live one. If the bootstrap also fails the
				// conn goes back stale and Do's retry repairs it on the next
				// real request. Never shrink the pool over a transient error.
				slog.Warn("sia: keepalive ping failed, re-bootstrapping", "err", err)
				if _, berr := c.Bootstrap(ctx); berr != nil {
					slog.Error("sia: keepalive re-bootstrap failed", "err", berr)
				}
			}
		}
		p.conns <- c
	}
}

// Do runs fn on a pooled connection and guarantees that the connection goes
// back to the pool USABLE. Two repairs, both of which the pool lacked and
// whose absence wedged every connection permanently:
//
//   - a noop (dead session — GOTCHAS §6/§7) re-bootstraps and retries fn
//     once, because a dead ADF session never recovers on its own;
//   - a connection left inside a numbered detail region (GOTCHAS §10/§20)
//     is walked back out, with a bootstrap as the fallback.
//
// The repair never runs on the caller's context: a cancelled request is
// precisely when the connection is most likely to be left mid-operation.
func Do[T any](ctx context.Context, p *Pool, fn func(*SIAConn) (T, error)) (T, error) {
	var zero T
	conn, release, err := p.Acquire(ctx)
	if err != nil {
		return zero, err
	}
	defer release()

	out, err := fn(conn)
	if err == nil {
		return out, nil
	}
	if !isRecoverable(err) {
		repair(conn)
		return zero, err
	}

	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), rebootstrapTimeout)
	_, berr := conn.Bootstrap(rctx)
	cancel()
	if berr != nil {
		slog.Error("sia: re-bootstrap after noop failed", "err", berr)
		return zero, err // the original noop is the honest answer
	}

	out, err = fn(conn)
	if err != nil {
		repair(conn)
		return zero, err
	}
	return out, nil
}

// isRecoverable reports whether a fresh session would plausibly fix err. A
// noop is the session-death signature; a stale detail region means the
// connection's own state is wrong, which a bootstrap resets.
func isRecoverable(err error) bool {
	return errors.Is(err, catalog.ErrSIANoop) || errors.Is(err, errStaleDetailRegion)
}

// repair leaves the connection in a state the next caller can use: out of
// any detail region, session alive if possible. Detached from the caller's
// context on purpose (see Do).
func repair(c *SIAConn) {
	if c.DetailRegion == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), rebootstrapTimeout)
	defer cancel()
	if _, err := c.Volver(ctx); err == nil {
		return
	}
	if _, err := c.Bootstrap(ctx); err != nil {
		slog.Error("sia: repair bootstrap failed", "err", err)
	}
}
