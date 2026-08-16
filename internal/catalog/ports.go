package catalog

import (
	"context"
	"time"
)

// CourseOffering pairs a Course with the typology it has under the program
// the fetch was made from. Typology lives in course_program, not course —
// it's relative to the plan (decision 1, DATA-MODEL.md).
type CourseOffering struct {
	Course   Course
	Typology string

	// Seats is the stored seat total across the groups this program sees.
	// nil = nunca se pidió el detalle de esta asignatura desde este plan.
	Seats *CourseSeats
}

// DropdownOption is one <option> of a cascade dropdown: Index is SIA's
// volatile positional value, Code/Name are the institutional identity
// parsed off the label (DATA-MODEL.md decision 7). Never store Index as an
// identity — see GOTCHAS §26.
type DropdownOption struct {
	Index int
	Code  string
	Name  string
}

// LabelOption is a dropdown option with no institutional code in its label —
// soc1 alone. Turning a Label into a stable public ID is Service's job (see
// Level.Slug), never the adapter's.
type LabelOption struct {
	Index int
	Label string
}

// SIASource is the driven port for everything that talks to the real SIA.
// Implemented by internal/sia against the ADF protocol.
type SIASource interface {
	// FetchLevels returns the soc1 dropdown: the niveles de estudio. Their
	// labels carry no institutional code, hence LabelOption.
	FetchLevels(ctx context.Context) ([]LabelOption, error)

	// FetchCampuses returns the soc9 dropdown for a level: the sedes, with
	// their institutional code parsed off the label. Cheapest cascade there
	// is — one valueChange on soc1.
	FetchCampuses(ctx context.Context, level int) ([]DropdownOption, error)

	// FetchProgramDirectory serves the reference endpoints: every faculty of
	// (level, campusIdx) and every program under each. A miss is cheap and
	// bounded — part of the bootstrap you pay anyway — unlike the full
	// 1380-entry census (that's Refresher, fase 2). docs/API.md.
	FetchProgramDirectory(ctx context.Context, level, campusIdx int) (faculties []DropdownOption, programsByFaculty map[int][]DropdownOption, err error)

	// FetchCatalog runs the regular listing for a program: soc4=0, "todas
	// menos libre elección". GOTCHAS §21.
	FetchCatalog(ctx context.Context, key ProgramKey) ([]CourseOffering, error)

	// FetchElectives runs the campus-wide electives search for a program's
	// campus. This is the OTHER half of a program's catalog.
	FetchElectives(ctx context.Context, key ProgramKey) ([]CourseOffering, error)

	// FetchDetail fetches one course's groups from the program's viewpoint.
	// The returned Course has Sections populated; Code/Name/Credits/
	// Description come from the detail header, not the listing.
	FetchDetail(ctx context.Context, key ProgramKey, code, term string) (CourseOffering, error)
}

// Store is the driven port for Postgres persistence and cache reads.
type Store interface {
	// Reference. ReferenceFetchedAt is the 30 d TTL marker keyed by scope
	// (docs/API.md "Frescura"); the Upsert* writes stamp it in the same
	// transaction. Without it every campus/faculty/program read walks the
	// live cascade instead of the cache.
	UpsertProgram(ctx context.Context, p Program) (Program, error)
	Program(ctx context.Context, campusCode, facultyCode, code string) (Program, bool, error)
	Programs(ctx context.Context, campusCode, facultyCode, levelSlug string) ([]Program, error)
	Campuses(ctx context.Context, levelSlug string) ([]Campus, error)
	Levels(ctx context.Context) ([]Level, error)
	ReferenceFetchedAt(ctx context.Context, scope string) (*time.Time, error)
	UpsertPrograms(ctx context.Context, scope string, programs []Program) error
	UpsertCampuses(ctx context.Context, scope string, campuses []Campus) error

	// UpsertLevels matches on Name and must never rewrite an existing
	// slug — see Level.
	UpsertLevels(ctx context.Context, scope string, levels []Level) error

	// Catalog — program granularity. UpsertCatalog writes BOTH halves
	// (regular + electives) in one transaction and stamps
	// program.catalog_fetched_at only when both are present.
	UpsertCatalog(ctx context.Context, program Program, offerings []CourseOffering) error
	ProgramCourses(ctx context.Context, programID int64) ([]CourseOffering, error)

	// Detail — course granularity, scoped by program (section_program
	// visibility, decision 2/6 in DATA-MODEL.md).
	Course(ctx context.Context, campusCode, code string) (Course, bool, error)
	CourseProgramFetchedAt(ctx context.Context, programID int64, code string) (*time.Time, bool, error)
	CourseProgramTypology(ctx context.Context, programID int64, code string) (string, bool, error)
	UpsertDetail(ctx context.Context, programID int64, offering CourseOffering) error
	Sections(ctx context.Context, campusCode, code string, programID int64) ([]Section, error)
	CurrentSeats(ctx context.Context, sectionID int64) (SeatSnapshot, bool, error)

	// Shortcuts — served from Store only, never trigger a SIA fetch
	// (docs/API.md "Por qué la búsqueda global no dispara al SIA").
	ProgramsOfferingCourse(ctx context.Context, campusCode, code string) ([]Program, error)
	SearchCourses(ctx context.Context, campusCode, q string) ([]Course, error)
	ProgramCoverage(ctx context.Context, campusCode string) (known, withCatalog int, err error)
}
