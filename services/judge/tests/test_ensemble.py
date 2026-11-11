import math

import pytest

from app.llm.client import LLMResponseError
from app.llm.ensemble import EnsembleLLMClient, parse_model_specs
from app.llm.fake import FakeLLMClient
from app.models_generated import EventInput, EvidenceItem
from app.scoring.aggregate import aggregate_posterior
from app.scoring.judges.open_web_research import evaluate as evaluate_open_web


def _event() -> EventInput:
    return EventInput.model_validate(
        {
            "question": "Will the FOMC cut rates in December 2026?",
            "resolutionCriteria": "FOMC statement announces a cut.",
            "deadline": "2026-12-31T23:59:59Z",
            "entities": ["FOMC"],
            "referenceClass": None,
            "marketSymbols": [],
        }
    )


def _evidence() -> list[EvidenceItem]:
    return [
        EvidenceItem.model_validate(
            {
                "id": "w1",
                "eventId": "e",
                "sourceFamily": "web",
                "sourceType": "web_article",
                "title": "Fed holds",
                "url": "https://example.com/w1",
                "publisher": "Example",
                "publishedAt": "2026-11-01T00:00:00Z",
                "retrievedAt": "2026-11-07T00:00:00Z",
                "summary": "The Fed held rates steady.",
                "rawText": None,
                "entities": [],
                "claims": [],
                "stance": "unknown",
                "qualitySignals": {},
                "metadata": {},
            }
        )
    ]


def _member(probability: float, strength: str) -> FakeLLMClient:
    return FakeLLMClient(
        {"open_web_research": {"probability": probability, "evidenceStrength": strength, "rationale": f"{strength} read"}}
    )


class _FailingLLM(FakeLLMClient):
    def judge_panel(self, **_kwargs):
        raise LLMResponseError("upstream returned garbage")


def _logit(p: float) -> float:
    return math.log(p / (1 - p))


def test_ensemble_takes_the_median_across_models_in_log_odds() -> None:
    ensemble = EnsembleLLMClient(
        [("model-a", _member(0.3, "weak_against")), ("model-b", _member(0.4, "weak_against")), ("model-c", _member(0.9, "strong_for"))]
    )

    opinion = evaluate_open_web(_event(), _evidence(), llm=ensemble)

    assert abs(opinion.probability - 0.4) < 1e-9
    assert opinion.log_bayes_factor == -0.5
    assert opinion.evidence_strength == "weak_against"
    assert [sample["model"] for sample in opinion.samples] == ["model-a", "model-b", "model-c"]


def test_even_sized_ensembles_average_the_middle_pair() -> None:
    ensemble = EnsembleLLMClient([("model-a", _member(0.2, "moderate_against")), ("model-b", _member(0.8, "moderate_for"))])

    opinion = evaluate_open_web(_event(), _evidence(), llm=ensemble)

    assert abs(opinion.probability - 0.5) < 1e-9
    assert opinion.log_bayes_factor == 0.0


def test_ensemble_tolerates_failing_members_but_not_total_failure() -> None:
    survivor = EnsembleLLMClient([("broken", _FailingLLM()), ("ok", _member(0.7, "moderate_for"))])
    opinion = evaluate_open_web(_event(), _evidence(), llm=survivor)
    assert opinion.probability == 0.7
    assert any("broken" in warning for warning in opinion.warnings)

    with pytest.raises(LLMResponseError):
        evaluate_open_web(_event(), _evidence(), llm=EnsembleLLMClient([("broken", _FailingLLM())]))


def test_aggregation_uses_the_ensemble_log_bayes_factor() -> None:
    ensemble = EnsembleLLMClient([("model-a", _member(0.2, "moderate_against")), ("model-b", _member(0.8, "strong_for"))])
    opinion = evaluate_open_web(_event(), _evidence(), llm=ensemble)

    result = aggregate_posterior(
        prior_log_odds=0.0,
        raw_opinions=[opinion],
        base_weights={"open_web_research": 1.0},
        evidence_lookup={item.id: item for item in _evidence()},
        evaluation_time="2026-11-07T00:00:00Z",
    )

    assert result.finalized_opinions[0].logBayesFactor == 0.75


def test_model_specs_parse_optional_reasoning_effort() -> None:
    assert parse_model_specs("openai/gpt-6.1-sol@high, z-ai/glm-5.3@max ,anthropic/claude-opus-5.5") == [
        ("openai/gpt-6.1-sol", "high"),
        ("z-ai/glm-5.3", "max"),
        ("anthropic/claude-opus-5.5", None),
    ]


