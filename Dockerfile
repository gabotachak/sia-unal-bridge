# syntax=docker/dockerfile:1
FROM golang:1.27.0-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Default "dev"/"unknown" a propósito: un build local sin --build-arg no debe
# mentir que es una versión real. docker-compose.yml los pasa en cada build.
ARG GIT_TAG=dev
ARG GIT_SHA=unknown
RUN CGO_ENABLED=0 go build -ldflags "-X main.version=$GIT_TAG -X main.commit=$GIT_SHA" -o /out/bridge ./cmd/bridge
# El Job de fase 2 va en la MISMA imagen, otro entrypoint: comparte config,
# store y adaptadores con la API, y así no puede quedar desfasado de ella.
RUN CGO_ENABLED=0 go build -ldflags "-X main.version=$GIT_TAG -X main.commit=$GIT_SHA" -o /out/refresher ./cmd/refresher

FROM alpine:3.24
# tzdata NO es opcional: sin él, Go no puede resolver TZ=America/Bogota y todo
# log sale en UTC — 5 horas corridas respecto al cron que lanza los barridos.
# Medido 2026-08-17: el contenedor decía 08:10 a las 03:10 locales.
RUN apk add --no-cache ca-certificates tzdata && \
    adduser -D -u 1000 appuser
ARG GIT_TAG=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.version=$GIT_TAG
LABEL org.opencontainers.image.revision=$GIT_SHA
COPY --from=build /out/bridge /usr/local/bin/bridge
COPY --from=build /out/refresher /usr/local/bin/refresher
USER appuser
EXPOSE 8080
ENTRYPOINT ["bridge"]
