import { z } from "zod";

export const DEFAULT_AGENT_MODEL = "gpt-5.5";
export const DEFAULT_REASONING_EFFORT = "medium";

export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const toolInvocationSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.unknown()).default({}),
  timeout_seconds: z.number().nonnegative().nullable().optional(),
});

export const runtimeMediaAttachmentSchema = z.object({
  media_asset_id: z.string().min(1),
  mime_type: z.string().min(1),
  file_name: z.string().nullable().optional(),
  status: z.string().min(1),
  transcript: z.string().nullable().optional(),
  object_url: z.string().nullable().optional(),
  preview_url: z.string().nullable().optional(),
});

export const runtimeMediaInsightSchema = z.object({
  media_asset_id: z.string().min(1),
  mime_type: z.string().min(1),
  kind: z.enum(["image", "audio", "video", "file"]),
  status: z.enum(["ready", "failed", "skipped"]),
  summary: z.string().nullable().optional(),
  transcript: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

export const runtimeLinkSchema = z.object({
  url: z.string().min(1),
  normalized_url: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});

export const runtimeAgentContextSchema = z
  .object({
    provider_group_id: z.string().optional(),
    binding_id: z.string().optional(),
    agent_instance_id: z.string().optional(),
    sender_provider_user_id: z.string().nullable().optional(),
    sender_role: z.enum(["client", "lawyer", "company_staff", "bot"]).nullable().optional(),
    sender_display_name: z.string().nullable().optional(),
    primary_client_profile_id: z.string().nullable().optional(),
    primary_client_display_name: z.string().nullable().optional(),
    authorized_personal_profile_ids: z.array(z.string()).optional(),
    retrieval_access: z.record(z.unknown()).optional(),
    retrieval_refs: z.array(z.record(z.unknown())).optional(),
    retrieval_hits: z.array(z.record(z.unknown())).optional(),
    recent_messages: z.array(z.record(z.unknown())).optional(),
    todos: z.array(z.record(z.unknown())).optional(),
    links: z.array(runtimeLinkSchema).optional(),
    media_attachments: z.array(runtimeMediaAttachmentSchema).optional(),
    media_insights: z.array(runtimeMediaInsightSchema).optional(),
    todo_required: z.boolean().optional(),
    todo_required_reason: z.string().optional(),
  })
  .catchall(z.unknown());

export const runtimeAgentConfigSchema = z.object({
  pi_bash_enabled: z.boolean().default(false),
  pi_bash_allowlist: z.array(z.string().min(1)).default([]),
  gondolin_profile: z.string().trim().min(1).default("base"),
});

export const runtimeAgentRequestSchema = z.object({
  trace_id: z.string().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  user_prompt: z.string(),
  context: runtimeAgentContextSchema.default({}),
  runtime_config: runtimeAgentConfigSchema.default({}),
  model_path: z.array(z.string().min(1)).default([]),
  reasoning_effort: reasoningEffortSchema.default(DEFAULT_REASONING_EFFORT),
  allowed_tools: z.array(z.string().min(1)).default([]),
  tool_requests: z.array(toolInvocationSchema).default([]),
});

export const modelAttemptSchema = z.object({
  model: z.string(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
});

export const toolExecutionResultSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  timed_out: z.boolean().default(false),
  duration_ms: z.number().int().nonnegative().default(0),
  details: z.record(z.unknown()).nullable().optional(),
});

export const runtimeAgentResultSchema = z.object({
  success: z.boolean(),
  prompt: z.string(),
  system_prompt: z.string(),
  user_prompt: z.string(),
  context_block: z.string().nullable().optional(),
  model_used: z.string().nullable().optional(),
  reasoning_effort: reasoningEffortSchema.default(DEFAULT_REASONING_EFFORT),
  attempts: z.array(modelAttemptSchema).default([]),
  response_text: z.string().nullable().optional(),
  tool_results: z.array(toolExecutionResultSchema).default([]),
  media_insights: z.array(runtimeMediaInsightSchema).default([]),
  error: z.string().nullable().optional(),
});

export const runtimeAgentStreamEventTypeSchema = z.enum([
  "text_delta",
  "thinking_delta",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

export const runtimeAgentStreamEventSchema = z.object({
  type: runtimeAgentStreamEventTypeSchema,
  delta: z.string().optional(),
  text: z.string().optional(),
  tool_call_id: z.string().nullable().optional(),
  tool_name: z.string().nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
  timestamp: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
});

export const runtimeAgentRunEventSchema = z.union([
  runtimeAgentStreamEventSchema,
  z.object({
    type: z.literal("run_completed"),
    response_text: z.string().nullable().optional(),
    model_used: z.string().nullable().optional(),
    payload: z.record(z.unknown()).default({}),
    timestamp: z.string().optional(),
  }),
  z.object({
    type: z.literal("run_failed"),
    error: z.string(),
    payload: z.record(z.unknown()).default({}),
    timestamp: z.string().optional(),
  }),
]);

export const runtimeAgentEventBatchSchema = z.object({
  run_id: z.string().min(1),
  conversation_id: z.string().min(1).nullable().optional(),
  provider_group_id: z.string().min(1).nullable().optional(),
  trace_id: z.string().min(1).nullable().optional(),
  events: z.array(runtimeAgentRunEventSchema).min(1),
});

export const runtimeToolSearchRequestSchema = z.object({
  trace_id: z.string().nullable().optional(),
  tool_name: z.enum(["chat_history_search", "knowledge_search"]),
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(20).default(8),
  context: z.object({
    provider_group_id: z.string().min(1),
    binding_id: z.string().min(1),
    agent_instance_id: z.string().min(1),
    sender_provider_user_id: z.string().nullable().optional(),
  }).catchall(z.unknown()),
});

export const runtimeToolSearchHitSchema = z.object({
  chunk_id: z.string(),
  source_type: z.string(),
  source_scope: z.string(),
  source_id: z.string(),
  score: z.number(),
  content: z.string(),
  occurred_at: z.string(),
  provider_message_id: z.string().nullable().optional(),
  message_id: z.string().nullable().optional(),
  chunk_no: z.number().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const runtimeToolSearchResponseSchema = z.object({
  tool_name: z.enum(["chat_history_search", "knowledge_search"]),
  query: z.string(),
  hits: z.array(runtimeToolSearchHitSchema),
  access: z.record(z.unknown()),
});

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
export type RuntimeMediaAttachment = z.infer<typeof runtimeMediaAttachmentSchema>;
export type RuntimeMediaInsight = z.infer<typeof runtimeMediaInsightSchema>;
export type RuntimeLink = z.infer<typeof runtimeLinkSchema>;
export type RuntimeAgentContext = z.infer<typeof runtimeAgentContextSchema>;
export type RuntimeAgentConfig = z.infer<typeof runtimeAgentConfigSchema>;
export type RuntimeAgentRequest = z.infer<typeof runtimeAgentRequestSchema>;
export type ModelAttempt = z.infer<typeof modelAttemptSchema>;
export type ToolExecutionResult = z.infer<typeof toolExecutionResultSchema>;
export type RuntimeAgentResult = z.infer<typeof runtimeAgentResultSchema>;
export type RuntimeAgentStreamEventType = z.infer<typeof runtimeAgentStreamEventTypeSchema>;
export type RuntimeAgentStreamEvent = z.infer<typeof runtimeAgentStreamEventSchema>;
export type RuntimeAgentRunEvent = z.infer<typeof runtimeAgentRunEventSchema>;
export type RuntimeAgentEventBatch = z.infer<typeof runtimeAgentEventBatchSchema>;
export type RuntimeToolSearchRequest = z.infer<typeof runtimeToolSearchRequestSchema>;
export type RuntimeToolSearchResponse = z.infer<typeof runtimeToolSearchResponseSchema>;
