package catalog

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/sync/singleflight"
)

// Fase 1 scope pin: Bogotá, pregrado. See docs/ARCH.md "Alcance".
const (
	BogotaCampusIdx  = 2
	BogotaCampusCode = "1101"
	BogotaCampusName = "SEDE BOGOTÁ"
	UndergradLevel   = 0
)

// Service is the read-through orchestrator: Store first, SIASource on a
// stale/missing cache, respond, persist. docs/ARCH.md "Flujo principal".
type Service struct {
	store Store
	sia   SIASource
	term  string // current term stamped on fetched sections, e.g. "2026-2"

	sfCatalog singleflight.Group // key: program.ID
	sfDetail  singleflight.Group // key: "programID:code" — docs/API.md "Singleflight por clave de fetch"
}

func NewService(store Store, sia SIASource, term string) *Service {
	return &Service{store: store, sia: sia, term: term}
}

// ResolveProgram looks up a program by its institutional code within
// Bogotá. A store miss walks the faculty→program cascade live — bounded to
// ~13 faculties, "barata y acotada" per docs/API.md, never the full
// 1380-entry census (that's Refresher, fase 2).
func (s *Service) ResolveProgram(ctx context.Context, code string) (Program, error) {
	cached, err := s.store.Programs(ctx, BogotaCampusCode, "")
	if err != nil {
		return Program{}, err
	}
	for _, p := range cached {
		if p.Code == code {
			return p, nil
		}
	}

	faculties, programsByFaculty, err := s.sia.FetchProgramDirectory(ctx, UndergradLevel, BogotaCampusIdx)
	if err != nil {
		return Program{}, err
	}
	for _, fac := range faculties {
		for _, po := range programsByFaculty[fac.Index] {
			if po.Code != code {
				continue
			}
			p := Program{
				CampusCode: BogotaCampusCode, FacultyCode: fac.Code, Code: po.Code,
				Level: UndergradLevel, Name: po.Name, CampusName: BogotaCampusName, FacultyName: fac.Name,
				CampusIdx: BogotaCampusIdx, FacultyIdx: fac.Index, ProgramIdx: po.Index,
			}
			return s.store.UpsertProgram(ctx, p)
		}
	}
	return Program{}, ErrNotFound
}

func (p Program) key() ProgramKey {
	return ProgramKey{Level: p.Level, Campus: p.CampusIdx, Faculty: p.FacultyIdx, Program: p.ProgramIdx}
}

// Faculties lists Bogotá's faculties. Always a live cascade (docs/API.md:
// "barata y acotada") — there's no faculty table, only program rows carry
// faculty_code/faculty_name as a convenience column (DATA-MODEL.md).
func (s *Service) Faculties(ctx context.Context) ([]DropdownOption, error) {
	faculties, _, err := s.sia.FetchProgramDirectory(ctx, UndergradLevel, BogotaCampusIdx)
	return faculties, err
}

// ProgramsInFaculty lists cached programs under a faculty, falling back to a
// live directory fetch (and warming the cache) on a cold miss.
func (s *Service) ProgramsInFaculty(ctx context.Context, facultyCode string) ([]Program, error) {
	cached, err := s.store.Programs(ctx, BogotaCampusCode, facultyCode)
	if err != nil {
		return nil, err
	}
	if len(cached) > 0 {
		return cached, nil
	}

	faculties, programsByFaculty, err := s.sia.FetchProgramDirectory(ctx, UndergradLevel, BogotaCampusIdx)
	if err != nil {
		return nil, err
	}
	var out []Program
	for _, fac := range faculties {
		if fac.Code != facultyCode {
			continue
		}
		for _, po := range programsByFaculty[fac.Index] {
			p := Program{
				CampusCode: BogotaCampusCode, FacultyCode: fac.Code, Code: po.Code,
				Level: UndergradLevel, Name: po.Name, CampusName: BogotaCampusName, FacultyName: fac.Name,
				CampusIdx: BogotaCampusIdx, FacultyIdx: fac.Index, ProgramIdx: po.Index,
			}
			saved, err := s.store.UpsertProgram(ctx, p)
			if err != nil {
				return nil, err
			}
			out = append(out, saved)
		}
	}
	return out, nil
}

func (s *Service) ProgramsOfferingCourse(ctx context.Context, code string) ([]Program, error) {
	return s.store.ProgramsOfferingCourse(ctx, code)
}

func (s *Service) SearchCourses(ctx context.Context, q string) ([]Course, error) {
	return s.store.SearchCourses(ctx, q)
}

