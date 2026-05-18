import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { groupMembers, mediaAssets, messageVersions, messages, transcripts } from "../../db/schema.js";
import { createPresignedGetUrl } from "../../integrations/s3.js";
import { createTRPCRouter, protectedProcedure } from "../init.js";

type MessageRow = typeof messages.$inferSelect;
type MessageVersionRow = typeof messageVersions.$inferSelect;
type MediaAssetRow = typeof mediaAssets.$inferSelect;
type TranscriptRow = typeof transcripts.$inferSelect;

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function mapMessageListRow(
  message: MessageRow,
  latestVersion: MessageVersionRow | undefined,
  messageIdsWithMedia: Set<string>,
  member?: typeof groupMembers.$inferSelect,
) {
  return {
    id: message.id,
    provider_group_id: message.providerGroupId,
    provider_message_id: message.providerMessageId,
    sender_provider_user_id: message.senderProviderUserId,
    sender_display_name: member?.displayName ?? null,
    sender_phone: member?.phoneOverride ?? member?.derivedPhone ?? null,
    sender_push_name: member?.pushName ?? null,
    latest_version_no: message.latestVersionNo,
    latest_text: latestVersion?.textContent ?? null,
    latest_raw_event: latestVersion?.rawEvent ?? null,
    latest_is_deleted: latestVersion?.isDeleted ?? false,
    has_media: messageIdsWithMedia.has(message.id),
    created_at: message.createdAt.toISOString(),
    updated_at: message.updatedAt.toISOString(),
  };
}

function mapMessageVersionRead(version: MessageVersionRow) {
  return {
    id: version.id,
    message_id: version.messageId,
    version_no: version.versionNo,
    event_type: version.eventType,
    is_deleted: version.isDeleted,
    text: version.textContent,
    raw_event: version.rawEvent,
    occurred_at: version.occurredAt.toISOString(),
    created_at: version.createdAt.toISOString(),
  };
}

async function mapMediaAssetRead(asset: MediaAssetRow, transcript: TranscriptRow | undefined) {
  const metadata = objectRecord(asset.metadataJson);
  const objectUrl = stringField(metadata, "object_url");
  const downloadUrl =
    objectUrl && asset.s3Key
      ? (await createPresignedGetUrl({ objectKey: asset.s3Key })) ?? objectUrl
      : objectUrl;
  const previewUrl =
    stringField(metadata, "preview_url") ??
    (asset.mimeType.startsWith("image/") ? downloadUrl : null);
  return {
    id: asset.id,
    message_id: asset.messageId,
    provider_media_id: asset.providerMediaId,
    mime_type: asset.mimeType,
    file_name: asset.fileName,
    byte_size: asset.byteSize,
    status: asset.status,
    s3_key: asset.s3Key,
    preview_url: previewUrl,
    download_url: downloadUrl,
    transcript: transcript?.textContent ?? null,
    created_at: asset.createdAt.toISOString(),
    updated_at: asset.updatedAt.toISOString(),
  };
}

