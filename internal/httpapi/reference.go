package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// levels serves the soc1 list (FIELDS.md) from the reference cache. It was a
// hardcoded 3-value slice; the SIA owns the list, so a fourth nivel appears
// without a redeploy. The slugs are ours and stable — see catalog.Level.
func (a *api) levels(c *gin.Context) {
	levels, err := a.svc.Levels(c.Request.Context())
	if err != nil {
		writeError(c, err, "unknown_level")
		return
	}
	out := make([]gin.H, len(levels))
	for i, l := range levels {
		out[i] = gin.H{"slug": l.Slug, "name": l.Name}
	}
	c.JSON(http.StatusOK, gin.H{"levels": out})
}

// campuses serves the soc9 list (FIELDS.md) from the reference cache. It is
// the entry point of the whole API now that every other route hangs off a
// sede: real data the SIA owns, cached at the reference TTL, not hardcoded.
func (a *api) campuses(c *gin.Context) {
	campuses, err := a.svc.Campuses(c.Request.Context(), c.Query("level"))
	if err != nil {
		writeError(c, err, "unknown_level")
		return
	}
	out := make([]gin.H, len(campuses))
	for i, cam := range campuses {
		out[i] = gin.H{"code": cam.Code, "name": cam.Name}
	}
	c.JSON(http.StatusOK, gin.H{"campuses": out})
}

// faculties lists one campus's faculties. The sede comes from the path: it
// is not optional, so it is not a query parameter.
func (a *api) faculties(c *gin.Context) {
	faculties, err := a.svc.Faculties(c.Request.Context(), c.Param("campus"), c.Query("level"))
	if err != nil {
		writeError(c, err, "unknown_campus")
		return
	}
	out := make([]gin.H, len(faculties))
	for i, f := range faculties {
		out[i] = gin.H{"code": f.Code, "name": f.Name}
	}
	c.JSON(http.StatusOK, gin.H{"faculties": out})
}

// listPrograms serves /v1/campuses/{campus}/programs?faculty=. ?faculty=
// stays a filter, and is now genuinely free: a directory miss fills every
// faculty of the campus in the same cascade.
func (a *api) listPrograms(c *gin.Context) {
	programs, err := a.svc.ProgramsInFaculty(c.Request.Context(), c.Param("campus"), c.Query("faculty"), c.Query("level"))
	if err != nil {
		writeError(c, err, "unknown_campus")
		return
	}
	out := make([]gin.H, len(programs))
	for i, p := range programs {
		out[i] = programJSON(p)
	}
	c.JSON(http.StatusOK, gin.H{"programs": out})
}

func (a *api) getProgram(c *gin.Context) {
	program, err := a.resolveProgram(c)
	if err != nil {
		return // resolveProgram already wrote the error response
	}
	c.JSON(http.StatusOK, programJSON(program))
}

func programJSON(p catalog.Program) gin.H {
	h := gin.H{
		"campus_code":  p.CampusCode,
		"faculty_code": p.FacultyCode,
		"code":         p.Code,
		"name":         p.Name,
		"campus_name":  p.CampusName,
		"faculty_name": p.FacultyName,
	}
	if p.CatalogFetchedAt != nil {
		h["catalog_fetched_at"] = p.CatalogFetchedAt
	}
	return h
}

// resolveProgram is the shared :program path-param resolver. The sede comes
// from the path and settles the cross-campus collision (136 of 852 codes,
// GOTCHAS §26). ?faculty= is still accepted for the rarer within-campus one
// — 2515 is listed twice in Medellín — and that case still answers 300 with
// the candidates.
//
// On error it writes the HTTP response itself and returns a non-nil error so
// the caller just needs to `return`.
func (a *api) resolveProgram(c *gin.Context) (catalog.Program, error) {
	program, err := a.svc.ResolveProgram(c.Request.Context(), catalog.ProgramRef{
		Campus:  c.Param("campus"),
		Faculty: c.Query("faculty"),
		Code:    c.Param("program"),
		Level:   c.Query("level"),
	})
	if err != nil {
		writeError(c, err, "unknown_program")
		return catalog.Program{}, err
	}
	return program, nil
}
