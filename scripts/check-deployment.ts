import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Public HTTP checks only: no admin keys, real passwords or financial writes.
const base = new URL(process.argv[2] ?? "https://afiback.vercel.app");
assert.ok(
  ["https:", "http:"].includes(base.protocol) &&
    !base.username &&
    !base.password,
  "Usa una URL HTTP(S) pública sin credenciales",
);
const origins = [
  "https://afifront-git-main-eacode.vercel.app",
  "http://localhost:5173",
];
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const request = (path: string, init: RequestInit = {}) =>
  fetch(new URL(path, base), {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
const health = await request("/health");
assert.equal(health.status, 200, "/health no responde correctamente");
assert.equal((await health.json()).status, "ok");
console.log("PASS GET /health: 200");

for (const origin of origins) {
  const preflight = await request("/api/v1/auth/login", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "content-type,authorization,idempotency-key",
    },
  });
  assert.equal(preflight.status, 204, `OPTIONS falló para ${origin}`);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  const allowed = (preflight.headers.get("access-control-allow-methods") ?? "")
    .split(",")
    .map((s) => s.trim());
  for (const method of methods)
    assert.ok(allowed.includes(method), `Falta permitir ${method}`);
  const allowedHeaders = (
    preflight.headers.get("access-control-allow-headers") ?? ""
  ).toLowerCase();
  assert.ok(
    allowedHeaders.includes("content-type") &&
      allowedHeaders.includes("authorization"),
  );
  console.log(`PASS OPTIONS ${origin}: 204, origen y métodos correctos`);

  // A random nonexistent identity reaches Supabase Auth without changing a real account.
  const login = await request("/api/v1/auth/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `afi-check-${randomUUID()}@example.com`,
      password: `Check-${randomUUID()}`,
    }),
  });
  assert.ok(
    [400, 401].includes(login.status),
    `Login inválido devolvió HTTP ${login.status}; se esperaba 400/401, no 404`,
  );
  assert.equal(login.headers.get("access-control-allow-origin"), origin);
  const result = await login.json();
  assert.equal(
    result.error?.code,
    "invalid_credentials",
    "No se recibió el error esperado de Supabase Auth",
  );
  console.log(
    `PASS POST login ${origin}: ${login.status}, invalid_credentials, CORS correcto`,
  );
}

const foreign = await request("/api/v1/auth/login", {
  method: "OPTIONS",
  headers: {
    Origin: "https://attacker.invalid",
    "Access-Control-Request-Method": "POST",
  },
});
assert.equal(foreign.headers.get("access-control-allow-origin"), null);
console.log("PASS origen no autorizado: sin permiso CORS");
const privateRoute = await request("/api/v1/accounts", {
  headers: { Origin: origins[0] },
});
assert.equal(
  privateRoute.status,
  401,
  "Las rutas privadas deben exigir un token válido",
);
assert.equal(
  privateRoute.headers.get("access-control-allow-origin"),
  origins[0],
);
console.log("PASS ruta financiera sin sesión: 401 con CORS");

const lookup = await request("/api/v1/auth/security-question/lookup", {
  method: "POST",
  headers: { Origin: origins[0], "Content-Type": "application/json" },
  body: JSON.stringify({ username: `afi-check-${randomUUID()}` }),
});
assert.equal(
  lookup.status,
  200,
  "La consulta de recuperación no debe fallar por almacenamiento local",
);
assert.deepEqual(await lookup.json(), { question: null });
console.log(
  "PASS recuperación persistente: consulta de usuario inexistente devuelve 200",
);
const logout = await request("/api/v1/auth/logout", {
  method: "POST",
  headers: { Origin: origins[0], Authorization: "Bearer invalid-test-token" },
});
assert.equal(logout.status, 200);
assert.equal((await logout.json()).ok, true);
console.log(
  "PASS logout con sesión inexistente: 200, sin errores de socket o cuerpo vacío",
);
