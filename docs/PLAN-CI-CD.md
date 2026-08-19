# Plan de CI/CD — deploy automático al mergear a main

Cómo un merge a `main` termina en `git pull` + rebuild selectivo en
`gabotachak.dev`, sin build en el runner ni registry — un solo server, push-deploy por
SSH alcanza. Mismo formato que [`PLAN-PRODUCTION.md`](PLAN-PRODUCTION.md): pasos con
criterio de aceptación, marcados con quién lo ejecuta.

- **[YO]** — en este repo, vía diff.
- **[VOS]** — manual (GitHub Secrets, server).

---

## Punto de partida

`docker-compose.yml` ya define los servicios; no hay build en CI, el server hace el
build local igual que hoy a mano. `robot` ya está en el grupo `docker` (sin sudo para
`docker compose`).

| Componente | Dispara con cambios en | Acción en el server |
|---|---|---|
| api | `internal/**`, `cmd/bridge/**`, `Dockerfile` | `docker compose build api && docker compose up -d --no-deps api` |
| web | `web/**` | `docker compose build web && docker compose up -d --no-deps web` |
| job (refresher) | `cmd/refresher/**`, `internal/refresher/**` | `docker compose --profile jobs build refresher` (sin restart — cron usa la imagen nueva en su próxima corrida) |
| db | `migrations/**` | `make migrate`, **antes** que api |

---

## Fase 0 — key SSH solo-para-deploy · **[VOS]**, en el server

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gh-deploy -N ""
cat ~/.ssh/gh-deploy.pub >> ~/.ssh/authorized_keys
```

Key separada de la personal — así se puede revocar sin tocar tu acceso.

**Criterio de aceptación:** `ssh -i ~/.ssh/gh-deploy robot@<host> docker ps` conecta sin
password y sin sudo.

---

## Fase 1 — secrets en GitHub · **[VOS]**

Repo → Settings → Secrets and variables → Actions:

| Secret | Valor |
|---|---|
| `SSH_HOST` | IP o dominio del server |
| `SSH_USER` | `robot` |
| `SSH_PRIVATE_KEY` | contenido de `~/.ssh/gh-deploy` (privada) |
| `SSH_PORT` | solo si no es 22 |

**Criterio de aceptación:** los 3-4 secrets listados en la UI (valores ocultos).

---

## Fase 2 — versión semver automática · **[YO]**

`semantic-release` (`cycjimmy/semantic-release-action`), primer step del mismo
workflow, antes del deploy. Lee los commits desde el último tag, calcula el bump
(`feat:` → minor, `fix:` → patch, `BREAKING CHANGE:` → major) y en un solo paso:

- crea el tag `vX.Y.Z` sobre el commit de merge a `main`
- publica un GitHub Release con changelog generado de los mensajes de commit
- no toca npm/registry — plugins `commit-analyzer`, `release-notes-generator`, `github`
  únicamente; el proyecto sigue siendo Go, `semantic-release` corre standalone en el
  runner

Requiere **Conventional Commits** en los mensajes que llegan a `main` (`feat:`,
`fix:`, `refactor:`, etc.) — sin eso no hay bump que calcular. `contents: write` en
los permisos del job (para pushear el tag y crear el Release); usa el
`GITHUB_TOKEN` default, no hace falta secret nuevo.

**Criterio de aceptación:** un PR con `fix:` en el mensaje de merge produce, al
mergear, un Release nuevo (`vX.Y.Z+1` en patch) visible en la pestaña Releases del
repo — antes de que corra el deploy.

---

## Fase 3 — workflow de deploy · **[YO]**

`.github/workflows/deploy.yml`, `on: push: branches: [main]`.

1. `dorny/paths-filter` para los 4 grupos de la tabla de arriba.
2. Un step SSH (`appleboy/ssh-action`) que corre, en orden:
   ```bash
   cd /ruta/al/repo && git pull
   # si migrations cambió:
   make migrate
   # si api cambió:
   docker compose build api && docker compose up -d --no-deps api
   # si web cambió:
   docker compose build web && docker compose up -d --no-deps web
   # si refresher cambió:
   docker compose --profile jobs build refresher
   ```
3. Step final: `curl -f https://sia-api.gabotachak.dev/v1/healthz` — si falla, el
   workflow queda en rojo y avisa (no hay rollback automático, ver Riesgos).

