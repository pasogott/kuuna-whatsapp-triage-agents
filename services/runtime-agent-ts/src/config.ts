export const DEFAULT_HOST = "::";
export const DEFAULT_PORT = 8100;

export function port(): number {
  const value = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PORT;
}

export function host(): string {
  return process.env.HOST?.trim() || DEFAULT_HOST;
}

export function runtimeWorkspaceRoot(): string {
  return process.env.RUNTIME_WORKSPACE_ROOT?.trim() || process.cwd();
}

export function runtimeEventSinkUrl(): string | null {
  const value = process.env.RUNTIME_EVENT_SINK_URL?.trim();
  return value ? value.replace(/\/$/, "") : null;
}

export function runtimeEventSinkToken(): string | null {
  return process.env.RUNTIME_EVENT_SINK_TOKEN?.trim() || process.env.KUUNA_RUNTIME_EVENT_SINK_TOKEN?.trim() || null;
}
