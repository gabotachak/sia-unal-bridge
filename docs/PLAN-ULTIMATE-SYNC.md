# Plan: sincronización continua por asignatura (`--mode=live`)

> **Estado: propuesta.** Nada de esto está implementado. Los números que llevan
> "medido" salen de [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) §5 y del
> [Resultado de la fase 2](FASE-2.md#resultado-2026-08-1718); los derivados están
> marcados como tales. Los que dicen "medido" salen de la fase A.

Hoy el click del usuario **es** el mecanismo de medición: abrir la ficha de una
asignatura dispara el read-through y ese POST es lo que actualiza los cupos. Este
documento define cómo dejar de depender de ese click: un proceso que mide cupos por
asignatura de forma continua, con una cadencia que se **gana** por demanda y
volatilidad en vez de repartirse por igual.

| Documento | Para qué lo abres |
|---|---|
| [`FASE-2.md`](FASE-2.md) | el `Refresher` actual: modos, cadencia, lo que ya se midió |
| [`PLAN-SIACHANGES.md`](PLAN-SIACHANGES.md) | reconciliación, `disabled_at`, y por qué un 404 no apaga nada solo |
| [`GOTCHAS.md`](GOTCHAS.md) | §25 (bootstrap caro), §28 (una petición por conexión), §39 (asignaturas que tumban al SIA), §40 (parseo silencioso) |
| [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) | §2 (volatilidad de cupos — **este plan la desbloquea**), §5 (techo de 80 conexiones) |
| [`API.md`](API.md) | los TTL y `age_seconds` que este proceso tiene que sostener |
| [`DATA-MODEL.md`](DATA-MODEL.md) | `seat_snapshot` append-only, `section.seats_checked_at` |

---

## Orden de ejecución (el resumen de una hoja)

Las fases van **en orden** y cada una tiene un criterio de aceptación que hay que
cumplir antes de pasar a la siguiente. El detalle literal está en
[*Ejecución*](#ejecución--cómo-se-lleva-esto-a-cabo).

| Fase | Qué | Red | Criterio para pasar a la siguiente |
|---|---|---|---|
| **A** | Línea base: medir qué cuesta hoy | no | La línea base está escrita y commiteada |
| **B** | Bajar el coste por asignatura (electivas primero) | sí | `posts / courses_ok` **≤ 6.0** en el modo `seats` |
| **C** | El daemon `--mode=live` (bucle sobre `Run`) | sí | Un ciclo limpio en producción, `SIGTERM` corta sin dejar el lock |
| **D** | Producción: quitar el cron de `seats`, servicio, `.env` | sí | p95 de edad de cupos **< 15 min** a las 24 h |
| **E** | Vigilancia | no | permanente |

**Si la fase B no llega a su criterio, el plan se detiene ahí.** Sin ese ahorro `live`
cuesta 12.3 GB/día en vez de 3.1, y no vale la pena.

---

## Respuesta corta

**Mejorar el worker, no hacer uno nuevo.** Un modo más (`live`) en `cmd/refresher`,
que además corre como **daemon** en vez de como corrida de cron. Un binario nuevo
duplicaría el pool, el `Report`, el limitador de cortesía, el circuit breaker y el
advisory lock, que es exactamente el código que ya existe y funciona.

**El límite no es el SIA ni el presupuesto: es el coste por asignatura.** Medido el
2026-08-22 contra producción: el barrido de cupos gasta **4.1 GB y 103 000 POSTs al
día** para cubrir mal 250 asignaturas, a **8.8 POSTs y 348 KB cada una** — 2.4× lo que
la fase 2 midió. Con ese coste arreglado, cubrir **las 3 474 asignaturas con grupos de
toda la UNAL** —las volátiles cada 5 min, el resto cada 6 h— cuesta **3.1 GB/día y un
solo worker**: menos de lo que ya se gasta hoy. Sin arreglarlo, el mismo plan cuesta
12.3 GB/día.

**El click no se toca.** Sigue siendo el respaldo, y en un caso sigue siendo la única
fuente posible: la primera vez que un plan mira una asignatura. La sección
*"la frescura es la única palanca"* explica por qué, y es la razón por la que este plan
no promete "nunca más un POST desde un click".

**Y hay una restricción dura que hay que decir primero:** no existe una lectura barata
de cupos. El listado no los trae (verificado: 0 ocurrencias de `Cupos disponibles` en
241 KB / 98 filas), así que medir cupos **es** traer el detalle completo, una asignatura
a la vez. No hay batch posible. Todo lo demás en este documento es consecuencia de eso.

---

## Qué **no** se toca

El read-through de la fase 1 funciona y no se toca. `live` es un cliente más de los
mismos casos de uso, exactamente como el `Refresher` de hoy.

| Intacto | Por qué se dice acá |
|---|---|
| `catalog.Service` (`Catalog`, `CourseDetail`, `SectionSeats`) | Ni firma ni semántica. `live` entra por ahí, igual que `httpapi` |
| El contrato HTTP (`openapi.yaml`, `docs/API.md`) | Ningún endpoint nuevo, ningún campo nuevo |
| `?max_age=`, `FETCH_COOLDOWN`, el rate limit por IP | La política de frescura del cliente no cambia |
| `STALE_SEATS_SECONDS` y todo `web/` | Sigue avisando "esto es viejo"; solo que va a avisar menos |
| **El click** | Sigue siendo el mecanismo de respaldo, y hay un caso donde **siempre** lo será (ver abajo) |

**Alcance del cambio**, archivo por archivo:

```
internal/refresher/     modo live, scheduler, cuarentena
cmd/refresher/main.go   flag --mode=live, daemon en vez de corrida
internal/config         las variables REFRESH_LIVE_*
docker-compose.yml      servicio del daemon
deploy/cron.d/          se borra la línea de seats
```

Y tres cosas que **sí** rozan código compartido. Ninguna entra sin una medición que la
pida, y las tres están marcadas así en sus pasos:

| Qué | Quién lo usa hoy | Puerta |
|---|---|---|
| `ORDER BY` de `SeatsHotSet` (`store/refresh.go`) | **solo el job** | Ninguna: es código del job aunque viva en `store` |
| Decaimiento de `course_demand` | la API escribe la tabla, nadie más la lee | Solo si se mide que el hot set se osificó |
| `seats_checked_at` en un `UPDATE` por lote (`store/section.go:145`) | camino de escritura compartido | Solo si `n_dead_tup` de `section` crece; es rendimiento, no semántica |

---

## Sí: la frescura es la única palanca — y son **tres** marcadores, no uno

La pregunta de fondo: *¿la frescura es lo que decide si se va al SIA?* Sí, y no hay
otro mecanismo. `Fresh(t, maxAge, now)` (`internal/catalog/freshness.go`) es la
decisión completa: `nil` nunca es fresco, `maxAge=0` fuerza el POST, `?max_age=` la
sobreescribe y `DefaultFreshness` (-1) significa "usa el TTL del recurso".

Lo que hay que tener presente para este plan es que son **tres marcadores distintos, con
tres granularidades distintas**:

| Endpoint | Marcador que manda | TTL default | Quién lo estampa |
|---|---|---|---|
| Catálogo del plan | `program.catalog_fetched_at` | **7 d** | `UpsertCatalog` |
| Ficha de asignatura | `course_program.detail_fetched_at` **de ese plan** | **24 h** | `UpsertDetail`, **solo el plan que hizo el POST** |
| Cupos de un grupo | `section.seats_checked_at` | **5 min** | `UpsertDetail`, en **cada** medición |

### La consecuencia que este plan tiene que decir en voz alta

Los cupos son **globales**; la **visibilidad de grupos es por plan**. Y las dos lecturas
que le sirven al usuario pasan por la visibilidad:

- `ProgramCourses` agrega cupos con un `LATERAL` **filtrado por `section_program`**
  (`internal/store/course.go:69`).
- `cachedSection` lee el grupo *como lo ve este plan*, por el mismo join.

Entonces: **una medición del job llega al usuario solo si ese plan ya tiene filas de
visibilidad.** Y esas filas solo las escribe un detalle traído **desde ese plan**.

De ahí sale, sin ambigüedad, dónde queda el click:

| Situación | Qué pasa |
|---|---|
| Primer click de un plan sobre una asignatura | **Va al SIA, siempre.** El job no puede enseñar la visibilidad de un plan que nunca preguntó |
| Del segundo en adelante, con `live` corriendo | `hit`: los cupos que el job midió desde cualquier plan ya son los de este |
| La ficha completa (`CourseDetail`, 24 h) desde otro plan | Puede seguir siendo miss aunque los cupos tengan 30 s. `detail_fetched_at` es por plan a propósito |

No es un bug ni algo que este plan deba arreglar: la visibilidad es lo único que un
fetch de otro plan **no puede** enseñar (`DATA-MODEL.md` decisión 6). El click es el
respaldo y también es la única fuente posible en ese primer caso.

**La palanca barata para ampliar la cobertura no es `live`, es el barrido que ya
existe:** un `detail --scope=plan` sobre los planes con demanda al abrir semestre
(~10 h con 4 workers) llena la visibilidad, y a partir de ahí las mediciones globales de
`live` llegan solas a esos planes. `live` sin ese barrido solo mejora lo que la gente ya
abrió alguna vez — que sigue siendo lo que la gente mira, así que también está bien
como punto de partida.

---

## Qué cambia para quien usa la app

| Hoy | Con `live` |
|---|---|
| La lista de un plan muestra cupos de la última vez que **alguien** abrió esa materia | La lista llega ya fresca **de lo que ese plan ya vio alguna vez**; el click pasa de ser el mecanismo a ser el respaldo |
| `STALE_SEATS_SECONDS` (1800 s por defecto) existe para avisar "esto es viejo, ábrela para volver a preguntar" | El tooltip de dato viejo se vuelve raro en vez de ser la norma |
| Una materia retirada del catálogo aparece hasta el barrido semanal | La baja llega en horas: un `unknown_course` dispara la relectura del catálogo de ese plan (ver la Decisión 4) |
| `?max_age=` fuerza ir al SIA y pelea con el cooldown | El cache casi siempre está dentro del TTL, así que el camino normal es un `hit` |

---

## La aritmética, **medida** (fase A, 2026-08-22)

Nada de esto es estimación: sale de la base de producción. Las consultas están en el
la fase A del runbook; esto es su resultado.

### El universo es 3× más chico de lo que este borrador asumía

| Magnitud | Medido | El borrador decía |
|---|---|---|
| Cursos en la base | 28 246 | — |
| **Cursos con grupos** — los únicos con cupos que medir | **3 474** | 10 000 |
| Secciones (`term = 2026-2`) | 8 705 | ~87 000 |
| Pares plan-curso activos | 230 976 | ~135 000 |
| Planes | 1 380 | 1 380 ✔ |

Los otros 24 772 cursos no tienen detalle traído todavía; hasta que lo tengan no hay
cupos que refrescar. **El universo del barrido de cupos son 3 474 asignaturas.**

### Una asignatura cuesta 2.4× lo que dice la fase 2 — y se sabe por qué

| Magnitud | `seats` (48 h) | `detail --scope=global` (anoche) | FASE-2 midió |
|---|---|---|---|
| POSTs por asignatura | **8.8** | **21.7** | 3.7 |
| KB por asignatura | **348** | **690** | 87 |
| Asignaturas/min/worker | **16.1** (0.27/s) | — | 42 (0.7/s) |

La causa está medida: **107 de las 250 del hot set (43 %) son `LIBRE ELECCIÓN (L)`**, y
una libre elección paga la cascada de electivas completa con los rebotes de §30 — 10.6
POSTs medidos en la fase 2 sobre planes 100 % de electivas. El promedio ponderado da
justo lo que se observa.

> El `21.7` del barrido nocturno es **la alarma que la propia fase 2 dijo que había que
> vigilar** (`posts / courses_ok`, la lección del §38). La corrida del 20/08 terminó en
> `circuit_breaker`; la del 21/08 en `deadline` tras 4 h y 3 GB. Es un problema aparte
> de este plan y probablemente más urgente.

### Lo que se gasta hoy, para cubrir mal 250 asignaturas

| Día | Corridas | Asignaturas | Bytes | POSTs | Cortadas por reloj |
|---|---|---|---|---|---|
| 2026-08-21 | 67 | 12 288 | **4.1 GB** | 103 491 | **67 de 67** |
| 2026-08-20 | 68 | 8 369 | 2.9 GB | 76 315 | 66 de 68 |

**Ninguna corrida termina.** Las 67 se cortan por `--max-duration=10m` habiendo medido
~190 de las 250 del hot set. Las últimas ~60 no se miden nunca, y como la prioridad no se
recalcula entre corridas, son **siempre las mismas**.

### El presupuesto, con los números de verdad

Un reparto por niveles sobre el universo real (60 calientes cada 5 min, ~500 tibios cada
30 min, ~2 970 fríos cada 6 h) son **~2 200 mediciones/hora**. Lo que cuesta depende
enteramente de si se arregla el coste por asignatura:

| Escenario | Bytes/h | GB/día (16 h) | POSTs/s | Workers |
|---|---|---|---|---|
| Con el coste de hoy (348 KB, 8.8 POSTs) | 771 MB | **12.3** | 5.4 | 2.3 |
| Con el coste de la fase 2 (87 KB, 3.7 POSTs) | 193 MB | **3.1** | 2.3 | **0.9** |
| *Hoy, sin plan* — cubre 190 asignaturas y nunca termina | 256 MB | *4.1* | 1.2 | 1 |

**Esa tabla es el plan entero.** Con el coste arreglado, cubrir las **3 474**
asignaturas —las calientes cada 5 min, el resto cada 6 h— cuesta **menos de lo que ya se
gasta hoy** y lo hace con **un** worker. Sin arreglarlo, cuesta 3× y hay que recortar
cobertura.

### Volatilidad: real, y brutalmente concentrada

Excluyendo el primer snapshot de cada sección, que es un alta y no un cambio:

| Ventana | Cambios reales | Secciones distintas |
|---|---|---|
| Hora pico (21/08 17:00 UTC) | 86 | 31 |
| Hora típica de día | 50–80 | 6–27 |
| Madrugada | 18–40 | 6–13 |

Y el reparto en 24 h, que es lo que manda:

| Cambios en 24 h | Secciones |
|---|---|
| **0** | **3 894** |
| 1–5 | 116 |
| 8–18 | 6 |
| **115** | 5 |
| **203** | 1 |

Una sección (`1000019-B`, grupo `SUMA-01`) cambia **cada 7 minutos**. Los cinco grupos de
`2016498` cambian cada 12. Las otras 3 894 no se mueven.

**Y el traslape con la demanda es casi perfecto: 998 de 1 039 cambios (96 %) ocurren en
asignaturas que alguien pidió.** El hot set por demanda no era una apuesta razonable: es
la respuesta correcta, y ahora está medida.

### Demanda real

| Ventana | Asignaturas distintas |
|---|---|
| Última hora | **177** |
| Último día | 387 |
| Últimos 7 días | 549 — de las cuales **501 tienen grupos** |
| Histórico | 549 asignaturas, **19 087 hits** |

Por sede: **1101 Bogotá con 546 asignaturas y 19 087 hits**; Medellín 12, Manizales 5, el
resto ~7. **La decisión de alcance por sede la tomaron los datos: esto es Bogotá.**

### El SLO de hoy, para tener contra qué comparar

| Universo | p50 de edad de cupos | p95 |
|---|---|---|
| Pedido en la última hora (174 asignaturas) | **6 min** | **20 h** |
| Pedido en 7 días (466) | 12 min | **43 h** |

La mediana ya es buena; **la cola es el problema**. Una de cada veinte asignaturas que
alguien abre muestra cupos de hace un día. Eso es exactamente lo que arregla un reparto
por deuda de frescura, y es la métrica con la que se juzga la fase D.

---

## Decisión 1 — Un modo más en el mismo binario, y que sea daemon

### Por qué modo y no binario nuevo

`internal/refresher` ya tiene todo lo que un bucle continuo necesita y que sería un
error reescribir: pool propio (`cmd/refresher/main.go`), limitador de cortesía
compartido, `eachProgram` con `errgroup.SetLimit`, `Report` con circuit breaker,
`refresh_run` para observabilidad, `pg_try_advisory_lock` por modo y el freno
`REFRESH_ENABLED`. El modo `live` es un `dispatch` más y un scheduler; lo demás se
hereda.

También hereda la invariante que importa: **no escribe en Postgres**. Entra por
`catalog.Service` igual que `httpapi`, así que sigue habiendo un solo upsert.

### Por qué daemon y no cron cada 5 minutos

| | Cron cada 15 min (hoy) | Daemon |
|---|---|---|
| Bootstrap del pool | **en cada corrida**: 96/día × W conexiones, 0.15–7 s y 52 KB–4.5 MB cada una (§25) | una vez |
| Sesiones | mueren al terminar la corrida | vivas con `Keepalive` (ping ≤3 min, §7) |
| Localidad de parqueo | se pierde entre corridas | se conserva: un plan visitado hace 2 min cuesta 2 POSTs, no 6 |
| Prioridad | congelada al arrancar la corrida | se recalcula por lote |
| Cadencia mínima | el intervalo de cron | continua |

Con W=8, cron a 15 min son **768 bootstraps/día**, entre 40 MB y 3.4 GB solo en
arrancar conexiones, más hasta 7 s de tiempo muerto por conexión y por corrida. El
daemon lo paga una vez.

**Consecuencia operativa:** la línea de `seats` en `deploy/cron.d/sia-refresher` se
**borra** al activar `live`. Dos mecanismos midiendo cupos es trabajo duplicado contra
el SIA, y el advisory lock no lo evita porque son modos distintos.

Lo que **no** cambia: `reference`, `catalog` y `detail` siguen en cron. Son barridos con
principio y fin, y no ganan nada corriendo continuo.

---

## Decisión 2 — Presupuesto, no cobertura. Y un SLO explícito

El `Refresher` de la fase 2 ya lo dice para cupos: es un **calentador del hot set**, no
una garantía. `live` no cambia esa naturaleza, la vuelve **medible y negociable**.

El presupuesto se expresa en lo que ya existe: `REFRESH_RATE_POSTS_PER_SEC`. La
conversión honesta, para poder discutirlo con números:

```
1 worker continuo ≈ 2.6 POSTs/s ≈ 5.3 GB/día ≈ 60 500 mediciones/día
```

**SLO propuesto** (tres niveles, no uno):

| Nivel | Universo | Objetivo | Cómo se mide |
|---|---|---|---|
| **Caliente** | pedida por un cliente en la última hora, o con un cambio de cupos en la última hora | p95 de edad ≤ **5 min** | `section.seats_checked_at` |
| **Tibio** | pedida en los últimos 7 días, o con alguna sección en ≤3 cupos | p95 ≤ **30 min** | ídem |
| **Frío** | el resto de las que tienen grupos | p95 ≤ **6 h** | ídem |
| — | 0 grupos y sin demanda | lo cubre `detail` diario | — |

El universo de los tres niveles son las asignaturas **que ya tienen filas de
`section`** — es decir, las que alguien (un cliente o un barrido) trajo alguna vez. Una
asignatura que nadie pidió nunca no tiene cupos que medir: la cubre `detail --scope=global`
en su ronda diaria, y en cuanto tenga grupos entra sola en la rotación.

El SLO se mide con una consulta, no con una intuición:

```sql
-- Edad de los cupos de lo que la gente pidió en la última hora.
SELECT count(DISTINCT (d.campus_code, d.code))                        AS asignaturas,
       round(percentile_cont(0.50) WITHIN GROUP (
             ORDER BY extract(epoch FROM now() - sec.seats_checked_at)))  AS p50_s,
       round(percentile_cont(0.95) WITHIN GROUP (
             ORDER BY extract(epoch FROM now() - sec.seats_checked_at)))  AS p95_s
FROM course_demand d
JOIN section sec ON sec.campus_code = d.campus_code AND sec.code = d.code
WHERE d.last_requested_at > now() - interval '1 hour'
  AND sec.term = '2026-2';
```

Esa consulta se puede correr **hoy**, antes de escribir una línea: da la línea base
contra la que se juzga todo lo demás.

---

## Decisión 3 — La prioridad es deuda de frescura, y el checkpoint sigue siendo la base

**No hay tabla de cola.** Igual que en la fase 2: el checkpoint son los marcadores de
frescura, no un cursor. La cola se **calcula**, y por eso reiniciar el daemon no pierde
nada y dos instancias no se desincronizan.

La unidad de prioridad es la **deuda**: cuánto lleva vencido el objetivo de su nivel.

```
deuda(asignatura) = (now - seats_checked_at) / objetivo_de_su_nivel
```

Deuda 1.0 = justo en el objetivo. 3.0 = lleva tres veces su intervalo sin mirarse. Se
ordena por deuda descendente y se corta en el tamaño del lote. Es una sola métrica,
comparable entre niveles, y hace que un caliente atrasado 6 min gane sobre un frío
atrasado 5 h — que es lo correcto.

Esbozo del SQL. **El definitivo, ya escrito y listo para copiar, está en la fase C.2**:

```sql
WITH agg AS (
    SELECT sec.campus_code, sec.code,
           max(sec.seats_checked_at)  AS checked_at,
           min(cs.available_seats)    AS min_seats,
           max(cs.measured_at)        AS changed_at,
           count(*)                   AS sections
    FROM section sec
    JOIN current_seats cs ON cs.section_id = sec.id
    WHERE sec.term = $1
    GROUP BY 1, 2
), tiered AS (
    SELECT a.*, d.hits, d.last_requested_at,
           CASE
             WHEN d.last_requested_at > now() - interval '1 hour' THEN $2::interval  -- hot
             WHEN a.changed_at        > now() - interval '1 hour' THEN $2::interval
             WHEN d.last_requested_at > now() - interval '7 days' THEN $3::interval  -- warm
             WHEN a.min_seats <= 3                                THEN $3::interval
             ELSE                                                      $4::interval  -- cold
           END AS target
    FROM agg a
    LEFT JOIN course_demand d USING (campus_code, code)
)
SELECT campus_code, code,
       extract(epoch FROM now() - coalesce(checked_at, 'epoch'::timestamptz))
       / extract(epoch FROM target) AS debt
FROM tiered
ORDER BY debt DESC
LIMIT $5;
```

Tres cosas que este SQL tiene que respetar y que ya están resueltas en el repo:

1. **Filtrar `disabled_at IS NULL`** al elegir el plan desde el que se hace el POST
   (`course_program`), como ya hacen `CoursesNeedingDetail` y `SeatsHotSet`.
2. **Agrupar el lote por programa** antes de despachar. Una goroutine por **programa**,
   nunca por asignatura: la conexión queda parqueada y repartir sus asignaturas entre
   workers reabre §30/§31/§33. `eachProgram` + `fetchDetails` ya hacen exactamente esto.
3. **Elegir el plan de forma estable.** `SeatsHotSet` hoy ordena por
   `cp.detail_fetched_at DESC`, así que el plan desde el que se mide una asignatura
   **cambia** en cada vuelta. Para `live` conviene fijarlo (`ORDER BY cp.program_id`,
   estable) — ver la Decisión 6, que es la razón de fondo.

### El nivel no puede salir de `hits` a secas

`course_demand.hits` es monotónico. A los tres meses el hot set es "lo popular en
agosto" y no se mueve más. `live` necesita **decaimiento**: una pasada diaria
`UPDATE course_demand SET hits = hits / 2` (o el filtro por `last_requested_at`, que ya
está en el índice). Es una línea, y sin ella la prioridad se osifica en silencio —
misma clase de fallo que el proxy de `detail_fetched_at` que la fase 2 ya rechazó.

**Cómo se detecta:** cuántas de las top-100 por `hits` fueron pedidas en los últimos 7
días. Si baja de la mitad, el decaimiento no está funcionando.

---

## Decisión 4 — Un 404 no apaga nada: dispara la relectura del catálogo de ese plan

Esto ata `live` con lo último que se hizo ([`PLAN-SIACHANGES.md`](PLAN-SIACHANGES.md),
commits `d24676d`…`c49b82a`).

Hoy, `unknown_course` sale de dos sitios distintos que el cliente no distingue:

| Origen | Qué significa de verdad |
|---|---|
| El plan no lista la asignatura en el cache (`course_program.disabled_at`) | **La reconciliación ya decidió**: el SIA dejó de ofrecerla. Es definitivo y no cuesta un POST |
| `findRow` no la encontró en el SIA | **Todavía no se sabe**: puede ser una baja real, o un hipo (el precedente exacto es `3cdcd9b`) |

El principio de `PLAN-SIACHANGES` manda: *una ausencia solo es una baja si la lectura
que la produjo fue completa*. **El detalle no es una lectura completa del plan**, así
que `live` **nunca** puede apagar un `course_program` por un 404 de detalle. Lo que hace
en cambio, y esto es lo que lo vuelve valioso:

1. **Saca la asignatura de la rotación** con backoff (Decisión 5). Si no, el daemon
   reintenta una materia inexistente 288 veces al día, para siempre.
2. **Encola un `catalog` de ESE plan** — 13 POSTs, medido. El catálogo **sí** es una
   lectura completa, tiene autoridad para apagar, y ya está blindado por
   `suspectShrunkCatalog` (0 filas o encogimiento >50 % ⇒ error, no baja).
3. Cuando la reconciliación la apaga, **desaparece sola de la rotación**: todas las
   consultas del scheduler filtran `disabled_at IS NULL`.

El efecto de producto es el remate de `c49b82a`: hoy el "quitar de la lista" aparece
cuando la reconciliación semanal ya pasó. Con esto la baja llega en **horas**, y el
mensaje que ve el usuario deja de ser un limbo entre "no existe" y "el SIA tuvo un
hipo".

**Guardas, porque esto es un disparador automático de escrituras destructivas:**

| Guarda | Por qué |
|---|---|
| Tope de relecturas de catálogo encoladas por hora (p. ej. 20) | Un cambio de página en el SIA daría 404 en todo; sin tope, `live` relee 1380 planes y multiplica el daño |
| Nunca reencolar el mismo plan dos veces en la misma hora | Un plan con 30 bajas dispararía 30 relecturas idénticas |
| El 404 **no** cuenta como fallo del circuit breaker | Es un resultado, no un error de infraestructura. Contarlo apagaría el daemon el día que la UNAL retire 50 materias |
| Sí cuenta en un contador propio (`not_found`) visible en el `Report` | Es la señal de que el SIA cambió; si se dispara, se mira a mano |

---

## Decisión 5 — Cuarentena en memoria, y que sea en memoria a propósito

Dos casos ya conocidos rompen un bucle continuo:

- **§39**: hay asignaturas que **tumban al SIA** (`2011302`, `2018602` en Bogotá): CDATA
  cortado y redirect a `errorNavegacion.jsf`. Sin detectarlas, la conexión se lleva por
  delante las asignaturas siguientes del plan.
- **404 persistente** (Decisión 4).

En un daemon que las visitaría cada 5 minutos, reintentar es intolerable. La respuesta
más barata: un `map[courseKey]{fails, nextTry}` **en memoria del daemon**, con backoff
exponencial (5 min → 10 → 20 → … → 24 h) y reseteo al primer éxito.

En memoria, no en la base, y es deliberado: un fallo del SIA se cura solo, y un
reinicio del proceso es la forma más barata de darle otra oportunidad a todo. Una
columna `detail_failed_at` sería una migración, un estado que sobrevive al arreglo del
bug y una segunda cosa que puede desincronizarse de los datos.

---

## Decisión 6 — Plan estable por asignatura, y **no** se toca `UpsertDetail`

`UpsertDetail` reconcilia `section_program` del plan que hizo el POST (`10cf5b3`). Eso
es correcto y funciona; el riesgo no está en el código sino en **cómo lo llama el job**.

- La visibilidad de grupos es un **subconjunto estricto** por plan (25 grupos en
  Sistemas, 23 en Industrial — medido).
- `SeatsHotSet` elige hoy el plan con `ORDER BY cp.detail_fetched_at DESC`, así que el
  plan desde el que se mide una asignatura **cambia entre vueltas**. A 288 vueltas por
  día, cada cambio de plan apaga y reactiva grupos reales del otro. **Flapping**, con
  datos incorrectos en el intervalo — el mismo escenario con que `PLAN-SIACHANGES`
  justifica que `section.disabled_at` no exista.

**La cura es una línea en la consulta del job, no un cambio en el camino de escritura:**
fijar el plan (`ORDER BY cp.program_id`, estable). Mide siempre desde el mismo plan,
reconcilia siempre la misma visibilidad, y el flapping desaparece por construcción.

Lo que **no** se hace: un `reconcile bool` en `UpsertDetail`. Sería tocar el camino que
usa la API para arreglar un problema que el job se causa solo, y dejaría dos semánticas
de escritura donde hoy hay una. **Si tras la fase C, con el plan ya fijo, todavía
aparece flapping medido** (filas de `section_program` cambiando de `disabled_at` sin que
el SIA cambie), entonces se reabre — con el dato en la mano, no antes.

Cómo se detecta el flapping, para poder decir "no apareció" con algo más que una
impresión:

```sql
-- Grupos que se apagaron y reactivaron más de una vez en 24 h no existen
-- en un SIA estable: son el job midiendo desde planes distintos.
SELECT sp.program_id, count(*) AS grupos_que_parpadearon
FROM section_program sp
WHERE sp.disabled_at > now() - interval '24 hours'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

---

## Lo que hay que considerar (la lista completa)

Ordenado por cuánto duele si se ignora.

### 1. La cortesía es el techo real, no el SIA

El SIA aguanta 80 conexiones (rampa medida 2026-08-19; 88 ya falla ~4.5 %). Lo que no
aguanta un servidor público de universidad es que le saquemos 140 GB/día. **El
presupuesto se elige, se escribe y se vigila**, y baja en la ventana nocturna.

### 2. La invariante de conexiones está mal escrita en el código

`cmd/refresher/main.go` tiene `maxTotalConnections = 8` con el comentario "el techo
medido: 8 sesiones concurrentes". [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) §5 dice
**80** desde el 2026-08-19. Hoy no molesta porque nadie sube de 4+2; el día que `live`
pida 8 workers, el proceso arranca gritando un warning falso. **Arreglarlo es
prerrequisito de la fase C.4**, y hay que decidir a la vez qué margen se le reserva a la API
(propuesta: `api + live ≤ 16`, muy por debajo del techo, porque el límite lo pone el
ancho de banda mucho antes que el servidor).

### 3. El limitador de cortesía ya topa en ~2.3 workers

`REFRESH_RATE_POSTS_PER_SEC=6` contra 2.6 POSTs/s por worker. Subir workers sin subirlo
es no hacer nada. Y ojo con el limitador actual: es un ticker compartido y **`live` lo
necesita así** (sin acumulación de crédito), pero el coste de latencia por operación
sube con W.

### 4. La sesión de ~4.2 min se invierte de riesgo

En un daemon las conexiones ocupadas nunca son idle, así que el problema deja de ser
"se murió por inactividad" y pasa a ser el contrario: un pool grande medio ocioso fuera
de temporada gasta un POST de keepalive cada 45 s por conexión, sin medir nada.
**Encoger el pool fuera de inscripciones.**

### 5. ~~Amplificación de escrituras en Postgres~~ — **descartada por medición**

La preocupación era real en teoría y **falsa en los números**:

| Tabla | Tamaño | Filas vivas | Filas muertas |
|---|---|---|---|
| `section` | 2 712 kB | 8 715 | 1 287 |
| `seat_snapshot` | 1 608 kB | 11 477 | **0** |
| `course` | 35 MB | 28 246 | 4 395 |

Con 8 705 secciones (no las ~87 000 que estimé) y autovacuum haciendo su trabajo, el
`UPDATE` por sección de `seats_checked_at` no es un problema y no lo va a ser a esta
escala. **No entra en el plan.** Se revisa si `section` pasa de ~50 000 filas.

### 6. `seat_snapshot` en temporada real

El dedupe de la migración `00002` lo salvó de la escritura tonta, pero si los cupos se
mueven de verdad, las filas son legítimas y crecen. Hoy pesa 1.6 MB. Si algún día
resulta caro: retención (90 días) o *rollup* horario. **No decidir antes de medir.**

### 7. El circuit breaker no tiene fronteras en un daemon

Hoy cuenta por corrida y aborta con `os.Exit`. `live` no tiene corrida. Necesita:

- ventana deslizante (últimas ~200 unidades) en vez de contador de corrida,
- freno **con backoff** (pausar 5 min y reintentar) en vez de morir — un daemon que sale
  a las 3 a.m. por un hipo se queda muerto hasta que alguien lo mire,
- y la métrica del §38 vigilada por ciclo: **`posts / courses_ok`**. Si se despega de
  3.7 hay un bug de navegación, y es la única señal que lo delata. `programs_failed` no
  sirve: 38 programas "OK" taparon 1795 asignaturas fallidas.

### 8. Observabilidad: un `refresh_run` por ciclo

Reusar la tabla tal cual, con `mode='live'`. A 5 min son 288 filas/día, nada. Sin eso,
`/v1/status` no puede decir si el daemon está vivo y midiendo o vivo y girando en vacío
— que es un fallo perfectamente silencioso.

### 9. El parser blindado ya está desplegado — verificarlo igual antes de cada fase

A1 de [`PLAN-SIACHANGES.md`](PLAN-SIACHANGES.md) (cuadrar grupos parseados contra el
conteo de `Profesor:`) entró en `2fbd5e8`, y producción corre `v1.17.0-18-gcaf0cd5`
(= `main`) con la migración `00004` aplicada. **La reconciliación está viva en
producción**, lo cual importa por dos razones:

- `live` multiplica por ~100 lo que el sistema escribe al día, y sin A1 el §40 a esa
  escala llenaría la base de "sin oferta" plausible. Ya está cubierto.
- Las corridas 269 y 270 del barrido de cupos son **posteriores** al deploy y siguen
  costando 8.8–9.0 POSTs por asignatura: el problema de coste **no** lo causaba la
  versión vieja.

Verificación, antes de empezar cada fase:

```bash
ssh robot@ramsus.site "cd /mnt/newhdd/robot/repos/sia-unal-bridge && git log --oneline -1 && \
  docker inspect -f '{{index .Config.Labels \"org.opencontainers.image.version\"}}' sia-unal-bridge-api-1"
```

### 10. Temporada

Fuera de inscripciones los cupos **no se mueven**: 0 cambios en 347 grupos en 35 min
(medido). Correr `live` todo el año es gastar ancho de banda ajeno para reescribir el
mismo número. Interruptor por variable de entorno (no editando cron), y fuera de
temporada todo cae al nivel frío.

### 11. Cambio de semestre

Cuando cambia `SIA_TERM`, `section` queda *keyed* por el término viejo y **todo el
universo queda a deuda infinita de golpe**. El daemon intentaría medirlo todo a la vez.
Necesita arranque escalonado (o simplemente: `live` apagado hasta que `catalog` +
`detail` hayan pasado una vez con el término nuevo).

### 12. Contrapresión con la API

Los dos procesos compiten por el **SIA**, no por Postgres. La señal de que `live` está
ahogando a los usuarios es el `503 busy` de la API (`SIA_ACQUIRE_TIMEOUT_SECONDS=45`).
Propuesta: `live` lee su propia tasa de éxito y el ritmo de `503` de la API desde
`refresh_run`/logs y **baja workers solo**. Empezar sin esto, pero dejar el
gancho.

### 13. Sin identificación posible

No se puede poner un User-Agent que diga quiénes somos: con UA de navegador el servidor
devuelve bootstrap JS (§2), y el default de Go es lo único verificado que funciona. Es
un argumento más para que el presupuesto sea conservador: no hay forma de que la UNAL
nos distinga ni nos pida bajar el ritmo.

---

## Ejecución — cómo se lleva esto a cabo

> **Esta sección está escrita para que alguien que no participó en el análisis pueda
> ejecutarla al pie de la letra.** Cada fase trae: qué archivos se tocan, el comando
> exacto, la salida esperada, el criterio de aceptación verificable, y cómo revertir.
> Si un criterio de aceptación no se cumple, **no se pasa a la fase siguiente**.

### Convenciones y accesos

| Cosa | Valor |
|---|---|
| Repo local | `/Users/gabotachak/Repos/sia-unal-bridge` |
| Repo en el server | `/mnt/newhdd/robot/repos/sia-unal-bridge` |
| Acceso | `ssh robot@ramsus.site` |
| Base | Postgres en el contenedor `sia-unal-bridge-db-1`, usuario `sia`, base `sia_bridge` |
| Log del Job | `/var/log/sia-refresher.log` |
| Cron | `/etc/cron.d/sia-refresher` (editable **solo con `sudo`, que pide contraseña**) |
| Imagen del Job | `sia-unal-bridge-refresher:latest`, misma que `api`, entrypoint `refresher` |

**Correr SQL en producción** — la forma que funciona (evita el infierno de comillas de
fish: se escribe el SQL a un archivo local y se manda por stdin):

```sh
cat > /tmp/q.sql <<'SQL'
SELECT count(*) FROM course;
SQL
ssh robot@ramsus.site "cd /mnt/newhdd/robot/repos/sia-unal-bridge && \
    docker compose exec -T db psql -U sia -d sia_bridge" < /tmp/q.sql
```

**Correr varios comandos en el server** — mismo truco, con `bash -s`:

```sh
cat > /tmp/cmd.sh <<'SH'
cd /mnt/newhdd/robot/repos/sia-unal-bridge
docker compose ps
SH
ssh robot@ramsus.site 'bash -s' < /tmp/cmd.sh
```

**Cosas que un agente NO puede hacer solo** (piden contraseña de `sudo`): editar
`/etc/cron.d/sia-refresher`, `systemctl`, tocar `/var/log`. Para esas, el runbook da el
comando exacto y **la persona lo pega en su terminal** (en Claude Code, con el prefijo
`!` para que la salida quede en la conversación).

**Reglas duras del repo, que aplican a todas las fases:**

1. El checkout del server **siempre** en `main`. Nunca `git checkout` ahí; si hace falta
   otra rama, `git worktree add ../otra-carpeta esa-rama` ([`COMMANDS.md`](COMMANDS.md)).
2. Un commit por hito, formato de [`COMMIT-CONVENTION.md`](COMMIT-CONVENTION.md). Los
   mensajes exactos están sugeridos en cada fase.
3. Antes de cada commit: `make test` y `make lint` en verde.
4. Los tests que pegan al SIA real solo corren con `SIA_LIVE=1` y **nunca** en CI.
5. Los tests de `store` escriben de verdad: usan `TEST_DATABASE_URL`, que **debe apuntar
   a otra base** que `DATABASE_URL`. Apuntar las dos a la misma metió 28 programas falsos
   en producción una vez.

---

### Fase A · Línea base · *sin código, ~15 min*

Deja escrito contra qué se compara todo lo demás. **No se salta**: sin esto, la fase B
no puede demostrar que mejoró nada.

#### A.1 — Verificar qué corre en producción

```sh
cat > /tmp/a1.sh <<'SH'
cd /mnt/newhdd/robot/repos/sia-unal-bridge
git log --oneline -1
docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}} {{index .Config.Labels "org.opencontainers.image.revision"}}' sia-unal-bridge-api-1
docker compose exec -T db psql -U sia -d sia_bridge -c "SELECT max(version_id) AS migracion FROM goose_db_version;"
SH
ssh robot@ramsus.site 'bash -s' < /tmp/a1.sh
```

**Esperado:** el commit del server es el mismo `main` que local, el label dice
`v1.17.x-…`, y la migración es **4** o más.

**Si no coincide:** desplegar primero siguiendo [`COMMANDS.md`](COMMANDS.md) → "Deploy
manual", y **no seguir** hasta que coincida.

#### A.2 — Guardar la línea base

Guardar la salida de este bloque en `docs/measurements/baseline-YYYY-MM-DD.txt` (crear
la carpeta si no existe) y commitearla:

```sql
\pset pager off
\echo '--- coste por asignatura, ultimas 48 h ---'
SELECT mode, scope, count(*) AS corridas, sum(courses_ok) AS asignaturas,
       round(sum(posts)::numeric / nullif(sum(courses_ok),0), 1) AS posts_por_asig,
       round(sum(bytes)::numeric / nullif(sum(courses_ok),0) / 1024) AS kb_por_asig,
       pg_size_pretty(sum(bytes)) AS bytes_totales,
       count(*) FILTER (WHERE ended_reason <> 'done') AS no_terminadas
