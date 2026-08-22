package refresher

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// POST estimates per unit of work, for the courtesy limiter. Both are
// measured averages, not guesses: 1380 programs cost ~2760 POSTs of catalog,
// and a course detail is the cb1 of findRow plus the detail itself.
const (
	catalogPosts = 2
	detailPosts  = 2
)

// A program where more than 90% of the courses come back with zero groups is
// a parser failure, not a result: zero groups is perfectly valid one course at
// a time (GOTCHAS §18), never at that scale.
//
// But only among the courses that ALREADY HAD groups. A sede with nothing
// scheduled this term legitimately answers 0 for every course — SEDE DE LA PAZ
// does, measured 2026-08-17, and the first version of this check failed two of
// its plans for telling the truth. What must never happen silently is groups
// DISAPPEARING, so that is what is measured. The minimum sample keeps a plan
// with three known courses from tripping it.
const (
	zeroGroupsMax       = 0.90
	zeroGroupsMinSample = 10
)

// reference walks niveles → sedes → directorio de cada sede. 142 POSTs, once
// a month: no rate limiter here on purpose, it is noise against the budget,
// and waiting on a ticker would also make the second (all-fresh) run take
// seconds instead of milliseconds.
func (r *refresher) reference(ctx context.Context) error {
	levels, err := r.svc.Levels(ctx)
	if err != nil {
		return err
	}
	for _, level := range levels {
		campuses, err := r.svc.Campuses(ctx, level.Slug)
		if err != nil {
			r.record(level.Slug, 0, false, err)
			continue
		}
		for _, c := range campuses {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if r.opts.Campus != "" && c.Code != r.opts.Campus {
				continue
			}
			r.mu.Lock()
			r.rep.ProgramsTotal++
			r.mu.Unlock()

			// ProgramsInFaculty is the read-through: it walks the cascade
			// only when the directory is missing or older than 30 d, so a
			// second run is pure cache and costs 0 POSTs.
			programs, err := r.svc.ProgramsInFaculty(ctx, c.Code, "", level.Slug)
			r.record(c.Code+"/"+level.Slug, len(programs), false, err)
		}
	}
	return ctx.Err()
}

// catalogSweep fills program.catalog_fetched_at for every program the
// directory knows. ~2760 POSTs, ~0.7 GB, ~2.7 h serial — cheap next to the
// detail sweep, which is why they run on different cadences.
func (r *refresher) catalogSweep(ctx context.Context) error {
	programs, err := r.workList(ctx)
	if err != nil {
		return err
	}
	return r.eachProgram(ctx, programs, func(ctx context.Context, p catalog.Program) (int, bool, error) {
		// Pre-checked here as well as inside Service.Catalog: the point is
		// to count it as SKIPPED and to not spend courtesy budget on a
		// program that is not going to be fetched.
		if catalog.Fresh(p.CatalogFetchedAt, r.opts.CatalogMaxAge, time.Now()) {
			return 0, true, nil
		}
		if err := r.lim.wait(ctx, catalogPosts); err != nil {
			return 0, false, err
		}
		offerings, _, err := r.svc.Catalog(ctx, p, r.opts.CatalogMaxAge)
		if err != nil {
			return 0, false, err
		}
		return len(offerings), false, nil
	})
}

// detail pulls course details program by program.
//
//	--scope=global: one POST per COURSE, from whatever plan already lists it.
//	  The section rows it writes (profesor, horario, aula, cupos) are valid
//	  for every plan, so this covers the whole university in ~3 h.
//	--scope=plan:   one POST per (plan, course) pair, which is the only way
//	  to learn which groups THIS plan sees. ~38 h serial, once a semester.
//
// The global sweep does not lie about what it covered:
// course_program.detail_fetched_at is stamped only for the plan that made the
// POST, so a plan the job never walked still reads as "never asked" and its
// first request still triggers the read-through.
func (r *refresher) detail(ctx context.Context) error {
	programs, err := r.workList(ctx)
	if err != nil {
		return err
	}
	perPlan := r.opts.Scope == ScopePlan
	return r.eachProgram(ctx, programs, func(ctx context.Context, p catalog.Program) (int, bool, error) {
		var refs []catalog.CourseRef
		var err error
		if perPlan {
			refs, err = r.svc.CoursesNeedingVisibility(ctx, p.ID, r.opts.DetailMaxAge)
		} else {
			refs, err = r.svc.CoursesNeedingDetail(ctx, p.ID, r.opts.DetailMaxAge)
		}
		if err != nil {
			return 0, false, err
		}
		if len(refs) == 0 {
			return 0, true, nil
		}
		return r.fetchDetails(ctx, p, refs)
	})
}

