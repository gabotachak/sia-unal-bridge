# Trampas verificadas

Cada punto fue comprobado contra el servidor de producción el **2026-08-15**, y las seis
últimas (§34–§39) el **2026-08-17/18**, implementando la fase 2.
Varios contradicen lo que asumía el proyecto anterior (`BetterCampus/sia-scraper`).

Léelo antes de escribir código.

> §34-§39 las destapó el `Refresher` al recorrer sedes y niveles que la API nunca había
> tocado. Las seis eran bugs de la API tambien, no del Job.
>
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

Entre conexiones distintas no hay problema hasta 80 en paralelo: 0 errores, 0
contaminación (§ concurrencia en [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)). En 88 empieza
a degradar. El paralelismo va **entre** conexiones, nunca dentro de una.

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

> **Corrección, 2026-08-16:** lo de arriba no basta. El §30 se manifestó en producción
> vía Bruno contra `/v1/campuses/{campus}/faculties` — no por una segunda llamada *dentro* de
> `FetchProgramDirectory`, sino porque el **pool** reutiliza conexiones entre
> operaciones sin relación: una petición a `/v1/campuses/1101/programs/2A74/courses` deja la conexión
> con `soc1=0, soc9=2`; la siguiente petición a `/v1/campuses/{campus}/faculties`, si le toca esa misma
> conexión, reenvía `soc1=0, soc9=2` sin saberlo → mismo no-op del §30. Ver detalle
> completo en §31.

> **Excepción, 2026-08-18:** `soc6` no la sufre. El `soc10` que va justo antes lo
> re-renderiza y le borra la selección en el servidor, así que reenviarle el mismo valor
> vuelve a ser un cambio real. Rebotar ahí no solo sobra: es imposible en las sedes de
> una sola facultad. Medido en §37.

---

## 31. El §30 es un problema del *pool*, no solo de un bucle mal escrito

Reproducido primero a mano vía Bruno (`GET /v1/campuses/1101/faculties` → `502 sia_noop`)
contra el `api` en Docker, con el pool ya calentado por peticiones anteriores.

El §30 documentaba el síntoma dentro de un único método (`FetchProgramDirectory`
llamándose dos veces sobre la misma conexión). La causa real es más ancha: **cualquier
conexión del pool puede llegar a cualquier método ya parqueada en cualquier estado**,
porque el pool no le pertenece a ninguna operación — se la queda quien la pida. Dos
peticiones HTTP sin relación (`/programs/2A74/courses` y luego `/faculties`) pueden
compartir físicamente la misma conexión si el scheduler del pool así lo decide, y la
segunda hereda el `soc1`/`soc9` que dejó la primera.

Peor todavía en fase 1: **el alcance es una sola sede.** `FetchElectives` postea
`soc4=7, soc5=0, soc10=<sede>, soc6=12` — los mismos cuatro valores en *cada* llamada,
sin excepción, porque solo hay una sede. La segunda vez que cualquier conexión del pool
se reutiliza para electivas — sin importar de qué programa — los cuatro campos ya están
en el valor que se les va a mandar. Sin arreglo, esto rompe silenciosamente el catálogo
completo de cualquier segundo programa consultado.

**Regla general:** cualquier método que dependa de un `valueChange` para traer datos
frescos (no solo para avanzar estado) tiene que:

1. Llevar en la conexión el último valor real posteado por campo (`navLevel`,
   `navCampus`, `navFaculty`, `navTipologia`, `navModo`, `navSedeElect`, `navFacElect`
   en `sia.SIAConn`), independiente de `parked`.
2. Si el valor objetivo ya coincide con el último conocido, **rebotar**: postear
   cualquier otro valor válido primero (una repetición gratis, se descarta), y recién
   ahí postear el valor real — así el POST que importa siempre es un cambio genuino.
3. Si el método NO necesita los datos de vuelta (p. ej. `gotoProgram`, que solo le
   importa que el servidor quede posicionado antes de `soc3`), no hace falta rebotar:
   simplemente **saltarse el POST entero** si el valor no cambia. Sin red, sin riesgo.

