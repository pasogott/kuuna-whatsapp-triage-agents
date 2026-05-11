import { createHash } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import {
  clientProfiles,
  embeddings,
  groupBindings,
  groupClientProfiles,
  groupMembers,
  knowledgeCommonDocs,
  knowledgeCustomerDocs,
  knowledgeClaims,
  knowledgeGroupDocs,
  knowledgePersonalDocs,
  knowledgeStatements,
  knowledgeVersions,
  mediaAssets,
  messages,
  messageVersions,
  retrievalChunks,
  templateVersions,
  transcripts,
} from "../../db/schema.js";
import type { DbLike } from "../../db/client.js";
import { enqueueKuunaJob } from "../../jobs/queues.js";
import { extractKnowledgeFilter, type KnowledgeFilter } from "../../jobs/retrieval.js";
import { createTRPCRouter, protectedProcedure, roleProcedure } from "../init.js";

const commonDocInput = z.object({
  docKey: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(255),
});

const groupDocInput = commonDocInput.extend({
  providerGroupId: z.string().trim().min(1).max(255),
});

const customerDocInput = groupDocInput.extend({
  customerKey: z.string().trim().min(1).max(255).optional(),
});

const personalDocInput = commonDocInput.extend({
  clientProfileId: z.string().uuid(),
});

const personNoteInput = z.object({
  providerGroupId: z.string().trim().min(1).max(255),
  providerUserId: z.string().trim().min(1).max(255),
  contentMarkdown: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: "Markdown cannot be empty",
  }),
});

const versionInput = z.object({
  scope: z.enum(["common", "group", "customer", "personal"]),
  docRefId: z.string().uuid(),
  contentMarkdown: z.string(),
});

const versionTargetInput = z.object({
  scope: z.enum(["common", "group", "customer", "personal"]),
  docRefId: z.string().uuid(),
  versionId: z.string().uuid(),
});

type GroupIngestStats = {
  providerGroupId: string;
  chunkCount: number;
  updatedAt: Date | null;
  hasPendingMedia: boolean;
  hasFailedMedia: boolean;
};

type PrivateKnowledgeDocKeyRow = {
  doc_key: string;
  title: string;
  scopes: Array<"group" | "customer" | "personal">;
  group_count: number;
  customer_count: number;
  personal_count: number;
  updated_at: string;
};

const noAgentKnowledgeFilter: KnowledgeFilter = {
  commonDocKeys: "none",
  groupDocKeys: "none",
  includeGroupKnowledge: false,
};

