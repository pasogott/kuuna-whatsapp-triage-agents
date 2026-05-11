import { createServer, type ServerResponse } from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import {
  defaultModel,
  defaultReasoningEffort,
  openAiApiKey,
  openAiBaseUrl,
  openAiTimeoutSeconds,
  piAuthPath,
  piTransport,
} from "@kuuna/pi-runtime";

import { host, port } from "./config.js";
import { runtimeAgentRouter } from "./trpc.js";

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { detail: "not found" });
}

const trpcHandler = createHTTPHandler({
  router: runtimeAgentRouter,
  basePath: "/trpc/",
});

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && request.url === "/debug/status") {
      sendJson(response, 200, {
        status: "ok",
        openai_configured: Boolean(openAiApiKey()),
        openai_base_url: openAiBaseUrl(),
        openai_timeout_seconds: openAiTimeoutSeconds(),
        pi_auth_path: piAuthPath() ?? null,
        pi_transport: piTransport(),
        default_model: defaultModel(),
        reasoning_effort: defaultReasoningEffort(),
        runtime: "pi-typescript",
      });
      return;
    }

    if (request.url?.startsWith("/trpc/")) {
      trpcHandler(request, response);
      return;
    }

    notFound(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, {
      detail: `runtime-agent execution failed: ${message}`,
    });
  }
});

server.listen(port(), host(), () => {
  console.log(JSON.stringify({ event: "runtime_agent_ts_started", host: host(), port: port() }));
});
