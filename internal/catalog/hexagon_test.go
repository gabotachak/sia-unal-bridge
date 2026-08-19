package catalog

import (
	"os/exec"
	"strings"
	"testing"
)

// TestDomainHasNoInfraImports guards the hexagon: internal/catalog must stay
// free of infrastructure. See docs/LAYOUT.md "La invariante que sostiene el
// hexágono".
//
// internal/refresher is checked here too (fase 2): it is a driving adapter,
// so it may depend on the domain and on nothing else — the moment it imports
// sia or store it stops entering through the use cases and becomes a second
// path into Postgres, which is exactly what docs/FASE-2.md forbids.
func TestDomainHasNoInfraImports(t *testing.T) {
	forbidden := []string{"gin-gonic", "jackc/pgx", "PuerkitoBio/goquery", "encoding/xml"}
	for _, pkg := range []string{"./...", "../refresher/..."} {
		out, err := exec.Command("go", "list", "-deps", pkg).Output()
		if err != nil {
			t.Fatalf("go list -deps %s: %v", pkg, err)
		}
		for _, line := range strings.Split(string(out), "\n") {
			for _, f := range forbidden {
				if strings.Contains(line, f) {
					t.Errorf("%s imports infrastructure: %s", pkg, line)
				}
			}
			// The adapters themselves are infrastructure, whatever they import.
			if strings.HasSuffix(line, "/internal/sia") || strings.HasSuffix(line, "/internal/store") ||
				strings.HasSuffix(line, "/internal/httpapi") {
				t.Errorf("%s imports the adapter %s directly", pkg, line)
			}
		}
	}
}
