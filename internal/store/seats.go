package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// CurrentSeats reads the latest snapshot via the current_seats view —
// seat_snapshot is append-only (DATA-MODEL.md decision 4), this is always
// the newest row for sectionID.
func (s *Store) CurrentSeats(ctx context.Context, sectionID int64) (catalog.SeatSnapshot, bool, error) {
	var snap catalog.SeatSnapshot
	err := s.pool.QueryRow(ctx, `
		SELECT available_seats, measured_at FROM current_seats WHERE section_id = $1`,
		sectionID,
	).Scan(&snap.Available, &snap.MeasuredAt)
	if err == pgx.ErrNoRows {
		return catalog.SeatSnapshot{}, false, nil
	}
	if err != nil {
		return catalog.SeatSnapshot{}, false, fmt.Errorf("store: CurrentSeats: %w", err)
	}
	return snap, true, nil
}
