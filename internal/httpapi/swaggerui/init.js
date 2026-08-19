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
