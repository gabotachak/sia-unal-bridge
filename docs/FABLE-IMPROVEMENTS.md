# FABLE-IMPROVEMENTS — diagnóstico y plan de mejoras

> Análisis hecho el **2026-09-20** sobre `main` (`e9c112e`, producción en `v1.25.0`).
> Combina lectura de código con mediciones de solo lectura contra la API de producción
> y una corrida de la colección Bruno contra el SIA. Lo que está **medido** lo dice; lo
> que es **hipótesis** también.
>
> Se hizo en cinco pasadas la misma noche: lectura y medición desde fuera; diagnóstico
> por SSH en el server de producción; arreglos probados en local con Go y Postgres en
> espacio de usuario; lo mismo repetido sobre los contenedores Docker del repo; y una última
> pasada sobre lo que había quedado pendiente. §9 dice qué quedó hecho y cómo se probó.

## Resumen ejecutivo

Los dos dolores reportados tienen causa raíz identificada, y las dos salen del mismo
cambio (la medición automática de cupos al abrir el catálogo, PR #49):

1. **"El front no muestra bien la transición de la rueda a los cupos"** — bug confirmado
   y **ya corregido en esta rama**. El detalle de la API no trae el agregado `seats`; el
   catálogo lo leía igual (`m.seats`, siempre `undefined`), así que toda fila recién
   medida pasaba de la rueda a **"sin grupos"** en vez de a su número. Detalle en §2.
2. **"Demora un montón en cargar" / "está fallando mucho"** — la medición automática es
   una **tormenta**: en el plan 2879 de Bogotá, **267 de 267** asignaturas cumplen
   `seatsUnknown` al abrir, así que cada apertura del catálogo dispara 267 detalles, casi
   todos *miss* contra el SIA (≈1000 POSTs y >100 MB por apertura, por usuario). Eso
   satura el pool, hace cola delante de los misses interactivos y choca con el limitador
   por IP. Detalle en §3.

Y tres hallazgos de producción que no estaban en el reporte pero pesan más que todo lo
demás **hoy**:

- **El 85 % de lo que iba al SIA devolvía `502 sia_noop`** (1713 de 2126 requests en 4 h,
  según los logs). Causa encontrada: ~18 de las 32 conexiones del pool estaban
  **envenenadas de forma permanente**, y ni el keepalive ni el reintento de `Pool.Do` las
  curaban, porque `Bootstrap()` reutilizaba el cookie jar. Reiniciar `api` lo arregló en
  el acto; el fix de código (jar nuevo en cada bootstrap) está en esta rama, con test. §1.1.
- **El `Refresher` está pausado a mano desde el 2026-08-23** (las cuatro líneas de
  `/etc/cron.d/sia-refresher` dicen `#PAUSED`). Es una decisión, no una avería — pero su
  costo es que los catálogos y los cupos los refresca el tráfico de usuarios. §1.2.
- **Ninguna respuesta va comprimida**: el catálogo son 297 KB en claro en cada apertura
  y en cada vuelta a la pestaña. §4.1.

## 1. Estado de producción (medido 2026-09-20 ~22:00)

### 1.1 El pool se envenena y no se cura solo (causa encontrada)

Síntoma, medido desde fuera antes de tener acceso al server:

```
GET /v1/campuses/1101/programs/2879/courses/2030030?faculty=2055&level=pregrado
→ 502 {"error":"sia_noop","message":"SIA returned an empty re-render"}   0.69 s  (×3)
GET …/programs/2879/courses/2016696   → 502 sia_noop   0.93 s
GET …/programs/2A74/courses/2016696   → 502 sia_noop   0.61 s
```

Lo que dicen los logs de `api` (contenedor con 4 días arriba):

| ventana | 502 | 200 | 503 | 500 (`context canceled`) |
|---|---|---|---|---|
| últimas 4 h | **1713** | 302 | 16 | 70 |
| hora pico (09-19 18 h) | **4430** | 298 | 13 | 235 |

- `keepalive ping failed, re-bootstrapping` ≈ **490 veces por hora, plano, día y noche**,
  incluso a las 03:00 sin tráfico. Cada conexión rota falla su ping cada ~135 s, así que
  son **~18 de 32 conexiones** rotas de forma estable.
- Cada request fallido deja **dos** `findRowInListings … catalog_err=noop electives_err=noop`
  seguidos: el intento y el reintento que `Do` hace *después* de re-bootstrapear. O sea:
  el re-bootstrap funciona (hay ViewState nuevo) y aun así el primer POST da noop.
- Nunca aparece `re-bootstrap after noop failed`: el GET siempre sale bien.

Lo que se descartó, reproduciendo a mano:

| prueba | desde | resultado |
|---|---|---|
| Bruno 01→06 | máquina local | OK, listado de 241 KB |
| Bruno 01→06 | **el server** (misma IP que `api`) | OK, 240 KB → **no es bloqueo de IP** |
| cuerpo idéntico al de Go, `soc1=0` en sesión nueva | local y server | OK (25.9 KB) |
| re-GET del bootstrap con la MISMA cookie y luego `soc1=0` | local | OK (15 KB) → no es el estado de la sesión ADF |
| `docker compose restart api` | server | los tres requests de arriba → **200 en 2.6–5.5 s** |

Una sesión nueva desde la misma IP funciona, y un proceso nuevo también. Lo único que
sobrevive a `SIAConn.Bootstrap()` dentro del proceso es el `http.Client` de la conexión, y
como el transporte es el `DefaultTransport` compartido, lo único *propio* de cada conexión
que sobrevive es el **cookie jar**. El SIA pone dos cookies: `PortalJSESSION` (sesión) y
`cookiesession1`, **con un año de vida** (cookie de rastreo del WAF/balanceador). Una
conexión cuyo jar queda marcado sigue marcada para siempre: cada re-bootstrap manda las
mismas cookies y recibe el mismo trato.

No se pudo leer el jar de un proceso en marcha, así que *qué* cookie exacta es la
responsable queda como inferencia; que la causa vive en el jar, no: es lo único que un
reinicio resetea y un re-bootstrap no.

**Fix (en esta rama):** `Bootstrap()` arranca con `c.client = newClient()` — jar vacío en
cada bootstrap, para que re-bootstrapear valga lo mismo que reiniciar. Con test de
regresión (`TestDo_RebootstrapStartsFromAnEmptyCookieJar`), verificado que **falla sin el
fix** y pasa con él. `internal/sia/conn.go`, `internal/sia/pool_recovery_test.go`.

**Acción tomada en producción:** `docker compose restart api` a las ~22:27 del 2026-09-20.
Es un parche: sin el fix desplegado el pool se vuelve a pudrir (en este contenedor tardó
menos de 3 días en llegar al 56 % de conexiones rotas).

**Lo que sigue faltando (P0/P1):**

- Qué dispara el envenenamiento inicial. Candidatos: la tormenta de §3 (hasta 4700
  requests/hora contra el SIA) marcando sesiones en el WAF, o los POST cancelados a
  mitad (`context canceled`, 235 en la hora pico) dejando `nav*` desincronizado del
  servidor. El fix lo hace inofensivo, no lo explica.
- `NoopError` guarda el cuerpo y nadie lo loguea. Cuando un noop **sobrevive** a un
  re-bootstrap, loguear tamaño y primeros bytes: habría acortado este diagnóstico a minutos.
- `/v1/healthz` decía `ok` con el 85 % de los fetches fallando. Tasa de noop y último
  fetch exitoso en `/v1/status`.
- Un cliente que cancela produce `ERROR unhandled error … context canceled` y un **500**.
  No es un error del servidor: debería ser un 499 silencioso. Hoy ensucia los logs justo
  cuando más se necesitan.

### 1.2 El Refresher está pausado

`/v1/status` → última corrida por modo: `catalog` 2026-08-23, `detail` 2026-08-24
(`ended_reason: signal`), `seats` 2026-08-23, `reference` 2026-08-17. En el server,
`/etc/cron.d/sia-refresher` tiene las cuatro líneas con `#PAUSED` desde el 08-23 23:09,
y `/var/log/sia-refresher.log` no se escribe desde las 22:53 de ese día. Está apagado a
propósito (la última corrida de `detail` fueron 191 343 POSTs y 5.9 GB).

Es una decisión legítima, pero hay que saber lo que cuesta:

- Con TTL de catálogo de 7 días y sin job, **cada plan paga un miss frío por semana** y lo
  paga un usuario (cascada + listado regular + electivas: 3–8 s con el pool libre, hasta
  el timeout de 45 s con el pool saturado). Los `catalog_fetched_at` de Bogotá están
  repartidos a horas de usuario (07:49, 08:25, 18:51).
- Sin `detail` ni `seats`, **nada mantiene los cupos frescos**, así que para la medición
  automática "lo vencido" es siempre el catálogo entero (§3). El job pausado y la tormenta
  son el mismo problema visto desde dos lados.

Desde `/v1/status` "pausado a propósito" y "cron roto" se ven igual. Vale la pena que lo
distinga (p. ej. un `refresh.enabled` y la edad de la última corrida).

Recomendación original: reactivar solo `catalog` y `reference`. **Lo que se hizo al final
(2026-09-21): abandonar el cron entero.** El miss frío que esos dos modos evitaban lo evita
ahora la API sirviendo lo guardado y refrescando por detrás, y solo para los planes que
alguien abre. El porqué de cada modo está al inicio de [`FASE-2.md`](FASE-2.md).

## 2. Dolor 2 — la rueda no pasa a los cupos (corregido)

**Causa raíz.** `courseDetailJSON` (`internal/httpapi/detail.go:192`) devuelve
`campus_code, code, name, credits, typology, description, fetched_at, sections`. No hay
`seats` agregado ni `detail_fetched_at`: esos campos son del listado. Pero el tipo del
front es `CourseDetail = CourseSummary & { sections }`, así que `detail.seats` compila.
En `Program.tsx`, `withSeats` hacía:

```ts
{ ...c, seats: m.seats, detail_fetched_at: m.detail_fetched_at ?? m.fetched_at }
//            ^ siempre undefined
```

Resultado: al terminar la medición, la fila queda con `seats: undefined` y un sello
fresco → `SeatsCell` pinta **"— sin grupos · 0 s"** para una materia con grupos y cupos.
De rebote, `hasRoom` la saca del filtro "con cupos" y `sortKeyOf` la ordena como sin
oferta. Y como `detailCache` pisa al catálogo, ni recargar el catálogo lo arreglaba
durante la sesión.

**Segundo camino al mismo síntoma (hoy, el principal en producción).** Con el pool
envenenado de §1.1, más de la mitad de las mediciones volvían `502 sia_noop`; tras tres
reintentos la tanda las suelta en silencio y la fila vuelve al `?`. Rueda → `?`.

**Tercero, latente.** El limitador por IP (`ratelimit.go`) responde 429
sin encolar. La tanda corre con 32 en vuelo y los hits de cache vuelven en milisegundos,
así que supera `RATE_LIMIT_RPS=5` sola (el default de `.env.example`; producción corre con 60/80 y
no lo toca, pero cualquier despliegue con los defaults sí). Ese 429 no está en `TRANSIENT_CODES`, y la tanda
lo soltaba en silencio: rueda → `?` otra vez.

**Lo que cambié en esta rama (`fix/auto-measure-seats-transition`, sin commit):**

- `web/src/lib/catalog.ts`: `seatsFromDetail(detail)` — la misma cuenta que
  `ProgramCourses` en SQL (suma de grupos con medición, sello del más viejo, cuántos).
- `web/src/views/Program.tsx`: `withSeats` usa `seatsFromDetail(m)`; la tanda espera y
  reintenta ante el 429 del limitador (`Retry-After` ≤ 5 s) en vez de rendirse.
- `web/src/lib/catalog.test.ts`: dos tests de `seatsFromDetail`.
- `internal/sia/conn.go` + `pool_recovery_test.go`: jar nuevo en cada bootstrap (§1.1).

Verificado: `vitest` 72/72, `tsc -b` limpio, `oxlint` sin avisos nuevos; `go build`,
`go vet` y `go test ./internal/... ./cmd/...` verdes. **No verificado en vivo**: nada de
esta rama está desplegado; en producción solo se reinició `api`.

**Lo que queda por hacer bien (P1):** que el contrato no mienta. O la API agrega `seats`
y `detail_fetched_at` al detalle (es una columna más en la consulta de
`CourseProgramTypology`), o `CourseDetail` deja de extender `CourseSummary`. El mismo
malentendido está en `Course.tsx:101` y `useCourseDetails.ts:67`: calculan el cooldown
del botón desde `fetched_at` creyendo que es `course_program.detail_fetched_at`, y es
`course.fetched_at` — global, y además lo sella `UpsertCatalog`. Un refresco de catálogo
apaga el botón de medir cinco minutos sin que nadie haya medido nada.

## 3. Dolor 1 — la carga, y por qué falla desde la medición automática

### 3.1 La tormenta, con números

Plan 2879 (Bogotá), medido contra producción:

| | |
|---|---|
| asignaturas del catálogo | 267 |
| con `seatsUnknown` al abrir (umbral de producción: 1 h; el más fresco tenía 1.5 h) | **267** |
| con el detalle de ESTE plan fresco (< 24 h) | 0 |
| cupos medidos por OTRO plan > 1 h más recientes que el sello de este | **136** |

`VITE_STALE_SEATS_SECONDS` es 3600 en producción (1800 por defecto) y nada mantiene los
cupos a esa edad: el Refresher está pausado (§1.2). Así que "lo vencido" es siempre **todo el catálogo**,
y la tanda pide cada asignatura con `max_age=3600`: como eso es `≥ FETCH_COOLDOWN`, el
cooldown no aplica (`cooldown.go`) y cada una es un miss real.

Costo de un miss de detalle por la API: `Source.FetchDetail` llama
`fetchDetail(…, CourseRef{Code: code}, …)` **sin nombre** (`internal/sia/source.go:147`),
así que no usa el filtro `it11`: relista el catálogo entero (241 KB), para libre elección
además el de electivas (240–320 KB), más detalle, más Volver. El `Refresher` sí pasa el
nombre y paga 15–27 KB. Una apertura de catálogo son del orden de **1000 POSTs y >100 MB
contra el SIA, por usuario, por visita**. En los logs se ve: horas con 4300–4700 requests
de detalle (09-19 18 h y 19 h, 09-20 13 h), contra decenas en las horas sin catálogos abiertos.

### 3.2 Por qué eso rompe todo lo demás

- **Un solo usuario ocupa el pool entero.** `CONCURRENCY = 32 = SIA_POOL_SIZE`. Mientras
  dura la tanda (≥ 40–60 s), el miss de catálogo de otro usuario y la ficha que alguien
  abre hacen cola en `Pool.Acquire` detrás de 32 mediciones que nadie pidió. No hay
  prioridad: lo interactivo y lo especulativo compiten igual.
- **Dos usuarios = `503 busy`.** `requestTimeout` (45 s) cubre la espera en cola *y* el
  fetch; la segunda tanda se cae por timeout.
- **`singleflight` hereda el contexto del primero.** `refreshDetail` y `Catalog` corren
  el fetch con el `ctx` de quien llegó primero (`service.go:421`, `:557`). Si ese cliente
  navega o le vence el timeout, **todos** los que esperaban la misma clave reciben su
  cancelación. Con una tanda en vuelo y gente navegando, pasa seguido.
- **Se mide lo mismo N veces.** La frescura del detalle es por `(plan, asignatura)`, pero
  los cupos son globales. Las de libre elección están en cientos de planes: cada plan
  paga su POST por un número que otro plan midió hace un minuto (las 136 de la tabla).
- **Ensucia la señal del hot set.** `recordDemand` cuenta cada request de detalle como
  "una persona pidió esta asignatura". La tanda suma +1 a las 267 de cada catálogo
  abierto, así que `course_demand` deja de distinguir lo popular de lo listado.
- **No hay red cuando el SIA falla.** Postgres tiene el dato (viejo pero real) y la API
  responde 502. Lo de §1.1 sería invisible para quien solo mira si sirviera lo guardado.

### 3.3 Costo de render en el front

Cada respuesta de la tanda dispara **dos** renders completos del catálogo (`putDetail` →
`useSyncExternalStore`, y `setMeasuring`), cada uno recalculando `withSeats`,
`sectionsById`, `conflictCourseIds` y `shown`, y repintando 267–700 filas sin memo ni
virtualización, cada fila con 3–4 `Tooltip`. Son ~500–1400 renders de lista completa por
apertura. En un teléfono eso es lo que se siente como "se pega".

## 4. Rendimiento — mejoras concretas

### 4.1 Rápidas (horas)

| # | Qué | Por qué | Dónde |
|---|---|---|---|
| R1 | `encode zstd gzip` en Caddy | 297 KB de JSON en claro por catálogo; ~10× menos. También cubre el bundle JS, que nginx sirve sin gzip | `deploy/Caddyfile.gabotachak` |
| R2 | Pasar el nombre al detalle de la API | El Store ya lo tiene. 4× menos bytes por miss, mismo código que ya usa el Refresher | `Service.refreshDetail` → `CourseRef{Code, Name}` |
| R3 | Desacoplar el `ctx` del singleflight | `context.WithoutCancel(ctx)` + timeout propio dentro de `sfDetail.Do`/`sfCatalog.Do` | `internal/catalog/service.go` |
| R4 | No refetch del catálogo en cada `visibilitychange` | Hoy volver a la pestaña baja 300 KB ×2 y rearma toda la lista. Basta con "si pasaron > 5 min" | `web/src/hooks/useApi.ts` |
| R5 | `recordDemand` solo para pedidos de persona | La tanda manda un `?source=auto` (o un header) y no cuenta | `detail.go`, `Program.tsx` |

### 4.2 Por request (medio día)

Un hit de detalle hace ~12 consultas a Postgres: `resolveProgram` → `ensureDirectory` →
`coordinates` (niveles, sedes, tres `ReferenceFetchedAt`) → `store.Programs` **de toda la
sede** filtrado en Go, más `recordDemand`, `refreshBlocked`, `CourseProgramFetchedAt`,
`Course`, `Sections` (3 consultas) y `CourseProgramTypology`. Con `pool_max_conns=16` y
32 requests en vuelo, la tanda también hace cola en Postgres.

- Cachear en memoria niveles/sedes/directorio (cambian cada 30 días; TTL de 1–5 min
  basta) y resolver el plan con un `WHERE code = $n` en vez de traer la sede.
- `UpsertCatalog` hace 2 `Exec` por asignatura (≈1400 round-trips para Medellín): un
  `pgx.Batch` o `unnest` lo deja en 2.

### 4.3 Front (medio día)

- Fila memoizada (`React.memo`) que reciba sus datos ya resueltos; hoy cualquier cambio
  repinta todas.
- Escribir las mediciones en lote: acumular y `putDetails` una vez por frame
  (`putDetails` ya existe y nadie lo usa). Derivar `measuring` del mismo almacén en vez
  de un segundo `setState`.
- Medir lo **visible** primero (`IntersectionObserver`) y con concurrencia baja (4–6).
  Quien abre el catálogo mira 15 filas, no 267.

### 4.4 Pool

- **Afinidad por plan.** `Acquire` es FIFO; con varios planes en vuelo cada conexión paga
  la cascada (2–6 POSTs) una y otra vez. Preferir una conexión con `ParkedAt == key`
  antes de tomar la primera libre. Es el ahorro de "2 POSTs en vez de 6" que `ARCH.md`
  ya describe, hoy librado al azar.
- **Carriles.** Reservar parte del pool para lo interactivo (catálogo, ficha, botón de
  medir) y acotar lo especulativo al resto. Un semáforo alcanza.
- `Do` devuelve al pool una conexión que dio noop dos veces seguidas. Debería marcarla
  para re-bootstrap perezoso en el próximo uso; hoy eso lo hace solo el keepalive.

## 5. Lógica de negocio — enfoques mejores

### 5.1 Un dato viejo no es un dato desconocido

Hoy, pasados 30 min, la celda tira el número y pinta `?`. La base sabe "12 cupos hace
25 h" y muestra menos que eso. Fuera de inscripciones los cupos no se mueven (medido en
`FASE-2.md`: 0 cambios en 347 grupos en 35 min), así que el número viejo casi siempre es
el correcto.

