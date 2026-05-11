import {
  runtimeAgentEventBatchSchema,
  type RuntimeAgentEventBatch,
  type RuntimeAgentRunEvent,
} from "@kuuna/agent-contracts";
import type { RunnerConfig } from "./config.js";

export class RuntimeEventSink {
  #sequence = 0;
  #queue: RuntimeAgentRunEvent[] = [];
  #flushTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: RunnerConfig,
    private readonly runId: string,
    private readonly providerGroupId?: string | null,
    private readonly traceId?: string | null,
  ) {}

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
        console.error("[runtime-runner] failed to flush runtime stream events", error);
      });
    }, 150);
  }

  async flush(): Promise<void> {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    if (this.#queue.length === 0) {
      return;
    }
    const events = this.#queue.splice(0, this.#queue.length);
    await postRuntimeEvents(this.config, {
      run_id: this.runId,
      provider_group_id: this.providerGroupId ?? null,
      trace_id: this.traceId ?? null,
      events,
    });
  }
}

export async function postRuntimeEvents(config: RunnerConfig, batch: RuntimeAgentEventBatch): Promise<void> {
  const parsed = runtimeAgentEventBatchSchema.parse(batch);
  const response = await fetch(config.runtimeEventSinkUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": config.runtimeEventSinkToken,
    },
    body: JSON.stringify(parsed),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`runtime event sink failed (${response.status}): ${detail}`);
  }
}