`sia/cascade.go`: `gotoProgram` usa la estrategia (3) para `soc1`/`soc9`/`soc2`.
`FetchProgramDirectory` y `FetchElectives` usan la (2) vía el helper
`postValueChangeFresh`, porque sí consumen la respuesta.

Verificado con dos pruebas en vivo que reproducen exactamente el bug original:
`TestLive_FetchProgramDirectory_AfterGotoProgram` (parquea con `FetchCatalog`, después
pide el directorio en la misma conexión) y `TestLive_FetchElectives_TwiceOnSameConn`
(dos programas distintos, misma sede, misma conexión). Las dos fallaban antes del
arreglo y pasan después, sin tocar nada más.

---

## 32. El comodín "toda la sede" de `soc6` está en una posición distinta en cada sede

`soc6=12` es el comodín `2000 SEDE BOGOTÁ` del buscador de electivas ([PROTOCOL §5](PROTOCOL.md)):
devuelve la libre elección de **toda la sede** de una. Eso es cierto **solo en Bogotá**.

El `12` no es el comodín: es su **posición** en la lista `soc6` de Bogotá, que tiene 13
opciones. Cada sede rinde su propia lista y el comodín cae donde caiga:

| Sede | Opciones en `soc6` | Índice del comodín | Etiqueta |
|---|---|---|---|
| Bogotá | 13 | `12` | `2000 SEDE BOGOTÁ` |
| Medellín | 11 | `10` | `3 SEDE MEDELLÍN` |

Medido 2026-08-15. Postear `12` en Medellín es un índice fuera de rango, y el SIA
responde a eso **con un no-op silencioso**: ~900 B, HTTP 200, sin `<update>`. O sea que
el síntoma es el del §30 y el del §7 (sesión caducada) aunque la causa sea otra. Con la
API por delante se ve como `502 sia_noop` en el catálogo de cualquier sede que no sea
Bogotá, y solo en la mitad de electivas: `FetchCatalog` funciona perfecto, así que
parece un problema de electivas y no de sede.

**Cómo se resuelve:** la respuesta del `valueChange` de `soc10` (sede del buscador) trae
el `<update id="pt1:r1:0:soc6">` con la lista de ESA sede. El comodín se reconoce por la
etiqueta —las facultades reales se llaman `FACULTAD DE …`, el comodín `SEDE …`— y su
índice se lee de ahí, en cada petición. Nunca se constantiza.

Mismo patrón que el §26 y que los `*_idx`: **una posición de dropdown no es identidad**.
El comodín también aparece en `soc2` (cascada regular), donde no estorba pero tampoco es
una facultad — y en Medellín cuelgan de él 2 planes que no aparecen bajo ninguna
facultad real, así que filtrarlo perdería datos.

`sia/cascade.go`: `electivesWildcard`. Verificado con
`TestLive_ElectivesWildcardIsPerCampus`, que corre Bogotá y Medellín en la misma prueba:
240 y 640 filas de libre elección respectivamente. Antes del arreglo, Medellín daba
no-op.

---

## 33. Una conexión que hizo electivas queda en `soc4=7`, y el siguiente catálogo regular sale no-op

`FetchElectives` conmuta la búsqueda con `soc4=7` y arma el buscador de electivas
(`soc5`, `soc10`, `soc6`). Al terminar **el servidor sigue ahí**. Como el pool reparte
conexiones entre peticiones sin relación (§31), la siguiente que pida el listado regular
puede caer en esa misma conexión.

Y si además es el **mismo plan**, `gotoProgram` no hace nada —el valor de cada dropdown
ya es el correcto, así que se salta los tres POSTs (§30, estrategia 3)—, de modo que el
`cb1` se dispara con el buscador de electivas todavía activo. El SIA responde con un
no-op silencioso.

**La trampa dentro de la trampa:** el código *creía* arreglarlo. `FetchElectives`
terminaba con

```go
c.form.Tipologia = TypologyAll   // NO alcanza
```

