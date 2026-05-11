import cors from "@fastify/cors";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
import { fromNodeHeaders } from "better-auth/node";

import { ensureRequiredAdmin } from "./auth/bootstrap.js";
import { createBetterAuth } from "./better-auth.js";
import { getSettings } from "./config.js";
import { closeDb, db, type Database } from "./db/client.js";
import { closeQueues, enqueueKuunaJob, type EnqueueKuunaJob } from "./jobs/queues.js";
import { logger } from "./logging.js";
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
  const settings = getSettings();
  const database = options.db ?? db;
  const auth = createBetterAuth(database);

  const app = fastify({
    logger: false,
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || origin === settings.DASHBOARD_ORIGIN || origin === settings.BETTER_AUTH_URL) {
        callback(null, true);
        return;
      }
      callback(new Error("origin not allowed"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Internal-Token", "X-Requested-With"],
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
  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "POST" && url.pathname === "/api/auth/sign-in/email") {
        await ensureRequiredAdmin(database);
      }
      const body =
        request.method === "GET" || request.method === "HEAD" || request.body === undefined
          ? undefined
          : JSON.stringify(request.body);
      const response = await auth.handler(
        new Request(url.toString(), {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          body,
        }),
      );

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") {
          reply.header(key, value);
        }
      });
      const withSetCookie = response.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies = withSetCookie.getSetCookie?.() ?? [response.headers.get("set-cookie")].filter(Boolean);
      for (const cookie of setCookies) {
        reply.header("Set-Cookie", cookie);
      }
      return reply.send(response.body ? await response.text() : null);
    },
  });

  app.post("/internal/runtime-tools/search", async (request, reply) => {
    const expected = settings.RUNTIME_TOOL_TOKEN?.trim() || settings.INTERNAL_OPS_TOKEN?.trim();
    if (!expected) {
      return reply.code(503).send({ detail: "runtime tool token not configured" });
    }
    if (request.headers["x-internal-token"] !== expected) {
      return reply.code(403).send({ detail: "invalid runtime tool token" });
    }
    try {
      return await searchRuntimeTool(database, request.body);
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
          db: database,
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
