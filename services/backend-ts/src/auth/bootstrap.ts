import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";

import { getSettings } from "../config.js";
import type { Database } from "../db/client.js";
import { account, users } from "../db/schema.js";

export async function ensureRequiredAdmin(database: Database): Promise<void> {
  const settings = getSettings();
  const email = settings.REQUIRED_ADMIN_EMAIL.toLowerCase();
  const now = new Date();

  const [existing] = await database.select().from(users).where(eq(users.email, email)).limit(1);
  if (!existing) {
    const password = await hashPassword(settings.DASHBOARD_REQUIRED_ADMIN_PASSWORD);
    const [created] = await database
      .insert(users)
      .values({
        email,
        emailVerified: true,
        name: email,
        role: "admin",
        banned: false,
        banReason: null,
        banExpires: null,
        mustChangePassword: true,
      })
      .returning();
    if (!created) return;
    await database.insert(account).values({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password,
    });
    return;
  }

  await database
    .update(users)
    .set({
      role: "admin",
      banned: false,
      banReason: null,
      banExpires: null,
      emailVerified: true,
      updatedAt: now,
    })
    .where(eq(users.id, existing.id));

  const resetPassword =
    settings.DASHBOARD_DEV_RESET_BOOTSTRAP_ADMIN_PASSWORD &&
    process.env.NODE_ENV !== "production" &&
    settings.APP_ENV !== "prod";
  const [existingAccount] = await database
    .select({ id: account.id })
    .from(account)
    .where(eq(account.userId, existing.id))
    .limit(1);
  if (!existingAccount || resetPassword) {
    const password = await hashPassword(settings.DASHBOARD_REQUIRED_ADMIN_PASSWORD);
    await database
      .insert(account)
      .values({
        userId: existing.id,
        providerId: "credential",
        accountId: existing.id,
        password,
      })
      .onConflictDoUpdate({
        target: [account.providerId, account.accountId],
        set: { password, updatedAt: now },
      });
  }
}
