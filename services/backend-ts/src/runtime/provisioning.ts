import { createHash } from "node:crypto";
import http, { type IncomingMessage } from "node:http";

import { and, desc, eq, sql } from "drizzle-orm";

import { getSettings, type Settings } from "../config.js";
import type { Database, DbLike } from "../db/client.js";
import { agentInstances, groupBindings, templateBuilds } from "../db/schema.js";

const managedRuntimeLabel = "dev.kuuna.managed-runtime";
const providerGroupLabel = "dev.kuuna.provider-group-id";
const bindingLabel = "dev.kuuna.binding-id";
const agentInstanceLabel = "dev.kuuna.agent-instance-id";
const secretsRefLabel = "dev.kuuna.secrets-ref";
const runtimeImageIdLabel = "dev.kuuna.runtime-image-id";
const runtimeConfigHashLabel = "dev.kuuna.runtime-config-hash";
const defaultHealthcheckAttempts = 20;
const defaultHealthcheckIntervalMs = 250;
const defaultRuntimeModel = "gpt-5.5";
const defaultReasoningEffort = "medium";
const reservedRuntimeEnvKeys = new Set([
  "PORT",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_AUDIO_TRANSCRIPTION_MODEL",
  "OPENAI_TIMEOUT_SECONDS",
  "OPENAI_VISION_MODEL",
  "PI_AUTH_PATH",
  "PI_TRANSPORT",
  "RUNTIME_AGENT_DEFAULT_MODEL",
  "RUNTIME_AGENT_REASONING_EFFORT",
  "KUUNA_PROVIDER_GROUP_ID",
  "KUUNA_BINDING_ID",
  "KUUNA_AGENT_INSTANCE_ID",
  "KUUNA_SECRETS_REF",
  "KUUNA_RUNTIME_TOOL_BACKEND_BASE_URL",
  "KUUNA_RUNTIME_TOOL_TOKEN",
  "KUUNA_RUNTIME_DATA_DIR",
]);

export type RuntimeProvisioningErrorCode =
  | "runtime_binding_not_found"
  | "runtime_agent_instance_not_found"
  | "runtime_image_required"
  | "runtime_image_inspect_failed"
  | "runtime_container_unmanaged"
  | "runtime_container_identity_mismatch"
  | "runtime_container_create_failed"
  | "runtime_container_start_failed"
  | "runtime_container_remove_failed"
  | "runtime_container_network_failed"
  | "runtime_healthcheck_failed"
  | "runtime_extra_env_invalid"
  | "runtime_docker_error";

export class RuntimeProvisioningError extends Error {
  readonly code: RuntimeProvisioningErrorCode;

  constructor(code: RuntimeProvisioningErrorCode, message: string) {
    super(message);
    this.name = "RuntimeProvisioningError";
    this.code = code;
  }
}

export type RuntimeIdentity = {
  providerGroupId: string;
  bindingId: string;
  agentInstanceId: string;
  containerName: string;
  secretsRef: string;
};

export type RuntimeProvisioningResult = {
  containerId: string;
  containerName: string;
  runtimeBaseUrl: string;
  dockerNetwork: string | null;
};

export type DockerContainerInspect = {
  Id: string;
  Image?: string;
  State?: { Running?: boolean };
  Config?: {
    Image?: string;
    Labels?: Record<string, string>;
  };
  NetworkSettings?: {
    Networks?: Record<string, unknown>;
  };
};

export type DockerImageInspect = {
  Id: string;
};

type DockerCreateContainerPayload = {
  Image: string;
  Env: string[];
  Labels: Record<string, string>;
  ExposedPorts: Record<string, Record<string, never>>;
  HostConfig: {
    RestartPolicy: { Name: "unless-stopped" };
    Binds: string[];
    NetworkMode?: string;
  };
  NetworkingConfig?: {
    EndpointsConfig: Record<string, { Aliases: string[] }>;
  };
};

type DockerCreateContainerResult = {
  Id: string;
};

