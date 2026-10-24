# Arena Pong: common tasks.  Run `make` (or `make help`) for the list.
#
# Deploy settings, overridable on the command line or in the environment:
#   make supabase-link SUPABASE_PROJECT_REF=abcdefghijklmnop
#   make deploy-web CF_PAGES_PROJECT=my-pong

SUPABASE_PROJECT_REF ?=
CF_PAGES_PROJECT ?= arenapong
CF_BRANCH ?= main
# Run with npx on demand instead of adding it to package.json.
WRANGLER := npx --yes wrangler@4.149.0

# Point the Supabase CLI at Podman when there's no Docker and DOCKER_HOST isn't set.
ifeq ($(origin DOCKER_HOST),undefined)
  ifeq ($(shell command -v docker 2>/dev/null),)
    PODMAN_SOCK := $(XDG_RUNTIME_DIR)/podman/podman.sock
    ifneq ($(wildcard $(PODMAN_SOCK)),)
      export DOCKER_HOST := unix://$(PODMAN_SOCK)
    endif
  endif
endif

.DEFAULT_GOAL := help
.PHONY: help install start stop status reset types dev build preview clean \
	typecheck test test-db test-integration check \
	supabase-link db-diff db-push deploy-functions pages-create build-prod deploy-web deploy

help: ## List targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  \033[1m%-18s\033[0m %s\n", $$1, $$2} /^## / {printf "\n%s\n", substr($$0, 4)}' $(MAKEFILE_LIST)

## Local development

install: ## Install dependencies (also enables the pre-commit hook)
	npm install

start: ## Start the local Supabase stack
	npx supabase start

stop: ## Stop the local Supabase stack
	npx supabase stop

status: ## Show local stack URLs and keys
	npx supabase status

reset: ## Re-apply migrations and seed to the local database, then regenerate types
	npx supabase db reset
	npm run gen:types

types: ## Regenerate src/database.types.ts from the local schema
	npm run gen:types

dev: ## Run the app at http://127.0.0.1:5173
	npm run dev

build: ## Typecheck and build to dist/ (uses .env.local: local stack)
	npm run build

preview: ## Serve the built dist/
	npm run preview

clean: ## Remove build output
	rm -rf dist

## Tests

typecheck: ## Typecheck everything
	npm run typecheck

test: ## Unit tests (no network)
	npm test

test-db: ## pgTAP database tests (needs the local stack)
	npm run test:db

test-integration: ## App code against the local stack
	npm run test:integration

check: ## Everything: typecheck, unit, schema drift, pgTAP, integration
	npm run check

## Deploy (see "Deploying" in README.md)

supabase-link: ## Link this repo to a hosted project (SUPABASE_PROJECT_REF=...)
	@test -n "$(SUPABASE_PROJECT_REF)" || { echo "Set SUPABASE_PROJECT_REF (Project Settings > General in the dashboard)."; exit 1; }
	npx supabase link --project-ref $(SUPABASE_PROJECT_REF)

# The linked project on your machine.  CI never links, so it names the
# project with SUPABASE_PROJECT_REF, and answers the push prompt with --yes.
SUPABASE_TARGET = $(if $(SUPABASE_PROJECT_REF),--project-ref $(SUPABASE_PROJECT_REF),--linked)

db-diff: ## Show which migrations db-push would apply to the hosted project
	npx supabase db push $(SUPABASE_TARGET) --dry-run

db-push: ## Apply new migrations to the hosted project (CI does this on main)
	npx supabase db push $(SUPABASE_TARGET) $(if $(CI),--yes)

# Bundled on Supabase's side (--use-api), so it needs no Docker.  Unlike db
# push, functions deploy has no --linked: it uses the link by default.
deploy-functions: ## Deploy the Edge Functions to the hosted project (CI does this on main)
	npx supabase functions deploy --use-api $(if $(SUPABASE_PROJECT_REF),--project-ref $(SUPABASE_PROJECT_REF))

pages-create: ## Create the Cloudflare Pages project (once)
	$(WRANGLER) pages project create $(CF_PAGES_PROJECT) --production-branch $(CF_BRANCH)

build-prod: ## Build for the hosted project, from .env.production.local
	@if [ -z "$$VITE_SUPABASE_URL" ] && [ ! -f .env.production.local ]; then \
		echo "Missing .env.production.local with the hosted VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."; \
		echo "Without it, the build would point at your local stack (.env.local)."; \
		exit 1; \
	fi
	@if [ -z "$$VITE_TURNSTILE_SITE_KEY" ] && ! grep -qs '^VITE_TURNSTILE_SITE_KEY=.' .env.production.local; then \
		echo "Missing VITE_TURNSTILE_SITE_KEY in .env.production.local (the Turnstile widget's site key)."; \
		echo "Without it, the build would use the test key from .env.local."; \
		exit 1; \
	fi
	npm run build
	@if grep -rqE '127\.0\.0\.1:54321|localhost:54321' dist; then \
		echo "dist/ points at the local Supabase stack; refusing to use it for a deploy."; \
		exit 1; \
	fi
	@if grep -rqE '[123]x00000000000000000000(AA|BB|FF)' dist; then \
		echo "dist/ uses a Turnstile test site key; set VITE_TURNSTILE_SITE_KEY in .env.production.local."; \
		exit 1; \
	fi

deploy-web: build-prod ## Build and upload dist/ to Cloudflare Pages
	$(WRANGLER) pages deploy dist --project-name $(CF_PAGES_PROJECT) --branch $(CF_BRANCH)

deploy: db-push deploy-functions deploy-web ## Push migrations, deploy the functions, then the frontend
