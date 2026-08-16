package sia

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

const (
	windowID  = "winnoloop" // Adf-Window-Id, constant once the JS loopback is skipped. GOTCHAS §2.
	pageID    = "0"
	adsPageID = "1"
)

// SIAConn is one live, stateful ADF session. Strictly sequential: the caller
// must serialize access (see sia/pool.go, GOTCHAS §28). Do not set a
// User-Agent header — Go's default is what keeps the server from routing to
// the JS loopback. GOTCHAS §1.
type SIAConn struct {
	baseURL string
	client  *http.Client

	viewState string
	form      formState

	ParkedAt catalog.ProgramKey // cascade already done for this program; zero value = never cascaded
	parked   bool

	// DetailRegion: 0 = in the search region; >0 = an open detail region.
	// Back is pt1:r1:<DetailRegion>:cb4 and the number grows with every
	// detail opened in the session. Never hardcode it. GOTCHAS §20.
	DetailRegion int

	LastUsed time.Time
}

var viewStateHTMLRe = regexp.MustCompile(`javax\.faces\.ViewState"\s+value="([^"]+)"`)

// NewConn creates an SIAConn with its own cookie jar. It is not usable until
// Bootstrap succeeds.
func NewConn(baseURL string) (*SIAConn, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, fmt.Errorf("sia: cookiejar: %w", err)
	}
	return &SIAConn{
		baseURL: baseURL,
		client:  &http.Client{Jar: jar, Timeout: 30 * time.Second},
	}, nil
}

// Bootstrap performs the one-per-session GET. Cost is highly variable
// (0.15s/52KB .. 7s/4.5MB) and does NOT depend on the User-Agent — GOTCHAS
// §25. The returned page's table (if any) belongs to another session and
// must never be parsed — GOTCHAS §22.
func (c *SIAConn) Bootstrap(ctx context.Context) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.baseURL+"?taskflowId=task-flow-AC_CatalogoAsignaturas", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("sia: bootstrap: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("sia: bootstrap: read body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("sia: bootstrap: status %d", resp.StatusCode)
	}

	m := viewStateHTMLRe.FindSubmatch(body)
	if m == nil {
		return nil, fmt.Errorf("sia: bootstrap: ViewState not found (%d bytes)", len(body))
	}
	c.viewState = string(m[1])
	c.form = formState{Modo: "", SedeElect: "0"}
	c.ParkedAt = catalog.ProgramKey{}
	c.parked = false
	c.DetailRegion = 0
	c.LastUsed = time.Now()
	return body, nil
}

// post sends one POST with the SIA's accumulated form state, recaptures the
// ViewState from the response (it doesn't rotate — GOTCHAS §3 — but we
// re-read it anyway, it's free), and returns the raw body plus the parsed
// <update id=...> map.
func (c *SIAConn) post(ctx context.Context, values url.Values) ([]byte, map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"?Adf-Window-Id="+windowID+"&Adf-Page-Id="+pageID,
		strings.NewReader(values.Encode()))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	req.Header.Set("Adf-Ads-Page-Id", adsPageID)
	req.Header.Set("Adf-Rich-Message", "true")
	req.Header.Set("Origin", "https://sia.unal.edu.co")
	req.Header.Set("Referer", c.baseURL+"?taskflowId=task-flow-AC_CatalogoAsignaturas")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("sia: post: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("sia: post: read body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("sia: post: status %d", resp.StatusCode)
	}
	c.LastUsed = time.Now()

	env, err := ParseEnvelope(body)
	if err == nil {
		if vs, ok := env["javax.faces.ViewState"]; ok && vs != "" {
			c.viewState = vs
		}
	}
	return body, env, nil
}

func (c *SIAConn) postValueChange(ctx context.Context, id string) ([]byte, map[string]string, error) {
	return c.post(ctx, c.form.valueChangeValues(c.viewState, id))
}

func (c *SIAConn) postAction(ctx context.Context, id, deltas string) ([]byte, map[string]string, error) {
	return c.post(ctx, c.form.actionValues(c.viewState, id, deltas))
}

// DebugRawCB1 clicks "Mostrar" with whatever form state the connection
// currently has, skipping gotoProgram entirely. Exists only to reproduce
// GOTCHAS.md §6 (cascada incompleta → no-op ~896B) for fixture capture and
// tests; production code always goes through FetchCatalog/FetchElectives.
func (c *SIAConn) DebugRawCB1(ctx context.Context) ([]byte, error) {
	body, _, err := c.postAction(ctx, "pt1:r1:0:cb1", "")
	return body, err
}

// Ping keeps the session alive with the cheapest possible request: a Volver
// bounce is stateful, so instead we re-post the current search (cb1) if
// parked and not in detail, or re-run soc1 valueChange otherwise. Kept in
// pool.go's keepalive loop; ≤3 min interval (real timeout ~4.2 min, not the
// 5 min the JS timer advertises). GOTCHAS §7.
func (c *SIAConn) Ping(ctx context.Context) error {
	if !c.parked {
		return nil // nothing cascaded yet, nothing to keep alive
	}
	if c.DetailRegion != 0 {
		_, _, err := c.postAction(ctx, fmt.Sprintf("pt1:r1:%d:cb4", c.DetailRegion), "")
		if err == nil {
			c.DetailRegion = 0
		}
		return err
	}
	_, _, err := c.postAction(ctx, "pt1:r1:0:cb1", "")
	return err
}
