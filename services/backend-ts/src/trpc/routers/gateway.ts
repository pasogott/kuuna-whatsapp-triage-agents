import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  type GatewayInboundAck,
  gatewayInboundEventSchema,
  gatewayOutboundStatusEventSchema,
  type GatewayInboundEvent,
  type GatewayOutboundStatusEvent,
} from "@kuuna/contracts";

import { getSettings } from "../../config.js";
import type { Database } from "../../db/client.js";
import {
  groupBindings,
  groupMembers,
  mediaAssets,
  messageDecisions,
  messageLinks,
  messages,
  messageVersions,
  outboundIntents,
} from "../../db/schema.js";
import { ensureAutomaticFollowupTodo } from "../../jobs/followup-todos.js";
import { enqueueRuntimeChatTask, type EnqueueKuunaJob, type RuntimeChatTaskQueueClient } from "../../jobs/queues.js";
import { logger } from "../../logging.js";
import { publishRuntimeEvent } from "../../runtime/events.js";
import { evaluateTrigger } from "../../trigger.js";
import { createTRPCRouter, publicProcedure } from "../init.js";

function mediaKindFromMimeType(mimeType: string | null | undefined): string {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!normalized) return "file";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/") || normalized.endsWith("/audio")) return "audio";
  if (normalized.startsWith("video/") || normalized.endsWith("/video")) return "video";
  return "file";
}

function hasInboundContent(event: GatewayInboundEvent): boolean {
  return Boolean((event.message.text ?? "").trim()) || event.message.media.length > 0;
}

function inboundMediaPreviewUrl(event: GatewayInboundEvent, mimeType: string | null | undefined): string | null {
  if (!mimeType?.startsWith("image/")) return null;
  for (const container of [objectRecord(event.raw_event?.Message), objectRecord(event.raw_event?.Raw), objectRecord(event.raw_event)]) {
    const image = objectRecord(container.imageMessage ?? container.ImageMessage);
    const thumbnail = stringField(image, "jpegThumbnail") ?? stringField(image, "JPEGThumbnail");
    if (thumbnail) return `data:image/jpeg;base64,${thumbnail}`;
  }
  return null;
}

const gatewayServiceProcedure = publicProcedure.use(({ ctx, next }) => {
  const expected = getSettings().GATEWAY_SERVICE_TOKEN;
  if (!expected) return next();
  const actual = extractBearerToken(ctx.headers.get("authorization"));
  if (actual !== expected) {
    throw new TRPCError({ code: "FORBIDDEN", message: "invalid gateway service token" });
  }
  return next();
});

export const gatewayRouter = createTRPCRouter({
  inbound: createTRPCRouter({
    ingest: gatewayServiceProcedure.input(gatewayInboundEventSchema).mutation(async ({ ctx, input }) =>
      ingestGatewayInbound(ctx.rootDb, ctx.enqueueJob ?? missingEnqueueJob, input, ctx.runtimeChatQueue),
    ),
  }),
  outbound: createTRPCRouter({
    status: gatewayServiceProcedure.input(gatewayOutboundStatusEventSchema).mutation(async ({ ctx, input }) =>
      recordGatewayOutboundStatus(ctx.rootDb, input),
    ),
  }),
});

