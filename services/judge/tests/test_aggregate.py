from app.models_generated import EvidenceItem
from app.scoring.aggregate import (
    aggregate_posterior,
    disagreement_shrinkage,
    freshness_decay,
    log_odds_to_probability,
    probability_to_log_odds,
)
from app.scoring.types import RawJudgeOpinion


def _evidence(evidence_id: str, published_at: str) -> EvidenceItem:
    return EvidenceItem.model_validate(
        {
            "id": evidence_id,
            "eventId": "event-1",
            "sourceFamily": "web",
            "sourceType": "web_article",
            "title": f"Evidence {evidence_id}",
            "url": f"https://example.com/{evidence_id}",
            "publisher": "Example",
            "publishedAt": published_at,
            "retrievedAt": "2026-10-11T12:00:00Z",
            "summary": "Example summary",
            "rawText": None,
            "entities": ["Example Corp"],
            "claims": ["Example claim"],
            "stance": "supports",
            "qualitySignals": {"citationCount": 3},
            "metadata": {},
        }
    )


def _raw_opinion(judge_name: str, evidence_ids: list[str], strength: str) -> RawJudgeOpinion:
    return RawJudgeOpinion(
        judge_name=judge_name,
        probability=0.6,
        evidence_strength=strength,
        rationale="Example rationale",
        evidence_ids=evidence_ids,
        warnings=[],
        missing_evidence=[],
    )


def test_probability_conversion_handles_edges() -> None:
    assert log_odds_to_probability(probability_to_log_odds(1e-6)) > 0
    assert log_odds_to_probability(probability_to_log_odds(1 - 1e-6)) < 1


def test_bayes_factor_contributions_add_in_log_odds_space() -> None:
    result = aggregate_posterior(
        prior_log_odds=0.0,
        raw_opinions=[_raw_opinion("official_records", ["e1"], "moderate_for")],
        base_weights={"official_records": 1.0},
        evidence_lookup={"e1": _evidence("e1", "2026-10-11T10:00:00Z")},
        evaluation_time="2026-10-11T12:00:00Z",
    )

    assert result.raw_posterior_log_odds > 1.0
    assert result.posterior_probability > 0.7


def test_identical_evidence_is_dependency_discounted() -> None:
    result = aggregate_posterior(
        prior_log_odds=0.0,
        raw_opinions=[
            _raw_opinion("official_records", ["e1"], "weak_for"),
            _raw_opinion("open_web_research", ["e1"], "weak_for"),
        ],
        base_weights={"official_records": 1.0, "open_web_research": 1.0},
        evidence_lookup={"e1": _evidence("e1", "2026-10-11T10:00:00Z")},
        evaluation_time="2026-10-11T12:00:00Z",
    )

    discounts = {op.judgeName: op.dependencyDiscount for op in result.finalized_opinions}
    assert round(discounts["official_records"], 2) == 0.5
    assert round(discounts["open_web_research"], 2) == 0.5


def test_disagreement_shrinkage_pulls_toward_prior() -> None:
    shrinkage = disagreement_shrinkage([3.0, -3.0])

    assert 0 < shrinkage <= 0.6


def test_aggregate_posterior_shrinkage_keeps_non_neutral_prior_signal() -> None:
    prior_log_odds = probability_to_log_odds(0.8)
    result = aggregate_posterior(
        prior_log_odds=prior_log_odds,
        raw_opinions=[
            _raw_opinion("official_records", ["e1"], "strong_for"),
            _raw_opinion("open_web_research", ["e2"], "strong_against"),
        ],
        base_weights={"official_records": 1.0, "open_web_research": 1.0},
        evidence_lookup={
            "e1": _evidence("e1", "2026-10-11T10:00:00Z"),
            "e2": _evidence("e2", "2026-10-11T09:00:00Z"),
        },
        evaluation_time="2026-10-11T12:00:00Z",
    )

    assert result.shrinkage > 0
    assert result.posterior_probability > 0.5
    assert abs(result.posterior_probability - log_odds_to_probability(prior_log_odds)) < 0.02


def test_stale_evidence_decays_more_than_fresh_evidence() -> None:
    fresh = freshness_decay("2026-10-11T11:00:00Z", "2026-10-11T12:00:00Z")
    stale = freshness_decay("2026-09-01T12:00:00Z", "2026-10-11T12:00:00Z")

    assert fresh > stale


def test_zero_shrinkage_when_all_judges_agree() -> None:
    assert disagreement_shrinkage([0.5, 0.5, 0.5]) == 0.0


def _family_evidence(evidence_id: str, source_family: str, published_at: str) -> EvidenceItem:
    item = _evidence(evidence_id, published_at).model_dump()
    item["sourceFamily"] = source_family
    return EvidenceItem.model_validate(item)


