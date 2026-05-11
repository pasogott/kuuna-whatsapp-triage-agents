import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MessageSquare } from "lucide-react";

import {
  AUTO_REFRESH_INTERVALS,
  AutoRefresh,
} from "@/components/system/auto-refresh";
import { RuntimeStreamPanel } from "@/components/agent-runs/runtime-stream-panel";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { listAgentRuns, listToolInvocations } from "@/lib/api-client";
import { canAccessGroup, requireSession } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/utils/format";

type Params = Promise<{ runId: string }>;

function CodeBlock({ value, maxHeight = "max-h-[440px]" }: { value: string; maxHeight?: string }) {
  return (
    <pre
      className={`${maxHeight} overflow-auto rounded-md border border-border bg-muted/70 p-3 font-mono text-xs leading-relaxed text-foreground`}
    >
      <code>{value}</code>
    </pre>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-border/70 py-3 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs font-medium uppercase text-muted-foreground">{label}</dt>
      <dd className="break-words font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

function formatJsonLike(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return formatJsonLike(value);
  }
  return JSON.stringify(value ?? {}, null, 2);
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export default async function AgentRunDetailPage({ params }: { params: Params }) {
  const { runId } = await params;
  const session = await requireSession();
  const runs = await listAgentRuns();
  const run = runs.find((item) => item.id === runId);

  if (!run || !canAccessGroup(session, run.providerGroupId)) {
    notFound();
  }

  const toolInvocations = await listToolInvocations(run.providerGroupId, run.id);
  const inputContext = run.inputContext ?? {};
  const hasPromptSnapshot = Boolean(run.systemPrompt || run.userPrompt || Object.keys(inputContext).length);
  const rawLog = {
    run,
    toolInvocations,
  };

  const refreshIntervalMs =
    run.status === "running"
      ? AUTO_REFRESH_INTERVALS.fast
      : AUTO_REFRESH_INTERVALS.slow;

  return (
    <div className="flex flex-col gap-8">
      <AutoRefresh
        intervalMs={refreshIntervalMs}
        eventTypes={["agent_run.updated", "tool_invocation.created", "todo.updated"]}
      />
      <PageHeader
        title="Agent run"
        description={`Execution log for ${run.groupTitle}.`}
        actions={
          <Button asChild variant="outline">
            <Link href="/agent-runs">
              <ArrowLeft aria-hidden />
              <span>Back</span>
            </Link>
          </Button>
        }
      />

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Execution</h2>
          <dl className="mt-2 border-t border-border">
            <Field label="Run ID" value={run.id} />
            <Field label="Status" value={run.status} />
            <Field label="Started" value={formatDateTime(run.startedAt)} />
            <Field
              label="Completed"
              value={run.completedAt ? formatDateTime(run.completedAt) : "running"}
            />
            <Field
              label="Model"
              value={`${run.modelUsed ?? run.modelPath[0] ?? "n/a"} / ${run.reasoningEffort}`}
            />
            <Field label="Trace" value={run.traceId ?? "n/a"} />
            <Field label="Message" value={run.messageId ?? "n/a"} />
            <Field
              label="Prompt snapshot"
              value={hasPromptSnapshot ? "recorded" : "not recorded"}
            />
          </dl>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-foreground">Context</h2>
          <div className="mt-2 border-t border-border">
            <div className="border-b border-border/70 py-3">
              <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">Group</p>
              <Link
                href={`/inbox/${encodeURIComponent(run.providerGroupId)}`}
                className="inline-flex items-center gap-2 text-sm text-foreground hover:underline"
              >
                <MessageSquare aria-hidden className="size-4" />
                <span>{run.groupTitle}</span>
              </Link>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                {run.providerGroupId}
              </p>
            </div>

            <div className="border-b border-border/70 py-3">
              <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                Allowed tools
              </p>
              <p className="break-words font-mono text-xs text-foreground">
                {run.allowedTools.length ? run.allowedTools.join(", ") : "none"}
              </p>
            </div>

            <div className="border-b border-border/70 py-3">
              <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                Retrieval refs
              </p>
              <p className="break-words font-mono text-xs text-foreground">
                {run.retrievalRefs.length ? run.retrievalRefs.join(", ") : "none"}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-foreground">Input prompt</h2>
          <p className="text-sm text-muted-foreground">
            Exact prompt payload captured before the runtime call. Older runs may not have this snapshot.
          </p>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <PromptMetric label="Recent messages" value={countArray(inputContext.recent_messages)} />
          <PromptMetric label="Todos" value={countArray(inputContext.todos)} />
          <PromptMetric label="Retrieval hits" value={countArray(inputContext.retrieval_hits)} />
          <PromptMetric label="Media" value={countArray(inputContext.media_attachments)} />
        </div>

        <div className="mt-4 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <PromptPanel
            title="User prompt"
            value={run.userPrompt}
            emptyLabel="No user prompt snapshot recorded for this run."
            maxHeight="max-h-[520px]"
          />
          <PromptPanel
            title="System prompt"
            value={run.systemPrompt}
            emptyLabel="No system prompt snapshot recorded for this run."
            maxHeight="max-h-[520px]"
          />
        </div>

        <div className="mt-6">
          <h3 className="text-sm font-semibold text-foreground">Runtime context</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Context object passed beside the prompts, including recent messages, todos, retrieval, links, media, and access IDs.
          </p>
          <div className="mt-2">
            <CodeBlock value={formatUnknown(inputContext)} maxHeight="max-h-[640px]" />
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-foreground">Pi stream</h2>
        <div className="mt-2">
          <RuntimeStreamPanel runId={run.id} initialText={run.responseText} />
        </div>
      </section>

      {run.error ? (
        <section>
          <h2 className="text-sm font-semibold text-foreground">Error</h2>
          <div className="mt-2">
            <CodeBlock value={run.error} />
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="text-sm font-semibold text-foreground">Tool calls</h2>
        <div className="mt-2 divide-y divide-border border-y border-border">
          {toolInvocations.length ? (
            toolInvocations.map((invocation) => (
              <article key={invocation.id} className="grid gap-3 py-4 lg:grid-cols-[240px_minmax(0,1fr)]">
                <div>
                  <p className="font-mono text-xs text-foreground">{invocation.toolName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {invocation.timedOut ? "timeout" : invocation.ok ? "ok" : "failed"} ·{" "}
                    {invocation.durationMs} ms · {formatDateTime(invocation.createdAt)}
                  </p>
                </div>
                <div className="grid gap-2">
                  {invocation.stdout ? (
                    <CodeBlock value={formatJsonLike(invocation.stdout)} maxHeight="max-h-[260px]" />
                  ) : null}
                  {invocation.stderr ? (
                    <CodeBlock value={invocation.stderr} maxHeight="max-h-[260px]" />
                  ) : null}
                  {!invocation.stdout && !invocation.stderr ? (
                    <CodeBlock value={formatJsonLike(invocation.detailsSummary || "{}")} maxHeight="max-h-[260px]" />
                  ) : null}
                </div>
              </article>
            ))
          ) : (
            <p className="py-4 text-sm text-muted-foreground">
              No tool calls recorded for this run.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-foreground">Raw agent log JSON</h2>
        <div className="mt-2">
          <CodeBlock value={JSON.stringify(rawLog, null, 2)} maxHeight="max-h-[640px]" />
        </div>
      </section>
    </div>
  );
}

function PromptMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

function PromptPanel({
  title,
  value,
  emptyLabel,
  maxHeight,
}: {
  title: string;
  value?: string;
  emptyLabel: string;
  maxHeight: string;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-2">
        {value ? (
          <CodeBlock value={value} maxHeight={maxHeight} />
        ) : (
          <p className="rounded-md border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
            {emptyLabel}
          </p>
        )}
      </div>
    </div>
  );
}
