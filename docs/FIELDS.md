# Mapa de campos y componentes ADF

Ids y opciones capturados del servidor de producción el **2026-08-15**.
Los ids llevan al menos desde marzo de 2026 sin cambiar, pero son frágiles por diseño
(dependen del árbol de componentes renderizado).

---

## Componentes

| Id | Tipo | Etiqueta en la UI | Uso |
|---|---|---|---|
| `pt1:r1:0:soc1` | select | Nivel de estudio | cascada regular |
| `pt1:r1:0:soc9` | select | Sede | cascada regular |
| `pt1:r1:0:soc2` | select | Facultad | cascada regular |
| `pt1:r1:0:soc3` | select | Carrera / plan | cascada regular |
| `pt1:r1:0:soc4` | select | Tipología de asignatura | `7` activa electivas |
| `pt1:r1:0:soc5` | select | ¿Por qué deseas buscar? | modo, solo electivas |
| `pt1:r1:0:soc10` | select | ¿Porque sede? | sede, solo electivas |
| `pt1:r1:0:soc6` | select | ¿Por qué facultad? | facultad, solo electivas |
| `pt1:r1:0:soc7` | select | ¿Por qué plan? | plan, opcional |
| `pt1:r1:0:soc8` | select | ¿Por qué plan? | duplicado, sin uso observado |
| `pt1:r1:0:it10` | input | Número de créditos de la asignatura | filtro libre |
| `pt1:r1:0:it11` | input | Nombre de la asignatura | filtro libre |
| `pt1:r1:0:cb1` | button | **Mostrar** | dispara la consulta |
| `pt1:r1:0:t4` | table | tabla de resultados | selección de fila |
| `pt1:r1:0:t4:{RK}:cl2` | link | código de la fila `{RK}` | abre el detalle |
| `pt1:r1:<N>:cb4` | button | **Volver** | sale del detalle; **`N` sube con cada detalle**, léelo de la respuesta ([GOTCHAS §20](GOTCHAS.md)) |
| `pt1:r1` | region | región raíz | valor de `PROCESS` |

Ocultos del formulario:

```
org.apache.myfaces.trinidad.faces.FORM = f1
Adf-Window-Id                          = winnoloop
javax.faces.ViewState                  = <por sesión>
```

---

## Opciones de los dropdowns

### `soc1` — Nivel de estudio

| Valor | Etiqueta |
|---|---|
| `0` | Pregrado |
| `1` | Doctorado |
| `2` | Postgrados y másteres |

### `soc9` / `soc10` — Sede

Mismo listado en ambos.

| Valor | Etiqueta |
|---|---|
| `1` | 1125 SEDE AMAZONIA |
| `2` | 1101 SEDE BOGOTÁ |
| `3` | 1126 SEDE CARIBE |
| `4` | 9933 SEDE DE LA PAZ |
| `5` | 1103 SEDE MANIZALES |
| `6` | 1102 SEDE MEDELLÍN |
| `7` | 1124 SEDE ORINOQUIA |
| `8` | 1104 SEDE PALMIRA |
| `9` | 9920 SEDE TUMACO |

### `soc5` — Modo de búsqueda (solo electivas)

| Valor | Etiqueta |
|---|---|
| `0` | Por facultad y plan |
| `1` | Por plan de estudios |

### `soc6` — Facultad (solo electivas, tras fijar `soc10=2` Bogotá)

| Valor | Etiqueta |
|---|---|
| `0` | 2048 FACULTAD DE AGRONOMÍA |
| `1` | 2049 FACULTAD DE ARTES |
| `2` | 2050 FACULTAD DE CIENCIAS |
| `3` | 2728 FACULTAD DE CIENCIAS AGRARIAS |
| `4` | 2051 FACULTAD DE CIENCIAS ECONÓMICAS |
| `5` | 2052 FACULTAD DE CIENCIAS HUMANAS |
| `6` | 2053 FACULTAD DE DERECHO, CIENCIAS POLÍTICAS Y SOCIALES |
| `7` | 2054 FACULTAD DE ENFERMERÍA |
| `8` | 2055 FACULTAD DE INGENIERÍA |
| `9` | 2056 FACULTAD DE MEDICINA |
| `10` | 2057 FACULTAD DE MEDICINA VETERINARIA Y DE ZOOTECNIA |
| `11` | 2058 FACULTAD DE ODONTOLOGÍA |
| `12` | **2000 SEDE BOGOTÁ** ← comodín: todas las facultades |

Las opciones dependen de `soc10`; hay que releerlas tras cada cambio de sede.

### `soc2` / `soc3` / `soc4`

Vienen **vacías** en la página inicial. Se pueblan al disparar el dropdown anterior.
Hay que leer sus opciones de la respuesta de ese paso.

### `soc4` — Tipología (se puebla al elegir carrera)

