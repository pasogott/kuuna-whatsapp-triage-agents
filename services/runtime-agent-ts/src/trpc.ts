import { runtimeAgentRequestSchema } from "@kuuna/agent-contracts";
import { GondolinRuntime, normalizeGondolinProfile, runAgent } from "@kuuna/pi-runtime";
import { initTRPC } from "@trpc/server";
import { runtimeWorkspaceRoot } from "./config.js";
import { RuntimeEventSink } from "./event-sink.js";

const t = initTRPC.create();
const gondolinRuntimes = new Map<string, GondolinRuntime>();

async function appendFinalRuntimeEvent(
  sink: RuntimeEventSink | null,
  result: Awaited<ReturnType<typeof runAgent>>,
): Promise<void> {
  if (!sink) return;
  try {
    await sink.append(
      result.success
        ? {
            type: "run_completed",
            response_text: result.response_text ?? null,
            model_used: result.model_used ?? null,
            payload: result,
          }
        : {
            type: "run_failed",
            error: result.error ?? "agent run failed",
            payload: result,
          },
    );
    await sink.flush();
  } catch (error) {
    console.warn("[runtime-agent-ts] failed to flush final runtime stream event", error);
  }
}

function gondolinFor(profile: string): GondolinRuntime {
  const normalized = normalizeGondolinProfile(profile);
  let runtime = gondolinRuntimes.get(normalized);
  if (!runtime) {
    runtime = new GondolinRuntime(runtimeWorkspaceRoot(), { profile: normalized });
    gondolinRuntimes.set(normalized, runtime);
  }
  return runtime;
}

export const runtimeAgentRouter = t.router({
  agent: t.router({
    run: t.procedure
      .input(runtimeAgentRequestSchema)
      .mutation(async ({ input }) => {
        const sink = RuntimeEventSink.fromContext(input.context);
        const gondolin = gondolinFor(input.runtime_config.gondolin_profile);
        await gondolin.ensureVm();
        const result = await runAgent(input, {
          cwd: runtimeWorkspaceRoot(),
          onStreamEvent: (event) => sink?.append(event),
          extensionFactories: (state) => [
            gondolin.createPiSandboxExtension(state, input.runtime_config.pi_bash_allowlist),
          ],
          tools: {
            disableCustomBash: true,
          },
        });
        await appendFinalRuntimeEvent(sink, result);
        return result;
      }),
  }),
});

export type RuntimeAgentRouter = typeof runtimeAgentRouter;
