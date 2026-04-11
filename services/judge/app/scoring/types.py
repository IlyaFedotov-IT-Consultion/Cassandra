from __future__ import annotations

from dataclasses import dataclass, field

from app.models_generated import JudgeOpinion


@dataclass(slots=True)
class RawJudgeOpinion:
    judge_name: str
    probability: float
    evidence_strength: str
    rationale: str
    evidence_ids: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    missing_evidence: list[str] = field(default_factory=list)


@dataclass(slots=True)
class CrossExaminerResult:
    conflicts: list[dict[str, str]] = field(default_factory=list)
    warnings_by_judge: dict[str, list[str]] = field(default_factory=dict)


@dataclass(slots=True)
class BaseRateResult:
    reference_class: str | None
    probability: float
    sample_size: int
    used_fallback: bool
    alpha: float


@dataclass(slots=True)
class PriorResult:
    prior_log_odds: float
    base_rate_probability: float
    market_probability: float
    alpha: float
    reference_class_fallback: bool


@dataclass(slots=True)
class AggregateResult:
    finalized_opinions: list[JudgeOpinion]
    dependency_matrix: list[dict[str, float | str]]
    raw_posterior_log_odds: float
    posterior_log_odds: float
    raw_probability: float
    posterior_probability: float
    shrinkage: float


@dataclass(slots=True)
class BootstrapInterval:
    low: float
    high: float
    mean: float
