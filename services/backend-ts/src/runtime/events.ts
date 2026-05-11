import { on } from "node:events";
import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";
import { z } from "zod";

import { getSettings } from "../config.js";
import { getRedisConnection } from "../jobs/queues.js";
import { logger } from "../logging.js";

const runtimeEventsChannel = "kuuna:runtime-events";

export const runtimeEventTypeSchema = z.enum([
  "message.created",
  "message.decision",
  "media.updated",
  "agent_run.updated",
  "agent_run.stream",
  "tool_invocation.created",
  "todo.updated",
  "outbound_intent.updated",
  "template_build.updated",
  "binding.updated",
  "runtime_container.updated",
  "job.completed",
  "job.failed",
]);

export const runtimeEventSchema = z.object({
  id: z.string().uuid(),
  type: runtimeEventTypeSchema,
  provider_group_id: z.string().nullable(),
  trace_id: z.string().nullable(),
  entity_id: z.string().nullable(),
  entity_type: z.string().nullable(),
  occurred_at: z.string().datetime(),
  payload: z.record(z.unknown()),
});

export type RuntimeEventType = z.infer<typeof runtimeEventTypeSchema>;
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export type RuntimeEventInput = {
  type: RuntimeEventType;
  providerGroupId?: string | null;
  traceId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  payload?: Record<string, unknown>;
};

export async function publishRuntimeEvent(input: RuntimeEventInput): Promise<void> {
  const event = runtimeEventSchema.parse({
    id: randomUUID(),
    type: input.type,
    provider_group_id: input.providerGroupId ?? null,
    trace_id: input.traceId ?? null,
    entity_id: input.entityId ?? null,
    entity_type: input.entityType ?? null,
    occurred_at: new Date().toISOString(),
    payload: input.payload ?? {},
  });

  try {
    await getRedisConnection().publish(runtimeEventsChannel, JSON.stringify(event));
  } catch (error) {
    logger.warn("runtime_event_publish_failed", {
      type: event.type,
      entity_id: event.entity_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function* subscribeRuntimeEvents(signal: AbortSignal): AsyncGenerator<RuntimeEvent> {
  const subscriber = new Redis(getSettings().REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  try {
    await subscriber.subscribe(runtimeEventsChannel);
    for await (const [, rawMessage] of on(subscriber, "message", { signal })) {
      if (typeof rawMessage !== "string") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(rawMessage) as unknown;
      } catch {
        continue;
      }
      const parsed = runtimeEventSchema.safeParse(raw);
      if (parsed.success) {
        yield parsed.data;
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      logger.warn("runtime_event_subscription_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    await subscriber.unsubscribe(runtimeEventsChannel).catch(() => undefined);
    await subscriber.quit().catch(() => undefined);
  }
}
