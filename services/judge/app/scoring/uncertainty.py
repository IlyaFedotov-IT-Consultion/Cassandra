from __future__ import annotations

from dataclasses import dataclass, field
from math import exp
from random import Random
from statistics import mean, median

from app.scoring.aggregate import disagreement_shrinkage
from app.scoring.types import BootstrapInterval


def _sigmoid(value: float) -> float:
    return 1 / (1 + exp(-value))


@dataclass(slots=True)
class JudgeSpread:
    """One informative judge as it entered the pool, with what each ensemble model said."""

    # Pool weight, dependency discount, evidence quality and freshness multiplied together.
    multiplier: float
    base_weight: float
    # The judge's log Bayes factor in the forecast (the ensemble median).
    log_bayes_factor: float
    # The log Bayes factor each model gave. Empty when a single model was asked.
    sample_log_bayes_factors: list[float] = field(default_factory=list)


def _redraw_median(values: list[float], fallback: float, rng: Random) -> float:
    """The median of a panel drawn again, with replacement, from the models that answered."""
    if len(values) < 2:
        return fallback
    return median(values[rng.randrange(len(values))] for _ in values)


def model_spread_interval(
    *,
    prior_log_odds: float,
    judges: list[JudgeSpread],
    prior_sample_log_odds: list[float] | None = None,
    num_samples: int = 500,
    confidence: float = 0.9,
    seed: int = 0,
) -> BootstrapInterval | None:
    """How much the forecast depends on which models were asked.

    The ensemble takes a median across models for each judge, and for an estimated base
    rate. Each resample draws the models again with replacement, retakes those medians and
    pools them exactly as the forecast was pooled, disagreement shrinkage included. The
    interval is the range of forecasts that other draws of the same models would have given.

    Returns None when nothing was answered by more than one model: then no spread was
    measured, and inventing an interval would misreport it.
    """
    prior_samples = prior_sample_log_odds or []
    if len(prior_samples) < 2 and all(len(judge.sample_log_bayes_factors) < 2 for judge in judges):
        return None

    rng = Random(seed)
    forecasts: list[float] = []
    for _ in range(num_samples):
        prior = _redraw_median(prior_samples, prior_log_odds, rng)
        log_bayes_factors = [
            _redraw_median(judge.sample_log_bayes_factors, judge.log_bayes_factor, rng) for judge in judges
        ]
        update = sum(judge.multiplier * value for judge, value in zip(judges, log_bayes_factors))
        shrinkage = disagreement_shrinkage(
            [judge.base_weight * value for judge, value in zip(judges, log_bayes_factors)]
        )
        forecasts.append(_sigmoid(prior + (1 - shrinkage) * update))

    forecasts.sort()
    tail = (1 - confidence) / 2
    low_index = max(0, int(tail * (len(forecasts) - 1)))
    high_index = min(len(forecasts) - 1, int((1 - tail) * (len(forecasts) - 1)))
    return BootstrapInterval(low=forecasts[low_index], high=forecasts[high_index], mean=mean(forecasts))