FROM refresh_run WHERE started_at > now() - interval '48 hours'
GROUP BY 1,2 ORDER BY 1,2;

\echo '--- SLO: edad de cupos de lo pedido ---'
SELECT 'ultima hora' AS ventana, count(DISTINCT (d.campus_code, d.code)) AS asignaturas,
       round(percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM now() - sec.seats_checked_at))) AS p50_s,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM now() - sec.seats_checked_at))) AS p95_s
FROM course_demand d JOIN section sec ON sec.campus_code = d.campus_code AND sec.code = d.code
WHERE d.last_requested_at > now() - interval '1 hour' AND sec.term = '2026-2'
UNION ALL
SELECT '7 dias', count(DISTINCT (d.campus_code, d.code)),
       round(percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM now() - sec.seats_checked_at))),
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM now() - sec.seats_checked_at)))
FROM course_demand d JOIN section sec ON sec.campus_code = d.campus_code AND sec.code = d.code
WHERE d.last_requested_at > now() - interval '7 days' AND sec.term = '2026-2';

\echo '--- universo ---'
SELECT (SELECT count(*) FROM course) AS cursos,
       (SELECT count(DISTINCT (campus_code, code)) FROM section) AS cursos_con_grupos,
       (SELECT count(*) FROM section) AS secciones;
