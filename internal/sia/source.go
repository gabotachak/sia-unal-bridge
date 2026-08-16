package sia

import (
	"context"
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

func (s *Source) FetchProgramDirectory(ctx context.Context, level, campusIdx int) ([]catalog.DropdownOption, map[int][]catalog.DropdownOption, error) {
	conn, release, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer release()
	faculties, programs, err := conn.FetchProgramDirectory(ctx, level, campusIdx)
	if err != nil {
		return nil, nil, err
	}
	programsOut := make(map[int][]catalog.DropdownOption, len(programs))
	for idx, opts := range programs {
		programsOut[idx] = toDomainOptions(opts)
	}
	return toDomainOptions(faculties), programsOut, nil
}

func toDomainOptions(opts []Option) []catalog.DropdownOption {
	out := make([]catalog.DropdownOption, len(opts))
	for i, o := range opts {
		out[i] = catalog.DropdownOption{Index: o.Index, Code: o.Code, Name: o.Name}
	}
	return out
}

func (s *Source) FetchCatalog(ctx context.Context, key catalog.ProgramKey) ([]catalog.CourseOffering, error) {
	conn, release, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()

	body, err := conn.FetchCatalog(ctx, key)
	if err != nil {
		return nil, err
	}
	rows, err := ParseList(body)
	if err != nil {
		return nil, err
	}
	return offeringsFromRows(DedupeByCode(rows), key), nil
}

func (s *Source) FetchElectives(ctx context.Context, key catalog.ProgramKey) ([]catalog.CourseOffering, error) {
	conn, release, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()

	body, err := conn.FetchElectives(ctx, key)
	if err != nil {
		return nil, err
	}
	rows, err := ParseList(body)
	if err != nil {
		return nil, err
	}
	return offeringsFromRows(DedupeByCode(rows), key), nil
}

func (s *Source) FetchDetail(ctx context.Context, key catalog.ProgramKey, code, term string) (catalog.CourseOffering, error) {
	conn, release, err := s.pool.Acquire(ctx)
	if err != nil {
		return catalog.CourseOffering{}, err
	}
	defer release()

	row, err := findRow(ctx, conn, key, code)
	if err != nil {
		return catalog.CourseOffering{}, err
	}

	body, _, err := conn.FetchDetail(ctx, row.RowKey)
	if err != nil {
		return catalog.CourseOffering{}, err
	}
	// Leave the detail region regardless of what happens next — an
	// unreturned conn is stuck for every future caller (GOTCHAS §10/§20).
	defer func() { _, _ = conn.Volver(ctx) }()

	campusCode := CampusCode(key.Campus)
	d, err := ParseDetail(body, campusCode, code, term)
	if err != nil {
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
// back to its electives listing (libre elección never appears in the
// regular one — GOTCHAS §21). Returns catalog.ErrNotFound if neither has it.
func findRow(ctx context.Context, conn *SIAConn, key catalog.ProgramKey, code string) (Row, error) {
	if body, err := conn.FetchCatalog(ctx, key); err == nil {
		if rows, perr := ParseList(body); perr == nil {
			for _, r := range rows {
				if r.Code == code {
					return r, nil
				}
			}
		}
	}

	body, err := conn.FetchElectives(ctx, key)
	if err != nil {
		return Row{}, err
	}
	rows, err := ParseList(body)
	if err != nil {
		return Row{}, err
	}
	for _, r := range rows {
		if r.Code == code {
			return r, nil
		}
	}
	return Row{}, catalog.ErrNotFound
}

func offeringsFromRows(rows []Row, key catalog.ProgramKey) []catalog.CourseOffering {
	campusCode := CampusCode(key.Campus)
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
