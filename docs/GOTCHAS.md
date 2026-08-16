# Trampas verificadas

Cada punto fue comprobado contra el servidor de producción el **2026-08-15**.
Varios contradicen lo que asumía el proyecto anterior (`BetterCampus/sia-scraper`).

Léelo antes de escribir código.

> §20-§28 salen de la segunda ronda de experimentos (2026-08-15, tarde). Las dos caras
> de descubrir por tu cuenta son la §20 —se disfraza de sesión colgada— y la §27, que
> no se nota nunca: simplemente faltan grupos.

---

## 1. El User-Agent NO puede parecer un navegador

Medido, misma URL, único cambio el UA:

| User-Agent | Respuesta |
|---|---|
| `curl/8.7.1` | **1 092 738 B** — página completa |
| `python-requests/2.31` | **1 135 019 B** — página completa |
| `sia-scraper/2.0` | **1 092 738 B** — página completa |
| `Mozilla/5.0 ... Chrome/120` | **6 998 B** — bootstrap JS |
| `Mozilla/5.0 ... Chrome/107` | **6 998 B** — bootstrap JS |
| *(sin header UA)* | 59 089 B |

Con UA de navegador recibes `AdfLoopbackUtils.runLoopback(...)`, que calcula
`_afrLoop` y `Adf-Window-Id` en JS y recarga. Sin motor JS te quedas ahí.

Lo que **sí** depende del UA es esa frontera: navegador → 6 998 B de loopback, cualquier
otra cosa → página utilizable. Los tamaños concretos de la columna derecha no son
estables entre peticiones (§25); no los uses como firma.

**Contraintuitivo:** intentar "parecer navegador" es exactamente lo que rompe el
scraper. Deja que Go mande su `Go-http-client/2.0`.

---

## 2. `Adf-Window-Id` es la constante `winnoloop`

Al saltarte el loopback, ADF asigna ese id fijo. No hay que extraerlo ni generarlo.

---

## 3. El ViewState NO rota

El proyecto anterior afirmaba que ADF rota el `javax.faces.ViewState` tras cada POST,
y montó toda su arquitectura de resincronización sobre esa premisa.

Es falso. Verificado: el mismo token `!-5pdrpr5se` en los 8 pasos de una sesión.
El estado vive en el servidor indexado por cookie; el token solo apunta.

Recaptúralo por si acaso, pero no diseñes alrededor de que cambie.

---

## 4. `_afrRK` se acumula Y se renumera

**El peor de todos.** Falla en silencio.

Los row keys son un contador por sesión que **no se reinicia entre búsquedas**:

```
Búsqueda 1 (Ing. Sistemas):  filas=98  _afrRK   0..97
Búsqueda 2 (otra carrera):   filas=71  _afrRK  98..168
Búsqueda 3:                  filas=57  _afrRK 169..225
```

Y además se **reasignan en cada re-render**:

```
antes de entrar al detalle:  2016353 → _afrRK=101
después de "Volver":         2016353 → _afrRK=8
```

Regla: **lee `_afrRK` del `<tr>` cada vez, justo antes de usarlo.** Nunca enumeres
posicionalmente, nunca caches la lista de keys.

El proyecto anterior usaba el índice de posición como `selectedRowKeys` y como sufijo
en `pt1:r1:0:t4:{idx}:cl2`. Funciona en la primera búsqueda de una sesión y se rompe
en la segunda — que es el patrón normal.

---

## 5. `_rowCount` miente a veces — y esa es la parte mala

```
Búsqueda 1 (plan A):  _rowCount="98"   filas reales = 98   ✓
Búsqueda 2 (plan B):  _rowCount="98"   filas reales = 67   ✗
Búsqueda 3 (plan C):  _rowCount="1"    filas reales =  1   ✓
Búsqueda 4 (plan D):  _rowCount="98"   filas reales = 59   ✗
Búsqueda 5 (electivas): _rowCount="240" filas reales = 240 ✓
```

No es "se queda con el primer valor": acierta unas veces y falla otras dentro de la
misma sesión, sin patrón útil. Peor que estar siempre mal, porque parece fiable.

**Cuenta los `<tr>`.** Siempre.

---

## 6. Sin cascada completa, el botón es un no-op silencioso

