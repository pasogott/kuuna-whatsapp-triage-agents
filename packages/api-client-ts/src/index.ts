export type WorkflowStatus =
  | "draft"
  | "ready"
  | "published"
  | "archived"
  | "active"
  | "inactive"
  | "provisioning"
  | "failed"
  | "queued"
  | "processing"
  | "running"
  | "succeeded"
  | "cancelled";

export {
  createKuunaTrpcClient,
  type KuunaEventSource,
  type KuunaTrpcClient,
  type KuunaTrpcClientOptions,
} from "./trpc.js";

export type TemplateBuildStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type GroupTemplate = {
  id: string;
  key: string;
  displayName: string;
  description: string;
  publishedVersionId: string;
  updatedAt: string;
};

export type TemplateVersion = {
  id: string;
  templateId: string;
  versionNo: number;
  status: WorkflowStatus;
  systemPrompt?: string;
  modelChain: string[];
  allowedTools?: string[];
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  toolProfile: string;
  knowledgeProfile: string;
  egressPolicy: string;
  runtimeImageConfig?: {
    baseImage?: string;
    dockerfileSnippet?: string;
    piBashEnabled: boolean;
    piBashAllowlist: string[];
    gondolinProfile: string;
  };
  updatedAt: string;
  updatedBy: string;
};

export type TemplateBuild = {
  id: string;
  templateId: string;
  templateVersionId: string;
  status: TemplateBuildStatus;
  imageRef?: string;
  imageTag?: string;
  buildInputs: Record<string, unknown>;
  logsRef?: string;
  createdAt: string;
  updatedAt: string;
};

export type GroupBinding = {
  id: string;
  providerGroupId: string;
  groupTitle: string;
  templateVersionId: string;
  status: WorkflowStatus;
  runtimeMode: "on-demand" | "hot";
  runtimeContainerName?: string;
  runtimeBaseUrl?: string;
  secretsRef?: string;
  updatedAt: string;
};

export type ToolCatalogItem = {
  id: string;
  toolKey: string;
  displayName: string;
  description: string;
  riskClass: "read" | "write" | "admin";
  category: string;
  isEnabled: boolean;
  updatedAt: string;
};

export type KnownProviderGroup = {
  providerGroupId: string;
  groupTitle: string;
  lastSeenAt?: string;
  sources: Array<"binding" | "message" | "assignment" | "knowledge">;
};

export type BindingTimelineEvent = {
  id: string;
  bindingId: string;
  status: WorkflowStatus;
  label: string;
  occurredAt: string;
  details?: string;
};

export type PromptAsset = {
  id: string;
  templateId: string;
  templateName: string;
  templateVersionId: string;
  instanceId: string;
  instanceName: string;
  type: "system" | "user";
  title: string;
  status: WorkflowStatus;
  versionNo: number;
  updatedAt: string;
  updatedBy: string;
};

export type RuntimeRunStatus = "started" | "succeeded" | "failed" | "timeout";

export type RuntimeRun = {
  id: string;
  providerGroupId: string;
  messageId?: string;
  bindingId: string;
  templateVersionId: string;
  templateBuildId?: string;
  imageRef: string;
  status: RuntimeRunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  execution: Record<string, unknown>;
};

export type KnowledgeDoc = {
  id: string;
  docKey: string;
  scope: "common" | "group" | "customer" | "personal";
  providerGroupId?: string;
  customerKey?: string;
  clientProfileId?: string;
  title: string;
  status: WorkflowStatus;
  updatedAt: string;
  updatedBy: string;
  chunkCount: number;
};

export type KnowledgeDocVersion = {
  id: string;
  scope: "common" | "group" | "customer" | "personal";
  docRefId: string;
  versionNo: number;
  status: WorkflowStatus;
  contentMarkdown: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};

export type PrivateKnowledgeScope = "group" | "customer" | "personal";

export type PrivateKnowledgeDocKey = {
  docKey: string;
  title: string;
  scopes: PrivateKnowledgeScope[];
  groupCount: number;
  customerCount: number;
  personalCount: number;
  updatedAt: string;
};

