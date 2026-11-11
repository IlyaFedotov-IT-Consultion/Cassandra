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
    """Return the most liquid Yes probability of a market bound to this event, or None.

    Only `prediction_market` evidence is a probability prior; traditional quotes
    (`market`) are prices, not event probabilities. Markets the provider found by search
    (`matchedBy: "search"`) answer a related question, not this one, so they never set
    the prior.
    """
    best: dict[str, float | None] | None = None
    best_rank = -1.0
    for item in evidence:
        if str(getattr(item, "sourceFamily", "")) != "prediction_market":
            continue
        metadata = getattr(item, "metadata", None) or {}
        if metadata.get("matchedBy") == "search":
            continue
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


def market_trust_probability(price: float, market_prior_params: Mapping[str, Any] | None) -> float:
    """Map a market price through the trust curve fitted on resolved benchmark markets.

    `trustSlope` and `trustIntercept` are a Platt fit of outcomes on market log-odds
    (see `fit_market_trust`). Until a snapshot carries a fit the price is used as is:
    the identity is the only map that assumes nothing about how markets misprice.
    """
    params = market_prior_params or {}
    slope = _as_float(params.get("trustSlope"))
    intercept = _as_float(params.get("trustIntercept"))
    log_odds = (1.0 if slope is None else slope) * _logit(price) + (0.0 if intercept is None else intercept)
    return 1 / (1 + exp(-log_odds))


def build_prior_log_odds(
    event: Any,
    snapshot: Any,
    market_signals: Mapping[str, float | None] | None = None,
    estimated_base_rate: float | None = None,
) -> PriorResult:
    """The prior comes from the best source available, in this order: the bound market's
    price, the reference class's observed base rate, a base rate estimated for this
    question, and otherwise an uninformed 0.5.

    Sources are not blended. A market price already reflects base rates, so mixing a
    reference-class rate back in would count that information twice.
    """
    base_rate_params = getattr(snapshot, "baseRateParams", {}) or {}
    market_prior_params = getattr(snapshot, "marketPriorParams", {}) or {}
    reference_class = getattr(event, "referenceClass", None)
    minimum_sample = int(base_rate_params.get("minimumSample", 20))
    historical_counts = base_rate_params.get("historicalCounts", {})

    base_rate = empirical_bayes_base_rate(reference_class, historical_counts, minimum_sample)
    market_price = _as_float((market_signals or {}).get("price"))
    market_probability = (
        None if market_price is None else market_trust_probability(market_price, market_prior_params)
    )

    if market_probability is not None:
        source, prior_log_odds, alpha = "market", _logit(market_probability), 0.0
    elif not base_rate.used_fallback:
        source, prior_log_odds, alpha = "reference_class", _logit(base_rate.probability), 1.0
    elif estimated_base_rate is not None:
        source, prior_log_odds, alpha = "estimated_base_rate", _logit(estimated_base_rate), 0.0
    else:
        source, prior_log_odds, alpha = "uninformed", 0.0, 0.0

    return PriorResult(
        prior_log_odds=prior_log_odds,
        base_rate_probability=base_rate.probability,
        market_probability=market_probability,
        alpha=alpha,
        reference_class_fallback=base_rate.used_fallback,
        source=source,
    )