// seats warms the hot set (ScopeHot) or drains the freshness-debt queue
// (ScopeDebt). It is NOT a freshness guarantee: one worker measures ~1
// course/s, the universe is ~3 474 courses with groups, and the TTL is 5 min.
// What this buys is that the courses people actually look at — or the ones
// most overdue relative to their tier target — almost always answer from cache.
//
// The debt work list comes from Store.SeatsByDebt, which already selects the
// lowest stable program_id per course (docs/PLAN-ULTIMATE-SYNC.md decisión 6).
// The hot-set work list comes from real client demand (RecordDemand, written
// only by httpapi), never from "the ones with detail_fetched_at".
func (r *refresher) seats(ctx context.Context) error {
	if r.opts.Scope == ScopeDebt {
		return r.seatsDebt(ctx)
	}
	return r.seatsHot(ctx)
}

func (r *refresher) seatsHot(ctx context.Context) error {
	programs, err := r.workList(ctx)
	if err != nil {
		return err
	}
	byID := make(map[int64]catalog.Program, len(programs))
	for _, p := range programs {
		byID[p.ID] = p
	}

	// One budget across sedes, spent in order: the first sede with real
	// demand takes what it needs, which is where the users are. --campus
	// narrows it when a specific sede matters.
	budget := r.opts.HotSetSize
	work := make(map[int64][]catalog.CourseRef)
	for _, campusCode := range campusCodes(programs) {
		if budget <= 0 {
			break
		}
		hot, err := r.svc.SeatsHotSet(ctx, campusCode, budget)
		if err != nil {
			return err
		}
		budget -= len(hot)
		for _, ref := range hot {
			work[ref.ProgramID] = append(work[ref.ProgramID], ref)
		}
	}
	if len(work) == 0 {
		r.log.Info("refresher: hot set empty, no client demand recorded yet")
		return ctx.Err()
	}

	programs, err = r.workList(ctx)
	if err != nil {
		return err
	}
	byID = make(map[int64]catalog.Program, len(programs))
	for _, p := range programs {
		byID[p.ID] = p
	}
	targets := make([]catalog.Program, 0, len(work))
	for id := range work {
		p, ok := byID[id]
		if !ok {
			// The demand row outlived its program (directory re-cached
			// under a different id). Not an error, just nothing to fetch.
			continue
		}
		targets = append(targets, p)
	}
	return r.eachProgram(ctx, targets, func(ctx context.Context, p catalog.Program) (int, bool, error) {
		return r.fetchDetails(ctx, p, work[p.ID])
	})
}

func (r *refresher) seatsDebt(ctx context.Context) error {
	programs, err := r.workList(ctx)
	if err != nil {
		return err
	}
	byID := make(map[int64]catalog.Program, len(programs))
	for _, p := range programs {
		byID[p.ID] = p
	}

	refs, err := r.svc.SeatsByDebt(ctx, r.svc.Term(), r.opts.LiveHot, r.opts.LiveWarm, r.opts.LiveCold, r.opts.LiveBatch)
	if err != nil {
		return err
	}

	// Filter quarantined courses before grouping by program.
	filtered := refs[:0:0]
	for _, ref := range refs {
		if !r.opts.Quarantine.Blocked(ref.Code) {
			filtered = append(filtered, ref)
		}
	}
	refs = filtered

	if len(refs) == 0 {
		r.log.Info("refresher: debt queue empty, all courses within their freshness target")
		return ctx.Err()
	}

	work := make(map[int64][]catalog.CourseRef)
	for _, ref := range refs {
		work[ref.ProgramID] = append(work[ref.ProgramID], ref)
	}
	targets := make([]catalog.Program, 0, len(work))
	for id := range work {
		p, ok := byID[id]
		if !ok {
			continue
		}
		targets = append(targets, p)
	}
	return r.eachProgram(ctx, targets, func(ctx context.Context, p catalog.Program) (int, bool, error) {
		return r.fetchDetails(ctx, p, work[p.ID])
	})
}

