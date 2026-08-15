# Modelo de datos

Postgres. El código y los identificadores van en inglés; esta documentación en español.
Los literales del SIA se citan tal cual porque son datos, no texto nuestro.

Cada decisión de aquí sale de algo verificado contra el servidor.
Referencias a [GOTCHAS.md](GOTCHAS.md).

---

## Por qué relacional

| Razón | Detalle |
|---|---|
| La forma es estable y jerárquica | `course → section → class_session`, descubierta, no supuesta |
| Los cupos piden historial | series temporales de `(section, seats, measured_at)` |
| Las consultas útiles son joins | *"libre elección, 3 créditos, con cupo, sin choque de horario"* |
| Choques = solapamiento de intervalos | Postgres tiene `tstzrange` y constraints de exclusión |
| La escala es minúscula | Bogotá: ~5-10k asignaturas, ~25k grupos |

El único argumento decente para documentos es que el detalle llega anidado. Se resuelve
con una columna `jsonb` con el crudo: normalizado para consultar, crudo para reprocesar
sin volver a scrapear.

---

## Esquema

```sql
-- ─── catalog: cheap, near-immutable ──────────────────────────────
CREATE TABLE course (
    campus_code text NOT NULL,             -- '1101'; qualifier, see decision 7
    code        text NOT NULL,             -- '2016696', '1000003-B'
    name        text NOT NULL,
    credits     int,
    description text,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campus_code, code)
);

CREATE TABLE program (                     -- a degree program (UNAL "carrera")
    id           bigserial PRIMARY KEY,

    -- public identity: institutional codes, parsed off the dropdown labels.
    -- '1101 SEDE BOGOTÁ' / '2055 FACULTAD DE INGENIERÍA' / '2A74 INGENIERÍA ...'
    --  ^^^^                 ^^^^                            ^^^^
    campus_code  text NOT NULL,            -- '1101'
    faculty_code text NOT NULL,            -- '2055'
    code         text NOT NULL,            -- '2A74'
    level        smallint NOT NULL,        -- soc1; fixed 3-value enum, no code
    name         text,                     -- 'INGENIERÍA DE SISTEMAS Y COMPUTACIÓN'
    campus_name  text,                     -- 'SEDE BOGOTÁ'
    faculty_name text,                     -- 'FACULTAD DE INGENIERÍA'

    -- navigation coordinate: positional dropdown indices. VOLATILE.
    -- Never an identity, never in a URL. Revalidate against the label
    -- before use; see "El ID público no es el índice del dropdown".
    campus_idx   smallint NOT NULL,        -- soc9
    faculty_idx  smallint NOT NULL,        -- soc2
    program_idx  smallint NOT NULL,        -- soc3

    catalog_fetched_at timestamptz,        -- drives the catalog cache TTL

    -- NOT UNIQUE (code): 136 of 852 codes repeat across campuses (PEAMA),
    -- and 46 repeat within a campus across faculties. Verified over the full
    -- 1380-entry census. See GOTCHAS.md §26.
    UNIQUE (campus_code, faculty_code, code)
);

CREATE TABLE course_program (              -- M:N; typology lives HERE
    program_id  bigint REFERENCES program(id) ON DELETE CASCADE,
    campus_code text NOT NULL,             -- redundant with program_id, needed by the FK
    code        text NOT NULL,
    typology    text,                      -- 'FUND. OBLIGATORIA (B)'
    detail_fetched_at timestamptz,         -- drives the VISIBILITY cache TTL
    PRIMARY KEY (program_id, code),
    FOREIGN KEY (campus_code, code)
        REFERENCES course (campus_code, code) ON DELETE CASCADE
);

-- ─── detail: expensive, one request per course ───────────────────
CREATE TABLE section (                     -- UNAL "grupo"
    id          bigserial PRIMARY KEY,
    campus_code text NOT NULL,
    code        text NOT NULL,
    term        text NOT NULL,             -- '2026-2'

    -- The token in parentheses of the group header, verbatim: '1', '10',
    -- 'AMAZ-07', 'TUMA-01'. THIS is the natural key inside a course, not
    -- `number`: a course can hold '(1) Grupo 1' AND '(AMAZ-01) ... Grupo 1'
    -- AND '(TUMA-01) ... Grupo 1'. Verified: 88/88 unique by key, 78/88 by
    -- number. See decision 8.
    key         text NOT NULL,
    number      int,                       -- from 'Grupo 1'; NOT unique alone
    site        text,                      -- 'AMAZ', 'TUMA', NULL if regular
    site_campus text,                      -- group's own 'Facultad: SEDE TUMACO'

    label       text,                      -- 'Grupo 1'
    instructor  text,
    shift       text,                      -- 'DIURNO'
    duration    text,                      -- 'Semestral'
    start_date  date,
    end_date    date,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    raw         jsonb,
    UNIQUE (campus_code, code, term, key),
    FOREIGN KEY (campus_code, code)
        REFERENCES course (campus_code, code) ON DELETE CASCADE
);

CREATE TABLE section_program (             -- which programs may enroll it
    section_id bigint REFERENCES section(id) ON DELETE CASCADE,
    program_id bigint REFERENCES program(id) ON DELETE CASCADE,
    PRIMARY KEY (section_id, program_id)
);

CREATE TABLE class_session (               -- one weekly meeting of a section
    id         bigserial PRIMARY KEY,
    section_id bigint REFERENCES section(id) ON DELETE CASCADE,
    weekday    smallint NOT NULL,          -- 1=Mon .. 7=Sun
    start_time time NOT NULL,
    end_time   time NOT NULL,
    room       text,                       -- 'SALA DE INFORMATICA 453-203'
    building   text                        -- '453 - Guillermina Uribe Bone'
);

-- ─── seats: volatile, keep history ───────────────────────────────
CREATE TABLE seat_snapshot (
    section_id      bigint REFERENCES section(id) ON DELETE CASCADE,
    available_seats int NOT NULL,
    measured_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (section_id, measured_at)
);

CREATE INDEX ON seat_snapshot (section_id, measured_at DESC);

CREATE VIEW current_seats AS
SELECT DISTINCT ON (section_id) section_id, available_seats, measured_at
FROM seat_snapshot ORDER BY section_id, measured_at DESC;
```

