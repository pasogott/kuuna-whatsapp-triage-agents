# Docker Compose (Development)

Use Docker for all local runs (frontend + backend + gateway + infra dependencies).

This file documents the development stack only. Do not use `just up` or
`docker-compose.dev.yml` as the remote staff-dashboard deployment: it runs
Next.js in development mode and starts watch-mode backend, worker, and gateway
processes. Remote single-host deployments should use
`infra/compose/docker-compose.prod.yml`.

## Start
```bash
just up
```

This builds the `kuuna-runtime-agent-ts:dev` image and then starts the stack.
Runtime agents are not long-running shared Compose services; they are created
on demand as per-chat containers by the backend worker.

## Stop
```bash
just down
```

## Hot Reload
- Dashboard: Next.js dev server runs with bind mount (`apps/dashboard:/app`).
- Backend API: `tsx watch` runs the TypeScript backend with bind-mounted source.
- Worker: `tsx watch` runs the TypeScript BullMQ worker with bind-mounted source.
- Gateway: `tsx watch` runs the Baileys TypeScript gateway with bind-mounted source.

## WhatsApp Session Persistence (Gateway)
The gateway stores Baileys auth/session state in the named Docker volume `gateway_session` at `/data`.
`BAILEYS_AUTH_DIR` defaults to `/data/baileys-auth`, so login/session state survives container restarts.

Reset session state intentionally:

```bash
docker volume rm kuuna-dev_gateway_session
```

## Smoke Gates

Run Docker smoke checks (services + migrations):

```bash
just smoke-docker
```

Run backup/restore DR baseline smoke:

```bash
just smoke-dr-restore
```

Run both:

```bash
just smoke-all
```

Scripts:
- `infra/compose/smoke/docker-smoke.sh`
- `infra/compose/smoke/dr-backup-restore.sh`

Restore runbook:
- `infra/compose/DR_RUNBOOK.md`

Remote Tailscale Serve helper:
- `infra/compose/tailscale-serve.cyberheld-ai-team.sh`

## Database Migrations

Compose runs migrations through the TypeScript backend service:

```bash
just migrate
```

This invokes `pnpm --filter @kuuna/backend-ts db:migrate` in the `migrate`
container. The runner uses `drizzle-orm`, reads `.sql` files from
`services/backend-ts/drizzle/`, and records applied files in
`__kuuna_drizzle_migrations`.
