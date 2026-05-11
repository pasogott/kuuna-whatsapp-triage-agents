import { currentCookieHeader } from "@/lib/auth/session";
import { BACKEND_URL_CANDIDATES } from "@/lib/backend/client";

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

async function signOut(request: Request) {
  const backendBaseUrl = (BACKEND_URL_CANDIDATES[0] ?? "http://localhost:8000").replace(/\/$/, "");
  const response = await fetch(`${backendBaseUrl}/api/auth/sign-out`, {
    method: "POST",
    headers: { Cookie: await currentCookieHeader() },
  }).catch(() => null);
  return redirect303("/login?loggedOut=1", request, response ? getSetCookies(response) : []);
}

export async function POST(request: Request): Promise<Response> {
  return signOut(request);
}

export async function GET(request: Request): Promise<Response> {
  return signOut(request);
}
