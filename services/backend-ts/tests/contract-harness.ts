import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres, { type Sql } from "postgres";
import { hashPassword } from "better-auth/crypto";

import { issueAccessToken, type RoleName } from "../src/auth.js";
import { resetSettingsForTests } from "../src/config.js";
import type { Database } from "../src/db/client.js";
import { appRouter } from "../src/trpc/routers/_app.js";
import { createCallerFactory, createTRPCContext } from "../src/trpc/init.js";
import { closeQueues } from "../src/jobs/queues.js";
import * as schema from "../src/db/schema.js";

export const contractDatabaseUrl = process.env.BACKEND_TS_CONTRACT_DATABASE_URL;

const createCaller = createCallerFactory(appRouter);

export type ContractDb = Database;
export type AppCaller = ReturnType<typeof createCaller>;

export type EnqueuedJob = {
  name: string;
  data: Record<string, unknown>;
  jobId?: string;
};

export type ContractHarness = {
  db: ContractDb;
  sql: Sql;
  schemaName: string;
  jobs: EnqueuedJob[];
  runtimeChatTasks: string[];
  caller: (token?: string) => Promise<AppCaller>;
  authTokenForUser: (userId: string) => Promise<string>;
  callerForUser: (userId: string) => Promise<AppCaller>;
  internalCaller: (internalToken: string) => Promise<AppCaller>;
  seedUser: (input: {
    email: string;
    password: string;
    role?: RoleName;
    groupScope?: string[];
    isActive?: boolean;
    mustChangePassword?: boolean;
  }) => Promise<{ id: string; email: string }>;
  close: () => Promise<void>;
};

export async function createContractHarness(): Promise<ContractHarness> {
  assert.ok(contractDatabaseUrl, "BACKEND_TS_CONTRACT_DATABASE_URL is required for contract tests");

  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "backend-ts-contract-secret";
  resetSettingsForTests();

  const schemaName = `backend_ts_contract_${randomUUID().replaceAll("-", "_")}`;
  const sql = postgres(contractDatabaseUrl, { max: 1, prepare: false, onnotice: () => undefined });

  await sql.unsafe(`create schema ${schemaName}`);
  await sql.unsafe(`set search_path to ${schemaName}, public`);
  await createContractTables(sql);

  const db = drizzle(sql, { schema }) as Database;
  const jobs: EnqueuedJob[] = [];
  const runtimeChatTasks: string[] = [];
  const activeRuntimeChatDrains = new Set<string>();
  const runtimeChatQueue = {
    async rpush(_key: string, value: string) {
      runtimeChatTasks.push(value);
      return runtimeChatTasks.length;
    },
    async set(key: string) {
      if (activeRuntimeChatDrains.has(key)) return null;
      activeRuntimeChatDrains.add(key);
      return "OK" as const;
    },
  };

  return {
    db,
    sql,
    schemaName,
    jobs,
    runtimeChatTasks,
    caller: async (token?: string) => {
      const headers = new Headers();
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }
      const context = await createTRPCContext({ headers, clientIp: "contract-test", db, enqueueJob: async (name, data, jobId) => {
        jobs.push({ name, data, jobId });
        return jobId ?? name;
      }, runtimeChatQueue });
      return createCaller(context);
    },
    authTokenForUser: async (userId: string) => {
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
      assert.ok(user);
      const assignments = await db
        .select({ providerGroupId: schema.groupAssignments.providerGroupId })
        .from(schema.groupAssignments)
        .where(eq(schema.groupAssignments.userId, userId));
      return issueAccessToken({
        userId: user.id,
        role: user.role,
        groupScope: assignments.map((assignment) => assignment.providerGroupId),
      });
    },
    callerForUser: async (userId: string) => {
      const token = await (async () => {
        const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
        assert.ok(user);
        const assignments = await db
          .select({ providerGroupId: schema.groupAssignments.providerGroupId })
          .from(schema.groupAssignments)
          .where(eq(schema.groupAssignments.userId, userId));
        return issueAccessToken({
          userId: user.id,
          role: user.role,
          groupScope: assignments.map((assignment) => assignment.providerGroupId),
        });
      })();
      const headers = new Headers({ authorization: `Bearer ${token}` });
      const context = await createTRPCContext({ headers, clientIp: "contract-test", db, enqueueJob: async (name, data, jobId) => {
        jobs.push({ name, data, jobId });
        return jobId ?? name;
      }, runtimeChatQueue });
      return createCaller(context);
    },
    internalCaller: async (internalToken: string) => {
      const headers = new Headers({ "x-internal-token": internalToken });
      const context = await createTRPCContext({ headers, clientIp: "contract-test", db, enqueueJob: async (name, data, jobId) => {
        jobs.push({ name, data, jobId });
        return jobId ?? name;
      }, runtimeChatQueue });
      return createCaller(context);
    },
    seedUser: async (input) => {
      const role = input.role ?? "operator";
      const [user] = await db
        .insert(schema.users)
        .values({
          email: input.email.toLowerCase(),
          emailVerified: true,
          name: input.email.toLowerCase(),
          role,
          banned: !(input.isActive ?? true),
          banReason: input.isActive === false ? "test inactive" : null,
          banExpires: null,
          mustChangePassword: input.mustChangePassword ?? false,
        })
        .returning({ id: schema.users.id, email: schema.users.email });
      assert.ok(user);

      await db.insert(schema.account).values({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await hashPassword(input.password),
      });
      for (const providerGroupId of Array.from(new Set(input.groupScope ?? [])).sort()) {
        await db.insert(schema.groupAssignments).values({ userId: user.id, providerGroupId });
      }
      return user;
    },
    close: async () => {
      await closeQueues();
      await sql.unsafe(`drop schema if exists ${schemaName} cascade`);
      await sql.end({ timeout: 5 });
    },
  };
}

