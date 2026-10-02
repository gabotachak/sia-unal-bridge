# Constantes

**El único documento con cifras.** Los demás nombran la constante: "como mucho
`maxTotalConnections` sesiones", nunca "como mucho 80". Si un valor cambia, se cambia
aquí y en su fuente, y nada más.

Tres tipos:

- **Medidas**: el comportamiento del SIA. No las controlamos; la evidencia está en
  [GOTCHAS.md](GOTCHAS.md).
- **En el código**: las decide este proyecto. `internal/config/constants_doc_test.go`
  compara cada fila de Go con su fuente y falla si no coinciden.
- **De entorno**: su valor por defecto está solo en [`.env.example`](../.env.example).

---

## Medidas del SIA

| Nombre | Valor | Evidencia |
|---|---|---|
| `SIA_SESSION_IDLE_TIMEOUT` | ~4.2 min sin tráfico | [GOTCHAS §7](GOTCHAS.md) |
| `SIA_BOOTSTRAP_COST` | 52 KB – 4.5 MB, 0.15 – 7 s | [GOTCHAS §25](GOTCHAS.md) |
| `SIA_BROWSER_UA_BYTES` | ~7 KB de bootstrap JS en vez de la página | [GOTCHAS §1](GOTCHAS.md) |
| `SIA_NOOP_BYTES` | ~900 B | [GOTCHAS §6](GOTCHAS.md) |
| `SIA_POST_LATENCY` | ~470 ms por POST de cascada, listado o Volver | — |
| `SIA_LISTING_BYTES` | ~240 KB por un plan de ~98 asignaturas | — |
| `SIA_LISTING_IT11_BYTES` | 15 – 27 KB | [GOTCHAS §19](GOTCHAS.md) |
| `SIA_ELECTIVES_COST` | ~240 – 520 KB, ~1 s por sede | — |
| `SIA_DETAIL_COST` | 8 – 264 KB, ~500 ms | — |
| `SIA_VOLVER_BYTES` | ~257 KB | — |
| `SIA_DETAIL_WARM` | ~1.3 s, con la conexión ya en el plan | [PROTOCOL §9](PROTOCOL.md) |
| `SIA_DETAIL_COLD` | ~10 s, sin sesión | [PROTOCOL §9](PROTOCOL.md) |
| `SIA_PLAN_CRAWL` | 201 POSTs, 99 s, 31 MB: un plan entero con detalle | — |
| `SIA_REFERENCE_CENSUS` | 142 POSTs, 78 s, 1380 entradas de programa | [FIELDS.md](FIELDS.md) |

El límite de sesiones concurrentes también es una medida, pero lo fija el código:
`maxTotalConnections`, abajo.

---

## En el código

La columna Valor es la expresión tal cual está en la fuente.

### SIA y pool

| Nombre | Valor | Fuente | Qué es |
|---|---|---|---|
| `maxTotalConnections` | `80` | `cmd/refresher/main.go` | sesiones concurrentes que el SIA aguanta limpias, compartidas entre la API y el `Refresher`. Medido: con 88 falla ~4.5 % |
| `DefaultPoolSize` | `4` | `internal/sia/pool.go` | pool de la API si `SIA_POOL_SIZE` no está definida |
| `readyBeforeServing` | `4` | `internal/sia/pool.go` | conexiones que se bootstrapean antes de servir; el resto llega en segundo plano |
| `fillRetryDelay` | `15 * time.Second` | `internal/sia/pool.go` | pausa entre reintentos del llenado del pool |
| `keepaliveTick` | `45 * time.Second` | `internal/sia/pool.go` | cada cuánto revisa el keepalive |
| `keepaliveIdle` | `2 * time.Minute` | `internal/sia/pool.go` | quietud a partir de la cual se hace ping; con margen contra `SIA_SESSION_IDLE_TIMEOUT` |
| `rebootstrapTimeout` | `45 * time.Second` | `internal/sia/pool.go` | tope de un bootstrap de reparación |
| `noopThreshold` | `1200` | `internal/sia/noop.go` | bytes por debajo de los cuales una respuesta es un no-op; por encima de `SIA_NOOP_BYTES` |
| `maxBodySize` | `10 * 1024 * 1024` | `internal/sia/conn.go` | tope de una respuesta del SIA |

