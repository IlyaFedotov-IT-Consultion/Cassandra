import { z } from "zod";

const IdSchema = z.string().min(1);
const TimestampSchema = z.string().min(1);
const ProbabilitySchema = z.number().min(0).max(1);
const JsonMapSchema = z.record(z.string(), z.unknown());

export const SourceFamilySchema = z.enum([
  "official",
  "government",
  "community",
  "web",
  "market",
  "prediction_market",
  "llm_research",
]);

export const SourceTypeSchema = z.enum([
  "perplexity_search_result",
  "web_article",
  "reddit_post",
  "x_post",
  "sec_filing",
  "press_release",
  "polymarket_market",
  "quote_snapshot",
  "government_notice",
]);

export const EventStatusSchema = z.enum([
  "draft",
  "active",
  "resolved",
  "archived",
]);

export const CandidatePromotionStatusSchema = z.enum([
  "pending",
  "promoted",
  "rejected",
]);

export const JudgmentStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "insufficient_evidence",
  "failed",
]);

export const EnsembleMethodSchema = z.enum(["logarithmic_opinion_pool"]);
export const CalibrationMethodSchema = z.enum([
  "identity",
  "isotonic",
  "logistic",
  "beta",
]);
export const UncertaintyMethodSchema = z.enum(["none", "bootstrap"]);
export const BaselineNameSchema = z.enum([
  "base_rate_only",
  "polymarket_only",
  "model_without_polymarket",
  "model_with_polymarket",
]);

export const EventInputSchema = z
  .object({
    question: z.string().min(1),
    resolutionCriteria: z.string().min(1),
    deadline: TimestampSchema,
    entities: z.array(z.string().min(1)).min(1),
    marketSymbols: z.array(z.string().min(1)).default([]),
    polymarketMarketId: z.string().min(1).optional(),
  })
  .strict();

export const WatchlistInputSchema = z
  .object({
    name: z.string().min(1),
    keywords: z.array(z.string().min(1)).min(1),
    jurisdictions: z.array(z.string().min(1)).default([]),
    cadence: z.string().min(1),
    sourceToggles: z
      .object({
        community: z.boolean().optional(),
        official: z.boolean().optional(),
        government: z.boolean().optional(),
        markets: z.boolean().optional(),
        predictionMarkets: z.boolean().optional(),
      })
      .partial()
      .default({}),
  })
  .strict();

export const CandidateEventSchema = z
  .object({
    id: IdSchema,
    watchlistId: IdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    supportingEvidenceIds: z.array(IdSchema).default([]),
    clusterKey: z.string().min(1),
    promotionStatus: CandidatePromotionStatusSchema,
  })
  .strict();

export const EvidenceItemSchema = z
  .object({
    id: IdSchema,
    eventId: IdSchema.optional(),
    sourceFamily: SourceFamilySchema,
    sourceType: SourceTypeSchema,
    title: z.string().min(1),
    url: z.string().url(),
    publisher: z.string().min(1),
    publishedAt: TimestampSchema,
    retrievedAt: TimestampSchema,
    summary: z.string().min(1),
    rawText: z.string().nullable().default(null),
    entities: z.array(z.string().min(1)).default([]),
    claims: z.array(z.string().min(1)).default([]),
    stance: z.enum(["supports", "contradicts", "neutral", "unknown"]),
    freshnessHours: z.number().min(0),
    qualitySignals: JsonMapSchema.default({}),
    metadata: JsonMapSchema.default({}),
  })
  .strict();

