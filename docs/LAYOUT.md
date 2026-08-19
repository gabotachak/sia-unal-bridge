# Estructura del código y dependencias

Propuesta de árbol de archivos y librerías. Todavía no hay código: esto es para revisar
antes de escribirlo.

Traduce a paquetes de Go la arquitectura de [ARCH.md](ARCH.md) y el contrato de
[API.md](API.md). Los identificadores van en inglés; esta documentación en español.

---

## Árbol

```
sia-unal-bridge/
├── cmd/
│   ├── bridge/
│   │   └── main.go                 # único sitio con wiring: config → adapters → server
│   └── refresher/
│       └── main.go                 # el Job: config → store → POOL PROPIO → Service
│
├── internal/
│   ├── catalog/                    # ── DOMINIO ── cero imports de infraestructura
│   │   ├── course.go               # Course, Section, ClassSession, SeatSnapshot
│   │   ├── program.go              # Program, PublicID(), ProgramKey
│   │   ├── typology.go             # 'LIBRE ELECCIÓN (L)' ↔ 'ELEGIBLES' → enum + crudo
│   │   ├── freshness.go            # política de max_age por tipo de recurso
│   │   ├── errors.go               # ErrNotFound, ErrNoOffering, ErrAmbiguous, ErrSIANoop…
│   │   ├── ports.go                # interfaces Store y SIASource
│   │   └── service.go              # read-through, singleflight, decide cache vs fetch
│   │
│   ├── sia/                        # ── ADAPTADOR driven: Oracle ADF ──
│   │   ├── conn.go                 # SIAConn: bootstrap, búsqueda, detalle, Volver
│   │   ├── cascade.go              # las DOS cascadas: regular (5 pasos) y electivas (9)
│   │   ├── pool.go                 # pool de 4, mutex por operacion, keepalive <=3 min
│   │   ├── form.go                 # cuerpos x-www-form-urlencoded (PROTOCOL.md)
│   │   ├── envelope.go             # <partial-response> → CDATA indexado por id
│   │   ├── parse_list.go           # tabla t4: filas, _afrRK, dedupe por código
│   │   ├── parse_detail.go         # grupos, profesor, cupos, jornada, fechas
│   │   ├── parse_schedule.go       # 'MIÉRCOLES de 09:00 a 11:00.' → ClassSession
│   │   ├── parse_options.go        # '2A74 INGENIERÍA…' → (code, name)
│   │   ├── noop.go                 # detección de ~900 B y de sesión caducada
│   │   ├── source.go               # implementa catalog.SIASource sobre el pool
│   │   └── testdata/               # fixtures fechados y sanitizados
│   │
│   ├── store/                      # ── ADAPTADOR driven: Postgres ──
│   │   ├── store.go                # pgxpool, helper de transacción
│   │   ├── program.go
│   │   ├── course.go               # upsert del catálogo de un programa en una tx
│   │                               # (las DOS mitades: regular + libre elección)
│   │   ├── section.go              # upsert de grupos + section_program + class_session
│   │   └── seats.go                # append-only, lectura por current_seats
│   │
│   ├── httpapi/                    # ── ADAPTADOR driving ──
│   │   ├── router.go               # gin.New(), grupo /v1, middleware
│   │   ├── reference.go            # /levels /campuses, …/faculties …/programs
│   │   ├── catalog.go              # …/programs/{program}/courses
│   │   ├── detail.go               # …/courses/{code}[/sections[/{key}[/seats]]]
│   │   ├── shortcuts.go            # …/courses/{code}, …/courses?q=
│   │   ├── freshness.go            # ?max_age=, Age, Cache-Control, X-Cache
│   │   ├── errors.go               # error de dominio → status + body JSON
│   │   ├── middleware.go           # slog, recover, request id
│   │   └── status.go               # /healthz, /status
│   │
│   ├── refresher/                  # ── ADAPTADOR driving: el Job (fase 2) ──
│   │   ├── refresher.go            # Run(ctx, Options): orquesta un barrido, errgroup, limitador
│   │   ├── modes.go                # reference · catalog · detail(global|plan) · seats(hot)
│   │   └── report.go               # contadores, errores agregados, circuit breaker
│   │
│   └── config/
│       └── config.go
│
├── migrations/
│   ├── 00001_init.sql
│   └── …
│
├── docs/
├── bruno/sia-catalogo/
├── testdata/live/                  # gitignored
├── docker-compose.yml
├── Makefile
└── go.mod
```

