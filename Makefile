.PHONY: run test migrate migrate-down lint check-env

# Sin esto, DATABASE_URL llega vacío y goose cae al default de libpq: socket
# unix local y usuario del sistema ("role robot does not exist").
# El `-` tolera que no exista .env; `export` pasa las variables a las recetas.
-include .env
export

check-env:
	@test -n "$(DATABASE_URL)" || { echo "DATABASE_URL vacío. ¿Falta .env? Copiar de .env.example"; exit 1; }

run:
	go run ./cmd/bridge

test:
	go test ./...

migrate: check-env
	go run github.com/pressly/goose/v3/cmd/goose@latest -dir migrations postgres "$(DATABASE_URL)" up

migrate-down: check-env
	go run github.com/pressly/goose/v3/cmd/goose@latest -dir migrations postgres "$(DATABASE_URL)" down

lint:
	go vet ./...
	gofmt -l .
