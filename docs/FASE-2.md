# Fase 2 — `Refresher`: el Job que baja todo el SIA

Cómo se llena la cache **sin** que un cliente pague el miss. La fase 1 dejó el
read-through funcionando: la cache crece con el uso, y lo que nadie pidió no existe.
Este documento define el proceso que recorre el catálogo entero, en serie si hace falta,
y deja Postgres poblado antes de que alguien pregunte.

Mismo formato que [`PLAN.md`](PLAN.md): pasos con criterio de aceptación. La
justificación de cada número vive en el documento que lo midió; aquí solo está el
enlace.

> **Estado: implementada y verificada contra producción el 2026-08-17.**
> `internal/refresher` + `cmd/refresher`, migración `00002`, los cuatro modos, `/v1/status`
> y el crontab de `deploy/cron.d/sia-refresher`. Lo medido y las desviaciones respecto a
> este plan están al final, en [Resultado](#resultado-2026-08-17).

| Documento | Para qué lo abres |
|---|---|
| [`GOTCHAS.md`](GOTCHAS.md) | **§28, §30, §31, §33 son las que rompen un crawler** |
| [`ARCH.md`](ARCH.md) | el puerto `Refresher` del diagrama es esto |
| [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) | de dónde salen 1380, 99 s y 31 MB |
| [`API.md`](API.md) | los TTL que este job tiene que sostener |
| [`DATA-MODEL.md`](DATA-MODEL.md) | `seat_snapshot` append-only y sus consecuencias |

---

## Qué es y qué no es

**Es** un adaptador *driving*, como `httpapi`. Entra por los mismos casos de uso
(`catalog.Service`) y deja que el read-through de fase 1 haga el trabajo: navegar,
parsear, persistir, marcar frescura.

**No es** un segundo camino a Postgres. El `Refresher` **no escribe en la base**. Si
escribiera por su cuenta habría dos implementaciones del upsert de catálogo —
"las dos mitades en una transacción" ([GOTCHAS §21](GOTCHAS.md)) — y la segunda se
desincronizaría de la primera en la primera corrección de bug. La única diferencia
entre un fetch del job y uno de un cliente es **quién lo pidió**.

```
   cron / systemd timer
          │
          v
   ┌──────────────┐        mismos puertos, mismos casos de uso
   │  Refresher   │ ─────────────────┐
   └──────────────┘                  │
                                     v
   ┌──────────────┐          ┌───────────────┐
   │   httpapi    │ ───────> │ catalog.Service│ ──> Store · SIASource
   └──────────────┘          └───────────────┘
```

Consecuencia práctica: cualquier bug de persistencia que el job destape es un bug que
la API también tenía. Eso es una feature.

---

## Punto de partida

Lo que ya existe y no hay que volver a construir:

- `catalog.Service` con read-through, `singleflight` y frescura por recurso.
- `sia.Pool` con keepalive, auto-reparación y mutex por operación lógica.
- `sia.Source` con las dos cascadas, el comodín por sede (§32) y el arreglo de §33.
- `store` con upserts idempotentes de catálogo, detalle, visibilidad y cupos.
- Los marcadores de frescura: `program.catalog_fetched_at`,
  `course_program.detail_fetched_at`, `section.fetched_at`, `seat_snapshot.measured_at`
  (el de cupos pasó a ser `section.seats_checked_at` en el paso 6 — ver *Cupos*).

Lo que **no** existe y esta fase agrega: enumeración masiva, control de concurrencia
propio, límite de tasa propio, cadencia y observabilidad de corridas.

---

## Dimensionado: la aritmética antes que el código

Todo sale de mediciones de [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md). Lo **derivado**
está marcado como tal.

| Magnitud | Valor | Origen |
|---|---|---|
| Entradas de programa en toda la UNAL | **1380** (852 códigos, 112 facultades) | medido, 142 POSTs / 78 s |
| Un programa con detalle completo (98 asignaturas) | **201 POSTs · 99 s · 31 MB** | medido |
| POSTs por asignatura | **~2** (`cb1` de `findRow` + el detalle) | derivado de lo anterior |
| Peso del `cb1` sin filtrar | 241 KB | medido |
| Peso del `cb1` con filtro `it11` | **15–27 KB** | medido ([§19](GOTCHAS.md)) |
| Peso de una respuesta de detalle | ~48 KB | medido ([§9](GOTCHAS.md)) |
| Bootstrap de una conexión | 0.15–7 s, hasta 4.5 MB | medido ([§25](GOTCHAS.md)) |
| Conexiones concurrentes que el SIA aguanta | **8**, sin errores ni throttling | medido |

Y de ahí, el coste de cada barrido posible (derivado; **serial** = 1 worker):

| Barrido | Unidades | POSTs | Tiempo serial | Volumen |
|---|---|---|---|---|
| Referencia (niveles, sedes, directorios) | 1 | 142 | **78 s** | ~30 MB |
| Catálogo de **todos** los programas | 1380 | ~2 760 | **~2.7 h** | ~0.7 GB |
| Detalle **global** (una vez por asignatura) | ~8–10 k * | ~20 k | **~3 h** | ~0.7 GB * |
| Detalle **por plan** (visibilidad completa) | ~135 k | ~270 k | **~38 h** | ~9 GB * |

\* con el filtro `it11` puesto (paso 3). Sin él, el detalle por plan son **42 GB**. El
`8–10 k` es una estimación: el número exacto se conoce **gratis** después del barrido de
catálogo, con un `SELECT count(*) FROM course`. No comprometas 38 horas antes de haberlo
mirado.

Dos lecturas que mandan sobre todo el diseño:

1. **El barrido de catálogo es barato y el de detalle no.** Un factor de ~14 entre uno y
   otro. Se corren con cadencias distintas y hasta con estrategias distintas.
2. **El `cb1` de `findRow` es el que pesa, no el detalle.** 241 KB contra 48 KB, dos
   veces por asignatura. Bajarlo con `it11` es la única optimización de esta fase que
   vale un factor de 4 en ancho de banda.

> `it11` baja los **bytes**, no el **reloj**. La búsqueda tarda 0.5–0.9 s pase lo que
> pase (medido, y no se degrada con N). Las ~38 h del barrido completo siguen siendo
> ~38 h; lo que cae de 42 GB a 9 GB es lo que la UNAL nos regala.

---

## La decisión central: cobertura global vs cobertura por plan

Es la pregunta de "cómo abarcar toda la info", y tiene una respuesta que el esquema ya
soporta sin cambios.

El detalle cacheado tiene **dos capas con validez distinta**
([DATA-MODEL, decisión 6](DATA-MODEL.md)):

| Capa | Vale para | Coste de conseguirla completa |
|---|---|---|
| filas de `section` — profesor, horario, aula, **cupos** | **todos** los planes | ~10 k POSTs, **~3 h** |
| `section_program` — qué grupos ve **este** plan | solo el plan consultado | ~270 k POSTs, **~38 h** |

Los cupos son globales ([§16](GOTCHAS.md)): una medición sirve para toda la
universidad. Los grupos visibles no.

**Estrategia:** el barrido por defecto es el **global** — una asignatura, un POST, desde
cualquier plan que ya la tenga en `course_program`. Da el 90 % del valor (todos los
horarios, todos los profesores, todos los cupos de toda la UNAL) por el 7 % del coste.
El barrido **por plan** queda para una lista corta de programas prioritarios y para la
carga inicial de semestre.

Y no miente, que es lo que lo hace aceptable: `UpsertDetail` solo estampa
`course_program.detail_fetched_at` **del plan que hizo el POST**. Un plan que el job no
recorrió sigue apareciendo como "nunca consultado" y su primera petición dispara el
read-through, igual que hoy. La API no cambia de contrato; solo deja de tener misses.

---

## Dónde vive el código

Según [`LAYOUT.md`](LAYOUT.md), que ya lo reservó:

```
internal/refresher/
├── refresher.go     # Run(ctx, Options): orquesta un barrido y devuelve un Report
├── plan.go          # enumera el trabajo: qué programas, qué asignaturas, en qué orden
├── worker.go        # errgroup acotado, límite de tasa, presupuesto de tiempo
├── modes.go         # reference · catalog · detail · seats
├── hotset.go        # selección por demanda para el barrido de cupos
└── report.go        # contadores, errores agregados, circuit breaker

cmd/refresher/main.go  # wiring: config → store → pool propio → Service → Refresher
```

`internal/refresher` importa `internal/catalog` y nada más de infraestructura. Es un
adaptador driving: puede importar el dominio, no puede importar `sia` ni `store`. El
test de la invariante del hexágono se extiende a él.

### Puertos que hay que ampliar

Son tres métodos nuevos, y cada uno tiene una razón medida:

```go
// catalog.Store
//
// CoursesNeedingDetail devuelve los códigos del programa cuyo detalle GLOBAL
// (max(section.fetched_at) de la asignatura) falta o es más viejo que maxAge.
// Es el filtro que hace que el barrido global cueste 3 h y no 38.
CoursesNeedingDetail(ctx context.Context, programID int64, maxAge time.Duration) ([]string, error)

// SeatsHotSet devuelve las asignaturas más pedidas por clientes reales de una
// sede, con un plan que ya las ve, ordenadas por demanda. docs/API.md no puede
// sostener el TTL de 5 min sobre 1380 programas; sobre 300 asignaturas sí.
SeatsHotSet(ctx context.Context, campusCode string, limit int) ([]CourseRef, error)

// RecordDemand cuenta que un CLIENTE (no el job) pidió esta asignatura.
// Lo llama httpapi, que es el único que sabe que hay alguien del otro lado.
RecordDemand(ctx context.Context, campusCode, code string) error
```

Y uno en `SIASource`, que es el que justifica el paso 4:

```go
// FetchDetails trae el detalle de varias asignaturas del MISMO programa sobre
// UNA sola conexión, invocando yield por cada resultado para que el llamador
// persista de forma incremental. No ahorra el cb1 por asignatura — los _afrRK
// se renumeran tras cada Volver (§4) y cachearlos es el bug que mató al
// proyecto anterior — pero sí ahorra el reparqueo entre asignaturas y cierra
// la puerta a §30/§31/§33, que es donde un crawler se rompe en silencio.
FetchDetails(ctx context.Context, key ProgramKey, codes []string, term string,
    yield func(CourseOffering, error) error) error
```

---

## Concurrencia: dónde se ganan su sitio las goroutines

Mismo criterio que [`ARCH.md`](ARCH.md): una goroutine por motivo medido, no por
costumbre.

| Uso | Justificación |
|---|---|
| `errgroup` con `SetLimit(W)` sobre la **lista de programas** | W goroutines, una por conexión disponible. Más goroutines no aceleran nada: se quedan bloqueadas en `Pool.Acquire`, que es el verdadero semáforo |
| Una goroutine **por programa**, nunca por asignatura | localidad. La conexión queda parqueada en el programa; repartir sus 98 asignaturas entre workers reparquea en cada una y reabre §30/§31/§33 |
| `pool.Keepalive` en su propia goroutine | igual que en `cmd/bridge`: la sesión muere a los ~4.2 min y un barrido tiene huecos (transacciones largas, esperas del limitador) |
| `rate.Limiter` compartido por los workers | techo de POSTs/s del job entero, para que no compita con la API por el pool. Ver *Cadencia* |
| `signal.NotifyContext` + `ctx` que atraviesa todo | parar en cualquier punto es seguro porque el checkpoint está en la base |

### El pool del job es suyo, no el de la API

El barrido de detalle ocupa sus conexiones durante horas. Si comparte pool con
`cmd/bridge`, **todas** las peticiones de usuarios reales compiten con él y devuelven
`503 busy` — el error que `API.md` reserva para picos, servido durante nueve horas
seguidas.

`cmd/refresher` levanta **su propio pool**, y la invariante que no se negocia:

```
conexiones(api) + conexiones(refresher) ≤ 80      ← el techo medido (OPEN-QUESTIONS.md §5)
   4 (api, por defecto)  +  2 (refresher)  =  6   ← operación normal
   4                     +  4              =  8   ← ventana de mantenimiento, API ociosa
```

80 es el óptimo medido: rampa contra producción (2026-08-19), 100% de aciertos y
latencia p50 plana hasta 80, y 88 concurrentes ya rompe ~4.5% de las peticiones. Los
valores por defecto de arriba se quedan chicos frente a ese techo porque el trabajo de
hoy cabe de sobra, no porque el techo sea otro.

**Coste aceptado:** dos procesos no comparten `singleflight`, así que el job y un
cliente pueden pedir la misma asignatura a la vez y gastar dos POSTs en vez de uno. Es
desperdicio, no incorrección: los upserts son idempotentes. Si alguna vez molesta, el
`singleflight` entre procesos es un `pg_try_advisory_lock` sobre
`hashtext(program_id || ':' || code)`; hoy no vale el código.

### Cuatro antipatrones que este job invita a cometer

1. **`errgroup` que cancela todo al primer error.** Es su comportamiento normal y aquí
   está mal: un no-op en un programa no puede matar un barrido de nueve horas. La
   función que se pasa a `Go` devuelve `nil` **siempre**, salvo cancelación del
   contexto; los errores se acumulan en el `Report`. `errgroup` se usa solo por
   `SetLimit`.
2. **Paralelizar dentro de un programa.** Reproduce [§28](GOTCHAS.md): dos peticiones
   sobre la misma conexión devuelven `200 OK` con la respuesta del otro hilo. Bien
   formada, plausible, equivocada.
3. **Cargar el trabajo entero en memoria.** 1380 programas son nada, pero sus catálogos
   parseados no. Se enumera por programa y se descarta al terminar cada uno.
4. **Fan-out de bootstraps.** Hasta 4.5 MB cada uno ([§25](GOTCHAS.md)). `sia.NewPool`
   ya los hace en serie; no lo "optimices" al armar el pool del job.

### El checkpoint ya existe: no inventes un cursor

La tentación es una tabla `crawl_cursor` con "voy por el programa 412". No hace falta y
sería peor: un cursor puede desincronizarse de los datos, y entonces el job cree que
terminó algo que no terminó.

**Los marcadores de frescura SON el checkpoint.** El job no pregunta "¿dónde me quedé?"
sino "¿qué sigue viejo?". De ahí salen cuatro propiedades gratis:

- **Resumible.** Reanudar es volver a correr.
- **Idempotente.** Correrlo dos veces seguidas: el segundo no hace ni un POST.
- **Interrumpible en cualquier punto.** La unidad de commit es una asignatura (una
  transacción de `UpsertDetail`). Un `SIGTERM` a mitad hace rollback de esa y deja las
  anteriores marcadas.
- **Cooperativo con el tráfico real.** Una asignatura que un cliente pidió hace 10
  minutos ya está fresca, así que el job la salta. El job y los usuarios no se pisan:
  se ayudan.

La única tabla nueva es de **observabilidad**, no de correctitud (paso 7).

---

## Cupos: los dos problemas que aparecen al medirlos en bucle

### 1. `seat_snapshot` es append-only y los cupos casi nunca cambian

Medido: **0 cambios en 347 grupos a lo largo de 35 min**. Un barrido de cupos cada 15
min sobre 3 000 grupos escribe 288 000 filas al día, casi todas idénticas a la anterior.
En una temporada de inscripciones son millones de filas para almacenar una recta.

Pero no basta con "insertar solo si cambió": `measured_at` es lo que la API usa para
decidir si el dato está fresco y para publicar `age_seconds`. Si no se inserta, el dato
**parece viejo** y el read-through vuelve a pedirlo — el job estaría causando
exactamente los POSTs que existe para evitar.

**Solución (migración `00002`):** separar *cuándo se midió* de *cuándo cambió*.

```sql
ALTER TABLE section ADD COLUMN seats_checked_at timestamptz;
-- seat_snapshot: solo se inserta cuando available_seats cambia respecto al último.
-- section.seats_checked_at: se actualiza en CADA medición.
```

| Concepto | Columna | Quién la usa |
|---|---|---|
| Cuándo se miró por última vez | `section.seats_checked_at` | frescura, `age_seconds`, `Cache-Control` |
| Cuándo cambió por última vez | `max(seat_snapshot.measured_at)` | historial, gráficas, alertas |

En el body de la API son dos campos, y el segundo es información nueva y útil:

```json
{ "key": "1", "available": 32, "measured_at": "...", "age_seconds": 47, "changed_at": "..." }
```

Añadido compatible: `measured_at` y `age_seconds` conservan su significado
("de cuándo es este número"), que es el que [`API.md`](API.md) promete.

### 2. El TTL de cupos no se puede sostener globalmente. Nunca

Cuentas honestas: un worker mide ~1 asignatura/s (dominado por los round trips, no por
los bytes). En una ventana de 10 min, **~600 asignaturas por worker**. El universo son
~10 000. Con TTL de 5 min y dos workers, la cobertura completa de cupos es imposible por
un factor de ~8.

**Conclusión que hay que aceptar en vez de esquivar:** para cupos, el `Refresher` es un
**calentador del hot set**, no una garantía de frescura. El read-through sigue siendo el
mecanismo; el job solo hace que las asignaturas que la gente mira de verdad casi siempre
den `hit`.

El hot set sale de la demanda real (`RecordDemand`, escrito solo por `httpapi`).
Y ojo con el proxy fácil: *"las que tienen `detail_fetched_at`"* funciona hoy — porque
en fase 1 el único escritor es un cliente — y **deja de funcionar** en cuanto el barrido
global marque todas. Por eso la demanda se cuenta aparte.

Presupuesto, para elegir el tamaño con los ojos abiertos (con `it11`, ~68 KB por
asignatura):

| Hot set | Ciclo | Volumen/día (16 h) |
|---|---|---|
| 200 asignaturas | 15 min | ~0.9 GB |
| 600 asignaturas | 15 min | ~2.6 GB |
| 1 200 asignaturas | 15 min (2 workers) | ~5.2 GB |

Empezar en **200–300** y subir con datos: es ~1 GB/día. El límite es el ancho de banda
propio y el reloj del barrido, no el SIA — el óptimo medido son 80 conexiones
concurrentes y el job usa 2.

---

## Cadencia: cada cuánto correr cada barrido

La regla: **la cadencia se deriva del TTL**, no al revés. Si el job pasa cada T y el TTL
es ≥ T, el read-through nunca falla. Donde eso es imposible (cupos), se dice.

| Barrido | TTL que sostiene | Cadencia | Duración | Por qué |
|---|---|---|---|---|
| **Referencia** | 30 d | **mensual**, día 1, 03:00 | 78 s | Los planes cambian entre semestres, no dentro. 142 POSTs es ruido |
| **Catálogo** | 7 d | **semanal**, domingo 02:00 | 40–90 min (2 workers) | "Casi inmutable" está medido a nivel de intuición, no de reloj ([OQ §8](OPEN-QUESTIONS.md)). Semanal es barato y cubre el error |
| **Catálogo (apertura)** | — | **1 disparo manual** al abrir semestre | ídem | El único momento en que el catálogo cambia de verdad |
| **Detalle global** | 24 h | **diario**, 01:00–05:00, con tope de 4 h | ~3 h (2 workers) | Cabe en la ventana nocturna. Si no cabe, el checkpoint hace que mañana siga donde quedó |
| **Detalle por plan** | 24 h (visibilidad) | **1×/semestre**, ventana de mantenimiento, 4 workers | ~10 h | 38 h serial. Solo antes de que abran inscripciones, con la API avisada |
| **Cupos (hot set)** | 5 min *(provisional)* | **cada 15 min**, 06:00–22:00, **solo en temporada de inscripciones** | ≤10 min | Fuera de inscripciones no cambian: 0/347 en 35 min. Correrlo todo el año es gastar el ancho de banda de la UNAL para reescribir el mismo número |

```cron
# /etc/cron.d/sia-refresher   —   TZ del contenedor: America/Bogota (verificar; cron
#                                 no hereda la TZ del host y una hora corrida mete el
#                                 barrido pesado en horario pico)
CRON_TZ=America/Bogota

 0  3  1  *  *   refresher --mode=reference
 0  2  *  *  0   refresher --mode=catalog       --workers=2 --max-duration=3h
 0  1  *  *  *   refresher --mode=detail --scope=global --workers=2 --max-duration=4h
*/15 6-22 * * *  refresher --mode=seats  --scope=hot    --workers=1 --max-duration=10m
```

Tres reglas de operación que van con esa tabla:

- **`--max-duration` siempre menor que el intervalo.** Y además un
  `pg_try_advisory_lock` por modo al arrancar: si la corrida anterior sigue viva, la
  nueva sale con código 0 y un log, no se encola.
- **La ventana nocturna es para el barrido pesado, no para los cupos.** De noche los
  cupos no se mueven y nadie los mira.
- **La cadencia de cupos es provisional.** El número real lo fija el muestreo del
  **27/08/2026** ([OPEN-QUESTIONS §2](OPEN-QUESTIONS.md)): si los cupos se mueven cada
  minuto, 15 min es inútil y hay que recortar el hot set para bajar el ciclo; si se
  mueven cada hora, 15 min es despilfarro. **No congelar este número antes de esa
  medición.**

---

## Pasos

### Paso 1 · Esqueleto y modo `reference` · *con red, barato*

`internal/refresher` + `cmd/refresher`, `Options`, `Report`, señales, pool propio,
`Service` compartido por construcción. Modo `reference`: niveles → sedes → directorio de
cada sede.

**Hecho cuando:** dos corridas seguidas; la segunda hace **0 POSTs** y termina en menos
de un segundo (todo fresco). Y el test del hexágono cubre `internal/refresher`.

### Paso 2 · Modo `catalog` con concurrencia acotada · *con red*

Enumera `Levels → Campuses → ProgramsInFaculty` y llama a `Service.Catalog` con el TTL
del job. `errgroup.SetLimit(W)`, `rate.Limiter`, presupuesto de tiempo, errores
acumulados en vez de propagados.

**Hecho cuando:**
- Un `SIGINT` a mitad de corrida y una reanudación no repiten ni un programa ya fresco.
- `-race` limpio con W=4 sobre programas de sedes distintas.
- El `Report` cuadra: `programas = ok + saltados + fallidos`, sin residuo.

### Paso 3 · `it11` en `findRow` · *con red* — el paso que paga la fase

`sia.findRow` filtra el listado por nombre antes de leer el `_afrRK`, con caída a listado
completo si el filtro devuelve 0 filas (acentos, nombres raros).

Dos trampas, y la segunda es de la familia [§33](GOTCHAS.md):

- El filtro devuelve varias filas: se elige por **código**, jamás por posición.
- **`it11` se queda puesto en el servidor.** Una conexión que filtró y vuelve al pool
  convierte el siguiente catálogo completo en un listado recortado — y son ~98 filas
  plausibles en vez de las que tocan. Limpiarlo es parte de la operación lógica, con el
  mismo criterio con que `FetchCatalog` repone `soc4`.

**Hecho cuando:** el mismo programa con detalle completo baja de **31 MB a ≤ 8 MB**, con
las mismas 98 asignaturas y los mismos grupos byte a byte; y un `FetchCatalog` inmediatamente
posterior a un detalle filtrado devuelve **98 filas**, no menos.

### Paso 4 · `FetchDetails` por lote y modo `detail --scope=global` · *con red*

Una conexión por programa durante todas sus asignaturas. `CoursesNeedingDetail` filtra
por frescura **global**, así que la segunda carrera que comparte asignaturas con la
primera solo paga las que faltan.

**Hecho cuando:**
- Un programa de 98 asignaturas termina sin atascos y con **menos POSTs** que 98
  llamadas sueltas a `FetchDetail` (el reparqueo desaparece).
- Dos workers sobre programas distintos: los 2×98 detalles son los correctos, ninguno
  contaminado ([§28](GOTCHAS.md)).
- Tras recorrer dos programas que comparten 40 asignaturas, el segundo hace ~58 POSTs de
  detalle, no 98.

### Paso 5 · Aserciones de cordura — que el job no escriba basura a escala

Un crawler es una máquina de multiplicar un bug de parseo por 135 000. Cada unidad se
valida antes de persistir, y una violación **aborta el programa entero**, no la fila:

| Aserción | Qué significa |
|---|---|
| exactamente 1000 filas | truncamiento ([§14](GOTCHAS.md)), no un resultado |
| catálogo con 0 filas en un programa que antes tenía 98 | el SIA cambió, o `soc4` se ensució |
| >90 % de las asignaturas de un programa con 0 grupos | 0 grupos es válido de a uno ([§18](GOTCHAS.md)); a esa escala es el parser |
| `_afrRK` idéntico entre dos búsquedas del mismo programa | se cacheó un índice; es el bug que mató al proyecto anterior |
| 5 programas seguidos fallidos, o >20 % de error en la corrida | **circuit breaker**: aborta y sale con código ≠ 0 |

**Hecho cuando:** un fixture con 1000 filas y otro con la tabla ajena del
[§22](GOTCHAS.md) abortan la corrida en vez de escribirse.

### Paso 6 · Cupos: migración `00002`, dedupe y hot set · *con red*

`seats_checked_at`, inserción en `seat_snapshot` solo al cambiar, `changed_at` en el
body, `RecordDemand` desde `httpapi`, `SeatsHotSet`, modo `seats`.

**Hecho cuando:**
- Dos barridos seguidos sin cambios reales: **0 filas nuevas** en `seat_snapshot`,
  `seats_checked_at` actualizado en todas, y `age_seconds` de la API sigue siendo la
  edad de la **medición**.
- Un cambio real de cupos sí inserta, y `changed_at` lo refleja.
- El barrido del hot set configurado cabe en su `--max-duration` con margen.

### Paso 7 · Observabilidad · *sin red*

Tabla `refresh_run` (`id`, `mode`, `scope`, `started_at`, `finished_at`, `programs_ok`,
`programs_failed`, `courses_ok`, `posts`, `bytes`, `ended_reason`) y `/v1/status`
enriquecido — cierra el `TODO` que `httpapi/status.go` dejó escrito y el
*"cuando exista `Refresher`, la cobertura crece sola"* de [`API.md`](API.md).

Logs `slog` con `run_id` en cada línea. Sin eso, un fallo a las 3 de la mañana en el
programa 412 de 1380 es inencontrable.

**Hecho cuando:** `GET /v1/status` reporta la última corrida de cada modo con su
resultado, y una corrida abortada por el circuit breaker aparece con su `ended_reason`.

### Paso 8 · Empaquetado y freno de mano · *sin red*

Servicio `refresher` en `docker-compose.yml` (misma imagen, otro entrypoint,
`restart: no`), crontab del paso *Cadencia*, y `REFRESH_ENABLED=false` como interruptor
único que apaga todo sin editar cron.

**Hecho cuando:** `REFRESH_ENABLED=false` hace que cualquier modo salga con código 0 y
un log, sin abrir una sola conexión al SIA.

---

## Configuración

| Variable | Default | Qué hace |
|---|---|---|
| `REFRESH_ENABLED` | `true` | freno de mano |
| `REFRESH_WORKERS` | `2` | goroutines = conexiones. Con la API arriba, **≤ 4** |
| `REFRESH_POOL_SIZE` | `= REFRESH_WORKERS` | más conexiones que workers no sirve para nada |
| `REFRESH_MAX_DURATION` | `4h` | presupuesto de reloj; corta limpio y reanuda mañana |
| `REFRESH_RATE_POSTS_PER_SEC` | `6` | techo, no freno: 2 workers rinden ~4/s y nunca lo tocan |
| `REFRESH_CATALOG_MAX_AGE` | `168h` | TTL que el modo `catalog` sostiene |
| `REFRESH_DETAIL_MAX_AGE` | `24h` | ídem para `detail` |
| `REFRESH_HOT_SET_SIZE` | `250` | asignaturas del barrido de cupos |

`SIA_POOL_SIZE` sigue siendo el de la API y **no** se comparte. La suma de ambos es la
invariante de ≤ 80 (techo medido, `OPEN-QUESTIONS.md` §5).

---

## Riesgos

| Riesgo | Cómo se detecta | Qué hacer |
|---|---|---|
| La UNAL repinta la página a mitad de barrido | circuit breaker del paso 5; la colección Bruno deja de pasar | abortar, re-mapear con [`FIELDS.md`](FIELDS.md) |
| **Datos plausibles y equivocados, ×135 000** | no da síntoma — es el fallo propio de este dominio | las aserciones del paso 5 existen solo para esto |
| El job ahoga a la API | `503 busy` en tráfico real | pool propio + invariante ≤ 80; bajar `REFRESH_WORKERS` |
| Ancho de banda del barrido | **18.8 MB/min** por worker hoy; ~4 tras el paso 3 | `RATE_POSTS_PER_SEC`, ventana nocturna, hot set chico |
| `seat_snapshot` crece sin freno | tamaño de tabla | dedupe del paso 6; retención si aun así crece |
| Cambio de semestre | `SIA_TERM` cambia y todo queda viejo de golpe | `section` está *keyed* por `term`: lo viejo queda como historial. Disparo manual de `catalog` + `detail` |
| Dos corridas solapadas | filas duplicadas en `refresh_run` | `pg_try_advisory_lock` por modo |
| §30/§31/§33 vuelven por una ruta nueva | `502 sia_noop` intermitente y rapidísimo (~250 ms) | los tests vivos de fase 1 (`live_regression_test.go`) son la red; ampliarlos con las rutas del job |

---

## Qué cambia en los otros documentos

Al cerrar esta fase hay que tocar, y conviene hacerlo en el mismo PR que el código:

| Documento | Cambio |
|---|---|
| [`ARCH.md`](ARCH.md) | `Refresher` deja de estar "aplazado"; agregar el pool propio y la invariante ≤ 8 |
| [`API.md`](API.md) | `changed_at` en el body de cupos; `/v1/status` con la última corrida |
| [`DATA-MODEL.md`](DATA-MODEL.md) | `section.seats_checked_at`, tabla `refresh_run`, tabla de demanda |
| [`LAYOUT.md`](LAYOUT.md) | `internal/refresher` y `cmd/refresher` dejan de ser una nota al pie |
| [`GOTCHAS.md`](GOTCHAS.md) | §34 si `it11` deja estado pegado, que es lo que el paso 3 espera encontrar |
| [`PLAN.md`](PLAN.md) | el esbozo de "Fase 2" apunta acá |

---

---

## Resultado (2026-08-17/18)

Medido contra producción, no estimado.

| Barrido | Medido | El plan decía |
|---|---|---|
| `reference` (todos los niveles × sedes) | 27 directorios, 1380 entradas, **131 POSTs, 72 s** | 142 POSTs, 78 s |
| `reference`, segunda corrida | **0 POSTs, <1 s** — todo fresco | criterio del paso 1 ✔ |
| `catalog` (SEDE DE LA PAZ, 9 planes) | 468 asignaturas, 114 POSTs, **39 s** con 2 workers | ~13 POSTs/plan ✔ |
| `catalog` (Palmira, 27 planes) | 16 recorridos + **11 saltados** tras un `SIGINT`: cero repeticiones | criterio del paso 2 ✔ |
| `it11` en el listado | 232 675 B → **17 862 B (13×)**, misma fila encontrada por código | 241 KB → 15–27 KB ✔ |
| `detail --scope=global` | **~0.7 asignaturas/s/worker**, ~3.7 POSTs y **~87 KB** por asignatura | ~1/s, ~2 POSTs, ~68 KB |
| `FetchDetails` por lote | 24 POSTs contra **28** de llamadas sueltas intercaladas (6 asignaturas, 2 planes) | "menos POSTs" ✔ |
| `seats --scope=hot` | 5 asignaturas en 24 s; segundo barrido: **0 filas nuevas** en `seat_snapshot`, `seats_checked_at` refrescado en las 244 secciones | criterio del paso 6 ✔ |
| Bogotá, `detail` a mitad | **201 de 505 planes saltados** porque otro plan ya había traído sus asignaturas | la aritmética de las 3 h ✔ |
| `catalog` en toda la UNAL (2026-08-17, 1 h 46 min) | 1306 planes OK, 23 fallidos, 60 saltados, 224 750 asignaturas, 16 246 POSTs, 3.4 GB | ~2 760 POSTs, ~2.7 h, ~0.7 GB |
| Los 23 fallidos, ya arreglados (§37) | **18 planes reales** de Amazonia, Caribe, Orinoquía y 2 sueltos; los otros 5 eran los tests escribiendo en la base de producción | — |
| `catalog` sobre esas 5 sedes tras el arreglo (2026-08-18) | 18 planes OK, **0 fallidos**, 206 POSTs, 21 MB | cobertura **1380/1380** |
| `detail --scope=global` lanzado por cron (2026-08-18, 01:00) | 1442 asignaturas, **1795 fallos**, 68 861 POSTs = **47 POSTs/asignatura** | ~3.7 POSTs/asignatura |
| Los 1795 fallos | un solo bug: los `_afrRK` de la unión de electivas (§38), que golpea a **todo doctorado** porque su listado regular está vacío | — |
| `detail --scope=plan` en Bogotá tras el arreglo | 76 asignaturas, **0 fallos**, 806 POSTs = 10.6 POSTs/asignatura sobre planes 100 % de electivas | 3.7 en planes con listado regular |

`-race` limpio con W=4 sobre programas concurrentes. `REFRESH_ENABLED=false` sale con
código 0 y un log **sin abrir una conexión al SIA**. Dos corridas del mismo modo: la
segunda sale con código 0 por el `pg_try_advisory_lock`.

### Lo que el Job destapó (y era de la API también)

Cuatro trampas nuevas, las cuatro en rutas que la API podía recorrer y nunca había
recorrido: [GOTCHAS §34](GOTCHAS.md) (`it11` se queda en el formulario y recorta el
siguiente listado), [§35](GOTCHAS.md) (**en doctorado no existe el comodín de sede**, así
que el catálogo de ~82 planes era `502`), [§36](GOTCHAS.md) (el nombre del listado venía
pegado a la insignia `ASIGNATURA SIN PROGRAMAR`, y ese texto llegaba a `course.name`) y
[§37](GOTCHAS.md) (el rebote del §30 sobre `soc6` es innecesario **e imposible** en las
sedes de una sola facultad, así que 14 planes de Amazonia y Caribe no tenían catálogo).

Y dos más que solo aparecieron cuando el cron corrió solo de madrugada:
[§38](GOTCHAS.md) (el `_afrRK` sacado de la **unión** de las búsquedas de electivas
pertenece a una tabla que el servidor ya reemplazó, así que el detalle de cualquier
asignatura de doctorado era inalcanzable) y [§39](GOTCHAS.md) (hay asignaturas que
**tumban al SIA**: CDATA cortado y redirect a `errorNavegacion.jsf`, y sin detectarlo la
conexión se llevaba por delante las 40 asignaturas siguientes del plan).

El §37 salió del barrido completo, no de una prueba: 23 planes fallidos en el log de
`/var/log/sia-refresher.log`, agrupados por error, y 14 de ellos con el mismo
`soc6 has 1 options, need at least 2`. Sin `refresh_run` y sin el log por unidad, ese
número se habría visto como "1362 de 1380, casi todo".

El §38 es peor de encontrar y vale la pena subrayar por qué: **el circuit breaker no
saltó**. Cuenta unidades, y una unidad es un programa que se da por bueno con que **una**
de sus asignaturas pase. 38 programas "OK" tapaban 1795 asignaturas fallidas. Lo que lo
delató fue la aritmética de `posts` contra `courses_ok`: 47 POSTs por asignatura donde el
plan decía 3.7. Si algún día hay que elegir una sola métrica para vigilar el Job, es esa
razón, no `programs_failed`.

Era la predicción explícita de este documento: *"cualquier bug de persistencia que el job
destape es un bug que la API también tenía. Eso es una feature."*

### Desviaciones deliberadas del plan

| Plan | Implementado | Por qué |
|---|---|---|
| `CoursesNeedingDetail(...) ([]string, error)` | devuelve `[]CourseRef` con `Name` y `HadSections` | el nombre es lo que filtra `it11`, y sin él el paso 3 no aplica al barrido; `HadSections` es lo que hace honesta la aserción de 0 grupos |
| `plan.go`, `worker.go`, `hotset.go` como archivos | fundidos en `refresher.go` y `modes.go` | tres archivos de ~40 líneas cada uno no se buscan mejor que dos de ~250 |
| Aserción *"`_afrRK` idéntico entre dos búsquedas"* | **no implementada** | con `it11` una búsqueda filtrada devuelve 1–3 filas y el renumerado puede repetir la clave legítimamente: la aserción abortaría barridos válidos. La invariante real —nunca cachear un `_afrRK`— se sostiene en el código y en `TestLive_FetchDetails_TwoWorkersDoNotCrossTalk` |
| Aserción *">90 % con 0 grupos = el parser"* | solo sobre las asignaturas que **ya tenían** grupos | SEDE DE LA PAZ responde 0 grupos en todas sus asignaturas, y es verdad. La primera versión falló dos de sus planes por decir la verdad |
| — | **añadido**: el detalle verifica el código que la propia página imprime | es gratis (el regex del encabezado ya lo capturaba y lo tiraba) y es el único detector directo de §28/§4: un detalle bien formado que habla de otra asignatura |

### Números que este plan estimaba de más

- **POSTs por asignatura: ~3.7, no ~2.** El plan contaba el `cb1` de `findRow` más el
  detalle; faltaban el `soc3` de reparqueo, el `Volver` y —para las de libre elección— la
  cascada de electivas completa, que con las rebotes de §30 son 8 POSTs.
- **Bytes por asignatura: ~87 KB, no ~68 KB**, por lo mismo. Aun así el filtro bajó el
  barrido de ~366 KB a ~87 KB por asignatura (4.2×) al aplicarlo también al listado de
  electivas, que es el más gordo de los dos.

---

## Lo que **no** se hace en fase 2

Alertas de cupo (el historial ya las soporta, pero son producto, no crawler) ·
prerrequisitos y componentes (se siguen parseando sin guardar) · paginación del SIA (no
existe, [§14](GOTCHAS.md)) · autenticación · descubrimiento de semestres pasados (el SIA
solo expone el actual) · cualquier optimización que implique **cachear un `_afrRK`**.

---

## Pendiente de verificar (al 2026-08-18)

Todo lo de arriba está medido. Esto **no**, y es lo que queda por mirar:

| Cuándo | Qué | Cómo se ve que salió bien |
|---|---|---|
| **2026-08-19, ~05:05** | Primera corrida de `detail --scope=global` con los arreglos de §38/§39 dentro de la imagen (el rebuild se hizo el 18/08 por la noche) | `posts / courses_ok` cerca de **3.7**, no de 47; `errors_dropped` bajo o ausente |
| **2026-08-23, ~05:00** | Primer `catalog` semanal que lanza el cron solo (domingo 02:00). Los anteriores fueron manuales | `reason=done`, no `circuit_breaker`; `programs_failed=0` |
| **2026-08-27** | Descomentar la línea de `seats` en `deploy/cron.d/sia-refresher` y reinstalarla. La cadencia de 15 min es **provisional**: el número real lo fija el muestreo de ese día ([OPEN-QUESTIONS §2](OPEN-QUESTIONS.md)) | filas nuevas en `seat_snapshot` durante el día, no solo `seats_checked_at` |

La métrica a vigilar es **`posts / courses_ok`**, no `programs_failed`: el §38 pasó
inadvertido cuatro horas porque 38 programas "OK" tapaban 1795 asignaturas fallidas.

```sql
SELECT id, mode, scope, courses_ok, posts,
       round(posts::numeric / nullif(courses_ok, 0), 1) AS posts_por_asignatura,
       ended_reason
FROM refresh_run ORDER BY id DESC LIMIT 5;
```

Dos cosas que ya se sabe que **no** son bugs y no hay que volver a investigar:

- **3 planes con catálogo vacío de verdad**: `1102/3CLE`, `1103/4336`, `1103/4620`. No
  ofertan nada este semestre; `catalog_fetched_at` está puesto y la lista es vacía.
- **2 asignaturas que tumban al SIA**: `2011302` y `2018602` (Bogotá). Es el §39, es del
  servidor, y falla igual en una conexión recién creada. Se reportan y se sigue.