---

## Responsabilidad por paquete

| Paquete | Rol hexagonal | Responsabilidad |
|---|---|---|
| `cmd/bridge` | composición | lee config, construye adaptadores, arranca el server. Nada de lógica |
| `internal/catalog` | dominio + puertos | tipos, reglas de frescura, read-through. No sabe de HTTP, SQL ni ADF |
| `internal/sia` | driven | todo lo que toca el SIA real: protocolo, estado, parseo |
| `internal/store` | driven | persistencia y consultas |
| `internal/httpapi` | driving | traduce HTTP a casos de uso y errores de dominio a status |
| `internal/refresher` | driving | enumera el trabajo y lo recorre acotado; entra por los mismos casos de uso que `httpapi` |
| `internal/config` | — | variables de entorno a un struct |

`internal/refresher` importa `internal/catalog` **y nada más de infraestructura**: es un
adaptador driving, puede depender del dominio pero no de `sia` ni de `store`. En el momento
en que importara uno de los dos dejaría de entrar por los casos de uso y sería un segundo
camino a Postgres, que es lo que [FASE-2.md](FASE-2.md) prohíbe. El test de la invariante
del hexágono lo cubre igual que a `internal/catalog`.

### La invariante que sostiene el hexágono

`internal/catalog` **no importa** `gin`, `pgx`, `goquery` ni `encoding/xml`. Y ni él ni
`internal/refresher` importan `internal/sia`, `internal/store` o `internal/httpapi`.

Si eso se rompe, el hexágono ya no existe aunque el árbol de carpetas siga igual. Vale
un test:

```go
func TestDomainHasNoInfraImports(t *testing.T) {
    // go list -deps ./internal/catalog | grep -E 'gin-gonic|pgx|goquery|encoding/xml'
}
```

Los puertos se declaran en `catalog/ports.go`: el consumidor define la interfaz, idioma
Go. `sia` y `store` no importan `catalog` para *implementar* una interfaz declarada
allá — la satisfacen estructuralmente. (Sí lo importan para los tipos de dominio que
devuelven, y está bien: dependen del dominio, que apunta hacia adentro.)

---

## Por qué `internal/sia` está partido así

Es el paquete gordo y debe serlo: ahí viven las 39 trampas de
[GOTCHAS.md](GOTCHAS.md). Está dividido por **fase del protocolo**, no por capa
técnica, para que cada trampa tenga un archivo obvio donde vivir y donde buscarla.

| Archivo | Trampas que le tocan |
|---|---|
| `conn.go` | §1 User-Agent · §2 `winnoloop` · §3 ViewState no rota · §7 timeout ~4.2 min · §8 cookie+ViewState · §10 región 0 vs detalle · **§20 región de detalle numerada** · §22 bootstrap con tabla ajena · §25 coste variable del bootstrap |
| `pool.go` | §7 expiración y keepalive ≤3 min · **§28 mutex por conexión envolviendo la operación lógica** · 8 conexiones en paralelo van bien |
| `form.go` | §9 `selection` innecesario · §11 `DELTAS` opcional · §12 headers no validados |
| `cascade.go` | §6 la cascada no se puede saltar · §21 `soc4=0` excluye libre elección → la de electivas no es opcional · §5 de `PROTOCOL.md`: `soc10` antes de `soc6` o sale basura |
| `parse_list.go` | §4 `_afrRK` se renumera y no empieza en 0 · §5 `_rowCount` no fiable · §13 dedupe · §14 tope de 1000 · §21 `soc4=0` excluye libre elección · §23 `<tr>` ×5 en la página completa |
| `parse_detail.go` | §17 vocabulario de tipología · §18 asignaturas sin grupos · **§24 cabeceras PEAMA** · **§27 la clave del grupo es el token entre paréntesis** · prerrequisitos y componentes |
| `parse_options.go` | §15 `soc6` no es una fórmula · índices posicionales volátiles · §26 `program.code` no identifica |
| `noop.go` | §6 no-op silencioso de ~900 B · §7 las **dos** firmas de sesión muerta (~1.2 KB mudo y 419 B con mensaje) · distinguirlas del atasco por región equivocada (§20) |

