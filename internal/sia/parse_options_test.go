package sia

import "testing"

func TestParseOptions_Faculties(t *testing.T) {
	opts, err := ParseOptions(fixture(t, "cascada_soc2_facultades_2026-08-15.xml"), "pt1:r1:0:soc2")
	if err != nil {
		t.Fatalf("ParseOptions: %v", err)
	}
	if len(opts) != 13 {
		t.Fatalf("got %d faculties, want 13 (12 real + Bogotá wildcard)", len(opts))
	}
	var ingenieria *Option
	for i := range opts {
		if opts[i].Index == 8 {
			ingenieria = &opts[i]
		}
	}
	if ingenieria == nil {
		t.Fatal("index 8 (Ingeniería) not found")
	}
	if ingenieria.Code != "2055" {
		t.Errorf("got code %q, want 2055", ingenieria.Code)
	}
	if ingenieria.Name != "FACULTAD DE INGENIERÍA" {
		t.Errorf("got name %q, want FACULTAD DE INGENIERÍA", ingenieria.Name)
	}
}

func TestParseOptions_Programs(t *testing.T) {
	opts, err := ParseOptions(fixture(t, "cascada_soc3_carreras_2026-08-15.xml"), "pt1:r1:0:soc3")
	if err != nil {
		t.Fatalf("ParseOptions: %v", err)
	}
	if len(opts) != 12 {
		t.Fatalf("got %d programs, want 12", len(opts))
	}

	// Two "Ingeniería de Sistemas y Computación" entries with DIFFERENT
	// institutional codes — must not collapse (FIELDS.md).
	var codes []string
	for _, o := range opts {
		if o.Name == "INGENIERÍA DE SISTEMAS Y COMPUTACIÓN" {
			codes = append(codes, o.Code)
		}
	}
	if len(codes) != 2 {
		t.Fatalf("got %d 'Ingeniería de Sistemas y Computación' entries, want 2 distinct codes: %v", len(codes), codes)
	}
	if codes[0] == codes[1] {
		t.Errorf("both entries share code %q — must be distinct (2A74 vs 2879)", codes[0])
	}
}

func TestParseOptions_BlankPlaceholderSkipped(t *testing.T) {
	opts, err := ParseOptions(fixture(t, "cascada_soc3_carreras_2026-08-15.xml"), "pt1:r1:0:soc3")
	if err != nil {
		t.Fatalf("ParseOptions: %v", err)
	}
	for _, o := range opts {
		if o.Code == "" {
			t.Errorf("blank placeholder option leaked through: %+v", o)
		}
	}
}
