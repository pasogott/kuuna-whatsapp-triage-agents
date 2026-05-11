import { eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword } from "better-auth/crypto";

import { auth } from "./better-auth.js";
import { getSettings } from "./config.js";
import type { DbLike } from "./db/client.js";
import { groupAssignments, users } from "./db/schema.js";

export type RoleName = "owner" | "admin" | "operator" | "viewer";

export type AuthContext = {
  userId: string;
  role: RoleName;
  groupScope: string[];
  sessionId: string;
  sessionToken: string;
  sessionExpiresAt: Date;
};

export type AuthContextOptions = {
  allowMustChangePassword?: boolean;
};

export function isRoleName(value: unknown): value is RoleName {
  return value === "owner" || value === "admin" || value === "operator" || value === "viewer";
}

export function requireRole(authContext: AuthContext, allowedRoles: RoleName[]): void {
  if (!allowedRoles.includes(authContext.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "insufficient role" });
  }
}

export function passwordPolicyViolations(password: string): string[] {
  const settings = getSettings();
  const violations: string[] = [];
  if (password.length < settings.AUTH_PASSWORD_MIN_LENGTH) {
    violations.push(`minimum length is ${settings.AUTH_PASSWORD_MIN_LENGTH}`);
  }
  if (password.toLowerCase() === password) violations.push("must include an uppercase letter");
  if (password.toUpperCase() === password) violations.push("must include a lowercase letter");
  if (![...password].some((char) => /\d/.test(char))) violations.push("must include a digit");
  if (![...password].some((char) => !/[A-Za-z0-9]/.test(char))) {
    violations.push("must include a symbol");
  }
  let runLength = 1;
  for (let index = 1; index < password.length; index += 1) {
    if (password[index] === password[index - 1]) {
      runLength += 1;
      if (runLength > settings.AUTH_PASSWORD_MAX_CONSECUTIVE) {
        violations.push(`must not repeat the same character more than ${settings.AUTH_PASSWORD_MAX_CONSECUTIVE} times`);
        break;
      }
    } else {
      runLength = 1;
    }
  }
  return violations;
}

export { hashPassword, verifyPassword };

export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

export function issueAccessToken(payload: {
  userId: string;
  role: RoleName;
  groupScope: string[];
  expiresAt?: Date;
}): string {
  const expiresAt = payload.expiresAt ?? new Date(Date.now() + getSettings().AUTH_TOKEN_TTL_SECONDS * 1000);
  const body = Buffer.from(
    JSON.stringify({
      sub: payload.userId,
      role: payload.role,
      group_scope: payload.groupScope,
      exp: Math.floor(expiresAt.getTime() / 1000),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", getSettings().BETTER_AUTH_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function decodeAccessToken(token: string): {
  userId: string;
  role: RoleName;
  groupScope: string[];
  expiresAt: Date;
} | null {
  try {
    const [body, signature] = token.split(".");
    if (!body || !signature) return null;
    const expected = createHmac("sha256", getSettings().BETTER_AUTH_SECRET).update(body).digest("base64url");
    if (!constantTimeEqual(signature, expected)) return null;
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      sub?: unknown;
      role?: unknown;
      group_scope?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.sub !== "string" || !isRoleName(parsed.role) || typeof parsed.exp !== "number") {
      return null;
    }
    const expiresAt = new Date(parsed.exp * 1000);
    if (expiresAt.getTime() <= Date.now()) return null;
    return {
      userId: parsed.sub,
      role: parsed.role,
      groupScope: Array.isArray(parsed.group_scope)
        ? parsed.group_scope.filter((value): value is string => typeof value === "string")
        : [],
      expiresAt,
    };
  } catch {
    return null;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function authContextFromHeaders(headers: Headers): Promise<AuthContext | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const scope = await resolveScopeForUserFromId(session.user.id);
  return {
    userId: session.user.id,
    role: scope.role,
    groupScope: scope.groupScope,
    sessionId: session.session.id,
    sessionToken: session.session.token,
    sessionExpiresAt: session.session.expiresAt,
  };
}

export async function requireCurrentAuthContext(
  database: DbLike,
  headers: Headers,
  options: AuthContextOptions = {},
): Promise<AuthContext> {
  const session = await auth.api.getSession({ headers });
  if (!session) {
    const bearer = decodeAccessToken(extractBearerToken(headers.get("authorization")) ?? "");
    if (!bearer) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "missing session" });
    }
    const user = await getCurrentUser(database, bearer.userId);
    if (!user || isUserBanned(user)) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "inactive or missing user" });
    }
    if (user.mustChangePassword && !options.allowMustChangePassword) {
      throw new TRPCError({ code: "FORBIDDEN", message: "password change required" });
    }
    const scope = await resolveScopeForUser(database, user.id);
    return {
      userId: user.id,
      role: scope.role,
      groupScope: scope.groupScope,
      sessionId: "legacy-bearer",
      sessionToken: "legacy-bearer",
      sessionExpiresAt: bearer.expiresAt,
    };
  }

  const user = await getCurrentUser(database, session.user.id);
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "inactive or missing user" });
  }
  if (isUserBanned(user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "inactive user" });
  }
  if (user.mustChangePassword && !options.allowMustChangePassword) {
    throw new TRPCError({ code: "FORBIDDEN", message: "password change required" });
  }

  const scope = await resolveScopeForUser(database, user.id);
  return {
    userId: user.id,
    role: scope.role,
    groupScope: scope.groupScope,
    sessionId: session.session.id,
    sessionToken: session.session.token,
    sessionExpiresAt: session.session.expiresAt,
  };
}

export async function resolveScopeForUser(
  database: DbLike,
  userId: string,
): Promise<{ role: RoleName; groupScope: string[] }> {
  const [user] = await database
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const assignments = await database
    .select({ providerGroupId: groupAssignments.providerGroupId })
    .from(groupAssignments)
    .where(eq(groupAssignments.userId, userId));

  return {
    role: isRoleName(user?.role) ? user.role : "viewer",
    groupScope: assignments.map((row) => row.providerGroupId),
  };
}

export async function getCurrentUser(database: DbLike, userId: string) {
  const [user] = await database.select().from(users).where(eq(users.id, userId)).limit(1);
  return user ?? null;
}

export async function listUserRoles(database: DbLike, userId: string): Promise<RoleName[]> {
  const scope = await resolveScopeForUser(database, userId);
  return [scope.role];
}

export async function filterAuthorizedGroups(
  authContext: AuthContext,
  providerGroupIds: string[],
): Promise<string[]> {
  if (authContext.role === "owner" || authContext.role === "admin") {
    return providerGroupIds;
  }
  const allowed = new Set(authContext.groupScope);
  return providerGroupIds.filter((providerGroupId) => allowed.has(providerGroupId));
}

export function groupScopeWhere(authContext: AuthContext, column: unknown) {
  if (authContext.role === "owner" || authContext.role === "admin") {
    return undefined;
  }
  if (authContext.groupScope.length === 0) {
    return inArray(column as never, ["__kuuna_no_authorized_group__"] as never[]);
  }
  return inArray(column as never, authContext.groupScope as never[]);
}

export function isUserBanned(user: typeof users.$inferSelect): boolean {
  if (!user.banned) return false;
  return !user.banExpires || user.banExpires.getTime() > Date.now();
}

async function resolveScopeForUserFromId(userId: string): Promise<{ role: RoleName; groupScope: string[] }> {
  const { db } = await import("./db/client.js");
  return resolveScopeForUser(db, userId);
}
