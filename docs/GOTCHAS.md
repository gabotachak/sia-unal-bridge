# Trampas verificadas

Cada punto fue comprobado contra el servidor de producción el **2026-08-15**.
Varios contradicen lo que asumía el proyecto anterior (`BetterCampus/sia-scraper`).

Léelo antes de escribir código.

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

## 5. `_rowCount` está stale

```
Búsqueda 1:  _rowCount="98"   filas reales = 98
Búsqueda 2:  _rowCount="98"   filas reales = 71
Búsqueda 3:  _rowCount="98"   filas reales = 57
```

Conserva el valor de la primera búsqueda de la sesión. **Cuenta los `<tr>`.**

---

## 6. Sin cascada completa, el botón es un no-op silencioso

| Intento | Respuesta |
|---|---|
| Todo vacío, click directo a `cb1` | 896 B, cero filas |
| Solo `soc1=0` | 896 B, cero filas |
| `soc1=0` + `soc9=2`, sin facultad/carrera | 896 B, cero filas |
| Electivas sin disparar `soc10` antes de `soc6` | basura: keys duplicados |

Ni error, ni mensaje de validación. Solo no hace nada. Si recibes ~900 B donde
esperabas datos: falta un paso, o estás en la región 1 (§10), o expiró la sesión.

---

## 7. La sesión expira a los 5 minutos

`AdfPage.PAGE.__initializeSessionTimeoutTimer(300000, 120000, ...)`

Se renueva con cada petición, así que un scraper activo la mantiene viva sola.

Respuesta típica de sesión caducada:

```
Because of inactivity, your session has timed out and is no longer active.
```

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

La sesión está en `pt1:r1:0` (buscador+tabla) o en `pt1:r1:1` (detalle).

Tras abrir un detalle quedas en la región 1. Verificado limpio: desde ahí, tanto una
**búsqueda nueva** como el **detalle de otra asignatura** devuelven ~895 B.

No es solo "entre detalles": es antes de cualquier cosa en la región 0.
Tu pool tiene que llevar ese estado por sesión.

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

## 14. Posible tope de 1000 filas (sin confirmar)

En una consulta malformada vi `_rowCount="2114"` con exactamente **1000 filas**
devueltas — igual al `fetchSize: 1000` que declara el `AdfRichTable`.

No pude confirmarlo: `_rowCount` no es fiable (§5) y `startRow`/`rows` en `DELTAS` no
tuvieron efecto. Con consultas bien formadas (98, 240 filas) nunca se alcanza.

**Pendiente de verificar.**

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

**No confirmado** que la tipología varíe entre carreras: `1000004-B` es
`FUND. OPTATIVA` tanto en Sistemas como en Industrial, y las 6 asignaturas de cálculo
salieron iguales en ambos listados. Aun así vive en `course_program`, porque revertirlo
después es trivial y al revés no.

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

## Resumen para el diseño en Go

```go
// 1. UA que no parezca navegador (el default de Go sirve)
// 2. Adf-Window-Id = "winnoloop" constante
// 3. cookiejar obligatorio; ViewState de la misma sesión
// 4. Re-parsear _afrRK antes de CADA uso. Nunca cachear.
// 5. Contar los <tr>; ignorar _rowCount
// 6. Respuesta de ~900 B = paso faltante, región 1, o sesión caducada
// 7. Llevar el estado (parkedAt, inDetail) por conexión
// 8. Un bootstrap por sesión, no por carrera
// 9. Dedupear el listado por código
// 10. Clave natural de oferta: (code, term, number)
```