export interface DockerClient {
  inspectContainer(containerNameOrId: string): Promise<DockerContainerInspect | null>;
  inspectImage(image: string): Promise<DockerImageInspect>;
  createContainer(containerName: string, payload: DockerCreateContainerPayload): Promise<DockerCreateContainerResult>;
  startContainer(containerId: string): Promise<void>;
  removeContainer(containerId: string): Promise<void>;
  connectNetwork(networkName: string, containerId: string, containerName: string): Promise<void>;
}

export type EnsureRuntimeForChatInput = {
  providerGroupId: string;
  messageId: string;
  traceId: string | null;
};

export type RuntimeProvisioner = (
  database: DbLike,
  input: EnsureRuntimeForChatInput,
) => Promise<RuntimeProvisioningResult>;

export async function ensureRuntimeForChat(
  database: DbLike,
  input: EnsureRuntimeForChatInput,
  options: { dockerClient?: DockerClient; settings?: Settings } = {},
): Promise<RuntimeProvisioningResult> {
  const settings = options.settings ?? getSettings();
  const run = async (tx: DbLike): Promise<RuntimeProvisioningResult> => {
    await acquireChatProvisioningLock(tx, input.providerGroupId);
    const target = await resolveProvisioningTarget(tx, input.providerGroupId);
    const image = target.imageRef || settings.RUNTIME_AGENT_IMAGE.trim();
    if (!image) {
      throw new RuntimeProvisioningError("runtime_image_required", "runtime image is required");
    }

    const identity: RuntimeIdentity = {
      providerGroupId: input.providerGroupId,
      bindingId: target.bindingId,
      agentInstanceId: target.agentInstanceId,
      containerName: target.containerName,
      secretsRef: target.secretsRef,
    };
    const dockerClient = options.dockerClient ?? new DockerSocketClient(settings.RUNTIME_DOCKER_SOCKET);
    const result = await provisionRuntimeContainer(dockerClient, {
      identity,
      image,
      settings,
    });

    await tx
      .update(agentInstances)
      .set({
        status: "healthy",
        runtimeBaseUrl: result.runtimeBaseUrl,
        runtimeContainerName: result.containerName,
        secretsRef: identity.secretsRef,
        updatedAt: new Date(),
      })
      .where(eq(agentInstances.id, identity.agentInstanceId));

    return result;
  };

  try {
    if (hasTransaction(database)) {
      return await database.transaction(run);
    }
    return await run(database);
  } catch (error) {
    await markRuntimeDegraded(database, input.providerGroupId);
    throw error;
  }
}

export async function provisionRuntimeContainer(
  dockerClient: DockerClient,
  input: {
    identity: RuntimeIdentity;
    image: string;
    settings: Settings;
  },
): Promise<RuntimeProvisioningResult> {
  const port = input.settings.RUNTIME_AGENT_CONTAINER_PORT;
  const dockerNetwork = normalizeOptional(input.settings.RUNTIME_DOCKER_NETWORK);
  const imageInspect = await dockerClient.inspectImage(input.image).catch((error: unknown) => {
    throw new RuntimeProvisioningError(
      "runtime_image_inspect_failed",
      `failed to inspect runtime image ${input.image}: ${errorMessage(error)}`,
    );
  });
  const baseLabels = buildRuntimeLabels(input.identity);
  const env = buildRuntimeEnv(input.identity, input.settings);
  const binds = buildRuntimeBinds(input.identity.containerName, input.settings);
  const labels = withRuntimeConfigLabels(baseLabels, {
    image: input.image,
    imageId: imageInspect.Id,
    env,
    binds,
  });

  const existing = await dockerClient.inspectContainer(input.identity.containerName);
  let containerId: string;
  if (!existing) {
    containerId = (await dockerClient.createContainer(
      input.identity.containerName,
      buildCreateContainerPayload({
        image: input.image,
        port,
        env,
        labels,
        containerName: input.identity.containerName,
        binds,
        dockerNetwork,
      }),
    )).Id;
  } else {
    assertManagedContainerIdentity(existing, input.identity);
    if (!containerMatchesRuntimeConfig(existing, input.image, imageInspect.Id, labels)) {
      await dockerClient.removeContainer(existing.Id).catch((error: unknown) => {
        throw new RuntimeProvisioningError(
          "runtime_container_remove_failed",
          `failed to remove stale runtime container ${input.identity.containerName}: ${errorMessage(error)}`,
        );
      });
      containerId = (await dockerClient.createContainer(
        input.identity.containerName,
        buildCreateContainerPayload({
          image: input.image,
          port,
          env,
          labels,
          containerName: input.identity.containerName,
          binds,
          dockerNetwork,
        }),
      )).Id;
    } else {
      containerId = existing.Id;
      if (dockerNetwork && !containerNetworkNames(existing).has(dockerNetwork)) {
        await dockerClient.connectNetwork(dockerNetwork, containerId, input.identity.containerName).catch((error: unknown) => {
          throw new RuntimeProvisioningError(
            "runtime_container_network_failed",
            `failed to connect runtime container ${input.identity.containerName} to ${dockerNetwork}: ${errorMessage(error)}`,
          );
        });
      }
    }
  }

  const current = await dockerClient.inspectContainer(containerId);
  if (!current?.State?.Running) {
    await dockerClient.startContainer(containerId).catch((error: unknown) => {
      throw new RuntimeProvisioningError(
        "runtime_container_start_failed",
        `failed to start runtime container ${input.identity.containerName}: ${errorMessage(error)}`,
      );
    });
  }

  const runtimeBaseUrl = `http://${input.identity.containerName}:${port}`;
  await waitForRuntimeHealth(runtimeBaseUrl);
  return {
    containerId,
    containerName: input.identity.containerName,
    runtimeBaseUrl,
    dockerNetwork,
  };
}

