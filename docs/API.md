# API

Contrato HTTP del puente. Los endpoints y campos van en inglés; esta documentación en
español.

Base: `/v1`. Todo JSON, `UTF-8`.

> **La forma exacta la define [`../internal/httpapi/openapi.yaml`](../internal/httpapi/openapi.yaml)**
> — OpenAPI 3.1, embebido en el binario y servido en `/v1/docs`, así que la instancia
> que corre siempre describe su propia versión. Este documento explica el **porqué** de
> cada decisión (qué identifica un recurso, cómo se mide la frescura, qué significa cada
> error) y no repite los esquemas: donde los dos discrepen, manda el YAML.

---

## Por qué REST

No es la opción por defecto sin pensar. Las otras dos pelean contra el backend real.

**GraphQL** vende "pide exactamente lo que necesitas en un round-trip". Acá eso es un
arma cargada apuntando al pool:

```graphql
{ program(code:"2A74") { courses { sections { seats } } } }   # 196 POSTs, ~99 s
```

El detalle es **irreductiblemente unitario** — 1 POST por asignatura, y no hay forma de
traer los grupos de varias en una petición ([DATA-MODEL §5](DATA-MODEL.md)). El truco
normal contra N+1 (dataloader → batch) no existe. Con REST el costo está en la URL:
`/programs/2A74/courses` es 1 POST, siempre. Con GraphQL lo elige el cliente y no se ve
venir hasta que el pool está saturado.

Segundo: el diseño entero es frescura con granularidad distinta
(`catalog_fetched_at` / `detail_fetched_at` / `measured_at`). GraphQL es un solo POST →
cero cache HTTP, y habría que reinventar `Age` y `Cache-Control` dentro del body.

**gRPC** no aporta: el consumidor es browser o script, la latencia es del SIA y no del
transporte, y se perdería poder comparar contra la colección Bruno con `curl`. Tendría
sentido más adelante entre `Refresher` y el core, no en el borde.

---

## Identificadores

Los índices que usa el SIA (`0-2-8-3`) son **posiciones dentro de un dropdown** y no
aparecen jamás en una URL. El ID público es el código institucional. Ver
[DATA-MODEL, decisión 7](DATA-MODEL.md).

| Entidad | ID en la URL | Ejemplo |
|---|---|---|
| `level` | slug | `pregrado`, `doctorado`, `posgrado` |
| `campus` | código institucional | `1101` |
| `faculty` | código institucional | `2055` |
| `program` | código institucional | `2A74` |
| `course` | `code` | `2016696`, `1000003-B` |
| `section` | `key` + `?term=` | `1`, `AMAZ-07`, `?term=2026-2` |

**Ni `program` ni `section` identifican por sí solos fuera de una sede.** Medido sobre
el censo completo: `program.code` se repite en 136 de 852 casos (PEAMA reexpone el mismo
código en varias sedes, [GOTCHAS §26](GOTCHAS.md)), y el número de grupo se repite
dentro de la misma asignatura (`(1) Grupo 1` y `(TUMA-01) … Grupo 1`,
[DATA-MODEL, decisión 8](DATA-MODEL.md)).

Por eso el `section` se direcciona con `key` —el token entre paréntesis, verbatim— y no
con `number`. **La sede va en la ruta, no en un query param.** `/v1/campuses/{campus}/…` para todo lo
que cuelgue de una sede. Es un dato obligatorio y el contrato lo trata como tal: no hay
default, no hay forma de omitirlo, y no existe una URL que signifique "cualquier sede".

Eso resuelve la colisión entre sedes. Queda la de dentro de una sede —**46 códigos se
repiten entre facultades**— que se desempata con `?faculty=`; si no se pasa y hay varios
candidatos se devuelve `300` con la lista, como el atajo de `course`.

Medido: `2515` (FARMACIA) sale en Bogotá, Medellín y Amazonia; y **dentro de Medellín**
sale dos veces, bajo `3050` y bajo el comodín de sede. Por eso fijar la sede en la ruta
no siempre basta, y el `hint` de la respuesta pide `?faculty=`.

`class_session` y `seat_snapshot` no son direccionables: viajan siempre dentro de su
`section`.

