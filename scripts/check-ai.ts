import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import { config } from "../src/config.js";
import { CompatibleProvider } from "../src/ai.js";

// One synthetic interpretation, with a spend reservation. Never writes a
// financial transaction, signs in as another user or reads their accounts.
const username = process.argv[2];
if (!username || !/^[a-z0-9._-]+$/.test(username))
  throw Error(
    "Uso: npm run ai:check -- ealva (consume una interacción de prueba)",
  );
if (
  !config.AI_ENABLED ||
  !config.AI_MODEL ||
  !config.AI_API_KEY ||
  !config.AI_INPUT_USD_PER_MILLION ||
  !config.AI_OUTPUT_USD_PER_MILLION ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY
)
  throw Error("Completa la configuración de IA y Supabase en el .env privado.");
const admin = createClient(
  config.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);
const email = username + "@afi.com";
let userId: string | undefined;
for (let page = 1; page <= 100; page++) {
  const { data, error } = await admin.auth.admin.listUsers({
    page,
    perPage: 100,
  });
  if (error)
    throw Error("No se pudo verificar el usuario para contabilizar la prueba.");
  userId = data.users.find((u) => u.email?.toLowerCase() === email)?.id;
  if (userId || data.users.length < 100) break;
}
if (!userId)
  throw Error("El usuario no existe. No se llamó al proveedor de IA.");
const reservedCost =
  (config.AI_MAX_INPUT_TOKENS * config.AI_INPUT_USD_PER_MILLION +
    config.AI_MAX_OUTPUT_TOKENS * config.AI_OUTPUT_USD_PER_MILLION) /
  1e6;
const reservation = await admin.rpc("reserve_ai", {
  u: userId,
  k: randomUUID(),
  cost: reservedCost,
  budget: config.AI_MONTHLY_BUDGET_USD,
  quota: config.AI_DEFAULT_MONTHLY_REQUEST_LIMIT,
});
if (reservation.error)
  throw Error(
    "No se pudo reservar cuota/presupuesto para la prueba. No se llamó al proveedor.",
  );
try {
  const result = await new CompatibleProvider().extract(
    "Gasté 25 soles en almuerzo",
    {
      accounts: [],
      categories: [],
      currency: "PEN",
      today: DateTime.now().setZone("America/Lima").toISODate(),
    },
  );
  if (
    result.value.type !== "expense" ||
    result.value.amount !== 25 ||
    result.value.currency !== "PEN"
  )
    throw Error("La interpretación de prueba no pasó la validación.");
  const actualCost =
    (result.inputTokens * config.AI_INPUT_USD_PER_MILLION +
      result.outputTokens * config.AI_OUTPUT_USD_PER_MILLION) /
    1e6;
  const settled = await admin.rpc("settle_ai", {
    log_id: reservation.data.id,
    result_payload: { diagnostic: true, extracted: result.value },
    in_tokens: result.inputTokens,
    out_tokens: result.outputTokens,
    actual_cost: actualCost,
    failed: false,
  });
  if (settled.error)
    throw Error(
      "La interpretación funcionó, pero no se pudo cerrar el registro de consumo.",
    );
  process.stdout.write(
    JSON.stringify({
      ok: true,
      model: config.AI_MODEL,
      type: result.value.type,
      amount: result.value.amount,
      currency: result.value.currency,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedActualCostUsd: actualCost,
      financialTransactionCreated: false,
    }) + "\n",
  );
} catch (error) {
  await admin.rpc("settle_ai", {
    log_id: reservation.data.id,
    result_payload: { diagnostic: true, failed: true },
    in_tokens: 0,
    out_tokens: 0,
    actual_cost: reservedCost,
    failed: true,
  });
  process.stderr.write(
    (error instanceof Error
      ? error.message
      : "La prueba de IA no pudo completarse.") + "\n",
  );
  process.exitCode = 1;
}
