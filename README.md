# sia-unal-bridge

API JSON sobre el catálogo público de asignaturas del **SIA** (Sistema de Información
Académica, Universidad Nacional de Colombia).

El SIA expone su catálogo únicamente a través de una aplicación Oracle ADF con estado
de sesión en servidor, navegación por POSTs de formulario encadenados y respuestas en
XML con HTML incrustado. No existe API pública.

Este proyecto traduce esa complejidad a JSON.

```
                  ┌──────────────────────────────────────┐
   GET /courses   │  sia-unal-bridge                     │   POST servicioPublico.jsf
  ───────────────>│  bootstrap → cascada → consulta       │──────────────────────────>
   JSON limpio    │  → parseo de tabla ADF → Postgres     │   XML + HTML en CDATA
  <───────────────│                                      │<──────────────────────────
                  └──────────────────────────────────────┘        SIA (Oracle ADF)
```

## Estado

Arrancando. La ingeniería inversa del protocolo está **completa y verificada contra el
servidor en producción** (2026-08-15). Sin código todavía.

## Documentación

| Documento | Contenido |
|---|---|
| [ARCH.md](ARCH.md) | Arquitectura: puertos, flujo read-through, pool de sesiones, alcance |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Esquema Postgres, structs de Go, casos borde |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Handshake completo con cuerpos de petición reales |
| [docs/FIELDS.md](docs/FIELDS.md) | Componentes ADF y opciones de cada dropdown |
| [docs/GOTCHAS.md](docs/GOTCHAS.md) | 19 trampas verificadas. **Léelo antes de codear.** |
| [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | Qué está probado y qué no. Experimentos pendientes |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Entorno con Docker, fixtures, orden sugerido para arrancar |
| [bruno/](bruno/sia-catalogo/) | Colección Bruno para ejecutar el flujo a mano |

Empezando de cero: [DEVELOPMENT.md](docs/DEVELOPMENT.md) para montar el entorno,
[GOTCHAS.md](docs/GOTCHAS.md) antes de escribir la primera línea.

## Convención de idioma

**Código en inglés** — identificadores, tipos, columnas, endpoints, comentarios.
**Documentación en español.**

Los literales que vienen del SIA se conservan tal cual (`Cupos disponibles:`,
`LIBRE ELECCIÓN (L)`, `MIÉRCOLES de 09:00 a 11:00.`): son datos, no texto nuestro.

## Datos disponibles

**Catálogo** — una consulta devuelve todas las asignaturas del filtro (~98 por carrera):

- código, nombre, créditos, tipología, descripción (programa completo)

**Detalle** — una consulta por asignatura:

- grupos, profesor, **cupos disponibles**, horarios (día + hora), aula y edificio,
  jornada, duración, fechas del periodo

Dos advertencias que salen de los datos reales:

- El listado devuelve **ofertas, no asignaturas**: los códigos se repiten. Clave
  natural `(code, term, number)`.
- El conjunto de grupos visibles **depende de la carrera** desde la que consultas.
  Los cupos, en cambio, son globales.

## Fuente

```
https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf
    ?taskflowId=task-flow-AC_CatalogoAsignaturas
```

Catálogo público, sin autenticación. No hay `robots.txt` (404).
