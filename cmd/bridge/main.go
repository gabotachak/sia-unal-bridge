// Command bridge is the only place that wires config, adapters, and server
// together. No logic lives here.
package main

import (
	"log/slog"
	"os"

	"github.com/gabotachak/sia-unal-bridge/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	slog.Info("sia-unal-bridge starting", "port", cfg.Port, "sia_pool_size", cfg.SIAPoolSize)
}