export const knowledgeRouter = createTRPCRouter({
  commonDocs: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(knowledgeCommonDocs)
      .orderBy(desc(knowledgeCommonDocs.updatedAt));
    return rows.map((doc) => ({
      id: doc.id,
      doc_key: doc.docKey,
      scope: "common" as const,
      provider_group_id: null,
      title: doc.title,
      created_at: doc.createdAt.toISOString(),
      updated_at: doc.updatedAt.toISOString(),
    }));
  }),

  ingestedCommonDocs: protectedProcedure.query(async () => {
    return [];
  }),

  ingestedGroupDocs: protectedProcedure
    .input(z.object({ providerGroupId: z.string().optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const statsByGroup = await collectIngestStats(ctx.db);
      const eligible = Array.from(statsByGroup.values())
        .filter((stats) => stats.chunkCount > 0 && stats.updatedAt)
        .filter((stats) => !input.providerGroupId || stats.providerGroupId === input.providerGroupId)
        .sort((left, right) => (right.updatedAt?.getTime() ?? 0) - (left.updatedAt?.getTime() ?? 0));

      return eligible.map((stats) => ({
        id: stats.providerGroupId,
        doc_key: "ingested-chat-history",
        scope: "group",
        provider_group_id: stats.providerGroupId,
        title: stats.providerGroupId,
        status: deriveIngestedStatus(stats),
        updated_at: stats.updatedAt?.toISOString(),
        updated_by: "ingest-pipeline",
        chunk_count: stats.chunkCount,
      }));
    }),

  groupExplorer: protectedProcedure
    .input(z.object({
      providerGroupId: z.string().trim().min(1).max(255),
      q: z.string().trim().max(255).optional(),
      scope: z.enum(["common", "group", "personal"]).optional(),
      sourceRole: z.enum(["client", "lawyer", "company_staff", "bot", "unknown"]).optional(),
      limit: z.number().int().min(1).max(200).default(100),
    }))
    .query(async ({ ctx, input }) => {
      const [binding] = await ctx.db
        .select({ templateVersion: templateVersions })
        .from(groupBindings)
        .innerJoin(templateVersions, eq(templateVersions.id, groupBindings.templateVersionId))
        .where(and(eq(groupBindings.providerGroupId, input.providerGroupId), eq(groupBindings.status, "active")))
        .limit(1);
      const agentKnowledgeFilter =
        binding && templateAllowsTool(binding.templateVersion.toolsConfig, "knowledge_search")
          ? extractKnowledgeFilter(binding.templateVersion.toolsConfig)
          : noAgentKnowledgeFilter;
      const [primary] = await ctx.db
        .select({
          clientProfileId: groupClientProfiles.clientProfileId,
          clientDisplayName: clientProfiles.displayName,
        })
        .from(groupClientProfiles)
        .leftJoin(clientProfiles, eq(clientProfiles.id, groupClientProfiles.clientProfileId))
        .where(and(eq(groupClientProfiles.providerGroupId, input.providerGroupId), eq(groupClientProfiles.isPrimary, true)))
        .limit(1);
      const query = input.q?.toLowerCase().trim() ?? "";
      const sourceRole = input.sourceRole === "unknown" ? null : input.sourceRole;

      const [commonDocs, groupDocs, personalDocs, statementRows, claimRows] = await Promise.all([
        (input.scope && input.scope !== "common") || agentKnowledgeFilter.commonDocKeys === "none"
          ? Promise.resolve([])
          : ctx.db.select().from(knowledgeCommonDocs).orderBy(desc(knowledgeCommonDocs.updatedAt)).limit(50),
        (input.scope && input.scope !== "group") || !agentKnowledgeFilter.includeGroupKnowledge || agentKnowledgeFilter.groupDocKeys === "none"
          ? Promise.resolve([])
          : ctx.db
              .select()
              .from(knowledgeGroupDocs)
              .where(eq(knowledgeGroupDocs.providerGroupId, input.providerGroupId))
              .orderBy(desc(knowledgeGroupDocs.updatedAt))
              .limit(50),
        !primary?.clientProfileId || (input.scope && input.scope !== "personal") || !agentKnowledgeFilter.includeGroupKnowledge || agentKnowledgeFilter.groupDocKeys === "none"
          ? Promise.resolve([])
          : ctx.db
              .select()
              .from(knowledgePersonalDocs)
              .where(eq(knowledgePersonalDocs.clientProfileId, primary.clientProfileId))
              .orderBy(desc(knowledgePersonalDocs.updatedAt))
              .limit(50),
        ctx.db
          .select()
          .from(knowledgeStatements)
          .where(and(
            eq(knowledgeStatements.providerGroupId, input.providerGroupId),
            input.scope ? eq(knowledgeStatements.scope, input.scope) : sql`true`,
            input.sourceRole ? (sourceRole ? eq(knowledgeStatements.speakerRole, sourceRole) : isNull(knowledgeStatements.speakerRole)) : sql`true`,
          ))
          .orderBy(desc(knowledgeStatements.occurredAt))
          .limit(input.limit),
        ctx.db
          .select({ claim: knowledgeClaims, statement: knowledgeStatements })
          .from(knowledgeClaims)
          .innerJoin(knowledgeStatements, eq(knowledgeStatements.id, knowledgeClaims.statementId))
          .where(and(
            eq(knowledgeClaims.providerGroupId, input.providerGroupId),
            input.scope ? eq(knowledgeClaims.scope, input.scope) : sql`true`,
            input.sourceRole ? (sourceRole ? eq(knowledgeStatements.speakerRole, sourceRole) : isNull(knowledgeStatements.speakerRole)) : sql`true`,
          ))
          .orderBy(desc(knowledgeClaims.updatedAt))
          .limit(input.limit),
      ]);

      const documents = input.sourceRole ? [] : [
        ...commonDocs
          .filter((doc) => knowledgeDocKeyAllowed(agentKnowledgeFilter.commonDocKeys, doc.docKey))
          .map((doc) => ({
          id: doc.id,
          kind: "document" as const,
          scope: "common" as const,
          title: doc.title,
          text: doc.docKey,
          source_role: null,
          speaker_display_name: null,
          provider_message_id: null,
          source_message_id: null,
          client_profile_id: null,
          occurred_at: doc.updatedAt.toISOString(),
          updated_at: doc.updatedAt.toISOString(),
        })),
        ...groupDocs
          .filter((doc) => knowledgeDocKeyAllowed(agentKnowledgeFilter.groupDocKeys, doc.docKey))
          .map((doc) => ({
          id: doc.id,
          kind: "document" as const,
          scope: "group" as const,
          title: doc.title,
          text: doc.docKey,
          source_role: null,
          speaker_display_name: null,
          provider_message_id: null,
          source_message_id: null,
          client_profile_id: null,
          occurred_at: doc.updatedAt.toISOString(),
          updated_at: doc.updatedAt.toISOString(),
        })),
        ...personalDocs
          .filter((doc) => knowledgeDocKeyAllowed(agentKnowledgeFilter.groupDocKeys, doc.docKey))
          .map((doc) => ({
          id: doc.id,
          kind: "document" as const,
          scope: "personal" as const,
          title: doc.title,
          text: doc.docKey,
          source_role: null,
          speaker_display_name: primary?.clientDisplayName ?? null,
          provider_message_id: null,
          source_message_id: null,
          client_profile_id: doc.clientProfileId,
          occurred_at: doc.updatedAt.toISOString(),
          updated_at: doc.updatedAt.toISOString(),
        })),
      ];
      const statements = statementRows.map((statement) => ({
        id: statement.id,
        kind: "statement" as const,
        scope: normalizeExplorerScope(statement.scope),
        title: sourceTitle(statement.attributionLabel, statement.speakerDisplayName),
        text: statement.statementText,
        source_role: statement.speakerRole,
        speaker_display_name: statement.speakerDisplayName,
        provider_message_id: statement.providerMessageId,
        source_message_id: statement.sourceMessageId,
        client_profile_id: statement.clientProfileId,
        occurred_at: statement.occurredAt.toISOString(),
        updated_at: statement.updatedAt.toISOString(),
      }));
      const claims = claimRows.map(({ claim, statement }) => ({
        id: claim.id,
        kind: "claim" as const,
        scope: normalizeExplorerScope(claim.scope),
        title: `${humanClaimKind(claim.claimKind)} from ${sourceTitle(claim.attributionLabel, statement.speakerDisplayName)}`,
        text: claim.claimText,
        source_role: statement.speakerRole,
        speaker_display_name: statement.speakerDisplayName,
        provider_message_id: statement.providerMessageId,
        source_message_id: statement.sourceMessageId,
        client_profile_id: claim.clientProfileId,
        occurred_at: statement.occurredAt.toISOString(),
        updated_at: claim.updatedAt.toISOString(),
      }));
      const items = [...documents, ...statements, ...claims]
        .filter((item) => explorerItemAllowedByAgentKnowledge(item, agentKnowledgeFilter))
        .filter((item) => !query || `${item.title} ${item.text} ${item.speaker_display_name ?? ""}`.toLowerCase().includes(query))
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, input.limit);

      return {
        provider_group_id: input.providerGroupId,
        primary_client_profile_id: primary?.clientProfileId ?? null,
        primary_client_display_name: primary?.clientDisplayName ?? null,
        items,
      };
    }),

  createCommonDoc: roleProcedure("owner", "admin").input(commonDocInput).mutation(async ({ ctx, input }) => {
    const [existing] = await ctx.db
      .select({ id: knowledgeCommonDocs.id })
      .from(knowledgeCommonDocs)
      .where(eq(knowledgeCommonDocs.docKey, input.docKey))
      .limit(1);
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: "common knowledge doc already exists" });
    }
    const [doc] = await ctx.db
      .insert(knowledgeCommonDocs)
      .values({ docKey: input.docKey, title: input.title })
      .returning();
    return doc;
  }),

  groupDocs: protectedProcedure
    .input(z.object({ providerGroupId: z.string().optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(knowledgeGroupDocs)
        .where(input.providerGroupId ? eq(knowledgeGroupDocs.providerGroupId, input.providerGroupId) : undefined)
        .orderBy(desc(knowledgeGroupDocs.updatedAt));
      return rows.map((doc) => ({
        id: doc.id,
        doc_key: doc.docKey,
        scope: "group" as const,
        provider_group_id: doc.providerGroupId,
        title: doc.title,
        created_at: doc.createdAt.toISOString(),
        updated_at: doc.updatedAt.toISOString(),
      }));
    }),

  createGroupDoc: roleProcedure("owner", "admin").input(groupDocInput).mutation(async ({ ctx, input }) => {
    const [existing] = await ctx.db
      .select({ id: knowledgeGroupDocs.id })
      .from(knowledgeGroupDocs)
      .where(
        and(
          eq(knowledgeGroupDocs.providerGroupId, input.providerGroupId),
          eq(knowledgeGroupDocs.docKey, input.docKey),
        ),
      )
      .limit(1);
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: "group knowledge doc already exists" });
    }
    const [doc] = await ctx.db
      .insert(knowledgeGroupDocs)
      .values({ providerGroupId: input.providerGroupId, docKey: input.docKey, title: input.title })
      .returning();
    return doc;
  }),

  upsertPersonNote: roleProcedure("owner", "admin").input(personNoteInput).mutation(async ({ ctx, input }) => {
    const [member] = await ctx.db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.providerGroupId, input.providerGroupId),
          eq(groupMembers.providerUserId, input.providerUserId),
        ),
      )
      .limit(1);
    if (!member) {
      throw new TRPCError({ code: "NOT_FOUND", message: "group member not found" });
    }

    const docKey = personNoteDocKey(input.providerUserId);
    const title = `Person note: ${personNoteDisplayName(member)}`;
    const now = new Date();
    const result = await ctx.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(knowledgeGroupDocs)
        .where(
          and(
            eq(knowledgeGroupDocs.providerGroupId, input.providerGroupId),
            eq(knowledgeGroupDocs.docKey, docKey),
          ),
        )
        .limit(1);

      const doc = existing
        ? (await tx
            .update(knowledgeGroupDocs)
            .set({ title, updatedAt: now })
            .where(eq(knowledgeGroupDocs.id, existing.id))
            .returning())[0]
        : (await tx
            .insert(knowledgeGroupDocs)
            .values({
              providerGroupId: input.providerGroupId,
              docKey,
              title,
            })
            .returning())[0];
      if (!doc) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "person note document write failed" });
      }

      const [latest] = await tx
        .select({ value: sql<number>`coalesce(max(${knowledgeVersions.versionNo}), 0)` })
        .from(knowledgeVersions)
        .where(and(eq(knowledgeVersions.scope, "group"), eq(knowledgeVersions.docRefId, doc.id)));
      const superseded = await tx
        .select({ id: knowledgeVersions.id })
        .from(knowledgeVersions)
        .where(
          and(
            eq(knowledgeVersions.scope, "group"),
            eq(knowledgeVersions.docRefId, doc.id),
            inArray(knowledgeVersions.status, ["published", "ready"]),
          ),
        );
      const supersededVersionIds = superseded.map((version) => version.id);
      if (supersededVersionIds.length) {
        await tx
          .update(knowledgeVersions)
          .set({ status: "archived", updatedAt: now })
          .where(inArray(knowledgeVersions.id, supersededVersionIds));
        await tx
          .delete(embeddings)
          .where(inArray(embeddings.sourceVersionId, supersededVersionIds));
        await tx
          .delete(retrievalChunks)
          .where(
            and(
              eq(retrievalChunks.sourceType, "knowledge_version"),
              inArray(retrievalChunks.sourceId, supersededVersionIds),
            ),
          );
      }
      const [version] = await tx
        .insert(knowledgeVersions)
        .values({
          scope: "group",
          docRefId: doc.id,
          versionNo: Number(latest?.value ?? 0) + 1,
          status: "published",
          contentMarkdown: input.contentMarkdown,
        })
        .returning();
      if (!version) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "person note version write failed" });
      }
      return { doc, version };
    });

    await enqueueKuunaJob(
      "knowledge_indexing",
      { knowledge_version_id: result.version.id },
      `knowledge_indexing_${jobToken(result.version.id)}`,
    );
    return {
      doc_id: result.doc.id,
      doc_key: result.doc.docKey,
      version_id: result.version.id,
      version_no: result.version.versionNo,
    };
  }),

  customerDocs: protectedProcedure
    .input(z.object({ providerGroupId: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(knowledgeCustomerDocs)
        .where(eq(knowledgeCustomerDocs.providerGroupId, input.providerGroupId))
        .orderBy(desc(knowledgeCustomerDocs.updatedAt));
      return rows.map((doc) => ({
        id: doc.id,
        doc_key: doc.docKey,
        scope: "customer" as const,
        provider_group_id: doc.providerGroupId,
        customer_key: doc.customerKey,
        title: doc.title,
        created_at: doc.createdAt.toISOString(),
        updated_at: doc.updatedAt.toISOString(),
      }));
    }),

  createCustomerDoc: roleProcedure("owner", "admin").input(customerDocInput).mutation(async ({ ctx, input }) => {
    const customerKey = input.customerKey?.trim() || input.providerGroupId;
    const [existing] = await ctx.db
      .select({ id: knowledgeCustomerDocs.id })
      .from(knowledgeCustomerDocs)
      .where(
        and(
          eq(knowledgeCustomerDocs.customerKey, customerKey),
          eq(knowledgeCustomerDocs.docKey, input.docKey),
        ),
      )
      .limit(1);
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: "customer knowledge doc already exists" });
    }
    const [doc] = await ctx.db
      .insert(knowledgeCustomerDocs)
      .values({
        providerGroupId: input.providerGroupId,
        customerKey,
        docKey: input.docKey,
        title: input.title,
      })
      .returning();
    return doc;
  }),

  personalDocs: protectedProcedure
    .input(z.object({ clientProfileId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(knowledgePersonalDocs)
        .where(eq(knowledgePersonalDocs.clientProfileId, input.clientProfileId))
        .orderBy(desc(knowledgePersonalDocs.updatedAt));
      return rows.map((doc) => ({
        id: doc.id,
        doc_key: doc.docKey,
        scope: "personal" as const,
        provider_group_id: null,
        client_profile_id: doc.clientProfileId,
        title: doc.title,
        created_at: doc.createdAt.toISOString(),
        updated_at: doc.updatedAt.toISOString(),
      }));
    }),

  createPersonalDoc: roleProcedure("owner", "admin").input(personalDocInput).mutation(async ({ ctx, input }) => {
    const [existing] = await ctx.db
      .select({ id: knowledgePersonalDocs.id })
      .from(knowledgePersonalDocs)
      .where(
        and(
          eq(knowledgePersonalDocs.clientProfileId, input.clientProfileId),
          eq(knowledgePersonalDocs.docKey, input.docKey),
        ),
      )
      .limit(1);
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: "personal knowledge doc already exists" });
    }
    const [doc] = await ctx.db
      .insert(knowledgePersonalDocs)
      .values({
        clientProfileId: input.clientProfileId,
        docKey: input.docKey,
        title: input.title,
      })
      .returning();
    return doc;
  }),

  privateDocKeys: protectedProcedure.query(async ({ ctx }) => {
    const [groupDocs, customerDocs, personalDocs] = await Promise.all([
      ctx.db.select().from(knowledgeGroupDocs),
      ctx.db.select().from(knowledgeCustomerDocs),
      ctx.db.select().from(knowledgePersonalDocs),
    ]);
    const byDocKey = new Map<string, {
      docKey: string;
      title: string;
      scopes: Set<"group" | "customer" | "personal">;
      groupCount: number;
      customerCount: number;
      personalCount: number;
      updatedAt: Date;
    }>();

    function addDoc(input: {
      docKey: string;
      title: string;
      scope: "group" | "customer" | "personal";
      updatedAt: Date;
    }) {
      const existing = byDocKey.get(input.docKey);
      if (!existing) {
        byDocKey.set(input.docKey, {
          docKey: input.docKey,
          title: input.title,
          scopes: new Set([input.scope]),
          groupCount: input.scope === "group" ? 1 : 0,
          customerCount: input.scope === "customer" ? 1 : 0,
          personalCount: input.scope === "personal" ? 1 : 0,
          updatedAt: input.updatedAt,
        });
        return;
      }

      existing.scopes.add(input.scope);
      if (input.scope === "group") existing.groupCount += 1;
      if (input.scope === "customer") existing.customerCount += 1;
      if (input.scope === "personal") existing.personalCount += 1;
      if (input.updatedAt > existing.updatedAt) {
        existing.updatedAt = input.updatedAt;
        existing.title = input.title;
      }
    }

    for (const doc of groupDocs) {
      addDoc({
        docKey: doc.docKey,
        title: doc.title,
        scope: "group",
        updatedAt: doc.updatedAt,
      });
    }
    for (const doc of customerDocs) {
      addDoc({
        docKey: doc.docKey,
        title: doc.title,
        scope: "customer",
        updatedAt: doc.updatedAt,
      });
    }
    for (const doc of personalDocs) {
      addDoc({
        docKey: doc.docKey,
        title: doc.title,
        scope: "personal",
        updatedAt: doc.updatedAt,
      });
    }

    return Array.from(byDocKey.values())
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .map((entry): PrivateKnowledgeDocKeyRow => ({
        doc_key: entry.docKey,
        title: entry.title,
        scopes: Array.from(entry.scopes),
        group_count: entry.groupCount,
        customer_count: entry.customerCount,
        personal_count: entry.personalCount,
        updated_at: entry.updatedAt.toISOString(),
      }));
  }),

  versions: protectedProcedure
    .input(z.object({ docRefId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.docRefId, input.docRefId))
        .orderBy(desc(knowledgeVersions.versionNo));
      return rows.map((version) => ({
        id: version.id,
        scope: version.scope,
        doc_ref_id: version.docRefId,
        version_no: version.versionNo,
        status: version.status,
        content_markdown: version.contentMarkdown,
        created_at: version.createdAt.toISOString(),
        updated_at: version.updatedAt.toISOString(),
      }));
    }),

  createVersion: roleProcedure("owner", "admin").input(versionInput).mutation(async ({ ctx, input }) => {
    const doc = await findKnowledgeDoc(ctx.db, input.scope, input.docRefId);
    if (!doc) {
      throw new TRPCError({ code: "NOT_FOUND", message: "knowledge doc not found" });
    }
    const [latest] = await ctx.db
      .select({ value: sql<number>`coalesce(max(${knowledgeVersions.versionNo}), 0)` })
      .from(knowledgeVersions)
      .where(and(eq(knowledgeVersions.scope, input.scope), eq(knowledgeVersions.docRefId, input.docRefId)));
    const [version] = await ctx.db
      .insert(knowledgeVersions)
      .values({
        scope: input.scope,
        docRefId: input.docRefId,
        versionNo: Number(latest?.value ?? 0) + 1,
        status: "draft",
        contentMarkdown: input.contentMarkdown,
      })
      .returning();
    return version;
  }),

  publishVersion: roleProcedure("owner", "admin").input(versionTargetInput).mutation(async ({ ctx, input }) => {
    const [target] = await ctx.db
      .select()
      .from(knowledgeVersions)
      .where(
        and(
          eq(knowledgeVersions.id, input.versionId),
          eq(knowledgeVersions.scope, input.scope),
          eq(knowledgeVersions.docRefId, input.docRefId),
        ),
      )
      .limit(1);
    if (!target) {
      throw new TRPCError({ code: "NOT_FOUND", message: "knowledge version not found" });
    }
    if (target.status === "archived") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "archived knowledge versions must be restored via rollback",
      });
    }
    await ctx.db
      .update(knowledgeVersions)
      .set({ status: "archived", updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeVersions.scope, input.scope),
          eq(knowledgeVersions.docRefId, input.docRefId),
          eq(knowledgeVersions.status, "published"),
          ne(knowledgeVersions.id, input.versionId),
        ),
      );
    const [version] = await ctx.db
      .update(knowledgeVersions)
      .set({ status: "published", updatedAt: new Date() })
      .where(eq(knowledgeVersions.id, input.versionId))
      .returning();
    await enqueueKuunaJob("knowledge_indexing", { knowledge_version_id: input.versionId }, `knowledge_indexing_${jobToken(input.versionId)}`);
    return version;
  }),

  rollbackVersion: roleProcedure("owner", "admin").input(versionTargetInput).mutation(async ({ ctx, input }) => {
    const [target] = await ctx.db
      .select()
      .from(knowledgeVersions)
      .where(
        and(
          eq(knowledgeVersions.id, input.versionId),
          eq(knowledgeVersions.scope, input.scope),
          eq(knowledgeVersions.docRefId, input.docRefId),
        ),
      )
      .limit(1);
    if (!target) {
      throw new TRPCError({ code: "NOT_FOUND", message: "knowledge version not found" });
    }
    if (target.status !== "archived" && target.status !== "published") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "rollback target must be an archived or published knowledge version",
      });
    }
    await ctx.db
      .update(knowledgeVersions)
      .set({ status: "archived", updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeVersions.scope, input.scope),
          eq(knowledgeVersions.docRefId, input.docRefId),
          eq(knowledgeVersions.status, "published"),
          ne(knowledgeVersions.id, input.versionId),
        ),
      );
    const [version] = await ctx.db
      .update(knowledgeVersions)
      .set({ status: "published", updatedAt: new Date() })
      .where(eq(knowledgeVersions.id, input.versionId))
      .returning();
    await enqueueKuunaJob("knowledge_indexing", { knowledge_version_id: input.versionId }, `knowledge_indexing_${jobToken(input.versionId)}`);
    return version;
  }),
});

