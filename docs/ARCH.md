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
                     │   Refresher  │  ← cron, POOL PROPIO (fase 2)
                     └──────────────┘
```

| Puerto | Dirección | Responsabilidad |
|---|---|---|
| `API` | driving | expone JSON, traduce a casos de uso |
| `Store` | driven | persistencia y cache (Postgres) |
| `SIASource` | driven | todo lo que toca el SIA real |
| `Refresher` | driving | llena la cache proactivamente — **implementado (fase 2)** |

`Refresher` entra por los **mismos casos de uso** que `httpapi` (`catalog.Service`) y no
escribe en la base por su cuenta: si lo hiciera habría dos implementaciones del upsert de
catálogo y la segunda se desincronizaría en la primera corrección de bug. La única
diferencia entre un fetch del job y uno de un cliente es **quién lo pidió**
([FASE-2.md](FASE-2.md)).

### El pool del job es suyo, no el de la API

`cmd/refresher` levanta **su propio pool**. Compartirlo sería servir `503 busy` —el error
que [API.md](API.md) reserva para picos— durante las horas que dura un barrido de detalle.
La invariante que no se negocia es el techo medido: 80 conexiones concurrentes limpias,
88 ya degrada (~4.5% de fallas — [OPEN-QUESTIONS.md §5](OPEN-QUESTIONS.md), medido
2026-08-19). Los valores por defecto de `api` y `refresher` se quedan muy por debajo de
eso a propósito — el tráfico real no lo pide, esto solo fija cuánto margen hay antes del
borde:

```
conexiones(api) + conexiones(refresher) ≤ 80
   4 (api, por defecto)  +  2 (refresher)  =  6   ← operación normal
   4                     +  4              =  8   ← ventana de mantenimiento
```

Coste aceptado: dos procesos no comparten `singleflight`, así que el job y un cliente
pueden pedir la misma asignatura a la vez y gastar dos POSTs en vez de uno. Es
desperdicio, no incorrección — los upserts son idempotentes.

---

## Flujo principal: read-through

```
GET /v1/campuses/1101/programs/2A74/courses/2016696
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

**El catálogo de un plan son dos consultas, no una.** `soc4=0` significa "todas menos
libre elección" ([GOTCHAS.md §21](GOTCHAS.md)), así que las libres del plan no
están en esas ~98 filas: salen del buscador de electivas, que es por sede y no por plan.
Si `catalog_fetched_at` solo cubre la primera, la cache queda plausible e incompleta.

---

## Cupos

Un solo concepto de frescura, `?max_age=<segundos>`, con default por tipo de recurso.
`?max_age=0` fuerza la consulta al SIA. Contrato completo en [docs/API.md](API.md).

```json
{ "key": "1", "number": 1, "available": 32, "measured_at": "2026-08-15T16:22:03Z", "age_seconds": 47 }
```

Nunca se sirve un cupo sin decir de cuándo es.

Forzar los cupos cuesta exactamente lo mismo que traer el detalle completo, porque
llegan juntos. Aprovecha: **refresca y guarda todo el grupo**, devuelve solo los cupos.
Sale gratis y mantiene la cache caliente.

`seat_snapshot` es append-only. El historial habilita alertas más adelante sin
rediseñar nada.

---

## SIASource es un pool, no un cliente

No es un cliente HTTP sin estado. Es un **pool de sesiones ADF vivas**, y cada una:

- muere a los **~4.2 min** de inactividad — renovable con tráfico; keepalive ≤3 min
- es **estrictamente secuencial**: una petición en vuelo a la vez — y el servidor no lo
  impone, así que el mutex es tuyo ([GOTCHAS §28](GOTCHAS.md))
- está *parqueada* en un `(level, campus, faculty, program)`; moverla cuesta 2 POSTs
- está en la región del buscador **o** en una región de detalle **numerada**; salir
  cuesta 1 POST *al id correcto*
- renumera sus `_afrRK` en cada re-render → hay que re-parsear, nunca cachear índices

```go
type SIAConn struct {
    viewState    string
    jar          *cookiejar.Jar
    parkedAt     ProgramKey // cascada ya hecha para este programa
    detailRegion int        // 0 = en el buscador; >0 = región de detalle abierta.
                            // Volver es pt1:r1:<detailRegion>:cb4 y el número
                            // sube con cada detalle. Ver GOTCHAS.md §20.
    lastUsed     time.Time
}
```

