package sia

import (
	"context"
	"fmt"
	"regexp"
	"strconv"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// TypologyAll is soc4=0: "TODAS MENOS LIBRE ELECCIÓN". NOT "sin filtro" —
// the program's libre elección courses never appear here. GOTCHAS §21.
const TypologyAll = "0"

// TypologyElectives is soc4=7: switches to the 9-step electives cascade.
const TypologyElectives = "7"

// electivesCampusWildcard is soc6=12 with soc10=2 (Bogotá): "2000 SEDE
// BOGOTÁ", returns electives from every faculty at once. FIELDS.md.
const electivesCampusWildcard = "12"

// gotoProgram walks the connection to key, skipping any soc1/soc9/soc2 POST
// whose target value the connection already holds — reposting an unchanged
// valueChange does not re-render the dependent dropdown (GOTCHAS §30), and
// none of these three steps' response data is ever consumed here, only its
// side effect of advancing server-side state. Safe to skip freely. Must not
// be called while DetailRegion != 0 — call Volver first (GOTCHAS §10).
func (c *SIAConn) gotoProgram(ctx context.Context, key catalog.ProgramKey) error {
	if c.DetailRegion != 0 {
		return fmt.Errorf("sia: gotoProgram: connection is in detail region %d, call Volver first", c.DetailRegion)
	}
	if c.parked && c.ParkedAt == key {
		return nil
	}

	if c.navLevel != key.Level {
		c.form.Nivel = strconv.Itoa(key.Level)
		if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc1"); err != nil {
			return err
		} else if isNoop(body) {
			return newNoopError(body)
		}
		c.navLevel = key.Level
		c.navCampus, c.navFaculty = -1, -1 // level changed: everything downstream is stale
	}
	if c.navCampus != key.Campus {
		c.form.Sede = strconv.Itoa(key.Campus)
		if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc9"); err != nil {
			return err
		} else if isNoop(body) {
			return newNoopError(body)
		}
		c.navCampus = key.Campus
		c.navFaculty = -1
	}
	if c.navFaculty != key.Faculty {
		c.form.Facultad = strconv.Itoa(key.Faculty)
		if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc2"); err != nil {
			return err
		} else if isNoop(body) {
			return newNoopError(body)
		}
		c.navFaculty = key.Faculty
	}

	c.form.Carrera = strconv.Itoa(key.Program)
	if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc3"); err != nil {
		return err
	} else if isNoop(body) {
		return newNoopError(body)
	}

	c.ParkedAt = key
	c.parked = true
	return nil
}

