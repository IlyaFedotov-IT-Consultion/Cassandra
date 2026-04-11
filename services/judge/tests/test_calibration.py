from app.main import app
from app.scoring.calibration import (
    brier_score,
    calibration_error_by_reference_class,
    expected_calibration_error,
    fit_calibration_snapshot,
    log_loss,
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
