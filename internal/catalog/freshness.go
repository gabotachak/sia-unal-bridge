package catalog

import "time"

// Default max-age per resource type. See docs/API.md "Frescura" — the seats
// default is a guess pending the 2026-08-27 measurement window
// (docs/OPEN-QUESTIONS.md §2).
const (
	FreshnessReference = 30 * 24 * time.Hour
	FreshnessCatalog   = 7 * 24 * time.Hour
	FreshnessDetail    = 24 * time.Hour
	FreshnessSeats     = 5 * time.Minute
)

// Fresh reports whether a timestamp measured at t is still within maxAge of
// now. A nil t (never fetched) is never fresh.
func Fresh(t *time.Time, maxAge time.Duration, now time.Time) bool {
	if t == nil {
		return false
	}
	return now.Sub(*t) < maxAge
}
