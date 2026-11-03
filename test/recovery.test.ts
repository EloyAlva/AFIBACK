import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  RecoveryStore,
  registerPasswordRecovery,
} from "../src/password-recovery.js";

test("Código vinculado a usuario, vencimiento y consumo único atómico", () => {
  const store = new RecoveryStore(":memory:");
  try {
    const { code } = store.issue("user1", "ealva@afi.com", 1000);
    assert.equal(store.consume("mramirez@afi.com", code, 2000), null);
    assert.equal(store.consume("ealva@afi.com", "wrong", 2000), null);
    assert.equal(store.consume("ealva@afi.com", code, 2000), "user1");
    assert.equal(store.consume("ealva@afi.com", code, 2000), null);
    const expired = store.issue("user1", "ealva@afi.com", 1000);
    assert.equal(
      store.consume("ealva@afi.com", expired.code, 1000 + 30 * 60 * 1000),
      null,
    );
    const old = store.issue("user1", "ealva@afi.com");
    const next = store.issue("user1", "ealva@afi.com");
    assert.equal(store.consume("ealva@afi.com", old.code), null);
    assert.equal(store.consume("ealva@afi.com", next.code), "user1");
  } finally {
    store.close();
  }
});

test("Endpoint público cambia clave solo con código válido y rechaza reuso concurrente", async () => {
  const app = Fastify();
  const store = new RecoveryStore(":memory:");
  let writes = 0;
  await registerPasswordRecovery(app, {
    store,
    admin: () => ({
      getUser: async (id) => ({ id, email: "ealva@afi.com" }),
      setPassword: async (id, password) => {
        assert.equal(id, "user1");
        assert.equal(password, "MyNewPassword.2026!");
        writes++;
        return true;
      },
    }),
  });
  try {
    const issued = store.issue("user1", "ealva@afi.com");
    const body = {
      username: "ealva",
      code: issued.code,
      password: "MyNewPassword.2026!",
      confirmation: "MyNewPassword.2026!",
    };
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-recovery",
      payload: { ...body, code: "a".repeat(43) },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(writes, 0);
    const mismatched = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-recovery",
      payload: { ...body, username: "mramirez" },
    });
    assert.equal(mismatched.statusCode, 400);
    assert.equal(writes, 0);
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
    assert.equal(writes, 1);
  } finally {
    await app.close();
    store.close();
  }
});

test("Rate limiting bloquea intentos repetidos sin invocar Auth", async () => {
  const app = Fastify();
  const store = new RecoveryStore(":memory:");
  let writes = 0;
  await app.register(rateLimit);
  await registerPasswordRecovery(app, {
    store,
    admin: () => ({
      getUser: async () => null,
      setPassword: async () => {
        writes++;
        return true;
      },
    }),
  });
  try {
    for (let n = 0; n < 5; n++)
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-recovery",
        payload: {
          username: "ealva",
          code: "a".repeat(43),
          password: "MyNewPassword.2026!",
          confirmation: "MyNewPassword.2026!",
        },
      });
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-recovery",
      payload: {
        username: "ealva",
        code: "a".repeat(43),
        password: "MyNewPassword.2026!",
        confirmation: "MyNewPassword.2026!",
      },
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(writes, 0);
  } finally {
    await app.close();
    store.close();
  }
});
