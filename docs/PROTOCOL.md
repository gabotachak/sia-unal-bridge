# Protocolo SIA / Oracle ADF

Handshake completo para extraer asignaturas del catálogo público.
Todo lo aquí descrito fue verificado contra el servidor de producción el **2026-08-15**.

Base URL:

```
https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf
```

> Los literales del SIA (`Cupos disponibles:`, `LIBRE ELECCIÓN (L)`, `MIÉRCOLES de
> 09:00 a 11:00.`) se citan tal cual: son datos, no texto nuestro.

---

## 0. Modelo mental

ADF guarda el estado de la vista **en el servidor** (`STATE_SAVING_METHOD=server`).
El `javax.faces.ViewState` que viaja en cada POST no es el estado: es un **puntero**.

```
Cookie PortalJSESSION  →  sesión WebLogic
                            └─ mapa de vistas
                                 └─ "!8hb1r2yc0" → { opciones de cada dropdown,
                                                     fila seleccionada, región activa }
```

Consecuencias:

- Necesitas **cookie + ViewState de la misma sesión**. Ninguno funciona solo.
- Cada POST **muta** ese objeto. Por eso la cascada importa: cada paso puebla las
  opciones del siguiente.
- El ViewState **no rota**. Es estable durante toda la sesión.
- La sesión tiene **dos regiones**: `pt1:r1:0` (buscador + tabla) y `pt1:r1:1`
  (detalle). Solo una está activa. Ver §7.

---

## 1. Bootstrap

```http
GET /Catalogo/facespublico/public/servicioPublico.jsf?taskflowId=task-flow-AC_CatalogoAsignaturas
User-Agent: <cualquier cosa que NO parezca navegador>
```

**Crítico:** con un User-Agent de navegador el servidor devuelve ~7 KB de bootstrap
JavaScript (`AdfLoopbackUtils.runLoopback`) que exige ejecutar JS. Con
`Go-http-client/2.0`, `curl/8.7.1` o similar, sirve la página completa directo.

De la respuesta extraes:

```html
<input type="hidden" name="javax.faces.ViewState" value="!-nlppp4bk5">
<input name="Adf-Window-Id" type="hidden" value="winnoloop">
```

- `javax.faces.ViewState` → aleatorio por sesión.
- `Adf-Window-Id` → **siempre `winnoloop`**. Constante.

Guarda las cookies (`PortalJSESSION` y las `OAM*`).

Costo: **muy variable, entre 0.15 s / 52 KB y ~7 s / 4.5 MB**, sin depender del UA ni
del `Accept`. Sigue siendo lo más caro del flujo. Una vez por sesión, nunca por carrera.
Ver [GOTCHAS.md §25](GOTCHAS.md).

Y **no parsees la tabla de esta respuesta**: puede llegar poblada con el resultado de
otra sesión ([GOTCHAS.md §22](GOTCHAS.md)).

---

## 2. Anatomía de un POST

```http
POST ...servicioPublico.jsf?Adf-Window-Id=winnoloop&Adf-Page-Id=0
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Adf-Ads-Page-Id: 1
Adf-Rich-Message: true
Origin: https://sia.unal.edu.co
Referer: ...servicioPublico.jsf?taskflowId=task-flow-AC_CatalogoAsignaturas
Cookie: PortalJSESSION=...
```

Cuerpo = **estado del formulario** + **triple de evento**.

### Estado del formulario

Se manda **completo en cada POST**, con los valores acumulados:

```
pt1:r1:0:soc1=<nivel>          pt1:r1:0:soc10=<sede electivas>
pt1:r1:0:soc9=<sede>           pt1:r1:0:soc6=<facultad electivas>
pt1:r1:0:soc2=<facultad>       pt1:r1:0:soc7=<plan electivas>
pt1:r1:0:soc3=<carrera>        pt1:r1:0:it10=<filtro créditos>
pt1:r1:0:soc4=<tipología>      pt1:r1:0:it11=<filtro nombre>
pt1:r1:0:soc5=<modo electivas>

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

`PROCESS` = el id del componente para dropdowns y selección;
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

**Selección de fila** (`selection`) — existe, pero resultó **innecesaria**, ver §6:
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

`soc4` (tipología) puede ir vacío o en `0` — son equivalentes. Pero **`0` no significa
"sin filtro"**: es `TODAS MENOS  LIBRE ELECCIÓN`. Este listado **nunca** trae las
asignaturas de libre elección del plan; para esas hace falta §5.
Ver [GOTCHAS.md §21](GOTCHAS.md).

### Cambiar de carrera es barato

Con la sesión ya cascadeada, moverse a otra carrera de la **misma facultad** cuesta
2 POSTs: `soc3` + `cb1`. No hay que re-bootstrapear ni rehacer la cascada.

---

## 4. Filtro por nombre (`it11`)

`it11` filtra por nombre **en el servidor**: substring, insensible a acentos
(`calculo` encuentra `Cálculo`).

Reduce el payload de forma brutal:

```
sin filtro                241 033 B    98 filas
it11=calculo               26 848 B     6 filas
it11=algoritmos            15 018 B     1 fila
```

Re-medido el 2026-08-17 sobre el barrido de la fase 2: 232 675 B → 17 862 B, **13×**.

`it10` filtra por **número de créditos** (no por nombre, pese a lo que sugiere el orden).

**No reemplaza la carrera.** Probado: con `soc3` vacío y `it11` puesto, ADF ignora la
consulta y re-renderiza el resultado anterior.

**Y no se limpia solo.** `it11` es un input del formulario, así que viaja en **cada** POST
junto a los nueve `soc*` (§2). Dejarlo puesto convierte el siguiente listado completo en
uno recortado: ~3 filas plausibles donde iban 98, sin ningún error. Limpiarlo es parte de
la operación, no cortesía del llamador ([GOTCHAS §34](GOTCHAS.md)).

---

## 5. Cascada de electivas (libre elección)

Con `soc4=7` (LIBRE ELECCIÓN) se activa un **segundo buscador** con sus propios
dropdowns. Son 9 pasos, verificados uno a uno contra un HAR de navegador:

| # | Evento | Componente | Ejemplo | Efecto |
|---|---|---|---|---|
| 1 | valueChange | `soc1` | `0` | nivel |
| 2 | valueChange | `soc9` | `2` | sede |
| 3 | valueChange | `soc2` | `8` | facultad |
| 4 | valueChange | `soc3` | `3` | carrera |
| 5 | valueChange | `soc4` | `7` | **tipología = libre elección** |
| 6 | valueChange | `soc5` | `0` | modo: "Por facultad y plan" |
| 7 | valueChange | `soc10` | `2` | sede del buscador → puebla `soc6` |
| 8 | valueChange | `soc6` | `12` | facultad → **`12` = toda la sede** (en Bogotá-pregrado) |
| 9 | action | `cb1` | — | **Mostrar** |

Los pasos 8 y 9 se **repiten una vez por facultad** cuando la sede no ofrece comodín en
ese nivel — ver el truco de abajo.

`soc7` ("¿Por qué plan?") es opcional; puede ir vacío.

**Saltarse el paso 7 produce basura silenciosa:** `_rowCount` inflado y `_afrRK` no
contiguos con duplicados. Con la cascada correcta: 240 filas limpias para Bogotá.

### Truco: todas las facultades a la vez — cuando existe

`soc6=12` no es una facultad — es la opción `2000 SEDE BOGOTÁ`, un comodín que devuelve
las asignaturas de libre elección de **toda la sede** mezcladas.

Dos límites, los dos medidos:

- **La posición cambia con la sede** (`12` en Bogotá, `10` en Medellín, `3` en Palmira):
  se lee de la respuesta del paso 7, nunca se constantiza ([GOTCHAS §32](GOTCHAS.md)).
- **La existencia cambia con el nivel.** En doctorado no hay comodín en ninguna sede
  (Bogotá 11 opciones, Medellín 6, Palmira 2 — todas facultades reales, 2026-08-17). Ahí
  el listado de la sede es la **unión de una búsqueda por facultad**: repetir pasos 8-9
  por cada opción y dedupear por código. Palmira doctorado: 186 + 21 = 207 filas, 76 tras
  dedupe ([GOTCHAS §35](GOTCHAS.md)).

No existe equivalente para el flujo regular: las obligatorias y optativas siempre
requieren carrera concreta.

---

## 6. Detalle de una asignatura (cupos, horarios, profesor)

**Un solo POST.** El `selection` previo es innecesario si `DELTAS` lleva
`selectedRowKeys`:

```
oracle.adf.view.rich.DELTAS = {pt1:r1:0:t4={viewportSize=999,rows=999,selectedRowKeys=<RK>}}
event                       = pt1:r1:0:t4:<RK>:cl2
event.pt1:r1:0:t4:<RK>:cl2  = <payload action>
oracle.adf.view.rich.PROCESS= pt1:r1,pt1:r1:0:t4:<RK>:cl2
```

→ ~48 KB con grupos, profesor, horarios, aula, jornada y cupos.

`<RK>` es el `_afrRK` leído del `<tr>` de esa fila **en la respuesta más reciente**.
Nunca la posición. Ver [GOTCHAS.md](GOTCHAS.md) §4.

---

## 7. Las dos regiones y el botón Volver

La sesión está en una de dos regiones:

```
pt1:r1:0     buscador + tabla de resultados   ← operan cb1 y los cl2
pt1:r1:<N>   detalle de una asignatura        ← opera cb4 (Volver)
```

Tras abrir un detalle quedas en la de detalle. **Cualquier** acción de la región 0
—una búsqueda nueva o el detalle de otra asignatura— devuelve ~895 B vacíos hasta
que salgas con Volver.

### `<N>` no es 1: crece con cada detalle

Lo que más código rompe de todo este documento. El índice de la región de detalle
**sube en cada detalle abierto** dentro de la misma sesión:

```
1.er detalle → pt1:r1:1     2.º detalle → pt1:r1:2     98.º detalle → pt1:r1:98
```

Con `pt1:r1:1:cb4` fijo, el segundo Volver devuelve 893 B y **todo lo posterior también**
—búsquedas incluidas—, así que parece una sesión caducada que no lo está.
Ver [GOTCHAS.md §20](GOTCHAS.md).

Léelo de la respuesta del propio detalle:

```
id="pt1:r1:<N>:cb4"
```

y úsalo en el POST:

```
event                       = pt1:r1:<N>:cb4
event.pt1:r1:<N>:cb4        = <payload action>
oracle.adf.view.rich.PROCESS= pt1:r1,pt1:r1:<N>:cb4
```

→ ~257 KB, re-renderiza la tabla. **Los `_afrRK` se renumeran aquí.**

### Bucle para varias asignaturas

```
por cada asignatura:
    POST click             (~48 KB)    ─┐
    leer N de id="pt1:r1:N:cb4"         │  ~1.0 s
    POST Volver a pt1:r1:N:cb4 (~257 KB)│
    re-parsear _afrRK                  ─┘
