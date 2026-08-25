# Plan de implementación

Qué construir, en qué orden, y cómo saber que cada paso está bien. Sale de todo lo
verificado contra producción el **2026-08-15** (dos rondas de experimentos).

Este documento es operativo: se tacha y se actualiza mientras se codea. La
justificación de cada decisión vive en los otros documentos; aquí solo está el enlace.

| Documento | Para qué lo abres |
|---|---|
| [`GOTCHAS.md`](GOTCHAS.md) | **antes de escribir la primera línea.** Las trampas verificadas |
| [`PROTOCOL.md`](PROTOCOL.md) | cuerpos de petición reales |
| [`FIELDS.md`](FIELDS.md) | ids de componente, opciones, formatos del detalle |
| [`DATA-MODEL.md`](DATA-MODEL.md) | esquema y las nueve decisiones no obvias |
| [`API.md`](API.md) | contrato HTTP |
| [`ARCH.md`](ARCH.md) | pool, read-through, concurrencia |
| [`LAYOUT.md`](LAYOUT.md) | árbol de paquetes y librerías |
| [`bruno/sia-catalogo/`](../bruno/sia-catalogo/) | el canario: si esto falla, cambió el SIA |

---

## Punto de partida

- Ingeniería inversa **completa y verificada**.
- Alcance: **todas las sedes y todos los niveles**. Ambas listas se descubren de sus
  dropdowns (`soc1`, `soc9`) y se cachean; no hay sede ni nivel privilegiado en el
  código. La sede es un segmento obligatorio de la ruta: `/v1/campuses/{campus}/…`.
  El nivel tiene un default de producto (`pregrado`) y se cambia con `?level=`.
- Go 1.26.6, Postgres 18.6 (últimas estables verificadas, 2026-08-15).

---

## Decisiones ya cerradas

No se vuelven a discutir salvo que aparezca una medición nueva.

| Decisión | Por qué | Ref |
|---|---|---|
| Hexagonal: dominio + `Store` + `SIASource` | el dominio no importa gin/pgx/goquery | [ARCH](ARCH.md) |
| Read-through síncrono; `Refresher` a fase 2 | la cache se llena con el uso | [ARCH](ARCH.md) |
| REST, no GraphQL | el detalle es unitario: no hay dataloader posible | [API §Por qué REST](API.md) |
| Identidad de programa `(campus, faculty, code)` | `code` colisiona 136 veces de 852 | [G §26](GOTCHAS.md) |
| Identidad de grupo = token entre paréntesis | `Grupo N` pierde 10 de 88 grupos | [DM §8](DATA-MODEL.md) |
| `typology` en `course_program` | probado: 8 códigos divergen entre planes | [G §17](GOTCHAS.md) |
| `section` global + `section_program` visibilidad | los cupos son globales, los grupos visibles no | [G §16](GOTCHAS.md) |
| `seat_snapshot` append-only | habilita alertas sin rediseñar | [DM §4](DATA-MODEL.md) |
| Pool de **4**, mutex por **operación lógica** | hasta 80 en paralelo van bien; dentro de una conexión, no | [G §28](GOTCHAS.md) |
| Keepalive ≤3 min | muere a ~4.2 min, no a los 5 | [G §7](GOTCHAS.md) |
| `pt1:r1:<N>:cb4` con `N` leído de la respuesta | con `1` fijo se rompe en la 2.ª asignatura | [G §20](GOTCHAS.md) |

---

## Fase 0 — andamiaje (medio día)

1. `go mod init`, árbol de [`LAYOUT.md`](LAYOUT.md) con paquetes vacíos.
2. `docker-compose.yml` con Postgres 18. `Makefile`: `run`, `test`, `migrate`, `lint`.
3. `internal/config`: ~6 variables de entorno (`DATABASE_URL`, `PORT`, `SIA_POOL_SIZE`,
   `LOG_LEVEL`, `TEST_DATABASE_URL`).
4. El test de la invariante del hexágono, que debe pasar desde el día 1:

   ```
   go list -deps ./internal/catalog | grep -E 'gin-gonic|pgx|goquery|encoding/xml'  → vacío
   ```

**Hecho cuando:** `make test` pasa en verde con cero tests reales.

---

