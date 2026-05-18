import pino, { type Logger } from "pino";
import qrcode from "qrcode-terminal";

import { BackendIngestClient } from "./backend.js";
import { mapBaileysMessage, isSelfMessage } from "./mapping.js";
import { GatewayConnectionStatus, GatewayQrStatus } from "./status.js";
import type {
  ConnectionSnapshot,
  GatewayClient,
  GatewayGroup,
  GatewayGroupParticipant,
  GatewayInboundEvent,
  GatewaySelfIdentity,
  QrSnapshot,
} from "./types.js";

type AnyRecord = Record<string, unknown>;
type BaileysModule = typeof import("@whiskeysockets/baileys");
type HistorySyncNotification = import("@whiskeysockets/baileys").proto.Message.IHistorySyncNotification;
type WASocket = import("@whiskeysockets/baileys").WASocket;
type WAMessage = import("@whiskeysockets/baileys").WAMessage;
type MessagingHistorySetEvent = {
  chats?: unknown[];
  contacts?: unknown[];
  messages?: WAMessage[];
  isLatest?: boolean;
  progress?: number | null;
  syncType?: unknown;
  peerDataRequestSessionId?: string | null;
};

export class BaileysGateway implements GatewayClient {
  private socket: WASocket | null = null;
  private module: BaileysModule | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly gatewayOutboundMessageIds = new Set<string>();
  private stopping = false;
  private starting: Promise<void> | null = null;
  private readonly logger: Logger;

