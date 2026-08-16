package sia

import "encoding/xml"

// envelope is ADF's <partial-response>: a set of <update id="..."> blocks,
// each holding either HTML/CDATA payload or a plain value (ViewState).
type envelope struct {
	XMLName xml.Name `xml:"partial-response"`
	Updates []update `xml:"changes>update"`
}

type update struct {
	ID      string `xml:"id,attr"`
	Content string `xml:",chardata"`
}

// ParseEnvelope decodes a <partial-response> body into a map of update id →
// content (CDATA already unwrapped by the XML decoder).
func ParseEnvelope(body []byte) (map[string]string, error) {
	var e envelope
	if err := xml.Unmarshal(body, &e); err != nil {
		return nil, err
	}
	m := make(map[string]string, len(e.Updates))
	for _, u := range e.Updates {
		m[u.ID] = u.Content
	}
	return m, nil
}
