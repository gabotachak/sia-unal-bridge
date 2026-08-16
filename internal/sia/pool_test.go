package sia

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// newTestPool builds a Pool without hitting the network — NewPool always
// bootstraps, so this constructs the channel directly with un-bootstrapped
// conns. Fine for exercising Acquire/release semantics in isolation.
func newTestPool(size int) *Pool {
	p := &Pool{baseURL: "http://unused.invalid", conns: make(chan *SIAConn, size), size: size}
	for i := 0; i < size; i++ {
		c, _ := NewConn(p.baseURL)
		p.conns <- c
	}
	return p
}

func TestPool_AcquireReleaseRoundTrip(t *testing.T) {
	p := newTestPool(1)
	ctx := context.Background()

	c, release, err := p.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if c == nil {
		t.Fatal("Acquire returned nil conn")
	}
	release()

	select {
	case back := <-p.conns:
		if back != c {
			t.Error("released conn is not the same one that was acquired")
		}
	default:
		t.Fatal("release() did not return the conn to the pool")
	}
}

func TestPool_AcquireBlocksWhenExhausted(t *testing.T) {
	p := newTestPool(1)
	ctx := context.Background()

	_, _, err := p.Acquire(ctx)
	if err != nil {
		t.Fatalf("first Acquire: %v", err)
	}

	shortCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	_, _, err = p.Acquire(shortCtx)
	if !errors.Is(err, catalog.ErrBusy) {
		t.Fatalf("got %v, want catalog.ErrBusy when pool is exhausted", err)
	}
}

func TestPool_ExclusiveAcrossConcurrentAcquires(t *testing.T) {
	p := newTestPool(2)
	ctx := context.Background()

	held := map[*SIAConn]bool{}
	for i := 0; i < 2; i++ {
		c, _, err := p.Acquire(ctx)
		if err != nil {
			t.Fatalf("Acquire %d: %v", i, err)
		}
		if held[c] {
			t.Fatalf("same conn handed out twice while both should be checked out")
		}
		held[c] = true
	}

	shortCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, _, err := p.Acquire(shortCtx); !errors.Is(err, catalog.ErrBusy) {
		t.Fatalf("got %v, want ErrBusy: both conns are checked out", err)
	}
}