## Fase 0.5 — capturar fixtures (2 h, **antes de codear parsers**)

Con la colección Bruno, guardados en `internal/sia/testdata/`, fechados
(`listado_2026-08-15.xml`) y sin borrar los viejos. **Sin estos, los pasos 2 y 3 no se
pueden hacer sin red**, que es justo lo que los hace baratos.

| Fixture | Por qué es imprescindible |
|---|---|
| listado regular, 98 filas | el caso normal |
| listado de electivas, 240 filas | duplicados y comodín de sede |
| detalle con muchos grupos (`1000004-B`, 32) | parser de grupos |
| **detalle con grupos PEAMA** (`1000004-B`, `2015555`) | 5 grupos se llaman "Grupo 1" → [G §27](GOTCHAS.md) |
| **detalle con prerrequisitos** | bloque `Tipo M ¿Todas? [N]` |
| detalle con 0 grupos (`2027641`) | asignatura sin oferta |
| grupo sin horario (`Horarios/Aula: No informado`) | `section` sin `class_session` |
| **2.º detalle de la sesión** (`pt1:r1:2:cb4`) | la región numerada |
| respuesta no-op (~895 B) | detección de error |
| respuesta de sesión caducada (419 B **y** ~1.2 KB) | las dos firmas |
| **bootstrap con tabla ajena poblada** | que el parser la ignore |

---

## Fase 1 — la API

### Paso 1 · Esquema y migraciones · *sin red*

`migrations/00001_init.sql` tal cual [`DATA-MODEL.md`](DATA-MODEL.md), con los
dos cambios que costaron sangre: `UNIQUE (campus_code, faculty_code, code)` en `program`
y `UNIQUE (campus_code, code, term, key)` en `section`.

**Hecho cuando:** `goose up` y `goose down` funcionan, y este test pasa —

```
insertar 5 grupos con key '1','AMAZ-01','AMAZ-07','TUMA-01','CARI-01', todos number=1
→ 5 filas.   Con la clave vieja (term, number) → 1 fila.
```

### Paso 2 · Parser del listado · *sin red*

`sia/envelope.go` (XML → CDATA por id) y `sia/parse_list.go`.

Trampas: [§4](GOTCHAS.md) `_afrRK` re-leído siempre y **no empieza en 0** ·
[§5](GOTCHAS.md) contar `<tr>`, ignorar `_rowCount` · [§13](GOTCHAS.md) dedupe
por código · [§23](GOTCHAS.md) en la página completa cada `<tr>` sale 5 veces, así
que solo se parsea CDATA de respuestas parciales · goquery, nunca regex.

**Hecho cuando:** contra los fixtures da 98 y 240 filas, 215 códigos únicos en el de
electivas, y el bootstrap con tabla ajena devuelve **0 filas** en vez de 78.

### Paso 3 · Parser del detalle · *sin red*

`sia/parse_detail.go` y `sia/parse_schedule.go`. Texto plano y marcadores, no DOM.

Trampas: [§24](GOTCHAS.md) cabeceras PEAMA — el regex es
`\([^)\n]{1,20}\)[^\n]{0,60}?Grupo\s*\S+`, no `^\(\d+\)` · [§27](GOTCHAS.md) `key`
es el token entre paréntesis · [§17](GOTCHAS.md) `ELEGIBLES` ↔ `LIBRE ELECCIÓN (L)`
· [§18](GOTCHAS.md) 0 grupos es válido.

**Hecho cuando:** `1000004-B` da **32 grupos** (no 26), los 5 "Grupo 1" salen con `key`
distinto, `2027641` da 0 grupos sin error, y los prerrequisitos se extraen aunque
todavía no se guarden.

### Paso 4 · Navegación con estado · *con red*

`sia/conn.go`, `sia/cascade.go`, `sia/form.go`, `sia/noop.go`.

- UA que no parezca navegador ([§1](GOTCHAS.md)); `winnoloop` constante; cookiejar.
- Las **dos** cascadas: regular (5 pasos) y electivas (9, con `soc10` antes de `soc6`).
- `soc4=0` = *todas menos libre elección* ([§21](GOTCHAS.md)).
- `detailRegion int`, leído de `id="pt1:r1:(\d+):cb4"` ([§20](GOTCHAS.md)).
- `noop.go`: ~900 B, ~1.2 KB y 419 B. Los tres son error explícito, nunca "sin
  resultados".

