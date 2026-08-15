package catalog

import (
	"os/exec"
	"strings"
	"testing"
)

// TestDomainHasNoInfraImports guards the hexagon: internal/catalog must stay
// free of infrastructure. See docs/LAYOUT.md "La invariante que sostiene el
// hexágono".
func TestDomainHasNoInfraImports(t *testing.T) {
	out, err := exec.Command("go", "list", "-deps", "./...").Output()
	if err != nil {
		t.Fatalf("go list -deps: %v", err)
	}

	forbidden := []string{"gin-gonic", "jackc/pgx", "PuerkitoBio/goquery", "encoding/xml"}
	for _, line := range strings.Split(string(out), "\n") {
		for _, f := range forbidden {
			if strings.Contains(line, f) {
				t.Errorf("internal/catalog imports infrastructure: %s", line)
			}
		}
	}
}
