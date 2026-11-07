from __future__ import annotations

from math import exp
from random import Random
from statistics import mean

from app.scoring.aggregate import disagreement_shrinkage
from app.scoring.types import BootstrapInterval


def _sigmoid(value: float) -> float:
    return 1 / (1 + exp(-value))


def posterior_bootstrap_interval(
    *,
    prior_log_odds: float,
    contributions: list[float],
    weighted_log_odds: list[float],
    num_samples: int = 500,
    confidence: float = 0.9,
    seed: int = 0,
) -> BootstrapInterval:
    """Bootstrap the pooled posterior by resampling informative judges with replacement.

    Each resample re-runs the same pooling as `aggregate_posterior`: sum the sampled
    effective contributions onto the prior, then apply disagreement shrinkage computed
    from the sampled judges. The band therefore describes spread of the posterior itself.
    """
    if not contributions:
        point = _sigmoid(prior_log_odds)
        return BootstrapInterval(low=point, high=point, mean=point)

    rng = Random(seed)
    count = len(contributions)
    samples: list[float] = []
    for _ in range(num_samples):
        indices = [rng.randrange(count) for _ in range(count)]
        update = sum(contributions[index] for index in indices)
        shrinkage = disagreement_shrinkage([weighted_log_odds[index] for index in indices])
        samples.append(_sigmoid(prior_log_odds + (1 - shrinkage) * update))

    samples.sort()
    tail = (1 - confidence) / 2
    low_index = max(0, int(tail * (len(samples) - 1)))
    high_index = min(len(samples) - 1, int((1 - tail) * (len(samples) - 1)))
    return BootstrapInterval(low=samples[low_index], high=samples[high_index], mean=mean(samples))
