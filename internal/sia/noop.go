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
