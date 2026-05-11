# Gondolin + Pi Runtime

## Direction

The runtime stays on the current Postgres-backed backend. Convex is not part of
this path.

The building blocks are:

- Dashboard: reads backend APIs and subscribes to backend runtime events.
- Backend: owns Postgres writes, job scheduling, connector orchestration, and
  the authenticated runtime event sink.
- WhatsApp gateway: remains an adapter into the backend.
- Runtime agent: runs Pi and exposes the existing runtime-agent API.
- Gondolin: sandboxes Pi's file and shell tools in a selected micro-VM guest
  profile mounted at `/workspace`.
- Runtime-runner: optional standalone HTTP runner for future web chat, Slack, or
  other connectors that need to start runs outside the current backend worker.

## Streaming

Pi `message_update` text deltas are normalized to runtime stream events:

- `text_delta`
- `thinking_delta`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `run_completed`
- `run_failed`

Runtime containers post batches to:

```text
POST /internal/runtime-events/publish
```

The backend validates `RUNTIME_EVENT_SINK_TOKEN` or `INTERNAL_OPS_TOKEN`, then
publishes events onto the existing Redis runtime event bus. Dashboard live views
receive those events through the existing `runtimeEvents.onEvent` subscription.

## Sandbox

Pi still owns model/session orchestration. The runtime registers a Pi extension
factory that replaces Pi's built-in `read`, `write`, `edit`, and `bash` tools
with Gondolin-backed operations. The repository workspace is mounted read-write
at `/workspace` inside the VM, and tool paths are mapped from the host workspace
into that guest mount. Paths outside the mounted workspace are rejected by the
adapter before a VM operation is started.

Templates carry a `gondolin_profile` runtime setting. `base` uses Gondolin's
default guest image. Non-base profiles such as `python` or `media` must resolve
to prebuilt Gondolin guest assets inside the runtime container. The clean path is
to build/select guest images with the needed tools preinstalled, then mount the
asset directory read-only into lazy runtime containers:

```text
GONDOLIN_PROFILE_ASSETS_CONTAINER_DIR=/gondolin-profiles
GONDOLIN_PROFILE_ASSETS_HOST_DIR=/absolute/path/to/gondolin-profiles
```

The runtime resolves `/gondolin-profiles/<profile>` by default. For explicit
paths, set `GONDOLIN_PROFILE_PATHS` to JSON, for example:

```json
{"python":"/gondolin-profiles/python","media":"/gondolin-profiles/media"}
```

If a template selects a non-base profile that is not mounted or mapped, runtime
startup fails instead of falling back to a mock or host execution.

`bash` still requires template runtime config to enable it and still enforces
the configured command allowlist before execution. User `!` bash commands are
also wired to the same Gondolin `BashOperations` when this runtime is used
through Pi's extension event path. The allowlist gates command execution; the
guest profile defines which binaries are actually available.

## Adapter Shape

New connectors should not call Postgres. They should call the backend or the
standalone runtime-runner:

- Ingress adapters create or update canonical data through backend APIs.
- Runtime execution emits stream events through the backend sink.
- Outbound adapters consume backend-created outbound intents.

This keeps WhatsApp, web chat, Slack, and future connectors as replaceable
adapters around one backend/runtime contract.
