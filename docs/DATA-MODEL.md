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
    code        text PRIMARY KEY,          -- '2016696', '1000003-B'
    name        text NOT NULL,
    credits     int,
    description text,
    fetched_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE program (                     -- a degree program (UNAL "carrera")
    id           bigserial PRIMARY KEY,
    level        smallint NOT NULL,        -- soc1
    campus       smallint NOT NULL,        -- soc9
    faculty      smallint NOT NULL,        -- soc2
    program_idx  smallint NOT NULL,        -- soc3
    name         text,                     -- '2A74 INGENIERÍA DE SISTEMAS Y COMPUTACIÓN'
    catalog_fetched_at timestamptz,        -- drives the catalog cache TTL
    UNIQUE (level, campus, faculty, program_idx)
);

CREATE TABLE course_program (              -- M:N; typology lives HERE
    program_id bigint REFERENCES program(id) ON DELETE CASCADE,
    code       text   REFERENCES course(code) ON DELETE CASCADE,
    typology   text,                       -- 'FUND. OBLIGATORIA (B)'
    PRIMARY KEY (program_id, code)
);

-- ─── detail: expensive, one request per course ───────────────────
CREATE TABLE section (                     -- UNAL "grupo"
    id          bigserial PRIMARY KEY,
    code        text NOT NULL REFERENCES course(code) ON DELETE CASCADE,
    term        text NOT NULL,             -- '2026-2'
    number      int  NOT NULL,             -- from '(1) Grupo 1'
    label       text,                      -- 'Grupo 1'
    instructor  text,
    shift       text,                      -- 'DIURNO'
    duration    text,                      -- 'Semestral'
    start_date  date,
    end_date    date,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    raw         jsonb,
    UNIQUE (code, term, number)
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
    Code        string    `db:"code"        json:"code"`
    Name        string    `db:"name"        json:"name"`
    Credits     int       `db:"credits"     json:"credits"`
    Description string    `db:"description" json:"description,omitempty"`
    FetchedAt   time.Time `db:"fetched_at"  json:"fetched_at"`

    Sections []Section `json:"sections,omitempty"`
}

type Program struct {
    ID               int64      `db:"id"`
    Level            int        `db:"level"`
    Campus           int        `db:"campus"`
    Faculty          int        `db:"faculty"`
    ProgramIdx       int        `db:"program_idx"`
    Name             string     `db:"name"`
    CatalogFetchedAt *time.Time `db:"catalog_fetched_at"`
}

// ProgramKey is the navigation coordinate inside SIA: "0-2-8-3".
type ProgramKey struct{ Level, Campus, Faculty, Program int }

func (k ProgramKey) String() string {
    return fmt.Sprintf("%d-%d-%d-%d", k.Level, k.Campus, k.Faculty, k.Program)
}

type Section struct {
    ID         int64      `db:"id"         json:"-"`
    Code       string     `db:"code"       json:"-"`
    Term       string     `db:"term"       json:"term"`
    Number     int        `db:"number"     json:"number"`
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
    inDetail  bool        // true → must click Back before any region-0 action
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
`name` y `raw` verificados: ninguna es reservada en Postgres.

`section` además es el término académico estándar en inglés para lo que UNAL llama
"grupo".

---

## Las cinco decisiones no obvias

### 1. `typology` vive en `course_program`, no en `course`

Es relativa al plan de estudios. Si la cuelgas de `course`, la machacas cada vez que
scrapeas otra carrera.

**No confirmado** que varíe entre carreras — `1000004-B` es `FUND. OPTATIVA` tanto en
Sistemas como en Industrial. Se deja aquí porque revertirlo después es trivial y al
revés no. Ver [GOTCHAS.md §17](GOTCHAS.md).

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

---

## Casos borde que el esquema debe soportar

| Caso | Ejemplo | Implicación |
|---|---|---|
| Asignatura sin oferta | `2027641` — 0 grupos | `course` sin `section`; la API distingue "no existe" de "sin oferta" |
| Grupo sin horario | `Horarios/Aula: No informado` | `section` sin `class_session` |
| Nombres de carrera repetidos | `2A74` y `2879`, ambos "Ing. Sistemas y Computación" | no resolver por nombre; guardar índice + nombre |
| Códigos con sufijo | `1000003-B`, `1000044-B` | `code` es `text`, no entero |
| Descripción vacía | varias filas | `description` nullable |
