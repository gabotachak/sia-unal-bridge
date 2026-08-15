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
| `pt1:r1:1:cb4` | button | **Volver** | sale del detalle (región 1) |
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

Valor conocido de `soc4`: **`7` = LIBRE ELECCIÓN**.

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

| Celda | Campo | Ejemplo |
|---|---|---|
| `c1` | Código | `2016696`, `1000003-B` |
| `c2` | Nombre | `Algoritmos` |
| `c5` | Créditos | `3` |
| `c6` | Tipología | `FUND. OBLIGATORIA (B)` |
| `c8` | Descripción | programa completo, texto largo |

Id de celda: `pt1:r1:0:t4:{RK}:c{N}`. El código va dentro de un
`<a id="pt1:r1:0:t4:{RK}:cl2">`.

Tipologías observadas:

```
FUND. OBLIGATORIA (B)          DISCIPLINAR OBLIGATORIA (C)
FUND. OPTATIVA (O)             DISCIPLINAR OPTATIVA (T)
LIBRE ELECCIÓN (L)             NIVELACIÓN (E)
TRABAJO DE GRADO (P)
```

Marcador extra: `ASIGNATURA SIN PROGRAMAR` aparece en `c2` fuera del `<span>`,
después de un `<div></div>`.

---

## Campos del detalle

Texto plano tras quitar etiquetas del CDATA. Por grupo:

| Campo | Marcador |
|---|---|
| Grupo | `(N) Grupo X` — delimita el bloque |
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
