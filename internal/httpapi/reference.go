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

// campuses serves the soc9 list (FIELDS.md) from the reference cache. Fase 1
// only resolves programs for Bogotá, but the sede list itself is real data
// the SIA owns — cached at the reference TTL, not hardcoded here.
func (a *api) campuses(c *gin.Context) {
	campuses, err := a.svc.Campuses(c.Request.Context())
	if err != nil {
		writeError(c, err, "unknown_campus")
		return
	}
	out := make([]gin.H, len(campuses))
	for i, cam := range campuses {
		out[i] = gin.H{"code": cam.Code, "name": cam.Name}
	}
	c.JSON(http.StatusOK, gin.H{"campuses": out})
}

// faculties lists Bogotá's faculties — the only campus fase 1 resolves
// (docs/ARCH.md "Alcance"). ?campus= is accepted but only 1101 works.
func (a *api) faculties(c *gin.Context) {
	campus := c.Query("campus")
	if campus != "" && campus != catalog.BogotaCampusCode {
		c.JSON(http.StatusOK, gin.H{"faculties": []gin.H{}})
		return
	}
	faculties, err := a.svc.Faculties(c.Request.Context())
	if err != nil {
		writeError(c, err, "unknown_program")
		return
	}
	out := make([]gin.H, len(faculties))
	for i, f := range faculties {
		out[i] = gin.H{"code": f.Code, "name": f.Name}
	}
	c.JSON(http.StatusOK, gin.H{"faculties": out})
}

// listPrograms serves /v1/programs?campus=&faculty=. faculty is required in
// fase 1 (no full-campus program directory endpoint — that's the 65-program
// census, not "barata y acotada").
func (a *api) listPrograms(c *gin.Context) {
	campus := c.Query("campus")
	faculty := c.Query("faculty")
	if campus != catalog.BogotaCampusCode || faculty == "" {
		badRequest(c, "campus must be 1101 and faculty is required in fase 1")
		return
	}
	programs, err := a.svc.ProgramsInFaculty(c.Request.Context(), faculty)
	if err != nil {
		writeError(c, err, "unknown_program")
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

// resolveProgram is the shared :program path-param resolver. On error it
// writes the HTTP response itself and returns a non-nil error so the caller
// just needs to `return`.
func (a *api) resolveProgram(c *gin.Context) (catalog.Program, error) {
	code := c.Param("program")
	program, err := a.svc.ResolveProgram(c.Request.Context(), code)
	if err != nil {
		writeError(c, err, "unknown_program")
		return catalog.Program{}, err
	}
	return program, nil
}
