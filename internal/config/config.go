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
type Config struct {
	DatabaseURL   string
	Port          string
	SIABaseURL    string
	SIAPoolSize   int
	LogLevel      string
	Term          string // SIA exposes only the current term — docs/API.md
	FetchCooldown int    // Seconds to wait before allowing a force refresh
}

func Load() (Config, error) {
	poolSize, err := strconv.Atoi(getenv("SIA_POOL_SIZE", "4"))
	if err != nil {
		return Config{}, fmt.Errorf("SIA_POOL_SIZE: %w", err)
	}

	cooldown, err := strconv.Atoi(getenv("FETCH_COOLDOWN", "60"))
	if err != nil {
		return Config{}, fmt.Errorf("FETCH_COOLDOWN: %w", err)
	}
	// 0 disables the throttle on purpose; a negative would disable it too, but
	// silently and by accident, so it is rejected instead.
	if cooldown < 0 {
		return Config{}, fmt.Errorf("FETCH_COOLDOWN: must be >= 0, got %d", cooldown)
	}

	return Config{
		// sslmode=disable is deliberate: this default only ever applies to a
		// bare `go run ./cmd/bridge` against the compose Postgres, which
		// serves no TLS. Any real deployment sets DATABASE_URL explicitly and
		// should require TLS there. sslmode=require here would only make
		// `make run` and `make migrate` fail to connect.
		DatabaseURL:   getenv("DATABASE_URL", "postgres://sia:sia@localhost:15432/sia_bridge?sslmode=disable"),
		Port:          getenv("PORT", "8080"),
		SIABaseURL:    getenv("SIA_BASE_URL", "https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf"),
		SIAPoolSize:   poolSize,
		LogLevel:      getenv("LOG_LEVEL", "info"),
		Term:          getenv("SIA_TERM", "2026-2"), // NOT "TERM" — collides with the shell's terminal-type var
		FetchCooldown: cooldown,
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