export const JudgeOpinionSchema = z
  .object({
    id: IdSchema.optional(),
    judgmentId: IdSchema.optional(),
    judgeName: z.string().min(1),
    probability: ProbabilitySchema,
    confidence: ProbabilitySchema,
    logBayesFactor: z.number(),
    reliabilityWeight: z.number().min(0),
    dependencyDiscount: z.number().min(0).max(1),
    rationale: z.string().min(1),
    evidenceIds: z.array(IdSchema).default([]),
    warnings: z.array(z.string().min(1)).default([]),
    missingEvidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const WeightBreakdownEntrySchema = z
  .object({
    source: z.string().min(1),
    weight: z.number(),
    details: JsonMapSchema.default({}),
  })
  .strict();

export const CitationSchema = z
  .object({
    title: z.string().min(1),
    url: z.string().url(),
    sourceFamily: SourceFamilySchema,
  })
  .strict();

export const VerdictTraceSchema = z
  .object({
    id: IdSchema,
    eventId: IdSchema,
    priorProbability: ProbabilitySchema,
    rawPosteriorProbability: ProbabilitySchema,
    finalProbability: ProbabilitySchema,
    confidenceLow: ProbabilitySchema,
    confidenceHigh: ProbabilitySchema,
    judgeOpinions: z.array(JudgeOpinionSchema).min(1),
    weightBreakdown: z.array(WeightBreakdownEntrySchema),
    ensembleMethod: EnsembleMethodSchema,
    calibrationMethod: CalibrationMethodSchema,
    uncertaintyMethod: UncertaintyMethodSchema,
    conflicts: z.array(z.string().min(1)).default([]),
    missingEvidence: z.array(z.string().min(1)).default([]),
    citations: z.array(CitationSchema).min(1),
    modelVersion: z.string().min(1),
    weightVersion: z.string().min(1),
    calibrationVersion: z.string().min(1),
    status: JudgmentStatusSchema,
  })
  .strict()
  .refine((value) => value.confidenceLow <= value.finalProbability, {
    message: "confidenceLow must be less than or equal to finalProbability",
    path: ["confidenceLow"],
  })
  .refine((value) => value.confidenceHigh >= value.finalProbability, {
    message: "confidenceHigh must be greater than or equal to finalProbability",
    path: ["confidenceHigh"],
  });

export const OutcomeInputSchema = z
  .object({
    eventId: IdSchema,
    resolvedValue: z.boolean(),
    resolvedAt: TimestampSchema,
    resolutionSourceUrl: z.string().url(),
  })
  .strict();

export const CalibrationSnapshotSchema = z
  .object({
    id: IdSchema,
    createdAt: TimestampSchema,
    trainingWindow: z.string().min(1),
    judgeWeights: JsonMapSchema,
    baseRateParams: JsonMapSchema,
    marketPriorParams: JsonMapSchema,
    calibrationParams: JsonMapSchema,
    onlineLearningParams: JsonMapSchema,
    metrics: JsonMapSchema,
    approved: z.boolean(),
  })
  .strict();

export const BenchmarkMarketSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    resolutionCriteria: z.string().min(1),
    theme: z.string().min(1),
    volume: z.number().min(0),
    liquidity: z.number().min(0),
    resolvedAt: TimestampSchema,
    resolvedValue: z.boolean(),
    marketUrl: z.string().url(),
  })
  .strict();

export const EvaluationSliceResultSchema = z
  .object({
    sliceKey: z.string().min(1),
    baseline: BaselineNameSchema,
    brierScore: z.number().min(0),
    logLoss: z.number().min(0),
    averageAbsoluteError: z.number().min(0),
    winRateVsPolymarket: z.number().min(0).max(1).optional(),
    sampleSize: z.number().int().min(0),
  })
  .strict();

export const EvaluationRunSchema = z
  .object({
    id: IdSchema,
    benchmarkSetId: IdSchema,
    cutoffs: z.array(z.string().min(1)).min(1),
    baselines: z.array(BaselineNameSchema).min(1),
    overallMetrics: JsonMapSchema,
    sliceResults: z.array(EvaluationSliceResultSchema),
    replayFidelity: z.enum(["exact", "approximate"]),
    leakageWarnings: z.array(z.string().min(1)).default([]),
    createdAt: TimestampSchema,
  })
  .strict();

export type EventInput = z.infer<typeof EventInputSchema>;
export type WatchlistInput = z.infer<typeof WatchlistInputSchema>;
export type CandidateEvent = z.infer<typeof CandidateEventSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type JudgeOpinion = z.infer<typeof JudgeOpinionSchema>;
export type VerdictTrace = z.infer<typeof VerdictTraceSchema>;
export type OutcomeInput = z.infer<typeof OutcomeInputSchema>;
export type CalibrationSnapshot = z.infer<typeof CalibrationSnapshotSchema>;
export type BenchmarkMarket = z.infer<typeof BenchmarkMarketSchema>;
export type EvaluationSliceResult = z.infer<typeof EvaluationSliceResultSchema>;
export type EvaluationRun = z.infer<typeof EvaluationRunSchema>;
