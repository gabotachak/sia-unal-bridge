// Command refresher runs one sweep of the SIA catalog and exits. It is the
// wiring for internal/refresher — config → store → its OWN pool → Service →
// Refresher — and holds no logic, same rule as cmd/bridge.
//
// Its own pool, not the API's: a detail sweep occupies its connections for
// hours, and sharing would make every real user request compete with it and
// come back 503 busy — the error docs/API.md reserves for spikes, served for
// nine hours straight. The invariant is conexiones(api) + conexiones(job) ≤ 80.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
	"github.com/gabotachak/sia-unal-bridge/internal/config"
	"github.com/gabotachak/sia-unal-bridge/internal/refresher"
	"github.com/gabotachak/sia-unal-bridge/internal/sia"
	"github.com/gabotachak/sia-unal-bridge/internal/store"
)

func main() {
	mode := flag.String("mode", "", "reference | catalog | detail | seats")
	scope := flag.String("scope", "", "detail: global | plan · seats: hot")
	campus := flag.String("campus", "", "narrow the sweep to one sede, e.g. 1101")
	workers := flag.Int("workers", 0, "goroutines and connections (default REFRESH_WORKERS)")
	maxDuration := flag.Duration("max-duration", 0, "clock budget (default REFRESH_MAX_DURATION)")
	flag.Parse()

	if *mode == "" {
		slog.Error("refresher: --mode is required", "modes", "reference|catalog|detail|seats")
		os.Exit(2)
	}

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}
	rcfg, err := config.LoadRefresh()
	if err != nil {
		slog.Error("config: refresher", "err", err)
		os.Exit(1)
	}

	// The handbrake: one switch that turns every mode off without editing
	// cron. Exit 0 and a log, and — the part that matters — not a single
	// connection opened to the SIA.
	if !rcfg.Enabled {
		slog.Info("refresher: REFRESH_ENABLED=false, nothing to do", "mode", *mode)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("store", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	// One advisory lock per mode: if the previous run is still alive, this
	// one leaves with code 0 and a log instead of queueing up behind it and
	// doubling the load on the SIA.
	release, ok, err := st.TryLock(ctx, "refresh:"+*mode)
	if err != nil {
		slog.Error("refresher: advisory lock", "err", err)
		os.Exit(1)
	}
	if !ok {
		slog.Info("refresher: another sweep of this mode is still running, skipping", "mode", *mode)
		return
	}
	defer release()

	opts := refresher.Options{
		Mode: *mode, Scope: *scope, Campus: *campus,
		Workers:         pick(*workers, rcfg.Workers),
		MaxDuration:     pickDuration(*maxDuration, rcfg.MaxDuration),
		RatePostsPerSec: rcfg.RatePostsPS,
		CatalogMaxAge:   rcfg.CatalogMaxAge,
		DetailMaxAge:    rcfg.DetailMaxAge,
		HotSetSize:      rcfg.HotSetSize,
	}

	poolSize := rcfg.PoolSize
	if opts.Workers > poolSize {
		poolSize = opts.Workers
	}
	slog.Info("refresher: bootstrapping its own SIA pool", "size", poolSize, "api_pool", cfg.SIAPoolSize)
	if poolSize+cfg.SIAPoolSize > maxTotalConnections {
		slog.Warn("refresher: over the measured ceiling of concurrent SIA sessions; real requests may get 503 busy",
			"refresher", poolSize, "api", cfg.SIAPoolSize, "ceiling", maxTotalConnections)
	}
	pool, err := sia.NewPool(ctx, cfg.SIABaseURL, poolSize)
	if err != nil {
		slog.Error("sia pool", "err", err)
		os.Exit(1)
	}
	// Same reason as cmd/bridge: the session dies after ~4.2 min idle, and a
	// sweep has gaps — long transactions, waits on the rate limiter.
	go pool.Keepalive(ctx)

	svc := catalog.NewService(st, sia.NewSource(pool), cfg.Term)

	rep, runErr := refresher.Run(ctx, svc, opts, pool.Stats)
	if runErr != nil {
		slog.Error("refresher: sweep failed", "err", runErr)
		os.Exit(1)
	}
	// A sweep cut short by its budget or by a signal is a normal outcome:
	// resuming is just running again, because the checkpoint is the freshness
	// marks in the database.
	if rep != nil && errors.Is(ctx.Err(), context.Canceled) {
		slog.Info("refresher: interrupted, will resume where it left off", "unvisited", rep.Unvisited())
	}
}

// maxTotalConnections is the measured optimum: 80 concurrent SIA sessions
// run clean — no errors, no throttling, flat p50 latency — and 88 already
// shows ~4.5% failures (docs/OPEN-QUESTIONS.md §5). It is the real edge of
// the server, shared between the two processes, which is why crossing it is
// a warning here and not a silent success.
const maxTotalConnections = 80

func pick(flagVal, cfgVal int) int {
	if flagVal > 0 {
		return flagVal
	}
	return cfgVal
}

func pickDuration(flagVal, cfgVal time.Duration) time.Duration {
	if flagVal > 0 {
		return flagVal
	}
	return cfgVal
}