```

**Línea base conocida (2026-08-22)**, para comparar de un vistazo:

| Métrica | Valor |
|---|---|
| `seats`: POSTs por asignatura | **8.8** |
| `seats`: KB por asignatura | **348** |
| `detail --scope=global`: POSTs por asignatura | **21.7** |
| Gasto diario de `seats` | **4.1 GB**, 103 491 POSTs |
| Corridas de `seats` que terminan | **0 de 67** |
| p50 / p95 de edad de cupos (última hora) | **6 min / 20 h** |

**Commit:** `docs: registrar la línea base de coste y frescura del Job`

---

### Fase B · Bajar el coste por asignatura · *el prerrequisito económico*

**Objetivo medible: `posts_por_asig` del modo `seats` baja de 8.8 a ≤ 6.0.**

La causa está diagnosticada y es de una sola línea de lógica: `findRowInListings`
(`internal/sia/source.go:286`) busca **siempre primero en el listado regular**, y el
listado regular es `soc4=0` = *"TODAS MENOS LIBRE ELECCIÓN"*. Para una asignatura de
libre elección esa búsqueda **no puede encontrarla nunca**: es 2–3 POSTs y el listado
entero de bytes, garantizadamente tirados a la basura, antes de arrancar la cascada de
electivas de 6 POSTs que sí la va a encontrar.

Y son **107 de las 250 del hot set (43 %)**.

#### B.1 — Reproducir el coste, para tener el antes exacto

```sh
cat > /tmp/b1.sh <<'SH'
cd /mnt/newhdd/robot/repos/sia-unal-bridge
docker compose --profile jobs run --rm refresher --mode=seats --scope=hot --workers=1 --max-duration=5m
SH
ssh robot@ramsus.site 'bash -s' < /tmp/b1.sh 2>&1 | tail -20
```

Después, leer lo que quedó registrado:

```sql
SELECT id, courses_ok, posts, round(posts::numeric/nullif(courses_ok,0),1) AS posts_por_asig,
       pg_size_pretty(bytes) AS bytes, ended_reason