async function findKnowledgeDoc(
  database: DbLike,
  scope: "common" | "group" | "customer" | "personal",
  docRefId: string,
): Promise<{ id: string } | null> {
  if (scope === "common") {
    const [doc] = await database
      .select({ id: knowledgeCommonDocs.id })
      .from(knowledgeCommonDocs)
      .where(eq(knowledgeCommonDocs.id, docRefId))
      .limit(1);
    return doc ?? null;
  }
  if (scope === "group") {
    const [doc] = await database
      .select({ id: knowledgeGroupDocs.id })
      .from(knowledgeGroupDocs)
      .where(eq(knowledgeGroupDocs.id, docRefId))
      .limit(1);
    return doc ?? null;
  }
  if (scope === "customer") {
    const [doc] = await database
      .select({ id: knowledgeCustomerDocs.id })
      .from(knowledgeCustomerDocs)
      .where(eq(knowledgeCustomerDocs.id, docRefId))
      .limit(1);
    return doc ?? null;
  }
  const [doc] = await database
    .select({ id: knowledgePersonalDocs.id })
    .from(knowledgePersonalDocs)
    .where(eq(knowledgePersonalDocs.id, docRefId))
    .limit(1);
  return doc ?? null;
}

async function collectIngestStats(database: DbLike): Promise<Map<string, GroupIngestStats>> {
  const statsByGroup = new Map<string, GroupIngestStats>();

  const latestVersions = await database
    .select({
      providerGroupId: messages.providerGroupId,
      occurredAt: messageVersions.occurredAt,
      textContent: messageVersions.textContent,
    })
    .from(messages)
    .innerJoin(
      messageVersions,
      and(
        eq(messageVersions.messageId, messages.id),
        eq(messageVersions.versionNo, messages.latestVersionNo),
      ),
    )
    .where(eq(messageVersions.isDeleted, false));

  for (const row of latestVersions) {
    if (!row.textContent?.trim()) {
      continue;
    }
    const stats = getStats(statsByGroup, row.providerGroupId);
    stats.chunkCount += 1;
    stats.updatedAt = maxDate(stats.updatedAt, row.occurredAt);
  }

  const transcriptRows = await database
    .select({
      providerGroupId: messages.providerGroupId,
      messageUpdatedAt: messages.updatedAt,
      mediaUpdatedAt: mediaAssets.updatedAt,
      transcriptUpdatedAt: transcripts.updatedAt,
      textContent: transcripts.textContent,
    })
    .from(messages)
    .innerJoin(mediaAssets, eq(mediaAssets.messageId, messages.id))
    .innerJoin(transcripts, eq(transcripts.mediaAssetId, mediaAssets.id));

  for (const row of transcriptRows) {
    if (!row.textContent?.trim()) {
      continue;
    }
    const stats = getStats(statsByGroup, row.providerGroupId);
    stats.chunkCount += 1;
    stats.updatedAt = maxDate(
      stats.updatedAt,
      row.transcriptUpdatedAt ?? row.mediaUpdatedAt ?? row.messageUpdatedAt,
    );
  }

  const mediaRows = await database
    .select({
      providerGroupId: messages.providerGroupId,
      status: mediaAssets.status,
    })
    .from(messages)
    .innerJoin(mediaAssets, eq(mediaAssets.messageId, messages.id));

  for (const row of mediaRows) {
    const stats = getStats(statsByGroup, row.providerGroupId);
    if (row.status === "pending") {
      stats.hasPendingMedia = true;
    } else if (row.status === "failed") {
      stats.hasFailedMedia = true;
    }
  }

  return statsByGroup;
}

