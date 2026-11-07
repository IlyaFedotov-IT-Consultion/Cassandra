import type { JudgmentRecordDetails } from "../api";
import { formatDateTime, formatProbability, formatSignedDecimal, humanizeProviderName, humanizeToken } from "../format";
import { EmptyState, StatusPill } from "./ui";

type Trace = NonNullable<JudgmentRecordDetails["verdictTrace"]>;
type Stage = Trace["pipelineStages"][number];
type Opinion = JudgmentRecordDetails["judgeOpinions"][number];

export interface EnsembleSample {
  model: string;
  probability: number;
  evidenceStrength: string;
  rationale?: string;
  excluded?: string;
}

const STAGE_LABELS: Record<string, string> = {
  query_planning: "Query planning",
  retrieval: "Retrieval",
  relevance_rating: "Relevance rating",
  panel_reasoning: "Panel reasoning",
  cross_examination: "Cross-examination",
  aggregation: "Aggregation",
  calibration: "Calibration",
};

/** "openai/gpt-6.1-sol@high" -> "gpt-6.1-sol". */
export function shortModelName(model: string) {
  return model.split("/").pop()!.split("@")[0]!;
}

/** Split an ensemble rationale "[provider/model@effort] text" into its model and text. */
export function splitRationale(rationale: string): { model: string | null; text: string } {
  const match = /^\[([^\]]+)\]\s*/.exec(rationale);
  return match ? { model: match[1]!, text: rationale.slice(match[0].length) } : { model: null, text: rationale };
}

export function readSamples(trace: Trace | null, judgeName: string): EnsembleSample[] {
  const entry = trace?.weightBreakdown.find((item) => item.source === judgeName);
  const samples = entry?.details.samples;
  return Array.isArray(samples) ? (samples as EnsembleSample[]) : [];
}

export function readStage(trace: Trace | null, name: string): Stage | undefined {
  return trace?.pipelineStages?.find((stage) => stage.stage === name);
}

