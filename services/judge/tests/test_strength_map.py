import pytest

from app.models_generated import CalibrationSnapshot
from app.scoring.strength_map import DEFAULT_STRENGTH_TO_LOG_BF, from_calibration, to_log_bf


def _snapshot(weight_regime: str, overrides: dict[str, float] | None = None) -> CalibrationSnapshot:
    return CalibrationSnapshot.model_validate(
        {
            "id": "snapshot-1",
            "createdAt": "2026-01-01T00:00:00Z",
            "trainingWindow": "all_time",
            "judgeWeights": {},
            "baseRateParams": {},
            "marketPriorParams": {},
            "calibrationParams": {"strengthMap": overrides or {}},
            "onlineLearningParams": {},
            "metrics": {},
            "weightRegime": weight_regime,
            "resolvedOutcomeCount": 0,
            "approved": False,
        }
    )


def test_strength_map_is_monotonic_and_symmetric() -> None:
    values = [to_log_bf(level) for level in DEFAULT_STRENGTH_TO_LOG_BF]

    assert values == sorted(values)
    assert to_log_bf("strong_for") == -to_log_bf("strong_against")
    assert to_log_bf("moderate_for") == -to_log_bf("moderate_against")
    assert to_log_bf("weak_for") == -to_log_bf("weak_against")
    assert to_log_bf("neutral") == 0.0


def test_unknown_strength_raises() -> None:
    with pytest.raises(KeyError):
        to_log_bf("made_up_strength")


def test_calibration_overrides_only_apply_in_steady_regime() -> None:
    warming = from_calibration(_snapshot("warming", {"weak_for": 0.9}))
    steady = from_calibration(_snapshot("steady", {"weak_for": 0.9}))

    assert warming["weak_for"] == DEFAULT_STRENGTH_TO_LOG_BF["weak_for"]
    assert steady["weak_for"] == 0.9
