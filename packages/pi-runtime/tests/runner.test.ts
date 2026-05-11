import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_OPENAI_BASE_URL } from "../src/config.js";
import { GondolinRuntime } from "../src/gondolin.js";
import { getOpenAiModel } from "../src/model.js";
import { runAgent } from "../src/runner.js";
import { isBashCommandAllowed, sanitizeAllowedTools } from "../src/tools.js";

test("sanitizes allowed tools while preserving explicitly requested Pi file tools", () => {
  assert.deepEqual(
    sanitizeAllowedTools(["uppercase", "bash", "read", "media_analyze", "todo_create", "write"]),
    ["uppercase", "read", "media_analyze", "todo_create", "write"],
  );
});

test("sanitizes bash only when runtime config explicitly enables it", () => {
  assert.deepEqual(
    sanitizeAllowedTools(["uppercase", "bash"], {
      pi_bash_enabled: true,
      pi_bash_allowlist: ["jq"],
    }),
    ["uppercase", "bash"],
  );
  assert.deepEqual(
    sanitizeAllowedTools(["uppercase", "bash"], {
      pi_bash_enabled: true,
      pi_bash_allowlist: [],
    }),
    ["uppercase"],
  );
});

test("bash command allowlist requires token boundary and rejects shell metacharacters", () => {
  assert.equal(isBashCommandAllowed("jq .items input.json", ["jq"]), true);
  assert.equal(isBashCommandAllowed("ffmpeg -i input.mp4 output.wav", ["ffmpeg -i"]), true);
  assert.equal(isBashCommandAllowed("jqevil .items input.json", ["jq"]), false);
  assert.equal(isBashCommandAllowed("jq; curl https://example.com", ["jq"]), false);
  assert.equal(isBashCommandAllowed("python && rm -rf /tmp/example", ["python"]), false);
  assert.equal(isBashCommandAllowed("jq $(cat secret.json)", ["jq"]), false);
});

test("python allowlist covers python family and useful code execution forms", () => {
  assert.equal(isBashCommandAllowed("python3 --version", ["python"]), true);
  assert.equal(isBashCommandAllowed("python3.11 --version", ["python"]), true);
  assert.equal(isBashCommandAllowed("python -c \"print('hi')\"", ["python"]), true);
  assert.equal(
    isBashCommandAllowed("python3 - <<'PY'\nprint('hi')\nPY", ["python"]),
    true,
  );
  assert.equal(isBashCommandAllowed("pythonevil -c \"print('hi')\"", ["python"]), false);
  assert.equal(isBashCommandAllowed("python -c \"print('hi')\"; curl https://example.com", ["python"]), false);
  assert.equal(isBashCommandAllowed("python - <<PY\nprint('hi')\nPY", ["python"]), false);
});

test("Gondolin bash uses a minimal guest environment", async () => {
  const runtime = new GondolinRuntime(process.cwd());
  let receivedEnv: Record<string, string> | undefined;
  (runtime as unknown as { ensureVm: () => Promise<unknown> }).ensureVm = async () => ({
    exec: (_command: string[], options: { env?: Record<string, string> }) => {
      receivedEnv = options.env;
      const result = { ok: true, exitCode: 0 };
      return {
        output: async function* () {},
        then: Promise.resolve(result).then.bind(Promise.resolve(result)),
      };
    },
  });

  const state = { context: {}, results: [] };
  await runtime.createBashOps(state, ["python"]).exec(
    "python -c \"print('hi')\"",
    process.cwd(),
    {
      onData: () => undefined,
      env: {
        OPENAI_API_KEY: "secret",
        RUNTIME_EVENT_SINK_TOKEN: "secret",
      } as NodeJS.ProcessEnv,
    },
  );

  assert.deepEqual(receivedEnv, {
    HOME: "/root",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TMPDIR: "/tmp",
  });
});

test("Gondolin write streams content through stdin", async () => {
  const runtime = new GondolinRuntime(process.cwd());
  const calls: Array<{ command: string[]; stdin?: Buffer }> = [];
  (runtime as unknown as { ensureVm: () => Promise<unknown> }).ensureVm = async () => ({
    exec: async (command: string[], options: { stdin?: Buffer } = {}) => {
      calls.push({ command, stdin: options.stdin });
      return { ok: true, exitCode: 0, stderr: "" };
    },
  });

  const largeContent = "x".repeat(256 * 1024);
  await runtime.createWriteOps().writeFile(pathForTest("gondolin-large.txt"), largeContent);

  assert.deepEqual(calls[0]?.command.slice(0, 3), ["/bin/mkdir", "-p", "/workspace"]);
  assert.deepEqual(calls[1]?.command.slice(0, 3), ["/bin/sh", "-c", "cat > \"$1\""]);
  assert.equal(calls[1]?.command.some((part) => part.includes(largeContent)), false);
  assert.equal(calls[1]?.stdin?.byteLength, largeContent.length);
});

test("uses gpt-5.5 and medium reasoning by default", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await runAgent({
      user_prompt: "Please uppercase hello",
      allowed_tools: ["uppercase"],
    });

    assert.equal(result.success, true);
    assert.equal(result.model_used, "gpt-5.5");
    assert.equal(result.reasoning_effort, "medium");
    assert.equal(result.attempts[0]?.model, "gpt-5.5");
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  }
});