export function safeContainerSuffix(providerGroupId: string): string {
  const normalized = providerGroupId
    .toLowerCase()
    .replaceAll("@", "-at-")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  const digest = createHash("sha256").update(providerGroupId).digest("hex").slice(0, 12);
  const maxPrefixLength = 80 - digest.length - 1;
  const prefix = (normalized || "group").slice(0, maxPrefixLength).replace(/^[.-]+|[.-]+$/g, "") || "group";
  return `${prefix}-${digest}`;
}

export function dataVolumeName(containerName: string, settings: Settings): string {
  const prefix = settings.RUNTIME_CONTAINER_DATA_VOLUME_PREFIX.trim() || "kuuna-runtime-data";
  return `${prefix}-${containerName}`.slice(0, 255);
}

export function buildRuntimeLabels(identity: RuntimeIdentity): Record<string, string> {
  return {
    [managedRuntimeLabel]: "true",
    [providerGroupLabel]: identity.providerGroupId,
    [bindingLabel]: identity.bindingId,
    [agentInstanceLabel]: identity.agentInstanceId,
    [secretsRefLabel]: identity.secretsRef,
  };
}

export function buildRuntimeEnv(identity: RuntimeIdentity, settings: Settings): string[] {
  const env: Record<string, string> = {
    PORT: String(settings.RUNTIME_AGENT_CONTAINER_PORT),
    OPENAI_BASE_URL: settings.OPENAI_BASE_URL,
    OPENAI_AUDIO_TRANSCRIPTION_MODEL: settings.OPENAI_AUDIO_TRANSCRIPTION_MODEL,
    OPENAI_TIMEOUT_SECONDS: String(settings.OPENAI_TIMEOUT_SECONDS),
    OPENAI_VISION_MODEL: settings.OPENAI_VISION_MODEL,
    PI_TRANSPORT: settings.PI_TRANSPORT,
    RUNTIME_AGENT_DEFAULT_MODEL: defaultRuntimeModel,
    RUNTIME_AGENT_REASONING_EFFORT: defaultReasoningEffort,
    KUUNA_PROVIDER_GROUP_ID: identity.providerGroupId,
    KUUNA_BINDING_ID: identity.bindingId,
    KUUNA_AGENT_INSTANCE_ID: identity.agentInstanceId,
    KUUNA_SECRETS_REF: identity.secretsRef,
    KUUNA_RUNTIME_TOOL_BACKEND_BASE_URL: settings.RUNTIME_TOOL_BACKEND_BASE_URL,
    KUUNA_RUNTIME_DATA_DIR: settings.RUNTIME_CONTAINER_DATA_DIR,
  };
  const runtimeToolToken = settings.RUNTIME_TOOL_TOKEN?.trim() || settings.INTERNAL_OPS_TOKEN?.trim();
  if (runtimeToolToken) {
    env.KUUNA_RUNTIME_TOOL_TOKEN = runtimeToolToken;
  }
  if (settings.OPENAI_API_KEY?.trim()) {
    env.OPENAI_API_KEY = settings.OPENAI_API_KEY;
  }
  if (settings.PI_AUTH_HOST_PATH?.trim()) {
    env.PI_AUTH_PATH = settings.PI_AUTH_CONTAINER_PATH;
  }
  Object.assign(env, parseExtraEnv(settings.RUNTIME_CONTAINER_EXTRA_ENV_JSON));
  return Object.entries(env).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`);
}

export function parseExtraEnv(rawValue: string | undefined): Record<string, string> {
  const normalized = normalizeOptional(rawValue);
  if (!normalized) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(normalized);
  } catch (error) {
    throw new RuntimeProvisioningError(
      "runtime_extra_env_invalid",
      `RUNTIME_CONTAINER_EXTRA_ENV_JSON must be valid JSON: ${errorMessage(error)}`,
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new RuntimeProvisioningError("runtime_extra_env_invalid", "RUNTIME_CONTAINER_EXTRA_ENV_JSON must be an object");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(decoded)) {
    if (!key || key.includes("=")) {
      throw new RuntimeProvisioningError("runtime_extra_env_invalid", "RUNTIME_CONTAINER_EXTRA_ENV_JSON contains an invalid key");
    }
    if (reservedRuntimeEnvKeys.has(key) || key.startsWith("KUUNA_")) {
      throw new RuntimeProvisioningError("runtime_extra_env_invalid", `RUNTIME_CONTAINER_EXTRA_ENV_JSON cannot override reserved key ${key}`);
    }
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      env[key] = String(value);
      continue;
    }
    throw new RuntimeProvisioningError("runtime_extra_env_invalid", "RUNTIME_CONTAINER_EXTRA_ENV_JSON values must be scalar");
  }
  return env;
}

export function withRuntimeConfigLabels(
  labels: Record<string, string>,
  input: { image: string; imageId: string; env: string[]; binds: string[] },
): Record<string, string> {
  const next: Record<string, string> = { ...labels, [runtimeImageIdLabel]: input.imageId };
  next[runtimeConfigHashLabel] = runtimeConfigHash({
    image: input.image,
    imageId: input.imageId,
    env: input.env,
    binds: input.binds,
    labels,
  });
  return next;
}

function runtimeConfigHash(input: {
  image: string;
  imageId: string;
  env: string[];
  binds: string[];
  labels: Record<string, string>;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      image: input.image,
      imageId: input.imageId,
      env: [...input.env].sort(),
      binds: [...input.binds].sort(),
      labels: Object.entries(input.labels).sort(([left], [right]) => left.localeCompare(right)),
    }))
    .digest("hex");
}

function buildRuntimeBinds(containerName: string, settings: Settings): string[] {
  const binds = [`${dataVolumeName(containerName, settings)}:${settings.RUNTIME_CONTAINER_DATA_DIR}`];
  const piAuthHostPath = normalizeOptional(settings.PI_AUTH_HOST_PATH);
  if (piAuthHostPath) {
    binds.push(`${piAuthHostPath}:${settings.PI_AUTH_CONTAINER_PATH}:ro`);
  }
  return binds;
}

function buildCreateContainerPayload(input: {
  image: string;
  port: number;
  env: string[];
  labels: Record<string, string>;
  containerName: string;
  binds: string[];
  dockerNetwork: string | null;
}): DockerCreateContainerPayload {
  const exposedPort = `${input.port}/tcp`;
  const payload: DockerCreateContainerPayload = {
    Image: input.image,
    Env: input.env,
    Labels: input.labels,
    ExposedPorts: { [exposedPort]: {} },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      Binds: input.binds,
    },
  };
  if (input.dockerNetwork) {
    payload.HostConfig.NetworkMode = input.dockerNetwork;
    payload.NetworkingConfig = {
      EndpointsConfig: {
        [input.dockerNetwork]: { Aliases: [input.containerName] },
      },
    };
  }
  return payload;
}

function assertManagedContainerIdentity(container: DockerContainerInspect, identity: RuntimeIdentity): void {
  const labels = container.Config?.Labels ?? {};
  if (labels[managedRuntimeLabel] !== "true") {
    throw new RuntimeProvisioningError(
      "runtime_container_unmanaged",
      `container ${identity.containerName} exists but is not Kuuna-managed`,
    );
  }
  if (
    labels[providerGroupLabel] !== identity.providerGroupId
  ) {
    throw new RuntimeProvisioningError(
      "runtime_container_identity_mismatch",
      `container ${identity.containerName} is managed by another runtime identity`,
    );
  }
}

function containerMatchesRuntimeConfig(
  container: DockerContainerInspect,
  image: string,
  imageId: string,
  labels: Record<string, string>,
): boolean {
  if (container.Config?.Image !== image) return false;
  if (container.Image !== imageId) return false;
  const existingLabels = container.Config?.Labels ?? {};
  return Object.entries(labels).every(([key, value]) => existingLabels[key] === value);
}

function containerNetworkNames(container: DockerContainerInspect): Set<string> {
  return new Set(Object.keys(container.NetworkSettings?.Networks ?? {}));
}

async function resolveProvisioningTarget(database: DbLike, providerGroupId: string): Promise<RuntimeIdentity & { imageRef: string | null }> {
  const rows = await database
    .select({
      bindingId: groupBindings.id,
      templateVersionId: groupBindings.templateVersionId,
      agentInstanceId: agentInstances.id,
      containerName: agentInstances.runtimeContainerName,
      secretsRef: agentInstances.secretsRef,
    })
    .from(groupBindings)
    .leftJoin(agentInstances, eq(agentInstances.groupBindingId, groupBindings.id))
    .where(and(eq(groupBindings.providerGroupId, providerGroupId), eq(groupBindings.status, "active")))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new RuntimeProvisioningError("runtime_binding_not_found", `active binding not found for ${providerGroupId}`);
  }
  if (!row.agentInstanceId) {
    throw new RuntimeProvisioningError("runtime_agent_instance_not_found", `agent instance not found for ${providerGroupId}`);
  }
  const containerName = row.containerName?.trim() || `kuuna-runtime-${safeContainerSuffix(providerGroupId)}`;
  const secretsRef = row.secretsRef?.trim() || `runtime/${safeContainerSuffix(providerGroupId)}`;
  const [build] = await database
    .select({ imageRef: templateBuilds.imageRef })
    .from(templateBuilds)
    .where(and(eq(templateBuilds.templateVersionId, row.templateVersionId), eq(templateBuilds.status, "succeeded")))
    .orderBy(desc(templateBuilds.createdAt), desc(templateBuilds.id))
    .limit(1);
  const imageRef = build?.imageRef?.trim() || null;
  return {
    providerGroupId,
    bindingId: row.bindingId,
    agentInstanceId: row.agentInstanceId,
    containerName,
    secretsRef,
    imageRef,
  };
}

async function acquireChatProvisioningLock(database: DbLike, providerGroupId: string): Promise<void> {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`runtime:${providerGroupId}`}))`);
}

