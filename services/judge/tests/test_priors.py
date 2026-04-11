from app.models_generated import CalibrationSnapshot, EventInput
from app.scoring.aggregate import log_odds_to_probability
from app.scoring.priors import (
    build_prior_log_odds,
    empirical_bayes_base_rate,
    liquidity_adjusted_market_probability,
)


def _event(reference_class: str | None) -> EventInput:
    return EventInput.model_validate(
        {
            "question": "Will Example Corp launch Product X by 2026-12-31?",
            "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
            "deadline": "2026-12-31T23:59:59Z",
            "entities": ["Example Corp", "Product X"],
            "referenceClass": reference_class,
            "marketSymbols": ["EXMPL"],
            "polymarketMarketId": "poly-1",
        }
    )


def _snapshot() -> CalibrationSnapshot:
    return CalibrationSnapshot.model_validate(
        {
            "id": "snapshot-1",
            "createdAt": "2026-01-01T00:00:00Z",
            "trainingWindow": "all_time",
            "judgeWeights": {},
            "baseRateParams": {
                "minimumSample": 20,
                "historicalCounts": {
                    "product_launch": {"successes": 3, "total": 4},
                    "regulatory_approval": {"successes": 70, "total": 100},
                },
            },
            "marketPriorParams": {"defaultAlpha": 0.6},
            "calibrationParams": {},
            "onlineLearningParams": {},
            "metrics": {},
            "weightRegime": "cold_start",
            "resolvedOutcomeCount": 0,
            "approved": False,
        }
    )


def test_empirical_bayes_shrinks_sparse_classes_toward_global_prior() -> None:
    result = empirical_bayes_base_rate(
        "product_launch",
        {"product_launch": {"successes": 3, "total": 4}},
        minimum_sample=20,
    )

    assert result.used_fallback is True
    assert 0.5 < result.probability < 0.75


def test_market_probability_is_discounted_by_spread_and_volatility() -> None:
    liquid = liquidity_adjusted_market_probability(0.7, spread=0.01, depth=1_000_000, volatility=0.02)
    noisy = liquidity_adjusted_market_probability(0.7, spread=0.15, depth=500, volatility=0.3)

    assert liquid > noisy
    assert 0.5 < noisy < 0.7


def test_build_prior_log_odds_uses_market_only_when_reference_class_is_unsampled() -> None:
    result = build_prior_log_odds(
        _event("geopolitical_event"),
        _snapshot(),
        market_signals={"price": 0.62, "spread": 0.03, "depth": 250_000, "volatility": 0.05},
    )

    assert result.alpha == 0.0
    assert result.reference_class_fallback is True
    assert log_odds_to_probability(result.prior_log_odds) > 0.5
