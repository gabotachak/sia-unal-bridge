# Qué está verificado y qué no

Todo lo de `PROTOCOL.md`, `FIELDS.md` y `GOTCHAS.md` se comprobó contra el servidor de
producción el **2026-08-15**. Este documento separa lo probado de lo inferido, y deja
apuntados los experimentos pendientes.

Léelo antes de asumir algo. Varias afirmaciones "obvias" resultaron falsas al medirlas.

> **Tercera ronda: 2026-08-17, implementando la fase 2.** El `Refresher` recorrió sedes y
> niveles que la API nunca había pisado y eso midió cosas que aquí estaban inferidas
> (coste por asignatura, ritmo del barrido) y destapó tres hallazgos nuevos: §34, §35 y
> §36 de `GOTCHAS.md`. El más caro: **el comodín de sede de `soc6` no existe en
> doctorado**, en ninguna sede.
>
> **Segunda ronda de experimentos: 2026-08-15 (tarde).** Se cerraron 4 de las 5
> preguntas abiertas, se probó el punto que estaba solo inferido y aparecieron 8
> hallazgos nuevos, dos de ellos críticos: la región de detalle numerada (§20) y la
> clave real de un grupo (§27).
> Los scripts viven fuera del repo; lo que importa está volcado aquí y en `GOTCHAS.md`.

---

## Verificado

| Afirmación | Cómo se comprobó |
|---|---|
| No existe API pública | 404 en `/Catalogo/rest/`, `/Catalogo/api/`, `/buscador/`; `datosabiertos.unal.edu.co` sin catálogo |
| UA de navegador → bootstrap JS | 6 combinaciones de UA, misma URL; re-confirmado con 12 combinaciones UA×Accept |
| El ViewState no rota | mismo token en los 8 pasos de una sesión |
| Cookie y ViewState deben ser de la misma sesión | matriz de 6 combinaciones, solo una funciona |
| La cascada no se puede saltar | 3 intentos (todo vacío / solo nivel / nivel+sede) → 896 B |
| Cascada de electivas = 9 pasos | HAR de navegador, paso a paso; reproducida con 240 filas exactas |
| `soc6=12` = comodín "toda la sede" | opciones del dropdown + reproducción de las 240 filas. **Solo Bogotá-pregrado**: la posición es por sede (§32) y la EXISTENCIA es por (sede, nivel) — en doctorado no hay comodín (§35) |
| `_afrRK` se acumula entre búsquedas | 3 búsquedas seguidas: 0..97, 98..168, 169..225 |
| `_afrRK` se renumera tras re-render | `2016353` pasó de rk=101 a rk=8 tras Volver |
| `_rowCount` no es fiable | dice 98 cuando las filas reales son 67, 59 y 66 |
| El `selection` es innecesario | 1 POST con `selectedRowKeys` → 48 524 B con cupos |
| Volver es necesario antes de cualquier acción de región 0 | búsqueda y detalle desde región 1 → 895 B |
| `it11` filtra por nombre en servidor | 241 KB → 15 KB; `calculo` encuentra `Cálculo`. Re-medido 2026-08-17 sobre el barrido: 232 675 B → 17 862 B (13×) |
| `it11` viaja en CADA POST y no se limpia solo | un catálogo completo tras uno filtrado devolvía 3 filas en vez de 98 (§34) |
| `it10` filtra por créditos | etiqueta del `<label for=...>` |
| Filas duplicadas → detalle idéntico | `sha256` igual entre rk=142 y rk=81 de `2019510` |
| Los grupos visibles dependen del programa | `1000004-B`: 25 grupos en Sistemas, 23 en Industrial |
| Los cupos son globales | los 23 grupos comunes, 0 diferencias de cupos |
| El listado no trae cupos | 0 ocurrencias de `Cupos disponibles` en 241 KB / 98 filas |
| Hay asignaturas sin grupos | `2027641`, detalle con 0 grupos (confirmado con el parser corregido) |
| El detalle usa otro vocabulario de tipología | `ELEGIBLES` vs `LIBRE ELECCIÓN (L)` |
| Cambiar de carrera cuesta 2 POSTs | `soc3` + `cb1` → 71 filas de la nueva carrera |
| **La tipología SÍ depende del programa** | 8 códigos divergentes entre planes — ver abajo |
| **La región de detalle se numera y crece** | 98 detalles seguidos: `pt1:r1:1` … `pt1:r1:98` |
| **`soc4=0` significa "todas menos libre elección"** | los 7 subfiltros suman exactamente las 98 filas |
| **El SIA aguanta 80 conexiones concurrentes** | rampa 8→80 limpia; 88 ya falla ~4.5% (ver §5, medido 2026-08-19) |
| **La sesión muere a los ~4.2 min de inactividad** | ocioso 250 s vive, 270 s muere; ping ≤3 min la mantiene 30 min |
| **1380 entradas de programa en toda la UNAL** | recorrido de `soc1 × soc9 × soc2 × soc3`, 142 POSTs |
| **`program.code` NO es único entre sedes** | 136 códigos repetidos de 852; ver abajo |

