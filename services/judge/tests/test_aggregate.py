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


def test_stale_evidence_decays_more_than_fresh_evidence() -> None:
    fresh = freshness_decay("2026-10-11T11:00:00Z", "2026-10-11T12:00:00Z")
    stale = freshness_decay("2026-09-01T12:00:00Z", "2026-10-11T12:00:00Z")

    assert fresh > stale


def test_zero_shrinkage_when_all_judges_agree() -> None:
    assert disagreement_shrinkage([0.5, 0.5, 0.5]) == 0.0
