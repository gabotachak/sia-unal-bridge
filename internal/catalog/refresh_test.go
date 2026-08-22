package catalog

import "testing"

func TestIsElective(t *testing.T) {
	cases := []struct {
		typology string
		want     bool
	}{
		{"LIBRE ELECCIÓN (L)", true},
		{"ELEGIBLES (L)", true},
		{"ELEGIBLES (U)", true},
		{"ELECTIVA DE PREGRADO (E)", true},
		{"ELECTIVA DE PREGRADO (A)", true},
		{"DISCIPLINAR OBLIGATORIA (C)", false},
		{"", false},
	}
	for _, c := range cases {
		if got := IsElective(c.typology); got != c.want {
			t.Errorf("IsElective(%q) = %v, want %v", c.typology, got, c.want)
		}
	}
}
