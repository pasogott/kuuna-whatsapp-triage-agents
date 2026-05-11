import type {
  RuntimeMediaAttachment,
  RuntimeMediaInsight,
} from "@kuuna/agent-contracts";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import {
  defaultModel,
  openAiApiKey,
  openAiAudioTranscriptionModel,
  openAiBaseUrl,
  openAiTimeoutMs,
  piAuthPath,
  piTransport,
} from "./config.js";
import { getOpenAiModel } from "./model.js";

type FetchLike = typeof fetch;

type MediaBytes = {
  bytes: Uint8Array;
  contentType: string;
  dataUrl: string;
  base64: string;
};

type OpenAiTranscription = {
  text?: unknown;
};

export async function analyzeRuntimeMedia(
  attachments: RuntimeMediaAttachment[],
  fetchClient: FetchLike = fetch,
): Promise<RuntimeMediaInsight[]> {
  const insights: RuntimeMediaInsight[] = [];
  for (const attachment of attachments) {
    insights.push(await analyzeAttachment(attachment, fetchClient));
  }
  return insights;
}

function mediaKind(mimeType: string): RuntimeMediaInsight["kind"] {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/") || normalized.endsWith("/audio")) return "audio";
  if (normalized.startsWith("video/") || normalized.endsWith("/video")) return "video";
  return "file";
}

async function analyzeAttachment(
  attachment: RuntimeMediaAttachment,
  fetchClient: FetchLike,
): Promise<RuntimeMediaInsight> {
  const kind = mediaKind(attachment.mime_type);
  if (kind === "file") {
    return {
      media_asset_id: attachment.media_asset_id,
      mime_type: attachment.mime_type,
      kind,
      status: "skipped",
      summary: attachment.transcript ?? null,
      transcript: attachment.transcript ?? null,
    };
  }

  try {
    const sourceUrl = mediaSourceUrl(attachment, kind);
    if (!sourceUrl) {
      throw new Error("media_url_missing");
    }
    if (kind === "image") {
      const media = await loadMedia(sourceUrl, attachment.mime_type, fetchClient);
      const summary = await analyzeImageWithPi(media, imageInsightPrompt());
      return {
        media_asset_id: attachment.media_asset_id,
        mime_type: attachment.mime_type,
        kind,
        status: "ready",
        summary,
        transcript: summary,
      };
    }

    if (kind === "video") {
      const videoInsight = await analyzeVideoAttachment(attachment, fetchClient);
      return {
        media_asset_id: attachment.media_asset_id,
        mime_type: attachment.mime_type,
        kind,
        status: "ready",
        summary: videoInsight,
        transcript: videoInsight,
      };
    }

    const apiKey = openAiApiKey();
    if (!apiKey) {
      throw new Error("audio_transcription_requires_openai_api_key");
    }
    const media = await loadMedia(sourceUrl, attachment.mime_type, fetchClient);
    const transcript = await transcribeAudio(media.bytes, media.contentType, attachment.file_name ?? "audio", apiKey, fetchClient);
    return {
      media_asset_id: attachment.media_asset_id,
      mime_type: attachment.mime_type,
      kind,
      status: "ready",
      summary: transcript,
      transcript,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      media_asset_id: attachment.media_asset_id,
      mime_type: attachment.mime_type,
      kind,
      status: "failed",
      summary: attachment.transcript ?? null,
      transcript: attachment.transcript ?? null,
      error: message,
    };
  }
}

function mediaSourceUrl(
  attachment: RuntimeMediaAttachment,
  kind: RuntimeMediaInsight["kind"],
): string | null {
  if (kind === "image") {
    return attachment.object_url ?? attachment.preview_url ?? null;
  }
  return attachment.object_url ?? attachment.preview_url ?? null;
}

async function loadMedia(
  url: string,
  fallbackContentType: string,
  fetchClient: FetchLike,
): Promise<MediaBytes> {
  if (url.startsWith("data:")) {
    return mediaBytesFromDataUrl(url, fallbackContentType);
  }

  const response = await fetchClient(url, {
    method: "GET",
    signal: AbortSignal.timeout(openAiTimeoutMs()),
  });
  if (!response.ok) {
    throw new Error(`media_fetch_http_${response.status}`);
  }
  const contentType =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() ||
    fallbackContentType;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const base64 = Buffer.from(bytes).toString("base64");
  return {
    bytes,
    contentType,
    base64,
    dataUrl: `data:${contentType};base64,${base64}`,
  };
}

