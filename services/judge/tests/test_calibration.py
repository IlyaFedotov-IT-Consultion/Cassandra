from app.main import app
from app.scoring.calibration import (
    apply_probability_calibration,
    brier_score,
    calibration_error_by_reference_class,
    expected_calibration_error,
    fit_calibration_snapshot,
    log_loss,
    pool_adjacent_violators,
    reliability_bins,
)
from fastapi.testclient import TestClient


client = TestClient(app)


def test_metric_calculations_are_deterministic() -> None:
    pairs = [
        {"predicted": 0.8, "outcome": 1},
        {"predicted": 0.7, "outcome": 1},
        {"predicted": 0.3, "outcome": 0},
        {"predicted": 0.4, "outcome": 0},
    ]

    assert round(brier_score(pairs), 4) == 0.095
    assert round(log_loss(pairs), 4) == 0.3618
    assert expected_calibration_error(pairs, bins=2) >= 0.0
    assert reliability_bins(pairs, bins=2)


def test_probability_calibration_applies_stored_maps() -> None:
    logistic = apply_probability_calibration(
        0.5,
        {"method": "logistic", "slope": 1.0, "intercept": 1.0},
    )
    isotonic = apply_probability_calibration(
        0.6,
        {
            "method": "isotonic",
            "thresholds": [0.2, 0.5, 0.8],
            "outputs": [0.1, 0.4, 0.9],
        },
    )

    assert logistic > 0.5
    assert round(isotonic, 3) == 0.567


def test_calibration_error_by_reference_class_groups_metrics() -> None:
    traces = [
        {"referenceClass": "product_launch", "predicted": 0.7, "outcome": 1},
        {"referenceClass": "product_launch", "predicted": 0.6, "outcome": 0},
        {"referenceClass": "election", "predicted": 0.8, "outcome": 1},
    ]

    grouped = calibration_error_by_reference_class(traces)

    assert set(grouped) == {"product_launch", "election"}
    assert grouped["product_launch"]["sampleSize"] == 2


def test_cold_start_snapshot_uses_identity_and_uniform_weights() -> None:
    snapshot = fit_calibration_snapshot(
        historical_traces=[],
        resolved_outcomes=[],
    )

    assert snapshot.weightRegime == "cold_start"
    assert snapshot.calibrationParams["method"] == "identity"
    assert snapshot.judgeWeights == {
        "official_records": 1 / 3,
        "community_signal": 1 / 3,
        "open_web_research": 1 / 3,
    }


def test_snapshot_persists_learned_prior_params() -> None:
    traces = [
        {
            "eventId": f"event-{index}",
            "referenceClass": "product_launch",
            "finalProbability": 0.6 if index % 2 == 0 else 0.4,
            "judgeOpinions": [
                {"judgeName": "official_records", "probability": 0.6},
                {"judgeName": "community_signal", "probability": 0.5},
                {"judgeName": "open_web_research", "probability": 0.55},
            ],
        }
        for index in range(4)
    ]
    outcomes = [
        {"eventId": f"event-{index}", "resolvedValue": index % 2 == 0}
        for index in range(4)
    ]

    snapshot = fit_calibration_snapshot(
        historical_traces=traces,
        resolved_outcomes=outcomes,
    )

    assert snapshot.baseRateParams["minimumSample"] == 20
    assert snapshot.baseRateParams["historicalCounts"]["product_launch"] == {
        "successes": 2,
        "total": 4,
    }
    assert snapshot.marketPriorParams["sampleSize"] == 4
    assert snapshot.marketPriorParams["referenceClassCount"] == 1
    assert 0.0 < snapshot.marketPriorParams["defaultAlpha"] < 1.0


def test_warming_snapshot_uses_logistic_style_calibration_and_online_updates() -> None:
    traces = [
        {
            "eventId": f"event-{index}",
            "referenceClass": "product_launch",
            "finalProbability": 0.65 if index % 2 == 0 else 0.35,
            "judgeOpinions": [
                {"judgeName": "official_records", "probability": 0.7 if index % 2 == 0 else 0.3},
                {"judgeName": "community_signal", "probability": 0.55},
                {"judgeName": "open_web_research", "probability": 0.6 if index % 2 == 0 else 0.4},
            ],
        }
        for index in range(20)
    ]
    outcomes = [
        {"eventId": f"event-{index}", "resolvedValue": index % 2 == 0}
        for index in range(20)
    ]

    snapshot = fit_calibration_snapshot(
        historical_traces=traces,
        resolved_outcomes=outcomes,
    )

    assert snapshot.weightRegime == "warming"
    assert snapshot.calibrationParams["method"] in {"logistic", "beta"}
    assert snapshot.onlineLearningParams["stepSizeScale"] == 0.5


def test_steady_snapshot_uses_monotonic_isotonic_output() -> None:
    traces = [
        {
            "eventId": f"event-{index}",
            "referenceClass": "product_launch",
            "finalProbability": min(0.95, max(0.05, index / 120)),
            "judgeOpinions": [
                {"judgeName": "official_records", "probability": min(0.95, max(0.05, index / 120))},
                {"judgeName": "community_signal", "probability": 0.5},
                {"judgeName": "open_web_research", "probability": min(0.95, max(0.05, index / 140))},
            ],
        }
        for index in range(100)
    ]
    outcomes = [
        {"eventId": f"event-{index}", "resolvedValue": index >= 50}
        for index in range(100)
    ]

    snapshot = fit_calibration_snapshot(
        historical_traces=traces,
        resolved_outcomes=outcomes,
    )

    assert snapshot.weightRegime == "steady"
    assert snapshot.calibrationParams["method"] == "isotonic"
    outputs = snapshot.calibrationParams["outputs"]
    assert outputs == sorted(outputs)


