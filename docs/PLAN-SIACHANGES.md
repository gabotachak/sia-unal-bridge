# Plan: Reconciliación de entidades que el SIA deja de ofrecer

## Problema

Cuando el SIA retira una entidad —un programa desaparece del dropdown, una
asignatura sale del plan, un grupo se cancela a mitad de semestre— la app la
sigue mostrando: la base tiene la fila, la API la sirve y el frontend la pinta.
No hay reconciliación que compare "lo que el SIA devolvió ahora" con "lo que la
base tenía antes".

El patrón subyacente es **append-only en todas partes**. Es la decisión correcta
para un cache que se llena incrementalmente, pero una vez que el `Refresher`
recorre todo el universo, la ausencia deja de significar "nadie preguntó" y pasa
a significar "ya no existe". Codificar esa transición es este plan.

---

## El principio que gobierna todo el plan

> **Una ausencia solo es una baja si la lectura que la produjo fue completa.**

Reconciliar es la primera operación de este proyecto que **destruye** datos a
partir de una lectura del SIA. Hasta hoy una lectura mala solo dejaba el cache
sin llenar; a partir de aquí apaga filas buenas. Las trampas de
`docs/GOTCHAS.md` que fallan en silencio dejan de costar un miss y pasan a
costar datos.

Dos hallazgos del 2026-08-21 son la prueba de que ese riesgo es real y presente,
no hipotético:

- **§40** (`e1267b3`): `2022615` (Alemán I) parseaba **0 grupos** porque su
  cabecera no dice la palabra `Grupo`. Con reconciliación activa, esa lectura
  habría apagado el único grupo real de la asignatura —con profesor, horario y
  23 cupos— y la API lo habría reportado como "sin oferta".
- **`3cdcd9b`**: `findRowInListings` se tragaba el error de `FetchCatalog` y
  devolvía `ErrNotFound`. Un hipo transitorio del SIA se reportaba como "la
  asignatura no existe". Ese commit ya arregló el caso, y es el precedente
  exacto de lo que este plan debe hacer en todas partes.

De ahí sale el orden del plan: **primero se blinda la lectura (Parte A), después
se reconcilia (Partes B y C).** Hacerlo al revés es cablear un destructor de
datos a un parser que ya se sabe frágil.

---

## Decisiones

1. **`disabled_at timestamptz` nullable en CINCO tablas**: `level`, `campus`,
   `program`, `course_program`, `section_program`.

   **NO** en `course` ni en `section`. Las dos son derivables y almacenarlas
   cuesta caro o es directamente incorrecto (ver "Por qué cinco y no siete").

2. **No se exponen entidades deshabilitadas.** No hay `?include_disabled`.
   Desaparecen de todas las respuestas.

3. **Nunca se reconcilia sobre una lectura sospechosa.** Lista vacía, catálogo
   encogido más de la mitad, o detalle cuyo parseo no cuadra ⇒ error, no baja.

4. **Reactivación automática**: si una entidad reaparece, el `ON CONFLICT DO
   UPDATE` la pone en `NULL` otra vez. Es reversible por construcción.

### Por qué cinco tablas y no siete

**`section.disabled_at` sería incorrecto.** `UpsertDetail` recibe la respuesta
de **un** programa, y esa respuesta es un subconjunto estricto de los grupos que
existen — medido en `docs/DATA-MODEL.md` §2:

```
1000004-B  Sistemas y Computación : 25 grupos
1000004-B  Industrial             : 23 grupos   ← subconjunto ESTRICTO
```

Reconciliar `section` globalmente por `(campus_code, code, term)` desde un
upsert por programa hace que refrescar Industrial apague 2 grupos reales de
Sistemas, y que refrescar Sistemas los reactive. Flapping permanente entre
planes, con datos incorrectos en el intervalo.

La columna además **no hace falta**: todas las rutas de lectura de grupos ya
pasan por `section_program` filtrado por `program_id` — `Sections()`
(`internal/store/section.go:164`), `ProgramSchedules()` (`section.go:306`) y el
`LATERAL` de cupos en `ProgramCourses()` (`internal/store/course.go:69`).
Apagando el `section_program` se apaga el grupo para ese plan, que es
exactamente la semántica correcta.

**`course.disabled_at` sería caro.** El diseño explícito exige dos `UPDATE`
campus-wide en cada `UpsertCatalog`:

- `course_program` no tiene índice por `(campus_code, code)` —su PK es
  `(program_id, code)`, `migrations/00001_init.sql:96`— así que el `NOT EXISTS`
  hace seq scan de `course_program` por cada fila de `course` de la sede.
- El `Refresher` corre programas de la misma sede en paralelo. Dos
  transacciones haciendo `UPDATE course WHERE campus_code = '1101'` compiten por
  los mismos row locks y pueden deadlockear.

Es derivable con un `EXISTS` sobre `course_program`, que con el índice nuevo es
una búsqueda indexada por lectura. El índice hace falta igual: hoy los `LATERAL`
de `CoursesNeedingDetail` y el `JOIN` de `SeatsHotSet`
(`internal/store/refresh.go`) también escanean por `(campus_code, code)`.

**`seat_snapshot` y `course_demand` no llevan columna.** El primero es historial
append-only por diseño; el segundo se filtra en el JOIN.