**Propuesta: stale-while-revalidate a la vista.** Pintar el número guardado, atenuado y
con su edad; la rueda chiquita al lado mientras se remide; reemplazar al llegar. El `?`
queda solo para "nunca se preguntó". Con esto la medición automática deja de ser urgente
y puede ser lenta, visible-primero y barata — y el dolor 2 desaparece por diseño: ya no
hay una transición de "nada" a "número", solo un número que se actualiza.

### 5.2 La frescura de cupos debería ser global, la visibilidad por plan

El modelo ya separa bien las dos cosas (`section` global, `section_program` por plan),
pero el read-through decide con un solo sello por plan (`detail_fetched_at`). Regla
propuesta para `CourseDetail(maxAge)`:

- **visibilidad** conocida y < 24 h (el sello del plan), **y**
- **cupos** de todos los grupos visibles medidos hace < `maxAge` (`seats_checked_at`,
  venga del plan que venga) → **hit**.

Para las 136/267 asignaturas de la tabla de §3.1 eso es cero POSTs. El costo es una
consulta más en el camino del hit.

Un paso más allá, para misses: la clave del `singleflight` es `programID:code`; dos
planes pidiendo la misma electiva a la vez son dos fetches. No se pueden fundir del todo
(la visibilidad difiere), pero sí ordenar: el segundo espera al primero y reevalúa la
regla de arriba, que ahora da hit si ya conocía su visibilidad.

