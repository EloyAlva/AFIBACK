import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import handler, { requestUrl } from "../src/vercel-handler.js";
import { config } from "../src/config.js";

test("La reescritura conserva rutas y filtros sin filtrar el parámetro interno", () => {
  assert.equal(
    requestUrl(
      "/api/index?__afi_path=/api/v1/transactions&page=2&currency=PEN",
    ),
    "/api/v1/transactions?page=2&currency=PEN",
  );
  assert.equal(requestUrl("/health"), "/health");
  assert.throws(() => requestUrl("/api/index?__afi_path=//attacker.invalid"));
});

test("La función Vercel responde salud y preflight sin abrir un puerto de Fastify", async () => {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const origin = config.FRONTEND_URL.split(",")[0];
  try {
    const health = await fetch(base + "/api/index?__afi_path=/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    const preflight = await fetch(
      base + "/api/index?__afi_path=/api/v1/auth/login",
      {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(
      preflight.headers.get("access-control-allow-methods") ?? "",
      /POST/,
    );
    assert.match(
      preflight.headers.get("access-control-allow-headers") ?? "",
      /content-type/i,
    );
    const foreign = await fetch(
      base + "/api/index?__afi_path=/api/v1/auth/login",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.invalid",
          "Access-Control-Request-Method": "POST",
        },
      },
    );
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    const rejected = await fetch(
      base + "/api/index?__afi_path=/api/v1/auth/login",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invalid", password: "" }),
      },
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.headers.get("access-control-allow-origin"), origin);
    assert.equal((await rejected.json()).error.code, "VALIDATION_ERROR");
    const finance = await fetch(
      base + "/api/index?__afi_path=/api/v1/accounts",
    );
    assert.ok([401, 503].includes(finance.status));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("La función admite JSON ya procesado por Vercel y devuelve errores legibles con CORS", async () => {
  const server = createServer((req, res) => {
    const prepared = req as typeof req & { body?: unknown };
    prepared.body = req.url?.includes("large")
      ? "x".repeat(32769)
      : { email: "invalid", password: "" };
    void handler(prepared, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const origin = config.FRONTEND_URL.split(",")[0];
  try {
    const response = await fetch(
      base + "/api/index?__afi_path=/api/v1/auth/login",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: ' { "email" : "invalid", "password" : "" } ',
      },
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const large = await fetch(
      base + "/api/index?__afi_path=/api/v1/auth/login&large=1",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(large.status, 413);
    assert.equal(large.headers.get("access-control-allow-origin"), origin);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
