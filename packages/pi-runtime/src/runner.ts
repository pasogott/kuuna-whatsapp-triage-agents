import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_REASONING_EFFORT,
  runtimeAgentRequestSchema,
  type ModelAttempt,
  type RuntimeAgentRequest,
  type RuntimeAgentResult,
  type RuntimeMediaInsight,
  type ToolExecutionResult,
} from "@kuuna/agent-contracts";
import {
  defaultModel,
  defaultReasoningEffort,
  kuunaAgentInstanceId,
  kuunaBindingId,
  kuunaProviderGroupId,
  openAiApiKey,
  piAuthPath,
  piTransport,
} from "./config.js";
import { getOpenAiModel, modelPath, piThinkingLevel } from "./model.js";
import { analyzeRuntimeMedia } from "./media-insights.js";
import { buildPrompt } from "./prompt.js";
import { createKuunaTools, executeExplicitTool, sanitizeAllowedTools } from "./tools.js";

function placeholderResponse(modelName: string, request: RuntimeAgentRequest): string {
  return [`[${modelName}] Processed request.`, `User: ${request.user_prompt}`].join("\n");
}

function lastAssistantText(messages: unknown[]): string {
  for (const message of messages.slice().reverse()) {
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }

    const content = record.content;
    if (typeof content === "string") {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part !== "object" || part === null) {
            return "";
          }
          const item = part as Record<string, unknown>;
          return item.type === "text" && typeof item.text === "string" ? item.text : "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function lastAssistantError(messages: unknown[]): string | undefined {
  for (const message of messages.slice().reverse()) {
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    if (typeof record.errorMessage === "string" && record.errorMessage.trim()) {
      return record.errorMessage.trim();
    }
  }
  return undefined;
}

function contextString(context: Record<string, unknown>, key: string): string | undefined {
  const value = context[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertRuntimeIdentity(request: RuntimeAgentRequest): void {
  const expectedProviderGroupId = kuunaProviderGroupId();
  const expectedBindingId = kuunaBindingId();
  const expectedAgentInstanceId = kuunaAgentInstanceId();
  const context = request.context ?? {};

  const providerGroupId = contextString(context, "provider_group_id");
  if (expectedProviderGroupId && providerGroupId !== expectedProviderGroupId) {
    throw new Error("runtime identity mismatch: provider_group_id");
  }

  const bindingId = contextString(context, "binding_id");
  if (expectedBindingId && bindingId !== expectedBindingId) {
    throw new Error("runtime identity mismatch: binding_id");
  }

  const agentInstanceId = contextString(context, "agent_instance_id");
  if (expectedAgentInstanceId && agentInstanceId !== expectedAgentInstanceId) {
    throw new Error("runtime identity mismatch: agent_instance_id");
  }
}

async function runPiAttempt(
  request: RuntimeAgentRequest,
  modelName: string,
  allowedTools: string[],
  mediaInsights: RuntimeMediaInsight[],
): Promise<{ responseText: string; toolResults: ToolExecutionResult[] }> {
  const model = getOpenAiModel(modelName);
  if (!model) {
    throw new Error(`OpenAI model '${modelName}' is not available in Pi model registry`);
  }

  const prompt = buildPrompt({
    ...request,
    context: { ...(request.context ?? {}), media_insights: mediaInsights },
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
    transport: piTransport(),
  });
  const authStorage = piAuthPath() ? AuthStorage.create(piAuthPath()) : AuthStorage.create();
  const apiKey = openAiApiKey();
  if (apiKey) {
    authStorage.setRuntimeApiKey("openai", apiKey);
  }
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: "/tmp/kuuna-pi-agent",
    settingsManager,
    systemPromptOverride: () => prompt.systemPrompt,
  });
  await resourceLoader.reload();

  const toolState = {
    context: { ...(request.context ?? {}), media_insights: mediaInsights },
    results: [] as ToolExecutionResult[],
    mediaInsights,
  };
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: "/tmp/kuuna-pi-agent",
    model,
    thinkingLevel: piThinkingLevel(request.reasoning_effort),
    authStorage,
    modelRegistry,
    noTools: "builtin",
    tools: allowedTools,
    customTools: createKuunaTools(toolState, request.runtime_config),
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
  });

  let streamedText = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_update") {
      return;
    }
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      streamedText += update.delta;
    }
  });

  try {
    const userMessage = prompt.contextBlock
      ? `Kontext:\n${prompt.contextBlock}\n\nNutzeranfrage:\n${prompt.userPrompt}`
      : prompt.userPrompt;
    await session.prompt(userMessage);
    const messages = session.messages as unknown[];
    const responseText = streamedText.trim() || lastAssistantText(messages);
    if (!responseText) {
      throw new Error(lastAssistantError(messages) ?? "Pi returned an empty assistant response");
    }
    return { responseText, toolResults: toolState.results };
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export async function runAgent(input: unknown): Promise<RuntimeAgentResult> {
  const request = runtimeAgentRequestSchema.parse(input);
  assertRuntimeIdentity(request);
  const mediaInsights = await analyzeRuntimeMedia(request.context.media_attachments ?? []);
  const enrichedRequest: RuntimeAgentRequest = {
    ...request,
    context: { ...(request.context ?? {}), media_insights: mediaInsights },
  };
  const prompt = buildPrompt(enrichedRequest);
  const selectedModelPath = modelPath(request.model_path);
  const reasoningEffort = request.reasoning_effort ?? defaultReasoningEffort() ?? DEFAULT_REASONING_EFFORT;
  const allowedTools = sanitizeAllowedTools(request.allowed_tools, request.runtime_config);

  const attempts: ModelAttempt[] = [];
  let responseText: string | undefined;
  let modelUsed: string | undefined;
  let lastError: string | undefined;
  let modelToolResults: ToolExecutionResult[] = [];

  for (const modelName of selectedModelPath) {
    try {
      if (!openAiApiKey()) {
        responseText = placeholderResponse(modelName || defaultModel(), enrichedRequest);
        modelToolResults = [];
      } else {
        const result = await runPiAttempt(enrichedRequest, modelName, allowedTools, mediaInsights);
        responseText = result.responseText;
        modelToolResults = result.toolResults;
      }
      attempts.push({ model: modelName, success: true });
      modelUsed = modelName;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      attempts.push({ model: modelName, success: false, error: lastError });
    }
  }

  if (!modelUsed || !responseText) {
    return {
      success: false,
      prompt: prompt.fullPrompt,
      system_prompt: prompt.systemPrompt,
      user_prompt: prompt.userPrompt,
      context_block: prompt.contextBlock,
      model_used: null,
      reasoning_effort: reasoningEffort,
      attempts,
      response_text: null,
      tool_results: [],
      media_insights: mediaInsights,
      error: lastError ?? "no model candidates available",
    };
  }

  const modelCreatedTodo = modelToolResults.some((result) => result.ok && result.name === "todo_create");
  const requestedToolResults = request.tool_requests
    .filter((toolRequest) => !(toolRequest.name.trim().toLowerCase() === "todo_create" && modelCreatedTodo))
    .map((toolRequest) => executeExplicitTool(toolRequest, allowedTools, request.context, request.runtime_config));
  const toolResults = [...modelToolResults, ...requestedToolResults];

  return {
    success: true,
    prompt: prompt.fullPrompt,
    system_prompt: prompt.systemPrompt,
    user_prompt: prompt.userPrompt,
    context_block: prompt.contextBlock,
    model_used: modelUsed,
    reasoning_effort: reasoningEffort,
    attempts,
    response_text: responseText,
    tool_results: toolResults,
    media_insights: mediaInsights,
    error: null,
  };
}
