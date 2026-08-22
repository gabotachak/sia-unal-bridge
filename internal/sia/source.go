package sia

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// Source implements catalog.SIASource over a Pool. It does not import
// catalog to satisfy an interface declared there structurally — it imports
// it for the domain types it returns, which is the allowed direction
// (docs/LAYOUT.md).
type Source struct {
	pool *Pool
}

var _ catalog.SIASource = (*Source)(nil)

func NewSource(pool *Pool) *Source {
	return &Source{pool: pool}
}

func (s *Source) FetchLevels(ctx context.Context) ([]catalog.LabelOption, error) {
	return Do(ctx, s.pool, func(conn *SIAConn) ([]catalog.LabelOption, error) {
		opts, err := conn.FetchLevels(ctx)
		if err != nil {
			return nil, err
		}
		out := make([]catalog.LabelOption, len(opts))
		for i, o := range opts {
			out[i] = catalog.LabelOption{Index: o.Index, Label: o.Label}
		}
		return out, nil
	})
}

func (s *Source) FetchCampuses(ctx context.Context, level int) ([]catalog.DropdownOption, error) {
	return Do(ctx, s.pool, func(conn *SIAConn) ([]catalog.DropdownOption, error) {
		campuses, err := conn.FetchCampuses(ctx, level)
		if err != nil {
			return nil, err
		}
		return toDomainOptions(campuses), nil
	})
}

// directory is FetchProgramDirectory's two return values in one value, so
// the operation can go through the generic Do (which retries a dead session
// once) instead of hand-rolling the acquire/release dance.
type directory struct {
	faculties []catalog.DropdownOption
	programs  map[int][]catalog.DropdownOption
}

func (s *Source) FetchProgramDirectory(ctx context.Context, level, campusIdx int) ([]catalog.DropdownOption, map[int][]catalog.DropdownOption, error) {
	dir, err := Do(ctx, s.pool, func(conn *SIAConn) (directory, error) {
		faculties, programs, err := conn.FetchProgramDirectory(ctx, level, campusIdx)
		if err != nil {
			return directory{}, err
		}
		programsOut := make(map[int][]catalog.DropdownOption, len(programs))
		for idx, opts := range programs {
			programsOut[idx] = toDomainOptions(opts)
		}
		return directory{faculties: toDomainOptions(faculties), programs: programsOut}, nil
	})
	if err != nil {
		return nil, nil, err
	}
	return dir.faculties, dir.programs, nil
}

func toDomainOptions(opts []Option) []catalog.DropdownOption {
	out := make([]catalog.DropdownOption, len(opts))
	for i, o := range opts {
		out[i] = catalog.DropdownOption{Index: o.Index, Code: o.Code, Name: o.Name}
	}
	return out
}

func (s *Source) FetchCatalog(ctx context.Context, key catalog.ProgramKey) ([]catalog.CourseOffering, error) {
	return Do(ctx, s.pool, func(conn *SIAConn) ([]catalog.CourseOffering, error) {
		body, err := conn.FetchCatalog(ctx, key)
		if err != nil {
			return nil, err
		}
		rows, err := ParseList(body)
		if err != nil {
			return nil, err
		}
		return offeringsFromRows(DedupeByCode(rows), key), nil
	})
}

func (s *Source) FetchElectives(ctx context.Context, key catalog.ProgramKey) ([]catalog.CourseOffering, error) {
	return Do(ctx, s.pool, func(conn *SIAConn) ([]catalog.CourseOffering, error) {
		bodies, err := conn.FetchElectives(ctx, key)
		if err != nil {
			return nil, err
		}
		rows, err := electiveRows(bodies)
		if err != nil {
			return nil, err
		}
		return offeringsFromRows(DedupeByCode(rows), key), nil
	})
}

