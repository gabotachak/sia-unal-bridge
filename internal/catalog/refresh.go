package catalog

import "time"

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

	// HadSections is whether the cache already holds groups for this course.
	// It is what separates the two ways a sweep can see "0 grupos": a sede
	// with nothing scheduled this term (legitimate, and it is what SEDE DE LA
	// PAZ looks like — measured 2026-08-17) from groups that used to be there
	// and stopped parsing, which is the ×135 000 failure of docs/FASE-2.md
	// paso 5. Only the second one may abort a sweep.
	HadSections bool
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
