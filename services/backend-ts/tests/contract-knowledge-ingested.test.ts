import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import {
  embeddings,
  groupMembers,
  knowledgeCustomerDocs,
  knowledgeGroupDocs,
  knowledgeVersions,
  mediaAssets,
  messages,
  messageVersions,
  retrievalChunks,
  transcripts,
} from "../src/db/schema.js";
import { contractDatabaseUrl, createContractHarness } from "./contract-harness.js";

const skipReason = contractDatabaseUrl
  ? false
  : "set BACKEND_TS_CONTRACT_DATABASE_URL to run backend-ts contract tests";

test("contract: ingested group docs aggregate latest message versions", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());
  const caller = await authedCaller(harness);

  const [message] = await harness.db
    .insert(messages)
    .values({
      providerGroupId: "contract-group@g.us",
      providerMessageId: "msg-1",
      senderProviderUserId: "user-1",
      latestVersionNo: 2,
    })
    .returning();
  assert.ok(message);
  await harness.db.insert(messageVersions).values([
    {
      messageId: message.id,
      versionNo: 1,
      eventType: "message_created",
      isDeleted: false,
      textContent: "first",
      rawEvent: { event: "created" },
      occurredAt: new Date("2026-04-18T10:00:00Z"),
    },
    {
      messageId: message.id,
      versionNo: 2,
      eventType: "message_edited",
      isDeleted: false,
      textContent: "second",
      rawEvent: { event: "edited" },
      occurredAt: new Date("2026-04-18T11:00:00Z"),
    },
  ]);

  const payload = await caller.knowledge.ingestedGroupDocs({ providerGroupId: "contract-group@g.us" });

  assert.equal(payload.length, 1);
  assert.equal(payload[0]?.id, "contract-group@g.us");
  assert.equal(payload[0]?.scope, "group");
  assert.equal(payload[0]?.status, "ready");
  assert.equal(payload[0]?.chunk_count, 1);
});

test("contract: person note creates and updates one group knowledge document", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());
  const caller = await authedCaller(harness);

  await harness.db.insert(groupMembers).values({
    providerGroupId: "people-group@g.us",
    providerUserId: "person-1@s.whatsapp.net",
    role: "client",
    displayName: "Alex Client",
    derivedPhone: "436600000001",
  });

  const first = await caller.knowledge.upsertPersonNote({
    providerGroupId: "people-group@g.us",
    providerUserId: "person-1@s.whatsapp.net",
    contentMarkdown: "First note about Alex.",
  });
  await harness.db.update(knowledgeVersions).set({ status: "ready" }).where(eq(knowledgeVersions.id, first.version_id));
  await harness.db.insert(embeddings).values({
    scope: "group",
    sourceVersionId: first.version_id,
    chunkNo: 1,
    content: "First note about Alex.",
    tokenCount: 4,
    embedding: "[0]",
  });
  await harness.db.insert(retrievalChunks).values({
    scope: "group",
    providerGroupId: "people-group@g.us",
    sourceType: "knowledge_version",
    sourceId: first.version_id,
    chunkNo: 1,
    content: "First note about Alex.",
    tokenCount: 4,
    embedding: "[0]",
    metadataJson: {},
  });
  const second = await caller.knowledge.upsertPersonNote({
    providerGroupId: "people-group@g.us",
    providerUserId: "person-1@s.whatsapp.net",
    contentMarkdown: "Updated note about Alex.",
  });

  assert.equal(first.doc_id, second.doc_id);
  assert.equal(second.version_no, 2);
  const docs = await harness.db.select().from(knowledgeGroupDocs);
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.providerGroupId, "people-group@g.us");
  assert.match(docs[0]?.docKey ?? "", /^person-note-/);
  assert.equal(docs[0]?.title, "Person note: Alex Client");

  const versions = await harness.db.select().from(knowledgeVersions);
  assert.deepEqual(
    versions.map((version) => version.status).sort(),
    ["archived", "published"],
  );
  const staleEmbeddings = await harness.db.select().from(embeddings).where(eq(embeddings.sourceVersionId, first.version_id));
  assert.equal(staleEmbeddings.length, 0);
  const staleChunks = await harness.db.select().from(retrievalChunks).where(eq(retrievalChunks.sourceId, first.version_id));
  assert.equal(staleChunks.length, 0);
  assert.equal(harness.jobs.filter((job) => job.name === "knowledge_indexing").length, 2);
});

test("contract: group docs can list manual docs across all groups", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());
  const caller = await authedCaller(harness);

  await harness.db.insert(knowledgeGroupDocs).values([
    {
      providerGroupId: "people-group@g.us",
      docKey: "person-note-a",
      title: "Person note A",
    },
    {
      providerGroupId: "other-group@g.us",
      docKey: "person-note-b",
      title: "Person note B",
    },
  ]);

  const rows = await caller.knowledge.groupDocs({});

  assert.deepEqual(
    rows.map((row) => row.doc_key).sort(),
    ["person-note-a", "person-note-b"],
  );
});

