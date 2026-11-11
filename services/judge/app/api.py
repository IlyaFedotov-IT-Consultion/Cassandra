from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone
from math import exp, log
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException

from app.llm import LLMClient, get_llm_client
from app.llm.client import LLMError
from app.models import CalibrationRequest, JudgeRequest, PlanRequest, VerdictTrace
from app.models_generated import EvidenceItem
from app.observability import ContextThreadPoolExecutor
from app.scoring.aggregate import aggregate_posterior
from app.scoring.calibration import apply_probability_calibration, fit_calibration_snapshot
from app.scoring.judges.community_signal import evaluate as evaluate_community_signal
from app.scoring.judges.cross_examiner import evaluate as evaluate_cross_examiner
from app.scoring.judges.official_records import evaluate as evaluate_official_records
from app.scoring.judges.open_web_research import evaluate as evaluate_open_web_research
from app.scoring.priors import build_prior_log_odds, extract_market_signal
from app.scoring.types import CrossExaminerResult, PriorResult
from app.scoring.uncertainty import posterior_bootstrap_interval
from app.scoring.weights import default_judge_weights, select_regime


router = APIRouter()


def _llm_dependency() -> Iterator[LLMClient]:
    llm = get_llm_client()
    try:
        yield llm
    finally:
        close = getattr(llm, "close", None)
        if callable(close):
            close()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _log_odds_to_probability(log_odds: float) -> float:
    return 1 / (1 + exp(-log_odds))

def _looks_english(text: str) -> bool:
    latin_count = sum(1 for char in text if "a" <= char.lower() <= "z")
    cjk_count = sum(1 for char in text if "\u3400" <= char <= "\u9fff")
    return latin_count >= max(10, cjk_count * 2)


def _english_evidence_priority(item: EvidenceItem) -> int:
    url = str(item.url)
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    is_cn_host = host.endswith(".cn") or ".cn." in host
    text = " ".join([item.title, item.summary, item.publisher])
    english_text = _looks_english(text)
    metadata_hint = item.metadata.get("language")
    explicit_non_english = isinstance(metadata_hint, str) and metadata_hint.lower() not in {
        "en",
        "eng",
        "english",
    }

    if explicit_non_english:
        return 0
    if english_text and not is_cn_host:
        return 3
    if english_text:
        return 2
    if not is_cn_host:
        return 1
    return 0


def _sort_evidence_for_judging(evidence: list[EvidenceItem]) -> list[EvidenceItem]:
    return sorted(
        evidence,
        key=lambda item: (
            -_english_evidence_priority(item),
            item.publishedAt,
            item.id,
        ),
    )


def _missing_evidence_records(request: JudgeRequest, raw_opinions: list) -> list[dict[str, str]]:
    missing: list[dict[str, str]] = []
    family_map = {
        "official_records": "official",
        "community_signal": "community",
        "open_web_research": "web",
    }

    for opinion in raw_opinions:
        if not opinion.missing_evidence:
            continue
        missing.append(
            {
                "claim": request.event.question,
                "sourceFamily": family_map.get(opinion.judge_name, "web"),
                "reason": opinion.missing_evidence[0],
            }
        )

    return missing


FALLBACK_HALF_WIDTH_LOG_ODDS = 1.0
RELEVANCE_THRESHOLD = 4  # on the 1-6 scale (Halawi et al. 2024)
MIN_RELEVANT_ITEMS = 2
PRIOR_ONLY_FAMILIES = {"market", "prediction_market"}


def _stage(stage: str, status: str, **details) -> dict:
    return {"stage": stage, "status": status, "details": details}