function mediaBytesFromDataUrl(url: string, fallbackContentType: string): MediaBytes {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) {
    throw new Error("invalid_data_url");
  }
  const contentType = match[1] || fallbackContentType;
  const encoded = match[3] ?? "";
  const bytes = match[2]
    ? Buffer.from(encoded, "base64")
    : Buffer.from(decodeURIComponent(encoded), "utf8");
  const base64 = Buffer.from(bytes).toString("base64");
  return {
    bytes,
    contentType,
    base64,
    dataUrl: `data:${contentType};base64,${base64}`,
  };
}

async function analyzeImageWithPi(
  media: MediaBytes,
  instruction: string,
): Promise<string> {
  const authPath = piAuthPath();
  if (!authPath) {
    throw new Error("pi_chatgpt_auth_required_for_media_preview");
  }
  const authStorage = AuthStorage.create(authPath);
  const apiKey = await authStorage.getApiKey("openai-codex", { includeFallback: false });
  if (!apiKey) {
    throw new Error("pi_chatgpt_auth_required_for_media_preview");
  }
  const model = getOpenAiModel(defaultModel());
  if (!model) {
    throw new Error(`OpenAI model '${defaultModel()}' is not available in Pi model registry`);
  }
  const response = await complete(model, {
    systemPrompt: "You analyze WhatsApp media for support staff. Return only the concise analysis text.",
    messages: [
      {
        role: "user",
        timestamp: Date.now(),
        content: [
          { type: "text", text: instruction },
          { type: "image", data: media.base64, mimeType: media.contentType },
        ],
      },
    ],
  }, {
    apiKey,
    transport: piTransport(),
    timeoutMs: openAiTimeoutMs(),
    maxRetries: 0,
  });
  const content = response.content
    .filter((item) => item.type === "text" && item.text.trim())
    .map((item) => item.type === "text" ? item.text.trim() : "")
    .join("\n")
    .trim();
  if (content) {
    return content;
  }
  throw new Error(response.errorMessage || "pi_media_preview_empty_response");
}

async function analyzeVideoAttachment(
  attachment: RuntimeMediaAttachment,
  fetchClient: FetchLike,
): Promise<string> {
  if (attachment.preview_url) {
    const preview = await loadMedia(attachment.preview_url, "image/jpeg", fetchClient);
    if (preview.contentType.toLowerCase().startsWith("image/")) {
      return analyzeImageWithPi(preview, videoPreviewInsightPrompt());
    }
  }

  const apiKey = openAiApiKey();
  if (!apiKey) {
    throw new Error("audio_transcription_requires_openai_api_key");
  }
  const sourceUrl = attachment.object_url ?? attachment.preview_url;
  if (!sourceUrl) {
    throw new Error("media_url_missing");
  }
  const media = await loadMedia(sourceUrl, attachment.mime_type, fetchClient);
  return transcribeAudio(media.bytes, media.contentType, attachment.file_name ?? "video", apiKey, fetchClient);
}

function imageInsightPrompt(): string {
  return "Analyze this WhatsApp image for a support staff todo. Summarize visible text, entities, dates, amounts, and the concrete follow-up needed. Be concise.";
}

function videoPreviewInsightPrompt(): string {
  return "Analyze this WhatsApp video preview frame for a support staff todo. Summarize visible text, entities, dates, amounts, and the concrete follow-up needed. Be concise and say that this is based on the preview frame.";
}

async function transcribeAudio(
  bytes: Uint8Array,
  contentType: string,
  filename: string,
  apiKey: string,
  fetchClient: FetchLike,
): Promise<string> {
  const body = new FormData();
  body.set("model", openAiAudioTranscriptionModel());
  body.set(
    "file",
    new Blob([bytes], { type: contentType }),
    filenameWithExtension(filename, contentType),
  );

  const response = await fetchClient(`${openAiBaseUrl()}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    signal: AbortSignal.timeout(openAiTimeoutMs()),
  });
  if (!response.ok) {
    throw new Error(`openai_transcription_http_${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const payload = (await response.json()) as OpenAiTranscription;
  if (typeof payload.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }
  throw new Error("openai_transcription_empty_response");
}

function filenameWithExtension(filename: string, contentType: string): string {
  if (/\.[a-z0-9]{2,5}$/i.test(filename)) {
    return filename;
  }
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized === "audio/mpeg" || normalized === "application/audio") return `${filename}.mp3`;
  if (normalized === "audio/ogg") return `${filename}.ogg`;
  if (normalized === "audio/mp4") return `${filename}.m4a`;
  if (normalized === "audio/wav" || normalized === "audio/wave") return `${filename}.wav`;
  if (normalized.startsWith("audio/")) return `${filename}.mp3`;
  return `${filename}.bin`;
}
