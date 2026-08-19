package refresher

import (
	"fmt"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// Circuit breaker thresholds (docs/FASE-2.md, paso 5). Five programs failing
// in a row, or a fifth of the sweep failing, is the SIA having changed under
// us — not bad luck. breakerMinSample keeps a three-program sweep from
// tripping on its first failure.
const (
	maxConsecutiveFailures = 5
	breakerErrorRate       = 0.20
	breakerMinSample       = 20
)

// maxReportedErrors caps the aggregated error list: a sweep that fails on
// 1380 programs must not turn its report into a 1380-line log line. The
// counters stay exact.
const maxReportedErrors = 20

// How a sweep ended. Only ReasonCircuitBreaker and ReasonError are failures;
// deadline and signal are normal, resumable outcomes — reanudar es volver a
// correr.
const (
	ReasonDone           = "done"
	ReasonDeadline       = "deadline"
	ReasonSignal         = "signal"
	ReasonCircuitBreaker = "circuit_breaker"
	ReasonError          = "error"
)

// Report is what one sweep did. Programs add up without residue:
//
//	total = ok + skipped + failed + unvisited
//
// and unvisited is 0 exactly when EndedReason is "done". Skipped means "was
// already fresh", which on a second consecutive run is every program — that
// is the idempotence the freshness marks buy.
type Report struct {
	RunID      int64
	Mode       string
	Scope      string
	StartedAt  time.Time
	FinishedAt time.Time

	ProgramsTotal   int
	ProgramsOK      int
	ProgramsSkipped int
	ProgramsFailed  int
	CoursesOK       int

	Posts int64
	Bytes int64

	EndedReason string
	Errors      []error

	// ErrorsDropped counts what maxReportedErrors left out.
	ErrorsDropped int
}

func (r *Report) addError(err error) {
	if len(r.Errors) >= maxReportedErrors {
		r.ErrorsDropped++
		return
	}
	r.Errors = append(r.Errors, err)
}

// Unvisited is the residue: programs enqueued that the budget never reached.
func (r *Report) Unvisited() int {
	return r.ProgramsTotal - r.ProgramsOK - r.ProgramsSkipped - r.ProgramsFailed
}

func (r *Report) Duration() time.Duration { return r.FinishedAt.Sub(r.StartedAt) }

func (r *Report) toRun() catalog.RefreshRun {
	finished := r.FinishedAt
	return catalog.RefreshRun{
		ID: r.RunID, Mode: r.Mode, Scope: r.Scope,
		StartedAt: r.StartedAt, FinishedAt: &finished,
		ProgramsOK: r.ProgramsOK, ProgramsFailed: r.ProgramsFailed,
		ProgramsSkipped: r.ProgramsSkipped, CoursesOK: r.CoursesOK,
		Posts: r.Posts, Bytes: r.Bytes, EndedReason: r.EndedReason,
	}
}

func (r *Report) logArgs() []any {
	args := []any{
		"reason", r.EndedReason,
		"duration", r.Duration().Round(time.Second).String(),
		"programs_total", r.ProgramsTotal,
		"programs_ok", r.ProgramsOK,
		"programs_skipped", r.ProgramsSkipped,
		"programs_failed", r.ProgramsFailed,
		"programs_unvisited", r.Unvisited(),
		"courses_ok", r.CoursesOK,
		"posts", r.Posts,
		"mb", fmt.Sprintf("%.1f", float64(r.Bytes)/(1024*1024)),
	}
	if r.ErrorsDropped > 0 {
		args = append(args, "errors_dropped", r.ErrorsDropped)
	}
	return args
}