export async function ingestGatewayInbound(
  database: Database,
  enqueueJob: EnqueueKuunaJob,
  event: GatewayInboundEvent,
  runtimeChatQueue?: RuntimeChatTaskQueueClient,
): Promise<GatewayInboundAck> {
  const occurredAt = new Date(event.occurred_at);
  const agentMentionIds = await loadGroupBotMentionIds(database, event.provider_group_id);
  const triggerDecision = evaluateTrigger(event, {
    agentMentionIds,
    replyToAgent: await isReplyToKnownBotOutbound(
      database,
      event.provider_group_id,
      event.message.reply_to_provider_message_id,
    ),
  });

  const result = await database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.providerGroupId, event.provider_group_id),
          eq(messages.providerMessageId, event.provider_message_id),
        ),
      )
      .limit(1);

    const [latestVersion] = existing
      ? await tx
          .select()
          .from(messageVersions)
          .where(eq(messageVersions.messageId, existing.id))
          .orderBy(desc(messageVersions.versionNo))
          .limit(1)
      : [];
    const [existingMedia] = existing
      ? await tx
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(eq(mediaAssets.messageId, existing.id))
          .limit(1)
      : [];
    const existingHasContent = Boolean((latestVersion?.textContent ?? "").trim()) || Boolean(existingMedia);
    const shouldFillContentlessDuplicate =
      Boolean(existing) && event.event_type === "message_created" && !existingHasContent && hasInboundContent(event);
    const deduped = Boolean(existing && event.event_type === "message_created" && !shouldFillContentlessDuplicate);
    const message =
      existing ??
      (
        await tx
          .insert(messages)
          .values({
            providerGroupId: event.provider_group_id,
            providerMessageId: event.provider_message_id,
            senderProviderUserId: event.sender_provider_user_id ?? null,
            latestVersionNo: 1,
          })
          .returning()
      )[0];

    if (!message) {
      throw new Error("failed to persist message");
    }

    if (!deduped) {
      const versionNo = existing ? existing.latestVersionNo + 1 : 1;
      await tx.insert(messageVersions).values({
        messageId: message.id,
        versionNo,
        eventType: event.event_type,
        isDeleted: event.event_type === "message_deleted",
        textContent: event.message.text ?? null,
        rawEvent: event.raw_event ?? {},
        occurredAt,
      });

      await tx
        .update(messages)
        .set({ latestVersionNo: versionNo, updatedAt: new Date() })
        .where(eq(messages.id, message.id));

      await tx.insert(messageDecisions).values({
        messageId: message.id,
        providerGroupId: event.provider_group_id,
        decisionType: triggerDecision.triggerType ?? "ignore",
        reason: triggerDecision.reason,
        shouldExecute: triggerDecision.shouldExecute,
        payload: {
          trace_id: event.trace_id,
          provider_message_id: event.provider_message_id,
          event_type: event.event_type,
        },
      });
    }

    const [activeBinding] = await tx
      .select({ id: groupBindings.id })
      .from(groupBindings)
      .where(and(eq(groupBindings.providerGroupId, event.provider_group_id), eq(groupBindings.status, "active")))
      .limit(1);

    const mediaAssetIds: string[] = [];
    const messageLinkIds: string[] = [];

    if (!deduped) {
      for (const media of event.message.media) {
        const [asset] = await tx
          .insert(mediaAssets)
          .values({
            messageId: message.id,
            providerMediaId: media.provider_media_id,
            mimeType: media.mime_type ?? "application/octet-stream",
            fileName: media.file_name ?? null,
            byteSize: media.byte_size ?? null,
            status: "pending",
            metadataJson: {
              kind: mediaKindFromMimeType(media.mime_type),
              download_url: media.download_url ?? null,
              inline_data_base64: media.inline_data_base64 ?? null,
              preview_url: inboundMediaPreviewUrl(event, media.mime_type),
            },
          })
          .returning({ id: mediaAssets.id });
        if (asset) {
          mediaAssetIds.push(asset.id);
        }
      }

      for (const url of extractUrls(event.message.text ?? null)) {
        const [link] = await tx
          .insert(messageLinks)
          .values({
            messageId: message.id,
            providerGroupId: event.provider_group_id,
            url,
            normalizedUrl: normalizeUrl(url),
            metadataJson: { trace_id: event.trace_id },
          })
          .onConflictDoNothing()
          .returning({ id: messageLinks.id });
        if (link) {
          messageLinkIds.push(link.id);
        }
      }
    }

    return {
      messageId: message.id,
      deduped,
      activeBinding: Boolean(activeBinding),
      mediaAssetIds,
      messageLinkIds,
    };
  });

  if (!result.deduped) {
    for (const mediaAssetId of result.mediaAssetIds) {
      await enqueueJob(
        "media_processing",
        { media_asset_id: mediaAssetId, trace_id: event.trace_id },
        `media_processing_${jobToken(mediaAssetId)}`,
      );
    }
    await enqueueJob(
      "retrieval_indexing",
      { source_type: "message", source_id: result.messageId, trace_id: event.trace_id },
      `retrieval_indexing_message_${jobToken(result.messageId)}_${jobToken(event.trace_id)}`,
    );
    for (const messageLinkId of result.messageLinkIds) {
      await enqueueJob(
        "retrieval_indexing",
        { source_type: "message_link", source_id: messageLinkId, trace_id: event.trace_id },
        `retrieval_indexing_message_link_${jobToken(messageLinkId)}_${jobToken(event.trace_id)}`,
      );
    }
    if (event.event_type !== "message_deleted" && result.activeBinding) {
      await ensureAutomaticFollowupTodo(database, {
        providerGroupId: event.provider_group_id,
        messageId: result.messageId,
        traceId: event.trace_id,
      });
    }
    if (event.event_type !== "message_deleted" && result.activeBinding && result.mediaAssetIds.length === 0) {
      await enqueueRuntimeChatTask(
        {
          name: "passive_message_analysis",
          messageId: result.messageId,
          providerGroupId: event.provider_group_id,
          reason: triggerDecision.reason,
          traceId: event.trace_id,
        },
        { enqueueJob, redis: runtimeChatQueue },
      );
    }
    if (triggerDecision.shouldExecute && event.event_type !== "message_deleted" && result.activeBinding) {
      await enqueueRuntimeChatTask(
        {
          name: "inbound_execution",
          messageId: result.messageId,
          providerGroupId: event.provider_group_id,
          reason: triggerDecision.reason,
          traceId: event.trace_id,
        },
        { enqueueJob, redis: runtimeChatQueue },
      );
    }
  }

  logger.info("gateway_inbound_accepted", {
    trace_id: event.trace_id,
    provider_group_id: event.provider_group_id,
    provider_message_id: event.provider_message_id,
    event_type: event.event_type,
    deduped: result.deduped,
    trigger_reason: triggerDecision.reason,
    trigger_type: triggerDecision.triggerType,
  });
  if (!result.deduped) {
    await publishRuntimeEvent({
      type: "message.created",
      providerGroupId: event.provider_group_id,
      traceId: event.trace_id,
      entityId: result.messageId,
      entityType: "message",
      payload: {
        provider_message_id: event.provider_message_id,
        event_type: event.event_type,
      },
    });
    await publishRuntimeEvent({
      type: "message.decision",
      providerGroupId: event.provider_group_id,
      traceId: event.trace_id,
      entityId: result.messageId,
      entityType: "message",
      payload: {
        decision_type: triggerDecision.triggerType ?? "ignore",
        should_execute: triggerDecision.shouldExecute,
        reason: triggerDecision.reason,
      },
    });
    for (const mediaAssetId of result.mediaAssetIds) {
      await publishRuntimeEvent({
        type: "media.updated",
        providerGroupId: event.provider_group_id,
        traceId: event.trace_id,
        entityId: mediaAssetId,
        entityType: "media_asset",
        payload: { status: "pending", message_id: result.messageId },
      });
    }
  }

  return {
    accepted: true,
    trace_id: event.trace_id,
    deduped: result.deduped,
    execution_enqueued:
      !result.deduped && result.activeBinding && event.event_type !== "message_deleted" && triggerDecision.shouldExecute,
  };
}

