package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
)

func requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		var b [8]byte
		_, _ = rand.Read(b[:])
		id := hex.EncodeToString(b[:])
		c.Set("request_id", id)
		c.Header("X-Request-Id", id)
		c.Next()
	}
}

func requestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		slog.Info("http",
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"status", c.Writer.Status(),
			"dur_ms", time.Since(start).Milliseconds(),
			"request_id", c.GetString("request_id"),
		)
	}
}

// requestTimeout bounds c.Request.Context(), which otherwise has no deadline
// of its own — a request queued on sia.Pool.Acquire (internal/sia/pool.go)
// would wait until the CLIENT gives up, not the server. A cache hit finishes
// in milliseconds regardless of d, so this is safe to apply globally; only a
// pool-contended or cold-miss request can ever feel it. d<=0 disables it.
func requestTimeout(d time.Duration) gin.HandlerFunc {
	if d <= 0 {
		return func(c *gin.Context) { c.Next() }
	}
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), d)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	}
}

func secureHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("X-XSS-Protection", "1; mode=block")
		c.Header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		c.Header("Content-Security-Policy", "default-src 'self'")
		c.Header("Referrer-Policy", "strict-origin-when-cross-origin")
		c.Next()
	}
}
