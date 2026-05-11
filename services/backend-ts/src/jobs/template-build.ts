import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, desc, eq } from "drizzle-orm";

import { getSettings } from "../config.js";
import type { Database, DbLike } from "../db/client.js";
import { auditEvents, groupTemplates, templateBuilds, templateVersions } from "../db/schema.js";
import { logger } from "../logging.js";
import { publishRuntimeEvent } from "../runtime/events.js";
import { enqueueKuunaJob, type EnqueueKuunaJob } from "./queues.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const baseImagePattern = /^[a-zA-Z0-9._/:@-]+$/;
const gondolinProfilePattern = /^[a-z0-9._-]+$/;
const tagSafePattern = /[^a-zA-Z0-9._-]+/g;
const dockerfileSnippetMaxLength = 8000;
const blockedDockerfileInstructions = new Set(["from", "cmd", "entrypoint", "expose"]);
const disabledToolKeys = new Set(["context_lookup", "send_whatsapp"]);

export type TemplateBuildRow = typeof templateBuilds.$inferSelect;

export type CommandResult = {
  returncode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export class TemplateBuildValidationError extends Error {}
export class TemplateBuildNotFoundError extends Error {}

export type QueueTemplateBuildInput = {
  actorUserId: string;
  templateId: string;
  versionId: string;
  baseImage: string;
  allowedTools?: string[] | null;
  dockerfileSnippet?: string | null;
  piBashEnabled?: boolean | null;
  piBashAllowlist?: string[] | null;
  gondolinProfile?: string | null;
};

export async function queueTemplateBuild(
  database: Database,
  input: QueueTemplateBuildInput,
  options: { enqueueJob?: EnqueueKuunaJob } = {},
): Promise<TemplateBuildRow> {
  const [template] = await database
    .select()
    .from(groupTemplates)
    .where(eq(groupTemplates.id, input.templateId))
    .limit(1);
  if (!template) {
    throw new TemplateBuildValidationError("template not found");
  }

  const [version] = await database
    .select()
    .from(templateVersions)
    .where(and(eq(templateVersions.id, input.versionId), eq(templateVersions.templateId, input.templateId)))
    .limit(1);
  if (!version) {
    throw new TemplateBuildValidationError("template version not found");
  }
  if (version.status !== "published") {
    throw new TemplateBuildValidationError("only published template versions can be built");
  }

  const runtimeImageConfig = extractRuntimeImageConfig(version.toolsConfig);
  const baseImage = validateBaseImage(input.baseImage);
  const allowedTools = input.allowedTools
    ? normalizeAllowedTools(input.allowedTools)
    : extractAllowedTools(version.toolsConfig);
  const dockerfileSnippet = validateDockerfileSnippet(
    input.dockerfileSnippet !== undefined
      ? input.dockerfileSnippet
      : runtimeImageConfig.dockerfileSnippet,
  );
  const piBashEnabled = input.piBashEnabled ?? runtimeImageConfig.piBashEnabled;
  const piBashAllowlist = normalizeStringList(input.piBashAllowlist ?? runtimeImageConfig.piBashAllowlist);
  const gondolinProfile = validateGondolinProfile(input.gondolinProfile ?? runtimeImageConfig.gondolinProfile);
  if (piBashEnabled && piBashAllowlist.length === 0) {
    throw new TemplateBuildValidationError("pi_bash_allowlist is required when Pi bash exec is enabled");
  }

  const buildInputs = {
    base_image: baseImage,
    allowed_tools: allowedTools,
    dockerfile_snippet: dockerfileSnippet || null,
    pi_bash_enabled: piBashEnabled,
    pi_bash_allowlist: piBashAllowlist,
    gondolin_profile: gondolinProfile,
    egress_policy: version.egressPolicy,
    tools_config: version.toolsConfig,
    model_config: version.modelConfig,
  };

  const [build] = await database.transaction(async (tx) => {
    const [created] = await tx
      .insert(templateBuilds)
      .values({
        templateId: input.templateId,
        templateVersionId: input.versionId,
        status: "queued",
        buildInputs,
      })
      .returning();
    if (!created) {
      throw new Error("template build creation failed");
    }

    await tx.insert(auditEvents).values({
      actorUserId: input.actorUserId,
      eventType: "template_build.queued",
      entityType: "template_build",
      entityId: created.id,
      payload: {
        template_id: input.templateId,
        template_version_id: input.versionId,
      },
    });

    return [created];
  });

  const enqueueJob = options.enqueueJob ?? enqueueKuunaJob;
  await enqueueJob("template_build", { build_id: build.id }, `template_build_${jobToken(build.id)}`);
  await publishRuntimeEvent({
    type: "template_build.updated",
    entityId: build.id,
    entityType: "template_build",
    payload: {
      status: "queued",
      template_id: build.templateId,
      template_version_id: build.templateVersionId,
    },
  });
  return build;
}

export async function listTemplateBuildsForVersion(
  database: DbLike,
  input: { templateId: string; versionId: string },
): Promise<TemplateBuildRow[]> {
  const [version] = await database
    .select({ id: templateVersions.id })
    .from(templateVersions)
    .where(and(eq(templateVersions.id, input.versionId), eq(templateVersions.templateId, input.templateId)))
    .limit(1);
  if (!version) {
    throw new TemplateBuildValidationError("template version not found");
  }

  return database
    .select()
    .from(templateBuilds)
    .where(eq(templateBuilds.templateVersionId, input.versionId))
    .orderBy(desc(templateBuilds.createdAt), desc(templateBuilds.id));
}

export async function getTemplateBuild(database: DbLike, buildId: string): Promise<TemplateBuildRow> {
  const [build] = await database
    .select()
    .from(templateBuilds)
    .where(eq(templateBuilds.id, buildId))
    .limit(1);
  if (!build) {
    throw new TemplateBuildNotFoundError("template build not found");
  }
  return build;
}

export async function processTemplateBuildJob(
  database: DbLike,
  input: { buildId: string },
  options: { commandRunner?: CommandRunner } = {},
): Promise<{ processed: boolean; status: "succeeded" | "failed" | "invalid" | "not_found" }> {
  if (!uuidPattern.test(input.buildId)) {
    logger.error("template_build_invalid_build_id", { build_id: input.buildId });
    return { processed: false, status: "invalid" };
  }

  const [build] = await database
    .select()
    .from(templateBuilds)
    .where(eq(templateBuilds.id, input.buildId))
    .limit(1);
  if (!build) {
    logger.error("template_build_not_found", { build_id: input.buildId });
    return { processed: false, status: "not_found" };
  }

  const [template] = await database
    .select()
    .from(groupTemplates)
    .where(eq(groupTemplates.id, build.templateId))
    .limit(1);
  const [version] = await database
    .select()
    .from(templateVersions)
    .where(eq(templateVersions.id, build.templateVersionId))
    .limit(1);
  if (!template || !version) {
    await markFailed(database, build, "missing template/version rows");
    return { processed: true, status: "failed" };
  }

  await database
    .update(templateBuilds)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(templateBuilds.id, build.id));
  await publishRuntimeEvent({
    type: "template_build.updated",
    entityId: build.id,
    entityType: "template_build",
    payload: {
      status: "running",
      template_id: build.templateId,
      template_version_id: build.templateVersionId,
    },
  });

  const buildInputs = objectRecord(build.buildInputs);
  const baseImage = typeof buildInputs.base_image === "string" ? buildInputs.base_image.trim() : "";
  if (!baseImage) {
    await markFailed(database, build, "missing base_image in build_inputs");
    return { processed: true, status: "failed" };
  }
  const snippetResult = validateDockerfileSnippetForJob(buildInputs.dockerfile_snippet);
  if (!snippetResult.ok) {
    await markFailed(database, build, snippetResult.error);
    return { processed: true, status: "failed" };
  }

  const settings = getSettings();
  const docker = settings.DOCKER_CLI_PATH;
  const imageTag = buildImageTag(template.key, build.id);
  const generatedDockerfile = await createTemplateBuildDockerfile({
    sourceDockerfilePath: settings.TEMPLATE_BUILD_DOCKERFILE_PATH,
    snippet: snippetResult.snippet,
  }).catch(async (error: unknown) => {
    await markFailed(database, build, `failed to prepare Dockerfile: ${errorMessage(error)}`);
    return null;
  });
  if (!generatedDockerfile) {
    return { processed: true, status: "failed" };
  }
  const buildArgs = [
    "build",
    "-f",
    generatedDockerfile.path,
    "--build-arg",
    `BASE_IMAGE=${baseImage}`,
    "--build-arg",
    `KUUNA_TEMPLATE_KEY=${template.key}`,
    "--build-arg",
    `KUUNA_TEMPLATE_VERSION_ID=${version.id}`,
    "-t",
    imageTag,
    settings.TEMPLATE_BUILD_CONTEXT_PATH,
  ];
  const runner = options.commandRunner ?? runCommand;
  let inspect: CommandResult;
  try {
    const completed = await runner(docker, buildArgs);
    const logs = JSON.stringify({
      command: [docker, ...buildArgs],
      returncode: completed.returncode,
      stdout_tail: tail(completed.stdout, 4000),
      stderr_tail: tail(completed.stderr, 4000),
    });

    await database
      .update(templateBuilds)
      .set({ logsRef: logs, updatedAt: new Date() })
      .where(eq(templateBuilds.id, build.id));

    if (completed.returncode !== 0) {
      await markFailed(database, build, `docker build failed (exit ${completed.returncode})`);
      return { processed: true, status: "failed" };
    }

    inspect = await runner(docker, ["image", "inspect", "--format", "{{json .RepoDigests}}", imageTag]);
  } catch (error) {
    const message = errorMessage(error);
    const logs = JSON.stringify({
      command: [docker, ...buildArgs],
      returncode: null,
      stdout_tail: "",
      stderr_tail: tail(message, 4000),
    });
    await database
      .update(templateBuilds)
      .set({ logsRef: logs, updatedAt: new Date() })
      .where(eq(templateBuilds.id, build.id));
    await markFailed(database, build, `docker build failed: ${message}`);
    return { processed: true, status: "failed" };
  } finally {
    await generatedDockerfile.cleanup();
  }
  const imageRef = parseFirstDigest(inspect) ?? imageTag;

  await database
    .update(templateBuilds)
    .set({
      status: "succeeded",
      imageRef: imageRef.slice(0, 512),
      imageTag: imageTag.slice(0, 255),
      updatedAt: new Date(),
    })
    .where(eq(templateBuilds.id, build.id));

  await database.insert(auditEvents).values({
    actorUserId: null,
    eventType: "template_build.succeeded",
    entityType: "template_build",
    entityId: build.id,
    payload: {
      template_id: template.id,
      template_version_id: version.id,
      image_ref: imageRef.slice(0, 512),
    },
  });
  await publishRuntimeEvent({
    type: "template_build.updated",
    entityId: build.id,
    entityType: "template_build",
    payload: {
      status: "succeeded",
      template_id: template.id,
      template_version_id: version.id,
      image_ref: imageRef.slice(0, 512),
    },
  });

  return { processed: true, status: "succeeded" };
}

