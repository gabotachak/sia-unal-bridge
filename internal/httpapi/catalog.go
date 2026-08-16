package httpapi

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// programCourses serves GET /v1/campuses/{campus}/programs/{program}/courses.
// Filters (?q=, ?credits=, ?typology=) are applied in-memory over the full
// (cache-aware) catalog fetch — a simplification over docs/API.md's
// described it11 server-side filter, which would need its own
// non-catalog-completing SIA fetch path. Correctness is preserved; the
// optimization of a smaller SIA payload on a cold filtered miss is not
// implemented.
func (a *api) programCourses(c *gin.Context) {
	program, err := a.resolveProgram(c)
	if err != nil {
		return
	}

	maxAge, ok := parseMaxAge(c)
	if !ok {
		badRequest(c, "invalid max_age")
		return
	}

	offerings, res, err := a.svc.Catalog(c.Request.Context(), program, maxAge)
	if err != nil {
		writeError(c, err, "unknown_program")
		return
	}

	offerings = filterOfferings(offerings, c.Query("q"), c.Query("credits"), c.Query("typology"))

	age := time.Duration(0)
	if program.CatalogFetchedAt != nil {
		age = time.Since(*program.CatalogFetchedAt)
	}
	setFreshnessHeaders(c, res, age, resolveMaxAge(maxAge, catalog.FreshnessCatalog))

	courses := make([]gin.H, len(offerings))
	for i, o := range offerings {
		courses[i] = courseSummaryJSON(o)
	}
	c.JSON(http.StatusOK, gin.H{"courses": courses})
}

func filterOfferings(offerings []catalog.CourseOffering, q, creditsStr, typology string) []catalog.CourseOffering {
	if q == "" && creditsStr == "" && typology == "" {
		return offerings
	}
	credits, hasCredits := -1, false
	if creditsStr != "" {
		if n, err := strconv.Atoi(creditsStr); err == nil {
			credits, hasCredits = n, true
		}
	}
	out := offerings[:0]
	for _, o := range offerings {
		if q != "" && !strings.Contains(strings.ToLower(o.Course.Name), strings.ToLower(q)) {
			continue
		}
		if hasCredits && o.Course.Credits != credits {
			continue
		}
		if typology != "" && o.Typology != typology {
			continue
		}
		out = append(out, o)
	}
	return out
}

func courseSummaryJSON(o catalog.CourseOffering) gin.H {
	return gin.H{
		"campus_code": o.Course.CampusCode,
		"code":        o.Course.Code,
		"name":        o.Course.Name,
		"credits":     o.Course.Credits,
		"typology":    o.Typology,
		"description": o.Course.Description,
		"fetched_at":  o.Course.FetchedAt,
	}
}