FROM refresh_run ORDER BY id DESC LIMIT 1;
```

**Anotar ese número.** Es el "antes".

#### B.2 — Llevar la tipología hasta `findRow`

Cinco archivos, en este orden.

**1. `internal/catalog/refresh.go`** — agregar el campo a `CourseRef`:

```go
type CourseRef struct {
	ProgramID int64
	Code      string
	Name      string

	// Typology is this plan's typology for the course, straight from
	// course_program. It exists for one reason: a libre elección course can
	// ONLY be found in the electives listing (soc4=0 means "todas menos
	// libre elección" — GOTCHAS §21), so searching the regular listing
	// first is 2-3 POSTs and a whole listing of bytes that cannot possibly
	// contain it. Measured 2026-08-22: 43% of the hot set is libre
	// elección, and a course of that kind costs ~10.6 POSTs against the 3.7
	// of a regular one.
	Typology string

	HadSections bool
}

// IsElective reports whether a typology means the course lives in the
// electives listing. The vocabulary is the SIA's and it varies by level and
// sede — these are the values actually present in production (2026-08-22),
// not a guess. A typology this does not recognise falls back to the old
// order (regular first), which is slower but never wrong.
func IsElective(typology string) bool {
	switch {
	case strings.HasPrefix(typology, "LIBRE ELECCIÓN"),
		strings.HasPrefix(typology, "ELEGIBLES"),
		strings.HasPrefix(typology, "ELECTIVA"):
		return true
	}
	return false
}
```

**2. `internal/store/refresh.go`** — devolver `cp.typology` en las tres consultas que
construyen `CourseRef`: `CoursesNeedingDetail`, `CoursesNeedingVisibility` y
`SeatsHotSet`. En cada una: agregar `cp.typology` al `SELECT` y `&ref.Typology` al
`Scan`, en la misma posición. En `SeatsHotSet` la columna va dentro del subselect
(`DISTINCT ON`) y también en el `SELECT` exterior.

**3. `internal/sia/source.go`** — `findRow` recibe el orden y lo aplica:

```go
// findRow locates the row to click. electivesFirst flips the order of the
// two listings: a libre elección course is NEVER in the regular one, so
// looking there first is pure waste (see catalog.IsElective).
func findRow(ctx context.Context, conn *SIAConn, key catalog.ProgramKey, code, name string, electivesFirst bool) (Row, error) {
```

y `findRowInListings(ctx, conn, key, code, electivesFirst)` invierte el orden de las dos
mitades **conservando exactamente la semántica de errores actual**, que es lo que
`3cdcd9b` arregló y no se puede perder:

- Si la primera mitad falla con un error que **no** es `catalog.ErrNotFound`, ese error
  se guarda y, si la segunda tampoco resuelve, **se reporta ese error**, nunca un
  `ErrNotFound`. Una asignatura no se declara inexistente por una lectura que se rompió.
- Solo cuando **las dos** mitades contestaron bien y ninguna tiene el código se devuelve
  `catalog.ErrNotFound`.

**4. `internal/sia/source.go`, `fetchDetail`** — pasar el flag:

```go
row, err := findRow(ctx, conn, key, ref.Code, ref.Name, catalog.IsElective(ref.Typology))
```

`FetchDetail` (el de una sola asignatura, sin `CourseRef`) pasa `false`: el read-through
de la API no conoce la tipología en ese punto y **no se toca** — mantiene el
comportamiento de hoy, que es correcto aunque sea más caro.

**5. Tests.** En `internal/catalog`, una tabla para `IsElective` con los seis valores
reales de producción (`LIBRE ELECCIÓN (L)`, `ELEGIBLES (L)`, `ELEGIBLES (U)`,
`ELECTIVA DE PREGRADO (E)`, `ELECTIVA DE PREGRADO (A)`, y uno regular como
`DISCIPLINAR OBLIGATORIA (C)` que debe dar `false`). En `internal/store`, extender los
tests de `refresh_test.go` para que afirmen que la tipología viaja en el `CourseRef`.

```sh
make test && make lint
```

**Commit:** `perf(sia): buscar primero en electivas cuando la asignatura es de libre elección`

#### B.3 — Medir que sirvió

Desplegar y repetir exactamente B.1:

```sh
cat > /tmp/b3.sh <<'SH'
cd /mnt/newhdd/robot/repos/sia-unal-bridge
git pull
export GIT_TAG=$(git describe --tags --always)
export GIT_SHA=$(git rev-parse --short HEAD)
docker compose build refresher
docker compose --profile jobs run --rm refresher --mode=seats --scope=hot --workers=1 --max-duration=5m
SH
ssh robot@ramsus.site 'bash -s' < /tmp/b3.sh 2>&1 | tail -20
```

**Criterio de aceptación** (las tres a la vez):

| Métrica | Antes | Después debe ser |
|---|---|---|
| `posts / courses_ok` | 8.8 | **≤ 6.0** |
| `bytes / courses_ok` | 348 KB | **≤ 250 KB** |
| Asignaturas medidas en 5 min | ~95 | **≥ 130** |

**Si no baja:** el diagnóstico estaba mal y **hay que parar**. Antes de improvisar,
mirar el log con `LOG_LEVEL=debug` y contar POSTs por asignatura a mano en una sola
asignatura de libre elección conocida (`1000019-B` sirve). No seguir a la fase C: sin
este ahorro, `live` cuesta 12.3 GB/día en vez de 3.1.

**Rollback:** `git revert` del commit y `docker compose build refresher`. No hay
migración ni estado que deshacer.

#### B.4 — *(Opcional, solo si B.3 no alcanzó el criterio)* Reusar la cascada de electivas

Para varias asignaturas de libre elección del **mismo programa** y la **misma conexión**,
la cascada de 6 POSTs (`gotoProgram` + `soc4` + `soc5` + `soc10` + `soc6` + `cb1`) se
repite entera por asignatura. En teoría, tras el `Volver` la conexión sigue parada en la
búsqueda de electivas y bastaría un `cb1` nuevo con otro `it11`.

**No implementar a ciegas.** Es territorio de §34 (el `it11` que se queda pegado) y §38
(los `_afrRK` de una tabla que el servidor ya reemplazó), que es exactamente donde este
proyecto se rompe en silencio. El orden correcto es:

1. Reproducirlo **a mano** con la colección `bruno/sia-catalogo/`.
2. Solo si funciona ahí, escribir un test vivo (`SIA_LIVE=1`) que traiga dos asignaturas
   de libre elección del mismo plan y afirme que la segunda cuesta **menos POSTs** que
   la primera y que su detalle **habla de su propio código** (`checkDetailCode`).
3. Recién entonces, el código.

---

### Fase C · El daemon `--mode=live` · *el grueso del código*

**Idea de implementación, y es lo que la hace barata:** `live` **no es un motor nuevo**.
Es un **bucle alrededor de `Run()`**, el que ya existe. Cada vuelta es una corrida
normal de `--mode=seats` con una lista de trabajo distinta, y por eso hereda gratis el
`refresh_run`, el `Report`, el circuit breaker, el limitador y el manejo de señales.

Lo único verdaderamente nuevo son tres cosas: **la consulta de prioridad**, **la
cuarentena** (que tiene que sobrevivir entre vueltas) y **el bucle** con su backoff.

**Este plan no lleva migración.** No hay tabla nueva ni columna nueva: la prioridad se
calcula, la cuarentena vive en memoria y el registro reusa `refresh_run`. Eso hace que
el rollback sea apagar un contenedor.

#### C.1 — Configuración

En `internal/config/config.go`, agregar a la struct `Refresh` y a `LoadRefresh()`, con el
mismo estilo de validación que las que ya están (entero positivo o error explícito,
`time.ParseDuration` para las duraciones):

| Variable | Default | Campo |
|---|---|---|
| `REFRESH_LIVE_ENABLED` | `false` | `LiveEnabled bool` |
| `REFRESH_LIVE_WORKERS` | `2` | `LiveWorkers int` |
| `REFRESH_LIVE_BATCH` | `100` | `LiveBatch int` |
| `REFRESH_LIVE_HOT_INTERVAL` | `5m` | `LiveHot time.Duration` |
| `REFRESH_LIVE_WARM_INTERVAL` | `30m` | `LiveWarm time.Duration` |
| `REFRESH_LIVE_COLD_INTERVAL` | `6h` | `LiveCold time.Duration` |
| `REFRESH_LIVE_NIGHT_FACTOR` | `0.25` | `LiveNightFactor float64` |
| `REFRESH_LIVE_RECHECKS_PER_HOUR` | `20` | `LiveRechecksPerHour int` |

`REFRESH_LIVE_ENABLED` arranca en `false` **a propósito**: el contenedor se puede
desplegar sin que empiece a medir, y se prende cuando la persona quiere.

**Commit:** `feat(config): agregar las variables del modo live del Refresher`

#### C.2 — La consulta de prioridad

**Archivo:** `internal/store/refresh.go`. Método nuevo, al lado de `SeatsHotSet`:

```go
// SeatsByDebt is the live loop's work list: the courses whose seats are most
// overdue relative to the target interval of their tier.
//
//	debt = (now - seats_checked_at) / target_interval_of_its_tier
//
// One comparable number across tiers, so a hot course 6 min late outranks a
// cold one 5 h late — which is the right answer. Only courses with debt >= 1
// are returned: below that they are inside their target and there is nothing
// to do.
//
// The plan each course is measured from is the LOWEST program_id that can see
// it, deliberately stable: UpsertDetail reconciles section_program for the
// plan that made the POST, so a plan that changes between cycles would turn
// the visibility subset of DATA-MODEL.md decision 6 into permanent flapping.
func (s *Store) SeatsByDebt(ctx context.Context, term string,
	hot, warm, cold time.Duration, limit int) ([]catalog.CourseRef, error) {
```

SQL completo (probado contra el esquema de producción; `current_seats` es la vista que
ya usa `store/seats.go`):

```sql
WITH agg AS (
    SELECT sec.campus_code, sec.code,
           max(sec.seats_checked_at) AS checked_at,
           min(cs.available_seats)   AS min_seats,
           max(cs.measured_at)       AS changed_at
    FROM section sec
    JOIN current_seats cs ON cs.section_id = sec.id
    WHERE sec.term = $1
    GROUP BY 1, 2
), tiered AS (
    SELECT a.campus_code, a.code, a.checked_at,
           CASE
             WHEN d.last_requested_at > now() - interval '1 hour' THEN $2::double precision
             WHEN a.changed_at        > now() - interval '1 hour' THEN $2::double precision
             WHEN d.last_requested_at > now() - interval '7 days' THEN $3::double precision
             WHEN a.min_seats <= 3                                THEN $3::double precision
             ELSE                                                      $4::double precision
           END AS target_s
    FROM agg a
    LEFT JOIN course_demand d
           ON d.campus_code = a.campus_code AND d.code = a.code
), scored AS (
    SELECT t.campus_code, t.code,
           extract(epoch FROM now() - coalesce(t.checked_at, 'epoch'::timestamptz)) / t.target_s AS debt
    FROM tiered t
)
SELECT program_id, code, name, typology, debt FROM (
    SELECT DISTINCT ON (s.campus_code, s.code)
           cp.program_id, s.code, c.name, cp.typology, s.debt
    FROM scored s
    JOIN course c          ON c.campus_code  = s.campus_code AND c.code  = s.code
    JOIN course_program cp ON cp.campus_code = s.campus_code AND cp.code = s.code
                          AND cp.disabled_at IS NULL
    WHERE s.debt >= 1
    ORDER BY s.campus_code, s.code, cp.program_id
) t
ORDER BY debt DESC
LIMIT $5
```

`$2`, `$3`, `$4` son los tres intervalos **en segundos** (`hot.Seconds()`, etc.).
`HadSections` se pone en `true` al construir el `CourseRef`: la consulta arranca desde
`section`, así que por construcción todas tienen grupos.

**Puerto:** agregar la firma a la interfaz `Store` en `internal/catalog/ports.go` y el
passthrough de una línea en `internal/catalog/service_refresh.go`, exactamente como está
hecho `SeatsHotSet`. `internal/refresher` **no puede** importar `store` — es un adaptador
driving y el test del hexágono lo verifica.

**Tests** (`internal/store/refresh_test.go`, escriben de verdad, usan
`TEST_DATABASE_URL`):

| Test | Afirma |
|---|---|
| `TestSeatsByDebt_HotBeatsCold` | Una asignatura con demanda de hace 10 min ordena por encima de una fría atrasada 5 h |
| `TestSeatsByDebt_SkipsFresh` | Una medida hace 1 min con objetivo de 5 min **no** sale en la lista |
| `TestSeatsByDebt_StablePlan` | Dos llamadas seguidas devuelven el **mismo** `program_id` para la misma asignatura |
| `TestSeatsByDebt_SkipsDisabled` | Un `course_program` con `disabled_at` no aparece |

**Commit:** `feat(store): priorizar cupos por deuda de frescura en vez de por hits`

#### C.3 — La cuarentena

**Archivo nuevo:** `internal/refresher/quarantine.go`.

```go
// Quarantine keeps courses that just failed out of the rotation for a while.
// It lives in MEMORY on purpose: a SIA failure heals on its own, and a
// process restart is the cheapest way to give everything another chance. A
// column would be a migration, a state that outlives the bug that caused it,
// and one more thing that can drift from the data.
//
// Two cases it exists for, both measured:
//   - GOTCHAS §39: courses that CRASH the SIA (2011302, 2018602 in Bogotá).
//     Without this, the live loop would visit them 288 times a day and each
//     visit takes the connection down with the rest of the plan's batch.
//   - A course the SIA answers ErrNotFound for. Retrying cannot help; what
//     helps is re-reading the plan's catalog (see enqueueRecheck).
type Quarantine struct {
	mu    sync.Mutex
	until map[string]time.Time
	fails map[string]int
}

func (q *Quarantine) Blocked(key string) bool
func (q *Quarantine) Fail(key string, notFound bool)   // backoff 5m→10m→…→24h; notFound salta directo a 24h
func (q *Quarantine) OK(key string)                    // limpia el contador
func (q *Quarantine) Len() int
```

`key` es `campus_code + "/" + code`. Backoff exponencial con tope de 24 h.

En `internal/refresher/refresher.go`, agregar a `Options`:

```go
// Quarantine is set only by the live loop: a one-shot sweep has nowhere to
// remember a backoff to. Nil means no quarantine, which is the behaviour of
// every cron mode today.
Quarantine *Quarantine
```

En `modes.go`:

- `seats()` (o la rama nueva de `ScopeDebt`) filtra los `refs` cuyo `Blocked(key)` sea
  `true`, **antes** de agrupar por programa.
- `fetchDetails()`, en la rama de error por asignatura: `q.Fail(key, errors.Is(ferr, catalog.ErrNotFound))`; en la de éxito: `q.OK(key)`.
- **Un `ErrNotFound` no cuenta como fallo del circuit breaker.** Es un resultado, no una
  avería: contarlo apagaría el daemon el día que la UNAL retire 50 materias. Se cuenta
  aparte, en un contador nuevo del `Report` (`NotFound int`), que sí se loguea.

**Test** (`internal/refresher/quarantine_test.go`, sin red): dos fallos seguidos dan
backoff creciente; un `notFound` bloquea 24 h; un éxito limpia el contador.

**Commit:** `feat(refresher): poner en cuarentena las asignaturas que fallan en bucle`

#### C.4 — El bucle

**Archivo nuevo:** `internal/refresher/live.go`.

```go
// ModeLive is not a sweep: it is a LOOP around Run(), one cycle at a time,
// each cycle a normal seats sweep whose work list comes from SeatsByDebt.
// Everything a cycle needs — refresh_run bookkeeping, the Report, the circuit
// breaker, the courtesy limiter, signal handling — already exists in Run and
// is reused as is.
const ModeLive = "live"

// ScopeDebt is the work list built by Store.SeatsByDebt.
const ScopeDebt = "debt"

// Loop runs cycles until ctx is done. It returns nil on a clean shutdown:
// stopping is normal, and the checkpoint is the freshness marks in the
// database, so there is nothing to hand over.
func Loop(ctx context.Context, svc *catalog.Service, opts Options, stats func() (int64, int64)) error
```

Cuerpo, en orden:

1. `q := &Quarantine{}`, `opts.Quarantine = q`, `opts.Mode = ModeSeats`, `opts.Scope = ScopeDebt`.
2. Bucle `for ctx.Err() == nil`:
   1. **Ritmo nocturno.** Si la hora local está fuera de 06:00–22:00, la tasa efectiva es
      `RatePostsPerSec × NightFactor`. Se aplica poniendo `opts.RatePostsPerSec` antes de
      llamar a `Run` — el limitador se construye dentro de `Run`, así que cambia solo.
   2. `rep, err := Run(cycleCtx, svc, opts, stats)` con `opts.MaxDuration` = el tiempo de
      un ciclo (ver abajo).
   3. **Backoff ante circuit breaker.** Si `err != nil`, dormir 5 min y seguir.
      **Nunca `os.Exit`**: un daemon que se muere a las 3 a.m. por un hipo se queda
      muerto hasta que alguien lo mire.
   4. **Relectura de catálogo.** Tomar hasta `RechecksPerHour` planes de la cola que
      llenó el `ErrNotFound` (ver C.5) y llamar `svc.Catalog(ctx, program, 0)` para cada
      uno. Un plan no se reencola dos veces en la misma hora.
   5. Si el `Report` dice que **no había trabajo** (`ProgramsTotal == 0`), dormir 60 s:
      todo está dentro de su objetivo, que es el estado deseado y no un error.
3. Al salir, loguear el resumen y devolver `nil`.

`opts.MaxDuration` para un ciclo: **`REFRESH_LIVE_HOT_INTERVAL`** (5 min por defecto).
Así el peor caso de espera de una asignatura caliente es un ciclo, y el `refresh_run`
queda con `ended_reason='deadline'` cuando el lote no cupo — que es información útil, no
un fallo.

**`cmd/refresher/main.go`:**

```go
mode := flag.String("mode", "", "reference | catalog | detail | seats | live")
```

- Añadir `live` a la validación y al mensaje de error.
- El advisory lock ya se toma por modo (`"refresh:"+*mode`) y se libera con el `defer`:
  para `live` eso significa que lo tiene **durante toda la vida del proceso**, que es
  justo lo que hace falta para que no corran dos daemons.
- El freno: si `*mode == "live"` y `!rcfg.LiveEnabled`, salir con código 0 y un log, sin
  abrir una sola conexión al SIA — igual que hace hoy `REFRESH_ENABLED=false`.
- Llamar a `refresher.Loop(...)` en vez de `refresher.Run(...)`.
- **Arreglar `maxTotalConnections`**: hoy vale `8` y su comentario dice "el techo
  medido: 8 sesiones concurrentes". El techo medido es **80**
  ([`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) §5, rampa del 2026-08-19). Dejarlo en 8 hace
  que el proceso grite un warning falso en cuanto `live` pida 4 workers. Cambiarlo a
  `16` **con un comentario que explique que 16 no es el techo del SIA sino el margen que
  este proyecto se reserva**, y que el techo real es 80.

