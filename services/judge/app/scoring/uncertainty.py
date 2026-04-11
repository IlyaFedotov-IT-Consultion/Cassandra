from __future__ import annotations

from random import Random
from statistics import mean

from app.scoring.types import BootstrapInterval


def bootstrap_confidence_interval(
    *,
    cluster_groups: list[list[float]],
    judge_probabilities: list[float],
    num_samples: int = 500,
    confidence: float = 0.9,
    seed: int = 0,
) -> BootstrapInterval:
    rng = Random(seed)
    samples: list[float] = []

    if not cluster_groups and not judge_probabilities:
        return BootstrapInterval(low=0.5, high=0.5, mean=0.5)

    for _ in range(num_samples):
        sampled_clusters = [rng.choice(group) for group in cluster_groups if group]
        sampled_judges = (
            [rng.choice(judge_probabilities) for _ in range(len(judge_probabilities))]
            if judge_probabilities
            else []
        )
        pooled = sampled_clusters + sampled_judges
        samples.append(mean(pooled) if pooled else 0.5)

    samples.sort()
    alpha = (1 - confidence) / 2
    low_index = max(0, int(alpha * (len(samples) - 1)))
    high_index = min(len(samples) - 1, int((1 - alpha) * (len(samples) - 1)))
    return BootstrapInterval(low=samples[low_index], high=samples[high_index], mean=mean(samples))
