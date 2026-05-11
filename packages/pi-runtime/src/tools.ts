import { Type } from "typebox";
import {
  createBashToolDefinition,
  defineTool,
  type BashToolDetails,
  type BashToolInput,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  runtimeMediaAttachmentSchema,
  runtimeToolSearchRequestSchema,
  runtimeToolSearchResponseSchema,
  type RuntimeAgentConfig,
  type RuntimeMediaInsight,
  type RuntimeToolSearchResponse,
  type ToolExecutionResult,
  type ToolInvocation,
} from "@kuuna/agent-contracts";
import {
  kuunaRuntimeToolBackendBaseUrl,
  kuunaRuntimeToolToken,
} from "./config.js";
import { analyzeRuntimeMedia } from "./media-insights.js";

export const KUUNA_TOOL_NAMES = [
  "uppercase",
  "media_analyze",
  "chat_history_search",
  "knowledge_search",
  "message_history",
  "todo_create",
  "todo_update",
  "todo_list",
] as const;

export type RuntimeToolState = {
  context: Record<string, unknown>;
  results: ToolExecutionResult[];
  mediaInsights?: RuntimeMediaInsight[];
};

const knownToolNames = new Set<string>(KUUNA_TOOL_NAMES);
const disabledToolNames = new Set<string>(["context_lookup", "send_whatsapp"]);
const unsafeBashCommandPattern = /[;&|<>\n\r`$()]/;
const pythonCommandPattern = /^python(?:\d+(?:\.\d+)*)?(?:\s|$)/;

function textArg(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function nowMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function pushResult(
  state: RuntimeToolState,
  startedAt: number,
  result: Omit<ToolExecutionResult, "duration_ms">,
): ToolExecutionResult {
  const completed = { ...result, duration_ms: nowMs(startedAt) };
  state.results.push(completed);
  return completed;
}

function contextArray(context: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = context[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function runtimeMediaAttachments(context: Record<string, unknown>) {
  const parsed = runtimeMediaAttachmentSchema.array().safeParse(context.media_attachments);
  return parsed.success ? parsed.data : [];
}

async function callBackendSearchTool(
  state: RuntimeToolState,
  toolName: "chat_history_search" | "knowledge_search",
  input: { query?: string; limit?: number },
): Promise<RuntimeToolSearchResponse> {
  const backendBaseUrl = kuunaRuntimeToolBackendBaseUrl();
  const token = kuunaRuntimeToolToken();
  if (!backendBaseUrl || !token) {
    throw new Error("runtime backend search endpoint is not configured");
  }
  const context = state.context;
  const request = runtimeToolSearchRequestSchema.parse({
    trace_id: typeof context.trace_id === "string" ? context.trace_id : null,
    tool_name: toolName,
    query: input.query ?? "",
    limit: input.limit ?? 8,
    context: {
      provider_group_id: context.provider_group_id,
      binding_id: context.binding_id,
      agent_instance_id: context.agent_instance_id,
      sender_provider_user_id: context.sender_provider_user_id ?? null,
    },
  });
  const response = await fetch(`${backendBaseUrl}/internal/runtime-tools/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify(request),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload
      ? String((payload as { detail: unknown }).detail)
      : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return runtimeToolSearchResponseSchema.parse(payload);
}

async function ensureMediaInsights(state: RuntimeToolState): Promise<RuntimeMediaInsight[]> {
  if (state.mediaInsights) {
    return state.mediaInsights;
  }
  const insights = await analyzeRuntimeMedia(runtimeMediaAttachments(state.context));
  state.mediaInsights = insights;
  state.context.media_insights = insights;
  return insights;
}

export function sanitizeAllowedTools(allowedTools: string[], runtimeConfig?: RuntimeAgentConfig): string[] {
  const sanitized = allowedTools
    .map((tool) => tool.trim().toLowerCase())
    .filter((tool, index, tools) => knownToolNames.has(tool) && !disabledToolNames.has(tool) && tools.indexOf(tool) === index);
  if (
    runtimeConfig?.pi_bash_enabled &&
    runtimeConfig.pi_bash_allowlist.length > 0 &&
    allowedTools.map((tool) => tool.trim().toLowerCase()).includes("bash")
  ) {
    sanitized.push("bash");
  }
  return sanitized;
}