### 5.3 Mover la medición al servidor

El front orquestando 267 requests es el enfoque caro: no sabe qué midió otro usuario, no
puede priorizar, y cada pestaña repite el trabajo. Alternativa:

```
POST /v1/campuses/{c}/programs/{p}/seats:refresh   → 202 {queued: n}
GET  …/courses                                     → lo de siempre, con los sellos
```

El servidor encola por `(campus, code)` —dedupe entre usuarios y entre planes gratis—,
usa `FetchDetails` (una conexión, un plan, N asignaturas: el camino que el Refresher ya
tiene y que ahorra el re-parqueo), respeta el carril de §4.4 y un presupuesto global de
POSTs/s. El front solo vuelve a pedir el catálogo cada tanto mientras haya encolados.
Es, en el fondo, el modo `seats` del Refresher disparado por demanda real en vez de por
cron: reemplaza al hot set adivinado por "los planes que alguien tiene abiertos ahora".

Versión perezosa mientras tanto (sin back): §4.3 visible-primero + concurrencia 4–6 +
`VITE_STALE_SEATS_SECONDS` alineado con la temporada (30 min en inscripciones, 24 h el
resto del año).

### 5.4 Servir lo guardado cuando el SIA falla

Si el fetch falla y hay dato en Postgres: responder 200 con el dato, `X-Cache: stale` y
un `Warning`. El front ya tiene el lugar para decirlo (`isNoopWithData` en `Course.tsx`).
502 solo cuando no hay nada que mostrar. Con esto §1.1 habría sido un aviso amarillo y no
una app rota.

