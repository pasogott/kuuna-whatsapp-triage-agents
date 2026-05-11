import Link from "next/link";

import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { savePersonKnowledgeNoteAction } from "@/lib/knowledge/actions";
import { listGroupKnowledgeExplorer, listGroupMembers } from "@/lib/api-client";
import type { KnowledgeExplorerItem, WhatsAppGroupMember } from "@/lib/api-client/types";
import { formatDateTime } from "@/lib/utils/format";

type KnowledgeTabProps = {
  providerGroupId: string;
  filters?: {
    q?: string;
    scope?: "common" | "group" | "personal";
    sourceRole?: "client" | "lawyer" | "company_staff" | "bot" | "unknown";
  };
  personNoteStatus?: "saved" | "error";
  personNoteReason?: string;
};

const scopeLabels: Record<KnowledgeExplorerItem["scope"], string> = {
  common: "Common",
  group: "Group",
  personal: "Personal",
};

const kindLabels: Record<KnowledgeExplorerItem["kind"], string> = {
  document: "Document",
  statement: "Statement",
  claim: "Claim",
};

export async function KnowledgeTab({
  providerGroupId,
  filters = {},
  personNoteStatus,
  personNoteReason,
}: KnowledgeTabProps) {
  const [explorer, memberConfig] = await Promise.all([
    listGroupKnowledgeExplorer(providerGroupId, filters),
    listGroupMembers(providerGroupId),
  ]);
  const grouped = {
    common: explorer.items.filter((item) => item.scope === "common"),
    group: explorer.items.filter((item) => item.scope === "group"),
    personal: explorer.items.filter((item) => item.scope === "personal"),
  };

  return (
    <div className="flex flex-col gap-6 p-4">
      <Notice title="Knowledge is source-attributed" tone="info">
        This view is filtered to the knowledge the bound AI agent is allowed to
        search from its active template. Chat-derived entries remain attributed
        perspectives, not objective facts.
      </Notice>

      {personNoteStatus === "saved" ? (
        <Notice title="Person note saved" tone="success">
          The Markdown note was published and queued for Knowledge indexing.
        </Notice>
      ) : null}
      {personNoteStatus === "error" ? (
        <Notice title="Person note failed" tone="warning">
          {personNoteReason ?? "The person note could not be saved."}
        </Notice>
      ) : null}

      <PersonNoteForm providerGroupId={providerGroupId} members={memberConfig.items} />

      <form className="grid gap-3 rounded border border-border bg-card p-4 md:grid-cols-[1fr_180px_220px_auto]">
        <input
          name="q"
          defaultValue={filters.q ?? ""}
          placeholder="Search Knowledge"
          className="h-10 rounded border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <select
          name="scope"
          defaultValue={filters.scope ?? ""}
          className="h-10 rounded border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All levels</option>
          <option value="common">Common</option>
          <option value="group">Group</option>
          <option value="personal">Personal</option>
        </select>
        <select
          name="sourceRole"
          defaultValue={filters.sourceRole ?? ""}
          className="h-10 rounded border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All source roles</option>
          <option value="client">Client</option>
          <option value="lawyer">Lawyer</option>
          <option value="company_staff">Company staff</option>
          <option value="bot">Bot</option>
          <option value="unknown">Unknown</option>
        </select>
        <Button type="submit" variant="outline">Filter</Button>
      </form>

      <div className="grid gap-4 xl:grid-cols-3">
        {(["common", "group", "personal"] as const).map((scope) => (
          <Card key={scope} className="overflow-hidden">
            <CardHeader className="border-b border-border">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">{scopeLabels[scope]}</CardTitle>
                <StatusBadge status={grouped[scope].length ? "ready" : "draft"} />
              </div>
              {scope === "personal" ? (
                <p className="text-sm text-muted-foreground">
                  {explorer.primaryClientDisplayName ?? "No primary client configured"}
                </p>
              ) : null}
            </CardHeader>
            <CardContent className="p-0">
              <KnowledgeList items={grouped[scope]} providerGroupId={providerGroupId} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function PersonNoteForm({
  providerGroupId,
  members,
}: {
  providerGroupId: string;
  members: WhatsAppGroupMember[];
}) {
  const selectableMembers = members.filter((member) => member.role !== "bot");
  return (
    <form action={savePersonKnowledgeNoteAction} className="grid gap-3 rounded border border-border bg-card p-4">
      <input type="hidden" name="providerGroupId" value={providerGroupId} />
      <div className="grid gap-3 md:grid-cols-[minmax(220px,320px)_1fr_auto] md:items-start">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase text-muted-foreground">Person</span>
          <select
            name="providerUserId"
            className="h-10 rounded border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            required
            disabled={selectableMembers.length === 0}
          >
            <option value="">Select person</option>
            {selectableMembers.map((member) => (
              <option key={member.providerUserId} value={member.providerUserId}>
                {memberLabel(member)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase text-muted-foreground">Markdown note</span>
          <textarea
            name="contentMarkdown"
            className="min-h-28 rounded border border-input bg-background px-3 py-2 text-sm leading-6 outline-none focus:ring-2 focus:ring-ring"
            placeholder="Add relevant person information for this chat."
            required
            disabled={selectableMembers.length === 0}
          />
        </label>
        <Button type="submit" className="md:mt-5" disabled={selectableMembers.length === 0}>
          Save note
        </Button>
      </div>
      {selectableMembers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sync or save WhatsApp members in Settings before adding person notes.
        </p>
      ) : null}
    </form>
  );
}

function memberLabel(member: WhatsAppGroupMember): string {
  return (
    member.displayName ||
    member.pushName ||
    member.phoneDisplay ||
    member.providerUserId
  );
}

function KnowledgeList({
  items,
  providerGroupId,
}: {
  items: KnowledgeExplorerItem[];
  providerGroupId: string;
}) {
  if (items.length === 0) {
    return (
      <div className="px-4 py-8 text-sm text-muted-foreground">
        No entries for this level yet.
      </div>
    );
  }
  return (
    <div className="divide-y divide-border">
      {items.map((item) => (
        <article key={`${item.kind}:${item.id}`} className="flex flex-col gap-3 px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-border bg-muted px-2 py-0.5 text-xs font-medium">
              {kindLabels[item.kind]}
            </span>
            {item.sourceRole ? (
              <span className="rounded border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                {item.sourceRole}
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {formatDateTime(item.occurredAt)}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
            <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
              {item.text}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {item.speakerDisplayName ? <span>{item.speakerDisplayName}</span> : null}
            {item.providerMessageId ? (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                {item.providerMessageId}
              </code>
            ) : null}
            {item.sourceMessageId ? (
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/inbox/${encodeURIComponent(providerGroupId)}`}>
                  Open chat
                </Link>
              </Button>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}