Eso solo cambia **qué lleva el próximo POST**, no el estado del servidor. `soc4` en ADF
se cambia con un `valueChange`, no adjuntando otro valor en el siguiente formulario. Y
peor: dejaba `navTipologia` diciendo `7` mientras `form` decía `0`, así que la conexión
mentía sobre sí misma.

**Cómo se resuelve:** `FetchCatalog` postea el cambio real a `soc4` cuando
`navTipologia != "0"`, y se lo salta cuando ya está —no consume la respuesta, solo el
efecto, igual que `gotoProgram`—. `FetchElectives` ya no toca `form.Tipologia` al final:
deja `navTipologia` diciendo la verdad.

Síntoma en la API: `502 sia_noop` en **el detalle** de una asignatura, en ~250 ms —
demasiado rápido para una cascada—, y solo después de haber pedido el catálogo de ese
plan. El detalle pasa por `findRow`, que llama a `FetchCatalog` para leer el `_afrRK`
fresco (§4), así que el fallo aparece al pedir cupos y parece un problema de cupos.

`sia/cascade.go`: `FetchCatalog`. Verificado con
`TestLive_CatalogAfterElectivesOnSameConn`, que hace electivas y luego catálogo sobre la
misma conexión y el mismo plan: 98 filas donde antes había un no-op.

---

## 34. `it11` viaja en el estado del formulario: si no lo limpias, recorta el siguiente listado

Descubierta implementando la fase 2 (2026-08-17). El filtro por nombre es lo que hace
barato el barrido de detalle: el `cb1` sin filtrar son **232 KB** y con filtro **17.8 KB**
sobre el mismo plan — **13× menos** (medido, Ingeniería de Sistemas, Bogotá).

La trampa no es el servidor, es el formulario. `it11` va en **cada POST** junto con los
nueve `soc*` ([PROTOCOL §2](PROTOCOL.md)), así que una conexión que filtró y vuelve al
pool con `form.Nombre` puesto convierte el **siguiente catálogo completo** en un listado
recortado: ~3 filas plausibles donde debían ir 98. Nadie ve un error; se guarda un
catálogo mutilado y se marca fresco.

Es la familia del §33 con la causa invertida:

| | §33 (`soc4`) | §34 (`it11`) |
|---|---|---|
| Dónde vive el estado | en el **servidor** | en el **formulario** |
| Por qué falla | escribir `form` no cambia el servidor | escribir `form` **sí** llega, y se queda |
| Cómo se limpia | posteando el `valueChange` real | poniendo el campo en `""` |

**Cómo se resuelve:** limpiarlo es parte de la operación lógica, no de la buena educación
del llamador. `findRow` pone `form.Nombre`, hace su búsqueda y lo borra en la misma
función, tanto en el listado regular como en el de electivas — que es el más caro de los
dos (~240–320 KB) y el único donde viven las de libre elección.

Y el filtro puede devolver **varias filas**: la fila se elige por **código**, jamás por
posición. Si el código no aparece (acentos, nombres raros), se repite la búsqueda sin
filtro; el filtro es una optimización, no la fuente de verdad.

`sia/source.go`: `findRow`, `findRowInListings`. Verificado con
`TestLive_NameFilterShrinksTheListingAndDoesNotStick`: filtra, comprueba que la fila está,
y exige que el listado inmediatamente posterior vuelva a traer las 98 filas.

---

## 35. El comodín "toda la sede" de `soc6` NO EXISTE en doctorado

Medido 2026-08-17, en las tres sedes con doctorado que se probaron:

| Sede | Nivel | Opciones `soc6` | Comodín `SEDE …` |
|---|---|---|---|
| Bogotá | pregrado | 13 | sí, índice 12 |
| Bogotá | posgrado | 13 | sí, índice 12 |
| Bogotá | **doctorado** | **11** | **no** |
| Medellín | **doctorado** | **6** | **no** |
| Palmira | pregrado | 4 | sí, índice 3 |
| Palmira | **doctorado** | **2** | **no** |