export type GroupKnowledgeLevel = "common" | "group" | "personal";

export type KnowledgeSourceAttribution = {
  sourceRole?: GroupMemberRole | null;
  speakerDisplayName?: string | null;
  providerMessageId?: string | null;
  sourceMessageId?: string | null;
  clientProfileId?: string | null;
};

export type KnowledgeExplorerItem = KnowledgeSourceAttribution & {
  id: string;
  kind: "document" | "statement" | "claim";
  scope: GroupKnowledgeLevel;
  title: string;
  text: string;
  occurredAt: string;
  updatedAt: string;
};

export type GroupKnowledgeExplorer = {
  providerGroupId: string;
  primaryClientProfileId?: string | null;
  primaryClientDisplayName?: string | null;
  items: KnowledgeExplorerItem[];
};

export type GroupMemberRole = "client" | "lawyer" | "company_staff" | "bot";

export type ClientProfile = {
  id: string;
  displayName: string;
  notes?: string | null;
};

export type GroupPrivateRetrievalStatus = {
  complete: boolean;
  primaryClientCount: number;
  clientMemberCount: number;
  missingRoleCount: number;
  reason?: string | null;
};

export type WhatsAppGroupMember = {
  providerGroupId: string;
  providerUserId: string;
  role?: GroupMemberRole | null;
  displayName?: string | null;
  derivedPhone?: string | null;
  phoneOverride?: string | null;
  phoneDisplay?: string | null;
  pushName?: string | null;
  linkedClientProfile?: ClientProfile | null;
  gatewayMetadata: Record<string, unknown>;
  isPrimaryClient: boolean;
  setupStatus: "configured" | "missing_role" | "missing_profile";
  updatedAt: string;
};

export type WhatsAppGroupMembersResult = {
  providerGroupId: string;
  primaryClientProfileId?: string | null;
  privateRetrievalStatus: GroupPrivateRetrievalStatus;
  items: WhatsAppGroupMember[];
};

export type MessageRecord = {
  id: string;
  providerGroupId: string;
  sender: string;
  senderPhone?: string;
  senderPushName?: string;
  preview: string;
  hasMedia: boolean;
  isDeleted: boolean;
  latestVersionNo: number;
  createdAt: string;
};

export type MessageVersion = {
  id: string;
  messageId: string;
  versionNo: number;
  eventType: "created" | "edited" | "deleted";
  text: string;
  occurredAt: string;
};

export type MediaAsset = {
  id: string;
  messageId: string;
  kind: "image" | "audio" | "video" | "file";
  filename: string;
  mimeType?: string;
  byteSize?: number;
  status: WorkflowStatus;
  transcript?: string;
  viewUrl?: string;
  previewUrl?: string;
  downloadUrl?: string;
};

export type AuditEvent = {
  id: string;
  eventType: string;
  actor: string;
  entityType: string;
  entityId: string;
  traceId: string;
  createdAt: string;
  metadata: string;
};

export type TraceDetail = {
  traceId: string;
  providerGroupId: string;
  inboundEventId: string;
  retrievalRefs: string[];
  modelPath: string[];
  outboundIntentId: string;
};

export type StaffUser = {
  id: string;
  email: string;
  displayName: string;
  role: "owner" | "admin" | "operator" | "viewer";
  active: boolean;
};

export type GroupAssignment = {
  id: string;
  userId: string;
  user: string;
  providerGroupId: string;
  groupTitle: string;
};

export type RuntimeDebugStatus = {
  runtimeHealth: "ok" | "unreachable" | "error";
  runtimeUrl?: string;
  openaiConfigured: boolean | null;
  openaiBaseUrl?: string;
  openaiTimeoutSeconds?: string;
  defaultModel?: string;
  reasoningEffort?: string;
  lastModelPath: string[];
  lastModelUsed?: string;
  lastOutboundIntentId?: string;
  lastOutboundAt?: string;
  error?: string;
};

