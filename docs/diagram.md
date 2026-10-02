# Diagramas del proyecto

El proyecto entero en diagramas Mermaid, de afuera hacia adentro: quién habla con quién,
cómo está armado el hexágono y por dónde viaja cada petición desde `main` hasta el SIA y
de vuelta.

Este documento **explica**, no define. Si un diagrama y el código no coinciden, manda el
código. El contrato HTTP está en `internal/httpapi/openapi.yaml` y las trampas del
protocolo en [GOTCHAS.md](GOTCHAS.md).

**Índice**

1. [El sistema completo](#1-el-sistema-completo)
2. [Despliegue: contenedores y CI/CD](#2-despliegue-contenedores-y-cicd)
3. [El hexágono](#3-el-hexágono)
4. [Las dependencias entre paquetes](#4-las-dependencias-entre-paquetes)
5. [Arranque: `cmd/bridge`](#5-arranque-cmdbridge)
6. [Una petición HTTP de punta a punta](#6-una-petición-http-de-punta-a-punta)
7. [Rutas, handlers y casos de uso](#7-rutas-handlers-y-casos-de-uso)
8. [Flujo de referencia: de código público a índice de dropdown](#8-flujo-de-referencia-de-código-público-a-índice-de-dropdown)
9. [Flujo de catálogo: stale-while-revalidate](#9-flujo-de-catálogo-stale-while-revalidate)
10. [Flujo de detalle: read-through con tres atajos](#10-flujo-de-detalle-read-through-con-tres-atajos)
11. [Flujo de cupos](#11-flujo-de-cupos)
12. [Deduplicación: `shared` y `refreshBehind`](#12-deduplicación-shared-y-refreshbehind)
13. [Dentro de `SIASource`: el pool](#13-dentro-de-siasource-el-pool)
14. [La conexión ADF como máquina de estados](#14-la-conexión-adf-como-máquina-de-estados)
15. [Las dos cascadas, POST por POST](#15-las-dos-cascadas-post-por-post)
16. [Keepalive](#16-keepalive)
17. [Errores de dominio a status HTTP](#17-errores-de-dominio-a-status-http)
18. [El `Refresher`](#18-el-refresher)
19. [Modelo de datos](#19-modelo-de-datos)
20. [La interfaz web](#20-la-interfaz-web)

---

## 1. El sistema completo

Tres procesos nuestros (`web`, `api` y `refresher`) y dos ajenos (Postgres y el SIA).
El navegador nunca habla con la API directo: nginx, el servidor de la `web`, le pasa
`/v1/*`. Los clientes externos entran por `sia-api.gabotachak.dev`.

```mermaid
flowchart LR
    user(["Estudiante<br/>navegador"])
    ext(["Cliente externo<br/>curl, Bruno, otra app"])

    subgraph server["Servidor"]
        caddy["Caddy<br/>TLS + reverse proxy"]
        subgraph compose["docker compose"]
            web["web<br/>nginx + SPA React"]
            api["api<br/>cmd/bridge"]
            refresher["refresher<br/>cmd/refresher<br/>manual, profile jobs"]
            db[("Postgres")]
        end
    end

    sia[["SIA UNAL<br/>Oracle ADF<br/>sesión con estado"]]

    user -- "sia.gabotachak.dev" --> caddy
    ext -- "sia-api.gabotachak.dev" --> caddy
    caddy -- ":13000" --> web
    caddy -- ":18080" --> api
    web -- "/v1/* proxy_pass" --> api
    api -- "pgx" --> db
    api -- "pool de sesiones ADF<br/>POST form-urlencoded" --> sia
    refresher -- "pgx" --> db
    refresher -- "SU PROPIO pool" --> sia
```

La regla que importa: `conexiones(api) + conexiones(refresher) ≤ 80` sesiones ADF
simultáneas. Es el techo medido del SIA ([OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) §5).

---

## 2. Despliegue: contenedores y CI/CD

Un merge a `main` dispara `semantic-release`, que versiona según el mensaje del commit
([COMMIT-CONVENTION.md](COMMIT-CONVENTION.md)). Luego `paths-filter` decide qué hay que
redesplegar y solo eso se toca por SSH.

```mermaid
flowchart TD
    pr["PR a main"] --> ci["ci.yml<br/>tests Go + web"]
    pr --> lint["commitlint + pr-title-lint"]
    ci --> merge["merge a main"]
    lint --> merge
    merge --> sr["semantic-release<br/>tag vX.Y.Z + Release"]
    sr --> filter{"paths-filter:<br/>¿qué cambió?"}

    filter -- "migrations/**" --> m["make migrate"]
    filter -- "internal/**, cmd/bridge/**, Dockerfile" --> a["make deploy-api"]
    filter -- "web/**" --> w["make deploy-web"]
    filter -- "cmd/refresher/**, internal/refresher/**" --> j["make deploy-jobs"]

    m --> ssh["SSH al servidor:<br/>git pull + make ..."]
    a --> ssh
    w --> ssh
    j --> ssh
    ssh --> hc["curl /v1/healthz"]
```

Los comandos concretos están en [COMMANDS.md](COMMANDS.md).

---

## 3. El hexágono

El dominio (`internal/catalog`) está en el centro y no sabe de HTTP, SQL ni ADF. Declara
dos **puertos driven** (`Store`, `SIASource`) como interfaces en `ports.go`. Los adaptadores
de afuera los implementan. Dos **adaptadores driving** (`httpapi` y `refresher`) entran por
el mismo `catalog.Service`.

```mermaid
flowchart LR
    subgraph driving["Adaptadores DRIVING<br/>(quién pide)"]
        http["internal/httpapi<br/>gin, /v1/..."]
        ref["internal/refresher<br/>barrido por modos"]
    end

    subgraph core["DOMINIO: internal/catalog"]
        svc["catalog.Service<br/>read-through, singleflight,<br/>frescura, SWR"]
        types["Tipos: Program, Course,<br/>Section, SeatSnapshot..."]
        ports{{"Puertos (ports.go)<br/>Store · SIASource"}}
        svc --- types
        svc --> ports
    end

    subgraph driven["Adaptadores DRIVEN<br/>(a quién se le pide)"]
        store["internal/store<br/>pgx → Postgres"]
        sia["internal/sia<br/>Source → Pool → SIAConn"]
    end

    http -- "llama casos de uso" --> svc
    ref -- "llama casos de uso" --> svc
    ports -. "implementa Store" .- store
    ports -. "implementa SIASource" .- sia
    store --> pg[("Postgres")]
    sia --> adf[["SIA ADF"]]

    main1["cmd/bridge"] -. "cablea" .-> http
    main2["cmd/refresher"] -. "cablea" .-> ref
```

Por qué así:

- El `Refresher` **no escribe en la base por su cuenta**. Entra por `catalog.Service`,
  igual que un cliente HTTP. Hay un solo upsert de catálogo, no dos que se desincronicen.
- `gin.Context` nunca cruza al dominio: los handlers pasan `c.Request.Context()`.
- `cmd/*` son el único sitio con *wiring*. No tienen lógica.

---

## 4. Las dependencias entre paquetes

Todas las flechas apuntan hacia `catalog`. Ningún paquete de adentro importa uno de
afuera. `internal/catalog/hexagon_test.go` falla si eso se rompe.

```mermaid
flowchart BT
    catalog["internal/catalog<br/>(dominio + puertos)"]
    config["internal/config"]
    httpapi["internal/httpapi"] --> catalog
    refresher["internal/refresher"] --> catalog
    store["internal/store"] --> catalog
    sia["internal/sia"] --> catalog

    bridge["cmd/bridge"] --> httpapi
    bridge --> store
    bridge --> sia
    bridge --> catalog
    bridge --> config

    job["cmd/refresher"] --> refresher
    job --> store
    job --> sia
    job --> catalog
    job --> config

    httpapi -. "gin, x/time/rate" .- libs1(("libs"))
    store -. "pgx v5" .- libs2(("libs"))
    sia -. "goquery, x/net/html,<br/>encoding/xml" .- libs3(("libs"))
    catalog -. "solo x/sync/singleflight" .- libs4(("libs"))
```

Prohibido, y verificado por test:

- `catalog` importando `gin`, `pgx`, `goquery` o `encoding/xml`.
- `catalog` o `refresher` importando `sia`, `store` o `httpapi`.

---

## 5. Arranque: `cmd/bridge`

`main.go` arma las piezas de adentro hacia afuera y arranca el servidor. El pool queda
**usable** con 4 conexiones y termina de llenarse en segundo plano.

```mermaid
sequenceDiagram
    autonumber
    participant M as main()
    participant C as config
    participant S as store.New
    participant P as sia.NewPool
    participant SIA as SIA ADF
    participant SV as catalog.Service
    participant R as httpapi.NewRouter
    participant H as http.Server

    M->>C: config.Load() desde env
    M->>S: store.New(DATABASE_URL)
    S-->>M: *Store sobre pgxpool
    M->>P: NewPool(SIA_BASE_URL, SIA_POOL_SIZE)
    loop hasta 4 conexiones, en secuencia
        P->>SIA: GET bootstrap (ViewState + cookies)
        SIA-->>P: 52 KB a 4.5 MB
    end
    P-->>M: pool usable
    Note over P: go fill(): resto del pool<br/>de a una conexión
    M->>P: go pool.Keepalive(ctx)
    M->>SV: NewService(store, sia.NewSource(pool), term)
    M->>SV: ServeStale = true
    M->>R: NewRouter(svc, cooldown, rate limit, timeouts)
    M->>H: ListenAndServe en :PORT
    Note over M,H: SIGINT/SIGTERM: srv.Shutdown con 10 s
```

---

## 6. Una petición HTTP de punta a punta

El camino completo de `GET /v1/campuses/1101/programs/2A74/courses/2016696` cuando no
está en cache. Cada caja es un paquete distinto.

```mermaid
sequenceDiagram
    autonumber
    actor U as Cliente
    participant MW as httpapi<br/>middleware
    participant HD as httpapi<br/>courseDetail
    participant SV as catalog.Service
    participant ST as store (Postgres)
    participant SR as sia.Source
    participant PL as sia.Pool
    participant CN as sia.SIAConn
    participant SIA as SIA ADF

    U->>MW: GET .../courses/2016696
    MW->>MW: Recovery, requestID, logger,<br/>secureHeaders, rate limit por IP,<br/>timeout = SIA_ACQUIRE_TIMEOUT
    MW->>HD: next()
    HD->>SV: ResolveProgram(campus, faculty, code, level)
    SV->>ST: ReferenceFetchedAt + Programs
    ST-->>SV: Program{ID, índices de dropdown}
    HD->>ST: RecordDemand (vía Service)
    HD->>HD: refreshBlocked? (cooldown de max_age=0)
    HD->>SV: CourseDetail(ctx, program, code, maxAge)
    SV->>ST: CourseProgramFetchedAt
    ST-->>SV: viejo o nulo: miss
    SV->>SR: FetchDetail(key, ref, term)
    SR->>PL: DoAt(key, fn)
    PL->>PL: acquireAt: ¿conexión ya<br/>parqueada en este programa?
    PL->>CN: fn(conn)
    CN->>SIA: cascada soc1..soc3 (si hace falta)
    CN->>SIA: soc4 + cb1 (listado)
    SIA-->>CN: tabla con _afrRK
    CN->>SIA: click en la fila (detalle)
    SIA-->>CN: región pt1:r1:N
    CN->>SIA: Volver pt1:r1:N:cb4
    CN-->>PL: CourseOffering
    PL-->>SR: devuelve la conexión al pool
    SR-->>SV: CourseOffering
    SV->>ST: UpsertDetail (sección, horario,<br/>visibilidad, seat_snapshot)
    SV->>ST: readCourse (relee lo guardado)
    SV-->>HD: offering + FetchResult{miss, ms}
    HD-->>U: 200 JSON + X-Cache, Age, Cache-Control
```

Con la conexión ya parqueada en el programa son 2 POSTs y ~1.3 s. En frío son
1 GET + 6 POSTs y ~10 s ([ARCH.md](ARCH.md), "Rutas mínimas medidas").

---

## 7. Rutas, handlers y casos de uso

Qué handler atiende cada ruta y en qué método de `catalog.Service` termina. Las rutas
grises nunca llaman al SIA: leen solo Postgres.

```mermaid
flowchart LR
    subgraph rutas["/v1"]
        r0["/healthz /status /version<br/>/openapi.yaml /docs"]
        r1["/levels"]
        r2["/campuses"]
        r3["/campuses/:campus/faculties"]
        r4["/campuses/:campus/programs"]
        r5["…/programs/:program"]
        r6["…/programs/:program/courses"]
        r7["…/courses/:code"]
        r8["…/courses/:code/sections<br/>…/sections/:key"]
        r9["…/sections/:key/seats"]
        r10["/campuses/:campus/courses?q="]
        r11["/campuses/:campus/courses/:code"]
    end

    subgraph svc["catalog.Service"]
        s1["Levels"]
        s2["Campuses"]
        s3["Faculties"]
        s4["ProgramsInFaculty"]
        s5["ResolveProgram"]
        s6["Catalog (+ Schedules)"]
        s7["CourseDetail"]
        s9["SectionSeats"]
        s10["SearchCourses"]
        s11["ProgramsOfferingCourse"]
        sh["SIAHealth, LastRuns"]
    end

    r0 --> sh
    r1 --> s1
    r2 --> s2
    r3 --> s3
    r4 --> s4
    r5 --> s5
    r6 --> s5 --> s6
    r7 --> s7
    r8 --> s7
    r9 --> s9
    r10 --> s10
    r11 --> s11

    classDef storeOnly fill:#eee,stroke:#999,color:#333
    class r10,r11,s10,s11 storeOnly
```

Todas las rutas bajo `…/programs/:program` resuelven el programa primero
(`resolveProgram` → `Service.ResolveProgram`). Detalle, secciones y cupos son **el mismo
POST** visto de cuatro formas, así que comparten fetch, cache y cooldown.

---

## 8. Flujo de referencia: de código público a índice de dropdown

El cliente habla en códigos (`1101`, `2A74`, `pregrado`). El SIA navega por **posiciones**
de dropdown, que son volátiles. `Service.coordinates` es el único sitio donde un código se
convierte en índice, y lo hace leyendo la cache de referencia (TTL 30 días).

```mermaid
flowchart TD
    req["ResolveProgram<br/>campus=1101, code=2A74, level=''"] --> ed["ensureDirectory(1101, pregrado)"]
    ed --> co["coordinates()"]
    co --> lv["Levels(): cache 'levels'<br/>¿fresco? si no, FetchLevels (soc1)"]
    lv --> rl["resolveLevel: '' → pregrado<br/>slug → índice soc1"]
    rl --> cp["Campuses(pregrado): cache 'campuses:pregrado'<br/>¿fresco? si no, FetchCampuses (soc9)"]
    cp --> find{"¿existe campus 1101?"}
    find -- no --> nf["ErrNotFound → 404"]
    find -- sí --> dir{"ReferenceFetchedAt<br/>'programs:1101:pregrado'<br/>¿fresco (30 d)?"}
    dir -- sí --> read["store.Programs(1101, faculty, pregrado)"]
    dir -- "no, pero hay copia" --> bg["refreshBehind: cascada<br/>en segundo plano"] --> read
    dir -- "no hay nada" --> fetch["FetchProgramDirectory<br/>~15 POSTs, TODAS las facultades"] --> up["UpsertPrograms + sello TTL"] --> read
    read --> match{"¿cuántos con code=2A74?"}
    match -- 0 --> nf
    match -- 1 --> ok["Program con LevelIdx, CampusIdx,<br/>FacultyIdx, ProgramIdx"]
    match -- "2 o más" --> amb["AmbiguousError → 300<br/>pista: ?faculty="]
```

Un miss de directorio llena **todas** las facultades de la sede: la cascada ya pagó por
ellas.

---

## 9. Flujo de catálogo: stale-while-revalidate

El catálogo de un plan casi no cambia en el semestre. Con `ServeStale` (activo en
`cmd/bridge`), si hay **cualquier** copia guardada se responde ya y el SIA se consulta por
detrás. Solo espera quien nunca abrió ese programa, o quien fuerza `?max_age=0`.

```mermaid
flowchart TD
    in["GET …/programs/2A74/courses"] --> rp["ResolveProgram"]
    rp --> fr{"catalog_fetched_at<br/>¿fresco? (7 d o ?max_age)"}
    fr -- sí --> hit["store.ProgramCourses<br/>X-Cache: hit"]
    fr -- no --> forced{"¿max_age=0?"}
    forced -- no --> exists{"¿hay copia guardada?"}
    exists -- sí --> stale["Responde ProgramCourses ya<br/>X-Cache: stale"]
    stale -.-> behind["refreshBehind (goroutine):<br/>misma función refresh"]
    exists -- no --> wait
    forced -- sí --> wait["shared(): espera el refresh<br/>X-Cache: miss"]

    subgraph refresh["refresh() — el catálogo son DOS consultas"]
        direction TB
        f1["FetchCatalog: soc4=0<br/>todas MENOS libre elección"] --> f2["FetchElectives: soc4=7<br/>buscador de electivas de la sede"]
        f2 --> chk["checkListing por mitad (tope 1000)<br/>suspectShrunkCatalog"]
        chk --> ups["UpsertCatalog: las dos mitades<br/>en UNA transacción + sello"]
        ups --> reread["Relee ProgramCourses<br/>(recupera cupos ya medidos)"]
    end

    behind --> refresh
    wait --> refresh
```

`?include=schedules` añade `Service.Schedules`, que lee solo Postgres: nunca dispara al
SIA.

---

## 10. Flujo de detalle: read-through con tres atajos

El detalle **no** es SWR: trae cupos, y unos cupos viejos servidos como frescos mentirían.
Pero hay tres salidas antes de gastar un POST, y una red de seguridad si el SIA falla.

```mermaid
flowchart TD
    in["CourseDetail(program, code, maxAge)"] --> d{"maxAge &lt; 0"}
    d -- sí --> def["maxAge = 24 h"] --> q
    d -- no --> q["CourseProgramFetchedAt<br/>(programa, código)"]
    q --> f1{"¿fresco para maxAge?"}
    f1 -- sí --> hit["readCourse → hit"]
    f1 -- no --> f2{"¿la visibilidad del programa<br/>tiene &lt; 24 h y TODOS sus grupos<br/>se midieron dentro de maxAge<br/>(desde cualquier programa)?"}
    f2 -- sí --> hit2["readCourse → hit<br/>los cupos son globales"]
    f2 -- no --> rd["refreshDetail<br/>(singleflight por programa:código)"]
    rd --> ok{"¿el SIA respondió?"}
    ok -- sí --> miss["UpsertDetail + readCourse → miss"]
    ok -- no --> keep{"¿max_age=0, ErrNotFound,<br/>cliente se fue o no hay copia?"}
    keep -- sí --> err["error → status (sección 17)"]
    keep -- no --> st["Sirve la copia vieja<br/>X-Cache: stale"]
```

Dentro de `refreshDetail`, el nombre guardado filtra el listado por `it11` (de 241 KB
a 15–27 KB). Si la tipología es libre elección, se busca primero en electivas.

Antes de todo esto, el handler aplica el **cooldown**: un `max_age` menor que
`FETCH_COOLDOWN` sobre una asignatura recién traída responde `429 refresh_cooldown` con
`Retry-After`.

---

## 11. Flujo de cupos

Los cupos son el único dato volátil (TTL 5 min). Pero nunca llegan solos: traerlos cuesta
el detalle completo. Por eso un miss de cupos **guarda todo** y devuelve solo la sección
pedida.

```mermaid
sequenceDiagram
    autonumber
    actor U as Cliente
    participant H as sectionSeats
    participant S as Service.SectionSeats
    participant ST as Store
    participant D as refreshDetail
    participant SIA as SIA

    U->>H: GET …/sections/1/seats
    H->>H: recordDemand + cooldown
    H->>S: SectionSeats(program, code, key=1, maxAge)
    S->>ST: Sections (vía section_program)
    alt medición de menos de 5 min
        ST-->>S: sección con Seats fresco
        S-->>H: hit
    else vieja o no visible desde este programa
        S->>D: refreshDetail (mismo POST que el detalle)
        D->>SIA: listado + click + Volver
        SIA-->>D: todos los grupos con cupos
        D->>ST: UpsertDetail: section, class_session,<br/>section_program, seat_snapshot (append)
        D-->>S: CourseOffering completo
        S->>S: busca la sección key=1
        S-->>H: miss
    end
    H-->>U: available, measured_at, age_seconds, changed_at
```

`seat_snapshot` es *append-only*: cada medición queda como historia.

---

## 12. Deduplicación: `shared` y `refreshBehind`

Dos piezas en `catalog/service.go` evitan pedir al SIA lo mismo dos veces.

- **`shared`**: un `singleflight` por clave (`catalog:<id>`, `<id>:<code>`, scope de
  referencia). Diez clientes que piden lo mismo en frío generan **un** fetch. Si el primer
  cliente cancela, el fetch sigue: corre con `context.WithoutCancel` y el *deadline*
  original.
- **`refreshBehind`**: la mitad *revalidate* del SWR. Como mucho un arranque por clave por
  minuto. Corre en el carril de fondo del pool (`WithBackground`) con su propio timeout de
  3 min.

```mermaid
sequenceDiagram
    autonumber
    participant A as Cliente A
    participant B as Cliente B
    participant SF as shared()<br/>singleflight
    participant FN as refresh fn
    participant SIA as SIA

    A->>SF: DoChan("catalog:42")
    SF->>FN: arranca con WithoutCancel(ctx A)
    B->>SF: DoChan("catalog:42")
    Note over SF: misma clave: B se cuelga<br/>del vuelo de A
    FN->>SIA: FetchCatalog + FetchElectives
    A--xSF: A cancela (cerró la pestaña)
    Note over FN: el fetch NO se cancela
    SIA-->>FN: listados
    FN->>FN: UpsertCatalog
    FN-->>SF: resultado
    SF-->>B: mismo resultado
```

---

## 13. Dentro de `SIASource`: el pool

`sia.Source` implementa el puerto `SIASource`. Cada método termina en `DoAt`, que toma una
conexión del pool, ejecuta la **operación lógica entera** con ella y la devuelve
**utilizable**. El canal con buffer **es** el mutex: mientras una conexión está fuera del
canal, nadie más la toca.

```mermaid
flowchart TD
    call["Source.FetchDetail / FetchCatalog / ..."] --> doat["DoAt(ctx, pool, key, fn)"]
    doat --> bg{"¿IsBackground(ctx)?"}
    bg -- sí --> lane["Toma un cupo del carril de fondo<br/>(máx. mitad del pool)"] --> acq
    bg -- no --> acq["acquireAt(key)"]
    acq --> aff{"¿hay una conexión libre YA parqueada<br/>en key y fuera de detalle?"}
    aff -- sí --> got["la usa: se ahorra la cascada"]
    aff -- no --> blk["Acquire: espera en el canal"]
    blk -- "ctx vence" --> busy["ErrBusy → 503 busy"]
    blk --> got
    got --> sus{"¿conn.suspect?"}
    sus -- sí --> boot0["Bootstrap antes de usarla"] --> run
    sus -- no --> run["fn(conn)"]
    run --> res{"resultado"}
    res -- ok --> rel["release: vuelve al canal"]
    res -- "error no recuperable" --> rep["repair: Volver o Bootstrap"] --> rel
    res -- "noop o región vieja" --> boot["Bootstrap (contexto propio, 45 s)"]
    boot --> retry["fn(conn) una vez más"]
    retry -- ok --> rel
    retry -- "otra vez noop" --> mark["conn.suspect = true<br/>repair"] --> rel
```

Reglas que el pool impone:

- **N peticiones concurrentes = N conexiones.** Nunca dos operaciones sobre una sesión: el
  SIA no lo rechaza, le da a un hilo la respuesta del otro (GOTCHAS §28).
- La reparación **nunca** usa el contexto del cliente: un cliente que cancela es justo el
  caso en que la conexión queda a mitad de operación.

---

## 14. La conexión ADF como máquina de estados

Una `SIAConn` es una sesión ADF viva. Lo que ahorra POSTs es **saber dónde está**:
`navLevel/navCampus/navFaculty`, `ParkedAt`, `navTipologia` y `DetailRegion`.

```mermaid
stateDiagram-v2
    [*] --> Bootstrapped: GET inicial<br/>ViewState + cookies
    Bootstrapped --> Navegando: soc1 / soc9 / soc2<br/>(solo los que cambian)
    Navegando --> Parqueada: soc3 (programa)
    Parqueada --> Parqueada: otro programa:<br/>re-cascada parcial
    Parqueada --> ListadoRegular: soc4=0 + cb1
    Parqueada --> ListadoElectivas: soc4=7, soc5, soc10, soc6 + cb1
    ListadoRegular --> Detalle_N: click en fila _afrRK
    ListadoElectivas --> Detalle_N: click en fila _afrRK
    Detalle_N --> Parqueada: Volver pt1:r1:N:cb4<br/>(N leído de la respuesta)
    ListadoRegular --> Parqueada
    ListadoElectivas --> Parqueada

    Bootstrapped --> Muerta: ~4.2 min sin tráfico
    Parqueada --> Muerta: ~4.2 min sin tráfico
    Muerta --> Bootstrapped: Bootstrap (keepalive o Do)

    note right of Detalle_N
        N sube con cada detalle.
        Con N=1 fijo, el segundo
        detalle deja la sesión
        inservible (GOTCHAS §20).
    end note
```

En la región de detalle, cualquier acción del buscador es un **no-op de ~900 B**.
`noop.go` lo convierte en `ErrSIANoop`. Nunca se trata como éxito.

---

## 15. Las dos cascadas, POST por POST

El catálogo de un plan son **dos** búsquedas: la regular (`soc4=0`, todo menos libre
elección) y la de electivas (`soc4=7`, por sede). Cada `valueChange` se salta si la
conexión ya tiene ese valor. Excepción: los que hay que forzar con un "rebote" para que
ADF re-renderice (GOTCHAS §30).

```mermaid
sequenceDiagram
    autonumber
    participant C as SIAConn
    participant SIA as SIA ADF

    Note over C,SIA: gotoProgram — se salta lo ya hecho
    C->>SIA: valueChange soc1 (nivel)
    C->>SIA: valueChange soc9 (sede)
    C->>SIA: valueChange soc2 (facultad)
    C->>SIA: valueChange soc3 (programa)
    Note over C: ParkedAt = key

    rect rgba(120,160,255,0.12)
    Note over C,SIA: Cascada regular (FetchCatalog)
    C->>SIA: valueChange soc4=0 (si no está ahí)
    C->>SIA: action cb1 (viewportSize=999)
    SIA-->>C: tabla t4, ~98 filas, 241 KB
    end

    rect rgba(120,220,160,0.12)
    Note over C,SIA: Cascada de electivas (FetchElectives)
    C->>SIA: valueChange soc4=7
    C->>SIA: valueChange soc5 (modo)
    C->>SIA: valueChange soc10 (sede de electivas)
    SIA-->>C: lista soc6 de ESA sede
    C->>SIA: valueChange soc6 (comodín "SEDE …")
    C->>SIA: action cb1
    SIA-->>C: libre elección de toda la sede
    end

    rect rgba(255,190,120,0.12)
    Note over C,SIA: Detalle de una asignatura
    C->>SIA: action pt1:r1:0:t4:RK:cl2 (RK = _afrRK recién parseado)
    SIA-->>C: región pt1:r1:N
    C->>SIA: action pt1:r1:N:cb4 (Volver)
    Note over C: _afrRK se renumeró: re-parsear siempre
    end
```

---

## 16. Keepalive

Una sesión muere a los ~4.2 min de silencio. Un ticker de 3 min no alcanza: una conexión
liberada justo después de un tick llega al siguiente con 2:59 y se salta. Por eso el
ticker corre cada **45 s** y hace ping a todo lo que lleve **≥ 2 min** quieto.

```mermaid
flowchart LR
    t["ticker 45 s"] --> drain["Saca del canal las conexiones LIBRES<br/>(las ocupadas no están ahí)"]
    drain --> each{"por cada una:<br/>¿LastUsed ≥ 2 min?"}
    each -- no --> back["la devuelve al canal"]
    each -- sí --> ping["Ping: POST liviano"]
    ping -- ok --> back
    ping -- "error o no-op ~900 B" --> boot["Bootstrap"] --> back
```

---

## 17. Errores de dominio a status HTTP

El dominio devuelve errores con nombre (`catalog/errors.go`). Solo `httpapi/errors.go` sabe
de status codes.

```mermaid
flowchart LR
    e1["context.Canceled"] --> s499["499 (cliente colgó)"]
    e2["ErrNotFound"] --> s404["404 unknown_program /<br/>unknown_course / unknown_section"]
    e3["AmbiguousError"] --> s300["300 + candidates + hint"]
    e4["ErrBusy<br/>(pool lleno o deadline)"] --> s503["503 busy + Retry-After: 2"]
    e5["ErrSIASessionLost"] --> s502a["502 sia_session_lost"]
    e6["ErrSIANoop"] --> s502b["502 sia_noop"]
    e7["otro"] --> s500["500 internal"]
    h1["handler: cooldown"] --> s429["429 refresh_cooldown"]
    h2["handler: max_age inválido"] --> s400["400"]
    h3["middleware: rate limit por IP"] --> s429b["429"]
```

---

## 18. El `Refresher`

Hoy es una **herramienta manual**. Su cron se abandonó el 2026-09-21, porque el SWR de la
API cubre lo que el cron cubría. Levanta su **propio pool** y entra por el mismo
`catalog.Service` (con `ServeStale` apagado: él sí quiere esperar el fetch).

```mermaid
flowchart TD
    start["refresher --mode=... [--scope] [--campus]"] --> en{"REFRESH_ENABLED"}
    en -- false --> bye["exit 0, ni una conexión al SIA"]
    en -- true --> st["store.New"]
    st --> lock{"pg_try_advisory_lock<br/>'refresh:mode'"}
    lock -- "ocupado" --> skip["exit 0: ya hay una corrida"]
    lock -- ok --> pool["sia.NewPool PROPIO<br/>aviso si api + job &gt; 80"]
    pool --> svc["catalog.NewService<br/>(ServeStale = false)"]
    svc --> run["refresher.Run: StartRun en refresh_run"]
    run --> mode{"modo"}

    mode -- reference --> mr["Levels → Campuses → ProgramsInFaculty<br/>por cada sede y nivel"]
    mode -- catalog --> mc["por programa con catálogo viejo:<br/>Service.Catalog"]
    mode -- "detail --scope=global" --> md["CoursesNeedingDetail:<br/>detalle global viejo"]
    mode -- "detail --scope=plan" --> mp["CoursesNeedingVisibility:<br/>visibilidad por plan"]
    mode -- "seats --scope=hot" --> ms["SeatsHotSet: lo más pedido<br/>(course_demand)"]

    md --> fd["RefreshDetails → FetchDetails:<br/>varias asignaturas por UNA conexión"]
    mp --> fd
    ms --> fd

    mc --> eg
    fd --> eg["errgroup.SetLimit(workers)<br/>una goroutine por PROGRAMA<br/>+ limitador de POSTs/s"]
    eg --> cb{"¿muchas fallas seguidas?"}
    cb -- sí --> brk["circuit breaker: corta"]
    cb -- no --> fin["FinishRun + Report"]
    brk --> fin
```

El checkpoint son los **marcadores de frescura**, no un cursor. Reanudar es volver a
correr. Dos corridas seguidas no hacen ni un POST.

---

## 19. Modelo de datos

Dos granularidades de cache: el catálogo es **por programa** (`course_program`) y el
detalle es **por asignatura** (`section`). Los grupos visibles dependen del programa
(`section_program`). Los cupos son globales (`seat_snapshot` cuelga de `section`).

```mermaid
erDiagram
    level ||--o{ campus : "tiene"
    level ||--o{ program : "clasifica"
    program ||--o{ course_program : "ofrece"
    course ||--o{ course_program : "tipología por plan"
    course ||--o{ section : "grupos (code, term, key)"
    section ||--o{ section_program : "visible para"
    program ||--o{ section_program : "ve"
    section ||--o{ class_session : "horario semanal"
    section ||--o{ seat_snapshot : "cupos, append-only"

    level {
        text slug PK
        text name
        smallint level_idx "posición soc1, volátil"
    }
    campus {
        text level_slug PK
        text code PK
        text name
        smallint campus_idx "posición soc9, volátil"
    }
    program {
        bigint id PK
        text campus_code
        text faculty_code
        text code "NO único entre sedes"
        text level_slug
        smallint program_idx "más level, campus, faculty _idx"
        timestamptz catalog_fetched_at
    }
    course {
        text campus_code PK
        text code PK
        text name
        int credits
    }
    course_program {
        bigint program_id PK
        text code PK
        text typology
        timestamptz detail_fetched_at
    }
    section {
        bigint id PK
        text campus_code
        text code
        text term
        text key "token entre paréntesis"
        timestamptz fetched_at
    }
    section_program {
        bigint section_id PK
        bigint program_id PK
    }
    class_session {
        bigint id PK
        bigint section_id
        smallint weekday
        time start_time
        time end_time
    }
    seat_snapshot {
        bigint section_id PK
        timestamptz measured_at PK
        int available_seats
    }
```

Tablas de apoyo, sin relaciones de dominio:

- `reference_fetch`: sello de TTL por lista (`levels`, `campuses:pregrado`,
  `programs:1101:pregrado`).
- `course_demand`: cuántas veces pidió un **cliente** cada asignatura. Alimenta
  `seats --scope=hot`.
- `refresh_run`: bitácora de corridas del `Refresher`. Es observabilidad, no checkpoint.

Esquema completo y sus decisiones en [DATA-MODEL.md](DATA-MODEL.md).

### Frescura por recurso

| Recurso | TTL por defecto | Marcador | Comportamiento al vencer |
|---|---|---|---|
| Referencia (niveles, sedes, programas) | 30 d | `reference_fetch.fetched_at` | SWR |
| Catálogo de un programa | 7 d | `program.catalog_fetched_at` | SWR |
| Detalle de una asignatura | 24 h | `course_program.detail_fetched_at` | espera; copia vieja si el SIA falla |
| Cupos | 5 min | `seat_snapshot.measured_at` | espera |

`?max_age=<segundos>` cambia el TTL de una petición. `?max_age=0` fuerza el SIA.

---

## 20. La interfaz web

React + TypeScript, servida por nginx. Es **un cliente más** de la API pública: nunca toca
Postgres ni importa nada de `internal/`. No hay router: la pantalla activa es estado
(`useNav().screen`). El plan elegido vive en el navegador.

```mermaid
flowchart TD
    subgraph providers["Providers (App.tsx)"]
        pp["PlanProvider<br/>plan elegido"] --> sp["ScheduleProvider<br/>selección de grupos"]
        sp --> pvp["PlanViewProvider<br/>filtro y orden"]
        pvp --> np["NavProvider<br/>pantalla activa"]
        np --> cfp["CatalogFiltersProvider"]
    end

    cfp --> screens{"screen.name"}
    screens --> v1["PlanPicker"]
    screens --> v2["Program<br/>catálogo"]
    screens --> v3["Course<br/>detalle + grupos"]
    screens --> v4["Semester<br/>mi semestre"]
    screens --> v5["Schedule<br/>mi horario + .ics"]

    subgraph data["Datos"]
        hooks["useApi, useCourseDetails<br/>(hasta 32 en paralelo)"]
        cache["lib/detailCache<br/>cache en memoria"]
        client["api/client.ts<br/>fetch('/v1' + path)"]
        hooks --> cache
        hooks --> client
    end

    v2 --> hooks
    v3 --> hooks
    v4 --> hooks
    v5 --> hooks
    client -- "mismo origen" --> nginx["nginx: location /v1/<br/>proxy_pass api:8080"]
    nginx --> api["API /v1"]
```

La medición automática de cupos de una tabla entera manda `?background=1`. Esas peticiones
van al carril de fondo del pool (sección 13), así que nunca ocupan todas las conexiones
mientras una persona espera la página que abrió. El botón "medir" manda `?max_age=0`,
sujeto al cooldown.