export function createKuunaTools(state: RuntimeToolState, runtimeConfig?: RuntimeAgentConfig): ToolDefinition[] {
  const tools: ToolDefinition[] = runtimeConfig?.pi_bash_enabled && runtimeConfig.pi_bash_allowlist.length > 0
    ? [createAllowlistedBashTool(state, runtimeConfig.pi_bash_allowlist)]
    : [];
  tools.push(
    ...[
    defineTool({
      name: "uppercase",
      label: "Uppercase",
      description: "Convert provided text to uppercase.",
      parameters: Type.Object({
        text: Type.String({ description: "Text to convert." }),
      }),
      execute: async (_toolCallId, params) => {
        const startedAt = Date.now();
        const stdout = params.text.toUpperCase();
        pushResult(state, startedAt, { name: "uppercase", ok: true, stdout, stderr: "", timed_out: false });
        return { content: [{ type: "text", text: stdout }], details: { text: params.text } };
      },
    }),
    defineTool({
      name: "media_analyze",
      label: "Analyze Media",
      description: "Inspect image and audio insights generated inside this isolated chat runtime.",
      parameters: Type.Object({
        media_asset_id: Type.Optional(Type.String({ description: "Optional media asset id to inspect." })),
      }),
      execute: async (_toolCallId, params) => {
        const startedAt = Date.now();
        const insights = await ensureMediaInsights(state);
        const selected = params.media_asset_id
          ? insights.filter((insight) => insight.media_asset_id === params.media_asset_id)
          : insights;
        const stdout = JSON.stringify({ media_insights: selected });
        pushResult(state, startedAt, {
          name: "media_analyze",
          ok: true,
          stdout,
          stderr: "",
          timed_out: false,
          details: {
            media_asset_id: params.media_asset_id ?? null,
            insight_count: selected.length,
          },
        });
        return { content: [{ type: "text", text: stdout }], details: { media_insights: selected } };
      },
    }),
    defineTool({
      name: "chat_history_search",
      label: "Chat History Search",
      description: "Search older messages, links, and media transcripts for this bound WhatsApp group only.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
      }),
      execute: async (_toolCallId, params) => {
        const startedAt = Date.now();
        try {
          const result = await callBackendSearchTool(state, "chat_history_search", {
            query: params.query,
            limit: params.limit,
          });
          const stdout = JSON.stringify({ query: result.query, hits: result.hits, access: result.access });
          pushResult(state, startedAt, {
            name: "chat_history_search",
            ok: true,
            stdout,
            stderr: "",
            timed_out: false,
            details: { query: result.query, hit_count: result.hits.length, source: "backend_runtime_tool" },
          });
          return { content: [{ type: "text", text: stdout }], details: { hits: result.hits, access: result.access, error: "" } };
        } catch (error) {
          const stderr = error instanceof Error ? error.message : String(error);
          pushResult(state, startedAt, {
            name: "chat_history_search",
            ok: false,
            stdout: "",
            stderr,
            timed_out: /timed out|timeout/i.test(stderr),
            details: { query: params.query, source: "backend_runtime_tool" },
          });
          return { content: [{ type: "text", text: stderr }], details: { hits: [], access: {}, error: stderr } };
        }
      },
    }),
    defineTool({
      name: "knowledge_search",
      label: "Knowledge Search",
      description: "Search allowed Kuuna knowledge snippets through the backend policy gate.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
      }),
      execute: async (_toolCallId, params) => {
        const startedAt = Date.now();
        try {
          const result = await callBackendSearchTool(state, "knowledge_search", {
            query: params.query,
            limit: params.limit,
          });
          const stdout = JSON.stringify({ query: result.query, hits: result.hits, access: result.access });
          pushResult(state, startedAt, {
            name: "knowledge_search",
            ok: true,
            stdout,
            stderr: "",
            timed_out: false,
            details: { query: result.query, hit_count: result.hits.length, source: "backend_runtime_tool" },
          });
          return { content: [{ type: "text", text: stdout }], details: { hits: result.hits, access: result.access, error: "" } };
        } catch (error) {
          const stderr = error instanceof Error ? error.message : String(error);
          if (stderr !== "runtime backend search endpoint is not configured") {
            pushResult(state, startedAt, {
              name: "knowledge_search",
              ok: false,
              stdout: "",
              stderr,
              timed_out: /timed out|timeout/i.test(stderr),
              details: {
                query: params.query,
                hit_count: 0,
                source: "backend_runtime_tool",
              },
            });
            return { content: [{ type: "text", text: stderr }], details: { hits: [], access: {}, error: stderr } };
          }
          const fallbackHits = contextArray(state.context, ["retrieval_hits", "retrievalRefs", "retrieval_refs"]);
          const stdout = JSON.stringify({ query: params.query, hits: fallbackHits, fallback_reason: stderr });
          pushResult(state, startedAt, {
            name: "knowledge_search",
            ok: fallbackHits.length > 0,
            stdout,
            stderr,
            timed_out: /timed out|timeout/i.test(stderr),
            details: {
              query: params.query,
              hit_count: fallbackHits.length,
              source: "preloaded_context_fallback",
            },
          });
          return { content: [{ type: "text", text: stdout }], details: { hits: fallbackHits, access: {}, error: stderr } };
        }
      },
    }),
    defineTool({
      name: "message_history",
      label: "Message History",
      description: "Read recent messages already scoped to this WhatsApp group.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum number of messages." })),
      }),
      execute: async (_toolCallId, params) => {
        const startedAt = Date.now();
        const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : 15;
        const messages = contextArray(state.context, ["recent_messages", "message_history"]).slice(0, limit);
        const stdout = JSON.stringify({ messages });
        pushResult(state, startedAt, {
          name: "message_history",
          ok: true,
          stdout,
          stderr: "",
          timed_out: false,
          details: { limit, message_count: messages.length },
        });
        return { content: [{ type: "text", text: stdout }], details: { messages } };
      },
    }),
    defineTool({
      name: "todo_create",
      label: "Create Todo",
      description: "Create a dashboard todo for the staff team.",
      parameters: Type.Object({
        title: Type.String({ description: "Short todo title." }),
        description: Type.Optional(Type.String({ description: "Todo details." })),
        priority: Type.Optional(Type.String({ description: "low, normal, high, or urgent." })),
        due_at: Type.Optional(Type.String({ description: "Optional due date/time." })),
      }),
      execute: async (_toolCallId, params) => {
        const startedAt = Date.now();
        const details = {
          operation: "create",
          title: params.title,
          description: params.description ?? "",
          priority: params.priority ?? "normal",
          due_at: params.due_at ?? null,
        };
        const stdout = JSON.stringify(details);
        pushResult(state, startedAt, {
          name: "todo_create",
          ok: true,
          stdout,
          stderr: "",
          timed_out: false,
          details,
        });
        return { content: [{ type: "text", text: stdout }], details };
      },
    }),
    defineTool({
      name: "todo_update",
      label: "Update Todo",
      description: "Update a dashboard todo for this group.",
      parameters: Type.Object({
        todo_id: Type.String({ description: "Todo id to update." }),
        title: Type.Optional(Type.String({ description: "New title." })),
        status: Type.Optional(Type.String({ description: "open, in_progress, done, or cancelled." })),
        description: Type.Optional(Type.String({ description: "New details." })),
        priority: Type.Optional(Type.String({ description: "low, normal, high, or urgent." })),
      }),
      execute: async (_toolCallId, params) => {
        const startedAt = Date.now();
        const details = { operation: "update", ...params };
        const stdout = JSON.stringify(details);
        pushResult(state, startedAt, {
          name: "todo_update",
          ok: true,
          stdout,
          stderr: "",
          timed_out: false,
          details,
        });
        return { content: [{ type: "text", text: stdout }], details };
      },
    }),
    defineTool({
      name: "todo_list",
      label: "List Todos",
      description: "Read open todos already scoped to this group.",
      parameters: Type.Object({
        status: Type.Optional(Type.String({ description: "Optional status filter." })),
      }),
      execute: async (_toolCallId, params) => {
        const startedAt = Date.now();
        const todos = contextArray(state.context, ["todos"]);
        const status = params.status;
        const filtered =
          typeof status === "string" && status
            ? todos.filter((todo) => {
                if (typeof todo !== "object" || todo === null) return false;
                return (todo as Record<string, unknown>).status === status;
              })
            : todos;
        const stdout = JSON.stringify({ todos: filtered });
        pushResult(state, startedAt, {
          name: "todo_list",
          ok: true,
          stdout,
          stderr: "",
          timed_out: false,
          details: { status: status ?? null, todo_count: filtered.length },
        });
        return { content: [{ type: "text", text: stdout }], details: { todos: filtered } };
      },
    }),
    ],
  );
  return tools;
}

