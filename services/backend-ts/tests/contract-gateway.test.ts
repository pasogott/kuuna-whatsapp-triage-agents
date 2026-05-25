import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { eq } from "drizzle-orm";
import type { GatewayInboundEvent, GatewayOutboundStatusEvent } from "@kuuna/contracts";

import {
  groupBindings,
  groupMembers,
  groupTemplates,
  outboundIntents,
  messageLinks,
  messageVersions,
  templateVersions,
  todos,
} from "../src/db/schema.js";
import { parseRuntimeChatTask } from "../src/jobs/queues.js";
import { contractDatabaseUrl, createContractHarness } from "./contract-harness.js";

const skipReason = contractDatabaseUrl
  ? false
  : "set BACKEND_TS_CONTRACT_DATABASE_URL to run backend-ts contract tests";

function inboundPayload(
  messageId: string,
  eventType: GatewayInboundEvent["event_type"] = "message_created",
): GatewayInboundEvent {
  return {
    trace_id: randomUUID(),
    provider: "whatsapp-baileys",
    provider_group_id: "group-123",
    provider_message_id: messageId,
    sender_provider_user_id: "user-1",
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    message: {
      text: "hello",
      reply_to_provider_message_id: null,
      mentions: [],
      media: [],
    },
    raw_event: {
      provider_payload: { kind: "MessageEv", message_id: messageId },
      raw_flags: { from_me: false },
    },
  };
}

test("contract: gateway inbound accepts and versions event", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });

  const payload = inboundPayload("msg-123");
  await seedActiveBinding(harness, payload.provider_group_id);
  const response = await caller.gateway.inbound.ingest(payload);

  assert.equal(response.accepted, true);
  assert.equal(response.trace_id, payload.trace_id);
  assert.equal(response.deduped, false);

  const [storedVersion] = await harness.db.select().from(messageVersions).limit(1);
  assert.ok(storedVersion);
  assert.equal((storedVersion.rawEvent as Record<string, { kind?: string }>).provider_payload.kind, "MessageEv");
  assert.deepEqual(
    harness.jobs.map((job) => job.name),
    ["retrieval_indexing", "runtime_chat_queue"],
  );
  assert.equal(harness.jobs[1]?.data.provider_group_id, payload.provider_group_id);
  assert.equal(harness.jobs[1]?.data.queued_task, undefined);
  assert.equal(parseRuntimeChatTask(harness.runtimeChatTasks[0]).name, "passive_message_analysis");
});

test("contract: gateway inbound triggers when WhatsApp mentions bound bot identity", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });

  const payload = inboundPayload("msg-bot-lid-mention");
  await seedActiveBinding(harness, payload.provider_group_id);
  await harness.db.insert(groupMembers).values({
    providerGroupId: payload.provider_group_id,
    providerUserId: "2768027737581120@lid",
    role: "bot",
    displayName: "Kuuna Bot",
    derivedPhone: "436765308907",
  });
  payload.message.text = "@2768027737581120 can you check this?";
  payload.message.mentions = ["2768027737581120@lid"];

  const response = await caller.gateway.inbound.ingest(payload);

  assert.equal(response.accepted, true);
  assert.equal(response.execution_enqueued, true);
  assert.deepEqual(harness.runtimeChatTasks.map((task) => parseRuntimeChatTask(task).name), [
    "passive_message_analysis",
    "inbound_execution",
  ]);
});

test("contract: gateway inbound triggers when replying to bound bot identity", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });

  const payload = inboundPayload("msg-bot-reply");
  await seedActiveBinding(harness, payload.provider_group_id);
  await seedBotMember(harness, payload.provider_group_id);
  payload.message.text = "can you check this?";
  payload.message.reply_to_provider_message_id = "bot-msg-1";
  payload.message.reply_to_provider_user_id = "2768027737581120@lid";

  const response = await caller.gateway.inbound.ingest(payload);

  assert.equal(response.accepted, true);
  assert.equal(response.execution_enqueued, true);
  assert.deepEqual(harness.runtimeChatTasks.map((task) => parseRuntimeChatTask(task).name), [
    "passive_message_analysis",
    "inbound_execution",
  ]);
});

