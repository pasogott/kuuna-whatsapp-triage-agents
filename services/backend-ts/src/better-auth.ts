import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { adminAc, defaultAc } from "better-auth/plugins/admin/access";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";

import { getSettings } from "./config.js";
import { db } from "./db/client.js";
import * as schema from "./db/schema.js";

const settings = getSettings();

const configuredAuth = betterAuth({
  appName: "Kuuna Support Agents",
  baseURL: settings.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: settings.BETTER_AUTH_SECRET,
  trustedOrigins: [settings.DASHBOARD_ORIGIN, settings.BETTER_AUTH_URL],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    transaction: true,
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: settings.AUTH_PASSWORD_MIN_LENGTH,
    maxPasswordLength: 255,
  },
  user: {
    additionalFields: {
      mustChangePassword: {
        type: "boolean",
        fieldName: "must_change_password",
        defaultValue: true,
        required: true,
      },
    },
  },
  session: {
    expiresIn: settings.AUTH_TOKEN_TTL_SECONDS,
    updateAge: Math.min(60 * 60, settings.AUTH_TOKEN_TTL_SECONDS),
  },
  advanced: {
    database: {
      generateId: "uuid",
    },
    cookiePrefix: "kuuna",
  },
  plugins: [
    admin({
      defaultRole: "viewer",
      adminRoles: ["owner", "admin"],
      ac: defaultAc as never,
      roles: {
        owner: adminAc,
        admin: adminAc,
      },
      bannedUserMessage: "This account is inactive. Ask an admin to reactivate it.",
    }),
  ],
});

export const auth = configuredAuth as {
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: { id: string };
      session: { id: string; token: string; expiresAt: Date };
    } | null>;
    changePassword(input: {
      headers: Headers;
      body: { currentPassword: string; newPassword: string; revokeOtherSessions?: boolean };
    }): Promise<unknown>;
  };
  handler(request: Request): Promise<Response>;
  $Infer: unknown;
};

export type BetterAuthSession = unknown;
