.PHONY: run test migrate migrate-down migrate-test lint check-env deploy-web deploy-web-test deploy-api deploy-jobs run-jobs

# Variables for deployment
GIT_TAG ?= $(shell git describe --tags --always)
GIT_SHA ?= $(shell git rev-parse --short HEAD)

# Sin esto, DATABASE_URL llega vacío y goose cae al default de libpq: socket
# unix local y usuario del sistema ("role robot does not exist").
# El `-` tolera que no exista .env; `export` pasa las variables a las recetas.
-include .env
export

check-env:
	@test -n "$(DATABASE_URL)" || { echo "DATABASE_URL vacío. ¿Falta .env? Copiar de .env.example"; exit 1; }

run:
	go run ./cmd/bridge

# -p 1: los paquetes de store/ y cmd/refresher/ escriben en la MISMA base de test
# (TEST_DATABASE_URL). Corriendo en paralelo, que es el default de `go test`, de
# vez en cuando se pisan: `deadlock detected` en un DELETE de limpieza, ~1 de cada
# 10 corridas con -race. Un paquete a la vez cuesta un par de segundos.
test:
	go test -p 1 ./...

migrate: check-env
	go run github.com/pressly/goose/v3/cmd/goose@latest -dir migrations postgres "$(DATABASE_URL)" up

migrate-down: check-env
	go run github.com/pressly/goose/v3/cmd/goose@latest -dir migrations postgres "$(DATABASE_URL)" down

# La base de test es OTRA base (sia_bridge_test), no un esquema aparte: los tests
# de store/ y cmd/refresher/ escriben de verdad, y compartirla con producción
# dejó 28 planes de sedes falsas dentro. Correr esto tras cada migración nueva.
migrate-test:
	@test -n "$(TEST_DATABASE_URL)" || { echo "TEST_DATABASE_URL vacío. ¿Falta .env?"; exit 1; }
	go run github.com/pressly/goose/v3/cmd/goose@latest -dir migrations postgres "$(TEST_DATABASE_URL)" up

lint:
	go vet ./...
	gofmt -l .

deploy-web:
	docker compose build web && docker compose up -d --no-deps web

deploy-web-test:
	docker compose build web-test && docker compose up -d --no-deps web-test

deploy-api:
	docker compose build api && docker compose up -d --no-deps api

deploy-jobs:
	docker compose --profile jobs build refresher

# Corrida manual del refresher, ej: make run-jobs MODE=detail SCOPE=global WORKERS=80
MODE ?= reference
SCOPE ?=
WORKERS ?= 2
CAMPUS ?=
run-jobs:
	docker compose run --rm refresher \
		--mode=$(MODE) $(if $(SCOPE),--scope=$(SCOPE)) \
		--workers=$(WORKERS) $(if $(CAMPUS),--campus=$(CAMPUS))
