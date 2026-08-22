# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

API puente en Go sobre el catálogo público de asignaturas del SIA (Universidad
Nacional de Colombia). El SIA solo expone el catálogo mediante una app Oracle ADF con
estado de sesión en servidor y navegación por POSTs de formulario encadenados. Este
proyecto traduce eso a JSON.

**Estado: en producción.** Tres piezas en este repo:

- **API** (`cmd/bridge` + `internal/`) — read-through de referencia, catálogo, detalle
  y cupos sobre Postgres. Contrato en `internal/httpapi/openapi.yaml`, servido en
  `/v1/docs`.
- **`Refresher`** (`cmd/refresher`) — el Job por cron de la fase 2, que llena la cache
  antes de que un cliente pague el miss.
- **Interfaz** (`web/`) — React + TypeScript. Habla la misma API pública que cualquier
  otro cliente: **nunca** toca Postgres ni importa nada de `internal/`.

La ingeniería inversa del protocolo está completa y verificada contra producción
(2026-08-15, ampliada el 2026-08-17), igual que el funcionamiento multi-sede (Bogotá,
Medellín, Amazonia, Palmira, La Paz).

**La sede es un segmento obligatorio de la ruta**: `/v1/campuses/{campus}/…`. No hay
sede ni nivel privilegiado en el código; las dos listas salen de sus dropdowns y se
cachean como cualquier otra referencia.

## Convención de idioma

- **Código en inglés**: identificadores, tipos, columnas SQL, endpoints, comentarios.
- **Documentación en español.**
- Los literales del SIA se conservan tal cual (`Cupos disponibles:`,
  `LIBRE ELECCIÓN (L)`, `MIÉRCOLES de 09:00 a 11:00.`) — son datos, no texto nuestro.

## Antes de hacer commit

Lee **`docs/COMMIT-CONVENTION.md`**. `semantic-release` lee el mensaje del commit de
merge a `main` para versionar (`vX.Y.Z`) — un prefijo (`feat:`, `fix:`, …) fuera de
formato no rompe nada, pero deja el deploy sin Release ni changelog.

## Antes de escribir código

Lee **`docs/GOTCHAS.md`** completo. No es opcional. Son trampas verificadas contra el
servidor real, varias de las cuales fallan **en silencio** (devuelven datos plausibles
pero equivocados). El proyecto anterior murió por asumir mal cuatro de ellas. El
documento crece: cuántas hay y cuál es la última se leen ahí, no acá.

Las cuatro que más código han roto (más las que destapó el Job de la fase 2 en sedes y
niveles que la API nunca había recorrido, y §40, encontrada en vivo el 2026-08-21):

1. **La región de detalle está numerada y el número sube.** Volver es
   `pt1:r1:<N>:cb4`, con `N` leído de la respuesta del detalle. Con `1` fijo, la
   segunda asignatura de la sesión la deja inservible y **parece sesión caducada**.
2. **El User-Agent no puede parecer navegador.** Con un UA de Chrome el servidor
   devuelve 7 KB de bootstrap JS en vez de la página. El default de Go funciona; no lo
   "mejores".
3. **`_afrRK` se acumula entre búsquedas y se renumera en cada re-render.** Nunca
   enumeres posicionalmente, nunca caches la lista de row keys. Re-parsea siempre.
   Tampoco empieza en 0: el bootstrap puede llegar con la tabla de otra sesión.
4. **Una respuesta de ~900 B no es un error HTTP, es un no-op.** Significa que falta un
   paso de la cascada, que estás en la región de detalle, o que caducó la sesión
   (~4.2 min de inactividad, no 5). Trátala como error explícito.

## Mapa del repo

| Ruta | Qué hay |
|---|---|
| `docs/PLAN-CI-CD.md` | **Plan de deploy automático y versionado semver** |
| `docs/COMMANDS.md` | **Chuleta: deploy, migraciones, qué versión corre dónde, cómo borrar todo** |
| `docs/COMMIT-CONVENTION.md` | **Formato de commits — leer antes de hacer commit** |
| `docs/PLAN.md` | **Plan de implementación: pasos, criterios de aceptación, fixtures** |
| `docs/FASE-2.md` | **La fase 2: el Job, su concurrencia, su cadencia y lo medido al implementarla** |
| `docs/ARCH.md` | Arquitectura: puertos, read-through, pool de sesiones, concurrencia |
| `docs/API.md` | Contrato HTTP: endpoints, IDs públicos, frescura, errores |
| `docs/LAYOUT.md` | Árbol de paquetes Go: qué vive en cada uno y por qué |
| `docs/PROTOCOL.md` | Handshake ADF completo con cuerpos de petición reales |
| `docs/FIELDS.md` | Componentes ADF, opciones de cada dropdown, mapeo a columnas |
| `docs/GOTCHAS.md` | Las trampas verificadas contra el servidor |
| `docs/DATA-MODEL.md` | Esquema Postgres + structs de Go |
| `docs/OPEN-QUESTIONS.md` | Qué está verificado y qué no. Léelo antes de asumir |
| `docs/DEVELOPMENT.md` | Entorno: Docker, Postgres, cómo replicar el flujo |
| `docs/PLAN-PRODUCTION.md` | Cómo esto pasa de localhost al server |
| `docs/PLAN-SIACHANGES.md` | Reconciliar lo que el SIA deja de ofrecer |
| `web/README.md`, `docs/PLAN-FRONTEND.md` | La interfaz: cómo correrla, y su plan |
| `internal/httpapi/openapi.yaml` | **El contrato que manda.** `docs/API.md` explica el porqué, no la forma |
| `.env.example` | **La fuente de verdad de puertos y variables.** Ningún doc los repite |
| `bruno/sia-catalogo/` | Colección Bruno: el flujo ADF crudo, a mano contra el SIA |
| `bruno/bridge-api/` | Colección Bruno: esta API, endpoint por endpoint |