Nunca en una URL: `program_idx`, `campus_idx`, `faculty_idx`, `program.id`,
`section.id`, `_afrRK`.

---

## La ruta canónica cuelga del programa

```
/v1/campuses/{campus}/programs/{program}/courses/{code}
```

No es decoración. Los grupos visibles son un **subconjunto estricto por programa**
(Sistemas 25, Industrial 23 — [GOTCHAS §16](GOTCHAS.md)), así que *"los grupos de
`1000004-B`"* es una pregunta mal formulada. La bien formulada incluye el plan.

Y en frío es la única resoluble: la cascada `(level, campus, faculty, program)` ya está
en la URL, así que nunca se cae en el no-op silencioso de ~900 B por cascada incompleta
([GOTCHAS §6](GOTCHAS.md)).

El programa fija la sede, por eso `campus_code` no es un segmento de ruta aunque sí sea
parte de la PK de `course`.

---

## Endpoints

### Referencia

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/v1/levels` | los niveles de `soc1`; cacheados, no fijos en código |
| `GET` | `/v1/campuses` | las sedes de `soc9`; cacheadas, no fijas en código |
| `GET` | `/v1/campuses/{campus}/faculties` | |
| `GET` | `/v1/campuses/{campus}/programs?faculty=2055` | `faculty` es filtro opcional |
| `GET` | `/v1/campuses/{campus}/programs/{program}` | incluye `catalog_fetched_at`. `?faculty=` desempata la colisión intra-sede |

Se sirven del Store. Un miss aquí **sí** dispara la cascada: es barata (parte del
bootstrap que hay que hacer igual) y acotada.

### Catálogo — granularidad programa

| Método | Ruta |
|---|---|
| `GET` | `/v1/campuses/{campus}/programs/{program}/courses` |

Filtros: `?q=` (nombre), `?credits=`, `?typology=`. Extra: `?include=schedules`.

`?typology=` no es un filtro más: en el SIA es `soc4`, y el valor *libre elección* no
filtra el listado sino que **conmuta a otro buscador** de 9 pasos, por sede y no por
plan ([PROTOCOL §5](PROTOCOL.md)). En la API se ve igual; por dentro son 4 POSTs más y
otro conjunto de resultados.

`q` mapea al filtro `it11` del SIA, que filtra **en el servidor**: substring,
insensible a acentos, y baja el payload de 241 KB a 15–27 KB
([GOTCHAS §19](GOTCHAS.md)). `credits` mapea a `it10`.

Un miss trae ~98 asignaturas en 1 POST. Con `?q=` el miss trae solo las que casan, así
que **no marca el catálogo del programa como completo**: `catalog_fetched_at` solo se
sella en el fetch sin filtro.

Y "sin filtro" son **dos POSTs, no uno**. El listado por plan corre con `soc4=0`, que en
el SIA significa literalmente `TODAS MENOS  LIBRE ELECCIÓN`
([GOTCHAS §21](GOTCHAS.md)): las asignaturas de libre elección del plan no salen ahí,
sino por el buscador de electivas, que es **por sede** y devuelve entre 233 y 644 filas
según la sede y el plan de origen. `catalog_fetched_at` se sella cuando están las dos
mitades; si no, la respuesta es plausible y le falta el trozo que más se consulta.

Cada asignatura del listado trae los cupos que **ya** están guardados (`seats`) y el
sello `detail_fetched_at`, que es cuándo ese plan pidió su detalle por última vez.
Ninguno de los dos dispara nada: salen del Store tal cual.

Los dos juntos son los que dejan responder sin mentir, porque `seats` puede faltar por
dos motivos distintos:

| `detail_fetched_at` | `seats` | Significa |
|---|---|---|
| ausente | ausente | nadie preguntó todavía — **no sé** |
| presente | ausente | se preguntó y la asignatura no tiene grupos — **cero** |
| presente | presente | los cupos, con la edad de la medición más vieja |

Sin el sello, un catálogo recién traído y una asignatura sin oferta se ven idénticos, y
el cliente termina pintando un guion en los dos casos.

#### `?include=schedules`

Agrega `section_schedules` a cada asignatura: sus grupos con el horario de cada uno.
Sale del Store igual que `seats` — **no dispara nada contra el SIA** ni sella el
catálogo como completo.

Existe porque el listado no trae horarios y el choque de horario es una pregunta sobre
el catálogo ENTERO. Sin esto, un cliente que quiera marcar "a esta asignatura ya no le
sirve ningún grupo" necesita el detalle asignatura por asignatura: medidas **200
peticiones** para un plan de Bogotá (313 asignaturas, 200 con detalle pedido), ~30 s de
goteo. Acá son **~44 KB** sobre los 358 KB que la respuesta ya pesa, en la petición que
el cliente hace igual. Es opcional porque solo lo necesita quien ya tenga un horario
armado contra el que chocar.

Es la forma REDUCIDA del grupo —`key` y `schedule`, nada más— y por eso no se llama
`sections`: el detalle sirve grupos completos bajo ese nombre (instructor, aula, cupos,
fechas), y reusar la palabra para dos formas distintas es la clase de ambigüedad que
esta API no tiene en ningún otro sitio.

La misma tabla de arriba aplica, con la misma razón:

| `section_schedules` | Significa |
|---|---|
| ausente | nadie pidió el detalle todavía — **no sé** |
| presente y vacío | se pidió y la asignatura no tiene grupos — **cero** |
| presente con grupos | los grupos que ESTE plan ve, con su horario |

Un grupo que no informa horario viene con `schedule: []`, nunca `null`, y **no se
omite**. Omitirlo haría que un cliente concluyera "todos los grupos chocan" sobre un
conjunto más chico que el real — un fallo silencioso, que es exactamente lo que el
resto de este contrato se cuida de no producir.

### Detalle — granularidad asignatura

| Método | Ruta |
|---|---|
| `GET` | `/v1/campuses/{campus}/programs/{program}/courses/{code}` |
| `GET` | `/v1/campuses/{campus}/programs/{program}/courses/{code}/sections` |
| `GET` | `/v1/campuses/{campus}/programs/{program}/courses/{code}/sections/{key}` |
| `GET` | `/v1/campuses/{campus}/programs/{program}/courses/{code}/sections/{key}/seats` |

`?term=` opcional; default el periodo vigente. Hoy el SIA solo expone el vigente — el
parámetro está en el contrato para no romperlo cuando haya histórico.

Los cupos son **globales**, no dependen del plan ([GOTCHAS §16](GOTCHAS.md)). Aun así
`seats` cuelga del programa: es la única ruta que resuelve en frío, y el `code` pelado
no está verificado como único entre sedes.

### Atajos sobre lo ya cacheado

| Método | Ruta | Miss → SIA |
|---|---|---|
| `GET` | `/v1/campuses/{campus}/courses/{code}` | no |
| `GET` | `/v1/campuses/{campus}/courses?q=&credits=&typology=` | **no** |

`/v1/campuses/{campus}/courses/{code}` resuelve el programa vía `course_program`:

| Coincidencias | Respuesta |
|---|---|
| 1 | `200` |
| N | `300` con `candidates` |
| 0 | `404` con `hint` |

`300 Multiple Choices` es literalmente el caso: hay varias representaciones y el cliente
elige. Quien no quiera manejarlo, usa la ruta canónica.

### Operación

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/v1/healthz` | liveness |
| `GET` | `/v1/status` | cobertura de la cache, estado de conexiones vivas y **última corrida del `Refresher`** |
| `GET` | `/v1/version` | tag semver y commit del build corriendo (`{"version","commit"}`) — ver `docs/COMMANDS.md` |
| `GET` | `/v1/openapi.yaml` | el contrato, embebido en el binario |
| `GET` | `/v1/docs` | Swagger UI sobre ese contrato (con sus estáticos bajo `/v1/docs/`) |

