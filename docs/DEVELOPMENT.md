# Entorno de desarrollo

Cómo montar el entorno para trabajar en este repo. Pensado para Linux con Docker.

> **Puertos y variables no se repiten acá.** La fuente de verdad es
> [`.env.example`](../.env.example), que es lo que `docker-compose.yml` lee. Los
> comandos de abajo usan los nombres de variable (`DB_PORT`, `API_PORT`), no números
> horneados: así siguen siendo correctos cuando alguien cambia un puerto.

---

## Requisitos

| Herramienta | Versión | Para qué |
|---|---|---|
| Go | ver `go 1.x` en [`go.mod`](../go.mod) | el servicio y el Job |
| Node | 22 | la interfaz (misma mayor que `web/Dockerfile`) |
| Docker + Compose | cualquiera reciente | Postgres, API e interfaz |
| Bruno | 1.x | ejecutar el flujo del SIA a mano |
| `curl` | — | pruebas rápidas contra el SIA |

Conexión a internet solo para tocar el SIA de verdad: el grueso del parser se prueba
contra los fixtures commiteados (ver [Fixtures](#fixtures)).

---

## Postgres local

El servicio `db` de [`docker-compose.yml`](../docker-compose.yml) lo levanta. Publica en
`127.0.0.1:${DB_PORT}` y el volumen usa el layout por versión mayor de Postgres 18+
(`/var/lib/postgresql`, no `.../data`).

```bash
cp .env.example .env
docker compose up -d db
psql "postgres://sia:sia@localhost:${DB_PORT:-15432}/sia_bridge"
```

### La base de test es OTRA base

`TEST_DATABASE_URL` apunta a `sia_bridge_test`, no a `sia_bridge`. No es una
formalidad: los tests de `internal/store` y `cmd/refresher` **escriben de verdad** —es el
tradeoff elegido frente a testcontainers ([LAYOUT.md](LAYOUT.md))— y apuntar las dos a la
misma base metió 28 planes de sedes inventadas (`999x`) dentro de producción, con
`/v1/status` reportando 1408 planes donde el censo real son 1380.

La crea `deploy/initdb/01-test-database.sql` en el primer arranque del contenedor `db`. Si
la base ya existía, a mano:

```bash
psql -h localhost -p "${DB_PORT:-15432}" -U sia -d postgres \
  -c 'CREATE DATABASE sia_bridge_test OWNER sia;'
make migrate-test        # y de nuevo tras cada migración nueva
```

---

## API en contenedor

El [`Dockerfile`](../Dockerfile) de la raíz (multi-stage: build en Go, runtime en
Alpine — las versiones exactas están ahí) y el servicio `api` de
[`docker-compose.yml`](../docker-compose.yml) levantan el puente completo:

```bash
make migrate                      # lee DATABASE_URL del .env
docker compose up -d --build api
curl "http://localhost:${API_PORT:-18080}/v1/healthz"
```

Las migraciones **no corren solas** — `api` no las aplica al arrancar. Correr `make
migrate` contra el `DB_PORT` mapeado en el host, antes o después de `docker compose up`.

`api` espera a que `db` esté `healthy` (`depends_on.condition: service_healthy`), no
solo arrancado.

El esquema y el porqué de cada decisión están en [DATA-MODEL.md](DATA-MODEL.md); el
esquema que de verdad corre es la suma de `migrations/`, que es lo que hay que mirar
cuando los dos discrepen.

### La interfaz

Dos formas, según qué estés tocando:

```bash
# Desarrollo: Vite recarga en caliente y proxea /v1 a la API (VITE_API_TARGET).
docker compose up -d db api
cd web && npm install && npm run dev      # → localhost:${VITE_DEV_PORT}

# Como en producción: nginx sobre los estáticos ya compilados.
docker compose up -d --build web          # → localhost:${WEB_PORT}
```

Las variables `VITE_*` se **hornean en el bundle** durante el build: no hay proceso que
las lea en caliente, así que cambiarlas pide `docker compose build web`, no un restart.
En el build de Docker el contexto es `./web`, donde el `.env` de la raíz no se ve — por
eso cada variable necesita su `ARG` en [`web/Dockerfile`](../web/Dockerfile) **y** su
entrada en `build.args` del compose. Olvidar ese paso deja dev y producción con valores
distintos sin que nada lo diga.

Qué dependencia hace qué y por qué no hay más: [`web/README.md`](../web/README.md).

### El Job (`refresher`)

Misma imagen, otro entrypoint, y bajo el perfil `jobs` para que `docker compose up` **no**
lo dispare — si arrancara con el stack, `restart` lo repetiría en bucle:

```bash
docker compose --profile jobs run --rm refresher --mode=reference
docker compose --profile jobs run --rm refresher --mode=catalog --workers=2 --max-duration=3h
docker compose --profile jobs run --rm refresher --mode=detail --scope=global --workers=2
docker compose --profile jobs run --rm refresher --mode=seats --scope=hot --workers=1

# Fuera de compose, contra la base del host:
DATABASE_URL=... go run ./cmd/refresher --mode=catalog --campus=1104 --max-duration=10m
```

`--campus` acota el barrido a una sede, que es la forma barata de probarlo: SEDE DE LA PAZ
(9 planes) o Palmira (27) en vez de Bogotá (505). En producción ya no corre por cron: es
una herramienta manual, y `REFRESH_ENABLED=false` la bloquea. Ver [FASE-2.md](FASE-2.md).

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

Viven en [`internal/sia/testdata/`](../internal/sia/testdata/) — respuestas reales del
SIA, capturadas contra producción y commiteadas. Cubren los listados, la cascada, el
bootstrap con tabla ajena, los no-ops y un detalle por cada forma rara que apareció. El
listado completo es un `ls`; lo que importa es la convención:

- **Cada fixture nombra el caso y la fecha** — `detalle_2027641_0grupos_2026-08-15.xml`.
  Una respuesta sintética lo dice en el nombre (`..._SYNTHETIC.xml`).
- **Casi siempre nacen de un bug real.** Cuando el SIA muestre una forma que el parser
  no esperaba, la fixture de esa página entra al repo junto al arreglo, con su sección
  en [GOTCHAS.md](GOTCHAS.md) y su test. Es el patrón de §40.
- **No se borran las viejas.** Sirven para detectar cuándo el SIA cambió de forma.

`.gitignore` excluye `/testdata/live/` y `*.har`: las capturas crudas pesan entre 50 KB
y 1 MB, y lo que se commitea es la respuesta mínima que reproduce el caso.

---

## Cuidado con el servidor

Es un catálogo público de una universidad, sin `robots.txt`. Aun así:

- **Un bootstrap por sesión**, jamás por request. Cuesta entre 0.15 s/52 KB y 7 s/4.5 MB,
  y no lo controlas ([GOTCHAS §25](GOTCHAS.md)).
- Reutiliza la conexión: cambiar de carrera son 2 POSTs, no 6.
- Usa `it11` cuando busques una asignatura concreta: medido 2026-08-17, 232 KB → 17.8 KB.
  El `Refresher` lo hace en los dos listados, y **limpia el campo** al terminar: se queda
  pegado en el formulario y recorta la siguiente búsqueda ([GOTCHAS §34](GOTCHAS.md)).
- El crawl completo con detalle son **30-40 h** (una carrera de 98 asignaturas = 201
  POSTs / 99 s / 31 MB). Ya es resumible: el `Refresher` usa los marcadores de frescura
  como checkpoint. El SIA aguantó hasta 80 conexiones en paralelo sin errores ni
  throttling (88 ya degrada, [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) §5), así que se
  puede paralelizar con moderación — respetando
  `conexiones(api) + conexiones(refresher) ≤ 80`. Los valores por defecto se quedan
  muy por debajo de eso; el tráfico real no lo pide.
- `REFRESH_RATE_POSTS_PER_SEC` es el techo de POSTs/s del Job, y la ventana
  nocturna es para el barrido pesado, no para los cupos.

Durante el desarrollo, trabaja contra fixtures y toca el servidor real solo para
verificar.

---

## Por dónde entrar al código

Ya no hay nada que arrancar de cero, pero el orden en que se construyó sigue siendo el
orden en que se entiende:

1. **Los parsers** (`internal/sia/parse_*.go`) — la parte con más trampas, y la única
   que se prueba entera sin red. Empezar por acá con `go test ./internal/sia/`.
2. **`SIAConn`** (`conn.go`, `cascade.go`) — bootstrap, cascada, búsqueda, detalle,
   Volver. Los campos de estado `parkedAt` y `detailRegion` son los que ahorran POSTs;
   `detailRegion` es un entero, no un bool: sube con cada detalle (GOTCHAS §20).
3. **El pool** (`pool.go`) — el mutex envuelve la **operación lógica** (cascada+`cb1`,
   detalle+`Volver`), no el POST. Partirlo reproduce el §28: dos peticiones a la vez
   sobre una conexión devuelven `200 OK` con la respuesta del otro hilo.
4. **`Store` y read-through** (`internal/store`, `internal/catalog`).
5. **La API HTTP** (`internal/httpapi`) y **el Job** (`internal/refresher`).

El paso 2 es donde muerden las trampas de `GOTCHAS.md`. Que los parsers estén probados
contra fixtures es lo que permite saber si un fallo está en la navegación o en el
parseo.
