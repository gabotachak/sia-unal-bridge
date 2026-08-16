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

// AmbiguousError carries the candidates for ErrAmbiguous. Two different
// ambiguities produce it, hence Code/Hint: a course code offered by several
// programs, and a program code exposed by several (campus, faculty) pairs —
// program.code identifies nothing on its own (GOTCHAS §26).
type AmbiguousError struct {
	Candidates []Program
	Code       string // 'ambiguous_program' | 'ambiguous_course'
	Hint       string // what the caller should add to disambiguate
}

func (e *AmbiguousError) Error() string { return ErrAmbiguous.Error() }
func (e *AmbiguousError) Unwrap() error { return ErrAmbiguous }
