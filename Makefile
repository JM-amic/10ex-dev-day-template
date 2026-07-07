export DOCKER_BUILDKIT=0

COMPOSE_BASE=docker-compose.yml
COMPOSE_DEV=docker-compose.dev.yml
USE_DEV?=0

ifeq ($(USE_DEV),1)
COMPOSE_FILES=$(COMPOSE_BASE) $(COMPOSE_DEV)
else
COMPOSE_FILES=$(COMPOSE_BASE)
endif

COMPOSE_CMD=docker compose $(foreach file,$(COMPOSE_FILES),-f $(file))

COMPOSE_E2E_CMD=docker compose -f docker-compose.e2e.yml

.PHONY: up down reset logs logs-temporal logs-frontend supabase-status e2e-up e2e-down

# `up` starts the full local Supabase stack (Postgres + API/Kong + Auth +
# Storage + Studio) via the Supabase CLI, applying migrations and seed, THEN
# brings up Temporal + worker + frontend via docker compose.
up:
	supabase start
	@eval "$$(./scripts/supabase-env.sh)"; $(COMPOSE_CMD) up -d
	@echo ""
	@echo "Stack up. Frontend http://localhost:3000 | Temporal UI http://localhost:8080 | Supabase Studio http://localhost:54323"

down:
	$(COMPOSE_CMD) down
	supabase stop

# Full wipe: tear down compose volumes AND the Supabase stack (incl. its DB),
# then recreate everything from scratch (migrations + seed re-applied).
reset:
	$(COMPOSE_CMD) down -v
	-supabase stop --no-backup
	$(MAKE) up

logs:
	$(COMPOSE_CMD) logs -f

logs-temporal:
	$(COMPOSE_CMD) logs -f temporal temporal-worker

logs-frontend:
	$(COMPOSE_CMD) logs -f frontend

# Supabase is CLI-managed, not a compose service -- use this for its status/keys.
supabase-status:
	supabase status

# E2E stack: a standalone set of Temporal/worker/trigger/frontend containers
# on distinct ports (3001/7235/8001) so it can run alongside `make up`'s dev
# stack without colliding with it. Shares the same Supabase CLI instance --
# spinning up a second one isn't practical, and it's harmless since E2E just
# writes its own rows into the same local dev DB. The worker's Azure OpenAI
# call is pointed at a local deterministic stub (e2e/stub-llm) instead of the
# real endpoint.
e2e-up:
	supabase start
	@eval "$$(./scripts/supabase-env.sh)"; $(COMPOSE_E2E_CMD) up -d --build
	@echo ""
	@echo "E2E backend up (Trigger http://localhost:8001). Run 'npm run test:e2e' in frontend/ to also launch the frontend and run Playwright."

# Leaves the shared Supabase instance running (it may still be in use by
# `make up`'s dev stack) -- run `make down` / `supabase stop` separately.
e2e-down:
	$(COMPOSE_E2E_CMD) down