El §32 dice que la posición del comodín es por sede. Es más que eso: su **existencia** es
por *(sede, nivel)*. En doctorado `soc6` lista solo facultades.

Tratar su ausencia como error —que es lo que hacía el código— dejaba el catálogo de
**~82 planes de doctorado** inservible: `502` por la API y programas fallidos en el
barrido. El síntoma es un error explícito y honesto (`no "SEDE " wildcard among 2 soc6
options`), así que no es de los silenciosos; pero se descubrió porque el Job lo destapó
en Palmira, no por la API. La fase 2 predijo exactamente eso: *"cualquier bug de
persistencia que el job destape es un bug que la API también tenía"*.

**Cómo se resuelve:** el comodín es una **optimización, no el mecanismo**. Cuando existe,
una búsqueda cubre la sede; cuando no, el listado de la sede es la **unión de una búsqueda
por facultad** (Palmira doctorado: 186 + 21 = 207 filas, 76 tras dedupe). Por eso
`FetchElectives` devuelve `[][]byte` — un cuerpo por búsqueda — y no un cuerpo solo.

Con la unión aparece un caso nuevo: una facultad **sin** libre elección. Un no-op ahí es
ambiguo (§6/§7), así que se recuerda y solo se reporta si **todas** las búsquedas dan
no-op; si alguna trajo filas, la sesión está viva y las vacías son vacías de verdad.

`sia/cascade.go`: `electivesTargets`. Verificado con
`TestLive_FetchElectives_LevelWithoutSedeWildcard`.

---

## 36. El nombre de la asignatura en el listado viene pegado a una insignia

En la celda `c2` del listado, una asignatura sin programar mete un cartel **dentro del
mismo `<td>`**:

```html
<td id="...:c2"><span class="af_column_data-container">
  <span title="">Complemento a teoría de la computación </span>
  <div></div>ASIGNATURA SIN PROGRAMAR
</span></td>
```

Leer el texto de la celda entera los pega: `"Complemento a teoría de la
computaciónASIGNATURA SIN PROGRAMAR"`. Eso llegaba a la columna `course.name` — dato
plausible y equivocado, del tipo que este dominio produce sin avisar — y además rompía el
filtro del §34, que busca por el nombre que tenemos guardado.

**Cómo se resuelve:** el nombre está en el `<span title="">` más interno, no en la celda.
`parse_list.go` lee `td[id$=":c2"] span[title]` y solo cae al texto completo de la celda
si eso no existe.

`sia/parse_list.go`: `ParseList`. Verificado con
`TestParseList_NameExcludesTheUnscheduledBadge` sobre el fixture del 2026-08-15.

---

## 37. `soc10` borra la selección de `soc6`, así que el rebote del §30 sobra ahí

El §30 dice que reenviar a un dropdown el valor que ya tiene produce un no-op
indistinguible de una sesión muerta, y que por eso hay que **rebotar** por otro valor
antes. Es cierto para `soc1`/`soc9`/`soc2`/`soc3`/`soc10`. Para `soc6` **no**, y esa
excepción importa porque el rebote necesita una segunda opción por la que rebotar.

Medido 2026-08-18, una sola conexión sobre Amazonia posgrado:

| POST | Bytes | ¿no-op? |
|---|---|---|
| `soc10=1` | 6 515 | no |
| `soc6=0` | 1 174 714 | no |
| `soc6=0` otra vez | **1 036** | **sí** |
| `soc10=2`, `soc10=1` (rebote de sede) | 7 875 / 21 721 | no |
| `soc6=0` **después del re-render** | **21 042** | **no** |

Repetir `soc6` sin más sí es no-op. Pero `FetchElectives` **siempre** postea `soc10`
antes, y ese POST **vuelve a pintar el dropdown de `soc6` y le borra la selección en el
servidor**. Después de eso, el mismo valor de siempre vuelve a ser un cambio real.