| Intento | Respuesta |
|---|---|
| Todo vacío, click directo a `cb1` | 896 B, cero filas |
| Solo `soc1=0` | 896 B, cero filas |
| `soc1=0` + `soc9=2`, sin facultad/carrera | 896 B, cero filas |
| Electivas sin disparar `soc10` antes de `soc6` | basura: keys duplicados |

Ni error, ni mensaje de validación. Solo no hace nada. Si recibes ~900 B donde
esperabas datos: falta un paso, o estás en la región de detalle (§10, §20), o expiró
la sesión (§7).

---

## 7. La sesión expira a los ~4.2 minutos, no a los 5

El timer de JS declara `__initializeSessionTimeoutTimer(300000, 120000, ...)` — 5 min.
**Medido, es menos:**

| Inactividad | Resultado |
|---|---|
| 250 s (4.2 min) | viva |
| 270 s (4.5 min) | **muerta** |
| 300 s / 310 s / 340 s | muerta |

Sí se renueva con cada petición: sesiones con ping cada 60, 120 y 180 s llegaron a los
**30 min** (tope de la prueba) sin degradarse, y una hizo 201 POSTs seguidos sin morir.
Pero el margen real es de ~4 min, no de 5: **usa un keepalive de ≤3 min.**

Y hay **dos firmas de muerte**, no una:

```
justo al expirar    ~1 200 B   no-op mudo, idéntico al de cascada incompleta (§6)
más tarde              419 B   "Because of inactivity, your session has timed out..."
```

La primera es la traicionera: no dice nada. Si un POST que debería traer datos devuelve
~1 KB, la sesión es sospechosa aunque no haya mensaje.

---

## 8. Cookie y ViewState deben ser de la misma sesión

Probadas las 6 combinaciones:

| Cookies | ViewState | Resultado |
|---|---|---|
| ✗ | vacío | falla |
| ✗ | inventado | falla ("session timed out") |
| ✓ | vacío | falla |
| ✓ | inventado | falla |
| ✓ | **el suyo** | **funciona** |
| ✓ (sesión A) | válido, de sesión B | falla |

---

## 9. El POST de `selection` es innecesario

Antes creía que hacían falta dos POSTs para el detalle (`selection` y luego el click).
No: **un solo POST basta** si `DELTAS` lleva `selectedRowKeys`.

Verificado: 1 POST → 48 524 B con `Cupos disponibles`.

Cuando el `selection` parecía obligatorio era porque `DELTAS` no llevaba la clave.

---

## 10. "Volver" antes de CUALQUIER acción de la región 0

La sesión está en `pt1:r1:0` (buscador+tabla) o en la región de detalle.

Tras abrir un detalle quedas en la de detalle. Verificado limpio: desde ahí, tanto una
**búsqueda nueva** como el **detalle de otra asignatura** devuelven ~895 B.

No es solo "entre detalles": es antes de cualquier cosa en la región 0.
Tu pool tiene que llevar ese estado por sesión.

**Pero el id de esa región no es `pt1:r1:1` fijo.** Cambia con cada detalle: ver §20.

---

## 11. `DELTAS` es opcional para buscar

El HAR de navegador de las electivas **no manda `oracle.adf.view.rich.DELTAS` en
ningún paso**, ni siquiera en el `cb1` final, y devuelve las 240 filas igual.

Sí hace falta para el detalle, donde transporta `selectedRowKeys`.

---

## 12. `Adf-Page-Id` y `Adf-Ads-Page-Id` no se validan

Observados funcionando: `Adf-Page-Id` = 0, 1, 2, 9 · `Adf-Ads-Page-Id` = 1, 3, 11.
Manda cualquier cosa consistente.

---

## 13. Los códigos se repiten en el listado — y son la misma asignatura

```
libre elección Bogotá:  215 códigos únicos en 240 filas
2019510 ×7 · 2020922 ×4 · 2020933 ×4 · 2018632 ×4
```

**Verificado:** hacer click en dos filas duplicadas del mismo código da un detalle
**byte-idéntico** (`sha256` igual, 28 líneas iguales).

Las filas repetidas **no son grupos distintos**: `2019510` aparece 7 veces y su detalle
tiene **1 solo grupo**. Son emparejamientos (asignatura × plan) — la misma asignatura
ofertada bajo varios planes, y las 5 columnas visibles no incluyen el plan.

**Dedupear por código al parsear el listado es seguro.**

El listado regular de una carrera **no** tiene duplicados (98 códigos únicos de 98
filas). Solo aparecen en el buscador de electivas.

