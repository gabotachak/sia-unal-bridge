package refresher

import (
	"testing"
	"time"
)

func TestQuarantine_BackoffGrows(t *testing.T) {
	q := &Quarantine{}
	key := "1101/TEST"

	// First fail: should be blocked for ~5m.
	q.Fail(key, false)
	if !q.Blocked(key) {
		t.Fatal("should be blocked after first fail")
	}

	// Second fail: should extend the window.
	q.Fail(key, false)
	if !q.Blocked(key) {
		t.Fatal("should still be blocked after second fail")
	}

	// OK clears it.
	q.OK(key)
	if q.Blocked(key) {
		t.Fatal("should not be blocked after OK")
	}
	if q.Len() != 0 {
		t.Fatalf("Len = %d, want 0 after OK", q.Len())
	}
}

func TestQuarantine_NotFoundJumpsTo24h(t *testing.T) {
	q := &Quarantine{}
	key := "1101/GONE"

	q.Fail(key, true)
	if !q.Blocked(key) {
		t.Fatal("should be blocked")
	}
	// The until time should be ~24 h from now, i.e. well beyond 23h from now.
	q.mu.Lock()
	until := q.until[key]
	q.mu.Unlock()
	if time.Until(until) < 23*time.Hour {
		t.Errorf("notFound backoff = %v, want ≥ 23h", time.Until(until))
	}
}

func TestQuarantine_OKResetsCounter(t *testing.T) {
	q := &Quarantine{}
	key := "1101/FLAKY"

	// Accumulate a few failures to grow the counter…
	q.Fail(key, false)
	q.Fail(key, false)
	q.Fail(key, false)

	// …then recover.
	q.OK(key)
	if q.Blocked(key) {
		t.Fatal("should not be blocked after OK")
	}

	// One more failure should give us the smallest backoff again (fails reset).
	q.Fail(key, false)
	q.mu.Lock()
	until := q.until[key]
	fails := q.fails[key]
	q.mu.Unlock()
	if fails != 1 {
		t.Errorf("fails counter = %d after OK+Fail, want 1", fails)
	}
	// Smallest backoff is 5m; anything above 10m means the counter wasn't reset.
	if time.Until(until) > 10*time.Minute {
		t.Errorf("backoff after reset = %v, want ≤ 10m (smallest tier)", time.Until(until))
	}
}

func TestQuarantine_NilIsSafe(t *testing.T) {
	var q *Quarantine
	if q.Blocked("any") {
		t.Fatal("nil Quarantine must never block")
	}
	q.Fail("any", false)
	q.OK("any")
	if q.Len() != 0 {
		t.Fatal("nil Quarantine Len must be 0")
	}
}