def test_calibrate_endpoint_returns_versioned_snapshot_payload() -> None:
    response = client.post(
        "/calibrate",
        json={
            "historicalTraces": [],
            "resolvedOutcomes": [],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["weightRegime"] == "cold_start"
    assert payload["resolvedOutcomeCount"] == 0


def _calibrated_pairs(count: int, seed: int) -> list[dict]:
    import random

    rng = random.Random(seed)
    pairs = []
    for _ in range(count):
        probability = rng.random()
        pairs.append({"predicted": probability, "outcome": 1 if rng.random() < probability else 0})
    return pairs


def _traces_for(pairs: list[dict], **trace_fields) -> tuple[list[dict], list[dict]]:
    traces = [
        {
            "eventId": f"event-{index}",
            "evaluationTime": "2026-01-01T00:00:00Z",
            "referenceClass": None,
            "finalProbability": pair["predicted"],
            "judgeOpinions": [],
            **trace_fields,
        }
        for index, pair in enumerate(pairs)
    ]
    outcomes = [
        {
            "eventId": f"event-{index}",
            "resolvedValue": bool(pair["outcome"]),
            "resolvedAt": "2026-02-01T00:00:00Z",
        }
        for index, pair in enumerate(pairs)
    ]
    return traces, outcomes


def test_pool_adjacent_violators_pools_decreasing_runs() -> None:
    assert pool_adjacent_violators([0.0, 1.0, 0.0, 1.0]) == [0.0, 0.5, 0.5, 1.0]
    assert pool_adjacent_violators([1.0, 0.0, 0.0]) == [1 / 3, 1 / 3, 1 / 3]


def test_isotonic_fit_on_calibrated_forecasts_stays_close_to_identity() -> None:
    traces, outcomes = _traces_for(_calibrated_pairs(2000, seed=7))

    snapshot = fit_calibration_snapshot(historical_traces=traces, resolved_outcomes=outcomes)

    assert snapshot.calibrationParams["method"] == "isotonic"
    for probability in (0.1, 0.3, 0.5, 0.7, 0.9):
        assert abs(apply_probability_calibration(probability, snapshot.calibrationParams) - probability) < 0.08


def test_logistic_fit_corrects_overconfident_forecasts() -> None:
    pairs = [{"predicted": 0.9, "outcome": index % 2} for index in range(30)]
    pairs += [{"predicted": 0.1, "outcome": index % 2} for index in range(30)]
    traces, outcomes = _traces_for(pairs)

    snapshot = fit_calibration_snapshot(historical_traces=traces, resolved_outcomes=outcomes)

    assert snapshot.weightRegime == "warming"
    assert 0.4 < apply_probability_calibration(0.9, snapshot.calibrationParams) < 0.6
    assert 0.4 < apply_probability_calibration(0.1, snapshot.calibrationParams) < 0.6


def test_logistic_fit_keeps_calibrated_forecasts_near_identity() -> None:
    traces, outcomes = _traces_for(_calibrated_pairs(80, seed=11))

    snapshot = fit_calibration_snapshot(historical_traces=traces, resolved_outcomes=outcomes)

    assert abs(apply_probability_calibration(0.8, snapshot.calibrationParams) - 0.8) < 0.12


def test_calibration_fits_on_pre_calibration_probability() -> None:
    pairs = [{"predicted": 0.9, "outcome": index % 2} for index in range(30)]
    pairs += [{"predicted": 0.1, "outcome": index % 2} for index in range(30)]
    traces, outcomes = _traces_for(pairs, calibrationMethod="logistic")
    for trace, pair in zip(traces, pairs):
        trace["preCalibrationProbability"] = pair["predicted"]
        trace["finalProbability"] = 0.5

    snapshot = fit_calibration_snapshot(historical_traces=traces, resolved_outcomes=outcomes)

    assert snapshot.resolvedOutcomeCount == 60
    assert apply_probability_calibration(0.9, snapshot.calibrationParams) < 0.6


def test_calibration_skips_calibrated_traces_without_a_pre_calibration_probability() -> None:
    traces, outcomes = _traces_for(_calibrated_pairs(30, seed=3), calibrationMethod="logistic")

    snapshot = fit_calibration_snapshot(historical_traces=traces, resolved_outcomes=outcomes)

    assert snapshot.resolvedOutcomeCount == 0
    assert snapshot.weightRegime == "cold_start"


def test_calibration_ignores_judgments_made_after_resolution() -> None:
    traces, outcomes = _traces_for(_calibrated_pairs(30, seed=5))
    for trace in traces[:15]:
        trace["evaluationTime"] = "2026-03-01T00:00:00Z"

    snapshot = fit_calibration_snapshot(historical_traces=traces, resolved_outcomes=outcomes)

    assert snapshot.resolvedOutcomeCount == 15
    assert snapshot.weightRegime == "cold_start"


def test_calibration_keeps_the_latest_pre_resolution_trace_per_event() -> None:
    traces, outcomes = _traces_for([{"predicted": 0.2, "outcome": 1}])
    later = dict(traces[0], evaluationTime="2026-01-20T00:00:00Z", finalProbability=0.9)

    snapshot = fit_calibration_snapshot(historical_traces=[traces[0], later], resolved_outcomes=outcomes)

    assert snapshot.resolvedOutcomeCount == 1
    assert round(snapshot.metrics["brierScore"], 4) == 0.01
