import Link from "next/link";
import { notFound } from "next/navigation";

import { SimpleTable } from "@/components/data-table/simple-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FormActions, FormRow } from "@/components/ui/form";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SearchableKnowledgeSelector } from "@/components/templates/searchable-knowledge-selector";
import { TemplateBuildList } from "@/components/templates/template-build-list";
import { TemplateBuildAutoRefresh } from "@/components/templates/template-build-auto-refresh";
import { ToolSelector } from "@/components/templates/tool-selector";
import {
  getTemplate,
  listKnowledgeDocs,
  listPrivateKnowledgeDocKeys,
  listKnowledgeVersions,
  listTemplateBuilds,
  listTemplateVersions,
  listTools,
} from "@/lib/api-client";
import type { KnowledgeDoc, KnowledgeDocVersion, TemplateBuild } from "@/lib/api-client/types";
import { requireAuthorized } from "@/lib/auth/guards";
import { isAdminRole } from "@/lib/permissions/matrix";
import { saveTemplateVersionAction } from "@/lib/templates/actions";
import { PI_OPENAI_MODELS, isPiOpenAiModel } from "@/lib/templates/pi-models";
import { formatDateTime } from "@/lib/utils/format";

type Params = Promise<{ templateId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function getSingleParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function defaultModelChain(
  versions: Array<{ modelChain: string[] }>,
): string[] {
  const latestWithChain = versions.find(
    (version) => version.modelChain.length > 0,
  );
  if (!latestWithChain) {
    return ["gpt-5.5"];
  }
  return latestWithChain.modelChain;
}

function firstSupportedPiModel(modelChain: string[] | undefined): string | undefined {
  return modelChain?.find((model) => isPiOpenAiModel(model));
}

type KnowledgeDocKeyFilter = "*" | "none" | string[];

type TemplateKnowledgeConfig = {
  commonDocKeys: KnowledgeDocKeyFilter;
  groupDocKeys: KnowledgeDocKeyFilter;
  includeGroupKnowledge: boolean;
};

type KnowledgeDocOption = KnowledgeDoc & {
  latestVersion?: KnowledgeDocVersion;
  publishedVersion?: KnowledgeDocVersion;
};

const defaultKnowledgeConfig: TemplateKnowledgeConfig = {
  commonDocKeys: "*",
  groupDocKeys: "*",
  includeGroupKnowledge: true,
};

const defaultSystemPrompt = [
  "Du bist der Cyberheld WhatsApp-Beweissicherungsassistent in einer betreuten WhatsApp-Gruppe.",
  "Cyberheld ist ein österreichischer Anbieter für Unterstützung bei Hass im Netz, digitaler Gewalt und damit verbundener Beweissicherung.",
  "Du arbeitest für Cyberheld und das autorisierte Betreuungsteam dieser Gruppe.",
  "Du unterstützt Klient:innen, Anwält:innen und berechtigte Mitarbeiter:innen dabei, relevante Informationen zu strukturieren, Beweise nachvollziehbar zu sichern, Fragen zum Ablauf zu beantworten und nächste Schritte vorzubereiten.",
  "Du vertrittst keine Polizei, kein Gericht, keine Behörde und keine gegnerische Partei.",
  "Du gibst keine verbindliche Rechtsberatung und ersetzt keine anwaltliche, medizinische, therapeutische oder behördliche Stelle.",
  "Bei rechtlicher Bewertung, unklaren Sachverhalten, Risikoabwägungen oder sensiblen Entscheidungen erstellst du ein Todo für das zuständige Team oder verweist auf anwaltliche Prüfung.",
  "Du leitest Antworten nur aus den Template-Anweisungen, dem Runtime-Kontext dieser Gruppe, bereitgestelltem Knowledge-/RAG-Kontext, erlaubten Tools, der aktuellen Nutzernachricht und autorisierter Chat-Historie ab.",
  "Wenn eine Information nicht in diesen Quellen enthalten ist, sagst du das transparent oder erstellst ein Todo, statt zu raten.",
  "Antworte auf Deutsch, präzise, freundlich und mit klaren nächsten Schritten.",
].join("\n\n");

function systemPromptForForm(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "Antworte auf Deutsch, präzise, freundlich und mit klaren nächsten Schritten.") {
    return defaultSystemPrompt;
  }
  return trimmed;
}

function parseDocKeyFilter(value: unknown, fallback: KnowledgeDocKeyFilter): KnowledgeDocKeyFilter {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "*") return "*";
    if (normalized === "none") return "none";
    return normalized.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return fallback;
}

