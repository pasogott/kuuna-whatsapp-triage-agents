import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runtimeAgentRequestSchema } from "@kuuna/agent-contracts";
import { GondolinRuntime, normalizeGondolinProfile, runAgent } from "@kuuna/pi-runtime";
import { loadConfig } from "./config.js";
import { RuntimeEventSink } from "./event-sink.js";

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function tokenFrom(request: IncomingMessage): string {
  const authorization = request.headers.authorization ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : String(request.headers["x-kuuna-runner-token"] ?? "");
}

const config = loadConfig();
const gondolinRuntimes = new Map<string, GondolinRuntime>();

function gondolinFor(profile: string): GondolinRuntime {
  const normalized = normalizeGondolinProfile(profile);
  let runtime = gondolinRuntimes.get(normalized);
  if (!runtime) {
    runtime = new GondolinRuntime(config.workspaceRoot, { profile: normalized });
    gondolinRuntimes.set(normalized, runtime);
  }
  return runtime;
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method !== "POST" || request.url !== "/runs") {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    if (tokenFrom(request) !== config.runnerToken) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const payload = await readJson(request);
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const runId = typeof record.run_id === "string" ? record.run_id : typeof record.runId === "string" ? record.runId : "";
    const providerGroupId =
      typeof record.provider_group_id === "string"
        ? record.provider_group_id
        : typeof record.providerGroupId === "string"
          ? record.providerGroupId
          : null;
    const traceId = typeof record.trace_id === "string" ? record.trace_id : typeof record.traceId === "string" ? record.traceId : null;
    if (!runId) {
      writeJson(response, 400, { error: "run_id is required" });
      return;
    }

    const requestBody = runtimeAgentRequestSchema.parse(record.request ?? record);
    const sink = new RuntimeEventSink(config, runId, providerGroupId, traceId);
    const gondolin = gondolinFor(requestBody.runtime_config.gondolin_profile);
    await gondolin.ensureVm();

    runAgent(requestBody, {
      cwd: config.workspaceRoot,
      onStreamEvent: (event) => sink.append(event),
      extensionFactories: (state) => [
        gondolin.createPiSandboxExtension(state, requestBody.runtime_config.pi_bash_allowlist),
      ],
      tools: {
        disableCustomBash: true,
      },
    })
      .then(async (result) => {
        if (result.success) {
          await sink.append({
            type: "run_completed",
            response_text: result.response_text ?? null,
            model_used: result.model_used ?? null,
            payload: result,
          });
        } else {
          await sink.append({
            type: "run_failed",
            error: result.error ?? "agent run failed",
            payload: result,
          });
        }
        await sink.flush();
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await sink.append({ type: "run_failed", error: message, payload: {} });
        await sink.flush();
      });

    writeJson(response, 202, { ok: true, run_id: runId });
  } catch (error) {
    writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const shutdown = async () => {
  server.close();
  await Promise.all(Array.from(gondolinRuntimes.values(), (runtime) => runtime.close()));
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

server.listen(config.port, config.host, () => {
  console.log(`[runtime-runner] listening on ${config.host}:${config.port}`);
});