export function readRelevanceScores(trace: Trace | null): Record<string, number> {
  const scores = readStage(trace, "relevance_rating")?.details.scores;
  return scores && typeof scores === "object" ? (scores as Record<string, number>) : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function StageSummary({ stage }: { stage: Stage }) {
  const details = stage.details as Record<string, unknown>;

  switch (stage.stage) {
    case "query_planning": {
      const queries = asStrings(details.queries);
      if (queries.length === 0) {
        return (
          <p>
            {stage.status === "failed"
              ? `Planning failed (${String(details.error ?? "unknown error")}); providers used their own queries.`
              : "No planned queries; providers used their own queries."}
          </p>
        );
      }
      return (
        <>
          <p>Searched {queries.length} sub-question {queries.length === 1 ? "query" : "queries"}:</p>
          <ul className="stage__queries">
            {queries.map((query) => (
              <li key={query}>{query}</li>
            ))}
          </ul>
        </>
      );
    }
    case "retrieval": {
      const providers = Array.isArray(details.providers)
        ? (details.providers as Array<{ name: string; rawCount: number; error?: string | null }>)
        : [];
      const failed = providers.filter((provider) => provider.error);
      return (
        <>
          <p>
            {asNumber(details.evidenceCount) ?? 0} items from {providers.length} provider{providers.length === 1 ? "" : "s"}
          </p>
          {failed.map((provider) => (
            <p key={provider.name} className="stage__warning">
              {humanizeProviderName(provider.name)} failed: {provider.error}
            </p>
          ))}
        </>
      );
    }
    case "relevance_rating": {
      if (stage.status === "failed") {
        return <p className="stage__warning">Rating failed; judges read all evidence unfiltered.</p>;
      }
      if (stage.status === "skipped") {
        return <p>Not run ({String(details.reason ?? "no evidence to rate")}).</p>;
      }
      return (
        <>
          <p>
            Kept {asNumber(details.kept) ?? 0} of {asNumber(details.rated) ?? 0} rated sources (score{" "}
            {asNumber(details.threshold) ?? 4}+ of 6)
          </p>
          {details.insufficientRelevantEvidence ? (
            <p className="stage__warning">Too little relevant evidence; the verdict uses the prior only.</p>
          ) : null}
        </>
      );
    }
    case "panel_reasoning": {
      const models = typeof details.models === "string" ? details.models.replace(/^ensemble\[|\]$/g, "").split(",") : [];
      const judges = details.judges && typeof details.judges === "object"
        ? (details.judges as Record<string, { samples?: number; excludedSamples?: number }>)
        : {};
      const excluded = Object.values(judges).reduce((sum, judge) => sum + (judge.excludedSamples ?? 0), 0);
      return (
        <p>
          {models.length > 0 ? models.map(shortModelName).join(", ") : "Fake LLM"}
          {excluded > 0 ? `; ${excluded} incoherent sample${excluded === 1 ? "" : "s"} excluded` : ""}
        </p>
      );
    }
    case "cross_examination":
      return stage.status === "skipped" ? (
        <p>Skipped: fewer than two judges had evidence.</p>
      ) : (
        <p>
          {asNumber(details.conflicts) ?? 0} conflict{asNumber(details.conflicts) === 1 ? "" : "s"} raised
        </p>
      );
    case "aggregation": {
      const prior = asNumber(details.priorProbability);
      const raw = asNumber(details.rawPosteriorProbability);
      return (
        <p>
          Prior {formatProbability(prior)} to pooled {formatProbability(raw)}
          {details.marketPriorUsed ? " (market price in the prior)" : " (no market price)"}
        </p>
      );
    }
    case "calibration":
      return (
        <p>
          {details.method === "identity" || !details.method
            ? "No recalibration applied yet"
            : `${humanizeToken(String(details.method))} calibration applied`}
        </p>
      );
    default:
      return null;
  }
}

export function PipelineStages({ stages }: { stages: Stage[] }) {
  if (stages.length === 0) {
    return (
      <EmptyState
        title="No stage records"
        body="This trace was produced before the pipeline recorded its stages. Run the judgment again to see them."
      />
    );
  }

  return (
    <ol className="pipeline" aria-label="Pipeline stages">
      {stages.map((stage) => (
        <li key={stage.stage} className={`pipeline__stage pipeline__stage--${stage.status}`}>
          <div className="pipeline__head">
            <h4>{STAGE_LABELS[stage.stage] ?? humanizeToken(stage.stage)}</h4>
            {stage.status === "completed" ? null : <StatusPill value={stage.status} />}
          </div>
          <StageSummary stage={stage} />
        </li>
      ))}
    </ol>
  );
}

export function JudgeCard({ opinion, samples }: { opinion: Opinion; samples: EnsembleSample[] }) {
  const { model, text } = splitRationale(opinion.rationale);
  const name = humanizeToken(opinion.judgeName);
  const noEvidence = opinion.evidenceIds.length === 0;

  return (
    <article className={noEvidence ? "judge-card judge-card--idle" : "judge-card"}>
      <header className="judge-card__head">
        <h3>{name}</h3>
        <StatusPill value={opinion.evidenceStrength} />
      </header>
      <dl className="judge-card__figures">
        <div>
          <dt>Probability</dt>
          <dd>{formatProbability(opinion.probability)}</dd>
        </div>
        <div>
          <dt>Log-odds pull</dt>
          <dd>{formatSignedDecimal(opinion.effectiveLogOddsContribution)}</dd>
        </div>
        <div>
          <dt>Evidence read</dt>
          <dd>{opinion.evidenceIds.length}</dd>
        </div>
      </dl>
      <p className="judge-card__rationale">{text}</p>
      {model ? <p className="judge-card__source">Rationale from {shortModelName(model)}</p> : null}
      {samples.length > 0 ? (
        <table className="sample-table" aria-label={`${name} samples`}>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Probability</th>
              <th scope="col">Evidence strength</th>
            </tr>
          </thead>
          <tbody>
            {samples.map((sample) => (
              <tr key={sample.model} className={sample.excluded ? "sample-table__row--excluded" : undefined}>
                <td>{shortModelName(sample.model)}</td>
                <td>{formatProbability(sample.probability)}</td>
                <td>
                  {humanizeToken(sample.evidenceStrength)}
                  {sample.excluded ? <span className="sample-table__note">Excluded: {sample.excluded}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </article>
  );
}

/** "official, governmentSearch, <date>" -> "Official via Government, <date>"; drops a provider that repeats the family. */
export function citationMeta(citation: Trace["citations"][number]) {
  const family = humanizeToken(citation.sourceFamily);
  const provider = citation.provider ? humanizeToken(citation.provider.replace(/search$/i, "")) : null;
  const source = provider && provider.toLowerCase() !== family.toLowerCase() ? `${family} via ${provider}` : family;
  return citation.publishedAt ? `${source}, ${formatDateTime(citation.publishedAt)}` : source;
}

export function CitationList({
  citations,
  relevanceScores,
  compare,
}: {
  citations: Trace["citations"];
  relevanceScores: Record<string, number>;
  compare: (left: Trace["citations"][number], right: Trace["citations"][number]) => number;
}) {
  const score = (citation: Trace["citations"][number]) =>
    citation.evidenceId ? relevanceScores[citation.evidenceId] : undefined;
  const ordered = [...citations].sort(
    (left, right) => (score(right) ?? 0) - (score(left) ?? 0) || compare(left, right),
  );

  return (
    <ul className="citation-list">
      {ordered.map((citation) => {
        const relevance = score(citation);
        return (
          <li key={citation.url}>
            <a className="citation" href={citation.url} target="_blank" rel="noreferrer">
              <span className="citation__title">{citation.title}</span>
              <span className="citation__meta">
                {citationMeta(citation)}
              </span>
              {typeof relevance === "number" ? (
                <span className="citation__relevance">Relevance {relevance}/6</span>
              ) : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
