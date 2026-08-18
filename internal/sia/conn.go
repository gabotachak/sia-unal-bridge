package sia

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

const (
	windowID    = "winnoloop" // Adf-Window-Id, constant once the JS loopback is skipped. GOTCHAS §2.
	pageID      = "0"
	adsPageID   = "1"
	maxBodySize = 10 * 1024 * 1024 // 10 MB limit for SIA responses
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

	// navLevel/navCampus/navFaculty track the LAST VALUE actually posted to
	// soc1/soc9/soc2 on this connection — independent of `parked`, which
	// only means "a full program was selected". A pooled connection can
	// arrive here already sitting on some level/campus/faculty from a
	// completely different prior request (FetchProgramDirectory,
	// gotoProgram, ...). Re-posting a valueChange with the value it
	// already has does not make ADF re-render the dependent dropdown —
	// GOTCHAS §30 — so every step that changes one of these must check
	// first. -1 means "unknown", forcing the first post on a fresh
	// connection (see Bootstrap, which resets these).
	navLevel, navCampus, navFaculty int

	// navTipologia/navModo/navSedeElect are the electives cascade's
	// equivalent tracking (soc4, soc5, soc10). soc4 and soc5 are constant
	// across every call, and soc10 repeats whenever two consecutive requests
	// hit the same sede — so the SECOND time a pooled connection is reused,
	// those would repost unchanged and noop without this guard. "" = unset
	// (matches formState's zero value).
	//
	// soc6 is deliberately NOT tracked: the soc10 post that precedes it
	// re-renders the dropdown and clears its selection server-side, so every
	// soc6 post is a genuine change (GOTCHAS §37).
	navTipologia, navModo, navSedeElect string

	// DetailRegion: 0 = in the search region; >0 = an open detail region.
	// Back is pt1:r1:<DetailRegion>:cb4 and the number grows with every
	// detail opened in the session. Never hardcode it. GOTCHAS §20.
	DetailRegion int

	// Traffic counters, atomic because Pool.Stats reads them from another
	// goroutine while this connection is checked out. They are the courtesy
	// budget made visible: "18.8 MB/min por worker" is a number this
	// project has to keep an eye on (docs/FASE-2.md "Riesgos").
	posts, bytes atomic.Int64

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
		baseURL:    baseURL,
		client:     &http.Client{Jar: jar, Timeout: 30 * time.Second},
		navLevel:   -1,
		navCampus:  -1,
		navFaculty: -1,
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
	resp.Body = http.MaxBytesReader(nil, resp.Body, maxBodySize)
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("sia: bootstrap: read body: %w", err)
	}
	c.bytes.Add(int64(len(body)))
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
	c.navLevel, c.navCampus, c.navFaculty = -1, -1, -1
	c.navTipologia, c.navModo, c.navSedeElect = "", "", ""
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
	resp.Body = http.MaxBytesReader(nil, resp.Body, maxBodySize)
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("sia: post: read body: %w", err)
	}
	c.posts.Add(1)
	c.bytes.Add(int64(len(body)))
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

// Ping keeps the session alive with the cheapest request that still forces a
// real re-render, and reports a noop as an error so a dead session is never
// mistaken for a live one — the bug that let a whole pool sit dead, answering
// sia_noop to every request until the process restarted.
//
// An un-parked connection is pinged too: the ~4.2min idle timeout is the
// session's, not the cascade's, so a connection that only ever served
// dropdown reads dies just the same. GOTCHAS §7.
func (c *SIAConn) Ping(ctx context.Context) error {
	switch {
	case c.DetailRegion != 0:
		_, err := c.Volver(ctx)
		return err
	case c.parked:
		body, _, err := c.postAction(ctx, "pt1:r1:0:cb1", "")
		if err != nil {
			return err
		}
		if isNoop(body) {
			return newNoopError(body)
		}
		return nil
	default:
		// Nothing cascaded: bounce soc1 to a level it isn't on. Reposting
		// the value it already holds would not re-render (GOTCHAS §30) and
		// would be indistinguishable from a dead session.
		target := 0
		if c.navLevel == target {
			target = 1
		}
		c.form.Nivel = strconv.Itoa(target)
		body, _, err := c.postValueChange(ctx, "pt1:r1:0:soc1")
		if err != nil {
			return err
		}
		if isNoop(body) {
			return newNoopError(body)
		}
		c.navLevel = target
		c.navCampus, c.navFaculty = -1, -1
		return nil
	}
}