export type TodoItem = {
  id: string;
  messageId?: string;
  agentRunId?: string;
  providerGroupId: string;
  groupTitle: string;
  title: string;
  description?: string;
  status: "open" | "in_progress" | "done" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  dueAt?: string;
  completedAt?: string;
  exportedAt?: string;
  exportAttemptCount: number;
  externalRef?: string;
  lastExportError?: string;
  attachments: MediaAsset[];
  createdAt: string;
  updatedAt: string;
};

export type AgentRunRecord = {
  id: string;
  messageId?: string;
  providerGroupId: string;
  groupTitle: string;
  traceId?: string;
  status: "running" | "succeeded" | "failed";
  modelPath: string[];
  modelUsed?: string;
  reasoningEffort: string;
  allowedTools: string[];
  retrievalRefs: string[];
  systemPrompt?: string;
  userPrompt?: string;
  inputContext: Record<string, unknown>;
  responseText?: string;
  responsePreview?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export type OutboundIntentRecord = {
  id: string;
  outboundIntentId: string;
  providerGroupId: string;
  status: "pending" | "sending" | "sent" | "failed";
  attemptCount: number;
  text: string;
  replyToProviderMessageId?: string;
  agentRunId?: string;
  agentInstanceId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageDecisionRecord = {
  id: string;
  messageId: string;
  providerGroupId: string;
  groupTitle: string;
  decisionType: string;
  reason?: string;
  shouldExecute: boolean;
  payloadSummary: string;
  createdAt: string;
};

export type ToolInvocationRecord = {
  id: string;
  agentRunId?: string;
  messageId?: string;
  providerGroupId: string;
  groupTitle: string;
  toolName: string;
  ok: boolean;
  stdout?: string;
  stdoutPreview?: string;
  stderr?: string;
  stderrPreview?: string;
  timedOut: boolean;
  durationMs: number;
  detailsSummary: string;
  createdAt: string;
};

export type BackendTodoRead = {
  id: string;
  provider_group_id: string;
  message_id?: string | null;
  agent_run_id?: string | null;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  due_at?: string | null;
  completed_at?: string | null;
  exported_at?: string | null;
  export_attempt_count: number;
  external_ref?: string | null;
  last_export_error?: string | null;
  attachments: BackendMediaAssetRead[];
  created_at: string;
  updated_at: string;
};

export type BackendMediaAssetRead = {
  id: string;
  message_id: string;
  provider_media_id?: string | null;
  mime_type: string;
  file_name?: string | null;
  byte_size?: number | null;
  status: string;
  s3_key?: string | null;
  preview_url?: string | null;
  download_url?: string | null;
  transcript?: string | null;
  created_at: string;
  updated_at: string;
};

export type BackendAgentRunRead = {
  id: string;
  message_id?: string | null;
  provider_group_id: string;
  trace_id?: string | null;
  status: string;
  model_path: unknown[];
  model_used?: string | null;
  reasoning_effort: string;
  allowed_tools: unknown[];
  retrieval_refs: unknown[];
  response_text?: string | null;
  error?: string | null;
  started_at: string;
  completed_at?: string | null;
};

export type BackendMessageDecisionRead = {
  id: string;
  message_id: string;
  provider_group_id: string;
  decision_type: string;
  reason?: string | null;
  should_execute: boolean;
  payload: unknown;
  created_at: string;
};

export type BackendToolInvocationRead = {
  id: string;
  agent_run_id?: string | null;
  message_id?: string | null;
  provider_group_id: string;
  tool_name: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
  details: unknown;
  created_at: string;
};

export type BackendListParams = {
  providerGroupId?: string;
};

export type BackendToolInvocationListParams = BackendListParams & {
  agentRunId?: string;
};

export type BackendMessageDecisionListParams = BackendListParams & {
  messageId?: string;
};

type UnknownRecord = Record<string, unknown>;

export class KuunaApiClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KuunaApiClientError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function readString(record: UnknownRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new KuunaApiClientError(`${path}.${key} must be a string`);
  }
  return value;
}

function readOptionalString(record: UnknownRecord, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new KuunaApiClientError(`${path}.${key} must be a string or null`);
  }
  return value;
}

