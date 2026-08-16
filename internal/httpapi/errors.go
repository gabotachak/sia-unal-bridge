package httpapi

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// writeError maps a domain error to the status/body contract in
// docs/API.md "Errores". notFoundCode distinguishes unknown_program from
// unknown_course — same catalog.ErrNotFound, different context, so the
// caller (which knows what it was looking up) supplies it.
func writeError(c *gin.Context, err error, notFoundCode string) {
	var aerr *catalog.AmbiguousError
	switch {
	case errors.Is(err, catalog.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": notFoundCode, "message": err.Error()})
	case errors.As(err, &aerr):
		candidates := make([]gin.H, len(aerr.Candidates))
		for i, cand := range aerr.Candidates {
			candidates[i] = gin.H{"program": cand.Code, "name": cand.Name}
		}
		c.JSON(http.StatusMultipleChoices, gin.H{"error": "ambiguous_course", "message": err.Error(), "candidates": candidates})
	case errors.Is(err, catalog.ErrBusy):
		c.Header("Retry-After", "2")
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "busy", "message": "sia connection pool busy"})
	case errors.Is(err, catalog.ErrSIASessionLost):
		c.JSON(http.StatusBadGateway, gin.H{"error": "sia_session_lost", "message": err.Error()})
	case errors.Is(err, catalog.ErrSIANoop):
		c.JSON(http.StatusBadGateway, gin.H{"error": "sia_noop", "message": "SIA returned an empty re-render"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal", "message": err.Error()})
	}
}

func badRequest(c *gin.Context, message string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": "bad_request", "message": message})
}