export function executeExplicitTool(
  invocation: ToolInvocation,
  allowedTools: string[],
  context: Record<string, unknown>,
  runtimeConfig?: RuntimeAgentConfig,
): ToolExecutionResult {
  const startedAt = Date.now();
  const name = invocation.name.trim().toLowerCase();
  if (!sanitizeAllowedTools(allowedTools, runtimeConfig).includes(name)) {
    return {
      name,
      ok: false,
      stdout: "",
      stderr: `Tool '${name}' is not allowed.`,
      timed_out: false,
      duration_ms: nowMs(startedAt),
    };
  }

  const args = invocation.arguments ?? {};
  if (name === "uppercase") {
    return {
      name,
      ok: true,
      stdout: textArg(args, ["text", "input", "value"]).toUpperCase(),
      stderr: "",
      timed_out: false,
      duration_ms: nowMs(startedAt),
    };
  }

  if (name === "knowledge_search") {
    return {
      name,
      ok: true,
      stdout: JSON.stringify({ hits: contextArray(context, ["retrieval_hits", "retrieval_refs"]) }),
      stderr: "",
      timed_out: false,
      duration_ms: nowMs(startedAt),
    };
  }

  if (name === "message_history") {
    return {
      name,
      ok: true,
      stdout: JSON.stringify({ messages: contextArray(context, ["recent_messages", "message_history"]) }),
      stderr: "",
      timed_out: false,
      duration_ms: nowMs(startedAt),
    };
  }

  if (name === "todo_create") {
    const details = {
      operation: "create",
      title: textArg(args, ["title"]).trim(),
      description: textArg(args, ["description"]).trim(),
      priority: textArg(args, ["priority"]).trim() || "normal",
      due_at: textArg(args, ["due_at"]).trim() || null,
    };
    return {
      name,
      ok: Boolean(details.title),
      stdout: JSON.stringify(details),
      stderr: details.title ? "" : "todo_create requires title",
      timed_out: false,
      duration_ms: nowMs(startedAt),
      details,
    };
  }

  return {
    name,
    ok: false,
    stdout: "",
    stderr: `Tool '${name}' can only be executed by the agent.`,
    timed_out: false,
    duration_ms: nowMs(startedAt),
  };
}

