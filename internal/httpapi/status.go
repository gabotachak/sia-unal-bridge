package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (a *api) healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// status reports cache coverage. The pool's own live state (parkedAt,
// detailRegion per connection) isn't wired through yet — that needs
// sia.Pool to expose an introspection method, left for when Refresher
// lands and actually needs it (docs/API.md "Operación").
func (a *api) status(c *gin.Context) {
	cached, total, err := a.svc.CachedProgramCount(c.Request.Context())
	if err != nil {
		writeError(c, err, "unknown_program")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"programs_cached": cached,
		"programs_total":  total,
	})
}
