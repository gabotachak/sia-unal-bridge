# Arquitectura

API puente sobre el catálogo del SIA: traduce la navegación con estado de Oracle ADF a
JSON. Los diagramas de cada flujo están en [diagram.md](diagram.md); este documento
explica las reglas que esos diagramas dibujan.

Los números medidos del SIA viven solo en [PROTOCOL.md §10](PROTOCOL.md). Los valores de
configuración viven en el código (cada sección nombra la constante) y en
[`.env.example`](../.env.example). Aquí no se repiten.

---

## Premisa

Casi todo el catálogo cambia una vez por semestre: códigos, nombres, créditos, horarios.
**Lo único volátil son los cupos.** Consultar el SIA en cada petición daría una API de
segundos, así que cachear no es una optimización: es la condición para que esto sea
usable.

La frontera no es "cupos contra todo lo demás", sino **listado contra detalle**:

| Dato | De dónde sale | Granularidad |
|---|---|---|
| código, nombre, créditos, tipología, descripción | listado (`cb1`) | 1 POST → todas las asignaturas de un plan |
| grupo, profesor, horario, aula, jornada, **cupos** | detalle (click) | 1 POST → 1 asignatura |

El listado no trae cupos. Cada medición de cupos trae horarios y profesor gratis, en la
misma respuesta.

---

## Hexágono

```
              driving                                driven
   ┌──────────────────────┐                    ┌──────────────────┐
   │ internal/httpapi     │──┐              ┌─>│ internal/store   │──> Postgres
   └──────────────────────┘  │  ┌────────┐  │  └──────────────────┘
                             ├─>│catalog │──┤
   ┌──────────────────────┐  │  │Service │  │  ┌──────────────────┐
   │ internal/refresher   │──┘  └────────┘  └─>│ internal/sia     │──> SIA (ADF)
   └──────────────────────┘                    └──────────────────┘
```

| Paquete | Rol | Responsabilidad |
|---|---|---|
| `cmd/bridge` | composición | lee config, arma adaptadores, arranca el servidor. Sin lógica |
| `cmd/refresher` | composición | lo mismo para el barrido manual, con **su propio pool** |
| `internal/catalog` | dominio + puertos | tipos, frescura, read-through. Declara `Store` y `SIASource` en `ports.go` |
| `internal/httpapi` | driving | HTTP → casos de uso; errores de dominio → status |
| `internal/refresher` | driving | enumera trabajo y lo recorre acotado, por los mismos casos de uso |
| `internal/store` | driven | Postgres; `Cached` guarda la referencia en memoria |
| `internal/sia` | driven | todo lo que toca el SIA: protocolo, estado, parseo |
| `internal/config` | — | variables de entorno → struct |

### La invariante

`internal/catalog` no importa `gin`, `pgx`, `goquery` ni `encoding/xml`. Ni `catalog` ni
`refresher` importan `sia`, `store` o `httpapi`. `internal/catalog/hexagon_test.go` falla
si eso se rompe.

- **El `Refresher` no escribe en la base por su cuenta.** Entra por `catalog.Service`,
  igual que un cliente HTTP. Hay un solo upsert de catálogo.
- `gin.Context` nunca cruza al dominio: los handlers pasan `c.Request.Context()`.
- `sia` y `store` importan `catalog` por sus tipos, y satisfacen los puertos
  estructuralmente.

---

## Read-through