Los dos últimos se sirven desde el propio binario, sin CDN ni red: una instancia
aislada documenta su versión sin depender de nada externo.

---

## Read-through

Si no está en Postgres o está viejo → se consulta al SIA, se responde al cliente, se
persiste. En ese orden.

| Endpoint | Miss → SIA | Qué trae el miss |
|---|---|---|
| `/levels`, `/campuses` | solo si falta o pasó de 30 d | 1 POST → el dropdown entero |
| `/campuses/{c}/programs`, `/campuses/{c}/faculties` | solo si falta o pasó de 30 d | ~15 POSTs → **todas** las facultades y sus programas |
| `/campuses/{c}/programs/{p}/courses` | sí | 1 POST → ~98 asignaturas |
| `/campuses/{c}/programs/{p}/courses/{code}` | sí | 1 POST → esa asignatura con sus grupos |
| `…/courses/{code}/sections[/{n}]` | sí | igual |
| `.../sections/{n}/seats` | solo si el snapshot pasó de 5 min | igual: refresca y guarda el grupo entero, responde solo los cupos |
| `/campuses/{c}/courses/{code}` | **no** | — |
| `/campuses/{c}/courses?q=` | **no** | — |

### Por qué la búsqueda global no dispara al SIA

Parece que contradice el read-through. No.

