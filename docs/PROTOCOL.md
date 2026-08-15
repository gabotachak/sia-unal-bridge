# Protocolo SIA / Oracle ADF

Handshake completo para extraer asignaturas del catálogo público.
Todo lo aquí descrito fue verificado contra el servidor de producción el **2026-08-15**.

Base URL:

```
https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf
```

---

## 0. Modelo mental

ADF guarda el estado de la vista **en el servidor** (`STATE_SAVING_METHOD=server`).
El `javax.faces.ViewState` que viaja en cada POST no es el estado: es un **puntero**.

```
Cookie PortalJSESSION  →  sesión WebLogic
                            └─ mapa de vistas
                                 └─ "!8hb1r2yc0" → { opciones de cada dropdown,
                                                     fila seleccionada, ... }
```

Consecuencias:

- Necesitas **cookie + ViewState de la misma sesión**. Ninguno funciona solo.
- Cada POST **muta** ese objeto en el servidor. Por eso la cascada de dropdowns
  importa: cada paso puebla las opciones del siguiente.
- El ViewState **no rota**. Es estable durante toda la sesión.

---

## 1. Bootstrap

```http
GET /Catalogo/facespublico/public/servicioPublico.jsf?taskflowId=task-flow-AC_CatalogoAsignaturas
User-Agent: <cualquier cosa que NO parezca navegador>
```

**Crítico:** con un User-Agent de navegador el servidor devuelve ~7 KB de bootstrap
JavaScript (`AdfLoopbackUtils.runLoopback`) que exige ejecutar JS para calcular
`_afrLoop` y `Adf-Window-Id`. Con `curl/8.7.1`, `Go-http-client/2.0`,
`python-requests/2.31` o similar, sirve la página completa directo.

De la respuesta extraes:

```html
<input type="hidden" name="javax.faces.ViewState" value="!-nlppp4bk5">
<input name="Adf-Window-Id" type="hidden" value="winnoloop">
```

- `javax.faces.ViewState` → cámbialo por sesión, es aleatorio.
- `Adf-Window-Id` → **siempre `winnoloop`** cuando te saltas el loopback. Constante.

Guarda las cookies (`PortalJSESSION` y las `OAM*`).

---

## 2. Anatomía de un POST

```http
POST /Catalogo/facespublico/public/servicioPublico.jsf?Adf-Window-Id=winnoloop&Adf-Page-Id=0
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Adf-Ads-Page-Id: 1
Adf-Rich-Message: true
Origin: https://sia.unal.edu.co
Referer: .../servicioPublico.jsf?taskflowId=task-flow-AC_CatalogoAsignaturas
Cookie: PortalJSESSION=...
```

Cuerpo = **estado del formulario** + **triple de evento**.

### Estado del formulario

Se manda **completo en cada POST**, con los valores acumulados hasta ese punto:

```
pt1:r1:0:soc1=<nivel>
pt1:r1:0:soc9=<sede>
pt1:r1:0:soc2=<facultad>
pt1:r1:0:soc3=<carrera>
pt1:r1:0:soc4=<tipología>
pt1:r1:0:soc5=<modo búsqueda electivas>
pt1:r1:0:soc10=<sede electivas>
pt1:r1:0:soc6=<facultad electivas>
pt1:r1:0:soc7=<plan electivas>
pt1:r1:0:it10=<filtro créditos>
pt1:r1:0:it11=<filtro nombre>
org.apache.myfaces.trinidad.faces.FORM=f1
Adf-Window-Id=winnoloop
Adf-Page-Id=0
javax.faces.ViewState=<el actual>
```

Los campos aún no seleccionados van vacíos.

### Triple de evento

```
event=<id del componente>
event.<id del componente>=<payload XML>
oracle.adf.view.rich.PROCESS=<qué procesar>
```

`PROCESS` es el id del componente para dropdowns y selección;
`pt1:r1,<id>` para acciones (botones y links).

### Los tres payloads

**Dropdown** (`valueChange`):
```xml
<m xmlns="http://oracle.com/richClient/comm"><k v="autoSubmit"><b>1</b></k><k v="suppressMessageShow"><s>true</s></k><k v="type"><s>valueChange</s></k></m>
```

