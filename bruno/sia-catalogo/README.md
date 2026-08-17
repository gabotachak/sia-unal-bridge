# Colección Bruno — Catálogo SIA

Flujo completo del catálogo público, verificado end-to-end contra el servidor real
el **2026-08-15**.

Abre esta carpeta en Bruno.app y selecciona el entorno **SIA**.

Referencia completa del protocolo: [`../../docs/PROTOCOL.md`](../../docs/PROTOCOL.md)
Trampas: [`../../docs/GOTCHAS.md`](../../docs/GOTCHAS.md)

---

## Flujo A — asignaturas de una carrera

Corre en orden. Cada petición depende del estado que dejó la anterior.

| # | Petición | Qué hace |
|---|---|---|
| 01 | Bootstrap | GET inicial → captura ViewState |
| 02 | Nivel (soc1) | pregrado / doctorado / postgrado |
| 03 | Sede (soc9) | puebla facultad |
| 04 | Facultad (soc2) | puebla carrera |
| 05 | Carrera (soc3) | puebla tipología |
| 06 | Consultar cursos | **98 asignaturas** (Ing. Sistemas) |
| 07 | Seleccionar fila | **opcional** — resultó innecesaria, ver abajo |
| 08 | Detalle | grupos, profesor, horarios, aula, **cupos** |
| 14 | Volver | obligatorio antes de cualquier acción del buscador |

El paso **07 se puede saltar**. Verificado: el `08` funciona solo, en un único POST,
porque su `DELTAS` ya lleva `selectedRowKeys`. Se deja en la colección para
documentar el evento `selection`, pero la ruta real es `06 → 08`.

## Flujo B — libre elección (todas las facultades mezcladas)

`01` → `02` → `03` → `04` → `05` → `09` → `10` → `11` → `12` → `13`

Pon `tipologia = 7` en el entorno antes del paso 09.

Con `facElect = 12` (comodín "2000 SEDE BOGOTÁ") devuelve ~240 asignaturas de libre
elección de todas las facultades de la sede.

> **`facElect = 12` solo sirve para Bogotá-pregrado.** La posición del comodín cambia con
> la sede (10 en Medellín, 3 en Palmira) y **en doctorado no existe**: `soc6` lista solo
> facultades, así que hay que consultar una por una y unir los resultados. Medido
> 2026-08-17, ver [GOTCHAS §32 y §35](../../docs/GOTCHAS.md).

---

## Variables

| Variable | Default | Nota |
|---|---|---|
| `nivel` | `0` | 0=Pregrado, 1=Doctorado, 2=Postgrado |
| `sede` | `2` | 2=Bogotá, 5=Manizales, 6=Medellín |
| `facultad` | `8` | 8=Ingeniería (en Bogotá) |
| `carrera` | `3` | 3=Ing. Sistemas y Computación |
| `tipologia` | `0` | **7 = libre elección** (activa el flujo B) |
| `modo` | `0` | 0=Por facultad y plan, 1=Por plan de estudios |
| `sedeElect` | `2` | sede del buscador de electivas |
| `facElect` | `12` | **12 = toda la sede**; 0..11 = facultad concreta |
| `nombre` | *(vacío)* | filtro por nombre de asignatura (`it11`) |
| `fila` | `0` | **row key `_afrRK` real**, no la posición |
| `windowId` | `winnoloop` | constante |
| `viewState` | *(vacío)* | lo llena el script de cada petición |
| `regionDetalle` | `1` | lo llena el script del paso 08; **sube con cada detalle** |

`nivel-sede-facultad-carrera` = el "career code" `0-2-8-3`.

---

## Lo que tienes que saber para no perder tiempo

**El User-Agent no puede parecer navegador.** Con Chrome/Firefox el servidor devuelve
7 KB de bootstrap JS que exige ejecutar JavaScript. El UA de Bruno funciona.

**Respuesta de ~900 B = algo falta.** O te saltaste un paso de la cascada, o estás en
la vista de detalle sin haber hecho Volver, o expiró la sesión (~4.2 min de
inactividad). Los scripts de la colección te lo avisan en la consola.

**Tras un detalle, "Volver" (14) es obligatorio antes de *cualquier* cosa** — otra
búsqueda o el detalle de otra asignatura. No es solo entre detalles.

**El Volver no apunta siempre al mismo sitio.** La región de detalle se numera y crece:
1.er detalle `pt1:r1:1`, 2.º `pt1:r1:2`, y así. El paso 08 captura el número en
`regionDetalle` y el 14 lo usa. Verificado en la colección: `08 → 14 → 08 → 14 → 08 →
14` da `regionDetalle` 1, 2, 3 y 98 filas en cada Volver. Con el `1` fijo que tenía
antes, el segundo Volver devolvía 893 B y la sesión parecía muerta.
Ver [`GOTCHAS.md §20`](../../docs/GOTCHAS.md).

**`nombre` (`it11`) filtra en el servidor.** Substring, insensible a acentos. Ojo al
reusar la sesión a mano: el campo viaja en cada POST, así que si lo dejas puesto la
siguiente consulta sale recortada sin avisar ([GOTCHAS §34](../../docs/GOTCHAS.md)).
Baja el payload de 241 KB a 15-27 KB. La ruta más rápida para una asignatura concreta
es `06` con `nombre` puesto, y luego `08`.

**`fila` es el `_afrRK`, no la posición.** Los row keys se acumulan entre búsquedas y
**se renumeran** tras cada "Volver". Lee el `_afrRK` del `<tr>` en la respuesta del
paso 06/13 justo antes de usarlo en 07/08.

**Cuenta los `<tr>`, ignora `_rowCount`.** Acierta unas veces y se queda con un valor
viejo otras, dentro de la misma sesión y sin patrón útil.

**`tipologia = 0` no es "sin filtro": es "todas menos libre elección".** El paso 06
nunca devuelve las asignaturas de libre elección del plan; para esas es el flujo B.

**El paso 11 (soc10) no es opcional.** Saltarlo en el flujo B produce basura silenciosa.

---

## Estructura de la respuesta

`text/xml`, un `<partial-response>`. El contenido va en el CDATA de
`<update id="pt1:r1:0:pb3">`.

Filas: `<tr role="row" _afrRK="N" class="af_table_data-row">` con celdas

| Celda | Campo |
|---|---|
| `c1` | Código (dentro de `<a id="pt1:r1:0:t4:N:cl2">`) |
| `c2` | Asignatura |
| `c5` | Créditos |
| `c6` | Tipología |
| `c8` | Descripción |

El detalle (paso 08) añade, por grupo: profesor, día/hora, aula, edificio,
cupos disponibles, jornada, duración y fechas del periodo.
