import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { eq } from "drizzle-orm";

import { resetSettingsForTests } from "../src/config.js";
import { auditEvents, groupTemplates, templateBuilds, templateVersions } from "../src/db/schema.js";
import { processTemplateBuildJob } from "../src/jobs/template-build.js";
import { contractDatabaseUrl, createContractHarness } from "./contract-harness.js";

const skipReason = contractDatabaseUrl
  ? false
  : "set BACKEND_TS_CONTRACT_DATABASE_URL to run backend-ts contract tests";

test("contract: template build tRPC queues published version", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const actor = await harness.seedUser({ email: "builder@example.com", password: "LongPassword123!", role: "admin" });
  const caller = await harness.callerForUser(actor.id);
  const seeded = await seedTemplate(harness, { status: "published" });

  const body = await caller.templates.queueBuild({
    templateId: seeded.templateId,
    versionId: seeded.versionId,
    actorUserId: actor.id,
    baseImage: "ghcr.io/kuuna/runtime-base:1",
    allowedTools: [" Search ", "TODO_CREATE"],
    dockerfileSnippet: "RUN apt-get update",
    piBashEnabled: true,
    piBashAllowlist: [" jq ", "PYTHON"],
  });

  assert.equal(body.template_id, seeded.templateId);
  assert.equal(body.template_version_id, seeded.versionId);
  assert.equal(body.status, "queued");
  assert.equal((body.build_inputs as Record<string, unknown>).base_image, "ghcr.io/kuuna/runtime-base:1");
  assert.deepEqual((body.build_inputs as Record<string, unknown>).allowed_tools, ["search", "todo_create"]);
  assert.equal((body.build_inputs as Record<string, unknown>).dockerfile_snippet, "RUN apt-get update");
  assert.equal((body.build_inputs as Record<string, unknown>).pi_bash_enabled, true);
  assert.deepEqual((body.build_inputs as Record<string, unknown>).pi_bash_allowlist, ["jq", "python"]);

  assert.equal(harness.jobs.length, 1);
  assert.equal(harness.jobs[0]?.name, "template_build");
  assert.deepEqual(harness.jobs[0]?.data, { build_id: body.id });
  assert.equal(harness.jobs[0]?.jobId, `template_build_${String(body.id).replaceAll("-", "_")}`);

  const [event] = await harness.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.eventType, "template_build.queued"))
    .limit(1);
  assert.ok(event);
  assert.equal(event.actorUserId, actor.id);
  assert.equal(event.entityId, body.id);
});

test("contract: template build tRPC uses runtime image settings from template version", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const actor = await harness.seedUser({ email: "builder-runtime@example.com", password: "LongPassword123!", role: "admin" });
  const caller = await harness.callerForUser(actor.id);
  const seeded = await seedTemplate(harness, {
    status: "published",
    toolsConfig: {
      allowed_tools: ["message_history"],
      runtime_image: {
        dockerfile_snippet: "RUN apt-get update",
        pi_bash_enabled: true,
        pi_bash_allowlist: [" jq ", "PYTHON"],
      },
    },
  });

  const body = await caller.templates.queueBuild({
    templateId: seeded.templateId,
    versionId: seeded.versionId,
    actorUserId: actor.id,
    baseImage: "node:22-bookworm",
  });

  assert.equal((body.build_inputs as Record<string, unknown>).dockerfile_snippet, "RUN apt-get update");
  assert.equal((body.build_inputs as Record<string, unknown>).pi_bash_enabled, true);
  assert.deepEqual((body.build_inputs as Record<string, unknown>).pi_bash_allowlist, ["jq", "python"]);
});

test("contract: template build tRPC rejects unpublished or missing versions", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const actor = await harness.seedUser({ email: "builder2@example.com", password: "LongPassword123!", role: "admin" });
  const caller = await harness.callerForUser(actor.id);
  const seeded = await seedTemplate(harness, { status: "draft" });

  await assert.rejects(
    async () => caller.templates.queueBuild({
      templateId: seeded.templateId,
      versionId: seeded.versionId,
      actorUserId: actor.id,
      baseImage: "node:22-alpine",
    }),
    /only published template versions can be built/,
  );

  await assert.rejects(
    async () => caller.templates.queueBuild({
      templateId: seeded.templateId,
      versionId: randomUUID(),
      actorUserId: actor.id,
      baseImage: "node:22-alpine",
    }),
    /template version not found/,
  );
});

