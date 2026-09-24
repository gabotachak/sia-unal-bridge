# Comandos

Chuleta de comandos del día a día — deploy, migraciones, ver qué versión corre
dónde, y cómo tirar todo abajo si hace falta. Para el *por qué* de cada pieza ver
[`internal/PLAN-CI-CD.md`](internal/PLAN-CI-CD.md) (deploy) y [`ARCH.md`](ARCH.md) (arquitectura).
Todo asume que estás parado en la raíz del repo, en el server (o en local con
`docker compose` — es el mismo compose para los dos).

**El checkout del server siempre tiene que estar en `main`** — el deploy hace
`git pull` a secas, sin especificar rama. Si necesitás mirar otra rama ahí, usar
`git worktree add ../otra-carpeta esa-rama`, nunca `git checkout` sobre este path.

---

## Qué versión está corriendo en cada contenedor

`api` y `web` llevan el tag semver y el commit horneados en la imagen (`LABEL`,
ver `Dockerfile` / `web/Dockerfile`) — sobreviven aunque el proceso esté caído,
porque no dependen de que la app conteste.

```bash
for s in api web; do
  printf '%-4s ' "$s"
  docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}} ({{index .Config.Labels "org.opencontainers.image.revision"}})' sia-unal-bridge-${s}-1
done
```

`api` además lo expone en caliente, sin necesidad de `docker inspect`:

```bash
curl -s https://sia-api.gabotachak.dev/v1/version
# {"version":"v1.2.0","commit":"a1b2c3d"}
```

`db` no es código nuestro — su "versión" es el tag de la imagen de Postgres,
fijado en `docker-compose.yml`:

```bash
docker inspect -f '{{.Config.Image}}' sia-unal-bridge-db-1
```

`job` (refresher): todavía no existe como servicio (`docs/FASE-2.md`, sin
implementar). Cuando lo esté, va a llevar el mismo `LABEL` que `api` — mismo
comando, cambiando el nombre del contenedor.

Ojo: como el deploy reconstruye servicios por separado (`--no-deps`, ver
`internal/PLAN-CI-CD.md`), `api` y `web` pueden estar en versiones distintas entre sí en
cualquier momento — es normal, no un bug.

---

## Levantar todo

```bash
docker compose up -d
```

Primera vez: copiar `.env.example` a `.env`, completar `PGDATA_DIR` y crear esa
carpeta a mano (bind mount, `docker compose up` no la crea sola).

Un solo servicio (por ejemplo tras cambiar su código a mano):

```bash
docker compose build api && docker compose up -d --no-deps api
```

`--no-deps` es a propósito — sin eso, compose reinicia también `db` si detecta
que su config "cambió" (`internal/PLAN-CI-CD.md`, sección Riesgos).

## Logs

```bash
docker compose logs -f api          # un servicio, en vivo
docker compose logs --tail=200 web  # las últimas 200 líneas, sin seguir
```

## Migraciones

```bash
make migrate        # aplica lo que falte
make migrate-down    # revierte la última
```

Corre en el HOST, no en un contenedor — usa `DATABASE_URL` del `.env` (sección 4,
apunta a `localhost:$DB_PORT`, no al hostname interno `db`). El `Makefile` ya
carga `.env` solo (`-include .env` + `export`), no hace falta `source` a mano.

## Deploy manual (sin esperar el pipeline)

Lo mismo que hace `.github/workflows/deploy.yml`, a mano — útil si Actions está
caído o para un hotfix que no puede esperar un PR:

```bash
git pull
export GIT_TAG=$(git describe --tags --always)
export GIT_SHA=$(git rev-parse --short HEAD)
make migrate                                              # si tocaste migrations/
docker compose build api && docker compose up -d --no-deps api    # si tocaste internal/, cmd/bridge/, Dockerfile
docker compose build web && docker compose up -d --no-deps web    # si tocaste web/
curl -f https://sia-api.gabotachak.dev/v1/healthz
```

Sin `GIT_TAG`/`GIT_SHA` exportados, la imagen queda etiquetada `dev`/`unknown` —
no es un error, es la señal de que no pasó por el pipeline versionado.

## Reiniciar un servicio sin rebuildear

```bash
docker compose restart api
```

## Parar todo (sin borrar nada)

```bash
docker compose stop
```

Contenedores quedan creados pero apagados; `docker compose up -d` los levanta
de nuevo tal cual estaban, imágenes y volúmenes intactos.

## Borrar — por partes

```bash
docker compose down                 # contenedores + red, imágenes y volúmenes quedan
docker compose down --rmi local     # + imágenes que este compose construyó (api, web)
docker compose down -v              # + volúmenes anónimos (NO el bind mount de PGDATA_DIR)
```

`PGDATA_DIR` es bind mount a una carpeta del host — ningún `docker compose down`
la toca, se borra a mano (`rm -rf`) si de verdad se quiere perder la base.

## Borrar todo, de una

**Destructivo — pensarlo dos veces, no hay vuelta atrás.**

```bash
docker compose down --rmi local -v
rm -rf "$PGDATA_DIR"   # solo si además querés perder los datos de Postgres
```

## Diagnóstico rápido

```bash
docker compose ps                 # qué está arriba, qué se cayó
docker compose config             # valida el compose + interpolación de .env
docker compose exec api sh        # shell dentro del contenedor de la API
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```