**Commit:** `feat(refresher): agregar el modo live, un bucle continuo sobre la deuda de frescura`

#### C.5 — La relectura de catálogo ante un 404

Cerrar el círculo con [`PLAN-SIACHANGES.md`](PLAN-SIACHANGES.md). Reglas, en orden de
importancia:

1. **`live` nunca apaga un `course_program` por un 404 de detalle.** El detalle no es una
   lectura completa del plan, y el principio del plan de reconciliación es que *una
   ausencia solo es baja si la lectura que la produjo fue completa*.
2. Ante `catalog.ErrNotFound` en una asignatura: cuarentena 24 h **y** encolar el
   `program_id` para relectura.
3. La relectura es `svc.Catalog(ctx, program, 0)` — el mismo caso de uso que usa la API,
   que ya trae las dos mitades, ya reconcilia y ya está protegido por
   `suspectShrunkCatalog` (0 filas o encogimiento >50 % ⇒ error, no baja).
4. Topes: `REFRESH_LIVE_RECHECKS_PER_HOUR` (20) y **nunca el mismo plan dos veces en la
   misma hora**. Sin eso, el día que la UNAL repinte la página, todo da 404 y el daemon
   relee 1380 catálogos.
5. Cuando la reconciliación apaga la asignatura, **desaparece sola** de la rotación: la
   consulta de C.2 filtra `cp.disabled_at IS NULL`.

