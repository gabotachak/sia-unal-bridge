package sia

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// Detail is one course's detail page, parsed as plain text after stripping
// tags — LAYOUT.md "goquery solo para el listado". Sections is the group
// list; ProgramName/ProgramFaculty are the context the detail was fetched
// from, not part of the persisted schema.
type Detail struct {
	Code string

	// HeaderCode is the code the DETAIL page itself printed, next to the
	// name: "Álgebra Lineal (1000003-B)". It is the only self-describing
	// field in the whole response, so it is the only way to notice that this
	// detail belongs to a different course than the one we clicked — the
	// silent shape of GOTCHAS §28 (cross-talk on a shared connection) and of
	// a stale _afrRK (§4). Empty when the header did not parse.
	HeaderCode string

	Name           string
	Typology       string // detail vocabulary, e.g. 'ELEGIBLES' — differs from the listing's. GOTCHAS §17.
	Credits        int
	ProgramName    string
	ProgramFaculty string
	Sections       []catalog.Section
	Prerequisites  []catalog.Prerequisite
}

var headerRe = regexp.MustCompile(`Imprimir(.+?)\(([^()\n]+)\)\s*Tipolog[ií]a:\s*(.*?)Cr[eé]ditos:\s*(\d+)(.*?)Facultad:\s*([^\n]*)`)

// groupHeaderRe delimits a group block. Tolerant to PEAMA variants — GOTCHAS
// §24. It also matches the leading component code that sits right before
// the FIRST group's header (e.g. "(21000004) (10) Grupo 10"); extractGroupKey
// resolves that by taking the LAST parenthesised token before "Grupo".
var groupHeaderRe = regexp.MustCompile(`\([^)\n]{1,20}\)[^\n]{0,60}?Grupo\s*\S+`)

var (
	profesorRe = regexp.MustCompile(`Profesor:\s*(.*?)Facultad:`)
	facultadRe = regexp.MustCompile(`Facultad:\s*(.*?)(?:Horarios/Aula:|Duraci[oó]n:)`)
	fechaRe    = regexp.MustCompile(`Fecha:\s*(\d{2}/\d{2}/\d{4})\s*-\s*(\d{2}/\d{2}/\d{4})`)
	duracionRe = regexp.MustCompile(`Duraci[oó]n:\s*(.*?)Jornada:`)
	jornadaRe  = regexp.MustCompile(`Jornada:\s*(.*?)Cupos disponibles:`)
	cuposRe    = regexp.MustCompile(`Cupos disponibles:\s*(\d+)`)
	numberRe   = regexp.MustCompile(`Grupo\s*(\d+)`)
	siteRe     = regexp.MustCompile(`^([A-Z]+)-\d+$`)

	prereqCondRe = regexp.MustCompile(`Condici[oó]n\s*(\d+)Tipo\s*(\w)`)
	prereqMetaRe = regexp.MustCompile(`¿Todas\?\s*\[[SN]?\]N[uú]mero asignaturas\s*\[\d*\]`)
	courseCodeRe = regexp.MustCompile(`\d{6,7}(?:-[A-Z])?`)
)

const prereqLegend = "Tipo de prerrequisito implica"

// ParseDetailText strips tags from the largest <update> block in a detail
// response (the detail markup isn't under a fixed id like the list's pb3;
// it's the region's whole content). Never call this on a list response.
func ParseDetailText(raw []byte) (string, error) {
	env, err := ParseEnvelope(raw)
	if err != nil {
		return "", fmt.Errorf("sia: ParseDetailText: %w", err)
	}
	var html string
	for _, v := range env {
		if len(v) > len(html) {
			html = v
		}
	}
	if html == "" {
		return "", fmt.Errorf("sia: ParseDetailText: empty response")
	}
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return "", fmt.Errorf("sia: ParseDetailText: parse html: %w", err)
	}
	return doc.Text(), nil
}

