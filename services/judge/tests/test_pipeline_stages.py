from fastapi.testclient import TestClient

from app.api import _llm_dependency
from app.llm.client import LLMResponseError
from app.llm.fake import FakeLLMClient
from app.main import app


client = TestClient(app)


def _item(evidence_id: str, source_family: str = "web", metadata: dict | None = None, summary: str = "raw snippet") -> dict:
    return {
        "id": evidence_id,
        "eventId": "event-stages",
        "sourceFamily": source_family,
        "sourceType": "quote_snapshot" if source_family == "prediction_market" else "web_article",
        "title": f"Example {evidence_id}",
        "url": f"https://example.com/{evidence_id}",
        "publisher": "Example",
        "publishedAt": "2026-10-10T09:00:00Z",
        "retrievedAt": "2026-10-11T12:00:00Z",
        "summary": summary,
        "rawText": None,
        "entities": [],
        "claims": [],
        "stance": "supports",
        "qualitySignals": {},
        "metadata": metadata or {},
    }


def _snapshot() -> dict:
    return {
        "id": "snapshot-stages",
        "createdAt": "2026-10-01T00:00:00Z",
        "trainingWindow": "all_time",
        "judgeWeights": {},
        "baseRateParams": {},
        "marketPriorParams": {},
        "calibrationParams": {"method": "identity"},
        "onlineLearningParams": {},
        "metrics": {},
        "weightRegime": "cold_start",
        "resolvedOutcomeCount": 0,
        "approved": False,
    }


EVENT = {
    "question": "Will Example Corp launch Product X by 2026-12-31?",
    "resolutionCriteria": "Official launch announcement.",
    "deadline": "2026-12-31T23:59:59Z",
    "entities": ["Example Corp"],
    "referenceClass": None,
    "marketSymbols": [],
}


class _RecordingLLM(FakeLLMClient):
    def __init__(self, responses=None, *, fail_rating: bool = False) -> None:
        super().__init__(responses or {})
        self.panel_evidence: dict[str, list] = {}
        self._fail_rating = fail_rating

    def judge_panel(self, *, judge_name, event, evidence, default_rationale, evaluation_time=None):
        self.panel_evidence[judge_name] = list(evidence)
        return super().judge_panel(
            judge_name=judge_name, event=event, evidence=evidence, default_rationale=default_rationale
        )

    def rate_evidence(self, *, event, evidence, evaluation_time=None):
        if self._fail_rating:
            raise LLMResponseError("rating model returned garbage")
        return super().rate_evidence(event=event, evidence=evidence, evaluation_time=evaluation_time)


def _judge(evidence: list[dict], llm: FakeLLMClient) -> dict:
    app.dependency_overrides[_llm_dependency] = lambda: llm
    try:
        response = client.post(
            "/judge",
            json={
                "eventId": "event-stages",
                "event": EVENT,
                "evaluationTime": "2026-10-11T12:00:00Z",
                "evidence": evidence,
                "calibrationSnapshot": _snapshot(),
            },
        )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200, response.text
    return response.json()


def _stage(trace: dict, name: str) -> dict:
    return next(stage for stage in trace["pipelineStages"] if stage["stage"] == name)


RATINGS = {
    "__relevance__": {
        "w1": {"relevance": 6, "summary": "Example Corp confirmed a December launch."},
        "w2": {"relevance": 2, "summary": "Unrelated product news."},
        "w3": {"relevance": 5, "summary": "Retail partners prepare Product X shelves."},
    }
}


def test_relevance_stage_keeps_only_relevant_evidence_and_feeds_judges_summaries() -> None:
    llm = _RecordingLLM(RATINGS)

    trace = _judge([_item("w1"), _item("w2"), _item("w3")], llm)

    web = next(opinion for opinion in trace["judgeOpinions"] if opinion["judgeName"] == "open_web_research")
    assert sorted(web["evidenceIds"]) == ["w1", "w3"]
    assert [item.summary for item in llm.panel_evidence["open_web_research"]] == [
        "Example Corp confirmed a December launch.",
        "Retail partners prepare Product X shelves.",
    ]
    stage = _stage(trace, "relevance_rating")
    assert stage["status"] == "completed"
    assert stage["details"]["rated"] == 3
    assert stage["details"]["kept"] == 2
    assert stage["details"]["threshold"] == 4


def test_too_few_relevant_items_returns_a_prior_only_insufficient_verdict() -> None:
    llm = _RecordingLLM({"__relevance__": {"w1": {"relevance": 5, "summary": "s"}, "w2": {"relevance": 1, "summary": "s"}}})

    trace = _judge([_item("w1"), _item("w2")], llm)

    assert trace["status"] == "insufficient_evidence"
    assert llm.panel_evidence == {}
    assert _stage(trace, "relevance_rating")["details"]["insufficientRelevantEvidence"] is True


def test_market_evidence_bypasses_rating_and_still_sets_the_prior() -> None:
    llm = _RecordingLLM(RATINGS)

    trace = _judge(
        [_item("w1"), _item("w3"), _item("m1", "prediction_market", {"price": 0.8, "liquidity": 500000})],
        llm,
    )

    assert _stage(trace, "relevance_rating")["details"]["rated"] == 2
    assert trace["priorProbability"] > 0.75


def test_a_failing_rater_falls_back_to_unfiltered_evidence() -> None:
    llm = _RecordingLLM(fail_rating=True)

    trace = _judge([_item("w1"), _item("w2")], llm)

    assert trace["status"] == "completed"
    assert sorted(item.id for item in llm.panel_evidence["open_web_research"]) == ["w1", "w2"]
    assert _stage(trace, "relevance_rating")["status"] == "failed"


def test_trace_records_panel_cross_examination_aggregation_and_calibration_stages() -> None:
    trace = _judge([_item("w1"), _item("w3")], _RecordingLLM(RATINGS))

    names = [stage["stage"] for stage in trace["pipelineStages"]]
    assert names == ["relevance_rating", "panel_reasoning", "cross_examination", "aggregation", "calibration"]
    assert _stage(trace, "panel_reasoning")["details"]["models"] == "fake-llm"


def test_plan_endpoint_returns_deduplicated_sub_question_queries() -> None:
    llm = FakeLLMClient(
        {
            "__plan__": {
                "subQuestions": ["Has Example Corp announced a date?", "Are retailers stocking Product X?"],
                "queries": [
                    "Example Corp Product X launch date announcement",
                    "example corp product x launch date announcement",
                    "Product X retail availability",
                    "",
                ],
            }
        }
    )
    app.dependency_overrides[_llm_dependency] = lambda: llm
    try:
        response = client.post("/plan", json={"event": EVENT, "evaluationTime": "2026-10-11T12:00:00Z", "maxQueries": 4})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["subQuestions"] == ["Has Example Corp announced a date?", "Are retailers stocking Product X?"]
    assert payload["queries"] == ["Example Corp Product X launch date announcement", "Product X retail availability"]