async function markRuntimeDegraded(database: DbLike, providerGroupId: string): Promise<void> {
  const rows = await database
    .select({ id: agentInstances.id })
    .from(groupBindings)
    .innerJoin(agentInstances, eq(agentInstances.groupBindingId, groupBindings.id))
    .where(and(eq(groupBindings.providerGroupId, providerGroupId), eq(groupBindings.status, "active")))
    .limit(1);
  const row = rows[0];
  if (!row) return;
  await database
    .update(agentInstances)
    .set({ status: "degraded", updatedAt: new Date() })
    .where(eq(agentInstances.id, row.id));
}

function hasTransaction(database: DbLike): database is Database {
  return "transaction" in database && typeof database.transaction === "function";
}

async function waitForRuntimeHealth(runtimeBaseUrl: string): Promise<void> {
  const healthUrl = `${runtimeBaseUrl.replace(/\/$/, "")}/healthz`;
  let lastError = "no response";
  for (let attempt = 0; attempt < defaultHealthcheckAttempts; attempt += 1) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    if (attempt < defaultHealthcheckAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, defaultHealthcheckIntervalMs));
    }
  }
  throw new RuntimeProvisioningError(
    "runtime_healthcheck_failed",
    `runtime container did not become healthy at ${healthUrl}: ${lastError}`,
  );
}

