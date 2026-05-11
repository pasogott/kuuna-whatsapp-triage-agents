import { NextResponse } from "next/server";

import { currentCookieHeader, getSession } from "@/lib/auth/session";
import { createBackendTrpcClient } from "@/lib/backend/client";

type Params = Promise<{
  messageId: string;
  assetId: string;
}>;

function fileExtensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/plain") return "txt";
  if (normalized === "audio/mpeg" || normalized === "application/audio") return "mp3";
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/mp4") return "m4a";
  if (normalized === "audio/wav" || normalized === "audio/wave") return "wav";
  if (normalized.startsWith("audio/")) return "mp3";
  if (normalized === "video/mp4") return "mp4";
  return "bin";
}

function fallbackFilename(input: {
  id: string;
  file_name?: string | null;
  mime_type: string;
}): string {
  const fileName = input.file_name?.trim();
  if (fileName) {
    return fileName;
  }
  return `media-${input.id}.${fileExtensionFromMimeType(input.mime_type)}`;
}

function contentDisposition(filename: string, disposition: "attachment" | "inline"): string {
  const asciiFilename = filename.replace(/[\r\n"]/g, "_");
  return `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function responseFromDataUrl(
  url: string,
  filename: string,
  fallbackMimeType: string,
  disposition: "attachment" | "inline",
): Response | null {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(url);
  if (!match) {
    return null;
  }

  const mimeType = match[1] || fallbackMimeType;
  const encodedBody = match[2] ?? "";
  const isBase64 = url.slice(0, url.indexOf(",")).includes(";base64");
  const body = isBase64
    ? Buffer.from(encodedBody, "base64")
    : Buffer.from(decodeURIComponent(encodedBody), "utf8");

  return new Response(body, {
    headers: {
      "content-type": mimeType,
      "content-disposition": contentDisposition(filename, disposition),
      "content-length": String(body.byteLength),
    },
  });
}

function uniqueUrls(urls: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

export async function GET(
  request: Request,
  { params }: { params: Params },
): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }

  const { messageId, assetId } = await params;
  const disposition =
    new URL(request.url).searchParams.get("disposition") === "inline"
      ? "inline"
      : "attachment";
  const client = createBackendTrpcClient(undefined, { Cookie: await currentCookieHeader() });
  const assets = await client.messages.media.query({ messageId });
  const asset = assets.find((item) => item.id === assetId);
  if (!asset) {
    return NextResponse.json({ detail: "media asset not found" }, { status: 404 });
  }

  const filename = fallbackFilename(asset);
  const isInlineImage = disposition === "inline" && asset.mime_type.startsWith("image/");
  const downloadUrls = isInlineImage
    ? uniqueUrls([asset.download_url, asset.preview_url])
    : uniqueUrls([
        asset.download_url,
        asset.mime_type.startsWith("image/") ? asset.preview_url : null,
      ]);
  if (downloadUrls.length === 0) {
    return NextResponse.json({ detail: "download unavailable" }, { status: 404 });
  }

  for (const downloadUrl of downloadUrls) {
    if (downloadUrl.startsWith("data:")) {
      const dataUrlResponse = responseFromDataUrl(
        downloadUrl,
        filename,
        asset.mime_type,
        disposition,
      );
      if (dataUrlResponse) return dataUrlResponse;
      continue;
    }

    const upstream = await fetch(downloadUrl, { cache: "no-store" });
    if (!upstream.ok || !upstream.body) {
      continue;
    }

    return new Response(upstream.body, {
      headers: {
        "content-type": upstream.headers.get("content-type") ?? asset.mime_type,
        "content-disposition": contentDisposition(filename, disposition),
        ...(upstream.headers.get("content-length")
          ? { "content-length": upstream.headers.get("content-length") as string }
          : {}),
      },
    });
  }

  return NextResponse.json({ detail: "download failed" }, { status: 502 });
}