### 5.5 Latentes (no duelen hoy, van a doler)

- **Cambio de periodo.** `ProgramCourses`, `Sections` y `ProgramSchedules` no filtran por
  `term`, y la reconciliación de `UpsertDetail` solo apaga visibilidad del `term` actual.
  En 2027-1 los grupos de 2026-2 siguen visibles: se suman a los cupos, y su
  `seats_checked_at` de meses atrás se vuelve el `oldest` de la asignatura → `?` perpetuo
  que la medición nunca cura. Filtrar por `term = $actual` en las tres lecturas.
- **Un grupo sin "Cupos disponibles" parseable** deja su `seats_checked_at` viejo y
  arrastra el `min()` de toda la asignatura, mismo síntoma.
- **`rate_limit` significa dos cosas** (balde por IP y cooldown por asignatura) con el
  mismo `error`. El front le dice "esta asignatura se midió hace un momento" a quien en
  realidad chocó con el balde. Códigos distintos.
- El limitador por IP castiga a toda una red NAT (el campus entero sale por pocas IPs).
  Con la medición en el servidor (§5.3) el balde puede volver a ser chico sin romper nada.

## 6. Fortalezas (lo que no hay que tocar)

- **La documentación de trampas.** `GOTCHAS.md` + los comentarios con el porqué y la fecha
  de medición son el activo más valioso del repo; el código del pool se lee como un
  registro de incidentes ya resueltos.
