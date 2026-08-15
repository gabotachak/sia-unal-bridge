# Arquitectura

API puente sobre el catálogo del SIA. Traduce la navegación con estado de Oracle ADF
a JSON.

El código va en inglés; esta documentación en español.

---

## Premisa

Casi toda la información cambia muy poco: códigos, nombres, créditos, descripciones y
horarios se fijan al abrir el semestre. **Lo único volátil son los cupos.**

Consultar el SIA en cada request daría una API de 10 s. Cachear no es una optimización:
es la condición para que esto sea usable.

Pero la frontera no está donde parecía. Los cupos **no vienen solos**:

| Dato | De dónde sale | Costo |
|---|---|---|
| código, nombre, créditos, tipología, descripción | listado (`cb1`) | 1 POST → ~98 asignaturas |
| grupo, profesor, horario, aula, jornada, **cupos** | detalle (click) | 1 POST → 1 asignatura |

Verificado: una respuesta de listado de 241 KB con 98 filas tiene **cero** ocurrencias
de `Cupos disponibles`.

Así que la partición real es **catálogo vs detalle**, no *cupos vs todo lo demás*.
Cada refresco de cupos trae horarios y profesor gratis, en el mismo response.

---

## Puertos y adaptadores

```
                        ┌───────────────────────────────┐
   HTTP / JSON          │                               │
  ────────────────────> │          dominio              │
      (driving)         │   course · section · seats    │
                        │                               │
                        └───┬───────────────────────┬───┘
                            │ (driven)              │ (driven)
                            v                       v
                     ┌─────────────┐        ┌───────────────┐
                     │    Store    │        │   SIASource   │
                     │  Postgres   │        │  Oracle ADF   │
                     └─────────────┘        └───────────────┘
                            ^
                            │ (driving)
                     ┌──────┴───────┐
                     │   Refresher  │  ← cron/worker, fase 2
                     └──────────────┘
```

| Puerto | Dirección | Responsabilidad |
|---|---|---|
| `API` | driving | expone JSON, traduce a casos de uso |
| `Store` | driven | persistencia y cache (Postgres) |
| `SIASource` | driven | todo lo que toca el SIA real |
| `Refresher` | driving | llena la cache proactivamente — **aplazado** |

`Refresher` está en el diagrama pero no en la fase 1: la cache se llena sola con el
uso. Cuando se implemente, el adaptador de `SIASource` ya estará probado.

---

## Flujo principal: read-through

```
GET /courses/2016696
        │
        ├── ¿está en Store y fresco?  ──sí──> responde
        │
        └── no
              │
              ├── SIASource: navega, parsea      ~1.3 s caliente / ~10 s frío
              ├── responde al cliente
              └── persiste en Store
```

El cliente espera en el miss. Con los números medidos es aceptable, y el segundo
consumidor de esa carrera ya tiene hit.

### Granularidad del miss

Un miss **no llena una fila**: llena lo que el SIA devolvió al mismo costo.

```
miss de catálogo  →  cb1 sin filtro  →  se guardan las ~98 del programa   ~5 s
miss de detalle   →  click           →  se guarda 1 asignatura            ~1 s
```

Gobernado por `program.catalog_fetched_at` y `section.fetched_at`.

---

## Cupos

Dos rutas, a propósito:

| Endpoint | Comportamiento |
|---|---|
| `GET /courses/{code}` | sirve de cache, con `measured_at` y edad explícita |
| `GET /courses/{code}/seats` | fuerza consulta al SIA, refresca y persiste |

```json
{ "section": 1, "available": 32, "measured_at": "2026-08-15T16:22:03Z", "age_seconds": 47 }
```

Nunca se sirve un cupo sin decir de cuándo es.

El endpoint "en vivo" cuesta exactamente lo mismo que traer el detalle completo,
porque llegan juntos. Aprovecha: **refresca y guarda todo el grupo**, devuelve solo
los cupos. Sale gratis y mantiene la cache caliente.

`seat_snapshot` es append-only. El historial habilita alertas más adelante sin
rediseñar nada.

---

## SIASource es un pool, no un cliente

No es un cliente HTTP sin estado. Es un **pool de sesiones ADF vivas**, y cada una:

- muere a los 5 min de inactividad
- es **estrictamente secuencial**: una petición en vuelo a la vez
- está *parqueada* en un `(level, campus, faculty, program)`; moverla cuesta 2 POSTs
- está en la región del buscador **o** en la del detalle; salir cuesta 1 POST
- renumera sus `_afrRK` en cada re-render → hay que re-parsear, nunca cachear índices

```go
type SIAConn struct {
    viewState string
    jar       *cookiejar.Jar
    parkedAt  ProgramKey   // cascada ya hecha para este programa
    inDetail  bool         // true → hay que hacer Back antes de nada
    lastUsed  time.Time
}
```

Esos dos campos de estado son los que ahorran POSTs: si la conexión ya está en el
programa pedido y no está en detalle, son 2 POSTs en vez de 6.

**Fase 1:** pool de 1-2 conexiones con mutex. Suficiente para uso personal y no
encierra en nada.

### Rutas mínimas medidas

| Escenario | POSTs | Tiempo |
|---|---|---|
| Frío, sin sesión | 1 GET + 6 | ~10 s |
| Caliente, mismo programa, tras búsqueda | 2 | **~1.3 s** |
| Caliente, mismo programa, tras detalle | 3 | ~1.8 s |
| Caliente, otro programa misma facultad | 3 | ~1.5 s |

Usar el filtro `it11` (nombre) baja el payload de 241 KB a 15–27 KB.

---

## Alcance

**Fase 1** — Bogotá (`campus=2`), pregrado (`level=0`).

- read-through de catálogo y detalle
- endpoint de cupos en vivo
- pool de 1-2 conexiones

**Después**

- `Refresher`: crawl inicial y polling. El crawl con detalle de todas las carreras son
  horas (1 POST por asignatura); diseñarlo resumible con checkpoint por programa.
- Otras sedes: `campus` ya está en el esquema, es iterar.
- Alertas de cupo: el historial de `seat_snapshot` ya lo soporta.

---

## Restricciones heredadas del SIA

Salen de [docs/GOTCHAS.md](docs/GOTCHAS.md). Estas condicionan el diseño, no son
detalles de implementación:

| Restricción | Impacto |
|---|---|
| El User-Agent no puede parecer navegador | el default de Go sirve; no "mejorarlo" |
| Sesión muere a los 5 min | keepalive o re-bootstrap; el pool lo gestiona |
| Bootstrap cuesta 7 s y 1.1 MB | una vez por sesión, jamás por request |
| Conexión estrictamente secuencial | N requests concurrentes ⇒ N conexiones |
| `_afrRK` se renumera en cada re-render | re-parsear siempre; nunca cachear índices |
| Sin cascada completa el botón es no-op silencioso | ~900 B = error, tratar como tal |
| Los grupos visibles dependen del programa | `section_program`; una consulta ≠ el universo |
| Los cupos son globales | una medición sirve para todos los programas |

---

## Modelo de datos

En [docs/DATA-MODEL.md](docs/DATA-MODEL.md): esquema SQL, structs de Go, palabras
reservadas evitadas y los casos borde que hay que soportar.

Resumen:

```
course ─┬─ course_program ── program
        └─ section ─┬─ section_program ── program
                    ├─ class_session
                    └─ seat_snapshot        (append-only)
```

Clave natural de una oferta: `(code, term, number)`. Nunca `code` solo — el listado
devuelve ofertas, no asignaturas.
