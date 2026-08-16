package catalog

import (
	"context"
	"fmt"
	"sort"
	"strings"
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

	sfCatalog   singleflight.Group // key: program.ID
	sfDetail    singleflight.Group // key: "programID:code" — docs/API.md "Singleflight por clave de fetch"
	sfDirectory singleflight.Group // key: "campusCode:level" — the cascade is 15 POSTs; never run two at once
}

func NewService(store Store, sia SIASource, term string) *Service {
	return &Service{store: store, sia: sia, term: term}
}

// ensureDirectory guarantees Store holds a program directory for Bogotá no
// older than maxAge, walking the live cascade only when it doesn't. This is
// the reference cache docs/API.md "Frescura" specifies at 30 d — before it
// existed, every faculty/program read went to the SIA unconditionally.
//
// A miss fills the WHOLE directory, all ~13 faculties. The cascade already
// pays for every faculty's program list to produce any one of them, so
// persisting a single faculty and discarding the other twelve would throw
// away data already bought — same reasoning as "un miss de catálogo llena el
// programa entero" in ARCH.md.
func (s *Service) ensureDirectory(ctx context.Context, maxAge time.Duration) error {
	scope := directoryScope(BogotaCampusCode, UndergradLevel)
	fetchedAt, err := s.store.ReferenceFetchedAt(ctx, scope)
	if err != nil {
		return err
	}
	if Fresh(fetchedAt, maxAge, time.Now()) {
		return nil
	}

	_, err, _ = s.sfDirectory.Do(scope, func() (any, error) {
		faculties, programsByFaculty, err := s.sia.FetchProgramDirectory(ctx, UndergradLevel, BogotaCampusIdx)
		if err != nil {
			return nil, err
		}
		var programs []Program
		for _, fac := range faculties {
			for _, po := range programsByFaculty[fac.Index] {
				programs = append(programs, Program{
					CampusCode: BogotaCampusCode, FacultyCode: fac.Code, Code: po.Code,
					Level: UndergradLevel, Name: po.Name, CampusName: BogotaCampusName, FacultyName: fac.Name,
					CampusIdx: BogotaCampusIdx, FacultyIdx: fac.Index, ProgramIdx: po.Index,
				})
			}
		}
		return nil, s.store.UpsertPrograms(ctx, scope, programs)
	})
	return err
}

// Levels lists the niveles de estudio off the reference cache. The three
// published slugs are seeded by migration; a level the SIA adds later shows
// up on the next refresh with a derived slug, and an existing slug is never
// rewritten (Store.UpsertLevels matches on the label).
func (s *Service) Levels(ctx context.Context) ([]Level, error) {
	scope := "levels"
	fetchedAt, err := s.store.ReferenceFetchedAt(ctx, scope)
	if err != nil {
		return nil, err
	}
	if !Fresh(fetchedAt, FreshnessReference, time.Now()) {
		if _, err, _ := s.sfDirectory.Do(scope, func() (any, error) {
			opts, err := s.sia.FetchLevels(ctx)
			if err != nil {
				return nil, err
			}
			levels := make([]Level, len(opts))
			for i, o := range opts {
				levels[i] = Level{Slug: slugify(o.Label), Name: o.Label, Index: o.Index}
			}
			return nil, s.store.UpsertLevels(ctx, scope, levels)
		}); err != nil {
			return nil, err
		}
	}
	return s.store.Levels(ctx)
}

// slugify turns a soc1 label into a URL-safe public ID. It only ever applies
// to a label the level table has never seen: the published slugs
// (docs/API.md) are seeded and Store.UpsertLevels will not overwrite them —
// "posgrado" must not silently become "postgrados-y-masteres".
func slugify(label string) string {
	var b strings.Builder
	var pendingDash bool
	for _, r := range strings.ToLower(label) {
		if repl, ok := accentFolds[r]; ok {
			r = repl
		}
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			if pendingDash && b.Len() > 0 {
				b.WriteByte('-')
			}
			pendingDash = false
			b.WriteRune(r)
		default:
			pendingDash = true
		}
	}
	return b.String()
}

// accentFolds covers the Spanish letters the SIA's labels actually use.
// Deliberately not a full Unicode normalisation: a fixed table is auditable
// and this only ever runs on a handful of dropdown labels.
var accentFolds = map[rune]rune{
	'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ü': 'u', 'ñ': 'n',
}

// Campuses lists the sedes off the reference cache. They used to be a
// hardcoded slice in the HTTP layer; they are a SIA dropdown (soc9) like any
// other, so they follow the same rule as everything else — read from Store,
// go to the SIA only when missing or stale.
func (s *Service) Campuses(ctx context.Context) ([]Campus, error) {
	scope := campusScope(UndergradLevel)
	fetchedAt, err := s.store.ReferenceFetchedAt(ctx, scope)
	if err != nil {
		return nil, err
	}
	if !Fresh(fetchedAt, FreshnessReference, time.Now()) {
		if _, err, _ := s.sfDirectory.Do(scope, func() (any, error) {
			opts, err := s.sia.FetchCampuses(ctx, UndergradLevel)
			if err != nil {
				return nil, err
			}
			campuses := make([]Campus, len(opts))
			for i, o := range opts {
				campuses[i] = Campus{Level: UndergradLevel, Code: o.Code, Name: o.Name, Index: o.Index}
			}
			return nil, s.store.UpsertCampuses(ctx, scope, campuses)
		}); err != nil {
			return nil, err
		}
	}
	return s.store.Campuses(ctx, UndergradLevel)
}

