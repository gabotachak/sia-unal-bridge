package sia

import (
	"regexp"
	"strings"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

var weekdayNames = map[string]time.Weekday{
	"LUNES":     time.Monday,
	"MARTES":    time.Tuesday,
	"MIÉRCOLES": time.Wednesday,
	"MIERCOLES": time.Wednesday,
	"JUEVES":    time.Thursday,
	"VIERNES":   time.Friday,
	"SÁBADO":    time.Saturday,
	"SABADO":    time.Saturday,
	"DOMINGO":   time.Sunday,
}

// weekdayLineRe matches 'MIÉRCOLES de 09:00 a 11:00.' verbatim (PROTOCOL.md §9).
var weekdayLineRe = regexp.MustCompile(`(LUNES|MARTES|MI[EÉ]RCOLES|JUEVES|VIERNES|S[AÁ]BADO|DOMINGO)\s+de\s+(\d{2}:\d{2})\s+a\s+(\d{2}:\d{2})\.`)

// buildingRe matches '453 - Guillermina Uribe Bone.' — a 3-digit building
// code, a LITERAL space-dash-space, and a name, terminated by a period.
// FIELDS.md "Edificio". The spaces are load-bearing: room codes look like
// '453-203' (no spaces around the dash) and appear earlier in the same
// blob — `\s*` instead of a literal space matches the room code by
// accident and leaves the real building text stuck in Room. Verified
// against a live capture (2026-08-15): with `\s*` this produced
// building="453-203", room="SALA DE INFORMATICA" for a session whose real
// building was "453 - Guillermina Uribe Bone".
var buildingRe = regexp.MustCompile(`(\d{3} - [^.\n]+)\.`)

// parseSchedule extracts one ClassSession per weekday line inside a group's
// text block. Room/building parsing is best-effort: the source repeats the
// room code and appends a category word (SALON, AUDITORIO...) with no
// stable delimiter, so Room keeps everything before the building match.
func parseSchedule(block string) []catalog.ClassSession {
	locs := weekdayLineRe.FindAllStringSubmatchIndex(block, -1)
	if locs == nil {
		return nil
	}
	sessions := make([]catalog.ClassSession, 0, len(locs))
	for i, loc := range locs {
		day := block[loc[2]:loc[3]]
		start := block[loc[4]:loc[5]]
		end := block[loc[6]:loc[7]]

		blobEnd := len(block)
		if i+1 < len(locs) {
			blobEnd = locs[i+1][0]
		} else if di := strings.Index(block[loc[1]:], "Duración:"); di >= 0 {
			blobEnd = loc[1] + di
		}
		blob := block[loc[1]:blobEnd]

		wd, ok := weekdayNames[day]
		if !ok {
			continue
		}

		var room, building string
		if bm := buildingRe.FindStringIndex(blob); bm != nil {
			building = strings.TrimSpace(blob[bm[0] : bm[1]-1]) // drop trailing '.'
			room = strings.Trim(strings.TrimSpace(blob[:bm[0]]), ". ")
		} else {
			room = strings.Trim(strings.TrimSpace(blob), ". ")
		}

		sessions = append(sessions, catalog.ClassSession{
			Weekday:   wd,
			StartTime: start,
			EndTime:   end,
			Room:      room,
			Building:  building,
		})
	}
	return sessions
}
