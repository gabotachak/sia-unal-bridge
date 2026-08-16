package catalog

import "errors"

var (
	ErrNotFound       = errors.New("not found")
	ErrNoOffering     = errors.New("course exists but has no offering this term")
	ErrAmbiguous      = errors.New("ambiguous shortcut: multiple candidates")
	ErrSIANoop        = errors.New("sia returned an empty re-render")
	ErrSIASessionLost = errors.New("sia session lost after retry")
	ErrBusy           = errors.New("sia connection pool busy")
)

// AmbiguousError carries the candidates for ErrAmbiguous: the programs that
// offer the requested course, so the client can pick
// /v1/programs/{program}/courses/{code}.
type AmbiguousError struct {
	Candidates []Program
}

func (e *AmbiguousError) Error() string { return ErrAmbiguous.Error() }
func (e *AmbiguousError) Unwrap() error { return ErrAmbiguous }
