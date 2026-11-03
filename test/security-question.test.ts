import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { RecoveryStore } from "../src/password-recovery.js";
import { registerSecurityQuestions } from "../src/security-question.js";

test("Respuesta normalizada, hash, exclusión concurrente y bloqueo tras cinco errores", async () => {
  const store = new RecoveryStore(":memory:");
  try {
    await store.setQuestion(
      "u1",
      "ealva@afi.com",
      "¿Cuál es mi frase privada?",
      "Mi Recuerdo del Verano",
    );
    assert.equal(store.question("ealva@afi.com"), "¿Cuál es mi frase privada?");
    assert.equal(store.question("mramirez@afi.com"), null);
    const now = Date.now();
    for (let n = 0; n < 5; n++)
      assert.equal(
        await store.verifyAnswer(
          "ealva@afi.com",
          "Otra respuesta incorrecta",
          now + n,
        ),
        null,
      );
    assert.equal(
      await store.verifyAnswer(
        "ealva@afi.com",
        "Mi Recuerdo del Verano",
        now + 100,
      ),
      null,
    );
    const later = now + 31 * 60 * 1000;
    const results = await Promise.all([
      store.verifyAnswer(
        "ealva@afi.com",
        "  MI   recuerdo del verano  ",
        later,
      ),
      store.verifyAnswer("ealva@afi.com", "Mi Recuerdo del Verano", later),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const result = results.find(Boolean)!;
    assert.equal(result.userId, "u1");
    store.finishAnswer("ealva@afi.com", result.claim, true, later);
    assert.equal(
      (
        await store.verifyAnswer(
          "ealva@afi.com",
          "Mi Recuerdo del Verano",
          later + 10,
        )
      )?.userId,
      "u1",
    );
  } finally {
    store.close();
  }
});

test("Configurar pregunta requiere prueba de identidad y no acepta códigos de otra cuenta", async () => {
  const app = Fastify();
  const store = new RecoveryStore(":memory:");
  await registerSecurityQuestions(app, {
    store,
    authorize: async (token, password) =>
      token === "valid" && password === "CurrentPassword.2026!"
        ? { id: "u1", email: "ealva@afi.com" }
        : null,
    admin: () => ({
      getUser: async (id) => ({ id, email: "ealva@afi.com" }),
      setPassword: async () => true,
    }),
  });
  try {
    const body = {
      username: "ealva",
      question: "¿Cuál es mi frase privada?",
      answer: "Un recuerdo del verano",
      answerConfirmation: "Un recuerdo del verano",
    };
    const post = (payload: unknown, headers?: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/security-question/setup",
        payload,
        headers,
      });
    assert.equal((await post(body)).statusCode, 401);
    assert.equal(store.question("ealva@afi.com"), null);
    assert.equal(
      (
        await post(
          { ...body, currentPassword: "wrong" },
          { authorization: "Bearer valid" },
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await post(
          {
            ...body,
            username: "mramirez",
            currentPassword: "CurrentPassword.2026!",
          },
          { authorization: "Bearer valid" },
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await post(
          { ...body, currentPassword: "CurrentPassword.2026!" },
          { authorization: "Bearer valid" },
        )
      ).statusCode,
      200,
    );
    const code = store.issue("u1", "ealva@afi.com");
    assert.equal((await post({ ...body, code: code.code })).statusCode, 200);
    assert.equal((await post({ ...body, code: code.code })).statusCode, 401);
  } finally {
    await app.close();
    store.close();
  }
});

test("Restablecimiento verifica respuesta, usuario y destino antes de actualizar Auth", async () => {
  const app = Fastify();
  const store = new RecoveryStore(":memory:");
  let writes = 0;
  await store.setQuestion(
    "u1",
    "ealva@afi.com",
    "¿Cuál es mi frase privada?",
    "Un recuerdo del verano",
  );
  await registerSecurityQuestions(app, {
    store,
    admin: () => ({
      getUser: async (id) => ({ id, email: "ealva@afi.com" }),
      setPassword: async (id, password) => {
        assert.equal(id, "u1");
        assert.equal(password, "NewPassword.2026!");
        writes++;
        return true;
      },
    }),
  });
  try {
    const lookup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/security-question/lookup",
      payload: { username: "ealva" },
    });
    assert.deepEqual(lookup.json(), { question: "¿Cuál es mi frase privada?" });
    const body = {
      username: "ealva",
      answer: "Un recuerdo del verano",
      password: "NewPassword.2026!",
      confirmation: "NewPassword.2026!",
    };
    const post = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/security-question/reset",
        payload,
      });
    assert.equal(
      (await post({ ...body, answer: "Otra respuesta incorrecta" })).statusCode,
      400,
    );
    assert.equal(writes, 0);
    assert.equal(
      (await post({ ...body, username: "mramirez" })).statusCode,
      400,
    );
    assert.equal(writes, 0);
    const results = await Promise.all([post(body), post(body)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 400]);
    assert.equal(writes, 1);
  } finally {
    await app.close();
    store.close();
  }
});
