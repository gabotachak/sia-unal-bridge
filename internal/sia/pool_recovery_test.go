package sia

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// fakeSIA is the smallest server that satisfies Bootstrap and post: a page
// carrying a ViewState, and POST replies whose size decides noop vs render.
type fakeSIA struct {
	gets, posts atomic.Int32
	postBody    func(n int32) string // n is 1-based post count
}

func (f *fakeSIA) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			f.gets.Add(1)
			fmt.Fprintf(w, `<html><input name="javax.faces.ViewState" value="vs-%d"/>%s</html>`,
				f.gets.Load(), strings.Repeat("x", 4096))
			return
		}
		n := f.posts.Add(1)
		fmt.Fprint(w, f.postBody(n))
	})
}

// bigRender is any body above noopThreshold: a real re-render.
func bigRender() string { return strings.Repeat("y", noopThreshold*2) }

// smallNoop is ADF's silent no-op: under noopThreshold. GOTCHAS §6.
func smallNoop() string { return strings.Repeat("z", 300) }

func newFakePool(t *testing.T, f *fakeSIA) *Pool {
	t.Helper()
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)

	p := &Pool{baseURL: srv.URL, conns: make(chan *SIAConn, 1), size: 1}
	c, err := NewConn(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}
	p.conns <- c
	return p
}

// A dead ADF session never recovers on its own: without a re-bootstrap the
// connection answers noop forever and the whole pool rots. GOTCHAS §7.
func TestDo_RebootstrapsAndRetriesAfterNoop(t *testing.T) {
	f := &fakeSIA{postBody: func(int32) string { return bigRender() }}
	p := newFakePool(t, f)
	before := f.gets.Load()

	calls := 0
	got, err := Do(context.Background(), p, func(c *SIAConn) (string, error) {
		calls++
		if calls == 1 {
			return "", newNoopError([]byte(smallNoop()))
		}
		return "ok", nil
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if got != "ok" {
		t.Fatalf("got %q, want the retry's result", got)
	}
	if calls != 2 {
		t.Fatalf("fn ran %d times, want 2 (first noop, then retry)", calls)
	}
	if n := f.gets.Load() - before; n != 1 {
		t.Fatalf("%d bootstraps after the noop, want exactly 1", n)
	}
}

// A connection wedged inside a numbered detail region is a state bug the
// bootstrap clears — GOTCHAS §10/§20.
func TestDo_RetriesStaleDetailRegion(t *testing.T) {
	f := &fakeSIA{postBody: func(int32) string { return bigRender() }}
	p := newFakePool(t, f)

	calls := 0
	_, err := Do(context.Background(), p, func(c *SIAConn) (int, error) {
		calls++
		if calls == 1 {
			c.DetailRegion = 7
			return 0, fmt.Errorf("wrapped: %w", errStaleDetailRegion)
		}
		if c.DetailRegion != 0 {
			t.Errorf("retry saw DetailRegion=%d, want 0 after the bootstrap", c.DetailRegion)
		}
		return 1, nil
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if calls != 2 {
		t.Fatalf("fn ran %d times, want 2", calls)
	}
}

// Anything else (parse bugs, not-found, ...) is not a session problem: a
// bootstrap would only cost a round trip and lose the connection's parking.
func TestDo_DoesNotRetryUnrelatedErrors(t *testing.T) {
	f := &fakeSIA{postBody: func(int32) string { return bigRender() }}
	p := newFakePool(t, f)
	before := f.gets.Load()

	sentinel := errors.New("parse failed")
	calls := 0
	_, err := Do(context.Background(), p, func(*SIAConn) (int, error) {
		calls++
		return 0, sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("got %v, want the original error", err)
	}
	if calls != 1 {
		t.Fatalf("fn ran %d times, want 1", calls)
	}
	if n := f.gets.Load() - before; n != 0 {
		t.Fatalf("%d bootstraps, want 0", n)
	}
}

// The connection must go back to the pool usable even when the operation
// failed with it parked in a detail region.
func TestDo_RepairsDetailRegionOnFailure(t *testing.T) {
	f := &fakeSIA{postBody: func(int32) string { return bigRender() }}
	p := newFakePool(t, f)

	_, err := Do(context.Background(), p, func(c *SIAConn) (int, error) {
		c.DetailRegion = 4
		return 0, errors.New("boom")
	})
	if err == nil {
		t.Fatal("want the operation's error")
	}
	c, _, err := p.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if c.DetailRegion != 0 {
		t.Fatalf("released conn still in detail region %d", c.DetailRegion)
	}
}

// Ping must report a dead session instead of silently "succeeding" — the
// bug that let keepalive keep dead connections in the pool indefinitely.
func TestPing_ReportsNoopAsError(t *testing.T) {
	f := &fakeSIA{postBody: func(int32) string { return smallNoop() }}
	p := newFakePool(t, f)
	c, release, err := p.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	c.parked = true

	if err := c.Ping(context.Background()); !errors.Is(err, catalog.ErrSIANoop) {
		t.Fatalf("Ping on a dead session returned %v, want a noop error", err)
	}
}

// An un-parked connection still holds a session that dies after ~4.2min, so
// keepalive must actually send something for it too.
func TestPing_UnparkedConnectionStillPosts(t *testing.T) {
	f := &fakeSIA{postBody: func(int32) string { return bigRender() }}
	p := newFakePool(t, f)
	c, release, err := p.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	before := f.posts.Load()
	if err := c.Ping(context.Background()); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	if n := f.posts.Load() - before; n != 1 {
		t.Fatalf("Ping sent %d POSTs on an un-parked conn, want 1", n)
	}
}

// A re-bootstrap must not carry the old cookies along. The SIA hands out a
// long-lived cookie next to the session one, and a connection whose jar
// survived the re-bootstrap stayed poisoned forever: measured in production
// 2026-09-20, cured only by restarting the process.
func TestDo_RebootstrapStartsFromAnEmptyCookieJar(t *testing.T) {
	var gets atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tracked, err := r.Cookie("cookiesession1")
		if r.Method == http.MethodGet {
			n := gets.Add(1)
			if err != nil { // like the real one: set once, never replaced
				http.SetCookie(w, &http.Cookie{Name: "cookiesession1", Value: fmt.Sprint(n), Path: "/"})
			}
			fmt.Fprintf(w, `<html><input name="javax.faces.ViewState" value="vs-%d"/>%s</html>`, n, strings.Repeat("x", 4096))
			return
		}
		if err == nil && tracked.Value == "1" { // the first client is the poisoned one
			fmt.Fprint(w, smallNoop())
			return
		}
		fmt.Fprint(w, bigRender())
	}))
	t.Cleanup(srv.Close)

	p := &Pool{baseURL: srv.URL, conns: make(chan *SIAConn, 1), size: 1}
	c, err := NewConn(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Bootstrap(context.Background()); err != nil {
		t.Fatal(err)
	}
	p.conns <- c

	_, err = Do(context.Background(), p, func(c *SIAConn) (struct{}, error) {
		body, err := c.DebugRawCB1(context.Background())
		if err == nil && isNoop(body) {
			err = newNoopError(body)
		}
		return struct{}{}, err
	})
	if err != nil {
		t.Fatalf("Do: the re-bootstrap kept the poisoned cookie: %v", err)
	}
}
