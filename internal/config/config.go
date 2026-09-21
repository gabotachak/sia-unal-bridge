// Package config reads environment variables into a Config struct. No
// framework, no validation library: a handful of variables don't need one.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is what the RUNNING process needs. TEST_DATABASE_URL is
// deliberately absent: the tests that use it read it straight from the
// environment (store_test.go, integration_test.go) because they must decide
// whether to skip before any config is loaded. Carrying it here would be a
// field nobody reads, and an invitation to set it expecting an effect.
//
// It must point at a DIFFERENT DATABASE than DATABASE_URL. Those tests write
// for real, and pointing both at the same base put 28 fake-campus programs
// into production and left /v1/status reporting 1408 known plans where the
// real census is 1380. `make migrate-test` migrates it.
type Config struct {
	DatabaseURL    string
	Port           string
	SIABaseURL     string
	SIAPoolSize    int
	LogLevel       string
	Term           string  // SIA exposes only the current term — docs/API.md
	FetchCooldown  int     // Seconds to wait before allowing a force refresh
	RateLimitRPS   float64 // Sustained requests/sec allowed per client IP
	RateLimitBurst int     // Token bucket size per client IP

	// SIAAcquireTimeout bounds how long a request queues for a pool
	// connection (internal/sia/pool.go Acquire) before failing 503 busy.
	// Without it the wait is bounded only by the client's own patience —
	// c.Request.Context() has no deadline of its own. 0 disables the bound
	// (the old, unbounded behavior).
	SIAAcquireTimeout time.Duration
}

func Load() (Config, error) {
	poolSize, err := strconv.Atoi(getenv("SIA_POOL_SIZE", "4"))
	if err != nil {
		return Config{}, fmt.Errorf("SIA_POOL_SIZE: %w", err)
	}

	cooldown, err := strconv.Atoi(getenv("FETCH_COOLDOWN", "300"))
	if err != nil {
		return Config{}, fmt.Errorf("FETCH_COOLDOWN: %w", err)
	}
	// 0 disables the throttle on purpose; a negative would disable it too, but
	// silently and by accident, so it is rejected instead.
	if cooldown < 0 {
		return Config{}, fmt.Errorf("FETCH_COOLDOWN: must be >= 0, got %d", cooldown)
	}

	// 60/80, what production has run since August. The old 5/20 was sized to
	// shield the SIA pool from one client; the pool now shields itself (queue
	// with a deadline, background lane capped at half), and 5 rps per IP was
	// a campus-wide limit in practice — a whole campus leaves through a
	// handful of NAT addresses. The bucket is now only a brake on abuse.
	rateRPS, err := strconv.ParseFloat(getenv("RATE_LIMIT_RPS", "60"), 64)
	if err != nil || rateRPS <= 0 {
		return Config{}, fmt.Errorf("RATE_LIMIT_RPS: must be a positive number, got %q", os.Getenv("RATE_LIMIT_RPS"))
	}
	rateBurst, err := strconv.Atoi(getenv("RATE_LIMIT_BURST", "80"))
	if err != nil || rateBurst <= 0 {
		return Config{}, fmt.Errorf("RATE_LIMIT_BURST: must be a positive integer, got %q", os.Getenv("RATE_LIMIT_BURST"))
	}

	// Default 45s: pool=4, an op costs ~2-10s, so 45s rides out a real burst
	// (4 x 4.5-22 ops) without leaving a request queued so long a genuinely
	// wedged pool (SIA down, dead session) piles up goroutines for no
	// answer. Provisional like FETCH_COOLDOWN — tune with real 27/08 traffic.
	acquireTimeout, err := strconv.Atoi(getenv("SIA_ACQUIRE_TIMEOUT_SECONDS", "45"))
	if err != nil {
		return Config{}, fmt.Errorf("SIA_ACQUIRE_TIMEOUT_SECONDS: %w", err)
	}
	if acquireTimeout < 0 {
		return Config{}, fmt.Errorf("SIA_ACQUIRE_TIMEOUT_SECONDS: must be >= 0, got %d", acquireTimeout)
	}

	return Config{
		// sslmode=disable is deliberate: this default only ever applies to a
		// bare `go run ./cmd/bridge` against the compose Postgres, which
		// serves no TLS. Any real deployment sets DATABASE_URL explicitly and
		// should require TLS there. sslmode=require here would only make
		// `make run` and `make migrate` fail to connect.
		DatabaseURL:    getenv("DATABASE_URL", "postgres://sia:sia@localhost:15432/sia_bridge?sslmode=disable"),
		Port:           getenv("PORT", "8080"),
		SIABaseURL:     getenv("SIA_BASE_URL", "https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf"),
		SIAPoolSize:    poolSize,
		LogLevel:       getenv("LOG_LEVEL", "info"),
		Term:           getenv("SIA_TERM", "2026-2"), // NOT "TERM" — collides with the shell's terminal-type var
		FetchCooldown:  cooldown,
		RateLimitRPS:   rateRPS,
		RateLimitBurst: rateBurst,

		SIAAcquireTimeout: time.Duration(acquireTimeout) * time.Second,
	}, nil
}