---

## 14. El tope de 1000 filas existe en el código, pero no se alcanza

En una consulta malformada vi `_rowCount="2114"` con exactamente **1000 filas**
devueltas — igual al `fetchSize: 1000` que declara el `AdfRichTable`.

Barrido posterior de ~120 consultas bien formadas (electivas con comodín de sede en 4
sedes × 2 modos × todas las facultades, más listados regulares en varios niveles):

```
máximo global      644 filas   Medellín, comodín de sede, desde un plan de Arquitectura
máximo en Bogotá   319 filas
listado regular     98 filas   típico
```

Y `viewportSize` / `rows` dentro de `DELTAS` **no cambian nada**: 25, 100, 250, 999,
2000 y 5000 devuelven las mismas filas. No hay paginado, ni hace falta.

**Regla práctica:** no lo vas a tocar. Deja una aserción por si acaso — exactamente
1000 filas = sospecha de truncamiento, no un resultado.

---

## 15. Bug del proyecto anterior: `soc6 = sede + 40`

`ELECTIVES_CAMPUS_INCREMENT = 40` → para sede=2 calculaba `soc6=42`.

El dropdown solo tiene opciones **0..12**. Es un índice posicional en una lista de 13,
no una fórmula. El flujo de electivas de ese proyecto estaba roto.

---

## 16. El conjunto de grupos depende de la carrera; los cupos no

Misma asignatura (`1000004-B` Cálculo diferencial), dos carreras:

```
INGENIERÍA DE SISTEMAS Y COMPUTACIÓN : 25 grupos
INGENIERÍA INDUSTRIAL                : 23 grupos
comunes                              : 23      ← subconjunto ESTRICTO
solo en Sistemas                     : Grupo 18, Grupo 24
cupos de los 23 comunes              : idénticos, 0 diferencias
```

Los grupos son **globales** (mismo profesor, horario, aula y cupos), pero cada plan ve
solo el subconjunto que tiene habilitado.

Dos consecuencias:

- **Una sola medición de cupos sirve para todos los planes.** No hay que muestrear por
  carrera.
- Consultar una asignatura desde **una** carrera te da un subconjunto de sus grupos.
  Para el universo completo habría que consultarla desde todos los planes que la
  ofrecen. Para el caso de uso normal (¿qué puedo inscribir yo?) el subconjunto por
  plan es justamente lo que interesa.

Modelado: `section` global + `section_program` como tabla de visibilidad.

---

## 17. El vocabulario de tipología cambia entre vistas

```
listado:  LIBRE ELECCIÓN (L)
detalle:  ELEGIBLES
```

Misma cosa, dicha distinto. Normaliza a un enum en el dominio y guarda el literal
crudo aparte.

**Confirmado que la tipología varía entre carreras.** Se comparó la celda `c6` de 15
planes de Bogotá: de los 22 códigos presentes en más de un plan, **8 divergen**.

```
1000003-B   INGENIERÍA AGRÍCOLA  = FUND. OBLIGATORIA (B)
            BIOLOGÍA             = FUND. OPTATIVA (O)
2017538     INGENIERÍA AGRÍCOLA  = FUND. OBLIGATORIA (B)
            BIOLOGÍA             = DISCIPLINAR OPTATIVA (T)
2015701     INGENIERÍA AGRÍCOLA  = FUND. OPTATIVA (O)
            ADMÓN. DE EMPRESAS   = DISCIPLINAR OPTATIVA (T)
```

Y cruzando con el buscador de electivas, `2027992` y `2025196` son
`DISCIPLINAR OPTATIVA (T)` en su plan madre y `LIBRE ELECCIÓN (L)` desde otro.

Por eso `typology` vive en `course_program`. Colgarla de `course` la machaca en cada
scrapeo de otra carrera, en silencio.

---

## 18. Hay asignaturas sin grupos

`2027641` (Análisis de bases de datos) existe en el catálogo y su detalle trae
**0 grupos**. No se está ofertando este periodo.

El esquema debe permitirlo, y la API debe distinguir *"no la conozco"* de
*"existe pero no tiene oferta"*.

---

## 19. `it11` filtra por nombre, `it10` por créditos

Pese al orden de los campos, `it10` es **número de créditos** e `it11` es **nombre**.

