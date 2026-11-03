import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/runtime-config.js";
import { defaults } from "../src/defaults.js";

const minimal = {
  FRONTEND_URL: "https://afifront.vercel.app",
  AI_API_KEY: "test-key",
  DATABASE_URL: "unused",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "test-anon",
  SUPABASE_SERVICE_ROLE_KEY: "test-service",
};
test("FRONTEND_URL normaliza dominio, barra final y varios orígenes para CORS", () => {
  assert.equal(
    parseConfig({ ...minimal, FRONTEND_URL: "afifront.vercel.app/" })
      .FRONTEND_URL,
    ["https://afifront.vercel.app", ...defaults.additionalFrontendOrigins].join(
      ",",
    ),
  );
  assert.equal(
    parseConfig({
      ...minimal,
      FRONTEND_URL: "https://afifront.vercel.app/, http://localhost:3000/",
    }).FRONTEND_URL,
    [
      "https://afifront.vercel.app",
      "http://localhost:3000",
      ...defaults.additionalFrontendOrigins,
    ].join(","),
  );
  assert.throws(() =>
    parseConfig({ ...minimal, FRONTEND_URL: "ftp://afifront.vercel.app" }),
  );
});
test("Solo las seis variables del despliegue habilitan IA con valores completos", () => {
  const config = parseConfig(minimal);
  assert.equal(config.AI_ENABLED, true);
  assert.equal(config.AI_MODEL, defaults.ai.model);
  assert.equal(config.AI_BASE_URL, defaults.ai.baseUrl);
  assert.equal(config.AI_INPUT_USD_PER_MILLION, 0.2);
  assert.equal(config.AI_OUTPUT_USD_PER_MILLION, 1.25);
  assert.equal(config.AI_MONTHLY_BUDGET_USD, 5);
  assert.equal(config.AI_DEFAULT_MONTHLY_REQUEST_LIMIT, 100);
  assert.equal(config.AI_MAX_OUTPUT_TOKENS, 300);
  assert.equal(config.FRONTEND_URL.split(",")[0], minimal.FRONTEND_URL);
  assert.equal(config.SUPABASE_ANON_KEY, "test-anon");
});
test("Sin clave la IA queda apagada; una desactivación explícita se conserva", () => {
  assert.equal(parseConfig({}).AI_ENABLED, false);
  assert.equal(
    parseConfig({ ...minimal, AI_ENABLED: "false" }).AI_ENABLED,
    false,
  );
  assert.equal(
    parseConfig({ ...minimal, AI_API_KEY: "   " }).AI_ENABLED,
    false,
  );
});
test("Valores vacíos usan defaults, pero los límites explícitos de cero se respetan", () => {
  const config = parseConfig({
    ...minimal,
    AI_ENABLED: "",
    AI_MODEL: "",
    AI_BASE_URL: " ",
    AI_TIMEOUT_MS: "",
    AI_INPUT_USD_PER_MILLION: "",
    AI_MONTHLY_BUDGET_USD: "0",
    AI_DEFAULT_MONTHLY_REQUEST_LIMIT: "0",
  });
  assert.equal(config.AI_ENABLED, true);
  assert.equal(config.AI_MODEL, defaults.ai.model);
  assert.equal(config.AI_TIMEOUT_MS, 15000);
  assert.equal(config.AI_INPUT_USD_PER_MILLION, 0.2);
  assert.equal(config.AI_MONTHLY_BUDGET_USD, 0);
  assert.equal(config.AI_DEFAULT_MONTHLY_REQUEST_LIMIT, 0);
  assert.throws(() => parseConfig({ ...minimal, AI_TIMEOUT_MS: "invalid" }));
});
test("Los overrides son opcionales y no heredan precios de otro modelo", () => {
  const changed = parseConfig({ ...minimal, AI_MODEL: "custom-model" });
  assert.equal(changed.AI_INPUT_USD_PER_MILLION, undefined);
  assert.equal(changed.AI_OUTPUT_USD_PER_MILLION, undefined);
  assert.equal(
    parseConfig({
      ...minimal,
      AI_BASE_URL: "https://other-provider.invalid/v1",
    }).AI_INPUT_USD_PER_MILLION,
    undefined,
  );
  const priced = parseConfig({
    ...minimal,
    AI_MODEL: "custom-model",
    AI_INPUT_USD_PER_MILLION: "2",
    AI_OUTPUT_USD_PER_MILLION: "5",
  });
  assert.equal(priced.AI_INPUT_USD_PER_MILLION, 2);
  assert.equal(priced.AI_OUTPUT_USD_PER_MILLION, 5);
});
test("Vercel usa producción sin configurar NODE_ENV ni el puerto", () => {
  const production = parseConfig({ ...minimal, FRONTEND_URL: "", VERCEL: "1" });
  assert.equal(production.NODE_ENV, "production");
  assert.equal(production.PORT, 4000);
  assert.equal(
    production.FRONTEND_URL,
    ["https://afifront.vercel.app", ...defaults.additionalFrontendOrigins].join(
      ",",
    ),
  );
  assert.equal(
    parseConfig({}).FRONTEND_URL.split(",")[0],
    "http://localhost:3000",
  );
});

test("El dominio principal sigue permitido en Vercel con una URL temporal configurada", () => {
  const configured = parseConfig({
    ...minimal,
    VERCEL: "1",
    FRONTEND_URL: "https://old-preview.example/",
  });
  assert.deepEqual(configured.FRONTEND_URL.split(","), [
    "https://afifront.vercel.app",
    "https://old-preview.example",
    ...defaults.additionalFrontendOrigins,
  ]);
  assert.ok(!configured.FRONTEND_URL.includes("*"));
});
