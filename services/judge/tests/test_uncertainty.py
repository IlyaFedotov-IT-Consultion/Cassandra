from math import exp

from app.scoring.uncertainty import posterior_bootstrap_interval


def _sigmoid(value: float) -> float:
    return 1 / (1 + exp(-value))


def test_posterior_interval_is_centered_on_the_pooled_posterior_not_judge_self_reports() -> None:
    interval = posterior_bootstrap_interval(
        prior_log_odds=0.0,
        contributions=[1.0, 1.0, 1.0],
        weighted_log_odds=[1.0, 1.0, 1.0],
        seed=3,
    )

    assert abs(interval.low - _sigmoid(3.0)) < 1e-9
    assert abs(interval.high - _sigmoid(3.0)) < 1e-9


def test_posterior_interval_widens_when_judges_disagree() -> None:
    agreeing = posterior_bootstrap_interval(
        prior_log_odds=0.0,
        contributions=[0.5, 0.5, 0.5],
        weighted_log_odds=[0.5, 0.5, 0.5],
        seed=3,
    )
    disagreeing = posterior_bootstrap_interval(
        prior_log_odds=0.0,
        contributions=[1.0, -1.0, 0.5],
        weighted_log_odds=[1.0, -1.0, 0.5],
        seed=3,
    )

    assert (disagreeing.high - disagreeing.low) > (agreeing.high - agreeing.low)
    assert disagreeing.high - disagreeing.low > 0.1