El único archivo que **debe** leerse entero antes de tocar nada es `noop.go`: es la
diferencia entre "el SIA no devolvió nada" y "devolví datos plausibles y equivocados".

---

## Librerías

| Necesidad | Elección | Por qué |
|---|---|---|
| Router HTTP | **`gin-gonic/gin`** | binding y validación de query params sobre una superficie real (`max_age`, `q`, `credits`, `typology`, `term`, `has_seats`); recovery y grupos de ruta incluidos |
| Postgres | **`jackc/pgx/v5`** + `pgxpool` | estándar de facto; sin `database/sql` de intermediario |
| Filas → struct | **`pgx.CollectRows` + `pgx.RowToStructByName`** | viene dentro de pgx v5 y respeta los tags `db:` que ya están en [DATA-MODEL.md](DATA-MODEL.md). Sin dependencia extra, sin codegen |
| Migraciones | **`pressly/goose`** | SQL plano, embebible con `embed.FS`, sin daemon ni CLI obligatoria |
| HTML del listado | **`golang.org/x/net/html`** + **`PuerkitoBio/goquery`** | hay que releer `_afrRK` del `<tr>` en cada render ([GOTCHAS §4](GOTCHAS.md)); regex ahí es exactamente como se rompió el proyecto anterior |
| Envoltorio XML | **`encoding/xml`** (stdlib) | `<partial-response>` → CDATA por id de componente |
| Deduplicar fetches | **`golang.org/x/sync/singleflight`** | requisito explícito de [API.md](API.md) |
| Normalizar acentos | **`golang.org/x/text`** (`norm`, `runes`) | filtrar como lo hace `it11` (substring insensible a acentos) y comparar etiquetas al revalidar índices. **No** para resolver programas por nombre: eso es ambiguo por diseño ([DATA-MODEL, decisión 7](DATA-MODEL.md)) |
| Cookies | **`net/http/cookiejar`** (stdlib) | obligatorio, [GOTCHAS §8](GOTCHAS.md) |
| Logs | **`log/slog`** (stdlib) | |
| Config | stdlib + struct a mano | son ~6 variables de entorno |
| Tests | stdlib + **`stretchr/testify`** (opcional) | golden files a mano para los parsers |

Dependencias de verdad: **gin, pgx, goose, goquery**. Más tres paquetes
`golang.org/x/`, que son casi stdlib. Todo lo demás es biblioteca estándar.

### Alternativas descartadas