function readBoolean(record: UnknownRecord, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new KuunaApiClientError(`${path}.${key} must be a boolean`);
  }
  return value;
}

function readNumber(record: UnknownRecord, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new KuunaApiClientError(`${path}.${key} must be a number`);
  }
  return value;
}

function readArray(record: UnknownRecord, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function assertArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new KuunaApiClientError(`${path} must be an array`);
  }
  return value;
}

function compactStringList(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function summarizeJson(value: unknown, maxLength = 180): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return "";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function toTodoStatus(value: string): TodoItem["status"] {
  if (value === "open" || value === "in_progress" || value === "done" || value === "cancelled") {
    return value;
  }
  return "open";
}

function toTodoPriority(value: string): TodoItem["priority"] {
  if (value === "low" || value === "normal" || value === "high" || value === "urgent") {
    return value;
  }
  return "normal";
}

function toWorkflowStatus(value: string): WorkflowStatus {
  const allowed: WorkflowStatus[] = [
    "draft",
    "ready",
    "published",
    "archived",
    "active",
    "inactive",
    "provisioning",
    "failed",
    "queued",
    "processing",
    "running",
    "succeeded",
    "cancelled",
  ];
  return allowed.includes(value as WorkflowStatus) ? (value as WorkflowStatus) : "failed";
}

function toMediaKind(mimeType: string): MediaAsset["kind"] {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/") || normalized.endsWith("/audio")) return "audio";
  if (normalized.startsWith("video/") || normalized.endsWith("/video")) return "video";
  return "file";
}

function fileExtensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/plain") return "txt";
  if (normalized === "audio/mpeg" || normalized === "application/audio") return "mp3";
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/mp4") return "m4a";
  if (normalized === "audio/wav" || normalized === "audio/wave") return "wav";
  if (normalized.startsWith("audio/")) return "mp3";
  if (normalized === "video/mp4") return "mp4";
  return "bin";
}

function mediaFilename(item: BackendMediaAssetRead): string {
  const fileName = item.file_name?.trim();
  return fileName || `media-${item.id}.${fileExtensionFromMimeType(item.mime_type)}`;
}

function toAgentRunStatus(value: string): AgentRunRecord["status"] {
  if (value === "running" || value === "succeeded" || value === "failed") {
    return value;
  }
  return "failed";
}