- **Hexágono real.** El Refresher entra por `catalog.Service`; hay un solo upsert.
- **Modelo de datos correcto donde es difícil**: `section` global vs `section_program`,
  tipología por plan, identidad `(campus, faculty, code)`, snapshots solo cuando el
  número cambia.
- **Honestidad del dato**: la edad viaja con el dato, "no sé" ≠ "no hay", guardas contra
  catálogos truncados o encogidos antes de reconciliar.
- **Pool que se autorrepara**: keepalive con holgura medida, reparación fuera del `ctx`
  del cliente, arranque "usable, no completo".
- **Front sin dependencias de más** (React + lucide), criterio único para `seatsUnknown`,
  reintentos compartidos, tests donde hay lógica (`conflicts`, `catalog`, `plans`).

## 7. Debilidades transversales

- **Contrato duplicado a mano.** `openapi.yaml` manda, pero `web/src/api/types.ts` se
  escribe aparte y ya divergió (§2). Generar los tipos (`openapi-typescript`) convierte
  ese bug en error de compilación.
- **`Program.tsx` tiene 1400 líneas** y mezcla fetch, medición, filtros, choques y
  render. La medición automática no tiene un solo test; es donde estaban los dos bugs.
- **Sin observabilidad del camino al SIA.** Hay logs, no hay métricas: tasa de noop,
  espera en `Acquire`, POSTs/s, ocupación del pool. `/v1/status` es el sitio natural.
- **Invariantes repartidas entre back, front y `.env`** (`CONCURRENCY ≤ SIA_POOL_SIZE ≤
  RATE_LIMIT_BURST`) sostenidas por comentarios. La de `RATE_LIMIT_RPS` no estaba en la
  lista y es la que se rompió.