test("contract: gateway inbound ignores replies to non-bot messages", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });

  const payload = inboundPayload("msg-human-reply");
  await seedActiveBinding(harness, payload.provider_group_id);
  await seedBotMember(harness, payload.provider_group_id);
  payload.message.text = "this was an ordinary threaded reply";
  payload.message.reply_to_provider_message_id = "human-msg-1";
  payload.message.reply_to_provider_user_id = "111111111111@lid";

  const response = await caller.gateway.inbound.ingest(payload);

  assert.equal(response.accepted, true);
  assert.equal(response.execution_enqueued, false);
  assert.deepEqual(harness.runtimeChatTasks.map((task) => parseRuntimeChatTask(task).name), [
    "passive_message_analysis",
  ]);
});

test("contract: gateway inbound triggers when reply matches prior bot outbound id", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });

  const payload = inboundPayload("msg-bot-outbound-id-reply");
  await seedActiveBinding(harness, payload.provider_group_id);
  payload.message.text = "following up here";
  payload.message.reply_to_provider_message_id = "bot-provider-msg-1";

  await harness.db.insert(outboundIntents).values({
    outboundIntentId: randomUUID(),
    providerGroupId: payload.provider_group_id,
    status: "sent",
    attemptCount: 1,
    payload: {
      text: "previous bot answer",
      _dispatch: {
        last_status: "sent",
        provider_message_id: "bot-provider-msg-1",
      },
    },
  });

  const response = await caller.gateway.inbound.ingest(payload);

  assert.equal(response.accepted, true);
  assert.equal(response.execution_enqueued, true);
  assert.deepEqual(harness.runtimeChatTasks.map((task) => parseRuntimeChatTask(task).name), [
    "passive_message_analysis",
    "inbound_execution",
  ]);
});

test("contract: gateway inbound dedupes duplicate created event", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });

  const firstResponse = await caller.gateway.inbound.ingest(inboundPayload("msg-dedupe"));
  const secondResponse = await caller.gateway.inbound.ingest(inboundPayload("msg-dedupe"));

  assert.equal(firstResponse.deduped, false);
  assert.equal(secondResponse.deduped, true);
});

test("contract: gateway inbound fills a contentless duplicate created event", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });

  const emptyPayload = inboundPayload("msg-content-fill");
  emptyPayload.message.text = null;
  emptyPayload.raw_event = { Message: { senderKeyDistributionMessage: { groupID: "group-123" } } };
  const contentPayload = inboundPayload("msg-content-fill");
  contentPayload.message.text = "actual text";

  const firstResponse = await caller.gateway.inbound.ingest(emptyPayload);
  const secondResponse = await caller.gateway.inbound.ingest(contentPayload);

  assert.equal(firstResponse.accepted, true);
  assert.equal(secondResponse.accepted, true);
  assert.equal(secondResponse.deduped, false);

  const versions = await harness.db.select().from(messageVersions);
  assert.equal(versions.length, 2);
  assert.equal(versions.some((version) => version.textContent === "actual text"), true);
});

test("contract: gateway inbound strips closing URL delimiters", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });

  const payload = inboundPayload("msg-url-delimiter");
  await seedActiveBinding(harness, payload.provider_group_id);
  payload.message.text = "Please read https://example.com/path] before replying.";

  const response = await caller.gateway.inbound.ingest(payload);

  assert.equal(response.accepted, true);
  const [link] = await harness.db.select().from(messageLinks).limit(1);
  assert.ok(link);
  assert.equal(link.url, "https://example.com/path");
  assert.equal(link.normalizedUrl, "https://example.com/path");
  const [todo] = await harness.db.select().from(todos).limit(1);
  assert.ok(todo);
  assert.equal(todo.title, "Review shared link");
  assert.equal(todo.messageId, link.messageId);
});

test("contract: gateway inbound does not create todos or runtime tasks for unbound chats", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });

  const payload = inboundPayload("msg-unbound-followup");
  payload.message.text = "Please read https://example.com/evidence";
  payload.message.media = [
    {
      provider_media_id: `media-unbound-${randomUUID()}`,
      mime_type: "image/jpeg",
      file_name: "evidence.jpg",
      byte_size: 123,
      inline_data_base64: Buffer.from("image", "utf8").toString("base64"),
    },
  ];

  const response = await caller.gateway.inbound.ingest(payload);

  assert.equal(response.accepted, true);
  assert.equal(response.execution_enqueued, false);
  const todoRows = await harness.db.select().from(todos);
  assert.equal(todoRows.length, 0);
  assert.equal(harness.runtimeChatTasks.length, 0);
  assert.deepEqual(
    harness.jobs.map((job) => job.name),
    ["media_processing", "retrieval_indexing", "retrieval_indexing"],
  );
});