function titleFromProviderGroupId(providerGroupId: string): string {
  if (providerGroupId.includes("@")) {
    const [user, server] = providerGroupId.split("@", 2);
    if (server === "g.us") {
      return `WhatsApp Group ${user}`;
    }
    if (server === "lid") {
      return `WhatsApp Chat ${user}`;
    }
    if (server === "s.whatsapp.net") {
      return `WhatsApp Contact ${user}`;
    }
    return `WhatsApp ${providerGroupId}`;
  }

  return providerGroupId
    .replace(/^grp-/, "")
    .split("-")
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function toBackendTodoRead(value: unknown, path: string): BackendTodoRead {
  if (!isRecord(value)) {
    throw new KuunaApiClientError(`${path} must be an object`);
  }
  return {
    id: readString(value, "id", path),
    provider_group_id: readString(value, "provider_group_id", path),
    message_id: readOptionalString(value, "message_id", path),
    agent_run_id: readOptionalString(value, "agent_run_id", path),
    title: readString(value, "title", path),
    description: readOptionalString(value, "description", path),
    status: readString(value, "status", path),
    priority: readString(value, "priority", path),
    due_at: readOptionalString(value, "due_at", path),
    completed_at: readOptionalString(value, "completed_at", path),
    exported_at: readOptionalString(value, "exported_at", path),
    export_attempt_count: readNumber(value, "export_attempt_count", path),
    external_ref: readOptionalString(value, "external_ref", path),
    last_export_error: readOptionalString(value, "last_export_error", path),
    attachments: readArray(value, "attachments").map((item, index) => toBackendMediaAssetRead(item, `${path}.attachments[${index}]`)),
    created_at: readString(value, "created_at", path),
    updated_at: readString(value, "updated_at", path),
  };
}

function toBackendMediaAssetRead(value: unknown, path: string): BackendMediaAssetRead {
  if (!isRecord(value)) {
    throw new KuunaApiClientError(`${path} must be an object`);
  }
  return {
    id: readString(value, "id", path),
    message_id: readString(value, "message_id", path),
    provider_media_id: readOptionalString(value, "provider_media_id", path),
    mime_type: readString(value, "mime_type", path),
    file_name: readOptionalString(value, "file_name", path),
    byte_size: value.byte_size === null || value.byte_size === undefined ? undefined : readNumber(value, "byte_size", path),
    status: readString(value, "status", path),
    s3_key: readOptionalString(value, "s3_key", path),
    preview_url: readOptionalString(value, "preview_url", path),
    download_url: readOptionalString(value, "download_url", path),
    transcript: readOptionalString(value, "transcript", path),
    created_at: readString(value, "created_at", path),
    updated_at: readString(value, "updated_at", path),
  };
}

function mapMediaAsset(item: BackendMediaAssetRead): MediaAsset {
  const kind = toMediaKind(item.mime_type);
  return {
    id: item.id,
    messageId: item.message_id,
    kind,
    filename: mediaFilename(item),
    mimeType: item.mime_type,
    byteSize: item.byte_size ?? undefined,
    status: toWorkflowStatus(item.status),
    transcript: item.transcript ?? undefined,
    viewUrl: item.preview_url ?? item.download_url ?? undefined,
    previewUrl: item.preview_url ?? undefined,
    downloadUrl: item.download_url ?? undefined,
  };
}

function toBackendAgentRunRead(value: unknown, path: string): BackendAgentRunRead {
  if (!isRecord(value)) {
    throw new KuunaApiClientError(`${path} must be an object`);
  }
  return {
    id: readString(value, "id", path),
    message_id: readOptionalString(value, "message_id", path),
    provider_group_id: readString(value, "provider_group_id", path),
    trace_id: readOptionalString(value, "trace_id", path),
    status: readString(value, "status", path),
    model_path: readArray(value, "model_path"),
    model_used: readOptionalString(value, "model_used", path),
    reasoning_effort: readString(value, "reasoning_effort", path),
    allowed_tools: readArray(value, "allowed_tools"),
    retrieval_refs: readArray(value, "retrieval_refs"),
    response_text: readOptionalString(value, "response_text", path),
    error: readOptionalString(value, "error", path),
    started_at: readString(value, "started_at", path),
    completed_at: readOptionalString(value, "completed_at", path),
  };
}

function toBackendMessageDecisionRead(value: unknown, path: string): BackendMessageDecisionRead {
  if (!isRecord(value)) {
    throw new KuunaApiClientError(`${path} must be an object`);
  }
  return {
    id: readString(value, "id", path),
    message_id: readString(value, "message_id", path),
    provider_group_id: readString(value, "provider_group_id", path),
    decision_type: readString(value, "decision_type", path),
    reason: readOptionalString(value, "reason", path),
    should_execute: readBoolean(value, "should_execute", path),
    payload: value.payload,
    created_at: readString(value, "created_at", path),
  };
}

function toBackendToolInvocationRead(value: unknown, path: string): BackendToolInvocationRead {
  if (!isRecord(value)) {
    throw new KuunaApiClientError(`${path} must be an object`);
  }
  return {
    id: readString(value, "id", path),
    agent_run_id: readOptionalString(value, "agent_run_id", path),
    message_id: readOptionalString(value, "message_id", path),
    provider_group_id: readString(value, "provider_group_id", path),
    tool_name: readString(value, "tool_name", path),
    ok: readBoolean(value, "ok", path),
    stdout: readString(value, "stdout", path),
    stderr: readString(value, "stderr", path),
    timed_out: readBoolean(value, "timed_out", path),
    duration_ms: readNumber(value, "duration_ms", path),
    details: value.details,
    created_at: readString(value, "created_at", path),
  };
}
