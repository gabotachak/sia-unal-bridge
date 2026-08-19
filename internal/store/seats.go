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
//
// MeasuredAt comes from section.seats_checked_at, not from the snapshot:
// with the dedupe of migración 00002 the snapshot only moves when the number
// changes, so its timestamp answers "cuándo cambió", not "de cuándo es este
// número". The coalesce covers rows written before that migration.
func (s *Store) CurrentSeats(ctx context.Context, sectionID int64) (catalog.SeatSnapshot, bool, error) {
	var snap catalog.SeatSnapshot
	err := s.pool.QueryRow(ctx, `
		SELECT cs.available_seats, coalesce(sec.seats_checked_at, cs.measured_at), cs.measured_at
		FROM current_seats cs
		JOIN section sec ON sec.id = cs.section_id
		WHERE cs.section_id = $1`,
		sectionID,
	).Scan(&snap.Available, &snap.MeasuredAt, &snap.ChangedAt)
	if err == pgx.ErrNoRows {
		return catalog.SeatSnapshot{}, false, nil
	}
	if err != nil {
		return catalog.SeatSnapshot{}, false, fmt.Errorf("store: CurrentSeats: %w", err)
	}
	return snap, true, nil
}
