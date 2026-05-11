import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { eq } from "drizzle-orm";

import { auditEvents, mediaAssets, messages, todos, transcripts } from "../src/db/schema.js";
import { contractDatabaseUrl, createContractHarness } from "./contract-harness.js";

const skipReason = contractDatabaseUrl
  ? false
  : "set BACKEND_TS_CONTRACT_DATABASE_URL to run backend-ts contract tests";

test("contract: agent state todos include source message attachments", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const owner = await harness.seedUser({
    email: "owner@example.com",
    password: "OwnerSecure123!",
    role: "owner",
  });

  const messageId = randomUUID();
  const mediaAssetId = randomUUID();
  await harness.db.insert(messages).values({
    id: messageId,
    providerGroupId: "group-a@g.us",
    providerMessageId: "provider-message-a",
  });
  await harness.db.insert(mediaAssets).values({
    id: mediaAssetId,
    messageId,
    providerMediaId: "provider-media-a",
    mimeType: "application/pdf",
    fileName: "evidence.pdf",
    byteSize: 1024,
    status: "ready",
    metadataJson: {
      object_url: "https://files.example.test/evidence.pdf",
      preview_url: "https://files.example.test/evidence.pdf",
    },
  });
  await harness.db.insert(transcripts).values({
    mediaAssetId,
    textContent: "Extracted evidence summary.",
    status: "ready",
  });
  await harness.db.insert(todos).values({
    providerGroupId: "group-a@g.us",
    messageId,
    title: "Review uploaded evidence",
    description: "Check the PDF.",
    status: "open",
    priority: "urgent",
  });

  const authedCaller = await harness.callerForUser(owner.id);
  const result = await authedCaller.agentState.todos({ providerGroupId: "group-a@g.us" });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.message_id, messageId);
  assert.equal(result[0]?.attachments.length, 1);
  assert.equal(result[0]?.attachments[0]?.file_name, "evidence.pdf");
  assert.equal(result[0]?.attachments[0]?.download_url, "https://files.example.test/evidence.pdf");
  assert.equal(result[0]?.attachments[0]?.transcript, "Extracted evidence summary.");
});

test("contract: todo status updates completed state and audit event", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const operator = await harness.seedUser({
    email: "operator@example.com",
    password: "Operator123!!",
    role: "operator",
    groupScope: ["group-a@g.us"],
  });

  const todoId = randomUUID();
  await harness.db.insert(todos).values({
    id: todoId,
    providerGroupId: "group-a@g.us",
    title: "Call customer",
    status: "open",
    priority: "normal",
  });

  const authedCaller = await harness.callerForUser(operator.id);

  const done = await authedCaller.agentState.updateTodoStatus({ todoId, status: "done" });
  assert.equal(done.status, "done");
  assert.ok(done.completed_at);

  const [storedDone] = await harness.db.select().from(todos).where(eq(todos.id, todoId)).limit(1);
  assert.equal(storedDone?.status, "done");
  assert.ok(storedDone?.completedAt);

  const reopened = await authedCaller.agentState.updateTodoStatus({ todoId, status: "in_progress" });
  assert.equal(reopened.status, "in_progress");
  assert.equal(reopened.completed_at, null);

  const [storedReopened] = await harness.db.select().from(todos).where(eq(todos.id, todoId)).limit(1);
  assert.equal(storedReopened?.completedAt, null);

  const events = await harness.db.select().from(auditEvents).where(eq(auditEvents.eventType, "todo.status_updated"));
  assert.equal(events.length, 2);
  assert.equal(events[0]?.entityId, todoId);
});

test("contract: todo status update enforces role and group scope", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const viewer = await harness.seedUser({
    email: "viewer@example.com",
    password: "Viewer123!!",
    role: "viewer",
    groupScope: ["group-a@g.us"],
  });
  const operator = await harness.seedUser({
    email: "operator@example.com",
    password: "Operator123!!",
    role: "operator",
    groupScope: ["group-a@g.us"],
  });

  const todoId = randomUUID();
  await harness.db.insert(todos).values({
    id: todoId,
    providerGroupId: "group-b@g.us",
    title: "Restricted todo",
    status: "open",
    priority: "normal",
  });

  const viewerCaller = await harness.callerForUser(viewer.id);
  await assert.rejects(
    viewerCaller.agentState.updateTodoStatus({ todoId, status: "done" }),
    /insufficient role/,
  );

  const operatorCaller = await harness.callerForUser(operator.id);
  await assert.rejects(
    operatorCaller.agentState.updateTodoStatus({ todoId, status: "done" }),
    /outside group scope/,
  );
});