async function createContractTables(sql: Sql): Promise<void> {
  await sql.unsafe(`
    create extension if not exists pgcrypto;
    create extension if not exists vector;
    create type role_name as enum ('owner', 'admin', 'operator', 'viewer');

    create table users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      email_verified boolean not null default false,
      name text not null,
      image text,
      role role_name not null default 'viewer',
      banned boolean not null default false,
      ban_reason text,
      ban_expires timestamptz,
      must_change_password boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table session (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null,
      token text not null unique,
      expires_at timestamptz not null,
      ip_address text,
      user_agent text,
      impersonated_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table account (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null,
      account_id text not null,
      provider_id text not null,
      access_token text,
      refresh_token text,
      id_token text,
      access_token_expires_at timestamptz,
      refresh_token_expires_at timestamptz,
      scope text,
      password text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (provider_id, account_id)
    );

    create table verification (
      id uuid primary key default gen_random_uuid(),
      identifier text not null,
      value text not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table group_assignments (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      provider_group_id text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (user_id, provider_group_id)
    );

    create table client_profiles (
      id uuid primary key default gen_random_uuid(),
      display_name text not null,
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table client_profile_identities (
      id uuid primary key default gen_random_uuid(),
      client_profile_id uuid not null references client_profiles(id) on delete cascade,
      provider_user_id text not null unique,
      derived_phone text,
      phone_override text,
      push_name text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table group_members (
      id uuid primary key default gen_random_uuid(),
      provider_group_id text not null,
      provider_user_id text not null,
      role text,
      display_name text,
      derived_phone text,
      phone_override text,
      push_name text,
      client_profile_id uuid references client_profiles(id) on delete set null,
      gateway_metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (provider_group_id, provider_user_id)
    );

    create table group_client_profiles (
      id uuid primary key default gen_random_uuid(),
      provider_group_id text not null,
      client_profile_id uuid not null references client_profiles(id) on delete cascade,
      is_primary boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (provider_group_id, client_profile_id)
    );

    create table audit_events (
      id uuid primary key default gen_random_uuid(),
      actor_user_id uuid references users(id) on delete set null,
      event_type text not null,
      entity_type text not null,
      entity_id text not null,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table group_templates (
      id uuid primary key default gen_random_uuid(),
      key text not null unique,
      display_name text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table template_versions (
      id uuid primary key default gen_random_uuid(),
      template_id uuid not null references group_templates(id) on delete cascade,
      version_no integer not null,
      status text not null,
      system_prompt text,
      model_config jsonb not null default '{}'::jsonb,
      tools_config jsonb not null default '{}'::jsonb,
      egress_policy jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (template_id, version_no)
    );

    create table template_builds (
      id uuid primary key default gen_random_uuid(),
      template_id uuid not null references group_templates(id) on delete cascade,
      template_version_id uuid not null references template_versions(id) on delete cascade,
      status text not null default 'queued',
      image_ref text,
      image_tag text,
      build_inputs jsonb not null default '{}'::jsonb,
      logs_ref text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table runtime_runs (
      id uuid primary key default gen_random_uuid(),
      provider_group_id text not null,
      message_id uuid,
      binding_id uuid not null,
      template_version_id uuid not null,
      template_build_id uuid,
      image_ref text not null,
      status text not null,
      started_at timestamptz not null,
      finished_at timestamptz,
      duration_ms integer,
      error text,
      execution jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table group_bindings (
      id uuid primary key default gen_random_uuid(),
      provider_group_id text not null,
      template_version_id uuid not null,
      status text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create unique index uq_group_bindings_active_provider_group
      on group_bindings (provider_group_id)
      where status = 'active';

    create table agent_instances (
      id uuid primary key default gen_random_uuid(),
      group_binding_id uuid not null references group_bindings(id) on delete cascade,
      runtime_mode text not null default 'on_demand',
      status text not null,
      runtime_container_name text,
      runtime_base_url text,
      secrets_ref text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table messages (
      id uuid primary key default gen_random_uuid(),
      provider_group_id text not null,
      provider_message_id text not null,
      sender_provider_user_id text,
      latest_version_no integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (provider_group_id, provider_message_id)
    );

    create table message_versions (
      id uuid primary key default gen_random_uuid(),
      message_id uuid not null references messages(id) on delete cascade,
      version_no integer not null,
      event_type text not null,
      is_deleted boolean not null default false,
      text_content text,
      raw_event jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null,
      created_at timestamptz not null default now(),
      unique (message_id, version_no)
    );

    create table media_assets (
      id uuid primary key default gen_random_uuid(),
      message_id uuid not null references messages(id) on delete cascade,
      provider_media_id text not null,
      mime_type text not null,
      file_name text,
      byte_size integer,
      s3_key text,
      status text not null default 'pending',
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table transcripts (
      id uuid primary key default gen_random_uuid(),
      media_asset_id uuid not null references media_assets(id) on delete cascade,
      text_content text,
      language text,
      status text not null default 'pending',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table message_decisions (
      id uuid primary key default gen_random_uuid(),
      message_id uuid not null references messages(id) on delete cascade,
      provider_group_id text not null,
      decision_type text not null,
      reason text,
      should_execute boolean not null default false,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table message_links (
      id uuid primary key default gen_random_uuid(),
      message_id uuid not null references messages(id) on delete cascade,
      provider_group_id text not null,
      url text not null,
      normalized_url text not null,
      title text,
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (message_id, normalized_url)
    );

    create table outbound_intents (
      id uuid primary key default gen_random_uuid(),
      outbound_intent_id uuid not null unique,
      provider_group_id text not null,
      status text not null default 'pending',
      attempt_count integer not null default 0,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index ix_outbound_intents_group_dispatch_provider_message
      on outbound_intents (
        provider_group_id,
        ((payload->'_dispatch'->>'provider_message_id'))
      )
      where (payload->'_dispatch'->>'provider_message_id') is not null;

    create table todos (
      id uuid primary key default gen_random_uuid(),
      provider_group_id text not null,
      message_id uuid,
      agent_run_id uuid,
      title text not null,
      description text,
      status text not null default 'open',
      priority text not null default 'normal',
      due_at timestamptz,
      completed_at timestamptz,
      exported_at timestamptz,
      export_attempt_count integer not null default 0,
      external_ref text,
      last_export_error text,
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table agent_runs (
      id uuid primary key default gen_random_uuid(),
      message_id uuid,
      provider_group_id text not null,
      trace_id text,
      status text not null,
      model_path jsonb not null default '[]'::jsonb,
      model_used text,
      reasoning_effort text not null default 'medium',
      allowed_tools jsonb not null default '[]'::jsonb,
      retrieval_refs jsonb not null default '[]'::jsonb,
      system_prompt text,
      user_prompt text,
      input_context jsonb not null default '{}'::jsonb,
      response_text text,
      error text,
      started_at timestamptz not null default now(),
      completed_at timestamptz
    );

    create table tool_invocations (
      id uuid primary key default gen_random_uuid(),
      agent_run_id uuid,
      message_id uuid,
      provider_group_id text not null,
      tool_name text not null,
      ok boolean not null default false,
      stdout text not null default '',
      stderr text not null default '',
      timed_out boolean not null default false,
      duration_ms integer not null default 0,
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table knowledge_common_docs (
      id uuid primary key default gen_random_uuid(),
      doc_key text not null unique,
      title text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table knowledge_group_docs (
      id uuid primary key default gen_random_uuid(),
      provider_group_id text not null,
      doc_key text not null,
      title text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (provider_group_id, doc_key)
    );

    create table knowledge_customer_docs (
      id uuid primary key default gen_random_uuid(),
      provider_group_id text not null,
      customer_key text not null,
      doc_key text not null,
      title text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (customer_key, doc_key)
    );

    create table knowledge_personal_docs (
      id uuid primary key default gen_random_uuid(),
      client_profile_id uuid not null references client_profiles(id) on delete cascade,
      doc_key text not null,
      title text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (client_profile_id, doc_key)
    );

    create table knowledge_statements (
      id uuid primary key default gen_random_uuid(),
      scope text not null,
      provider_group_id text not null,
      client_profile_id uuid references client_profiles(id) on delete set null,
      source_message_id uuid not null references messages(id) on delete cascade,
      source_message_version_id uuid not null references message_versions(id) on delete cascade,
      provider_message_id text not null,
      speaker_provider_user_id text,
      speaker_role text,
      speaker_display_name text,
      statement_text text not null,
      attribution_label text not null,
      source_type text not null default 'message',
      occurred_at timestamptz not null,
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (source_message_id)
    );

    create table knowledge_claims (
      id uuid primary key default gen_random_uuid(),
      statement_id uuid not null references knowledge_statements(id) on delete cascade,
      scope text not null,
      provider_group_id text not null,
      client_profile_id uuid references client_profiles(id) on delete set null,
      claim_text text not null,
      claim_kind text not null default 'general_statement',
      attribution_label text not null,
      confidence integer not null default 100,
      extraction_method text not null default 'sentence_split_v1',
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table knowledge_versions (
      id uuid primary key default gen_random_uuid(),
      scope text not null,
      doc_ref_id uuid not null,
      version_no integer not null,
      status text not null,
      content_markdown text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (scope, doc_ref_id, version_no)
    );

    create table embeddings (
      id uuid primary key default gen_random_uuid(),
      scope text not null,
      source_version_id uuid not null references knowledge_versions(id) on delete cascade,
      chunk_no integer not null,
      content text not null,
      token_count integer not null,
      embedding text not null,
      embedding_vector vector(1536),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table retrieval_chunks (
      id uuid primary key default gen_random_uuid(),
      scope text not null,
      provider_group_id text,
      client_profile_id uuid references client_profiles(id) on delete cascade,
      source_type text not null,
      source_id uuid not null,
      chunk_no integer not null,
      content text not null,
      token_count integer not null default 0,
      embedding text,
      embedding_vector vector(1536),
      metadata_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (source_type, source_id, chunk_no)
    );
  `);
}
