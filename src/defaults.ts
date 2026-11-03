// Public, non-secret defaults. Credentials stay in the deployment environment.
export const defaults = {
  port: 4000,
  developmentFrontend: "http://localhost:3000",
  productionFrontend: "https://afifront.vercel.app",
  ai: {
    provider: "openai-compatible",
    model: "gpt-5.4-nano",
    baseUrl: "https://api.openai.com/v1",
    timeoutMs: 15000,
    monthlyBudgetUsd: 5,
    monthlyRequestLimit: 100,
    maxInputTokens: 2000,
    maxOutputTokens: 300,
    tokenParameter: "max_completion_tokens" as const,
    // USD per million tokens; verified 2026-11-02 against OpenAI Docs:
    // https://developers.openai.com/api/docs/models/gpt-5.4-nano
    inputUsdPerMillion: 0.2,
    outputUsdPerMillion: 1.25,
  },
} as const;