function parseKnowledgeConfig(value: string | undefined): TemplateKnowledgeConfig {
  if (!value) {
    return defaultKnowledgeConfig;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      commonDocKeys: parseDocKeyFilter(
        parsed.common_doc_keys ?? parsed.commonDocKeys,
        defaultKnowledgeConfig.commonDocKeys,
      ),
      groupDocKeys: parseDocKeyFilter(
        parsed.group_doc_keys ?? parsed.groupDocKeys,
        defaultKnowledgeConfig.groupDocKeys,
      ),
      includeGroupKnowledge:
        parsed.include_group_knowledge === false || parsed.includeGroupKnowledge === false
          ? false
          : true,
    };
  } catch {
    return defaultKnowledgeConfig;
  }
}

function filterMode(value: KnowledgeDocKeyFilter): "all" | "selected" | "none" {
  if (value === "*") return "all";
  if (value === "none") return "none";
  return "selected";
}

function selectedKeys(value: KnowledgeDocKeyFilter): Set<string> {
  return new Set(Array.isArray(value) ? value : []);
}

function formatKnowledgeFilter(value: KnowledgeDocKeyFilter): string {
  if (value === "*") return "all";
  if (value === "none") return "none";
  return value.length ? value.join(", ") : "none";
}

function formatKnowledgeProfile(value: string): string {
  const config = parseKnowledgeConfig(value);
  return [
    `company: ${formatKnowledgeFilter(config.commonDocKeys)}`,
    `bound private docs: ${config.includeGroupKnowledge ? formatKnowledgeFilter(config.groupDocKeys) : "none"}`,
  ].join(" · ");
}

function formatRuntimeImageProfile(
  runtimeImageConfig:
    | {
        dockerfileSnippet?: string;
        piBashEnabled: boolean;
        piBashAllowlist: string[];
        gondolinProfile?: string;
      }
    | undefined,
): string {
  const parts = [`Gondolin: ${runtimeImageConfig?.gondolinProfile ?? "base"}`];
  if (runtimeImageConfig?.dockerfileSnippet?.trim()) {
    parts.push("outer runtime setup");
  }
  if (runtimeImageConfig?.piBashEnabled) {
    parts.push(`bash: ${runtimeImageConfig.piBashAllowlist.length} allowlisted`);
  }
  return parts.join(" · ");
}

async function withKnowledgeVersionStatus(doc: KnowledgeDoc): Promise<KnowledgeDocOption> {
  const versions = await listKnowledgeVersions(doc.id);
  return {
    ...doc,
    latestVersion: versions[0],
    publishedVersion: versions.find((version) => version.status === "published"),
  };
}

