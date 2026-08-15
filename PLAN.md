# Plan de implementación

Qué construir, en qué orden, y cómo saber que cada paso está bien. Sale de todo lo
verificado contra producción el **2026-08-15** (dos rondas de experimentos).

Este documento es operativo: se tacha y se actualiza mientras se codea. La
justificación de cada decisión vive en los otros documentos; aquí solo está el enlace.

| Documento | Para qué lo abres |
|---|---|
| [`docs/GOTCHAS.md`](docs/GOTCHAS.md) | **antes de escribir la primera línea.** 28 trampas |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | cuerpos de petición reales |
| [`docs/FIELDS.md`](docs/FIELDS.md) | ids de componente, opciones, formatos del detalle |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | esquema y las 8 decisiones no obvias |
| [`docs/API.md`](docs/API.md) | contrato HTTP |
| [`ARCH.md`](ARCH.md) | pool, read-through, concurrencia |
| [`docs/LAYOUT.md`](docs/LAYOUT.md) | árbol de paquetes y librerías |
| [`bruno/sia-catalogo/`](bruno/sia-catalogo/) | el canario: si esto falla, cambió el SIA |

---

## Punto de partida

- Ingeniería inversa **completa y verificada**. Sin código todavía.
- Alcance de fase 1: **Bogotá (`campus=2`), pregrado (`level=0`)**.
- Go 1.26.6, Postgres 18.6 (últimas estables verificadas, 2026-08-15).

---

## Decisiones ya cerradas

No se vuelven a discutir salvo que aparezca una medición nueva.

| Decisión | Por qué | Ref |
|---|---|---|
| Hexagonal: dominio + `Store` + `SIASource` | el dominio no importa gin/pgx/goquery | [ARCH](ARCH.md) |
| Read-through síncrono; `Refresher` a fase 2 | la cache se llena con el uso | [ARCH](ARCH.md) |
| REST, no GraphQL | el detalle es unitario: no hay dataloader posible | [API §Por qué REST](docs/API.md) |
| Identidad de programa `(campus, faculty, code)` | `code` colisiona 136 veces de 852 | [G §26](docs/GOTCHAS.md) |
| Identidad de grupo = token entre paréntesis | `Grupo N` pierde 10 de 88 grupos | [DM §8](docs/DATA-MODEL.md) |
| `typology` en `course_program` | probado: 8 códigos divergen entre planes | [G §17](docs/GOTCHAS.md) |
| `section` global + `section_program` visibilidad | los cupos son globales, los grupos visibles no | [G §16](docs/GOTCHAS.md) |
| `seat_snapshot` append-only | habilita alertas sin rediseñar | [DM §4](docs/DATA-MODEL.md) |
| Pool de **4**, mutex por **operación lógica** | 8 en paralelo van bien; dentro de una conexión, no | [G §28](docs/GOTCHAS.md) |
| Keepalive ≤3 min | muere a ~4.2 min, no a los 5 | [G §7](docs/GOTCHAS.md) |
| `pt1:r1:<N>:cb4` con `N` leído de la respuesta | con `1` fijo se rompe en la 2.ª asignatura | [G §20](docs/GOTCHAS.md) |

---

## Fase 0 — andamiaje (medio día)

1. `go mod init`, árbol de [`docs/LAYOUT.md`](docs/LAYOUT.md) con paquetes vacíos.
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
| **detalle con grupos PEAMA** (`1000004-B`, `2015555`) | 5 grupos se llaman "Grupo 1" → [G §27](docs/GOTCHAS.md) |
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

`migrations/00001_init.sql` tal cual [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md), con los
dos cambios que costaron sangre: `UNIQUE (campus_code, faculty_code, code)` en `program`
y `UNIQUE (campus_code, code, term, key)` en `section`.

**Hecho cuando:** `goose up` y `goose down` funcionan, y este test pasa —

```
insertar 5 grupos con key '1','AMAZ-01','AMAZ-07','TUMA-01','CARI-01', todos number=1
→ 5 filas.   Con la clave vieja (term, number) → 1 fila.
```

### Paso 2 · Parser del listado · *sin red*

`sia/envelope.go` (XML → CDATA por id) y `sia/parse_list.go`.

Trampas: [§4](docs/GOTCHAS.md) `_afrRK` re-leído siempre y **no empieza en 0** ·
[§5](docs/GOTCHAS.md) contar `<tr>`, ignorar `_rowCount` · [§13](docs/GOTCHAS.md) dedupe
por código · [§23](docs/GOTCHAS.md) en la página completa cada `<tr>` sale 5 veces, así
que solo se parsea CDATA de respuestas parciales · goquery, nunca regex.

