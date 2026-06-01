import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const roleName = pgEnum("role_name", ["owner", "admin", "operator", "viewer"]);
export const templateVersionStatus = pgEnum("template_version_status", [
  "draft",
  "ready",
  "published",
  "archived",
]);
export const bindingStatus = pgEnum("binding_status", [
  "draft",
  "provisioning",
  "active",
  "inactive",
  "failed",
]);
export const runtimeMode = pgEnum("runtime_mode", ["on_demand", "hot"]);
export const runtimeStatus = pgEnum("runtime_status", [
  "pending",
  "provisioning",
  "healthy",
  "degraded",
  "stopped",
]);
export const messageEventType = pgEnum("message_event_type", [
  "message_created",
  "message_edited",
  "message_deleted",
]);
export const mediaStatus = pgEnum("media_status", ["pending", "ready", "failed"]);
export const transcriptStatus = pgEnum("transcript_status", ["pending", "ready", "failed"]);
export const knowledgeScope = pgEnum("knowledge_scope", ["common", "group", "customer", "personal"]);
export const knowledgeVersionStatus = pgEnum("knowledge_version_status", [
  "draft",
  "ready",
  "published",
  "archived",
]);
export const embeddingScope = pgEnum("embedding_scope", ["common", "group", "customer", "personal"]);
export const groupMemberRole = pgEnum("group_member_role", [
  "client",
  "lawyer",
  "company_staff",
  "bot",
]);
export const outboundStatus = pgEnum("outbound_status", [
  "pending",
  "sending",
  "sent",
  "failed",
]);
export const toolRiskClass = pgEnum("tool_risk_class", ["read", "write", "admin"]);
export const templateBuildStatus = pgEnum("template_build_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const runtimeRunStatus = pgEnum("runtime_run_status", [
  "started",
  "succeeded",
  "failed",
  "timeout",
]);
export const todoStatus = pgEnum("todo_status", ["open", "in_progress", "done", "cancelled"]);
export const todoPriority = pgEnum("todo_priority", ["low", "normal", "high", "urgent"]);
export const agentRunStatus = pgEnum("agent_run_status", ["running", "succeeded", "failed"]);

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

const vector1536 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  mustChangePassword: boolean("must_change_password").default(true).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  failedLoginAttempts: integer("failed_login_attempts").default(0).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  createdAt,
  updatedAt,
});

export const roles = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: roleName("name").notNull(),
});

export const userRoles = pgTable("user_roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull(),
  roleId: uuid("role_id").notNull(),
});

export const groupAssignments = pgTable("group_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull(),
  providerGroupId: text("provider_group_id").notNull(),
  createdAt,
  updatedAt,
});

export const clientProfiles = pgTable("client_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  displayName: text("display_name").notNull(),
  notes: text("notes"),
  createdAt,
  updatedAt,
});

export const clientProfileIdentities = pgTable(
  "client_profile_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientProfileId: uuid("client_profile_id").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    derivedPhone: text("derived_phone"),
    phoneOverride: text("phone_override"),
    pushName: text("push_name"),
    createdAt,
    updatedAt,
  },
  (table) => ({
    providerUserUnique: uniqueIndex("uq_client_profile_identities_provider_user")
      .on(table.providerUserId),
  }),
);

export const groupMembers = pgTable(
  "group_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerGroupId: text("provider_group_id").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    role: groupMemberRole("role"),
    displayName: text("display_name"),
    derivedPhone: text("derived_phone"),
    phoneOverride: text("phone_override"),
    pushName: text("push_name"),
    clientProfileId: uuid("client_profile_id"),
    gatewayMetadata: jsonb("gateway_metadata").default({}).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => ({
    groupMemberUnique: uniqueIndex("uq_group_members_group_user")
      .on(table.providerGroupId, table.providerUserId),
    groupMemberGroupIdx: index("ix_group_members_provider_group_id").on(table.providerGroupId),
  }),
);

export const groupClientProfiles = pgTable(
  "group_client_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerGroupId: text("provider_group_id").notNull(),
    clientProfileId: uuid("client_profile_id").notNull(),
    isPrimary: boolean("is_primary").default(true).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => ({
    primaryGroupUnique: uniqueIndex("uq_group_client_profiles_primary_group")
      .on(table.providerGroupId)
      .where(sql`is_primary = true`),
    clientGroupUnique: uniqueIndex("uq_group_client_profiles_group_client")
      .on(table.providerGroupId, table.clientProfileId),
  }),
);

