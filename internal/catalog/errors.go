package catalog

import "errors"

var (
	ErrNotFound       = errors.New("not found")
	ErrNoOffering     = errors.New("course exists but has no offering this term")
	ErrAmbiguous      = errors.New("ambiguous shortcut: multiple candidates")
	ErrSIANoop        = errors.New("sia returned an empty re-render")
	ErrSIASessionLost = errors.New("sia session lost after retry")
	ErrBusy           = errors.New("sia connection pool busy")

	// Sanity assertions. A crawler is a machine for multiplying a parsing
	// bug by 135 000, and this domain's characteristic failure is data that
	// is plausible and wrong (docs/FASE-2.md, paso 5). Both abort BEFORE
	// persisting, and both fire on the API's path too — a bug the job would
	// expose is a bug the API already had.
	ErrTruncated  = errors.New("listing hit the SIA's 1000-row cap: truncated, not a result")
	ErrSuspectRun = errors.New("sanity assertion failed: refusing to persist")
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