---

## Resuelto en la segunda ronda

### La tipología depende del programa — **probado**

Se comparó la celda `c6` de 15 planes de Bogotá. De los 22 códigos que aparecen en más
de un plan, **8 divergen**:

```
1000003-B  INGENIERÍA AGRÍCOLA = FUND. OBLIGATORIA (B)
           BIOLOGÍA            = FUND. OPTATIVA (O)
2017538    INGENIERÍA AGRÍCOLA = FUND. OBLIGATORIA (B)
           BIOLOGÍA            = DISCIPLINAR OPTATIVA (T)
2015701    INGENIERÍA AGRÍCOLA = FUND. OPTATIVA (O)
           ADMINISTRACIÓN DE EMPRESAS = DISCIPLINAR OPTATIVA (T)
```

Y en el cruce con el buscador de electivas, 2 códigos más son `DISCIPLINAR OPTATIVA (T)`
en su plan madre y `LIBRE ELECCIÓN (L)` vistos desde otro (`2027992`, `2025196`).

`typology` se queda en `course_program`. Ya no por precaución: por medición.

### 1. El tope de 1000 filas — no se alcanza

Barrido de ~120 consultas bien formadas: electivas con comodín de sede en 4 sedes × 2
modos × todas las facultades, más listados regulares en varios niveles y sedes.

```
máximo global            644 filas   (Medellín, comodín de sede, plan de Arquitectura)
máximo en Bogotá         319 filas
listado regular típico    98 filas
```

Además, `viewportSize` y `rows` dentro de `DELTAS` **no tienen ningún efecto**: 25, 100,
250, 999, 2000 y 5000 devuelven exactamente las mismas filas. No hay palanca de paginado
y tampoco hace falta.

**Conclusión operativa:** el tope no se toca con consultas legítimas. No se puede
demostrar que no exista, así que queda una aserción barata: si una respuesta trae
**exactamente 1000 filas**, trátala como truncada y avisa.

### 3. Cuánto vive una conexión — ~4.2 min de inactividad, renovable

| Prueba | Resultado |
|---|---|
| ocioso 250 s (4.2 min) | **viva** |
| ocioso 270 s (4.5 min) | muerta — respuesta no-op de ~1.2 KB |
| ocioso 310 s / 340 s / 300 s | muerta — 419 B con `session has timed out` |
| ping cada 60 s, 120 s y 180 s | **vivas a los 30 min**, tope de la prueba |

Dos correcciones a lo que decía `GOTCHAS.md §7`:

- El timeout real está **entre 4.2 y 4.5 min**, no en los 5 min que declara el timer de
  JS. Un keepalive de 4 min es demasiado justo; usa **≤3 min**.
