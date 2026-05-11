import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import type { Settings } from "../src/config.js";
import {
  buildRuntimeEnv,
  buildRuntimeLabels,
  dataVolumeName,
  provisionRuntimeContainer,
  RuntimeProvisioningError,
  safeContainerSuffix,
  type DockerClient,
  type DockerContainerInspect,
  type RuntimeIdentity,
} from "../src/runtime/provisioning.js";

const baseSettings: Settings = {
  APP_ENV: "test",
  HOST: "::",
  PORT: 8000,
  DATABASE_URL: "postgres://test",
  REDIS_URL: "redis://test",
  REQUIRED_ADMIN_EMAIL: "admin@kuuna.ai",
  DASHBOARD_REQUIRED_ADMIN_PASSWORD: "admin123456!",
  DASHBOARD_DEV_RESET_BOOTSTRAP_ADMIN_PASSWORD: false,
  AUTH_TOKEN_SECRET: "secret",
  AUTH_TOKEN_TTL_SECONDS: 3600,
  AUTH_LOCKOUT_THRESHOLD: 5,
  AUTH_LOCKOUT_SECONDS: 900,
  AUTH_PASSWORD_MIN_LENGTH: 12,
  AUTH_PASSWORD_MAX_CONSECUTIVE: 3,
  AUTH_RATE_LIMIT_WINDOW_SECONDS: 60,
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: 20,
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  OPENAI_TIMEOUT_SECONDS: 30,
  OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
  OPENAI_AUDIO_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
  OPENAI_VISION_MODEL: "gpt-4.1-mini",
  PI_TRANSPORT: "websocket-cached",
  PI_AUTH_CONTAINER_PATH: "/runtime-data/pi-auth.json",
  S3_BUCKET: "kuuna-dev",
  S3_REGION: "us-east-1",
  MEDIA_PROCESSING_ENABLED: true,
  MEDIA_DOWNLOAD_TIMEOUT_SECONDS: 20,
  GATEWAY_BASE_URL: "http://gateway:8090",
  OUTBOUND_DISPATCH_TIMEOUT_SECONDS: 10,
  TODO_EXPORT_ENABLED: false,
  TODO_EXPORT_TIMEOUT_SECONDS: 20,
  DOCKER_CLI_PATH: "docker",
  TEMPLATE_BUILD_CONTEXT_PATH: ".",
  TEMPLATE_BUILD_DOCKERFILE_PATH: "services/runtime-agent-ts/Dockerfile",
  RUNTIME_AGENT_TIMEOUT_SECONDS: 45,
  RUNTIME_DOCKER_SOCKET: "/var/run/docker.sock",
  RUNTIME_DOCKER_NETWORK: "kuuna-dev_default",
  RUNTIME_AGENT_IMAGE: "kuuna-runtime-agent-ts:dev",
  RUNTIME_AGENT_CONTAINER_PORT: 8100,
  RUNTIME_TOOL_BACKEND_BASE_URL: "http://backend:8000",
  RUNTIME_CONTAINER_DATA_DIR: "/runtime-data",
  RUNTIME_CONTAINER_DATA_VOLUME_PREFIX: "kuuna-runtime-data",
};

class FakeDockerClient implements DockerClient {
  container: DockerContainerInspect | null = null;
  createdPayloads: unknown[] = [];
  startedContainers: string[] = [];
  removedContainers: string[] = [];
  connectedNetworks: string[] = [];
  inspectedImages: string[] = [];
  missingImages = new Set<string>();
  nextContainerId = "container-new";

  async inspectContainer(containerNameOrId: string): Promise<DockerContainerInspect | null> {
    if (containerNameOrId === this.nextContainerId) {
      return { Id: this.nextContainerId, State: { Running: false }, Config: {}, NetworkSettings: { Networks: {} } };
    }
    return this.container;
  }

  async inspectImage(image: string): Promise<{ Id: string }> {
    this.inspectedImages.push(image);
    if (this.missingImages.has(image)) {
      throw new Error(`No such image: ${image}`);
    }
    return { Id: "sha256:runtime-dev" };
  }

  async createContainer(_containerName: string, payload: unknown): Promise<{ Id: string }> {
    this.createdPayloads.push(payload);
    this.container = { Id: this.nextContainerId, State: { Running: false }, Config: {}, NetworkSettings: { Networks: {} } };
    return { Id: this.nextContainerId };
  }

  async startContainer(containerId: string): Promise<void> {
    this.startedContainers.push(containerId);
  }

  async removeContainer(containerId: string): Promise<void> {
    this.removedContainers.push(containerId);
    this.container = null;
  }

  async connectNetwork(networkName: string, containerId: string, containerName: string): Promise<void> {
    this.connectedNetworks.push(`${networkName}:${containerId}:${containerName}`);
  }
}

function identity(providerGroupId = "group-a@g.us"): RuntimeIdentity {
  const suffix = safeContainerSuffix(providerGroupId);
  return {
    providerGroupId,
    bindingId: randomUUID(),
    agentInstanceId: randomUUID(),
    containerName: `kuuna-runtime-${suffix}`,
    secretsRef: `runtime/${suffix}`,
  };
}

