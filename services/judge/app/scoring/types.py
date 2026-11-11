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
    # Ensembles report an aggregated log Bayes factor that may fall between labels.
    log_bayes_factor: float | None = None
    samples: list[dict] = field(default_factory=list)


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
    market_probability: float | None
    alpha: float
    reference_class_fallback: bool
    # "market", "reference_class", "estimated_base_rate" or "uninformed".
    source: str = "uninformed"


@dataclass(slots=True)
class AggregateResult:
    finalized_opinions: list[JudgeOpinion]
    dependency_matrix: list[dict[str, float | str]]
    raw_posterior_log_odds: float
    posterior_log_odds: float
    raw_probability: float
    posterior_probability: float
    shrinkage: float
    informative_contributions: list[float] = field(default_factory=list)
    informative_weighted_log_odds: list[float] = field(default_factory=list)


@dataclass(slots=True)
class BootstrapInterval:
    low: float
    high: float
    mean: float