// FetchProgramDirectory walks the reference cascade for one (level, campus):
// soc1, soc9, then soc2 once per faculty returned. Unlike gotoProgram, every
// step here MUST return fresh response data (the actual options), so it
// can't just skip a step whose value is already current — GOTCHAS §30 means
// skipping would leave us with no data at all. Where the connection already
// holds the target value (pooled and reused from an unrelated prior
// request), it bounces through a different value first to force a genuine
// change, then sets the real target — 2 extra POSTs, only paid when needed.
// Cost is bounded: 2-4 + len(faculties) POSTs — "barata y acotada" per
// docs/API.md, not the full 1380-entry census (that's Refresher).
func (c *SIAConn) FetchProgramDirectory(ctx context.Context, level, campus int) ([]Option, map[int][]Option, error) {
	if c.DetailRegion != 0 {
		return nil, nil, fmt.Errorf("sia: FetchProgramDirectory: connection is in detail region %d, call Volver first", c.DetailRegion)
	}

	if c.navLevel != level {
		c.form.Nivel = strconv.Itoa(level)
		if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc1"); err != nil {
			return nil, nil, err
		} else if isNoop(body) {
			return nil, nil, newNoopError(body)
		}
		c.navLevel = level
		c.navCampus, c.navFaculty = -1, -1
	}

	if c.navCampus == campus {
		// Bounce: force a real change so the soc9 response actually
		// contains a fresh <update id="pt1:r1:0:soc2">.
		bounce := 1
		if campus == 1 {
			bounce = 2
		}
		c.form.Sede = strconv.Itoa(bounce)
		if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc9"); err != nil {
			return nil, nil, err
		} else if isNoop(body) {
			return nil, nil, newNoopError(body)
		}
		c.navCampus = bounce
	}
	c.form.Sede = strconv.Itoa(campus)
	body, env, err := c.postValueChange(ctx, "pt1:r1:0:soc9")
	if err != nil {
		return nil, nil, err
	}
	if isNoop(body) {
		return nil, nil, newNoopError(body)
	}
	c.navCampus = campus
	c.navFaculty = -1
	c.parked = false // no program selected — gotoProgram must run its full path next

	html, ok := env["pt1:r1:0:soc2"]
	if !ok {
		return nil, nil, fmt.Errorf("sia: FetchProgramDirectory: no update id=%q in response", "pt1:r1:0:soc2")
	}
	faculties, err := parseOptionsHTML(html)
	if err != nil {
		return nil, nil, err
	}

	programs := make(map[int][]Option, len(faculties))
	for _, fac := range faculties {
		if c.navFaculty == fac.Index {
			// Same bounce trick, using any other known faculty index.
			// With a single-faculty campus (never the case for Bogotá's
			// 13) there's no alternative and this would noop — acceptable
			// gap given the fase 1 scope.
			var bounce = -1
			for _, other := range faculties {
				if other.Index != fac.Index {
					bounce = other.Index
					break
				}
			}
			if bounce != -1 {
				c.form.Facultad = strconv.Itoa(bounce)
				if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc2"); err != nil {
					return nil, nil, err
				} else if isNoop(body) {
					return nil, nil, newNoopError(body)
				}
				c.navFaculty = bounce
			}
		}
		c.form.Facultad = strconv.Itoa(fac.Index)
		body, env, err := c.postValueChange(ctx, "pt1:r1:0:soc2")
		if err != nil {
			return nil, nil, err
		}
		if isNoop(body) {
			return nil, nil, newNoopError(body)
		}
		c.navFaculty = fac.Index
		html, ok := env["pt1:r1:0:soc3"]
		if !ok {
			return nil, nil, fmt.Errorf("sia: FetchProgramDirectory: no update id=%q in response for faculty %d", "pt1:r1:0:soc3", fac.Index)
		}
		opts, err := parseOptionsHTML(html)
		if err != nil {
			return nil, nil, err
		}
		programs[fac.Index] = opts
	}
	return faculties, programs, nil
}

// FetchCatalog runs the regular listing: gotoProgram + soc4=0 + cb1. Returns
// the raw <partial-response> body — parse_list.go extracts the
// <update id="pt1:r1:0:pb3"> CDATA table from it. This is HALF the program's
// catalog — it excludes libre elección (GOTCHAS §21). See FetchElectives for
// the other half.
func (c *SIAConn) FetchCatalog(ctx context.Context, key catalog.ProgramKey) ([]byte, error) {
	if err := c.gotoProgram(ctx, key); err != nil {
		return nil, err
	}
	c.form.Tipologia = TypologyAll
	body, _, err := c.postAction(ctx, "pt1:r1:0:cb1", "{pt1:r1:0:t4={viewportSize=999}}")
	if err != nil {
		return nil, err
	}
	if isNoop(body) {
		return nil, newNoopError(body)
	}
	return body, nil
}

