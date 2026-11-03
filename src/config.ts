import "dotenv/config";
import { z } from "zod";
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  SUPABASE_URL: z.string().default(""),
  SUPABASE_ANON_KEY: z.string().default(""),
  AI_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AI_PROVIDER: z.string().default("openai-compatible"),
  AI_API_KEY: z.string().default(""),
  AI_MODEL: z.string().default(""),
  AI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(5),
  AI_DEFAULT_MONTHLY_REQUEST_LIMIT: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(100),
  AI_MAX_INPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .max(16000)
    .default(2000),
  AI_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .max(2000)
    .default(300),
  AI_TOKEN_PARAMETER: z
    .enum(["max_tokens", "max_completion_tokens"])
    .default("max_completion_tokens"),
  AI_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().optional(),
  AI_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().optional(),
});
export const config = envSchema.parse(process.env);
