import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { BackendIngestClient } from "../src/backend.js";
import { BaileysGateway } from "../src/baileys-gateway.js";
import { GatewayConnectionStatus, GatewayQrStatus } from "../src/status.js";

type Handler = (...args: never[]) => void;

class FakeSocket {
  ev = new EventEmitter();
  sent: Array<{ jid: string; content: unknown }> = [];
  ended = false;
  mediaBytes = Buffer.from("original-media-bytes");

  async groupFetchAllParticipating() {
    return {
      "120363000000000@g.us": {
        id: "120363000000000@g.us",
        subject: "Support Team",
        participants: [{ id: "1@s.whatsapp.net" }, { id: "2@s.whatsapp.net" }],
      },
    };
  }

  async groupCreate(subject: string, participants: string[]) {
    return { id: "120363999999999@g.us", subject, participants: participants.map((id) => ({ id })) };
  }

  async groupMetadata() {
    return {
      id: "120363000000000@g.us",
      subject: "Support Team",
      participants: [
        { id: "43664111222@s.whatsapp.net", admin: "admin", notify: "Client One" },
        { id: "111111@lid", phoneNumber: "43664111999@s.whatsapp.net", notify: "LID Client" },
        { id: "222222@lid", phoneNumber: "43664000000@s.whatsapp.net", notify: "Felix" },
        { id: "43664111333@s.whatsapp.net" },
      ],
    };
  }

  async sendMessage(jid: string, content: unknown) {
    this.sent.push({ jid, content });
    return { key: { id: "provider-msg-123" } };
  }

  async updateMediaMessage(message: unknown) {
    return message;
  }

  end() {
    this.ended = true;
  }
}

function fakeBaileys(socket: FakeSocket) {
  return {
    DisconnectReason: { loggedOut: 401 },
    Browsers: { appropriate: () => ["Kuuna", "Chrome", "1.0"] },
    makeCacheableSignalKeyStore: (keys: unknown) => keys,
    useMultiFileAuthState: async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: async () => undefined,
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
    makeWASocket: () => socketWithUser(socket),
    downloadMediaMessage: async () => socket.mediaBytes,
  };
}

function socketWithUser(socket: FakeSocket) {
  return Object.assign(socket, {
    user: { id: "43664000000:4@s.whatsapp.net", name: "Kuuna Bot" },
  });
}

function captureSocketConfig(socket: FakeSocket, configs: Record<string, unknown>[]) {
  return (config: unknown) => {
    configs.push(config as Record<string, unknown>);
    return socketWithUser(socket) as never;
  };
}

function makeGateway(socket: FakeSocket, calls: unknown[], overrides: Partial<ConstructorParameters<typeof BaileysGateway>[0]> = {}) {
  const connectionStatus = new GatewayConnectionStatus();
  const qrStatus = new GatewayQrStatus();
  const backendClient = new BackendIngestClient({
    backendBaseUrl: "http://backend.test",
    transport: async (payload) => {
      calls.push(payload);
      return {
        accepted: true,
        trace_id: payload.trace_id,
        deduped: false,
        execution_enqueued: false,
      };
    },
  });

  return new BaileysGateway({
    authDir: "/tmp/auth",
    sessionName: "kuuna-gateway",
    printQrToConsole: false,
    backendClient,
    connectionStatus,
    qrStatus,
    baileysModule: fakeBaileys(socket) as never,
    ...overrides,
  });
}