`it11` filtra en el servidor: substring, insensible a acentos (`calculo` → `Cálculo`).
Baja el payload de 241 KB a 15–27 KB.

**No reemplaza la carrera:** con `soc3` vacío, ADF ignora la consulta y re-renderiza
el resultado anterior — que se parece mucho a un éxito. Cuidado.

---

## 20. La región de detalle se NUMERA, y el número crece

**La peor de todas. Se disfraza de sesión colgada.**

`PROTOCOL.md` decía que Volver es `pt1:r1:1:cb4`. Eso es cierto **solo para el primer
detalle de la sesión**. El índice de la región sube con cada detalle abierto:

```
1.er detalle → la región es pt1:r1:1  → Volver = pt1:r1:1:cb4
2.º  detalle → la región es pt1:r1:2  → Volver = pt1:r1:2:cb4
98.º detalle → la región es pt1:r1:98 → Volver = pt1:r1:98:cb4
```

Con el id fijo, el síntoma es este:

```
detalle 1 → 157 KB ✓     Volver (pt1:r1:1:cb4) → 257 KB, 98 filas ✓
detalle 2 →  20 KB ✓     Volver (pt1:r1:1:cb4) →   893 B, 0 filas  ✗
                         Volver otra vez        →   893 B          ✗
                         búsqueda nueva         →   893 B          ✗
```

La sesión **parece muerta y no lo está**: sigue en la región de detalle, y como el
botón que le mandas no existe, todo lo demás es no-op (§6, §10). Con el índice correcto
revive al instante. Medido: reintentar `pt1:r1:2:cb4` desde ese estado devuelve los
257 KB de siempre.

Sin el arreglo, cada asignatura a partir de la segunda cuesta un re-bootstrap de 7 s.
Con el arreglo:

```
98 detalles seguidos en UNA sesión · 201 POSTs · 99 s · 31 MB · 0 fallos
```

**Regla:** lee el índice de la respuesta del detalle y úsalo para el Volver. Nunca lo
hardcodees, nunca lo derives de un contador propio.

```go
// de la respuesta del detalle:
//   id="pt1:r1:<N>:cb4"
re := regexp.MustCompile(`id="pt1:r1:(\d+):cb4"`)
```

No se le vio techo en 98 iteraciones.

---

## 21. `soc4=0` no es "sin filtro": es "todas MENOS libre elección"

El dropdown de tipología completo:

| Valor | Etiqueta |
|---|---|
| `0` | **TODAS MENOS  LIBRE ELECCIÓN** |
| `1` | DISCIPLINAR OPTATIVA |
| `2` | FUND. OBLIGATORIA |
| `3` | FUND. OPTATIVA |
| `4` | TRABAJO DE GRADO |
| `5` | DISCIPLINAR OBLIGATORIA |
| `6` | NIVELACIÓN |
| `7` | LIBRE ELECCIÓN |

Mandarlo vacío es idéntico a mandar `0` (98 filas en ambos casos, mismo reparto). Y los
subfiltros parten exactamente el total:

```
20 FUND. OPTATIVA + 5 FUND. OBLIGATORIA + 38 DISCIPLINAR OPTATIVA
+ 13 DISCIPLINAR OBLIGATORIA + 19 NIVELACIÓN + 3 TRABAJO DE GRADO = 98
```

**Consecuencia:** el listado regular de un plan **nunca** incluye sus asignaturas de
libre elección. Las libres solo salen por el buscador de electivas (§5 de
`PROTOCOL.md`), que es campus-wide y no por plan. Si asumes que "1 POST = el programa
entero", te falta una parte del catálogo del estudiante.

Ojo también: en doctorado y postgrado (`soc1` = 1 o 2) **no existe la opción LIBRE
ELECCIÓN**, así que el buscador de electivas es exclusivo de pregrado.

---

## 22. El bootstrap puede llegar con la tabla de OTRA sesión

La página inicial no siempre trae la tabla vacía. En 8 bootstraps limpios:

```
4 de 8   tabla vacía
4 de 8   tabla poblada con 78, 97 y hasta 98 filas ajenas
```

Los códigos que aparecen no tienen nada que ver con la consulta que vas a hacer:
`5000844 Agroindustria de alimentos balanceados` (posgrado, agro) en una sesión recién
abierta. Es estado de otra consulta reciente contra el mismo nodo.

Dos consecuencias:

- **Nunca parsees la tabla de la respuesta del bootstrap.** Son datos de alguien más.
- **Desplaza el origen de `_afrRK`.** Con la tabla poblada, tu primera búsqueda propia
  empieza en `rk=78` o `rk=98`, no en `0`. Otra razón para no asumir nunca que las
  claves arrancan en cero (§4).

---

## 23. En la página completa cada `<tr>` aparece 5 veces

Solo en el HTML completo del GET inicial, no en las respuestas parciales:

```
página completa    390 <tr>   →   78 filas reales, cada una repetida ×5
respuesta parcial   98 <tr>   →   98 filas reales
```

ADF renderiza la tabla partida en varias sub-tablas (columnas fijas, scroll, etc.).
Si alguna vez parseas el HTML completo, cuentas 5 veces todo.

**Regla:** parsea siempre el CDATA de `<update id="pt1:r1:0:pb3">` de una respuesta
parcial, nunca el documento del bootstrap. Que es, además, lo que dice §22.

---

## 24. Las cabeceras de grupo no siempre son `(N) Grupo N`

El regex documentado (`^\(\d+\)\s*Grupo`) se come los grupos PEAMA. De 233 cabeceras
observadas en 36 asignaturas:

```
187   (N) Grupo N                          ← el formato "normal"
 11   (TUMA-N) Peama - Tumaco - Grupo N
 10   (ORIN-N) Peama-Orinoquia Grupo N
  9   (SUMA-N) Grupo N
  5   (AMAZ-N) Peama-Amazonia Grupo N
  3   (TUMA-N) Peama- Tumaco -Grupo N      ← mismos espacios, distintos
  3   (SUMA-N) Peama Sumapaz - Grupo N
  2   (CARI-N) Peama-Caribe Grupo N
  1   (CARI-N) PEAMA- PAET Caribe Grupo N
  1   (ORIN-N) Peama Grupo N
  1   (N) Grupo N-
```

Un 20 % de los grupos son PEAMA y el regex viejo los ignora **en silencio**:
`2015555` parecía tener 0 grupos y tiene 1, con sus cupos.

```go
// tolerante a las variantes de arriba
var groupRe = regexp.MustCompile(`\([^)\n]{1,20}\)[^\n]{0,60}?Grupo\s*\S+`)
```

Esos grupos traen además su propia sede (`Facultad: SEDE TUMACO`), distinta de la del
plan desde el que consultas.

---

## 25. El coste del bootstrap es muy variable, y no depende del UA

`PROTOCOL.md` decía "~7 s y 1.1 MB". Es un punto de una distribución ancha. Mismo
request, sesiones nuevas, seguidas:

```
59 050 B / 0.33 s      685 160 B / 6.0 s      1 363 133 B / 6.4 s
59 050 B / 0.26 s      843 245 B / 6.2 s      4 849 783 B / ~7 s
```

El eje no es el User-Agent: `Go-http-client/2.0` dio 59 KB en una tirada y 843 KB en
otra. Lo único determinista es la regla del §1 — UA de navegador → 6 998 B de loopback,
cualquier otro → página utilizable. Buena parte de la varianza es la tabla ajena del
§22.

Reusar cookies sí abarata: el mismo GET dentro de una sesión ya abierta baja a
~52 KB / 0.14 s.

**Para el diseño:** no presupuestes 7 s fijos de bootstrap, pero tampoco cuentes con
los 0.3 s. Es entre 0.15 y 7 s, y no lo controlas.

---

## 26. `program.code` NO es único entre sedes

`DATA-MODEL.md` daba por verificado que sí. El censo completo (1380 entradas de
programa) dice lo contrario:

| Clave candidata | Claves distintas | Colisiones |
|---|---|---|
| `code` | 852 | **136** |
| `(campus_code, code)` | 1333 | **46** |
| `(campus_code, faculty_code, code)` | 1380 | **0** |

El mecanismo es PEAMA: las sedes de presencia nacional reexponen programas de otras
sedes con **el mismo código institucional**.

```
2A41 ADMINISTRACIÓN DE EMPRESAS
  1101 SEDE BOGOTÁ    · 2051 FACULTAD DE CIENCIAS ECONÓMICAS
  1124 SEDE ORINOQUIA · 7000 SEDE ORINOQUIA
  1125 SEDE AMAZONIA  · 6000 SEDE AMAZONIA
  1126 SEDE CARIBE    · 8000 SEDE CARIBE
  9920 SEDE TUMACO    · 9000 SEDE TUMACO
```

