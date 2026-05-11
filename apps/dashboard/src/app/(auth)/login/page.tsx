import { redirect } from "next/navigation";
import { AlertCircle, CheckCircle2 } from "lucide-react";

import { AuthShell } from "@/components/layout/auth-shell";
import { Button } from "@/components/ui/button";
import { FormActions, FormRow } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { getSession } from "@/lib/auth/session";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function getMessage(error: string | undefined): string | null {
  switch (error) {
    case "missing":
      return "Enter both email and password.";
    case "invalid":
      return "Invalid email or password.";
    case "inactive":
      return "This account is inactive. Ask an admin to reactivate it.";
    case "locked":
      return "This account is temporarily locked after failed sign-in attempts. Try again later or ask an admin.";
    case "backend":
      return "Could not reach the backend authentication service. Check the backend logs and configuration.";
    case "db":
      return "Database connection failed. Check dashboard DB configuration.";
    case "schema-missing":
      return "Database is reachable, but required tables are missing. Run backend migrations first.";
    case "reauth":
      return "Session format changed. Please sign in again.";
    default:
      return null;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await getSession();

  if (session && !session.mustChangePassword) {
    redirect("/overview");
  }

  if (session?.mustChangePassword) {
    redirect("/first-password-change");
  }

  const resolvedSearchParams = await searchParams;

  const error = Array.isArray(resolvedSearchParams.error)
    ? resolvedSearchParams.error[0]
    : resolvedSearchParams.error;
  const loggedOut = resolvedSearchParams.loggedOut === "1";
  const errorMessage = getMessage(error);

  return (
    <AuthShell
      title="Staff sign in"
      description="Use your staff account. New users must change their password at first sign-in."
    >
      {loggedOut ? (
        <div className="mb-5 flex items-start gap-2.5 rounded-md border border-[color:color-mix(in_oklab,var(--success-500)_28%,transparent)] bg-[color:var(--success-50)] px-3 py-2.5 text-sm text-[color:var(--success-700)]">
          <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>You have been signed out.</span>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mb-5 flex items-start gap-2.5 rounded-md border border-[color:color-mix(in_oklab,var(--danger-500)_30%,transparent)] bg-[color:var(--danger-50)] px-3 py-2.5 text-sm text-[color:var(--danger-700)]">
          <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <form action="/login/action" method="post" className="flex flex-col gap-4">
        <FormRow label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            name="email"
            placeholder="operator@kuuna.ai"
            required
            autoComplete="email"
          />
        </FormRow>

        <FormRow label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            name="password"
            placeholder="Minimum 8 characters"
            required
            minLength={8}
            autoComplete="current-password"
          />
        </FormRow>

        <FormActions className="flex-col items-stretch gap-2">
          <Button type="submit" className="w-full">
            Sign in
          </Button>
        </FormActions>
      </form>

    </AuthShell>
  );
}
