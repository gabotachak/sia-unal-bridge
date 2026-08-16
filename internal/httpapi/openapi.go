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

// swaggerUI serves Swagger UI from a CDN against the embedded spec. The page
// is a convenience for humans; the spec at /v1/openapi.yaml is the artifact
// tooling should consume.
//
// "Try it out" is left enabled on purpose: half the point of the page is
// that a reader can fire a real request and watch a cold miss take seconds
// and the next one take milliseconds.
func (a *api) swaggerUI(c *gin.Context) {
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(swaggerHTML))
}

const swaggerHTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>sia-unal-bridge · API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      // Absolute: relative would resolve against /v1/docs's own base and
      // break the moment the URL picks up a trailing slash.
      url: '/v1/openapi.yaml',
      dom_id: '#ui',
      deepLinking: true,
      docExpansion: 'list',
      defaultModelsExpandDepth: 0,
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>`
