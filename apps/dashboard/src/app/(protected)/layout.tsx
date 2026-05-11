import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { RealtimeProvider } from "@/components/realtime/realtime-provider";
import { requireSession } from "@/lib/auth/session";

export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireSession();
  const realtimeBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

  return (
    <RealtimeProvider baseUrl={realtimeBaseUrl}>
      <AppShell session={session}>{children}</AppShell>
    </RealtimeProvider>
  );
}