```

Medido con el índice dinámico: **98 asignaturas de un plan, 201 POSTs, 99 s, 31 MB,
cero atascos.**

---

## 8. Rutas mínimas medidas

| Escenario | Secuencia | POSTs | Tiempo |
|---|---|---|---|
| Frío, sin sesión | GET + 4 cascada + `cb1` + click | 1 GET + 6 | **~10 s** |
| Sesión viva, misma carrera, tras una búsqueda | `cb1` + click | **2** | **~1.3 s** |
| Sesión viva, misma carrera, tras un detalle | Volver + `cb1` + click | 3 | ~1.8 s |
| Sesión viva, otra carrera misma facultad | `soc3` + `cb1` + click | 3 | ~1.5 s |

Combinar `it11` con la ruta de 2 POSTs es lo más eficiente para consultar una
asignatura concreta.

---

## 9. Estructura de la respuesta

`Content-Type: text/xml`, un `<partial-response>`:

```xml
<partial-response><changes>
  <update id="pt1:r1:0:pb3"><![CDATA[  ...HTML de la tabla...  ]]></update>
  <update id="javax.faces.ViewState"><![CDATA[!-h23nny91f]]></update>
  <eval><![CDATA[ AdfPage.PAGE.addComponents(...) ]]></eval>
</changes></partial-response>
```

El contenido útil está en el CDATA de `<update id="pt1:r1:0:pb3">`.

### Filas del listado

```html
<tr role="row" _afrRK="0" class="af_table_data-row">
  <td id="pt1:r1:0:t4:0:c1"><a id="pt1:r1:0:t4:0:cl2">2016696</a></td>
  <td id="pt1:r1:0:t4:0:c2"><span title="">Algoritmos</span></td>
  <td id="pt1:r1:0:t4:0:c5"><span title="">3</span></td>
  <td id="pt1:r1:0:t4:0:c6"><span title="">FUND. OBLIGATORIA (B)</span></td>
  <td id="pt1:r1:0:t4:0:c8"><span title="">Asignatura del componente...</span></td>