| Valor | Etiqueta | Filas en Ing. Sistemas y Comp. |
|---|---|---|
| *(vacío)* | — | 98 (idéntico a `0`) |
| `0` | **TODAS MENOS  LIBRE ELECCIÓN** | 98 |
| `1` | DISCIPLINAR OPTATIVA | 38 |
| `2` | FUND. OBLIGATORIA | 5 |
| `3` | FUND. OPTATIVA | 20 |
| `4` | TRABAJO DE GRADO | 3 |
| `5` | DISCIPLINAR OBLIGATORIA | 13 |
| `6` | NIVELACIÓN | 19 |
| `7` | **LIBRE ELECCIÓN** → activa el segundo buscador | — |

Los subfiltros parten exactamente el total (38+5+20+3+13+19 = 98). Que `0` excluya las
libres es la trampa: el listado "completo" de un plan no lo es.
Ver [GOTCHAS.md §21](GOTCHAS.md).

En **doctorado y postgrado** (`soc1` = 1 o 2) la opción `LIBRE ELECCIÓN` no existe: el
buscador de electivas es solo de pregrado.

### `soc3` — Carreras de Ingeniería (nivel=0, sede=2, facultad=8)

Ejemplo de lo que devuelve el paso 3 de la cascada:

| Valor | Etiqueta |
|---|---|
| `0` | 2541 INGENIERÍA AGRÍCOLA |
| `1` | 2542 INGENIERÍA CIVIL |
| `2` | 2543 INGENIERÍA DE SISTEMAS |
| `3` | 2A74 INGENIERÍA DE SISTEMAS Y COMPUTACIÓN |
| `4` | 2879 INGENIERÍA DE SISTEMAS Y COMPUTACIÓN |
| `5` | 2544 INGENIERÍA ELÉCTRICA |
| `6` | 2983 INGENIERÍA ELÉCTRICA |
| `7` | 2545 INGENIERÍA ELECTRÓNICA |
| `8` | 2546 INGENIERÍA INDUSTRIAL |
| `9` | 2547 INGENIERÍA MECÁNICA |
| `10` | 2548 INGENIERÍA MECATRÓNICA |
| `11` | 2549 INGENIERÍA QUÍMICA |

Ojo: hay **nombres repetidos con código institucional distinto** (`2A74` y `2879`,
ambos "Ingeniería de Sistemas y Computación"; `2544` y `2983`, ambos "Eléctrica").
Son versiones curriculares distintas. Resolver por nombre es ambiguo — guarda el
índice **y** el nombre completo con su código institucional.

Y al revés: el **mismo código institucional aparece en varias sedes** (PEAMA). El
código solo tampoco identifica. Ver [GOTCHAS.md §26](GOTCHAS.md).

### Censo completo de los dropdowns (2026-08-15)

Recorriendo `soc1 × soc9 × soc2 × soc3`: **142 POSTs, 78 s, 1380 entradas de programa**.

| Nivel | Facultades | Entradas de programa |
|---|---|---|
| Pregrado (`0`) | 55 | 665 |
| Doctorado (`1`) | 25 | 82 |
| Postgrados y másteres (`2`) | 32 | 633 |

Pregrado por sede:

```
BOGOTÁ     13 fac ·  65      AMAZONIA    5 fac · 125
MEDELLÍN   11 fac ·  55      CARIBE      3 fac · 121
MANIZALES   6 fac ·  26      ORINOQUIA   6 fac · 128
PALMIRA     4 fac ·  12      TUMACO      5 fac · 126
LA PAZ      2 fac ·   7
```

Las sedes de presencia nacional listan **más** programas que Bogotá porque reexponen los
de otras sedes. Dentro de ellas hay una **facultad comodín con código terminado en
`000`** (`6000 SEDE AMAZONIA`, `7000 SEDE ORINOQUIA`, `8000 SEDE CARIBE`,
`9000 SEDE TUMACO`, y también `2000`, `4000`) que agrupa todo lo reexpuesto.

### `it10` / `it11` — filtros de texto

| Campo | Filtra por |
|---|---|
| `it10` | **número de créditos** |
| `it11` | **nombre de la asignatura** |

El orden engaña: `it10` no es el nombre.

`it11` filtra en el servidor, substring e insensible a acentos (`calculo` encuentra
`Cálculo`). Baja el payload de 241 KB a 15–27 KB. No reemplaza la carrera.

---

## Código de carrera

El formato `0-2-8-3` que usaba el proyecto anterior es simplemente:

```
soc1 - soc9 - soc2 - soc3
 │      │      │      └── carrera   (3 = Ing. Sistemas y Computación)
 │      │      └───────── facultad  (8 = Ingeniería)
 │      └──────────────── sede      (2 = Bogotá)
 └─────────────────────── nivel     (0 = Pregrado)
```

