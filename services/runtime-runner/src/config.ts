export type RunnerConfig = {
  host: string;
  port: number;
  workspaceRoot: string;
  runtimeEventSinkUrl: string;
  runtimeEventSinkToken: string;
  runnerToken: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function optionalPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(): RunnerConfig {
  return {
    host: process.env.HOST ?? "::",
    port: optionalPort("PORT", 8095),
    workspaceRoot: process.env.RUNTIME_WORKSPACE_ROOT ?? process.cwd(),
    runtimeEventSinkUrl: requiredEnv("RUNTIME_EVENT_SINK_URL").replace(/\/$/, ""),
    runtimeEventSinkToken: requiredEnv("RUNTIME_EVENT_SINK_TOKEN"),
    runnerToken: requiredEnv("RUNTIME_RUNNER_TOKEN"),
  };
}
