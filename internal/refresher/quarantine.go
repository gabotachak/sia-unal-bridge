package refresher

import (
	"sync"
	"time"
)

// Quarantine keeps courses that just failed out of the rotation for a while.
// It lives in MEMORY on purpose: a SIA failure heals on its own, and a
// process restart is the cheapest way to give everything another chance. A
// column would be a migration, a state that outlives the bug that caused it,
// and one more thing that can drift from the data.
//
// Two cases it exists for, both measured:
//   - GOTCHAS §39: courses that CRASH the SIA (2011302, 2018602 in Bogotá).
//     Without this, the live loop would visit them 288 times a day and each
//     visit takes the connection down with the rest of the plan's batch.
//   - A course the SIA answers ErrNotFound for. Retrying cannot help; what
//     helps is re-reading the plan's catalog (see the live loop's recheck
//     queue). A notFound failure jumps straight to 24 h backoff so the recheck
//     has time to run and either confirm the course is gone (in which case it
//     disappears from SeatsByDebt's result because disabled_at IS NULL filters
//     it) or clear it for the next cycle.
type Quarantine struct {
	mu    sync.Mutex
	until map[string]time.Time
	fails map[string]int
}

const (
	quarantineBase = 5 * time.Minute
	quarantineMax  = 24 * time.Hour
)

// Blocked reports whether key is currently in quarantine and should be skipped.
func (q *Quarantine) Blocked(key string) bool {
	if q == nil {
		return false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	t, ok := q.until[key]
	return ok && time.Now().Before(t)
}

// Fail records one failure for key and extends its quarantine with exponential
// backoff. notFound=true jumps straight to 24 h: the only remedy is a catalog
// re-read, and retrying the detail every 5 min until that happens just wastes
// budget.
func (q *Quarantine) Fail(key string, notFound bool) {
	if q == nil {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.until == nil {
		q.until = make(map[string]time.Time)
		q.fails = make(map[string]int)
	}
	if notFound {
		q.fails[key] = 0 // irrelevant, jump to max
		q.until[key] = time.Now().Add(quarantineMax)
		return
	}
	n := q.fails[key] + 1
	q.fails[key] = n
	// 5m → 10m → 20m → 40m → 80m → 160m → 320m → 24h (cap)
	d := quarantineBase * (1 << uint(n-1))
	if d > quarantineMax {
		d = quarantineMax
	}
	q.until[key] = time.Now().Add(d)
}

// OK records a successful fetch for key, clearing its quarantine and backoff
// counter. A course that the SIA eventually answers correctly should never be
// stuck in backoff.
func (q *Quarantine) OK(key string) {
	if q == nil {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	delete(q.until, key)
	delete(q.fails, key)
}

// Len returns the number of keys currently blocked (for observability).
func (q *Quarantine) Len() int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	now := time.Now()
	n := 0
	for _, t := range q.until {
		if now.Before(t) {
			n++
		}
	}
	return n
}