**Test** (`internal/refresher`, sin red, con un `catalog.Service` de mentira): 50 cursos
que fallan con `ErrNotFound` producen **como máximo** `RechecksPerHour` relecturas y
**no** disparan el circuit breaker.

**Commit:** `feat(refresher): releer el catálogo del plan cuando una asignatura da 404`

#### C.6 — Antes de desplegar

```sh
make test && make lint
go test -race ./internal/refresher/...
```

Y una corrida en seco contra producción, **sin** dejarla suelta: un solo ciclo, pocos
workers, desde el server:

```sh
cat > /tmp/c6.sh <<'SH'
cd /mnt/newhdd/robot/repos/sia-unal-bridge
git pull
export GIT_TAG=$(git describe --tags --always)
export GIT_SHA=$(git rev-parse --short HEAD)
docker compose build refresher
REFRESH_LIVE_ENABLED=true timeout 400 docker compose --profile jobs run --rm \
  -e REFRESH_LIVE_ENABLED=true -e REFRESH_LIVE_WORKERS=1 -e REFRESH_LIVE_BATCH=40 \
  refresher --mode=live
SH
ssh robot@ramsus.site 'bash -s' < /tmp/c6.sh 2>&1 | tail -30
```

**Criterio de aceptación:**

- Al menos un ciclo completo, con su fila en `refresh_run` (`mode='seats'`,
  `scope='debt'`).