test("contract: template build tRPC rejects bash without allowlist and blocked Dockerfile instructions", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const actor = await harness.seedUser({ email: "builder4@example.com", password: "LongPassword123!", role: "admin" });
  const caller = await harness.callerForUser(actor.id);
  const seeded = await seedTemplate(harness, { status: "published" });

  await assert.rejects(
    async () => caller.templates.queueBuild({
      templateId: seeded.templateId,
      versionId: seeded.versionId,
      actorUserId: actor.id,
      baseImage: "node:22-alpine",
      piBashEnabled: true,
      piBashAllowlist: [],
    }),
    /pi_bash_allowlist is required/,
  );

  await assert.rejects(
    async () => caller.templates.queueBuild({
      templateId: seeded.templateId,
      versionId: seeded.versionId,
      actorUserId: actor.id,
      baseImage: "node:22-alpine",
      dockerfileSnippet: "ENTRYPOINT [\"bad\"]",
    }),
    /dockerfile_snippet cannot contain ENTRYPOINT/,
  );
});

test("contract: template build tRPC list mirrors response shape", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const actor = await harness.seedUser({ email: "builder3@example.com", password: "LongPassword123!", role: "admin" });
  const caller = await harness.callerForUser(actor.id);

  const seeded = await seedTemplate(harness, { status: "published" });
  const [build] = await harness.db
    .insert(templateBuilds)
    .values({
      templateId: seeded.templateId,
      templateVersionId: seeded.versionId,
      status: "succeeded",
      imageRef: "kuuna/template-support@sha256:abc",
      imageTag: "kuuna/template-support:build-abc",
      buildInputs: { base_image: "node:22-alpine" },
      logsRef: "{\"returncode\":0}",
    })
    .returning();
  assert.ok(build);

  const list = await caller.templates.builds({ templateId: seeded.templateId, versionId: seeded.versionId });
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, build.id);
  assert.equal(list[0]?.image_ref, "kuuna/template-support@sha256:abc");
  assert.equal(typeof list[0]?.created_at, "string");
});

test("contract: template build job invalid or unknown id mutates nothing", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  assert.deepEqual(await processTemplateBuildJob(harness.db, { buildId: "not-a-uuid" }), {
    processed: false,
    status: "invalid",
  });
  assert.deepEqual(await processTemplateBuildJob(harness.db, { buildId: randomUUID() }), {
    processed: false,
    status: "not_found",
  });
  assert.equal((await harness.db.select().from(templateBuilds)).length, 0);
});

test("contract: template build job fails when base image is missing", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const seeded = await seedTemplate(harness, { status: "published" });
  const [build] = await harness.db
    .insert(templateBuilds)
    .values({
      templateId: seeded.templateId,
      templateVersionId: seeded.versionId,
      status: "queued",
      buildInputs: {},
    })
    .returning();
  assert.ok(build);

  const result = await processTemplateBuildJob(harness.db, { buildId: build.id });
  assert.deepEqual(result, { processed: true, status: "failed" });

  const stored = await findBuild(harness, build.id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.imageRef, null);
  const event = await findAuditEvent(harness, "template_build.failed");
  assert.deepEqual(event.payload, { error: "missing base_image in build_inputs" });
});

test("contract: template build job records docker failure logs", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const seeded = await seedTemplate(harness, { status: "published" });
  const [build] = await harness.db
    .insert(templateBuilds)
    .values({
      templateId: seeded.templateId,
      templateVersionId: seeded.versionId,
      status: "queued",
      buildInputs: { base_image: "node:22-alpine" },
    })
    .returning();
  assert.ok(build);

  const result = await processTemplateBuildJob(
    harness.db,
    { buildId: build.id },
    { commandRunner: async () => ({ returncode: 17, stdout: "out", stderr: "bad docker" }) },
  );
  assert.deepEqual(result, { processed: true, status: "failed" });

  const stored = await findBuild(harness, build.id);
  assert.equal(stored.status, "failed");
  const logs = JSON.parse(stored.logsRef ?? "{}") as Record<string, unknown>;
  assert.equal(logs.returncode, 17);
  assert.equal(logs.stderr_tail, "bad docker");
  const event = await findAuditEvent(harness, "template_build.failed");
  assert.deepEqual(event.payload, { error: "docker build failed (exit 17)" });
});