export default async function TemplateDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const session = await requireAuthorized("templates", "read");
  const canManageTemplateBuilds = isAdminRole(session.role);

  const { templateId } = await params;
  const search = await searchParams;
  const created = getSingleParam(search.created);
  const saved = getSingleParam(search.saved);
  const versionId = getSingleParam(search.versionId);
  const error = getSingleParam(search.error);
  const buildId = getSingleParam(search.buildId);

  const [
    templateMaybe,
    versions,
    commonKnowledgeDocs,
    privateKnowledgeDocKeys,
    tools,
  ] = await Promise.all([
    getTemplate(templateId),
    listTemplateVersions(templateId),
    listKnowledgeDocs("common"),
    listPrivateKnowledgeDocKeys(),
    listTools(),
  ]);

  if (!templateMaybe) {
    notFound();
  }

  const template = templateMaybe;

  const activeVersion =
    versions.find((version) => version.status === "published") ?? versions[0];
  const systemPromptDefault = systemPromptForForm(activeVersion?.systemPrompt);
  const modelChainPrefill =
    firstSupportedPiModel(activeVersion?.modelChain) ??
    firstSupportedPiModel(defaultModelChain(versions)) ??
    "gpt-5.5";
  const allowedToolsPrefill = activeVersion?.allowedTools?.length
    ? activeVersion.allowedTools.filter(
        (tool) => tool !== "knowledge_search" && tool !== "chat_history_search",
      )
    : ["message_history", "media_analyze", "todo_create", "todo_update", "todo_list"];
  const knowledgeConfigPrefill = parseKnowledgeConfig(activeVersion?.knowledgeProfile);
  const commonKnowledgeModePrefill = filterMode(knowledgeConfigPrefill.commonDocKeys);
  const selectedCommonDocKeys = selectedKeys(knowledgeConfigPrefill.commonDocKeys);
  const groupKnowledgeModePrefill =
    knowledgeConfigPrefill.includeGroupKnowledge
      ? filterMode(knowledgeConfigPrefill.groupDocKeys)
      : "none";
  const selectedGroupDocKeys = Array.isArray(knowledgeConfigPrefill.groupDocKeys)
    ? knowledgeConfigPrefill.groupDocKeys
    : [];
  const includeChatHistorySearchPrefill =
    activeVersion?.allowedTools?.includes("chat_history_search") ?? true;
  const runtimeImageConfigPrefill = activeVersion?.runtimeImageConfig;
  const commonKnowledgeOptions = await Promise.all(
    commonKnowledgeDocs.map(withKnowledgeVersionStatus),
  );

  const publishedVersionIds = Array.from(
    new Set(
      versions.filter((version) => version.status === "published").map((version) => version.id),
    ),
  );

  const templateBuildsByVersionId: Record<string, TemplateBuild[]> = {};

  if (canManageTemplateBuilds && publishedVersionIds.length > 0) {
    const results = await Promise.all(
      publishedVersionIds.map(async (id) => {
        const items = await listTemplateBuilds(template.id, id);
        return { id, items };
      }),
    );

    for (const entry of results) {
      templateBuildsByVersionId[entry.id] = entry.items;
    }
  }

  const templateBuildRefreshActive = canManageTemplateBuilds
    ? Object.values(templateBuildsByVersionId).some((items) =>
        items.some((build) => build.status === "queued" || build.status === "running"),
      )
    : false;

  return (
    <div className="flex flex-col gap-8">
      {canManageTemplateBuilds ? (
        <TemplateBuildAutoRefresh active={templateBuildRefreshActive} />
      ) : null}

      <PageHeader
        title={template.displayName}
        description={`Template key: ${template.key}`}
        actions={
          <Button variant="outline" asChild>
            <Link href="/inbox/create">
              <span>Go to binding</span>
            </Link>
          </Button>
        }
      />

      {created === "1" ? (
        <Notice title="Template created" tone="success">
          Configure the template below and save it to build the runtime image.
        </Notice>
      ) : null}

      {saved === "1" ? (
        <Notice title="Template saved" tone="success">
          {versionId ? (
            <p>
              Active version:{" "}
              <code className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                {versionId}
              </code>
            </p>
          ) : null}
          {buildId ? (
            <p>
              Runtime image build:{" "}
              <code className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                {buildId}
              </code>
            </p>
          ) : null}
          <p>The build status updates automatically while the image is queued or running.</p>
        </Notice>
      ) : null}

      {error ? (
        <Notice title="Template workflow failed" tone="warning">
          {error}
        </Notice>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Configuration summary</CardTitle>
          <CardDescription>{template.description}</CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          <p className="text-sm text-muted-foreground">
            Active version ID:{" "}
            <code className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
              {template.publishedVersionId || "n/a"}
            </code>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Saving makes this configuration active and starts a runtime image build.
          </p>
        </CardContent>
      </Card>

      <Card>
        <div id="configuration" />
        <CardHeader>
          <CardTitle>Template configuration</CardTitle>
          <CardDescription>
            Save once to update the active template and start the Pi runtime image build.
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          <form
            action={saveTemplateVersionAction}
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="templateId" value={template.id} />

            <FormRow
              label="System prompt"
              htmlFor="systemPrompt"
              hint="Defines this template's role, target audience, tone and task. Platform isolation rules are appended by the runtime."
            >
              <Textarea
                id="systemPrompt"
                name="systemPrompt"
                defaultValue={systemPromptDefault}
                rows={12}
              />
            </FormRow>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormRow
                label="Model"
                htmlFor="modelChain"
                hint="Pi OpenAI model used by this template."
              >
                <Select
                  id="modelChain"
                  name="modelChain"
                  defaultValue={modelChainPrefill}
                >
                  {PI_OPENAI_MODELS.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} - {model.id}
                    </option>
                  ))}
                </Select>
              </FormRow>

              <ToolSelector
                tools={tools}
                defaultSelectedToolKeys={allowedToolsPrefill}
              />
            </div>

            <SearchableKnowledgeSelector
              companyDocs={commonKnowledgeOptions.map((doc) => ({
                id: doc.id,
                docKey: doc.docKey,
                title: doc.title,
                status:
                  doc.publishedVersion?.status ??
                  doc.latestVersion?.status ??
                  doc.status,
              }))}
              privateDocKeys={privateKnowledgeDocKeys}
              defaultCompanyMode={commonKnowledgeModePrefill}
              defaultCompanyDocKeys={Array.from(selectedCommonDocKeys)}
              defaultPrivateMode={groupKnowledgeModePrefill}
              defaultPrivateDocKeys={selectedGroupDocKeys}
              defaultIncludeChatHistorySearch={includeChatHistorySearchPrefill}
            />

            <div className="space-y-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-foreground">Pi runtime image</h3>
                <p className="text-xs text-muted-foreground">
                  Saved with this template version. The TS runner stays fixed; agent tools belong in the Gondolin guest profile.
                </p>
              </div>

              <FormRow
                label="Gondolin guest profile"
                htmlFor="gondolinProfile"
                hint="Selects the micro-VM image used for Pi read, write, edit, and bash tools."
              >
                <Select
                  id="gondolinProfile"
                  name="gondolinProfile"
                  defaultValue={runtimeImageConfigPrefill?.gondolinProfile ?? "base"}
                >
                  <option value="base">Base</option>
                  <option value="python">Python tools</option>
                  <option value="media">Media tools</option>
                </Select>
              </FormRow>

              <FormRow
                label="Outer runtime Dockerfile instructions"
                htmlFor="dockerfileSnippet"
                hint="Advanced runner-container setup only. Put Python, ffmpeg, and agent shell tools in the Gondolin guest profile instead."
              >
                <Textarea
                  id="dockerfileSnippet"
                  name="dockerfileSnippet"
                  defaultValue={runtimeImageConfigPrefill?.dockerfileSnippet ?? ""}
                  placeholder={"RUN apt-get update && apt-get install -y --no-install-recommends jq ffmpeg && rm -rf /var/lib/apt/lists/*"}
                  rows={4}
                />
              </FormRow>

              <div className="space-y-1">
                <h4 className="text-sm font-medium text-foreground">Runtime tools</h4>
                <p className="text-xs text-muted-foreground">
                  Template tools are selected above. Only enable bash when this runtime image needs allowlisted shell commands.
                </p>
              </div>

              <div className="flex items-start gap-2">
                <Checkbox
                  id="piBashEnabled"
                  name="piBashEnabled"
                  defaultChecked={runtimeImageConfigPrefill?.piBashEnabled ?? false}
                />
                <div className="space-y-1">
                  <label htmlFor="piBashEnabled" className="text-sm font-medium text-foreground">
                    Enable Pi bash exec
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Allows the agent to run allowlisted commands inside this runtime image.
                  </p>
                </div>
              </div>

              <FormRow
                label="Bash allowlist"
                htmlFor="piBashAllowlist"
                hint="Comma- or newline-separated command prefixes, for example jq, python, ffmpeg -i."
              >
                <Textarea
                  id="piBashAllowlist"
                  name="piBashAllowlist"
                  defaultValue={runtimeImageConfigPrefill?.piBashAllowlist.join("\n") ?? ""}
                  placeholder={"jq\npython\nffmpeg -i"}
                  rows={4}
                />
              </FormRow>
            </div>

            <FormActions>
              <Button type="submit">Save</Button>
            </FormActions>
          </form>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <div id="timeline" />
        <CardHeader>
          <CardTitle>Saved versions</CardTitle>
          <CardDescription>
            Configuration history for this template.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-4">
          <SimpleTable
            data={versions}
            emptyMessage="No versions yet."
            columns={[
              {
                header: "Version",
                cell: (version) => (
                  <Badge variant="outline">v{version.versionNo}</Badge>
                ),
              },
              {
                header: "Model failover",
                cell: (version) =>
                  version.modelChain.length ? (
                    <span className="font-mono text-xs text-foreground">
                      {version.modelChain.join(" → ")}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">n/a</span>
                  ),
              },
              {
                header: "Reasoning",
                cell: (version) => (
                  <span className="font-mono text-xs text-foreground">
                    {version.reasoningEffort}
                  </span>
                ),
              },
              {
                header: "Tool profile",
                cell: (version) => (
                  <span className="text-sm text-foreground">
                    {version.toolProfile || "default"}
                  </span>
                ),
              },
              {
                header: "Knowledge",
                cell: (version) => (
                  <span className="text-sm text-foreground">
                    {formatKnowledgeProfile(version.knowledgeProfile)}
                  </span>
                ),
              },
              {
                header: "Runtime image",
                cell: (version) => (
                  <span className="text-sm text-foreground">
                    {formatRuntimeImageProfile(version.runtimeImageConfig)}
                  </span>
                ),
              },
              {
                header: "Updated",
                cell: (version) => (
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(version.updatedAt)} by {version.updatedBy}
                  </span>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>

      {canManageTemplateBuilds ? (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Pi runtime image builds</CardTitle>
            <CardDescription>
              Docker image history for saved template versions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pb-6">
            {publishedVersionIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Save the template to start the first Pi runtime image build.
              </p>
            ) : (
              publishedVersionIds.map((publishedVersionId) => {
                const publishedVersion = versions.find((v) => v.id === publishedVersionId);
                const builds = templateBuildsByVersionId[publishedVersionId] ?? [];

                return (
                  <div key={publishedVersionId} className="space-y-3">
                    <div className="space-y-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          Version{" "}
                          <span className="font-mono text-xs">
                            v{publishedVersion?.versionNo ?? "?"}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Version-ID:{" "}
                          <code className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                            {publishedVersionId}
                          </code>
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatRuntimeImageProfile(publishedVersion?.runtimeImageConfig)}
                      </p>
                    </div>

                    <TemplateBuildList builds={builds} />
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
