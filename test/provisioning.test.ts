import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

// Supabase owns Auth tables in production. This fixture models the fields used
// by provisioning; it does not pretend to implement the GoTrue login service.
const authFixture = `
 create role anon; create role authenticated; create role service_role;
 create schema auth;
 create table auth.users(
  instance_id uuid,id uuid primary key,aud text,role text,email text unique,
  encrypted_password text,email_confirmed_at timestamptz,confirmation_token text,
  recovery_token text,email_change_token_new text,email_change text,email_change_token_current text,
  email_change_confirm_status integer,reauthentication_token text,
  raw_app_meta_data jsonb,raw_user_meta_data jsonb not null default '{}',
  is_super_admin boolean,is_sso_user boolean,is_anonymous boolean,created_at timestamptz,updated_at timestamptz
 );
 create table auth.identities(
  id uuid primary key,provider_id text not null,user_id uuid not null references auth.users(id),
  identity_data jsonb not null,provider text not null,created_at timestamptz,updated_at timestamptz,
  unique(provider_id,provider)
 );
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 grant usage on schema auth,public to authenticated,anon,service_role;
 grant execute on all functions in schema auth to authenticated,anon,service_role;
`;

test("SQL completo instala AFI y crea usuarios Auth, identidades y configuración sin duplicar", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(authFixture);
    const original = await readFile(
      new URL("../supabase/afi_instalacion_completa.sql", import.meta.url),
      "utf8",
    );
    const execution = await db.exec(original);
    const credentials = execution.at(-1)!.rows as {
      email: string;
      contrasena_inicial: string;
    }[];
    assert.equal(credentials.length, 2);
    assert.notEqual(
      credentials[0].contrasena_inicial,
      credentials[1].contrasena_inicial,
    );
    for (const credential of credentials) {
      assert.match(credential.contrasena_inicial, /^[a-f0-9]{36}$/);
      const result = await db.query<any>(
        "select encrypted_password=extensions.crypt($1,encrypted_password) as valid from auth.users where email=$2",
        [credential.contrasena_inicial, credential.email],
      );
      assert.equal(result.rows[0].valid, true);
    }
    const users =
      await db.query<any>(`select u.id,u.email,p.display_name,u.email_confirmed_at,
     (select count(*)::int from auth.identities i where i.user_id=u.id and i.provider='email' and i.identity_data->>'sub'=u.id::text and i.identity_data->>'email'=u.email) as identities,
     (select count(*)::int from public.categories c where c.user_id=u.id) as categories,
     (select count(*)::int from public.financial_accounts a where a.user_id=u.id and a.opening_balance=0) as accounts
     from auth.users u join public.profiles p on p.id=u.id order by u.email`);
    assert.deepEqual(
      users.rows.map((r) => r.email),
      ["ealva@afi.com", "mramirez@afi.com"],
    );
    assert.deepEqual(
      users.rows.map((r) => r.display_name),
      ["Eloy Gonzalo Alva Calderon", "Marines Ramirez Rodriguez"],
    );
    for (const user of users.rows) {
      assert.ok(user.email_confirmed_at);
      assert.equal(user.identities, 1);
      assert.equal(user.categories, 7);
      assert.equal(user.accounts, 1);
    }
    const before = (
      await db.query<any>(
        "select email,encrypted_password from auth.users order by email",
      )
    ).rows;
    // Replaying never regenerates or reveals an existing password.
    const repeated = await db.exec(original);
    assert.ok(
      repeated.at(-1)!.rows.every((r: any) => r.contrasena_inicial === null),
    );
    assert.equal(
      (
        await db.query<any>(
          "select count(*)::int as n from pg_temp.afi_initial_users",
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(
      (
        await db.query<any>(
          "select email,encrypted_password from auth.users order by email",
        )
      ).rows,
      before,
    );
    assert.equal(
      (await db.query<any>("select count(*)::int as n from auth.users")).rows[0]
        .n,
      2,
    );
    assert.equal(
      (
        await db.query<any>(
          "select count(*)::int as n from public.financial_accounts",
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await db.query<any>(
          "select count(*)::int as n from public.ai_usage_limits",
        )
      ).rows[0].n,
      2,
    );
    const rls = await db.query<any>(
      "select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity",
    );
    assert.equal(rls.rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test("Una contraseña personalizada inválida revierte la instalación", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(authFixture);
    const sql = await readFile(
      new URL("../supabase/afi_instalacion_completa.sql", import.meta.url),
      "utf8",
    );
    const invalid = sql.replace(
      "'Marines Ramirez Rodriguez',null)",
      "'Marines Ramirez Rodriguez','short')",
    );
    assert.notEqual(invalid, sql);
    await assert.rejects(db.exec(invalid), /La contraseña personalizada/);
    await db.exec("rollback");
    assert.equal(
      (await db.query<any>("select count(*)::int as n from auth.users")).rows[0]
        .n,
      0,
    );
    assert.equal(
      (
        await db.query<any>(
          "select to_regclass('public.profiles') as table_name",
        )
      ).rows[0].table_name,
      null,
    );
  } finally {
    await db.close();
  }
});
