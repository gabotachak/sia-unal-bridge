// Package refresher is the driving adapter that fills the cache before a
// client pays for the miss. It enters through the same use cases as httpapi
// (catalog.Service) and lets fase 1's read-through do the work: navigate,
// parse, persist, stamp freshness.
//
// It is NOT a second path into Postgres. If it wrote on its own there would
// be two implementations of the catalog upsert, and the second one would
// drift from the first at the first bug fix. The only difference between a
// fetch made by this job and one made by a client is WHO asked for it.
//
// Consequence: any persistence bug this job exposes is a bug the API already
// had. That is a feature. See docs/FASE-2.md.
package refresher

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// The four sweeps. Each has its own cadence and its own cost — the catalog
// sweep is ~14× cheaper than the detail one, so they are never run together
// (docs/FASE-2.md "Cadencia").
const (
	ModeReference = "reference"
	ModeCatalog   = "catalog"
	ModeDetail    = "detail"
	ModeSeats     = "seats"
)

// Detail scopes: global covers every course once from whatever plan already
// lists it (~3 h, and the section rows it writes — profesor, horario, cupos —
// are valid for every plan); plan covers each plan's visibility separately
// (~38 h serial, once per semester).
const (
	ScopeGlobal = "global"
	ScopePlan   = "plan"
	ScopeHot    = "hot"
)

// progressLogInterval throttles the "refresher: progress" line — enough to
// watch a manual run without flooding the log on an automatic one.
const progressLogInterval = 10 * time.Second

type Options struct {
	Mode  string
	Scope string

	// Workers is goroutines AND connections: more goroutines than
	// connections just block in Pool.Acquire, which is the real semaphore.
	Workers int

	// MaxDuration is the clock budget. It must always be smaller than the
	// cron interval; when it runs out the sweep stops clean and tomorrow's
	// run continues where this one left off, because the checkpoint is the
	// freshness marks in the database, not a cursor.
	MaxDuration time.Duration

	// RatePostsPerSec is a ceiling, not throughput control: 2 workers yield
	// ~4 POSTs/s on their own and never reach it. 0 disables it.
	RatePostsPerSec float64

	CatalogMaxAge time.Duration
	DetailMaxAge  time.Duration
	HotSetSize    int

	// Campus narrows a sweep to one sede ('1101'). Empty means every sede
	// the directory cache knows.
	Campus string
}

func (o *Options) applyDefaults() {
	if o.Scope == "" && o.Mode == ModeDetail {
		o.Scope = ScopeGlobal
	}
	if o.Scope == "" && o.Mode == ModeSeats {
		o.Scope = ScopeHot
	}
	if o.Workers <= 0 {
		o.Workers = 2
	}
	if o.MaxDuration <= 0 {
		o.MaxDuration = 4 * time.Hour
	}
	if o.CatalogMaxAge <= 0 {
		o.CatalogMaxAge = catalog.FreshnessCatalog
	}
	if o.DetailMaxAge <= 0 {
		o.DetailMaxAge = catalog.FreshnessDetail
	}
	if o.HotSetSize <= 0 {
		o.HotSetSize = 250
	}
}

// refresher is one sweep in flight.
type refresher struct {
	svc  *catalog.Service
	opts Options
	log  *slog.Logger
	lim  *limiter

	// abort is the run context's cancel: the circuit breaker's only power.
	abort func()

	mu       sync.Mutex
	rep      *Report
	lastProg time.Time // throttle for the progress log in record()
	fails  int  // consecutive program failures
	broken bool // circuit breaker tripped
}

// Run executes one sweep and returns its Report. The returned error is
// non-nil only for outcomes an operator must notice — a tripped circuit
// breaker or a failure to even start; a sweep cut short by its own budget or
// by SIGTERM is a normal, resumable outcome and returns nil.
//
// stats reports the POSTs and bytes the process has spent (sia.Pool.Stats);
// nil is fine, the run is then recorded without traffic figures.
func Run(ctx context.Context, svc *catalog.Service, opts Options, stats func() (int64, int64)) (*Report, error) {
	opts.applyDefaults()

	runID, err := svc.StartRun(ctx, opts.Mode, opts.Scope)
	if err != nil {
		return nil, err
	}
	log := slog.With("run_id", runID, "mode", opts.Mode, "scope", opts.Scope)
	log.Info("refresher: sweep starting", "workers", opts.Workers, "max_duration", opts.MaxDuration)

	runCtx, cancel := context.WithTimeout(ctx, opts.MaxDuration)
	defer cancel()

	lim := newLimiter(opts.RatePostsPerSec)
	defer lim.close()

	r := &refresher{
		svc: svc, opts: opts, log: log, lim: lim, abort: cancel,
		rep: &Report{RunID: runID, Mode: opts.Mode, Scope: opts.Scope, StartedAt: time.Now()},
	}

	sweepErr := r.dispatch(runCtx)

	rep := r.rep
	rep.FinishedAt = time.Now()
	rep.EndedReason = r.endedReason(ctx, runCtx, sweepErr)
	if stats != nil {
		rep.Posts, rep.Bytes = stats()
	}

	// Detached from ctx on purpose: the most interesting run to record is
	// precisely the one that was cancelled.
	fctx, fcancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer fcancel()
	if err := svc.FinishRun(fctx, rep.toRun()); err != nil {
		log.Error("refresher: could not record the run", "err", err)
	}

	log.Info("refresher: sweep finished", rep.logArgs()...)
	for _, e := range rep.Errors {
		log.Warn("refresher: error during sweep", "err", e)
	}

	switch {
	case r.broken:
		return rep, fmt.Errorf("refresher: circuit breaker: %d consecutive failures, %d/%d failed",
			r.fails, rep.ProgramsFailed, rep.ProgramsTotal)
	case sweepErr != nil && !errors.Is(sweepErr, context.Canceled) && !errors.Is(sweepErr, context.DeadlineExceeded):
		return rep, sweepErr
	}
	return rep, nil
}

