import { getSession } from "@/lib/auth/session";
import { createSessionBackendTrpcClient, dashboardAuthErrorFromUnknown } from "@/lib/backend/client";

function redirect303(path: string, request: Request) {
  const location = new URL(path, request.url);
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${location.pathname}${location.search}`,
    },
  });
}

function passwordChangeErrorRedirect(code: string, request: Request, reason?: string): Response {
  const params = new URLSearchParams({ error: code });
  const trimmedReason = reason?.replace(/^password policy violation:\s*/i, "").trim();
  if (trimmedReason) {
    params.set("reason", trimmedReason.slice(0, 240));
  }
  return redirect303(`/first-password-change?${params.toString()}`, request);
}

export async function POST(request: Request): Promise<Response> {
  const formData = await request.formData();
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const nextPassword = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!currentPassword) {
    return passwordChangeErrorRedirect("current-password", request);
  }

  if (nextPassword.length < 12) {
    return passwordChangeErrorRedirect("weak-password", request);
  }

  if (nextPassword !== confirmPassword) {
    return passwordChangeErrorRedirect("mismatch", request);
  }

  const session = await getSession();
  if (!session) {
    return redirect303("/login", request);
  }

  try {
    const client = await createSessionBackendTrpcClient();
    await client.auth.changePassword.mutate({
      currentPassword,
      newPassword: nextPassword,
    });

    return redirect303("/overview?passwordChanged=1", request);
  } catch (error) {
    console.error("[dashboard-auth] password change failed", error);
    const authError = dashboardAuthErrorFromUnknown(error);
    const code = authError?.code ?? "db";
    return passwordChangeErrorRedirect(code, request, authError?.message);
  }
}
