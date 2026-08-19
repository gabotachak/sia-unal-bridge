package httpapi

import (
	_ "embed"
	"net/http"

	"github.com/gin-gonic/gin"
)

// openapiSpec is the contract, embedded so the binary always serves the spec
// that was built with it — a spec fetched from disk or a CDN can drift from
// the routes it documents.
//
//go:embed openapi.yaml
var openapiSpec []byte

func (a *api) openapi(c *gin.Context) {
	c.Data(http.StatusOK, "application/yaml; charset=utf-8", openapiSpec)
}

// swaggerUICSS and swaggerUIBundleJS are swagger-ui-dist@5.32.14, vendored
// instead of pulled from a CDN: secureHeaders() sets a strict
// Content-Security-Policy (default-src 'self') on every response, which a
// <script src="https://unpkg.com/..."> silently fails under — the page loads
// (200) but stays blank, CSP violation only visible in the browser console.
// Serving the assets from this origin keeps the CSP as-is and drops the
// runtime dependency on unpkg's uptime.
//
//go:embed swaggerui/swagger-ui.css
var swaggerUICSS []byte

//go:embed swaggerui/swagger-ui-bundle.js
var swaggerUIBundleJS []byte

// swaggerUIInitJS is the call that actually renders the UI into #ui. It has
// to be an external file, not an inline <script> in swaggerHTML: default-src
// 'self' with no script-src override blocks inline scripts too (no
// 'unsafe-inline', no nonce, no hash) — the CSS and the bundle load fine
// (same-origin <link>/<script src>), but an inline <script> block is silent
// dead code under that policy. Page renders, #ui just never fills in.
//
//go:embed swaggerui/init.js
var swaggerUIInitJS []byte

// swaggerUI serves Swagger UI (vendored, see swaggerUICSS) against the
// embedded spec. The page is a convenience for humans; the spec at
// /v1/openapi.yaml is the artifact tooling should consume.
//
// "Try it out" is left enabled on purpose: half the point of the page is
// that a reader can fire a real request and watch a cold miss take seconds
// and the next one take milliseconds.
func (a *api) swaggerUI(c *gin.Context) {
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(swaggerHTML))
}

func (a *api) swaggerUICSS(c *gin.Context) {
	c.Data(http.StatusOK, "text/css; charset=utf-8", swaggerUICSS)
}

func (a *api) swaggerUIBundleJS(c *gin.Context) {
	c.Data(http.StatusOK, "application/javascript; charset=utf-8", swaggerUIBundleJS)
}

func (a *api) swaggerUIInitJS(c *gin.Context) {
	c.Data(http.StatusOK, "application/javascript; charset=utf-8", swaggerUIInitJS)
}

const swaggerHTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>sia-unal-bridge · API</title>
  <link rel="stylesheet" href="/v1/docs/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="ui"></div>
  <script src="/v1/docs/swagger-ui-bundle.js"></script>
  <script src="/v1/docs/init.js"></script>
</body>
</html>`
