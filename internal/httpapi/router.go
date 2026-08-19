// Package httpapi is the driving adapter: gin router translating HTTP to
// catalog use cases and domain errors to status codes, per docs/API.md.
package httpapi

import (
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// api holds the one dependency every handler needs. c.Request.Context()
// crosses into catalog, never *gin.Context itself — LAYOUT.md's hexagon
// rule for this adapter.
type api struct {
	svc *catalog.Service
	// cooldown is the floor on how often a client may force a SIA fetch for
	// one course. Zero disables the throttle entirely. See cooldown.go.
	cooldown time.Duration
	// buildVersion/buildCommit come from -ldflags at build time (cmd/bridge/main.go).
	buildVersion string
	buildCommit  string
}

// NewRouter builds the /v1 router. gin.New(), not Default(): the logger is
// slog via requestLogger, not gin's own stdout writer (docs/LAYOUT.md
// "Gin: cuatro reglas").
func NewRouter(svc *catalog.Service, cooldown int, rateRPS float64, rateBurst, acquireTimeoutSeconds int, version, commit string) *gin.Engine {
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}
	a := &api{svc: svc, cooldown: time.Duration(cooldown) * time.Second, buildVersion: version, buildCommit: commit}

	r := gin.New()
	// Caddy is the only thing allowed to reach this port (docker-compose.yml
	// binds it to 127.0.0.1) and sits either on loopback or Docker's bridge
	// network, so its X-Forwarded-For is trusted from those ranges only —
	// gin's default trusts everyone, which would let a request that DID reach
	// this port forge its own IP and dodge the per-IP rate limiter below.
	// Verify once per deployment: log c.ClientIP() on a real request and
	// confirm it's the actual client, not Caddy's own address — Docker's
	// port-forwarding implementation decides which subnet Caddy appears from.
	_ = r.SetTrustedProxies([]string{"127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"})
	limiter := newRateLimiter(rate.Limit(rateRPS), rateBurst)
	r.Use(gin.Recovery(), requestID(), requestLogger(), secureHeaders(), limiter.middleware(),
		requestTimeout(time.Duration(acquireTimeoutSeconds)*time.Second))

	v1 := r.Group("/v1")
	{
		v1.GET("/healthz", a.healthz)
		v1.GET("/status", a.status)
		v1.GET("/version", a.version)

		// The contract, embedded in the binary, plus a Swagger UI over it.
		v1.GET("/openapi.yaml", a.openapi)
		v1.GET("/docs", a.swaggerUI)
		v1.GET("/docs/swagger-ui.css", a.swaggerUICSS)
		v1.GET("/docs/swagger-ui-bundle.js", a.swaggerUIBundleJS)
		v1.GET("/docs/init.js", a.swaggerUIInitJS)

		// Not campus-scoped: these two ARE the list of campuses and the
		// list of levels.
		v1.GET("/levels", a.levels)
		v1.GET("/campuses", a.campuses)

		// Everything else hangs off a sede, because everything else IS
		// scoped to one. program.code repeats across sedes (136 of 852,
		// GOTCHAS §26) and course.code is keyed by (campus_code, code) in
		// the schema, so a campus-less URL names nothing exactly. It used
		// to be an optional ?campus= that defaulted to Bogotá; a required
		// path segment is the honest shape of a required datum.
		campus := v1.Group("/campuses/:campus")
		{
			campus.GET("/faculties", a.faculties)

			programs := campus.Group("/programs")
			{
				programs.GET("", a.listPrograms)
				programs.GET("/:program", a.getProgram)

				courses := programs.Group("/:program/courses")
				{
					courses.GET("", a.programCourses)
					courses.GET("/:code", a.courseDetail)

					sections := courses.Group("/:code/sections")
					{
						sections.GET("", a.courseSections)
						sections.GET("/:key", a.courseSection)
						sections.GET("/:key/seats", a.sectionSeats)
					}
				}
			}

			// The shortcut: a course code without knowing its program. Same
			// campus scoping, because course is keyed by (campus_code, code).
			shortcuts := campus.Group("/courses")
			{
				shortcuts.GET("", a.courseSearch)
				shortcuts.GET("/:code", a.courseShortcut)
			}
		}
	}
	return r
}