def test_judge_whose_evidence_is_missing_contributes_nothing() -> None:
    result = aggregate_posterior(
        prior_log_odds=0.0,
        raw_opinions=[
            _raw_opinion("official_records", ["o1"], "weak_for"),
            _raw_opinion("community_signal", [], "strong_against"),
        ],
        base_weights={"official_records": 0.5, "community_signal": 0.5},
        evidence_lookup={"o1": _family_evidence("o1", "official", "2026-10-01T12:00:00Z")},
        evaluation_time="2026-10-11T12:00:00Z",
    )

    by_name = {opinion.judgeName: opinion for opinion in result.finalized_opinions}
    assert by_name["community_signal"].effectiveLogOddsContribution == 0.0
    assert by_name["community_signal"].evidenceStrength == "neutral"
    assert result.shrinkage == 0.0
    assert result.posterior_probability > 0.5


def test_official_evidence_ages_slower_than_community_evidence() -> None:
    month_old_official = freshness_decay(
        "2026-09-11T12:00:00Z", "2026-10-11T12:00:00Z", source_family="official"
    )
    week_old_community = freshness_decay(
        "2026-10-04T12:00:00Z", "2026-10-11T12:00:00Z", source_family="community"
    )

    assert month_old_official > 0.75
    assert week_old_community < 0.25


def test_freshness_is_a_true_half_life_with_a_floor() -> None:
    one_half_life = freshness_decay(
        "2026-09-27T12:00:00Z", "2026-10-11T12:00:00Z", source_family="web"
    )
    ancient = freshness_decay("2020-01-01T00:00:00Z", "2026-10-11T12:00:00Z", source_family="web")

    assert abs(one_half_life - 0.5) < 1e-9
    assert ancient == 0.1


def test_evidence_with_an_unknown_publication_date_gets_neutral_freshness() -> None:
    undated = _family_evidence("u1", "web", "2026-10-11T12:00:00Z").model_dump()
    undated["metadata"] = {"publishedAtSource": "unknown"}
    result = aggregate_posterior(
        prior_log_odds=0.0,
        raw_opinions=[_raw_opinion("open_web_research", ["u1"], "moderate_for")],
        base_weights={"open_web_research": 1.0},
        evidence_lookup={"u1": EvidenceItem.model_validate(undated)},
        evaluation_time="2026-10-11T12:00:00Z",
    )

    assert result.finalized_opinions[0].freshnessDecay == 0.5


def _plain_evidence(evidence_id: str, source_family: str) -> EvidenceItem:
    item = _family_evidence(evidence_id, source_family, "2026-10-11T12:00:00Z").model_dump()
    item["qualitySignals"] = {}
    return EvidenceItem.model_validate(item)


def test_judges_without_evidence_do_not_dilute_the_one_that_has_some() -> None:
    panel = aggregate_posterior(
        prior_log_odds=0.0,
        raw_opinions=[
            _raw_opinion("official_records", [], "neutral"),
            _raw_opinion("community_signal", [], "neutral"),
            _raw_opinion("open_web_research", ["w1"], "strong_for"),
        ],
        base_weights={"official_records": 1 / 3, "community_signal": 1 / 3, "open_web_research": 1 / 3},
        evidence_lookup={"w1": _plain_evidence("w1", "web")},
        evaluation_time="2026-10-11T12:00:00Z",
    )

    # strong_for is a log Bayes factor of 3.0 on evidence published at the evaluation time.
    assert abs(panel.raw_posterior_log_odds - 3.0) < 1e-9


def test_pool_is_a_weighted_average_of_the_informative_judges() -> None:
    result = aggregate_posterior(
        prior_log_odds=0.0,
        raw_opinions=[
            _raw_opinion("official_records", ["o1"], "strong_for"),
            _raw_opinion("community_signal", ["c1"], "neutral"),
            _raw_opinion("open_web_research", [], "neutral"),
        ],
        base_weights={"official_records": 0.6, "community_signal": 0.2, "open_web_research": 0.2},
        evidence_lookup={"o1": _plain_evidence("o1", "official"), "c1": _plain_evidence("c1", "community")},
        evaluation_time="2026-10-11T12:00:00Z",
    )

    # Informative weights 0.6 and 0.2 renormalise to 0.75 and 0.25: 0.75 * 3.0 + 0.25 * 0.
    assert abs(result.raw_posterior_log_odds - 2.25) < 1e-9
    by_name = {opinion.judgeName: opinion for opinion in result.finalized_opinions}
    assert by_name["official_records"].baseWeight == 0.6