function matchingContainer(runtimeIdentity: RuntimeIdentity, running: boolean): DockerContainerInspect {
  const env = buildRuntimeEnv(runtimeIdentity, baseSettings);
  const labels = buildRuntimeLabels(runtimeIdentity);
  const configHashLabels = {
    ...labels,
    "dev.kuuna.runtime-image-id": "sha256:runtime-dev",
    "dev.kuuna.runtime-config-hash": "placeholder",
  };
  const desiredHash = buildDesiredHash(runtimeIdentity);
  configHashLabels["dev.kuuna.runtime-config-hash"] = desiredHash;
  assert.ok(env.length > 0);
  return {
    Id: "container-existing",
    Image: "sha256:runtime-dev",
    State: { Running: running },
    Config: {
      Image: "kuuna-runtime-agent-ts:dev",
      Labels: configHashLabels,
    },
    NetworkSettings: { Networks: { "kuuna-dev_default": {} } },
  };
}

function buildDesiredHash(runtimeIdentity: RuntimeIdentity): string {
  const labels = buildRuntimeLabels(runtimeIdentity);
  const env = buildRuntimeEnv(runtimeIdentity, baseSettings);
  const binds = [`${dataVolumeName(runtimeIdentity.containerName, baseSettings)}:${baseSettings.RUNTIME_CONTAINER_DATA_DIR}`];
  return createHash("sha256")
    .update(JSON.stringify({
      image: "kuuna-runtime-agent-ts:dev",
      imageId: "sha256:runtime-dev",
      env: [...env].sort(),
      binds: [...binds].sort(),
      labels: Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
    }))
    .digest("hex");
}

