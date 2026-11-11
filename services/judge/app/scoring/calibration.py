from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from math import exp, log
from statistics import mean
from typing import Any
from uuid import uuid4

from app.models_generated import CalibrationSnapshot
from app.scoring.priors import build_base_rate_params
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


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _training_probability(trace: dict[str, Any]) -> float | None:
    """The probability the calibration map is applied to at inference time.

    Traces that were calibrated by an earlier snapshot without recording their
    pre-calibration probability cannot be used: their final value is already remapped.
    """
    pre_calibration = trace.get("preCalibrationProbability")
    if isinstance(pre_calibration, int | float):
        return float(pre_calibration)
    if trace.get("calibrationMethod") in (None, "identity"):
        final = trace.get("finalProbability")
        if isinstance(final, int | float):
            return float(final)
    return None


def _join_traces_and_outcomes(
    historical_traces: list[dict[str, Any]],
    resolved_outcomes: list[dict[str, Any]],
    *,
    completed_only: bool = False,
) -> list[dict[str, Any]]:
    """One training pair per resolved event: its latest judgment made before resolution.

    With `completed_only`, prior-only (`insufficient_evidence`) traces are left out: they
    never went through the panel, so they say nothing about how the panel's output
    should be recalibrated.
    """
    outcomes_by_event_id = {str(item["eventId"]): item for item in resolved_outcomes}
    selected: dict[str, tuple[datetime | None, dict[str, Any], float]] = {}
    for trace in historical_traces:
        event_id = str(trace["eventId"])
        outcome = outcomes_by_event_id.get(event_id)
        if outcome is None:
            continue
        if completed_only and trace.get("status", "completed") != "completed":
            continue
        probability = _training_probability(trace)
        if probability is None:
            continue
        evaluated_at = _parse_time(trace.get("evaluationTime"))
        resolved_at = _parse_time(outcome.get("resolvedAt"))
        if evaluated_at and resolved_at and evaluated_at >= resolved_at:
            continue
        current = selected.get(event_id)
        if current is None or (evaluated_at and (current[0] is None or evaluated_at >= current[0])):
            selected[event_id] = (evaluated_at, trace, probability)

    return [
        {
            "eventId": event_id,
            "groupId": event_id,
            "referenceClass": trace.get("referenceClass"),
            "predicted": probability,
            "outcome": int(bool(outcomes_by_event_id[event_id]["resolvedValue"])),
            "priorProbability": trace.get("priorProbability"),
            "judgeOpinions": [
                {
                    "judgeName": opinion["judgeName"],
                    "logBayesFactor": opinion.get("logBayesFactor"),
                    "hadEvidence": bool(opinion.get("evidenceIds")),
                }
                for opinion in trace.get("judgeOpinions", [])
                if "judgeName" in opinion
            ],
        }
        for event_id, (_, trace, probability) in selected.items()
    ]


