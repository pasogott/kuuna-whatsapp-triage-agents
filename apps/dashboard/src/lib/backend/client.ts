import "server-only";

import { createKuunaTrpcClient } from "@kuuna/api-client-ts";

import { currentCookieHeader, getSession, requireSession } from "@/lib/auth/session";

export const BACKEND_URL_CANDIDATES = [
  process.env.BACKEND_BASE_URL,
  process.env.NEXT_PUBLIC_API_BASE_URL,
  "http://backend:8000",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://host.docker.internal:8000",
]
  .filter((value): value is string => Boolean(value))
  .filter((value, index, self) => self.indexOf(value) === index);

export function getInternalOpsToken(): string | undefined {
  return process.env.DASHBOARD_INTERNAL_OPS_TOKEN ?? process.env.INTERNAL_OPS_TOKEN;
}

export function createBackendTrpcClient(token?: string, headers?: Record<string, string>) {
  const baseUrl = BACKEND_URL_CANDIDATES[0] ?? "http://backend:8000";
  return createKuunaTrpcClient({ baseUrl, token, headers });
}

export type DashboardAuthErrorCode =
  | "invalid"
  | "inactive"
  | "locked"
  | "current-password"
  | "weak-password"
  | "backend";

export class DashboardAuthError extends Error {
  constructor(
    readonly code: DashboardAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DashboardAuthError";
  }
}

export function createInternalBackendTrpcClient() {
  const internalToken = getInternalOpsToken();
  if (!internalToken) {
    throw new Error("missing internal ops token");
  }
  return createBackendTrpcClient(undefined, { "X-Internal-Token": internalToken });
}

export async function createSessionBackendTrpcClient() {
  await requireSession({ allowMustChangePassword: true });
  return createBackendTrpcClient(undefined, { Cookie: await currentCookieHeader() });
}

export async function getOptionalSessionBackendTrpcClient() {
  const session = await getSession();
  return session ? createBackendTrpcClient(undefined, { Cookie: await currentCookieHeader() }) : null;
}

export async function bootstrapRequiredAdmin(): Promise<void> {
  try {
    await createInternalBackendTrpcClient().internal.adminBootstrap.mutate();
  } catch (error) {
    console.warn("[dashboard-auth] admin bootstrap failed", error);
  }
}

export function dashboardAuthErrorFromUnknown(error: unknown): DashboardAuthError | null {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("invalid current password")) {
    return new DashboardAuthError("current-password", "invalid current password");
  }
  if (message.includes("password policy violation")) {
    return new DashboardAuthError("weak-password", errorMessage(error));
  }
  if (message.includes("invalid credentials")) {
    return new DashboardAuthError("invalid", "invalid credentials");
  }
  if (message.includes("inactive user")) {
    return new DashboardAuthError("inactive", "inactive user");
  }
  if (message.includes("user locked")) {
    return new DashboardAuthError("locked", "user locked");
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
