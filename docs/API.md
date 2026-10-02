# API

Contrato HTTP del puente: el **porqué** de cada decisión. Base `/v1`, todo JSON en UTF-8.

> **La forma exacta la define
> [`../internal/httpapi/openapi.yaml`](../internal/httpapi/openapi.yaml)**: OpenAPI 3.1,
> embebido en el binario y servido en `/v1/docs`. Este documento no repite esquemas. Si
> los dos discrepan, manda el YAML.

---

## Por qué REST

**GraphQL** deja que el cliente elija el costo, y aquí el costo es el SIA:

```graphql
{ program(code:"2A74") { courses { sections { seats } } } }   # un POST al SIA por asignatura
```

El detalle es **irreductiblemente unitario**: un POST por asignatura, sin forma de agrupar.
Con REST el costo está en la URL. Además, todo el diseño gira en torno a la frescura, y
un único POST de GraphQL pierde el cache HTTP (`Age`, `Cache-Control`).

**gRPC** no aporta: el consumidor es un navegador o un script, la latencia es del SIA y no
del transporte, y se perdería probar con `curl` o Bruno.

---

## Identificadores

Los índices de dropdown del SIA son **posiciones** y nunca aparecen en una URL. El ID
público es el código institucional ([DATA-MODEL, decisión 7](DATA-MODEL.md)).

| Entidad | ID en la URL | Ejemplo |
|---|---|---|
| `level` | slug | `pregrado`, `doctorado`, `posgrado` |
| `campus` | código institucional | `1101` |
| `faculty` | código institucional | `2055` |
| `program` | código institucional | `2A74` |
| `course` | `code` | `2016696`, `1000003-B` |
| `section` | `key` (token entre paréntesis) | `1`, `AMAZ-07` |

- **La sede es un segmento obligatorio de la ruta**: `/v1/campuses/{campus}/…`. No hay
  default ni URL que signifique "cualquier sede", porque `program.code` se repite entre
  sedes ([GOTCHAS §26](GOTCHAS.md)).
- Dentro de una sede un código de programa también puede repetirse entre facultades. Se
  desempata con `?faculty=`; sin él, la respuesta es `300` con los candidatos y un `hint`.
- `?level=` elige el nivel; por defecto `pregrado`.
- Un grupo se identifica por `key`, no por `number`: el número se repite dentro de una
  misma asignatura ([DATA-MODEL, decisión 8](DATA-MODEL.md)).
- `class_session` y `seat_snapshot` no son direccionables: viajan dentro de su `section`.

Nunca en una URL: `program_idx`, `campus_idx`, `faculty_idx`, `program.id`, `section.id`,
`_afrRK`.

### La ruta canónica cuelga del programa

```
/v1/campuses/{campus}/programs/{program}/courses/{code}
```

Los grupos visibles son un **subconjunto por plan** ([GOTCHAS §16](GOTCHAS.md)), así que
"los grupos de `1000004-B`" es una pregunta incompleta: le falta el plan. Además, en frío
es la única ruta resoluble: la cascada completa `(nivel, sede, facultad, programa)` sale
de la URL.

---

## Endpoints

### Referencia

| Ruta | Notas |
|---|---|
| `/v1/levels` | los niveles de `soc1` |
| `/v1/campuses` | las sedes de `soc9` |
| `/v1/campuses/{campus}/faculties` | |
| `/v1/campuses/{campus}/programs` | `?faculty=` filtra |
| `/v1/campuses/{campus}/programs/{program}` | incluye `catalog_fetched_at` |

Un miss del directorio de una sede trae **todas** sus facultades y programas: la cascada
ya pagó por ellas.

### Catálogo

`/v1/campuses/{campus}/programs/{program}/courses`

Un miss trae las dos mitades del catálogo del plan: la regular y la libre elección de la
sede ([GOTCHAS §21](GOTCHAS.md)). `catalog_fetched_at` se sella solo con las dos.

Filtros `?q=` (substring del nombre, sin distinguir mayúsculas), `?credits=` y
`?typology=`. Se aplican **sobre el catálogo guardado**: no cambian lo que se pide al SIA
ni lo que se sella.

Cada asignatura trae los cupos **ya guardados** (`seats`) y `detail_fetched_at` (cuándo
este plan pidió su detalle). Ninguno dispara un fetch. Juntos permiten no mentir:

| `detail_fetched_at` | `seats` | Significa |
|---|---|---|
| ausente | ausente | nadie preguntó: **no se sabe** |
| presente | ausente | se preguntó y no tiene grupos: **cero** |
| presente | presente | los cupos, con la edad de la medición más vieja |

