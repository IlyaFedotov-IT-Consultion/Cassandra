import { z } from "zod";

const EnvSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://postgres:postgres@localhost:5432/cassandra"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  JUDGE_BASE_URL: z.string().url().default("http://localhost:8000"),
  CASSANDRA_ADAPTER_MODE: z.enum(["live", "fixture"]).default("live"),
  PERPLEXITY_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_JUDGE_MODEL: z.string().min(1).optional(),
  OPENROUTER_CROSS_EXAMINER_MODEL: z.string().min(1).optional(),
  OPENROUTER_SEARCH_MODEL: z.string().min(1).optional(),
  ZAI_API_KEY: z.string().min(1).optional(),
  ZAI_BASE_URL: z.string().url().default("https://api.z.ai/api/paas/v4"),
  ZAI_MODEL: z.string().min(1).optional(),
  ZAI_WEB_SEARCH_URL: z.string().url().optional(),
  ZAI_WEB_SEARCH_PRIME_URL: z.string().url().optional(),
  ZAI_web_search_prime_URL: z.string().url().optional(),
  POLYMARKET_GAMMA_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_CLOB_URL: z.string().url().default("https://clob.polymarket.com"),
  CUSTOM_MARKET_API_BASE_URL: z
    .string()
    .url()
    .default("https://example-market-provider.local"),
  CUSTOM_MARKET_API_KEY: z.string().min(1).optional(),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function getEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return EnvSchema.parse(input);
}
