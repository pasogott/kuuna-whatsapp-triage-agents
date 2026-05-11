import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_REASONING_EFFORT,
  type ReasoningEffort,
} from "@kuuna/agent-contracts";
import type { Transport } from "@earendil-works/pi-ai";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const MAX_MODEL_ATTEMPTS = 2;
const DEFAULT_PI_TRANSPORT: Transport = "websocket-cached";

export function openAiApiKey(): string | undefined {
  const value = process.env.OPENAI_API_KEY?.trim();
  return value || undefined;
}

export function openAiBaseUrl(): string {
  const value = process.env.OPENAI_BASE_URL?.trim();
  return (value || DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");
}

export function openAiTimeoutSeconds(): string {
  return process.env.OPENAI_TIMEOUT_SECONDS ?? "30";
}

export function piAuthPath(): string | undefined {
  const value = process.env.PI_AUTH_PATH?.trim() || process.env.PI_AUTH_FILE?.trim();
  return value || undefined;
}

export function piTransport(): Transport {
  const value = process.env.PI_TRANSPORT?.trim();
  if (value === "sse" || value === "websocket" || value === "websocket-cached" || value === "auto") {
    return value;
  }
  return DEFAULT_PI_TRANSPORT;
}

export function openAiTimeoutMs(): number {
  const parsed = Number(openAiTimeoutSeconds());
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 30_000;
}

export function openAiVisionModel(): string {
  return process.env.OPENAI_VISION_MODEL?.trim() || "gpt-4.1-mini";
}

export function openAiAudioTranscriptionModel(): string {
  return process.env.OPENAI_AUDIO_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";
}

export function defaultModel(): string {
  return process.env.RUNTIME_AGENT_DEFAULT_MODEL?.trim() || DEFAULT_AGENT_MODEL;
}

export function defaultReasoningEffort(): ReasoningEffort {
  const value = process.env.RUNTIME_AGENT_REASONING_EFFORT?.trim();
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return DEFAULT_REASONING_EFFORT;
}

export function kuunaProviderGroupId(): string | undefined {
  const value = process.env.KUUNA_PROVIDER_GROUP_ID?.trim();
  return value || undefined;
}

export function kuunaBindingId(): string | undefined {
  const value = process.env.KUUNA_BINDING_ID?.trim();
  return value || undefined;
}

export function kuunaAgentInstanceId(): string | undefined {
  const value = process.env.KUUNA_AGENT_INSTANCE_ID?.trim();
  return value || undefined;
}

export function kuunaRuntimeToolBackendBaseUrl(): string | undefined {
  const value = process.env.KUUNA_RUNTIME_TOOL_BACKEND_BASE_URL?.trim();
  return value ? value.replace(/\/$/, "") : undefined;
}

export function kuunaRuntimeToolToken(): string | undefined {
  const value = process.env.KUUNA_RUNTIME_TOOL_TOKEN?.trim();
  return value || undefined;
}