  constructor(
    private readonly input: {
      authDir: string;
      sessionName: string;
      backendClient: BackendIngestClient;
      connectionStatus: GatewayConnectionStatus;
      qrStatus: GatewayQrStatus;
      logLevel?: string;
      printQrToConsole?: boolean;
      syncFullHistory?: boolean;
      processHistorySync?: boolean;
      qrRenderer?: (qr: string) => void;
      socketFactory?: (config: unknown) => WASocket;
      baileysModule?: BaileysModule;
    },
  ) {
    this.logger = pino({ level: input.logLevel ?? "info" });
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.openSocket().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.end(new Error("gateway stopped"));
      this.socket = null;
    }
  }

  async listGroups(): Promise<GatewayGroup[]> {
    const socket = this.requireSocket();
    const groups = await socket.groupFetchAllParticipating();
    return (Object.values(groups) as Array<{ id: string; subject?: string; participants?: unknown[] }>)
      .map((group) => ({
        jid: group.id,
        name: group.subject?.trim() || group.id,
        participants_count: group.participants?.length ?? 0,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createGroup(name: string, participants: string[]): Promise<GatewayGroup> {
    const socket = this.requireSocket();
    const group = await socket.groupCreate(name, participants);
    return {
      jid: group.id,
      name: group.subject?.trim() || name,
      participants_count: group.participants?.length ?? participants.length,
    };
  }

  async listGroupParticipants(providerGroupId: string): Promise<GatewayGroupParticipant[]> {
    const socket = this.requireSocket();
    const metadata = await socket.groupMetadata(providerGroupId);
    const participants = Array.isArray(metadata.participants) ? metadata.participants : [];
    const self = this.selfIdentity();
    const selfJid = self.jid;
    const mapped = participants
      .map((participant) => mapGroupParticipant(participant, selfJid, self.phone))
      .filter((participant): participant is GatewayGroupParticipant => Boolean(participant))
      .sort((left, right) => left.jid.localeCompare(right.jid));
    if (selfJid && !mapped.some((participant) => participant.is_self || samePhone(participant.phone, self.phone) || sameWhatsAppUser(participant.jid, selfJid))) {
      mapped.push({
        jid: selfJid,
        phone: self.phone,
        display_name: self.display_name,
        is_admin: null,
        is_self: true,
        metadata: { source: "socket_user" },
      });
    }
    return mapped.sort((left, right) => Number(right.is_self) - Number(left.is_self) || left.jid.localeCompare(right.jid));
  }

  selfIdentity(): GatewaySelfIdentity {
    const socket = this.socket;
    const user = objectRecord(socket?.user);
    const jid = normalizeUserJid(stringValue(user.id));
    return {
      jid,
      phone: phoneFromJid(jid),
      display_name: stringValue(user.name ?? user.notify ?? user.verifiedName),
      metadata: {
        lid: stringValue(user.lid),
        phone_number_jid: normalizeUserJid(stringValue(user.phoneNumber)),
      },
    };
  }

  async sendText(input: {
    providerGroupId: string;
    text: string;
    replyToProviderMessageId?: string | null;
  }): Promise<string | null> {
    const socket = this.requireSocket();
    const response = await socket.sendMessage(input.providerGroupId, { text: input.text });
    const providerMessageId = response?.key?.id ?? null;
    if (providerMessageId) {
      this.rememberGatewayOutboundMessage(providerMessageId);
    }
    return providerMessageId;
  }

  connectionSnapshot(): ConnectionSnapshot {
    return this.input.connectionStatus.snapshot();
  }

  qrSnapshot(): QrSnapshot {
    return this.input.qrStatus.snapshot();
  }

  private async openSocket(): Promise<void> {
    this.stopping = false;
    this.input.connectionStatus.markDisconnected("connecting");
    const baileys = await this.loadBaileys();
    const { state, saveCreds } = await baileys.useMultiFileAuthState(this.input.authDir);
    this.saveCreds = saveCreds;
    const version = await this.resolveBaileysVersion(baileys);

    const socketFactory = this.input.socketFactory ?? ((config: unknown) => baileys.makeWASocket(config as never));
    const logger = this.logger.child({ component: "baileys" });
    const syncFullHistory = this.input.syncFullHistory === true;
    const processHistorySync = this.input.processHistorySync === true;
    const auth =
      typeof baileys.makeCacheableSignalKeyStore === "function"
        ? { creds: state.creds, keys: baileys.makeCacheableSignalKeyStore(state.keys, logger) }
        : state;

    this.logger.info({
      event: "gateway_history_sync_configured",
      sync_full_history: syncFullHistory,
      process_history_sync: processHistorySync,
    });

    const socket = socketFactory({
      auth,
      ...(version ? { version } : {}),
      logger,
      browser: baileys.Browsers.appropriate(this.input.sessionName),
      markOnlineOnConnect: false,
      syncFullHistory,
      shouldSyncHistoryMessage: (message: HistorySyncNotification) => {
        this.logger.info({
          event: "gateway_history_sync_notification_decision",
          sync_type: historySyncType(message.syncType),
          process: processHistorySync,
          sync_full_history: syncFullHistory,
        });
        return processHistorySync;
      },
      getMessage: async () => undefined,
    } as AnyRecord);
    this.socket = socket;
    this.registerHandlers(socket, baileys);
  }

  private async loadBaileys(): Promise<BaileysModule> {
    if (this.module) return this.module;
    this.module = this.input.baileysModule ?? (await import("@whiskeysockets/baileys"));
    return this.module;
  }

  private async resolveBaileysVersion(baileys: BaileysModule): Promise<unknown[] | null> {
    try {
      const result = await baileys.fetchLatestBaileysVersion();
      return result.version;
    } catch (error) {
      this.logger.warn({
        event: "gateway_baileys_version_lookup_failed",
        error: errorMessage(error),
      });
      return null;
    }
  }

  private registerHandlers(socket: WASocket, baileys: BaileysModule): void {
    socket.ev.on("connection.update", (update: AnyRecord) => {
      const qr = typeof update.qr === "string" ? update.qr : null;
      if (qr) {
        this.input.qrStatus.setQr(qr);
        this.input.connectionStatus.markDisconnected(
          "qr",
          "pairing required - scan the QR code printed in gateway logs or query gateway ops QR over tRPC",
        );
        this.printQr(qr);
      }

      if (update.connection === "open") {
        this.input.qrStatus.clear();
        this.input.connectionStatus.markConnected("connected");
        this.logger.info({ event: "gateway_connected" });
        return;
      }

      if (update.connection === "connecting") {
        this.input.connectionStatus.markDisconnected("connecting");
        return;
      }

      if (update.connection === "close") {
        const statusCode = disconnectStatusCode(update.lastDisconnect);
        const reason = errorMessage(update.lastDisconnect);
        const loggedOut = statusCode === baileys.DisconnectReason.loggedOut;
        this.input.connectionStatus.markDisconnected(loggedOut ? "logged_out" : "disconnected", reason);
        this.logger.warn({ event: "gateway_disconnected", status_code: statusCode, reason });
        if (!loggedOut && !this.stopping) {
          this.scheduleReconnect();
        }
      }
    });

    socket.ev.on("creds.update", () => {
      void this.saveCreds?.().catch((error) => {
        this.logger.error({ event: "gateway_creds_save_failed", error: errorMessage(error) });
      });
    });

    socket.ev.on("messages.upsert", (event: { messages?: unknown; type?: unknown }) => {
      const messages = Array.isArray(event.messages) ? (event.messages as WAMessage[]) : [];
      this.logger.info({
        event: "gateway_messages_upsert_received",
        upsert_type: typeof event.type === "string" ? event.type : null,
        message_count: messages.length,
      });
      void this.handleMessages(messages).catch((error) => {
        this.logger.error({ event: "gateway_messages_upsert_failed", error: errorMessage(error) });
      });
    });

    socket.ev.on("messaging-history.set", (event: MessagingHistorySetEvent) => {
      const messages = Array.isArray(event.messages) ? event.messages : [];
      const processHistorySync = this.input.processHistorySync === true;
      this.logger.info({
        event: "gateway_messaging_history_received",
        process: processHistorySync,
        sync_type: historySyncType(event.syncType),
        message_count: messages.length,
        chat_count: Array.isArray(event.chats) ? event.chats.length : 0,
        contact_count: Array.isArray(event.contacts) ? event.contacts.length : 0,
        is_latest: event.isLatest ?? null,
        progress: typeof event.progress === "number" ? event.progress : null,
        peer_data_request_session_id: event.peerDataRequestSessionId ?? null,
      });
      if (!processHistorySync) return;
      void this.handleMessages(messages).catch((error) => {
        this.logger.error({ event: "gateway_messaging_history_failed", error: errorMessage(error) });
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start().catch((error) => {
        this.input.connectionStatus.markDisconnected("reconnect_failed", errorMessage(error));
        this.logger.error({ event: "gateway_reconnect_failed", error: errorMessage(error) });
        this.scheduleReconnect();
      });
    }, 3000);
  }

  private async handleMessages(messages: WAMessage[]): Promise<void> {
    for (const message of messages) {
      const messageRecord = message as unknown as AnyRecord;
      const summary = messageSummary(messageRecord);
      if (!message.message) {
        this.logger.info({
          event: "gateway_inbound_skipped",
          reason: "missing_message_content",
          ...summary,
        });
        continue;
      }
      if (isSelfMessage(messageRecord) && summary.provider_message_id && this.gatewayOutboundMessageIds.has(summary.provider_message_id)) {
        this.logger.info({
          event: "gateway_inbound_skipped",
          reason: "known_gateway_outbound_echo",
          ...summary,
        });
        continue;
      }
      const payload = mapBaileysMessage(messageRecord);
      await this.attachOriginalMediaBytes(payload, message);
      if (!payload.provider_group_id) {
        this.logger.warn({
          event: "gateway_inbound_skipped",
          reason: "missing_provider_group_id",
          provider_message_id: payload.provider_message_id,
          message_keys: summary.message_keys,
        });
        continue;
      }
      try {
        const response = await this.input.backendClient.sendInboundPayload(payload);
        this.logger.info({
          event: "gateway_inbound_forwarded",
          trace_id: response.trace_id,
          provider_group_id: payload.provider_group_id,
          provider_message_id: payload.provider_message_id,
          from_me: summary.from_me,
          text_present: Boolean((payload.message.text ?? "").trim()),
          media_count: payload.message.media.length,
          deduped: response.deduped,
          execution_enqueued: response.execution_enqueued,
        });
      } catch (error) {
        this.logger.error({
          event: "gateway_inbound_forward_failed",
          trace_id: payload.trace_id,
          provider_group_id: payload.provider_group_id,
          provider_message_id: payload.provider_message_id,
          error: errorMessage(error),
        });
      }
    }
  }

  private async attachOriginalMediaBytes(payload: GatewayInboundEvent, message: WAMessage): Promise<void> {
    if (payload.message.media.length === 0) return;
    const baileys = await this.loadBaileys();
    const socket = this.requireSocket();

    let mediaBytes: Buffer;
    try {
      mediaBytes = await baileys.downloadMediaMessage(
        message,
        "buffer",
        {},
        {
          logger: this.logger,
          reuploadRequest: socket.updateMediaMessage.bind(socket),
        },
      );
    } catch (error) {
      this.logger.warn({
        event: "gateway_media_download_failed",
        trace_id: payload.trace_id,
        provider_group_id: payload.provider_group_id,
        provider_message_id: payload.provider_message_id,
        error: errorMessage(error),
      });
      return;
    }

    const encoded = mediaBytes.toString("base64");
    for (const media of payload.message.media) {
      media.inline_data_base64 = encoded;
      media.byte_size = mediaBytes.byteLength;
    }
    this.logger.info({
      event: "gateway_media_downloaded",
      trace_id: payload.trace_id,
      provider_group_id: payload.provider_group_id,
      provider_message_id: payload.provider_message_id,
      media_count: payload.message.media.length,
      byte_size: mediaBytes.byteLength,
    });
  }

  private rememberGatewayOutboundMessage(providerMessageId: string): void {
    this.gatewayOutboundMessageIds.add(providerMessageId);
    if (this.gatewayOutboundMessageIds.size <= 5000) return;
    const oldest = this.gatewayOutboundMessageIds.values().next().value;
    if (typeof oldest === "string") {
      this.gatewayOutboundMessageIds.delete(oldest);
    }
  }

  private printQr(qr: string): void {
    if (this.input.printQrToConsole === false) return;
    const render = this.input.qrRenderer ?? ((value: string) => qrcode.generate(value, { small: true }));
    this.logger.info({
      event: "gateway_pairing_qr_available",
      auth_dir: this.input.authDir,
      message: "Scan this QR code in WhatsApp Linked Devices.",
    });
    render(qr);
  }

  private requireSocket(): WASocket {
    if (!this.socket) {
      throw new Error("baileys socket is not initialized");
    }
    return this.socket;
  }
}

function disconnectStatusCode(value: unknown): number | null {
  const error = objectRecord(objectRecord(value).error);
  const output = objectRecord(error.output);
  const statusCode = output.statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    const nested = (error as { error?: unknown }).error;
    if (nested instanceof Error) return nested.message;
  }
  return String(error);
}

function objectRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function messageSummary(message: AnyRecord): {
  provider_group_id: string | null;
  provider_message_id: string | null;
  from_me: boolean;
  message_keys: string[];
} {
  const key = objectRecord(message.key);
  const content = objectRecord(message.message);
  return {
    provider_group_id: stringValue(key.remoteJid),
    provider_message_id: stringValue(key.id),
    from_me: key.fromMe === true,
    message_keys: Object.keys(content).sort(),
  };
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function historySyncType(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function mapGroupParticipant(value: unknown, selfJid: string | null, selfPhone: string | null): GatewayGroupParticipant | null {
  const participant = objectRecord(value);
  const jid = normalizeUserJid(stringValue(participant.id ?? participant.jid));
  if (!jid) return null;
  const admin = stringValue(participant.admin);
  const phoneNumberJid = normalizeUserJid(stringValue(participant.phoneNumber));
  const phone = phoneFromJid(phoneNumberJid) ?? phoneFromJid(jid);
  return {
    jid,
    phone,
    display_name: stringValue(participant.notify ?? participant.name ?? participant.verifiedName ?? participant.pushName),
    is_admin: admin ? admin === "admin" || admin === "superadmin" : null,
    is_self: isSelfParticipant({ jid, phoneNumberJid, phone }, { jid: selfJid, phone: selfPhone }),
    metadata: {
      admin,
      lid: stringValue(participant.lid),
      phone_number_jid: phoneNumberJid,
      verified_name: stringValue(participant.verifiedName),
      contact_name: stringValue(participant.name),
      notify_name: stringValue(participant.notify),
    },
  };
}

function phoneFromJid(jid: string | null): string | null {
  if (!jid) return null;
  const [user, server] = jid.split("@", 2);
  if (server !== "s.whatsapp.net" || !user) return null;
  const digits = user.replace(/[^0-9]/g, "");
  return digits || null;
}

function normalizeUserJid(jid: string | null): string | null {
  if (!jid) return null;
  const [user, server] = jid.split("@", 2);
  if (!user || !server) return jid;
  const userWithoutDevice = user.split(":", 1)[0] ?? user;
  return `${userWithoutDevice}@${server}`;
}

function sameWhatsAppUser(left: string, right: string): boolean {
  return normalizeUserJid(left) === normalizeUserJid(right);
}

function samePhone(left: string | null, right: string | null): boolean {
  return Boolean(left && right && left === right);
}

function isSelfParticipant(
  participant: { jid: string; phoneNumberJid: string | null; phone: string | null },
  self: { jid: string | null; phone: string | null },
): boolean {
  if (self.jid && sameWhatsAppUser(participant.jid, self.jid)) return true;
  if (self.jid && participant.phoneNumberJid && sameWhatsAppUser(participant.phoneNumberJid, self.jid)) return true;
  return Boolean(self.phone && participant.phone && self.phone === participant.phone);
}