---

## Structs

```go
type Course struct {
    CampusCode  string    `db:"campus_code" json:"campus_code"`
    Code        string    `db:"code"        json:"code"`
    Name        string    `db:"name"        json:"name"`
    Credits     int       `db:"credits"     json:"credits"`
    Description string    `db:"description" json:"description,omitempty"`
    FetchedAt   time.Time `db:"fetched_at"  json:"fetched_at"`

    Sections []Section `json:"sections,omitempty"`
}

type Program struct {
    ID               int64      `db:"id"           json:"-"`
    CampusCode       string     `db:"campus_code"  json:"campus_code"`   // '1101'
    FacultyCode      string     `db:"faculty_code" json:"faculty_code"`  // '2055'
    Code             string     `db:"code"         json:"code"`          // '2A74'
    Level            int        `db:"level"        json:"-"`
    Name             string     `db:"name"         json:"name"`
    CampusName       string     `db:"campus_name"  json:"campus_name"`
    FacultyName      string     `db:"faculty_name" json:"faculty_name"`
    CatalogFetchedAt *time.Time `db:"catalog_fetched_at" json:"catalog_fetched_at,omitempty"`

    // Volatile navigation coordinate. Never serialized.
    CampusIdx  int `db:"campus_idx"  json:"-"`
    FacultyIdx int `db:"faculty_idx" json:"-"`
    ProgramIdx int `db:"program_idx" json:"-"`
}

// PublicID is what appears in URLs: "2A74". NOT unique across campuses —
// 136 of 852 codes repeat (PEAMA). Unqualified only while the scope is a
// single campus; qualify with campus_code once other campuses are in.
// See GOTCHAS.md §26.
func (p Program) PublicID() string { return p.Code }

// ProgramKey is the navigation coordinate inside SIA: "0-2-8-3".
// Positional dropdown indices — volatile. Derived from a Program at use
// time, never stored as its identity.
type ProgramKey struct{ Level, Campus, Faculty, Program int }

func (k ProgramKey) String() string {
    return fmt.Sprintf("%d-%d-%d-%d", k.Level, k.Campus, k.Faculty, k.Program)
}

type Section struct {
    ID         int64      `db:"id"          json:"-"`
    CampusCode string     `db:"campus_code" json:"-"`
    Code       string     `db:"code"        json:"-"`
    Term       string     `db:"term"       json:"term"`

    // Key is the parenthesised token, verbatim: "1", "AMAZ-07", "TUMA-01".
    // Identity inside the course. Number alone collides — see decision 8.
    Key        string     `db:"key"        json:"key"`
    Number     int        `db:"number"     json:"number"`
    Site       string     `db:"site"       json:"site,omitempty"`        // "TUMA"
    SiteCampus string     `db:"site_campus" json:"site_campus,omitempty"`

    Label      string     `db:"label"      json:"label,omitempty"`
    Instructor string     `db:"instructor" json:"instructor,omitempty"`
    Shift      string     `db:"shift"      json:"shift,omitempty"`
    Duration   string     `db:"duration"   json:"duration,omitempty"`
    StartDate  *time.Time `db:"start_date" json:"start_date,omitempty"`
    EndDate    *time.Time `db:"end_date"   json:"end_date,omitempty"`
    FetchedAt  time.Time  `db:"fetched_at" json:"fetched_at"`

    Schedule []ClassSession `json:"schedule"`
    Seats    *SeatSnapshot  `json:"seats,omitempty"`
}

type ClassSession struct {
    Weekday   time.Weekday `db:"weekday"    json:"weekday"`
    StartTime string       `db:"start_time" json:"start_time"` // "09:00"
    EndTime   string       `db:"end_time"   json:"end_time"`   // "11:00"
    Room      string       `db:"room"       json:"room,omitempty"`
    Building  string       `db:"building"   json:"building,omitempty"`
}

type SeatSnapshot struct {
    Available  int       `db:"available_seats" json:"available"`
    MeasuredAt time.Time `db:"measured_at"     json:"measured_at"`
}

func (s SeatSnapshot) AgeSeconds() int { return int(time.Since(s.MeasuredAt).Seconds()) }

// SIAConn is one live, stateful ADF session. Strictly sequential.
type SIAConn struct {
    viewState string
    jar       *cookiejar.Jar
    parkedAt  ProgramKey  // cascade already done for this program
    detailRegion int      // 0 = in the search region; >0 = open detail region.
                          // Back is pt1:r1:<detailRegion>:cb4 and the number grows
                          // with every detail. See GOTCHAS.md §20.
    lastUsed  time.Time
}
```