class DockerSocketClient implements DockerClient {
  readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async inspectContainer(containerNameOrId: string): Promise<DockerContainerInspect | null> {
    const response = await this.request("GET", `/containers/${encodeURIComponent(containerNameOrId)}/json`);
    if (response.statusCode === 404) return null;
    if (response.statusCode >= 400) throw dockerError("runtime_docker_error", response, `inspect container ${containerNameOrId}`);
    return parseDockerObject(response.body, isDockerContainerInspect, `invalid container inspect payload for ${containerNameOrId}`);
  }

  async inspectImage(image: string): Promise<DockerImageInspect> {
    const response = await this.request("GET", `/images/${encodeURIComponent(image)}/json`);
    if (response.statusCode >= 400) throw dockerError("runtime_image_inspect_failed", response, `inspect image ${image}`);
    return parseDockerObject(response.body, isDockerImageInspect, `invalid image inspect payload for ${image}`);
  }

  async createContainer(containerName: string, payload: DockerCreateContainerPayload): Promise<DockerCreateContainerResult> {
    const response = await this.request("POST", `/containers/create?name=${encodeURIComponent(containerName)}`, payload);
    if (response.statusCode !== 201) throw dockerError("runtime_container_create_failed", response, `create container ${containerName}`);
    return parseDockerObject(response.body, isDockerCreateResult, `invalid create container payload for ${containerName}`);
  }