func (s *Service) CachedProgramCount(ctx context.Context) (cached, total int, err error) {
	return s.store.CachedProgramCount(ctx)
}

// CacheStatus tells the caller (httpapi's X-Cache header, docs/API.md)
// whether a response was served from Store or required a live SIA fetch.
type CacheStatus string

const (
	CacheHit  CacheStatus = "hit"
	CacheMiss CacheStatus = "miss"
)

// FetchResult carries the cache/timing metadata docs/API.md's headers need
// alongside the data itself.
type FetchResult struct {
	Cache   CacheStatus
	FetchMs int64 // only meaningful when Cache == CacheMiss
}

// DefaultFreshness tells Catalog/CourseDetail to use the resource's own
// default TTL instead of a caller-supplied ?max_age=.
const DefaultFreshness time.Duration = -1

// Catalog is the program-granularity read-through. A miss fetches BOTH
// halves (regular + electives) before persisting — a partial catalog marked
// fresh is the failure this project exists to avoid (GOTCHAS §21). maxAge
// overrides FreshnessCatalog (docs/API.md "?max_age="); maxAge==0 forces a
// SIA fetch.
func (s *Service) Catalog(ctx context.Context, program Program, maxAge time.Duration) ([]CourseOffering, FetchResult, error) {
	if maxAge < 0 {
		maxAge = FreshnessCatalog
	}
	if Fresh(program.CatalogFetchedAt, maxAge, time.Now()) {
		offerings, err := s.store.ProgramCourses(ctx, program.ID)
		return offerings, FetchResult{Cache: CacheHit}, err
	}

	start := time.Now()
	sfKey := fmt.Sprintf("%d", program.ID)
	v, err, _ := s.sfCatalog.Do(sfKey, func() (any, error) {
		key := program.key()
		regular, err := s.sia.FetchCatalog(ctx, key)
		if err != nil {
			return nil, err
		}
		electives, err := s.sia.FetchElectives(ctx, key)
		if err != nil {
			return nil, err
		}
		combined := append(regular, electives...)
		if err := s.store.UpsertCatalog(ctx, program, combined); err != nil {
			return nil, err
		}
		return combined, nil
	})
	res := FetchResult{Cache: CacheMiss, FetchMs: time.Since(start).Milliseconds()}
	if err != nil {
		return nil, res, err
	}
	return v.([]CourseOffering), res, nil
}

// CourseDetail is the course-granularity read-through, scoped by program
// (section_program visibility — DATA-MODEL.md decision 6). Freshness is
// governed by course_program.detail_fetched_at: a program that has never
// asked about this course pays the POST even if another program already
// cached the section rows.
func (s *Service) CourseDetail(ctx context.Context, program Program, code string, maxAge time.Duration) (CourseOffering, FetchResult, error) {
	if maxAge < 0 {
		maxAge = FreshnessDetail
	}
	fetchedAt, ok, err := s.store.CourseProgramFetchedAt(ctx, program.ID, code)
	if err != nil {
		return CourseOffering{}, FetchResult{}, err
	}
	if ok && Fresh(fetchedAt, maxAge, time.Now()) {
		offering, err := s.readCourse(ctx, program, code)
		return offering, FetchResult{Cache: CacheHit}, err
	}

	start := time.Now()
	sfKey := fmt.Sprintf("%d:%s", program.ID, code)
	v, err, _ := s.sfDetail.Do(sfKey, func() (any, error) {
		offering, err := s.sia.FetchDetail(ctx, program.key(), code, s.term)
		if err != nil {
			return nil, err
		}
		if err := s.store.UpsertDetail(ctx, program.ID, offering); err != nil {
			return nil, err
		}
		return s.readCourse(ctx, program, code)
	})
	res := FetchResult{Cache: CacheMiss, FetchMs: time.Since(start).Milliseconds()}
	if err != nil {
		return CourseOffering{}, res, err
	}
	return v.(CourseOffering), res, nil
}

func (s *Service) readCourse(ctx context.Context, program Program, code string) (CourseOffering, error) {
	course, found, err := s.store.Course(ctx, program.CampusCode, code)
	if err != nil {
		return CourseOffering{}, err
	}
	if !found {
		return CourseOffering{}, ErrNotFound
	}
	sections, err := s.store.Sections(ctx, program.CampusCode, code, program.ID)
	if err != nil {
		return CourseOffering{}, err
	}
	course.Sections = sections
	typology, _, err := s.store.CourseProgramTypology(ctx, program.ID, code)
	if err != nil {
		return CourseOffering{}, err
	}
	return CourseOffering{Course: course, Typology: typology}, nil
}
