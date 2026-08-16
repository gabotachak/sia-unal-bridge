// Package httpapi is the driving adapter: gin router translating HTTP to
// catalog use cases and domain errors to status codes, per docs/API.md.
package httpapi

import (
	"os"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// api holds the one dependency every handler needs. c.Request.Context()
// crosses into catalog, never *gin.Context itself — LAYOUT.md's hexagon
// rule for this adapter.
type api struct {
	svc *catalog.Service
}

// NewRouter builds the /v1 router. gin.New(), not Default(): the logger is
// slog via requestLogger, not gin's own stdout writer (docs/LAYOUT.md
// "Gin: cuatro reglas").
func NewRouter(svc *catalog.Service) *gin.Engine {
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}
	a := &api{svc: svc}

	r := gin.New()
	r.Use(gin.Recovery(), requestID(), requestLogger())

	v1 := r.Group("/v1")
	{
		v1.GET("/healthz", a.healthz)
		v1.GET("/status", a.status)

		v1.GET("/levels", a.levels)
		v1.GET("/campuses", a.campuses)
		v1.GET("/faculties", a.faculties)
		v1.GET("/programs", a.listPrograms)
		v1.GET("/programs/:program", a.getProgram)

		v1.GET("/programs/:program/courses", a.programCourses)
		v1.GET("/programs/:program/courses/:code", a.courseDetail)
		v1.GET("/programs/:program/courses/:code/sections", a.courseSections)
		v1.GET("/programs/:program/courses/:code/sections/:key", a.courseSection)
		v1.GET("/programs/:program/courses/:code/sections/:key/seats", a.sectionSeats)

		v1.GET("/courses/:code", a.courseShortcut)
		v1.GET("/courses", a.courseSearch)
	}
	return r
}