- `posts / courses_ok` **≤ 6.0** (el número que dejó la fase B).
- Ningún `502 sia_noop` en el log.
- `Ctrl-C` / `SIGTERM` corta limpio, sin dejar el advisory lock tomado: verificarlo
  corriendo el mismo comando otra vez y viendo que **arranca** en vez de salir con
  "another sweep of this mode is still running".

---

### Fase D · Puesta en producción · *comandos exactos*

#### D.1 — Quitar la línea de `seats` del cron

**Esto lo tiene que correr una persona: `sudo` pide contraseña.** En Claude Code, con el
prefijo `!` para que la salida quede en la conversación.

Paso 1, respaldo y edición (comentar la línea, **no borrarla** — el comentario es el
rollback):

```sh
ssh robot@ramsus.site
sudo cp /etc/cron.d/sia-refresher /etc/cron.d/sia-refresher.bak-$(date +%F)
sudo sed -i 's|^\*/15 6-22 \* \* \*|#DESACTIVADA-POR-LIVE &|' /etc/cron.d/sia-refresher
```

Paso 2, verificar que quedó comentada y que las otras tres siguen vivas:

```sh
grep -v '^#[^D]' /etc/cron.d/sia-refresher | grep -v '^ *$'
```

**Esperado:** las líneas de `reference`, `catalog` y `detail` intactas, y la de `seats`
empezando con `#DESACTIVADA-POR-LIVE`.

Paso 3, confirmar que cron releyó el archivo (cron.d se relee solo al cambiar el mtime;
si hay dudas, `sudo systemctl restart cron`) y que en los siguientes 20 minutos **no**
aparecen filas nuevas de `mode='seats', scope='hot'`:

```sql
SELECT id, mode, scope, started_at FROM refresh_run
WHERE mode = 'seats' ORDER BY id DESC LIMIT 5;
```

> **Por qué se quita:** dos mecanismos midiendo cupos es trabajo duplicado contra el SIA.
> El advisory lock **no** lo evita, porque son modos distintos (`refresh:seats` contra
> `refresh:live`).

#### D.2 — El servicio en `docker-compose.yml`

Agregar **después** del bloque `refresher`, copiando su estilo:

```yaml
  # El modo continuo de la fase 3 (docs/PLAN-ULTIMATE-SYNC.md). Misma imagen
  # que `api` y que `refresher`, otro modo, y `restart: unless-stopped`
  # porque este NO termina: es un bucle.
  #
  # Perfil propio `live`, separado de `jobs`: `docker compose up -d` no lo
  # levanta, y las corridas de cron con `--profile jobs` no lo tocan.
  #
  #   docker compose --profile live up -d live
  live:
    build:
      context: .
      args:
        GIT_TAG: ${GIT_TAG:-dev}
        GIT_SHA: ${GIT_SHA:-unknown}
    profiles: ["live"]
    entrypoint: ["refresher"]
    command: ["--mode=live"]
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-sia}:${POSTGRES_PASSWORD:-sia}@db:5432/${POSTGRES_DB:-sia_bridge}?sslmode=disable
      SIA_BASE_URL: ${SIA_BASE_URL:-https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf}
      SIA_POOL_SIZE: ${SIA_POOL_SIZE:-4}
      SIA_TERM: ${SIA_TERM:-2026-2}
      LOG_LEVEL: ${LOG_LEVEL:-info}
      REFRESH_ENABLED: ${REFRESH_ENABLED:-true}
      REFRESH_RATE_POSTS_PER_SEC: ${REFRESH_RATE_POSTS_PER_SEC:-6}
      REFRESH_LIVE_ENABLED: ${REFRESH_LIVE_ENABLED:-false}
      REFRESH_LIVE_WORKERS: ${REFRESH_LIVE_WORKERS:-2}
      REFRESH_POOL_SIZE: ${REFRESH_LIVE_WORKERS:-2}
      REFRESH_LIVE_BATCH: ${REFRESH_LIVE_BATCH:-100}
      REFRESH_LIVE_HOT_INTERVAL: ${REFRESH_LIVE_HOT_INTERVAL:-5m}
      REFRESH_LIVE_WARM_INTERVAL: ${REFRESH_LIVE_WARM_INTERVAL:-30m}
      REFRESH_LIVE_COLD_INTERVAL: ${REFRESH_LIVE_COLD_INTERVAL:-6h}
      REFRESH_LIVE_NIGHT_FACTOR: ${REFRESH_LIVE_NIGHT_FACTOR:-0.25}
      REFRESH_LIVE_RECHECKS_PER_HOUR: ${REFRESH_LIVE_RECHECKS_PER_HOUR:-20}
      TZ: ${TZ:-America/Bogota}
    depends_on:
      db:
        condition: service_healthy
```

