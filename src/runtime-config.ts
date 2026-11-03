import { z } from "zod";
import { defaults } from "./defaults.js";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65535).default(defaults.port),
  FRONTEND_URL: z.string(),
  SUPABASE_URL: z.string().trim().default(""),
  SUPABASE_ANON_KEY: z.string().trim().default(""),
  AI_ENABLED: z.enum(["true", "false"]).optional(),
  AI_PROVIDER: z.string().trim().default(defaults.ai.provider),
  AI_API_KEY: z.string().trim().default(""),
  AI_MODEL: z.string().trim().default(defaults.ai.model),
  AI_BASE_URL: z.url().default(defaults.ai.baseUrl),
  AI_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(defaults.ai.timeoutMs),
  AI_MONTHLY_BUDGET_USD: z.coerce
    .number()
    .nonnegative()
    .default(defaults.ai.monthlyBudgetUsd),
  AI_DEFAULT_MONTHLY_REQUEST_LIMIT: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(defaults.ai.monthlyRequestLimit),
  AI_MAX_INPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .max(16000)
    .default(defaults.ai.maxInputTokens),
  AI_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .max(2000)
    .default(defaults.ai.maxOutputTokens),
  AI_TOKEN_PARAMETER: z
    .enum(["max_tokens", "max_completion_tokens"])
    .default(defaults.ai.tokenParameter),
  AI_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().optional(),
  AI_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().optional(),
});

export function parseConfig(environment: Record<string, string | undefined>) {
  // Blank optional values use defaults instead of becoming zero or invalid URLs.
  const input = Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [
      key,
      value?.trim() || undefined,
    ]),
  );
  const production = input.NODE_ENV === "production" || input.VERCEL === "1";
  const parsed = schema.parse({
    ...input,
    NODE_ENV: input.NODE_ENV ?? (production ? "production" : "development"),
    FRONTEND_URL:
      input.FRONTEND_URL ??
      (production ? defaults.productionFrontend : defaults.developmentFrontend),
  });
  const origins = parsed.FRONTEND_URL.split(",").map((value) => {
    const address = value.trim();
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(
      address,
    );
    const url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(address)
        ? address
        : (local ? "http://" : "https://") + address,
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("FRONTEND_URL debe contener dominios HTTP(S) válidos");
    return url.origin;
  });
  // Never apply this model's prices to a different model or provider endpoint.
  const knownModel =
    parsed.AI_MODEL === defaults.ai.model &&
    parsed.AI_BASE_URL.replace(/\/+$/, "") === defaults.ai.baseUrl;
  return {
    ...parsed,
    FRONTEND_URL: [
      ...new Set(
        production ? [defaults.productionFrontend, ...origins] : origins,
      ),
    ].join(","),
    AI_ENABLED:
      parsed.AI_ENABLED === undefined
        ? !!parsed.AI_API_KEY
        : parsed.AI_ENABLED === "true",
    AI_INPUT_USD_PER_MILLION:
      parsed.AI_INPUT_USD_PER_MILLION ??
      (knownModel ? defaults.ai.inputUsdPerMillion : undefined),
    AI_OUTPUT_USD_PER_MILLION:
      parsed.AI_OUTPUT_USD_PER_MILLION ??
      (knownModel ? defaults.ai.outputUsdPerMillion : undefined),
  };
}