// Refresh is what cmd/refresher needs on top of Config. It is loaded
// separately so a typo in a REFRESH_* variable can never keep the API from
// starting — the two processes share a database and an .env, not a lifecycle.
//
// The invariant that is not negotiable (docs/FASE-2.md): the API's pool plus
// the job's pool must stay ≤ 8, the measured ceiling of concurrent SIA
// sessions. SIA_POOL_SIZE is the API's and is never shared.
type Refresh struct {
	Enabled       bool
	Workers       int
	PoolSize      int
	MaxDuration   time.Duration
	RatePostsPS   float64
	CatalogMaxAge time.Duration
	DetailMaxAge  time.Duration
	HotSetSize    int
}

func LoadRefresh() (Refresh, error) {
	workers, err := strconv.Atoi(getenv("REFRESH_WORKERS", "2"))
	if err != nil || workers <= 0 {
		return Refresh{}, fmt.Errorf("REFRESH_WORKERS: must be a positive integer, got %q", os.Getenv("REFRESH_WORKERS"))
	}
	// More connections than workers buys nothing: the extra ones sit idle
	// while their keepalive still costs the SIA a POST every 45 s.
	poolSize, err := strconv.Atoi(getenv("REFRESH_POOL_SIZE", strconv.Itoa(workers)))
	if err != nil || poolSize <= 0 {
		return Refresh{}, fmt.Errorf("REFRESH_POOL_SIZE: must be a positive integer, got %q", os.Getenv("REFRESH_POOL_SIZE"))
	}
	maxDuration, err := time.ParseDuration(getenv("REFRESH_MAX_DURATION", "4h"))
	if err != nil {
		return Refresh{}, fmt.Errorf("REFRESH_MAX_DURATION: %w", err)
	}
	rate, err := strconv.ParseFloat(getenv("REFRESH_RATE_POSTS_PER_SEC", "6"), 64)
	if err != nil {
		return Refresh{}, fmt.Errorf("REFRESH_RATE_POSTS_PER_SEC: %w", err)
	}
	catalogMaxAge, err := time.ParseDuration(getenv("REFRESH_CATALOG_MAX_AGE", "168h"))
	if err != nil {
		return Refresh{}, fmt.Errorf("REFRESH_CATALOG_MAX_AGE: %w", err)
	}
	detailMaxAge, err := time.ParseDuration(getenv("REFRESH_DETAIL_MAX_AGE", "24h"))
	if err != nil {
		return Refresh{}, fmt.Errorf("REFRESH_DETAIL_MAX_AGE: %w", err)
	}
	hotSet, err := strconv.Atoi(getenv("REFRESH_HOT_SET_SIZE", "250"))
	if err != nil || hotSet <= 0 {
		return Refresh{}, fmt.Errorf("REFRESH_HOT_SET_SIZE: must be a positive integer, got %q", os.Getenv("REFRESH_HOT_SET_SIZE"))
	}

	return Refresh{
		Enabled:       getenv("REFRESH_ENABLED", "true") != "false",
		Workers:       workers,
		PoolSize:      poolSize,
		MaxDuration:   maxDuration,
		RatePostsPS:   rate,
		CatalogMaxAge: catalogMaxAge,
		DetailMaxAge:  detailMaxAge,
		HotSetSize:    hotSet,
	}, nil
}

func getenv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
