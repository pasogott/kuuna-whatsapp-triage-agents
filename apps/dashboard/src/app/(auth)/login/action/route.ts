import { BACKEND_URL_CANDIDATES, bootstrapRequiredAdmin, DashboardAuthError } from "@/lib/backend/client";

function redirect303(path: string, request: Request, cookiesToSet: string[] = []) {
  const location = new URL(path, request.url);
  const headers = new Headers({
    Location: `${location.pathname}${location.search}`,
  });
  for (const cookie of cookiesToSet) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, {
    status: 303,
    headers,
  });
}

function getSetCookies(response: Response): string[] {
  const withGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] };
  return withGetSetCookie.getSetCookie?.() ?? [response.headers.get("set-cookie")].filter((value): value is string => Boolean(value));
}

function dashboardOrigin(): string {
  return process.env.DASHBOARD_ORIGIN ?? process.env.NEXT_PUBLIC_DASHBOARD_ORIGIN ?? "http://localhost:3000";
}

async function signIn(backendBaseUrl: string, email: string, password: string): Promise<Response> {
  return fetch(`${backendBaseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: dashboardOrigin() },
    body: JSON.stringify({ email, password }),
  });
}

async function readAuthError(response: Response): Promise<{ code: string; message: string }> {
  const body = await response.clone().json().catch(() => null) as { code?: unknown; message?: unknown } | null;
  return {
    code: typeof body?.code === "string" ? body.code : "",
    message: typeof body?.message === "string" ? body.message : "",
  };
}

export async function POST(request: Request): Promise<Response> {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const requiredAdminEmail = (process.env.REQUIRED_ADMIN_EMAIL ?? "admin@kuuna.ai").toLowerCase();

  if (!email || !password) {
    return redirect303("/login?error=missing", request);
  }

  try {
    await bootstrapRequiredAdmin();
    const backendBaseUrl = (BACKEND_URL_CANDIDATES[0] ?? "http://localhost:8000").replace(/\/$/, "");
    let response = await signIn(backendBaseUrl, email, password);
    if (!response.ok) {
      const error = await readAuthError(response);
      if (error.code === "BANNED_USER" && email === requiredAdminEmail) {
        await bootstrapRequiredAdmin();
        response = await signIn(backendBaseUrl, email, password);
      }
    }
    if (!response.ok) {
      const error = await readAuthError(response);
      const code = error.code === "BANNED_USER" ? "inactive" : "invalid";
      throw new DashboardAuthError(code, error.message || "invalid credentials");
    }

    const cookiesToSet = getSetCookies(response);
    return redirect303("/overview", request, cookiesToSet);
  } catch (error) {
    console.error("[dashboard-auth] login failed", error);
    const code = error instanceof DashboardAuthError ? error.code : "invalid";
    return redirect303(`/login?error=${encodeURIComponent(code)}`, request);
  }
}