export const groupTemplates = pgTable("group_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull(),
  displayName: text("display_name").notNull(),
  createdAt,
  updatedAt,
});

export const templateVersions = pgTable("template_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  templateId: uuid("template_id").notNull(),
  versionNo: integer("version_no").notNull(),
  status: templateVersionStatus("status").notNull(),
  systemPrompt: text("system_prompt"),
  modelConfig: jsonb("model_config").default({}).notNull(),
  toolsConfig: jsonb("tools_config").default({}).notNull(),
  egressPolicy: jsonb("egress_policy").default({}).notNull(),
  createdAt,
  updatedAt,
});

export const toolCatalogEntries = pgTable("tool_catalog_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  toolKey: text("tool_key").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description").default("").notNull(),
  riskClass: toolRiskClass("risk_class").notNull(),
  category: text("category").default("general").notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  createdAt,
  updatedAt,
});

export const groupBindings = pgTable(
  "group_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerGroupId: text("provider_group_id").notNull(),
    templateVersionId: uuid("template_version_id").notNull(),
    status: bindingStatus("status").notNull(),
    createdAt,
    updatedAt,
  },
  (table) => ({
    activeProviderGroupUnique: uniqueIndex("uq_group_bindings_active_provider_group")
      .on(table.providerGroupId)
      .where(sql`status = 'active'`),
  }),
);

export const agentInstances = pgTable(
  "agent_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    groupBindingId: uuid("group_binding_id").notNull(),
    runtimeMode: runtimeMode("runtime_mode").default("on_demand").notNull(),
    status: runtimeStatus("status").notNull(),
    runtimeContainerName: text("runtime_container_name"),
    runtimeBaseUrl: text("runtime_base_url"),
    secretsRef: text("secrets_ref"),
    createdAt,
    updatedAt,
  },
  (table) => ({
    runtimeContainerNameUnique: uniqueIndex("uq_agent_instances_runtime_container_name")
      .on(table.runtimeContainerName)
      .where(sql`runtime_container_name is not null`),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerGroupId: text("provider_group_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    senderProviderUserId: text("sender_provider_user_id"),
    latestVersionNo: integer("latest_version_no").default(1).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => ({
    groupCreatedIdx: index("ix_messages_provider_group_id_created_at").on(
      table.providerGroupId,
      table.createdAt,
    ),
    providerUnique: uniqueIndex("uq_messages_provider_group_message").on(
      table.providerGroupId,
      table.providerMessageId,
    ),
  }),
);

export const messageVersions = pgTable("message_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull(),
  versionNo: integer("version_no").notNull(),
  eventType: messageEventType("event_type").notNull(),
  isDeleted: boolean("is_deleted").default(false).notNull(),
  textContent: text("text_content"),
  rawEvent: jsonb("raw_event").default({}).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt,
});

export const mediaAssets = pgTable("media_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull(),
  providerMediaId: text("provider_media_id").notNull(),
  mimeType: text("mime_type").notNull(),
  fileName: text("file_name"),
  byteSize: integer("byte_size"),
  s3Key: text("s3_key"),
  status: mediaStatus("status").default("pending").notNull(),
  metadataJson: jsonb("metadata_json").default({}).notNull(),
  createdAt,
  updatedAt,
});

export const transcripts = pgTable("transcripts", {
  id: uuid("id").defaultRandom().primaryKey(),
  mediaAssetId: uuid("media_asset_id").notNull(),
  textContent: text("text_content"),
  language: text("language"),
  status: transcriptStatus("status").default("pending").notNull(),
  createdAt,
  updatedAt,
});

export const knowledgeCommonDocs = pgTable("knowledge_common_docs", {
  id: uuid("id").defaultRandom().primaryKey(),
  docKey: text("doc_key").notNull(),
  title: text("title").notNull(),
  createdAt,
  updatedAt,
});

export const knowledgeGroupDocs = pgTable("knowledge_group_docs", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerGroupId: text("provider_group_id").notNull(),
  docKey: text("doc_key").notNull(),
  title: text("title").notNull(),
  createdAt,
  updatedAt,
});

