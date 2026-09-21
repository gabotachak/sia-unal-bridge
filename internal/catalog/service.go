package catalog

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"
)

// DefaultLevelSlug is what an unqualified request means. It is a product
// default — which view the API shows when the caller says nothing — not a
// structural assumption: every level in the `level` table works, and nothing
// downstream is written against this value. There is deliberately no
// equivalent for campus: a campus-less request is answered from whatever is
// cached, or 300, never silently narrowed to one sede.
const DefaultLevelSlug = "pregrado"

// Service is the read-through orchestrator: Store first, SIASource on a
// stale/missing cache, respond, persist. docs/ARCH.md "Flujo principal".
type Service struct {
	store Store
	sia   SIASource
	term  string // current term stamped on fetched sections, e.g. "2026-2"

	sfCatalog   singleflight.Group // key: program.ID
	sfDetail    singleflight.Group // key: "programID:code" — docs/API.md "Singleflight por clave de fetch"
	sfDirectory singleflight.Group // key: reference scope — the cascade is 15 POSTs; never run two at once
}

func NewService(store Store, sia SIASource, term string) *Service {
	return &Service{store: store, sia: sia, term: term}
}

// ensureDirectory guarantees Store holds a program directory for one
// (campus, level) no older than maxAge, walking the live cascade only when
// it doesn't. This is the reference cache docs/API.md "Frescura" specifies
// at 30 d — before it existed, every faculty/program read went to the SIA
// unconditionally.
//
// A miss fills the WHOLE directory for that campus, all ~13 faculties. The
// cascade already pays for every faculty's program list to produce any one
// of them, so persisting a single faculty and discarding the rest would
// throw away data already bought — same reasoning as "un miss de catálogo
// llena el programa entero" in docs/ARCH.md.
//
// Both coordinates come from the caches (level slug → soc1 index, campus
// code → soc9 index), never from a constant: which sede is index 2 is the
// SIA's business and it can renumber (GOTCHAS §26).
func (s *Service) ensureDirectory(ctx context.Context, campusCode, levelSlug string, maxAge time.Duration) error {
	campus, level, err := s.coordinates(ctx, campusCode, levelSlug)
	if err != nil {
		return err
	}

	// level.Slug, not levelSlug: the raw parameter may be empty, and
	// "programs:1101:" and "programs:1101:pregrado" would be two cache
	// entries for the same directory.
	scope := directoryScope(campusCode, level.Slug)
	fetchedAt, err := s.store.ReferenceFetchedAt(ctx, scope)
	if err != nil {
		return err
	}
	if Fresh(fetchedAt, maxAge, time.Now()) {
		return nil
	}

	_, err, _ = s.sfDirectory.Do(scope, func() (any, error) {
		faculties, programsByFaculty, err := s.sia.FetchProgramDirectory(ctx, level.Index, campus.Index)
		if err != nil {
			return nil, err
		}
		var programs []Program
		for _, fac := range faculties {
			for _, po := range programsByFaculty[fac.Index] {
				programs = append(programs, Program{
					CampusCode: campus.Code, FacultyCode: fac.Code, Code: po.Code,
					LevelSlug: level.Slug, Name: po.Name, CampusName: campus.Name, FacultyName: fac.Name,
					LevelIdx: level.Index, CampusIdx: campus.Index, FacultyIdx: fac.Index, ProgramIdx: po.Index,
				})
			}
		}
		return nil, s.store.UpsertPrograms(ctx, scope, programs)
	})
	return err
}

// coordinates turns the public identifiers of a request — a campus code and
// a level slug — into the volatile dropdown positions the SIA navigates by,
// reading both off the reference caches and refreshing them if cold.
//
// This is the single place where a public ID becomes an index. Everything
// upstream of it speaks codes and slugs; everything downstream speaks
// positions. An unknown campus is ErrNotFound, not a silent fallback to some
// default sede.
func (s *Service) coordinates(ctx context.Context, campusCode, levelSlug string) (Campus, Level, error) {
	level, err := s.resolveLevel(ctx, levelSlug)
	if err != nil {
		return Campus{}, Level{}, err
	}
	campuses, err := s.Campuses(ctx, level.Slug)
	if err != nil {
		return Campus{}, Level{}, err
	}
	for _, c := range campuses {
		if c.Code == campusCode {
			return c, level, nil
		}
	}
	return Campus{}, Level{}, ErrNotFound
}