Y dentro de una misma sede un programa puede colgar de dos facultades: la real y una
**facultad comodín cuyo código acaba en `000`** (`2000`, `4000`, `6000`, `7000`, `8000`,
`9000`), que agrupa lo reexpuesto.

**Identidad de programa = `(campus_code, faculty_code, code)`.** Con `UNIQUE (code)`,
el crawl de fase 2 hace UPSERT de Orinoquia sobre Bogotá: corrupción silenciosa.

---

## 27. La identidad de un grupo NO es `Grupo N`

Una asignatura mezcla grupos regulares y grupos PEAMA de otras sedes, y **la numeración
se repite entre unos y otros**:

```
1000004-B  Cálculo diferencial · 32 grupos
  (1) Grupo 1 · (2) Grupo 2 · … · (26) Grupo 26
  (AMAZ-01) Peama-Amazonia Grupo 1     ← "Grupo 1" otra vez
  (AMAZ-07) Peama-Amazonia Grupo 1     ← y otra
  (TUMA-01) Peama - Tumaco - Grupo 1   ← y otra
  (CARI-01) Peama-Caribe Grupo 1       ← y otra
```

Medido sobre 88 grupos de 10 asignaturas:

| Clave | Valores distintos | Veredicto |
|---|---|---|
| `Grupo N` | 78 de 88 | **pierde 10 grupos** |
| token entre paréntesis | 88 de 88 | identidad |

Con `(code, term, number)` como clave, esos 10 hacen UPSERT unos sobre otros: la
asignatura queda con menos oferta de la real y con horarios y cupos mezclados. Otro
fallo silencioso.

**La clave es el token entre paréntesis, verbatim:** `1`, `10`, `AMAZ-07`, `TUMA-01`.
`number` se guarda porque es lo que el estudiante lee, pero no identifica.

Los grupos PEAMA además traen su propia sede (`Facultad: SEDE TUMACO`) y **su propio
calendario** (`24/08/2026` frente al `27/08/2026` de Bogotá).

---

## 28. Una conexión no RECHAZA la concurrencia: te da la respuesta de otro

Lo esperable de un backend con estado sería un error, o un lock. No hay ninguno de los
dos. Dos peticiones a la vez sobre la **misma** sesión (misma cookie, mismo ViewState)
devuelven `200 OK` con contenido plausible, y el perdedor no tiene forma de notarlo.

Medido, tres escenarios:

```
A) 2 búsquedas IDÉNTICAS     → las dos correctas, 98 filas cada una
B) 2 programas DISTINTOS     → las dos devuelven 67 filas y los MISMOS códigos.
                               El hilo que pidió el programa de 98 filas recibió
                               el catálogo del otro programa. 200 OK.
C) 2 detalles                → uno gana (157 KB, 19 grupos), el otro recibe 895 B
```

El caso B es el grave: no es un fallo, es una **respuesta equivocada bien formada**. El
caso C al menos se detecta con la regla del no-op (§6).

Después de la carrera la sesión queda desincronizada de forma no determinista — en una
tirada un `soc3` de vuelta al programa correcto seguía devolviendo 67 filas, en otra se
recuperó sola. **La conexión no hay que tirarla:** re-cascadear (`soc9` → `soc2` →
`soc3`) la deja sana otra vez.

### La consecuencia no es "pon un mutex", es dónde ponerlo

El mutex tiene que envolver la **operación lógica completa**:

```
    correcto                             roto
    ────────                             ────
    lock                                 lock; POST soc3; unlock
      POST soc3                          lock; POST cb1;  unlock
      POST cb1                           ↑ dos operaciones se intercalan aquí
    unlock                                 y reproduces el caso B tal cual
```

Las operaciones lógicas son: *cascada + `cb1`*, y *detalle + `Volver`*. Partirlas es
exactamente el bug.

Entre conexiones distintas no hay problema: 8 sesiones en paralelo dan 0 errores y 0
contaminación (§ concurrencia en [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)). El paralelismo
va **entre** conexiones, nunca dentro de una.

---

## Resumen para el diseño en Go

