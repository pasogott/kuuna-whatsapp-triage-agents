"use server";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { isRedirectError } from "next/dist/client/components/redirect-error";
import { redirect } from "next/navigation";

import { requireAuthorized } from "@/lib/auth/guards";
import { createSessionBackendTrpcClient } from "@/lib/backend/client";

function clean(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeDocKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_.\s]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

function shortReason(reason: string): string {
  return reason.slice(0, 220);
}

function rethrowRedirectError(error: unknown): void {
  if (isRedirectError(error)) {
    throw error;
  }
}

function chatKnowledgeRedirect(providerGroupId: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `/inbox/${encodeURIComponent(providerGroupId)}/knowledge?${search.toString()}`;
}

const cyberheldCommonKnowledgeSeeds = [
  {
    title: "Cyberheld - Unternehmensprofil und Grundpositionierung",
    docKey: "cyberheld-company-positioning",
    filename: "cyberheld-company-positioning.md",
  },
  {
    title: "Cyberheld - Intake, Beweissicherung und Fallworkflow",
    docKey: "cyberheld-intake-evidence-workflow",
    filename: "cyberheld-intake-and-evidence-workflow.md",
  },
  {
    title: "Cyberheld - Österreichischer Rechtskontext für Bot-Antworten",
    docKey: "cyberheld-austrian-legal-context",
    filename: "cyberheld-austrian-legal-context.md",
  },
  {
    title: "Cyberheld - FAQ und klientengerechte Kommunikation",
    docKey: "cyberheld-faq-client-communication",
    filename: "cyberheld-faq-and-client-communication.md",
  },
] as const;

async function readCyberheldSeedMarkdown(filename: string): Promise<string> {
  const candidates = [
    path.join(process.cwd(), "plan/mvp/common-knowledge-cyberheld", filename),
    path.join(process.cwd(), "../../plan/mvp/common-knowledge-cyberheld", filename),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error(`seed file not found: ${filename}`);
}

export async function createCommonKnowledgeDocAction(formData: FormData): Promise<void> {
  await requireAuthorized("knowledge", "publish");

  const title = clean(formData.get("title"));
  const docKeyInput = clean(formData.get("docKey"));

  if (!title || !docKeyInput) {
    redirect("/knowledge/common?error=missing-fields");
  }

  const docKey = normalizeDocKey(docKeyInput);
  if (!docKey) {
    redirect("/knowledge/common?error=invalid-doc-key");
  }

  try {
    const client = await createSessionBackendTrpcClient();
    const doc = await client.knowledge.createCommonDoc.mutate({ title, docKey });
    redirect(`/knowledge/common/${encodeURIComponent(doc.id)}?created=1`);
  } catch (error) {
    rethrowRedirectError(error);
    const reason = error instanceof Error ? error.message : String(error);
    redirect(`/knowledge/common?error=${encodeURIComponent(shortReason(reason))}`);
  }
}

export async function seedCyberheldCommonKnowledgeAction(): Promise<void> {
  await requireAuthorized("knowledge", "publish");

  try {
    const client = await createSessionBackendTrpcClient();
    const existing = await client.knowledge.commonDocs.query();
    if (existing.length > 0) {
      redirect("/knowledge/common?seed=skipped");
    }

    let createdCount = 0;
    for (const seed of cyberheldCommonKnowledgeSeeds) {
      const contentMarkdown = await readCyberheldSeedMarkdown(seed.filename);
      const doc = await client.knowledge.createCommonDoc.mutate({
        title: seed.title,
        docKey: seed.docKey,
      });
      const version = await client.knowledge.createVersion.mutate({
        scope: "common",
        docRefId: doc.id,
        contentMarkdown,
      });
      await client.knowledge.publishVersion.mutate({
        scope: "common",
        docRefId: doc.id,
        versionId: version.id,
      });
      createdCount += 1;
    }

    redirect(`/knowledge/common?seed=created&count=${createdCount}`);
  } catch (error) {
    rethrowRedirectError(error);
    const reason = error instanceof Error ? error.message : String(error);
    redirect(`/knowledge/common?seed=error&reason=${encodeURIComponent(shortReason(reason))}`);
  }
}

export async function createCommonKnowledgeDraftAction(formData: FormData): Promise<void> {
  await requireAuthorized("knowledge", "publish");

  const docRefId = clean(formData.get("docRefId"));
  const contentMarkdown = clean(formData.get("contentMarkdown")) ?? "";

  if (!docRefId) {
    redirect("/knowledge/common?error=missing-doc-id");
  }
  if (!contentMarkdown.trim()) {
    redirect(`/knowledge/common/${encodeURIComponent(docRefId)}?error=missing-content`);
  }

  try {
    const client = await createSessionBackendTrpcClient();
    const version = await client.knowledge.createVersion.mutate({
      scope: "common",
      docRefId,
      contentMarkdown,
    });
    redirect(`/knowledge/common/${encodeURIComponent(docRefId)}?draft=1&versionId=${encodeURIComponent(version.id)}`);
  } catch (error) {
    rethrowRedirectError(error);
    const reason = error instanceof Error ? error.message : String(error);
    redirect(`/knowledge/common/${encodeURIComponent(docRefId)}?error=${encodeURIComponent(shortReason(reason))}`);
  }
}

export async function publishCommonKnowledgeVersionAction(formData: FormData): Promise<void> {
  await requireAuthorized("knowledge", "publish");

  const docRefId = clean(formData.get("docRefId"));
  const versionId = clean(formData.get("versionId"));

  if (!docRefId || !versionId) {
    redirect("/knowledge/common?error=missing-version-id");
  }

  try {
    const client = await createSessionBackendTrpcClient();
    await client.knowledge.publishVersion.mutate({
      scope: "common",
      docRefId,
      versionId,
    });
    redirect(`/knowledge/common/${encodeURIComponent(docRefId)}?published=1&versionId=${encodeURIComponent(versionId)}`);
  } catch (error) {
    rethrowRedirectError(error);
    const reason = error instanceof Error ? error.message : String(error);
    redirect(`/knowledge/common/${encodeURIComponent(docRefId)}?error=${encodeURIComponent(shortReason(reason))}`);
  }
}

export async function savePersonKnowledgeNoteAction(formData: FormData): Promise<void> {
  await requireAuthorized("knowledge", "publish");

  const providerGroupId = clean(formData.get("providerGroupId"));
  const providerUserId = clean(formData.get("providerUserId"));
  const contentMarkdownValue = formData.get("contentMarkdown");
  const contentMarkdown = typeof contentMarkdownValue === "string" ? contentMarkdownValue : null;

  if (!providerGroupId) {
    redirect("/inbox?personNote=error&reason=missing-provider-group-id");
  }
  if (!providerUserId) {
    redirect(chatKnowledgeRedirect(providerGroupId, { personNote: "error", reason: "missing-person" }));
  }
  if (!contentMarkdown || !contentMarkdown.trim()) {
    redirect(chatKnowledgeRedirect(providerGroupId, { personNote: "error", reason: "missing-content" }));
  }

  try {
    const client = await createSessionBackendTrpcClient();
    await client.knowledge.upsertPersonNote.mutate({
      providerGroupId,
      providerUserId,
      contentMarkdown,
    });
    redirect(chatKnowledgeRedirect(providerGroupId, { personNote: "saved" }));
  } catch (error) {
    rethrowRedirectError(error);
    const reason = error instanceof Error ? error.message : String(error);
    redirect(chatKnowledgeRedirect(providerGroupId, { personNote: "error", reason: shortReason(reason) }));
  }
}