def _replay_training_pairs(forecast_pairs: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Training pairs from replayed benchmark forecasts.

    A market replayed at several horizons gives several forecasts of one outcome. Each is a
    pair, but they share a `groupId` so that folds and the regime count the market once.
    """
    pairs: list[dict[str, Any]] = []
    for index, forecast in enumerate(forecast_pairs or []):
        probability = forecast.get("probability")
        if isinstance(probability, bool) or not isinstance(probability, int | float):
            continue
        group_id = f"replay:{forecast.get('groupId')}"
        pairs.append(
            {
                "eventId": f"{group_id}#{index}",
                "groupId": group_id,
                "referenceClass": None,
                "predicted": float(probability),
                "outcome": int(bool(forecast.get("outcome"))),
                "priorProbability": forecast.get("priorProbability"),
                "judgeOpinions": list(forecast.get("judgeOpinions") or []),
            }
        )
    return pairs


def pool_adjacent_violators(values: list[float], weights: list[float] | None = None) -> list[float]:
    """Least-squares non-decreasing fit of `values` (already ordered by their predictor)."""
    blocks: list[list[float]] = []  # [weighted_sum, weight, count]
    for index, value in enumerate(values):
        weight = 1.0 if weights is None else weights[index]
        blocks.append([value * weight, weight, 1])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            last = blocks.pop()
            blocks[-1] = [blocks[-1][0] + last[0], blocks[-1][1] + last[1], blocks[-1][2] + last[2]]
    fitted: list[float] = []
    for weighted_sum, weight, count in blocks:
        fitted.extend([weighted_sum / weight] * int(count))
    return fitted


ISOTONIC_OUTPUT_BOUNDS = (0.005, 0.995)


def _fit_isotonic_outputs(pairs: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[float, list[int]] = defaultdict(list)
    for pair in pairs:
        grouped[float(pair["predicted"])].append(int(pair["outcome"]))
    xs = sorted(grouped)
    means = [mean(grouped[x]) for x in xs]
    counts = [float(len(grouped[x])) for x in xs]
    fitted = pool_adjacent_violators(means, counts)

    thresholds: list[float] = []
    outputs: list[float] = []
    index = 0
    while index < len(xs):
        end = index
        while end + 1 < len(xs) and fitted[end + 1] == fitted[index]:
            end += 1
        block_weight = sum(counts[index : end + 1])
        thresholds.append(sum(xs[i] * counts[i] for i in range(index, end + 1)) / block_weight)
        low, high = ISOTONIC_OUTPUT_BOUNDS
        outputs.append(min(max(fitted[index], low), high))
        index = end + 1
    return {"method": "isotonic", "thresholds": thresholds, "outputs": outputs}


def fit_platt_scaling(
    pairs: list[dict[str, Any]],
    *,
    l2_toward_identity: float = 1.0,
    iterations: int = 50,
) -> dict[str, Any]:
    """Fit p' = sigmoid(slope * logit(p) + intercept) by penalized, damped Newton-Raphson.

    The L2 penalty pulls (slope, intercept) toward the identity map (1, 0), which keeps
    small samples from producing wild recalibrations. Each Newton step is halved until it
    lowers the objective: a full step can overshoot when the starting map is far from the
    data, and then the iteration diverges instead of converging.
    """
    features = [_logit(float(pair["predicted"])) for pair in pairs]
    labels = [float(pair["outcome"]) for pair in pairs]
    weights = [float(pair.get("weight", 1.0)) for pair in pairs]

    def objective(slope: float, intercept: float) -> float:
        penalty = 0.5 * l2_toward_identity * ((slope - 1.0) ** 2 + intercept**2)
        loss = 0.0
        for x, y, weight in zip(features, labels, weights):
            z = slope * x + intercept
            # log(1 + exp(z)) - y * z, written so that it cannot overflow.
            loss += weight * (max(z, 0.0) + log(1 + exp(-abs(z))) - y * z)
        return loss + penalty

    slope, intercept = 1.0, 0.0
    current = objective(slope, intercept)
    for _ in range(iterations):
        grad_slope = l2_toward_identity * (slope - 1.0)
        grad_intercept = l2_toward_identity * intercept
        h_ss = h_si = h_ii = 0.0
        for x, y, weight in zip(features, labels, weights):
            q = _sigmoid(slope * x + intercept)
            residual = weight * (q - y)
            curvature = weight * q * (1 - q)
            grad_slope += residual * x
            grad_intercept += residual
            h_ss += curvature * x * x
            h_si += curvature * x
            h_ii += curvature
        h_ss += l2_toward_identity
        h_ii += l2_toward_identity
        determinant = h_ss * h_ii - h_si * h_si
        if determinant <= 1e-12:
            break
        step_slope = (h_ii * grad_slope - h_si * grad_intercept) / determinant
        step_intercept = (h_ss * grad_intercept - h_si * grad_slope) / determinant

        damping = 1.0
        while damping > 1e-6:
            candidate = objective(slope - damping * step_slope, intercept - damping * step_intercept)
            if candidate <= current:
                break
            damping /= 2
        else:
            break
        slope -= damping * step_slope
        intercept -= damping * step_intercept
        improvement = current - candidate
        current = candidate
        if improvement < 1e-12:
            break
    return {"method": "logistic", "slope": slope, "intercept": intercept}


def _judge_regrets(joined_pairs: list[dict[str, Any]], judge_names: list[str]) -> dict[str, float]:
    """Each judge's cumulative regret from how it read its evidence.

    For every resolved forecast where the judge had evidence, compare the Brier score of
    the prior moved by that judge's log Bayes factor alone with the Brier score of the
    prior left alone. Negative regret means its readings pointed the right way. This scores
    what the pool actually uses from a judge, its log Bayes factor.
    """
    regrets = {judge_name: 0.0 for judge_name in judge_names}
    for pair in joined_pairs:
        prior = pair.get("priorProbability")
        if isinstance(prior, bool) or not isinstance(prior, int | float):
            continue
        outcome = float(pair["outcome"])
        for opinion in pair.get("judgeOpinions", []):
            judge_name = opinion.get("judgeName")
            log_bayes_factor = opinion.get("logBayesFactor")
            if (
                judge_name not in regrets
                or not opinion.get("hadEvidence")
                or isinstance(log_bayes_factor, bool)
                or not isinstance(log_bayes_factor, int | float)
            ):
                continue
            moved = _sigmoid(_logit(float(prior)) + float(log_bayes_factor))
            regrets[judge_name] += (moved - outcome) ** 2 - (float(prior) - outcome) ** 2
    return regrets


def _fit_calibration_params(pairs: list[dict[str, Any]], regime: str) -> dict[str, Any]:
    if regime == "cold_start" or not pairs:
        return {"method": "identity"}
    if regime == "warming":
        return fit_platt_scaling(pairs)
    unique_predictions = len({pair["predicted"] for pair in pairs})
    unique_outcomes = len({pair["outcome"] for pair in pairs})
    if unique_predictions >= 3 and unique_outcomes >= 2:
        return _fit_isotonic_outputs(pairs)
    return fit_platt_scaling(pairs)


HELD_OUT_FOLDS = 5


def held_out_calibration_scores(
    pairs: list[dict[str, Any]],
    regime: str,
    *,
    folds: int = HELD_OUT_FOLDS,
) -> dict[str, Any] | None:
    """Cross-validated scores of the calibration map against leaving forecasts alone.

    Each fold is scored by a map fitted on the other folds, so the comparison shows what
    the map does to forecasts it has not seen. Folds are assigned by group order, which
    keeps the result reproducible.
    """
    # A market forecast at several horizons must sit in one fold: scoring one of its
    # forecasts with a map fitted on another would leak the outcome.
    groups = sorted({str(pair.get("groupId", pair.get("eventId", ""))) for pair in pairs})
    if regime == "cold_start" or len(groups) < folds:
        return None

    fold_of_group = {group: index % folds for index, group in enumerate(groups)}
    fold_of = [fold_of_group[str(pair.get("groupId", pair.get("eventId", "")))] for pair in pairs]
    identity: list[dict[str, float | int]] = []
    calibrated: list[dict[str, float | int]] = []
    for fold in range(folds):
        training = [pair for pair, pair_fold in zip(pairs, fold_of) if pair_fold != fold]
        params = _fit_calibration_params(training, regime)
        for pair, pair_fold in zip(pairs, fold_of):
            if pair_fold != fold:
                continue
            identity.append({"predicted": pair["predicted"], "outcome": pair["outcome"]})
            calibrated.append(
                {
                    "predicted": apply_probability_calibration(pair["predicted"], params),
                    "outcome": pair["outcome"],
                }
            )

    brier_identity = brier_score(identity)
    brier_calibrated = brier_score(calibrated)
    return {
        "folds": folds,
        "sampleSize": len(pairs),
        "brierIdentity": brier_identity,
        "brierCalibrated": brier_calibrated,
        "logLossIdentity": log_loss(identity),
        "logLossCalibrated": log_loss(calibrated),
        "improves": brier_calibrated < brier_identity,
    }


MIN_MARKET_TRUST_PAIRS = 40


def fit_market_trust(market_price_pairs: list[dict[str, Any]] | None) -> dict[str, Any]:
    """How far to trust a prediction-market price, fitted on resolved benchmark markets.

    A Platt fit of outcomes on the market's log-odds: a slope below 1 means prices were
    overconfident, above 1 underconfident. With too few resolved markets, or only one
    kind of outcome, the price is trusted as is. Each market has total weight one,
    divided across its cutoffs, retaining each cutoff's price signal. Callers without
    `groupId` retain the legacy behavior of one independent market per pair.
    """
    pairs: list[dict[str, Any]] = []
    group_sizes: dict[tuple[str, str | int], int] = defaultdict(int)
    for index, pair in enumerate(market_price_pairs or []):
        price = pair.get("price")
        if isinstance(price, bool) or not isinstance(price, int | float) or not 0.0 <= price <= 1.0:
            continue
        group_id = pair.get("groupId")
        group = ("market", str(group_id)) if group_id is not None else ("legacy", index)
        group_sizes[group] += 1
        pairs.append({"predicted": float(price), "outcome": int(bool(pair.get("outcome"))), "group": group})

    sample_size = len(group_sizes)
    if sample_size < MIN_MARKET_TRUST_PAIRS or len({pair["outcome"] for pair in pairs}) < 2:
        return {"trustSlope": 1.0, "trustIntercept": 0.0, "fitted": False, "sampleSize": sample_size}

    for pair in pairs:
        pair["weight"] = 1.0 / group_sizes[pair["group"]]
    fit = fit_platt_scaling(pairs)
    return {
        "trustSlope": fit["slope"],
        "trustIntercept": fit["intercept"],
        "fitted": True,
        "sampleSize": sample_size,
    }


def fit_calibration_snapshot(
    *,
    historical_traces: list[dict[str, Any]],
    resolved_outcomes: list[dict[str, Any]],
    market_price_pairs: list[dict[str, Any]] | None = None,
    forecast_pairs: list[dict[str, Any]] | None = None,
) -> CalibrationSnapshot:
    judgment_pairs = _join_traces_and_outcomes(historical_traces, resolved_outcomes, completed_only=True)
    replay_pairs = _replay_training_pairs(forecast_pairs)
    joined_pairs = judgment_pairs + replay_pairs
    # Forecasts of one market are not independent, so the sample size that decides how
    # much to trust the fit is the number of markets and events, not of forecasts.
    resolved_outcome_count = len({pair["groupId"] for pair in joined_pairs})
    regime = select_regime(resolved_outcome_count)
    judge_names = sorted(
        {
            str(opinion["judgeName"])
            for pair in joined_pairs
            for opinion in pair["judgeOpinions"]
            if "judgeName" in opinion
        }
        | {
            str(opinion["judgeName"])
            for trace in historical_traces
            for opinion in trace.get("judgeOpinions", [])
            if "judgeName" in opinion
        }
        or set(DEFAULT_PANEL)
    )
    uniform_weights = default_judge_weights(judge_names)
    calibration_params = _fit_calibration_params(joined_pairs, regime)

    if regime == "cold_start" or not joined_pairs:
        judge_weights = uniform_weights
        online_learning_params = {"enabled": False, "stepSizeScale": 0.0}
    else:
        regrets = _judge_regrets(joined_pairs, judge_names)
        judge_weights = update_expert_weights(
            uniform_weights,
            regrets,
            resolved_outcome_count=resolved_outcome_count,
        )
        online_learning_params = {"enabled": True, "stepSizeScale": 0.5 if regime == "warming" else 1.0}

    # Base rates count every resolved event, including ones whose judgment was prior-only.
    base_rate_params = build_base_rate_params(_join_traces_and_outcomes(historical_traces, resolved_outcomes))
    market_prior_params = fit_market_trust(market_price_pairs)

    metrics_pairs = [
        {"predicted": pair["predicted"], "outcome": pair["outcome"]}
        for pair in joined_pairs
    ]
    metrics: dict[str, Any] = {
        "traceCount": len(joined_pairs),
        "outcomeCount": resolved_outcome_count,
        "trainingSources": {
            "judgments": len(judgment_pairs),
            "replayForecasts": len(replay_pairs),
            "groups": resolved_outcome_count,
        },
    }
    if metrics_pairs:
        # With nothing to score there are no scores; a 0 would read as a perfect forecast.
        metrics.update(
            {
                "brierScore": brier_score(metrics_pairs),
                "logLoss": log_loss(metrics_pairs),
                "expectedCalibrationError": expected_calibration_error(metrics_pairs),
                "referenceClassMetrics": calibration_error_by_reference_class(judgment_pairs),
            }
        )
    held_out = held_out_calibration_scores(joined_pairs, regime)
    if held_out is not None:
        metrics["heldOut"] = held_out

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
