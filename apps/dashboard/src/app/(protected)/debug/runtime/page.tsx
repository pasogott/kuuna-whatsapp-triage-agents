import { AutoRefresh } from "@/components/system/auto-refresh";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { getRuntimeDebugStatus } from "@/lib/api-client";
import { formatDateTime } from "@/lib/utils/format";

function StatRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      {mono ? (
        <code className="rounded-sm border border-border bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
          {value}
        </code>
      ) : (
        <span className="text-sm font-medium text-foreground">{value}</span>
      )}
    </div>
  );
}

export default async function RuntimeDebugPage() {
  const status = await getRuntimeDebugStatus();

  const healthTone =
    status.runtimeHealth === "ok" ? ("success" as const) : ("warning" as const);
  const healthTitle =
    status.runtimeHealth === "ok"
      ? "Runtime agent reachable"
      : status.runtimeHealth === "error"
        ? "Runtime agent responded with error"
        : "Runtime agent unreachable";

  return (
    <div className="flex flex-col gap-8">
      <AutoRefresh
        intervalMs={8000}
        eventTypes={[
          "runtime_container.updated",
          "agent_run.updated",
          "tool_invocation.created",
          "job.completed",
          "job.failed",
        ]}
      />
      <PageHeader
        title="Runtime debug"
        description="Quick health checks for the runtime agent, Pi model path, and utility OpenAI settings."
      />

      <Notice title={healthTitle} tone={healthTone}>
        <p>
          Health: <strong>{status.runtimeHealth}</strong>
        </p>
        {status.runtimeUrl ? (
          <p>
            Runtime URL:{" "}
            <code className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
              {status.runtimeUrl}
            </code>
          </p>
        ) : null}
        {status.error ? <p>Error: {status.error}</p> : null}
      </Notice>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>OpenAI utility wiring</CardTitle>
            <CardDescription>
              Embedding and audio transcription configuration.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pb-6">
            <StatRow
              label="Configured"
              value={
                status.openaiConfigured === null
                  ? "unknown"
                  : status.openaiConfigured
                    ? "yes"
                    : "no"
              }
            />
            <StatRow
              label="Base URL"
              value={status.openaiBaseUrl ?? "n/a"}
              mono
            />
            <StatRow
              label="Timeout (s)"
              value={status.openaiTimeoutSeconds ?? "n/a"}
              mono
            />
            <StatRow
              label="Default model"
              value={status.defaultModel ?? "gpt-5.5"}
              mono
            />
            <StatRow
              label="Reasoning effort"
              value={status.reasoningEffort ?? "medium"}
              mono
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Latest outbound model path</CardTitle>
            <CardDescription>
              Most recent model failover trace from the runtime.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pb-6">
            <StatRow
              label="Last model used"
              value={status.lastModelUsed ?? "n/a"}
            />
            <StatRow
              label="Model path"
              value={
                status.lastModelPath.length
                  ? status.lastModelPath.join(" → ")
                  : "n/a"
              }
              mono
            />
            <StatRow
              label="Last outbound intent"
              value={status.lastOutboundIntentId ?? "n/a"}
              mono
            />
            <StatRow
              label="Last outbound at"
              value={
                status.lastOutboundAt
                  ? formatDateTime(status.lastOutboundAt)
                  : "n/a"
              }
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