```go
// 1. UA que no parezca navegador (el default de Go sirve)
// 2. Adf-Window-Id = "winnoloop" constante
// 3. cookiejar obligatorio; ViewState de la misma sesión
// 4. Re-parsear _afrRK antes de CADA uso. Nunca cachear. No empieza en 0.
// 5. Contar los <tr>; ignorar _rowCount
// 6. Respuesta de ~900 B = paso faltante, región de detalle, o sesión caducada
// 7. Llevar el estado (parkedAt, detailRegion) por conexión
// 8. Un bootstrap por sesión, no por carrera
// 9. Dedupear el listado por código
// 10. Clave natural de oferta: (code, term, key); key = token entre parentesis
//     (1, AMAZ-07, TUMA-01). NUNCA (code, term, number): colisiona.
// 11. El Volver es pt1:r1:<N>:cb4 con N leído del detalle, nunca 1 fijo
// 12. soc4=0 excluye libre elección; las libres van por el buscador de electivas
// 13. Keepalive <= 3 min (el timeout real es ~4.2 min, no 5)
// 14. Identidad de programa: (campus_code, faculty_code, code)
// 15. Mutex por conexion envolviendo la OPERACION LOGICA, no cada POST
```

---

## 29. `golang.org/x/net/html` baja `_afrRK` a minúsculas — trampa de implementación, no del SIA

Verificado escribiendo `sia/parse_list.go` (2026-08-15). No es un hallazgo contra el
servidor como los anteriores: es un hallazgo contra la librería HTML de Go.

El tokenizer de `golang.org/x/net/html` (y por tanto `goquery`, que lo usa por debajo)
ASCII-lowercasea todos los nombres de atributo al parsear, por espec. HTML5. El atributo
que llega en el wire como `_afrRK="47"` aparece en el árbol DOM parseado como `_afrrk`.

```go
tr.Attr("_afrRK")  // false, "" — silencioso, no panic
tr.Attr("_afrrk")  // true, "47" — correcto
```

Con `Attr` devolviendo `(valor, ok)`, el fallo es fácil de no notar si no se comprueba
`ok`: `ParseList` devolvía **0 filas** de un documento con 98 `<tr>` reales, sin error.
Se mezcla mal con el §4 (nunca cachear `_afrRK`, releer siempre) — aquí el bug estaba en
leerlo *mal*, no en cachearlo.

**Regla:** cualquier atributo con mayúsculas que se lea vía `goquery`/`x/net/html` hay
que buscarlo en minúsculas. No aplica a atributos `id` (van todos en minúsculas en el
HTML que manda el SIA) ni a texto de nodos — solo a nombres de atributo.

---

## 30. Reenviar un `valueChange` con el mismo valor no re-renderiza el dropdown dependiente

Verificado escribiendo `sia/cascade.go` (paso 6, 2026-08-15). Necesario para resolver
`{program}` en la URL: recorrer las ~13 facultades de Bogotá y, por cada una, pedir sus
carreras (`soc2` → puebla `soc3`).

La implementación ingenua reutiliza `soc1`+`soc9` (nivel+sede) para cada facultad,
llamando a la misma secuencia de 2 pasos en cada iteración. **Falla en la segunda
llamada sobre la misma conexión:**

```
1.ª vez:  soc1=0, soc9=2  →  respuesta trae <update id="pt1:r1:0:soc2"> con las 13 facultades  ✓
2.ª vez:  soc1=0, soc9=2  →  respuesta NO trae <update id="pt1:r1:0:soc2">                      ✗
```

Mismos valores, misma conexión, mismo ViewState. La respuesta es 200 OK y no es un no-op
de los de siempre (no mide ~900 B, sigue siendo una respuesta normal) — simplemente el
`<update>` que se necesita no está, porque desde el punto de vista de ADF el valor **no
cambió**, así que no hay nada que re-renderizar. Se parece al no-op de cascada
incompleta (§6) pero la causa es la contraria: no falta un paso, sobra una repetición.

**Regla:** nunca reenviar un `valueChange` con el mismo valor que el componente ya
tiene. Si hace falta releer las opciones de un dropdown ya seleccionado, no se puede —
hay que quedarse con la respuesta de la primera vez.

**Consecuencia de diseño:** `sia.SIAConn.FetchProgramDirectory` hace nivel+sede **una
sola vez** y despues itera facultad por facultad cambiando solo `soc2` (valor distinto
en cada vuelta, así que sí re-renderiza `soc3`). Nunca separar esto en llamadas
independientes que puedan reutilizar la misma conexión para el mismo nivel+sede dos
veces.