- Hay **dos firmas de muerte** distintas. Justo al expirar, un no-op de ~1.2 KB
  indistinguible del no-op por cascada incompleta. Más tarde, los 419 B con el mensaje

> **Revisado en fase 1 (2026-08-15, noche).** Tres sondas con curl (misma cascada,
> misma cookie jar): ociosa 322 s → **viva** (`cb1` devolvió 232 KB, no un no-op).
> Ociosa 420 s → **muerta**, con la firma explícita real de 419 B (`Because of
> inactivity, your session has timed out...`), capturada y guardada en
> `internal/sia/testdata/noop_session_expired_explicit_2026-08-15.xml`. Estrecha la
> ventana real a **algún punto entre 322 s y 420 s** — más ancha que los 270 s
> documentados en la primera ronda, pero confirma que el mecanismo existe tal como se
> describe. No cambia el diseño (`keepalive ≤3 min` sigue siendo cota segura de sobra).
> La firma **muda** (~1.2 KB, justo al expirar) no se observó en esta sonda — saltamos
> directo del baseline vivo a la explícita porque el primer POST tras 420 s ya cayó
> del otro lado de ambas ventanas. `noop_session_expired_mute_SYNTHETIC.xml` sigue
> siendo sintético; reemplazar si se acota mejor el punto exacto de expiración.
  explícito. Ambas significan lo mismo: re-bootstrapear.

No hay tope absoluto observable: tres sesiones con ping regular llegaron a los 30 min
(el tope de la prueba) sin degradarse, y otra hizo 201 POSTs seguidos (98 detalles) sin
morir.

### 4. Cuántos programas hay — 1380 entradas, 852 códigos

Recorrido completo de `soc1 × soc9 × soc2 × soc3`. Coste: **142 POSTs, 78 s**.

| Nivel | Facultades | Entradas de programa |
|---|---|---|
| Pregrado | 55 | 665 |
| Doctorado | 25 | 82 |
| Postgrados y másteres | 32 | 633 |
| **Total** | **112** | **1380** |

Pregrado por sede:

```
BOGOTÁ      13 fac ·  65      MEDELLÍN   11 fac ·  55      MANIZALES  6 fac · 26
PALMIRA      4 fac ·  12      LA PAZ      2 fac ·   7
AMAZONIA     5 fac · 125      CARIBE      3 fac · 121
ORINOQUIA    6 fac · 128      TUMACO      5 fac · 126
```

Las cuatro *sedes de presencia nacional* listan **más** programas que Bogotá porque
reexponen los de las demás sedes (mecanismo PEAMA). No son programas propios.

Dimensiona la fase 2: el crawl de catálogo completo son ~1380 POSTs de `cb1`
(dedupeando, ~850). El crawl **con detalle** es otra cosa: ~100 s por programa de 98
asignaturas → del orden de **30-40 h** para la universidad entera.

**Medido al implementarlo (2026-08-17), ya no inferido:**

| Magnitud | Medido | Cómo |
|---|---|---|
| Referencia completa (3 niveles × 9 sedes) | **131 POSTs, 72 s**, 1380 entradas | `refresher --mode=reference` |
| Ritmo del barrido de catálogo | **8.0 planes/min** con 2 workers → **~2.7 h** para 1380 | delta de `catalog_fetched_at` en 90 s |
| Catálogo de un plan | ~13 POSTs (regular + electivas, con los rebotes de §30) | 9 planes de LA PAZ: 114 POSTs |
| Detalle por asignatura | **~3.7 POSTs, ~87 KB** con `it11` en los dos listados | 40 asignaturas, 136 POSTs, 3.5 MB |
| Ritmo del barrido de detalle | **~0.7 asignaturas/s/worker** | 123 asignaturas en 3 min con 2 workers |
| Ahorro de `FetchDetails` por lote | 24 POSTs contra 28 de llamadas sueltas intercaladas | 6 asignaturas, 2 planes, pool de 1 |

