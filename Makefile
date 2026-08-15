.PHONY: run test migrate migrate-down lint

run:
	go run ./cmd/bridge

test:
	go test ./...

migrate:
	go run github.com/pressly/goose/v3/cmd/goose@latest -dir migrations postgres "$(DATABASE_URL)" up

migrate-down:
	go run github.com/pressly/goose/v3/cmd/goose@latest -dir migrations postgres "$(DATABASE_URL)" down

lint:
	go vet ./...
	gofmt -l .
