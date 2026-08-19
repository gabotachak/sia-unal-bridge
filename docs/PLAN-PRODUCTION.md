# Plan de puesta en producción

Cómo `sia-unal-bridge` pasa de correr en localhost a vivir en `gabotachak.dev`, en el
servidor de un tercero (el "amigo dueño del server") detrás de su Caddy compartido.

Mismo formato que [`PLAN.md`](PLAN.md): pasos con criterio de aceptación. Cada paso
está marcado con quién lo ejecuta:

- **[YO]** — lo hago en este repo, ya aplicado o listo para revisar en el diff.
- **[VOS]** — acción manual tuya (Cloudflare, mandarle cosas al amigo).
- **[AMIGO]** — acción manual del dueño del server (su Caddyfile, su firewall).

---

## Punto de partida

Tres servicios en `docker-compose.yml`, puertos ya fijados en `.env` — no hay que
inventar nada nuevo, el amigo solo necesita saber cuáles:

| Servicio | Puerto host actual | Bind | Dominio destino |
|---|---|---|---|
| `api` | `18080` | `0.0.0.0` (todas las interfaces) | `sia-api.gabotachak.dev` |
| `web` | `13000` | `0.0.0.0` | `sia.gabotachak.dev` |
| `db` | `15432` | **`127.0.0.1` solo** | ninguno — ver decisión abajo |
| `refresher` | — | no escucha nada | ninguno — es un job de cron, ver abajo |

---

## Decisión: la DB no sale a internet

El propio `docker-compose.yml` ya lo dice en comentario (línea 8-9): sin el prefijo
`127.0.0.1:`, Docker abre el puerto en **todas** las interfaces y se salta las reglas
de `iptables` del host. Ese bind a loopback es una decisión de seguridad ya tomada, no
un descuido.

Exponer Postgres en `sia-db.gabotachak.dev:puerto` la revertiría — y
además no calza con lo que pidió el amigo: Caddy hace *reverse proxy HTTP*, el
protocolo de Postgres no es HTTP, así que "poner un dominio en el Caddyfile" no aplica
igual para la DB que para API/FRONT. Necesitaría el módulo `layer4` de Caddy (no
estándar) o un forward TCP crudo sin TLS.

**Decisión: sin dominio de DB.** Si en algún momento hace falta conectarse a la DB de
producción desde tu máquina, se hace por túnel SSH:

```bash
ssh -L 15432:localhost:15432 usuario@servidor-del-amigo
# y en otra terminal, contra localhost:15432 como si fuera local
```

Nunca abre el puerto al mundo, no depende de nada del amigo salvo tu acceso SSH normal.

---

## Fase 0 — repo

### Paso 1 · Restart policy en compose · **[YO]**

`docker-compose.yml` no tenía `restart:` en ningún servicio — si el server del amigo
reinicia o un contenedor muere, se queda caído hasta que alguien lo note. Se agregó
`restart: unless-stopped` a `db`, `api` y `web`.

**Criterio de aceptación:** `docker compose config` no rompe; los tres servicios
muestran la policy.

### Paso 2 · Caddyfile listo para mandarle al amigo · **[YO]**

Archivo `deploy/Caddyfile.gabotachak` con los dos bloques (`sia-api.gabotachak.dev` y
`sia.gabotachak.dev`) apuntando a `localhost:18080` y `localhost:13000`. Se lo pasás
tal cual — o él lo adapta a como tenga organizado su Caddyfile compartido.

**Criterio de aceptación:** el archivo existe, sintaxis Caddy válida, dominios y
puertos coinciden con la tabla de arriba.

---

## Fase 1 — Cloudflare · **[VOS]**, manual

