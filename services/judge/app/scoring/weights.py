from __future__ import annotations

from math import exp, log
from typing import Literal


WeightRegime = Literal["cold_start", "warming", "steady"]


def select_regime(resolved_outcome_count: int) -> WeightRegime:
    if resolved_outcome_count >= 100:
        return "steady"
    if resolved_outcome_count >= 20:
        return "warming"
    return "cold_start"


def default_judge_weights(judge_names: list[str]) -> dict[str, float]:
    if not judge_names:
        return {}
    uniform = 1.0 / len(judge_names)
    return {judge_name: uniform for judge_name in judge_names}


def _normalize(weights: dict[str, float]) -> dict[str, float]:
    total = sum(weights.values())
    if total <= 0:
        return default_judge_weights(list(weights))
    return {judge_name: value / total for judge_name, value in weights.items()}


def update_expert_weights(
    current_weights: dict[str, float],
    regrets: dict[str, float],
    resolved_outcome_count: int,
    base_step_size: float = 0.5,
    min_weight: float = 0.05,
    max_weight: float = 0.8,
) -> dict[str, float]:
    """Hedge update: each judge's weight is scaled by exp(-step * regret).

    `regrets` are cumulative over every resolved forecast, so the weights move further as
    evidence about a judge accumulates. A judge with no regret keeps its relative weight.
    """
    regime = select_regime(resolved_outcome_count)

    if regime == "cold_start":
        return dict(current_weights)

    step_size = base_step_size * (0.5 if regime == "warming" else 1.0)
    log_weights = {
        judge_name: log(weight) - step_size * regrets.get(judge_name, 0.0)
        for judge_name, weight in current_weights.items()
        if weight > 0
    }
    # Subtracting a shared offset preserves the normalized update and prevents
    # cumulative regrets from overflowing (or all weights from underflowing).
    maximum = max(log_weights.values(), default=0.0)
    updated = {
        judge_name: exp(log_weights[judge_name] - maximum) if judge_name in log_weights else 0.0
        for judge_name in current_weights
    }
    normalized = _normalize(updated)

    clipped = {
        judge_name: min(max_weight, max(min_weight, weight))
        for judge_name, weight in normalized.items()
    }
    return _normalize(clipped)