test("contract: gateway inbound creates automatic todos for all attachment kinds", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });
  await seedActiveBinding(harness, "group-123");

  const cases = [
    { suffix: "image", mimeType: "image/jpeg", title: "Review image attachment" },
    { suffix: "audio", mimeType: "audio/mpeg", title: "Review audio attachment" },
    { suffix: "video", mimeType: "video/mp4", title: "Review video attachment" },
    { suffix: "document", mimeType: "application/pdf", title: "Review document attachment" },
    { suffix: "file", mimeType: "application/octet-stream", title: "Review file attachment" },
  ];

  for (const item of cases) {
    const payload = inboundPayload(`msg-${item.suffix}-${randomUUID()}`);
    payload.message.text = null;
    payload.message.media = [
      {
        provider_media_id: `media-${item.suffix}-${randomUUID()}`,
        mime_type: item.mimeType,
        file_name: `${item.suffix}.bin`,
        byte_size: 123,
        inline_data_base64: Buffer.from(item.suffix, "utf8").toString("base64"),
      },
    ];

    const response = await caller.gateway.inbound.ingest(payload);
    assert.equal(response.accepted, true);
  }

  const todoRows = await harness.db.select().from(todos);
  for (const item of cases) {
    assert.equal(
      todoRows.some((todo) => todo.title === item.title),
      true,
      `missing todo title: ${item.title}`,
    );
  }
});

test("contract: gateway outbound status persists dispatch status", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  const caller = await harness.caller();
  t.after(async () => {
    await harness.close();
  });

  const outboundIntentId = randomUUID();
  await harness.db.insert(outboundIntents).values({
    outboundIntentId,
    providerGroupId: "group-123",
    status: "pending",
    attemptCount: 0,
    payload: { kind: "reply", _dispatch: { last_status: "pending" } },
  });

  const payload: GatewayOutboundStatusEvent = {
    trace_id: randomUUID(),
    outbound_intent_id: outboundIntentId,
    status: "sent",
    provider_message_id: "msg-456",
    error_code: null,
    error_message: null,
    occurred_at: new Date().toISOString(),
  };
  const response = await caller.gateway.outbound.status(payload);

  assert.equal(response.accepted, true);
  assert.equal(response.found, true);

  const [storedIntent] = await harness.db
    .select()
    .from(outboundIntents)
    .where(eq(outboundIntents.outboundIntentId, outboundIntentId))
    .limit(1);

  assert.ok(storedIntent);
  assert.equal(storedIntent.status, "sent");
  const dispatch = (storedIntent.payload as { _dispatch: Record<string, unknown> })._dispatch;
  assert.equal(dispatch.last_status, "sent");
  assert.equal(dispatch.provider_message_id, "msg-456");
  assert.equal(dispatch.last_error_code, null);
  assert.equal(dispatch.last_error_message, null);
});

async function seedActiveBinding(
  harness: Awaited<ReturnType<typeof createContractHarness>>,
  providerGroupId: string,
): Promise<void> {
  const [template] = await harness.db
    .insert(groupTemplates)
    .values({ key: `gateway-${randomUUID()}`, displayName: "Gateway Template" })
    .returning();
  assert.ok(template);
  const [version] = await harness.db
    .insert(templateVersions)
    .values({
      templateId: template.id,
      versionNo: 1,
      status: "published",
      systemPrompt: "Handle WhatsApp messages.",
      modelConfig: {},
      toolsConfig: { tools: ["message_history", "todo_create", "todo_update", "todo_list"] },
      egressPolicy: {},
    })
    .returning();
  assert.ok(version);
  await harness.db.insert(groupBindings).values({ providerGroupId, templateVersionId: version.id, status: "active" });
}

async function seedBotMember(
  harness: Awaited<ReturnType<typeof createContractHarness>>,
  providerGroupId: string,
): Promise<void> {
  await harness.db.insert(groupMembers).values({
    providerGroupId,
    providerUserId: "2768027737581120@lid",
    role: "bot",
    displayName: "Kuuna Bot",
    derivedPhone: "436765308907",
    gatewayMetadata: { phone_number_jid: "436765308907@s.whatsapp.net" },
  });
}