function getStats(statsByGroup: Map<string, GroupIngestStats>, providerGroupId: string): GroupIngestStats {
  const existing = statsByGroup.get(providerGroupId);
  if (existing) {
    return existing;
  }
  const created: GroupIngestStats = {
    providerGroupId,
    chunkCount: 0,
    updatedAt: null,
    hasPendingMedia: false,
    hasFailedMedia: false,
  };
  statsByGroup.set(providerGroupId, created);
  return created;
}

function deriveIngestedStatus(stats: GroupIngestStats): "processing" | "failed" | "ready" {
  if (stats.hasPendingMedia) {
    return "processing";
  }
  if (stats.hasFailedMedia) {
    return "failed";
  }
  return "ready";
}

function normalizeExplorerScope(scope: string): "common" | "group" | "personal" {
  return scope === "personal" ? "personal" : scope === "common" ? "common" : "group";
}

function sourceTitle(attributionLabel: string, speakerDisplayName: string | null): string {
  const speaker = speakerDisplayName?.trim();
  const label = humanAttributionLabel(attributionLabel);
  return speaker ? `${label} by ${speaker}` : label;
}

function humanAttributionLabel(value: string): string {
  if (value === "client_statement") return "Client statement";
  if (value === "lawyer_statement") return "Lawyer statement";
  if (value === "company_staff_statement") return "Company staff statement";
  if (value === "bot_statement") return "Bot statement";
  return "Participant statement";
}

