from __future__ import annotations

from collections.abc import Mapping
from typing import Any


DEFAULT_STRENGTH_TO_LOG_BF: dict[str, float] = {
    "strong_against": -3.0,
    "moderate_against": -1.5,
    "weak_against": -0.5,
    "neutral": 0.0,
    "weak_for": 0.5,
    "moderate_for": 1.5,
    "strong_for": 3.0,
}


def _snapshot_value(snapshot: Any, field_name: str, default: Any) -> Any:
    if hasattr(snapshot, field_name):
        return getattr(snapshot, field_name)
    if isinstance(snapshot, Mapping):
        return snapshot.get(field_name, default)
    return default


def to_log_bf(strength: str, mapping: Mapping[str, float] | None = None) -> float:
    active_mapping = mapping or DEFAULT_STRENGTH_TO_LOG_BF
    return active_mapping[strength]


def from_calibration(snapshot: Any) -> dict[str, float]:
    weight_regime = _snapshot_value(snapshot, "weightRegime", "cold_start")
    calibration_params = _snapshot_value(snapshot, "calibrationParams", {})
    overrides = calibration_params.get("strengthMap", {}) if isinstance(calibration_params, Mapping) else {}

    if weight_regime != "steady":
      return dict(DEFAULT_STRENGTH_TO_LOG_BF)

    merged = dict(DEFAULT_STRENGTH_TO_LOG_BF)
    for key, value in overrides.items():
        if key in merged and isinstance(value, int | float):
            merged[key] = float(value)
    return merged
