package sia

import "net/url"

// XML event payloads. Verbatim from bruno/sia-catalogo (verified against
// production 2026-08-15). See docs/PROTOCOL.md §2.
const (
	xmlValueChange = `<m xmlns="http://oracle.com/richClient/comm"><k v="autoSubmit"><b>1</b></k><k v="suppressMessageShow"><s>true</s></k><k v="type"><s>valueChange</s></k></m>`
	xmlAction      = `<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>`
)

// formState is the SIA's accumulated dropdown/filter state. The full state
// is sent on every POST — see docs/PROTOCOL.md §2 "Estado del formulario".
type formState struct {
	Nivel, Sede, Facultad, Carrera, Tipologia string // soc1 soc9 soc2 soc3 soc4
	Modo, SedeElect, FacElect, Plan           string // soc5 soc10 soc6 soc7
	Creditos, Nombre                          string // it10 it11
}

func (s formState) values() url.Values {
	v := url.Values{}
	v.Set("pt1:r1:0:soc1", s.Nivel)
	v.Set("pt1:r1:0:soc9", s.Sede)
	v.Set("pt1:r1:0:soc2", s.Facultad)
	v.Set("pt1:r1:0:soc3", s.Carrera)
	v.Set("pt1:r1:0:soc4", s.Tipologia)
	v.Set("pt1:r1:0:soc5", s.Modo)
	v.Set("pt1:r1:0:soc10", s.SedeElect)
	v.Set("pt1:r1:0:soc6", s.FacElect)
	v.Set("pt1:r1:0:soc7", s.Plan)
	v.Set("pt1:r1:0:it10", s.Creditos)
	v.Set("pt1:r1:0:it11", s.Nombre)
	v.Set("org.apache.myfaces.trinidad.faces.FORM", "f1")
	v.Set("Adf-Window-Id", windowID)
	v.Set("Adf-Page-Id", pageID)
	return v
}

// eventValues builds a full POST body: form state + the event triple
// (event, event.<id>, PROCESS), optionally with DELTAS.
func (s formState) eventValues(viewState, eventID, payload, process, deltas string) url.Values {
	v := s.values()
	v.Set("javax.faces.ViewState", viewState)
	if deltas != "" {
		v.Set("oracle.adf.view.rich.DELTAS", deltas)
	}
	v.Set("event", eventID)
	v.Set("event."+eventID, payload)
	v.Set("oracle.adf.view.rich.PROCESS", process)
	return v
}

// valueChangeValues builds the body for a dropdown valueChange event on
// component id (e.g. "pt1:r1:0:soc1").
func (s formState) valueChangeValues(viewState, id string) url.Values {
	return s.eventValues(viewState, id, xmlValueChange, id, "")
}

// actionValues builds the body for a button/link action on component id
// (e.g. "pt1:r1:0:cb1"), PROCESS-qualified with the root region.
func (s formState) actionValues(viewState, id, deltas string) url.Values {
	return s.eventValues(viewState, id, xmlAction, "pt1:r1,"+id, deltas)
}