#### `?include=schedules`

Agrega `section_schedules` a cada asignatura: sus grupos (solo `key` y `schedule`) con su
horario. Sale de lo guardado, sin tocar el SIA. Existe porque el choque de horario es una
pregunta sobre el catálogo entero, y sin esto haría falta un detalle por asignatura.

| `section_schedules` | Significa |
|---|---|
| ausente | nadie pidió el detalle: **no se sabe** |
| presente y vacío | no tiene grupos |
| presente con grupos | los grupos que **este** plan ve |

Un grupo sin horario viene con `schedule: []` y **no se omite**: omitirlo haría que un
cliente concluyera "todos los grupos chocan" sobre un conjunto incompleto.

### Detalle

| Ruta |
|---|
| `/v1/campuses/{campus}/programs/{program}/courses/{code}` |
| `…/courses/{code}/sections` |
| `…/courses/{code}/sections/{key}` |
| `…/courses/{code}/sections/{key}/seats` |

Las cuatro son **el mismo POST** al SIA visto de cuatro formas. Comparten fetch, cache y
cooldown.

Los grupos PEAMA de otra sede traen `site` y `site_campus`. Se exponen sin filtrar: si un
estudiante puede inscribirlos no está verificado ([ARCH.md](ARCH.md#lo-que-no-sabemos)).

`typology` sale de `course_program`: es relativa al plan de la ruta
([DATA-MODEL, decisión 1](DATA-MODEL.md)). La API expone el literal del listado
(`LIBRE ELECCIÓN (L)`), no el del detalle ([GOTCHAS §17](GOTCHAS.md)).

### Atajos sobre lo ya guardado

| Ruta | Qué hace |
|---|---|
| `/v1/campuses/{campus}/courses?q=` | busca por nombre en lo guardado. **Nunca va al SIA** |
| `/v1/campuses/{campus}/courses/{code}` | busca qué planes guardados ofrecen el código |

El atajo por código responde según cuántos planes guardados lo ofrecen:

| Planes | Respuesta |
|---|---|
| 0 | `404` con `hint` hacia la ruta canónica |
| 1 | el detalle, como la ruta canónica (puede ir al SIA) |
| varios | `300` con `candidates` |

**La búsqueda nunca va al SIA** porque su miss no está acotado. "No lo tengo" significa
"no está en los planes guardados", y resolverlo sería recorrer todos los demás: un barrido
completo disparado por un query string. Por eso declara su cobertura:

```json
{ "results": [ ... ], "coverage": { "programs_known": …, "programs_with_catalog": … } }
```

### Operación

| Ruta | Notas |
|---|---|
| `/v1/healthz` | el proceso vive |
| `/v1/status` | cobertura de la cache, **salud del camino al SIA** (fetches ok y fallidos, no-ops, POSTs, bytes, último fetch bueno) y última corrida de cada modo del `Refresher` |
| `/v1/version` | tag semver y commit del build |
| `/v1/openapi.yaml`, `/v1/docs` | el contrato y su Swagger UI, servidos desde el binario |

`healthz` solo dice que el proceso vive. Si el SIA está fallando, `status` lo muestra.

En `status`, `ended_reason` vale `done`, `deadline`, `signal`, `circuit_breaker` o
`error`. `deadline` y `signal` son normales: el barrido sigue donde quedó en la siguiente
corrida.

---

## Frescura

Un solo concepto: `?max_age=<segundos>`.

```
?max_age=0      fuerza la consulta al SIA
?max_age=N      sirve lo guardado si tiene menos de N segundos
(sin parámetro)  el default del recurso
```

| Recurso | Default | Marcador | Al vencer |
|---|---|---|---|
| Referencia (niveles, sedes, programas) | `FreshnessReference` | `reference_fetch.fetched_at` | sirve lo guardado y refresca por detrás |
| Catálogo | `FreshnessCatalog` | `program.catalog_fetched_at` | sirve lo guardado y refresca por detrás |
| Detalle (grupos y visibilidad del plan) | `FreshnessDetail` | `course_program.detail_fetched_at` | espera el SIA |
| Cupos | `FreshnessSeats` | `section.seats_checked_at` | espera el SIA |

Valores en [CONSTANTS.md](CONSTANTS.md).

- **Referencia y catálogo** existentes se responden al instante con `X-Cache: stale`, y el
  SIA se consulta por detrás. Solo esperan quien abre algo que nunca se trajo y quien manda
  `?max_age=0`. Si el refresco falla, se reintenta como mucho una vez cada `behindRetry`
  por recurso.
- **Detalle**: la visibilidad es por plan, así que un plan que nunca pidió la asignatura
  paga el POST aunque otro plan ya la tenga. Pero si el plan ya conoce sus grupos (dentro
  del default) y todos tienen cupos medidos dentro del `max_age` pedido, desde cualquier
  plan, la respuesta es `hit`.
- **Cupos**: un miss cuesta el detalle completo, porque los cupos nunca llegan solos. Se
  guarda todo y se responde solo lo pedido.

### Cooldown

Un `max_age` menor que `FETCH_COOLDOWN` sobre una asignatura traída hace menos de
`FETCH_COOLDOWN` responde `429 refresh_cooldown` con `Retry-After`. Sin esto, cualquier
cliente podría forzar el SIA en bucle.

### Carril de fondo

`?background=1` marca una lectura que no pidió una persona (un cliente que recorre un
catálogo para refrescar sus cupos). En el pool va por el **carril de fondo**, que ocupa
como mucho la mitad, y no cuenta como demanda. Una IP con más de `foregroundPerIP`
peticiones en vuelo también pasa al carril de fondo ([ARCH.md](ARCH.md#quién-va-al-carril-de-fondo)).

### Cabeceras

| Cabecera | Valor |
|---|---|
| `Age` | segundos desde el dato más viejo de la respuesta |
| `Cache-Control` | `max-age` efectivo del recurso |
| `X-Cache` | `hit` · `miss` · `stale` |
| `X-SIA-Fetch-Ms` | solo en `miss`: latencia del SIA |

`stale` tiene dos orígenes, y en los dos cada dato lleva su edad:

- en **referencia y catálogo**, lo normal pasado el TTL;
- en el **detalle**, el SIA falló y se sirvió lo guardado en vez de un `502`. Nunca con
  `max_age=0` (quien fuerza quiere un número nuevo o un error), ni cuando el SIA dice que
  la asignatura ya no está en el plan (ese `404` es la respuesta).

### Cupos: medido contra cambiado

Los cupos llevan la edad **en el body**: nunca se sirve un cupo sin decir de cuándo es.

```json
{ "key": "1", "number": 1, "available": 32, "measured_at": "2026-08-15T16:22:03Z",
  "age_seconds": 47, "changed_at": "2026-08-15T11:04:58Z" }
```

- `measured_at`, `age_seconds`: **cuándo se miró** este número.
- `changed_at`: **cuándo cambió** por última vez. Se omite si nunca se midió un cambio.

Son columnas distintas ([DATA-MODEL, decisión 4](DATA-MODEL.md)).

---

## Errores

```json
{ "error": "sia_noop", "message": "SIA returned an empty re-render" }
```

| Situación | Código | `error` |
|---|---|---|
| Programa, asignatura o grupo desconocido | `404` | `unknown_program` · `unknown_course` · `unknown_section` |
| Código ambiguo | `300` | `ambiguous_program` · `ambiguous_course` |
| Existe pero **sin grupos** | `200` | — (`"sections": []`) |
| El SIA devolvió un no-op, incluso tras sesión nueva | `502` | `sia_noop` |
| Sesión del SIA perdida | `502` | `sia_session_lost` |
| Pool ocupado hasta el timeout | `503` + `Retry-After` | `busy` |
| `max_age` inválido | `400` | `bad_request` |
| Refresco forzado antes del cooldown | `429` + `Retry-After` | `refresh_cooldown` |
| Límite de peticiones por IP | `429` + `Retry-After` | `rate_limit` |
| El cliente cerró la conexión | `499` | — |

- **`404` y `200` con `sections: []` no se colapsan.** Uno es "te equivocaste de código";
  el otro, "no se ofrece este periodo" ([GOTCHAS §18](GOTCHAS.md)).
- **Un no-op no es "sin resultados".** Es una cascada incompleta, una conexión atascada en
  la región de detalle o una sesión caducada ([GOTCHAS §6, §7, §20](GOTCHAS.md)). El pool
  reintenta con sesión nueva; si se repite, `502`.

---

## Fuera de alcance

| Cosa | Por qué |
|---|---|
| Escrituras | el SIA es de solo lectura para nosotros |
| Autenticación | catálogo público |
| Paginación | ni el SIA la tiene ([GOTCHAS §14](GOTCHAS.md)) |
| Prerrequisitos y componentes | llegan gratis en el detalle, pero no se guardan ([FIELDS.md](FIELDS.md)) |
| Alertas de cupo | `seat_snapshot` ya guarda el historial; la API no las ofrece |
