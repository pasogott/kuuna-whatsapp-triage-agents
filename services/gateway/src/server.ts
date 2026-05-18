import Fastify from "fastify";
import * as Sentry from "@sentry/node";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";

import { BackendIngestClient } from "./backend.js";
import { BaileysGateway } from "./baileys-gateway.js";
import { getSettings } from "./config.js";
import { GatewayConnectionStatus, GatewayQrStatus } from "./status.js";
import type { GatewayClient } from "./types.js";
import { createGatewayRouter } from "./trpc.js";

export async function buildServer(input: { client?: GatewayClient } = {}) {
  const settings = getSettings();
  const app = Fastify({
    logger: {
      level: settings.LOG_LEVEL.toLowerCase(),
      redact: [
        "req.headers.authorization",
        "req.headers.x-internal-token",
        "raw_event",
        "download_url",
        "inline_data_base64",
        "text_content",
      ],
    },
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const statusCode = errorStatusCode(error);
    if (statusCode >= 500) {
      app.log.error({ err: error }, "gateway_request_failed");
    }
    reply.code(statusCode).send({ detail: errorMessage(error) });
  });

  const client = input.client ?? createDefaultGatewayClient();
  const gatewayRouter = createGatewayRouter({
    client,
    opsToken: settings.GATEWAY_OPS_TOKEN ?? null,
    serviceToken: settings.GATEWAY_SERVICE_TOKEN ?? null,
  });
  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: gatewayRouter,
      createContext: ({ req }: { req: { headers: Record<string, string | string[] | undefined> } }) => ({
        headers: headersFromRecord(req.headers),
      }),
    },
  });
  app.addHook("onClose", async () => {
    await client.stop();
  });

  return app;
}

function headersFromRecord(headers: Record<string, string | string[] | undefined>): Headers {
  const output = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      output.set(key, value.join(","));
    } else if (value !== undefined) {
      output.set(key, value);
    }
  }
  return output;
}

function createDefaultGatewayClient(): GatewayClient {
  const settings = getSettings();
  const connectionStatus = new GatewayConnectionStatus();
  const qrStatus = new GatewayQrStatus();
  return new BaileysGateway({
    authDir: settings.BAILEYS_AUTH_DIR,
    sessionName: settings.GATEWAY_SESSION_NAME,
    printQrToConsole: settings.GATEWAY_PRINT_QR,
    syncFullHistory: settings.GATEWAY_SYNC_FULL_HISTORY,
    processHistorySync: settings.GATEWAY_PROCESS_HISTORY_SYNC,
    logLevel: settings.LOG_LEVEL.toLowerCase(),
    backendClient: new BackendIngestClient({
      backendBaseUrl: settings.BACKEND_BASE_URL,
      serviceToken: settings.GATEWAY_SERVICE_TOKEN ?? null,
    }),
    connectionStatus,
    qrStatus,
  });
}

function initSentry(): void {
  const settings = getSettings();
  if (!settings.SENTRY_DSN) return;
  Sentry.init({
    dsn: settings.SENTRY_DSN,
    environment: settings.SENTRY_ENVIRONMENT,
    sendDefaultPii: false,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
  });
}

function scrubSentryEvent<T>(event: T): T {
  return scrubValue("event", event) as T;
}

function scrubValue(key: string, value: unknown): unknown {
  if (containsSensitiveKey(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => scrubValue(key, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        scrubValue(childKey, childValue),
      ]),
    );
  }
  if (typeof value === "string") return value.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED]");
  return value;
}

function containsSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return ["authorization", "token", "secret", "api_key", "raw_event", "download_url", "inline_data_base64", "text_content"].some(
    (part) => lowered.includes(part),
  );
}

function errorStatusCode(error: unknown): number {
  if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
    return 422;
  }
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runServer(): Promise<void> {
  initSentry();
  const settings = getSettings();
  const client = createDefaultGatewayClient();
  const app = await buildServer({ client });
  await app.listen({ host: settings.GATEWAY_OPS_HOST, port: settings.GATEWAY_OPS_PORT });
  await client.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  initSentry();
  const settings = getSettings();
  const client = createDefaultGatewayClient();
  const app = await buildServer({ client });

  const shutdown = async () => {
    await app.close();
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await app.listen({ host: settings.GATEWAY_OPS_HOST, port: settings.GATEWAY_OPS_PORT });
  await client.start();
}
