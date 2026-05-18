#!/usr/bin/env bash
set -euo pipefail

# Own the node-level Tailscale Serve config for the Kuuna single-host deployment.
# This intentionally exposes only the dashboard and the tRPC subscription path
# inside the tailnet. It does not enable Tailscale Funnel or publish raw ports.

DASHBOARD_TARGET="${DASHBOARD_TARGET:-localhost:3000}"
TRPC_TARGET="${TRPC_TARGET:-localhost:8000}"

tailscale serve reset
tailscale serve --bg "${DASHBOARD_TARGET}"
tailscale serve --bg --set-path /trpc "${TRPC_TARGET}"
tailscale serve status
