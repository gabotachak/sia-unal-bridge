package refresher

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
	"github.com/gabotachak/sia-unal-bridge/internal/config"
)

// ModeLive is the continuous daemon mode. Unlike the cron modes (reference,
// catalog, detail, seats), it does not exit: it loops around Run() until its
// context is cancelled, recalculating the work list on every cycle from
// SeatsByDebt so priority always reflects the current state of the database.
const ModeLive = "live"

// Loop runs cycles until ctx is done. Each cycle is a normal seats sweep whose
// work list comes from SeatsByDebt (ScopeDebt). The checkpoint is the freshness
// marks in the database, so stopping is always clean: restarting picks up
// exactly where the work is.
//
// Loop returns nil on a clean shutdown (context cancelled); a non-nil error
// means the loop itself could not start (e.g. the catalog service is down).
func Loop(
	ctx context.Context,
	svc *catalog.Service,
	rcfg config.Refresh,
	baseOpts Options,
	stats func() (int64, int64),
) error {
	if !rcfg.LiveEnabled {
		slog.Info("refresher: REFRESH_LIVE_ENABLED=false, live mode not started")
		return nil
	}

	q := &Quarantine{}
	recheckQueue := &recheckQueue{maxPerHour: rcfg.LiveRechecksPerHour}

	opts := baseOpts
	opts.Mode = ModeSeats
	opts.Scope = ScopeDebt
	opts.Quarantine = q
	opts.LiveHot = rcfg.LiveHotInterval
	opts.LiveWarm = rcfg.LiveWarmInterval
	opts.LiveCold = rcfg.LiveColdInterval
	opts.LiveBatch = rcfg.LiveBatch
	opts.MaxDuration = rcfg.LiveHotInterval // one cycle = one hot interval

	log := slog.With("mode", ModeLive)
	log.Info("refresher: live loop starting",
		"workers", opts.Workers,
		"hot", rcfg.LiveHotInterval,
		"warm", rcfg.LiveWarmInterval,
		"cold", rcfg.LiveColdInterval,
		"batch", rcfg.LiveBatch,
		"night_factor", rcfg.LiveNightFactor,
		"rechecks_per_hour", rcfg.LiveRechecksPerHour,
	)

	for ctx.Err() == nil {
		// Night-time slowdown: outside 06:00-22:00 local time, scale the rate.
		cycleOpts := opts
		if isNight() {
			cycleOpts.RatePostsPerSec = opts.RatePostsPerSec * rcfg.LiveNightFactor
		}

		rep, err := Run(ctx, svc, cycleOpts, stats)

		// Collect ErrNotFound courses for catalog re-reads.
		if rep != nil && rep.NotFound > 0 {
			recheckQueue.drain(ctx, svc, log)
		}

		if err != nil {
			// Circuit breaker or unexpected error: back off 5 min and retry.
			// Never os.Exit: a daemon that dies at 3 a.m. stays dead.
			log.Error("refresher: live cycle failed, backing off 5m", "err", err)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(5 * time.Minute):
			}
			continue
		}

		if rep != nil && rep.ProgramsTotal == 0 {
			// Everything is within its freshness target: nothing to do.
			// Sleep briefly to avoid a tight empty loop.
			log.Debug("refresher: live cycle: all courses fresh, sleeping 60s")
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(60 * time.Second):
			}
		}
	}

	log.Info("refresher: live loop stopped cleanly")
	return nil
}

// recheckQueue collects program IDs that need their catalog re-read because
// a course in them came back ErrNotFound. It respects a per-hour cap and
// deduplicates: the same plan is only re-read once per hour no matter how
// many of its courses 404ed.
//
// The catalog re-read is svc.Catalog(ctx, program, 0): the same use case the
// API calls, which already reconciles and is already protected by
// suspectShrunkCatalog (0 rows or >50% shrinkage => error, not a wipe).
type recheckQueue struct {
	mu         sync.Mutex
	maxPerHour int
	seen       map[int64]time.Time // program_id → time of last recheck
	pending    []catalog.Program
}

func (rq *recheckQueue) enqueue(p catalog.Program) {
	rq.mu.Lock()
	defer rq.mu.Unlock()
	if rq.seen == nil {
		rq.seen = make(map[int64]time.Time)
	}
	if t, ok := rq.seen[p.ID]; ok && time.Since(t) < time.Hour {
		return // already re-read in this hour
	}
	rq.pending = append(rq.pending, p)
}

func (rq *recheckQueue) drain(ctx context.Context, svc *catalog.Service, log *slog.Logger) {
	rq.mu.Lock()
	pending := rq.pending
	rq.pending = nil
	rq.mu.Unlock()

	done := 0
	for _, p := range pending {
		if ctx.Err() != nil || done >= rq.maxPerHour {
			break
		}
		rq.mu.Lock()
		rq.seen[p.ID] = time.Now()
		rq.mu.Unlock()

		log.Info("refresher: live: re-reading catalog after ErrNotFound",
			"program_id", p.ID, "program", p.Code, "campus", p.CampusCode)
		// Force-fetch: maxAge=0 means "always go to the SIA".
		if _, _, err := svc.Catalog(ctx, p, 0); err != nil {
			log.Warn("refresher: live: catalog re-read failed",
				"program_id", p.ID, "err", err)
		}
		done++
	}
}

// isNight reports whether the current local time is outside the 06:00–22:00
// window. The factor is applied by the caller; this just answers the question.
func isNight() bool {
	h := time.Now().Hour()
	return h < 6 || h >= 22
}
