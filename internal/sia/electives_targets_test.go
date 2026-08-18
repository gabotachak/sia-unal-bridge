package sia

import (
	"reflect"
	"testing"
)

// A sede whose soc6 lists a single option is Amazonia and Caribe every day:
// their only entry is the campus-wide one. The sweep of 2026-08-17 rejected
// it and left 14 plans with no catalog at all.
func TestElectivesTargets(t *testing.T) {
	opts := func(pairs ...string) map[string]string {
		html := "<select>" + `<option value="" _adfTmpOpt="t"></option>`
		for i := 0; i < len(pairs); i += 2 {
			html += `<option value="` + pairs[i] + `">` + pairs[i+1] + `</option>`
		}
		return map[string]string{"pt1:r1:0:soc6": html + "</select>"}
	}

	for _, tc := range []struct {
		name string
		env  map[string]string
		want []string
	}{
		{"single campus-wide option", opts("0", "6000 SEDE AMAZONIA"), []string{"0"}},
		{"wildcard is not first", opts(
			"0", "7064 FACULTAD DE ARQUITECTURA",
			"1", "7037 FACULTAD DE CIENCIAS EXACTAS",
			"2", "7000 SEDE ORINOQUIA"), []string{"2"}},
		{"no wildcard: every faculty", opts(
			"0", "2055 FACULTAD DE INGENIERÍA",
			"1", "2056 FACULTAD DE CIENCIAS"), []string{"0", "1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := electivesTargets(tc.env)
			if err != nil {
				t.Fatalf("electivesTargets: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}

	// Zero options stays an error: every sede lists at least itself, so an
	// empty dropdown means the soc10 before it did not take effect.
	if _, err := electivesTargets(opts()); err == nil {
		t.Error("expected an error for an empty soc6")
	}
	if _, err := electivesTargets(map[string]string{}); err == nil {
		t.Error("expected an error when soc6 is absent from the response")
	}
}