// ParseDetail parses a course detail: header, groups (0 or more — GOTCHAS
// §18), and prerequisites if present. campusCode/code/term are stamped onto
// each Section since the plain-text body doesn't repeat them per group.
func ParseDetail(raw []byte, campusCode, code, term string) (Detail, error) {
	text, err := ParseDetailText(raw)
	if err != nil {
		return Detail{}, err
	}

	d := Detail{Code: code}
	if m := headerRe.FindStringSubmatch(text); m != nil {
		d.Name = strings.TrimSpace(m[1])
		d.HeaderCode = strings.TrimSpace(m[2])
		d.Typology = strings.TrimSpace(m[3])
		if n, err := strconv.Atoi(m[4]); err == nil {
			d.Credits = n
		}
		d.ProgramName = strings.TrimSpace(m[5])
		d.ProgramFaculty = strings.TrimSpace(m[6])
	}

	prereqStart := strings.Index(text, "Prerrequisitos")
	groupsEnd := len(text)
	if prereqStart >= 0 {
		groupsEnd = prereqStart
	}

	locs := groupHeaderRe.FindAllStringIndex(text[:groupsEnd], -1)
	sections := make([]catalog.Section, 0, len(locs))
	for i, loc := range locs {
		blockEnd := groupsEnd
		if i+1 < len(locs) {
			blockEnd = locs[i+1][0]
		}
		header := text[loc[0]:loc[1]]
		body := text[loc[1]:blockEnd]
		sections = append(sections, parseSection(header, body, campusCode, code, term))
	}
	d.Sections = sections

	if prereqStart >= 0 {
		d.Prerequisites = parsePrerequisites(text[prereqStart:])
	}

	return d, nil
}

// extractGroupKey isolates the LAST parenthesised token before "Grupo" in a
// matched header, so the component code that sometimes precedes the first
// group ("(21000004) (10) Grupo 10") doesn't get mistaken for the key.
func extractGroupKey(header string) (key, rest string) {
	gi := strings.Index(header, "Grupo")
	if gi < 0 {
		return "", header
	}
	open := strings.LastIndex(header[:gi], "(")
	if open < 0 {
		return "", header[gi:]
	}
	closeRel := strings.Index(header[open:], ")")
	if closeRel < 0 {
		return "", header[gi:]
	}
	key = header[open+1 : open+closeRel]
	rest = strings.TrimSpace(header[open:])
	return key, rest
}

func parseSection(header, body, campusCode, code, term string) catalog.Section {
	key, label := extractGroupKey(header)

	s := catalog.Section{
		CampusCode: campusCode,
		Code:       code,
		Term:       term,
		Key:        key,
		Label:      label,
	}

	if m := numberRe.FindStringSubmatch(label); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			s.Number = n
		}
	}
	if m := siteRe.FindStringSubmatch(key); m != nil {
		s.Site = m[1]
	}

	if m := profesorRe.FindStringSubmatch(body); m != nil {
		instr := strings.TrimSpace(m[1])
		if instr != "" && instr != "No informado" {
			s.Instructor = instr
		}
	}
	if m := facultadRe.FindStringSubmatch(body); m != nil {
		s.SiteCampus = strings.TrimSpace(m[1])
	}
	if m := duracionRe.FindStringSubmatch(body); m != nil {
		s.Duration = strings.TrimSpace(m[1])
	}
	if m := jornadaRe.FindStringSubmatch(body); m != nil {
		s.Shift = strings.TrimSpace(m[1])
	}
	if m := fechaRe.FindStringSubmatch(body); m != nil {
		if start, err := time.Parse("02/01/2006", m[1]); err == nil {
			s.StartDate = &start
		}
		if end, err := time.Parse("02/01/2006", m[2]); err == nil {
			s.EndDate = &end
		}
	}
	s.Schedule = parseSchedule(body)
	now := time.Now()
	s.FetchedAt = now

	if m := cuposRe.FindStringSubmatch(body); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			s.Seats = &catalog.SeatSnapshot{Available: n, MeasuredAt: now}
		}
	}

	return s
}

// parsePrerequisites extracts (condition, type, code, name) tuples. Best
// effort — extraction is required, persistence is not (fase 1 scope,
// docs/PLAN.md).
func parsePrerequisites(block string) []catalog.Prerequisite {
	if li := strings.Index(block, prereqLegend); li >= 0 {
		block = block[:li]
	}

	condLocs := prereqCondRe.FindAllStringSubmatchIndex(block, -1)
	var out []catalog.Prerequisite
	for i, loc := range condLocs {
		condNum, _ := strconv.Atoi(block[loc[2]:loc[3]])
		typ := block[loc[4]:loc[5]]

		segEnd := len(block)
		if i+1 < len(condLocs) {
			segEnd = condLocs[i+1][0]
		}
		seg := block[loc[1]:segEnd]
		seg = prereqMetaRe.ReplaceAllString(seg, "")

		codeLocs := courseCodeRe.FindAllStringIndex(seg, -1)
		for j, cl := range codeLocs {
			nameEnd := len(seg)
			if j+1 < len(codeLocs) {
				nameEnd = codeLocs[j+1][0]
			}
			out = append(out, catalog.Prerequisite{
				Condition: condNum,
				Type:      typ,
				Code:      seg[cl[0]:cl[1]],
				Name:      strings.TrimSpace(seg[cl[1]:nameEnd]),
			})
		}
	}
	return out
}
