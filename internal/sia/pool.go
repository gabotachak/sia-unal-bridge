package sia

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// DefaultPoolSize is fase 1's chosen size. 80 is the measured optimum:
// against production (2026-08-19) the SIA runs 80 concurrent sessions clean
// with flat p50 latency, and 88 already shows ~4.5% failures
// (docs/OPEN-QUESTIONS.md §5). 4 is sized to current real traffic; the
// headroom up to 80 is a config decision — see docs/ARCH.md "Concurrencia".
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

// readyBeforeServing is how many connections NewPool bootstraps before it
// returns; the rest are filled in the background.
//
// Why not all of them: bootstrapping is SEQUENTIAL (see NewPool) and costs
// 0.15–7 s each with a very wide spread (GOTCHAS §25). At size 4 that is a
// rounding error, but the pool is a config knob now — at 32 it is up to
// ~3.7 min during which cmd/bridge has not reached ListenAndServe and the
// service is simply down. The startup cost stopped being proportional to
// the pool the moment the pool stopped being 4.
//
// Why not one: a single connection serves one request at a time, so the
// first seconds after a deploy would be a queue. Four is what fase 1 ran on
// for months — enough to serve real traffic while the rest arrive.
const readyBeforeServing = 4

// fillRetryDelay paces the background filler's retries. The SIA being down
// is exactly when this loop must not become a hot loop against it.
const fillRetryDelay = 15 * time.Second

// Pool is a fixed set of live SIAConn, handed out one at a time. The
// channel IS the mutex: a connection is only in the channel while idle, so
// holding it across an entire logical operation (Acquire ... release)
// implements GOTCHAS §28's rule — mutex per connection around the whole
// operation, never a single POST — for free.
type Pool struct {
	baseURL string
	conns   chan *SIAConn
	size    int

	// mu guards all. The background filler appends to it after NewPool has
	// returned, so it is no longer written once at construction — and
	// Stats already read it from another goroutine.
	mu sync.Mutex
	// all is every connection the pool owns, checked out or not — the
	// channel only holds the idle ones, so it cannot answer "how much
	// traffic did this process generate".
	all []*SIAConn

	// bg caps how many connections background work (catalog.WithBackground)
	// may hold at once — half the pool. Without it one client sweeping a
	// catalog for seats held all 32 while somebody else's catalog miss queued
	// behind measurements nobody had asked for.
	bg chan struct{}

	// Health counters, since process start (Pool.Health).
	fetchesOK, fetchesFailed, noops atomic.Int64
	lastOK                          atomic.Int64 // unix nanos, 0 = never
}

// NewPool returns a pool that is USABLE, not necessarily full: it bootstraps
// readyBeforeServing connections and fills the rest in the background.
//
// Bootstraps are SEQUENTIAL, never fanned out — the bootstrap alone can hit
// 4.5MB and doing size of them at once is the mistake docs/ARCH.md calls out
// ("Bootstraps en fan-out"). The background filler keeps that property; it
// is one goroutine adding one connection at a time.
//
// A bootstrap that fails no longer kills the process. It used to: one bad
// bootstrap out of size returned an error, cmd/bridge called os.Exit(1), and
// docker's restart policy tried all of them again. That is P(start) = p^size
// — invisible at 4, a crash loop at 32. Now the failures are logged and
// retried by the filler, and the only fatal case is the honest one: not a
// single connection could be bootstrapped, so there is nothing to serve
// with.
func NewPool(ctx context.Context, baseURL string, size int) (*Pool, error) {
	if size <= 0 {
		size = DefaultPoolSize
	}
	p := &Pool{baseURL: baseURL, conns: make(chan *SIAConn, size), size: size,
		bg: make(chan struct{}, max(1, size/2))}

	var lastErr error
	for i := 0; i < min(size, readyBeforeServing); i++ {
		if err := p.add(ctx); err != nil {
			lastErr = err
			slog.Warn("sia: pool: bootstrap failed at startup, continuing", "conn", i, "err", err)
		}
	}
	if p.Ready() == 0 {
		return nil, fmt.Errorf("sia: pool: no connection could be bootstrapped: %w", lastErr)
	}
	if p.Ready() < size {
		go p.fill(ctx)
	}
	return p, nil
}

// add bootstraps one connection and hands it to the pool. The send never
// blocks: conns is buffered to size and add is never called beyond it.
func (p *Pool) add(ctx context.Context) error {
	c, err := NewConn(p.baseURL)
	if err != nil {
		return fmt.Errorf("sia: pool: new conn: %w", err)
	}
	if _, err := c.Bootstrap(ctx); err != nil {
		return fmt.Errorf("sia: pool: bootstrap: %w", err)
	}
	p.mu.Lock()
	p.all = append(p.all, c)
	p.mu.Unlock()
	p.conns <- c
	return nil
}