Por qué importa: el código rastreaba `soc6` en `navFacElect` y rebotaba por otra opción
cuando coincidía. Las sedes chicas listan **una sola opción** —`6000 SEDE AMAZONIA`,
`8000 SEDE CARIBE`— así que no había por dónde rebotar, y el guardia `len(opts) < 2`
devolvía `soc6 has 1 options, need at least 2`. Resultado: **14 planes de Amazonia y
Caribe sin catálogo**, otra vez destapado por el barrido de la fase 2, no por la API.

**Cómo se resuelve:** `soc6` no se rastrea. Se postea siempre, tal cual, y un no-op ahí
vuelve a ser lo que dice el §7 —un error de verdad—. `electivesTargets` acepta una sola
opción; lo que sigue siendo error es **cero** opciones, porque toda sede lista al menos
su propia entrada de sede y un dropdown vacío significa que el `soc10` anterior no cuajó.

Ojo con la tentación de contarlo al revés: la opción única de Amazonia **es** el comodín
`SEDE …` del §32, así que ese caso cae en la rama del comodín y hace **una** búsqueda,
no una por facultad.

`sia/cascade.go`: `FetchElectives`, `electivesTargets`. Verificado con
`TestElectivesTargets` y `TestLive_FetchElectives_SingleFacultySede` (dos planes de la
misma sede sobre una misma conexión, que es el caso para el que existía el rebote).

---

## 38. Los `_afrRK` de la unión de electivas no sirven para hacer clic

El §4 dice que un `_afrRK` solo vale para la respuesta de la que se leyó. El §35 añadió,
sin querer, una forma nueva de romperlo: donde no hay comodín de sede, el listado de
electivas es **una búsqueda por facultad**, y **cada cuerpo reinicia las claves en 0**.

Medido en `1101/2572` (DOCTORADO EN CIENCIAS AGROPECUARIAS), Bogotá doctorado:

```
body 0: 11 063 B    body 4: 73 073 B     rows unidas = 441
body 1: 64 340 B    body 5: 103 563 B    row 0 -> rk="0"
body 2: 392 807 B   ...                  row 1 -> rk="1"
body 3: 11 063 B    body 10: 11 085 B    row 2 -> rk="2"
```

`findRowInListings` unía los 11 cuerpos y buscaba el código ahí. La fila aparecía, pero su
clave pertenecía a la tabla de **otra** búsqueda: la única viva en el servidor es la de la
**última**. El clic caía en la fila que ocupara esa posición en la tabla equivocada, o en
ninguna, y la respuesta era `no detail region id in ~11960 byte response`.

**Lo que costó:** la corrida de `detail --scope=global` del 2026-08-18 (la primera que
lanzó el cron sola) hizo **68 861 POSTs para 1442 asignaturas — 47 POSTs por asignatura**
contra las ~3.7 medidas, con **1795 fallos** y 1340 planes sin visitar en 4 h. Cada
asignatura pagaba las 11 búsquedas y luego fallaba el clic. Los planes afectados son
exactamente los que no tienen listado regular: los doctorados, donde **todas** sus
asignaturas salen por la vía de electivas.

Ojo con el disfraz: el `circuit_breaker` **no** saltó, porque cuenta *unidades*
(programas) y un programa se da por bueno con que una sola asignatura pase. 38 programas
"OK" escondían 1795 asignaturas fallidas. `programs_ok` no es una medida de salud.

**Cómo se resuelve:** `eachElectivesSearch` recorre las búsquedas una por una y `FindElectiveRow`
**se detiene en la que trae el código**, dejando esa tabla como el render vivo. La unión
(`electiveRows`) sigue existiendo para el catálogo, que solo lee código, nombre y créditos
y nunca hace clic.

`sia/cascade.go`: `eachElectivesSearch`, `FindElectiveRow`. `sia/source.go`:
`findRowInListings`. Verificado con `TestLive_DetailOfAnElectiveOnlyCourse`.

---

## 39. El SIA se cae solo: CDATA cortado y redirect a `errorNavegacion.jsf`

Hay asignaturas cuyo detalle **rompe al servidor**. La respuesta llega truncada a media
sección CDATA y con un redirect pegado al final:

```
...<span id="pt1:r1:1:pgl3" class="row detass-creditos ...">Cr&eacute;ditos:<?xml version='1.0' encoding='UTF-8'?>
<partial-response id="j_id1"><redirect url="/Catalogo/facespublico/errorNavegacion.jsf?..."></redirect></partial-response>
```

Corta justo después de `Créditos:`. Medido 2026-08-18 en `2011302` y `2018602`, ambas de
Bogotá; **reproducible en una conexión recién creada**, así que es de la asignatura, no de
la sesión. Sin detectarlo, el síntoma era `XML syntax error: unexpected EOF in CDATA
section` y —peor— la conexión quedaba marcada en una región de detalle que no existe, con
lo que **las 40 asignaturas siguientes del mismo plan morían detrás**.

Dos cosas importan al tratarlo:

1. **La sesión queda muerta.** Todo POST posterior responde un re-render vacío. Hay que
   volver a hacer bootstrap sí o sí.
2. **Reintentar la asignatura no sirve.** Una sesión nueva entra a la misma página rota.
   Por eso `errSIAErrorPage` **no** está en `isRecoverable`: `FetchDetails` re-bootstrapea
   *sin* reintentar, y el resto del lote sobrevive.

Y una trampa dentro de la trampa: **una sesión caducada devuelve ese mismo redirect**,
pero en 412–877 B. Clasificar eso como "página rota" le quitaría el reintento que sí
merece (§7), y una sola sesión vencida se llevaría el lote entero. Por eso la detección
exige que el cuerpo **no** sea de tamaño no-op.

`sia/conn.go`: `post`. `sia/noop.go`: `isSIAErrorPage`, `errSIAErrorPage`.
`sia/source.go`: `FetchDetails`.

---

## 40. Un grupo puede no decir "Grupo" en absoluto

`groupHeaderRe` asumía que todo header de grupo contiene la palabra `Grupo`
literalmente — cierto en las 233 cabeceras que probaron el §24. Falso para
`2022615` (Alemán I, libre elección): su único grupo se llama **"(1) Aleman
Electivo 1"**, sin la palabra `Grupo` en ningún sitio.

```
CLASE TEORICA (2022615) (1) Aleman Electivo 1  Profesor: Paola Andrea Murillo
Serrano. Facultad: FACULTAD DE CIENCIAS HUMANAS ... Cupos disponibles: 23
```

Con el regex viejo esto parseaba **0 secciones** — idéntico en forma a una
asignatura sin oferta (§18), pero con un grupo real: profesor, horario, 23
cupos. Encontrado en vivo 2026-08-21, verificado contra producción con
`FindElectiveRow` + `FetchDetail` (página de 17.4 KB, no un no-op).

Arreglo en `parse_detail.go`: `groupHeaderRe` acepta como cierre de cabecera
`Grupo\s*\S+` **o**, si eso nunca aparece antes del siguiente bloque,
`Profesor:` (el ancla fija que todo grupo tiene). RE2 no tiene lookahead, así
que la rama de reserva se COME el `Profesor:` — el bucle en `ParseDetail` se
lo devuelve al body antes de parsearlo. `extractGroupKey` dejó de buscar
`Grupo` para ubicar la clave: toma el ÚLTIMO paréntesis del header, punto,
que es la misma regla de siempre y ahora no depende de la palabra.

Trampa dentro de la trampa: la rama `Profesor:` sin restricción cazaba
paréntesis que **no** son cabeceras — `(Presencial)` aparece a veces pegado
antes de `Profesor:` dentro del cuerpo de un grupo normal (ORIN-01/02 del
fixture PEAMA), y de puro parecido inflaba 32 grupos a 34. Por eso el primer
paréntesis del regex exige un dígito adentro (`\([^)\n]*\d[^)\n]*\)`): toda
clave real es numérica o tiene un dígito (`1`, `10`, `TUMA-01`, `2022615`);
`Presencial` no.

Fixture: `detalle_2022615_grupo_sin_palabra_grupo_2026-08-21.xml`. Test:
`TestParseDetail_GroupLabelWithoutGrupoWord`.
