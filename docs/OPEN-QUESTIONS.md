# Qué está verificado y qué no

Todo lo de `PROTOCOL.md`, `FIELDS.md` y `GOTCHAS.md` se comprobó contra el servidor de
producción el **2026-08-15**. Este documento separa lo probado de lo inferido, y deja
apuntados los experimentos pendientes.

Léelo antes de asumir algo. Varias afirmaciones "obvias" resultaron falsas al medirlas.

---

## Verificado

| Afirmación | Cómo se comprobó |
|---|---|
| No existe API pública | 404 en `/Catalogo/rest/`, `/Catalogo/api/`, `/buscador/`; `datosabiertos.unal.edu.co` sin catálogo |
| UA de navegador → bootstrap JS | 6 combinaciones de UA, misma URL |
| `Adf-Window-Id` = `winnoloop` | leído del HTML servido sin loopback |
| El ViewState no rota | mismo token en los 8 pasos de una sesión |
| Cookie y ViewState deben ser de la misma sesión | matriz de 6 combinaciones, solo una funciona |
| La cascada no se puede saltar | 3 intentos (todo vacío / solo nivel / nivel+sede) → 896 B |
| Cascada de electivas = 9 pasos | HAR de navegador, paso a paso |
| `soc6=12` = comodín "toda la sede" | opciones del dropdown + reproducción de las 240 filas |
| `_afrRK` se acumula entre búsquedas | 3 búsquedas seguidas: 0..97, 98..168, 169..225 |
| `_afrRK` se renumera tras re-render | `2016353` pasó de rk=101 a rk=8 tras Volver |
| `_rowCount` está stale | dice 98 cuando las filas reales son 71 y 57 |
| El `selection` es innecesario | 1 POST con `selectedRowKeys` → 48 524 B con cupos |
| Volver es necesario antes de cualquier acción de región 0 | búsqueda y detalle desde región 1 → 895 B |
| `it11` filtra por nombre en servidor | 241 KB → 15 KB; `calculo` encuentra `Cálculo` |
| `it10` filtra por créditos | etiqueta del `<label for=...>` |
| Filas duplicadas → detalle idéntico | `sha256` igual entre rk=142 y rk=81 de `2019510` |
| Los grupos visibles dependen del programa | `1000004-B`: 25 grupos en Sistemas, 23 en Industrial |
| Los cupos son globales | los 23 grupos comunes, 0 diferencias de cupos |
| El listado no trae cupos | 0 ocurrencias de `Cupos disponibles` en 241 KB / 98 filas |
| Hay asignaturas sin grupos | `2027641`, detalle con 0 grupos |
| El detalle usa otro vocabulario de tipología | `ELEGIBLES` vs `LIBRE ELECCIÓN (L)` |
| Cambiar de carrera cuesta 2 POSTs | `soc3` + `cb1` → 71 filas de la nueva carrera |

---

## Inferido, no probado

**La tipología varía entre programas.**
`1000004-B` es `FUND. OPTATIVA` tanto en Ing. Sistemas como en Ing. Industrial, y las
6 asignaturas de cálculo salieron iguales en ambos listados. No se encontró ningún caso
de divergencia.

Se modela igual en `course_program` porque el caso fuerte sigue sin probar: una
asignatura que sea `DISCIPLINAR OBLIGATORIA` en su carrera madre y aparezca como libre
elección para otra. Revertirlo a `course` después es trivial; al revés no.

**Experimento:** buscar un código que aparezca tanto en el listado regular de su
carrera madre como en el de electivas de otra, y comparar la celda `c6`.

---

## Abierto

### 1. ¿Existe el tope de 1000 filas?

En una consulta **malformada** salió `_rowCount="2114"` con exactamente **1000 filas**
— igual al `fetchSize: 1000` que declara el `AdfRichTable`.

No se pudo confirmar: `_rowCount` demostró no ser fiable, y `startRow` / `rows` en
`DELTAS` no tuvieron ningún efecto. Con consultas bien formadas (98, 240 filas) nunca
se alcanza.

**Experimento:** encontrar una consulta legítima que supere las 1000 filas y contar los
`<tr>`. Si el tope existe, hace falta paginar y no se sabe cómo.

### 2. ¿"Cupos disponibles" cambia en vivo durante inscripciones?

Toda la arquitectura asume que sí. El usuario lo confirma por experiencia, pero **no se
midió**: la sesión ocurrió en pre-inscripción (el periodo arranca el 27/08/2026), así
que los números observados son capacidad inicial.

**Experimento:** muestrear el mismo grupo dos veces con horas de diferencia el día que
abran inscripciones. Conviene hacerlo **antes** de construir el polling.

### 3. ¿Cuánto dura realmente una conexión con keepalive?

El timer declara 5 min de inactividad y se renueva con cada petición. No se probó
cuánto aguanta una sesión con tráfico constante, ni si hay un tope absoluto por sesión.

**Experimento:** mantener una conexión viva con un POST barato cada 4 min y ver cuándo
muere. Define si el pool necesita rotación programada.

### 4. ¿Cuántos programas hay en total?

Solo se enumeró Ingeniería en Bogotá (13 carreras, con nombres repetidos y códigos
institucionales distintos). El tamaño del crawl completo es desconocido.

**Experimento:** recorrer `soc2` × `soc3` para `campus=2`, `level=0` y contar. Es barato
(1 POST por facultad) y dimensiona la fase 2.

### 5. ¿El SIA aguanta concurrencia desde una IP?

No se probó nada en paralelo. Todo el trabajo fue secuencial.

**Experimento:** dos conexiones simultáneas y ver si aparecen errores o throttling.
Determina si el pool puede crecer más allá de 2.

---

## Notas de fragilidad

Los IDs de componente (`pt1:r1:0:soc1`, `pt1:r1:0:t4`, `pt1:r1:0:cb1`) dependen del
árbol de componentes que ADF renderiza. Llevan al menos desde marzo de 2026 sin cambiar
— el proyecto anterior los documentó entonces y seguían vigentes en agosto — pero
pueden romperse sin aviso si la UNAL toca la página.

La colección Bruno es el canario: si deja de funcionar, el SIA cambió, y hay que
re-mapear con `FIELDS.md`.