// resolveLevel maps a level slug to its cached row. An empty slug means the
// caller did not care and gets DefaultLevelSlug.
func (s *Service) resolveLevel(ctx context.Context, slug string) (Level, error) {
	if slug == "" {
		slug = DefaultLevelSlug
	}
	levels, err := s.Levels(ctx)
	if err != nil {
		return Level{}, err
	}
	for _, l := range levels {
		if l.Slug == slug {
			return l, nil
		}
	}
	return Level{}, ErrNotFound
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
func (s *Service) Campuses(ctx context.Context, levelSlug string) ([]Campus, error) {
	if levelSlug == "" {
		levelSlug = DefaultLevelSlug
	}
	scope := campusScope(levelSlug)
	fetchedAt, err := s.store.ReferenceFetchedAt(ctx, scope)
	if err != nil {
		return nil, err
	}
	if !Fresh(fetchedAt, FreshnessReference, time.Now()) {
		// The soc9 fetch needs soc1's position, and resolveLevel reads the
		// level cache — which Levels() keeps fresh on its own scope.
		level, err := s.resolveLevel(ctx, levelSlug)
		if err != nil {
			return nil, err
		}
		if _, err, _ := s.sfDirectory.Do(scope, func() (any, error) {
			opts, err := s.sia.FetchCampuses(ctx, level.Index)
			if err != nil {
				return nil, err
			}
			campuses := make([]Campus, len(opts))
			for i, o := range opts {
				campuses[i] = Campus{LevelSlug: level.Slug, Code: o.Code, Name: o.Name, Index: o.Index}
			}
			return nil, s.store.UpsertCampuses(ctx, scope, campuses)
		}); err != nil {
			return nil, err
		}
	}
	return s.store.Campuses(ctx, levelSlug)
}

// Scope keys for the reference cache's TTL marker. One namespace per list,
// because they are refreshed independently and at different costs: the
// campus list is one POST, a campus's program directory is ~15. Keyed by
// public IDs, never by dropdown positions.
func campusScope(levelSlug string) string { return "campuses:" + levelSlug }
func directoryScope(campusCode, levelSlug string) string {
	return fmt.Sprintf("programs:%s:%s", campusCode, levelSlug)
}

// ResolveProgram looks up a program by its institutional code.
//
// program.code does NOT identify on its own: 136 of 852 codes repeat across
// sedes because PEAMA reexposes the same plan (GOTCHAS §26). So the campus
// is optional but meaningful:
//
//   - campusCode given: that sede's directory is made fresh (fetched if
//     cold) and the lookup is exact.
//   - campusCode empty: the lookup runs over everything already cached and
//     triggers NO fetch — there is no campus to cascade. One match is
//     served, several are an AmbiguousError (300, docs/API.md
//     "Identificadores"), none is a 404 that tells the caller to qualify.
//
// An unknown code costs no SIA traffic once the directory is fresh: the
// cascade is authoritative about which programs exist, so absence from a
// fresh directory IS the 404.
func (s *Service) ResolveProgram(ctx context.Context, ref ProgramRef) (Program, error) {
	if ref.Campus != "" {
		if err := s.ensureDirectory(ctx, ref.Campus, ref.Level, FreshnessReference); err != nil {
			return Program{}, err
		}
	}
	// El nivel se resuelve para filtrar: sin él, pedir un plan de doctorado
	// podría devolver el de pregrado que comparte código.
	level, err := s.resolveLevel(ctx, ref.Level)
	if err != nil {
		return Program{}, err
	}
	programs, err := s.store.Programs(ctx, ref.Campus, ref.Faculty, level.Slug)
	if err != nil {
		return Program{}, err
	}
	var matches []Program
	for _, p := range programs {
		if p.Code == ref.Code {
			matches = append(matches, p)
		}
	}
	switch len(matches) {
	case 0:
		return Program{}, ErrNotFound
	case 1:
		return matches[0], nil
	default:
		return Program{}, &AmbiguousError{
			Candidates: matches,
			Code:       "ambiguous_program",
			Hint:       ambiguityHint(matches, ref),
		}
	}
}

// ambiguityHint names the coordinate that would actually settle it. Over
// HTTP the campus is always known (it is a path segment), so the answer is
// almost always ?faculty= — codes repeat across faculties within a sede too,
// not just across sedes. The campus branch is for callers that reach the
// service directly with only a code.
func ambiguityHint(matches []Program, ref ProgramRef) string {
	if ref.Campus != "" {
		return "add ?faculty= to disambiguate"
	}
	for _, p := range matches[1:] {
		if p.CampusCode != matches[0].CampusCode {
			return "qualify the campus: /v1/campuses/{campus}/programs/" + ref.Code
		}
	}
	return "add ?faculty= to disambiguate"
}

func (p Program) key() ProgramKey {
	return ProgramKey{
		Level: p.LevelIdx, Campus: p.CampusIdx, Faculty: p.FacultyIdx, Program: p.ProgramIdx,
		CampusCode: p.CampusCode,
	}
}

// Faculties lists one campus's faculties off the reference cache. There is
// no faculty table — program rows carry faculty_code/faculty_name as a
// convenience column (DATA-MODEL.md) — so the list is the distinct set over
// a directory that ensureDirectory has already made fresh.
func (s *Service) Faculties(ctx context.Context, campusCode, levelSlug string) ([]DropdownOption, error) {
	if err := s.ensureDirectory(ctx, campusCode, levelSlug, FreshnessReference); err != nil {
		return nil, err
	}
	level, err := s.resolveLevel(ctx, levelSlug)
	if err != nil {
		return nil, err
	}
	programs, err := s.store.Programs(ctx, campusCode, "", level.Slug)
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

// ProgramsInFaculty lists the programs of one campus from the reference
// cache, optionally narrowed to a faculty (facultyCode == "" means the whole
// campus — free, since a directory miss fills every faculty anyway).
//
// An empty result for a real faculty is a genuine empty: the directory is
// authoritative once fresh, so it must not retrigger a fetch.
func (s *Service) ProgramsInFaculty(ctx context.Context, campusCode, facultyCode, levelSlug string) ([]Program, error) {
	if err := s.ensureDirectory(ctx, campusCode, levelSlug, FreshnessReference); err != nil {
		return nil, err
	}
	level, err := s.resolveLevel(ctx, levelSlug)
	if err != nil {
		return nil, err
	}
	return s.store.Programs(ctx, campusCode, facultyCode, level.Slug)
}

func (s *Service) ProgramsOfferingCourse(ctx context.Context, campusCode, code string) ([]Program, error) {
	return s.store.ProgramsOfferingCourse(ctx, campusCode, code)
}

func (s *Service) SearchCourses(ctx context.Context, campusCode, q string) ([]Course, error) {
	return s.store.SearchCourses(ctx, campusCode, q)
}

func (s *Service) ProgramCoverage(ctx context.Context, campusCode string) (known, withCatalog int, err error) {
	return s.store.ProgramCoverage(ctx, campusCode)
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
// Schedules returns the stored group schedules of every course visible from
// this program, keyed by course code.
//
// A pure Store read: it never fetches from the SIA, and never completes the
// catalog. A course missing from the map is one whose detail nobody pulled
// yet — not one without groups, which comes back as an empty slice. That
// distinction is the whole point: a client that cannot tell them apart
// would flag "no group fits" on a course it knows nothing about.
func (s *Service) Schedules(ctx context.Context, program Program) (map[string][]SectionSchedule, error) {
	return s.store.ProgramSchedules(ctx, program.ID)
}

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
	v, err := shared(ctx, &s.sfCatalog, sfKey, func(ctx context.Context) (any, error) {
		key := program.key()
		regular, err := s.sia.FetchCatalog(ctx, key)
		if err != nil {
			return nil, err
		}
		electives, err := s.sia.FetchElectives(ctx, key)
		if err != nil {
			return nil, err
		}
		// Each half is checked on its own: the cap applies per listing, and
		// a campus with many electives could legitimately push the combined
		// set past 1000.
		if err := checkListing(regular, program, "regular"); err != nil {
			return nil, err
		}
		if err := checkListing(electives, program, "electives"); err != nil {
			return nil, err
		}
		combined := append(regular, electives...)
		if err := s.suspectShrunkCatalog(ctx, program, combined); err != nil {
			return nil, err
		}
		if err := s.store.UpsertCatalog(ctx, program, combined); err != nil {
			return nil, err
		}
		// Se relee de la base en vez de devolver lo recién parseado: el listado
		// del SIA no trae cupos, así que `combined` los tiene todos en nil y la
		// tabla saldría con "—" aunque la base ya guarde mediciones de detalles
		// anteriores. ProgramCourses reengancha current_seats.
		return s.store.ProgramCourses(ctx, program.ID)
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

// LastDetailFetch reports when the detail POST for this course last ran,
// reading the cache only — it never touches the SIA, which is the whole point:
// a refresh cooldown that fetches in order to decide whether to allow a fetch
// is not a cooldown.
//
// One timestamp serves every detail endpoint because they all reduce to the
// same POST (see refreshDetail): course, sections, section and seats are four
// views of one round trip, so throttling them separately would throttle
// nothing. Second return is false when the course was never fetched.
func (s *Service) LastDetailFetch(ctx context.Context, program Program, code string) (time.Time, bool, error) {
	fetchedAt, ok, err := s.store.CourseProgramFetchedAt(ctx, program.ID, code)
	if err != nil || !ok || fetchedAt == nil {
		return time.Time{}, false, err
	}
	return *fetchedAt, true, nil
}

// SectionSeats is the seats-granularity read-through. Seats are the one
// volatile datum (docs/ARCH.md "Lo único volátil son los cupos"), so they get
// their own TTL — FreshnessSeats, governed by seat_snapshot.measured_at
// (docs/API.md "Frescura") — instead of riding on detail_fetched_at's 24 h,
// which would serve day-old seats under a 5 min Cache-Control.
//
// A miss costs exactly one detail POST, the same as fetching the whole
// course, because the seats never arrive alone. So it refreshes and persists
// everything — sections, schedule, visibility, snapshot — and returns only
// the section asked for. docs/ARCH.md "Cupos": sale gratis y mantiene la cache
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
	v, err := shared(ctx, &s.sfDetail, sfKey, func(ctx context.Context) (any, error) {
		offering, err := s.sia.FetchDetail(ctx, program.key(), code, s.term)
		if err != nil {
			return nil, err
		}
		if err := s.store.UpsertDetail(ctx, program.ID, s.term, offering); err != nil {
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

// shared runs fn once per key however many callers ask at the same time, and
// — the part singleflight.Do gets wrong for this service — does not let the
// FIRST caller's cancellation fail everybody else. fn gets a context that
// keeps the first caller's deadline but not its cancel: a client navigating
// away used to hand its "context canceled" to every other request waiting on
// the same course, and to abandon the ADF connection mid-operation (235 of
// those in one production hour, 2026-09-19). The fetch now finishes and is
// persisted even if nobody is left to read it; each waiter still gives up on
// its OWN context.
func shared(ctx context.Context, g *singleflight.Group, key string, fn func(context.Context) (any, error)) (any, error) {
	ch := g.DoChan(key, func() (any, error) {
		fctx := context.WithoutCancel(ctx)
		if deadline, ok := ctx.Deadline(); ok {
			var cancel context.CancelFunc
			fctx, cancel = context.WithDeadline(fctx, deadline)
			defer cancel()
		}
		return fn(fctx)
	})
	select {
	case r := <-ch:
		return r.Val, r.Err
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, ErrBusy // same answer Pool.Acquire gives when the wait runs out
		}
		return nil, ctx.Err()
	}
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
