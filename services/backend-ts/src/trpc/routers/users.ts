import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";

import { passwordPolicyViolations, type RoleName } from "../../auth.js";
import type { DbLike } from "../../db/client.js";
import { account, auditEvents, groupAssignments, session, users } from "../../db/schema.js";
import { getSettings } from "../../config.js";
import { createTRPCRouter, roleProcedure } from "../init.js";

const roleInput = z.enum(["owner", "admin", "operator", "viewer"]);

const userCreateInput = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(255),
  roles: z.array(roleInput).default(["viewer"]),
  groupScope: z.array(z.string().trim().min(1).max(255)).default([]),
  mustChangePassword: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

const userUpdateInput = z.object({
  userId: z.string().uuid(),
  isActive: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
});

const userIdInput = z.object({
  userId: z.string().uuid(),
});

function highestRole(roleNames: RoleName[]): RoleName {
  if (roleNames.includes("owner")) return "owner";
  if (roleNames.includes("admin")) return "admin";
  if (roleNames.includes("operator")) return "operator";
  return "viewer";
}

async function replaceAssignments(database: DbLike, userId: string, groupScope: string[]) {
  await database.delete(groupAssignments).where(eq(groupAssignments.userId, userId));
  for (const providerGroupId of Array.from(new Set(groupScope)).sort()) {
    await database.insert(groupAssignments).values({ userId, providerGroupId });
  }
}

function isRequiredAdminEmail(email: string): boolean {
  return email.toLowerCase() === getSettings().REQUIRED_ADMIN_EMAIL.toLowerCase();
}

function isPrivilegedRole(roleName: string): boolean {
  return roleName === "owner" || roleName === "admin";
}

async function activePrivilegedUserCount(database: DbLike, excludeUserId?: string): Promise<number> {
  const rows = await database.select({ id: users.id, role: users.role, banned: users.banned }).from(users);
  return rows.filter((row) => row.id !== excludeUserId && !row.banned && isPrivilegedRole(row.role)).length;
}

async function assertCanRemoveActiveAccess(
  database: DbLike,
  target: typeof users.$inferSelect,
  operation: "deactivate" | "delete",
): Promise<void> {
  if (isRequiredAdminEmail(target.email)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `cannot ${operation} required admin account`,
    });
  }
  if (target.banned || !isPrivilegedRole(target.role)) {
    return;
  }
  if ((await activePrivilegedUserCount(database, target.id)) < 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `cannot ${operation} last active privileged user`,
    });
  }
}

function formatUser(
  user: typeof users.$inferSelect,
  assignmentRows: Array<typeof groupAssignments.$inferSelect> = [],
) {
  return {
    id: user.id,
    email: user.email,
    must_change_password: user.mustChangePassword,
    is_active: !user.banned,
    roles: [user.role],
    group_scope: assignmentRows
      .filter((assignment) => assignment.userId === user.id)
      .map((assignment) => assignment.providerGroupId),
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  };
}

export const usersRouter = createTRPCRouter({
  list: roleProcedure("owner", "admin").query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(users).orderBy(users.email);
    const assignmentRows = await ctx.db.select().from(groupAssignments);
    return rows.map((user) => formatUser(user, assignmentRows));
  }),

  assignments: roleProcedure("owner", "admin").query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: groupAssignments.id,
        userId: groupAssignments.userId,
        email: users.email,
        providerGroupId: groupAssignments.providerGroupId,
        createdAt: groupAssignments.createdAt,
        updatedAt: groupAssignments.updatedAt,
      })
      .from(groupAssignments)
      .innerJoin(users, eq(groupAssignments.userId, users.id));

    return rows.map((row) => ({
      id: row.id,
      user_id: row.userId,
      user_email: row.email,
      provider_group_id: row.providerGroupId,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    }));
  }),

  create: roleProcedure("owner", "admin").input(userCreateInput).mutation(async ({ ctx, input }) => {
    if (!ctx.auth) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "missing auth context" });
    }
    const violations = passwordPolicyViolations(input.password);
    if (violations.length > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `password policy violation: ${violations.join("; ")}`,
      });
    }
    const normalizedEmail = input.email.toLowerCase();
    const [existing] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail));
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: "email already exists" });
    }

    const role = highestRole(input.roles);
    const password = await hashPassword(input.password);
    const [user] = await ctx.db
      .insert(users)
      .values({
        email: normalizedEmail,
        emailVerified: true,
        name: normalizedEmail,
        role,
        banned: !input.isActive,
        banReason: input.isActive ? null : "deactivated by admin",
        banExpires: null,
        mustChangePassword: input.mustChangePassword,
      })
      .returning();
    if (!user) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "user creation failed" });
    }
    await ctx.db.insert(account).values({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password,
    });
    await replaceAssignments(ctx.db, user.id, input.groupScope);
    await ctx.db.insert(auditEvents).values({
      actorUserId: ctx.auth.userId,
      eventType: "user.created",
      entityType: "user",
      entityId: user.id,
      payload: { email: user.email, roles: [role] },
    });
    return {
      ...formatUser(user),
      group_scope: input.groupScope,
    };
  }),

  update: roleProcedure("owner", "admin").input(userUpdateInput).mutation(async ({ ctx, input }) => {
    if (!ctx.auth) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "missing auth context" });
    }
    const [before] = await ctx.db.select().from(users).where(eq(users.id, input.userId)).limit(1);
    if (!before) {
      throw new TRPCError({ code: "NOT_FOUND", message: "user not found" });
    }
    if (input.isActive === false && !before.banned) {
      await assertCanRemoveActiveAccess(ctx.db, before, "deactivate");
    }
    const [user] = await ctx.db
      .update(users)
      .set({
        ...(input.isActive !== undefined
          ? {
              banned: !input.isActive,
              banReason: input.isActive ? null : "deactivated by admin",
              banExpires: null,
            }
          : {}),
        ...(input.mustChangePassword !== undefined ? { mustChangePassword: input.mustChangePassword } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.userId))
      .returning();
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "user not found" });
    }
    await ctx.db.insert(auditEvents).values({
      actorUserId: ctx.auth.userId,
      eventType: "user.updated",
      entityType: "user",
      entityId: user.id,
      payload: {
        before: {
          is_active: !before.banned,
          must_change_password: before.mustChangePassword,
        },
        after: {
          is_active: !user.banned,
          must_change_password: user.mustChangePassword,
        },
      },
    });
    return formatUser(user);
  }),

  delete: roleProcedure("owner", "admin").input(userIdInput).mutation(async ({ ctx, input }) => {
    if (!ctx.auth) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "missing auth context" });
    }
    if (ctx.auth.userId === input.userId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "cannot hard-delete current user" });
    }
    const [user] = await ctx.db.select().from(users).where(eq(users.id, input.userId)).limit(1);
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "user not found" });
    }
    await assertCanRemoveActiveAccess(ctx.db, user, "delete");

    await ctx.db.insert(auditEvents).values({
      actorUserId: ctx.auth.userId,
      eventType: "user.hard_deleted",
      entityType: "user",
      entityId: user.id,
      payload: { email: user.email },
    });
    await ctx.db.delete(groupAssignments).where(eq(groupAssignments.userId, user.id));
    await ctx.db.delete(session).where(eq(session.userId, user.id));
    await ctx.db.delete(account).where(eq(account.userId, user.id));
    await ctx.db.delete(users).where(eq(users.id, user.id));
    return { deleted: true };
  }),
});
