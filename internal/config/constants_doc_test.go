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

// constRow matches a docs/CONSTANTS.md row whose third column is a source
// file: | `name` | `expr` | `path.go` | ... | (or .ts for the web app).
var constRow = regexp.MustCompile("^\\| `([A-Za-z_][A-Za-z0-9_]*)` \\| `([^`]+)` \\| `([^`]+\\.(?:go|ts))` \\|")

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
		var got string
		var ok bool
		if strings.HasSuffix(path, ".ts") {
			got, ok = tsConstExpr(t, "../../"+path, name)
		} else {
			got, ok = constExpr(t, "../../"+path, name)
		}
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

// tsConstExpr reads `export const NAME = <expr>;` from a TypeScript file.
// A regex is enough: the table only lists plain literal constants.
func tsConstExpr(t *testing.T, path, name string) (string, bool) {
	t.Helper()
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^export const ` + regexp.QuoteMeta(name) + `(?::[^=]+)? = (.+?);`).FindSubmatch(src)
	if m == nil {
		return "", false
	}
	return string(m[1]), true
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
