package httpapi

import (
	"errors"
	"log/slog"
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
		// The full identity goes in every candidate: the same program code is
		// reexposed across sedes by PEAMA and across faculties within a sede
		// (GOTCHAS §26), so a list without campus AND faculty is unusable.
		candidates := make([]gin.H, len(aerr.Candidates))
		for i, cand := range aerr.Candidates {
			candidates[i] = gin.H{
				"program": cand.Code, "name": cand.Name,
				"campus_code": cand.CampusCode, "campus_name": cand.CampusName,
				"faculty_code": cand.FacultyCode, "faculty_name": cand.FacultyName,
			}
		}
		code := aerr.Code
		if code == "" {
			code = "ambiguous_course"
		}
		body := gin.H{"error": code, "message": err.Error(), "candidates": candidates}
		if aerr.Hint != "" {
			body["hint"] = aerr.Hint
		}
		c.JSON(http.StatusMultipleChoices, body)
	case errors.Is(err, catalog.ErrBusy):
		c.Header("Retry-After", "2")
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "busy", "message": "sia connection pool busy"})
	case errors.Is(err, catalog.ErrSIASessionLost):
		c.JSON(http.StatusBadGateway, gin.H{"error": "sia_session_lost", "message": err.Error()})
	case errors.Is(err, catalog.ErrSIANoop):
		c.JSON(http.StatusBadGateway, gin.H{"error": "sia_noop", "message": "SIA returned an empty re-render"})
	default:
		slog.Error("unhandled error", "err", err, "request_id", c.GetString("request_id"))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal", "message": "internal server error"})
	}
}

func badRequest(c *gin.Context, message string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": "bad_request", "message": message})
}
