package httpapi

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// courseShortcut serves GET /v1/courses/{code}. Resolving WHICH program(s)
// offer the code is Store-only (docs/API.md "no" miss trigger) — but once
// resolved to exactly one program, it delegates to the same read-through as
// the canonical route, which may itself hit SIA if that program's cache is
// stale. That's ordinary caching, not the kind of unbounded miss this
// shortcut is designed to avoid.
func (a *api) courseShortcut(c *gin.Context) {
	code := c.Param("code")
	programs, err := a.svc.ProgramsOfferingCourse(c.Request.Context(), code)
	if err != nil {
		writeError(c, err, "unknown_course")
		return
	}
	switch len(programs) {
	case 0:
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown_course", "message": "not cached under any known program", "hint": "try /v1/programs/{program}/courses/" + code})
		return
	case 1:
		maxAge, ok := parseMaxAge(c)
		if !ok {
			badRequest(c, "invalid max_age")
			return
		}
		offering, res, err := a.svc.CourseDetail(c.Request.Context(), programs[0], code, maxAge)
		if err != nil {
			writeError(c, err, "unknown_course")
			return
		}
		now := time.Now()
		setFreshnessHeaders(c, res, courseAge(offering, now), resolveMaxAge(maxAge, catalog.FreshnessDetail))
		c.JSON(http.StatusOK, courseDetailJSON(offering, now))
	default:
		writeError(c, &catalog.AmbiguousError{Candidates: programs}, "unknown_course")
	}
}

// courseSearch serves GET /v1/courses?q=... — Store only, NEVER triggers
// SIA. A miss here would mean crawling every uncached program, which is the
// DoS-by-GET docs/API.md explicitly rules out. coverage tells the client
// how much of the catalog it's actually searching over.
func (a *api) courseSearch(c *gin.Context) {
	q := c.Query("q")
	courses, err := a.svc.SearchCourses(c.Request.Context(), q)
	if err != nil {
		writeError(c, err, "unknown_course")
		return
	}
	cached, total, err := a.svc.CachedProgramCount(c.Request.Context())
	if err != nil {
		writeError(c, err, "unknown_course")
		return
	}

	results := make([]gin.H, len(courses))
	for i, course := range courses {
		results[i] = gin.H{
			"campus_code": course.CampusCode, "code": course.Code, "name": course.Name,
			"credits": course.Credits, "description": course.Description, "fetched_at": course.FetchedAt,
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"results":  results,
		"coverage": gin.H{"programs_cached": cached, "programs_total": total},
	})
}