**Commit:** `build: agregar el servicio live al compose`

#### D.3 — Las variables en el `.env` del server

**No se commitea** (`.env` está fuera de git); sí se agregan las mismas líneas a
`.env.example`, que es la fuente de verdad documental.

```sh
cat > /tmp/d3.sh <<'SH'
cd /mnt/newhdd/robot/repos/sia-unal-bridge
cp .env .env.bak-$(date +%F)
cat >> .env <<'ENV'

# --- modo live (docs/PLAN-ULTIMATE-SYNC.md) ---
REFRESH_LIVE_ENABLED=true
REFRESH_LIVE_WORKERS=2
REFRESH_LIVE_BATCH=100
REFRESH_LIVE_HOT_INTERVAL=5m
REFRESH_LIVE_WARM_INTERVAL=30m
REFRESH_LIVE_COLD_INTERVAL=6h
REFRESH_LIVE_NIGHT_FACTOR=0.25
REFRESH_LIVE_RECHECKS_PER_HOUR=20
ENV
grep -c REFRESH_LIVE .env
SH
ssh robot@ramsus.site 'bash -s' < /tmp/d3.sh
```

**Esperado:** `8`.

> **Ojo con `REFRESH_RATE_POSTS_PER_SEC=6`.** Un worker rinde ~2.6 POSTs/s, así que 6
> topa el proceso en ~2.3 workers **hagas lo que hagas**. Con `LIVE_WORKERS=2` está justo
> bien. Si algún día se suben los workers, hay que subir esto **en la misma edición** o
> no pasa nada — las goroutines se quedan esperando el ticker.

#### D.4 — Arrancar y verificar

```sh
cat > /tmp/d4.sh <<'SH'
cd /mnt/newhdd/robot/repos/sia-unal-bridge
git pull
export GIT_TAG=$(git describe --tags --always)
export GIT_SHA=$(git rev-parse --short HEAD)
docker compose build live
docker compose --profile live up -d live
sleep 20
docker compose --profile live ps live
docker compose --profile live logs --tail=40 live
SH
ssh robot@ramsus.site 'bash -s' < /tmp/d4.sh
```

**Criterio de aceptación, a los 30 minutos:**

```sql
-- 1. Los ciclos están corriendo y son sanos
SELECT id, started_at, finished_at - started_at AS dur, courses_ok, posts,
       round(posts::numeric/nullif(courses_ok,0),1) AS posts_por_asig,
       pg_size_pretty(bytes) AS bytes, ended_reason
FROM refresh_run WHERE mode='seats' AND scope='debt' ORDER BY id DESC LIMIT 8;

-- 2. El SLO se está moviendo en la dirección correcta
SELECT round(percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM now()-sec.seats_checked_at))) AS p50_s,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM now()-sec.seats_checked_at))) AS p95_s
FROM course_demand d JOIN section sec ON sec.campus_code=d.campus_code AND sec.code=d.code
WHERE d.last_requested_at > now() - interval '1 hour' AND sec.term='2026-2';
```

| Métrica | Antes (línea base) | A los 30 min | A las 24 h |
|---|---|---|---|
| p95 de edad (última hora) | 20 h | **< 2 h** | **< 15 min** |
| p50 de edad (última hora) | 6 min | < 6 min | **< 5 min** |
| `posts / courses_ok` | 8.8 | ≤ 6.0 | ≤ 6.0 |
| Ciclos con `ended_reason='error'` | — | 0 | 0 |

**Si el p95 no baja en 24 h:** el lote es muy chico o el presupuesto muy bajo. Subir
`REFRESH_LIVE_BATCH` primero (no cuesta POSTs, solo recalcula prioridad menos seguido);
si no alcanza, `REFRESH_LIVE_WORKERS=3` **y** `REFRESH_RATE_POSTS_PER_SEC=9` juntos.

#### D.5 — Rollback (30 segundos, sin pérdida de datos)

```sh
cat > /tmp/rollback.sh <<'SH'
cd /mnt/newhdd/robot/repos/sia-unal-bridge
docker compose --profile live stop live
docker compose --profile live rm -f live
SH
ssh robot@ramsus.site 'bash -s' < /tmp/rollback.sh
```

Y devolver el cron viejo (**una persona, `sudo`**):

```sh
sudo sed -i 's|^#DESACTIVADA-POR-LIVE ||' /etc/cron.d/sia-refresher
grep '15 6-22' /etc/cron.d/sia-refresher
```

**No hay nada más que revertir**: no hay migración, no hay tabla nueva, y los datos que
`live` escribió son los mismos que escribiría cualquier otra medición de cupos.

---

### Fase E · Vigilancia · *qué mirar y qué hacer*

Correr esto una vez al día durante la primera semana, y después cuando algo se sienta
raro.

```sql
\pset pager off
\echo '--- 1. la metrica que delata un bug de navegacion (§38) ---'
SELECT date_trunc('hour', started_at) AS hora, count(*) AS ciclos,
       sum(courses_ok) AS asignaturas,
       round(sum(posts)::numeric/nullif(sum(courses_ok),0),1) AS posts_por_asig,
       pg_size_pretty(sum(bytes)) AS bytes
FROM refresh_run WHERE mode='seats' AND scope='debt' AND started_at > now() - interval '24 hours'
GROUP BY 1 ORDER BY 1 DESC LIMIT 12;

\echo '--- 2. el SLO por nivel ---'
SELECT CASE
         WHEN d.last_requested_at > now() - interval '1 hour' THEN '1-caliente'
         WHEN d.last_requested_at > now() - interval '7 days' THEN '2-tibio'
         ELSE '3-frio' END AS nivel,
       count(DISTINCT (sec.campus_code, sec.code)) AS asignaturas,
       round(percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM now()-sec.seats_checked_at))) AS p50_s,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM now()-sec.seats_checked_at))) AS p95_s
FROM section sec LEFT JOIN course_demand d ON d.campus_code=sec.campus_code AND d.code=sec.code
WHERE sec.term='2026-2' GROUP BY 1 ORDER BY 1;

\echo '--- 3. flapping de visibilidad (deberia ser 0 filas) ---'
SELECT program_id, count(*) AS grupos_apagados_hoy
FROM section_program WHERE disabled_at > now() - interval '24 hours'
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

\echo '--- 4. la demanda no se osifico ---'
SELECT count(*) FILTER (WHERE last_requested_at > now() - interval '7 days') AS top100_vivas
FROM (SELECT * FROM course_demand ORDER BY hits DESC LIMIT 100) t;
```

| Señal | Umbral | Qué hacer |
|---|---|---|
| `posts_por_asig` | se despega de ~4–6 | **Parar `live`.** Es un bug de navegación, no ruido. Fue lo que delató el §38 |
| p95 del nivel caliente | > 15 min sostenido | Subir `LIVE_BATCH`; si no, workers **y** rate juntos |
| Flapping (consulta 3) | cualquier plan con muchos grupos apagados a diario | Revisar que el plan elegido sea estable (C.2) — es la Decisión 6 |
| `top100_vivas` | < 50 | La demanda se osificó: implementar el decaimiento diario (`UPDATE course_demand SET hits = hits/2`) |
| Tamaño de `seat_snapshot` | > 500 MB | Retención de 90 días o rollup horario |
| `503 busy` en la API | > 1 % en una hora | Bajar `LIVE_WORKERS` a 1 |

#### Y una cosa que esta fase hereda y no arregla

El barrido nocturno `detail --scope=global` corre a **21.7 POSTs por asignatura** y sus
últimas dos corridas terminaron en `circuit_breaker` y `deadline`. La fase B **debería**
mejorarlo también, porque comparte `findRow`. **Re-medirlo después de la fase B:**

```sql
SELECT id, started_at, courses_ok, posts,
       round(posts::numeric/nullif(courses_ok,0),1) AS posts_por_asig, ended_reason
FROM refresh_run WHERE mode='detail' ORDER BY id DESC LIMIT 5;
```

Si sigue por encima de 10, es un problema **aparte de este plan** y merece su propia
investigación — probablemente el mismo diagnóstico (asignaturas de libre elección que
pagan el listado regular en vano), pero sobre el universo entero en vez de sobre el hot
set.

---

## Lo que **no** se hace acá

- **Alertas de cupo.** El historial ya las soporta y `live` las vuelve útiles de verdad,
  pero son producto, no crawler. Van en su propio plan.
- **Endpoint de historial de cupos** (`/sections/{key}/history`). Habilitado por
  `seat_snapshot`, fuera de alcance.
- **Cualquier optimización que implique cachear un `_afrRK`.** Sigue siendo la regla que
  mató al proyecto anterior.
- **Un segundo camino a Postgres.** `live` entra por `catalog.Service`, punto.
- **Predecir cuándo se libera un cupo.** Con el historial se podrá; no es este plan.

---

## Qué documentos hay que tocar al cerrar

| Documento | Cambio |
|---|---|
| [`FASE-2.md`](FASE-2.md) | el modo `seats` de cron queda superado por `live`; enlazar acá |
| [`ARCH.md`](ARCH.md) | el puerto `Refresher` pasa a tener un modo continuo; la invariante de conexiones nueva |
| [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) | §2 **ya está respondida** por la fase A — llevar los números allá; §5 con el margen que `live` reserva |
| [`API.md`](API.md) | `/v1/status` con el estado del daemon y los p95 por nivel |
| [`DATA-MODEL.md`](DATA-MODEL.md) | **nada** — este plan no lleva migración: sin tabla de cola, sin columna nueva |
| [`GOTCHAS.md`](GOTCHAS.md) | lo que destape el bucle continuo, que será algo — la fase 2 destapó seis |
| [`COMMANDS.md`](COMMANDS.md) | dice que el servicio del Job "todavía no existe": ya existe, y ahora hay dos (`refresher` y `live`) |
| `deploy/cron.d/sia-refresher` | la línea de `seats` queda **comentada** con `#DESACTIVADA-POR-LIVE` (fase D.1), no borrada — el comentario es el rollback |
| `docker-compose.yml` | el servicio `live` bajo su propio perfil (fase D.2) |
| `.env.example` | las ocho variables `REFRESH_LIVE_*` de la fase C.1 |
