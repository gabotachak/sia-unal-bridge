package config

import (
	"bufio"
	"bytes"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"regexp"
	"strings"
	"testing"
)

// constRow matches a docs/CONSTANTS.md row whose third column is a Go file:
// | `name` | `expr` | `path.go` | ... |
var constRow = regexp.MustCompile("^\\| `([A-Za-z_][A-Za-z0-9_]*)` \\| `([^`]+)` \\| `([^`]+\\.go)` \\|")

// TestConstantsDocMatchesCode keeps docs/CONSTANTS.md, the one document that
// states numbers, honest: every row that names a Go source must match the
// constant's expression in that file, verbatim.
func TestConstantsDocMatchesCode(t *testing.T) {
	doc, err := os.ReadFile("../../docs/CONSTANTS.md")
	if err != nil {
		t.Fatal(err)
	}
	rows := 0
	sc := bufio.NewScanner(bytes.NewReader(doc))
	for sc.Scan() {
		m := constRow.FindStringSubmatch(sc.Text())
		if m == nil {
			continue
		}
		rows++
		name, want, path := m[1], m[2], m[3]
		got, ok := constExpr(t, "../../"+path, name)
		if !ok {
			t.Errorf("%s: constant %s not found", path, name)
			continue
		}
		if got != want {
			t.Errorf("%s in %s: docs say %q, code says %q", name, path, want, got)
		}
	}
	if rows == 0 {
		t.Fatal("no constant rows parsed from docs/CONSTANTS.md")
	}
}

func constExpr(t *testing.T, path, name string) (string, bool) {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.CONST {
			continue
		}
		for _, spec := range gd.Specs {
			vs := spec.(*ast.ValueSpec)
			for i, id := range vs.Names {
				if id.Name == name && i < len(vs.Values) {
					var b strings.Builder
					_ = printer.Fprint(&b, fset, vs.Values[i])
					return b.String(), true
				}
			}
		}
	}
	return "", false
}
