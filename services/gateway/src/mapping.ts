import { randomUUID } from "node:crypto";

import type { GatewayInboundEvent, GatewayInboundMedia, GatewayEventType } from "./types.js";

type AnyRecord = Record<string, unknown>;

const mediaFields: Array<{ keys: string[]; kind: string }> = [
  { keys: ["imageMessage", "ImageMessage", "image_message"], kind: "image" },
  { keys: ["videoMessage", "VideoMessage", "video_message"], kind: "video" },
  { keys: ["audioMessage", "AudioMessage", "audio_message"], kind: "audio" },
  { keys: ["documentMessage", "DocumentMessage", "document_message"], kind: "document" },
  { keys: ["stickerMessage", "StickerMessage", "sticker_message"], kind: "sticker" },
];

export function mapBaileysMessage(message: AnyRecord): GatewayInboundEvent {
  const key = objectRecord(message.key);
  const providerMessageId = stringValue(key.id) || randomUUID();
  const providerGroupId = stringValue(key.remoteJid) || "";
  const senderProviderUserId = resolveSenderProviderUserId(key, providerGroupId);
  const content = objectRecord(message.message);
  const eventType = classifyEventType(content);
  const contentMessage = resolveMessageContent(content);
  const replyToProviderMessageId = extractReplyToProviderMessageId(contentMessage);
  const replyToProviderUserId = extractReplyToProviderUserId(contentMessage);
  const deletedTargetId = eventType === "message_deleted" ? extractDeletedTargetMessageId(content) : null;
  const finalProviderMessageId = deletedTargetId || providerMessageId;

  return {
    trace_id: randomUUID(),
    provider: "whatsapp-baileys",
    provider_group_id: providerGroupId,
    provider_message_id: finalProviderMessageId,
    sender_provider_user_id: senderProviderUserId,
    event_type: eventType,
    occurred_at: timestampToIso(message.messageTimestamp),
    message: {
      text: extractText(contentMessage),
      reply_to_provider_message_id: replyToProviderMessageId,
      reply_to_provider_user_id: replyToProviderUserId,
      mentions: extractMentions(contentMessage),
      media: extractMedia(contentMessage, finalProviderMessageId),
    },
    raw_event: {
      key: toJsonable(key),
      message: toJsonable(content),
      Message: toJsonable(contentMessage),
      Raw: toJsonable(message),
    },
  };
}

export function isSelfMessage(message: AnyRecord): boolean {
  return objectRecord(message.key).fromMe === true;
}

function resolveSenderProviderUserId(key: AnyRecord, providerGroupId: string): string | null {
  const participant = stringValue(key.participant) || stringValue(key.participantPn);
  if (participant) return participant;
  if (key.fromMe === true) return null;
  const remoteJid = stringValue(key.remoteJid);
  if (!remoteJid || remoteJid === providerGroupId) return null;
  return remoteJid;
}

function classifyEventType(messageObj: AnyRecord): GatewayEventType {
  if (isDeletedIndication(messageObj)) return "message_deleted";
  if (isEditedIndication(messageObj)) return "message_edited";
  return "message_created";
}

function isDeletedIndication(messageObj: AnyRecord): boolean {
  const protocolMessage = objectRecord(fieldValue(messageObj, ["protocolMessage", "ProtocolMessage"]));
  if (!Object.keys(protocolMessage).length) return false;
  const type = protocolMessage.type;
  if (typeof type === "number") return type === 0;
  const typeName = String(type ?? "").toUpperCase();
  return typeName.includes("REVOKE") || (typeName.includes("DELETE") && !typeName.includes("EDIT"));
}

function isEditedIndication(messageObj: AnyRecord): boolean {
  if (fieldValue(messageObj, ["editedMessage", "EditedMessage"])) return true;
  const protocolMessage = objectRecord(fieldValue(messageObj, ["protocolMessage", "ProtocolMessage"]));
  if (!Object.keys(protocolMessage).length) return false;
  if (fieldValue(protocolMessage, ["editedMessage", "EditedMessage"])) return true;
  const type = protocolMessage.type;
  if (typeof type === "number") return type === 14;
  return String(type ?? "").toUpperCase().includes("EDIT");
}