1. En el dashboard de Cloudflare, zona `gabotachak.dev` → DNS → agregar dos registros:

   | Tipo | Nombre | Contenido | Proxy status |
   |---|---|---|---|
   | A | `sia-api` | IP pública del server del amigo | **DNS only** (nube gris) al principio |
   | A | `sia` | misma IP | **DNS only** (nube gris) al principio |

   Nube gris primero: así Caddy puede emitir el certificado Let's Encrypt vía HTTP-01
   sin que Cloudflare se interponga. Una vez el sitio responde con HTTPS válido, podés
   pasar cualquiera de los dos (o ambos) a **Proxied** (nube naranja) si querés el CDN
   y la protección DDoS de Cloudflare — no rompe nada, Caddy sigue funcionando detrás.

2. Si el amigo ya tiene otros dominios de él pasando por Cloudflare proxied con
   certificado por DNS-01 (token de API de Cloudflare en su Caddy), preguntale si
   prefiere ese patrón en vez del punto 1 — puede que ya tenga la automatización
   corriendo y sea menos fricción sumarse a eso que abrir la excepción HTTP-01.

**Criterio de aceptación:** `dig sia-api.gabotachak.dev` y `dig sia.gabotachak.dev`
resuelven a la IP del server.

---

## Fase 2 — servidor del amigo

Ya corriendo acá (verificado 2026-08-16): `docker compose ps` levantado, puertos
`18080`/`13000`/`15432` escuchando, `127.0.0.1:15432` respeta el bind a loopback,
`localhost:18080/v1/healthz` y `localhost:13000/` responden `200`. Nada que desplegar.

Falta solo el Caddyfile real, en `/etc/caddy/Caddyfile` — sirve otros ~25 dominios del
amigo (`ramsus.site`, `apollyon.lat`, `gsalud.co`…), mismo patrón `dominio { reverse_proxy
localhost:PUERTO }` que ya usa `deploy/Caddyfile.gabotachak`. Es root:root, `robot` está
en el grupo `sudo` pero sin passwordless — **no lo puedo editar ni recargar yo**, y aunque
pudiera: un typo ahí tumba los otros 25 dominios, no solo el tuyo, así que el paso queda
manual con intención, no solo por permiso.

**[VOS o AMIGO], en el server:**
```bash
sudo tee -a /etc/caddy/Caddyfile < deploy/Caddyfile.gabotachak
caddy validate --config /etc/caddy/Caddyfile   # "Valid configuration" antes de recargar
sudo systemctl reload caddy                    # o `caddy reload` según cómo lo tenga corriendo
```

**Criterio de aceptación:**
```bash
curl https://sia-api.gabotachak.dev/v1/healthz   # 200
curl https://sia.gabotachak.dev/                 # 200, HTML del SPA
```

---

## Fase 3 — verificación end-to-end · **[VOS]**

1. Abrir `https://sia.gabotachak.dev` en el navegador, navegar
   sede → programa → asignatura → cupos. El front pega a `/v1/*` mismo-origen (nginx
   lo proxea internamente al contenedor `api` — **no** al dominio público de la API),
   así que esto prueba la cadena completa sin depender de CORS en ningún lado.
2. Golpear la API pública directo para casos de uso externos (Bruno, terceros):
   `https://sia-api.gabotachak.dev/v1/campuses`.
3. Certificado válido en ambos dominios (candado verde, no advertencia).

**Criterio de aceptación:** las tres cosas de arriba, en verde.

---

## Fase 4 — el `Refresher` en producción (fase 2 del proyecto)

Aplicado y verificado en el server el **2026-08-17**. No expone puertos ni dominios: es la
misma imagen con otro entrypoint, un modo por corrida, y sale.

| Qué | Estado |
|---|---|
| Migración `00002` | aplicada (`make migrate`, versión 2) |
| Imagen con el binario `refresher` | construida (`docker compose --profile jobs build api refresher`) |
| `/etc/cron.d/sia-refresher` | instalado, `root:root 644`, su línea exacta probada a mano |
| Log | `/var/log/sia-refresher.log` + `logrotate` semanal |
| Base de test aparte | `sia_bridge_test` creada y migrada |

**Corre como `root`** porque `robot` no está en el grupo `docker` (ahí están `ramsus`,
`brahiam`, `mcsmanager`, `app-runner`). Si algún día se agrega, cambiar la columna de
usuario del crontab es preferible.

