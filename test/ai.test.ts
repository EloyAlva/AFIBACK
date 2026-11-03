import test from "node:test";
import assert from "node:assert/strict";
import { CompatibleProvider, interpret } from "../src/ai.js";
import { config } from "../src/config.js";
test("Proveedor desacoplado valida JSON y no envía herramientas de escritura", async () => {
  const original = globalThis.fetch;
  let request: any;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: "expense",
                amount: 25,
                currency: "PEN",
                description: "Almuerzo",
                date: null,
                account_id: null,
                category_id: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }),
    );
  };
  try {
    const r = await new CompatibleProvider().extract("Gasté 25", {
      accounts: [],
      categories: [],
    });
    assert.equal(r.value.amount, 25);
    assert.equal(r.inputTokens, 100);
    assert.equal(request.tools, undefined);
    assert.equal(request.max_completion_tokens, 300);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"type":"transfer","amount":25}' } },
          ],
        }),
      );
    await assert.rejects(new CompatibleProvider().extract("Transfiere 25", {}));
  } finally {
    globalThis.fetch = original;
  }
});
test("IA desactivada falla antes de consultar datos o llamar al proveedor", async () => {
  if (config.AI_ENABLED) return;
  await assert.rejects(
    interpret({} as any, "user", "key", "Hola"),
    /IA desactivada/,
  );
});
