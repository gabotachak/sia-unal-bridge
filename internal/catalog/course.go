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

type SeatSnapshot struct {
	Available  int       `db:"available_seats" json:"available"`
	MeasuredAt time.Time `db:"measured_at"     json:"measured_at"`
}

func (s SeatSnapshot) AgeSeconds() int { return int(time.Since(s.MeasuredAt).Seconds()) }

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
