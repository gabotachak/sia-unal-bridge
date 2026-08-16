package sia

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// Row is one row of the SIA's course-listing table: an OFFERING, not a
// course. Codes repeat — up to ×7 in the electives search, GOTCHAS §13 — so
// (code alone) is never an identity. See DedupeByCode.
type Row struct {
	RowKey      string // _afrRK, valid ONLY for the response it was parsed from. GOTCHAS §4.
	Code        string
	Name        string
	Credits     int
	Typology    string // raw listing vocabulary, e.g. 'FUND. OBLIGATORIA (B)'. GOTCHAS §17.
	Description string
}

// ParseList parses the <update id="pt1:r1:0:pb3"> table out of a raw
// <partial-response> body. One Row per <tr role="row">, in document order,
// NOT deduplicated — this must equal the literal <tr> count, never
// _rowCount (GOTCHAS §5). Feeding it a bootstrap page (not a
// partial-response) fails cleanly with zero rows — GOTCHAS §22, never parse
// the bootstrap's table.
func ParseList(raw []byte) ([]Row, error) {
	env, err := ParseEnvelope(raw)
	if err != nil {
		return nil, fmt.Errorf("sia: ParseList: %w", err)
	}
	// A plain cb1 search wraps the table narrowly under "pt1:r1:0:pb3".
	// Volver's response re-renders the WHOLE region-0 panel and wraps it
	// under the broader "pt1:r1" instead — same table markup, different
	// envelope id. Prefer the narrow id; fall back to whichever update
	// actually contains row markup.
	table, ok := env["pt1:r1:0:pb3"]
	if !ok {
		for _, v := range env {
			if strings.Contains(v, `_afrRK=`) {
				table = v
				ok = true
				break
			}
		}
	}
	if !ok {
		return nil, fmt.Errorf("sia: ParseList: no update with a results table in response")
	}

	doc, err := goquery.NewDocumentFromReader(strings.NewReader(table))
	if err != nil {
		return nil, fmt.Errorf("sia: ParseList: parse table html: %w", err)
	}

	var rows []Row
	doc.Find(`tr[role="row"]`).Each(func(_ int, tr *goquery.Selection) {
		// The HTML5 tokenizer lowercases attribute names, so the mixed-case
		// _afrRK from the wire shows up here as _afrrk.
		rk, hasRK := tr.Attr("_afrrk")
		if !hasRK {
			return
		}
		code := strings.TrimSpace(tr.Find(`td[id$=":c1"] a`).First().Text())
		if code == "" {
			return // header/footer row or malformed — not a data row
		}
		name := strings.TrimSpace(tr.Find(`td[id$=":c2"]`).First().Text())
		creditsText := strings.TrimSpace(tr.Find(`td[id$=":c5"] span`).First().Text())
		typology := strings.TrimSpace(tr.Find(`td[id$=":c6"] span`).First().Text())
		description := strings.TrimSpace(tr.Find(`td[id$=":c8"] span`).First().Text())

		credits, _ := strconv.Atoi(creditsText) // non-numeric (rare) -> 0, not an error

		rows = append(rows, Row{
			RowKey:      rk,
			Code:        code,
			Name:        name,
			Credits:     credits,
			Typology:    typology,
			Description: description,
		})
	})
	return rows, nil
}

// DedupeByCode drops repeated codes, keeping the first occurrence. Safe:
// duplicate rows within the same response have byte-identical detail
// (verified sha256, GOTCHAS §13) — they're the same course offered under
// several plans, not distinct groups. NOT safe across two different
// responses fetched at different times.
func DedupeByCode(rows []Row) []Row {
	seen := make(map[string]bool, len(rows))
	out := make([]Row, 0, len(rows))
	for _, r := range rows {
		if seen[r.Code] {
			continue
		}
		seen[r.Code] = true
		out = append(out, r)
	}
	return out
}
