"use server";

import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { requireAuthorized } from "@/lib/auth/guards";
import { createSessionBackendTrpcClient } from "@/lib/backend/client";

function clean(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeTemplateKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_.\s]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

function splitCsvLike(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeKnowledgeDocKeys(value: string | null): string | string[] {
  if (!value) {
    return "*";
  }

  const normalized = value.trim();
  if (!normalized || normalized === "*") {
    return "*";
  }

  if (["none", "off", "false"].includes(normalized.toLowerCase())) {
    return "none";
  }

  return splitCsvLike(normalized);
}

function selectedDocKeys(values: FormDataEntryValue[]): string[] {
  const keys = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(keys));
}

function allowedToolKeys(values: string[]): string[] {
  return values.filter((tool) => tool !== "context_lookup" && tool !== "send_whatsapp");
}

function knowledgeDocKeysFromMode(
  mode: string | null,
  selectedKeys: string[],
  fallbackText: string | null,
): string | string[] {
  if (mode === "all") {
    return "*";
  }
  if (mode === "none") {
    return "none";
  }
  if (mode === "selected") {
    return selectedKeys.length ? selectedKeys : "none";
  }
  return normalizeKnowledgeDocKeys(fallbackText);
}

function shortReason(reason: string): string {
  return reason.slice(0, 220);
}

function rethrowRedirectError(error: unknown): void {
  if (isRedirectError(error)) {
    throw error;
  }
}

const TEMPLATE_RUNTIME_BASE_IMAGE = "node:24-bookworm";
const GONDOLIN_PROFILES = new Set(["base", "python", "media"]);

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function createTemplateAction(formData: FormData): Promise<void> {
  await requireAuthorized("templates", "write");

  const keyInput = clean(formData.get("key"));
  const displayName = clean(formData.get("displayName"));

  if (!keyInput || !displayName) {
    redirect("/templates/new?error=missing-fields");
  }

  const key = normalizeTemplateKey(keyInput);
  if (!key) {
    redirect("/templates/new?error=invalid-key");
  }

  try {
    const client = await createSessionBackendTrpcClient();
    const payload = await client.templates.create.mutate({
      key,
      displayName,
    });

    if (payload.id) {
      redirect(`/templates/${encodeURIComponent(payload.id)}?created=1`);
    }

    redirect("/templates?created=1");
  } catch (error) {
    rethrowRedirectError(error);
    const reason = error instanceof Error ? error.message : String(error);
    redirect(`/templates/new?error=${encodeURIComponent(shortReason(reason))}`);
  }
}

