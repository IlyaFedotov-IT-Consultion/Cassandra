from app.models_generated import EventInput, EvidenceItem
from app.scoring.judges._fake_llm import FakeLLM
from app.scoring.judges.community_signal import evaluate as evaluate_community_signal
from app.scoring.judges.cross_examiner import evaluate as evaluate_cross_examiner
from app.scoring.judges.official_records import evaluate as evaluate_official_records
from app.scoring.judges.open_web_research import evaluate as evaluate_open_web_research


def _event() -> EventInput:
    return EventInput.model_validate(
        {
            "question": "Will Example Corp launch Product X by 2026-12-31?",
            "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
            "deadline": "2026-12-31T23:59:59Z",
            "entities": ["Example Corp", "Product X"],
            "referenceClass": "product_launch",
            "marketSymbols": ["EXMPL"],
        }
    )


def _evidence(evidence_id: str, source_family: str, stance: str) -> EvidenceItem:
    return EvidenceItem.model_validate(
        {
            "id": evidence_id,
            "eventId": "event-1",
            "sourceFamily": source_family,
            "sourceType": "web_article" if source_family != "official" else "press_release",
            "title": f"Evidence {evidence_id}",
            "url": f"https://example.com/{evidence_id}",
            "publisher": "Example",
            "publishedAt": "2026-10-11T09:00:00Z",
            "retrievedAt": "2026-10-11T12:00:00Z",
            "summary": f"Summary for {evidence_id}",
            "rawText": None,
            "entities": ["Example Corp"],
            "claims": [f"Claim from {evidence_id}"],
            "stance": stance,
            "qualitySignals": {},
            "metadata": {},
        }
    )


def test_evidence_reading_judges_return_valid_raw_opinions() -> None:
    event = _event()
    evidence = [
        _evidence("official-1", "official", "supports"),
        _evidence("community-1", "community", "neutral"),
        _evidence("web-1", "web", "supports"),
    ]
    llm = FakeLLM(
        {
            "official_records": {
                "probability": 0.7,
                "evidenceStrength": "moderate_for",
                "rationale": "Official statement supports the event.",
            },
            "community_signal": {
                "probability": 0.52,
                "evidenceStrength": "neutral",
                "rationale": "Community discussion is mixed.",
            },
            "open_web_research": {
                "probability": 0.64,
                "evidenceStrength": "weak_for",
                "rationale": "Open web reporting tilts positive.",
            },
        }
    )

    official = evaluate_official_records(event, evidence, llm=llm)
    community = evaluate_community_signal(event, evidence, llm=llm)
    open_web = evaluate_open_web_research(event, evidence, llm=llm)

    assert official.evidence_strength == "moderate_for"
    assert community.evidence_strength == "neutral"
    assert open_web.evidence_strength == "weak_for"
    assert official.evidence_ids == ["official-1"]
    assert community.evidence_ids == ["community-1"]
    assert open_web.evidence_ids == ["web-1"]


def test_cross_examiner_flags_divergence_and_stays_quiet_on_agreement() -> None:
    llm = FakeLLM({})
    divergent = evaluate_cross_examiner(
        [
            evaluate_official_records(
                _event(),
                [_evidence("official-1", "official", "supports")],
                llm=FakeLLM(
                    {
                        "official_records": {
                            "probability": 0.8,
                            "evidenceStrength": "strong_for",
                            "rationale": "Very supportive.",
                        }
                    }
                ),
            ),
            evaluate_open_web_research(
                _event(),
                [_evidence("web-1", "web", "contradicts")],
                llm=FakeLLM(
                    {
                        "open_web_research": {
                            "probability": 0.2,
                            "evidenceStrength": "strong_against",
                            "rationale": "Very contradictory.",
                        }
                    }
                ),
            ),
        ],
        llm=llm,
    )
    aligned = evaluate_cross_examiner(
        [
            evaluate_official_records(
                _event(),
                [_evidence("official-1", "official", "supports")],
                llm=FakeLLM(
                    {
                        "official_records": {
                            "probability": 0.75,
                            "evidenceStrength": "moderate_for",
                            "rationale": "Supportive.",
                        }
                    }
                ),
            ),
            evaluate_open_web_research(
                _event(),
                [_evidence("web-1", "web", "supports")],
                llm=FakeLLM(
                    {
                        "open_web_research": {
                            "probability": 0.72,
                            "evidenceStrength": "moderate_for",
                            "rationale": "Also supportive.",
                        }
                    }
                ),
            ),
        ],
        llm=llm,
    )

    assert divergent.conflicts
    assert not aligned.conflicts
