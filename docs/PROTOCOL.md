# Protocolo SIA / Oracle ADF

Cómo se extraen asignaturas del catálogo público, POST por POST. Verificado contra el
servidor de producción. Las trampas, con su evidencia, están en [GOTCHAS.md](GOTCHAS.md);
los ids y opciones de cada componente, en [FIELDS.md](FIELDS.md).

Las cifras (tamaños, tiempos, límites) están solo en [CONSTANTS.md](CONSTANTS.md); aquí
se nombran.

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
                                                     fila seleccionada, región activa }
```

Consecuencias:

- Hacen falta **cookie y ViewState de la misma sesión**. Ninguno funciona solo.
- Cada POST **muta** ese objeto. Por eso la cascada importa: cada paso llena las opciones
  del siguiente.
- El ViewState **no rota**. Es estable durante toda la sesión.
- La sesión está en una de dos regiones: `pt1:r1:0` (buscador y tabla) o `pt1:r1:<N>`
  (detalle). Ver §7.

---

## 1. Bootstrap

```http
GET /Catalogo/facespublico/public/servicioPublico.jsf?taskflowId=task-flow-AC_CatalogoAsignaturas
User-Agent: <cualquier cosa que NO parezca navegador>
```

**Crítico:** con un User-Agent de navegador, el servidor devuelve un bootstrap JavaScript
(`AdfLoopbackUtils.runLoopback`, `SIA_BROWSER_UA_BYTES`) en vez de la página
([GOTCHAS §1](GOTCHAS.md)). El UA por
defecto de Go sirve.

De la respuesta salen:

```html
<input type="hidden" name="javax.faces.ViewState" value="!-nlppp4bk5">
<input name="Adf-Window-Id" type="hidden" value="winnoloop">
```

- `javax.faces.ViewState`: aleatorio por sesión.
- `Adf-Window-Id`: **siempre `winnoloop`**.

Guarda las cookies (`PortalJSESSION` y las `OAM*`).

Es la operación más cara y de costo muy variable (`SIA_BOOTSTRAP_COST`). Se hace una vez por sesión, nunca
por petición. **No parsees la tabla de esta respuesta**: puede llegar con el resultado de
otra sesión ([GOTCHAS §22](GOTCHAS.md)).

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

`PROCESS` es el id del componente para dropdowns, y `pt1:r1,<id>` para acciones (botones
y links).

### Los payloads

**Dropdown** (`valueChange`):
```xml
<m xmlns="http://oracle.com/richClient/comm"><k v="autoSubmit"><b>1</b></k><k v="suppressMessageShow"><s>true</s></k><k v="type"><s>valueChange</s></k></m>
```

**Botón o link** (`action`):
```xml
<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>
```

Existe también `selection`, pero no hace falta: ver §6.

---

## 3. Cascada regular (asignaturas de una carrera)

Los dropdowns dependientes llegan **vacíos** en la página inicial. No se pueden saltar
pasos: ADF rechaza `soc2=8` porque esa opción todavía no existe en su modelo.

| # | Evento | Componente | Efecto |
|---|---|---|---|
| 1 | valueChange | `pt1:r1:0:soc1` | nivel de estudio |
| 2 | valueChange | `pt1:r1:0:soc9` | sede → llena facultad |
| 3 | valueChange | `pt1:r1:0:soc2` | facultad → llena carrera |
| 4 | valueChange | `pt1:r1:0:soc3` | carrera → llena tipología |
| 5 | action | `pt1:r1:0:cb1` | botón **Mostrar** → resultados |

`soc4` (tipología) puede ir vacío o en `0`: son equivalentes. Pero **`0` no significa
"sin filtro"**: es `TODAS MENOS  LIBRE ELECCIÓN`. Este listado **nunca** trae las
asignaturas de libre elección del plan; para esas hace falta §5
([GOTCHAS §21](GOTCHAS.md)).

Con la sesión ya en una facultad, cambiar a otra carrera de la misma facultad es `soc3` +
`cb1`. Reenviar un `valueChange` con el valor que ya tiene no re-renderiza el dropdown
dependiente ([GOTCHAS §30](GOTCHAS.md)).

---

## 4. Filtros de texto (`it11`, `it10`)

`it11` filtra por nombre **en el servidor**: substring, insensible a acentos (`calculo`
encuentra `Cálculo`). Baja la respuesta de `SIA_LISTING_BYTES` a `SIA_LISTING_IT11_BYTES`. `it10` filtra por
número de créditos.

- **No reemplaza la carrera.** Con `soc3` vacío y `it11` puesto, ADF ignora la consulta y
  re-renderiza el resultado anterior.
- **No se limpia solo.** `it11` viaja en **cada** POST. Dejarlo puesto recorta el siguiente
  listado completo sin ningún error ([GOTCHAS §34](GOTCHAS.md)). Limpiarlo es parte de la
  operación.

---

## 5. Cascada de electivas (libre elección)

Con `soc4=7` (LIBRE ELECCIÓN) se activa un **segundo buscador** con sus propios
dropdowns:

| # | Evento | Componente | Ejemplo | Efecto |
|---|---|---|---|---|
| 1 | valueChange | `soc1` | `0` | nivel |
| 2 | valueChange | `soc9` | `2` | sede |
| 3 | valueChange | `soc2` | `8` | facultad |
| 4 | valueChange | `soc3` | `3` | carrera |
| 5 | valueChange | `soc4` | `7` | **tipología = libre elección** |
| 6 | valueChange | `soc5` | `0` | modo: "Por facultad y plan" |
| 7 | valueChange | `soc10` | `2` | sede del buscador → llena `soc6` |
| 8 | valueChange | `soc6` | `12` | facultad, o el comodín de toda la sede |
| 9 | action | `cb1` | — | **Mostrar** |

`soc7` ("¿Por qué plan?") es opcional y puede ir vacío. **Saltarse el paso 7 produce
basura silenciosa**: `_rowCount` inflado y `_afrRK` duplicados.

### El comodín de toda la sede

Una opción de `soc6` no es una facultad sino la sede entera (`2000 SEDE BOGOTÁ`). Devuelve
la libre elección de **toda la sede** en una sola consulta. Dos límites:

- **Su posición cambia con la sede.** Se busca por la etiqueta (`SEDE …`) en la respuesta
  del paso 7, nunca por un número fijo ([GOTCHAS §32](GOTCHAS.md)).
- **No existe en doctorado.** Ahí el listado de la sede es la unión de una búsqueda por
  facultad: repetir los pasos 8 y 9 por cada opción y dedupear por código
  ([GOTCHAS §35](GOTCHAS.md)).

Los `_afrRK` de esa unión no sirven para hacer clic: el detalle se abre desde la búsqueda
de la facultad que tiene la fila ([GOTCHAS §38](GOTCHAS.md)).

---

## 6. Detalle de una asignatura (cupos, horarios, profesor)

**Un solo POST.** No hace falta el `selection` previo si `DELTAS` lleva
`selectedRowKeys`:

```
oracle.adf.view.rich.DELTAS = {pt1:r1:0:t4={viewportSize=999,rows=999,selectedRowKeys=<RK>}}
event                       = pt1:r1:0:t4:<RK>:cl2
event.pt1:r1:0:t4:<RK>:cl2  = <payload action>
oracle.adf.view.rich.PROCESS= pt1:r1,pt1:r1:0:t4:<RK>:cl2
```

Devuelve grupos, profesor, horarios, aula, jornada y cupos.

`<RK>` es el `_afrRK` leído del `<tr>` de esa fila **en la respuesta más reciente**, nunca
la posición ([GOTCHAS §4](GOTCHAS.md)).

---

## 7. Las dos regiones y el botón Volver

```
pt1:r1:0     buscador + tabla de resultados   ← operan cb1 y los cl2
pt1:r1:<N>   detalle de una asignatura        ← opera cb4 (Volver)
```

Tras abrir un detalle, la sesión queda en la región de detalle. **Cualquier** acción de la
región 0 (otra búsqueda, otro detalle) es un no-op hasta salir con Volver
([GOTCHAS §10](GOTCHAS.md)).

### `<N>` no es 1: crece con cada detalle

```
1.er detalle → pt1:r1:1     2.º detalle → pt1:r1:2     98.º detalle → pt1:r1:98
```

Con `pt1:r1:1:cb4` fijo, el segundo Volver es un no-op y todo lo posterior también, así
que parece una sesión caducada que no lo está ([GOTCHAS §20](GOTCHAS.md)). `N` se lee de
la respuesta del propio detalle:

```
id="pt1:r1:<N>:cb4"
```

y se usa en el POST:

```
event                       = pt1:r1:<N>:cb4
event.pt1:r1:<N>:cb4        = <payload action>
oracle.adf.view.rich.PROCESS= pt1:r1,pt1:r1:<N>:cb4
```

Volver re-renderiza la tabla y **renumera los `_afrRK`**. Para varias asignaturas:

```
por cada asignatura:
    POST click
    leer N de id="pt1:r1:N:cb4"
    POST Volver a pt1:r1:N:cb4
    re-parsear _afrRK
