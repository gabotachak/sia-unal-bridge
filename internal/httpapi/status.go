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

// status reports cache coverage. The pool's own live state (parkedAt,
// detailRegion per connection) isn't wired through yet — that needs
// sia.Pool to expose an introspection method, left for when Refresher
// lands and actually needs it (docs/API.md "Operación").
func (a *api) status(c *gin.Context) {
	// "" = every campus: /v1/status is the operator's global view, unlike
	// the per-campus coverage reported by the course search.
	known, withCatalog, err := a.svc.ProgramCoverage(c.Request.Context(), "")
	if err != nil {
		writeError(c, err, "unknown_program")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"programs_known":        known,
		"programs_with_catalog": withCatalog,
	})
}
