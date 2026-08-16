package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// levels is a fixed 3-value enum — no SIA round trip. FIELDS.md soc1.
func (a *api) levels(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"levels": []gin.H{
		{"slug": "pregrado", "name": "Pregrado"},
		{"slug": "doctorado", "name": "Doctorado"},
		{"slug": "posgrado", "name": "Postgrados y másteres"},
	}})
}

// campuses is fixed too — FIELDS.md soc9/soc10, 9 sedes. Fase 1 only
// resolves programs for Bogotá, but the list itself is free.
func (a *api) campuses(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"campuses": []gin.H{
		{"code": "1125", "name": "SEDE AMAZONIA"},
		{"code": "1101", "name": "SEDE BOGOTÁ"},
		{"code": "1126", "name": "SEDE CARIBE"},
		{"code": "9933", "name": "SEDE DE LA PAZ"},
		{"code": "1103", "name": "SEDE MANIZALES"},
		{"code": "1102", "name": "SEDE MEDELLÍN"},
		{"code": "1124", "name": "SEDE ORINOQUIA"},
		{"code": "1104", "name": "SEDE PALMIRA"},
		{"code": "9920", "name": "SEDE TUMACO"},
	}})
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