export async function saveTemplateVersionAction(formData: FormData): Promise<void> {
  const session = await requireAuthorized("templates", "publish");

  const templateId = clean(formData.get("templateId"));
  const systemPrompt = clean(formData.get("systemPrompt")) ?? "";
  const modelChainInput = clean(formData.get("modelChain"));
  const allowedToolsInput = clean(formData.get("allowedTools"));
  const explicitAllowedTools = formData.get("allowedToolSelection") === "explicit";
  const commonKnowledgeDocKeys = knowledgeDocKeysFromMode(
    clean(formData.get("commonKnowledgeMode")),
    selectedDocKeys(formData.getAll("commonKnowledgeDocKey")),
    clean(formData.get("commonKnowledgeDocKeys")),
  );
  const groupKnowledgeDocKeys = knowledgeDocKeysFromMode(
    clean(formData.get("groupKnowledgeMode")),
    selectedDocKeys(formData.getAll("groupKnowledgeDocKey")),
    clean(formData.get("groupKnowledgeDocKeys")),
  );
  const includeGroupKnowledge = groupKnowledgeDocKeys !== "none";
  const includeChatHistorySearch = formData.get("includeChatHistorySearch") === "on";
  const dockerfileSnippet = clean(formData.get("dockerfileSnippet"));
  const requestedGondolinProfile = clean(formData.get("gondolinProfile")) ?? "base";
  const gondolinProfile = requestedGondolinProfile.toLowerCase();
  const piBashEnabled = formData.get("piBashEnabled") === "on";
  const piBashAllowlist = splitCsvLike(clean(formData.get("piBashAllowlist")));

  if (!templateId) {
    redirect("/templates?error=missing-template-id");
  }
  if (!isUuid(session.userId)) {
    redirect(
      `/templates/${encodeURIComponent(templateId)}?error=${encodeURIComponent(
        "Template save failed: session.userId is not a UUID. Please sign in again.",
      )}`,
    );
  }
  if (piBashEnabled && piBashAllowlist.length === 0) {
    redirect(
      `/templates/${encodeURIComponent(templateId)}?error=${encodeURIComponent(
        "Pi runtime image: Bash allowlist is required when Pi bash exec is enabled.",
      )}`,
    );
  }
  if (!GONDOLIN_PROFILES.has(gondolinProfile)) {
    redirect(
      `/templates/${encodeURIComponent(templateId)}?error=${encodeURIComponent(
        "Pi runtime image: unsupported Gondolin guest profile.",
      )}`,
    );
  }

  const modelChain = splitCsvLike(modelChainInput);
  const selectedAllowedTools = selectedDocKeys(formData.getAll("allowedTool")).map((tool) =>
    tool.toLowerCase(),
  );
  const allowedTools = explicitAllowedTools
    ? allowedToolKeys(selectedAllowedTools)
    : allowedToolKeys(splitCsvLike(allowedToolsInput).map((tool) => tool.toLowerCase()));
  const effectiveAllowedTools = Array.from(new Set(allowedTools));
  if (
    (commonKnowledgeDocKeys !== "none" || includeGroupKnowledge) &&
    !effectiveAllowedTools.includes("knowledge_search")
  ) {
    effectiveAllowedTools.push("knowledge_search");
  }
  if (includeChatHistorySearch && !effectiveAllowedTools.includes("chat_history_search")) {
    effectiveAllowedTools.push("chat_history_search");
  }
  if (piBashEnabled && !effectiveAllowedTools.includes("bash")) {
    effectiveAllowedTools.push("bash");
  }

  try {
    const client = await createSessionBackendTrpcClient();
    const version = await client.templates.createVersion.mutate({
      templateId,
      systemPrompt,
      modelConfig: {
        failover_chain: modelChain.length ? modelChain : ["gpt-5.5"],
        reasoning_effort: "medium",
      },
      toolsConfig: {
        allowed_tools: effectiveAllowedTools,
        knowledge: {
          common_doc_keys: commonKnowledgeDocKeys,
          group_doc_keys: groupKnowledgeDocKeys,
          include_group_knowledge: includeGroupKnowledge,
        },
        runtime_image: {
          base_image: TEMPLATE_RUNTIME_BASE_IMAGE,
          dockerfile_snippet: dockerfileSnippet,
          gondolin_profile: gondolinProfile,
          pi_bash_enabled: piBashEnabled,
          pi_bash_allowlist: piBashAllowlist,
        },
      },
      egressPolicy: {
        mode: "restricted",
      },
    });

    await client.templates.publishVersion.mutate({
      templateId,
      versionId: version.id,
    });

    const build = await client.templates.queueBuild.mutate({
      templateId,
      versionId: version.id,
      actorUserId: session.userId,
      baseImage: TEMPLATE_RUNTIME_BASE_IMAGE,
      allowedTools: null,
    });

    const params = new URLSearchParams({ saved: "1" });
    params.set("versionId", version.id);
    params.set("buildId", build.id);
    redirect(`/templates/${encodeURIComponent(templateId)}?${params.toString()}`);
  } catch (error) {
    rethrowRedirectError(error);
    const reason = error instanceof Error ? error.message : String(error);
    redirect(
      `/templates/${encodeURIComponent(templateId)}?error=${encodeURIComponent(shortReason(reason))}`,
    );
  }
}