func (r *refresher) dispatch(ctx context.Context) error {
	switch r.opts.Mode {
	case ModeReference:
		return r.reference(ctx)
	case ModeCatalog:
		return r.catalogSweep(ctx)
	case ModeDetail:
		return r.detail(ctx)
	case ModeSeats:
		return r.seats(ctx)
	default:
		return fmt.Errorf("refresher: unknown mode %q", r.opts.Mode)
	}
}

func (r *refresher) endedReason(parent, run context.Context, err error) string {
	switch {
	case r.broken:
		return ReasonCircuitBreaker
	case parent.Err() != nil:
		return ReasonSignal
	case errors.Is(run.Err(), context.DeadlineExceeded):
		return ReasonDeadline
	case err != nil:
		return ReasonError
	default:
		return ReasonDone
	}
}

// eachProgram runs fn over programs with at most Workers of them in flight.
//
// errgroup is used ONLY for SetLimit. Its normal behaviour — cancel
// everything on the first error — is wrong here: a no-op on one program
// cannot kill a nine-hour sweep, so fn's wrapper always returns nil and the
// errors are accumulated in the Report instead. The only thing that stops a
// sweep early is the run context (deadline, signal, circuit breaker).
//
// One goroutine per PROGRAM, never per course: the connection stays parked on
// the program, and splitting its 98 courses across workers re-parks on every
// one and reopens GOTCHAS §30/§31/§33.
func (r *refresher) eachProgram(ctx context.Context, programs []catalog.Program,
	fn func(context.Context, catalog.Program) (courses int, skipped bool, err error)) error {
	r.mu.Lock()
	r.rep.ProgramsTotal += len(programs)
	r.mu.Unlock()

	var g errgroup.Group
	g.SetLimit(r.opts.Workers)
	for _, p := range programs {
		if ctx.Err() != nil {
			break
		}
		program := p
		g.Go(func() error {
			if ctx.Err() != nil {
				return nil
			}
			courses, skipped, err := fn(ctx, program)
			r.record(program.CampusCode+"/"+program.Code, courses, skipped, err)
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return err
	}
	return ctx.Err()
}

// record folds one unit's outcome into the Report and runs the circuit
// breaker: 5 consecutive failures, or >20% of a sweep failing, is not bad
// luck — it is the SIA having changed under us, and continuing would write
// plausible garbage 135 000 times (docs/FASE-2.md, paso 5).
//
// unit is what failed, for the log: "1101/2A74" for a program, "1101/pregrado"
// for a sede's directory.
func (r *refresher) record(unit string, courses int, skipped bool, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.rep.CoursesOK += courses
	// Out of budget is not a failure: the program stays UNVISITED (total
	// minus the three buckets), which is the honest shape of "tomorrow's run
	// continues here".
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return
	}
	switch {
	case err != nil:
		r.rep.ProgramsFailed++
		r.fails++
		r.rep.addError(fmt.Errorf("%s: %w", unit, err))
		r.log.Warn("refresher: unit failed", "unit", unit, "err", err)
	case skipped:
		r.rep.ProgramsSkipped++
		r.fails = 0
	default:
		r.rep.ProgramsOK++
		r.fails = 0
	}

	visited := r.rep.ProgramsOK + r.rep.ProgramsFailed + r.rep.ProgramsSkipped
	if now := time.Now(); now.Sub(r.lastProg) >= progressLogInterval {
		r.lastProg = now
		elapsed := now.Sub(r.rep.StartedAt)
		eta := "?"
		if visited > 0 {
			remaining := r.rep.ProgramsTotal - visited
			perProgram := elapsed / time.Duration(visited)
			eta = (perProgram * time.Duration(remaining)).Round(time.Second).String()
		}
		r.log.Info("refresher: progress",
			"programs", fmt.Sprintf("%d/%d", visited, r.rep.ProgramsTotal),
			"courses_ok", r.rep.CoursesOK, "failed", r.rep.ProgramsFailed,
			"elapsed", elapsed.Round(time.Second), "eta", eta)
	}
	tooManyInARow := r.fails >= maxConsecutiveFailures
	tooManyOverall := visited >= breakerMinSample &&
		float64(r.rep.ProgramsFailed) > breakerErrorRate*float64(visited)
	if !r.broken && (tooManyInARow || tooManyOverall) {
		r.broken = true
		r.log.Error("refresher: circuit breaker tripped, aborting sweep",
			"consecutive_failures", r.fails, "failed", r.rep.ProgramsFailed, "visited", visited)
		r.abort()
	}
}

// limiter is one shared ticker, not a token bucket, so unused capacity does
// not accumulate into a burst that would compete with the API for the pool.
// It costs each operation up to 1/rate of latency, which at the default 6/s
// is ~167 ms against operations that take ~1 s.
type limiter struct {
	ticker *time.Ticker
}

func newLimiter(perSec float64) *limiter {
	if perSec <= 0 {
		return nil
	}
	return &limiter{ticker: time.NewTicker(time.Duration(float64(time.Second) / perSec))}
}

func (l *limiter) close() {
	if l != nil {
		l.ticker.Stop()
	}
}

// wait blocks until posts POSTs' worth of budget is available. The count is
// an estimate on purpose — a course detail is ~2 POSTs (the cb1 of findRow
// plus the detail itself) — because the cheapest honest accounting is at the
// operation, not inside the adapter.
func (l *limiter) wait(ctx context.Context, posts int) error {
	if l == nil {
		return nil
	}
	for i := 0; i < posts; i++ {
		select {
		case <-l.ticker.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
