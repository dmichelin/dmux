SHELL := /bin/bash
UNAME_S := $(shell uname -s)

.PHONY: build install start pack

build:
ifeq ($(UNAME_S),Darwin)
	@./scripts/setup-mac.sh
else
	@echo "make build currently only packages and symlinks dmux on macOS."
	@echo "Detected OS: $(UNAME_S)"
	@echo "For now, run: npm install && npm start"
	@exit 1
endif

install:
	@npm install

start:
	@npm start

pack:
	@npm run pack
