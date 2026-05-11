import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getOpenAiModel } from "../src/model.js";
import { runAgent } from "../src/runner.js";
import { isBashCommandAllowed, sanitizeAllowedTools } from "../src/tools.js";

function fakeCodexJwt(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
    "signature",
  ].join(".");
}

async function createPiAuthFile(): Promise<{ dir: string; authPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "kuuna-pi-auth-"));
  const authPath = path.join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify({
    "openai-codex": { type: "api_key", key: fakeCodexJwt() },
  }));
  return { dir, authPath };
}

function codexSseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const body = [
    { type: "response.created", response: { id: "resp_test" } },
    { type: "response.output_item.added", item: { id: "msg_test", type: "message", role: "assistant", content: [] } },
    { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("sanitizes allowed tools without enabling Pi coding tools", () => {
  assert.deepEqual(
    sanitizeAllowedTools(["uppercase", "bash", "read", "media_analyze", "todo_create", "write"]),
    ["uppercase", "media_analyze", "todo_create"],
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

test("requires Pi ChatGPT auth for agent LLM calls", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousPiAuthPath = process.env.PI_AUTH_PATH;
  delete process.env.OPENAI_API_KEY;
  delete process.env.PI_AUTH_PATH;
  try {
    const result = await runAgent({
      user_prompt: "Please uppercase hello",
      allowed_tools: ["uppercase"],
    });

    assert.equal(result.success, false);
    assert.equal(result.reasoning_effort, "medium");
    assert.equal(result.attempts[0]?.model, "gpt-5.5");
    assert.match(result.error ?? "", /pi_chatgpt_auth_required_for_agent_llm/);
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
    if (previousPiAuthPath === undefined) delete process.env.PI_AUTH_PATH;
    else process.env.PI_AUTH_PATH = previousPiAuthPath;
  }
});

test("does not analyze media before Pi ChatGPT auth is configured", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousPiAuthPath = process.env.PI_AUTH_PATH;
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.PI_AUTH_PATH;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch should not be called without Pi auth");
  }) as typeof fetch;
  try {
    const result = await runAgent({
      user_prompt: "Review audio",
      context: {
        media_attachments: [
          {
            media_asset_id: "audio-1",
            mime_type: "audio/mpeg",
            status: "ready",
            object_url: "https://example.test/audio.mp3",
          },
        ],
      },
    });

    assert.equal(result.success, false);
    assert.deepEqual(result.media_insights, []);
    assert.match(result.error ?? "", /pi_chatgpt_auth_required_for_agent_llm/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousPiAuthPath === undefined) delete process.env.PI_AUTH_PATH;
    else process.env.PI_AUTH_PATH = previousPiAuthPath;
  }
});

test("uses Pi OpenAI Codex provider even when only an API key is configured", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousPiAuthPath = process.env.PI_AUTH_PATH;
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.PI_AUTH_PATH;
  try {
    const model = getOpenAiModel("gpt-5.5");

    assert.equal(model?.provider, "openai-codex");
    assert.equal(model?.id, "gpt-5.5");
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousPiAuthPath === undefined) delete process.env.PI_AUTH_PATH;
    else process.env.PI_AUTH_PATH = previousPiAuthPath;
  }
});

test("ignores explicit OpenAI API provider prefixes for agent models", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousPiAuthPath = process.env.PI_AUTH_PATH;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.PI_AUTH_PATH = "/tmp/pi-auth.json";
  try {
    const model = getOpenAiModel("openai/gpt-5.5");

    assert.equal(model?.provider, "openai-codex");
    assert.equal(model?.id, "gpt-5.5");
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousPiAuthPath === undefined) delete process.env.PI_AUTH_PATH;
    else process.env.PI_AUTH_PATH = previousPiAuthPath;
  }
});

test("uses Pi OpenAI Codex provider when only ChatGPT auth is configured", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousPiAuthPath = process.env.PI_AUTH_PATH;
  delete process.env.OPENAI_API_KEY;
  process.env.PI_AUTH_PATH = "/tmp/pi-auth.json";
  try {
    const model = getOpenAiModel("gpt-5.5");

    assert.equal(model?.provider, "openai-codex");
    assert.equal(model?.id, "gpt-5.5");
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousPiAuthPath === undefined) delete process.env.PI_AUTH_PATH;
    else process.env.PI_AUTH_PATH = previousPiAuthPath;
  }
});

test("uses Pi OpenAI Codex provider for agent models when ChatGPT auth and API key are both configured", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousPiAuthPath = process.env.PI_AUTH_PATH;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.PI_AUTH_PATH = "/tmp/pi-auth.json";
  try {
    const model = getOpenAiModel("gpt-5.5");

    assert.equal(model?.provider, "openai-codex");
    assert.equal(model?.id, "gpt-5.5");
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousPiAuthPath === undefined) delete process.env.PI_AUTH_PATH;
    else process.env.PI_AUTH_PATH = previousPiAuthPath;
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

test("keeps runtime identity checks but still requires Pi ChatGPT auth", async () => {
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

    assert.equal(result.success, false);
    assert.equal(result.model_used, null);
    assert.match(result.error ?? "", /pi_chatgpt_auth_required_for_agent_llm/);
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

test("does not execute explicit runtime tools as an agent fallback without Pi ChatGPT auth", async () => {
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

    assert.equal(result.success, false);
    assert.equal(result.tool_results.length, 0);
    assert.match(result.error ?? "", /pi_chatgpt_auth_required_for_agent_llm/);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test("analyzes image attachments before running the agent", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousPiAuthPath = process.env.PI_AUTH_PATH;
  const previousPiTransport = process.env.PI_TRANSPORT;
  delete process.env.OPENAI_API_KEY;
  const auth = await createPiAuthFile();
  process.env.PI_AUTH_PATH = auth.authPath;
  process.env.PI_TRANSPORT = "sse";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Array<{ content?: Array<{ text?: string }> }> };
    const text = body.input?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("\n") ?? "";
    return codexSseResponse(
      text.includes("Analyze this WhatsApp image")
        ? "Image shows an invoice requiring staff review."
        : "Agent reviewed media.",
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
    await rm(auth.dir, { recursive: true, force: true });
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousPiAuthPath === undefined) delete process.env.PI_AUTH_PATH;
    else process.env.PI_AUTH_PATH = previousPiAuthPath;
    if (previousPiTransport === undefined) delete process.env.PI_TRANSPORT;
    else process.env.PI_TRANSPORT = previousPiTransport;
  }
});

test("analyzes video thumbnails inside the runtime before running the agent", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousPiAuthPath = process.env.PI_AUTH_PATH;
  const previousPiTransport = process.env.PI_TRANSPORT;
  delete process.env.OPENAI_API_KEY;
  const auth = await createPiAuthFile();
  process.env.PI_AUTH_PATH = auth.authPath;
  process.env.PI_TRANSPORT = "sse";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Array<{ content?: Array<{ text?: string }> }> };
    const text = body.input?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("\n") ?? "";
    return codexSseResponse(
      text.includes("video preview frame")
        ? "Video preview shows a damaged package needing review."
        : "Agent reviewed video.",
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
    await rm(auth.dir, { recursive: true, force: true });
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousPiAuthPath === undefined) delete process.env.PI_AUTH_PATH;
    else process.env.PI_AUTH_PATH = previousPiAuthPath;
    if (previousPiTransport === undefined) delete process.env.PI_TRANSPORT;
    else process.env.PI_TRANSPORT = previousPiTransport;
  }
});
