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

// acquireAt prefers the idle connection already parked on the program, even
// when it is not the first one in the (FIFO) channel — and hands the others
// back untouched.
func TestAcquireAt_PrefersTheConnectionParkedOnTheProgram(t *testing.T) {
	key := catalog.ProgramKey{Level: 0, Campus: 2, Faculty: 8, Program: 3, CampusCode: "1101"}
	elsewhere := &SIAConn{}
	parked := &SIAConn{parked: true, ParkedAt: key}
	p := &Pool{conns: make(chan *SIAConn, 2), size: 2}
	p.conns <- elsewhere
	p.conns <- parked

	got, release, err := p.acquireAt(context.Background(), &key)
	if err != nil {
		t.Fatal(err)
	}
	if got != parked {
		t.Fatal("got the first idle connection, want the one parked on the program")
	}
	if len(p.conns) != 1 {
		t.Fatalf("the skipped connection did not go back: %d idle, want 1", len(p.conns))
	}
	release()

	other := catalog.ProgramKey{Level: 0, Campus: 6, Faculty: 4, Program: 2, CampusCode: "1102"}
	if _, release, err = p.acquireAt(context.Background(), &other); err != nil {
		t.Fatalf("no match must fall back to any idle connection: %v", err)
	}
	release()
}

// Background work may hold at most half the pool: with its lane full, more
// background work waits (and gives up as busy) while a person's request still
// gets a connection.
func TestDoAt_BackgroundLaneLeavesRoomForInteractiveWork(t *testing.T) {
	p := &Pool{conns: make(chan *SIAConn, 2), size: 2, bg: make(chan struct{}, 1)}
	p.conns <- &SIAConn{}
	p.conns <- &SIAConn{}
	noop := func(*SIAConn) (struct{}, error) { return struct{}{}, nil }

	p.bg <- struct{}{} // one background operation in flight

	short, cancel := context.WithTimeout(catalog.WithBackground(context.Background()), 20*time.Millisecond)
	defer cancel()
	if _, err := DoAt(short, p, nil, noop); !errors.Is(err, catalog.ErrBusy) {
		t.Fatalf("second background op: got %v, want ErrBusy", err)
	}
	if _, err := DoAt(context.Background(), p, nil, noop); err != nil {
		t.Fatalf("interactive op with the background lane full: %v", err)
	}
}
