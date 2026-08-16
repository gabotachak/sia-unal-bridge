// Package config reads environment variables into a Config struct. No
// framework, no validation library: a handful of variables don't need one.
package config

import (
	"fmt"
	"os"
	"strconv"
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
	
	cooldownStr := getenv("FETCH_COOLDOWN", "60")
	cooldown, err := strconv.Atoi(cooldownStr)
	if err != nil {
		return Config{}, fmt.Errorf("FETCH_COOLDOWN: %w", err)
	}

	return Config{
		DatabaseURL:   getenv("DATABASE_URL", "postgres://sia:sia@localhost:5432/sia_bridge?sslmode=require"),
		Port:          getenv("PORT", "8080"),
		SIABaseURL:    getenv("SIA_BASE_URL", "https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf"),
		SIAPoolSize:   poolSize,
		LogLevel:      getenv("LOG_LEVEL", "info"),
		Term:          getenv("SIA_TERM", "2026-2"), // NOT "TERM" — collides with the shell's terminal-type var
		FetchCooldown: cooldown,
	}, nil
}

func getenv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