export const knowledgeCustomerDocs = pgTable("knowledge_customer_docs", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerGroupId: text("provider_group_id").notNull(),
  customerKey: text("customer_key").notNull(),
  docKey: text("doc_key").notNull(),
  title: text("title").notNull(),
  createdAt,
  updatedAt,
});

export const knowledgePersonalDocs = pgTable(
  "knowledge_personal_docs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientProfileId: uuid("client_profile_id").notNull(),
    docKey: text("doc_key").notNull(),
    title: text("title").notNull(),
    createdAt,
    updatedAt,
  },
  (table) => ({
    clientDocKeyUnique: uniqueIndex("uq_knowledge_personal_docs_client_doc_key")
      .on(table.clientProfileId, table.docKey),
  }),
);

export const knowledgeStatements = pgTable(
  "knowledge_statements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: text("scope").notNull(),
    providerGroupId: text("provider_group_id").notNull(),
    clientProfileId: uuid("client_profile_id"),
    sourceMessageId: uuid("source_message_id").notNull(),
    sourceMessageVersionId: uuid("source_message_version_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    speakerProviderUserId: text("speaker_provider_user_id"),
    speakerRole: text("speaker_role"),
    speakerDisplayName: text("speaker_display_name"),
    statementText: text("statement_text").notNull(),
    attributionLabel: text("attribution_label").notNull(),
    sourceType: text("source_type").default("message").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => ({
    sourceMessageUnique: uniqueIndex("uq_knowledge_statements_source_message")
      .on(table.sourceMessageId),
    scopeGroupIdx: index("ix_knowledge_statements_scope_group").on(table.scope, table.providerGroupId),
    profileIdx: index("ix_knowledge_statements_client_profile").on(table.clientProfileId),
  }),
);

export const knowledgeClaims = pgTable(
  "knowledge_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    statementId: uuid("statement_id").notNull(),
    scope: text("scope").notNull(),
    providerGroupId: text("provider_group_id").notNull(),
    clientProfileId: uuid("client_profile_id"),
    claimText: text("claim_text").notNull(),
    claimKind: text("claim_kind").default("general_statement").notNull(),
    attributionLabel: text("attribution_label").notNull(),
    confidence: integer("confidence").default(100).notNull(),
    extractionMethod: text("extraction_method").default("sentence_split_v1").notNull(),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => ({
    statementIdx: index("ix_knowledge_claims_statement").on(table.statementId),
    scopeGroupIdx: index("ix_knowledge_claims_scope_group").on(table.scope, table.providerGroupId),
    profileIdx: index("ix_knowledge_claims_client_profile").on(table.clientProfileId),
  }),
);

export const knowledgeVersions = pgTable("knowledge_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  scope: knowledgeScope("scope").notNull(),
  docRefId: uuid("doc_ref_id").notNull(),
  versionNo: integer("version_no").notNull(),
  status: knowledgeVersionStatus("status").notNull(),
  contentMarkdown: text("content_markdown").notNull(),
  createdAt,
  updatedAt,
});

export const embeddings = pgTable("embeddings", {
  id: uuid("id").defaultRandom().primaryKey(),
  scope: embeddingScope("scope").notNull(),
  sourceVersionId: uuid("source_version_id").notNull(),
  chunkNo: integer("chunk_no").notNull(),
  content: text("content").notNull(),
  tokenCount: integer("token_count").notNull(),
  // pgvector is queried with raw SQL in TS until a typed vector helper is introduced.
  embedding: text("embedding").notNull(),
  embeddingVector: vector1536("embedding_vector"),
  createdAt,
  updatedAt,
});

export const outboundIntents = pgTable(
  "outbound_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outboundIntentId: uuid("outbound_intent_id").notNull(),
    providerGroupId: text("provider_group_id").notNull(),
    status: outboundStatus("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    payload: jsonb("payload").default({}).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => ({
    groupDispatchProviderMessageIdx: index("ix_outbound_intents_group_dispatch_provider_message")
      .on(table.providerGroupId, sql`${table.payload}->'_dispatch'->>'provider_message_id'`)
      .where(sql`${table.payload}->'_dispatch'->>'provider_message_id' is not null`),
  }),
);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id"),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payload: jsonb("payload").default({}).notNull(),
  createdAt,
});

