package catalog

import "time"

type Course struct {
	CampusCode  string    `db:"campus_code" json:"campus_code"`
	Code        string    `db:"code"        json:"code"`
	Name        string    `db:"name"        json:"name"`
	Credits     int       `db:"credits"     json:"credits"`
	Description string    `db:"description" json:"description,omitempty"`
	FetchedAt   time.Time `db:"fetched_at"  json:"fetched_at"`

	Sections []Section `json:"sections,omitempty"`
}

type Section struct {
	ID         int64  `db:"id"          json:"-"`
	CampusCode string `db:"campus_code" json:"-"`
	Code       string `db:"code"        json:"-"`
	Term       string `db:"term"        json:"term"`

	// Key is the parenthesised token, verbatim: "1", "AMAZ-07", "TUMA-01".
	// Identity inside the course. Number alone collides. See DATA-MODEL.md
	// decision 8.
	Key        string `db:"key"         json:"key"`
	Number     int    `db:"number"      json:"number"`
	Site       string `db:"site"        json:"site,omitempty"`
	SiteCampus string `db:"site_campus" json:"site_campus,omitempty"`

	Label      string     `db:"label"      json:"label,omitempty"`
	Instructor string     `db:"instructor" json:"instructor,omitempty"`
	Shift      string     `db:"shift"      json:"shift,omitempty"`
	Duration   string     `db:"duration"   json:"duration,omitempty"`
	StartDate  *time.Time `db:"start_date" json:"start_date,omitempty"`
	EndDate    *time.Time `db:"end_date"   json:"end_date,omitempty"`
	FetchedAt  time.Time  `db:"fetched_at" json:"fetched_at"`

	Schedule []ClassSession `json:"schedule"`
	Seats    *SeatSnapshot  `json:"seats,omitempty"`
}

type ClassSession struct {
	Weekday   time.Weekday `db:"weekday"    json:"weekday"`
	StartTime string       `db:"start_time" json:"start_time"`
	EndTime   string       `db:"end_time"   json:"end_time"`
	Room      string       `db:"room"       json:"room,omitempty"`
	Building  string       `db:"building"   json:"building,omitempty"`
}

// SeatSnapshot is a seat count with the two timestamps that answer two
// different questions (docs/FASE-2.md "Cupos"):
//
//	MeasuredAt — cuándo se MIRÓ (section.seats_checked_at). Frescura,
//	             age_seconds, Cache-Control. Se actualiza en cada medición.
//	ChangedAt  — cuándo CAMBIÓ (max(seat_snapshot.measured_at)). Historial.
//	             Solo se mueve cuando el número es distinto al anterior.
//
// Separarlos es lo que permite deduplicar seat_snapshot sin que el dato
// PAREZCA viejo y dispare el read-through que el job existe para evitar:
// medido, 0 cambios en 347 grupos a lo largo de 35 min.
type SeatSnapshot struct {
	Available  int        `db:"available_seats"  json:"available"`
	MeasuredAt time.Time  `db:"seats_checked_at" json:"measured_at"`
	ChangedAt  *time.Time `db:"measured_at"      json:"changed_at,omitempty"`
}

func (s SeatSnapshot) AgeSeconds() int { return int(time.Since(s.MeasuredAt).Seconds()) }

// CourseSeats is the seat total of a course as ALREADY STORED — the sum over
// the groups this program can see, plus the age of the oldest of those
// measurements.
//
// It never triggers a fetch: a course whose detail was never pulled simply
// has no CourseSeats, and that absence is the honest answer. Sirve para que
// el listado del plan diga algo útil sin pagar un POST por asignatura.
type CourseSeats struct {
	Available  int       `json:"available"`
	MeasuredAt time.Time `json:"measured_at"`
	Sections   int       `json:"sections"`
}

// Prerequisite and Component arrive free in the same detail POST but are not
// persisted yet (fase 1 scope). See docs/PLAN.md "Lo que no se hace en fase 1".
type Prerequisite struct {
	Condition int    `json:"condition"`
	Type      string `json:"type"` // M, O, E, A
	Code      string `json:"code"`
	Name      string `json:"name"`
}

type Component struct {
	Kind string `json:"kind"` // 'CLASE TEORICA', ...
	Code string `json:"code"`
}

// SectionSchedule is a group reduced to what a schedule-clash check needs:
// its identity and when it meets. It is what the catalog list carries under
// ?include=schedules — the full Section (instructor, room, seats, dates)
// would multiply that payload for data the check never reads.
type SectionSchedule struct {
	Key      string         `json:"key"`
	Schedule []ClassSession `json:"schedule"`
}