**Hecho cuando:** contra los fixtures da 98 y 240 filas, 215 códigos únicos en el de
electivas, y el bootstrap con tabla ajena devuelve **0 filas** en vez de 78.

### Paso 3 · Parser del detalle · *sin red*

`sia/parse_detail.go` y `sia/parse_schedule.go`. Texto plano y marcadores, no DOM.

Trampas: [§24](docs/GOTCHAS.md) cabeceras PEAMA — el regex es
`\([^)\n]{1,20}\)[^\n]{0,60}?Grupo\s*\S+`, no `^\(\d+\)` · [§27](docs/GOTCHAS.md) `key`
es el token entre paréntesis · [§17](docs/GOTCHAS.md) `ELEGIBLES` ↔ `LIBRE ELECCIÓN (L)`
· [§18](docs/GOTCHAS.md) 0 grupos es válido.

**Hecho cuando:** `1000004-B` da **32 grupos** (no 26), los 5 "Grupo 1" salen con `key`
distinto, `2027641` da 0 grupos sin error, y los prerrequisitos se extraen aunque
todavía no se guarden.

### Paso 4 · Navegación con estado · *con red*

`sia/conn.go`, `sia/cascade.go`, `sia/form.go`, `sia/noop.go`.

- UA que no parezca navegador ([§1](docs/GOTCHAS.md)); `winnoloop` constante; cookiejar.
- Las **dos** cascadas: regular (5 pasos) y electivas (9, con `soc10` antes de `soc6`).
- `soc4=0` = *todas menos libre elección* ([§21](docs/GOTCHAS.md)).
- `detailRegion int`, leído de `id="pt1:r1:(\d+):cb4"` ([§20](docs/GOTCHAS.md)).
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
  detalle+`Volver`). Partirlo por POST reproduce [§28](docs/GOTCHAS.md).
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
  asignatura ya esté ([DM §6](docs/DATA-MODEL.md)).

**Hecho cuando:** dos peticiones simultáneas de la misma asignatura en frío hacen **1**
POST al SIA, y pedir la misma asignatura desde otro plan **sí** dispara otro.

### Paso 7 · API HTTP · *con red*

`httpapi/*` según [`docs/API.md`](docs/API.md).

- `gin.New()` (no `Default()`), `ShouldBindQuery` (no `BindQuery`), `gin.Context` nunca
  cruza a `internal/catalog`.
- `?max_age=`, cabeceras `Age` / `Cache-Control` / `X-Cache` / `X-SIA-Fetch-Ms`.
- `404` y `200 {"sections": []}` son casos **distintos** y no se colapsan.
- `/v1/courses/{code}` ambiguo → `300` con candidatos.

**Hecho cuando:** `curl /v1/programs/2A74/courses/2016696` devuelve el JSON del ejemplo
de `API.md`, con `X-Cache: miss` la primera vez y `hit` la segunda.

---

## Definición de "fase 1 hecha"

1. Catálogo y detalle de cualquier plan de pregrado de Bogotá, servidos como JSON.
2. Cupos con su edad, siempre.
3. Cache que sobrevive al reinicio y no sirve datos de un plan como si fueran de otro.
4. 8 clientes concurrentes sin respuestas cruzadas.
5. Los parsers pasan contra los 11 fixtures, sin red.

---

## Fase 2 — `Refresher` (esbozo)

- `internal/refresher` + `cmd/refresher`, consumiendo los mismos puertos.
- Dimensionado: **1380 entradas de programa**, 852 códigos. Una carrera con detalle son
  201 POSTs / 99 s / 31 MB → el crawl completo es **30-40 h**.
- `errgroup` acotado al tamaño del pool + rate limiter + checkpoint por programa
  (resumible). El límite es la cortesía con la UNAL: 4 conexiones crawleando son
  ~120 MB/min contra un servidor público.
- Después: otras sedes (hay que calificar los IDs públicos antes), alertas de cupo.

---

## Pendiente con fecha: **27/08/2026**

El único experimento que no se puede adelantar. Hoy los cupos no se mueven (medido: 0
cambios en 347 grupos en 35 min de pre-inscripción), así que el TTL de 5 min de
`API.md` está inventado.

**Cuando abran las inscripciones:** muestrear el mismo plan cada 15 min durante las
primeras horas. Ese número fija el TTL de cupos y decide si el polling de fase 2 tiene
sentido. El arnés ya está probado; ver [`docs/OPEN-QUESTIONS.md §2`](docs/OPEN-QUESTIONS.md).

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