function createAllowlistedBashTool(state: RuntimeToolState, allowlist: string[]): ToolDefinition {
  const bash = createBashToolDefinition(process.cwd());
  const allowedPrefixes = allowlist.map((item) => item.trim().toLowerCase()).filter(Boolean);
  const wrapped = {
    ...bash,
    execute: async (...args: Parameters<typeof bash.execute>) => {
      const [toolCallId, params, signal, onUpdate, ctx] = args;
      const bashParams = params as BashToolInput;
      const startedAt = Date.now();
      const command = bashParams.command.trim();
      if (!isBashCommandAllowed(command, allowedPrefixes)) {
        const stderr = `Command is not allowed. Allowed prefixes: ${allowedPrefixes.join(", ")}`;
        pushResult(state, startedAt, {
          name: "bash",
          ok: false,
          stdout: "",
          stderr,
          timed_out: false,
          details: { command, allowlist: allowedPrefixes },
        });
        return { content: [{ type: "text", text: stderr }], details: { command, allowlist: allowedPrefixes } };
      }

      try {
        const result = await bash.execute(toolCallId, bashParams, signal, onUpdate, ctx);
        pushResult(state, startedAt, {
          name: "bash",
          ok: true,
          stdout: resultText(result.content),
          stderr: "",
          timed_out: false,
          details: {
            command,
            ...(result.details && typeof result.details === "object" ? (result.details as BashToolDetails) : {}),
          },
        });
        return result;
      } catch (error) {
        const stderr = error instanceof Error ? error.message : String(error);
        pushResult(state, startedAt, {
          name: "bash",
          ok: false,
          stdout: "",
          stderr,
          timed_out: /timed out|timeout/i.test(stderr),
          details: { command },
        });
        throw error;
      }
    },
  };
  return wrapped as ToolDefinition;
}

export function isBashCommandAllowed(command: string, allowlist: string[]): boolean {
  const normalizedCommand = normalizeBashCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  if (allowsPythonFamily(allowlist) && isPythonCommandAllowed(command)) {
    return true;
  }

  if (unsafeBashCommandPattern.test(command)) {
    return false;
  }

  return allowlist
    .map(normalizeBashCommand)
    .filter(Boolean)
    .some((prefix) => normalizedCommand === prefix || normalizedCommand.startsWith(`${prefix} `));
}

function allowsPythonFamily(allowlist: string[]): boolean {
  return allowlist.map(normalizeBashCommand).some((prefix) => prefix === "python");
}

function isPythonCommandAllowed(command: string): boolean {
  const trimmed = command.trim();
  if (!pythonCommandPattern.test(trimmed.toLowerCase())) {
    return false;
  }
  if (/[`\r]/.test(trimmed) || trimmed.includes("$(")) {
    return false;
  }
  if (isQuotedPythonHeredoc(trimmed)) {
    return true;
  }
  return !hasUnquotedShellControl(trimmed);
}

function isQuotedPythonHeredoc(command: string): boolean {
  const match = command.match(/^(python(?:\d+(?:\.\d+)*)?)\s+-\s+<<'([A-Za-z_][A-Za-z0-9_]*)'\n([\s\S]*)\n\2$/);
  return Boolean(match);
}

function hasUnquotedShellControl(command: string): boolean {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "\"" && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === "\"") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      continue;
    }
    if (!quote && /[;&|<>\n]/.test(char)) {
      return true;
    }
  }
  return quote !== null;
}

function normalizeBashCommand(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, " ");
}

function resultText(content: Array<{ type: string; text?: string }>): string {
  return content
    .map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}