// Scope keys for the reference cache's TTL marker. One namespace per list,
// because they are refreshed independently and at different costs: the
// campus list is one POST, the program directory is ~15.
func campusScope(level int) string { return fmt.Sprintf("campuses:%d", level) }
func directoryScope(campusCode string, level int) string {
	return fmt.Sprintf("programs:%s:%d", campusCode, level)
}

// ResolveProgram looks up a program by its institutional code within Bogotá,
// served from the reference cache. An unknown code costs no SIA traffic once
// the directory is fresh: the cascade is authoritative about which programs
// exist, so absence from a fresh directory IS the 404.
func (s *Service) ResolveProgram(ctx context.Context, code string) (Program, error) {
	if err := s.ensureDirectory(ctx, FreshnessReference); err != nil {
		return Program{}, err
	}
	programs, err := s.store.Programs(ctx, BogotaCampusCode, "")
	if err != nil {
		return Program{}, err
	}
	for _, p := range programs {
		if p.Code == code {
			return p, nil
		}
	}
	return Program{}, ErrNotFound
}

func (p Program) key() ProgramKey {
	return ProgramKey{Level: p.Level, Campus: p.CampusIdx, Faculty: p.FacultyIdx, Program: p.ProgramIdx}
}

// Faculties lists Bogotá's faculties off the reference cache. There is no
// faculty table — program rows carry faculty_code/faculty_name as a
// convenience column (DATA-MODEL.md) — so the list is the distinct set over
// a directory that ensureDirectory has already made fresh.
func (s *Service) Faculties(ctx context.Context) ([]DropdownOption, error) {
	if err := s.ensureDirectory(ctx, FreshnessReference); err != nil {
		return nil, err
	}
	programs, err := s.store.Programs(ctx, BogotaCampusCode, "")
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(programs))
	var out []DropdownOption
	for _, p := range programs {
		if seen[p.FacultyCode] {
			continue
		}
		seen[p.FacultyCode] = true
		out = append(out, DropdownOption{Index: p.FacultyIdx, Code: p.FacultyCode, Name: p.FacultyName})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// ProgramsInFaculty lists the programs under a faculty from the reference
// cache. An empty result for a real faculty is a genuine empty: the
// directory is authoritative once fresh, so it must not retrigger a fetch.
func (s *Service) ProgramsInFaculty(ctx context.Context, facultyCode string) ([]Program, error) {
	if err := s.ensureDirectory(ctx, FreshnessReference); err != nil {
		return nil, err
	}
	return s.store.Programs(ctx, BogotaCampusCode, facultyCode)
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
	return s.refreshDetail(ctx, program, code)
}

// SectionSeats is the seats-granularity read-through. Seats are the one
// volatile datum (ARCH.md "Lo único volátil son los cupos"), so they get
// their own TTL — FreshnessSeats, governed by seat_snapshot.measured_at
// (docs/API.md "Frescura") — instead of riding on detail_fetched_at's 24 h,
// which would serve day-old seats under a 5 min Cache-Control.
//
// A miss costs exactly one detail POST, the same as fetching the whole
// course, because the seats never arrive alone. So it refreshes and persists
// everything — sections, schedule, visibility, snapshot — and returns only
// the section asked for. ARCH.md "Cupos": sale gratis y mantiene la cache
// caliente.
func (s *Service) SectionSeats(ctx context.Context, program Program, code, key string, maxAge time.Duration) (Section, FetchResult, error) {
	if maxAge < 0 {
		maxAge = FreshnessSeats
	}
	cached, found, err := s.cachedSection(ctx, program, code, key)
	if err != nil {
		return Section{}, FetchResult{}, err
	}
	if found && cached.Seats != nil && Fresh(&cached.Seats.MeasuredAt, maxAge, time.Now()) {
		return cached, FetchResult{Cache: CacheHit}, nil
	}

	offering, res, err := s.refreshDetail(ctx, program, code)
	if err != nil {
		return Section{}, res, err
	}
	for _, sec := range offering.Course.Sections {
		if sec.Key == key {
			return sec, res, nil
		}
	}
	return Section{}, res, ErrNotFound
}

// cachedSection reads one section as THIS program sees it. Store.Sections
// joins section_program, so a course whose detail was never fetched from
// this program yields nothing here and correctly falls through to a fetch —
// the visibility layer of DATA-MODEL.md decision 6, not an optimisation to
// shortcut.
func (s *Service) cachedSection(ctx context.Context, program Program, code, key string) (Section, bool, error) {
	sections, err := s.store.Sections(ctx, program.CampusCode, code, program.ID)
	if err != nil {
		return Section{}, false, err
	}
	for _, sec := range sections {
		if sec.Key == key {
			return sec, true, nil
		}
	}
	return Section{}, false, nil
}

// refreshDetail runs the one live detail POST behind sfDetail and persists
// everything it brings back, whichever read-through asked for it. Shared by
// CourseDetail and SectionSeats so a seats refresh warms the detail cache
// and vice versa — they are the same POST.
func (s *Service) refreshDetail(ctx context.Context, program Program, code string) (CourseOffering, FetchResult, error) {
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