**Botón / link** (`action`):
```xml
<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>
```

**Selección de fila** (`selection`):
```xml
<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>selection</s></k></m>
```

---

## 3. Cascada regular (asignaturas de una carrera)

Los dropdowns dependientes llegan **vacíos** en la página inicial. No puedes saltar
pasos: ADF rechazaría `soc2=8` porque esa opción todavía no existe en su modelo.

| # | Evento | Componente | Efecto |
|---|---|---|---|
| 1 | valueChange | `pt1:r1:0:soc1` | nivel de estudio |
| 2 | valueChange | `pt1:r1:0:soc9` | sede → puebla facultad |
| 3 | valueChange | `pt1:r1:0:soc2` | facultad → puebla carrera |
| 4 | valueChange | `pt1:r1:0:soc3` | carrera → puebla tipología |
| 5 | action | `pt1:r1:0:cb1` | botón **Mostrar** → resultados |

El paso 5 devuelve la tabla completa.

> `soc4` (tipología) es opcional en el flujo regular: mándalo en `0`.

---

## 4. Cascada de electivas (libre elección)

Al poner `soc4=7` (LIBRE ELECCIÓN) se activa un **segundo buscador** con sus propios
dropdowns. Son 9 pasos, verificados uno a uno contra un HAR de navegador:

| # | Evento | Componente | Valor ejemplo | Efecto |
|---|---|---|---|---|
| 1 | valueChange | `soc1` | `0` | nivel |
| 2 | valueChange | `soc9` | `2` | sede |
| 3 | valueChange | `soc2` | `8` | facultad |
| 4 | valueChange | `soc3` | `3` | carrera |
| 5 | valueChange | `soc4` | `7` | **tipología = libre elección** |
| 6 | valueChange | `soc5` | `0` | modo: "Por facultad y plan" |
| 7 | valueChange | `soc10` | `2` | sede del buscador → puebla `soc6` |
| 8 | valueChange | `soc6` | `12` | facultad → **`12` = toda la sede** |
| 9 | action | `cb1` | — | **Mostrar** |

`soc7` ("¿Por qué plan?") es opcional; puede ir vacío.

**Saltarse el paso 7 produce basura silenciosa:** `_rowCount` inflado y `_afrRK` no
contiguos con duplicados. Con la cascada correcta: 240 filas limpias para Bogotá.

### Truco: todas las facultades a la vez

`soc6=12` no es una facultad — es la opción `2000 SEDE BOGOTÁ`, un comodín que devuelve
las asignaturas de libre elección de **toda la sede** mezcladas (Artes, Medicina,
Derecho, Ingeniería...). Es la forma más barata de barrer el catálogo de electivas.

No existe equivalente para el flujo regular: las obligatorias y optativas siempre
requieren carrera concreta.

---

## 5. Estructura de la respuesta

`Content-Type: text/xml`, un `<partial-response>`:

```xml
<partial-response><changes>
  <update id="pt1:r1:0:pb3"><![CDATA[  ...HTML de la tabla...  ]]></update>
  <update id="javax.faces.ViewState"><![CDATA[!-h23nny91f]]></update>
  <eval><![CDATA[ AdfPage.PAGE.addComponents(...) ]]></eval>
</changes></partial-response>
```

El contenido útil está en el CDATA de `<update id="pt1:r1:0:pb3">`.

### Filas

```html
<tr role="row" _afrRK="0" class="af_table_data-row">
  <td id="pt1:r1:0:t4:0:c1"><a id="pt1:r1:0:t4:0:cl2">2016696</a></td>
  <td id="pt1:r1:0:t4:0:c2"><span title="">Algoritmos</span></td>
  <td id="pt1:r1:0:t4:0:c5"><span title="">3</span></td>
  <td id="pt1:r1:0:t4:0:c6"><span title="">FUND. OBLIGATORIA (B)</span></td>
  <td id="pt1:r1:0:t4:0:c8"><span title="">Asignatura del componente...</span></td>
</tr>
```

| Celda | Campo |
|---|---|
| `c1` | Código (dentro del `<a id="...:t4:{RK}:cl2">`) |
| `c2` | Nombre de la asignatura |
| `c5` | Créditos |
| `c6` | Tipología |
| `c8` | Descripción / programa |

