package sia

import "testing"

func TestIsNoop_IncompleteCascade(t *testing.T) {
	if !isNoop(fixture(t, "noop_cascada_incompleta_2026-08-15.xml")) {
		t.Error("896B incomplete-cascade response must be detected as noop")
	}
}

func TestIsNoop_RealListingIsNotNoop(t *testing.T) {
	if isNoop(fixture(t, "listado_regular_2026-08-15.xml")) {
		t.Error("240KB listing must not be flagged as noop")
	}
}

// The mute-expiry fixture is synthetic (never naturally reproduced — see
// docs/OPEN-QUESTIONS.md §3); the explicit one below is a REAL capture.
func TestIsNoop_SessionExpiredMute(t *testing.T) {
	if !isNoop(fixture(t, "noop_session_expired_mute_SYNTHETIC.xml")) {
		t.Error("mute expiry response must be detected as noop")
	}
}

func TestIsSessionExpiredMessage(t *testing.T) {
	body := fixture(t, "noop_session_expired_explicit_2026-08-15.xml")
	if !isNoop(body) {
		t.Error("419B explicit expiry response must be detected as noop")
	}
	if !isSessionExpiredMessage(body) {
		t.Error("explicit expiry message must be recognized")
	}
}

func TestIsSessionExpiredMessage_MuteIsNotExplicit(t *testing.T) {
	if isSessionExpiredMessage(fixture(t, "noop_session_expired_mute_SYNTHETIC.xml")) {
		t.Error("mute noop has no message text, must not match the explicit signature")
	}
}
