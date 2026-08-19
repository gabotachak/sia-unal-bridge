# syntax=docker/dockerfile:1
FROM golang:1.26.6-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Default "dev"/"unknown" a propósito: un build local sin --build-arg no debe
# mentir que es una versión real. docker-compose.yml los pasa en cada build.
ARG GIT_TAG=dev
ARG GIT_SHA=unknown
RUN CGO_ENABLED=0 go build -ldflags "-X main.version=$GIT_TAG -X main.commit=$GIT_SHA" -o /out/bridge ./cmd/bridge

FROM alpine:3.24
RUN apk add --no-cache ca-certificates && \
    adduser -D -u 1000 appuser
ARG GIT_TAG=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.version=$GIT_TAG
LABEL org.opencontainers.image.revision=$GIT_SHA
COPY --from=build /out/bridge /usr/local/bin/bridge
USER appuser
EXPOSE 8080
ENTRYPOINT ["bridge"]