```

---

## 8. Estructura de la respuesta

`Content-Type: text/xml`, un `<partial-response>`:

```xml
<partial-response><changes>
  <update id="pt1:r1:0:pb3"><![CDATA[  ...HTML de la tabla...  ]]></update>
  <update id="javax.faces.ViewState"><![CDATA[!-h23nny91f]]></update>
  <eval><![CDATA[ AdfPage.PAGE.addComponents(...) ]]></eval>
</changes></partial-response>
```

El contenido útil está en el CDATA de `<update id="pt1:r1:0:pb3">`. En la página completa
cada `<tr>` aparece varias veces: solo se parsean respuestas parciales
([GOTCHAS §23](GOTCHAS.md)).

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

El listado **no trae** grupos, profesor, horarios ni cupos. Eso solo sale del detalle.

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

- `Cupos disponibles` es **por grupo**; no hay cupo a nivel de asignatura.
- **El conjunto de grupos depende de la carrera desde la que se consulta**
  ([GOTCHAS §16](GOTCHAS.md)).
- Las cabeceras de grupo no siempre son `(N) Grupo N`. Los grupos PEAMA llevan otra forma,
  y la identidad del grupo es el token entre paréntesis ([GOTCHAS §24, §27,
  §40](GOTCHAS.md)):

```
(1) Grupo 1
(TUMA-01) Peama - Tumaco - Grupo 1
(ORIN-01) Peama-Orinoquia Grupo 1
(SUMA-01) Grupo 1
```

El detalle trae además **prerrequisitos** y **contenido de la asignatura** (formato en
[FIELDS.md](FIELDS.md)). Hoy no se guardan.

---

## 9. Rutas mínimas

Cuántos POSTs cuesta un detalle según dónde esté la conexión:

| Escenario | Secuencia | Peticiones |
|---|---|---|
| Frío, sin sesión | GET + 4 de cascada + `cb1` + click | 1 GET + 6 POSTs |
| Misma carrera, tras una búsqueda | `cb1` + click | 2 |
| Misma carrera, tras un detalle | Volver + `cb1` + click | 3 |
| Otra carrera, misma facultad | `soc3` + `cb1` + click | 3 |

Lo más barato para una asignatura concreta es la ruta de 2 POSTs con `it11`.

---

## 10. Costos y límites

Están en [CONSTANTS.md](CONSTANTS.md): los medidos del SIA (`SIA_*`) y el límite de
sesiones concurrentes (`maxTotalConnections`), compartido entre la API y el `Refresher`.
