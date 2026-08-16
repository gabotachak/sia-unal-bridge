// Package httpapi is the driving adapter: gin router translating HTTP to
// catalog use cases and domain errors to status codes, per docs/API.md.
package httpapi

import (
	"os"
	"time"

	"github.com/gin-gonic/gin"

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
}

// NewRouter builds the /v1 router. gin.New(), not Default(): the logger is
// slog via requestLogger, not gin's own stdout writer (docs/LAYOUT.md
// "Gin: cuatro reglas").
func NewRouter(svc *catalog.Service, cooldown int) *gin.Engine {
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}
	a := &api{svc: svc, cooldown: time.Duration(cooldown) * time.Second}

	r := gin.New()
	r.Use(gin.Recovery(), requestID(), requestLogger(), secureHeaders())

	v1 := r.Group("/v1")
	{
		v1.GET("/healthz", a.healthz)
		v1.GET("/status", a.status)

		// The contract, embedded in the binary, plus a Swagger UI over it.
		v1.GET("/openapi.yaml", a.openapi)
		v1.GET("/docs", a.swaggerUI)

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
