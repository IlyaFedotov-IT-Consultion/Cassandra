from __future__ import annotations

from dataclasses import replace
from datetime import datetime
from math import exp, log
from statistics import mean

from app.models_generated import EvidenceItem, JudgeOpinion
from app.scoring.strength_map import DEFAULT_STRENGTH_TO_LOG_BF, to_log_bf
from app.scoring.types import AggregateResult, RawJudgeOpinion


def probability_to_log_odds(probability: float) -> float:
    bounded = min(max(probability, 1e-6), 1 - 1e-6)
    return log(bounded / (1 - bounded))


def log_odds_to_probability(log_odds: float) -> float:
    return 1 / (1 + exp(-log_odds))


def jaccard_overlap_matrix(raw_opinions: list[RawJudgeOpinion]) -> dict[tuple[str, str], float]:
    matrix: dict[tuple[str, str], float] = {}
    for left in raw_opinions:
        left_ids = set(left.evidence_ids)
        for right in raw_opinions:
            if left.judge_name == right.judge_name:
                continue
            right_ids = set(right.evidence_ids)
            union = left_ids | right_ids
            matrix[(left.judge_name, right.judge_name)] = (
                len(left_ids & right_ids) / len(union) if union else 0.0
            )
    return matrix


def dependency_discounts(
    matrix: dict[tuple[str, str], float],
    judge_names: list[str] | None = None,
) -> dict[str, float]:
    names = judge_names or sorted({name for pair in matrix for name in pair})
    return {
        judge_name: 1 / (1 + sum(value for (left, _), value in matrix.items() if left == judge_name))
        for judge_name in names
    }


def disagreement_shrinkage(
    weighted_log_odds: list[float],
    *,
    k_disagree: float = 0.25,
    shrinkage_max: float = 0.6,
) -> float:
    if not weighted_log_odds or len(set(weighted_log_odds)) <= 1:
        return 0.0
    average = mean(weighted_log_odds)
    dispersion = mean((value - average) ** 2 for value in weighted_log_odds)
    return min(max(k_disagree * dispersion, 0.0), shrinkage_max)


FAMILY_HALF_LIFE_HOURS: dict[str, float] = {
    "official": 24 * 90,
    "government": 24 * 90,
    "web": 24 * 14,
    "llm_research": 24 * 14,
    "community": 24 * 3,
    "market": 24,
    "prediction_market": 24,
}
DEFAULT_HALF_LIFE_HOURS = 24 * 14
FRESHNESS_FLOOR = 0.1
UNKNOWN_DATE_FRESHNESS = 0.5


def item_freshness(item: EvidenceItem, evaluation_time: str) -> float:
    """Freshness for one item; undated items (publishedAt is only a retrieval placeholder) get a neutral 0.5."""
    if (item.metadata or {}).get("publishedAtSource") == "unknown":
        return UNKNOWN_DATE_FRESHNESS
    return freshness_decay(item.publishedAt, evaluation_time, source_family=str(item.sourceFamily))


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def freshness_decay(
    published_at: str,
    evaluation_time: str,
    *,
    source_family: str | None = None,
    half_life_hours: float | None = None,
) -> float:
    """Half-life decay (0.5 after one half-life) per source family, floored at FRESHNESS_FLOOR."""
    half_life = half_life_hours or FAMILY_HALF_LIFE_HOURS.get(
        source_family or "", DEFAULT_HALF_LIFE_HOURS
    )
    age_hours = max(
        0.0,
        (_parse_timestamp(evaluation_time) - _parse_timestamp(published_at)).total_seconds() / 3600,
    )
    return max(FRESHNESS_FLOOR, 0.5 ** (age_hours / half_life))


def evidence_quality_modifier(evidence_items: list[EvidenceItem]) -> float:
    if not evidence_items:
        return 1.0

    scores: list[float] = []
    for item in evidence_items:
        quality = 1.0
        citation_count = item.qualitySignals.get("citationCount", 0)
        duplicate_cluster_size = item.qualitySignals.get("duplicateClusterSize", 1)
        if item.qualitySignals.get("officialDomain"):
            quality += 0.15
        if item.qualitySignals.get("governmentDomain"):
            quality += 0.15
        if isinstance(citation_count, int | float):
            quality += min(float(citation_count), 5.0) * 0.05
        if isinstance(duplicate_cluster_size, int | float):
            quality -= max(float(duplicate_cluster_size) - 1, 0.0) * 0.05
        scores.append(min(max(quality, 0.5), 1.5))

    return min(max(mean(scores), 0.5), 1.5)