- **Tests del back atados a Postgres/SIA reales**; no hay una prueba de carga que simule
  "dos usuarios abren un catálogo", que es el escenario que falló.

## 8. Plan priorizado

**P0 — hoy, operación**
1. ~~Diagnosticar el `sia_noop` global~~ hecho (§1.1); `api` reiniciado. **Desplegar el fix
   del cookie jar**: sin él, el pool se vuelve a pudrir en días.
2. Apagar la tormenta mientras no exista §5: `VITE_STALE_SEATS_SECONDS=86400` y
   reconstruir `web`. Es una variable, no código.
3. Reactivar `catalog` y `reference` en el cron (§1.2).
4. `encode zstd gzip` en Caddy (R1).

**P1 — esta semana, bugs**
5. Mergear el fix de §2 (esta rama) y corregir el contrato del detalle.
   Loguear el cuerpo del noop que sobrevive a un re-bootstrap; 499 para `context canceled`.
5. R2 (nombre en el detalle), R3 (ctx del singleflight), R5 (demanda).
6. Stale-on-error (§5.4) y códigos de 429 separados.
7. Estado del pool en `/v1/status`.

**P2 — siguiente iteración, diseño**
8. SWR visible en la celda de cupos (§5.1) + medición visible-primero con concurrencia
   baja (§4.3).
9. Frescura de cupos global (§5.2).
10. Afinidad y carriles en el pool (§4.4); cache en memoria de la referencia (§4.2).

**P3 — cuando haya tiempo**
11. Medición en el servidor (§5.3).
12. Filtro por `term` antes de 2027-1 (§5.5). *Tiene fecha: antes del cambio de periodo.*
13. Tipos generados desde OpenAPI; partir `Program.tsx`; prueba de carga.

## 9. Estado de implementación

Tercera pasada: se atacó todo lo de arriba que cabía sin rediseñar, en la rama
`fix/auto-measure-seats-transition` (sin commit). **Nada está desplegado.**

| § | Qué | Estado | Dónde |
|---|---|---|---|
| 1.1 | Jar de cookies nuevo en cada bootstrap | **hecho + test** (falla sin el fix) | `internal/sia/conn.go` |
| 1.1 | Loguear el noop que sobrevive a un re-bootstrap; conexión "sospechosa" se re-bootstrapea antes del siguiente uso | **hecho** | `internal/sia/pool.go` |
| 1.1 | Salud del camino al SIA en `/v1/status` (`sia`: ok/fallidos/noops/posts/bytes/last_ok) | **hecho**, probado en vivo | `pool.go`, `catalog/background.go`, `httpapi/status.go` |
| 1.1 | `context canceled` → 499 sin `ERROR` | **hecho** | `httpapi/errors.go` |
| 1.2 | Reactivar `catalog`/`reference` en el cron | **resuelto de otra forma (2026-09-21)**: el cron se abandonó; la API sirve el catálogo y la referencia guardados y los refresca por detrás (`Service.ServeStale`). Ver el aviso al inicio de `FASE-2.md` | `catalog/service.go` |
| 1.2 | `/v1/status` distingue "pausado" de "roto" | pendiente: la API no ve el crontab; `finished_at` ya deja calcular la edad | — |
| 2 | Rueda → cupos (`seatsFromDetail`) | **hecho + test**, verificado en Chromium | `web/src/lib/catalog.ts`, `Program.tsx` |
| 2 | El contrato ya no miente: el detalle trae `seats` y `detail_fetched_at` | **hecho + test**, probado en vivo | `catalog/service.go`, `httpapi/detail.go`, `openapi.yaml` |
| 2 | Cooldown del botón desde `detail_fetched_at` | **hecho** | `useCourseDetails.ts`, `Course.tsx` |
| 3 / 4.3 | Medir solo lo visible, de a 6, en cola que se vacía al salir | **hecho + test** de la cola; en Chromium: **17 peticiones al abrir, antes 272** | `Program.tsx`, `lib/pooled.ts` |
| 3.2 / 4.4 | Carril de fondo: lo especulativo usa a lo sumo medio pool | **hecho + test** | `pool.go`, `?background=1` |
| 3.2 / R3 | `singleflight` sin heredar la cancelación del primero | **hecho + test** | `catalog/service.go` (`shared`) |
| 3.2 / R5 | La medición automática no ensucia `course_demand` | **hecho** (`?background=1`) | `httpapi/detail.go` |
| 3.3 / 4.3 | Fila memoizada, objetos estables, escrituras una vez por frame | **hecho** | `Program.tsx` (`CatalogRow`, `mergedSeats`) |
| R1 | Compresión | **hecho en el repo**: `gzip` en los dos nginx, `encode` en el snippet de Caddy. El Caddyfile del server es compartido: aplicarlo es tuyo | `web/nginx*.conf`, `deploy/Caddyfile.gabotachak` |
| R2 | Nombre en el detalle de la API (filtro `it11`) | **hecho + test**, probado en vivo | `ports.go`, `source.go`, `service.go` |
| R4 | No refetch en cada `visibilitychange` (solo si pasaron > 5 min) | **hecho** | `useApi.ts` |
| 4.2 | `UpsertCatalog` en un batch | **hecho** (cubierto por los tests de store) | `store/course.go` |
| 4.2 | Cache en memoria de la referencia | **no se hizo, a propósito**: medido, son ~6 consultas de <1 ms; un hit completo responde en 2–3 ms | — |
| 4.4 | Afinidad por plan en el pool | **hecho + test** | `pool.go` (`acquireAt`) |
| 5.1 | Número vencido a la vista, atenuado, con su edad | **hecho**, verificado en Chromium | `Program.tsx` (`SeatsCell`), `Program.css` |
| 5.2 | Frescura de cupos global, visibilidad por plan | **hecho + test** | `catalog/service.go` (`seatsFresh`) |
| 5.3 | Medición en el servidor (cola por `(campus, code)`) | **pendiente**: es diseño nuevo, no un arreglo. Con visible-primero + carril + 5.2 dejó de ser urgente | — |
| 5.4 | Servir lo guardado cuando el SIA falla (`X-Cache: stale`) | **hecho + test**; `docs/API.md` ya lo prometía | `catalog/service.go` |
| 5.5 | Cambio de periodo: el detalle nuevo apaga los grupos del periodo viejo | **hecho + test** contra Postgres real | `store/section.go` |
| 5.5 | 429 con dos códigos: `rate_limit` (balde) y `refresh_cooldown` | **hecho + test** | `httpapi/cooldown.go`, `client.ts`, `docs/API.md` |
| — | `WriteTimeout` (30 s) más corto que el presupuesto del request (45 s): cortaba la conexión antes del 503 | **hecho** (encontrado en esta pasada) | `cmd/bridge/main.go` |
| 7 | Tipos del front generados desde OpenAPI; partir `Program.tsx`; prueba de carga | **pendiente**: refactors sin urgencia | — |

