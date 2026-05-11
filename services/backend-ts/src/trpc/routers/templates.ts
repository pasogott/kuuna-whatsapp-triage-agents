import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { groupBindings, groupTemplates, templateBuilds, templateVersions } from "../../db/schema.js";
import {
  formatTemplateBuild,
  queueTemplateBuild,
  TemplateBuildValidationError,
} from "../../jobs/template-build.js";
import { createTRPCRouter, protectedProcedure, roleProcedure } from "../init.js";
import { z } from "zod";

const createTemplateInput = z.object({
  key: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(255),
});

const createVersionInput = z.object({
  templateId: z.string().uuid(),
  systemPrompt: z.string().nullable().optional(),
  modelConfig: z.record(z.unknown()).default({}),
  toolsConfig: z.record(z.unknown()).default({}),
  egressPolicy: z.record(z.unknown()).default({}),
});

const versionTargetInput = z.object({
  templateId: z.string().uuid(),
  versionId: z.string().uuid(),
});

const queueBuildInput = z.object({
  templateId: z.string().uuid(),
  versionId: z.string().uuid(),
  actorUserId: z.string().uuid(),
  baseImage: z.string().trim().min(1),
  allowedTools: z.array(z.string()).nullable().optional(),
  dockerfileSnippet: z.string().nullable().optional(),
  piBashEnabled: z.boolean().nullable().optional(),
  piBashAllowlist: z.array(z.string()).nullable().optional(),
  gondolinProfile: z.string().nullable().optional(),
});

type TemplateVersionRow = typeof templateVersions.$inferSelect;

const disabledToolKeys = new Set(["context_lookup", "send_whatsapp"]);

function mapTemplateVersion(version: TemplateVersionRow) {
  return {
    id: version.id,
    template_id: version.templateId,
    version_no: version.versionNo,
    status: version.status,
    system_prompt: version.systemPrompt,
    model_settings: version.modelConfig,
    tools_config: version.toolsConfig,
    egress_policy: version.egressPolicy,
    created_at: version.createdAt.toISOString(),
    updated_at: version.updatedAt.toISOString(),
  };
}

function sanitizeToolsConfig(toolsConfig: Record<string, unknown>): Record<string, unknown> {
  const next = { ...toolsConfig };
  for (const key of ["allowed_tools", "allowedTools"]) {
    const value = next[key];
    if (Array.isArray(value)) {
      next[key] = value.filter(
        (item): item is string =>
          typeof item === "string" && !disabledToolKeys.has(item.trim().toLowerCase()),
      );
    }
  }
  const tools = next.tools;
  if (Array.isArray(tools)) {
    next.tools = tools.filter((item) => {
      if (typeof item === "string") {
        return !disabledToolKeys.has(item.trim().toLowerCase());
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const name = (item as Record<string, unknown>).name;
        return typeof name !== "string" || !disabledToolKeys.has(name.trim().toLowerCase());
      }
      return true;
    });
  }
  return next;
}

