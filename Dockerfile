# syntax=docker/dockerfile:1
FROM golang:1.26.6-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/bridge ./cmd/bridge
# El Job de fase 2 va en la MISMA imagen, otro entrypoint: comparte config,
# store y adaptadores con la API, y así no puede quedar desfasado de ella.
RUN CGO_ENABLED=0 go build -o /out/refresher ./cmd/refresher

FROM alpine:3.20
# tzdata NO es opcional: sin él, Go no puede resolver TZ=America/Bogota y todo
# log sale en UTC — 5 horas corridas respecto al cron que lanza los barridos.
# Medido 2026-08-17: el contenedor decía 08:10 a las 03:10 locales.
RUN apk add --no-cache ca-certificates tzdata && \
    adduser -D -u 1000 appuser
COPY --from=build /out/bridge /usr/local/bin/bridge
COPY --from=build /out/refresher /usr/local/bin/refresher
USER appuser
EXPOSE 8080
ENTRYPOINT ["bridge"]
