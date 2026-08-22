package catalog

import (
	"context"
	"fmt"
	"time"
)

// listingCap is the SIA's hard ceiling on a listing: exactly 1000 rows, with
// no pagination behind it (GOTCHAS §14). Hitting it means the answer was
// TRUNCATED, and persisting a truncated catalog as if it were complete is
// the silent failure this project exists to avoid.
const listingCap = 1000

// checkListing rejects a truncated half-catalog before anything is written.
func checkListing(offerings []CourseOffering, program Program, half string) error {
	if len(offerings) >= listingCap {
		return fmt.Errorf("%w: program %s/%s %s listing returned %d rows",
			ErrTruncated, program.CampusCode, program.Code, half, len(offerings))
	}
	return nil
}

// shrinkFloor: por debajo de esta fracción del catálogo activo previo, una
// respuesta más chica no es "retiraron materias", es una lectura rota. Un
// plan no pierde la mitad de su oferta de un semestre a otro; un listado
// truncado (§14) o un soc4 sucio (§22) sí producen exactamente eso, y en
// silencio.
const shrinkFloor = 0.5

// suspectShrunkCatalog rejects a catalog read that looks broken rather than
// smaller: zero courses for a program that already had some (SIA changed,
// soc4 got dirty, or the bootstrap's foreign table was parsed — GOTCHAS
// §22), or a catalog that shrank by more than shrinkFloor. With
// reconciliation live, a bad read here doesn't just leave the cache
// incomplete — it disables real rows.
func (s *Service) suspectShrunkCatalog(ctx context.Context, program Program, offerings []CourseOffering) error {
	if program.CatalogFetchedAt == nil {
		return nil // primera vez: no hay contra qué comparar
	}
	prev, err := s.store.ProgramCourses(ctx, program.ID)
	if err != nil {
		return err
	}
	if len(prev) == 0 {
		return nil
	}
	if len(offerings) == 0 {
		return fmt.Errorf("%w: program %s/%s returned 0 courses, cache holds %d",
			ErrSuspectRun, program.CampusCode, program.Code, len(prev))
	}
	if float64(len(offerings)) < shrinkFloor*float64(len(prev)) {
		return fmt.Errorf("%w: program %s/%s returned %d courses, cache holds %d active",
			ErrSuspectRun, program.CampusCode, program.Code, len(offerings), len(prev))
	}
	return nil
}

// RefreshDetails pulls the detail of several courses of ONE program over one
// connection, persisting each as it arrives. Same use case as CourseDetail —
// same fetch, same upsert, same freshness marks — with the batching the
// Refresher needs and no second path into Postgres (docs/FASE-2.md "Qué es y
// qué no es").
//
// yield is called once per course with the persisted offering, or with the
// error that course failed with. Returning an error from yield stops the
// batch: that is how the circuit breaker aborts a sweep.
func (s *Service) RefreshDetails(ctx context.Context, program Program, refs []CourseRef,
	yield func(CourseOffering, error) error) error {
	return s.sia.FetchDetails(ctx, program.key(), refs, s.term, func(o CourseOffering, err error) error {
		if err == nil {
			err = s.store.UpsertDetail(ctx, program.ID, s.term, o)
		}
		return yield(o, err)
	})
}

// CoursesNeedingDetail lists the program's courses whose GLOBAL detail is
// stale — the filter that separates a 3 h sweep from a 38 h one.
func (s *Service) CoursesNeedingDetail(ctx context.Context, programID int64, maxAge time.Duration) ([]CourseRef, error) {
	return s.store.CoursesNeedingDetail(ctx, programID, maxAge)
}

// CoursesNeedingVisibility is the per-plan variant: what the semestral sweep
// walks to learn which groups each plan actually sees.
func (s *Service) CoursesNeedingVisibility(ctx context.Context, programID int64, maxAge time.Duration) ([]CourseRef, error) {
	return s.store.CoursesNeedingVisibility(ctx, programID, maxAge)
}

// SeatsHotSet is the seats sweep's work list. For seats the Refresher is a
// hot-set warmer, not a freshness guarantee: one worker measures ~1
// course/s, the universe is ~10 000, and the TTL is 5 min — short by a
// factor of ~8. The read-through stays the mechanism (docs/FASE-2.md).
func (s *Service) SeatsHotSet(ctx context.Context, campusCode string, limit int) ([]CourseRef, error) {
	return s.store.SeatsHotSet(ctx, campusCode, limit)
}

// RecordDemand notes that a client asked for this course. Only the HTTP
// adapter calls it — the job's own fetches must not feed the hot set it
// derives its work from.
func (s *Service) RecordDemand(ctx context.Context, campusCode, code string) error {
	return s.store.RecordDemand(ctx, campusCode, code)
}

// AllPrograms is every program the directory cache knows, across every level
// and sede — the Refresher's work list for the catalog sweep, and the id →
// coordinates map the seats sweep needs to turn a hot-set entry into a
// fetchable program.
//
// It reads only the cache: whether the directory is complete is the
// reference sweep's business, and pretending otherwise here would hide an
// empty directory behind 1380 imaginary programs.
func (s *Service) AllPrograms(ctx context.Context) ([]Program, error) {
	return s.store.Programs(ctx, "", "", "")
}

// Run bookkeeping and the per-mode advisory lock, passed through so
// internal/refresher never imports store — it is a driving adapter and the
// hexagon's rule applies to it too (docs/LAYOUT.md).
func (s *Service) StartRun(ctx context.Context, mode, scope string) (int64, error) {
	return s.store.StartRun(ctx, mode, scope)
}

func (s *Service) FinishRun(ctx context.Context, run RefreshRun) error {
	return s.store.FinishRun(ctx, run)
}

func (s *Service) LastRuns(ctx context.Context) ([]RefreshRun, error) {
	return s.store.LastRuns(ctx)
}

func (s *Service) TryLock(ctx context.Context, key string) (func(), bool, error) {
	return s.store.TryLock(ctx, key)
}
