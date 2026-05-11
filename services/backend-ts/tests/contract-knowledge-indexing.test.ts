import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import {
  embeddings,
  knowledgeCommonDocs,
  knowledgeCustomerDocs,
  knowledgeGroupDocs,
  knowledgeVersions,
  retrievalChunks,
} from "../src/db/schema.js";
import { processKnowledgeIndexingJob } from "../src/jobs/knowledge-indexing.js";
import { contractDatabaseUrl, createContractHarness } from "./contract-harness.js";

const skipReason = contractDatabaseUrl
  ? false
  : "set BACKEND_TS_CONTRACT_DATABASE_URL to run backend-ts contract tests";

test("contract: knowledge indexing writes embeddings and retrieval chunks", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const [doc] = await harness.db
    .insert(knowledgeCommonDocs)
    .values({ docKey: "common", title: "Common" })
    .returning();
  assert.ok(doc);
  const [version] = await harness.db
    .insert(knowledgeVersions)
    .values({
      scope: "common",
      docRefId: doc.id,
      versionNo: 1,
      status: "published",
      contentMarkdown: "# Title\n\nFirst paragraph.\n\nSecond paragraph.",
    })
    .returning();
  assert.ok(version);

  const result = await processKnowledgeIndexingJob(harness.db, {
    knowledgeVersionId: version.id,
    traceId: "trace-knowledge",
  });

  assert.equal(result.indexed, true);
  assert.equal(result.chunkCount, 1);

  const [storedVersion] = await harness.db
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.id, version.id));
  assert.equal(storedVersion?.status, "ready");

  const storedEmbeddings = await harness.db
    .select()
    .from(embeddings)
    .where(eq(embeddings.sourceVersionId, version.id));
  assert.equal(storedEmbeddings.length, 1);
  assert.equal(storedEmbeddings[0]?.scope, "common");

  const storedChunks = await harness.db
    .select()
    .from(retrievalChunks)
    .where(eq(retrievalChunks.sourceId, version.id));
  assert.equal(storedChunks.length, 1);
  assert.equal(storedChunks[0]?.sourceType, "knowledge_version");
  assert.equal(storedChunks[0]?.scope, "common");
  assert.equal(storedChunks[0]?.providerGroupId, null);
});

test("contract: group knowledge indexing sets provider group and replaces stale rows", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const [doc] = await harness.db
    .insert(knowledgeGroupDocs)
    .values({ providerGroupId: "group-knowledge@g.us", docKey: "group", title: "Group" })
    .returning();
  assert.ok(doc);
  const [version] = await harness.db
    .insert(knowledgeVersions)
    .values({
      scope: "group",
      docRefId: doc.id,
      versionNo: 1,
      status: "published",
      contentMarkdown: "Fresh group content",
    })
    .returning();
  assert.ok(version);

  await harness.db.insert(embeddings).values({
    scope: "group",
    sourceVersionId: version.id,
    chunkNo: 99,
    content: "stale",
    tokenCount: 1,
    embedding: "[0]",
  });
  await harness.db.insert(retrievalChunks).values({
    scope: "group",
    providerGroupId: "group-knowledge@g.us",
    sourceType: "knowledge_version",
    sourceId: version.id,
    chunkNo: 99,
    content: "stale",
    tokenCount: 1,
    embedding: "[0]",
    metadataJson: {},
  });

  const result = await processKnowledgeIndexingJob(harness.db, {
    knowledgeVersionId: version.id,
  });
  assert.deepEqual(result, { indexed: true, chunkCount: 1 });

  const storedEmbeddings = await harness.db
    .select()
    .from(embeddings)
    .where(eq(embeddings.sourceVersionId, version.id));
  assert.equal(storedEmbeddings.length, 1);
  assert.equal(storedEmbeddings[0]?.chunkNo, 1);

  const [chunk] = await harness.db
    .select()
    .from(retrievalChunks)
    .where(eq(retrievalChunks.sourceId, version.id))
    .limit(1);
  assert.ok(chunk);
  assert.equal(chunk.providerGroupId, "group-knowledge@g.us");
  assert.equal((chunk.metadataJson as Record<string, unknown>).knowledge_scope, "group");
});

test("contract: archived knowledge versions are not indexed by stale jobs", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const [doc] = await harness.db
    .insert(knowledgeCommonDocs)
    .values({ docKey: "archived-common", title: "Archived Common" })
    .returning();
  assert.ok(doc);
  const [version] = await harness.db
    .insert(knowledgeVersions)
    .values({
      scope: "common",
      docRefId: doc.id,
      versionNo: 1,
      status: "archived",
      contentMarkdown: "This note has been replaced.",
    })
    .returning();
  assert.ok(version);

  await harness.db.insert(embeddings).values({
    scope: "common",
    sourceVersionId: version.id,
    chunkNo: 1,
    content: "stale archived note",
    tokenCount: 3,
    embedding: "[0]",
  });
  await harness.db.insert(retrievalChunks).values({
    scope: "common",
    sourceType: "knowledge_version",
    sourceId: version.id,
    chunkNo: 1,
    content: "stale archived note",
    tokenCount: 3,
    embedding: "[0]",
    metadataJson: {},
  });

  const result = await processKnowledgeIndexingJob(harness.db, {
    knowledgeVersionId: version.id,
  });

  assert.deepEqual(result, { indexed: false, chunkCount: 0 });
  const storedEmbeddings = await harness.db
    .select()
    .from(embeddings)
    .where(eq(embeddings.sourceVersionId, version.id));
  assert.equal(storedEmbeddings.length, 0);
  const storedChunks = await harness.db
    .select()
    .from(retrievalChunks)
    .where(eq(retrievalChunks.sourceId, version.id));
  assert.equal(storedChunks.length, 0);
  const [storedVersion] = await harness.db
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.id, version.id));
  assert.equal(storedVersion?.status, "archived");
});

test("contract: customer knowledge indexing stays isolated to the customer group key", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const [doc] = await harness.db
    .insert(knowledgeCustomerDocs)
    .values({
      providerGroupId: "customer-a@g.us",
      customerKey: "customer-a@g.us",
      docKey: "customer",
      title: "Customer",
    })
    .returning();
  assert.ok(doc);
  const [version] = await harness.db
    .insert(knowledgeVersions)
    .values({
      scope: "customer",
      docRefId: doc.id,
      versionNo: 1,
      status: "published",
      contentMarkdown: "Customer A private support policy.",
    })
    .returning();
  assert.ok(version);

  const result = await processKnowledgeIndexingJob(harness.db, {
    knowledgeVersionId: version.id,
  });

  assert.deepEqual(result, { indexed: true, chunkCount: 1 });
  const [chunk] = await harness.db
    .select()
    .from(retrievalChunks)
    .where(eq(retrievalChunks.sourceId, version.id))
    .limit(1);
  assert.ok(chunk);
  assert.equal(chunk.scope, "customer");
  assert.equal(chunk.providerGroupId, "customer-a@g.us");
  assert.equal((chunk.metadataJson as Record<string, unknown>).knowledge_scope, "customer");
});

test("contract: missing knowledge version is ignored without mutation", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const result = await processKnowledgeIndexingJob(harness.db, {
    knowledgeVersionId: "00000000-0000-4000-8000-000000000001",
  });

  assert.deepEqual(result, { indexed: false, chunkCount: 0 });
});