def test_factory_builds_an_ensemble_from_the_configured_model_list(monkeypatch) -> None:
    from app.llm.factory import get_llm_client

    monkeypatch.setenv("CASSANDRA_JUDGE_LLM", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("OPENROUTER_JUDGE_MODELS", "openai/gpt-6.1-sol@high, z-ai/glm-5.3@max")

    client = get_llm_client()
    try:
        assert isinstance(client, EnsembleLLMClient)
        assert client.model_version == "ensemble[openai/gpt-6.1-sol@high,z-ai/glm-5.3@max]"
    finally:
        client.close()


def test_factory_keeps_a_single_judge_model_when_no_list_is_configured(monkeypatch) -> None:
    from app.llm.factory import get_llm_client
    from app.llm.openrouter import OpenRouterLLMClient

    monkeypatch.setenv("CASSANDRA_JUDGE_LLM", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.delenv("OPENROUTER_JUDGE_MODELS", raising=False)
    monkeypatch.setenv("OPENROUTER_JUDGE_MODEL", "anthropic/claude-opus-5.5")
    monkeypatch.setenv("OPENROUTER_JUDGE_REASONING_EFFORT", "max")

    client = get_llm_client()
    try:
        assert isinstance(client, OpenRouterLLMClient)
        assert client.model_version == "anthropic/claude-opus-5.5@max"
    finally:
        client.close()


def test_ensemble_drops_samples_whose_label_contradicts_their_probability() -> None:
    ensemble = EnsembleLLMClient(
        [
            ("model-a", _member(0.95, "strong_for")),
            ("model-b", _member(0.93, "strong_for")),
            ("glm", _member(0.92, "strong_against")),
        ]
    )

    opinion = evaluate_open_web(_event(), _evidence(), llm=ensemble)

    assert opinion.log_bayes_factor == 3.0
    assert [sample["model"] for sample in opinion.samples if not sample.get("excluded")] == ["model-a", "model-b"]
    assert next(sample for sample in opinion.samples if sample["model"] == "glm")["excluded"] == "label contradicts probability"
    assert any("glm" in warning for warning in opinion.warnings)


def test_ensemble_keeps_weak_or_mild_disagreements() -> None:
    ensemble = EnsembleLLMClient([("model-a", _member(0.8, "weak_against")), ("model-b", _member(0.6, "moderate_against"))])

    opinion = evaluate_open_web(_event(), _evidence(), llm=ensemble)

    assert not any(sample.get("excluded") for sample in opinion.samples)


def test_ensemble_keeps_everything_when_every_sample_is_incoherent() -> None:
    ensemble = EnsembleLLMClient([("glm", _member(0.9, "strong_against")), ("other", _member(0.1, "strong_for"))])

    opinion = evaluate_open_web(_event(), _evidence(), llm=ensemble)

    assert opinion.log_bayes_factor == 0.0
    assert any("incoherent" in warning for warning in opinion.warnings)


def _base_rate_member(probability: float) -> FakeLLMClient:
    return FakeLLMClient({"__base_rate__": {"probability": probability, "rationale": f"p={probability}"}})


class _FailingBaseRate(FakeLLMClient):
    def estimate_base_rate(self, **_kwargs):
        raise LLMResponseError("upstream returned garbage")


def test_ensemble_base_rate_is_the_median_across_models_in_log_odds() -> None:
    ensemble = EnsembleLLMClient(
        [("model-a", _base_rate_member(0.05)), ("model-b", _base_rate_member(0.2)), ("model-c", _base_rate_member(0.9))]
    )

    estimate = ensemble.estimate_base_rate(event=_event(), evaluation_time="2026-11-07T00:00:00Z")

    assert abs(estimate["probability"] - 0.2) < 1e-9
    assert estimate["rationale"] == "[model-b] p=0.2"
    assert [sample["model"] for sample in estimate["samples"]] == ["model-a", "model-b", "model-c"]


def test_ensemble_base_rate_tolerates_failing_members_but_not_total_failure() -> None:
    survivor = EnsembleLLMClient([("broken", _FailingBaseRate()), ("ok", _base_rate_member(0.3))])
    assert abs(survivor.estimate_base_rate(event=_event())["probability"] - 0.3) < 1e-9

    with pytest.raises(LLMResponseError):
        EnsembleLLMClient([("broken", _FailingBaseRate())]).estimate_base_rate(event=_event())


def test_ensemble_has_no_base_rate_when_no_member_offers_one() -> None:
    ensemble = EnsembleLLMClient([("model-a", FakeLLMClient()), ("model-b", FakeLLMClient())])

    assert ensemble.estimate_base_rate(event=_event()) is None