El atributo `_afrRK` es la **clave de fila**. Léelo siempre; nunca uses la posición.
Ver [GOTCHAS.md](GOTCHAS.md).

Marcador extra: algunas filas traen el texto `ASIGNATURA SIN PROGRAMAR` fuera del
`<span>`, tras un `<div></div>` en la celda `c2`.

---

## 6. Detalle de una asignatura (cupos, horarios, profesor)

Dos POSTs, en este orden. El primero parece fallar (devuelve ~900 B sin contenido)
pero es obligatorio.

### 6.1 Seleccionar la fila

```
oracle.adf.view.rich.DELTAS = {pt1:r1:0:t4={viewportSize=999,rows=999,selectedRowKeys=<RK>}}
event                       = pt1:r1:0:t4
event.pt1:r1:0:t4           = <payload selection>
oracle.adf.view.rich.PROCESS= pt1:r1:0:t4
```

→ ~900 B, sin cambios visibles. Normal.

### 6.2 Click en el link del código

```
oracle.adf.view.rich.DELTAS = {pt1:r1:0:t4={viewportSize=999,rows=999,selectedRowKeys=<RK>}}
event                       = pt1:r1:0:t4:<RK>:cl2
event.pt1:r1:0:t4:<RK>:cl2  = <payload action>
oracle.adf.view.rich.PROCESS= pt1:r1,pt1:r1:0:t4:<RK>:cl2
```

→ ~48 KB con el detalle.

### 6.3 Volver antes del siguiente curso

Tras ver un detalle quedas atrapado en la región 1: un segundo click devuelve 893 B
vacíos. Hay que salir con el botón **Volver**:

```
event                       = pt1:r1:1:cb4
event.pt1:r1:1:cb4          = <payload action>
oracle.adf.view.rich.PROCESS= pt1:r1,pt1:r1:1:cb4
```

→ ~250 KB, re-renderiza la tabla completa. **Los `_afrRK` se renumeran aquí**, así que
hay que re-parsear la tabla antes de pedir el siguiente curso.

### Bucle completo

```
por cada curso:
    POST Volver            (~250 KB)   ─┐
    re-parsear _afrRK                   │  ~1.5 s
    POST selección         (~0.9 KB)    │  ~300 KB
    POST click             (~48 KB)    ─┘
```

### Contenido del detalle

Texto plano tras quitar etiquetas del CDATA:

```
Algoritmos (2016696)
Tipología: FUND. OBLIGATORIA
Créditos: 3
INGENIERÍA DE SISTEMAS Y COMPUTACIÓN
Facultad: FACULTAD DE INGENIERÍA
(1) Grupo 1
Profesor: German Jairo Hernandez Perez.
Horarios/Aula:
Fecha: 27/08/2026 - 17/12/2026
LUNES de 09:00 a 11:00.
SALA DE INFORMATICA 453-203.
453 - Guillermina Uribe Bone.
MIÉRCOLES de 09:00 a 11:00.
Duración: Semestral
Jornada: DIURNO
Cupos disponibles: 32
(2) Grupo 2
...
```

Los grupos se delimitan con el patrón `^\(\d+\)\s*Grupo`.
`Cupos disponibles` es **por grupo**; no existe un cupo a nivel de asignatura.

---

## 7. Costos medidos

| Operación | Tamaño | Tiempo |
|---|---|---|
| Bootstrap | 1.1 MB | ~7 s |
| Paso de cascada (dropdown dependiente) | ~2 KB | ~470 ms |
| Paso de cascada (re-render de panel) | ~33 KB | ~470 ms |
| Consulta (`cb1`), 98 filas | 241 KB | ~470 ms |
| Consulta (`cb1`), 240 filas | 514 KB | ~1 s |
| Volver | ~250 KB | ~470 ms |
| Detalle (2 POSTs) | ~49 KB | ~1 s |

Una carrera completa (98 asignaturas con detalle) ≈ **2.5 min y ~30 MB**.

El bootstrap es de lejos lo más caro: hazlo **una vez por sesión**, no por carrera.