Las ~3.7 POSTs por asignatura son más que las ~2 que este documento estimaba: faltaba
contar el `soc3` de reparqueo, el `Volver`, y —para las de libre elección— la cascada de
electivas entera, que con los rebotes del §30 son 8 POSTs.

### 5. Concurrencia — techo probado: 80

Primera ronda (2026-08-15): N = 1, 2, 4 y 8 sesiones haciendo el flujo completo a la vez
(bootstrap + cascada + búsqueda + detalle):

```
N=8   8/8 ok   0 errores   0 throttling   8 listados distintos (sin contaminación)
      búsqueda 0.5-0.9 s constante, no se degrada con N
      el reloj lo domina el bootstrap, no la concurrencia
```

En ese momento 8 quedó como techo por no haberse probado más alto, no porque fallara —
de ahí que el pool de fase 1 se describiera como "cortesía, no restricción del servidor".
Eso ya no es una suposición: se probó.

**Segunda ronda (2026-08-19)**, rampa contra producción vía la propia API dockerizada
(`SIA_POOL_SIZE` recreado por nivel, N fetches de detalle concurrentes, uno por conexión
del pool, cursos reales distintos por corrida para evitar cualquier cache):

```
N=8,12,16,24,32,46,64,80   100% ok en cada nivel   latencia p50 plana (~7-9.6 s)
N=88                        84/88 ok (4 fallas, ~4.5%)
N=96                        90/96 ok (6 fallas, ~6.25%)
```

Las fallas en 88 y 96 no son timeouts ni 503 — son la cascada de electivas
rompiéndose bajo carga (`soc6 came back with no options`, respuesta sin región de
detalle) más algún `sia_noop`. Se confirmó que no es un bug de esos códigos en
particular: los mismos cursos que fallaron en paralelo responden 200 limpio en
solitario (N=1). Es degradación real de concurrencia, no ruido de datos.

**Techo probado: 80 conexiones concurrentes, limpio. 88 ya degrada.** El número no
es cortesía — es el borde medido. `SIA_POOL_SIZE` de producción sigue en un valor muy
por debajo de esto (el tráfico actual no lo necesita); lo que cambia es que ahora hay
~10× de margen medido antes de tocar el borde real, no una regla de buena educación
inventada.

---

## Sigue abierto

### 2. ¿"Cupos disponibles" cambia en vivo durante inscripciones?

**Bloqueado hasta el 27/08/2026.** No es una pregunta que se pueda contestar hoy: el
periodo de inscripción todavía no abre, así que los números observados son capacidad
inicial y no se mueven.

Lo que sí se dejó hecho:

- **Arnés de medición probado.** Recorre 40 asignaturas de un plan, extrae los 347
  grupos con sus cupos y compara contra la muestra anterior.
- **Línea base de hoy.** Tres muestras (t0, +3.6 min, +31 min): **0 cambios** en los
  347 grupos de las 40 asignaturas. Consistente con "hoy es capacidad inicial"; no dice
  nada sobre el comportamiento en inscripciones.

**Experimento, el día que abran:** muestrear el mismo plan cada 15 min durante las
primeras horas. Confirma la volatilidad y, de paso, mide su ritmo — que es lo que debe
fijar el TTL por defecto de los cupos, hoy elegido a ojo.

### 6. ¿`course.code` es único entre sedes?

Sigue sin comprobarse, y ahora importa más: se demostró que `program.code` **no** lo es
(abajo), lo que quita fuerza al argumento por analogía. La PK `(campus_code, code)` de
`DATA-MODEL.md` sigue siendo la apuesta segura.

**Experimento:** bajar el listado de un plan de Medellín y otro de Bogotá y cruzar los
códigos. Barato: 2 POSTs.

### 7. ¿Son inscribibles los grupos PEAMA desde un plan de otra sede?

