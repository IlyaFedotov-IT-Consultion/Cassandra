from math import exp

from app.scoring.uncertainty import JudgeSpread, model_spread_interval


def _sigmoid(value: float) -> float:
    return 1 / (1 + exp(-value))


def _judge(log_bayes_factor: float, samples: list[float], multiplier: float = 1.0) -> JudgeSpread:
    return JudgeSpread(
        multiplier=multiplier,
        base_weight=1 / 3,
        log_bayes_factor=log_bayes_factor,
        sample_log_bayes_factors=samples,
    )


def test_there_is_no_interval_when_no_spread_between_models_was_measured() -> None:
    single_model = _judge(1.5, [])

    assert model_spread_interval(prior_log_odds=0.0, judges=[single_model], seed=3) is None
    assert model_spread_interval(prior_log_odds=0.0, judges=[], seed=3) is None


def test_interval_collapses_onto_the_forecast_when_every_model_agrees() -> None:
    interval = model_spread_interval(prior_log_odds=0.0, judges=[_judge(1.5, [1.5, 1.5, 1.5])], seed=3)

    assert interval is not None
    assert abs(interval.low - _sigmoid(1.5)) < 1e-9
    assert abs(interval.high - _sigmoid(1.5)) < 1e-9


def test_interval_spans_the_forecasts_that_other_draws_of_the_models_would_give() -> None:
    # Two models read the evidence as strong support, one as weak evidence against. A panel
    # drawn again from these models has a median of either 3.0 or -0.5.
    interval = model_spread_interval(prior_log_odds=0.0, judges=[_judge(3.0, [3.0, 3.0, -0.5])], seed=3)

    assert interval is not None
    assert abs(interval.low - _sigmoid(-0.5)) < 1e-9
    assert abs(interval.high - _sigmoid(3.0)) < 1e-9


def test_interval_uses_each_judges_weight_in_the_pool() -> None:
    interval = model_spread_interval(
        prior_log_odds=0.0, judges=[_judge(3.0, [3.0, 3.0, -0.5], multiplier=0.5)], seed=3
    )

    assert interval is not None
    assert abs(interval.high - _sigmoid(1.5)) < 1e-9


def test_models_that_disagree_about_the_base_rate_widen_the_interval() -> None:
    interval = model_spread_interval(
        prior_log_odds=0.0,
        judges=[_judge(0.0, [])],
        prior_sample_log_odds=[-2.0, 0.0, 2.0],
        seed=3,
    )

    assert interval is not None
    assert abs(interval.low - _sigmoid(-2.0)) < 1e-9
    assert abs(interval.high - _sigmoid(2.0)) < 1e-9


def test_interval_is_reproducible_for_a_seed() -> None:
    judges = [_judge(1.5, [3.0, 1.5, 0.5, -0.5]), _judge(-0.5, [-0.5, -1.5, 0.5])]

    assert model_spread_interval(prior_log_odds=0.3, judges=judges, seed=11) == model_spread_interval(
        prior_log_odds=0.3, judges=judges, seed=11
    )