</tr>
```

| Celda | Campo | Va a |
|---|---|---|
| `c1` | Código | `course.code` |
| `c2` | Nombre | `course.name` |
| `c5` | Créditos | `course.credits` |
| `c6` | Tipología | `course_program.typology` |
| `c8` | Descripción | `course.description` |

El listado **no trae** grupos, profesor, horarios ni cupos. Verificado: cero
ocurrencias de `Cupos disponibles` en una respuesta de 241 KB con 98 filas.

### Detalle

```
Algoritmos (2016696)
Tipología: FUND. OBLIGATORIA
Créditos: 3
INGENIERÍA DE SISTEMAS Y COMPUTACIÓN     ← plan desde el que consultas
Facultad: FACULTAD DE INGENIERÍA
(1) Grupo 1
Profesor: German Jairo Hernandez Perez.
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

`Cupos disponibles` es **por grupo**; no hay cupo a nivel de asignatura.

**El conjunto de grupos depende de la carrera desde la que consultas.** Ver
[GOTCHAS.md](GOTCHAS.md) §16.

### Delimitar los grupos: `^\(\d+\)\s*Grupo` NO basta

Los grupos PEAMA llevan otra cabecera y ese regex los descarta en silencio (son ~20 %
de los observados). Ver [GOTCHAS.md §24](GOTCHAS.md):

```
(1) Grupo 1                            ← formato normal
(TUMA-01) Peama - Tumaco - Grupo 1
(ORIN-01) Peama-Orinoquia Grupo 1
(SUMA-01) Grupo 1
(CARI-01) PEAMA- PAET Caribe Grupo 1
```

Usa algo tolerante: `\([^)\n]{1,20}\)[^\n]{0,60}?Grupo\s*\S+`.

Un grupo PEAMA además trae su propia sede (`Facultad: SEDE TUMACO`), distinta de la del
plan desde el que consultas.

### El detalle trae dos bloques más que no estaban documentados

**Prerrequisitos** (en 22 de 36 asignaturas muestreadas), después de los grupos:

```
Prerrequisitos Condición 1 Tipo M ¿Todas? [N] Número asignaturas [1]
1000004-B Cálculo diferencial
2016377 Cálculo diferencial en una variable
```

`Tipo` es un enum que el propio SIA explica en la página: `M` no se puede matricular sin
superarlo · `O` se matricula pero no se califica · `E` se puede cursar en simultáneo ·
`A` anulación por incompatibilidad.

**Contenido de la asignatura** (en 31 de 36), antes de los grupos, con los componentes:

```
Contenido de la asignatura
CLASE TEORICA 2015555 (2015555)
```

Ninguno de los dos está en `DATA-MODEL.md`. Son gratis: vienen en el mismo POST del
detalle. Si interesan, se modelan sin coste de red adicional.

Otro marcador útil: `Horarios/Aula: No informado` para grupos sin horario asignado.

---

## 10. Costos medidos

| Operación | Tamaño | Tiempo |
|---|---|---|
| Bootstrap | 52 KB – 4.5 MB | 0.15 – 7 s |
| Cascada, dropdown dependiente (`soc9`, `soc10`) | ~2 KB | ~470 ms |
| Cascada, re-render de panel (resto) | ~33 KB | ~470 ms |
| Consulta `cb1`, 98 filas | 241 KB | ~470 ms |
| Consulta `cb1`, 240 filas | 514 KB | ~1 s |
| Consulta `cb1` con `it11` | 15–27 KB | ~470 ms |
| Volver | ~257 KB | ~470 ms |
| Detalle (1 POST) | 8 KB–264 KB | ~500 ms |
| Censo de dropdowns (nivel × sede × facultad) | 131 MB | 142 POSTs / 78 s |

Una carrera completa (98 asignaturas con detalle) = **201 POSTs, 99 s, 31 MB**, medido
de punta a punta con el Volver dinámico de §7.

El SIA aguanta **80 sesiones concurrentes** sin errores ni throttling, y la latencia por
búsqueda no se degrada (0.5-0.9 s con N=1 y con N=8; plana hasta N=80). En 88 ya aparece
~4.5% de fallas — ver `OPEN-QUESTIONS.md` §5.
