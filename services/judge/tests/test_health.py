
from fastapi.testclient import TestClient

from app.api import _llm_dependency
from app.main import app
from app.llm.fake import FakeLLMClient


client = TestClient(app)


def test_health_endpoint_returns_ok() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_judge_endpoint_validates_and_returns_trace_shape() -> None:
    response = client.post(
        "/judge",
        json={
            "eventId": "event-123",
            "event": {
                "question": "Will Example Corp launch Product X by 2026-12-31?",
                "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
                "deadline": "2026-12-31T23:59:59Z",
                "entities": ["Example Corp", "Product X"],
                "referenceClass": "product_launch",
                "marketSymbols": ["EXMPL"],
                "polymarketMarketId": "poly-1",
            },
            "evaluationTime": "2026-10-11T12:00:00Z",
            "evidence": [
                {
                    "id": "11111111-1111-4111-8111-111111111111",
                    "eventId": "22222222-2222-4222-8222-222222222222",
                    "sourceFamily": "web",
                    "sourceType": "web_article",
                    "title": "Example report",
                    "url": "https://news.example.com/product-x",
                    "publisher": "Example News",
                    "publishedAt": "2026-10-10T09:00:00Z",
                    "retrievedAt": "2026-10-11T12:00:00Z",
                    "summary": "Several reports suggest a launch is close.",
                    "rawText": None,
                    "entities": ["Example Corp", "Product X"],
                    "claims": ["Product X may launch this year"],
                    "stance": "supports",
                    "qualitySignals": {},
                    "metadata": {},
                }
            ],
            "calibrationSnapshot": {
                "id": "33333333-3333-4333-8333-333333333333",
                "createdAt": "2026-10-01T00:00:00Z",
                "trainingWindow": "all_time",
                "judgeWeights": {
                    "official_records": 0.33,
                    "community_signal": 0.33,
                    "open_web_research": 0.34,
                },
                "baseRateParams": {},
                "marketPriorParams": {},
                "calibrationParams": {"method": "identity"},
                "onlineLearningParams": {"enabled": False},
                "metrics": {},
                "weightRegime": "cold_start",
                "resolvedOutcomeCount": 0,
                "approved": False,
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["eventId"] == "event-123"
    assert payload["judgeOpinions"]
    assert payload["citations"]
    assert payload["calibrationVersion"] == "33333333-3333-4333-8333-333333333333"


def test_judge_endpoint_applies_calibration_map_to_final_probability() -> None:
    app.dependency_overrides[_llm_dependency] = lambda: FakeLLMClient({})
    try:
        response = client.post(
            "/judge",
            json={
                "eventId": "event-calibrated",
                "event": {
                    "question": "Will Example Corp launch Product X by 2026-12-31?",
                    "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
                    "deadline": "2026-12-31T23:59:59Z",
                    "entities": ["Example Corp", "Product X"],
                    "referenceClass": "product_launch",
                    "marketSymbols": ["EXMPL"],
                },
                "evaluationTime": "2026-10-11T12:00:00Z",
                "evidence": [],
                "calibrationSnapshot": {
                    "id": "snapshot-calibrated",
                    "createdAt": "2026-10-01T00:00:00Z",
                    "trainingWindow": "all_time",
                    "judgeWeights": {
                        "official_records": 0.33,
                        "community_signal": 0.33,
                        "open_web_research": 0.34,
                    },
                    "baseRateParams": {},
                    "marketPriorParams": {},
                    "calibrationParams": {
                        "method": "logistic",
                        "slope": 1.0,
                        "intercept": 1.0,
                    },
                    "onlineLearningParams": {"enabled": False},
                    "metrics": {},
                    "weightRegime": "cold_start",
                    "resolvedOutcomeCount": 0,
                    "approved": False,
                },
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["rawPosteriorProbability"] == 0.5
    assert payload["finalProbability"] > payload["rawPosteriorProbability"]


def test_judge_endpoint_uses_a_bound_market_price_as_the_prior() -> None:
    app.dependency_overrides[_llm_dependency] = lambda: FakeLLMClient({})
    try:
        response = client.post(
            "/judge",
            json={
                "eventId": "event-prior",
                "event": {
                    "question": "Will Example Corp launch Product X by 2026-12-31?",
                    "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
                    "deadline": "2026-12-31T23:59:59Z",
                    "entities": ["Example Corp", "Product X"],
                    "referenceClass": "product_launch",
                    "marketSymbols": ["EXMPL"],
                },
                "evaluationTime": "2026-10-11T12:00:00Z",
                "evidence": [
                    {
                        "id": "market-1",
                        "eventId": "event-prior",
                        "sourceFamily": "prediction_market",
                        "sourceType": "quote_snapshot",
                        "title": "Example market snapshot",
                        "url": "https://markets.example.com/product-x",
                        "publisher": "Example Markets",
                        "publishedAt": "2026-10-10T09:00:00Z",
                        "retrievedAt": "2026-10-11T12:00:00Z",
                        "summary": "Market odds imply a likely launch.",
                        "rawText": None,
                        "entities": ["Example Corp", "Product X"],
                        "claims": ["Product X likely launches this year"],
                        "stance": "supports",
                        "qualitySignals": {},
                        "metadata": {
                            "price": 0.7,
                            "spread": 0.05,
                            "depth": 50000,
                            "volatility": 0.1,
                        },
                    }
                ],
                "calibrationSnapshot": {
                    "id": "snapshot-prior",
                    "createdAt": "2026-10-01T00:00:00Z",
                    "trainingWindow": "all_time",
                    "judgeWeights": {
                        "official_records": 0.33,
                        "community_signal": 0.33,
                        "open_web_research": 0.34,
                    },
                    "baseRateParams": {
                        "minimumSample": 20,
                        "historicalCounts": {
                            "product_launch": {
                                "successes": 15,
                                "total": 20,
                            }
                        },
                    },
                    "marketPriorParams": {
                        "defaultAlpha": 0.6,
                    },
                    "calibrationParams": {"method": "identity"},
                    "onlineLearningParams": {"enabled": False},
                    "metrics": {},
                    "weightRegime": "cold_start",
                    "resolvedOutcomeCount": 0,
                    "approved": False,
                },
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    # A bound market is the prior as priced: neither the reference-class base rate (16/22)
    # nor the market's depth or spread moves it.
    assert abs(payload["priorProbability"] - 0.7) < 1e-6


def test_judge_endpoint_rejects_invalid_payload() -> None:
    response = client.post(
        "/judge",
        json={
            "event": {
                "question": "",
            }
        },
    )

    assert response.status_code == 422


def test_judge_endpoint_runs_full_panel_and_reports_missing_families() -> None:
    response = client.post(
        "/judge",
        json={
            "eventId": "event-panel",
            "event": {
                "question": "Will Example Corp launch Product X by 2026-12-31?",
                "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
                "deadline": "2026-12-31T23:59:59Z",
                "entities": ["Example Corp", "Product X"],
                "referenceClass": "product_launch",
                "marketSymbols": ["EXMPL"],
            },
            "evaluationTime": "2026-10-11T12:00:00Z",
            "evidence": [
                {
                    "id": "web-1",
                    "eventId": "event-1",
                    "sourceFamily": "web",
                    "sourceType": "web_article",
                    "title": "Example web report",
                    "url": "https://news.example.com/product-x-web",
                    "publisher": "Example News",
                    "publishedAt": "2026-10-10T09:00:00Z",
                    "retrievedAt": "2026-10-11T12:00:00Z",
                    "summary": "Web reporting suggests a launch is close.",
                    "rawText": None,
                    "entities": ["Example Corp", "Product X"],
                    "claims": ["Product X may launch this year"],
                    "stance": "supports",
                    "qualitySignals": {},
                    "metadata": {},
                }
            ],
            "calibrationSnapshot": {
                "id": "snapshot-panel",
                "createdAt": "2026-10-01T00:00:00Z",
                "trainingWindow": "all_time",
                "judgeWeights": {
                    "official_records": 0.33,
                    "community_signal": 0.33,
                    "open_web_research": 0.34,
                },
                "baseRateParams": {},
                "marketPriorParams": {},
                "calibrationParams": {"method": "identity"},
                "onlineLearningParams": {"enabled": False},
                "metrics": {},
                "weightRegime": "cold_start",
                "resolvedOutcomeCount": 0,
                "approved": False,
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    judge_names = {opinion["judgeName"] for opinion in payload["judgeOpinions"]}
    missing_families = {item["sourceFamily"] for item in payload["missingEvidence"]}

    assert judge_names == {"official_records", "community_signal", "open_web_research"}
    assert {"official", "community"} <= missing_families


def test_judge_endpoint_prioritizes_english_citations() -> None:
    response = client.post(
        "/judge",
        json={
            "eventId": "event-citation-priority",
            "event": {
                "question": "Will Example Corp launch Product X by 2026-12-31?",
                "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
                "deadline": "2026-12-31T23:59:59Z",
                "entities": ["Example Corp", "Product X"],
                "referenceClass": "product_launch",
                "marketSymbols": ["EXMPL"],
            },
            "evaluationTime": "2026-10-11T12:00:00Z",
            "evidence": [
                {
                    "id": "zh-web-1",
                    "eventId": "event-citation-priority",
                    "sourceFamily": "web",
                    "sourceType": "web_article",
                    "title": "示例公司将在年底前发布产品",
                    "url": "https://news.example.cn/product-x",
                    "publisher": "示例财经",
                    "publishedAt": "2026-10-10T09:00:00Z",
                    "retrievedAt": "2026-10-11T12:00:00Z",
                    "summary": "市场传言称产品发布临近。",
                    "rawText": None,
                    "entities": ["Example Corp", "Product X"],
                    "claims": ["Product X may launch this year"],
                    "stance": "supports",
                    "qualitySignals": {},
                    "metadata": {},
                },
                {
                    "id": "en-web-1",
                    "eventId": "event-citation-priority",
                    "sourceFamily": "web",
                    "sourceType": "web_article",
                    "title": "Example Corp says Product X launch remains on track",
                    "url": "https://news.example.com/product-x",
                    "publisher": "Example News",
                    "publishedAt": "2026-10-10T08:00:00Z",
                    "retrievedAt": "2026-10-11T12:00:00Z",
                    "summary": "English-language reporting indicates a launch is still expected this year.",
                    "rawText": None,
                    "entities": ["Example Corp", "Product X"],
                    "claims": ["Product X may launch this year"],
                    "stance": "supports",
                    "qualitySignals": {},
                    "metadata": {},
                },
            ],
            "calibrationSnapshot": {
                "id": "snapshot-citation-priority",
                "createdAt": "2026-10-01T00:00:00Z",
                "trainingWindow": "all_time",
                "judgeWeights": {
                    "official_records": 0.33,
                    "community_signal": 0.33,
                    "open_web_research": 0.34,
                },
                "baseRateParams": {},
                "marketPriorParams": {},
                "calibrationParams": {"method": "identity"},
                "onlineLearningParams": {"enabled": False},
                "metrics": {},
                "weightRegime": "cold_start",
                "resolvedOutcomeCount": 0,
                "approved": False,
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["citations"][0]["url"] == "https://news.example.com/product-x"


def _review_snapshot(**overrides) -> dict:
    snapshot = {
        "id": "snapshot-review",
        "createdAt": "2026-10-01T00:00:00Z",
        "trainingWindow": "all_time",
        "judgeWeights": {},
        "baseRateParams": {},
        "marketPriorParams": {},
        "calibrationParams": {"method": "identity"},
        "onlineLearningParams": {"enabled": False},
        "metrics": {},
        "weightRegime": "cold_start",
        "resolvedOutcomeCount": 0,
        "approved": False,
    }
    snapshot.update(overrides)
    return snapshot


def _review_evidence(evidence_id: str, source_family: str, metadata: dict | None = None) -> dict:
    return {
        "id": evidence_id,
        "eventId": "event-review",
        "sourceFamily": source_family,
        "sourceType": "quote_snapshot" if source_family == "prediction_market" else "web_article",
        "title": f"Example Corp Product X {evidence_id}",
        "url": f"https://example.com/{evidence_id}",
        "publisher": "Example",
        "publishedAt": "2026-10-10T09:00:00Z",
        "retrievedAt": "2026-10-11T12:00:00Z",
        "summary": "Example Corp Product X update",
        "rawText": None,
        "entities": ["Example Corp"],
        "claims": [],
        "stance": "unknown",
        "qualitySignals": {},
        "metadata": metadata or {},
    }


def _post_review_judge(evidence: list[dict], snapshot: dict | None = None) -> dict:
    app.dependency_overrides[_llm_dependency] = lambda: FakeLLMClient({})
    try:
        response = client.post(
            "/judge",
            json={
                "eventId": "event-review",
                "event": {
                    "question": "Will Example Corp launch Product X by 2026-12-31?",
                    "resolutionCriteria": "Official launch announcement.",
                    "deadline": "2026-12-31T23:59:59Z",
                    "entities": ["Example Corp", "Product X"],
                    "referenceClass": None,
                    "marketSymbols": [],
                },
                "evaluationTime": "2026-10-11T12:00:00Z",
                "evidence": evidence,
                "calibrationSnapshot": snapshot or _review_snapshot(),
            },
        )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200, response.text
    return response.json()


def test_judge_prior_reflects_a_priced_benchmark_market_snapshot() -> None:
    payload = _post_review_judge(
        [_review_evidence("market-1", "prediction_market", {"price": 0.85, "liquidity": 250000})]
    )

    assert 0.8 < payload["priorProbability"] <= 0.85


def test_judge_reports_pre_calibration_probability_separately_from_final() -> None:
    payload = _post_review_judge(
        [_review_evidence("market-1", "prediction_market", {"price": 0.7, "liquidity": 250000})],
        snapshot=_review_snapshot(calibrationParams={"method": "logistic", "slope": 1.0, "intercept": 1.0}),
    )

    assert abs(payload["preCalibrationProbability"] - payload["priorProbability"]) < 1e-9
    assert payload["finalProbability"] > payload["preCalibrationProbability"]


def test_judge_traces_have_unique_ids() -> None:
    first = _post_review_judge([_review_evidence("web-1", "web")])
    second = _post_review_judge([_review_evidence("web-1", "web")])

    assert first["id"] != second["id"]


class _NoCallLLM:
    def judge_panel(self, **_kwargs):
        raise AssertionError("prior-only judgments must not call the panel LLM")

    def cross_examine(self, **_kwargs):
        raise AssertionError("prior-only judgments must not call the cross-examiner")

    def search_web(self, **_kwargs):
        raise AssertionError("unexpected search")


def test_prior_only_judgment_returns_insufficient_evidence_without_llm_calls() -> None:
    app.dependency_overrides[_llm_dependency] = lambda: _NoCallLLM()
    try:
        response = client.post(
            "/judge",
            json={
                "eventId": "event-review",
                "event": {
                    "question": "Will Example Corp launch Product X by 2026-12-31?",
                    "resolutionCriteria": "Official launch announcement.",
                    "deadline": "2026-12-31T23:59:59Z",
                    "entities": ["Example Corp", "Product X"],
                    "referenceClass": None,
                    "marketSymbols": [],
                },
                "evaluationTime": "2026-10-11T12:00:00Z",
                "priorOnly": True,
                "evidence": [
                    _review_evidence("web-1", "web"),
                    _review_evidence(
                        "market-1",
                        "prediction_market",
                        {"outcomePrices": '["0.8", "0.2"]', "outcomes": '["Yes", "No"]', "liquidity": 500000},
                    ),
                ],
                "calibrationSnapshot": _review_snapshot(),
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "insufficient_evidence"
    assert payload["uncertaintyMethod"] == "none"
    assert 0.75 < payload["priorProbability"] <= 0.8
    assert payload["finalProbability"] == payload["priorProbability"]
    assert {opinion["evidenceStrength"] for opinion in payload["judgeOpinions"]} == {"neutral"}


def test_ensemble_samples_and_model_version_are_recorded_in_the_trace() -> None:
    from app.llm.ensemble import EnsembleLLMClient

    members = [
        ("model-a", FakeLLMClient({"open_web_research": {"probability": 0.6, "evidenceStrength": "weak_for", "rationale": "a"}})),
        ("model-b", FakeLLMClient({"open_web_research": {"probability": 0.8, "evidenceStrength": "moderate_for", "rationale": "b"}})),
    ]
    app.dependency_overrides[_llm_dependency] = lambda: EnsembleLLMClient(members)
    try:
        response = client.post(
            "/judge",
            json={
                "eventId": "event-review",
                "event": {
                    "question": "Will Example Corp launch Product X by 2026-12-31?",
                    "resolutionCriteria": "Official launch announcement.",
                    "deadline": "2026-12-31T23:59:59Z",
                    "entities": ["Example Corp", "Product X"],
                    "referenceClass": None,
                    "marketSymbols": [],
                },
                "evaluationTime": "2026-10-11T12:00:00Z",
                "evidence": [_review_evidence("web-1", "web")],
                "calibrationSnapshot": _review_snapshot(),
            },
        )
    finally:
        app.dependency_overrides.clear()

    payload = response.json()
    assert payload["modelVersion"] == "ensemble[model-a,model-b]"
    web = next(entry for entry in payload["weightBreakdown"] if entry["source"] == "open_web_research")
    assert [sample["model"] for sample in web["details"]["samples"]] == ["model-a", "model-b"]
    opinion = next(item for item in payload["judgeOpinions"] if item["judgeName"] == "open_web_research")
    assert opinion["logBayesFactor"] == 1.0


def _post_with_llm(llm, evidence: list[dict]) -> dict:
    app.dependency_overrides[_llm_dependency] = lambda: llm
    try:
        response = client.post(
            "/judge",
            json={
                "eventId": "event-review",
                "event": {
                    "question": "Will Example Corp launch Product X by 2026-12-31?",
                    "resolutionCriteria": "Official launch announcement.",
                    "deadline": "2026-12-31T23:59:59Z",
                    "entities": ["Example Corp", "Product X"],
                    "referenceClass": None,
                    "marketSymbols": [],
                },
                "evaluationTime": "2026-10-11T12:00:00Z",
                "evidence": evidence,
                "calibrationSnapshot": _review_snapshot(),
            },
        )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200, response.text
    return response.json()


def _web_member(probability: float, strength: str) -> FakeLLMClient:
    return FakeLLMClient(
        {"open_web_research": {"probability": probability, "evidenceStrength": strength, "rationale": strength}}
    )


def test_range_reflects_how_far_the_ensemble_models_disagreed() -> None:
    from app.llm.ensemble import EnsembleLLMClient

    evidence = [_review_evidence("web-1", "web"), _review_evidence("web-2", "web")]
    agreeing = _post_with_llm(
        EnsembleLLMClient([(name, _web_member(0.8, "moderate_for")) for name in ("model-a", "model-b", "model-c")]),
        evidence,
    )
    split = _post_with_llm(
        EnsembleLLMClient(
            [
                ("model-a", _web_member(0.9, "strong_for")),
                ("model-b", _web_member(0.8, "moderate_for")),
                ("model-c", _web_member(0.45, "weak_against")),
            ]
        ),
        evidence,
    )

    assert agreeing["uncertaintyMethod"] == "model_spread"
    assert split["uncertaintyMethod"] == "model_spread"
    assert agreeing["finalProbability"] == split["finalProbability"]
    assert agreeing["confidenceHigh"] - agreeing["confidenceLow"] < 1e-9
    assert split["confidenceHigh"] - split["confidenceLow"] > 0.2
    assert split["confidenceLow"] < split["finalProbability"] < split["confidenceHigh"]


def test_range_is_a_labelled_fixed_band_when_only_one_model_was_asked() -> None:
    evidence = [
        _review_evidence("web-1", "web"),
        _review_evidence("web-2", "web"),
        _review_evidence("official-1", "official"),
    ]

    payload = _post_with_llm(FakeLLMClient({}), evidence)

    assert payload["uncertaintyMethod"] == "none"
    assert payload["confidenceLow"] < payload["finalProbability"] < payload["confidenceHigh"]