// electiveRows unions the listings FetchElectives came back with: one body
// with the sede wildcard, one per faculty at the levels that have no wildcard.
// Codes repeat across faculties, so the union is deduped by the caller.
//
// A body that has no results table is an EMPTY faculty, not a failure — at
// doctorado level most faculties have no libre elección at all. The parse
// error is only returned when nothing at all could be read, which is a real
// protocol problem.
//
// The RowKey of these rows MUST NOT be clicked. Every body restarts _afrRK at
// 0, so in the union a key means nothing — use FindElectiveRow, which stops on
// the listing that has the code and leaves it live (GOTCHAS §38). This union
// exists for the catalog, which only reads codes, names and credits.
func electiveRows(bodies [][]byte) ([]Row, error) {
	var rows []Row
	var firstErr error
	for _, body := range bodies {
		parsed, err := ParseList(body)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		rows = append(rows, parsed...)
	}
	if len(rows) == 0 && firstErr != nil {
		return nil, firstErr
	}
	return rows, nil
}

func (s *Source) FetchDetail(ctx context.Context, key catalog.ProgramKey, code, term string) (catalog.CourseOffering, error) {
	return Do(ctx, s.pool, func(conn *SIAConn) (catalog.CourseOffering, error) {
		return fetchDetail(ctx, conn, key, catalog.CourseRef{Code: code}, term)
	})
}

// FetchDetails walks several courses of one program over ONE connection.
// The saving is the re-parking, not the cb1: the _afrRK are renumbered by
// every Volver (GOTCHAS §4), so the listing is re-read for each course and
// never cached — that shortcut is what killed the previous project.
//
// A per-course failure goes to yield and the batch continues; a dead session
// (noop) re-bootstraps in place, because a 98-course batch that gives up on
// the first expiry is a batch that never finishes.
func (s *Source) FetchDetails(ctx context.Context, key catalog.ProgramKey, refs []catalog.CourseRef, term string,
	yield func(catalog.CourseOffering, error) error) error {
	_, err := Do(ctx, s.pool, func(conn *SIAConn) (struct{}, error) {
		for _, ref := range refs {
			if err := ctx.Err(); err != nil {
				return struct{}{}, err
			}
			off, ferr := fetchDetail(ctx, conn, key, ref, term)
			switch {
			case ferr == nil:
			case errors.Is(ferr, errSIAErrorPage):
				// The SIA killed its own session rendering this course, so
				// the connection is dead but the course is hopeless: retrying
				// it walks into the same broken page. Re-bootstrap so the
				// REST of the batch survives — without this, one bad course
				// takes the program's other 40 with it — and keep ferr.
				rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), rebootstrapTimeout)
				_, _ = conn.Bootstrap(rctx)
				cancel()
			case isRecoverable(ferr):
				rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), rebootstrapTimeout)
				_, berr := conn.Bootstrap(rctx)
				cancel()
				if berr == nil {
					off, ferr = fetchDetail(ctx, conn, key, ref, term)
				}
			}
			if err := yield(off, ferr); err != nil {
				return struct{}{}, err
			}
		}
		return struct{}{}, nil
	})
	return err
}

func fetchDetail(ctx context.Context, conn *SIAConn, key catalog.ProgramKey, ref catalog.CourseRef, term string) (catalog.CourseOffering, error) {
	code := ref.Code
	row, err := findRow(ctx, conn, key, code, ref.Name, catalog.IsElective(ref.Typology))
	if err != nil {
		return catalog.CourseOffering{}, err
	}

	body, _, err := conn.FetchDetail(ctx, row.RowKey)
	if err != nil {
		return catalog.CourseOffering{}, err
	}
	// Leave the detail region regardless of what happens next — an
	// unreturned conn is stuck for every future caller (GOTCHAS §10/§20).
	// Detached from ctx on purpose: a client that hangs up mid-detail must
	// not leave the connection parked in the region forever.
	defer func() {
		vctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), rebootstrapTimeout)
		defer cancel()
		_, _ = conn.Volver(vctx)
	}()

	campusCode := key.CampusCode
	d, err := ParseDetail(body, campusCode, code, term)
	if err != nil {
		return catalog.CourseOffering{}, err
	}
	if err := checkDetailCode(d, code); err != nil {
		return catalog.CourseOffering{}, err
	}

	course := catalog.Course{
		CampusCode:  campusCode,
		Code:        row.Code,
		Name:        row.Name,
		Credits:     row.Credits,
		Description: row.Description,
		FetchedAt:   time.Now(),
		Sections:    d.Sections,
	}
	return catalog.CourseOffering{Course: course, Typology: row.Typology}, nil
}

