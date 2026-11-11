from app.models_generated import CalibrationSnapshot, EventInput, EvidenceItem
from app.scoring.aggregate import log_odds_to_probability
from app.scoring.priors import (
    build_prior_log_odds,
    empirical_bayes_base_rate,
    extract_market_signal,
    market_trust_probability,
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


def test_an_unfitted_snapshot_trusts_the_market_price_as_is() -> None:
    assert abs(market_trust_probability(0.9, {}) - 0.9) < 1e-9
    assert abs(market_trust_probability(0.9, {"defaultAlpha": 0.6}) - 0.9) < 1e-9


def test_a_fitted_trust_slope_rescales_the_market_log_odds() -> None:
    # logit(0.8) = ln 4; half of it is ln 2, which is a probability of 2/3.
    assert abs(market_trust_probability(0.8, {"trustSlope": 0.5, "trustIntercept": 0.0}) - 2 / 3) < 1e-9


def test_build_prior_log_odds_uses_market_only_when_reference_class_is_unsampled() -> None:
    result = build_prior_log_odds(
        _event("geopolitical_event"),
        _snapshot(),
        market_signals={"price": 0.62, "spread": 0.03, "depth": 250_000, "volatility": 0.05},
    )

    assert result.alpha == 0.0
    assert result.reference_class_fallback is True
    assert log_odds_to_probability(result.prior_log_odds) > 0.5


def _market_item(metadata: dict, source_family: str = "prediction_market") -> EvidenceItem:
    return EvidenceItem.model_validate(
        {
            "id": f"market-{len(str(metadata))}-{source_family}",
            "eventId": "event-1",
            "sourceFamily": source_family,
            "sourceType": "quote_snapshot",
            "title": "Market snapshot",
            "url": "https://polymarket.com/event/example",
            "publisher": "Polymarket",
            "publishedAt": "2026-10-10T09:00:00Z",
            "retrievedAt": "2026-10-11T12:00:00Z",
            "summary": "Market snapshot",
            "rawText": None,
            "entities": [],
            "claims": [],
            "stance": "unknown",
            "qualitySignals": {},
            "metadata": metadata,
        }
    )


def test_market_signal_reads_yes_token_and_ignores_no_token() -> None:
    signal = extract_market_signal(
        [
            _market_item({"price": 0.15, "outcome": "No"}),
            _market_item({"price": 0.85, "outcome": "Yes"}),
        ]
    )

    assert signal is not None
    assert signal["price"] == 0.85


def test_market_signal_reads_gamma_outcome_prices_for_the_yes_outcome() -> None:
    signal = extract_market_signal(
        [
            _market_item(
                {
                    "outcomePrices": '["0.3", "0.7"]',
                    "outcomes": '["No", "Yes"]',
                    "liquidity": "120000",
                }
            )
        ]
    )

    assert signal is not None
    assert signal["price"] == 0.7
    assert signal["depth"] == 120000


def test_market_signal_uses_liquidity_when_depth_is_missing() -> None:
    signal = extract_market_signal([_market_item({"price": 0.85, "liquidity": 250000})])

    assert signal is not None
    assert signal["depth"] == 250000


def test_market_signal_ignores_quotes_that_are_not_probabilities() -> None:
    signal = extract_market_signal(
        [
            _market_item({"price": 187.2}, source_family="market"),
            _market_item({"price": 1.7}),
        ]
    )

    assert signal is None


def test_prior_follows_a_liquid_market_price() -> None:
    result = build_prior_log_odds(
        _event(None),
        _snapshot(),
        market_signals=extract_market_signal([_market_item({"price": 0.85, "liquidity": 250000})]),
    )

    assert 0.8 < log_odds_to_probability(result.prior_log_odds) <= 0.85


def test_prior_does_not_discount_a_market_for_thin_or_unknown_liquidity() -> None:
    for metadata in ({"price": 0.85}, {"price": 0.85, "liquidity": 5000}):
        result = build_prior_log_odds(
            _event(None),
            _snapshot(),
            market_signals=extract_market_signal([_market_item(metadata)]),
        )

        assert abs(log_odds_to_probability(result.prior_log_odds) - 0.85) < 1e-9
        assert result.source == "market"


def test_a_market_found_by_search_is_not_this_events_prior() -> None:
    related = _market_item({"probability": 0.08, "liquidity": 400000, "matchedBy": "search"})
    bound = _market_item({"probability": 0.7, "liquidity": 20000, "matchedBy": "id"})

    assert extract_market_signal([related]) is None
    assert extract_market_signal([related, bound])["price"] == 0.7


def test_a_well_sampled_base_rate_does_not_override_a_market_price() -> None:
    result = build_prior_log_odds(
        _event("regulatory_approval"),
        _snapshot(),
        market_signals=extract_market_signal([_market_item({"price": 0.95, "liquidity": 1_000_000})]),
    )

    assert abs(log_odds_to_probability(result.prior_log_odds) - 0.95) < 1e-9
    assert result.source == "market"


def test_an_estimated_base_rate_is_the_prior_when_nothing_better_exists() -> None:
    result = build_prior_log_odds(_event(None), _snapshot(), market_signals=None, estimated_base_rate=0.1)

    assert abs(log_odds_to_probability(result.prior_log_odds) - 0.1) < 1e-9
    assert result.source == "estimated_base_rate"


def test_a_sampled_reference_class_beats_an_estimated_base_rate() -> None:
    result = build_prior_log_odds(
        _event("regulatory_approval"), _snapshot(), market_signals=None, estimated_base_rate=0.1
    )

    assert abs(log_odds_to_probability(result.prior_log_odds) - 71 / 102) < 1e-9
    assert result.source == "reference_class"


def test_prior_is_uninformed_without_a_market_or_any_base_rate() -> None:
    result = build_prior_log_odds(_event(None), _snapshot(), market_signals=None)

    assert result.prior_log_odds == 0.0
    assert result.source == "uninformed"


def test_missing_market_does_not_dilute_a_sampled_base_rate() -> None:
    result = build_prior_log_odds(_event("regulatory_approval"), _snapshot(), market_signals=None)

    assert abs(log_odds_to_probability(result.prior_log_odds) - 71 / 102) < 1e-9