`detailRegion` no es un booleano por una razón cara: con `pt1:r1:1:cb4` fijo, el
segundo detalle de la sesión deja la conexión inservible y **parece** una sesión
caducada. Con el índice leído de la respuesta: 98 asignaturas seguidas, 99 s, sin un
solo atasco.

Esos campos de estado son los que ahorran POSTs: si la conexión ya está en el programa
pedido y no está en detalle, son 2 POSTs en vez de 6.

**Fase 1:** pool de **4** conexiones, cada una con su mutex. Medido: hasta 80 sesiones
concurrentes dan 0 errores, 0 throttling y latencia plana (la búsqueda tarda lo mismo
con N=1 que con N=80); en 88 ya aparece ~4.5% de fallas (OPEN-QUESTIONS.md §5). Con 1-2
el `503 busy` salta con dos pestañas abiertas. El pool por defecto se queda en 4 porque
el tráfico real no pide más, no porque el servidor lo exija. Ver *Concurrencia*.

### Concurrencia: entre conexiones, nunca dentro de una

"Estrictamente secuencial" dejó de ser una suposición heredada. Medido: el SIA **no
rechaza** dos peticiones simultáneas sobre la misma sesión — devuelve `200 OK` y le da a
un hilo la respuesta del otro ([GOTCHAS §28](GOTCHAS.md)).

```
2 búsquedas idénticas, misma conexión → las dos correctas
2 programas distintos, misma conexión → ambas devuelven el catálogo del MISMO programa
2 detalles, misma conexión            → uno gana, el otro recibe 895 B
```

El segundo caso es el peligroso: respuesta equivocada, bien formada, indetectable desde
el cliente. Y no se arregla poniendo un mutex en cualquier sitio:

```
    correcto                        roto
    lock                            lock; POST soc3; unlock
      POST soc3                     lock; POST cb1;  unlock
      POST cb1                      ↑ otra operación se cuela aquí
    unlock
```

**El mutex envuelve la operación lógica** —cascada+`cb1`, detalle+`Volver`—, no el POST.

Con eso, las goroutines se ganan su sitio en cuatro puntos y solo en cuatro:

| Uso | Justificación medida |
|---|---|
| Pool como `chan *SIAConn` | canal con buffer = pool acotado; `select` con `ctx.Done()` da el `503 busy` de [API.md](API.md) |
| Keepalive | una goroutine con ticker para todo el pool: ping ≤3 min mantiene la sesión 30 min; 5 min de silencio la mata |
| Auto-reparación | `Pool.Do` re-bootstrapea y reintenta una vez ante un no-op: una sesión ADF muerta no revive sola |
| `singleflight` | con pool chico es lo que evita que 3 clientes en frío hagan 3 × 10 s en cola |
| `Refresher` | `errgroup` con `SetLimit(W)` sobre la lista de **programas** — una goroutine por programa, nunca por asignatura: la conexión queda parqueada y repartir sus 98 asignaturas reabre §30/§31/§33. `errgroup` se usa **solo** por `SetLimit`: los errores se acumulan en el `Report`, porque un no-op no puede matar un barrido de nueve horas |

Dos trampas propias de este proyecto:

- **Write-behind con el contexto de la request.** El read-through responde y *luego*
  persiste. Si eso corre en una goroutine con el `Context` de la request, se cancela al
  volver el handler y la escritura se pierde en silencio. Usa `context.WithoutCancel`.
- **Bootstraps en fan-out.** Es la operación cara y variable (hasta 4.5 MB): arrancar 8
  a la vez son ~35 MB de golpe. Escalona el llenado del pool en frío.
- **Un ticker de 3 min no basta para un umbral de 4.2 min.** Una conexión liberada un
  segundo después de un tick tiene 2 min 59 s en el siguiente, no llega al mínimo y
  muere antes del tick posterior. El ticker corre cada 45 s y pinga todo lo que lleve
  ≥2 min parado. Y el ping tiene que *mirar* la respuesta: un no-op de ~900 B no es un
  ping exitoso, es la sesión muerta. Sin eso el pool se queda con cuatro conexiones
  zombis devolviendo `sia_noop` a todo hasta reiniciar el proceso.
- **Toda conexión necesita ping, esté parqueada o no.** El timeout es de la sesión, no
  de la cascada: una conexión que solo sirvió dropdowns muere igual.