Son **índices posicionales** dentro de cada dropdown, no códigos institucionales.
Si la UNAL reordena una lista, los códigos guardados apuntan a otra cosa.
Considera resolver por nombre y guardar el nombre junto al índice.

---

## Celdas de la tabla de resultados

| Celda | Campo | Ejemplo | Columna en BD |
|---|---|---|---|
| `c1` | Código | `2016696`, `1000003-B` | `course.code` |
| `c2` | Nombre | `Algoritmos` | `course.name` |
| `c5` | Créditos | `3` | `course.credits` |
| `c6` | Tipología | `FUND. OBLIGATORIA (B)` | `course_program.typology` |
| `c8` | Descripción | programa completo, texto largo | `course.description` |

Id de celda: `pt1:r1:0:t4:{RK}:c{N}`. El código va dentro de un
`<a id="pt1:r1:0:t4:{RK}:cl2">`.

Tipologías observadas **en el listado**:

```
FUND. OBLIGATORIA (B)          DISCIPLINAR OBLIGATORIA (C)
FUND. OPTATIVA (O)             DISCIPLINAR OPTATIVA (T)
LIBRE ELECCIÓN (L)             NIVELACIÓN (E)
TRABAJO DE GRADO (P)
```

El **detalle usa otro vocabulario** para lo mismo: donde el listado dice
`LIBRE ELECCIÓN (L)`, el detalle dice `ELEGIBLES`. Normaliza a un enum en el dominio
y conserva el literal crudo aparte.

Marcador extra: `ASIGNATURA SIN PROGRAMAR` aparece en `c2` fuera del `<span>`,
después de un `<div></div>`.

---

## Campos del detalle

Texto plano tras quitar etiquetas del CDATA. Por grupo:

| Campo | Marcador |
|---|---|
| Grupo | `(N) Grupo X` — delimita el bloque; **hay más formatos**, ver abajo |
| Profesor | tras `Profesor:` |
| Cupos | tras `Cupos disponibles:` |
| Jornada | tras `Jornada:` (`DIURNO`, ...) |
| Duración | tras `Duración:` (`Semestral`, ...) |
| Fechas | tras `Fecha:` (`27/08/2026` … `17/12/2026`) |
| Horario | líneas `LUNES de 09:00 a 11:00.` |
| Aula | líneas `SALA DE ...`, `LABORATORIO DE ...` |
| Edificio | línea `453 - Guillermina Uribe Bone.` |

Cabecera del detalle: `Algoritmos (2016696)`, luego `Tipología:`, `Créditos:`,
nombre del plan y `Facultad:`.

### Formatos de cabecera de grupo

233 cabeceras observadas en 36 asignaturas:

| Veces | Formato |
|---|---|
| 187 | `(N) Grupo N` |
| 11 | `(TUMA-N) Peama - Tumaco - Grupo N` |
| 10 | `(ORIN-N) Peama-Orinoquia Grupo N` |
| 9 | `(SUMA-N) Grupo N` |
| 5 | `(AMAZ-N) Peama-Amazonia Grupo N` |
| 3 | `(TUMA-N) Peama- Tumaco -Grupo N` |
| 3 | `(SUMA-N) Peama Sumapaz - Grupo N` |
| 2 | `(CARI-N) Peama-Caribe Grupo N` |
| 1 | `(CARI-N) PEAMA- PAET Caribe Grupo N` |
| 1 | `(ORIN-N) Peama Grupo N` |
| 1 | `(N) Grupo N-` |

El prefijo entre paréntesis es el **sitio PEAMA** (`TUMA`, `ORIN`, `AMAZ`, `CARI`,
`SUMA`), y el grupo trae su propia `Facultad: SEDE TUMACO`. Un grupo PEAMA de una
asignatura de Bogotá se imparte en otra sede — para el estudiante de Bogotá no es
inscribible, así que conviene conservar el prefijo, no solo el número.

### Bloques extra del detalle

| Bloque | Frecuencia | Contenido |
|---|---|---|
| `Prerrequisitos` | 22/36 | `Condición N Tipo M ¿Todas? [N] Número asignaturas [1]` + lista `código nombre` |
| `Contenido de la asignatura` | 31/36 | componentes: `CLASE TEORICA 2015555 (2015555)` |

Tipos de prerrequisito, según explica la propia página:

| Tipo | Significado |
|---|---|
| `M` | no se puede matricular la asignatura sin superar el prerrequisito |
| `O` | puede matricular, pero no ser calificado sin superarlo |
| `E` | lo matricula en simultáneo, o lo ha matriculado alguna vez |
| `A` | anulación por incompatibilidad |

Ninguno de los dos bloques está en `DATA-MODEL.md`. Llegan en el mismo POST del detalle:
modelarlos no cuesta red, solo parser.