def _rate_relevance(
    request: JudgeRequest,
    evidence: list[EvidenceItem],
    llm: LLMClient,
) -> tuple[list[EvidenceItem], dict, bool]:
    """Stage 3: rate each evidence item 1-6 for the question, keep >= threshold, and
    replace snippets with question-focused summaries. Market items feed the prior and are
    never rated. Returns (evidence for the panel, stage record, enough relevant evidence)."""
    candidates = [item for item in evidence if str(item.sourceFamily) not in PRIOR_ONLY_FAMILIES]
    market_items = [item for item in evidence if str(item.sourceFamily) in PRIOR_ONLY_FAMILIES]
    rate = getattr(llm, "rate_evidence", None)
    if request.prior_only or not candidates or not callable(rate):
        reason = "prior-only request" if request.prior_only else "no rateable evidence" if not candidates else "client cannot rate"
        return evidence, _stage("relevance_rating", "skipped", reason=reason), True

    model = str(getattr(llm, "utility_model_version", getattr(llm, "model_version", "fake-llm")))
    try:
        ratings = rate(event=request.event, evidence=candidates, evaluation_time=request.evaluation_time)
    except LLMError as error:
        return evidence, _stage("relevance_rating", "failed", model=model, error=str(error)[:300], fallback="unfiltered"), True

    by_id = {rating["id"]: rating for rating in ratings}
    kept: list[EvidenceItem] = []
    for item in candidates:
        rating = by_id.get(item.id)
        if rating is None:
            # The rater skipped it; keep the item rather than silently losing evidence.
            kept.append(item)
            continue
        if rating["relevance"] >= RELEVANCE_THRESHOLD:
            kept.append(
                item.model_copy(
                    update={
                        "summary": rating["summary"].strip() or item.summary,
                        "metadata": {**item.metadata, "originalSummary": item.summary, "relevance": rating["relevance"]},
                    }
                )
            )
    # Raw evidence quantity is gated upstream; this gate only fires when rating rejected
    # evidence and left less than the minimum.
    enough = len(kept) >= min(MIN_RELEVANT_ITEMS, len(candidates))
    record = _stage(
        "relevance_rating",
        "completed",
        model=model,
        threshold=RELEVANCE_THRESHOLD,
        rated=len(by_id),
        kept=len(kept),
        unrated=len(candidates) - len(by_id),
        scores={rating["id"]: rating["relevance"] for rating in ratings},
        insufficientRelevantEvidence=not enough,
    )
    return kept + market_items, record, enough


def _logit(probability: float) -> float:
    bounded = min(max(probability, 1e-6), 1 - 1e-6)
    return log(bounded / (1 - bounded))


# An estimate made without evidence should never be near-certain.
BASE_RATE_BOUNDS = (0.02, 0.98)


def _resolve_prior(request: JudgeRequest, evidence: list[EvidenceItem], llm: LLMClient) -> tuple[PriorResult, dict]:
    """Stage: pick the prior. A bound market or a sampled reference class settles it for
    free; only when neither exists is the model asked for an outside-view base rate."""
    related_markets_ignored = sum(
        1
        for item in evidence
        if str(item.sourceFamily) == "prediction_market" and (item.metadata or {}).get("matchedBy") == "search"
    )
    market_signals = extract_market_signal(evidence)
    prior = build_prior_log_odds(request.event, request.calibration_snapshot, market_signals=market_signals)
    status = "completed"
    details: dict = {}

    estimate = getattr(llm, "estimate_base_rate", None)
    if prior.source == "uninformed" and callable(estimate):
        try:
            estimated = estimate(event=request.event, evaluation_time=request.evaluation_time)
        except LLMError as error:
            estimated = None
            status = "failed"
            details = {"error": str(error)[:300], "fallback": "uninformed prior"}
        if estimated is not None:
            low, high = BASE_RATE_BOUNDS
            prior = build_prior_log_odds(
                request.event,
                request.calibration_snapshot,
                market_signals=market_signals,
                estimated_base_rate=min(max(float(estimated["probability"]), low), high),
            )
            details = {
                "model": str(getattr(llm, "model_version", "fake-llm")),
                "rationale": str(estimated.get("rationale", "")),
                "referenceClass": estimated.get("referenceClass") or None,
                "samples": estimated.get("samples") or None,
            }

    return prior, _stage(
        "prior",
        status,
        source=prior.source,
        probability=_log_odds_to_probability(prior.prior_log_odds),
        marketPrice=None if market_signals is None else market_signals.get("price"),
        marketLiquidity=None if market_signals is None else market_signals.get("depth"),
        relatedMarketsIgnored=related_markets_ignored,
        **{key: value for key, value in details.items() if value is not None},
    )


