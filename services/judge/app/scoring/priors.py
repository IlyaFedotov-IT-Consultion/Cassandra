from __future__ import annotations

from collections.abc import Mapping
from math import exp, log
from typing import Any

from app.scoring.types import BaseRateResult, PriorResult


def _logit(probability: float) -> float:
    bounded = min(max(probability, 1e-6), 1 - 1e-6)
    return log(bounded / (1 - bounded))


def empirical_bayes_base_rate(
    reference_class: str | None,
    historical_counts: Mapping[str, Mapping[str, int]] | None,
    minimum_sample: int = 20,
) -> BaseRateResult:
    if not reference_class or not historical_counts:
        return BaseRateResult(
            reference_class=reference_class,
            probability=0.5,
            sample_size=0,
            used_fallback=True,
            alpha=0.0,
        )

    counts = historical_counts.get(reference_class, {})
    successes = int(counts.get("successes", 0))
    total = int(counts.get("total", 0))

    if total <= 0:
        return BaseRateResult(
            reference_class=reference_class,
            probability=0.5,
            sample_size=0,
            used_fallback=True,
            alpha=0.0,
        )

    probability = (successes + 1) / (total + 2)
    return BaseRateResult(
        reference_class=reference_class,
        probability=probability,
        sample_size=total,
        used_fallback=total < minimum_sample,
        alpha=min(total / minimum_sample, 1.0),
    )


def build_base_rate_params(
    joined_pairs: list[dict[str, Any]],
    *,
    minimum_sample: int = 20,
) -> dict[str, Any]:
    historical_counts: dict[str, dict[str, int]] = {}
    for pair in joined_pairs:
        reference_class = str(pair.get("referenceClass") or "unknown")
        counts = historical_counts.setdefault(reference_class, {"successes": 0, "total": 0})
        counts["total"] += 1
        counts["successes"] += int(bool(pair.get("outcome")))

    total_successes = sum(counts["successes"] for counts in historical_counts.values())
    total_events = sum(counts["total"] for counts in historical_counts.values())

    return {
        "minimumSample": minimum_sample,
        "historicalCounts": {
            reference_class: {
                "successes": counts["successes"],
                "total": counts["total"],
            }
            for reference_class, counts in sorted(historical_counts.items())
        },
        "globalCounts": {
            "successes": total_successes,
            "total": total_events,
        },
    }


def build_market_prior_params(base_rate_params: Mapping[str, Any]) -> dict[str, Any]:
    historical_counts = base_rate_params.get("historicalCounts", {}) or {}
    minimum_sample = int(base_rate_params.get("minimumSample", 20))
    totals = [int(counts.get("total", 0)) for counts in historical_counts.values() if int(counts.get("total", 0)) > 0]

    if totals:
        weighted_confidence = sum(
            total * (total / (total + minimum_sample))
            for total in totals
        ) / sum(totals)
    else:
        weighted_confidence = 0.0

    return {
        "defaultAlpha": weighted_confidence,
        "minimumSample": minimum_sample,
        "sampleSize": sum(totals),
        "referenceClassCount": len(totals),
    }


def liquidity_adjusted_market_probability(
    price: float,
    *,
    spread: float,
    depth: float,
    volatility: float,
) -> float:
    bounded_price = min(max(price, 1e-6), 1 - 1e-6)
    spread_penalty = max(0.0, 1.0 - min(spread, 0.9))
    volatility_penalty = max(0.0, 1.0 - min(volatility, 0.9))
    depth_support = 1.0 - exp(-max(depth, 0.0) / 50_000)
    confidence = min(max(spread_penalty * volatility_penalty * depth_support, 0.0), 1.0)
    return 0.5 + confidence * (bounded_price - 0.5)


def build_prior_log_odds(
    event: Any,
    snapshot: Any,
    market_signals: Mapping[str, float] | None = None,
) -> PriorResult:
    base_rate_params = getattr(snapshot, "baseRateParams", {}) or {}
    market_prior_params = getattr(snapshot, "marketPriorParams", {}) or {}
    reference_class = getattr(event, "referenceClass", None)
    minimum_sample = int(base_rate_params.get("minimumSample", 20))
    historical_counts = base_rate_params.get("historicalCounts", {})

    base_rate = empirical_bayes_base_rate(reference_class, historical_counts, minimum_sample)
    market_probability = liquidity_adjusted_market_probability(
        (market_signals or {}).get("price", 0.5),
        spread=(market_signals or {}).get("spread", 0.05),
        depth=(market_signals or {}).get("depth", 0.0),
        volatility=(market_signals or {}).get("volatility", 0.1),
    )

    if base_rate.used_fallback:
        alpha = 0.0
    else:
        alpha = min(max(float(market_prior_params.get("defaultAlpha", 0.6)), 0.0), 1.0)

    prior_log_odds = alpha * _logit(base_rate.probability) + (1 - alpha) * _logit(market_probability)
    return PriorResult(
        prior_log_odds=prior_log_odds,
        base_rate_probability=base_rate.probability,
        market_probability=market_probability,
        alpha=alpha,
        reference_class_fallback=base_rate.used_fallback,
    )
