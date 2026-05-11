import "server-only";

import { createKuunaTrpcClient } from "@kuuna/api-client-ts";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  canRole,
  isAdminRole,
  type PermissionAction,
  type PermissionResource,
  type StaffRole,
} from "@/lib/permissions/matrix";

export type StaffSession = {
  userId: string;
  email: string;
  displayName: string;
  role: StaffRole;
  assignedGroupIds: string[];
  mustChangePassword: boolean;
  sessionExpiresAt: string;
};

type BackendSessionResponse = {
  session?: {
    expiresAt?: string | Date;
  };
  user?: {
    id?: string;
    email?: string;
    name?: string | null;
    role?: string | null;
    mustChangePassword?: boolean | null;
  };
} | null;

export async function getSession(): Promise<StaffSession | null> {
  const cookieHeader = await currentCookieHeader();
  if (!cookieHeader) return null;

  const baseUrl = process.env.BACKEND_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/auth/get-session`, {
    cache: "no-store",
    headers: { Cookie: cookieHeader },
  });
  if (!response.ok) return null;

  const data = (await response.json().catch(() => null)) as BackendSessionResponse;
  const user = data?.user;
  const expiresAt = data?.session?.expiresAt;
  if (!user?.id || !user.email || !expiresAt) return null;
  const client = createKuunaTrpcClient({
    baseUrl,
    headers: { Cookie: cookieHeader },
  });
  const appUser = await client.auth.me.query().catch(() => null);
  if (!appUser) return null;

  const sessionExpiresAt = new Date(expiresAt).toISOString();
  if (Date.parse(sessionExpiresAt) <= Date.now()) return null;

  return {
    userId: user.id,
    email: user.email,
    displayName: user.name || displayNameFromEmail(user.email),
    role: isStaffRole(appUser.role) ? appUser.role : "viewer",
    assignedGroupIds: appUser.group_scope,
    mustChangePassword: appUser.must_change_password,
    sessionExpiresAt,
  };
}

export async function currentCookieHeader(): Promise<string> {
  const headerStore = await headers();
  return headerStore.get("cookie") ?? "";
}

export async function requireSession(options?: {
  allowMustChangePassword?: boolean;
}): Promise<StaffSession> {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  if (session.mustChangePassword && !options?.allowMustChangePassword) {
    redirect("/first-password-change");
  }

  return session;
}

function isStaffRole(value: unknown): value is StaffRole {
  return value === "owner" || value === "admin" || value === "operator" || value === "viewer";
}

function displayNameFromEmail(email: string): string {
  const localPart = email.split("@")[0] ?? "staff";
  return localPart
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function hasPermission(
  session: StaffSession,
  resource: PermissionResource,
  action: PermissionAction,
): boolean {
  return canRole(session.role, resource, action);
}

export function canAccessGroup(session: StaffSession, groupId: string): boolean {
  if (isAdminRole(session.role)) {
    return true;
  }

  return session.assignedGroupIds.includes(groupId);
}

export function requirePermission(
  session: StaffSession,
  resource: PermissionResource,
  action: PermissionAction,
): void {
  if (!hasPermission(session, resource, action)) {
    redirect("/overview?error=forbidden");
  }
}