def _build_judge_trace(request: JudgeRequest, llm: LLMClient) -> VerdictTrace:
    ordered_evidence = _sort_evidence_for_judging(request.evidence)
    citations = [
        {
            "evidenceId": item.id,
            "provider": str(item.metadata.get("provider")) if item.metadata.get("provider") else None,
            "publishedAt": item.publishedAt,
            "title": item.title,
            "url": item.url,
            "sourceFamily": item.sourceFamily,
        }
        for item in ordered_evidence
    ] or [
        {
            "title": request.event.question,
            "url": "https://example.invalid/no-evidence",
            "sourceFamily": "web",
        }
    ]
    relevant_evidence, relevance_stage, enough_relevant = _rate_relevance(request, ordered_evidence, llm)
    # Prior-only runs (insufficient coverage, or too little relevant evidence after rating)
    # keep the evidence for the market prior and citations, but give the panel nothing to
    # read, so no panel or cross-examiner call is made.
    prior_only = request.prior_only or not enough_relevant
    panel_evidence = [] if prior_only else relevant_evidence
    # The three judges are independent (and may each fan out to an ensemble), so run them
    # concurrently; result order stays fixed.
    panel = (evaluate_official_records, evaluate_community_signal, evaluate_open_web_research)
    with ContextThreadPoolExecutor(max_workers=len(panel)) as pool:
        raw_opinions = list(
            pool.map(
                lambda evaluate: evaluate(
                    request.event, panel_evidence, llm=llm, evaluation_time=request.evaluation_time
                ),
                panel,
            )
        )
    samples_by_judge = {opinion.judge_name: opinion.samples for opinion in raw_opinions}
    informative_opinions = [opinion for opinion in raw_opinions if opinion.evidence_ids]
    cross_examiner = (
        evaluate_cross_examiner(informative_opinions, llm=llm)
        if len(informative_opinions) >= 2
        else CrossExaminerResult()
    )
    model_version = str(getattr(llm, "model_version", "fake-llm"))
    judge_names = [opinion.judge_name for opinion in raw_opinions]
    base_weights = default_judge_weights(judge_names)
    base_weights.update(
        {
            judge_name: float(weight)
            for judge_name, weight in request.calibration_snapshot.judgeWeights.items()
            if judge_name in base_weights and isinstance(weight, int | float)
        }
    )
    prior, prior_stage = _resolve_prior(request, ordered_evidence, llm)
    aggregate = aggregate_posterior(
        prior_log_odds=prior.prior_log_odds,
        raw_opinions=raw_opinions,
        base_weights=base_weights,
        evidence_lookup={item.id: item for item in relevant_evidence},
        evaluation_time=request.evaluation_time,
    )
    uses_bootstrap = len(aggregate.informative_contributions) >= 2
    if uses_bootstrap:
        interval = posterior_bootstrap_interval(
            prior_log_odds=prior.prior_log_odds,
            contributions=aggregate.informative_contributions,
            weighted_log_odds=aggregate.informative_weighted_log_odds,
            seed=11,
        )
        interval_low, interval_high = interval.low, interval.high
    else:
        # Too few informative judges to resample: report a fixed, explicitly labelled band.
        posterior_log_odds = _logit(aggregate.posterior_probability)
        interval_low = _log_odds_to_probability(posterior_log_odds - FALLBACK_HALF_WIDTH_LOG_ODDS)
        interval_high = _log_odds_to_probability(posterior_log_odds + FALLBACK_HALF_WIDTH_LOG_ODDS)
    calibration_method = request.calibration_snapshot.calibrationParams.get("method", "identity")
    if calibration_method not in {"identity", "isotonic", "logistic", "beta"}:
        calibration_method = "identity"

    final_probability = apply_probability_calibration(
        aggregate.posterior_probability,
        request.calibration_snapshot.calibrationParams,
    )
    calibrated_low = apply_probability_calibration(
        interval_low,
        request.calibration_snapshot.calibrationParams,
    )
    calibrated_high = apply_probability_calibration(
        interval_high,
        request.calibration_snapshot.calibrationParams,
    )
    confidence_low = min(calibrated_low, calibrated_high, final_probability)
    confidence_high = max(calibrated_low, calibrated_high, final_probability)
    pipeline_stages = [
        relevance_stage,
        prior_stage,
        _stage(
            "panel_reasoning",
            "skipped" if prior_only else "completed",
            models=model_version,
            judges={
                opinion.judge_name: {
                    "evidenceCount": len(opinion.evidence_ids),
                    "samples": len(opinion.samples),
                    "excludedSamples": sum(1 for sample in opinion.samples if sample.get("excluded")),
                }
                for opinion in raw_opinions
            },
        ),
        _stage(
            "cross_examination",
            "completed" if len(informative_opinions) >= 2 else "skipped",
            conflicts=len(cross_examiner.conflicts),
        ),
        _stage(
            "aggregation",
            "completed",
            priorProbability=_log_odds_to_probability(prior.prior_log_odds),
            marketPriorUsed=prior.market_probability is not None,
            rawPosteriorProbability=aggregate.raw_probability,
            disagreementShrinkage=aggregate.shrinkage,
        ),
        _stage(
            "calibration",
            "completed" if calibration_method != "identity" else "skipped",
            method=calibration_method,
            snapshotId=request.calibration_snapshot.id,
        ),
    ]

    return VerdictTrace.model_validate(
        {
            "id": f"trace-{uuid4()}",
            "eventId": request.event_id,
            "evaluationTime": request.evaluation_time,
            "referenceClass": request.event.referenceClass,
            "referenceClassFallback": None if not prior.reference_class_fallback else "global_baseline",
            "priorProbability": _log_odds_to_probability(prior.prior_log_odds),
            "rawPosteriorProbability": aggregate.raw_probability,
            "preCalibrationProbability": aggregate.posterior_probability,
            "finalProbability": final_probability,
            "confidenceLow": confidence_low,
            "confidenceHigh": confidence_high,
            "dependencyMatrix": aggregate.dependency_matrix,
            "disagreementShrinkage": aggregate.shrinkage,
            "judgeOpinions": [opinion.model_dump(by_alias=True, exclude_none=True) for opinion in aggregate.finalized_opinions],
            "weightBreakdown": [
                {
                    "source": opinion.judgeName,
                    "weight": opinion.baseWeight,
                    "details": {
                        "dependencyDiscount": opinion.dependencyDiscount,
                        "freshnessDecay": opinion.freshnessDecay,
                        "effectiveLogOddsContribution": opinion.effectiveLogOddsContribution,
                        **(
                            {"samples": samples_by_judge[opinion.judgeName]}
                            if samples_by_judge.get(opinion.judgeName)
                            else {}
                        ),
                    },
                }
                for opinion in aggregate.finalized_opinions
            ],
            "ensembleMethod": "logarithmic_opinion_pool",
            "calibrationMethod": calibration_method,
            "uncertaintyMethod": "bootstrap" if uses_bootstrap else "none",
            "weightRegime": select_regime(request.calibration_snapshot.resolvedOutcomeCount),
            "replayFidelity": "exact",
            "conflicts": cross_examiner.conflicts,
            "missingEvidence": _missing_evidence_records(request, raw_opinions),
            "citations": citations,
            "pipelineStages": pipeline_stages,
            "modelVersion": model_version,
            "weightVersion": request.calibration_snapshot.id,
            "calibrationVersion": request.calibration_snapshot.id,
            "status": "insufficient_evidence" if prior_only else "completed",
        }
    )


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/judge")
def judge(
    request: JudgeRequest,
    llm: LLMClient = Depends(_llm_dependency),
) -> dict:
    trace = _build_judge_trace(request, llm)
    return trace.model_dump(by_alias=True, exclude_none=True)


