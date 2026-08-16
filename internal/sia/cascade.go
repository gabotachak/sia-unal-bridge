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

// gotoProgram runs the regular 4-step cascade (soc1, soc9, soc2, soc3) to
// park the connection on key. If already parked there, it's a no-op. If
// parked in the same faculty, only soc3+cb1 need to run — PROTOCOL.md §3
// "Cambiar de carrera es barato". Must not be called while DetailRegion != 0
// — call Volver first (GOTCHAS §10).
func (c *SIAConn) gotoProgram(ctx context.Context, key catalog.ProgramKey) error {
	if c.DetailRegion != 0 {
		return fmt.Errorf("sia: gotoProgram: connection is in detail region %d, call Volver first", c.DetailRegion)
	}
	if c.parked && c.ParkedAt == key {
		return nil
	}

	sameFaculty := c.parked &&
		c.ParkedAt.Level == key.Level &&
		c.ParkedAt.Campus == key.Campus &&
		c.ParkedAt.Faculty == key.Faculty

	if !sameFaculty {
		c.form.Nivel = strconv.Itoa(key.Level)
		if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc1"); err != nil {
			return err
		} else if isNoop(body) {
			return newNoopError(body)
		}
		c.form.Sede = strconv.Itoa(key.Campus)
		if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc9"); err != nil {
			return err
		} else if isNoop(body) {
			return newNoopError(body)
		}
		c.form.Facultad = strconv.Itoa(key.Faculty)
		if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc2"); err != nil {
			return err
		} else if isNoop(body) {
			return newNoopError(body)
		}
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
// soc1, soc9 ONCE, then soc2 once per faculty returned. It does the whole
// walk on this ONE connection deliberately — re-posting soc1/soc9 with the
// SAME value they already hold does not make ADF re-render soc2 (verified
// 2026-08-15; the partial-response simply omits the update block, which
// looks exactly like GOTCHAS §6 but isn't a cascade problem, it's a
// redundant-repost problem. Never re-issue a valueChange with an unchanged
// value). Cost is bounded: 2 + len(faculties) POSTs — "barata y acotada"
// per docs/API.md, not the full 1380-entry census (that's Refresher).
func (c *SIAConn) FetchProgramDirectory(ctx context.Context, level, campus int) ([]Option, map[int][]Option, error) {
	if c.DetailRegion != 0 {
		return nil, nil, fmt.Errorf("sia: FetchProgramDirectory: connection is in detail region %d, call Volver first", c.DetailRegion)
	}
	c.form.Nivel = strconv.Itoa(level)
	if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc1"); err != nil {
		return nil, nil, err
	} else if isNoop(body) {
		return nil, nil, newNoopError(body)
	}
	c.form.Sede = strconv.Itoa(campus)
	body, env, err := c.postValueChange(ctx, "pt1:r1:0:soc9")
	if err != nil {
		return nil, nil, err
	}
	if isNoop(body) {
		return nil, nil, newNoopError(body)
	}
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
		c.form.Facultad = strconv.Itoa(fac.Index)
		body, env, err := c.postValueChange(ctx, "pt1:r1:0:soc2")
		if err != nil {
			return nil, nil, err
		}
		if isNoop(body) {
			return nil, nil, newNoopError(body)
		}
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

// FetchElectives runs the 9-step electives cascade (soc1,soc9,soc2,soc3,
// soc4=7,soc5,soc10,soc6,cb1) and returns the campus-wide libre elección
// listing. campus-wide because soc6=12 is the faculty wildcard — there is no
// per-program equivalent (PROTOCOL.md §5). Skipping soc10 before soc6
// produces silent garbage (GOTCHAS §5 of PROTOCOL.md); this always runs both.
func (c *SIAConn) FetchElectives(ctx context.Context, key catalog.ProgramKey) ([]byte, error) {
	// soc4=7 is a value CHANGE on top of an already-parked program: run the
	// regular cascade first so soc1..soc3 are populated, then switch soc4.
	if err := c.gotoProgram(ctx, key); err != nil {
		return nil, err
	}

	c.form.Tipologia = TypologyElectives
	if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc4"); err != nil {
		return nil, err
	} else if isNoop(body) {
		return nil, newNoopError(body)
	}

	c.form.Modo = "0" // "Por facultad y plan"
	if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc5"); err != nil {
		return nil, err
	} else if isNoop(body) {
		return nil, newNoopError(body)
	}

	c.form.SedeElect = strconv.Itoa(key.Campus)
	if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc10"); err != nil {
		return nil, err
	} else if isNoop(body) {
		return nil, newNoopError(body)
	}

	c.form.FacElect = electivesCampusWildcard
	if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc6"); err != nil {
		return nil, err
	} else if isNoop(body) {
		return nil, newNoopError(body)
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
