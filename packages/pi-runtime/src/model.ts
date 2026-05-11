import { getModel, type Api, type Model } from "@earendil-works/pi-ai";
import type { ReasoningEffort } from "@kuuna/agent-contracts";
import { defaultModel, defaultReasoningEffort, MAX_MODEL_ATTEMPTS } from "./config.js";

const openAiCodexProvider = "openai-codex";

function splitProviderModel(modelName: string): { provider: string | undefined; modelName: string } {
  const trimmed = modelName.trim();
  for (const separator of ["/", ":"]) {
    const index = trimmed.indexOf(separator);
    if (index <= 0) {
      continue;
    }
    const provider = trimmed.slice(0, index);
    if (provider === "openai" || provider === openAiCodexProvider) {
      return { provider, modelName: trimmed.slice(index + 1) };
    }
  }
  return { provider: undefined, modelName: trimmed };
}

export function normalizeModelName(modelName: string): string {
  const parsed = splitProviderModel(modelName);
  if (!parsed.modelName) {
    return "";
  }
  return parsed.modelName;
}

export function modelPath(candidates: string[]): string[] {
  const normalized = candidates
    .map(normalizeModelName)
    .filter((candidate) => candidate.length > 0);
  const unique = normalized.filter((candidate, index) => normalized.indexOf(candidate) === index);
  return (unique.length ? unique : [defaultModel()]).slice(0, MAX_MODEL_ATTEMPTS);
}

export function piThinkingLevel(effort: ReasoningEffort | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const selected = effort ?? defaultReasoningEffort();
  return selected === "none" ? "off" : selected;
}

export function getOpenAiModel(modelName: string): Model<Api> | undefined {
  const parsed = splitProviderModel(modelName);
  return getModel(openAiCodexProvider as never, parsed.modelName as never);
}