@router.post("/plan")
def plan(
    request: PlanRequest,
    llm: LLMClient = Depends(_llm_dependency),
) -> dict:
    """Stage 1: decompose the question into sub-questions with one search query each."""
    plan_queries = getattr(llm, "plan_queries", None)
    if not callable(plan_queries):
        return {"subQuestions": [], "queries": [], "model": None}
    try:
        result = plan_queries(event=request.event, evaluation_time=request.evaluation_time, max_queries=request.max_queries)
    except LLMError as error:
        raise HTTPException(status_code=502, detail=f"query planning failed: {str(error)[:300]}") from error

    seen: set[str] = {request.event.question.strip().lower()}
    queries: list[str] = []
    for query in result.get("queries", []):
        normalized = " ".join(str(query).split())
        if normalized and normalized.lower() not in seen:
            seen.add(normalized.lower())
            queries.append(normalized)
    return {
        "subQuestions": [" ".join(str(item).split()) for item in result.get("subQuestions", []) if str(item).strip()][
            : request.max_queries
        ],
        "queries": queries[: request.max_queries],
        "model": str(getattr(llm, "utility_model_version", getattr(llm, "model_version", "fake-llm"))),
    }


@router.post("/calibrate")
def calibrate(request: CalibrationRequest) -> dict:
    snapshot = fit_calibration_snapshot(
        historical_traces=[trace.model_dump(by_alias=True, exclude_none=True) for trace in request.historical_traces],
        resolved_outcomes=[outcome.model_dump(by_alias=True, exclude_none=True) for outcome in request.resolved_outcomes],
        market_price_pairs=[pair.model_dump() for pair in request.market_price_pairs],
    )
    return snapshot.model_dump(by_alias=True, exclude_none=True)
