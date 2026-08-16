package httpapi

import (
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// parseMaxAge reads ?max_age=<seconds> (docs/API.md "Frescura"). No
// parameter means "use the resource's own default" (catalog.DefaultFreshness);
// max_age=0 forces a SIA fetch; a negative or non-numeric value is a 400.
func parseMaxAge(c *gin.Context) (time.Duration, bool) {
	q, present := c.GetQuery("max_age")
	if !present {
		return catalog.DefaultFreshness, true
	}
	n, err := strconv.Atoi(q)
	if err != nil || n < 0 {
		return 0, false
	}
	return time.Duration(n) * time.Second, true
}

// resolveMaxAge turns catalog.DefaultFreshness into the resource's actual
// default, for display in the Cache-Control header — the sentinel itself
// (-1) must never leak into a header value.
func resolveMaxAge(maxAge, resourceDefault time.Duration) time.Duration {
	if maxAge < 0 {
		return resourceDefault
	}
	return maxAge
}

// setFreshnessHeaders writes Age/Cache-Control/X-Cache/X-SIA-Fetch-Ms per
// docs/API.md "Cabeceras". age is how old the OLDEST datum in the response
// is, not just the top-level record.
func setFreshnessHeaders(c *gin.Context, res catalog.FetchResult, age, maxAge time.Duration) {
	if age < 0 {
		age = 0
	}
	c.Header("Age", strconv.Itoa(int(age.Seconds())))
	c.Header("Cache-Control", "max-age="+strconv.Itoa(int(maxAge.Seconds())))
	c.Header("X-Cache", string(res.Cache))
	if res.Cache == catalog.CacheMiss {
		c.Header("X-SIA-Fetch-Ms", strconv.FormatInt(res.FetchMs, 10))
	}
}

// courseAge is the age of the OLDEST datum in a course response: the course
// row itself, every section, and every seat snapshot. Never report a course
// as fresher than its stalest section.
func courseAge(o catalog.CourseOffering, now time.Time) time.Duration {
	oldest := o.Course.FetchedAt
	for _, sec := range o.Course.Sections {
		if sec.FetchedAt.Before(oldest) {
			oldest = sec.FetchedAt
		}
		if sec.Seats != nil && sec.Seats.MeasuredAt.Before(oldest) {
			oldest = sec.Seats.MeasuredAt
		}
	}
	return now.Sub(oldest)
}