Los endpoints de identidad tienen un **miss acotado**: se sabe exactamente qué POST
hacer y cuánto cuesta. `/courses?q=algoritmos` no. Un miss ahí significa *"no lo tengo
en los 3 programas cacheados"*, y resolverlo es recorrer los 62 restantes — el crawl
inicial de [ARCH.md](ARCH.md), horas de POSTs, disparado por un query string. Eso no
es read-through, es un DoS con `GET`.

Ese endpoint sirve solo del Store y **declara su cobertura**:

```json
{
  "results": [ ... ],
  "coverage": { "programs_known": 287, "programs_with_catalog": 3 }
}
```

El `Refresher` (fase 2) hace crecer esa cobertura sola, sin cambiar el contrato, y
`/v1/status` cuenta lo que hizo — sin eso, "la cobertura crece sola" es una afirmación que
nadie puede comprobar:

```json
{
  "programs_known": 1408,
  "programs_with_catalog": 49,
  "refresh": {
    "reference": { "mode": "reference", "started_at": "...", "finished_at": "...",
                   "programs_ok": 27, "programs_failed": 0, "programs_skipped": 0,
                   "courses_ok": 1380, "posts": 131, "bytes": 41000000,
                   "ended_reason": "done" },
    "detail":    { "mode": "detail", "scope": "global", "ended_reason": "deadline", "...": "..." }
  }
}
```

`ended_reason` es `done` · `deadline` · `signal` · `circuit_breaker` · `error`. Los dos
primeros son normales: un barrido cortado por su presupuesto de reloj reanuda solo, porque
el checkpoint son los marcadores de frescura. `circuit_breaker` es el que hay que mirar.

---

## Frescura

Un solo concepto para toda la API: `?max_age=<segundos>`.

```
?max_age=0      fuerza consulta al SIA
?max_age=300    sirve de cache si tiene menos de 5 min
(sin parámetro)  default por tipo de recurso
```

Defaults iniciales, a calibrar con uso real:

| Recurso | Default | Gobernado por |
|---|---|---|
| referencia (sedes, facultades, programas) | 30 d | — |
| catálogo | 7 d | `program.catalog_fetched_at` |
| detalle: grupos, horario, profesor | 24 h | `section.fetched_at` |
| detalle: visibilidad por plan | 24 h | `course_program.detail_fetched_at` |
| cupos | 5 min | `section.seats_checked_at` |

El default de cupos es el único elegido a ojo: hoy no se mueven (medido, 0 cambios en
347 grupos a lo largo de 35 min en pre-inscripción). El ritmo real solo se puede medir
cuando abran las inscripciones el 27/08 ([OPEN-QUESTIONS §2](OPEN-QUESTIONS.md)), y es
ese número el que debe fijar este TTL.

Esto reemplaza al `GET /courses/{code}/seats` "en vivo" que proponía
[ARCH.md](ARCH.md). Mismo comportamiento con `?max_age=0`, pero un `GET` que escribe
y tarda 10 s deja de ser indistinguible por fuera de uno cacheado.

### Un hit de detalle es por `(code, program)`

El detalle cacheado tiene dos capas con validez distinta
([DATA-MODEL, decisión 6](DATA-MODEL.md)):

| Capa | Válida para |
|---|---|
| filas de `section` — profesor, horario, aula, cupos | todos los programas |
| `section_program` — qué grupos ve este plan | solo los planes ya consultados |

