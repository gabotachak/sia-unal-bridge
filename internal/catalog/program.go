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

	Level       int    `db:"level"        json:"-"`
	Name        string `db:"name"         json:"name"`
	CampusName  string `db:"campus_name"  json:"campus_name"`
	FacultyName string `db:"faculty_name" json:"faculty_name"`

	CatalogFetchedAt *time.Time `db:"catalog_fetched_at" json:"catalog_fetched_at,omitempty"`

	// Navigation coordinate: positional dropdown indices. VOLATILE. Never
	// serialized, never an identity. Revalidated against the label before use.
	CampusIdx  int `db:"campus_idx"  json:"-"`
	FacultyIdx int `db:"faculty_idx" json:"-"`
	ProgramIdx int `db:"program_idx" json:"-"`
}

// PublicID is what appears in URLs: "2A74". NOT unique across campuses — 136
// of 852 codes repeat (PEAMA). Unqualified only while the scope is a single
// campus (fase 1: Bogotá). See GOTCHAS.md §26.
func (p Program) PublicID() string { return p.Code }

// ProgramKey is the navigation coordinate inside SIA: "0-2-8-3". Positional
// dropdown indices — volatile, derived from a Program at use time, never
// stored as its identity.
type ProgramKey struct{ Level, Campus, Faculty, Program int }

func (k ProgramKey) String() string {
	return fmt.Sprintf("%d-%d-%d-%d", k.Level, k.Campus, k.Faculty, k.Program)
}

// Level enum for soc1. Fase 1 scope: LevelUndergrad only.
type Level int

const (
	LevelUndergrad Level = iota // pregrado
	LevelDoctorate              // doctorado
	LevelGraduate               // posgrado / máster
)

// Campus enum for soc9/soc10. Fase 1 scope: CampusBogota only.
type Campus int

const (
	CampusAmazonia Campus = iota + 1
	CampusBogota
	CampusCaribe
	CampusDeLaPaz
	CampusManizales
	CampusMedellin
	CampusOrinoquia
	CampusPalmira
	CampusTumaco
)