| Descartado | A favor de | Razón |
|---|---|---|
| `net/http` pelado | `gin` | 1.22 ya rutea con método y wildcards, así que el routing era empate. Lo que decide es el binding de query params: a mano son ~150 líneas de `strconv` repartidas por 12 handlers |
| `chi` / `echo` | `gin` | equivalentes en lo que importa acá; gin por familiaridad |
| `sqlc` | pgx crudo | 6 tablas, ~15 queries. sqlc paga a partir de ~80. Además los upserts interesantes (catálogo completo en una tx, `section_program` como diff de visibilidad) son más claros a mano. Migrar después es mecánico |
| `sqlx` / `scany` | `pgx.RowToStructByName` | pgx v5 ya lo hace nativo |
| `golang-migrate` | `goose` | goose embebe más fácil y permite migraciones en Go si algún día hace falta |
| `colly` / frameworks de scraping | `net/http` a mano | necesitan control total de UA, cookies y secuencialidad. Un framework estorba ([GOTCHAS §1](GOTCHAS.md)) |
| `testcontainers-go` | `docker-compose.yml` que ya existe | `TEST_DATABASE_URL` + `t.Skip()` si no está. Menos maquinaria, mismo resultado — **pero apuntando a otra base**: estos tests escriben de verdad, y compartir base con producción le metió 28 planes de sedes falsas (`make migrate-test`) |
| regex sobre el HTML | goquery | es el fallo que mató al proyecto anterior |

### Avisos de uso

**Gin: cuatro reglas.** El router es el cuello de botella de nadie — los 1.3–10 s los
pone el pool ADF ([ARCH.md](ARCH.md)) — así que gin se elige por ergonomía. Para que
esa comodidad no se cobre en otro lado:

1. **`gin.Context` nunca cruza a `internal/catalog`.** Se pasa `c.Request.Context()`.
   Es la invariante del hexágono, ahora con un tipo concreto capaz de romperla.
2. **`ShouldBindQuery`, nunca `BindQuery`.** El segundo responde un `400` con el
   formato de error *de gin*, no con el de [API.md](API.md)
   (`{"error": "...", "message": "..."}`). Rompería el contrato en silencio.
3. **`gin.New()`, no `gin.Default()`.** `Default()` monta el logger propio de gin
   escribiendo a stdout en su formato; acá se quiere `slog`. Se arma
   `gin.New()` + `gin.Recovery()` + middleware propio.
4. **`gin.SetMode(gin.ReleaseMode)`** fuera de desarrollo.

`internal/httpapi` es el adaptador driving: acoplarlo a un framework es correcto por
diseño. El acoplamiento que no se permite es hacia adentro.

**goquery y los `:` de ADF.** Los ids llevan dos puntos (`pt1:r1:0:t4`), que en un
selector CSS hay que escapar (`pt1\:r1\:0\:t4`). Conviene un helper único:

```go
func byID(id string) string { return "#" + strings.ReplaceAll(id, ":", `\:`) }
```

**goquery solo para el listado.** El detalle se parsea como **texto plano** tras quitar
etiquetas, buscando marcadores `Profesor:`, `Cupos disponibles:`, `Jornada:`
([FIELDS.md](FIELDS.md)). Eso es escaneo por líneas, no DOM. Meter goquery ahí complica
sin ganar nada.

---

## Orden de construcción

Es el orden de [DEVELOPMENT.md](DEVELOPMENT.md) con los archivos puestos:

| # | Qué | Dónde | Red |
|---|---|---|---|
| 1 | esquema y migraciones | `migrations/`, `catalog/{course,program}.go` | no |
| 2 | parser del listado | `sia/parse_list.go` | **no** |
| 3 | parser del detalle | `sia/parse_detail.go`, `parse_schedule.go` | **no** |
| 4 | navegación con estado | `sia/{conn,cascade,form,noop}.go` | sí |
| 5 | pool | `sia/pool.go` | sí |
| 6 | persistencia y read-through | `store/*`, `catalog/service.go` | sí |
| 7 | API HTTP | `httpapi/*` | sí |
| 8 | el Job (fase 2) | `refresher/*`, `cmd/refresher` | sí |

Los pasos 2 y 3 son los que más rinden hacer primero: no necesitan red y son la parte
con más trampas. Tenerlos ya probados contra fixtures hace que, cuando el paso 4 falle,
sepas que el problema es de navegación y no de parseo.

Antes de empezar el paso 4, corre la colección Bruno para confirmar que el protocolo
sigue vigente. Si Bruno funciona y tu código no, el problema es tuyo.
