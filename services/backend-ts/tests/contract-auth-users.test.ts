import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { resetSettingsForTests } from "../src/config.js";
import { auditEvents, users } from "../src/db/schema.js";
import { contractDatabaseUrl, createContractHarness } from "./contract-harness.js";

const skipReason = contractDatabaseUrl
  ? false
  : "set BACKEND_TS_CONTRACT_DATABASE_URL to run backend-ts contract tests";

test("contract: auth login and me match expected shape", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  await harness.seedUser({
    email: "owner@example.com",
    password: "OwnerSecure123!",
    role: "owner",
  });

  const publicCaller = await harness.caller();
  const login = await publicCaller.auth.login({
    email: "owner@example.com",
    password: "OwnerSecure123!",
  });

  assert.equal(login.token_type, "bearer");
  assert.equal(login.user.email, "owner@example.com");
  assert.equal(login.user.role, "owner");
  assert.deepEqual(login.user.group_scope, []);

  const authedCaller = await harness.caller(login.access_token);
  const me = await authedCaller.auth.me();
  assert.equal(me.email, "owner@example.com");
  assert.equal(me.role, "owner");
  assert.deepEqual(me.group_scope, []);
});

test("contract: users create and hard delete append audit event", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const owner = await harness.seedUser({
    email: "owner@example.com",
    password: "OwnerSecure123!",
    role: "owner",
  });
  const publicCaller = await harness.caller();
  const login = await publicCaller.auth.login({
    email: "owner@example.com",
    password: "OwnerSecure123!",
  });

  const authedCaller = await harness.caller(login.access_token);
  const created = await authedCaller.users.create({
    email: "operator@example.com",
    password: "Operator123!!",
    roles: ["operator"],
    groupScope: ["group-a@g.us"],
    mustChangePassword: true,
    isActive: true,
  });

  assert.deepEqual(created.roles, ["operator"]);
  assert.deepEqual(created.group_scope, ["group-a@g.us"]);

  await authedCaller.users.delete({ userId: created.id });

  const [hardDeleteEvent] = await harness.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.eventType, "user.hard_deleted"))
    .limit(1);

  assert.ok(hardDeleteEvent);
  assert.equal(hardDeleteEvent.actorUserId, owner.id);
  assert.equal(hardDeleteEvent.entityId, created.id);
});

test("contract: protected procedures revalidate active state and current roles", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  const owner = await harness.seedUser({
    email: "owner@example.com",
    password: "OwnerSecure123!",
    role: "owner",
  });

  const publicCaller = await harness.caller();
  const login = await publicCaller.auth.login({
    email: "owner@example.com",
    password: "OwnerSecure123!",
  });

  const authedCaller = await harness.caller(login.access_token);
  await authedCaller.users.list();

  await harness.db.update(users).set({ role: "viewer" }).where(eq(users.id, owner.id));

  await assert.rejects(async () => authedCaller.users.list(), /insufficient role/);

  await harness.db.update(users).set({ banned: true }).where(eq(users.id, owner.id));
  await assert.rejects(async () => authedCaller.auth.me(), /inactive or missing user/);
});

test("contract: must-change users cannot call protected domain procedures", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  await harness.seedUser({
    email: "admin@example.com",
    password: "AdminSecure123!",
    role: "admin",
    mustChangePassword: true,
  });

  const publicCaller = await harness.caller();
  const login = await publicCaller.auth.login({
    email: "admin@example.com",
    password: "AdminSecure123!",
  });
  assert.equal(login.user.must_change_password, true);

  const authedCaller = await harness.caller(login.access_token);
  const me = await authedCaller.auth.me();
  assert.equal(me.must_change_password, true);
  await assert.rejects(async () => authedCaller.users.list(), /password change required/);

  const changed = await authedCaller.auth.changePassword({
    currentPassword: "AdminSecure123!",
    newPassword: "AdminSecure124!",
  });
  assert.equal(changed.must_change_password, false);
});

test("contract: user administration preserves required and last privileged accounts", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  process.env.REQUIRED_ADMIN_EMAIL = "admin@kuuna.ai";
  resetSettingsForTests();
  t.after(() => {
    delete process.env.REQUIRED_ADMIN_EMAIL;
    resetSettingsForTests();
  });

  const requiredAdmin = await harness.seedUser({
    email: "admin@kuuna.ai",
    password: "AdminSecure123!",
    role: "admin",
  });

  const publicCaller = await harness.caller();
  const requiredLogin = await publicCaller.auth.login({
    email: "admin@kuuna.ai",
    password: "AdminSecure123!",
  });
  const requiredCaller = await harness.caller(requiredLogin.access_token);

  await assert.rejects(
    async () => requiredCaller.users.update({ userId: requiredAdmin.id, isActive: false }),
    /cannot deactivate required admin account/,
  );

  const secondAdmin = await harness.seedUser({
    email: "second-admin@example.com",
    password: "SecondAdmin123!",
    role: "admin",
  });
  const secondLogin = await publicCaller.auth.login({
    email: "second-admin@example.com",
    password: "SecondAdmin123!",
  });
  const secondCaller = await harness.caller(secondLogin.access_token);

  await assert.rejects(
    async () => secondCaller.users.delete({ userId: requiredAdmin.id }),
    /cannot delete required admin account/,
  );

  await harness.db.update(users).set({ banned: true }).where(eq(users.id, requiredAdmin.id));
  await assert.rejects(
    async () => secondCaller.users.update({ userId: secondAdmin.id, isActive: false }),
    /cannot deactivate last active privileged user/,
  );
});

test("contract: internal admin bootstrap is idempotent and token protected", { skip: skipReason }, async (t) => {
  const harness = await createContractHarness();
  t.after(() => harness.close());

  process.env.INTERNAL_OPS_TOKEN = "admin-bootstrap-token";
  process.env.REQUIRED_ADMIN_EMAIL = "admin@kuuna.ai";
  process.env.DASHBOARD_REQUIRED_ADMIN_PASSWORD = "AdminBootstrap123!";
  resetSettingsForTests();
  t.after(() => {
    delete process.env.INTERNAL_OPS_TOKEN;
    delete process.env.REQUIRED_ADMIN_EMAIL;
    delete process.env.DASHBOARD_REQUIRED_ADMIN_PASSWORD;
    resetSettingsForTests();
  });

  await assert.rejects(
    async () => (await harness.internalCaller("wrong")).internal.adminBootstrap(),
    /invalid internal ops token/,
  );

  const created = await (await harness.internalCaller("admin-bootstrap-token")).internal.adminBootstrap();
  assert.equal(created.created, true);

  const second = await (await harness.internalCaller("admin-bootstrap-token")).internal.adminBootstrap();
  assert.equal(second.created, false);

  const rows = await harness.db.select().from(users).where(eq(users.email, "admin@kuuna.ai"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.banned, false);
  assert.equal(rows[0]?.mustChangePassword, true);
});
