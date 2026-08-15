# Trampas verificadas

Cada punto aquí fue comprobado contra el servidor de producción el **2026-08-15**.
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

**Contraintuitivo:** intentar "parecer navegador" para pasar desapercibido es
exactamente lo que rompe el scraper. Deja que Go mande su `Go-http-client/2.0`.

---

## 2. `Adf-Window-Id` es la constante `winnoloop`

Al saltarte el loopback, ADF asigna ese id fijo. No hay que extraerlo ni generarlo.

---

## 3. El ViewState NO rota

`docs/QUIRKS.md` del proyecto anterior afirmaba que Oracle ADF rota el
`javax.faces.ViewState` tras cada POST, y sobre esa premisa montó toda su arquitectura
de resincronización de estado.

Es falso. Verificado: el mismo token `!-5pdrpr5se` en los 8 pasos de una sesión
completa. El estado vive en el servidor indexado por cookie; el token solo apunta.

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
en la segunda — que es el patrón normal (`set_career` → `scrape` → `set_career`).

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
esperabas datos, te falta un paso de la cascada o expiró la sesión.

---

## 7. La sesión expira a los 5 minutos

`AdfPage.PAGE.__initializeSessionTimeoutTimer(300000, 120000, ...)`

Se renueva con cada petición, así que un scraper activo la mantiene viva sola.
Si algo devuelve ~900 B inesperadamente, prueba re-bootstrap.

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

## 9. La selección previa al click es obligatoria

El POST de `selection` devuelve ~900 B sin contenido y parece un fallo. No lo es:
sin él, el click al link también devuelve vacío.

---

## 10. Hay que "Volver" entre cursos

Tras ver un detalle quedas en la región 1. Un segundo click al link de otra fila
devuelve 893 B. Sal con `pt1:r1:1:cb4` antes de pedir el siguiente.

---

## 11. `DELTAS` es opcional

El HAR de navegador de las electivas **no manda `oracle.adf.view.rich.DELTAS` en
ningún paso**, ni siquiera en el `cb1` final, y devuelve las 240 filas igual.

Sí hace falta para el detalle, donde transporta `selectedRowKeys`.

---

## 12. `Adf-Page-Id` y `Adf-Ads-Page-Id` no se validan

Observados funcionando: `Adf-Page-Id` = 0, 1, 2, 9 · `Adf-Ads-Page-Id` = 1, 3, 11.
Manda cualquier cosa consistente.

---

## 13. Los códigos de asignatura se repiten

Cada fila es una **oferta**, no una asignatura:

```
libre elección Bogotá:  215 códigos únicos en 240 filas
consulta malformada:    266 códigos únicos en 1000 filas
                        1000008-M ×131 · 1000009-B ×83 · 1000012-B ×72
```

Nunca uses el código como clave primaria. Perderías la mayoría de los datos.

---

## 14. Posible tope de 1000 filas (sin confirmar)

En una consulta malformada vi `_rowCount="2114"` con exactamente **1000 filas**
devueltas — número sospechosamente igual al `fetchSize: 1000` que declara el
componente `AdfRichTable`.

No pude confirmarlo: `_rowCount` no es fiable (ver #5) y `startRow`/`rows` en `DELTAS`
no tuvieron ningún efecto. Con consultas bien formadas (98, 240 filas) nunca se alcanza.

**Pendiente de verificar** si alguna consulta legítima supera las 1000 filas.

---

## 15. Bug del proyecto anterior: `soc6 = sede + 40`

`ELECTIVES_CAMPUS_INCREMENT = 40` → para sede=2 calculaba `soc6=42`.

El dropdown solo tiene opciones **0..12**. Es un índice posicional en una lista de 13,
no una fórmula aritmética. El flujo de electivas de ese proyecto estaba roto.

---

## Resumen para el diseño en Go

```go
// 1. Un UA que no parezca navegador (el default de Go sirve)
// 2. Adf-Window-Id = "winnoloop" constante
// 3. cookiejar obligatorio, ViewState de la misma sesión
// 4. Re-parsear _afrRK antes de CADA uso. Nunca cachear.
// 5. Contar los <tr>, ignorar _rowCount
// 6. Respuesta de ~900 B = paso faltante o sesión caducada
// 7. Un bootstrap por sesión, no por carrera
// 8. Clave primaria = (código, grupo), nunca código solo
```
