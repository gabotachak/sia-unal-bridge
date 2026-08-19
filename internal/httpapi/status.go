package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (a *api) healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok", "created_by": "gabotachak"})
}

// version reports the tag (semver, "dev" si no viene de un build con ldflags)
// y el commit exacto corriendo en este contenedor — ver docs/COMMANDS.md
// "Qué versión está corriendo".
func (a *api) version(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"version": a.buildVersion, "commit": a.buildCommit})
}

// status reports cache coverage plus the last sweep of each Refresher mode:
// which one ran, when, how it ended. Without it, "la cobertura crece sola"
// (docs/API.md) is a claim nobody can check, and a sweep aborted by the
// circuit breaker at 3 a.m. is invisible until somebody reads the logs.
//
// The pool's own live state (parkedAt, detailRegion per connection) is still
// not exposed: the job's traffic is accounted for in refresh_run.posts/bytes,
// which is the question that was actually being asked.
func (a *api) status(c *gin.Context) {
	ctx := c.Request.Context()
	// "" = every campus: /v1/status is the operator's global view, unlike
	// the per-campus coverage reported by the course search.
	known, withCatalog, err := a.svc.ProgramCoverage(ctx, "")
	if err != nil {
		writeError(c, err, "unknown_program")
		return
	}
	runs, err := a.svc.LastRuns(ctx)
	if err != nil {
		writeError(c, err, "status_unavailable")
		return
	}

	body := gin.H{
		"programs_known":        known,
		"programs_with_catalog": withCatalog,
	}
	// Keyed by mode: an operator asks "when did the detail sweep last run",
	// not "give me run 412".
	refresh := make(gin.H, len(runs))
	for _, r := range runs {
		refresh[r.Mode] = r
	}
	body["refresh"] = refresh
	c.JSON(http.StatusOK, body)
}