Encontrado de paso y **no** atacado: una conexión cuyo bootstrap llega con la tabla de
otra sesión (GOTCHAS §22) paga ~1.1 MB por cada POST de cascada hasta su primer `cb1`
(medido: 3.9 MB para un solo detalle). Y un detalle de libre elección cuesta ~9 POSTs
porque busca primero en el listado regular, donde nunca está: la tipología ya está en
Postgres y podría decidir por cuál empezar.

### Cómo se probó, todo local

Sin Docker ni sudo: Go 1.27 y Postgres 18.6 en espacio de usuario (binarios de
`io.zonky.test.postgres`), migraciones con goose, Chromium headless de Playwright.

- `go build`, `go vet`, `go test -race ./internal/... ./cmd/...` contra **Postgres real**
  (los tests de `store/` y `cmd/refresher/` se saltan sin `TEST_DATABASE_URL`): verde.
- `vitest` 75/75, `tsc -b`, `oxlint` sin avisos nuevos, `vite build`.
- **Punta a punta**: la API local (pool de 3) contra el SIA real y Postgres local.
  Directorio en frío 9.6 s, catálogo 2879 en frío 3.7 s (272 asignaturas), detalle *miss*
  2.1–2.6 s, *hit* 2.5 ms, `max_age=0` dentro del cooldown → `429 refresh_cooldown`.
  48 requests, **24 fetches al SIA, 0 fallidos, 0 noops**.
- **Navegador**: el catálogo abre, las filas visibles pasan de la rueda a su número
  (2, 1, 7, 11, 19…), y los valores coinciden uno a uno con los de producción. Abrir una
  ficha, volver (la fila conserva el número sin rueda) y agregar a Mi semestre: sin errores
  de página ni de API.

### Cuarta pasada: lo mismo, en Docker

Con el daemon ya disponible se repitió todo sobre los contenedores del repo, que es como
corre en producción: `docker compose build` de `api`, `web` y `refresher` desde esta rama,
`db` con `deploy/initdb` (crea `sia_bridge_test` sola), migraciones con goose.

- `go test -race ./internal/... ./cmd/...` contra el **Postgres del contenedor**: verde.
- Por el **nginx del contenedor `web`** (:13000): `Content-Encoding: gzip` en todo — el
  catálogo baja de 271 KB a **91 KB** en el cable, el bundle de 319 KB a 113 KB —, proxy
  `/v1` bien, detalle con `seats` (19, igual que producción) y `detail_fetched_at`,
  `429 refresh_cooldown`, `?background=1`. 7 fetches al SIA, 0 fallidos, 0 noops.
- **Chromium contra el bundle de producción** servido por nginx: 19 peticiones al abrir un
  catálogo de 272 filas, todas con `background=1`; rueda → número; ficha, volver y Mi
  semestre sin errores. En `course_demand` solo quedaron las lecturas de persona: ninguna
  de las ~27 mediciones automáticas.
- **`refresher` en su contenedor** (`--mode=seats --scope=hot`): 6 asignaturas, 0 fallos,
  45 POSTs — el cambio de firma de `FetchDetail` no tocó el Job.

Y Docker destapó dos bugs que el Postgres suelto escondía, los dos corregidos acá:

- **Los nombres con tilde salían al final del catálogo.** `postgres:alpine` ordena por
  bytes, así que `ORDER BY c.name` mandaba "Álgebra Lineal" después de "Uitoto II" —
  verificado en producción: era la 265 de 267 del plan 2879. Ahora el orden lleva
  `COLLATE "es-x-icu"`; en el contenedor pasó del puesto 270 al 4. Con test (falla sin el fix).