// fill brings the pool up to size, one connection at a time, retrying until
// ctx is done. It never gives up: a transient SIA outage during startup
// would otherwise shrink the pool for the lifetime of the process, and the
// operator would see a pool of 6 where the config says 32 with nothing to
// explain it.
func (p *Pool) fill(ctx context.Context) {
	for p.Ready() < p.size {
		if err := p.add(ctx); err != nil {
			if ctx.Err() != nil {
				return // shutting down; not a failure worth logging
			}
			slog.Warn("sia: pool: background fill failed, retrying",
				"ready", p.Ready(), "target", p.size, "err", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(fillRetryDelay):
			}
		}
	}
	slog.Info("sia: pool: filled", "size", p.size)
}

// Ready is how many connections the pool owns right now — at or below size
// while the background filler is still working.
func (p *Pool) Ready() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.all)
}

// Stats reports the traffic this pool has generated: POSTs made and bytes
// read (bootstraps included). It is what refresh_run stores and what makes
// the bandwidth figures of docs/FASE-2.md auditable instead of estimated.
func (p *Pool) Stats() (posts, bytes int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.all {
		posts += c.posts.Load()
		bytes += c.bytes.Load()
	}
	return posts, bytes
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

// acquireAt is Acquire with a preference: an idle connection already parked
// on key skips the cascade — 2 POSTs instead of 6, ~1.3 s instead of ~10 s
// (docs/ARCH.md). The channel is FIFO and knows nothing about where each
// connection sits, so this looks through what is idle RIGHT NOW, keeps the
// first match and puts the rest back. No match, or an empty pool, falls back
// to the plain blocking Acquire: affinity is a saving, never a wait.
func (p *Pool) acquireAt(ctx context.Context, key *catalog.ProgramKey) (*SIAConn, func(), error) {
	if key != nil {
		var hit *SIAConn
		var skipped []*SIAConn
	scan:
		for range p.size {
			select {
			case c := <-p.conns:
				if c.parked && c.ParkedAt == *key && c.DetailRegion == 0 {
					hit = c
					break scan
				}
				skipped = append(skipped, c)
			default:
				break scan
			}
		}
		for _, c := range skipped {
			p.conns <- c
		}
		if hit != nil {
			return hit, func() { p.conns <- hit }, nil
		}
	}
	return p.Acquire(ctx)
}

// Health is the pool's own account of how the path to the SIA is doing.
func (p *Pool) Health() catalog.SIAHealth {
	posts, bytes := p.Stats()
	h := catalog.SIAHealth{
		PoolSize: p.size, Ready: p.Ready(), Posts: posts, Bytes: bytes,
		FetchesOK: p.fetchesOK.Load(), FetchesFailed: p.fetchesFailed.Load(), Noops: p.noops.Load(),
	}
	if ns := p.lastOK.Load(); ns != 0 {
		t := time.Unix(0, ns)
		h.LastOK = &t
	}
	return h
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
	return DoAt(ctx, p, nil, fn)
}

// DoAt is Do for an operation that starts by walking to a program: it prefers
// a connection already parked there (acquireAt). Background work first takes
// a slot of the background lane.
func DoAt[T any](ctx context.Context, p *Pool, key *catalog.ProgramKey, fn func(*SIAConn) (T, error)) (out T, err error) {
	var zero T
	if p.bg != nil && catalog.IsBackground(ctx) {
		select {
		case p.bg <- struct{}{}:
			defer func() { <-p.bg }()
		case <-ctx.Done():
			return zero, catalog.ErrBusy
		}
	}
	conn, release, err := p.acquireAt(ctx, key)
	if err != nil {
		return zero, err
	}
	defer release()
	defer func() {
		if err == nil {
			p.fetchesOK.Add(1)
			p.lastOK.Store(time.Now().UnixNano())
		} else if ctx.Err() == nil { // a caller that left is not the SIA failing
			p.fetchesFailed.Add(1)
		}
	}()

	// A connection that answered noop even on a fresh session last time is
	// not trusted with this request: it starts over first.
	if conn.suspect {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), rebootstrapTimeout)
		_, _ = conn.Bootstrap(rctx)
		cancel()
	}

	out, err = fn(conn)
	if err == nil {
		return out, nil
	}
	if errors.Is(err, catalog.ErrSIANoop) {
		p.noops.Add(1)
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
		// A noop that survives a brand new session is not session death, and
		// its body is the only clue to what it is instead.
		var noop *NoopError
		if errors.As(err, &noop) {
			p.noops.Add(1)
			conn.suspect = true
			slog.Warn("sia: noop survived a re-bootstrap", "bytes", len(noop.Body), "expired", noop.Expired,
				"head", string(noop.Body[:min(len(noop.Body), 200)]))
		}
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
