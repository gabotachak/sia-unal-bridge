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
RUN npm run build

# ── Runtime: nginx sirve los estáticos y proxea /v1 al backend ───────
FROM nginxinc/nginx-unprivileged:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