async function withHealthyRuntime<T>(callback: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("provisionRuntimeContainer creates a lazy per-chat container and volume", async () => {
  await withHealthyRuntime(async () => {
    const runtimeIdentity = identity();
    const docker = new FakeDockerClient();

    const result = await provisionRuntimeContainer(docker, {
      identity: runtimeIdentity,
      image: "kuuna-runtime-agent-ts:dev",
      settings: baseSettings,
    });

    assert.equal(result.containerId, "container-new");
    assert.equal(result.runtimeBaseUrl, `http://${runtimeIdentity.containerName}:8100`);
    assert.equal(docker.createdPayloads.length, 1);
    assert.equal(docker.startedContainers[0], "container-new");
    const payload = docker.createdPayloads[0] as {
      Cmd?: string[];
      HostConfig: { Binds: string[]; NetworkMode: string };
      Labels: Record<string, string>;
      Env: string[];
    };
    assert.equal(payload.Cmd, undefined);
    assert.deepEqual(payload.HostConfig.Binds, [`${dataVolumeName(runtimeIdentity.containerName, baseSettings)}:/runtime-data`]);
    assert.equal(payload.HostConfig.NetworkMode, "kuuna-dev_default");
    assert.equal(payload.Labels["dev.kuuna.provider-group-id"], runtimeIdentity.providerGroupId);
    assert.ok(payload.Env.includes(`KUUNA_PROVIDER_GROUP_ID=${runtimeIdentity.providerGroupId}`));
    assert.ok(payload.Env.includes("PI_TRANSPORT=websocket-cached"));
  });
});

test("provisionRuntimeContainer mounts Pi auth file when configured", async () => {
  await withHealthyRuntime(async () => {
    const runtimeIdentity = identity();
    const docker = new FakeDockerClient();

    await provisionRuntimeContainer(docker, {
      identity: runtimeIdentity,
      image: "kuuna-runtime-agent-ts:dev",
      settings: {
        ...baseSettings,
        PI_AUTH_HOST_PATH: "/Users/flo/.pi/agent/auth.json",
        PI_AUTH_CONTAINER_PATH: "/runtime-data/pi-auth.json",
      },
    });

    const payload = docker.createdPayloads[0] as {
      HostConfig: { Binds: string[] };
      Env: string[];
    };
    assert.deepEqual(payload.HostConfig.Binds, [
      `${dataVolumeName(runtimeIdentity.containerName, baseSettings)}:/runtime-data`,
      "/Users/flo/.pi/agent/auth.json:/runtime-data/pi-auth.json:ro",
    ]);
    assert.ok(payload.Env.includes("PI_AUTH_PATH=/runtime-data/pi-auth.json"));
  });
});

test("provisionRuntimeContainer reuses a matching running container", async () => {
  await withHealthyRuntime(async () => {
    const runtimeIdentity = identity();
    const docker = new FakeDockerClient();
    docker.container = matchingContainer(runtimeIdentity, true);

    const result = await provisionRuntimeContainer(docker, {
      identity: runtimeIdentity,
      image: "kuuna-runtime-agent-ts:dev",
      settings: baseSettings,
    });

    assert.equal(result.containerId, "container-existing");
    assert.equal(docker.createdPayloads.length, 0);
    assert.deepEqual(docker.startedContainers, []);
  });
});

test("provisionRuntimeContainer starts a stopped matching container", async () => {
  await withHealthyRuntime(async () => {
    const runtimeIdentity = identity();
    const docker = new FakeDockerClient();
    docker.container = matchingContainer(runtimeIdentity, false);

    await provisionRuntimeContainer(docker, {
      identity: runtimeIdentity,
      image: "kuuna-runtime-agent-ts:dev",
      settings: baseSettings,
    });

    assert.deepEqual(docker.startedContainers, ["container-existing"]);
    assert.equal(docker.createdPayloads.length, 0);
  });
});

test("provisionRuntimeContainer refuses unmanaged same-name containers", async () => {
  await withHealthyRuntime(async () => {
    const runtimeIdentity = identity();
    const docker = new FakeDockerClient();
    docker.container = { Id: "foreign", Config: { Labels: {} }, State: { Running: true } };

    await assert.rejects(
      () => provisionRuntimeContainer(docker, { identity: runtimeIdentity, image: "kuuna-runtime-agent-ts:dev", settings: baseSettings }),
      (error: unknown) => error instanceof RuntimeProvisioningError && error.code === "runtime_container_unmanaged",
    );
  });
});

test("provisionRuntimeContainer refuses containers labeled for another chat", async () => {
  await withHealthyRuntime(async () => {
    const runtimeIdentity = identity("group-a@g.us");
    const docker = new FakeDockerClient();
    docker.container = matchingContainer({ ...runtimeIdentity, providerGroupId: "group-b@g.us" }, true);

    await assert.rejects(
      () => provisionRuntimeContainer(docker, { identity: runtimeIdentity, image: "kuuna-runtime-agent-ts:dev", settings: baseSettings }),
      (error: unknown) => error instanceof RuntimeProvisioningError && error.code === "runtime_container_identity_mismatch",
    );
  });
});

test("provisionRuntimeContainer recreates stale managed containers", async () => {
  await withHealthyRuntime(async () => {
    const runtimeIdentity = identity();
    const docker = new FakeDockerClient();
    const stale = matchingContainer(runtimeIdentity, true);
    stale.Image = "sha256:old";
    docker.container = stale;

    await provisionRuntimeContainer(docker, {
      identity: runtimeIdentity,
      image: "kuuna-runtime-agent-ts:dev",
      settings: baseSettings,
    });

    assert.deepEqual(docker.removedContainers, ["container-existing"]);
    assert.equal(docker.createdPayloads.length, 1);
    assert.deepEqual(docker.startedContainers, ["container-new"]);
  });
});

test("provisionRuntimeContainer falls back when stored template image is missing", async () => {
  await withHealthyRuntime(async () => {
    const runtimeIdentity = identity();
    const docker = new FakeDockerClient();
    docker.missingImages.add("kuuna/template-support-default@sha256:missing");

    await provisionRuntimeContainer(docker, {
      identity: runtimeIdentity,
      image: "kuuna/template-support-default@sha256:missing",
      fallbackImage: "kuuna-runtime-agent-ts:dev",
      settings: baseSettings,
    });

    assert.deepEqual(docker.inspectedImages, [
      "kuuna/template-support-default@sha256:missing",
      "kuuna-runtime-agent-ts:dev",
    ]);
    const payload = docker.createdPayloads[0] as { Image: string; Labels: Record<string, string> };
    assert.equal(payload.Image, "kuuna-runtime-agent-ts:dev");
    assert.ok(payload.Labels["dev.kuuna.runtime-config-hash"]);
  });
});

test("provisionRuntimeContainer recreates same-chat containers with stale binding identity", async () => {
  await withHealthyRuntime(async () => {
    const runtimeIdentity = identity("group-a@g.us");
    const oldIdentity: RuntimeIdentity = {
      ...runtimeIdentity,
      bindingId: randomUUID(),
      agentInstanceId: randomUUID(),
      secretsRef: "runtime/old-group-a",
    };
    const docker = new FakeDockerClient();
    docker.container = matchingContainer(oldIdentity, true);

    await provisionRuntimeContainer(docker, {
      identity: runtimeIdentity,
      image: "kuuna-runtime-agent-ts:dev",
      settings: baseSettings,
    });

    assert.deepEqual(docker.removedContainers, ["container-existing"]);
    assert.equal(docker.createdPayloads.length, 1);
  });
});

test("buildRuntimeEnv refuses extra env overrides for reserved runtime identity", () => {
  const settings: Settings = {
    ...baseSettings,
    RUNTIME_CONTAINER_EXTRA_ENV_JSON: JSON.stringify({ KUUNA_PROVIDER_GROUP_ID: "group-b@g.us" }),
  };

  assert.throws(
    () => buildRuntimeEnv(identity("group-a@g.us"), settings),
    (error: unknown) => error instanceof RuntimeProvisioningError && error.code === "runtime_extra_env_invalid",
  );
});

test("safeContainerSuffix and dataVolumeName are stable per chat", () => {
  const first = safeContainerSuffix("customer chat@g.us");
  const second = safeContainerSuffix("customer chat@g.us");
  const third = safeContainerSuffix("other chat@g.us");

  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.equal(dataVolumeName(`kuuna-runtime-${first}`, baseSettings), `kuuna-runtime-data-kuuna-runtime-${first}`);
});
