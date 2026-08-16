# Entorno de desarrollo

Pensado para trabajar en Linux con Docker. Todavía no hay código: esto documenta el
entorno que hace falta montar.

---

## Requisitos

| Herramienta | Versión | Para qué |
|---|---|---|
| Go | 1.26.6 | el servicio |
| Docker + Compose | cualquiera reciente | Postgres local |
| Bruno | 1.x | ejecutar el flujo del SIA a mano |
| `curl` | — | pruebas rápidas contra el SIA |

Conexión a internet: el SIA solo responde desde fuera. No hay fixtures grabados en el
repo todavía (ver [Fixtures](#fixtures)).

---

## Postgres local

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:18.6-alpine
    environment:
      POSTGRES_USER: sia
      POSTGRES_PASSWORD: sia
      POSTGRES_DB: sia_bridge
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql   # 18+: layout por versión mayor, no .../data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sia"]
      interval: 5s
      retries: 10

volumes:
  pgdata:
```

```bash
docker compose up -d db
psql postgres://sia:sia@localhost:5432/sia_bridge
```

---

## API en contenedor

`Dockerfile` (multi-stage: `golang:1.26.6-alpine` build → `alpine:3.20` runtime) y el
servicio `api` en `docker-compose.yml` levantan el puente completo:

```bash
DATABASE_URL="postgres://sia:sia@localhost:5432/sia_bridge?sslmode=disable" make migrate
docker compose up -d --build
curl http://localhost:8080/v1/healthz
```

Las migraciones **no corren solas** — `api` no las aplica al arrancar. Correr `make
migrate` contra el puerto 5432 mapeado en el host antes de `docker compose up` (o
después; el schema no cambia entre versiones todavía).

`api` espera a que `db` esté `healthy` (`depends_on.condition: service_healthy`), no
solo arrancado.

El esquema está en [DATA-MODEL.md](DATA-MODEL.md). Cuando haya migraciones, van en
`migrations/`.

---

## Probar el protocolo a mano

Antes de depurar código propio, confirma que el SIA sigue igual.

### Con Bruno

Abre `bruno/sia-catalogo/` y selecciona el entorno **SIA**. Corre las peticiones en
orden (01 → 06 para el catálogo, 01 → 13 para electivas). Cada una imprime en consola
el número de filas y el rango de `_afrRK`.

Si una devuelve ~900 B, la consola te avisa: falta un paso, estás en la región de
detalle, o caducó la sesión.

### Con curl

Lo mínimo para ver que responde:

```bash
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' \
  -A 'sia-bridge/dev' \
  'https://sia.unal.edu.co/Catalogo/facespublico/public/servicioPublico.jsf?taskflowId=task-flow-AC_CatalogoAsignaturas'
```

Esperado: `200` y ~1 MB. Si son ~7000 bytes, tu UA parece de navegador — ver
[GOTCHAS.md §1](GOTCHAS.md).

Extraer el ViewState:

```bash
curl -sS -A 'sia-bridge/dev' '<url de arriba>' \
  | grep -o 'javax.faces.ViewState" value="[^"]*"'
```

---

## Fixtures

**No hay ninguno commiteado todavía.** `.gitignore` excluye `/testdata/live/` y `*.har`
porque las respuestas del SIA pesan entre 50 KB y 1 MB.

Cuando haya parser, conviene guardar un juego mínimo y sanitizado:

| Fixture | Para probar |
|---|---|
| listado de una carrera (~98 filas) | parser de tabla, dedupe, `_afrRK` |
| listado de electivas (~240 filas) | duplicados, comodín de sede |
| detalle con varios grupos | parser de grupos, horarios, cupos |
| detalle con 0 grupos (`2027641`) | asignatura sin oferta |
| grupo sin horario (`Horarios/Aula: No informado`) | `section` sin `class_session` |
| respuesta de ~900 B | detección de no-op |
| respuesta de sesión caducada | detección de timeout |

Fecharlos (`listado_2026-08-15.xml`) y no borrar los viejos: sirven para detectar
cuándo el SIA cambió de forma.

---

## Cuidado con el servidor

Es un catálogo público de una universidad, sin `robots.txt`. Aun así:

- **Un bootstrap por sesión**, jamás por request. Cuesta entre 0.15 s/52 KB y 7 s/4.5 MB,
  y no lo controlas ([GOTCHAS §25](GOTCHAS.md)).
- Reutiliza la conexión: cambiar de carrera son 2 POSTs, no 6.
- Usa `it11` cuando busques una asignatura concreta: 241 KB → 15 KB.
- El crawl completo con detalle son **30-40 h** (una carrera de 98 asignaturas = 201
  POSTs / 99 s / 31 MB). Hazlo resumible. El SIA aguantó 8 conexiones en paralelo sin
  errores ni throttling, así que se puede paralelizar con moderación
  ([OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)).

Durante el desarrollo, trabaja contra fixtures y toca el servidor real solo para
verificar.

---

## Orden sugerido para arrancar

1. Esquema y migraciones (`DATA-MODEL.md`).
2. Parser del listado, contra un fixture guardado a mano con Bruno. Es la parte con más
   trampas y no necesita red.
3. Parser del detalle (grupos, horarios, cupos).
4. `SIAConn`: bootstrap, cascada, búsqueda, detalle, Volver. Con los campos de estado
   `parkedAt` y `detailRegion` desde el principio — son los que ahorran POSTs.
   `detailRegion` es un entero, no un bool: sube con cada detalle (GOTCHAS §20).
5. Pool de 4 conexiones. El mutex envuelve la **operación lógica** (cascada+`cb1`,
   detalle+`Volver`), no el POST: partirlo reproduce el §28 — dos peticiones a la vez
   sobre una conexión devuelven `200 OK` con la respuesta del otro hilo.
6. `Store` y read-through.
7. API HTTP.

El paso 4 es donde muerden las trampas de `GOTCHAS.md`. Tener los pasos 2 y 3 ya
probados contra fixtures hace que sea mucho más fácil saber si el problema está en la
navegación o en el parseo.
