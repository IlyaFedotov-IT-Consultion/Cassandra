import { z } from "zod";

const EnvSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://postgres:postgres@localhost:5432/cassandra"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  CASSANDRA_ADAPTER_MODE: z.enum(["live", "fixture"]).default("fixture"),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function getEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return EnvSchema.parse(input);
}
