import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { DbLike } from "../db/client.js";
import { retrievalChunks } from "../db/schema.js";
import { createEmbeddings, vectorLiteral } from "./indexing-utils.js";

export type GroupMemberRole = "client" | "lawyer" | "company_staff" | "bot";

export type RetrievalHit = {
  chunk_id: string;
  source_type: string;
  source_scope: string;
  source_id: string;
  score: number;
  content: string;
  occurred_at: string;
  provider_message_id?: string | null;
  message_id?: string | null;
  chunk_no?: number | null;
  metadata?: Record<string, unknown>;
};

export type RetrievalAccessAudit = {
  private_scopes_allowed: boolean;
  fallback_reason: string | null;
  sender_role: GroupMemberRole | null;
  authorized_personal_profile_ids: string[];
  template_filter: KnowledgeFilter;
};

export type RetrievalResult = {
  hits: RetrievalHit[];
  access: RetrievalAccessAudit;
};

export type RetrievalAccessContext = {
  providerGroupId: string;
  bindingId?: string | null;
  agentInstanceId?: string | null;
  senderProviderUserId?: string | null;
  senderRole?: string | null;
  primaryClientProfileId?: string | null;
  authorizedPersonalProfileIds?: string[];
};

type RetrievalCandidateRow = {
  chunk: typeof retrievalChunks.$inferSelect;
  vectorDistance: number;
};

export type KnowledgeFilter = {
  commonDocKeys: "*" | "none" | string[];
  groupDocKeys: "*" | "none" | string[];
  includeGroupKnowledge: boolean;
};

