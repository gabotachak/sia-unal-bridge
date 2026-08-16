package sia

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// TypologyAll is soc4=0: "TODAS MENOS LIBRE ELECCIÓN". NOT "sin filtro" —
// the program's libre elección courses never appear here. GOTCHAS §21.
const TypologyAll = "0"

// TypologyElectives is soc4=7: switches to the 9-step electives cascade.
const TypologyElectives = "7"

// campusWildcardPrefix identifies the soc2/soc6 option that is NOT a
// faculty but the whole sede — "2000 SEDE BOGOTÁ", "3 SEDE MEDELLÍN". In the
// electives search it is the wildcard that returns every faculty's libre
// elección at once (PROTOCOL.md §5). Real faculties are all named "FACULTAD
// DE …", so the prefix is the discriminator.
//
// Its POSITION is per sede and must never be hardcoded: it was "12" for
// Bogotá's 13-option list, but Medellín has 11 options and the wildcard sits
// at 10. Posting 12 there is out of range, which the SIA answers with a
// silent no-op — measured, not guessed.
const campusWildcardPrefix = "SEDE "

// gotoProgram walks the connection to key, skipping any soc1/soc9/soc2 POST
// whose target value the connection already holds — reposting an unchanged
// valueChange does not re-render the dependent dropdown (GOTCHAS §30), and
// none of these three steps' response data is ever consumed here, only its
// side effect of advancing server-side state. Safe to skip freely. Must not
// be called while DetailRegion != 0 — call Volver first (GOTCHAS §10).
func (c *SIAConn) gotoProgram(ctx context.Context, key catalog.ProgramKey) error {
	if c.DetailRegion != 0 {
		return fmt.Errorf("sia: gotoProgram: connection is in detail region %d, call Volver first: %w", c.DetailRegion, errStaleDetailRegion)
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

// FetchLevels returns the soc1 dropdown — the niveles de estudio. soc1 is
// the root of the cascade, so nothing upstream re-renders it; its own
// valueChange response does (verified against the live server). Exactly one
// POST: any genuine change works, so it just picks a level the connection
// isn't already on and never needs the bounce the others do.
//
// The labels carry no code — see LabelOption. Turning them into a public ID
// is the caller's job, not the parser's.
func (c *SIAConn) FetchLevels(ctx context.Context) ([]LabelOption, error) {
	if c.DetailRegion != 0 {
		return nil, fmt.Errorf("sia: FetchLevels: connection is in detail region %d, call Volver first: %w", c.DetailRegion, errStaleDetailRegion)
	}

	target := 0
	if c.navLevel == target {
		target = 1
	}
	c.form.Nivel = strconv.Itoa(target)
	body, env, err := c.postValueChange(ctx, "pt1:r1:0:soc1")
	if err != nil {
		return nil, err
	}
	if isNoop(body) {
		return nil, newNoopError(body)
	}
	c.navLevel = target
	c.navCampus, c.navFaculty = -1, -1
	c.parked = false // soc1 wipes the downstream dropdowns

	html, ok := env["pt1:r1:0:soc1"]
	if !ok {
		return nil, fmt.Errorf("sia: FetchLevels: no update id=%q in response", "pt1:r1:0:soc1")
	}
	return parseLabelOptionsHTML(html)
}

// FetchCampuses returns the soc9 dropdown — the sedes — for one level. The
// soc1 valueChange response carries a fresh <update id="pt1:r1:0:soc9">
// alongside soc2/soc3/soc4 (verified against the live server), so this is
// one POST, two when the connection is already sitting on `level` and has to
// bounce through another one to force a genuine change (GOTCHAS §30).
//
// The bootstrap page also carries the full soc9 list, but re-GETting it to
// read a dropdown would cost up to 4.5 MB and reset the connection's whole
// navigation state. One valueChange is cheaper.
func (c *SIAConn) FetchCampuses(ctx context.Context, level int) ([]Option, error) {
	if c.DetailRegion != 0 {
		return nil, fmt.Errorf("sia: FetchCampuses: connection is in detail region %d, call Volver first: %w", c.DetailRegion, errStaleDetailRegion)
	}

	if c.navLevel == level {
		bounce := 1
		if level == 1 {
			bounce = 0
		}
		c.form.Nivel = strconv.Itoa(bounce)
		if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc1"); err != nil {
			return nil, err
		} else if isNoop(body) {
			return nil, newNoopError(body)
		}
		c.navLevel = bounce
		c.navCampus, c.navFaculty = -1, -1
		c.parked = false
	}

	c.form.Nivel = strconv.Itoa(level)
	body, env, err := c.postValueChange(ctx, "pt1:r1:0:soc1")
	if err != nil {
		return nil, err
	}
	if isNoop(body) {
		return nil, newNoopError(body)
	}
	c.navLevel = level
	c.navCampus, c.navFaculty = -1, -1
	c.parked = false // soc1 wipes the downstream dropdowns

	html, ok := env["pt1:r1:0:soc9"]
	if !ok {
		return nil, fmt.Errorf("sia: FetchCampuses: no update id=%q in response", "pt1:r1:0:soc9")
	}
	return parseOptionsHTML(html)
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
		return nil, nil, fmt.Errorf("sia: FetchProgramDirectory: connection is in detail region %d, call Volver first: %w", c.DetailRegion, errStaleDetailRegion)
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
			// A campus with a single faculty would have no alternative to
			// bounce through and would noop here; none of the nine sedes
			// is in that shape (the smallest, Amazonia, has 5).
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

	// The connection may still be sitting in the ELECTIVES search from an
	// earlier FetchElectives: soc4=7, plus soc5/soc10/soc6 set. Clicking cb1
	// in that state answers with a no-op.
	//
	// Setting c.form.Tipologia alone does not fix it — that only changes what
	// the next POST carries, not the server's own state, and a parked
	// connection skips every valueChange in gotoProgram. It needs a real
	// change posted to soc4. Skipped when already there, like gotoProgram:
	// the response is not consumed, only its side effect.
	if c.navTipologia != TypologyAll {
		c.form.Tipologia = TypologyAll
		if body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc4"); err != nil {
			return nil, err
		} else if isNoop(body) {
			return nil, newNoopError(body)
		}
		c.navTipologia = TypologyAll
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
// listing. campus-wide because soc6 has a per-sede faculty wildcard — there
// is no per-program equivalent (PROTOCOL.md §5). Skipping soc10 before soc6
// produces silent garbage (GOTCHAS §5 of PROTOCOL.md); this always runs both.
//
// soc4 and soc5 post the same value on every call, and soc10/soc6 repeat
// whenever two consecutive requests target the same sede — so the second
// time a pooled connection is reused they would repost unchanged and noop
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
	_, env, err := c.postValueChangeFresh(ctx, "pt1:r1:0:soc10", &c.navSedeElect,
		sedeElect, sedeElectAlt, func(v string) { c.form.SedeElect = v })
	if err != nil {
		return nil, err
	}

	// soc10's response carries the sede's own soc6 list. The wildcard's
	// position is read from it, never assumed — see campusWildcardPrefix.
	wildcard, alt, err := electivesWildcard(env)
	if err != nil {
		return nil, err
	}
	if _, _, err := c.postValueChangeFresh(ctx, "pt1:r1:0:soc6", &c.navFacElect,
		wildcard, alt, func(v string) { c.form.FacElect = v }); err != nil {
		return nil, err
	}

	body, _, err := c.postAction(ctx, "pt1:r1:0:cb1", "")
	if err != nil {
		return nil, err
	}
	if isNoop(body) {
		return nil, newNoopError(body)
	}

	// NOTE: soc4 is deliberately NOT reset here. Writing c.form.Tipologia
	// would only change what the next POST carries while the SERVER stays in
	// the electives search — the exact mismatch that made a later
	// FetchCatalog no-op. FetchCatalog now posts the real change itself, and
	// navTipologia keeps saying the truth: this connection is on soc4=7.

	return body, nil
}

// electivesWildcard finds the "whole sede" option in the soc6 list a soc10
// response just rendered, and a different option to bounce through when the
// connection already sits on it (GOTCHAS §30). Both are positions in THIS
// sede's list, so both are read from THIS response.
func electivesWildcard(env map[string]string) (wildcard, alt string, err error) {
	html, ok := env["pt1:r1:0:soc6"]
	if !ok {
		return "", "", fmt.Errorf("sia: FetchElectives: no update id=%q in the soc10 response", "pt1:r1:0:soc6")
	}
	opts, err := parseOptionsHTML(html)
	if err != nil {
		return "", "", err
	}
	idx := -1
	for _, o := range opts {
		if strings.HasPrefix(o.Name, campusWildcardPrefix) {
			idx = o.Index
			break
		}
	}
	if idx == -1 {
		return "", "", fmt.Errorf("sia: FetchElectives: no %q wildcard among %d soc6 options", campusWildcardPrefix, len(opts))
	}
	for _, o := range opts {
		if o.Index != idx {
			return strconv.Itoa(idx), strconv.Itoa(o.Index), nil
		}
	}
	return "", "", fmt.Errorf("sia: FetchElectives: soc6 has only the wildcard, no option to bounce through")
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
		return nil, 0, fmt.Errorf("sia: FetchDetail: already in detail region %d, call Volver first: %w", c.DetailRegion, errStaleDetailRegion)
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
