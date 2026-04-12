import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppEnv } from "../../config/env.js";
import { searchWithZaiCli } from "../evidence/providers/zaiCli.js";

const ResearchInputSchema = z
  .object({
    query: z.string().min(1),
    domains: z.array(z.string().min(1)).max(5).optional(),
    recency: z.enum(["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"]).optional(),
    count: z.number().int().min(1).max(10).optional(),
  })
  .strict();

const ResearchResultSchema = z
  .object({
    title: z.string().min(1),
    url: z.string().url(),
    publisher: z.string().min(1),
    publishedAt: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

const ResearchRunSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["completed"]),
    query: z.string().min(1),
    domains: z.array(z.string().min(1)),
    recency: z.enum(["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"]),
    count: z.number().int().positive(),
    summary: z.string(),
    results: z.array(ResearchResultSchema),
    createdAt: z.string().min(1),
  })
  .strict();

export type ResearchRunRecord = z.infer<typeof ResearchRunSchema>;
export type ResearchRunInput = z.infer<typeof ResearchInputSchema>;

const researchRuns = new Map<string, ResearchRunRecord>();

export async function runResearchQuery(
  env: AppEnv,
  input: ResearchRunInput,
): Promise<ResearchRunRecord> {
  if (!env.ZAI_API_KEY) {
    throw new Error("ZAI_API_KEY is required for research runs.");
  }

  const documents = await searchWithZaiCli({
    apiKey: env.ZAI_API_KEY,
    count: input.count ?? 5,
    domains: input.domains,
    providerName: "research",
    query: input.query,
    recency: input.recency,
  });
  const id = randomUUID();
  const results = documents.map((document) => ({
    publishedAt: document.publishedAt,
    publisher: document.publisher,
    summary: document.summary,
    title: document.title ?? document.summary,
    url: document.url,
  }));
  const record = ResearchRunSchema.parse({
    id,
    status: "completed",
    query: input.query,
    domains: input.domains ?? [],
    recency: input.recency ?? "noLimit",
    count: input.count ?? 5,
    summary: results.slice(0, 3).map((result) => result.summary).join(" "),
    results,
    createdAt: new Date().toISOString(),
  });

  researchRuns.set(record.id, record);
  return record;
}

export function registerResearchRoutes(
  app: FastifyInstance,
  args: {
    env: AppEnv;
    runResearch?: (input: ResearchRunInput) => Promise<ResearchRunRecord>;
  },
) {
  const runResearch = args.runResearch ?? ((input: ResearchRunInput) => runResearchQuery(args.env, input));

  app.post("/research/runs", async (request, reply) => {
    const parsed = ResearchInputSchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid research input",
        issues: parsed.error.issues,
      };
    }

    try {
      const record = await runResearch(parsed.data);
      researchRuns.set(record.id, record);
      reply.code(201);
      return record;
    } catch (error) {
      if (error instanceof Error && error.message.includes("ZAI_API_KEY")) {
        reply.code(503);
        return {
          error: error.message,
        };
      }

      throw error;
    }
  });

  app.get("/research/runs/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const record = params.id ? researchRuns.get(params.id) : null;

    if (!record) {
      reply.code(404);
      return {
        error: "Research run not found",
      };
    }

    return record;
  });
}