export async function retrieveScopedRuntimeContext(
  database: DbLike,
  input: {
    query: string;
    limit: number;
    access: RetrievalAccessContext;
    toolsConfig?: unknown;
    sourceTypes?: string[];
    allowBoundConversationScope?: boolean;
  },
): Promise<RetrievalResult> {
  const terms = queryTerms(input.query);
  const templateFilter = extractKnowledgeFilter(input.toolsConfig);
  const access = evaluateAccess(input.access, templateFilter);
  const rowLimit = Math.max(input.limit * 3, input.limit);
  const queryEmbedding = (await createEmbeddings([input.query], {
    fallbackLogMessage: "retrieval_query_embedding_openai_not_configured_using_pseudo_embedding",
  }))[0] ?? [];
  const queryVector = vectorLiteral(queryEmbedding);
  const vectorDistance = sql<number>`coalesce(${retrievalChunks.embeddingVector} <=> ${queryVector}::vector, 1)`;
  const sourceTypes = normalizeUniqueStrings(input.sourceTypes ?? []);
  const whereClause = withSourceTypeFilter(
    input.allowBoundConversationScope
      ? eq(retrievalChunks.providerGroupId, input.access.providerGroupId)
      : authorizedWhereClause(input.access, access),
    sourceTypes,
  );
  const vectorRows = await database
    .select({
      chunk: retrievalChunks,
      vectorDistance,
    })
    .from(retrievalChunks)
    .where(whereClause)
    .orderBy(vectorDistance, desc(retrievalChunks.updatedAt))
    .limit(rowLimit);
  const privateKnowledgeRows = shouldSupplementPrivateKnowledge(input, access, sourceTypes)
    ? await database
      .select({
        chunk: retrievalChunks,
        vectorDistance,
      })
      .from(retrievalChunks)
      .where(privateKnowledgeVersionWhereClause(input.access, access))
      .orderBy(desc(retrievalChunks.updatedAt))
      .limit(Math.max(input.limit * 4, 24))
    : [];
  const rows = privateKnowledgeRows.length
    ? dedupeCandidateRows([...vectorRows, ...privateKnowledgeRows])
    : vectorRows;

  const hits = rows
    .filter(({ chunk }) =>
      isAuthorizedChunk(chunk, input.access, access, templateFilter, Boolean(input.allowBoundConversationScope)),
    )
    .map(({ chunk: row, vectorDistance }) => {
      const metadata = objectRecord(row.metadataJson);
      const lowered = row.content.toLowerCase();
      const lexicalScore = terms.length
        ? terms.filter((term) => lowered.includes(term)).length / terms.length
        : 0.1;
      const semanticScore = 1 - Math.min(Math.max(Number(vectorDistance ?? 1), 0), 1);
      return {
        chunk_id: row.id,
        source_type: row.sourceType,
        source_scope: row.scope,
        source_id: row.sourceId,
        score: semanticScore + lexicalScore * 0.2 + retrievalScopeBoost(row.scope),
        content: row.content,
        occurred_at: row.updatedAt.toISOString(),
        provider_message_id: optionalString(metadata.provider_message_id),
        message_id: optionalString(metadata.message_id),
        chunk_no: row.chunkNo,
        metadata,
      };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit);

  return {
    hits,
    access: {
      private_scopes_allowed: access.privateScopesAllowed,
      fallback_reason: access.fallbackReason,
      sender_role: access.senderRole,
      authorized_personal_profile_ids: access.authorizedPersonalProfileIds,
      template_filter: templateFilter,
    },
  };
}

function withSourceTypeFilter(whereClause: ReturnType<typeof authorizedWhereClause>, sourceTypes?: string[]) {
  const normalized = normalizeUniqueStrings(sourceTypes ?? []);
  if (!normalized.length) return whereClause;
  return and(whereClause, inArray(retrievalChunks.sourceType, normalized));
}

function shouldSupplementPrivateKnowledge(
  input: { sourceTypes?: string[]; allowBoundConversationScope?: boolean },
  access: ReturnType<typeof evaluateAccess>,
  sourceTypes: string[],
): boolean {
  if (input.allowBoundConversationScope || !access.privateScopesAllowed) {
    return false;
  }
  return sourceTypes.length === 0 || sourceTypes.includes("knowledge_version");
}

function privateKnowledgeVersionWhereClause(
  requested: RetrievalAccessContext,
  access: ReturnType<typeof evaluateAccess>,
) {
  const clauses = [eq(retrievalChunks.providerGroupId, requested.providerGroupId)];
  if (access.authorizedPersonalProfileIds.length > 0) {
    clauses.push(inArray(retrievalChunks.clientProfileId, access.authorizedPersonalProfileIds));
  }
  return and(eq(retrievalChunks.sourceType, "knowledge_version"), or(...clauses));
}

function dedupeCandidateRows(rows: RetrievalCandidateRow[]): RetrievalCandidateRow[] {
  const seen = new Set<string>();
  return rows.filter(({ chunk }) => {
    if (seen.has(chunk.id)) {
      return false;
    }
    seen.add(chunk.id);
    return true;
  });
}

function authorizedWhereClause(
  requested: RetrievalAccessContext,
  access: ReturnType<typeof evaluateAccess>,
) {
  if (!access.privateScopesAllowed) {
    return eq(retrievalChunks.scope, "common");
  }
  const clauses = [
    eq(retrievalChunks.scope, "common"),
    eq(retrievalChunks.providerGroupId, requested.providerGroupId),
  ];
  if (access.authorizedPersonalProfileIds.length > 0) {
    clauses.push(inArray(retrievalChunks.clientProfileId, access.authorizedPersonalProfileIds));
  }
  return or(...clauses);
}

function evaluateAccess(access: RetrievalAccessContext, templateFilter: KnowledgeFilter) {
  const senderRole = normalizeMemberRole(access.senderRole);
  const authorizedPersonalProfileIds = normalizeUniqueStrings([
    ...(access.authorizedPersonalProfileIds ?? []),
    ...(access.primaryClientProfileId ? [access.primaryClientProfileId] : []),
  ]);
  const missing = [
    ["provider_group_id", access.providerGroupId],
    ["binding_id", access.bindingId],
    ["agent_instance_id", access.agentInstanceId],
    ["sender_provider_user_id", access.senderProviderUserId],
    ["sender_role", senderRole],
    ["primary_client_profile_id", access.primaryClientProfileId],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    return {
      privateScopesAllowed: false,
      fallbackReason: `missing_private_access_context:${missing.map(([key]) => key).join(",")}`,
      senderRole,
      authorizedPersonalProfileIds,
    };
  }
  if (!templateFilter.includeGroupKnowledge) {
    return {
      privateScopesAllowed: false,
      fallbackReason: "template_disables_group_knowledge",
      senderRole,
      authorizedPersonalProfileIds,
    };
  }
  return {
    privateScopesAllowed: true,
    fallbackReason: null,
    senderRole,
    authorizedPersonalProfileIds,
  };
}

function isAuthorizedChunk(
  row: typeof retrievalChunks.$inferSelect,
  requested: RetrievalAccessContext,
  access: ReturnType<typeof evaluateAccess>,
  templateFilter: KnowledgeFilter,
  allowBoundConversationScope: boolean,
): boolean {
  const metadata = objectRecord(row.metadataJson);
  if (!matchesTemplateFilter(row.scope, row.sourceType, metadata, templateFilter)) {
    return false;
  }
  if (
    allowBoundConversationScope &&
    row.scope === "conversation" &&
    row.providerGroupId === requested.providerGroupId
  ) {
    return true;
  }
  if (row.scope === "common") {
    return true;
  }
  if (!access.privateScopesAllowed) {
    return false;
  }
  if (row.providerGroupId !== requested.providerGroupId) {
    if (!isPersonalScope(row.scope)) {
      return false;
    }
  }
  if (isPersonalScope(row.scope)) {
    const clientProfileId = row.clientProfileId ?? optionalString(metadata.client_profile_id);
    return !clientProfileId || access.authorizedPersonalProfileIds.includes(clientProfileId);
  }
  return row.scope === "group" || row.scope === "conversation";
}

function matchesTemplateFilter(
  scope: string,
  sourceType: string,
  metadata: Record<string, unknown>,
  filter: KnowledgeFilter,
): boolean {
  if (sourceType !== "knowledge_version") {
    return true;
  }
  const docKey = optionalString(metadata.doc_key);
  if (scope === "common") {
    return keyAllowed(filter.commonDocKeys, docKey);
  }
  if (scope === "group" || isPersonalScope(scope)) {
    return filter.includeGroupKnowledge && keyAllowed(filter.groupDocKeys, docKey);
  }
  return false;
}

function keyAllowed(allowed: "*" | "none" | string[], docKey: string | null): boolean {
  if (allowed === "*") return true;
  if (allowed === "none") return false;
  return Boolean(docKey && allowed.includes(docKey));
}

export function extractKnowledgeFilter(toolsConfig: unknown): KnowledgeFilter {
  const tools = objectRecord(toolsConfig);
  const knowledge = objectRecord(tools.knowledge);
  return {
    commonDocKeys: parseDocKeys(knowledge.common_doc_keys ?? knowledge.commonDocKeys, "*"),
    groupDocKeys: parseDocKeys(knowledge.group_doc_keys ?? knowledge.groupDocKeys, "*"),
    includeGroupKnowledge: knowledge.include_group_knowledge === false || knowledge.includeGroupKnowledge === false
      ? false
      : true,
  };
}

function parseDocKeys(value: unknown, fallback: "*" | "none"): "*" | "none" | string[] {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "*") return "*";
    if (normalized === "none") return "none";
    return normalizeUniqueStrings(normalized.split(","));
  }
  if (Array.isArray(value)) {
    return normalizeUniqueStrings(value.filter((item): item is string => typeof item === "string"));
  }
  return fallback;
}

function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((term) => term.length > 2).slice(0, 8);
}

function retrievalScopeBoost(scope: string): number {
  if (isPersonalScope(scope)) return 0.3;
  if (scope === "group") return 0.2;
  if (scope === "conversation") return 0.1;
  return 0;
}

function isPersonalScope(scope: string): boolean {
  return scope === "personal" || scope === "customer";
}

function normalizeMemberRole(value: string | null | undefined): GroupMemberRole | null {
  if (value === "client" || value === "lawyer" || value === "company_staff" || value === "bot") {
    return value;
  }
  return null;
}

function normalizeUniqueStrings(values: string[]): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    const item = value.trim().toLowerCase();
    if (item && !normalized.includes(item)) {
      normalized.push(item);
    }
  }
  return normalized;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