function humanClaimKind(value: string): string {
  if (value === "profile_statement") return "Profile claim";
  if (value === "incident_or_evidence_statement") return "Incident or evidence claim";
  if (value === "case_statement") return "Case claim";
  return "Claim";
}

function templateAllowsTool(toolsConfig: unknown, toolKey: string): boolean {
  return extractAllowedTools(toolsConfig).includes(toolKey);
}

function extractAllowedTools(toolsConfig: unknown): string[] {
  const config = objectRecord(toolsConfig);
  const candidates: string[] = [];
  for (const key of ["allowed_tools", "allowedTools"]) {
    const value = config[key];
    if (Array.isArray(value)) {
      candidates.push(...value.filter((item): item is string => typeof item === "string"));
    }
  }
  const tools = config.tools;
  if (Array.isArray(tools)) {
    for (const item of tools) {
      if (typeof item === "string") {
        candidates.push(item);
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        if (typeof record.name === "string" && record.name && record.enabled !== false) {
          candidates.push(record.name);
        }
      }
    }
  }
  return uniqueLowerStrings(candidates);
}

function explorerItemAllowedByAgentKnowledge(
  item: { kind: "document" | "statement" | "claim"; scope: "common" | "group" | "personal"; text: string },
  filter: KnowledgeFilter,
): boolean {
  if (item.kind === "document") {
    if (item.scope === "common") {
      return knowledgeDocKeyAllowed(filter.commonDocKeys, item.text);
    }
    return filter.includeGroupKnowledge && knowledgeDocKeyAllowed(filter.groupDocKeys, item.text);
  }
  return item.scope !== "common" && filter.includeGroupKnowledge && filter.groupDocKeys !== "none";
}

function knowledgeDocKeyAllowed(allowed: KnowledgeFilter["commonDocKeys"], docKey: string | null): boolean {
  if (allowed === "*") return true;
  if (allowed === "none") return false;
  return Boolean(docKey && allowed.includes(docKey.trim().toLowerCase()));
}

function personNoteDocKey(providerUserId: string): string {
  const digest = createHash("sha256").update(providerUserId).digest("hex").slice(0, 16);
  return `person-note-${digest}`;
}

function personNoteDisplayName(member: typeof groupMembers.$inferSelect): string {
  return (
    member.displayName?.trim() ||
    member.pushName?.trim() ||
    member.phoneOverride?.trim() ||
    member.derivedPhone?.trim() ||
    member.providerUserId
  );
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uniqueLowerStrings(values: string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized && !output.includes(normalized)) {
      output.push(normalized);
    }
  }
  return output;
}

function maxDate(current: Date | null, candidate: Date | null): Date | null {
  if (!candidate) {
    return current;
  }
  if (!current || candidate.getTime() > current.getTime()) {
    return candidate;
  }
  return current;
}

function jobToken(value: string): string {
  return value.replaceAll("-", "_").replaceAll(" ", "_");
}
