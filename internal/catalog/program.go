package catalog

import (
	"fmt"
	"time"
)

type Program struct {
	ID int64 `db:"id" json:"-"`

	// Public identity: institutional codes, parsed off the dropdown labels.
	// '1101 SEDE BOGOTÁ' / '2055 FACULTAD DE INGENIERÍA' / '2A74 INGENIERÍA ...'
	CampusCode  string `db:"campus_code"  json:"campus_code"`
	FacultyCode string `db:"faculty_code" json:"faculty_code"`
	Code        string `db:"code"         json:"code"`

	// LevelSlug is identity — the directory is cached per (campus, level) and
	// must be readable per level. LevelIdx below is only how the SIA navigates.
	LevelSlug   string `db:"level_slug"   json:"level"`
	Name        string `db:"name"         json:"name"`
	CampusName  string `db:"campus_name"  json:"campus_name"`
	FacultyName string `db:"faculty_name" json:"faculty_name"`

	CatalogFetchedAt *time.Time `db:"catalog_fetched_at" json:"catalog_fetched_at,omitempty"`

	// Navigation coordinate: positional dropdown indices. VOLATILE. Never
	// serialized, never an identity. Revalidated against the label before use.
	LevelIdx   int `db:"level_idx"   json:"-"`
	CampusIdx  int `db:"campus_idx"  json:"-"`
	FacultyIdx int `db:"faculty_idx" json:"-"`
	ProgramIdx int `db:"program_idx" json:"-"`
}

// PublicID is what appears in URLs: "2A74". NOT unique on its own — 136 of
// 852 codes repeat across sedes (PEAMA) and 46 repeat within a sede across
// faculties. See GOTCHAS.md §26 and ProgramRef.
func (p Program) PublicID() string { return p.Code }

// ProgramRef is how a caller names a program: the institutional identity
// (campus, faculty, code) that program's UNIQUE constraint mirrors, plus the
// level whose directory to consult.
//
// Campus and Faculty may be empty. That is not an invalid request — it is an
// under-specified one, and the answer is either a single match or a 300 with
// the candidates. Never a silent narrowing to some default sede.
type ProgramRef struct {
	Campus  string // '1101'; empty = search every cached campus, fetch none
	Faculty string // '2055'; empty = any faculty
	Code    string // '2A74'
	Level   string // slug; empty = DefaultLevelSlug
}

// ProgramKey is the navigation coordinate inside SIA: "0-2-8-3". Positional
// dropdown indices — volatile, derived from a Program at use time, never
// stored as its identity.
//
// CampusCode rides along even though it is not a coordinate: everything a
// fetch produces gets stamped with it, and the alternative was an
// index→code table compiled into the sia adapter. That table is data the SIA
// owns and can reorder (GOTCHAS §26), so it belongs in the campus cache, not
// in a var block.
type ProgramKey struct {
	Level, Campus, Faculty, Program int
	CampusCode                      string
}

func (k ProgramKey) String() string {
	return fmt.Sprintf("%d-%d-%d-%d", k.Level, k.Campus, k.Faculty, k.Program)
}

// Level is one soc1 option, cached like every other reference list.
//
// Unlike every other dropdown, soc1's labels carry no institutional code
// ("Pregrado", not "1101 SEDE BOGOTÁ"), so there is nothing to split an
// identity out of. Slug is that identity: ours, published in docs/API.md,
// and assigned once — never rewritten from a re-render, because the only
// other candidate is Index, and Index is volatile (GOTCHAS §26).
type Level struct {
	Slug string `db:"slug" json:"slug"` // 'pregrado'
	Name string `db:"name" json:"name"` // 'Pregrado'

	// soc1 position. VOLATILE — navigation coordinate, never an identity.
	Index int `db:"level_idx" json:"-"`
}

// Campus is one sede, as read from the soc9 dropdown and cached like every
// other reference list. It replaces the hardcoded enum this type used to be:
// the sede list is data the SIA owns (SEDE DE LA PAZ is recent), so a rename
// or an addition must not need a redeploy.
type Campus struct {
	// LevelSlug, not the soc1 index: this is half the primary key, so it is
	// identity, and identity is never positional.
	LevelSlug string `db:"level_slug" json:"-"`
	Code      string `db:"code"       json:"code"` // '1101'
	Name      string `db:"name"       json:"name"` // 'SEDE BOGOTÁ'

	// soc9 position. VOLATILE — navigation coordinate, never an identity
	// and never in a URL. Same rule as Program's *Idx fields.
	Index int `db:"campus_idx" json:"-"`
}
