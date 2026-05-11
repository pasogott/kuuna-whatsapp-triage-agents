import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getSettings } from "../../config.js";
import {
  getCurrentUser,
  issueAccessToken,
  passwordPolicyViolations,
  resolveScopeForUser,
  verifyPassword,
} from "../../auth.js";
import { auth } from "../../better-auth.js";
import { account, users } from "../../db/schema.js";
import { createTRPCRouter, publicProcedure, sessionProcedure } from "../init.js";

const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const changePasswordInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(255),
});

export const authRouter = createTRPCRouter({
  login: publicProcedure.input(loginInput).mutation(async ({ ctx, input }) => {
    const normalizedEmail = input.email.toLowerCase();
    const [row] = await ctx.db
      .select({
        user: users,
        password: account.password,
      })
      .from(users)
      .innerJoin(account, eq(account.userId, users.id))
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    if (!row?.password || !(await verifyPassword({ password: input.password, hash: row.password }))) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid credentials" });
    }
    if (row.user.banned) {
      throw new TRPCError({ code: "FORBIDDEN", message: "inactive user" });
    }
    const scope = await resolveScopeForUser(ctx.db, row.user.id);
    return {
      access_token: issueAccessToken({
        userId: row.user.id,
        role: scope.role,
        groupScope: scope.groupScope,
      }),
      token_type: "bearer",
      expires_in: getSettings().AUTH_TOKEN_TTL_SECONDS,
      user: {
        id: row.user.id,
        email: row.user.email,
        must_change_password: row.user.mustChangePassword,
        role: scope.role,
        group_scope: scope.groupScope,
      },
    };
  }),

  me: sessionProcedure.query(async ({ ctx }) => {
    if (!ctx.auth) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "missing auth context" });
    }
    const user = await getCurrentUser(ctx.db, ctx.auth.userId);
    if (!user) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "inactive or missing user" });
    }
    const scope = await resolveScopeForUser(ctx.db, user.id);
    return {
      id: user.id,
      email: user.email,
      must_change_password: user.mustChangePassword,
      is_active: !user.banned,
      role: scope.role,
      group_scope: scope.groupScope,
    };
  }),

  changePassword: sessionProcedure.input(changePasswordInput).mutation(async ({ ctx, input }) => {
    if (!ctx.auth) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "missing auth context" });
    }
    const violations = passwordPolicyViolations(input.newPassword);
    if (violations.length > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `password policy violation: ${violations.join("; ")}`,
      });
    }

    try {
      await auth.api.changePassword({
        headers: ctx.headers,
        body: {
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
          revokeOtherSessions: true,
        },
      });
    } catch (error) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: error instanceof Error ? error.message : "invalid current password",
      });
    }

    const [user] = await ctx.db
      .update(users)
      .set({ mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, ctx.auth.userId))
      .returning();
    if (!user) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "inactive or missing user" });
    }

    const scope = await resolveScopeForUser(ctx.db, user.id);
    return {
      id: user.id,
      email: user.email,
      must_change_password: false,
      is_active: !user.banned,
      role: scope.role,
      group_scope: scope.groupScope,
    };
  }),
});