def finalize_judge_opinion(
    raw: RawJudgeOpinion,
    *,
    log_bayes_factor: float,
    base_weight: float,
    dependency_discount: float,
    freshness: float,
    effective_log_odds_contribution: float,
) -> JudgeOpinion:
    confidence = min(max(0.55 + 0.1 * abs(log_bayes_factor), 0.0), 1.0)
    return JudgeOpinion.model_validate(
        {
            "judgeName": raw.judge_name,
            "probability": raw.probability,
            "confidence": confidence,
            "evidenceStrength": raw.evidence_strength,
            "rationale": raw.rationale,
            "evidenceIds": raw.evidence_ids,
            "warnings": raw.warnings,
            "logBayesFactor": log_bayes_factor,
            "baseWeight": base_weight,
            "dependencyDiscount": dependency_discount,
            "freshnessDecay": freshness,
            "effectiveLogOddsContribution": effective_log_odds_contribution,
            "missingEvidence": raw.missing_evidence,
        }
    )


def aggregate_posterior(
    *,
    prior_log_odds: float,
    raw_opinions: list[RawJudgeOpinion],
    base_weights: dict[str, float],
    evidence_lookup: dict[str, EvidenceItem],
    evaluation_time: str,
    strength_mapping: dict[str, float] | None = None,
) -> AggregateResult:
    mapping = strength_mapping or DEFAULT_STRENGTH_TO_LOG_BF
    overlap_matrix = jaccard_overlap_matrix(raw_opinions)
    discounts = dependency_discounts(overlap_matrix, [opinion.judge_name for opinion in raw_opinions])
    finalized_opinions: list[JudgeOpinion] = []
    weighted_log_odds: list[float] = []
    raw_posterior_log_odds = prior_log_odds

    informative_contributions: list[float] = []

    for raw in raw_opinions:
        evidence_items = [evidence_lookup[evidence_id] for evidence_id in raw.evidence_ids if evidence_id in evidence_lookup]
        if not evidence_items:
            # Absence of evidence is not evidence: the judge cannot move the posterior
            # and must not register as disagreement.
            raw = replace(
                raw,
                evidence_strength="neutral",
                log_bayes_factor=None,
                warnings=[*raw.warnings, "Opinion neutralized: no cited evidence was available."],
            )
        log_bayes_factor = (
            raw.log_bayes_factor
            if raw.log_bayes_factor is not None
            else to_log_bf(raw.evidence_strength, mapping)
        )
        base_weight = base_weights.get(raw.judge_name, 1.0)
        dependency_discount = discounts.get(raw.judge_name, 1.0)
        freshness = (
            mean(
                [item_freshness(item, evaluation_time) for item in evidence_items]
            )
            if evidence_items
            else 1.0
        )
        quality = evidence_quality_modifier(evidence_items)
        effective = base_weight * dependency_discount * quality * freshness * log_bayes_factor
        raw_posterior_log_odds += effective
        if evidence_items:
            weighted_log_odds.append(base_weight * log_bayes_factor)
            informative_contributions.append(effective)
        finalized_opinions.append(
            finalize_judge_opinion(
                raw,
                log_bayes_factor=log_bayes_factor,
                base_weight=base_weight,
                dependency_discount=dependency_discount,
                freshness=freshness,
                effective_log_odds_contribution=effective,
            )
        )

    shrinkage = disagreement_shrinkage(weighted_log_odds)
    posterior_log_odds = (1 - shrinkage) * raw_posterior_log_odds + shrinkage * prior_log_odds
    dependency_matrix = [
        {"judgeA": left, "judgeB": right, "jaccard": value}
        for (left, right), value in overlap_matrix.items()
        if left < right
    ]
    return AggregateResult(
        finalized_opinions=finalized_opinions,
        dependency_matrix=dependency_matrix,
        raw_posterior_log_odds=raw_posterior_log_odds,
        posterior_log_odds=posterior_log_odds,
        raw_probability=log_odds_to_probability(raw_posterior_log_odds),
        posterior_probability=log_odds_to_probability(posterior_log_odds),
        shrinkage=shrinkage,
        informative_contributions=informative_contributions,
        informative_weighted_log_odds=weighted_log_odds,
    )
