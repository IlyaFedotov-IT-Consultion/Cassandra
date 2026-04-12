from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from math import exp, log
from statistics import mean
from typing import Any
from uuid import uuid4

from app.models_generated import CalibrationSnapshot
from app.scoring.priors import build_base_rate_params, build_market_prior_params
from app.scoring.weights import default_judge_weights, select_regime, update_expert_weights


DEFAULT_PANEL = ["official_records", "community_signal", "open_web_research"]


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _clamp_probability(probability: float) -> float:
    return min(max(probability, 1e-6), 1 - 1e-6)


def _logit(probability: float) -> float:
    bounded = _clamp_probability(probability)
    return log(bounded / (1 - bounded))


def _sigmoid(value: float) -> float:
    return 1 / (1 + exp(-value))


def _apply_isotonic_calibration(
    probability: float,
    calibration_params: dict[str, Any],
) -> float:
    points: list[tuple[float, float]] = []
    thresholds = calibration_params.get("thresholds", [])
    outputs = calibration_params.get("outputs", [])
    for threshold, output in zip(thresholds, outputs):
        if isinstance(threshold, int | float) and isinstance(output, int | float):
            points.append((float(threshold), _clamp_probability(float(output))))

    if not points:
        return _clamp_probability(probability)

    points.sort(key=lambda point: point[0])
    bounded = _clamp_probability(probability)

    if bounded <= points[0][0]:
        return points[0][1]
    if bounded >= points[-1][0]:
        return points[-1][1]

    for index in range(1, len(points)):
        left_threshold, left_output = points[index - 1]
        right_threshold, right_output = points[index]
        if bounded > right_threshold:
            continue
        if right_threshold <= left_threshold:
            return right_output
        ratio = (bounded - left_threshold) / (right_threshold - left_threshold)
        return _clamp_probability(left_output + ratio * (right_output - left_output))

    return points[-1][1]


def apply_probability_calibration(
    probability: float,
    calibration_params: dict[str, Any] | None,
) -> float:
    params = calibration_params or {}
    if not isinstance(params, dict):
        return _clamp_probability(probability)

    method = str(params.get("method", "identity"))
    bounded = _clamp_probability(probability)

    if method == "identity":
        return bounded
    if method == "isotonic":
        return _apply_isotonic_calibration(bounded, params)
    if method == "logistic":
        slope = float(params.get("slope", 1.0))
        intercept = float(params.get("intercept", 0.0))
        return _clamp_probability(_sigmoid(slope * _logit(bounded) + intercept))
    if method == "beta":
        alpha = params.get("alpha", params.get("a"))
        beta = params.get("beta", params.get("b"))
        intercept = float(params.get("intercept", params.get("c", 0.0)))
        if isinstance(alpha, int | float) and isinstance(beta, int | float):
            return _clamp_probability(
                _sigmoid(float(alpha) * log(bounded) + float(beta) * log(1 - bounded) + intercept)
            )
        slope = float(params.get("slope", 1.0))
        return _clamp_probability(_sigmoid(slope * _logit(bounded) + intercept))

    return bounded


def brier_score(pairs: list[dict[str, float | int]]) -> float:
    if not pairs:
        return 0.0
    return mean((float(pair["predicted"]) - float(pair["outcome"])) ** 2 for pair in pairs)


def log_loss(pairs: list[dict[str, float | int]]) -> float:
    if not pairs:
        return 0.0
    losses = []
    for pair in pairs:
        predicted = _clamp_probability(float(pair["predicted"]))
        outcome = float(pair["outcome"])
        losses.append(-(outcome * log(predicted) + (1 - outcome) * log(1 - predicted)))
    return mean(losses)


def reliability_bins(
    pairs: list[dict[str, float | int]],
    *,
    bins: int = 10,
) -> list[dict[str, float | int]]:
    if not pairs:
        return []

    buckets: list[list[dict[str, float | int]]] = [[] for _ in range(bins)]
    for pair in pairs:
        predicted = min(max(float(pair["predicted"]), 0.0), 0.999999)
        index = min(int(predicted * bins), bins - 1)
        buckets[index].append(pair)

    result: list[dict[str, float | int]] = []
    for index, bucket in enumerate(buckets):
        if not bucket:
            continue
        result.append(
            {
                "bin": index,
                "sampleSize": len(bucket),
                "averagePredicted": mean(float(item["predicted"]) for item in bucket),
                "averageObserved": mean(float(item["outcome"]) for item in bucket),
            }
        )
    return result


def expected_calibration_error(
    pairs: list[dict[str, float | int]],
    *,
    bins: int = 10,
) -> float:
    if not pairs:
        return 0.0

    total = len(pairs)
    return sum(
        abs(float(bucket["averagePredicted"]) - float(bucket["averageObserved"]))
        * (int(bucket["sampleSize"]) / total)
        for bucket in reliability_bins(pairs, bins=bins)
    )


def calibration_error_by_reference_class(
    traces: list[dict[str, Any]],
) -> dict[str, dict[str, float | int]]:
    grouped: dict[str, list[dict[str, float | int]]] = defaultdict(list)
    for trace in traces:
        reference_class = str(trace.get("referenceClass") or "unknown")
        grouped[reference_class].append(
            {
                "predicted": float(trace["predicted"]),
                "outcome": int(bool(trace["outcome"])),
            }
        )

    return {
        reference_class: {
            "sampleSize": len(pairs),
            "brierScore": brier_score(pairs),
            "expectedCalibrationError": expected_calibration_error(pairs),
        }
        for reference_class, pairs in grouped.items()
    }