export const templatesRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(groupTemplates)
      .orderBy(groupTemplates.key)
      .then((rows) =>
        rows.map((template) => ({
          id: template.id,
          key: template.key,
          display_name: template.displayName,
          created_at: template.createdAt.toISOString(),
          updated_at: template.updatedAt.toISOString(),
        })),
      );
  }),

  byId: protectedProcedure.input(z.object({ templateId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const [template] = await ctx.db
      .select()
      .from(groupTemplates)
      .where(eq(groupTemplates.id, input.templateId))
      .limit(1);
    if (!template) {
      throw new TRPCError({ code: "NOT_FOUND", message: "template not found" });
    }
    return {
      id: template.id,
      key: template.key,
      display_name: template.displayName,
      created_at: template.createdAt.toISOString(),
      updated_at: template.updatedAt.toISOString(),
    };
  }),

  create: roleProcedure("owner", "admin").input(createTemplateInput).mutation(async ({ ctx, input }) => {
    const [existing] = await ctx.db
      .select({ id: groupTemplates.id })
      .from(groupTemplates)
      .where(eq(groupTemplates.key, input.key))
      .limit(1);
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: `template with key '${input.key}' already exists` });
    }

    const [template] = await ctx.db
      .insert(groupTemplates)
      .values({ key: input.key, displayName: input.displayName })
      .returning();

    if (!template) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "template creation failed" });
    }

    return {
      id: template.id,
      key: template.key,
      display_name: template.displayName,
      created_at: template.createdAt.toISOString(),
      updated_at: template.updatedAt.toISOString(),
    };
  }),

  versions: protectedProcedure
    .input(z.object({ templateId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(templateVersions)
        .where(eq(templateVersions.templateId, input.templateId))
        .orderBy(desc(templateVersions.versionNo));

      return rows.map(mapTemplateVersion);
    }),

  createVersion: roleProcedure("owner", "admin")
    .input(createVersionInput)
    .mutation(async ({ ctx, input }) => {
      const [template] = await ctx.db
        .select({ id: groupTemplates.id })
        .from(groupTemplates)
        .where(eq(groupTemplates.id, input.templateId))
        .limit(1);
      if (!template) {
        throw new TRPCError({ code: "NOT_FOUND", message: "template not found" });
      }

      const [latest] = await ctx.db
        .select({ value: sql<number>`coalesce(max(${templateVersions.versionNo}), 0)` })
        .from(templateVersions)
        .where(eq(templateVersions.templateId, input.templateId));
      const versionNo = Number(latest?.value ?? 0) + 1;

      const [version] = await ctx.db
        .insert(templateVersions)
        .values({
          templateId: input.templateId,
          versionNo,
          status: "draft",
          systemPrompt: input.systemPrompt ?? null,
          modelConfig: input.modelConfig,
          toolsConfig: sanitizeToolsConfig(input.toolsConfig),
          egressPolicy: input.egressPolicy,
        })
        .returning();
      if (!version) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "template version creation failed" });
      }
      return mapTemplateVersion(version);
    }),

  publishVersion: roleProcedure("owner", "admin")
    .input(versionTargetInput)
    .mutation(async ({ ctx, input }) => {
      const [target] = await ctx.db
        .select()
        .from(templateVersions)
        .where(and(eq(templateVersions.id, input.versionId), eq(templateVersions.templateId, input.templateId)))
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "template version not found" });
      }
      if (target.status === "archived") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "archived versions must be restored via rollback" });
      }

      await ctx.db
        .update(templateVersions)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(
            eq(templateVersions.templateId, input.templateId),
            eq(templateVersions.status, "published"),
            ne(templateVersions.id, input.versionId),
          ),
        );
      const [version] = await ctx.db
        .update(templateVersions)
        .set({ status: "published", updatedAt: new Date() })
        .where(eq(templateVersions.id, input.versionId))
        .returning();
      if (!version) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "template version publish failed" });
      }
      const bindingsToRetarget = await ctx.db
        .select({ id: groupBindings.id })
        .from(groupBindings)
        .innerJoin(templateVersions, eq(templateVersions.id, groupBindings.templateVersionId))
        .where(and(eq(templateVersions.templateId, input.templateId), eq(groupBindings.status, "active")));
      if (bindingsToRetarget.length > 0) {
        await ctx.db
          .update(groupBindings)
          .set({ templateVersionId: input.versionId, updatedAt: new Date() })
          .where(inArray(groupBindings.id, bindingsToRetarget.map((binding) => binding.id)));
      }
      return mapTemplateVersion(version);
    }),

  rollbackVersion: roleProcedure("owner", "admin")
    .input(versionTargetInput)
    .mutation(async ({ ctx, input }) => {
      const [target] = await ctx.db
        .select()
        .from(templateVersions)
        .where(and(eq(templateVersions.id, input.versionId), eq(templateVersions.templateId, input.templateId)))
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "template version not found" });
      }
      if (target.status !== "archived" && target.status !== "published") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "rollback target must be archived or published" });
      }
      await ctx.db
        .update(templateVersions)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(
            eq(templateVersions.templateId, input.templateId),
            eq(templateVersions.status, "published"),
            ne(templateVersions.id, input.versionId),
          ),
        );
      const [version] = await ctx.db
        .update(templateVersions)
        .set({ status: "published", updatedAt: new Date() })
        .where(eq(templateVersions.id, input.versionId))
        .returning();
      if (!version) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "template version rollback failed" });
      }
      const bindingsToRetarget = await ctx.db
        .select({ id: groupBindings.id })
        .from(groupBindings)
        .innerJoin(templateVersions, eq(templateVersions.id, groupBindings.templateVersionId))
        .where(and(eq(templateVersions.templateId, input.templateId), eq(groupBindings.status, "active")));
      if (bindingsToRetarget.length > 0) {
        await ctx.db
          .update(groupBindings)
          .set({ templateVersionId: input.versionId, updatedAt: new Date() })
          .where(inArray(groupBindings.id, bindingsToRetarget.map((binding) => binding.id)));
      }
      return mapTemplateVersion(version);
    }),

  builds: protectedProcedure
    .input(z.object({ templateId: z.string().uuid(), versionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(templateBuilds)
        .where(eq(templateBuilds.templateVersionId, input.versionId))
        .orderBy(desc(templateBuilds.createdAt));

      return rows
        .filter((build) => build.templateId === input.templateId)
        .map((build) => ({
          id: build.id,
          template_id: build.templateId,
          template_version_id: build.templateVersionId,
          status: build.status,
          image_ref: build.imageRef,
          image_tag: build.imageTag,
          build_inputs: build.buildInputs,
          logs_ref: build.logsRef,
          created_at: build.createdAt.toISOString(),
          updated_at: build.updatedAt.toISOString(),
        }));
    }),

  queueBuild: roleProcedure("owner", "admin")
    .input(queueBuildInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return formatTemplateBuild(await queueTemplateBuild(ctx.rootDb, {
          actorUserId: input.actorUserId,
          templateId: input.templateId,
          versionId: input.versionId,
          baseImage: input.baseImage,
          allowedTools: input.allowedTools ?? null,
          dockerfileSnippet: input.dockerfileSnippet ?? undefined,
          piBashEnabled: input.piBashEnabled ?? undefined,
          piBashAllowlist: input.piBashAllowlist ?? undefined,
          gondolinProfile: input.gondolinProfile ?? undefined,
        }, { enqueueJob: ctx.enqueueJob }));
      } catch (error) {
        if (error instanceof TemplateBuildValidationError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    }),
});
