package catalog

import (
	"strings"
	"time"
)

// CourseRef names one course to fetch the detail of, together with the
// program to fetch it FROM. The detail POST is always made from some plan's
// viewpoint (section_program visibility, DATA-MODEL.md decision 6), so a
// course on its own is not a fetchable unit.
//
// Name rides along because the listing filter (it11) matches on it: with the
// name, findRow narrows the ~241 KB cb1 to 15–27 KB, which is the factor of
// 4 in bandwidth that pays for fase 2. Empty Name simply means no filter.
type CourseRef struct {
	ProgramID int64
	Code      string
	Name      string

	// Typology is this plan's typology for the course, straight from
	// course_program. It exists for one reason: a libre elección course can
	// ONLY be found in the electives listing (soc4=0 means "todas menos
	// libre elección" — GOTCHAS §21), so searching the regular listing first
	// is 2-3 POSTs and a whole listing of bytes that cannot possibly contain
	// it. Measured 2026-08-22: 43% of the hot set is libre elección, and a
	// course of that kind costs ~10.6 POSTs against the 3.7 of a regular one.
	Typology string

	// HadSections is whether the cache already holds groups for this course.
	// It is what separates the two ways a sweep can see "0 grupos": a sede
	// with nothing scheduled this term (legitimate, and it is what SEDE DE LA
	// PAZ looks like — measured 2026-08-17) from groups that used to be there
	// and stopped parsing, which is the ×135 000 failure of docs/FASE-2.md
	// paso 5. Only the second one may abort a sweep.
	HadSections bool
}

// IsElective reports whether a typology means the course lives in the
// electives listing rather than the regular one. The vocabulary is the
// SIA's and it varies by level and sede — these are the values actually
// present in production (2026-08-22), not a guess. A typology this does
// not recognise falls back to the old order (regular first), which is
// slower but never wrong.
func IsElective(typology string) bool {
	switch {
	case strings.HasPrefix(typology, "LIBRE ELECCIÓN"),
		strings.HasPrefix(typology, "ELEGIBLES"),
		strings.HasPrefix(typology, "ELECTIVA"):
		return true
	}
	return false
}

// RefreshRun is one Refresher sweep, as recorded for /v1/status. It is
// observability, NOT a checkpoint: the job never asks "where was I", it asks
// "what is still stale" (docs/FASE-2.md "El checkpoint ya existe").
type RefreshRun struct {
	ID              int64      `json:"-"`
	Mode            string     `json:"mode"`
	Scope           string     `json:"scope,omitempty"`
	StartedAt       time.Time  `json:"started_at"`
	FinishedAt      *time.Time `json:"finished_at,omitempty"`
	ProgramsOK      int        `json:"programs_ok"`
	ProgramsFailed  int        `json:"programs_failed"`
	ProgramsSkipped int        `json:"programs_skipped"`
	CoursesOK       int        `json:"courses_ok"`
	Posts           int64      `json:"posts"`
	Bytes           int64      `json:"bytes"`
	EndedReason     string     `json:"ended_reason,omitempty"`
}