Si Sistemas trajo `1000004-B` hace 30 s y ahora pregunta Industrial, **se hace el POST
igual**: están todos los grupos que Industrial *podría* ver, pero no cuáles. Servir los
25 en vez de los 23 es el fallo silencioso que este proyecto existe para evitar.

Compensación: los cupos de ese POST son frescos para todos los planes.

### Cabeceras

| Cabecera | Valor |
|---|---|
| `Age` | segundos desde que se midió el dato más viejo de la respuesta |
| `Cache-Control` | `max-age` efectivo del recurso |
| `X-Cache` | `hit` · `miss` · `stale` |
| `X-SIA-Fetch-Ms` | solo en `miss`; latencia del SIA |

Los cupos además llevan la edad **en el body**, porque nunca se sirve un cupo sin decir
de cuándo es:

```json
{ "key": "1", "number": 1, "available": 32, "measured_at": "2026-08-15T16:22:03Z",
  "age_seconds": 47, "changed_at": "2026-08-15T11:04:58Z" }
```

`measured_at` y `age_seconds` conservan su significado — *de cuándo es este número* — y
`changed_at` es información nueva: **cuándo cambió por última vez**. Son dos preguntas
distintas y el esquema las separa (`section.seats_checked_at` contra
`max(seat_snapshot.measured_at)`), porque `seat_snapshot` solo crece cuando el número
cambia: medido, 0 cambios en 347 grupos a lo largo de 35 min, así que insertar en cada
medición serían millones de filas para almacenar una recta. `changed_at` se omite si nunca
se ha medido un cambio.

---

## Respuestas

`GET /v1/campuses/1101/programs/2A74/courses/2016696`

```json
{
  "campus_code": "1101",
  "code": "2016696",
  "name": "Algoritmos",
  "credits": 3,
  "typology": "FUND. OBLIGATORIA (B)",
  "description": "...",
  "fetched_at": "2026-08-15T16:20:00Z",
  "sections": [
    {
      "term": "2026-2",
      "key": "1",
      "number": 1,
      "label": "Grupo 1",
      "instructor": "...",
      "shift": "DIURNO",
      "duration": "Semestral",
      "start_date": "2026-08-27",
      "end_date": "2026-12-17",
      "fetched_at": "2026-08-15T16:22:03Z",
      "schedule": [
        {
          "weekday": 3,
          "start_time": "09:00",
          "end_time": "11:00",
          "room": "SALA DE INFORMATICA 453-203",
          "building": "453 - Guillermina Uribe Bone"
        }
      ],
      "seats": {
        "available": 32,
        "measured_at": "2026-08-15T16:22:03Z",
        "age_seconds": 47,
        "changed_at": "2026-08-15T11:04:58Z"
      }
    }
  ]
}
```

`typology` sale de `course_program`: es relativa al plan de la ruta, no de la
asignatura ([DATA-MODEL, decisión 1](DATA-MODEL.md)). Probado, no supuesto: `1000003-B`
es `FUND. OBLIGATORIA (B)` en Ingeniería Agrícola y `FUND. OPTATIVA (O)` en Biología.

`key` es la identidad del grupo dentro de la asignatura; `number` es lo que el
estudiante lee. Un grupo PEAMA trae además `site` y `site_campus`:

```json
{ "key": "TUMA-01", "number": 1, "site": "TUMA", "site_campus": "SEDE TUMACO" }
```

Salen en el detalle consultado desde Bogotá y son ~20 % de los grupos
([GOTCHAS §24](GOTCHAS.md)). Se imparten en otra sede, con **su propio calendario**
(`24/08/2026` frente al `27/08/2026` de Bogotá) y aulas de allá. Si un estudiante de
Bogotá puede o no inscribirlos **no está verificado** — el catálogo no lo dice
([OPEN-QUESTIONS](OPEN-QUESTIONS.md)). Por eso se exponen con `site` marcado en vez de
filtrarlos: el cliente decide, y no se inventa una regla que no medimos.

El SIA usa dos vocabularios para lo mismo — el listado dice `LIBRE ELECCIÓN (L)`, el
detalle dice `ELEGIBLES` ([GOTCHAS §17](GOTCHAS.md)). La API expone el literal del
listado y guarda el crudo aparte.