**Criterio de aceptación:** `docker compose config` no rompe en el server con el
archivo tal cual quedó; el workflow parsea (`act` local o simple `yamllint`).

---

## Fase 4 — prueba controlada antes de tocar main · **[VOS]**

Cambiar temporalmente el trigger a `pull_request` en una rama de prueba, abrir un PR
descartable, mirar el log de Actions: ¿conecta por SSH?, ¿corre los comandos
correctos según qué tocó el PR? Sacar el trigger de prueba antes de mergear el
workflow real.

**Criterio de aceptación:** corrida verde en Actions contra el server real, sin
tocar `main`.

---

## Fase 5 — operación

Merge a `main` dispara el deploy real. Mirar la corrida en Actions; si el healthz
final falla, entrar por SSH y diagnosticar a mano (`docker compose logs api`) — no
hay revert automático.

**Criterio de aceptación:** `curl https://sia-api.gabotachak.dev/v1/healthz` y
`curl https://sia.gabotachak.dev/` en 200 después del merge, sin tocar el server a
mano.

---

## Riesgos / lo que puede fallar en silencio

- **Migración con `api` ya corriendo la versión vieja del código.** Si `migrations/`
  y `internal/**` cambian en el mismo PR, el orden migración-antes-que-api del
  workflow no es opcional: al revés, la api vieja puede fallar contra el schema
  nuevo entre un paso y el otro.
- **`SIA_POOL_SIZE` + `REFRESH_POOL_SIZE` ≤ 8.** Un rebuild de `api` no lo cambia,
  pero si el PR toca `.env` en el server a mano fuera de este flujo, el CI no se
  entera — el `.env` del server no vive en git.
  y no se toca desde CI en este plan.
- **`--no-deps` es a propósito.** Sin eso, `docker compose up -d api` reinicia
  también `db` si compose decide que su config "cambió" — con `--no-deps` solo el
  servicio tocado se reinicia.
- **Sin rollback automático.** Si el healthz final falla, el server queda con el
  código nuevo corriendo mal hasta que alguien entre a mano. Aceptable para un solo
  usuario/proyecto; si esto crece, el siguiente paso natural es un `docker compose
  up -d --no-deps <servicio>` con la imagen anterior taggeada, no algo más.
- **Key comprometida.** Con acceso a `docker compose` sin sudo, el radio de daño es
  los contenedores de este proyecto, no el server entero — pero igual revocarla
  (borrar la línea de `authorized_keys`) si el repo o el secret se filtra.
- **El checkout del server tiene que estar siempre parado en `main`.** El script
  del workflow hace `git pull` a secas, sin `git checkout main` antes — tira de la
  rama que esté activa en ese momento, no de `main` por nombre. Si alguien cambia
  de rama ahí para debuggear (`git checkout otra-cosa`) y se olvida de volver, el
  próximo deploy hace pull de la rama equivocada **sin error visible** — mismo
  no-op silencioso que las otras trampas de este proyecto. Para tocar otra rama en
  ese server, usar `git worktree add` en otra carpeta, nunca `git checkout` sobre
  este mismo path.
- **El login shell de `robot` es fish, no bash.** SSH ejecuta el `script:` con el
  login shell del usuario — en fish, `set -e` no es errexit, se interpreta como
  `set --erase` sin argumento: esa línea falla pero **el resto del script sigue
  corriendo igual**, sin fail-fast. Verificado: `ssh ... 'set -e; false; echo
  esto-se-imprime'` imprime "esto-se-imprime". El fix es forzar `bash -c '...'`
  como wrapper de todo el script (ver `deploy.yml`) — sin eso, un `git pull` o
  `make migrate` que falla no frena el `docker compose build` siguiente.