// fetchDetails walks one program's courses over one connection and folds the
// result. A course that fails does not stop the batch; a program that
// produces no successful course at all is a failed program, which is what
// feeds the circuit breaker.
//
// ErrNotFound is special: it is NOT a circuit-breaker failure (the UNAL
// retiring a course is not a SIA malfunction), but it IS counted in
// Report.NotFound and quarantined for 24 h so the live loop can schedule
// a catalog re-read for that plan.
func (r *refresher) fetchDetails(ctx context.Context, p catalog.Program, refs []catalog.CourseRef) (int, bool, error) {
	hadSections := make(map[string]bool, len(refs))
	codeForRef := make(map[string]string, len(refs)) // course code → quarantine key
	for _, ref := range refs {
		hadSections[ref.Code] = ref.HadSections
		codeForRef[ref.Code] = ref.Code
	}

	ok, failed := 0, 0
	known, lost := 0, 0 // courses that already had groups, and how many lost them
	var assertion error

	err := r.svc.RefreshDetails(ctx, p, refs, func(o catalog.CourseOffering, ferr error) error {
		if ferr != nil {
			// A course cut off by the budget is not a failure — it is the
			// clock, and reporting it as an error would fill the run with
			// noise every single night at the deadline.
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(ferr, catalog.ErrNotFound) {
				// Not a circuit-breaker failure: count and quarantine.
				r.mu.Lock()
				r.rep.NotFound++
				r.mu.Unlock()
				r.opts.Quarantine.Fail(o.Course.Code, true)
				return nil // keep the batch alive
			}
			failed++
			r.opts.Quarantine.Fail(o.Course.Code, false)
			r.noteError(fmt.Errorf("detail %s/%s: %w", p.Code, o.Course.Code, ferr))
			return nil // keep the batch alive
		}
		ok++
		r.opts.Quarantine.OK(o.Course.Code)
		if hadSections[o.Course.Code] {
			known++
			if len(o.Course.Sections) == 0 {
				lost++
			}
		}
		// Checked inside the loop, not at the end: a course is the unit of
		// commit, so the only way to keep a parser failure from being written
		// 98 times is to stop as soon as the ratio is visible.
		if known >= zeroGroupsMinSample && float64(lost) > zeroGroupsMax*float64(known) {
			assertion = fmt.Errorf("%w: %d of %d courses that had groups came back with none",
				catalog.ErrSuspectRun, lost, known)
			return assertion
		}
		return r.lim.wait(ctx, detailPosts)
	})

	switch {
	case assertion != nil:
		return ok, false, assertion
	case err != nil:
		return ok, false, err
	case ok == 0 && failed > 0:
		return 0, false, fmt.Errorf("all %d courses failed", failed)
	}
	return ok, false, nil
}

// workList is every program the directory cache knows, optionally narrowed to
// one sede. An empty list is not an error but it is worth shouting about: it
// means nobody has run --mode=reference yet, and every sweep after this one
// would silently do nothing.
func (r *refresher) workList(ctx context.Context) ([]catalog.Program, error) {
	programs, err := r.svc.AllPrograms(ctx)
	if err != nil {
		return nil, err
	}
	if r.opts.Campus != "" {
		filtered := programs[:0:0]
		for _, p := range programs {
			if p.CampusCode == r.opts.Campus {
				filtered = append(filtered, p)
			}
		}
		programs = filtered
	}
	if len(programs) == 0 {
		r.log.Warn("refresher: no programs in the directory cache; run --mode=reference first",
			"campus", r.opts.Campus)
	}
	return programs, nil
}

// campusCodes lists the distinct sedes of a program list, in first-seen
// order (Store.Programs orders by campus_code, so that is stable).
func campusCodes(programs []catalog.Program) []string {
	seen := make(map[string]bool)
	var out []string
	for _, p := range programs {
		if !seen[p.CampusCode] {
			seen[p.CampusCode] = true
			out = append(out, p.CampusCode)
		}
	}
	return out
}

func (r *refresher) noteError(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rep.addError(err)
}