---

## Colisiones y palabras reservadas evitadas

| Candidato natural | Problema | Elegido |
|---|---|---|
| `group` | **reservada en SQL** (`GROUP BY`) | `section` |
| `session` | ambigua con la sesión HTTP/ADF | `class_session` / `SIAConn` |
| `end` | **reservada en SQL** | `end_time` |
| `start` | riesgosa y asimétrica con `end` | `start_time` |
| `order` | **reservada** | `number` |
| `user` | **reservada** | *(no se usa)* |
| `time` | choca con el paquete `time` de Go | `start_time`, `weekday` |
| `plan` | ambigua: plan de estudios vs `EXPLAIN` | `program` |

`section`, `program`, `term`, `shift`, `room`, `level`, `campus`, `faculty`, `credits`,
`name`, `raw`, `key` y `site` verificados: ninguna es reservada en Postgres. `key` y
`site` se probaron sin comillas contra Postgres 17 (decisión 8) — `key` es
*non-reserved* pese a aparecer en `PRIMARY KEY`. Si molesta a la vista, `section_key` es
un rename mecánico.

`section` además es el término académico estándar en inglés para lo que UNAL llama
"grupo".

---

## Las ocho decisiones no obvias

### 1. `typology` vive en `course_program`, no en `course`

Es relativa al plan de estudios. Si la cuelgas de `course`, la machacas cada vez que
scrapeas otra carrera.