export function formatTemplateBuild(build: TemplateBuildRow) {
  return {
    id: build.id,
    template_id: build.templateId,
    template_version_id: build.templateVersionId,
    status: build.status,
    image_ref: build.imageRef,
    image_tag: build.imageTag,
    build_inputs: build.buildInputs,
    logs_ref: build.logsRef,
    created_at: build.createdAt.toISOString(),
    updated_at: build.updatedAt.toISOString(),
  };
}

function validateBaseImage(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TemplateBuildValidationError("base_image is required");
  }
  if (normalized.length > 255) {
    throw new TemplateBuildValidationError("base_image is too long");
  }
  if (!baseImagePattern.test(normalized)) {
    throw new TemplateBuildValidationError("base_image contains invalid characters");
  }
  return normalized;
}

function normalizeStringList(values: string[]): string[] {
  const normalized: string[] = [];
  for (const item of values) {
    const value = item.trim().toLowerCase();
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

function validateDockerfileSnippet(value: string | null): string {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return "";
  }
  const invalid = dockerfileSnippetValidationError(normalized);
  if (invalid) {
    throw new TemplateBuildValidationError(invalid);
  }
  return normalized;
}

function validateDockerfileSnippetForJob(value: unknown): { ok: true; snippet: string } | { ok: false; error: string } {
  if (value === null || value === undefined) {
    return { ok: true, snippet: "" };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "dockerfile_snippet must be a string" };
  }
  const snippet = value.trim();
  if (!snippet) {
    return { ok: true, snippet: "" };
  }
  const invalid = dockerfileSnippetValidationError(snippet);
  return invalid ? { ok: false, error: invalid } : { ok: true, snippet };
}

