import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAuth } from "../src/auth.js";
import { config } from "../src/config.js";
import { z } from "zod";

const uid = "11111111-1111-4111-8111-111111111111";
const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const user = {
  id: uid,
  email: "ealva@afi.com",
  user_metadata: { display_name: "Eloy" },
  app_metadata: { private: "never-return" },
};
const session = {
  access_token: jwt,
  refresh_token: "refresh-secret",
  expires_in: 3600,
  user,
};

async function setup(
  handler: (
    path: string,
    method: string,
    body: any,
    headers: Headers,
  ) => Response | Promise<Response>,
) {
  const app = Fastify();
  app.setErrorHandler((error: any, _req, reply) =>
    reply
      .code(error instanceof z.ZodError ? 400 : (error.statusCode ?? 500))
      .send({ error: { code: error.code ?? "ERROR", message: error.message } }),
  );
  await registerAuth(app, {
    supabaseUrl: "https://auth-test.supabase.co",
    anonKey: "test-anon-key",
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("apikey"), "test-anon-key");
      return handler(
        new URL(String(input)).pathname.replace(/^\/auth\/v1/, "") +
          new URL(String(input)).search,
        init?.method ?? "GET",
        init?.body ? JSON.parse(String(init.body)) : undefined,
        headers,
      );
    },
  });
  return app;
}
const ok = (body: unknown) => Response.json(body);

test("Logout es idempotente para sesiones vencidas y conserva fallos reales del proveedor", async () => {
  let providerStatus = 403,
    calls = 0;
  const app = await setup(() => {
    calls++;
    return Response.json(
      { error_code: "session_not_found", msg: "Session not found" },
      { status: providerStatus },
    );
  });
  try {
    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
    });
    assert.equal(empty.statusCode, 200);
    assert.equal(calls, 0);
    for (const status of [401, 403, 404]) {
      providerStatus = status;
      const result = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { authorization: "Bearer expired-test" },
      });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().ok, true);
    }
    providerStatus = 500;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/logout",
          headers: { authorization: "Bearer expired-test" },
        })
      ).statusCode,
      503,
    );
  } finally {
    await app.close();
  }
});

test("Auth: login y renovación pasan por backend sin filtrar claves ni metadatos privados", async () => {
  let calls = 0;
  const app = await setup((path, method, body) => {
    calls++;
    assert.equal(method, "POST");
    if (path.includes("grant_type=password")) {
      assert.equal(body.email, "ealva@afi.com");
      assert.equal(body.password, "secret-password");
    } else {
      assert.ok(path.includes("grant_type=refresh_token"));
      assert.deepEqual(body, { refresh_token: "refresh-secret" });
    }
    return ok(session);
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: " EALVA ", password: "secret-password" },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.headers["cache-control"], "no-store");
    assert.deepEqual(login.json().session.user, {
      id: uid,
      email: user.email,
      user_metadata: { display_name: "Eloy" },
    });
    assert.equal(login.json().session.expires_at > 0, true);
    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: "refresh-secret" },
    });
    assert.equal(refresh.statusCode, 200);
    assert.equal(calls, 2);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "ealva",
        password: "secret-password",
        user_id: "attacker",
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});

test("Auth: registro y correo restringen URL de retorno y contenido de metadatos", async () => {
  const calls: { path: string; body: any }[] = [];
  const app = await setup((path, _method, body) => {
    calls.push({ path, body });
    return ok(path.startsWith("/signup") ? user : {});
  });
  try {
    const payload = {
      email: user.email,
      password: "NewPassword.2026!",
      display_name: "Eloy",
    };
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { ...payload, redirect_to: "https://attacker.invalid/steal" },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(calls.length, 0);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload,
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().session, null);
    assert.deepEqual(calls[0].body, {
      email: user.email,
      password: payload.password,
      data: { display_name: "Eloy" },
    });
    const recovery = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recover",
      payload: {
        email: "ealva",
        redirect_to: config.FRONTEND_URL.split(",")[0],
      },
    });
    assert.equal(recovery.statusCode, 200);
    assert.deepEqual(calls[1].body, { email: user.email });
  } finally {
    await app.close();
  }
});

test("Auth: validar enlaces exige token verificado y contraseña usa la identidad verificada", async () => {
  const calls: string[] = [];
  const app = await setup((path, method, body, headers) => {
    calls.push(method + " " + path);
    if (path === "/user" && method === "GET") {
      assert.equal(headers.get("authorization"), `Bearer ${jwt}`);
      return ok(user);
    }
    if (path.includes("grant_type=password")) {
      assert.equal(body.email, user.email);
      assert.equal(body.password, "CurrentPassword.2026!");
      return ok({ ...session, access_token: "verification-token" });
    }
    if (path === "/logout?scope=local") {
      assert.equal(headers.get("authorization"), "Bearer verification-token");
      return new Response(null, { status: 204 });
    }
    if (path === "/user" && method === "PUT") {
      assert.equal(headers.get("authorization"), `Bearer ${jwt}`);
      assert.equal(body.password, "NewPassword.2026!");
      return ok(user);
    }
    throw Error("Unexpected operation: " + path);
  });
  try {
    const linked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { access_token: jwt, refresh_token: "refresh-secret" },
    });
    assert.equal(linked.statusCode, 200);
    assert.equal(linked.json().session.user.id, uid);
    const unauthorized = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/password",
      payload: { password: "NewPassword.2026!" },
    });
    assert.equal(unauthorized.statusCode, 401);
    const changed = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/password",
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        password: "NewPassword.2026!",
        current_password: "CurrentPassword.2026!",
      },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(calls.at(-1), "PUT /user");
  } finally {
    await app.close();
  }
});

test("Auth: credenciales rechazadas y tokens inválidos conservan el código y no escriben", async () => {
  let writes = 0;
  const app = await setup((path, method) => {
    if (method === "PUT") writes++;
    return Response.json(
      {
        error_code: path.includes("grant_type=password")
          ? "invalid_credentials"
          : "bad_jwt",
        msg: "Not authorized",
      },
      { status: 401 },
    );
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ealva", password: "wrong" },
    });
    assert.equal(login.statusCode, 401);
    assert.equal(login.json().error.code, "invalid_credentials");
    const changed = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/password",
      headers: { authorization: "Bearer forged-token" },
      payload: { password: "NewPassword.2026!" },
    });
    assert.equal(changed.statusCode, 401);
    assert.equal(writes, 0);
  } finally {
    await app.close();
  }
});