**Hecho cuando:** un bucle de **98 detalles seguidos en una sola sesión** termina sin
atascos (referencia medida: 201 POSTs, ~99 s, 31 MB).

> Antes de empezar este paso, corre la colección Bruno. Si Bruno va y tu código no, el
> problema es tuyo.

### Paso 5 · Pool y concurrencia · *con red*

`sia/pool.go`, `sia/source.go`.

- Pool de 4 como `chan *SIAConn`; `select` con `ctx.Done()` → `503 busy` + `Retry-After`.
- **Mutex por conexión envolviendo la operación lógica** (cascada+`cb1`,
  detalle+`Volver`). Partirlo por POST reproduce [§28](GOTCHAS.md).
- Una goroutine de keepalive con ticker ≤3 min para todo el pool; recicla las muertas.
- Llenado en frío **escalonado**: el bootstrap llega a 4.5 MB, no 4 a la vez.
- Reusar la conexión ya parqueada: 2 POSTs en vez de 6.

**Hecho cuando:** un test dispara 8 peticiones concurrentes de programas distintos y
**cada una recibe su propio catálogo** (el test que hoy falla a mano: dos hilos sobre
una conexión sin mutex devuelven el mismo listado con `200 OK`).

### Paso 6 · Persistencia y read-through · *con red*

`store/*`, `catalog/service.go`, `catalog/freshness.go`.

- Upsert del catálogo de un programa en una transacción, **las dos mitades** (regular +
  libre elección).
- `singleflight` con clave `(program, code)` para detalle y `program` para catálogo.
- Write-behind con **`context.WithoutCancel`**: con el contexto de la request, gin lo
  cancela al volver el handler y la escritura se pierde en silencio.
- `detail_fetched_at` en `course_program`: un plan nuevo paga el POST otra vez aunque la
  asignatura ya esté ([DM §6](DATA-MODEL.md)).

**Hecho cuando:** dos peticiones simultáneas de la misma asignatura en frío hacen **1**
POST al SIA, y pedir la misma asignatura desde otro plan **sí** dispara otro.

### Paso 7 · API HTTP · *con red*

`httpapi/*` según [`API.md`](API.md).

- `gin.New()` (no `Default()`), `ShouldBindQuery` (no `BindQuery`), `gin.Context` nunca
  cruza a `internal/catalog`.
- `?max_age=`, cabeceras `Age` / `Cache-Control` / `X-Cache` / `X-SIA-Fetch-Ms`.
- `404` y `200 {"sections": []}` son casos **distintos** y no se colapsan.
- `/v1/campuses/{campus}/courses/{code}` ambiguo → `300` con candidatos.

**Hecho cuando:** `curl /v1/campuses/1101/programs/2A74/courses/2016696` devuelve el JSON del ejemplo
de `API.md`, con `X-Cache: miss` la primera vez y `hit` la segunda.

---

## Definición de "fase 1 hecha"

**Completa — verificado contra el SIA real y Postgres real, 2026-08-15.**

1. ✅ Catálogo y detalle de cualquier plan de pregrado de Bogotá, servidos como JSON.
   `ResolveProgram` camina facultad→programa en vivo si no está en cache
   (`FetchProgramDirectory`, 2-14 POSTs acotados).
2. ✅ Cupos con su edad, siempre. `age_seconds` va en el body de cada sección y de
   `.../seats`, nunca solo en cabeceras.
3. ✅ Cache que sobrevive al reinicio (Postgres) y no mezcla planes: `section_program`
   por programa, `course_program.detail_fetched_at` gobierna visibilidad.
4. ✅ 8 clientes concurrentes sin respuestas cruzadas — `TestLive_PoolConcurrency8DistinctPrograms`,
   8/8 catálogos distintos, `-race` limpio.
5. ✅ Los parsers pasan contra los fixtures, sin red — `internal/sia/testdata/`.

**Desviaciones conocidas del plan original**, documentadas en línea donde aplican:

- `?q=`/`?credits=`/`?typology=` en el `/courses` de un programa se filtran **en memoria**
  sobre el catálogo ya cacheado, no con `it11`/`it10` server-side. Correcto, pero no
  optimiza el payload de un miss filtrado en frío como describía `API.md`.
