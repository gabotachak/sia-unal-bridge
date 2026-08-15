# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

API puente en Go sobre el catálogo público de asignaturas del SIA (Universidad
Nacional de Colombia). El SIA solo expone el catálogo mediante una app Oracle ADF con
estado de sesión en servidor y navegación por POSTs de formulario encadenados. Este
proyecto traduce eso a JSON.

**Estado: sin código todavía.** Solo documentación. La ingeniería inversa del protocolo
está completa y verificada contra producción (2026-08-15).

## Convención de idioma

- **Código en inglés**: identificadores, tipos, columnas SQL, endpoints, comentarios.
- **Documentación en español.**
- Los literales del SIA se conservan tal cual (`Cupos disponibles:`,
  `LIBRE ELECCIÓN (L)`, `MIÉRCOLES de 09:00 a 11:00.`) — son datos, no texto nuestro.

## Antes de escribir código

Lee **`docs/GOTCHAS.md`** completo. No es opcional. Son 19 trampas verificadas contra
el servidor real, varias de las cuales fallan **en silencio** (devuelven datos
plausibles pero equivocados). El proyecto anterior murió por asumir mal cuatro de ellas.

Las tres que más código han roto:

1. **El User-Agent no puede parecer navegador.** Con un UA de Chrome el servidor
   devuelve 7 KB de bootstrap JS en vez de la página. El default de Go funciona; no lo
   "mejores".
2. **`_afrRK` se acumula entre búsquedas y se renumera en cada re-render.** Nunca
   enumeres posicionalmente, nunca caches la lista de row keys. Re-parsea siempre.
3. **Una respuesta de ~900 B no es un error HTTP, es un no-op.** Significa que falta un
   paso de la cascada, que estás en la región de detalle, o que caducó la sesión.
   Trátala como error explícito.

## Mapa del repo

| Ruta | Qué hay |
|---|---|
| `ARCH.md` | Arquitectura: puertos, read-through, pool de sesiones, alcance |
| `docs/PROTOCOL.md` | Handshake ADF completo con cuerpos de petición reales |
| `docs/FIELDS.md` | Componentes ADF, opciones de cada dropdown, mapeo a columnas |
| `docs/GOTCHAS.md` | Las 19 trampas |
| `docs/DATA-MODEL.md` | Esquema Postgres + structs de Go |
| `docs/OPEN-QUESTIONS.md` | Qué está verificado y qué no. Léelo antes de asumir |
| `docs/DEVELOPMENT.md` | Entorno: Docker, Postgres, cómo replicar el flujo |
| `bruno/sia-catalogo/` | Colección Bruno: 14 peticiones para ejecutar el flujo a mano |

## Arquitectura acordada

Hexagonal. Un puerto driving (`API`), dos driven (`Store` Postgres, `SIASource` ADF),
y un `Refresher` aplazado a fase 2.

Flujo principal: **read-through**. Si está en cache y fresco se sirve; si no, se
consulta al SIA, se responde al cliente y se persiste.

Dos caches con granularidad distinta — esto es lo que más se malentiende:

```
catálogo   → por PROGRAMA    1 POST trae ~98 asignaturas    casi inmutable
detalle    → por ASIGNATURA  1 POST trae 1 asignatura       volátil (cupos)
```

Un miss de catálogo llena el programa entero al mismo costo. El detalle es
irreductiblemente unitario: no hay forma de traer los grupos de varias asignaturas en
una petición.

## `SIASource` no es un cliente HTTP

Es un **pool de conexiones ADF con estado**. Cada conexión:

- muere a los 5 min de inactividad
- es **estrictamente secuencial**: una petición en vuelo a la vez
- está parqueada en un `(level, campus, faculty, program)`; moverla cuesta 2 POSTs
- está en la región del buscador **o** en la del detalle; salir cuesta 1 POST

N requests concurrentes ⇒ N conexiones. Fase 1: pool de 1-2 con mutex.

Los campos de estado (`parkedAt`, `inDetail`) son lo que ahorra POSTs: si la conexión
ya está donde toca, son 2 POSTs en vez de 6 (~1.3 s en vez de ~10 s).

## Modelado: tres cosas que no son obvias

- El listado devuelve **ofertas, no asignaturas**. Los códigos se repiten (hasta ×131).
  Clave natural `(code, term, number)`, nunca `code` solo. Pero las filas duplicadas
  **sí** se pueden dedupear: su detalle es byte-idéntico.
- **Los grupos visibles dependen del programa** (relación de subconjunto estricto);
  **los cupos son globales**. Por eso `section` es global y `section_program` es la
  tabla de visibilidad, y una sola medición de cupos sirve para todos los programas.
- `group` es **palabra reservada en SQL**. Se usa `section`. Ver la tabla de colisiones
  en `docs/DATA-MODEL.md`.

## Verificar contra el servidor

La colección Bruno (`bruno/sia-catalogo/`) ejecuta el flujo completo a mano. Úsala para
confirmar que el protocolo sigue vigente antes de depurar código propio — los IDs de
componente ADF (`pt1:r1:0:soc1`, etc.) son frágiles por diseño y pueden cambiar si la
UNAL repinta la página.

Si la colección funciona y tu código no, el problema es tuyo. Si la colección tampoco,
el SIA cambió y toca re-mapear con `docs/FIELDS.md`.
