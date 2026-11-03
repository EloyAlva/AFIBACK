import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import Fastify from "fastify";
import { SupabaseRecoveryStore } from "../src/supabase-recovery.js";
import { registerPasswordRecovery } from "../src/password-recovery.js";
import { registerSecurityQuestions } from "../src/security-question.js";

test("Recuperación compartida: RPC privadas, códigos atómicos y bloqueos entre instancias", async (t) => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key,email text);",
    );
    const sql = await readFile(
      new URL(
        "../supabase/migrations/009_private_recovery.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    const u = randomUUID(),
      v = randomUUID();
    await db.query(
      "insert into auth.users(id,email) values($1,'ealva@afi.com'),($2,'mramirez@afi.com')",
      [u, v],
    );
    const service = () => db.exec("reset role; set role service_role");
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const entries = Object.entries(args);
      const result = await db.query<any>(
        `select public.${name}(${entries.map(([key], i) => key + " => $" + (i + 1)).join(",")}) as result`,
        entries.map(([, value]) => value),
      );
      return result.rows[0].result;
    };
    const store = new SupabaseRecoveryStore(rpc),
      second = new SupabaseRecoveryStore(rpc);
    await t.test(
      "Anon y usuarios autenticados no pueden leer hashes ni invocar RPC",
      async () => {
        for (const role of ["anon", "authenticated"]) {
          await db.exec(`reset role; set role ${role}`);
          await assert.rejects(
            db.query("select * from afi_private.security_questions"),
          );
          await assert.rejects(store.question("ealva@afi.com"));
          await assert.rejects(store.consume("ealva@afi.com", "a".repeat(43)));
        }
        await service();
        assert.equal(await store.question("unknown@afi.com"), null);
      },
    );
    await t.test(
      "Código vinculado a identidad, reemplazo, vencimiento y consumo único",
      async () => {
        await assert.rejects(store.issue(u, "mramirez@afi.com"));
        const old = await store.issue(u, "ealva@afi.com"),
          fresh = await store.issue(u, "ealva@afi.com");
        assert.equal(await store.consume("ealva@afi.com", old.code), null);
        assert.equal(await store.consume("mramirez@afi.com", fresh.code), null);
        assert.equal(await second.consume("ealva@afi.com", fresh.code), u);
        assert.equal(await store.consume("ealva@afi.com", fresh.code), null);
        const expires = await store.issue(u, "ealva@afi.com");
        await db.exec("reset role");
        await db.query(
          "update afi_private.recovery_codes set expires_at=now()-interval '1 minute' where user_id=$1",
          [u],
        );
        await service();
        assert.equal(await store.consume("ealva@afi.com", expires.code), null);
      },
    );
    await t.test(
      "Cinco fallos bloquean incluso con dos instancias; una respuesta correcta exige claim exclusivo",
      async () => {
        await store.setQuestion(
          u,
          "ealva@afi.com",
          "¿Cuál es mi frase privada?",
          "Un recuerdo del verano",
        );
        assert.equal(
          await second.question("ealva@afi.com"),
          "¿Cuál es mi frase privada?",
        );
        for (let i = 0; i < 5; i++)
          assert.equal(
            await second.verifyAnswer("ealva@afi.com", "Respuesta equivocada"),
            null,
          );
        assert.equal(
          await store.verifyAnswer("ealva@afi.com", "Un recuerdo del verano"),
          null,
        );
        await db.exec("reset role");
        await db.query(
          "update afi_private.security_questions set locked_until=now()-interval '1 minute' where email='ealva@afi.com'",
        );
        await service();
        const results = await Promise.all([
          store.verifyAnswer("ealva@afi.com", "  UN   recuerdo del verano "),
          second.verifyAnswer("ealva@afi.com", "Un recuerdo del verano"),
        ]);
        assert.equal(results.filter(Boolean).length, 1);
        const claim = results.find(Boolean)!;
        assert.equal(claim.userId, u);
        await assert.rejects(
          store.setQuestion(
            u,
            "ealva@afi.com",
            "Otra pregunta privada",
            "Otra respuesta privada",
          ),
        );
        await store.finishAnswer("ealva@afi.com", "wrong-claim", true);
        assert.equal(
          await second.verifyAnswer("ealva@afi.com", "Un recuerdo del verano"),
          null,
        );
        await second.finishAnswer("ealva@afi.com", claim.claim, true);
        const again = await store.verifyAnswer(
          "ealva@afi.com",
          "Un recuerdo del verano",
        );
        assert.ok(again);
        await store.finishAnswer("ealva@afi.com", again.claim, true);
      },
    );
    await t.test(
      "Importar hashes locales nunca sobrescribe una pregunta ya configurada",
      async () => {
        await store.saveHash(
          u,
          "ealva@afi.com",
          "Pregunta de una instalación anterior",
          "a".repeat(32),
          "b".repeat(64),
        );
        assert.equal(
          await store.question("ealva@afi.com"),
          "¿Cuál es mi frase privada?",
        );
      },
    );
    await t.test(
      "Endpoints usan el almacén compartido y no actualizan Auth con respuestas o códigos inválidos",
      async () => {
        const app = Fastify();
        let writes = 0;
        const admin = () => ({
          getUser: async (id: string) => ({ id, email: "ealva@afi.com" }),
          setPassword: async () => {
            writes++;
            return true;
          },
        });
        await registerPasswordRecovery(app, { store, admin });
        await registerSecurityQuestions(app, { store, admin });
        try {
          const lookup = await app.inject({
            method: "POST",
            url: "/api/v1/auth/security-question/lookup",
            payload: { username: "ealva" },
          });
          assert.equal(lookup.statusCode, 200);
          assert.deepEqual(lookup.json(), {
            question: "¿Cuál es mi frase privada?",
          });
          const reset = {
            username: "ealva",
            answer: "Un recuerdo del verano",
            password: "NewPassword.2026!",
            confirmation: "NewPassword.2026!",
          };
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: "/api/v1/auth/security-question/reset",
                payload: { ...reset, answer: "Respuesta equivocada" },
              })
            ).statusCode,
            400,
          );
          assert.equal(writes, 0);
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: "/api/v1/auth/security-question/reset",
                payload: reset,
              })
            ).statusCode,
            200,
          );
          assert.equal(writes, 1);
          const issued = await second.issue(u, "ealva@afi.com");
          const body = {
            username: "ealva",
            code: issued.code,
            password: reset.password,
            confirmation: reset.confirmation,
          };
          const results = await Promise.all([
            app.inject({
              method: "POST",
              url: "/api/v1/auth/password-recovery",
              payload: body,
            }),
            app.inject({
              method: "POST",
              url: "/api/v1/auth/password-recovery",
              payload: body,
            }),
          ]);
          assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 400]);
          assert.equal(writes, 2);
        } finally {
          await app.close();
        }
      },
    );
  } finally {
    await db.close();
  }
});
