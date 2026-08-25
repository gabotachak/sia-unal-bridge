package sia

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// bootstrapServer serves the smallest page Bootstrap accepts, and lets a test
// decide per-GET whether it succeeds. `n` is the 1-based GET count.
type bootstrapServer struct {
	gets atomic.Int32
	// fail reports whether GET n answers 500 instead of a usable page.
	fail func(n int32) bool
	// gate, when non-nil, blocks GET n until it is closed. It is what makes
	// "returned before the pool was full" observable instead of a race.
	gate func(n int32) <-chan struct{}
}

func (s *bootstrapServer) start(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := s.gets.Add(1)
		if s.gate != nil {
			if ch := s.gate(n); ch != nil {
				<-ch
			}
		}
		if s.fail != nil && s.fail(n) {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		fmt.Fprintf(w, `<html><input name="javax.faces.ViewState" value="vs-%d"/>%s</html>`,
			n, strings.Repeat("x", 4096))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// waitFor polls until cond holds, so a background filler can be asserted on
// without sleeping for a fixed guess.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// One bad bootstrap used to kill the process: NewPool returned an error,
// cmd/bridge called os.Exit(1), and docker restarted it to try all of them
// again. P(start) = p^size — fine at 4, a crash loop at 32.
func TestNewPool_SurvivesPartialBootstrapFailure(t *testing.T) {
	s := &bootstrapServer{fail: func(n int32) bool { return n == 1 }}

	p, err := NewPool(context.Background(), s.start(t), 2)
	if err != nil {
		t.Fatalf("NewPool must not fail when some connection did bootstrap: %v", err)
	}
	if p.Ready() < 1 {
		t.Fatalf("Ready()=%d, want at least the connection that did bootstrap", p.Ready())
	}
	// And the filler makes up for the one that failed instead of leaving the
	// pool permanently short of its configured size.
	waitFor(t, "the background filler to reach the target size",
		func() bool { return p.Ready() == 2 })
}

// The one honest fatal case: nothing bootstrapped, so there is nothing to
// serve with. Better to exit and let the restart policy retry than to answer
// 503 busy to every request forever.
func TestNewPool_FailsWhenNoConnectionBootstraps(t *testing.T) {
	s := &bootstrapServer{fail: func(int32) bool { return true }}

	if _, err := NewPool(context.Background(), s.start(t), 2); err == nil {
		t.Fatal("NewPool must fail when not a single connection bootstrapped")
	}
}

// The point of the change: startup no longer costs size × bootstrap. The gate
// holds every connection past readyBeforeServing, so if NewPool returned it
// can only be because it stopped waiting for them.
func TestNewPool_ReturnsBeforeThePoolIsFull(t *testing.T) {
	release := make(chan struct{})
	s := &bootstrapServer{
		gate: func(n int32) <-chan struct{} {
			if n > readyBeforeServing {
				return release
			}
			return nil
		},
	}
	const size = readyBeforeServing + 4

	p, err := NewPool(context.Background(), s.start(t), size)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	if p.Ready() != readyBeforeServing {
		t.Fatalf("Ready()=%d right after NewPool, want %d — it waited for the whole pool",
			p.Ready(), readyBeforeServing)
	}

	close(release)
	waitFor(t, "the background filler to reach the target size",
		func() bool { return p.Ready() == size })
}

// Shutting down must stop the filler; otherwise a process told to stop keeps
// opening sessions against the SIA while it drains.
func TestNewPool_FillerStopsWithContext(t *testing.T) {
	s := &bootstrapServer{fail: func(n int32) bool { return n > readyBeforeServing }}

	ctx, cancel := context.WithCancel(context.Background())
	if _, err := NewPool(ctx, s.start(t), readyBeforeServing+1); err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	cancel()

	// The filler never reaches the target here (the last slot always 500s),
	// so without the ctx check it would retry forever. What must be true
	// after cancel is that the GET count stops moving: the two windows are
	// far shorter than fillRetryDelay, so a live filler would show up.
	time.Sleep(50 * time.Millisecond)
	settled := s.gets.Load()
	time.Sleep(50 * time.Millisecond)
	if n := s.gets.Load(); n != settled {
		t.Fatalf("filler kept bootstrapping after cancel: %d → %d GETs", settled, n)
	}
}