- Room/building del horario es *best-effort*: el SIA repite el código de sala sin
  delimitador estable. Ver el comentario de `buildingRe` en `sia/parse_schedule.go`.
- `noop_session_expired_mute_*` sigue siendo un fixture sintético — la firma muda
  (~1.2 KB) no se reprodujo; la explícita (419 B) sí, real. Ver
  [`OPEN-QUESTIONS.md §3`](OPEN-QUESTIONS.md).
- Prerrequisitos se extraen (`ParseDetail`) pero no se persisten, como ya preveía este
  documento. "Contenido de la asignatura" (componentes) no se parsea.

**Trampas nuevas encontradas construyendo esto**, añadidas a `GOTCHAS.md`:

- §29: `golang.org/x/net/html` baja `_afrRK` a minúsculas — `Attr("_afrRK")` falla en
  silencio, hay que leer `Attr("_afrrk")`.
- §30: reenviar un `valueChange` con el mismo valor no re-renderiza el dropdown
  dependiente — rompía el recorrido de facultades reutilizando una conexión.
- Bug propio (no del SIA): `cuposRe` estaba declarado y nunca usado — los cupos, el
  dato central de todo el proyecto, no se guardaban. Corregido antes de tocar `store`.

---

## Fase 2 — `Refresher` · **implementada (2026-08-17)**

> **Plan completo y criterios de aceptación: [`FASE-2.md`](FASE-2.md)**.

`internal/refresher` + `cmd/refresher`, consumiendo los mismos casos de uso que la API.
Cuatro modos (`reference`, `catalog`, `detail --scope=global|plan`, `seats --scope=hot`),
`errgroup` acotado al pool, limitador de tasa, presupuesto de reloj y `refresh_run`
para observabilidad. El checkpoint son los marcadores de frescura: reanudar es volver a
correr.

Medido el 2026-08-17 contra producción:

| Barrido | Resultado |
|---|---|
| `reference` | 27 directorios, 1380 entradas, **131 POSTs / 72 s**; segunda corrida **0 POSTs** |
| `catalog` (SEDE DE LA PAZ, 9 planes) | 468 asignaturas, 114 POSTs, 39 s con 2 workers |
| `detail --scope=global` | ~0.7 asignaturas/s/worker, **~87 KB por asignatura** con el filtro `it11` |
| `it11` en el listado | 232 KB → **17.8 KB** (13×) |
| `seats --scope=hot` | 5 asignaturas en 24 s; segundo barrido: **0 filas nuevas** en `seat_snapshot` |

Y destapó seis trampas que la API también tenía: [GOTCHAS §34–§39](GOTCHAS.md).

Después: alertas de cupo (el historial ya las soporta), prerrequisitos y componentes.

---

## Pendiente con fecha: **27/08/2026**

El único experimento que no se puede adelantar. Hoy los cupos no se mueven (medido: 0
cambios en 347 grupos en 35 min de pre-inscripción), así que el TTL de 5 min de
`API.md` está inventado.

**Cuando abran las inscripciones:** muestrear el mismo plan cada 15 min durante las
primeras horas. Ese número fija el TTL de cupos y decide si el polling de fase 2 tiene
sentido. El arnés ya está probado; ver [`OPEN-QUESTIONS.md §2`](OPEN-QUESTIONS.md).

---

## Riesgos

| Riesgo | Cómo se detecta | Qué hacer |
|---|---|---|
| La UNAL repinta la página y cambian los ids ADF | la colección Bruno deja de pasar | re-mapear con `FIELDS.md` |
| Una consulta llega a 1000 filas | aserción: exactamente 1000 = sospecha de truncamiento | investigar paginado (hoy no existe) |
| `course.code` resulta no ser único entre sedes | al abrir a Medellín | la PK ya es `(campus_code, code)`; no hay migración |
| Datos plausibles pero equivocados | es el fallo de este dominio, no da síntoma | los tres criterios de aceptación de los pasos 2, 4 y 5 existen para eso |

---

## Lo que **no** se hace en fase 1

Escrituras · autenticación · paginación · detección de choques de horario · alertas ·
sedes distintas de Bogotá · prerrequisitos y componentes (se parsean, no se guardan).
