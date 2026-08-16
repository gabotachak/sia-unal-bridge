package httpapi

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// courseShortcut serves GET /v1/campuses/{campus}/courses/{code}. Resolving
// WHICH program(s) offer the code is Store-only (docs/API.md "no" miss
// trigger) — but once
// resolved to exactly one program, it delegates to the same read-through as
// the canonical route, which may itself hit SIA if that program's cache is
// stale. That's ordinary caching, not the kind of unbounded miss this
// shortcut is designed to avoid.
func (a *api) courseShortcut(c *gin.Context) {
	code, campus := c.Param("code"), c.Param("campus")
	programs, err := a.svc.ProgramsOfferingCourse(c.Request.Context(), campus, code)
	if err != nil {
		writeError(c, err, "unknown_course")
		return
	}
	switch len(programs) {
	case 0:
		c.JSON(http.StatusNotFound, gin.H{
			"error":   "unknown_course",
			"message": "not cached under any known program of this campus",
			"hint":    "try /v1/campuses/" + campus + "/programs/{program}/courses/" + code,
		})
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
		writeError(c, &catalog.AmbiguousError{
			Candidates: programs,
			Code:       "ambiguous_course",
			Hint:       "pick one: /v1/campuses/" + campus + "/programs/{program}/courses/" + code,
		}, "unknown_course")
	}
}

// courseSearch serves GET /v1/campuses/{campus}/courses?q=... — Store only,
// NEVER triggers SIA. A miss here would mean crawling every uncached
// program, which is the DoS-by-GET docs/API.md explicitly rules out.
// coverage tells the client how much of THIS campus's catalog it is actually
// searching over — a global coverage number would be meaningless now that
// every sede is reachable.
func (a *api) courseSearch(c *gin.Context) {
	campus := c.Param("campus")
	courses, err := a.svc.SearchCourses(c.Request.Context(), campus, c.Query("q"))
	if err != nil {
		writeError(c, err, "unknown_course")
		return
	}
	known, withCatalog, err := a.svc.ProgramCoverage(c.Request.Context(), campus)
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
		"coverage": gin.H{"programs_known": known, "programs_with_catalog": withCatalog},
	})
}