export const runtimeRuns = pgTable("runtime_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerGroupId: text("provider_group_id").notNull(),
  messageId: uuid("message_id"),
  bindingId: uuid("binding_id").notNull(),
  templateVersionId: uuid("template_version_id").notNull(),
  templateBuildId: uuid("template_build_id"),
  imageRef: text("image_ref").notNull(),
  status: runtimeRunStatus("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  error: text("error"),
  execution: jsonb("execution").default({}).notNull(),
  createdAt,
  updatedAt,
});

export const templateBuilds = pgTable("template_builds", {
  id: uuid("id").defaultRandom().primaryKey(),
  templateId: uuid("template_id").notNull(),
  templateVersionId: uuid("template_version_id").notNull(),
  status: templateBuildStatus("status").notNull(),
  imageRef: text("image_ref"),
  imageTag: text("image_tag"),
  buildInputs: jsonb("build_inputs").default({}).notNull(),
  logsRef: text("logs_ref"),
  createdAt,
  updatedAt,
});

export const todos = pgTable("todos", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerGroupId: text("provider_group_id").notNull(),
  messageId: uuid("message_id"),
  agentRunId: uuid("agent_run_id"),
  title: text("title").notNull(),
  description: text("description"),
  status: todoStatus("status").default("open").notNull(),
  priority: todoPriority("priority").default("normal").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  exportedAt: timestamp("exported_at", { withTimezone: true }),
  exportAttemptCount: integer("export_attempt_count").default(0).notNull(),
  externalRef: text("external_ref"),
  lastExportError: text("last_export_error"),
  metadataJson: jsonb("metadata_json").default({}).notNull(),
  createdAt,
  updatedAt,
});

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id"),
  providerGroupId: text("provider_group_id").notNull(),
  traceId: text("trace_id"),
  status: agentRunStatus("status").notNull(),
  modelPath: jsonb("model_path").default([]).notNull(),
  modelUsed: text("model_used"),
  reasoningEffort: text("reasoning_effort").default("medium").notNull(),
  allowedTools: jsonb("allowed_tools").default([]).notNull(),
  retrievalRefs: jsonb("retrieval_refs").default([]).notNull(),
  systemPrompt: text("system_prompt"),
  userPrompt: text("user_prompt"),
  inputContext: jsonb("input_context").default({}).notNull(),
  responseText: text("response_text"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const messageDecisions = pgTable("message_decisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull(),
  providerGroupId: text("provider_group_id").notNull(),
  decisionType: text("decision_type").notNull(),
  reason: text("reason"),
  shouldExecute: boolean("should_execute").default(false).notNull(),
  payload: jsonb("payload").default({}).notNull(),
  createdAt,
});

export const toolInvocations = pgTable("tool_invocations", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentRunId: uuid("agent_run_id"),
  messageId: uuid("message_id"),
  providerGroupId: text("provider_group_id").notNull(),
  toolName: text("tool_name").notNull(),
  ok: boolean("ok").default(false).notNull(),
  stdout: text("stdout").default("").notNull(),
  stderr: text("stderr").default("").notNull(),
  timedOut: boolean("timed_out").default(false).notNull(),
  durationMs: integer("duration_ms").default(0).notNull(),
  details: jsonb("details").default({}).notNull(),
  createdAt,
});

export const retrievalChunks = pgTable("retrieval_chunks", {
  id: uuid("id").defaultRandom().primaryKey(),
  scope: text("scope").notNull(),
  providerGroupId: text("provider_group_id"),
  clientProfileId: uuid("client_profile_id"),
  sourceType: text("source_type").notNull(),
  sourceId: uuid("source_id").notNull(),
  chunkNo: integer("chunk_no").notNull(),
  content: text("content").notNull(),
  tokenCount: integer("token_count").default(0).notNull(),
  embedding: text("embedding"),
  embeddingVector: vector1536("embedding_vector"),
  metadataJson: jsonb("metadata_json").default({}).notNull(),
  createdAt,
  updatedAt,
});

export const messageLinks = pgTable("message_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull(),
  providerGroupId: text("provider_group_id").notNull(),
  url: text("url").notNull(),
  normalizedUrl: text("normalized_url").notNull(),
  title: text("title"),
  metadataJson: jsonb("metadata_json").default({}).notNull(),
  createdAt,
  updatedAt,
});