function extractDeletedTargetMessageId(messageObj: AnyRecord): string | null {
  const protocolMessage = objectRecord(fieldValue(messageObj, ["protocolMessage", "ProtocolMessage"]));
  const key = objectRecord(fieldValue(protocolMessage, ["key", "Key"]));
  return (
    stringValue(fieldValue(key, ["id", "ID", "Id", "stanzaId", "stanzaID"])) ||
    stringValue(protocolMessage.messageKey) ||
    null
  );
}

function resolveMessageContent(messageObj: AnyRecord): AnyRecord {
  for (const wrapperKey of [
    "ephemeralMessage",
    "EphemeralMessage",
    "ephemeral_message",
    "viewOnceMessage",
    "ViewOnceMessage",
    "view_once_message",
    "viewOnceMessageV2",
    "ViewOnceMessageV2",
    "view_once_message_v2",
    "documentWithCaptionMessage",
    "DocumentWithCaptionMessage",
    "document_with_caption_message",
  ]) {
    const wrapper = objectRecord(fieldValue(messageObj, [wrapperKey]));
    const nested = objectRecord(fieldValue(wrapper, ["message", "Message"]));
    if (Object.keys(nested).length) return resolveMessageContent(nested);
  }

  const directEditedMessage = objectRecord(fieldValue(messageObj, ["editedMessage", "EditedMessage"]));
  const directEditedNested = objectRecord(fieldValue(directEditedMessage, ["message", "Message"]));
  if (Object.keys(directEditedNested).length) return directEditedNested;

  const protocolMessage = objectRecord(fieldValue(messageObj, ["protocolMessage", "ProtocolMessage"]));
  const protocolEdited = objectRecord(fieldValue(protocolMessage, ["editedMessage", "EditedMessage"]));
  const protocolEditedNested = objectRecord(fieldValue(protocolEdited, ["message", "Message"]));
  if (Object.keys(protocolEditedNested).length) return protocolEditedNested;
  if (Object.keys(protocolEdited).length) return protocolEdited;

  return messageObj;
}

function extractText(messageObj: AnyRecord): string | null {
  const direct = stringValue(fieldValue(messageObj, ["conversation", "Conversation"]));
  if (direct) return direct;

  const extendedTextMessage = objectRecord(
    fieldValue(messageObj, ["extendedTextMessage", "ExtendedTextMessage", "extended_text_message"]),
  );
  const extended = stringValue(fieldValue(extendedTextMessage, ["text", "Text"]));
  if (extended) return extended;

  for (const media of mediaFields) {
    for (const key of media.keys) {
      const mediaObj = objectRecord(fieldValue(messageObj, [key]));
      const caption = stringValue(fieldValue(mediaObj, ["caption", "Caption"]));
      if (caption) return caption;
    }
  }

  return null;
}

function extractReplyToProviderMessageId(messageObj: AnyRecord): string | null {
  const context = extractContextInfo(messageObj);
  return stringValue(fieldValue(context, ["stanzaId", "stanzaID", "StanzaID", "StanzaId"])) || null;
}

function extractReplyToProviderUserId(messageObj: AnyRecord): string | null {
  const context = extractContextInfo(messageObj);
  return stringValue(fieldValue(context, ["participant", "Participant", "participantPn", "participantPN"])) || null;
}

function extractMentions(messageObj: AnyRecord): string[] {
  const context = extractContextInfo(messageObj);
  const mentioned = fieldValue(context, ["mentionedJid", "mentionedJID", "mentionedJID", "MentionedJID"]);
  if (!Array.isArray(mentioned)) return [];
  return mentioned.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
}

function extractContextInfo(messageObj: AnyRecord): AnyRecord {
  const candidates: AnyRecord[] = [messageObj];
  for (const media of mediaFields) {
    for (const key of media.keys) {
      candidates.push(objectRecord(fieldValue(messageObj, [key])));
    }
  }
  candidates.push(
    objectRecord(fieldValue(messageObj, ["extendedTextMessage", "ExtendedTextMessage", "extended_text_message"])),
  );

  for (const candidate of candidates) {
    const context = objectRecord(fieldValue(candidate, ["contextInfo", "ContextInfo", "context_info"]));
    if (Object.keys(context).length) return context;
  }
  return {};
}

