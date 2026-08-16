// Command bridge is the only place that wires config, adapters, and server
// together. No logic lives here.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
	"github.com/gabotachak/sia-unal-bridge/internal/config"
	"github.com/gabotachak/sia-unal-bridge/internal/httpapi"
	"github.com/gabotachak/sia-unal-bridge/internal/sia"
	"github.com/gabotachak/sia-unal-bridge/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("store", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	slog.Info("bootstrapping SIA connection pool", "size", cfg.SIAPoolSize)
	pool, err := sia.NewPool(ctx, cfg.SIABaseURL, cfg.SIAPoolSize)
	if err != nil {
		slog.Error("sia pool", "err", err)
		os.Exit(1)
	}
	go pool.Keepalive(ctx)

	src := sia.NewSource(pool)
	svc := catalog.NewService(st, src, cfg.Term)

	router := httpapi.NewRouter(svc)
	srv := &http.Server{Addr: ":" + cfg.Port, Handler: router}

	// signal.NotifyContext intercepts SIGINT/SIGTERM and stops the process
	// from dying on its own — the only thing that now honors those signals
	// is srv.Shutdown below. Skipping this wiring leaves the process
	// unkillable by a plain `kill` (learned the hard way: a stale `go run`
	// instance survived three SIGTERMs during manual testing).
	errCh := make(chan error, 1)
	go func() {
		slog.Info("sia-unal-bridge starting", "port", cfg.Port, "sia_pool_size", cfg.SIAPoolSize, "term", cfg.Term)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		slog.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("http server shutdown", "err", err)
			os.Exit(1)
		}
	case err := <-errCh:
		slog.Error("http server", "err", err)
		os.Exit(1)
	}
}