test("contract: person note rejects members outside the chat", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());
  const caller = await authedCaller(harness);

  await harness.db.insert(groupMembers).values({
    providerGroupId: "other-group@g.us",
    providerUserId: "person-1@s.whatsapp.net",
    role: "client",
    displayName: "Other Person",
  });

  await assert.rejects(
    () =>
      caller.knowledge.upsertPersonNote({
        providerGroupId: "people-group@g.us",
        providerUserId: "person-1@s.whatsapp.net",
        contentMarkdown: "Should not save.",
      }),
    /group member not found/,
  );
});

test("contract: person note rejects empty markdown", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());
  const caller = await authedCaller(harness);

  await harness.db.insert(groupMembers).values({
    providerGroupId: "people-group@g.us",
    providerUserId: "person-1@s.whatsapp.net",
    role: "client",
    displayName: "Alex Client",
  });

  await assert.rejects(
    () =>
      caller.knowledge.upsertPersonNote({
        providerGroupId: "people-group@g.us",
        providerUserId: "person-1@s.whatsapp.net",
        contentMarkdown: "   ",
      }),
    /Markdown cannot be empty/,
  );
});

test("contract: ingested docs status follows pending media and transcript chunks", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());
  const caller = await authedCaller(harness);

  const [processingMessage] = await harness.db
    .insert(messages)
    .values({
      providerGroupId: "group-processing@g.us",
      providerMessageId: "msg-processing",
      senderProviderUserId: "user-2",
      latestVersionNo: 1,
    })
    .returning();
  assert.ok(processingMessage);
  await harness.db.insert(messageVersions).values({
    messageId: processingMessage.id,
    versionNo: 1,
    eventType: "message_created",
    isDeleted: false,
    textContent: "hello",
    rawEvent: { event: "created" },
    occurredAt: new Date("2026-04-18T11:30:00Z"),
  });
  await harness.db.insert(mediaAssets).values({
    messageId: processingMessage.id,
    providerMediaId: "media-1",
    mimeType: "audio/ogg",
    fileName: "voice.ogg",
    byteSize: 123,
    status: "pending",
    metadataJson: {},
  });

  const [transcriptMessage] = await harness.db
    .insert(messages)
    .values({
      providerGroupId: "group-transcript@g.us",
      providerMessageId: "msg-transcript",
      senderProviderUserId: "user-3",
      latestVersionNo: 1,
    })
    .returning();
  assert.ok(transcriptMessage);
  await harness.db.insert(messageVersions).values({
    messageId: transcriptMessage.id,
    versionNo: 1,
    eventType: "message_created",
    isDeleted: false,
    textContent: "",
    rawEvent: { event: "created" },
    occurredAt: new Date("2026-04-18T12:00:00Z"),
  });
  const [media] = await harness.db
    .insert(mediaAssets)
    .values({
      messageId: transcriptMessage.id,
      providerMediaId: "media-2",
      mimeType: "audio/ogg",
      fileName: "voice2.ogg",
      byteSize: 321,
      status: "ready",
      metadataJson: {},
    })
    .returning();
  assert.ok(media);
  await harness.db.insert(transcripts).values({
    mediaAssetId: media.id,
    textContent: "transcribed text",
    language: "de",
    status: "ready",
  });

  const processing = await caller.knowledge.ingestedGroupDocs({ providerGroupId: "group-processing@g.us" });
  assert.equal(processing.length, 1);
  assert.equal(processing[0]?.status, "processing");

  const common = await caller.knowledge.ingestedCommonDocs();
  assert.deepEqual(common, []);
});

test("contract: customer docs list all docs for provider group", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());
  const caller = await authedCaller(harness);

  await harness.db.insert(knowledgeCustomerDocs).values([
    {
      providerGroupId: "customer-group@g.us",
      customerKey: "customer-a",
      docKey: "customer-a-policy",
      title: "Customer A Policy",
    },
    {
      providerGroupId: "customer-group@g.us",
      customerKey: "customer-b",
      docKey: "customer-b-policy",
      title: "Customer B Policy",
    },
    {
      providerGroupId: "other-group@g.us",
      customerKey: "customer-a",
      docKey: "other-policy",
      title: "Other Policy",
    },
  ]);

  const rows = await caller.knowledge.customerDocs({ providerGroupId: "customer-group@g.us" });

  assert.deepEqual(
    rows.map((row) => row.doc_key).sort(),
    ["customer-a-policy", "customer-b-policy"],
  );
});

async function authedCaller(harness: Awaited<ReturnType<typeof createContractHarness>>) {
  await harness.seedUser({
    email: "owner@example.com",
    password: "OwnerSecure123!",
    role: "owner",
  });
  const publicCaller = await harness.caller();
  const login = await publicCaller.auth.login({
    email: "owner@example.com",
    password: "OwnerSecure123!",
  });
  return harness.caller(login.access_token);
}
