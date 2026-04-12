from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha1

from fastapi import APIRouter, Depends

from app.llm import LLMClient, get_llm_client
from app.models import CalibrationRequest, CalibrationSnapshot, JudgeRequest, VerdictTrace
from app.scoring.aggregate import aggregate_posterior
from app.scoring.calibration import fit_calibration_snapshot
from app.scoring.judges.community_signal import evaluate as evaluate_community_signal
from app.scoring.judges.cross_examiner import evaluate as evaluate_cross_examiner
from app.scoring.judges.official_records import evaluate as evaluate_official_records
from app.scoring.judges.open_web_research import evaluate as evaluate_open_web_research
from app.scoring.priors import build_prior_log_odds
from app.scoring.uncertainty import bootstrap_confidence_interval
from app.scoring.weights import default_judge_weights, select_regime


router = APIRouter()


def _llm_dependency() -> LLMClient:
    return get_llm_client()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _event_id_for_request(question: str) -> str:
    return f"event-{sha1(question.encode('utf8')).hexdigest()[:12]}"


def _collect_market_signals(request: JudgeRequest) -> dict[str, float]:
    for item in request.evidence:
        if item.sourceFamily not in {"market", "prediction_market"}:
            continue

        price = item.metadata.get("price")
        spread = item.metadata.get("spread")
        depth = item.metadata.get("depth")
        volatility = item.metadata.get("volatility")
        if isinstance(price, int | float):
            return {
                "price": float(price),
                "spread": float(spread) if isinstance(spread, int | float) else 0.05,
                "depth": float(depth) if isinstance(depth, int | float) else 0.0,
                "volatility": float(volatility) if isinstance(volatility, int | float) else 0.1,
            }

    return {"price": 0.5, "spread": 0.05, "depth": 0.0, "volatility": 0.1}


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


def _cluster_groups(request: JudgeRequest, judge_probabilities: list[float]) -> list[list[float]]:
    if not request.evidence:
        return [[0.5]]

    by_family: dict[str, list[float]] = {}
    baseline = judge_probabilities or [0.5]
    for index, item in enumerate(request.evidence):
        family = str(item.sourceFamily)
        by_family.setdefault(family, []).append(baseline[index % len(baseline)])
    return list(by_family.values())


def _build_judge_trace(request: JudgeRequest, llm: LLMClient) -> VerdictTrace:
    citations = [
        {
            "title": item.title,
            "url": item.url,
            "sourceFamily": item.sourceFamily,
        }
        for item in request.evidence
    ] or [
        {
            "title": request.event.question,
            "url": "https://example.invalid/no-evidence",
            "sourceFamily": "web",
        }
    ]
    raw_opinions = [
        evaluate_official_records(request.event, request.evidence, llm=llm),
        evaluate_community_signal(request.event, request.evidence, llm=llm),
        evaluate_open_web_research(request.event, request.evidence, llm=llm),
    ]
    cross_examiner = evaluate_cross_examiner(raw_opinions, llm=llm)
    judge_names = [opinion.judge_name for opinion in raw_opinions]
    base_weights = default_judge_weights(judge_names)
    base_weights.update(
        {
            judge_name: float(weight)
            for judge_name, weight in request.calibration_snapshot.judgeWeights.items()
            if judge_name in base_weights and isinstance(weight, int | float)
        }
    )
    prior = build_prior_log_odds(
        request.event,
        request.calibration_snapshot,
        market_signals=_collect_market_signals(request),
    )
    aggregate = aggregate_posterior(
        prior_log_odds=prior.prior_log_odds,
        raw_opinions=raw_opinions,
        base_weights=base_weights,
        evidence_lookup={item.id: item for item in request.evidence},
        evaluation_time=request.evaluation_time,
    )
    interval = bootstrap_confidence_interval(
        cluster_groups=_cluster_groups(
            request,
            [opinion.probability for opinion in aggregate.finalized_opinions],
        ),
        judge_probabilities=[opinion.probability for opinion in aggregate.finalized_opinions],
        seed=11,
    )
    calibration_method = request.calibration_snapshot.calibrationParams.get("method", "identity")
    if calibration_method not in {"identity", "isotonic", "logistic", "beta"}:
        calibration_method = "identity"

    final_probability = aggregate.posterior_probability
    confidence_low = min(interval.low, final_probability)
    confidence_high = max(interval.high, final_probability)

    return VerdictTrace.model_validate(
        {
            "id": f"trace-{request.calibration_snapshot.id}",
            "eventId": _event_id_for_request(request.event.question),
            "evaluationTime": request.evaluation_time,
            "referenceClass": request.event.referenceClass,
            "referenceClassFallback": None if not prior.reference_class_fallback else "global_baseline",
            "priorProbability": prior.base_rate_probability if prior.alpha > 0 else prior.market_probability,
            "rawPosteriorProbability": aggregate.raw_probability,
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
                    },
                }
                for opinion in aggregate.finalized_opinions
            ],
            "ensembleMethod": "logarithmic_opinion_pool",
            "calibrationMethod": calibration_method,
            "uncertaintyMethod": "bootstrap",
            "weightRegime": select_regime(request.calibration_snapshot.resolvedOutcomeCount),
            "replayFidelity": "exact",
            "conflicts": cross_examiner.conflicts,
            "missingEvidence": _missing_evidence_records(request, raw_opinions),
            "citations": citations,
            "modelVersion": "judge-service-task9-v1",
            "weightVersion": request.calibration_snapshot.id,
            "calibrationVersion": request.calibration_snapshot.id,
            "status": "completed",
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


@router.post("/calibrate")
def calibrate(request: CalibrationRequest) -> dict:
    snapshot = fit_calibration_snapshot(
        historical_traces=[trace.model_dump(by_alias=True, exclude_none=True) for trace in request.historical_traces],
        resolved_outcomes=[outcome.model_dump(by_alias=True, exclude_none=True) for outcome in request.resolved_outcomes],
    )
    return snapshot.model_dump(by_alias=True, exclude_none=True)