// findRow locates code's row key in the program's regular listing, falling
// back to its electives listing (libre elección never appears in the regular
// one — GOTCHAS §21). Returns catalog.ErrNotFound if neither has it.
//
// electivesFirst flips which listing is tried first: a libre elección course
// is NEVER in the regular one, so looking there first is 2-3 POSTs and a
// whole listing thrown away before the electives cascade even starts
// (catalog.IsElective, measured 2026-08-22 — 43% of the hot set).
//
// With a name it first narrows the listing through it11, which is the single
// optimisation of fase 2 that is worth a factor of 4: the unfiltered cb1 is
// 241 KB and the filtered one 15–27 KB, twice per course. It does NOT make
// the search faster — 0.5–0.9 s either way (measured) — it makes it lighter
// on a public university server.
//
// Two traps, both of the GOTCHAS §33 family:
//
//   - the filter can return several rows: the row is picked by CODE, never
//     by position;
//   - it11 stays put on the connection, so an unfiltered catalog fetched
//     right after a filtered detail would come back silently trimmed. The
//     form state carries it11 on every POST, so clearing the field IS the
//     reset — and it happens here, inside the logical operation, with the
//     same criterion by which FetchCatalog reposts soc4.
func findRow(ctx context.Context, conn *SIAConn, key catalog.ProgramKey, code, name string, electivesFirst bool) (Row, error) {
	if name != "" {
		conn.form.Nombre = name
		row, err := findRowInListings(ctx, conn, key, code, electivesFirst)
		conn.form.Nombre = "" // see above: never leave the filter behind
		if err == nil {
			return row, nil
		}
		// 0 rows, a parse failure, or a code the filter did not match
		// (accents, odd names) all fall through to the full listings.
	}
	return findRowInListings(ctx, conn, key, code, electivesFirst)
}

