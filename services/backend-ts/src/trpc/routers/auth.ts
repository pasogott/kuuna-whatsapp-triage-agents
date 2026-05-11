import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  getCurrentUser,
  passwordPolicyViolations,
  resolveScopeForUser,
} from "../../auth.js";
import { auth } from "../../better-auth.js";
import { getSettings } from "../../config.js";
import { users } from "../../db/schema.js";
import { createTRPCRouter, sessionProcedure } from "../init.js";

const changePasswordInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(getSettings().AUTH_PASSWORD_MIN_LENGTH).max(255),
});

export const authRouter = createTRPCRouter({
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
    if (ctx.auth.sessionId === "legacy-bearer") {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "password changes require a Better Auth session" });
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