**Confirmado.** De los 22 códigos presentes en más de uno de 15 planes de Bogotá,
**8 divergen** — `1000003-B` es `FUND. OBLIGATORIA (B)` en Ingeniería Agrícola y
`FUND. OPTATIVA (O)` en Biología. Ya no es una precaución barata: es el modelo correcto.
Ver [GOTCHAS.md §17](GOTCHAS.md).

### 2. `section` es global; `section_program` es la visibilidad

Verificado con `1000004-B` desde dos carreras:

```
Sistemas y Computación : 25 grupos
Industrial             : 23 grupos    ← subconjunto ESTRICTO
cupos de los 23 comunes: idénticos
```

Los grupos existen una vez (mismo profesor, horario, aula y cupos); cada plan ve el
subconjunto que tiene habilitado. Ver [GOTCHAS.md §16](GOTCHAS.md).

**Consecuencia buena:** una sola medición de cupos sirve para todos los planes.
`seat_snapshot` cuelga de `section`, no de `(section, program)`.

### 3. Dedupear el listado por código al parsear

Las filas repetidas tienen las 5 columnas idénticas y su detalle es byte-idéntico.
Son emparejamientos (asignatura × plan), no grupos. Ver [GOTCHAS.md §13](GOTCHAS.md).

### 4. `seat_snapshot` es append-only

No un `UPDATE` sobre la fila del grupo. Te da gratis el historial para alertas
(*"avísame cuando se libere un cupo"*) y para graficar cómo se llenó un grupo.
La vista `current_seats` sirve el último valor.

### 5. Dos caches con granularidad distinta

| Cache | Granularidad | Costo del miss | Volatilidad |
|---|---|---|---|
| catálogo | **por programa** | 1 POST → ~98 filas | casi nula |
| detalle + cupos | **por asignatura** | 1 POST → 1 asignatura | alta |

Un miss de catálogo de *cualquier* asignatura llena las ~98 del programa de una.
El detalle es irreductiblemente unitario: no hay forma de traer los grupos de varias
asignaturas en una petición.

`program.catalog_fetched_at` gobierna el primero; `section.fetched_at` y
`seat_snapshot.measured_at` el segundo.

### 6. Un hit de detalle es por `(code, program)`, no por `code`

Consecuencia directa de la decisión 2. El detalle cacheado tiene **dos capas con
validez distinta**:

| Capa | Válida para | Gobernada por |
|---|---|---|
| filas de `section` — profesor, horario, aula, cupos | **todos** los programas | `section.fetched_at`, `seat_snapshot.measured_at` |
| `section_program` — qué grupos ve este plan | **solo** los programas ya consultados | `course_program.detail_fetched_at` |

Concreto: se bajó `1000004-B` desde Sistemas (25 grupos). Llega una consulta de
Industrial. En Postgres están todos los grupos que Industrial *podría* ver — pero no
cuáles. Son 23 de 25 y no se sabe cuáles hasta preguntarle al SIA por Industrial.

Servir los 25 es el fallo silencioso del proyecto: datos plausibles, equivocados, y el
usuario intenta inscribir un grupo que su plan no habilita.

Por eso `detail_fetched_at` vive en `course_program`: es lo único que responde *"¿ya sé
qué ve este plan?"*. Un plan nuevo paga el POST otra vez aunque la asignatura ya esté —
es información que solo existe consultando ese plan.

**Compensación:** los cupos que devuelve ese POST son frescos para *todos* los planes.
La visibilidad se paga por plan; la medición se comparte.