// findRowInListings looks for code in the regular listing and the electives
// one, in the order electivesFirst says, with whatever it11 filter the
// caller has set. Both halves are searched under the filter: the electives
// listing is the biggest single response the SIA serves (~240–320 KB, and
// libre elección courses are only ever found there), so filtering just the
// regular half would leave most of the bytes on the table.
//
// Error handling does not depend on order: whichever half fails with
// something other than catalog.ErrNotFound is kept, and only surfaced if the
// OTHER half also comes back without the code. A failed fetch used to be
// swallowed here — any error fell straight through to the second half, and
// if THAT also came back empty (certain, for a course that could only ever
// be in the failed half) the caller got a plain catalog.ErrNotFound. That is
// a confident lie: the course was never actually checked, a transient SIA
// hiccup was. Reported live 2026-08-21 as a course the Store already had
// (real sections, freshly crawled hours earlier) 404ing on every forced
// refresh — indistinguishable from "doesn't exist" from the outside. Now a
// fetch failure is kept and, if the other half doesn't resolve it either,
// surfaced instead of masked.
func findRowInListings(ctx context.Context, conn *SIAConn, key catalog.ProgramKey, code string, electivesFirst bool) (Row, error) {
	regular := func() (Row, error) {
		body, err := conn.FetchCatalog(ctx, key)
		if err != nil {
			return Row{}, err
		}
		rows, perr := ParseList(body)
		if perr != nil {
			return Row{}, fmt.Errorf("sia: findRowInListings: ParseList: %w", perr)
		}
		if r, ok := rowWithCode(rows, code); ok {
			return r, nil
		}
		return Row{}, catalog.ErrNotFound
	}
	// FindElectiveRow, not FetchElectives + electiveRows: the row is about to
	// be CLICKED, and an _afrRK only means anything while its own listing is
	// the live render. Where the sede has no wildcard the electives listing is
	// one search per faculty and every body restarts the keys at 0, so a key
	// picked out of the union clicks a row of whichever search ran last —
	// which is how every doctorado course reachable only through libre
	// elección failed with "no detail region id" (GOTCHAS §38).
	electives := func() (Row, error) { return conn.FindElectiveRow(ctx, key, code) }

	first, second := regular, electives
	if electivesFirst {
		first, second = electives, regular
	}

	// The first check to run either wins outright or leaves its error
	// pinned to what it actually is (regular vs electives); order never
	// changes which named error means what below.
	row, firstErr := first()
	if firstErr == nil {
		return row, nil
	}
	regularErr, electivesErr := firstErr, error(nil)
	if electivesFirst {
		regularErr, electivesErr = nil, firstErr
	}

	row, secondErr := second()
	if secondErr == nil {
		return row, nil
	}
	if electivesFirst {
		regularErr = secondErr
	} else {
		electivesErr = secondErr
	}

	if regularErr == nil {
		// Regular listing was checked in full (found or confirmed absent):
		// trust whatever electives came back with, real error or not.
		return Row{}, electivesErr
	}
	if !errors.Is(electivesErr, catalog.ErrNotFound) {
		slog.Warn("sia: findRowInListings: both listings failed to fetch",
			"level", key.Level, "campus", key.Campus, "faculty", key.Faculty, "program", key.Program,
			"code", code, "regular_err", regularErr, "electives_err", electivesErr)
		return Row{}, electivesErr
	}
	// Electives confirmed absence, but the regular fetch itself never
	// completed — do not report a course as unknown on the strength of a
	// search that broke. See the doc comment above.
	slog.Warn("sia: findRowInListings: regular fetch failed, electives came back empty — reporting the fetch failure instead of a false unknown_course",
		"level", key.Level, "campus", key.Campus, "faculty", key.Faculty, "program", key.Program,
		"code", code, "regular_err", regularErr)
	return Row{}, fmt.Errorf("sia: findRowInListings: regular check failed for %s: %w", code, regularErr)
}

// checkDetailCode compares the code the detail page printed with the one we
// asked for. They can only differ for reasons that all end in silently
// plausible data: two POSTs interleaved on one connection (GOTCHAS §28), an
// _afrRK read from a stale render (§4), or a row picked by position. There is
// no benign case, so it is an error and not a warning.
//
// A header that did not parse is left alone: the detail is still usable, and
// turning a header-regex miss into a hard failure would break the API over a
// cosmetic change to the page.
func checkDetailCode(d Detail, code string) error {
	if d.HeaderCode == "" || d.HeaderCode == code {
		return nil
	}
	return fmt.Errorf("%w: asked for %s, the detail page says %s", catalog.ErrSuspectRun, code, d.HeaderCode)
}

func rowWithCode(rows []Row, code string) (Row, bool) {
	for _, r := range rows {
		if r.Code == code {
			return r, true
		}
	}
	return Row{}, false
}

func offeringsFromRows(rows []Row, key catalog.ProgramKey) []catalog.CourseOffering {
	campusCode := key.CampusCode
	now := time.Now()
	out := make([]catalog.CourseOffering, len(rows))
	for i, r := range rows {
		out[i] = catalog.CourseOffering{
			Course: catalog.Course{
				CampusCode:  campusCode,
				Code:        r.Code,
				Name:        r.Name,
				Credits:     r.Credits,
				Description: r.Description,
				FetchedAt:   now,
			},
			Typology: r.Typology,
		}
	}
	return out
}
