package sia

import (
	"bytes"
	"errors"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// errStaleDetailRegion marks "this connection is parked inside a numbered
// detail region and the caller asked for a region-0 action" (GOTCHAS
// §10/§20). It is a connection-state bug, not a server one, so Pool.Do
// treats it as recoverable: a bootstrap resets DetailRegion to 0.
var errStaleDetailRegion = errors.New("sia: connection stuck in a detail region")

// errSIAErrorPage marks the SIA blowing up on its own page: the response is
// cut off mid-CDATA and a redirect to errorNavegacion.jsf is appended to it.
// Measured 2026-08-18 on 2011302 "Asignatura por convenio con Universidad de
// los Andes I - PREGRADO", where the body ends right after "Créditos:" — the
// server chokes on the course, not on anything we sent.
//
// It is deliberately NOT recoverable. The session IS dead afterwards (every
// later POST answers an empty re-render), but a fresh one walks into the same
// broken page — measured on two courses of one doctorado, reproducible on a
// brand new connection — so retrying only pays for a second bootstrap to fail
// identically. FetchDetails re-bootstraps WITHOUT retrying the course, which
// is what keeps one bad course from taking the program's other 40 with it.
//
// Only a full-size body counts. A dead session answers the same redirect in
// 412–877 B, and that one IS a noop with a retry to earn. GOTCHAS §39.
var errSIAErrorPage = errors.New("sia: the SIA redirected to errorNavegacion.jsf")

// errorPageMarker is the redirect the SIA appends when its own render fails.
var errorPageMarker = []byte("errorNavegacion.jsf")

// isSIAErrorPage reports whether the SIA gave up rendering. Checked on EVERY
// response, not just details: the truncation can land on any action, and a
// half-parsed body is exactly the plausible-but-wrong data this project
// exists to avoid.
func isSIAErrorPage(body []byte) bool { return bytes.Contains(body, errorPageMarker) }

// noopThreshold separates a real re-render from ADF's silent no-op. Measured
// signatures: ~895B (missing cascade step / wrong detail region), ~1.2KB
// (session just expired, mute), 419B (explicit "session has timed out").
// The smallest real payload observed (cascade dropdown re-render) is ~2KB.
// See docs/GOTCHAS.md §6, §7, §20.
const noopThreshold = 1200

// isNoop reports whether body is ADF's silent no-op: a missing cascade step,
// a stale detailRegion, or an about-to-expire session. All three must be
// treated as an explicit error, never as "no results" — GOTCHAS.md §6.
func isNoop(body []byte) bool { return len(body) < noopThreshold }

// isSessionExpiredMessage reports the OTHER death signature: the explicit
// 419B message that arrives after the mute no-op window has passed.
func isSessionExpiredMessage(body []byte) bool {
	return bytes.Contains(body, []byte("session has timed out")) ||
		bytes.Contains(body, []byte("inactivity"))
}

// NoopError wraps catalog.ErrSIANoop with the raw body that triggered it, so
// callers (pool retry logic, /status, debugging) can tell the three
// signatures apart instead of only knowing "it was small". See GOTCHAS.md
// §6, §7, §20 — never treat any of them as "no results".
type NoopError struct {
	Body    []byte
	Expired bool // true only for the explicit ~419B "timed out" message
}

func (e *NoopError) Error() string { return catalog.ErrSIANoop.Error() }
func (e *NoopError) Unwrap() error { return catalog.ErrSIANoop }

func newNoopError(body []byte) error {
	return &NoopError{Body: body, Expired: isSessionExpiredMessage(body)}
}
