package httpapi

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// refreshBlocked is the throttle on client-forced SIA fetches, shared by the
// four detail endpoints. It answers 429 and reports true when the caller
// should stop; false means carry on with the normal read-through.
//
// Three rules, each of which the obvious implementation gets wrong:
//
// It gates on maxAge < cooldown, not on maxAge == 0. Gating only the zero case
// leaves ?max_age=1 as a free bypass, since the cache is essentially never
// under a second old and every such request would reach the SIA. A max_age at
// or above the cooldown needs no gate: the read-through already serves it from
// cache that often.
//
// It measures against course_program.detail_fetched_at, read straight from the
// store, and never through Service.CourseDetail. Going through the read-through
// to find out how old the cache is fetches on a miss — the cooldown would then
// cause the very POST it exists to prevent, and answer 429 while hiding the
// data it just paid for.
//
// Its error code is refresh_cooldown, not the limiter's rate_limit: both are
// 429, but one says "this course is fresh, the number you have is right" and
// the other "you are sending too much". A client told the first when the
// second happened draws the wrong conclusion.
//
// A course with nothing cached passes. That request is a first fetch, not a
// refresh; 429 to a client that has never been served anything is a dead end.
func (a *api) refreshBlocked(c *gin.Context, program catalog.Program, code string, maxAge time.Duration) bool {
	// maxAge < 0 is catalog.DefaultFreshness: no explicit ?max_age=, so the
	// client is not forcing anything.
	if a.cooldown <= 0 || maxAge < 0 || maxAge >= a.cooldown {
		return false
	}

	fetchedAt, ok, err := a.svc.LastDetailFetch(c.Request.Context(), program, code)
	if err != nil || !ok {
		// On a store error, fall through: the read-through will hit the same
		// error and report it properly instead of masking it as a 429.
		return false
	}

	remaining := a.cooldown - time.Since(fetchedAt)
	if remaining <= 0 {
		return false
	}

	retryAfter := int(math.Ceil(remaining.Seconds()))
	c.Header("Retry-After", strconv.Itoa(retryAfter))
	c.JSON(http.StatusTooManyRequests, gin.H{
		"error":               "refresh_cooldown",
		"message":             "refresh too soon: this course was fetched from SIA less than the cooldown ago",
		"cooldown_seconds":    int(a.cooldown.Seconds()),
		"retry_after_seconds": retryAfter,
	})
	return true
}