### 7. El ID público no es el índice del dropdown

`0-2-8-3` son **posiciones** dentro de cada `<select>`, no códigos institucionales
([FIELDS.md](FIELDS.md)). Si la UNAL inserta una carrera, `soc3=3` pasa a apuntar a
otra — sin error, sin aviso.

Cada etiqueta trae el código institucional delante, y ese sí es estable:

```
1101 SEDE BOGOTÁ      2055 FACULTAD DE INGENIERÍA      2A74 INGENIERÍA DE SIST...
└──┘                  └──┘                             └──┘
```

Regla de parseo: primer token = código, resto = nombre.

| Entidad | ID público | Ejemplo |
|---|---|---|
| `level` | slug | `pregrado`, `doctorado`, `posgrado` |
| `campus` | código institucional | `1101` |
| `faculty` | código institucional | `2055` |
| `program` | `code` | `2A74`, `2546` |
| `course` | `code`, calificado por la sede del contexto | `2016696`, `1000003-B` |
| `section` | `(code, term, key)` | `key` = `1`, `AMAZ-07`, `TUMA-01` |
| `class_session`, `seat_snapshot` | ninguno — no direccionables | — |

**`program.code` NO es único entre sedes.** El censo completo (1380 entradas) lo
desmiente — ver [GOTCHAS.md §26](GOTCHAS.md):

```
code                                 852 claves · 136 colisiones
(campus_code, code)                 1333 claves ·  46 colisiones
(campus_code, faculty_code, code)   1380 claves ·   0 colisiones   ← identidad
```

Causa: PEAMA. `2A41 ADMINISTRACIÓN DE EMPRESAS` es el mismo código en Bogotá, Orinoquia,
Amazonia, Caribe y Tumaco. Y dentro de una sede el programa cuelga a la vez de su
facultad real y de una facultad comodín con código terminado en `000`.

Sigue sirviendo para desambiguar los nombres repetidos dentro de una sede (`2A74` y
`2879`, los dos "Ingeniería de Sistemas y Computación"): por nombre es imposible, por
código no.

**En la URL** el código va pelado solo mientras el alcance sea una sede (fase 1,
Bogotá). Al abrir a las demás hay que calificarlo —
`/v1/campuses/1101/programs/2A41` — o aceptar 300 en el atajo, igual que con
`course.code`. `PublicID()` no puede seguir devolviendo `p.Code` a secas.

**`course.code` no está verificado.** Por eso la PK es `(campus_code, code)` y no
`code` solo. Si resulta ser global, colapsarlo es borrar una columna; si es al revés
y ya está en producción, un `2016696` de Medellín hace UPSERT sobre el de Bogotá —
corrupción silenciosa, y la migración toca `course`, `course_program` y `section`.
Mismo razonamiento asimétrico que la decisión 1.

En la URL el código va pelado igual, porque la ruta canónica cuelga del programa y el
programa fija la sede:

```
/v1/programs/2A74/courses/2016696     ← sede implícita en 2A74
/v1/courses/2016696                   ← atajo; ambiguo por diseño, 300 si hay varios
```

`campus_code` es entonces un calificador del almacenamiento, no un segmento de ruta.

**Nunca en una URL:** `program_idx`, `campus_idx`, `faculty_idx`, `program.id`,
`section.id`, `_afrRK`.

**Revalidación.** Antes de usar `program_idx`, `SIASource` compara la etiqueta que está
en esa posición del dropdown contra el `code` guardado. Si no coincide, la UNAL
reordenó: se re-resuelve por código y se actualiza el índice. Sale gratis — las
opciones vienen en la respuesta de la cascada y hay que parsearlas igual.

---

### 8. La identidad de un grupo es el token entre paréntesis, no `Grupo N`

Lo que parecía obvio —`(1) Grupo 1` ⇒ `number = 1`— pierde grupos en silencio. Una
asignatura tiene a la vez grupos regulares y grupos PEAMA de otras sedes, y **la
numeración se repite entre ellos**:

```
1000004-B  Cálculo diferencial · 32 grupos
  (1) Grupo 1 · (2) Grupo 2 · … · (26) Grupo 26
  (AMAZ-01) Peama-Amazonia Grupo 1     ← number = 1 otra vez
  (AMAZ-07) Peama-Amazonia Grupo 1     ← y otra
  (TUMA-01) Peama - Tumaco - Grupo 1   ← y otra
  (CARI-01) Peama-Caribe Grupo 1       ← y otra
```

Medido sobre 88 grupos de 10 asignaturas:

| Clave | Valores distintos | Veredicto |
|---|---|---|
| `Grupo N` (`number`) | 78 de 88 | **pierde 10 grupos** |
| token entre paréntesis (`key`) | 88 de 88 | identidad |

Con `UNIQUE (campus_code, code, term, number)`, esos 10 grupos hacen UPSERT unos sobre
otros: la asignatura aparece con menos oferta de la que tiene, con horarios y cupos
mezclados. Es el fallo silencioso de siempre — datos plausibles, equivocados.

Comprobado en Postgres 17 con los 5 grupos reales de `1000004-B` que se llaman "Grupo 1"
(`1`, `AMAZ-01`, `AMAZ-07`, `TUMA-01`, `CARI-01`):

```
UNIQUE (term, key)     → 5 filas · 5 keys distintas · 1 number distinto   ✓
UNIQUE (term, number)  → 1 fila                                          ✗ 4 perdidas
```

`key` y `site` funcionan sin comillas como nombres de columna (`key` es *non-reserved*).

`number` se conserva porque es lo que el estudiante lee ("me inscribí al grupo 3"), pero
no es identidad. `site` (`AMAZ`, `TUMA`, `ORIN`, `CARI`, `SUMA`) sale del mismo token y
dice de qué sede es el grupo, dato que importa: un grupo PEAMA de Tumaco no es
inscribible desde Bogotá, aunque salga en el detalle consultado desde Bogotá.

Ver [GOTCHAS.md §24](GOTCHAS.md).

---

## Casos borde que el esquema debe soportar

| Caso | Ejemplo | Implicación |
|---|---|---|
| Asignatura sin oferta | `2027641` — 0 grupos | `course` sin `section`; la API distingue "no existe" de "sin oferta" |
| Grupo sin horario | `Horarios/Aula: No informado` | `section` sin `class_session` |
| Nombres de carrera repetidos | `2A74` y `2879`, ambos "Ing. Sistemas y Computación" | no resolver por nombre; identidad = `program.code` (decisión 7) |
| Mismo `course.code` en dos sedes | *no verificado* | PK `(campus_code, code)`; ver decisión 7 |
| Códigos con sufijo | `1000003-B`, `1000044-B` | `code` es `text`, no entero |
| Descripción vacía | varias filas | `description` nullable |
| Grupo PEAMA de otra sede | `(TUMA-01) Peama - Tumaco - Grupo 1`, `Facultad: SEDE TUMACO` | ~20 % de los grupos; identidad = `key`, no `number` (decisión 8) |
| Varios grupos con el mismo `Grupo N` | `1000004-B`: `(1)`, `(AMAZ-01)`, `(TUMA-01)`, `(CARI-01)`, todos "Grupo 1" | `UNIQUE (..., key)`; con `number` se pierden 10 de 88 |
| Mismo `program.code` en varias sedes | `2A41` en Bogotá, Orinoquia, Amazonia, Caribe y Tumaco | identidad `(campus_code, faculty_code, code)` (decisión 7) |
| Asignatura de libre elección del plan | no sale en el listado regular | se obtiene por el buscador de electivas ([GOTCHAS.md §21](GOTCHAS.md)) |
| Prerrequisitos y componentes | `Tipo M`, `CLASE TEORICA ...` | llegan gratis en el detalle; sin tabla todavía ([FIELDS.md](FIELDS.md)) |
