import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BookOpen,
  CircleDot,
  Layers,
  MessageCircle,
  Plug,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/status/status-badge";
import { AutoRefresh } from "@/components/system/auto-refresh";
import {
  listAuditEvents,
  listBindings,
  listKnowledgeDocs,
  listMessages,
  listTemplates,
} from "@/lib/api-client";
import { formatDateTime } from "@/lib/utils/format";

export default async function OverviewPage() {
  const [templates, bindings, commonDocs, messages, auditEvents] =
    await Promise.all([
      listTemplates(),
      listBindings(),
      listKnowledgeDocs(),
      listMessages(),
      listAuditEvents(),
    ]);

  const activeBindings = bindings.filter(
    (item) => item.status === "active",
  ).length;
  const provisioningBindings = bindings.filter(
    (item) => item.status === "provisioning",
  ).length;
  const failedBindings = bindings.filter(
    (item) => item.status === "failed",
  ).length;
  const recentAudit = [...auditEvents]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);
  const recentBindings = [...bindings]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);

  const healthItems: Array<{
    label: string;
    status: "ok" | "warn" | "err";
    detail: string;
  }> = [
    {
      label: "Active bindings",
      status: failedBindings > 0 ? "err" : provisioningBindings > 0 ? "warn" : "ok",
      detail:
        failedBindings > 0
          ? `${failedBindings} failed binding${failedBindings === 1 ? "" : "s"}`
          : provisioningBindings > 0
            ? `${provisioningBindings} provisioning`
            : "All groups reporting",
    },
    {
      label: "Company knowledge",
      status: commonDocs.length > 0 ? "ok" : "warn",
      detail:
        commonDocs.length > 0
          ? `${commonDocs.length} admin docs`
          : "No admin documents yet",
    },
  ];

  return (
    <div className="flex flex-col gap-10">
      <AutoRefresh
        intervalMs={10000}
        eventTypes={[
          "message.created",
          "media.updated",
          "todo.updated",
          "agent_run.updated",
          "binding.updated",
          "template_build.updated",
          "runtime_container.updated",
        ]}
      />
      <PageHeader
        title="Operations Overview"
        description="Status across templates, bindings, ingestion, and audit trails."
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/audit">
                <Activity aria-hidden />
                <span>Audit log</span>
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/inbox/create">
                <Plug aria-hidden />
                <span>Bind group</span>
              </Link>
            </Button>
          </>
        }
      />

      <section
        aria-label="Key metrics"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <MetricCard
          label="Templates"
          value={templates.length}
          hint="Published and draft versions"
          icon={Sparkles}
        />
        <MetricCard
          label="Active bindings"
          value={activeBindings}
          hint={`${bindings.length} bindings total`}
          icon={Layers}
          delta={
            provisioningBindings > 0
              ? { value: `${provisioningBindings} provisioning`, trend: "neutral" }
              : undefined
          }
        />
        <MetricCard
          label="Messages"
          value={messages.length}
          hint="Persisted inbound events"
          icon={MessageCircle}
        />
        <MetricCard
          label="Knowledge docs"
          value={commonDocs.length}
          hint="Admin-managed common docs"
          icon={BookOpen}
        />
      </section>

      <section
        aria-label="Secondary metrics"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        <MetricCard
          label="Audit events"
          value={auditEvents.length}
          hint="Append-only trail"
          icon={ShieldCheck}
        />
        <MetricCard
          label="Provisioning"
          value={provisioningBindings}
          hint="Pending activation"
          icon={CircleDot}
        />
      </section>

      <section
        aria-label="Operations detail"
        className="grid grid-cols-1 gap-6 lg:grid-cols-3"
      >
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <CardTitle>Recent bindings</CardTitle>
              <CardDescription>
                Latest template rollouts and group provisioning activity.
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/inbox?filter=bound">
                <span>View all</span>
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="pb-6 pt-0">
            {recentBindings.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                No bindings yet.
              </p>
            ) : (
              <ul className="-mx-6 divide-y divide-border">
                {recentBindings.map((binding) => (
                  <li
                    key={binding.id}
                    className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-muted/40"
                  >
                    <span
                      aria-hidden
                      className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
                    >
                      <Layers className="size-4" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/inbox/${encodeURIComponent(binding.providerGroupId)}/settings`}
                          className="truncate text-sm font-medium text-foreground hover:underline"
                        >
                          {binding.groupTitle}
                        </Link>
                        <Badge variant="outline" className="font-normal">
                          {binding.runtimeMode}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        Updated {formatDateTime(binding.updatedAt)}
                      </p>
                    </div>
                    <StatusBadge status={binding.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System health</CardTitle>
            <CardDescription>
              Live signal across the core pipelines.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 pb-6 pt-2">
            {healthItems.map((item, index) => (
              <div key={item.label} className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-hidden
                      className={
                        item.status === "ok"
                          ? "size-2 rounded-full bg-[color:var(--success-500)]"
                          : item.status === "warn"
                            ? "size-2 rounded-full bg-[color:var(--warning-500)]"
                            : "size-2 rounded-full bg-[color:var(--danger-500)]"
                      }
                    />
                    <p className="text-sm font-medium text-foreground">
                      {item.label}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {item.detail}
                  </span>
                </div>
                {index < healthItems.length - 1 ? (
                  <Separator />
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section aria-label="Recent activity" className="grid grid-cols-1 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <CardTitle>Recent audit events</CardTitle>
              <CardDescription>
                Append-only operational trail across templates, bindings, and
                knowledge.
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/audit">
                <span>Full log</span>
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="pb-6 pt-0">
            {recentAudit.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                No audit events recorded.
              </p>
            ) : (
              <ul className="-mx-6 divide-y divide-border">
                {recentAudit.map((event) => (
                  <li
                    key={event.id}
                    className="flex items-start gap-4 px-6 py-4"
                  >
                    <span
                      aria-hidden
                      className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
                    >
                      <Activity className="size-4" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <p className="truncate text-sm font-medium text-foreground">
                        {event.eventType}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {event.actor} &middot; {event.entityType}{" "}
                        <span className="font-mono">{event.entityId}</span>
                      </p>
                    </div>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <Notice title="MVP mode" tone="info">
        This dashboard requires the live backend. Runtime and control-plane
        updates flow through the backend event stream.
      </Notice>
    </div>
  );
}
