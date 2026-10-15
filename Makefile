WEB_EXT ?= npx --yes web-ext
APP_ID ?= app.zen_browser.zen
ROOT ?=
TODOIST_NOTES ?=
DIST := web-ext-artifacts
IGNORE := 'native/**' 'test/**' plan.md README.md Makefile '$(DIST)/**'
WEB_EXT_OPTS := --source-dir . --ignore-files $(IGNORE)

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

.PHONY: test test-py test-js
test: test-py test-js ## Run all tests

test-py:
	python3 -m unittest discover -s native

test-js:
	node --test test/*.test.js

.PHONY: lint
lint: ## Lint extension and install script
	$(WEB_EXT) lint $(WEB_EXT_OPTS)
	shellcheck native/install.sh

.PHONY: build
build: ## Build unsigned zip into web-ext-artifacts/
	$(WEB_EXT) build $(WEB_EXT_OPTS) --artifacts-dir $(DIST) --overwrite-dest

.PHONY: sign
sign: ## Sign as unlisted AMO add-on (needs AMO_API_KEY, AMO_API_SECRET)
	@test -n "$$AMO_API_KEY" -a -n "$$AMO_API_SECRET" || { echo "set AMO_API_KEY and AMO_API_SECRET"; exit 1; }
	$(WEB_EXT) sign $(WEB_EXT_OPTS) --artifacts-dir $(DIST) --channel unlisted \
		--api-key "$$AMO_API_KEY" --api-secret "$$AMO_API_SECRET"

.PHONY: run
run: ## Start Firefox with the extension loaded temporarily
	$(WEB_EXT) run $(WEB_EXT_OPTS)

.PHONY: install-zen install-firefox check-root
install-zen: check-root ## Install host for flatpak browser (ROOT=..., APP_ID=...)
	native/install.sh --app-id "$(APP_ID)" --root "$(ROOT)" --todoist-notes "$(TODOIST_NOTES)"

install-firefox: check-root ## Install host for non-sandboxed Firefox (ROOT=...)
	native/install.sh --native --root "$(ROOT)" --todoist-notes "$(TODOIST_NOTES)"

check-root:
	@test -n "$(ROOT)" || { echo "usage: make $(MAKECMDGOALS) ROOT=/absolute/notes/dir"; exit 1; }

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf $(DIST) native/__pycache__
