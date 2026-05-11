import { and, eq } from "drizzle-orm";

import type { DbLike } from "../db/client.js";
import {
  embeddings,
  knowledgeCommonDocs,
  knowledgeCustomerDocs,
  knowledgeGroupDocs,
  knowledgePersonalDocs,
  knowledgeVersions,
  retrievalChunks,
} from "../db/schema.js";
import { logger } from "../logging.js";
import { chunkMarkdown, createEmbeddings, tokenCount, vectorLiteral } from "./indexing-utils.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function processKnowledgeIndexingJob(
  database: DbLike,
  input: { knowledgeVersionId: string; traceId?: string | null },
): Promise<{ indexed: boolean; chunkCount: number }> {
  if (!uuidPattern.test(input.knowledgeVersionId)) {
    logger.error("knowledge_indexing_invalid_version_id", {
      trace_id: input.traceId,
      knowledge_version_id: input.knowledgeVersionId,
    });
    return { indexed: false, chunkCount: 0 };
  }

  const [version] = await database
    .select()
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.id, input.knowledgeVersionId))
    .limit(1);

  if (!version) {
    logger.warn("knowledge_version_not_found", {
      trace_id: input.traceId,
      knowledge_version_id: input.knowledgeVersionId,
    });
    return { indexed: false, chunkCount: 0 };
  }

  if (version.status !== "published" && version.status !== "ready") {
    await clearKnowledgeVersionIndex(database, version.id);
    logger.info("knowledge_indexing_skipped_inactive_version", {
      trace_id: input.traceId,
      knowledge_version_id: input.knowledgeVersionId,
      status: version.status,
    });
    return { indexed: false, chunkCount: 0 };
  }

  const chunks = chunkMarkdown(version.contentMarkdown);
  const chunkEmbeddings = await createEmbeddings(chunks, {
    fallbackLogMessage: "knowledge_indexing_openai_not_configured_using_pseudo_embeddings",
  });

  await clearKnowledgeVersionIndex(database, version.id);

  const metadata = await knowledgeDocMetadata(database, version.scope, version.docRefId);
  let chunkCount = 0;

  for (const [index, chunkContent] of chunks.entries()) {
    const embedding = chunkEmbeddings[index] ?? [];
    await database.insert(embeddings).values({
      scope: version.scope,
      sourceVersionId: version.id,
      chunkNo: index + 1,
      content: chunkContent,
      tokenCount: tokenCount(chunkContent),
      embedding: vectorLiteral(embedding),
      embeddingVector: vectorLiteral(embedding),
    });

    const normalizedChunk = chunkContent.trim();
    if (!normalizedChunk) {
      continue;
    }

    chunkCount += 1;
    await database.insert(retrievalChunks).values({
      scope: version.scope,
      providerGroupId: metadata.providerGroupId,
      clientProfileId: metadata.clientProfileId,
      sourceType: "knowledge_version",
      sourceId: version.id,
      chunkNo: index + 1,
      content: normalizedChunk,
      tokenCount: tokenCount(normalizedChunk),
      embedding: vectorLiteral(embedding),
      embeddingVector: vectorLiteral(embedding),
      metadataJson: {
        knowledge_version_id: version.id,
        knowledge_scope: version.scope,
        doc_ref_id: version.docRefId,
        doc_key: metadata.docKey,
        client_profile_id: metadata.clientProfileId,
      },
    });
  }

  await database
    .update(knowledgeVersions)
    .set({ status: "ready", updatedAt: new Date() })
    .where(eq(knowledgeVersions.id, version.id));

  logger.info("knowledge_version_indexed", {
    trace_id: input.traceId,
    knowledge_version_id: input.knowledgeVersionId,
    chunk_count: chunks.length,
    status: "ready",
  });

  return { indexed: chunkCount > 0, chunkCount };
}

async function clearKnowledgeVersionIndex(database: DbLike, versionId: string): Promise<void> {
  await database.delete(embeddings).where(eq(embeddings.sourceVersionId, versionId));
  await database
    .delete(retrievalChunks)
    .where(and(eq(retrievalChunks.sourceType, "knowledge_version"), eq(retrievalChunks.sourceId, versionId)));
}

async function knowledgeDocMetadata(
  database: DbLike,
  scope: string,
  docRefId: string,
): Promise<{ providerGroupId: string | null; clientProfileId: string | null; docKey: string | null }> {
  if (scope === "common") {
    const [doc] = await database
      .select({ docKey: knowledgeCommonDocs.docKey })
      .from(knowledgeCommonDocs)
      .where(eq(knowledgeCommonDocs.id, docRefId))
      .limit(1);
    return { providerGroupId: null, clientProfileId: null, docKey: doc?.docKey ?? null };
  }
  if (scope === "group") {
    const [doc] = await database
      .select({ providerGroupId: knowledgeGroupDocs.providerGroupId, docKey: knowledgeGroupDocs.docKey })
      .from(knowledgeGroupDocs)
      .where(eq(knowledgeGroupDocs.id, docRefId))
      .limit(1);
    return { providerGroupId: doc?.providerGroupId ?? null, clientProfileId: null, docKey: doc?.docKey ?? null };
  }
  if (scope === "customer") {
    const [doc] = await database
      .select({ providerGroupId: knowledgeCustomerDocs.providerGroupId, docKey: knowledgeCustomerDocs.docKey })
      .from(knowledgeCustomerDocs)
      .where(eq(knowledgeCustomerDocs.id, docRefId))
      .limit(1);
    return { providerGroupId: doc?.providerGroupId ?? null, clientProfileId: null, docKey: doc?.docKey ?? null };
  }
  if (scope === "personal") {
    const [doc] = await database
      .select({ clientProfileId: knowledgePersonalDocs.clientProfileId, docKey: knowledgePersonalDocs.docKey })
      .from(knowledgePersonalDocs)
      .where(eq(knowledgePersonalDocs.id, docRefId))
      .limit(1);
    return { providerGroupId: null, clientProfileId: doc?.clientProfileId ?? null, docKey: doc?.docKey ?? null };
  }
  return { providerGroupId: null, clientProfileId: null, docKey: null };
}