test("history sync socket settings default to disabled", async () => {
  const socket = new FakeSocket();
  const calls: unknown[] = [];
  const configs: Record<string, unknown>[] = [];
  const gateway = makeGateway(socket, calls, {
    socketFactory: captureSocketConfig(socket, configs),
  });

  await gateway.start();

  assert.equal(configs[0]?.syncFullHistory, false);
  const shouldSyncHistoryMessage = configs[0]?.shouldSyncHistoryMessage as (message: { syncType: number }) => boolean;
  assert.equal(shouldSyncHistoryMessage({ syncType: 1 }), false);

  socket.ev.emit("messaging-history.set", {
    syncType: 1,
    messages: [
      {
        key: { id: "history-disabled", remoteJid: "1203630-group@g.us", fromMe: false },
        message: { conversation: "should not ingest" },
      },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 0);
});

test("enabled history sync forwards history messages through inbound ingest", async () => {
  const socket = new FakeSocket();
  const calls: unknown[] = [];
  const configs: Record<string, unknown>[] = [];
  const gateway = makeGateway(socket, calls, {
    syncFullHistory: true,
    processHistorySync: true,
    socketFactory: captureSocketConfig(socket, configs),
  });

  await gateway.start();

  assert.equal(configs[0]?.syncFullHistory, true);
  const shouldSyncHistoryMessage = configs[0]?.shouldSyncHistoryMessage as (message: { syncType: number }) => boolean;
  assert.equal(shouldSyncHistoryMessage({ syncType: 1 }), true);

  socket.ev.emit("messaging-history.set", {
    syncType: 1,
    progress: 100,
    isLatest: true,
    chats: [{ id: "1203630-group@g.us" }],
    contacts: [{ id: "4912345@s.whatsapp.net" }],
    messages: [
      {
        key: {
          id: "history-msg-1",
          remoteJid: "1203630-group@g.us",
          participant: "4912345@s.whatsapp.net",
          fromMe: false,
        },
        messageTimestamp: 1776506400,
        message: { conversation: "backfilled hello" },
      },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal((calls[0] as Record<string, unknown>).provider, "whatsapp-baileys");
  assert.equal((calls[0] as Record<string, unknown>).provider_group_id, "1203630-group@g.us");
  assert.equal((calls[0] as Record<string, unknown>).provider_message_id, "history-msg-1");
  assert.equal(((calls[0] as { message: { text: string } }).message).text, "backfilled hello");
});

test("history processing can be enabled without requesting full history", async () => {
  const socket = new FakeSocket();
  const calls: unknown[] = [];
  const configs: Record<string, unknown>[] = [];
  const gateway = makeGateway(socket, calls, {
    processHistorySync: true,
    socketFactory: captureSocketConfig(socket, configs),
  });

  await gateway.start();

  assert.equal(configs[0]?.syncFullHistory, false);
  const shouldSyncHistoryMessage = configs[0]?.shouldSyncHistoryMessage as (message: { syncType: number }) => boolean;
  assert.equal(shouldSyncHistoryMessage({ syncType: 1 }), true);
});

test("tracks QR and connection status", async () => {
  const socket = new FakeSocket();
  const calls: unknown[] = [];
  const rendered: string[] = [];
  const gateway = makeGateway(socket, calls, {
    printQrToConsole: true,
    qrRenderer: (qr) => rendered.push(qr),
  });

  await gateway.start();
  socket.ev.emit("connection.update", { qr: "qr-code" });
  assert.equal(gateway.qrSnapshot().qr, "qr-code");
  assert.equal(gateway.connectionSnapshot().last_event, "qr");
  assert.equal(gateway.connectionSnapshot().last_error?.includes("pairing required"), true);
  assert.deepEqual(rendered, ["qr-code"]);

  socket.ev.emit("connection.update", { connection: "open" });
  assert.equal(gateway.connectionSnapshot().connected, true);
  assert.equal(gateway.qrSnapshot().qr, null);
});

test("forwards inbound messages and skips gateway outbound echoes", async () => {
  const socket = new FakeSocket();
  const calls: unknown[] = [];
  const gateway = makeGateway(socket, calls);

  await gateway.start();
  await gateway.sendText({
    providerGroupId: "1203630-group@g.us",
    text: "gateway outbound",
  });
  socket.ev.emit("messages.upsert", {
    messages: [
      {
        key: { id: "provider-msg-123", remoteJid: "1203630-group@g.us", fromMe: true },
        message: { conversation: "ignore me" },
      },
      {
        key: {
          id: "msg-1",
          remoteJid: "1203630-group@g.us",
          participant: "4912345@s.whatsapp.net",
          fromMe: false,
        },
        messageTimestamp: 1776506400,
        message: { conversation: "hello" },
      },
    ],
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal((calls[0] as Record<string, unknown>).provider_message_id, "msg-1");
});

test("forwards self messages not sent by this gateway", async () => {
  const socket = new FakeSocket();
  const calls: unknown[] = [];
  const gateway = makeGateway(socket, calls);

  await gateway.start();
  socket.ev.emit("messages.upsert", {
    messages: [
      {
        key: { id: "human-phone-msg", remoteJid: "1203630-group@g.us", fromMe: true },
        message: {
          imageMessage: {
            url: "https://example.com/image.enc",
            mimetype: "image/jpeg",
            mediaKey: Buffer.from("media-key-1").toString("base64"),
          },
        },
      },
    ],
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal((calls[0] as Record<string, unknown>).provider_message_id, "human-phone-msg");
  const media = (calls[0] as { message: { media: Array<Record<string, unknown>> } }).message.media;
  assert.equal(media.length, 1);
  assert.equal(media[0]?.inline_data_base64, socket.mediaBytes.toString("base64"));
  assert.equal(media[0]?.byte_size, socket.mediaBytes.byteLength);
});

test("group and outbound methods delegate to socket", async () => {
  const socket = new FakeSocket();
  const calls: unknown[] = [];
  const gateway = makeGateway(socket, calls);

  await gateway.start();
  const groups = await gateway.listGroups();
  const participants = await gateway.listGroupParticipants("120363000000000@g.us");
  const self = gateway.selfIdentity();
  const created = await gateway.createGroup("Ops", ["1@s.whatsapp.net"]);
  const providerMessageId = await gateway.sendText({
    providerGroupId: "120363000000000@g.us",
    text: "Hello",
  });

  assert.equal(groups[0]?.name, "Support Team");
  assert.deepEqual(participants[0], {
    jid: "222222@lid",
    phone: "43664000000",
    display_name: "Felix",
    is_admin: null,
    is_self: true,
    metadata: {
      admin: null,
      lid: null,
      phone_number_jid: "43664000000@s.whatsapp.net",
      verified_name: null,
      contact_name: null,
      notify_name: "Felix",
    },
  });
  assert.deepEqual(participants.find((item) => item.jid === "43664111222@s.whatsapp.net"), {
    jid: "43664111222@s.whatsapp.net",
    phone: "43664111222",
    display_name: "Client One",
    is_admin: true,
    is_self: false,
    metadata: {
      admin: "admin",
      lid: null,
      phone_number_jid: null,
      verified_name: null,
      contact_name: null,
      notify_name: "Client One",
    },
  });
  assert.equal(participants.find((item) => item.jid === "111111@lid")?.phone, "43664111999");
  assert.equal(self.jid, "43664000000@s.whatsapp.net");
  assert.equal(created.participants_count, 1);
  assert.equal(providerMessageId, "provider-msg-123");
  assert.deepEqual(socket.sent, [{ jid: "120363000000000@g.us", content: { text: "Hello" } }]);
});

test("logged out close does not reconnect", async () => {
  const socket = new FakeSocket();
  const calls: unknown[] = [];
  const gateway = makeGateway(socket, calls);

  await gateway.start();
  socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 }, message: "logged out" } },
  });

  assert.equal(gateway.connectionSnapshot().last_event, "logged_out");
});