**Tamaño del pool en fase 1: 4.** Con 1-2 devuelves `503` en cuanto hay dos pestañas
abiertas. El techo por arriba es **80: el óptimo medido** (rampa contra producción
2026-08-19, [OPEN-QUESTIONS §5](OPEN-QUESTIONS.md)) — 100 % de aciertos y latencia p50
plana hasta ahí, y 88 ya degrada ~4.5 %. 4 es lo que pide el tráfico de hoy, no un
límite; subirlo hasta 80 menos lo que use el `Refresher` es una decisión de
configuración, no de diseño.

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

**Todas las sedes y todos los niveles.** No hay sede ni nivel privilegiado en el
código: las dos listas salen de sus dropdowns (`soc1`, `soc9`), se cachean como
cualquier otra referencia, y la conversión de código público a índice de dropdown se
hace en un solo sitio (`catalog.Service.coordinates`) leyendo esa cache. Un `campus=`
desconocido es `404`, nunca un silencioso "te doy Bogotá".

Lo único con default es el nivel (`pregrado`), y es un default de producto —qué vista
sirve la API si el cliente no dice nada—, no un supuesto estructural. Para sede no hay
default ni forma de omitirla: es un segmento obligatorio de la ruta,
`/v1/campuses/{campus}/…`.

- read-through de catálogo y detalle
- endpoint de cupos en vivo
- pool de 4 conexiones (ver *Concurrencia*)

Verificado en vivo contra Bogotá, Medellín y Amazonia.

**Fase 2 — `Refresher`** (`internal/refresher` + `cmd/refresher`, ver
[FASE-2.md](FASE-2.md))

- Cuatro modos con cadencias distintas: `reference` (mensual), `catalog` (semanal),
  `detail --scope=global` (diario) y `seats --scope=hot` (cada 15 min, solo en
  inscripciones). Medido 2026-08-17: la referencia completa son **131 POSTs / 72 s** y
  deja 1380 entradas de programa; el catálogo de un plan, ~13 POSTs.
- **El checkpoint son los marcadores de frescura**, no un cursor: reanudar es volver a
  correr, y dos corridas seguidas no hacen ni un POST.
- Un `pg_try_advisory_lock` por modo evita que dos corridas se solapen.

**Después**

- Otras sedes: `campus` ya está en el esquema, es iterar.
- Alertas de cupo: el historial de `seat_snapshot` ya lo soporta.

---

## Restricciones heredadas del SIA

Salen de [docs/GOTCHAS.md](GOTCHAS.md). Estas condicionan el diseño, no son
detalles de implementación:

| Restricción | Impacto |
|---|---|
| El User-Agent no puede parecer navegador | el default de Go sirve; no "mejorarlo" |
| Sesión muere a los ~4.2 min | keepalive ≤3 min o re-bootstrap; el pool lo gestiona |
| Bootstrap cuesta entre 0.15 s/52 KB y 7 s/4.5 MB | una vez por sesión, jamás por request |
| **Una conexión concurrente devuelve la respuesta de otro hilo** | mutex por conexión sobre la operación lógica; N requests ⇒ N conexiones |
| **La región de detalle está numerada y sube** | `detailRegion` en la conexión; con id fijo la 2.ª asignatura la mata |
| `_afrRK` se renumera en cada re-render | re-parsear siempre; nunca cachear índices |
| Sin cascada completa el botón es no-op silencioso | ~900 B = error, tratar como tal |
| Los grupos visibles dependen del programa | `section_program`; una consulta ≠ el universo |
| Los cupos son globales | una medición sirve para todos los programas |
| **`soc4=0` excluye libre elección** | el catálogo de un plan son 2 consultas, no 1 |
| **`program.code` no es único entre sedes** | identidad `(campus, faculty, code)` |

---

## Modelo de datos

En [docs/DATA-MODEL.md](DATA-MODEL.md): esquema SQL, structs de Go, palabras
reservadas evitadas y los casos borde que hay que soportar.

Resumen:

```
course ─┬─ course_program ── program
        └─ section ─┬─ section_program ── program
                    ├─ class_session
                    └─ seat_snapshot        (append-only)
```

Clave natural de una oferta: `(code, term, key)`, con `key` = el token entre
paréntesis de la cabecera del grupo (`1`, `AMAZ-07`, `TUMA-01`); `Grupo N` solo se
repite dentro de la misma asignatura. Nunca `code` solo — el listado
devuelve ofertas, no asignaturas.