El índice completo, agrupado por para-qué-lo-abrís, está en `README.md`.

## Arquitectura acordada

Hexagonal. Dos puertos driving (`API` y `Refresher`) y dos driven (`Store` Postgres,
`SIASource` ADF).

El `Refresher` **no escribe en la base**: entra por los mismos casos de uso que `httpapi`
(`catalog.Service`), así que hay un solo upsert de catálogo y no dos que se
desincronicen. Levanta **su propio pool** de conexiones, y la invariante que no se negocia
es `conexiones(api) + conexiones(refresher) ≤ 80` (techo medido, `docs/OPEN-QUESTIONS.md`
§5). Su checkpoint son los marcadores de
frescura, no un cursor: reanudar es volver a correr, y dos corridas seguidas no hacen ni
un POST.

Flujo principal: **read-through**. Si está en cache y fresco se sirve; si no, se
consulta al SIA, se responde al cliente y se persiste.

Dos caches con granularidad distinta — esto es lo que más se malentiende:

```
catálogo   → por PROGRAMA    1 POST trae ~98 asignaturas    casi inmutable
detalle    → por ASIGNATURA  1 POST trae 1 asignatura       volátil (cupos)
```

Un miss de catálogo llena el programa entero al mismo costo. El detalle es
irreductiblemente unitario: no hay forma de traer los grupos de varias asignaturas en
una petición.

Con un matiz medido: ese POST de catálogo trae **todas menos las de libre elección**
(`soc4=0` significa eso literalmente). Las libres del plan salen del buscador de
electivas, que es por sede. El catálogo de un plan son dos consultas.

## `SIASource` no es un cliente HTTP

Es un **pool de conexiones ADF con estado**. Cada conexión:

- muere a los **~4.2 min** de inactividad; con ping ≤3 min vive indefinidamente
- es **estrictamente secuencial**: una petición en vuelo a la vez
- está parqueada en un `(level, campus, faculty, program)`; moverla cuesta 2 POSTs
- está en la región del buscador **o** en una región de detalle **numerada**; salir
  cuesta 1 POST al id correcto (`pt1:r1:<N>:cb4`, `N` creciente)

N requests concurrentes ⇒ N conexiones. Fase 1: pool de 4 con mutex por conexión
**sobre la operación lógica** (§28); medido contra producción (2026-08-19), el SIA
aguanta hasta **80** en paralelo sin errores ni throttling — en 88 ya aparece ~4.5% de
fallas (`docs/OPEN-QUESTIONS.md` §5). El pool por defecto se queda en 4 porque el
tráfico real no pide más, no porque el servidor imponga un techo bajo.

Los campos de estado (`parkedAt`, `detailRegion`) son lo que ahorra POSTs: si la
conexión ya está donde toca, son 2 POSTs en vez de 6 (~1.3 s en vez de ~10 s).

## Modelado: cinco cosas que no son obvias

- El listado devuelve **ofertas, no asignaturas**. Los códigos se repiten (hasta ×131).
  Clave natural `(code, term, key)` — `key` es el token entre paréntesis del grupo,
  porque `Grupo N` se repite entre regulares y PEAMA. Nunca `code` solo. Las filas duplicadas
  **sí** se pueden dedupear: su detalle es byte-idéntico.
- **Los grupos visibles dependen del programa** (relación de subconjunto estricto);
  **los cupos son globales**. Por eso `section` es global y `section_program` es la
  tabla de visibilidad, y una sola medición de cupos sirve para todos los programas.
- **La tipología depende del programa** — probado, no supuesto: 8 códigos divergen
  entre planes de Bogotá. Vive en `course_program`.
- **`program.code` no identifica.** Se repite entre sedes (PEAMA): 136 colisiones de
  852 códigos. La identidad es `(campus_code, faculty_code, code)`.
- `group` es **palabra reservada en SQL**. Se usa `section`. Ver la tabla de colisiones
  en `docs/DATA-MODEL.md`.

## Verificar contra el servidor

La colección Bruno (`bruno/sia-catalogo/`) ejecuta el flujo completo a mano. Úsala para
confirmar que el protocolo sigue vigente antes de depurar código propio — los IDs de
componente ADF (`pt1:r1:0:soc1`, etc.) son frágiles por diseño y pueden cambiar si la
UNAL repinta la página.

Si la colección funciona y tu código no, el problema es tuyo. Si la colección tampoco,
el SIA cambió y toca re-mapear con `docs/FIELDS.md`.