async function loadGroupBotMentionIds(database: Database, providerGroupId: string): Promise<string[]> {
  const rows = await database
    .select({
      providerUserId: groupMembers.providerUserId,
      derivedPhone: groupMembers.derivedPhone,
      phoneOverride: groupMembers.phoneOverride,
      gatewayMetadata: groupMembers.gatewayMetadata,
    })
    .from(groupMembers)
    .where(and(eq(groupMembers.providerGroupId, providerGroupId), eq(groupMembers.role, "bot")));

  return rows.flatMap((row) =>
    [
      row.providerUserId,
      row.derivedPhone,
      row.phoneOverride,
      stringField(objectRecord(row.gatewayMetadata), "phone_number_jid"),
    ].filter(isPresentString),
  );
}

async function isReplyToKnownBotOutbound(
  database: Database,
  providerGroupId: string,
  replyToProviderMessageId: string | null | undefined,
): Promise<boolean> {
  if (!replyToProviderMessageId) return false;
  const [row] = await database
    .select({ id: outboundIntents.id })
    .from(outboundIntents)
    .where(
      and(
        eq(outboundIntents.providerGroupId, providerGroupId),
        sql`${outboundIntents.payload}->'_dispatch'->>'provider_message_id' = ${replyToProviderMessageId}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

function isPresentString(value: string | null): value is string {
  return Boolean(value?.trim());
}

export async function recordGatewayOutboundStatus(
  database: Database,
  event: GatewayOutboundStatusEvent,
): Promise<{ accepted: true; found: boolean }> {
  const [intent] = await database
    .select()
    .from(outboundIntents)
    .where(eq(outboundIntents.outboundIntentId, event.outbound_intent_id))
    .limit(1);

  if (!intent) {
    logger.warn("gateway_outbound_intent_not_found", {
      trace_id: event.trace_id,
      outbound_intent_id: event.outbound_intent_id,
      status: event.status,
    });
    return { accepted: true, found: false };
  }

  await database
    .update(outboundIntents)
    .set({
      status: event.status === "retrying" ? "sending" : event.status,
      payload: {
        ...(intent.payload as Record<string, unknown>),
        _dispatch: {
          provider_message_id: event.provider_message_id ?? null,
          last_error_code: event.error_code ?? null,
          last_error_message: event.error_message ?? null,
          last_status: event.status,
          occurred_at: event.occurred_at,
        },
      },
      updatedAt: new Date(event.occurred_at),
    })
    .where(eq(outboundIntents.id, intent.id));
  await publishRuntimeEvent({
    type: "outbound_intent.updated",
    providerGroupId: intent.providerGroupId,
    traceId: event.trace_id,
    entityId: intent.outboundIntentId,
    entityType: "outbound_intent",
    payload: {
      status: event.status,
      provider_message_id: event.provider_message_id ?? null,
      error_code: event.error_code ?? null,
    },
  });

  return { accepted: true, found: true };
}

function extractUrls(text: string | null): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>()]+/gi) ?? [];
  return Array.from(new Set(matches.map((url) => url.replace(/[.,;:!?)\]}]+$/, ""))));
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function jobToken(value: string): string {
  return value.replaceAll("-", "_").replaceAll(" ", "_");
}

function extractBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const prefix = "bearer ";
  if (!authorization.toLowerCase().startsWith(prefix)) return null;
  return authorization.slice(prefix.length).trim() || null;
}

async function missingEnqueueJob(): Promise<string> {
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "enqueue job dependency unavailable" });
}