El detalle de una asignatura consultado desde un plan de **Bogotá** incluye grupos
`(TUMA-01)`, `(AMAZ-01)`, `(CARI-01)`… con `Facultad: SEDE TUMACO`, aulas de esa sede y
**otro calendario** (`24/08/2026 - 17/12/2026` frente al `27/08/2026 - 17/12/2026` de
Bogotá). Son ~20 % de los grupos.

Que aparezcan no implica que un estudiante de Bogotá pueda matricularlos: PEAMA es un
programa de movilidad y lo lógico es que sean para estudiantes admitidos por esa sede.
El catálogo público no lo dice, y no se puede comprobar sin una cuenta.

Mientras tanto se guardan con `site` marcado y se sirven sin filtrar. Filtrarlos por una
regla no medida sería inventar; ocultarlos también.

**Experimento posible:** contrastar con la matrícula real de alguien, o mirar si el SIA
los distingue en la vista autenticada. Fuera del alcance del catálogo público.

### 8. ¿Cuánto tarda en cambiar el catálogo entre semestres?

Nada de lo medido dice cada cuánto caduca de verdad `catalog_fetched_at`. Se asume
"casi inmutable" y es razonable, pero el valor del TTL es inventado.

---

## Hallazgos nuevos de la segunda ronda

Los siete van con detalle y reproducción en `GOTCHAS.md` §20-§26. Resumen:

| # | Hallazgo | Impacto |
|---|---|---|
| 20 | **La región de detalle se numera: `pt1:r1:1`, `:2`, `:3`…** El `pt1:r1:1:cb4` hardcodeado solo sirve para el primer detalle | **Crítico.** Rompe el bucle en la 2.ª asignatura y parece sesión colgada |
| 21 | `soc4=0` (y vacío) = `TODAS MENOS LIBRE ELECCIÓN` | El listado regular de un plan **nunca** trae sus libres |
| 22 | El bootstrap puede llegar con la tabla poblada por **otra sesión** | Nunca parsear la tabla del bootstrap; desplaza el origen de `_afrRK` |
| 23 | En la página completa cada `<tr>` sale **5 veces** | Parsear solo el CDATA de las respuestas parciales |
| 24 | Las cabeceras de grupo no siempre son `(N) Grupo N` | El regex documentado se come los grupos PEAMA (46 de 233) |
| 25 | El coste del bootstrap es **muy variable**: 52 KB/0.14 s … 4.5 MB/7 s | El "7 s y 1.1 MB" es un punto de una distribución ancha |
| 26 | `program.code` no es único: hay que usar `(campus, faculty, code)` | Corrige `UNIQUE (code)` y `PublicID()` de `DATA-MODEL.md` |
| 27 | **La identidad de un grupo es el token entre paréntesis, no `Grupo N`** | Corrige `UNIQUE (..., number)`: con `number` se pierden 10 de 88 grupos |

El 27 en corto: una asignatura tiene `(1) Grupo 1` **y** `(AMAZ-01) … Grupo 1` **y**
`(TUMA-01) … Grupo 1`. Medido sobre 88 grupos de 10 asignaturas: 88 tokens distintos,
78 números distintos. Ver [DATA-MODEL, decisión 8](DATA-MODEL.md).

Y dos cosas que el detalle trae y no estaban documentadas: **prerrequisitos**
(22 de 36 asignaturas muestreadas) y el bloque **"Contenido de la asignatura"** (31 de
36). Ver `FIELDS.md`.

---

## Notas de fragilidad

Los IDs de componente (`pt1:r1:0:soc1`, `pt1:r1:0:t4`, `pt1:r1:0:cb1`) dependen del
árbol de componentes que ADF renderiza. Llevan al menos desde marzo de 2026 sin cambiar
— el proyecto anterior los documentó entonces y seguían vigentes en agosto — pero
pueden romperse sin aviso si la UNAL repinta la página.

El de la región de detalle **no es fijo por diseño** (§20): ese hay que leerlo siempre.

La colección Bruno es el canario: si deja de funcionar, el SIA cambió, y hay que
re-mapear con `FIELDS.md`.
