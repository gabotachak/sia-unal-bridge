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
   JSON limpio    │  → parseo de tabla ADF                │   XML + HTML en CDATA
  <───────────────│                                      │<──────────────────────────
                  └──────────────────────────────────────┘        SIA (Oracle ADF)
```

## Estado

Arrancando. La fase de ingeniería inversa del protocolo está **completa y verificada
contra el servidor en producción** (2026-08-15). Ver `docs/`.

## Documentación

| Documento | Contenido |
|---|---|
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Handshake completo, paso a paso, con cuerpos de petición reales |
| [docs/FIELDS.md](docs/FIELDS.md) | Mapa de componentes ADF y opciones de cada dropdown |
| [docs/GOTCHAS.md](docs/GOTCHAS.md) | Trampas verificadas. **Léelo antes de escribir código.** |
| [bruno/](bruno/) | Colección Bruno para ejecutar el flujo a mano |

## Datos disponibles

**Listado** (una consulta devuelve todas las asignaturas del filtro):

- código, nombre, créditos, tipología, descripción (programa completo)

**Detalle** (por asignatura, requiere 3 POSTs extra):

- grupos, profesor por grupo, **cupos disponibles**, horarios (día + hora),
  aula y edificio, jornada, duración, fechas del periodo

## Fuente

```
https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf
    ?taskflowId=task-flow-AC_CatalogoAsignaturas
```

Catálogo público, sin autenticación. No hay `robots.txt` (404).