function dockerfileSnippetValidationError(snippet: string): string | null {
  if (snippet.length > dockerfileSnippetMaxLength) {
    return `dockerfile_snippet is too long (max ${dockerfileSnippetMaxLength} chars)`;
  }
  for (const line of snippet.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const instruction = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
    if (instruction && blockedDockerfileInstructions.has(instruction)) {
      return `dockerfile_snippet cannot contain ${instruction.toUpperCase()} instructions`;
    }
  }
  return null;
}

async function createTemplateBuildDockerfile(input: {
  sourceDockerfilePath: string;
  snippet: string;
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (!input.snippet) {
    return { path: input.sourceDockerfilePath, cleanup: async () => undefined };
  }

  const source = await readFile(input.sourceDockerfilePath, "utf8");
  const marker = "RUN npm install -g pnpm@10.33.2";
  const markerIndex = source.indexOf(marker);
  const content = markerIndex >= 0
    ? `${source.slice(0, markerIndex + marker.length)}\n\n# Kuuna template build customization\n${input.snippet}\n\n${source.slice(markerIndex + marker.length).trimStart()}`
    : `${source}\n\n# Kuuna template build customization\n${input.snippet}\n`;
  const dir = await mkdtemp(path.join(tmpdir(), "kuuna-template-build-"));
  const generatedPath = path.join(dir, "Dockerfile");
  await writeFile(generatedPath, content, "utf8");
  return {
    path: generatedPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function extractAllowedTools(toolsConfig: unknown): string[] {
  if (!toolsConfig || typeof toolsConfig !== "object" || Array.isArray(toolsConfig)) {
    return [];
  }
  const config = toolsConfig as Record<string, unknown>;
  const candidates: string[] = [];
  for (const key of ["allowed_tools", "allowedTools"]) {
    const raw = config[key];
    if (Array.isArray(raw)) {
      candidates.push(...raw.filter((item): item is string => typeof item === "string"));
    }
  }
  const rawTools = config.tools;
  if (Array.isArray(rawTools)) {
    for (const item of rawTools) {
      if (typeof item === "string") {
        candidates.push(item);
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        if (typeof record.name === "string" && record.name && record.enabled !== false) {
          candidates.push(record.name);
        }
      }
    }
  }

  return normalizeAllowedTools(candidates);
}

function normalizeAllowedTools(candidates: string[]): string[] {
  const normalized: string[] = [];
  for (const candidate of candidates) {
    const value = candidate.trim().toLowerCase();
    if (value && !disabledToolKeys.has(value) && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function extractRuntimeImageConfig(toolsConfig: unknown): {
  dockerfileSnippet: string | null;
  piBashEnabled: boolean;
  piBashAllowlist: string[];
  gondolinProfile: string;
} {
  const config = objectRecord(toolsConfig);
  const runtimeImage = objectRecord(config.runtime_image ?? config.runtimeImage);
  const snippet =
    typeof runtimeImage.dockerfile_snippet === "string"
      ? runtimeImage.dockerfile_snippet
      : typeof runtimeImage.dockerfileSnippet === "string"
        ? runtimeImage.dockerfileSnippet
        : null;
  return {
    dockerfileSnippet: snippet,
    piBashEnabled: runtimeImage.pi_bash_enabled === true || runtimeImage.piBashEnabled === true,
    piBashAllowlist: normalizeStringList(
      arrayOfStrings(runtimeImage.pi_bash_allowlist ?? runtimeImage.piBashAllowlist),
    ),
    gondolinProfile: validateGondolinProfile(runtimeImage.gondolin_profile ?? runtimeImage.gondolinProfile),
  };
}

function validateGondolinProfile(value: unknown): string {
  const profile = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "base";
  if (!gondolinProfilePattern.test(profile)) {
    throw new TemplateBuildValidationError("gondolin_profile contains invalid characters");
  }
  return profile;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function markFailed(database: DbLike, build: TemplateBuildRow, error: string): Promise<void> {
  await database
    .update(templateBuilds)
    .set({ status: "failed", imageRef: null, updatedAt: new Date() })
    .where(eq(templateBuilds.id, build.id));
  await database.insert(auditEvents).values({
    actorUserId: null,
    eventType: "template_build.failed",
    entityType: "template_build",
    entityId: build.id,
    payload: { error },
  });
  await publishRuntimeEvent({
    type: "template_build.updated",
    entityId: build.id,
    entityType: "template_build",
    payload: {
      status: "failed",
      template_id: build.templateId,
      template_version_id: build.templateVersionId,
      error,
    },
  });
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code === "string" && typeof (error as NodeJS.ErrnoException).errno === "number") {
        reject(error);
        return;
      }
      const maybeCode = error && typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : 0;
      resolve({
        returncode: maybeCode,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseFirstDigest(result: CommandResult): string | null {
  if (result.returncode !== 0 || !result.stdout.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.find((item): item is string => typeof item === "string" && Boolean(item)) ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function tail(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }
  return `...${value.slice(-maxLen)}`;
}

function buildImageTag(templateKey: string, buildId: string): string {
  const safeKey = templateKey.replace(tagSafePattern, "-").replace(/^-+|-+$/g, "").toLowerCase() || "template";
  const short = buildId.replaceAll("-", "").slice(0, 12);
  return `kuuna/template-${safeKey}:build-${short}`;
}

function jobToken(value: string): string {
  return value.replaceAll("-", "_").replaceAll(" ", "_");
}
