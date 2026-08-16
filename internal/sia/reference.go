package sia

// campusCodes maps the soc9/soc10 dropdown POSITION to the institutional
// campus code that identifies it outside the SIA's own navigation. Verified
// 2026-08-15, docs/FIELDS.md. Positions are volatile by design (GOTCHAS
// §26's sibling problem for programs) but this list has been stable since
// at least March 2026.
var campusCodes = map[int]string{
	1: "1125", // AMAZONIA
	2: "1101", // BOGOTÁ
	3: "1126", // CARIBE
	4: "9933", // DE LA PAZ
	5: "1103", // MANIZALES
	6: "1102", // MEDELLÍN
	7: "1124", // ORINOQUIA
	8: "1104", // PALMIRA
	9: "9920", // TUMACO
}

// CampusCode returns the institutional code for a soc9/soc10 dropdown
// index, or "" if idx is out of the known range.
func CampusCode(idx int) string { return campusCodes[idx] }