test("contract: template build job marks failed when docker runner throws", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const seeded = await seedTemplate(harness, { status: "published" });
  const [build] = await harness.db
    .insert(templateBuilds)
    .values({
      templateId: seeded.templateId,
      templateVersionId: seeded.versionId,
      status: "queued",
      buildInputs: { base_image: "node:22-alpine" },
    })
    .returning();
  assert.ok(build);

  const result = await processTemplateBuildJob(
    harness.db,
    { buildId: build.id },
    { commandRunner: async () => { throw new Error("spawn docker ENOENT"); } },
  );
  assert.deepEqual(result, { processed: true, status: "failed" });

  const stored = await findBuild(harness, build.id);
  assert.equal(stored.status, "failed");
  const logs = JSON.parse(stored.logsRef ?? "{}") as Record<string, unknown>;
  assert.equal(logs.returncode, null);
  assert.equal(logs.stderr_tail, "spawn docker ENOENT");
  const event = await findAuditEvent(harness, "template_build.failed");
  assert.deepEqual(event.payload, { error: "docker build failed: spawn docker ENOENT" });
});

test("contract: template build job succeeds and uses digest fallback", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  process.env.DOCKER_CLI_PATH = "docker-test";
  process.env.TEMPLATE_BUILD_CONTEXT_PATH = "/repo";
  process.env.TEMPLATE_BUILD_DOCKERFILE_PATH = "/repo/Dockerfile";
  resetSettingsForTests();
  t.after(() => {
    delete process.env.DOCKER_CLI_PATH;
    delete process.env.TEMPLATE_BUILD_CONTEXT_PATH;
    delete process.env.TEMPLATE_BUILD_DOCKERFILE_PATH;
    resetSettingsForTests();
  });

  const seeded = await seedTemplate(harness, { status: "published", key: "Support Bot!" });
  const [build] = await harness.db
    .insert(templateBuilds)
    .values({
      templateId: seeded.templateId,
      templateVersionId: seeded.versionId,
      status: "queued",
      buildInputs: { base_image: "node:22-alpine" },
    })
    .returning();
  assert.ok(build);

  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await processTemplateBuildJob(
    harness.db,
    { buildId: build.id },
    {
      commandRunner: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "image") {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        return { returncode: 0, stdout: "built", stderr: "" };
      },
    },
  );

  assert.deepEqual(result, { processed: true, status: "succeeded" });
  assert.equal(calls[0]?.command, "docker-test");
  assert.deepEqual(calls[0]?.args.slice(0, 3), ["build", "-f", "/repo/Dockerfile"]);
  assert.ok(calls[0]?.args.includes("BASE_IMAGE=node:22-alpine"));
  assert.equal(calls[0]?.args.at(-1), "/repo");

  const stored = await findBuild(harness, build.id);
  assert.equal(stored.status, "succeeded");
  assert.equal(stored.imageTag, `kuuna/template-support-bot:build-${build.id.replaceAll("-", "").slice(0, 12)}`);
  assert.equal(stored.imageRef, stored.imageTag);
  const event = await findAuditEvent(harness, "template_build.succeeded");
  assert.equal((event.payload as Record<string, unknown>).image_ref, stored.imageTag);
});

async function seedTemplate(
  harness: Awaited<ReturnType<typeof createContractHarness>>,
  input: {
    status: "draft" | "ready" | "published" | "archived";
    key?: string;
    toolsConfig?: Record<string, unknown>;
  },
) {
  const [template] = await harness.db
    .insert(groupTemplates)
    .values({ key: input.key ?? `template-${randomUUID()}`, displayName: "Support Template" })
    .returning();
  assert.ok(template);

  const [version] = await harness.db
    .insert(templateVersions)
    .values({
      templateId: template.id,
      versionNo: 1,
      status: input.status,
      modelConfig: { model: "gpt-5-mini" },
      toolsConfig: input.toolsConfig ?? { tools: [{ name: "search" }, { name: "disabled", enabled: false }] },
      egressPolicy: { allow: ["https://example.com"] },
    })
    .returning();
  assert.ok(version);
  return { templateId: template.id, versionId: version.id };
}

async function findBuild(harness: Awaited<ReturnType<typeof createContractHarness>>, buildId: string) {
  const [build] = await harness.db.select().from(templateBuilds).where(eq(templateBuilds.id, buildId)).limit(1);
  assert.ok(build);
  return build;
}

async function findAuditEvent(
  harness: Awaited<ReturnType<typeof createContractHarness>>,
  eventType: string,
) {
  const [event] = await harness.db.select().from(auditEvents).where(eq(auditEvents.eventType, eventType)).limit(1);
  assert.ok(event);
  return event;
}