### Tres cosas que se rompen en silencio, y cómo se cerraron

- **`--profile jobs` explícito en cada línea del cron.** El servicio vive en ese perfil
  para que `docker compose up` no dispare un barrido; según la versión de Compose, `run`
  no lo encuentra sin el flag. Habría fallado a las 3 a.m. y sin ruido.
- **`tzdata` en la imagen.** `alpine` no lo trae, así que `TZ=America/Bogota` no se podía
  resolver y **todo log salía en UTC**: el contenedor decía 08:10 a las 03:10 locales, 5
  horas corridas respecto al cron que lanza los barridos. Está en el `Dockerfile`.
- **`TEST_DATABASE_URL` apuntando a la base de producción.** Los tests de
  `internal/store` y `cmd/refresher` escriben de verdad: metieron 28 planes de sedes
  inventadas (`999x`) y dejaron `/v1/status` reportando 1408 planes conocidos donde el
  censo real son 1380. Limpiado, y ahora apunta a `sia_bridge_test`, que
  `deploy/initdb/01-test-database.sql` crea sola en un despliegue nuevo.

### Operación

```bash
# ver qué hizo el último barrido de cada modo
curl -s localhost:18080/v1/status | python3 -m json.tool

# disparar uno a mano (3 h de reloj: nohup, o se lo lleva el SSH al caerse)
sudo sh -c 'nohup docker compose --profile jobs run --rm refresher --mode=catalog --workers=2 --max-duration=3h >> /var/log/sia-refresher.log 2>&1 &'

# apagar todo sin editar cron
# .env → REFRESH_ENABLED=false   (cualquier modo sale con código 0 y un log)
```

`ended_reason` en `/v1/status` es lo primero que hay que mirar: `deadline` y `signal` son
normales —el barrido reanuda solo, porque el checkpoint son los marcadores de frescura—;
`circuit_breaker` significa que abortó por 5 fallos seguidos o >20% de error, y el log
dice qué unidad y con qué error.

**Pendiente con fecha:** la línea de cupos del crontab va comentada. Descomentarla el
**27/08/2026** cuando abran inscripciones, y volver a comentarla al cerrar — fuera de
temporada son ~1 GB/día contra un servidor público para reescribir el mismo número.

---

## Riesgos / lo que puede fallar en silencio

- **El barrido pesado en horario pico.** `CRON_TZ=America/Bogota` es obligatorio en el
  crontab: cron no hereda la TZ del host, y una hora corrida mete el barrido de detalle
  (~3 h, 4 conexiones al SIA) en mitad de la mañana. La TZ del host ya es Bogotá, pero eso
  no es garantía para el cron.
- **Las conexiones al SIA son un techo compartido.** `SIA_POOL_SIZE` (API) +
  `REFRESH_POOL_SIZE` (job) debe quedar **≤ 8**. Pasarse no da un error: da `503 busy` a
  usuarios reales durante las horas que dura un barrido.
- **HSTS con `includeSubDomains`.** `internal/httpapi/middleware.go` ya manda
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` en cada respuesta
  de la API. Una vez el navegador lo cachea para `sia-api.gabotachak.dev`,
  ese dominio (y cualquier subdominio suyo) queda forzado a HTTPS por un año — no
  hay vuelta atrás rápida a HTTP plano en ese host si algo del certificado falla.
  Verificar el certificado ANTES de que el header se sirva ampliamente no es posible
  (el header ya sale desde el primer 200), así que la Fase 2/3 deben hacerse en orden:
  Caddy con TLS funcionando primero, tráfico real después.
- **Nube naranja de Cloudflare antes de tener certificado propio.** Si activás Proxied
  antes de que Caddy tenga Let's Encrypt emitido, Cloudflare sirve su propio cert
  contra vos pero el tramo Cloudflare→origen puede quedar en HTTP o fallar según el
  modo SSL de la zona. Por eso Fase 1 pide nube gris primero.