- **El segundo `docker compose build` moría** con `permission denied` sobre `pgdata/18/docker`:
  con `PGDATA_DIR=./pgdata` (el default de `.env.example`) el bind mount de Postgres, que es
  de root, entraba al contexto del build. `pgdata/` va ahora en `.dockerignore`. En el server
  no pasa porque `PGDATA_DIR` apunta fuera del repo. Por lo mismo `go vet ./...` y
  `make test` fallan con la base levantada desde el repo; usar `./internal/... ./cmd/...`.

### Quinta pasada: lo que había quedado pendiente

| Qué | Estado |
|---|---|
| Grupo que el SIA deja de reportar con cupos arrastraba el sello de toda la asignatura | **hecho + test** contra Postgres: no aporta su número viejo, y cuenta cuándo se lo miró |
| Lecturas del Store sin filtro de periodo | **hecho + test**: solo el periodo más nuevo de cada asignatura |
| Detalle de libre elección a ~10 POSTs | **hecho, medido en vivo**: electivas primero + repetir la búsqueda con solo el botón → **3 POSTs y ~65 KB** (antes 10 y ~210 KB). GOTCHAS §42 |
| Edad congelada en las filas del catálogo | **hecho**: un reloj compartido (`useNow`), visto avanzar en Chromium |
| `X-Cache: stale` sin aviso | **hecho**: la ficha dice que el SIA no respondió |
| `go vet ./...` / `make test` con la base levantada | **hecho**: default `PGDATA_DIR=./.pgdata` |
| Limitador por IP contra una red NAT | **hecho**: default 60/80 (lo que ya corre producción); el pool se protege solo |
| Mi semestre con 32 en vuelo al abrir | **hecho**: 6 en la carga pasiva, 32 para el botón |
| Test de la decisión del `IntersectionObserver` | **hecho**: `pickToMeasure`, pura y probada |
| `Program.tsx` de 1400 líneas | **en parte**: fila y celda de cupos a `CatalogRow.tsx` (1176 + 310) |
| Prueba de "dos usuarios abren un catálogo" | **hecho** a nivel de pool: `TestDoAt_APersonIsServedWhileCatalogSweepsRun` |
| El jar envenenado, como trampa documentada | **hecho**: GOTCHAS §41 |

Lo que **no** se hizo, y por qué:

- **Bootstrap que llega con la tabla de otra sesión (~1.1 MB por POST de cascada).** No tiene
  arreglo seguro de nuestro lado. La tabla la re-renderiza el SIA porque cuelga de los
  dropdowns; la única forma de no bajarla es cortar la respuesta a mitad, y ADF guarda el
  estado de la vista al final del render: cortar ahí arriesga que la cascada "no haya pasado"
  y el siguiente POST devuelva datos de otro plan, en silencio. Se paga una vez por conexión,
  y la afinidad por plan hace que se pague menos. Desde el server de producción el bootstrap
  llega de 59 KB, así que hoy allá no duele.
- **Medición en el servidor (§5.3).** Es un Job más contra el SIA, que es justo lo que se
  decidió no tener corriendo ahora. Con visible-primero, el carril de fondo, cupos globales
  y las electivas a 3 POSTs, el costo por catálogo abierto cayó lo suficiente como para no
  necesitarlo todavía.
- **Tipos del front generados desde OpenAPI.** El contrato no declara `required`, así que
  todo saldría opcional y habría que tocar cada uso. Antes hay que endurecer el YAML.
- **Invariantes `CONCURRENCY ≤ SIA_POOL_SIZE ≤ RATE_LIMIT_BURST` en código.** Con la medición
  automática en 6 y el limitador en 60/80, la única que queda es la del botón de Mi semestre,
  y sigue en un comentario.
- **Avisos `set-state-in-effect` de oxlint** (7, todos de `main`): es el patrón que el front
  usa a propósito para sincronizar estado; cambiarlo es tocar pantallas que no fallan.
- **`/v1/status` no distingue Refresher pausado de cron roto**: la API no ve el crontab, y
  mientras el Job esté pausado por decisión, no hay nada que avisar.

No probado: comportamiento bajo carga real de varios usuarios, y el fix del jar contra
el envenenamiento real — solo se reproduce con días de tráfico. `/v1/status` → `sia` es
lo que lo va a decir después de desplegar.

## 10. Cómo se midió (primera y segunda pasada)

- API de producción, solo lectura, ~10 GETs: `/status`, `/version`, `/healthz`, directorio
  de Bogotá, catálogos de 2879 y 2A74, cuatro detalles sin `max_age`.
- SIA: GETs de bootstrap sueltos, Bruno 01→06 desde local y desde el server, y dos
  scripts de ~4 requests (cuerpo de Go con `soc1=0`/`soc1=1`; re-bootstrap con la misma
  cookie). En total, menos de 40 requests.
- Server de producción por SSH, solo lectura salvo **un** `docker compose restart api`
  (autorizado): logs de `api`, `.env` sin secretos, `/etc/cron.d/sia-refresher`,
  `/var/log/sia-refresher.log`. Ningún otro contenedor del server se tocó.
- Go: compilado y testeado en un contenedor `golang:1.27.0-alpine` efímero sobre una copia
  en `/tmp/fable-build` (borrada al terminar).
- Front: `npm ci`, `vitest run` (72/72), `tsc -b`, `oxlint`.
- No se hizo: reproducir la tormenta (habría sido cargarle ~1000 POSTs al SIA), ni medir
  tiempos de render en navegador. Las cifras de §3.3 son conteo de renders por lectura de
  código, no perfilado.
