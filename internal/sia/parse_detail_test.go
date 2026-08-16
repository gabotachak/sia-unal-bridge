package sia

import (
	"strings"
	"testing"
)

func TestParseDetail_32GruposConPeama(t *testing.T) {
	d, err := ParseDetail(fixture(t, "detalle_1000004-B_32grupos_peama_2026-08-15.xml"), "1101", "1000004-B", "2026-2")
	if err != nil {
		t.Fatalf("ParseDetail: %v", err)
	}
	if len(d.Sections) != 32 {
		t.Fatalf("got %d sections, want 32 (GOTCHAS §24/§27)", len(d.Sections))
	}

	keys := map[string]bool{}
	number1 := 0
	for _, s := range d.Sections {
		if s.Key == "" {
			t.Errorf("section with empty key: %+v", s)
		}
		keys[s.Key] = true
		if s.Number == 1 {
			number1++
		}
	}
	if len(keys) != 32 {
		t.Errorf("got %d unique keys, want 32 (no key collisions)", len(keys))
	}
	// Live data at capture time (2026-08-15): 4 PEAMA sites offer their own
	// "Grupo 1" (TUMA-01, AMAZ-01, CARI-01, ORIN-01); this course's own
	// regular numbering happens to skip plain "(1)" this term. The
	// invariant that matters is no key COLLISION despite the shared number
	// — asserted above via len(keys) == 32.
	if number1 < 4 {
		t.Errorf("expected at least 4 sections numbered 'Grupo 1' (PEAMA sites), got %d", number1)
	}
}

func TestParseDetail_2027641ZeroGroups(t *testing.T) {
	d, err := ParseDetail(fixture(t, "detalle_2027641_0grupos_2026-08-15.xml"), "1101", "2027641", "2026-2")
	if err != nil {
		t.Fatalf("ParseDetail: %v", err)
	}
	if len(d.Sections) != 0 {
		t.Fatalf("got %d sections, want 0 (GOTCHAS §18)", len(d.Sections))
	}
	if err != nil {
		t.Fatalf("0-group course must parse without error, got %v", err)
	}
}

func TestParseDetail_PrerequisitesExtracted(t *testing.T) {
	d, err := ParseDetail(fixture(t, "detalle_1000003-B_con_prerrequisitos_2026-08-15.xml"), "1101", "1000003-B", "2026-2")
	if err != nil {
		t.Fatalf("ParseDetail: %v", err)
	}
	if len(d.Prerequisites) == 0 {
		t.Fatal("expected at least one prerequisite to be extracted")
	}
	p := d.Prerequisites[0]
	if p.Type != "M" {
		t.Errorf("got type %q, want M", p.Type)
	}
	if p.Code == "" || p.Name == "" {
		t.Errorf("prerequisite missing code/name: %+v", p)
	}
}

func TestParseDetail_HeaderFields(t *testing.T) {
	d, err := ParseDetail(fixture(t, "detalle_1000004-B_32grupos_peama_2026-08-15.xml"), "1101", "1000004-B", "2026-2")
	if err != nil {
		t.Fatalf("ParseDetail: %v", err)
	}
	if d.Credits != 4 {
		t.Errorf("got credits %d, want 4", d.Credits)
	}
	if d.Name == "" {
		t.Error("Name must not be empty")
	}
}

func TestParseSchedule_GroupWithoutScheduleIsEmpty(t *testing.T) {
	d, err := ParseDetail(fixture(t, "detalle_1000003-B_con_prerrequisitos_2026-08-15.xml"), "1101", "1000003-B", "2026-2")
	if err != nil {
		t.Fatalf("ParseDetail: %v", err)
	}
	var found bool
	for _, s := range d.Sections {
		if s.Key == "SUMA-01" {
			found = true
			if len(s.Schedule) != 0 {
				t.Errorf("SUMA-01 has 'Horarios/Aula: No informado' with no Fecha: — expected 0 sessions, got %d", len(s.Schedule))
			}
			if s.Site != "SUMA" {
				t.Errorf("got site %q, want SUMA", s.Site)
			}
		}
	}
	if !found {
		t.Skip("SUMA-01 group not present in this fixture capture")
	}
}

func TestParseDetail_SeatsExtracted(t *testing.T) {
	d, err := ParseDetail(fixture(t, "detalle_1000004-B_32grupos_peama_2026-08-15.xml"), "1101", "1000004-B", "2026-2")
	if err != nil {
		t.Fatalf("ParseDetail: %v", err)
	}
	for _, s := range d.Sections {
		if s.Key == "10" {
			if s.Seats == nil {
				t.Fatal("Seats must not be nil — cupos is the whole point of this project")
			}
			if s.Seats.Available != 53 {
				t.Errorf("got %d seats, want 53 (fixture: 'Cupos disponibles: 53')", s.Seats.Available)
			}
			return
		}
	}
	t.Fatal("group with key '10' not found")
}

func TestParseSchedule_GroupWithScheduleHasSessions(t *testing.T) {
	d, err := ParseDetail(fixture(t, "detalle_1000004-B_32grupos_peama_2026-08-15.xml"), "1101", "1000004-B", "2026-2")
	if err != nil {
		t.Fatalf("ParseDetail: %v", err)
	}
	for _, s := range d.Sections {
		if s.Key == "10" {
			if len(s.Schedule) != 2 {
				t.Fatalf("group (10) Grupo 10 has 2 weekday lines in the fixture, got %d", len(s.Schedule))
			}
			cs := s.Schedule[0]
			if cs.StartTime != "16:00" || cs.EndTime != "18:00" {
				t.Errorf("got %s-%s, want 16:00-18:00", cs.StartTime, cs.EndTime)
			}
			// Regression: buildingRe used to accept '453-203' (room code,
			// no spaces around the dash) as a building, leaving the real
			// '401 - Julio Garavito Armero' stuck in Room. The space
			// around the dash is what distinguishes a building line from
			// a room code — see parse_schedule.go's buildingRe comment.
			if cs.Building != "401 - Julio Garavito Armero" {
				t.Errorf("got building %q, want '401 - Julio Garavito Armero'", cs.Building)
			}
			if strings.Contains(cs.Room, " - ") {
				t.Errorf("room %q leaked a building fragment ' - '", cs.Room)
			}
			return
		}
	}
	t.Fatal("group with key '10' not found")
}
