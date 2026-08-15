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
| 07 | Seleccionar fila | devuelve ~900 B vacíos — es normal y obligatorio |
| 08 | Detalle | grupos, profesor, horarios, aula, **cupos** |
| 14 | Volver | obligatorio antes del siguiente detalle |

## Flujo B — libre elección (todas las facultades mezcladas)

`01` → `02` → `03` → `04` → `05` → `09` → `10` → `11` → `12` → `13`

Pon `tipologia = 7` en el entorno antes del paso 09.

Con `facElect = 12` (comodín "2000 SEDE BOGOTÁ") devuelve ~240 asignaturas de libre
elección de todas las facultades de la sede.

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

`nivel-sede-facultad-carrera` = el "career code" `0-2-8-3`.

---

## Lo que tienes que saber para no perder tiempo

**El User-Agent no puede parecer navegador.** Con Chrome/Firefox el servidor devuelve
7 KB de bootstrap JS que exige ejecutar JavaScript. El UA de Bruno funciona.

**Respuesta de ~900 B = algo falta.** O te saltaste un paso de la cascada, o expiró la
sesión (5 min). Los scripts de la colección te lo avisan en la consola.

**`fila` es el `_afrRK`, no la posición.** Los row keys se acumulan entre búsquedas y
**se renumeran** tras cada "Volver". Lee el `_afrRK` del `<tr>` en la respuesta del
paso 06/13 justo antes de usarlo en 07/08.

**Cuenta los `<tr>`, ignora `_rowCount`.** Ese atributo se queda con el valor de la
primera búsqueda de la sesión.

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