Si está en Postgres y fresco, se sirve. Si no, se consulta al SIA, se persiste y se
responde. Cada recurso tiene su TTL (`catalog/freshness.go`, tabla en
[API.md](API.md#frescura)) y `?max_age=` lo cambia por petición.

Dos políticas, según cuánto cambia el dato:

| Recurso | Al vencer | Por qué |
|---|---|---|
| Referencia y catálogo | **stale-while-revalidate**: responde lo guardado y refresca por detrás | casi no cambian; nadie debería esperar un fetch para recibir lo mismo |
| Detalle y cupos | **espera** el fetch; si el SIA falla, sirve lo guardado marcado `stale` | son volátiles; un cupo viejo servido como fresco mentiría |

Lo activa `Service.ServeStale`, que `cmd/bridge` enciende. El `Refresher` lo deja apagado:
él sí necesita que el fetch haya ocurrido cuando la llamada vuelve.

### Dos caches con granularidad distinta

```
catálogo   → por PROGRAMA     1 POST trae todo el plan      casi inmutable
detalle    → por ASIGNATURA   1 POST trae 1 asignatura      volátil (cupos)
```

- Un miss de catálogo llena el plan entero. El catálogo de un plan son **dos** consultas:
  la regular (`soc4=0`, todo menos libre elección) y la de electivas de la sede
  ([GOTCHAS §21](GOTCHAS.md)). `catalog_fetched_at` se sella solo con las dos.
- El detalle es irreductiblemente unitario: no hay forma de traer los grupos de varias
  asignaturas en un POST.
- **La visibilidad es por plan, los cupos son globales.** Un plan que nunca pidió una
  asignatura paga el POST aunque otro plan ya la tenga. Pero si este plan ya sabe qué
  grupos ve y todos tienen cupos recientes, medidos desde cualquier plan, se sirve sin ir
  al SIA.

### Deduplicación

- **`singleflight` por clave** (`catalog/service.go`, función `shared`): N clientes que
  piden lo mismo en frío generan un fetch. Si el primero cancela, el fetch sigue con
  `context.WithoutCancel` y su deadline, y se persiste igual.
- **`refreshBehind`**: el refresco de fondo arranca como mucho una vez por clave cada
  `behindRetry`, en el carril de fondo del pool.

### Cache de referencia en memoria

Cada petición bajo `/programs/{program}` resuelve el programa con lecturas de referencia
(niveles, sedes, directorio y sus sellos). `store.Cached` las guarda en memoria durante
`referenceCacheTTL` y las invalida con cualquier escritura de referencia o de catálogo
propia. El resto pasa directo a Postgres. No hace falta Redis: con una sola instancia, un
viaje a Redis cuesta lo mismo que el viaje a Postgres que reemplazaría.

---

## `SIASource` es un pool de sesiones, no un cliente HTTP

Cada `SIAConn` es una sesión ADF viva:

- muere tras unos minutos de inactividad ([PROTOCOL §10](PROTOCOL.md));
- es **estrictamente secuencial**: el SIA no rechaza dos peticiones simultáneas en una
  sesión, le da a una la respuesta de la otra ([GOTCHAS §28](GOTCHAS.md));
- está **parqueada** en un `(nivel, sede, facultad, programa)`, y moverla cuesta POSTs;
- está en el buscador o en una región de detalle **numerada** (`DetailRegion`).

Saber dónde está cada conexión es lo que ahorra POSTs ([PROTOCOL §9](PROTOCOL.md)).

### Reglas del pool (`internal/sia/pool.go`)

| Regla | Cómo |
|---|---|
| **N peticiones concurrentes = N conexiones** | el pool es un `chan *SIAConn`; una conexión fuera del canal es de quien la tomó |
| **El mutex envuelve la operación lógica**, no el POST | `DoAt` sostiene la conexión durante cascada + `cb1`, o detalle + Volver |
| Afinidad | `acquireAt` prefiere una conexión libre ya parqueada en el programa pedido |
| Pool lleno | `Acquire` espera hasta el deadline de la petición y devuelve `ErrBusy` (503) |
| Carril de fondo | el trabajo marcado con `catalog.WithBackground` ocupa como mucho la mitad del pool |
| Auto-reparación | un no-op re-bootstrapea y reintenta una vez; una conexión que queda en detalle sale con Volver, o con un bootstrap si falla. Nunca con el contexto del cliente |
| Conexión sospechosa | si un no-op sobrevive a una sesión nueva, la siguiente operación re-bootstrapea antes de usarla |
| Keepalive | cada `keepaliveTick`, ping a toda conexión libre quieta desde `keepaliveIdle`; un ping que da no-op re-bootstrapea |
| Arranque | `NewPool` bootstrapea `readyBeforeServing` conexiones en serie y llena el resto en segundo plano, de a una |

### Quién va al carril de fondo

`httpapi.laneByIP` (`ratelimit.go`) decide antes del handler:

- toda petición con `?background=1`;
- toda petición de una IP que ya tiene `foregroundPerIP` en vuelo.

No rechaza: degrada. Un cliente que pide muchas asignaturas frías a la vez no puede tomar
más de la mitad del pool, y una red NAT entera (un campus detrás de pocas IPs) sigue siendo
atendida. El limitador por IP (`RATE_LIMIT_*`) cuenta peticiones; este cuenta conexiones
retenidas.

### Dónde hay goroutines, y por qué solo ahí

| Uso | Motivo |
|---|---|
| Pool como canal con buffer | acota la concurrencia y da `ErrBusy` con `select` sobre `ctx.Done()` |
| Keepalive | una goroutine para todo el pool |
| Llenado del pool | una goroutine que bootstrapea de a una conexión: en paralelo serían varios MB de golpe |
| `singleflight` y `refreshBehind` | evitan fetches repetidos; el refresco de fondo no bloquea al cliente |
| `recordDemand` | cuenta la demanda sin sumar latencia a la respuesta |
| `Refresher` | `errgroup.SetLimit(workers)` sobre la lista de **programas** (ver abajo) |

---

## `Refresher`

Barrido manual de la cache (`cmd/refresher`, `internal/refresher`). **No corre por cron**:
el stale-while-revalidate de la API cubre lo que el cron cubría, solo para lo que alguien
abre. Sirve para precalentar o reparar.

| Modo | Qué hace |
|---|---|
| `reference` | niveles → sedes → directorio de programas de cada sede |
| `catalog` | catálogo de cada programa vencido según `REFRESH_CATALOG_MAX_AGE` |
| `detail --scope=global` | detalle de cada asignatura cuyo detalle **global** está vencido, pedido desde un plan cualquiera |
| `detail --scope=plan` | detalle por plan, para conocer la visibilidad de grupos de cada uno. Es el modo caro |
| `seats --scope=hot` | detalle de las asignaturas más pedidas por clientes (`course_demand`) |

`--campus` acota a una sede. Las variables `REFRESH_*` están en
[`.env.example`](../.env.example).

Reglas:

- **Pool propio.** Compartir el de la API serviría `503 busy` a los usuarios durante todo
  el barrido. La suma de los dos pools respeta el límite de sesiones del SIA
  ([PROTOCOL §10](PROTOCOL.md)); `cmd/refresher` avisa en el log si se pasa.
- **El checkpoint son los marcadores de frescura**, no un cursor. Reanudar es volver a
  correr; dos corridas seguidas no hacen ni un POST. La unidad de commit es una
  asignatura.
- **Una goroutine por programa, nunca por asignatura.** La conexión queda parqueada en el
  programa y `FetchDetails` recorre sus asignaturas por ella. Repartirlas reabre
  [GOTCHAS §30, §31, §33](GOTCHAS.md).
- **Un error no mata el barrido.** Se acumula en el `Report`. Solo el circuit breaker
  (`internal/refresher/report.go`) corta: muchas fallas seguidas son el SIA que cambió.
- **Un advisory lock por modo** (`pg_try_advisory_lock`): si otra corrida del mismo modo
  sigue viva, la nueva sale con código 0.
- `REFRESH_ENABLED=false` bloquea todos los modos sin abrir una sola conexión.
- Cada corrida queda en `refresh_run` y `/v1/status` muestra la última de cada modo. Es
  observabilidad, no checkpoint.

---

## Restricciones heredadas del SIA

Condicionan el diseño, no la implementación. La evidencia está en
[GOTCHAS.md](GOTCHAS.md).

| Restricción | Impacto |
|---|---|
| El User-Agent no puede parecer navegador (§1) | el default de Go sirve; no "mejorarlo" |
| La sesión muere por inactividad (§7) | keepalive y re-bootstrap; los gestiona el pool |
| El bootstrap es caro y variable (§25) | una vez por sesión, nunca por petición |
| **Una sesión concurrente devuelve la respuesta de otro hilo** (§28) | mutex por conexión sobre la operación lógica |
| **La región de detalle está numerada y sube** (§20) | `DetailRegion` en la conexión, leída de cada respuesta |
| `_afrRK` se renumera en cada re-render (§4) | re-parsear siempre; nunca cachear row keys |
| Sin cascada completa el botón es un no-op (§6) | una respuesta de ~900 B es un error explícito |
| Los grupos visibles dependen del plan (§16) | `section_program`; una consulta no es el universo |
| Los cupos son globales (§16) | una medición sirve para todos los planes |
| **`soc4=0` excluye libre elección** (§21) | el catálogo de un plan son dos consultas |
| **`program.code` no es único entre sedes** (§26) | identidad `(campus, faculty, code)` |

### Dónde vive cada trampa en `internal/sia`

`internal/sia` está partido por fase del protocolo, para que cada trampa tenga un archivo
obvio.

| Archivo | Trampas |
|---|---|
| `conn.go` | §1 UA · §2 `winnoloop` · §3 ViewState · §7 expiración · §8 cookie+ViewState · §10 y §20 regiones · §22 tabla ajena · §25 bootstrap · §41 cookie jar |
| `pool.go` | §7 keepalive · §28 mutex sobre la operación lógica |
| `form.go` | §9 `selection` · §11 `DELTAS` · §12 headers |
| `cascade.go` | §6 cascada · §21 electivas · §30, §33, §37, §42 re-envíos · §32 y §35 comodín de sede |
| `parse_list.go` | §4 `_afrRK` · §5 `_rowCount` · §13 dedupe · §22 tabla ajena · §29 minúsculas · §36 insignia en el nombre |
| `parse_detail.go` | §17 tipología · §18 sin grupos · §24, §27, §40 cabeceras de grupo |
| `parse_options.go` | §26 códigos de dropdown |
| `source.go` | §33 y §34 limpiar `it11` · §38 clic desde la búsqueda de la facultad |
| `noop.go` | §6 y §7 no-op y sesión muerta · §39 página de error del SIA |

**`noop.go` se lee entero antes de tocar nada**: es la diferencia entre "el SIA no devolvió
nada" y "devolví datos plausibles y equivocados".

---

## Una sola instancia

El proceso asume que es el único servidor de la API. Este estado vive en memoria:

| Estado | Dónde | Con varias réplicas |
|---|---|---|
| Pool de sesiones ADF | `sia.Pool` | cada réplica tiene el suyo; la suma respeta el límite del SIA |
| `singleflight` y `refreshBehind` | `catalog.Service` | dos réplicas pedirían lo mismo; idempotente, solo desperdicio |
| Cache de referencia | `store.Cached` | cada réplica la suya; el TTL acota la diferencia |
| Rate limit, carril por IP | `httpapi` | por réplica; el límite real se multiplica |
| Cooldown de `max_age=0` | lee `course_program.detail_fetched_at` | ya es compartido (Postgres) |

Nada de esto rompe con dos réplicas: solo se vuelve menos eficiente. El `Refresher` ya
convive así con la API.

---

## Lo que no sabemos

| Pregunta | Qué hace el código mientras tanto |
|---|---|
| ¿Cada cuánto cambian los cupos durante inscripciones? | el TTL de cupos es una elección, no una medición |
| ¿`course.code` es único entre sedes? | la clave es `(campus_code, code)`: si resulta global, colapsarla es borrar una columna |
| ¿Un estudiante puede inscribir un grupo PEAMA de otra sede? | se exponen con `site` marcado, sin filtrar |
| ¿Cada cuánto cambia el catálogo entre semestres? | el TTL de catálogo es una elección |

Los ids de componente ADF (`pt1:r1:0:soc1`, `pt1:r1:0:t4`) son frágiles por diseño: si la
UNAL repinta la página, cambian. La colección Bruno (`bruno/sia-catalogo/`) es el canario.
Si Bruno funciona y el código no, el problema es del código. Si Bruno tampoco, toca
re-mapear con [FIELDS.md](FIELDS.md).

---

## Librerías

| Necesidad | Elección | Por qué |
|---|---|---|
| Router HTTP | `gin` | grupos de rutas; `gin.New()` con middleware propio y `slog` |
| Postgres | `pgx/v5` + `pgxpool` | sin `database/sql` de intermediario |
| Migraciones | `goose` | SQL plano |
| HTML del listado | `x/net/html` + `goquery` | `_afrRK` se relee del `<tr>` en cada render; un regex es como murió el proyecto anterior |
| Detalle | texto plano | se busca por marcadores (`Profesor:`, `Cupos disponibles:`), no por DOM |
| Envoltorio XML | `encoding/xml` | `<partial-response>` → CDATA por id |
| Deduplicar fetches | `x/sync/singleflight` | |
| Rate limit | `x/time/rate` | |

`gin.Context` nunca entra a `catalog`, y los errores siempre salen por `writeError`
(`httpapi/errors.go`) con el formato de la API, nunca con el de gin.