function pathForTest(fileName: string): string {
  return `${process.cwd()}/${fileName}`;
}

test("applies OPENAI_BASE_URL to Pi OpenAI models", () => {
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "http://openai-proxy:4000/v1/";
  try {
    const model = getOpenAiModel("gpt-5.5");

    assert.equal(model?.baseUrl, "http://openai-proxy:4000/v1");
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
  }
});

test("uses the default OpenAI base URL when OPENAI_BASE_URL is blank", () => {
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = " ";
  try {
    const model = getOpenAiModel("gpt-5.5");

    assert.equal(model?.baseUrl, DEFAULT_OPENAI_BASE_URL);
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
  }
});

test("rejects runtime requests for another provider group", async () => {
  const previousProviderGroupId = process.env.KUUNA_PROVIDER_GROUP_ID;
  process.env.KUUNA_PROVIDER_GROUP_ID = "group-a@g.us";
  try {
    await assert.rejects(
      () =>
        runAgent({
          user_prompt: "hello",
          context: { provider_group_id: "group-b@g.us" },
        }),
      /runtime identity mismatch: provider_group_id/,
    );
  } finally {
    if (previousProviderGroupId === undefined) {
      delete process.env.KUUNA_PROVIDER_GROUP_ID;
    } else {
      process.env.KUUNA_PROVIDER_GROUP_ID = previousProviderGroupId;
    }
  }
});

test("accepts runtime requests matching container identity", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousProviderGroupId = process.env.KUUNA_PROVIDER_GROUP_ID;
  const previousBindingId = process.env.KUUNA_BINDING_ID;
  const previousAgentInstanceId = process.env.KUUNA_AGENT_INSTANCE_ID;
  delete process.env.OPENAI_API_KEY;
  process.env.KUUNA_PROVIDER_GROUP_ID = "group-a@g.us";
  process.env.KUUNA_BINDING_ID = "binding-1";
  process.env.KUUNA_AGENT_INSTANCE_ID = "agent-1";
  try {
    const result = await runAgent({
      user_prompt: "hello",
      context: {
        provider_group_id: "group-a@g.us",
        binding_id: "binding-1",
        agent_instance_id: "agent-1",
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.model_used, "gpt-5.5");
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousProviderGroupId === undefined) delete process.env.KUUNA_PROVIDER_GROUP_ID;
    else process.env.KUUNA_PROVIDER_GROUP_ID = previousProviderGroupId;
    if (previousBindingId === undefined) delete process.env.KUUNA_BINDING_ID;
    else process.env.KUUNA_BINDING_ID = previousBindingId;
    if (previousAgentInstanceId === undefined) delete process.env.KUUNA_AGENT_INSTANCE_ID;
    else process.env.KUUNA_AGENT_INSTANCE_ID = previousAgentInstanceId;
  }
});

test("executes explicit todo_create requests inside runtime container", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await runAgent({
      user_prompt: "Review attached image",
      allowed_tools: ["todo_create"],
      context: {
        provider_group_id: "group-a@g.us",
        todo_required: true,
      },
      tool_requests: [
        {
          name: "todo_create",
          arguments: {
            title: "Review image attachment",
            description: "Inspect image for staff follow-up.",
            priority: "normal",
          },
        },
      ],
    });

    assert.equal(result.success, true);
    assert.equal(result.tool_results.length, 1);
    assert.equal(result.tool_results[0]?.name, "todo_create");
    assert.equal(result.tool_results[0]?.ok, true);
    assert.deepEqual(result.tool_results[0]?.details, {
      operation: "create",
      title: "Review image attachment",
      description: "Inspect image for staff follow-up.",
      priority: "normal",
      due_at: null,
    });
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test("analyzes image attachments before running the agent", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    assert.equal(body.model, "gpt-4.1-mini");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Image shows an invoice requiring staff review." } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await runAgent({
      user_prompt: "Review media",
      context: {
        provider_group_id: "group-a@g.us",
        media_attachments: [
          {
            media_asset_id: "media-1",
            mime_type: "image/jpeg",
            status: "ready",
            preview_url: "data:image/jpeg;base64,aGVsbG8=",
          },
        ],
      },
    });

    assert.equal(result.media_insights.length, 1);
    assert.equal(result.media_insights[0]?.status, "ready");
    assert.equal(result.media_insights[0]?.summary, "Image shows an invoice requiring staff review.");
    assert.match(result.context_block ?? "", /media_insights/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test("analyzes video thumbnails inside the runtime before running the agent", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    assert.equal(body.model, "gpt-4.1-mini");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Video preview shows a damaged package needing review." } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await runAgent({
      user_prompt: "Review video",
      context: {
        provider_group_id: "group-a@g.us",
        media_attachments: [
          {
            media_asset_id: "media-video-1",
            mime_type: "video/mp4",
            status: "ready",
            preview_url: "data:image/jpeg;base64,aGVsbG8=",
          },
        ],
      },
    });

    assert.equal(result.media_insights.length, 1);
    assert.equal(result.media_insights[0]?.kind, "video");
    assert.equal(result.media_insights[0]?.status, "ready");
    assert.equal(result.media_insights[0]?.summary, "Video preview shows a damaged package needing review.");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});
