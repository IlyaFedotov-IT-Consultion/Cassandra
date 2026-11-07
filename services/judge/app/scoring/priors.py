from __future__ import annotations

import json
from collections.abc import Mapping
from math import exp, isfinite, log
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


UNKNOWN_DEPTH_SUPPORT = 0.5
DEPTH_SCALE_USD = 50_000


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value) if isfinite(float(value)) else None
    if isinstance(value, str) and value.strip():
        try:
            parsed = float(value)
        except ValueError:
            return None
        return parsed if isfinite(parsed) else None
    return None


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip().startswith("["):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _yes_probability(metadata: Mapping[str, Any]) -> float | None:
    outcome = metadata.get("outcome")
    if isinstance(outcome, str) and outcome.strip().lower() != "yes":
        return None

    for key in ("probability", "yesPrice", "price", "lastTradePrice"):
        candidate = _as_float(metadata.get(key))
        if candidate is not None:
            return candidate

    prices = [_as_float(price) for price in _as_list(metadata.get("outcomePrices"))]
    outcomes = [str(item).strip().lower() for item in _as_list(metadata.get("outcomes"))]
    if not prices:
        return None
    if outcomes and len(outcomes) == len(prices):
        if "yes" not in outcomes:
            return None
        return prices[outcomes.index("yes")]
    return prices[0] if len(prices) == 2 else None


def extract_market_signal(evidence: list[Any]) -> dict[str, float | None] | None:
    """Return the most liquid prediction-market Yes probability, or None when absent.

    Only `prediction_market` evidence is a probability prior; traditional quotes
    (`market`) are prices, not event probabilities.
    """
    best: dict[str, float | None] | None = None
    best_rank = -1.0
    for item in evidence:
        if str(getattr(item, "sourceFamily", "")) != "prediction_market":
            continue
        metadata = getattr(item, "metadata", None) or {}
        probability = _yes_probability(metadata)
        if probability is None or not 0.0 <= probability <= 1.0:
            continue
        depth = _as_float(metadata.get("depth"))
        if depth is None:
            depth = _as_float(metadata.get("liquidity"))
        signal = {
            "price": probability,
            "depth": depth,
            "spread": _as_float(metadata.get("spread")),
            "volatility": _as_float(metadata.get("volatility")),
        }
        rank = depth if depth is not None else 0.0
        if rank > best_rank:
            best, best_rank = signal, rank
    return best


def liquidity_adjusted_market_probability(
    price: float,
    *,
    spread: float | None,
    depth: float | None,
    volatility: float | None,
) -> float:
    """Discount the market's log-odds toward 0 by observed spread, volatility and depth.

    Unobserved spread/volatility apply no penalty; unobserved depth gets partial trust.
    """
    spread_penalty = 1.0 if spread is None else max(0.0, 1.0 - min(spread, 0.9))
    volatility_penalty = 1.0 if volatility is None else max(0.0, 1.0 - min(volatility, 0.9))
    depth_support = (
        UNKNOWN_DEPTH_SUPPORT if depth is None else 1.0 - exp(-max(depth, 0.0) / DEPTH_SCALE_USD)
    )
    confidence = min(max(spread_penalty * volatility_penalty * depth_support, 0.0), 1.0)
    return 1 / (1 + exp(-confidence * _logit(price)))


def build_prior_log_odds(
    event: Any,
    snapshot: Any,
    market_signals: Mapping[str, float | None] | None = None,
) -> PriorResult:
    base_rate_params = getattr(snapshot, "baseRateParams", {}) or {}
    market_prior_params = getattr(snapshot, "marketPriorParams", {}) or {}
    reference_class = getattr(event, "referenceClass", None)
    minimum_sample = int(base_rate_params.get("minimumSample", 20))
    historical_counts = base_rate_params.get("historicalCounts", {})

    base_rate = empirical_bayes_base_rate(reference_class, historical_counts, minimum_sample)
    market_price = _as_float((market_signals or {}).get("price"))
    market_probability = (
        None
        if market_price is None
        else liquidity_adjusted_market_probability(
            market_price,
            spread=_as_float(market_signals.get("spread")),
            depth=_as_float(market_signals.get("depth")),
            volatility=_as_float(market_signals.get("volatility")),
        )
    )

    if market_probability is None:
        alpha = 0.0 if base_rate.used_fallback else 1.0
    elif base_rate.used_fallback:
        alpha = 0.0
    else:
        alpha = min(max(float(market_prior_params.get("defaultAlpha", 0.6)), 0.0), 1.0)

    market_log_odds = 0.0 if market_probability is None else _logit(market_probability)
    base_rate_log_odds = 0.0 if base_rate.used_fallback else _logit(base_rate.probability)
    prior_log_odds = alpha * base_rate_log_odds + (1 - alpha) * market_log_odds
    return PriorResult(
        prior_log_odds=prior_log_odds,
        base_rate_probability=base_rate.probability,
        market_probability=market_probability,
        alpha=alpha,
        reference_class_fallback=base_rate.used_fallback,
    )