`weekday`: 1 = lunes … 7 = domingo.

---

## Errores

```json
{ "error": "sia_noop", "message": "SIA returned an empty re-render" }
```

| Situación | Código | `error` |
|---|---|---|
| Asignatura desconocida | `404` | `unknown_course` |
| Programa desconocido | `404` | `unknown_program` |
| Código ambiguo en el atajo plano | `300` | `ambiguous_course` |
| Existe pero **0 grupos** | `200` | — (`"sections": []`) |
| SIA devuelve ~900 B o ~1.2 KB | `502` | `sia_noop` |
| Sesión caducada tras N reintentos | `502` | `sia_session_lost` |
| Pool ocupado / timeout | `503` + `Retry-After` | `busy` |
| `max_age` inválido | `400` | `bad_request` |
| Refresh forzado antes del cooldown (mismo curso) | `429` + `Retry-After` | `refresh_cooldown` |
| Límite de requests por IP superado (cualquier endpoint) | `429` + `Retry-After` | `rate_limit` |

**El `404` y el `200` con `sections: []` son casos distintos y no se pueden colapsar.**
`2027641` existe en el catálogo y no tiene oferta este periodo
([GOTCHAS §18](GOTCHAS.md)). Si se responden igual, el cliente no puede distinguir
*"te equivocaste de código"* de *"no la están ofreciendo"*.

Una respuesta de ~900 B del SIA **no es un error HTTP**: es un no-op silencioso. Falta
un paso de la cascada, la conexión quedó en la región de detalle —posiblemente con el
`cb4` apuntando a un índice viejo ([GOTCHAS §20](GOTCHAS.md))—, o caducó la sesión
([GOTCHAS §6](GOTCHAS.md), [§10](GOTCHAS.md)). Se trata como error explícito, nunca
como "sin resultados".

La sesión recién caducada devuelve **~1.2 KB**, no el mensaje de 419 B: mismo no-op mudo
([GOTCHAS §7](GOTCHAS.md)). Antes de dar `sia_noop`, el pool reintenta con sesión nueva;
si vuelve a pasar, entonces sí es `502`.

---

## Lo que el contrato asume de la implementación

**Singleflight por clave de fetch.** Tres clientes pidiendo `2016696` en frío = 1 POST,
no 3 encolados. Sin esto, el pool de 4 conexiones secuenciales se vuelve una cola de
10 s × N. La clave es `(program, code)` para el detalle y `program` para el catálogo.

**Miss frío síncrono.** El cliente espera. Feo pero honesto, y con los números medidos
(~1.3 s caliente; el frío sin sesión es 3-10 s y lo domina un bootstrap muy variable,
[GOTCHAS §25](GOTCHAS.md)) es aceptable para fase 1. Si molesta, la salida
REST-limpia es `202` + `Location: /v1/jobs/{id}` — pero eso se decide con números de uso
real, no antes.

**El pool lleva el estado.** Cada conexión está parqueada en un programa y está en la
región del buscador o en la del detalle. La API no lo expone (salvo en `/status`), pero
la latencia de cada endpoint depende de dónde esté la conexión
([ARCH.md](ARCH.md)).

---

## Fuera de alcance en fase 1

| Cosa | Por qué |
|---|---|
| Escrituras | el SIA es de solo lectura para nosotros |
| Autenticación | catálogo público, uso personal |
| Paginación | ~98 filas por programa, 644 en la consulta más grande medida; y aguas arriba **no existe**: `viewportSize`/`rows` no tienen efecto ([GOTCHAS §14](GOTCHAS.md)) |
| Detección de choques de horario | endpoint aparte, cuando haya datos suficientes |
| Alertas de cupo | `seat_snapshot` ya las soporta; la API no todavía |
| Prerrequisitos y componentes | llegan **gratis** en el mismo POST del detalle (22 de 36 asignaturas traen prerrequisitos) pero no están en el esquema; añadirlos es parser + tabla, cero red ([FIELDS.md](FIELDS.md)) |
| Sedes distintas de Bogotá | el esquema las aguanta, pero los IDs públicos hay que calificarlos antes (ver *Identificadores*) |
