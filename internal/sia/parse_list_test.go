package sia

import (
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return b
}

func TestParseList_Regular98Rows(t *testing.T) {
	rows, err := ParseList(fixture(t, "listado_regular_2026-08-15.xml"))
	if err != nil {
		t.Fatalf("ParseList: %v", err)
	}
	if len(rows) != 98 {
		t.Fatalf("got %d rows, want 98", len(rows))
	}
	deduped := DedupeByCode(rows)
	if len(deduped) != 98 {
		t.Errorf("regular listing should have no duplicates: got %d unique of 98", len(deduped))
	}
}

func TestParseList_Electives240RowsDedupe215(t *testing.T) {
	rows, err := ParseList(fixture(t, "listado_electivas_2026-08-15.xml"))
	if err != nil {
		t.Fatalf("ParseList: %v", err)
	}
	if len(rows) != 240 {
		t.Fatalf("got %d rows, want 240", len(rows))
	}
	deduped := DedupeByCode(rows)
	if len(deduped) != 215 {
		t.Fatalf("got %d unique codes, want 215 (GOTCHAS §13)", len(deduped))
	}
}

func TestParseList_ForeignBootstrapYieldsZeroRows(t *testing.T) {
	rows, err := ParseList(fixture(t, "bootstrap_tabla_ajena_poblada_2026-08-15.xml"))
	if err == nil && len(rows) != 0 {
		t.Fatalf("bootstrap page must never be parsed as a listing: got %d rows", len(rows))
	}
}

func TestParseList_IncompleteCascadeNoopYieldsZeroRows(t *testing.T) {
	rows, err := ParseList(fixture(t, "noop_cascada_incompleta_2026-08-15.xml"))
	if err == nil && len(rows) != 0 {
		t.Fatalf("noop response must never be parsed as a listing: got %d rows", len(rows))
	}
}

func TestParseList_RowFields(t *testing.T) {
	rows, err := ParseList(fixture(t, "listado_regular_2026-08-15.xml"))
	if err != nil {
		t.Fatalf("ParseList: %v", err)
	}
	first := rows[0]
	if first.RowKey == "" {
		t.Error("RowKey must not be empty")
	}
	if first.Code == "" {
		t.Error("Code must not be empty")
	}
	if first.Name == "" {
		t.Error("Name must not be empty")
	}
}

func TestDedupeByCode_PreservesOrderAndFirstOccurrence(t *testing.T) {
	rows := []Row{
		{RowKey: "0", Code: "A", Name: "first"},
		{RowKey: "1", Code: "B", Name: "only"},
		{RowKey: "2", Code: "A", Name: "duplicate, should be dropped"},
	}
	out := DedupeByCode(rows)
	if len(out) != 2 {
		t.Fatalf("got %d rows, want 2", len(out))
	}
	if out[0].Code != "A" || out[0].Name != "first" {
		t.Errorf("first occurrence not preserved: %+v", out[0])
	}
	if out[1].Code != "B" {
		t.Errorf("second row wrong: %+v", out[1])
	}
}