---

## Parte A — Blindar la lectura (antes de tocar la base)

Nada de la Parte B/C se despliega hasta que A esté en verde. Estos seis puntos
salen de revisar los commits del 2026-08-21.

### A1 — `ParseDetail`: cuadrar los grupos contra su ancla fija

**Es el cambio más importante del plan.** Hoy, si `groupHeaderRe` no encaja,
`ParseDetail` devuelve 0 secciones sin error: indistinguible de una asignatura
sin oferta (§18), que es un caso legítimo. Ese es literalmente el bug §40, y va
a volver a pasar con la próxima variante de cabecera que la UNAL invente.

Todo grupo tiene exactamente un `Profesor:` — es el ancla fija de la que
`e1267b3` ya depende para su rama de reserva. Eso da una comprobación de 4
líneas que cuadra el parseo consigo mismo:

```go
// internal/sia/parse_detail.go, al final de ParseDetail, antes del return.
//
// Todo grupo trae exactamente un "Profesor:". Si el conteo no cuadra con las
// cabeceras encontradas, groupHeaderRe se quedó corto o se pasó, y las dos
// fallas son SILENCIOSAS: de menos parece "sin oferta" (§18), de más inventa
// grupos. Es la comprobación que habría cazado §40 el día que apareció, y la
// que evita que la reconciliación apague grupos reales por un parseo malo.
if n := strings.Count(text[:groupsEnd], profesorAnchor); n != len(sections) {
    return Detail{}, fmt.Errorf("%w: %s parsed %d groups but the page has %d %q anchors",
        ErrParseMismatch, code, len(sections), n, profesorAnchor)
}
```

Verificado contra las 6 fixtures del repo, **incluidas las dos que reprodujeron
bugs reales**:

| Fixture | `sections` | `Profesor:` |
|---|---|---|
| `detalle_1000003-B_con_prerrequisitos` | 19 | 19 |
| `detalle_1000003-B_grupo_sin_horario` | 19 | 19 |
| `detalle_1000004-B_32grupos_peama` | 32 | 32 |
| `detalle_2022615_grupo_sin_palabra_grupo` | 1 | 1 |
| `detalle_2027641_0grupos` | 0 | 0 |
| `detalle_2do_de_sesion_region2` | 4 | 4 |

Con esta guarda, el falso positivo que `e1267b3` describe (32 grupos inflados a
34 por `(Presencial)`) habría salido como error en vez de como datos plausibles.

`ErrParseMismatch` va junto a los errores que ya tiene `internal/sia`, y sube
como fallo transitorio: reintentable, nunca `ErrNotFound`.

**Test**: agregar a `parse_detail_test.go` un caso que recorra `testdata/` y
afirme la invariante sobre toda fixture de detalle. Una fixture futura que la
rompa falla el build en vez de sorprender en producción.

### A2 — El dígito obligatorio de `groupHeaderRe` es una apuesta, y A1 la cubre

`e1267b3` cambió `\([^)\n]{1,20}\)` por `\([^)\n]*\d[^)\n]*\)` para descartar
`(Presencial)`. La justificación —"toda clave real tiene un dígito"— es la misma
clase de suposición sobre 233 cabeceras que §40 acaba de castigar: una clave
`(A)` o `(ORIN)` ahora se cae en silencio, que es el bug §40 al revés.

**No se toca el regex.** Con A1 la apuesta deja de ser silenciosa: si la clave
sin dígito existe, el conteo no cuadra y sale un error con el código de la
asignatura. Se arregla cuando aparezca, con una fixture real, como se arregló
§40. Es la comprobación la que vuelve segura la heurística, no al revés.

### A3 — El refresco por dato viejo: qué quedó bien y qué hay que rehacer

La idea es correcta y ya estaba a medio construir. `Program.tsx` usa
`STALE_SEATS_SECONDS` para **tres** decisiones coherentes entre sí, y esa parte
se queda tal cual:

| Dónde | Qué hace | Veredicto |
|---|---|---|
| Tooltip de la columna de cupos (`Program.tsx:847`) | "Hace más de X que se midieron los cupos. Ábrela para volver a preguntar." | Correcto |
| Orden por cupos (`seatsRank`) | Un "sin grupos" viejo ordena como `unknown`, no como `noOffer` | Correcto |
| Filtro "solo con cupo" (`hasRoom`) | Un "sin grupos" viejo NO se esconde | Correcto |