  async startContainer(containerId: string): Promise<void> {
    const response = await this.request("POST", `/containers/${encodeURIComponent(containerId)}/start`);
    if (response.statusCode !== 204 && response.statusCode !== 304) {
      throw dockerError("runtime_container_start_failed", response, `start container ${containerId}`);
    }
  }

  async removeContainer(containerId: string): Promise<void> {
    const response = await this.request("DELETE", `/containers/${encodeURIComponent(containerId)}?force=true&v=false`);
    if (response.statusCode !== 204 && response.statusCode !== 404) {
      throw dockerError("runtime_container_remove_failed", response, `remove container ${containerId}`);
    }
  }

  async connectNetwork(networkName: string, containerId: string, containerName: string): Promise<void> {
    const response = await this.request("POST", `/networks/${encodeURIComponent(networkName)}/connect`, {
      Container: containerId,
      EndpointConfig: { Aliases: [containerName] },
    });
    if (![200, 201, 204].includes(response.statusCode)) {
      throw dockerError("runtime_container_network_failed", response, `connect container ${containerName} to ${networkName}`);
    }
  }

  private request(method: string, path: string, payload?: unknown): Promise<{ statusCode: number; body: string }> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : undefined,
        },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            resolve({ statusCode: response.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") });
          });
        },
      );
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }
}

function dockerError(
  code: RuntimeProvisioningErrorCode,
  response: { statusCode: number; body: string },
  action: string,
): RuntimeProvisioningError {
  return new RuntimeProvisioningError(code, `Docker ${action} failed with HTTP ${response.statusCode}: ${response.body}`);
}

function parseDockerObject<T>(body: string, guard: (value: unknown) => value is T, error: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new RuntimeProvisioningError("runtime_docker_error", error);
  }
  if (!guard(decoded)) {
    throw new RuntimeProvisioningError("runtime_docker_error", error);
  }
  return decoded;
}

function isDockerContainerInspect(value: unknown): value is DockerContainerInspect {
  return Boolean(value && typeof value === "object" && typeof (value as { Id?: unknown }).Id === "string");
}

function isDockerImageInspect(value: unknown): value is DockerImageInspect {
  return Boolean(value && typeof value === "object" && typeof (value as { Id?: unknown }).Id === "string");
}

function isDockerCreateResult(value: unknown): value is DockerCreateContainerResult {
  return Boolean(value && typeof value === "object" && typeof (value as { Id?: unknown }).Id === "string");
}

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
