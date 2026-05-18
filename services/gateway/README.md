# Gateway

TypeScript WhatsApp gateway using Baileys for ingest, outbound dispatch, and ops tRPC procedures.

## Raw Event Persistence Rule

When mapping Baileys events, include the full provider event payload as `raw_event` in the backend inbound contract.
This payload is stored in Postgres (`message_versions.raw_event` JSONB) for audit/debug/replay.

The backend provider literal is `whatsapp-baileys`.

## Baileys Hook

`src/baileys-gateway.ts` wires Baileys events:
- `connection.update` -> connection status and QR cache
- `creds.update` -> persisted auth state
- `messages.upsert` -> map event -> backend tRPC `gateway.inbound.ingest`
- `messaging-history.set` -> map backfilled messages -> backend tRPC `gateway.inbound.ingest`

Entry point: `src/server.ts`

Environment variables:
- `GATEWAY_SESSION_NAME` (default `kuuna-gateway`)
- `BACKEND_BASE_URL` (default `http://backend:8000`)
- `GATEWAY_SERVICE_TOKEN` (optional)
- `BAILEYS_AUTH_DIR` (default `/data/baileys-auth` in Docker)
- `GATEWAY_SYNC_FULL_HISTORY` (default `false`; asks WhatsApp for full history when enabled)
- `GATEWAY_PROCESS_HISTORY_SYNC` (default `false`; processes Baileys history-sync batches when enabled)

### WhatsApp History Backfill

Deploying with the default environment keeps history backfill disabled. No new
environment variables are required unless backfill should be intentionally
enabled.

To enable backfill, set both flags on the gateway service and restart it:

```env
GATEWAY_SYNC_FULL_HISTORY=true
GATEWAY_PROCESS_HISTORY_SYNC=true
```

`GATEWAY_SYNC_FULL_HISTORY` asks WhatsApp for full history. `GATEWAY_PROCESS_HISTORY_SYNC`
allows Baileys history batches to be sent through the normal backend ingest path.
Backfilled messages are deduped like live messages by provider group and provider
message id, but new historical messages can still trigger indexing and passive
analysis for active bindings.

## Sentry

- Sentry project: `kuuna-gateway`
- Default CLI config in `services/gateway/.sentryclirc`
- DSN env var in `infra/env/gateway.env.example` (`SENTRY_DSN`)

For Docker dev, bind-mount source code and keep Baileys auth/session data on a persistent named volume (`gateway_session` -> `/data`).

When Baileys emits a QR code, the gateway stores it for the gateway tRPC `ops.qr`
procedure and prints a scannable terminal QR to the container logs by default. Set
`GATEWAY_PRINT_QR=false` to disable log rendering.