def _join_traces_and_outcomes(
    historical_traces: list[dict[str, Any]],
    resolved_outcomes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    outcomes_by_event_id = {
        str(item["eventId"]): bool(item["resolvedValue"]) for item in resolved_outcomes
    }
    joined: list[dict[str, Any]] = []
    for trace in historical_traces:
        event_id = str(trace["eventId"])
        if event_id not in outcomes_by_event_id:
            continue
        joined.append(
            {
                "eventId": event_id,
                "referenceClass": trace.get("referenceClass"),
                "predicted": float(trace.get("finalProbability", 0.5)),
                "outcome": int(outcomes_by_event_id[event_id]),
                "judgeOpinions": list(trace.get("judgeOpinions", [])),
            }
        )
    return joined


def _fit_isotonic_outputs(pairs: list[dict[str, Any]]) -> dict[str, Any]:
    sorted_pairs = sorted(pairs, key=lambda pair: float(pair["predicted"]))
    thresholds = [float(pair["predicted"]) for pair in sorted_pairs]
    outputs: list[float] = []
    running_max = 0.0
    for index in range(len(sorted_pairs)):
        observed_mean = mean(float(item["outcome"]) for item in sorted_pairs[: index + 1])
        running_max = max(running_max, observed_mean)
        outputs.append(running_max)
    return {
        "method": "isotonic",
        "thresholds": thresholds,
        "outputs": outputs,
    }


def _judge_regrets(joined_pairs: list[dict[str, Any]], judge_names: list[str]) -> dict[str, float]:
    regrets: dict[str, list[float]] = {judge_name: [] for judge_name in judge_names}
    for pair in joined_pairs:
        outcome = float(pair["outcome"])
        opinions_by_name = {
            str(opinion["judgeName"]): float(opinion["probability"])
            for opinion in pair["judgeOpinions"]
            if "judgeName" in opinion and "probability" in opinion
        }
        for judge_name in judge_names:
            predicted = opinions_by_name.get(judge_name, 0.5)
            regrets[judge_name].append((predicted - outcome) ** 2)

    return {
        judge_name: mean(values) if values else 0.25
        for judge_name, values in regrets.items()
    }


def fit_calibration_snapshot(
    *,
    historical_traces: list[dict[str, Any]],
    resolved_outcomes: list[dict[str, Any]],
) -> CalibrationSnapshot:
    resolved_outcome_count = len(resolved_outcomes)
    regime = select_regime(resolved_outcome_count)
    joined_pairs = _join_traces_and_outcomes(historical_traces, resolved_outcomes)
    judge_names = sorted(
        {
            str(opinion["judgeName"])
            for trace in historical_traces
            for opinion in trace.get("judgeOpinions", [])
            if "judgeName" in opinion
        }
        or set(DEFAULT_PANEL)
    )
    uniform_weights = default_judge_weights(judge_names)

    if regime == "cold_start" or not joined_pairs:
        judge_weights = uniform_weights
        calibration_params: dict[str, Any] = {"method": "identity"}
        online_learning_params = {"enabled": False, "stepSizeScale": 0.0}
    else:
        regrets = _judge_regrets(joined_pairs, judge_names)
        judge_weights = update_expert_weights(
            uniform_weights,
            regrets,
            resolved_outcome_count=resolved_outcome_count,
        )
        if regime == "warming":
            method = "logistic" if len({pair["predicted"] for pair in joined_pairs}) > 1 else "beta"
            calibration_params = {
                "method": method,
                "slope": 1.0,
                "intercept": mean(pair["outcome"] for pair in joined_pairs) - mean(pair["predicted"] for pair in joined_pairs),
            }
            online_learning_params = {"enabled": True, "stepSizeScale": 0.5}
        else:
            unique_predictions = len({pair["predicted"] for pair in joined_pairs})
            unique_outcomes = len({pair["outcome"] for pair in joined_pairs})
            if unique_predictions >= 3 and unique_outcomes >= 2:
                calibration_params = _fit_isotonic_outputs(joined_pairs)
            else:
                calibration_params = {"method": "logistic", "slope": 1.0, "intercept": 0.0}
            online_learning_params = {"enabled": True, "stepSizeScale": 1.0}

    base_rate_params = build_base_rate_params(joined_pairs)
    market_prior_params = build_market_prior_params(base_rate_params)

    metrics_pairs = [
        {"predicted": pair["predicted"], "outcome": pair["outcome"]}
        for pair in joined_pairs
    ]
    metrics = {
        "brierScore": brier_score(metrics_pairs),
        "logLoss": log_loss(metrics_pairs),
        "expectedCalibrationError": expected_calibration_error(metrics_pairs),
        "referenceClassMetrics": calibration_error_by_reference_class(joined_pairs),
        "traceCount": len(joined_pairs),
        "outcomeCount": resolved_outcome_count,
    }

    return CalibrationSnapshot.model_validate(
        {
            "id": f"snapshot-{uuid4()}",
            "createdAt": _utc_now(),
            "trainingWindow": "all_time",
            "judgeWeights": judge_weights,
            "baseRateParams": base_rate_params,
            "marketPriorParams": market_prior_params,
            "calibrationParams": calibration_params,
            "onlineLearningParams": online_learning_params,
            "metrics": metrics,
            "weightRegime": regime,
            "resolvedOutcomeCount": resolved_outcome_count,
            "approved": False,
        }
    )
