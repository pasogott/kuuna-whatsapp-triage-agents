import {
  runtimeAgentEventBatchSchema,
  type RuntimeAgentEventBatch,
  type RuntimeAgentRunEvent,
} from "@kuuna/agent-contracts";
import { runtimeEventSinkToken, runtimeEventSinkUrl } from "./config.js";

export class RuntimeEventSink {
  #sequence = 0;
  #queue: RuntimeAgentRunEvent[] = [];
  #flushTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly runId: string,
    private readonly providerGroupId?: string | null,
    private readonly traceId?: string | null,
  ) {}

  static fromContext(context: Record<string, unknown>): RuntimeEventSink | null {
    if (!runtimeEventSinkUrl() || !runtimeEventSinkToken()) {
      return null;
    }
    const runId = typeof context.agent_run_id === "string" ? context.agent_run_id : null;
    if (!runId) {
      return null;
    }
    const providerGroupId = typeof context.provider_group_id === "string" ? context.provider_group_id : null;
    const traceId = typeof context.trace_id === "string" ? context.trace_id : null;
    return new RuntimeEventSink(runId, providerGroupId, traceId);
  }

  async append(event: RuntimeAgentRunEvent): Promise<void> {
    const withSequence = "sequence" in event && typeof event.sequence === "number"
      ? event
      : { ...event, sequence: this.#sequence++ };
    this.#queue.push(withSequence);
    if (this.#queue.length >= 25 || event.type === "run_completed" || event.type === "run_failed") {
      await this.flush();
      return;
    }
    this.#flushTimer ??= setTimeout(() => {
      this.flush().catch((error) => {
        console.error("[runtime-agent-ts] failed to flush runtime stream events", error);
      });
    }, 150);
  }

  async flush(): Promise<void> {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    if (this.#queue.length === 0) return;
    const events = this.#queue.splice(0, this.#queue.length);
    await postRuntimeEvents({
      run_id: this.runId,
      provider_group_id: this.providerGroupId ?? null,
      trace_id: this.traceId ?? null,
      events,
    });
  }
}

async function postRuntimeEvents(batch: RuntimeAgentEventBatch): Promise<void> {
  const url = runtimeEventSinkUrl();
  const token = runtimeEventSinkToken();
  if (!url || !token) return;
  const parsed = runtimeAgentEventBatchSchema.parse(batch);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify(parsed),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`runtime event sink failed (${response.status}): ${detail}`);
  }
}