// postValueChangeFresh posts id=target and GUARANTEES a genuine response:
// if *cur already equals target (pooled connection reused from an
// unrelated prior request — GOTCHAS §30), it bounces through alt first so
// the real post is a genuine change from ADF's point of view.
func (c *SIAConn) postValueChangeFresh(ctx context.Context, id string, cur *string, target, alt string, setForm func(string)) ([]byte, map[string]string, error) {
	if *cur == target {
		setForm(alt)
		body, _, err := c.postValueChange(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		if isNoop(body) {
			return nil, nil, newNoopError(body)
		}
		*cur = alt
	}
	setForm(target)
	body, env, err := c.postValueChange(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if isNoop(body) {
		return nil, nil, newNoopError(body)
	}
	*cur = target
	return body, env, nil
}

// FetchElectives runs the 9-step electives cascade (soc1,soc9,soc2,soc3,
// soc4=7,soc5,soc10,soc6,cb1) and returns the campus-wide libre elección
// listing. campus-wide because soc6=12 is the faculty wildcard — there is no
// per-program equivalent (PROTOCOL.md §5). Skipping soc10 before soc6
// produces silent garbage (GOTCHAS §5 of PROTOCOL.md); this always runs both.
//
// Fase 1 targets exactly ONE campus, so soc4/soc5/soc10/soc6 post the SAME
// four values on every single call — the second time any pooled connection
// is reused for electives, all four would repost unchanged and noop
// (GOTCHAS §30) without postValueChangeFresh's bounce.
func (c *SIAConn) FetchElectives(ctx context.Context, key catalog.ProgramKey) ([]byte, error) {
	// soc4=7 is a value CHANGE on top of an already-parked program: run the
	// regular cascade first so soc1..soc3 are populated, then switch soc4.
	if err := c.gotoProgram(ctx, key); err != nil {
		return nil, err
	}

	if _, _, err := c.postValueChangeFresh(ctx, "pt1:r1:0:soc4", &c.navTipologia,
		TypologyElectives, TypologyAll, func(v string) { c.form.Tipologia = v }); err != nil {
		return nil, err
	}

	if _, _, err := c.postValueChangeFresh(ctx, "pt1:r1:0:soc5", &c.navModo,
		"0", "1", func(v string) { c.form.Modo = v }); err != nil {
		return nil, err
	}

	sedeElect := strconv.Itoa(key.Campus)
	sedeElectAlt := "1"
	if key.Campus == 1 {
		sedeElectAlt = "2"
	}
	if _, _, err := c.postValueChangeFresh(ctx, "pt1:r1:0:soc10", &c.navSedeElect,
		sedeElect, sedeElectAlt, func(v string) { c.form.SedeElect = v }); err != nil {
		return nil, err
	}

	if _, _, err := c.postValueChangeFresh(ctx, "pt1:r1:0:soc6", &c.navFacElect,
		electivesCampusWildcard, "0", func(v string) { c.form.FacElect = v }); err != nil {
		return nil, err
	}

	body, _, err := c.postAction(ctx, "pt1:r1:0:cb1", "")
	if err != nil {
		return nil, err
	}
	if isNoop(body) {
		return nil, newNoopError(body)
	}

	// Leave soc4 back at "all but electives" so the connection stays usable
	// for a plain FetchCatalog next, without another full cascade.
	c.form.Tipologia = TypologyAll

	return body, nil
}

// detailRegionFrom finds the numbered "Volver" button id in a detail
// response: id="pt1:r1:<N>:cb4". The index GROWS with every detail opened in
// the session — never hardcode it. GOTCHAS §20.
var detailRegionRe = regexp.MustCompile(`id="pt1:r1:(\d+):cb4"`)

// FetchDetail clicks the row with the given _afrRK (read fresh from the most
// recent list response — never a cached or positional key, GOTCHAS §4) and
// returns the raw detail CDATA plus the numbered region it opened. The
// caller MUST call Volver(ctx, region) before any other region-0 action.
func (c *SIAConn) FetchDetail(ctx context.Context, rowKey string) ([]byte, int, error) {
	if c.DetailRegion != 0 {
		return nil, 0, fmt.Errorf("sia: FetchDetail: already in detail region %d, call Volver first", c.DetailRegion)
	}
	deltas := fmt.Sprintf("{pt1:r1:0:t4={viewportSize=999,rows=999,selectedRowKeys=%s}}", rowKey)
	eventID := fmt.Sprintf("pt1:r1:0:t4:%s:cl2", rowKey)

	body, _, err := c.post(ctx, c.form.actionValues(c.viewState, eventID, deltas))
	if err != nil {
		return nil, 0, err
	}
	if isNoop(body) {
		return nil, 0, newNoopError(body)
	}

	m := detailRegionRe.FindStringSubmatch(string(body))
	if m == nil {
		return nil, 0, fmt.Errorf("sia: FetchDetail: no detail region id in %d byte response", len(body))
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return nil, 0, fmt.Errorf("sia: FetchDetail: bad region %q: %w", m[1], err)
	}
	c.DetailRegion = n
	return body, n, nil
}

// Volver leaves the numbered detail region and re-renders the search table.
// The region id must come from FetchDetail's return, never hardcoded —
// GOTCHAS §20. _afrRK is renumbered by this call; re-parse before the next
// FetchDetail.
func (c *SIAConn) Volver(ctx context.Context) ([]byte, error) {
	if c.DetailRegion == 0 {
		return nil, nil
	}
	id := fmt.Sprintf("pt1:r1:%d:cb4", c.DetailRegion)
	body, _, err := c.postAction(ctx, id, "")
	if err != nil {
		return nil, err
	}
	if isNoop(body) {
		return nil, newNoopError(body)
	}
	c.DetailRegion = 0
	return body, nil
}