### Frescura y deduplicación

| Nombre | Valor | Fuente | Qué es |
|---|---|---|---|
| `FreshnessReference` | `30 * 24 * time.Hour` | `internal/catalog/freshness.go` | TTL de niveles, sedes y programas |
| `FreshnessCatalog` | `7 * 24 * time.Hour` | `internal/catalog/freshness.go` | TTL del catálogo de un plan |
| `FreshnessDetail` | `24 * time.Hour` | `internal/catalog/freshness.go` | TTL del detalle y de la visibilidad por plan |
| `FreshnessSeats` | `5 * time.Minute` | `internal/catalog/freshness.go` | TTL de los cupos |
| `behindRetry` | `time.Minute` | `internal/catalog/service.go` | como mucho un refresco de fondo por clave en este lapso |
| `behindTimeout` | `3 * time.Minute` | `internal/catalog/service.go` | tope de un refresco de fondo |
| `referenceCacheTTL` | `time.Minute` | `internal/store/cache.go` | vida de la cache de referencia en memoria |
| `listingCap` | `1000` | `internal/catalog/service_refresh.go` | filas máximas de un listado del SIA; alcanzarlas es truncamiento |
| `shrinkFloor` | `0.5` | `internal/catalog/service_refresh.go` | un catálogo que encoge por debajo de esta fracción es sospechoso, no una baja |

### HTTP

| Nombre | Valor | Fuente | Qué es |
|---|---|---|---|
| `foregroundPerIP` | `4` | `internal/httpapi/ratelimit.go` | peticiones en vuelo por IP antes de pasar al carril de fondo |
| `staleAfter` | `10 * time.Minute` | `internal/httpapi/ratelimit.go` | se olvida el balde de una IP inactiva |

### Interfaz

| Nombre | Valor | Fuente | Qué es |
|---|---|---|---|
| `MAX_ITEMS` | `20` | `web/src/lib/storage.ts` | materias máximas en Mi semestre |

### `Refresher`

| Nombre | Valor | Fuente | Qué es |
|---|---|---|---|
| `maxConsecutiveFailures` | `5` | `internal/refresher/report.go` | programas fallidos seguidos que disparan el circuit breaker |
| `breakerErrorRate` | `0.20` | `internal/refresher/report.go` | fracción de programas fallidos que lo dispara |
| `breakerMinSample` | `20` | `internal/refresher/report.go` | programas mínimos antes de aplicar la fracción |
| `zeroGroupsMax` | `0.90` | `internal/refresher/modes.go` | fracción de asignaturas que tenían grupos y vuelven sin ninguno que hace sospechoso un plan |
| `zeroGroupsMinSample` | `10` | `internal/refresher/modes.go` | asignaturas mínimas antes de aplicarla |

---

## De entorno

Su valor por defecto vive solo en [`.env.example`](../.env.example):

| Variable | Qué es |
|---|---|
| `SIA_POOL_SIZE` | conexiones del pool de la API |
| `SIA_ACQUIRE_TIMEOUT_SECONDS` | cuánto espera una petición por una conexión antes de `503 busy` |
| `FETCH_COOLDOWN` | segundos mínimos entre dos `max_age` bajos sobre la misma asignatura |
| `RATE_LIMIT_RPS`, `RATE_LIMIT_BURST` | balde de peticiones por IP |
| `REFRESH_POOL_SIZE`, `REFRESH_WORKERS` | pool y concurrencia del `Refresher` |
| `REFRESH_*` | el resto de la configuración del `Refresher` |
| `VITE_STALE_SEATS_SECONDS` | edad a partir de la cual la interfaz da un cupo por viejo |

La regla que une dos de ellas: `SIA_POOL_SIZE + REFRESH_POOL_SIZE ≤ maxTotalConnections`.
