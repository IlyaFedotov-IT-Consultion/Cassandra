import { z } from "zod";

/** An env var left blank (`NAME=`) counts as unset. */
const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const EnvSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3000),
  /** Loopback by default: the API can start paid work, so other machines reach it only when asked to. */
  API_HOST: z.string().min(1).default("127.0.0.1"),
  /**
   * Browser origins allowed to call the API, comma-separated. Requests from any other origin get 403.
   * The default covers the local web workspace under `vite dev` (5173) and `vite preview` (4173).
   */
  CASSANDRA_CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"),
  /** When set, every route except /health and /ready needs it as `x-api-key` or a bearer token. */
  CASSANDRA_API_KEY: optionalSecret,
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://postgres:postgres@localhost:5432/cassandra"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  JUDGE_BASE_URL: z.string().url().default("http://localhost:8000"),
  JUDGE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(360000),
  CASSANDRA_ADAPTER_MODE: z.enum(["live", "fixture"]).default("live"),
  /** Runs watchlist discovery on each watchlist's cadence. In live mode every run makes paid search calls. */
  CASSANDRA_DISCOVERY_SCHEDULE: z.enum(["on", "off"]).default("on"),
  CASSANDRA_JUDGE_LLM: z.string().min(1).optional(),
  PERPLEXITY_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  /** Judge ensemble (model@effort, comma-separated); read by the judge service, used here for cache versioning. */
  OPENROUTER_JUDGE_MODELS: z.string().min(1).optional(),
  OPENROUTER_JUDGE_MODEL: z.string().min(1).optional(),
  OPENROUTER_JUDGE_REASONING_EFFORT: z.string().min(1).optional(),
  OPENROUTER_UTILITY_MODEL: z.string().min(1).optional(),
  OPENROUTER_CROSS_EXAMINER_MODEL: z.string().min(1).optional(),
  OPENROUTER_SEARCH_MODEL: z.string().min(1).optional(),
  /** Live web search backend: auto = Z.AI when its key is set, otherwise OpenRouter. */
  CASSANDRA_SEARCH_BACKEND: z.enum(["auto", "zai", "openrouter"]).default("auto"),
  OPENROUTER_WEB_SEARCH_MODEL: z.string().min(1).default("anthropic/claude-haiku-5.5"),
  OPENROUTER_WEB_SEARCH_ENGINE: z.string().min(1).default("perplexity"),
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
