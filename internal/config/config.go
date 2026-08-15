// Package config reads environment variables into a Config struct. No
// framework, no validation library: ~6 variables don't need one.
package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	DatabaseURL     string
	TestDatabaseURL string
	Port            string
	SIABaseURL      string
	SIAPoolSize     int
	LogLevel        string
}

func Load() (Config, error) {
	poolSize, err := strconv.Atoi(getenv("SIA_POOL_SIZE", "4"))
	if err != nil {
		return Config{}, fmt.Errorf("SIA_POOL_SIZE: %w", err)
	}

	return Config{
		DatabaseURL:     getenv("DATABASE_URL", "postgres://sia:sia@localhost:5432/sia_bridge"),
		TestDatabaseURL: os.Getenv("TEST_DATABASE_URL"),
		Port:            getenv("PORT", "8080"),
		SIABaseURL:      getenv("SIA_BASE_URL", "https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf"),
		SIAPoolSize:     poolSize,
		LogLevel:        getenv("LOG_LEVEL", "info"),
	}, nil
}

func getenv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
