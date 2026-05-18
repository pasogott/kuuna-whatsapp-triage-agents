#!/usr/bin/env bash
set -euo pipefail

# Own the node-level Tailscale Serve config for the Kuuna single-host deployment.
# This intentionally exposes only the dashboard and the tRPC subscription path
# inside the tailnet. It does not enable Tailscale Funnel or publish raw ports.
# `tailscale serve reset` clears every existing Serve route on this node; run
# this helper only where Kuuna owns the node-level Serve config.

DASHBOARD_TARGET="${DASHBOARD_TARGET:-localhost:3000}"
# Tailscale Serve strips the matched /trpc path before proxying. Keep /trpc in
# the backend target so dashboard HTTP calls and websocket subscriptions still
# reach the backend's /trpc route.
TRPC_TARGET="${TRPC_TARGET:-http://localhost:8000/trpc}"

tailscale serve reset
tailscale serve --bg "${DASHBOARD_TARGET}"
tailscale serve --bg --set-path /trpc "${TRPC_TARGET}"
tailscale serve status
