import { KnowledgeTab } from "@/components/inbox/tabs/knowledge-tab";

type Params = Promise<{ providerGroupId: string }>;
type SearchParams = Promise<{
  q?: string;
  scope?: string;
  sourceRole?: string;
  personNote?: string;
  reason?: string;
}>;

export default async function InboxKnowledgeTabPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { providerGroupId: rawParam } = await params;
  const rawFilters = await searchParams;
  const providerGroupId = decodeURIComponent(rawParam);
  return (
    <KnowledgeTab
      providerGroupId={providerGroupId}
      filters={{
        q: rawFilters.q?.trim() || undefined,
        scope: normalizeScope(rawFilters.scope),
        sourceRole: normalizeSourceRole(rawFilters.sourceRole),
      }}
      personNoteStatus={normalizePersonNoteStatus(rawFilters.personNote)}
      personNoteReason={rawFilters.reason}
    />
  );
}

function normalizeScope(value: string | undefined) {
  return value === "common" || value === "group" || value === "personal"
    ? value
    : undefined;
}

function normalizeSourceRole(value: string | undefined) {
  return value === "client" ||
    value === "lawyer" ||
    value === "company_staff" ||
    value === "bot" ||
    value === "unknown"
    ? value
    : undefined;
}

function normalizePersonNoteStatus(value: string | undefined) {
  return value === "saved" || value === "error" ? value : undefined;
}