function extractMedia(messageObj: AnyRecord, providerMessageId: string): GatewayInboundMedia[] {
  const items: GatewayInboundMedia[] = [];
  for (const media of mediaFields) {
    const mediaObj = findMediaObject(messageObj, media.keys);
    if (!mediaObj || !hasMediaPayload(mediaObj)) continue;

    const mimeType =
      stringValue(fieldValue(mediaObj, ["mimetype", "mimeType", "Mimetype", "MimeType"])) ||
      `application/${media.kind}`;
    const fileName = stringValue(fieldValue(mediaObj, ["fileName", "FileName"]));
    const byteSize = numberValue(fieldValue(mediaObj, ["fileLength", "FileLength"]));
    const downloadUrl = stringValue(fieldValue(mediaObj, ["url", "URL"]));
    const providerMediaId =
      stringValue(fieldValue(mediaObj, ["mediaKey", "MediaKey"])) ||
      stringValue(fieldValue(mediaObj, ["fileSha256", "FileSha256", "fileSHA256", "FileSHA256"])) ||
      `${providerMessageId}:${media.kind}`;

    items.push({
      provider_media_id: providerMediaId,
      mime_type: mimeType,
      file_name: fileName,
      byte_size: byteSize,
      download_url: downloadUrl,
    });
  }
  return items;
}

function findMediaObject(messageObj: AnyRecord, keys: string[]): AnyRecord | null {
  for (const key of keys) {
    const candidate = objectRecord(fieldValue(messageObj, [key]));
    if (Object.keys(candidate).length) return candidate;
  }
  return null;
}

function hasMediaPayload(mediaObj: AnyRecord): boolean {
  const signals = [
    fieldValue(mediaObj, ["url", "URL"]),
    fieldValue(mediaObj, ["directPath", "DirectPath"]),
    fieldValue(mediaObj, ["mediaKey", "MediaKey"]),
    fieldValue(mediaObj, ["fileLength", "FileLength"]),
    fieldValue(mediaObj, ["mimetype", "mimeType", "Mimetype", "MimeType"]),
    fieldValue(mediaObj, ["fileSha256", "FileSha256", "fileSHA256", "FileSHA256"]),
    fieldValue(mediaObj, ["fileEncSha256", "FileEncSha256", "fileEncSHA256", "FileEncSHA256"]),
    fieldValue(mediaObj, ["jpegThumbnail", "JPEGThumbnail"]),
    fieldValue(mediaObj, ["fileName", "FileName"]),
    fieldValue(mediaObj, ["caption", "Caption"]),
  ];
  return signals.some((signal) => !isEmptyValue(signal));
}

function fieldValue(obj: AnyRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  const lowered = new Map(Object.entries(obj).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lowered.get(key.toLowerCase());
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function timestampToIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (typeof value === "bigint") return new Date(Number(value) * 1000).toISOString();
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return new Date(Number(value.toNumber()) * 1000).toISOString();
  }
  return new Date().toISOString();
}

function objectRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value).toString("base64") || null;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && "toString" in value) {
    const rendered = String(value);
    return rendered && rendered !== "[object Object]" ? rendered : null;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "bigint" && value > 0n) return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    const parsed = Number(value.toNumber());
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
  }
  return null;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return value.byteLength === 0;
  if (typeof value === "string" && ["0", "0.0", "b''", "[]", "{}"].includes(value.trim())) return true;
  if (typeof value === "number" && value <= 0) return true;
  return false;
}

function toJsonable(value: unknown, depth = 0): unknown {
  if (depth > 8) return stringValue(value) ?? String(value);
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map((item) => toJsonable(item, depth + 1));
  if (typeof value === "object") {
    if ("toJSON" in value && typeof value.toJSON === "function") {
      return toJsonable(value.toJSON(), depth + 1);
    }
    return Object.fromEntries(
      Object.entries(value as AnyRecord)
        .filter(([key, item]) => !key.startsWith("_") && typeof item !== "function")
        .map(([key, item]) => [key, toJsonable(item, depth + 1)]),
    );
  }
  return String(value);
}
