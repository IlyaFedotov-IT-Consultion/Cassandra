from __future__ import annotations

from math import exp
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
    base_step_size: float = 0.2,
    min_weight: float = 0.05,
    max_weight: float = 0.8,
) -> dict[str, float]:
    regime = select_regime(resolved_outcome_count)

    if regime == "cold_start":
        return dict(current_weights)

    step_size = base_step_size * (0.5 if regime == "warming" else 1.0)
    updated = {
        judge_name: current_weights[judge_name] * exp(-step_size * regrets.get(judge_name, 0.0))
        for judge_name in current_weights
    }
    normalized = _normalize(updated)

    clipped = {
        judge_name: min(max_weight, max(min_weight, weight))
        for judge_name, weight in normalized.items()
    }
    return _normalize(clipped)
