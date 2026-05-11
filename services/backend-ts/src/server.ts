import cors from "@fastify/cors";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { runtimeAgentEventBatchSchema } from "@kuuna/agent-contracts";
import fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";

import { getSettings } from "./config.js";
import { closeDb, db, type Database } from "./db/client.js";
import { closeQueues, enqueueKuunaJob, type EnqueueKuunaJob } from "./jobs/queues.js";
import { logger } from "./logging.js";
import { publishRuntimeEvent } from "./runtime/events.js";
import { initSentry } from "./sentry.js";
import { RuntimeToolSearchError, searchRuntimeTool } from "./runtime/tool-search.js";
import { createTRPCContext } from "./trpc/init.js";
import { appRouter } from "./trpc/routers/_app.js";

export type { AppRouter } from "./trpc/routers/_app.js";

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

export type BuildServerOptions = {
  db?: Database;
  enqueueJob?: EnqueueKuunaJob;
};

export async function buildServer(options: BuildServerOptions = {}) {
  initSentry();

  const app = fastify({
    logger: false,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(422).send({ detail: error.issues });
    }

    const fastifyError = error as FastifyError;
    const statusCode = typeof fastifyError.statusCode === "number" ? fastifyError.statusCode : 500;
    logger.error("request_failed", {
      status_code: statusCode,
      error: fastifyError.message,
    });
    return reply.code(statusCode).send({ detail: fastifyError.message || "internal server error" });
  });

  app.get("/health", async () => ({ status: "ok", service: "backend-ts" }));
  app.post("/internal/runtime-tools/search", async (request, reply) => {
    const settings = getSettings();
    const expected = settings.RUNTIME_TOOL_TOKEN?.trim() || settings.INTERNAL_OPS_TOKEN?.trim();
    if (!expected) {
      return reply.code(503).send({ detail: "runtime tool token not configured" });
    }
    if (request.headers["x-internal-token"] !== expected) {
      return reply.code(403).send({ detail: "invalid runtime tool token" });
    }
    try {
      return await searchRuntimeTool(options.db ?? db, request.body);
    } catch (error) {
      if (error instanceof RuntimeToolSearchError) {
        return reply.code(error.statusCode).send({ detail: error.message });
      }
      if (error instanceof ZodError) {
        return reply.code(422).send({ detail: error.issues });
      }
      throw error;
    }
  });

  app.post("/internal/runtime-events/publish", async (request, reply) => {
    const settings = getSettings();
    const expected = settings.RUNTIME_EVENT_SINK_TOKEN?.trim() || settings.INTERNAL_OPS_TOKEN?.trim();
    if (!expected) {
      return reply.code(503).send({ detail: "runtime event sink token not configured" });
    }
    if (request.headers["x-internal-token"] !== expected) {
      return reply.code(403).send({ detail: "invalid runtime event sink token" });
    }

    const batch = runtimeAgentEventBatchSchema.parse(request.body);
    for (const event of batch.events) {
      await publishRuntimeEvent({
        type: event.type === "run_completed" || event.type === "run_failed" ? "agent_run.updated" : "agent_run.stream",
        providerGroupId: batch.provider_group_id ?? null,
        traceId: batch.trace_id ?? null,
        entityId: batch.run_id,
        entityType: "agent_run",
        payload: {
          ...event,
          agent_run_id: batch.run_id,
        },
      });
    }
    return { ok: true, ingested: batch.events.length };
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }: { req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } } }) =>
        createTRPCContext({
          headers: headersFromRecord(req.headers),
          clientIp:
            String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() ||
            String(req.headers["x-real-ip"] ?? "") ||
            req.socket.remoteAddress ||
            "unknown",
          db: options.db,
          enqueueJob: options.enqueueJob ?? enqueueKuunaJob,
        }),
    },
  });

  return app;
}

export async function run(): Promise<void> {
  const settings = getSettings();
  const app = await buildServer();

  const shutdown = async () => {
    await app.close();
    await closeQueues();
    await closeDb();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await app.listen({ host: settings.HOST, port: settings.PORT });
  logger.info("backend_ts_started", { host: settings.HOST, port: settings.PORT });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    logger.error("backend_ts_boot_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