export const messagesRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ providerGroupId: z.string().optional(), limit: z.number().int().min(1).max(200).default(100) }).default({ limit: 100 }))
    .query(async ({ ctx, input }) => {
      if (!ctx.auth) {
        return [];
      }

      let rows: MessageRow[];
      if (input.providerGroupId) {
        rows = await ctx.db
          .select()
          .from(messages)
          .where(eq(messages.providerGroupId, input.providerGroupId))
          .orderBy(desc(messages.createdAt))
          .limit(input.limit);
      } else if (ctx.auth.role === "owner" || ctx.auth.role === "admin") {
        rows = await ctx.db.select().from(messages).orderBy(desc(messages.createdAt)).limit(input.limit);
      } else if (ctx.auth.groupScope.length > 0) {
        rows = await ctx.db
          .select()
          .from(messages)
          .where(inArray(messages.providerGroupId, ctx.auth.groupScope))
          .orderBy(desc(messages.createdAt))
          .limit(input.limit);
      } else {
        rows = [];
      }

      const messageIds = rows.map((message) => message.id);
      const versionRows =
        messageIds.length > 0
          ? await ctx.db
              .select()
              .from(messageVersions)
              .where(inArray(messageVersions.messageId, messageIds))
              .orderBy(desc(messageVersions.versionNo))
          : [];
      const latestByMessageId = new Map<string, MessageVersionRow>();
      for (const version of versionRows) {
        if (!latestByMessageId.has(version.messageId)) {
          latestByMessageId.set(version.messageId, version);
        }
      }

      const mediaRows =
        messageIds.length > 0
          ? await ctx.db
              .select({ messageId: mediaAssets.messageId })
              .from(mediaAssets)
              .where(inArray(mediaAssets.messageId, messageIds))
          : [];
      const messageIdsWithMedia = new Set(mediaRows.map((row) => row.messageId));
      const memberRows = rows.length > 0
        ? await ctx.db
            .select()
            .from(groupMembers)
            .where(
              inArray(
                groupMembers.providerGroupId,
                Array.from(new Set(rows.map((message) => message.providerGroupId))),
              ),
            )
        : [];
      const membersByGroupAndSender = new Map(
        memberRows.map((member) => [`${member.providerGroupId}\n${member.providerUserId}`, member]),
      );

      return rows.map((message) =>
        mapMessageListRow(
          message,
          latestByMessageId.get(message.id),
          messageIdsWithMedia,
          message.senderProviderUserId
            ? membersByGroupAndSender.get(`${message.providerGroupId}\n${message.senderProviderUserId}`)
            : undefined,
        ),
      );
    }),

  conversation: protectedProcedure
    .input(z.object({ providerGroupId: z.string(), limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.auth) {
        return [];
      }

      const rows = await ctx.db
        .select()
        .from(messages)
        .where(eq(messages.providerGroupId, input.providerGroupId))
        .orderBy(desc(messages.createdAt))
        .limit(input.limit);

      const messageIds = rows.map((message) => message.id);
      const versionRows =
        messageIds.length > 0
          ? await ctx.db
              .select()
              .from(messageVersions)
              .where(inArray(messageVersions.messageId, messageIds))
              .orderBy(desc(messageVersions.versionNo))
          : [];
      const versionsByMessageId = new Map<string, ReturnType<typeof mapMessageVersionRead>[]>();
      const latestByMessageId = new Map<string, MessageVersionRow>();
      for (const version of versionRows) {
        const mapped = mapMessageVersionRead(version);
        versionsByMessageId.set(version.messageId, [...(versionsByMessageId.get(version.messageId) ?? []), mapped]);
        if (!latestByMessageId.has(version.messageId)) {
          latestByMessageId.set(version.messageId, version);
        }
      }

      const mediaRows =
        messageIds.length > 0
          ? await ctx.db
              .select()
              .from(mediaAssets)
              .where(inArray(mediaAssets.messageId, messageIds))
              .orderBy(desc(mediaAssets.createdAt))
          : [];
      const transcriptRows =
        mediaRows.length > 0
          ? await ctx.db
              .select()
              .from(transcripts)
              .where(inArray(transcripts.mediaAssetId, mediaRows.map((row) => row.id)))
          : [];
      const transcriptByMediaId = new Map(transcriptRows.map((row) => [row.mediaAssetId, row]));
      const mediaByMessageId = new Map<string, Awaited<ReturnType<typeof mapMediaAssetRead>>[]>();
      for (const asset of mediaRows) {
        const mapped = await mapMediaAssetRead(asset, transcriptByMediaId.get(asset.id));
        mediaByMessageId.set(asset.messageId, [...(mediaByMessageId.get(asset.messageId) ?? []), mapped]);
      }

      const memberRows = rows.length > 0
        ? await ctx.db
            .select()
            .from(groupMembers)
            .where(
              inArray(
                groupMembers.providerGroupId,
                Array.from(new Set(rows.map((message) => message.providerGroupId))),
              ),
            )
        : [];
      const membersByGroupAndSender = new Map(
        memberRows.map((member) => [`${member.providerGroupId}\n${member.providerUserId}`, member]),
      );
      const messageIdsWithMedia = new Set(mediaRows.map((row) => row.messageId));

      return rows.map((message) => ({
        message: mapMessageListRow(
          message,
          latestByMessageId.get(message.id),
          messageIdsWithMedia,
          message.senderProviderUserId
            ? membersByGroupAndSender.get(`${message.providerGroupId}\n${message.senderProviderUserId}`)
            : undefined,
        ),
        versions: versionsByMessageId.get(message.id) ?? [],
        media: mediaByMessageId.get(message.id) ?? [],
      }));
    }),

  versions: protectedProcedure
    .input(z.object({ messageId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(messageVersions)
        .where(eq(messageVersions.messageId, input.messageId))
        .orderBy(desc(messageVersions.versionNo));
      return rows.map(mapMessageVersionRead);
    }),

  media: protectedProcedure
    .input(z.object({ messageId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.messageId, input.messageId))
        .orderBy(desc(mediaAssets.createdAt));
      const transcriptRows =
        rows.length > 0
          ? await ctx.db
              .select()
              .from(transcripts)
              .where(inArray(transcripts.mediaAssetId, rows.map((row) => row.id)))
          : [];
      const transcriptByMediaId = new Map(transcriptRows.map((row) => [row.mediaAssetId, row]));
      return Promise.all(rows.map((asset) => mapMediaAssetRead(asset, transcriptByMediaId.get(asset.id))));
    }),
});