Es una semántica buena y bien defendida en los comentarios: **un dato viejo
vuelve a ser desconocido**. El tooltip incluso promete el remate ("Ábrela para
volver a preguntar"), así que cerrar el círculo en `Course.tsx` era lo natural.

Lo que no quedó bien es **cómo** se cerró (`4d625ad`,
`web/src/views/Course.tsx:118-129`). Cuatro problemas, de más grave a menos:

**1. Reimplementa en el cliente lo que el servidor ya hace mejor.** El
read-through existe justamente para esto: `?max_age=<segundos>` le dice a la API
"sírvemelo si es más nuevo que esto, si no ve al SIA". El efecto en cambio
fuerza `max_age=0`, que es "ve al SIA pase lo que pase" — y entonces tiene que
pelear con el cooldown que ese mismo modo dispara.

`internal/httpapi/cooldown.go:37` es explícito: no hay gate cuando
`maxAge >= a.cooldown`, y el comentario de la línea 23 dice el porqué —"the
read-through already serves it from cache". Con `FETCH_COOLDOWN=300` y
`STALE_SEATS_SECONDS` de 1800 o 7200, pedir `?max_age=STALE_SEATS_SECONDS`
**nunca** da 429 y hace exactamente lo que el efecto quería, sin efecto, sin
`cooldownUntil`, sin reintentos y sin una segunda política de frescura que
contradiga a la del servidor.

**2. Mira el campo equivocado.** `CourseDetail extends CourseSummary`
(`web/src/api/types.ts:92`), así que `data.fetched_at` es **`course.fetched_at`**
—cuándo se guardó la fila de la asignatura: nombre, créditos, descripción— y no
cuándo se pidió el detalle. Los dos upserts (`UpsertCatalog` y `UpsertDetail`)
lo tocan con `now()`, así que es un reloj más nuevo y sin relación con los
cupos. El campo que corresponde es `detail_fetched_at`, que es justamente el que
`Program.tsx` usa para la misma decisión. Hoy las dos pantallas miden vejez con
relojes distintos.

**3. El disparador `sections.length === 0` genera carga infinita.** Una
asignatura sin oferta este periodo (§18) tiene 0 grupos de forma legítima y
permanente. Cada vista fuerza un POST al SIA, dos horas después vuelve a estar
vieja, y la siguiente vista vuelve a forzar — para siempre, sobre un pool de 4
conexiones. Además ataca el síntoma equivocado: la sospecha de fondo es "0
grupos podría ser un parseo roto", y eso lo resuelve A1 en el parser. Después de
A1 un 0 que llega es un 0 de verdad y no hay nada que reintentar.

**4. Detalles.** Las dependencias del `useEffect` (`scope, program, code,
reload`) no incluyen `measureAll`, que es lo único que el efecto llama —closure
vieja. Y quedaron espacios en blanco al final de tres líneas.

#### Qué hacer

Borrar el `useEffect` entero y pedir la frescura en la petición normal, en el
`routes.course(...)` que `Course.tsx` ya hace al montar:

```
routes.course(scope, program, code)            →  el default del servidor (24 h)
routes.course(scope, program, code, STALE)     →  lo que el tooltip promete
```

Queda una llamada, sin efecto, sin cooldown, sin 429 y sin bucle. El botón
manual de "medir ahora" sigue mandando `max_age=0`, que es donde el 429 sí tiene
sentido: ahí sí lo pidió una persona.

Con eso, `STALE_SEATS_SECONDS` deja de ser un umbral del cliente y pasa a ser lo
que siempre debió ser: **la frescura que este front le pide a la API**. Vale
renombrarlo en consecuencia y moverlo junto a `FETCH_COOLDOWN` en
`web/src/api/client.ts`, que es donde ya vive esta clase de constante (ver A5).

### A4 — `VITE_STALE_SEATS_SECONDS` no llega a producción

**El `.env` no se está usando en el build de Docker.** La cadena está a dos
tercios:

| Eslabón | `FETCH_COOLDOWN` | `VITE_INCIDENT_BANNER_OFF` | `VITE_STALE_SEATS_SECONDS` |
|---|---|---|---|
| `.env.example` | ✅ | ✅ | ✅ `=1800` |
| `docker-compose.yml` → `build.args` | ✅ | ✅ | ❌ **falta** |
| `web/Dockerfile` → `ARG`/`ENV` | ✅ | ✅ | ❌ **falta** |
| `vite.config.ts` → `define` | ✅ | ✅ | ✅ |

`web/vite.config.ts:27` explica la regla que esto rompe, con esas palabras: *"el
build corre con contexto ./web, donde el .env de la raíz no existe, así que
compose lo inyecta como build arg"*. Sin el build arg,
`process.env.VITE_STALE_SEATS_SECONDS` llega vacío y cae al `|| '7200'` de
`vite.config.ts:54`.

Consecuencia medible:

- **Dev** (`npm run dev`): `loadEnv` sí ve el `.env` de la raíz → **1800 s**.
- **Docker / producción**: `.env` invisible, sin build arg → **7200 s**.
- **`.env.example` dice 1800**, y es lo que cualquiera asumiría leyéndolo.

Tres valores para una sola variable, sin que nada lo diga. Es exactamente la
clase de divergencia silenciosa que este proyecto persigue, y `831c3c1` ya había
escrito la receta completa ("Mismo camino que FETCH_COOLDOWN: .env de la raíz,
build arg en compose, `define` en vite.config.ts") — el commit de
`STALE_SEATS_SECONDS` hizo dos de los tres pasos.

**Arreglo**: agregar el eslabón que falta en los dos sitios.

```yaml
# docker-compose.yml, servicio web, junto a los otros build args
VITE_STALE_SEATS_SECONDS: ${VITE_STALE_SEATS_SECONDS:-1800}
```

```dockerfile
# web/Dockerfile, antes de `RUN npm run build`
ARG VITE_STALE_SEATS_SECONDS=1800
ENV VITE_STALE_SEATS_SECONDS=$VITE_STALE_SEATS_SECONDS
```

El default de los tres sitios (`.env.example`, compose, Dockerfile,
`vite.config.ts`) tiene que ser **el mismo número**. Hoy son 1800, ausente,
ausente y 7200.

**Verificación**, la misma que `831c3c1` documentó para el banner: construir con
la variable y sin ella, y confirmar en el bundle (`grep` sobre `dist/assets/*.js`)
que el número horneado es el esperado en cada caso. Si la constante se renombra
(A3), este cambio se hace con el nombre nuevo, de una sola vez.

### A5 — `STALE_SEATS_SECONDS` está definido dos veces

`web/src/views/Program.tsx:33` y `web/src/views/Course.tsx:23` leen la misma
variable por separado, con el mismo default repetido a mano. Va a
`web/src/api/client.ts` junto a `FETCH_COOLDOWN`, que es donde ya vive esta
clase de constante y donde el comentario de `FETCH_COOLDOWN` ya explica la
relación entre el umbral del cliente y la autoridad del servidor — que después
de A3 es exactamente lo que esta constante significa.

### A6 — Revertir el reformateo de `Program.tsx` (`2346902`)

El commit mezcla un cambio real de ~15 líneas (introducir
`STALE_SEATS_SECONDS`) con un reformateo de 466 que pasó todo el archivo de
comillas simples a dobles. El repo no tiene configuración de Prettier y los
otros ~40 archivos de `web/src/` usan comillas simples: el resultado es un
archivo inconsistente con todos los demás y un diff donde el cambio real es
invisible.

Rehacer como dos commits: un `style:` que revierte a comillas simples, y el
cambio de funcionalidad solo. Si se quiere formateo automático, es una decisión
aparte —agregar Prettier con `singleQuote: true` y formatear todo `web/src/` de
una— no un efecto colateral de un commit de funcionalidad.

### Lo que se queda como está

- **`3cdcd9b`** (`findRowInListings`): correcto y es el precedente del principio
  rector. Sin cambios.
- **`bca425a`** (`?include=schedules`): correcto. Su `ProgramSchedules` es una
  de las consultas que la Parte C filtra.
- **`f2e2def` / `831c3c1`** (banner de incidencia): correctos. Nota para
  después, fuera de este plan: una vez exista reconciliación, el banner manual
  puede sustituirse por una señal derivada de los marcadores de frescura.

---

## Parte B — Migración

### `migrations/00004_disabled_at.sql`

```sql
-- +goose Up
-- disabled_at marca las filas que la última reconciliación con el SIA
-- confirmó ausentes. NULL = activa. Los datos existentes quedan activos y la
-- primera pasada del Refresher hace la limpieza.
--
-- Solo cinco tablas. `course` y `section` NO la llevan: son derivables de
-- course_program y section_program respectivamente, y almacenarlas sería caro
-- (course) o incorrecto (section — la visibilidad de grupos es por programa,
-- DATA-MODEL.md §2).

ALTER TABLE level           ADD COLUMN disabled_at timestamptz;
ALTER TABLE campus          ADD COLUMN disabled_at timestamptz;
ALTER TABLE program         ADD COLUMN disabled_at timestamptz;
ALTER TABLE course_program  ADD COLUMN disabled_at timestamptz;
ALTER TABLE section_program ADD COLUMN disabled_at timestamptz;

-- El EXISTS que reemplaza a course.disabled_at entra por acá. El índice no es
-- deuda nueva: CoursesNeedingDetail y SeatsHotSet (store/refresh.go) ya
-- escanean course_program por (campus_code, code) sin índice.
CREATE INDEX course_program_campus_code_idx ON course_program (campus_code, code);

-- +goose Down
DROP INDEX course_program_campus_code_idx;
ALTER TABLE section_program DROP COLUMN disabled_at;
ALTER TABLE course_program  DROP COLUMN disabled_at;
ALTER TABLE program         DROP COLUMN disabled_at;
ALTER TABLE campus          DROP COLUMN disabled_at;
ALTER TABLE level           DROP COLUMN disabled_at;
```

Sin `UPDATE` de datos: todo lo existente arranca activo.

---

## Parte C — Implementación

### C1 — `internal/store/reference.go`

#### Guarda común

Las tres funciones de este archivo comparten la misma trampa: una lista vacía
significa "el dropdown falló", nunca "la UNAL cerró todos los niveles".
Reconciliar con lista vacía apaga la tabla entera. `Levels()` filtrado
devolviendo nada deja la API muerta de raíz, porque todo cuelga del nivel.

Guarda al principio de la reconciliación de las tres:

```go
if len(xs) == 0 {
    return stampReference(ctx, tx, scope)  // upsert vacío: nada que reconciliar
}
```

#### `UpsertLevels()`

```go
// ON CONFLICT: agregar la reactivación.
ON CONFLICT (name) DO UPDATE SET level_idx = EXCLUDED.level_idx, disabled_at = NULL
```

Reconciliación tras el loop, antes de `stampReference`, con la guarda de arriba.
El scope es la tabla entera y la identidad es `name`, el mismo conflict target
del upsert (el `slug` es el ID público y no se reasigna nunca):

```go
names := make([]string, len(levels))
for i, l := range levels {
    names[i] = l.Name
}
if _, err := tx.Exec(ctx, `
    UPDATE level SET disabled_at = now()
    WHERE name != ALL($1) AND disabled_at IS NULL`, names,
); err != nil {
    return fmt.Errorf("store: UpsertLevels: reconcile: %w", err)
}
```

#### `UpsertCampuses()`

```go
ON CONFLICT (level_slug, code) DO UPDATE SET
    name = EXCLUDED.name, campus_idx = EXCLUDED.campus_idx, disabled_at = NULL
```

Scope `level_slug` (todas las del batch comparten nivel):

```go
codes := make([]string, len(campuses))
for i, c := range campuses {
    codes[i] = c.Code
}
if _, err := tx.Exec(ctx, `
    UPDATE campus SET disabled_at = now()
    WHERE level_slug = $1 AND code != ALL($2) AND disabled_at IS NULL`,
    campuses[0].LevelSlug, codes,
); err != nil {
    return fmt.Errorf("store: UpsertCampuses: reconcile: %w", err)
}
```

#### `UpsertPrograms()`

El scope `(campus_code, level_slug)` es correcto: `ensureDirectory`
(`internal/catalog/service.go:70-86`) arma el batch con **todas** las facultades
de la sede antes de llamar, y el comentario de `UpsertPrograms` ya lo garantiza
("every faculty and every program under one (campus, level)").

```go
ON CONFLICT (campus_code, faculty_code, code, level_slug) DO UPDATE SET
    ..., program_idx = EXCLUDED.program_idx, disabled_at = NULL
```

El UNIQUE lleva `faculty_code`, así que la comparación necesita los dos códigos
—dos arrays paralelos con `unnest`, no un `IN` sobre uno solo:

```go
facultyCodes := make([]string, len(programs))
programCodes := make([]string, len(programs))
for i, p := range programs {
    facultyCodes[i], programCodes[i] = p.FacultyCode, p.Code
}
if _, err := tx.Exec(ctx, `
    UPDATE program SET disabled_at = now()
    WHERE campus_code = $1 AND level_slug = $2 AND disabled_at IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM unnest($3::text[], $4::text[]) AS t(fac, code)
          WHERE t.fac = program.faculty_code AND t.code = program.code
      )`,
    programs[0].CampusCode, programs[0].LevelSlug, facultyCodes, programCodes,
); err != nil {
    return fmt.Errorf("store: UpsertPrograms: reconcile: %w", err)
}
```

#### Filtros de lectura

```sql
-- Levels()
SELECT slug, name, level_idx FROM level WHERE disabled_at IS NULL ORDER BY level_idx

-- Campuses()
SELECT level_slug, code, name, campus_idx FROM campus
WHERE level_slug = $1 AND disabled_at IS NULL ORDER BY name
```

### C2 — `internal/store/program.go`

`UpsertProgram()` (el singular) solo lo usan los tests hoy, pero lleva la misma
reactivación por coherencia: `..., program_idx = EXCLUDED.program_idx,
disabled_at = NULL`. El `RETURNING` no cambia.

Filtros:

```sql
-- Program()
FROM program WHERE campus_code = $1 AND faculty_code = $2 AND code = $3
  AND disabled_at IS NULL

-- Programs()
WHERE ($1 = '' OR campus_code = $1) AND ($2 = '' OR faculty_code = $2)
  AND ($3 = '' OR level_slug = $3) AND disabled_at IS NULL

-- ProgramsOfferingCourse()
WHERE cp.code = $2 AND ($1 = '' OR p.campus_code = $1)
  AND p.disabled_at IS NULL AND cp.disabled_at IS NULL
```

`workList()` del `Refresher` sale gratis: llama a `Programs()`, que ya filtra. Se
deja de gastar POSTs navegando a planes que el dropdown ya no tiene.

### C3 — `internal/catalog/service_refresh.go`: la guarda de encogimiento

`suspectEmptyCatalog` solo detecta 0. Con reconciliación, un 98→5 por listado
truncado, `soc4` sucio o tabla del bootstrap (GOTCHAS §14/§21/§22) pasa el
control y apaga 93 materias reales. Se generaliza la función que ya existe y ya
está enganchada en `Catalog()` — no hay sitio de llamada nuevo:

```go
// shrinkFloor: por debajo de esta fracción del catálogo activo previo, una
// respuesta más chica no es "retiraron materias", es una lectura rota. Un plan
// no pierde la mitad de su oferta de un semestre a otro; un listado truncado
// (§14) o un soc4 sucio (§22) sí produce exactamente eso, y en silencio.
const shrinkFloor = 0.5

// suspectShrunkCatalog reemplaza a suspectEmptyCatalog: mismo caso del 0
// —que sigue siendo el más grave— y además el encogimiento brusco, que antes
// solo dejaba el cache incompleto y ahora apagaría filas buenas.
func (s *Service) suspectShrunkCatalog(ctx context.Context, program Program, offerings []CourseOffering) error {
    if program.CatalogFetchedAt == nil {
        return nil // primera vez: no hay contra qué comparar
    }
    prev, err := s.store.ProgramCourses(ctx, program.ID)
    if err != nil {
        return err
    }
    if len(prev) == 0 {
        return nil
    }
    if len(offerings) == 0 {
        return fmt.Errorf("%w: program %s/%s returned 0 courses, cache holds %d",
            ErrSuspectRun, program.CampusCode, program.Code, len(prev))
    }
    if float64(len(offerings)) < shrinkFloor*float64(len(prev)) {
        return fmt.Errorf("%w: program %s/%s returned %d courses, cache holds %d active",
            ErrSuspectRun, program.CampusCode, program.Code, len(offerings), len(prev))
    }
    return nil
}
```

`prev` cuenta solo las activas porque `ProgramCourses` filtra (C4). Correcto: la
comparación es contra lo vigente, no contra el historial.

**Nota de operación**: la primera pasada tras el deploy puede disparar
`ErrSuspectRun` en planes con muchas materias retiradas acumuladas. Es el
comportamiento deseado —parar y que un humano mire— pero conviene revisar los
logs las primeras 24 h en vez de asumir que el silencio es éxito.

### C4 — `internal/store/course.go`

#### `UpsertCatalog()`

Reactivación en los dos upserts:

```go
// course: sin disabled_at (no existe la columna), solo el fetched_at de siempre.
// course_program:
ON CONFLICT (program_id, code) DO UPDATE SET
    typology = EXCLUDED.typology, disabled_at = NULL
```

Reconciliación tras el loop, antes del `UPDATE program SET catalog_fetched_at`.
El scope es `program_id`, que es exactamente lo que el listado describe:

```go
// len(offerings) == 0 no llega hasta acá: suspectShrunkCatalog lo rechaza
// antes cuando había catálogo previo (C3). La guarda queda igual porque este
// upsert es público y no todos sus caminos pasan por el Service.
if len(offerings) > 0 {
    codes := make([]string, len(offerings))
    for i, o := range offerings {
        codes[i] = o.Course.Code
    }
    if _, err := tx.Exec(ctx, `
        UPDATE course_program SET disabled_at = now()
        WHERE program_id = $1 AND code != ALL($2) AND disabled_at IS NULL`,
        program.ID, codes,
    ); err != nil {
        return fmt.Errorf("store: UpsertCatalog: reconcile: %w", err)
    }
}
```

No hay nada más. `course` no se toca: una materia deja de ser visible en cuanto
ninguna `course_program` activa la referencia, y eso se evalúa al leer.

`Catalog()` pasa `combined` (regular + electivas) en **una sola** llamada
(`service.go:440`), así que las electivas nunca apagan a las regulares. Es un
riesgo real que la forma actual del código ya evita; si alguien parte esa
llamada en dos, la reconciliación se vuelve destructiva. Vale un comentario en
`UpsertCatalog` diciéndolo.

#### Filtros de lectura

```sql
-- ProgramCourses(): en el WHERE principal
WHERE cp.program_id = $1 AND cp.disabled_at IS NULL

-- ProgramCourses(): dentro del LATERAL de cupos, en el JOIN de visibilidad
JOIN section_program sp
  ON sp.section_id = sec.id AND sp.program_id = cp.program_id
 AND sp.disabled_at IS NULL

-- Course(): course.disabled_at derivado
FROM course
WHERE campus_code = $1 AND code = $2
  AND EXISTS (SELECT 1 FROM course_program cp
              WHERE cp.campus_code = course.campus_code AND cp.code = course.code
                AND cp.disabled_at IS NULL)

-- SearchCourses(): mismo EXISTS
WHERE name ILIKE '%' || $2 || '%' AND ($1 = '' OR campus_code = $1)
  AND EXISTS (SELECT 1 FROM course_program cp
              WHERE cp.campus_code = course.campus_code AND cp.code = course.code
                AND cp.disabled_at IS NULL)

-- ProgramCoverage()
FROM program WHERE ($1 = '' OR campus_code = $1) AND disabled_at IS NULL
```

El `EXISTS` usa `course_program_campus_code_idx` de la Parte B.

### C5 — `internal/store/section.go`

#### `UpsertDetail()`

Reactivación de `section_program`, que hoy es `ON CONFLICT DO NOTHING` y por
tanto nunca limpiaría la marca:

```go
INSERT INTO section_program (section_id, program_id) VALUES ($1, $2)
ON CONFLICT (section_id, program_id) DO UPDATE SET disabled_at = NULL
```

`section` no cambia: sigue con su `ON CONFLICT ... fetched_at = now()` y sin
columna que reactivar.

Reconciliación **solo de `section_program`, solo para este programa**, después
del loop de grupos:

```go
// La respuesta del detalle describe con autoridad UNA cosa: qué grupos ve
// ESTE plan. No dice nada sobre los grupos de los demás planes —Sistemas ve
// 25 donde Industrial ve 23 (DATA-MODEL.md §2)— así que se apaga la
// visibilidad, nunca el grupo. Un grupo cancelado de verdad se apaga solo:
// deja de aparecer en el detalle de todos los planes que lo veían.
//
// c.Sections vacío es un caso válido (§18) y llega acá con keys vacío, que
// apaga toda la visibilidad de este plan sobre este curso. Es lo correcto: el
// plan dejó de ver grupos. Y es seguro apagarlo porque A1 garantiza que un 0
// que llega hasta acá es un 0 de verdad y no un parseo roto.
keys := make([]string, len(c.Sections))
for i, sec := range c.Sections {
    keys[i] = sec.Key
}
if _, err := tx.Exec(ctx, `
    UPDATE section_program sp SET disabled_at = now()
    WHERE sp.program_id = $1 AND sp.disabled_at IS NULL
      AND EXISTS (
          SELECT 1 FROM section sec
          WHERE sec.id = sp.section_id
            AND sec.campus_code = $2 AND sec.code = $3 AND sec.term = $4
            AND sec.key != ALL($5)
      )`,
    programID, c.CampusCode, c.Code, term, keys,
); err != nil {
    return fmt.Errorf("store: UpsertDetail: reconcile section_program: %w", err)
}
```

**`term` tiene que ser un parámetro explícito.** Hoy sale de `sec.Term`, que no
existe cuando `c.Sections` está vacío — justo el caso que más importa. Sin el
filtro de periodo, la reconciliación apagaría la visibilidad de los grupos de
todos los semestres guardados. `Service.term` ya lo tiene y lo pasa a
`FetchDetails` (`service_refresh.go:57`); se agrega a la firma:

```go
func (s *Store) UpsertDetail(ctx context.Context, programID int64, term string,
                             offering catalog.CourseOffering) error
```

y al puerto en `internal/catalog/ports.go`. Son dos sitios de llamada:
`Service.CourseDetail` y el callback de `Service.RefreshDetails`.

#### Filtros de lectura

```sql
-- Sections()
FROM section sec
JOIN section_program sp ON sp.section_id = sec.id
WHERE sec.campus_code = $1 AND sec.code = $2 AND sp.program_id = $3
  AND sp.disabled_at IS NULL

-- ProgramSchedules(): el filtro va en el EXISTS, no en el WHERE.
LEFT JOIN section sec
       ON sec.campus_code = cp.campus_code AND sec.code = cp.code
      AND EXISTS (
          SELECT 1 FROM section_program sp
          WHERE sp.section_id = sec.id AND sp.program_id = cp.program_id
            AND sp.disabled_at IS NULL
      )
...
WHERE cp.program_id = $1 AND cp.detail_fetched_at IS NOT NULL
  AND cp.disabled_at IS NULL
```

Mover el filtro de secciones al `WHERE` de `ProgramSchedules` convertiría el
`LEFT JOIN` en `INNER` y haría desaparecer las asignaturas medidas sin grupos —
la distinción que el propio comentario de la función defiende y que `bca425a`
fijó con tests.

`currentSeatsBatch` y `classSessionsBatch` **no cambian**: reciben ids que
`Sections()` ya filtró.

### C6 — `internal/store/refresh.go`

```sql
-- CoursesNeedingDetail()
WHERE cp.program_id = $1 AND cp.disabled_at IS NULL AND coalesce(...)

-- CoursesNeedingVisibility()
WHERE cp.program_id = $1 AND cp.disabled_at IS NULL AND coalesce(...)

-- SeatsHotSet(): en el JOIN contra course_program del sub-query
JOIN course_program cp ON cp.campus_code = d.campus_code AND cp.code = d.code
                      AND cp.disabled_at IS NULL
```

`course_demand` no lleva columna: el filtro vive en el JOIN. El sweep de cupos
deja de gastar POSTs en materias retiradas.

### C7 — Dominio: sin cambios

No se agregan campos `DisabledAt` a `Program`, `Course` ni `Section`. La API no
expone deshabilitadas, las lecturas ya filtran, y la marca vive solo en la base.
`internal/catalog/service.go` no cambia salvo el `term` de C5;
`internal/httpapi/*` no cambia nada.

---

## Parte D — Frontend

El contrato HTTP no cambia: mismos endpoints, mismos campos, mismos tipos. Las
entidades apagadas simplemente dejan de venir. Pero hay tres bordes donde el
`localStorage` guarda cosas que la API puede dejar de reconocer.

### D1 — Plan elegido que se apaga

`Selection` vive en `localStorage` (`web/src/lib/storage.ts`, `PICK_KEY`). Si su
programa se apaga, todas las pantallas responden `404 unknown_program`. El texto
ya existe en `client.ts:64` ("Ese plan de estudios no existe en esta sede"), pero
la única salida es que la persona adivine que el botón de la papelera arriba
—"Empezar de nuevo"— es lo que la desatasca.

Arreglo, en el manejador de error de las vistas que dependen de la selección:
ante `code === 'unknown_program'`, ofrecer explícitamente "elegir otro plan"
llamando a `clearStored()` + `history.replaceState(null, '', '/')` +
`window.location.replace('/')`, el mismo camino que `Topbar.startOver` ya usa y
ya explica por qué recarga en vez de navegar. Los tres pasos, no solo el
primero: el `screen` guardado en `history.state` sobrevive a la recarga, así
que sin limpiarlo la app vuelve a pintar el plan que se acaba de borrar
(`NavProvider` lo filtra igual, pero la entrada del historial queda sucia).

### D2 — Materias apagadas en Mi semestre

`views/Semester.tsx` pinta desde `plan.items`, y `PlanItem` guarda `name`,
`credits` y `typology` propios. Una materia retirada **sigue en pantalla** aunque
la API ya no la sirva: es el fantasma que este plan existe para matar, en el
único sitio donde la base no manda.

`useCourseDetails` ya marca la fila con `status: 'error'` y el texto humano
("Esa asignatura no está en el catálogo de este plan"), así que la persona ve
que algo pasa. Falta el remate: en ese código concreto, ofrecer quitarla de la
lista en la misma fila. No se borra sola —la lista es de quien la armó— pero
tampoco se deja en un limbo que solo se resuelve borrando el semestre entero.

### D3 — Grupo elegido en Mi horario

`ScheduleSelection` guarda `section.key` por materia (`SCHEDULE_KEY`). Una key
apagada no matchea nada y la materia queda sin grupo elegido. Degrada limpio; no
hay que hacer nada.

---

## Parte E — Verificación

Por orden. **A completo y verde antes de aplicar la migración.**

1. `go test ./internal/sia/` — A1 pasa con las 6 fixtures, incluido el caso
   nuevo que recorre `testdata/` afirmando la invariante.
2. `npm run lint && npm run build && npm test` en `web/` — A3, A5, A6.
   `npm run lint` es además lo que caza la clase de fallo de A3 (dependencias
   incompletas de `useEffect`), que hoy nadie corre en CI.
3. **A4, la cadena del `.env`**: `docker compose build web` con
   `VITE_STALE_SEATS_SECONDS=1234` en el `.env` de la raíz y `grep 1234
   dist/assets/*.js` dentro de la imagen. Sin la variable, el mismo grep debe
   encontrar el default acordado. Es la única forma de comprobarlo: el valor se
   hornea en el bundle y no hay proceso que lo lea en caliente.
4. `go test ./internal/...` — el resto pasa sin cambios: la migración solo
   agrega columnas NULL.
5. **Reconciliación, ida y vuelta**, en `store_test.go` contra Postgres real
   (que es donde ya viven los tests de `bca425a`), una por tabla:
   insertar → upsert sin la entidad → `disabled_at IS NOT NULL` y la lectura
   pública no la devuelve → upsert con la entidad → `disabled_at IS NULL` y
   vuelve a salir.
6. **El test que fija el bug que este plan evita**: dos programas viendo el
   mismo curso con distinto número de grupos (25/23 de `DATA-MODEL.md` §2).
   Refrescar el detalle del plan chico **no** puede quitarle grupos al grande.
   Es la regresión más cara y la menos obvia.
7. **Guardas**: `UpsertLevels`/`UpsertCampuses`/`UpsertPrograms` con lista vacía
   no apagan nada; `suspectShrunkCatalog` rechaza 98→5 y acepta 98→90.
8. `go build ./cmd/...`.

---

## Checklist

| # | Archivo | Qué hacer |
|---|---|---|
| **A1** | `internal/sia/parse_detail.go` | Cuadrar `len(sections)` contra el conteo de `Profesor:`. `ErrParseMismatch` |
| **A1** | `internal/sia/parse_detail_test.go` | Test que recorre `testdata/` afirmando la invariante |
| **A3** | `web/src/views/Course.tsx` | **Borrar** el `useEffect` de auto-refresh (`4d625ad`); pedir la frescura con `?max_age=` en la petición normal |
| **A4** | `docker-compose.yml`, `web/Dockerfile` | Pasar `VITE_STALE_SEATS_SECONDS` como build arg. Igualar el default en los 4 sitios |
| **A5** | `web/src/api/client.ts`, `views/*.tsx` | La constante en un solo sitio, junto a `FETCH_COOLDOWN` |
| **A6** | `web/src/views/Program.tsx` | Revertir a comillas simples; separar el cambio real |
| **B** | `migrations/00004_disabled_at.sql` | **CREAR**. 5 `ADD COLUMN` + índice `course_program (campus_code, code)` |
| **C1** | `internal/store/reference.go` | Guarda de lista vacía, reactivación y reconciliación ×3. Filtro en `Levels()`, `Campuses()` |
| **C2** | `internal/store/program.go` | Reactivación en `UpsertProgram`. Filtro en `Program()`, `Programs()`, `ProgramsOfferingCourse()` |
| **C3** | `internal/catalog/service_refresh.go` | `suspectEmptyCatalog` → `suspectShrunkCatalog` con `shrinkFloor` |
| **C4** | `internal/store/course.go` | Reactivación y reconciliación de `course_program`. `EXISTS` en `Course()`/`SearchCourses()`. Filtros en `ProgramCourses()`, `ProgramCoverage()` |
| **C5** | `internal/store/section.go` | `term` en la firma. Reactivación y reconciliación de `section_program` **solo**. Filtros en `Sections()`, `ProgramSchedules()` |
| **C5** | `internal/catalog/ports.go`, `service.go` | `term` en el puerto `UpsertDetail` y sus 2 llamadas |
| **C6** | `internal/store/refresh.go` | Filtro en `CoursesNeedingDetail()`, `CoursesNeedingVisibility()`, `SeatsHotSet()` |
| **D1** | `web/src/views/Program.tsx`, `Course.tsx` | Salida explícita ante `unknown_program` |
| **D2** | `web/src/views/Semester.tsx` | Quitar de la lista ante `unknown_course` |

**No se modifica**: `internal/catalog/course.go`, `internal/catalog/program.go`,
`internal/httpapi/*`, `internal/refresher/*`, `seat_snapshot`, `course_demand`,
`class_session`.
