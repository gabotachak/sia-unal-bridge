# syntax=docker/dockerfile:1
FROM golang:1.26.6-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/bridge ./cmd/bridge

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && \
    adduser -D -u 1000 appuser
COPY --from=build /out/bridge /usr/local/bin/bridge
USER appuser
EXPOSE 8080
ENTRYPOINT ["bridge"]
