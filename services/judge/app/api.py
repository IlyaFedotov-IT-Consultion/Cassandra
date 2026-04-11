from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter

from app.models import CalibrationRequest, CalibrationSnapshot, JudgeOpinion, JudgeRequest, VerdictTrace


router = APIRouter()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _build_judge_trace(request: JudgeRequest) -> VerdictTrace:
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
    evidence_ids = [item.id for item in request.evidence]
    support_score = sum(1 for item in request.evidence if item.stance == "supports")
    contradiction_score = sum(1 for item in request.evidence if item.stance == "contradicts")
    directional_score = support_score - contradiction_score

    if directional_score >= 2:
        evidence_strength = "moderate_for"
        probability = 0.68
    elif directional_score == 1:
        evidence_strength = "weak_for"
        probability = 0.58
    elif directional_score <= -2:
        evidence_strength = "moderate_against"
        probability = 0.32
    elif directional_score == -1:
        evidence_strength = "weak_against"
        probability = 0.42
    else:
        evidence_strength = "neutral"
        probability = 0.5

    opinion = JudgeOpinion.model_validate(
        {
            "judgeName": "open_web_research",
            "probability": probability,
            "confidence": 0.7 if request.evidence else 0.55,
            "evidenceStrength": evidence_strength,
            "rationale": "Skeleton judge service uses shared-schema payloads and deterministic placeholder scoring.",
            "evidenceIds": evidence_ids,
            "warnings": [] if request.evidence else ["No evidence provided to judge endpoint."],
            "logBayesFactor": 0.5 if probability > 0.5 else -0.5 if probability < 0.5 else 0.0,
            "baseWeight": 1.0,
            "dependencyDiscount": 1.0,
            "freshnessDecay": 1.0,
            "effectiveLogOddsContribution": 0.5 if probability > 0.5 else -0.5 if probability < 0.5 else 0.0,
            "missingEvidence": [] if request.evidence else ["No evidence submitted with request."],
        }
    )

    return VerdictTrace.model_validate(
        {
            "id": f"trace-{request.calibration_snapshot.id}",
            "eventId": "event-from-request",
            "evaluationTime": request.evaluation_time,
            "referenceClass": request.event.referenceClass,
            "referenceClassFallback": None if request.event.referenceClass else "global_baseline",
            "priorProbability": 0.5,
            "rawPosteriorProbability": probability,
            "finalProbability": probability,
            "confidenceLow": max(0.0, probability - 0.1),
            "confidenceHigh": min(1.0, probability + 0.1),
            "dependencyMatrix": [],
            "disagreementShrinkage": 0.0,
            "judgeOpinions": [opinion.model_dump(by_alias=True)],
            "weightBreakdown": [
                {
                    "source": "open_web_research",
                    "weight": 1.0,
                    "details": {
                        "skeleton": True,
                    },
                }
            ],
            "ensembleMethod": "logarithmic_opinion_pool",
            "calibrationMethod": request.calibration_snapshot.calibrationParams.get("method", "identity"),
            "uncertaintyMethod": "none",
            "weightRegime": request.calibration_snapshot.weightRegime,
            "replayFidelity": "exact",
            "conflicts": [],
            "missingEvidence": [],
            "citations": citations,
            "modelVersion": "judge-service-skeleton-v1",
            "weightVersion": request.calibration_snapshot.id,
            "calibrationVersion": request.calibration_snapshot.id,
            "status": "completed",
        }
    )


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/judge", response_model=VerdictTrace)
def judge(request: JudgeRequest) -> VerdictTrace:
    return _build_judge_trace(request)


@router.post("/calibrate", response_model=CalibrationSnapshot)
def calibrate(request: CalibrationRequest) -> CalibrationSnapshot:
    resolved_outcome_count = len(request.resolved_outcomes)
    if resolved_outcome_count >= 100:
        regime = "steady"
        method = "isotonic"
    elif resolved_outcome_count >= 20:
        regime = "warming"
        method = "logistic"
    else:
        regime = "cold_start"
        method = "identity"

    return CalibrationSnapshot.model_validate(
        {
            "id": f"snapshot-{resolved_outcome_count}",
            "createdAt": _utc_now(),
            "trainingWindow": "all_time",
            "judgeWeights": {
                "official_records": 1 / 3,
                "community_signal": 1 / 3,
                "open_web_research": 1 / 3,
            },
            "baseRateParams": {},
            "marketPriorParams": {},
            "calibrationParams": {"method": method},
            "onlineLearningParams": {"enabled": regime != "cold_start"},
            "metrics": {
                "traceCount": len(request.historical_traces),
                "outcomeCount": resolved_outcome_count,
            },
            "weightRegime": regime,
            "resolvedOutcomeCount": resolved_outcome_count,
            "approved": False,
        }
    )
