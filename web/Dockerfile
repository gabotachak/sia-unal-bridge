# syntax=docker/dockerfile:1

# ── Build: Node compila los estáticos ────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# El contexto de build es ./web, así que el .env de la raíz no se ve desde aquí.
# Compose pasa el valor como build arg para que el botón de "medir ahora" del
# front use el mismo cooldown que aplica la API. Ver web/vite.config.ts.
ARG FETCH_COOLDOWN=60
ENV FETCH_COOLDOWN=$FETCH_COOLDOWN
# Mismo mecanismo: horneado en el bundle para el colofón (Layout.tsx), no solo
# en el LABEL de la imagen — un sitio estático no tiene proceso que lo sirva
# en caliente. Ver web/vite.config.ts.
ARG GIT_TAG=dev
ENV VITE_APP_VERSION=$GIT_TAG
# El banner rojo de incidencia (src/components/Banner.tsx). Ausente = se pinta;
# con cualquier valor no vacío, no. Vacío por defecto a propósito: una imagen
# construida sin pasar nada avisa, en vez de callar por omisión.
ARG VITE_INCIDENT_BANNER_OFF=
ENV VITE_INCIDENT_BANNER_OFF=$VITE_INCIDENT_BANNER_OFF
RUN npm run build

# ── Runtime: nginx sirve los estáticos y proxea /v1 al backend ───────
FROM nginxinc/nginx-unprivileged:stable-alpine
ARG GIT_TAG=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.version=$GIT_TAG
LABEL org.opencontainers.image.revision=$GIT_SHA
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
