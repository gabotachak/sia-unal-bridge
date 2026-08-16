package sia

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// Option is one <option> of a cascade dropdown: Index is the volatile
// positional value SIA uses internally (soc2/soc3/...); Code/Name come from
// splitting the label on its first token — 'code, rest = name'
// (DATA-MODEL.md decision 7, GOTCHAS §26). Index is NEVER an identity or a
// URL segment.
type Option struct {
	Index int
	Code  string
	Name  string
}

// ParseOptions extracts the <option> list of the named dropdown
// (e.g. "pt1:r1:0:soc2", "pt1:r1:0:soc3") from a raw cascade response. The
// blank placeholder option (value="") is skipped.
func ParseOptions(raw []byte, selectID string) ([]Option, error) {
	env, err := ParseEnvelope(raw)
	if err != nil {
		return nil, fmt.Errorf("sia: ParseOptions: %w", err)
	}
	html, ok := env[selectID]
	if !ok {
		return nil, fmt.Errorf("sia: ParseOptions: no update id=%q in response", selectID)
	}
	return parseOptionsHTML(html)
}

// parseOptionsHTML is the pure (no envelope-parsing) half of ParseOptions,
// reusable by cascade.go when it already has the envelope map from a POST.
func parseOptionsHTML(html string) ([]Option, error) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return nil, fmt.Errorf("sia: parseOptionsHTML: %w", err)
	}

	var opts []Option
	doc.Find("option").Each(func(_ int, o *goquery.Selection) {
		val, _ := o.Attr("value")
		if val == "" {
			return
		}
		idx, err := strconv.Atoi(val)
		if err != nil {
			return
		}
		code, name := splitCodeName(strings.TrimSpace(o.Text()))
		if code == "" {
			return
		}
		opts = append(opts, Option{Index: idx, Code: code, Name: name})
	})
	return opts, nil
}

// LabelOption is one <option> of a dropdown whose label carries NO
// institutional code — soc1 is the only one ("Pregrado", not "1101 SEDE
// BOGOTÁ"). Splitting it like the others would produce code="Postgrados",
// name="y másteres": a public identity invented out of a prefix.
type LabelOption struct {
	Index int
	Label string
}

// parseLabelOptionsHTML is parseOptionsHTML without the code/name split.
func parseLabelOptionsHTML(html string) ([]LabelOption, error) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return nil, fmt.Errorf("sia: parseLabelOptionsHTML: %w", err)
	}

	var opts []LabelOption
	doc.Find("option").Each(func(_ int, o *goquery.Selection) {
		val, _ := o.Attr("value")
		if val == "" {
			return
		}
		idx, err := strconv.Atoi(val)
		if err != nil {
			return
		}
		label := strings.TrimSpace(o.Text())
		if label == "" {
			return
		}
		opts = append(opts, LabelOption{Index: idx, Label: label})
	})
	return opts, nil
}

// splitCodeName applies "first token = código, resto = nombre"
// (DATA-MODEL.md §7): '2A74 INGENIERÍA DE SISTEMAS...' -> ("2A74",
// "INGENIERÍA DE SISTEMAS...").
func splitCodeName(label string) (code, name string) {
	parts := strings.SplitN(label, " ", 2)
	if len(parts) == 0 {
		return "", ""
	}
	code = parts[0]
	if len(parts) == 2 {
		name = strings.TrimSpace(parts[1])
	}
	return code, name
}
